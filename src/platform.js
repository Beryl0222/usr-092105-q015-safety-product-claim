import { validateEvent } from "./validator.js";
import { normalizeText, claimIdFor, fingerprintFor } from "./textnorm.js";
import { evaluateCoverage } from "./coverage.js";
import { buildCorrectionNotice } from "./notice.js";

const DISCLAIMER = "本系统仅判断现有证据能否覆盖声明，所有结论不构成行政认定。";

const KNOWN_EVENT_TYPES = new Set([
  "EVIDENCE_REGISTERED",
  "EVIDENCE_REVOKED",
  "CLAIM_PUBLISHED",
  "DERIVATIVE_DETECTED",
  "DISTRIBUTION_STARTED",
  "REVIEW_DECIDED",
  "DELIVERY_SUSPENDED",
  "DELIVERY_REINSTATED",
  "APPEAL_FILED",
  "APPEAL_DECIDED",
]);

const KNOWN_AGGREGATES = new Set(["claim_evidence", "creative_asset", "distribution_instance", "review_decision"]);

const ts = (s) => Date.parse(s);

function requireFields(event, fields) {
  return fields.filter((name) => event[name] === undefined || event[name] === null).map((name) => `缺少字段：${name}`);
}

/** 各事件类型在信封之外的最小载荷要求。 */
function validatePayload(event) {
  switch (event.event_type) {
    case "EVIDENCE_REGISTERED":
      return requireFields(event, ["model_ids", "scenarios", "valid_from", "valid_until"]);
    case "CLAIM_PUBLISHED":
    case "DERIVATIVE_DETECTED":
      return requireFields(event, ["model_ids", "claims"]);
    case "DISTRIBUTION_STARTED":
      return requireFields(event, ["asset_id", "account_id"]);
    case "REVIEW_DECIDED":
      if (!event.claim_text && !event.claim_id) return ["缺少字段：claim_text 或 claim_id"];
      return requireFields(event, ["model_id"]);
    case "APPEAL_FILED":
      return requireFields(event, ["appeal_id"]);
    case "APPEAL_DECIDED":
      return requireFields(event, ["appeal_id", "outcome"]);
    default:
      return [];
  }
}

/**
 * 宣传声明举证与传播处置平台。
 *
 * 以每一句可传播声明为核对单位：声明标识由口播文本内容决定，
 * 同一段话无论出现在直播、脚本还是几十条剪辑里，都是同一条声明。
 * 平台只判断现有证据能否覆盖声明，不代替监管作行政认定。
 *
 * 重复抓取安全：同一 event_id 重试直接跳过；同一外部素材重复上报并入已有素材；
 * 同一聚合的旧版本事件丢弃。
 */
export function createPlatform(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const state = {
    events: [],
    seenEventIds: new Set(),
    aggregateVersions: new Map(),
    evidence: new Map(),
    assets: new Map(),
    assetByExternalKey: new Map(),
    claims: new Map(),
    distributions: new Map(),
    decisions: new Map(),
    appeals: new Map(),
  };

  // ---------- 摄取 ----------

  function ingest(input) {
    const events = Array.isArray(input) ? input : [input];
    const report = { accepted: 0, duplicates: 0, merged: 0, stale: 0, rejected: [], generated: [] };
    for (const event of events) ingestOne(event, report);
    return report;
  }

  function ingestOne(event, report) {
    const envelopeErrors = validateEvent(event);
    if (envelopeErrors.length > 0) {
      report.rejected.push({ event_id: event?.event_id ?? "(缺少 event_id)", errors: envelopeErrors });
      return;
    }
    if (!KNOWN_EVENT_TYPES.has(event.event_type)) {
      report.rejected.push({ event_id: event.event_id, errors: [`不支持的事件类型：${event.event_type}`] });
      return;
    }
    if (!KNOWN_AGGREGATES.has(event.aggregate_type)) {
      report.rejected.push({ event_id: event.event_id, errors: [`不支持的聚合类型：${event.aggregate_type}`] });
      return;
    }
    const payloadErrors = validatePayload(event);
    if (payloadErrors.length > 0) {
      report.rejected.push({ event_id: event.event_id, errors: payloadErrors });
      return;
    }
    if (state.seenEventIds.has(event.event_id)) {
      report.duplicates += 1; // 来源系统重试沿用原事件标识，直接跳过
      return;
    }
    const externalKey = externalKeyOf(event);
    if (externalKey && state.assetByExternalKey.has(externalKey)) {
      // 同一外部素材被重复抓取：并入已有素材，不产生新对象、不重复触发处置
      const asset = state.assets.get(state.assetByExternalKey.get(externalKey));
      asset.last_seen_at = event.occurred_at;
      asset.crawl_count += 1;
      recordEvent(event);
      report.merged += 1;
      return;
    }
    const lastVersion = state.aggregateVersions.get(event.aggregate_id) ?? 0;
    if (event.version <= lastVersion) {
      report.stale += 1; // 重复抓取到的旧版本
      return;
    }
    const generated = [];
    applyEvent(event, generated);
    recordEvent(event);
    report.accepted += 1;
    report.generated.push(...generated);
  }

  function recordEvent(event) {
    state.seenEventIds.add(event.event_id);
    const lastVersion = state.aggregateVersions.get(event.aggregate_id) ?? 0;
    if (event.version > lastVersion) state.aggregateVersions.set(event.aggregate_id, event.version);
    state.events.push(event);
  }

  function externalKeyOf(event) {
    if (event.aggregate_type !== "creative_asset") return null;
    if (!event.platform || !event.external_asset_id) return null;
    return `${event.platform}:${event.external_asset_id}`;
  }

  /** 系统处置事件：占用聚合版本序列，标识确定，重复摄取时不会再次生成。 */
  function emitSystemEvent(eventType, aggregateType, aggregateId, summary, extra, generated) {
    const { event_id: eventId, ...rest } = extra;
    const event = {
      event_id: eventId,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: now(),
      version: (state.aggregateVersions.get(aggregateId) ?? 0) + 1,
      summary,
      generated_by: "platform-propagation",
      ...rest,
    };
    applyEvent(event, []);
    recordEvent(event);
    generated.push(event);
    return event;
  }

  // ---------- 事件应用 ----------

  function applyEvent(event, generated) {
    switch (event.event_type) {
      case "EVIDENCE_REGISTERED":
        return registerEvidence(event);
      case "EVIDENCE_REVOKED":
        return revokeEvidence(event);
      case "CLAIM_PUBLISHED":
      case "DERIVATIVE_DETECTED":
        return registerAsset(event, generated);
      case "DISTRIBUTION_STARTED":
        return startDistribution(event, generated);
      case "REVIEW_DECIDED":
        return decideReview(event, generated);
      case "DELIVERY_SUSPENDED":
        return suspendDelivery(event);
      case "DELIVERY_REINSTATED":
        return reinstateDelivery(event);
      case "APPEAL_FILED":
        return fileAppeal(event);
      case "APPEAL_DECIDED":
        return decideAppeal(event, generated);
      default:
        throw new Error(`未知事件类型：${event.event_type}`);
    }
  }

  function registerEvidence(event) {
    state.evidence.set(event.aggregate_id, {
      evidence_id: event.aggregate_id,
      report_no: event.report_no ?? event.aggregate_id,
      issuer: event.issuer ?? "",
      model_ids: event.model_ids ?? [],
      scenarios: event.scenarios ?? [],
      allowed_phrasings_raw: event.allowed_phrasings ?? [],
      allowed_phrasings: (event.allowed_phrasings ?? []).map(normalizeText),
      prohibited_comparisons_raw: event.prohibited_comparisons ?? [],
      prohibited_comparisons: (event.prohibited_comparisons ?? []).map(normalizeText),
      valid_from: event.valid_from,
      valid_until: event.valid_until,
      revoked_at: null,
      revocation_reason: null,
      registered_at: event.occurred_at,
    });
  }

  function revokeEvidence(event) {
    const evidence = state.evidence.get(event.aggregate_id);
    if (!evidence) return;
    evidence.revoked_at = event.revoked_at ?? event.occurred_at;
    evidence.revocation_reason = event.reason ?? "";
  }

  function registerAsset(event, generated) {
    const claimIds = [];
    for (const input of event.claims ?? []) {
      const claimId = claimIdFor(input.text);
      const existing = state.claims.get(claimId);
      if (existing) {
        for (const s of input.scenarios ?? []) {
          if (!existing.scenarios.includes(s)) existing.scenarios.push(s);
        }
        existing.asset_ids.add(event.aggregate_id);
      } else {
        state.claims.set(claimId, {
          claim_id: claimId,
          text: input.text,
          normalized: normalizeText(input.text),
          scenarios: [...(input.scenarios ?? [])],
          first_seen_at: event.occurred_at,
          asset_ids: new Set([event.aggregate_id]),
        });
      }
      claimIds.push(claimId);
    }
    const source = event.source_asset_id ? state.assets.get(event.source_asset_id) : null;
    const sharedWithSource = source ? claimIds.filter((id) => source.claim_ids.includes(id)) : [];
    const asset = {
      asset_id: event.aggregate_id,
      asset_kind: event.asset_kind ?? (event.event_type === "DERIVATIVE_DETECTED" ? "short_video" : "unknown"),
      title: event.title ?? "",
      model_ids: event.model_ids ?? [],
      claim_ids: claimIds,
      fingerprint: fingerprintFor(claimIds),
      source_asset_id: event.source_asset_id ?? null,
      shared_claim_ids_with_source: sharedWithSource,
      // 实质相同派生物：有明确剪辑来源且与来源共享至少一句声明
      substantially_identical: Boolean(source) && sharedWithSource.length > 0,
      platform: event.platform ?? null,
      external_asset_id: event.external_asset_id ?? null,
      performer: event.performer
        ? {
            influencer_id: event.performer.influencer_id,
            authorized_phrasings: (event.performer.authorized_phrasings ?? []).map(normalizeText),
            authorized_phrasings_raw: event.performer.authorized_phrasings ?? [],
          }
        : null,
      derivative_ids: [],
      published_at: event.occurred_at,
      last_seen_at: event.occurred_at,
      crawl_count: 1,
    };
    state.assets.set(asset.asset_id, asset);
    if (source) source.derivative_ids.push(asset.asset_id);
    const key = externalKeyOf(event);
    if (key) state.assetByExternalKey.set(key, asset.asset_id);
    // 先投放、后补登记素材的顺序下，素材一落库就核对其在投实例
    for (const dist of state.distributions.values()) {
      if (dist.asset_id === asset.asset_id && dist.status === "active") autoSuspendDistribution(dist, generated);
    }
  }

  function startDistribution(event, generated) {
    const dist = {
      distribution_id: event.aggregate_id,
      asset_id: event.asset_id,
      account_id: event.account_id,
      started_at: event.started_at ?? event.occurred_at,
      status: "active",
      suspended_by: null,
      suspension: null,
      reinstated_by: null,
      history: [{ at: event.occurred_at, action: "started" }],
    };
    state.distributions.set(dist.distribution_id, dist);
    // 原素材停投后，实质相同派生物的新投放一出现即被拦截
    autoSuspendDistribution(dist, generated);
  }

  function decideReview(event, generated) {
    const claimId = event.claim_id ?? claimIdFor(event.claim_text);
    const registered = state.claims.get(claimId);
    const claim = registered ?? {
      claim_id: claimId,
      text: event.claim_text ?? claimId,
      normalized: normalizeText(event.claim_text ?? claimId),
      scenarios: event.scenarios ?? [],
    };
    const asset = event.asset_id ? state.assets.get(event.asset_id) : findAssetContext(claimId, event.model_id);
    const at = event.window?.from ?? event.occurred_at;
    const coverage = evaluateCoverage({ claim, modelId: event.model_id, asset, evidenceList: [...state.evidence.values()], at });
    const decision = {
      decision_id: event.aggregate_id,
      claim_id: claimId,
      claim_text: claim.text,
      model_id: event.model_id,
      asset_id: asset?.asset_id ?? null,
      window: event.window ?? { from: event.occurred_at },
      reviewer: event.reviewer ?? null,
      note: event.note ?? "",
      verdict: coverage.covered ? "covered" : "uncovered",
      reasons: coverage.reasons,
      matched_evidence_ids: coverage.matched_evidence_ids,
      decided_at: event.occurred_at,
      appeal: null,
    };
    state.decisions.set(decision.decision_id, decision);
    if (decision.verdict === "uncovered") propagateSuspension(decision, generated);
  }

  function suspendDelivery(event) {
    const dist = state.distributions.get(event.aggregate_id);
    if (!dist || dist.status !== "active") return;
    dist.status = "suspended";
    dist.suspended_by = event.decision_id ?? null;
    dist.suspension = { at: event.occurred_at, decision_id: event.decision_id ?? null, summary: event.summary };
    dist.history.push({ at: event.occurred_at, action: "suspended", decision_id: event.decision_id ?? null });
  }

  function reinstateDelivery(event) {
    const dist = state.distributions.get(event.aggregate_id);
    if (!dist || dist.status !== "suspended") return;
    dist.status = "active";
    dist.reinstated_by = event.appeal_id ?? null;
    dist.history.push({ at: event.occurred_at, action: "reinstated", appeal_id: event.appeal_id ?? null });
  }

  function fileAppeal(event) {
    const appeal = {
      appeal_id: event.appeal_id,
      decision_id: event.aggregate_id,
      appellant: event.appellant ?? "",
      statement: event.statement ?? "",
      materials: event.materials ?? [],
      filed_at: event.occurred_at,
      outcome: null,
      scope: null,
      note: "",
      effective_from: null,
      decided_at: null,
    };
    state.appeals.set(appeal.appeal_id, appeal);
    const decision = state.decisions.get(event.aggregate_id);
    if (decision) decision.appeal = appeal;
  }

  function decideAppeal(event, generated) {
    const appeal = state.appeals.get(event.appeal_id);
    const decision = state.decisions.get(event.aggregate_id);
    const scope = normalizeScope(event.scope);
    if (appeal) {
      appeal.outcome = event.outcome;
      appeal.scope = scope;
      appeal.note = event.note ?? "";
      appeal.effective_from = event.effective_from ?? event.occurred_at;
      appeal.decided_at = event.occurred_at;
    }
    if (!decision || (event.outcome !== "overturned" && event.outcome !== "partial")) return;
    // 恢复范围严格限定在申诉决定列明的（声明 × 型号）之内
    for (const dist of state.distributions.values()) {
      if (dist.status !== "suspended" || dist.suspended_by !== decision.decision_id) continue;
      const asset = state.assets.get(dist.asset_id);
      if (!asset) continue;
      if (!scopeCoversAsset(scope, decision, asset, event.outcome)) continue;
      emitSystemEvent(
        "DELIVERY_REINSTATED",
        "distribution_instance",
        dist.distribution_id,
        `申诉 ${event.appeal_id} ${event.outcome === "overturned" ? "成立" : "部分成立"}，恢复投放`,
        { event_id: `auto-rein-${event.appeal_id}-${dist.distribution_id}`, appeal_id: event.appeal_id },
        generated,
      );
    }
  }

  function normalizeScope(scope) {
    const claimIds = [...(scope?.claim_ids ?? [])];
    for (const text of scope?.claim_texts ?? []) claimIds.push(claimIdFor(text));
    return { claim_ids: claimIds, model_ids: [...(scope?.model_ids ?? [])] };
  }

  function scopeCoversAsset(scope, decision, asset, outcome) {
    // 整体撤销且未列明范围时，覆盖该决定涉及的全部（声明 × 型号）
    if (outcome === "overturned" && scope.claim_ids.length === 0 && scope.model_ids.length === 0) return true;
    const claimsOk = scope.claim_ids.length > 0 && asset.claim_ids.some((c) => scope.claim_ids.includes(c));
    const modelsOk = scope.model_ids.length > 0 && asset.model_ids.some((m) => scope.model_ids.includes(m));
    return claimsOk && modelsOk;
  }

  // ---------- 处置传播 ----------

  /** 停投只落到（声明 × 型号）命中的投放实例上，不误伤其他型号。 */
  function propagateSuspension(decision, generated) {
    for (const dist of state.distributions.values()) {
      if (dist.status !== "active") continue;
      const asset = state.assets.get(dist.asset_id);
      if (!asset) continue;
      if (!asset.model_ids.includes(decision.model_id)) continue;
      if (!asset.claim_ids.includes(decision.claim_id)) continue;
      emitSuspension(dist, decision, [decision.decision_id], generated);
    }
  }

  function autoSuspendDistribution(dist, generated) {
    const asset = state.assets.get(dist.asset_id);
    if (!asset || dist.status !== "active") return;
    const hits = [];
    for (const claimId of asset.claim_ids) {
      for (const modelId of asset.model_ids) {
        const decision = activeUncoveredDecision(claimId, modelId);
        if (decision && !hits.includes(decision)) hits.push(decision);
      }
    }
    if (hits.length === 0) return;
    emitSuspension(dist, hits[0], hits.map((d) => d.decision_id), generated);
  }

  function emitSuspension(dist, decision, matchedDecisionIds, generated) {
    emitSystemEvent(
      "DELIVERY_SUSPENDED",
      "distribution_instance",
      dist.distribution_id,
      `依据审核决定 ${decision.decision_id} 停止投放：声明未获现有证据覆盖`,
      {
        event_id: `auto-susp-${decision.decision_id}-${dist.distribution_id}`,
        decision_id: decision.decision_id,
        matched_decision_ids: matchedDecisionIds,
      },
      generated,
    );
  }

  /** 生效中的“未覆盖”决定：未被申诉推翻或部分推翻的最近一次决定。 */
  function activeUncoveredDecision(claimId, modelId) {
    let latest = null;
    for (const d of state.decisions.values()) {
      if (d.claim_id === claimId && d.model_id === modelId) latest = d;
    }
    if (!latest || latest.verdict !== "uncovered") return null;
    const appeal = latest.appeal;
    if (appeal && (appeal.outcome === "overturned" || appeal.outcome === "partial")) {
      const scope = appeal.scope ?? { claim_ids: [], model_ids: [] };
      const wholeDecision = scope.claim_ids.length === 0 && scope.model_ids.length === 0;
      const inScope = scope.claim_ids.includes(claimId) && scope.model_ids.includes(modelId);
      if (appeal.outcome === "overturned" && (wholeDecision || inScope)) return null;
      if (appeal.outcome === "partial" && inScope) return null;
    }
    return latest;
  }

  function findAssetContext(claimId, modelId) {
    let fallback = null;
    for (const asset of state.assets.values()) {
      if (!asset.claim_ids.includes(claimId) || !asset.model_ids.includes(modelId)) continue;
      if (asset.performer) return asset; // 优先带达人授权信息的素材
      if (!fallback || ts(asset.published_at) > ts(fallback.published_at)) fallback = asset;
    }
    return fallback;
  }

  // ---------- 查询视图 ----------

  function evidenceForModel(modelId) {
    return [...state.evidence.values()].filter((e) => e.model_ids.includes(modelId));
  }

  function publicEvidence(e) {
    const nowTs = ts(now());
    const status = e.revoked_at ? "revoked" : ts(e.valid_until) < nowTs ? "expired" : ts(e.valid_from) > nowTs ? "pending" : "active";
    return {
      evidence_id: e.evidence_id,
      report_no: e.report_no,
      issuer: e.issuer,
      model_ids: [...e.model_ids],
      scenarios: [...e.scenarios],
      allowed_phrasings: [...e.allowed_phrasings_raw],
      prohibited_comparisons: [...e.prohibited_comparisons_raw],
      valid_from: e.valid_from,
      valid_until: e.valid_until,
      revoked_at: e.revoked_at,
      revocation_reason: e.revocation_reason,
      status,
    };
  }

  function publicAsset(a) {
    return {
      asset_id: a.asset_id,
      asset_kind: a.asset_kind,
      title: a.title,
      model_ids: [...a.model_ids],
      claims: a.claim_ids.map((id) => state.claims.get(id)?.text ?? id),
      source_asset_id: a.source_asset_id,
      derivative_ids: [...a.derivative_ids],
      substantially_identical_to_source: a.substantially_identical,
      platform: a.platform,
      external_asset_id: a.external_asset_id,
      influencer_id: a.performer?.influencer_id ?? null,
      crawl_count: a.crawl_count,
    };
  }

  function publicDistribution(d) {
    const asset = state.assets.get(d.asset_id);
    return {
      distribution_id: d.distribution_id,
      account_id: d.account_id,
      asset_id: d.asset_id,
      asset_kind: asset?.asset_kind ?? null,
      model_ids: asset ? [...asset.model_ids] : [],
      started_at: d.started_at,
      status: d.status,
      suspended_by: d.suspended_by,
      reinstated_by: d.reinstated_by,
      history: d.history.map((h) => ({ ...h })),
    };
  }

  function publicDecision(d) {
    return {
      decision_id: d.decision_id,
      claim_text: d.claim_text,
      model_id: d.model_id,
      verdict: d.verdict,
      reasons: d.reasons.map((r) => ({ ...r })),
      matched_evidence_ids: [...d.matched_evidence_ids],
      window: { ...d.window },
      decided_at: d.decided_at,
      note: d.note,
      appeal: d.appeal
        ? {
            appeal_id: d.appeal.appeal_id,
            outcome: d.appeal.outcome,
            materials: [...d.appeal.materials],
            scope: d.appeal.scope ? { claim_ids: [...d.appeal.scope.claim_ids], model_ids: [...d.appeal.scope.model_ids] } : null,
            note: d.appeal.note,
          }
        : null,
    };
  }

  function evaluateClaimAt(textOrId, modelId, at) {
    const claimId = textOrId.startsWith("claim-") ? textOrId : claimIdFor(textOrId);
    const registered = state.claims.get(claimId);
    const claim = registered ?? { claim_id: claimId, text: textOrId, normalized: normalizeText(textOrId), scenarios: [] };
    const asset = findAssetContext(claim.claim_id, modelId);
    return evaluateCoverage({ claim, modelId, asset, evidenceList: [...state.evidence.values()], at });
  }

  /**
   * 处置视图：从任一句口播（原文或 claim_id）展开它对应的型号、证据、
   * 审核决定、全部派生素材与全部派生投放，并给出面向消费者的更正说明。
   */
  function claimView(textOrId) {
    const claimId = textOrId.startsWith("claim-") ? textOrId : claimIdFor(textOrId);
    const claim = state.claims.get(claimId);
    if (!claim) return null;
    const assets = [...state.assets.values()].filter((a) => a.claim_ids.includes(claimId));
    const assetIds = new Set(assets.map((a) => a.asset_id));
    const distributions = [...state.distributions.values()].filter((d) => assetIds.has(d.asset_id));
    const modelIds = [...new Set(assets.flatMap((a) => a.model_ids))];
    const models = modelIds.map((modelId) => {
      const decisions = [...state.decisions.values()].filter((d) => d.claim_id === claimId && d.model_id === modelId);
      return {
        model_id: modelId,
        coverage_now: evaluateClaimAt(claimId, modelId, now()),
        evidence: evidenceForModel(modelId).map(publicEvidence),
        decisions: decisions.map(publicDecision),
        currently_suspended: Boolean(activeUncoveredDecision(claimId, modelId)),
      };
    });
    const notices = {};
    for (const m of models) {
      if (!m.currently_suspended) continue;
      const decision = activeUncoveredDecision(claimId, m.model_id);
      notices[m.model_id] = buildCorrectionNotice({
        claim,
        modelId: m.model_id,
        decision,
        evidenceList: evidenceForModel(m.model_id),
        assets: assets.filter((a) => a.model_ids.includes(m.model_id)),
        distributions: distributions.filter((d) => state.assets.get(d.asset_id)?.model_ids.includes(m.model_id)),
        at: now(),
      });
    }
    return {
      claim: { claim_id: claim.claim_id, text: claim.text, scenarios: [...claim.scenarios], asset_count: assets.length },
      models,
      assets: assets.map(publicAsset),
      distributions: distributions.map(publicDistribution),
      correction_notices: notices,
      disclaimer: DISCLAIMER,
    };
  }

  function listDistributions() {
    return [...state.distributions.values()].map(publicDistribution);
  }

  /** 全量公开状态快照，用于审计与幂等性校验。 */
  function snapshot() {
    return {
      claims: [...state.claims.values()].map((c) => ({
        claim_id: c.claim_id,
        text: c.text,
        scenarios: [...c.scenarios],
        asset_ids: [...c.asset_ids].sort(),
      })),
      evidence: [...state.evidence.values()].map(publicEvidence),
      assets: [...state.assets.values()].map(publicAsset),
      distributions: listDistributions(),
      decisions: [...state.decisions.values()].map(publicDecision),
      appeals: [...state.appeals.values()].map((a) => ({ ...a, materials: [...a.materials] })),
    };
  }

  return { ingest, claimView, evaluateClaimAt, listDistributions, snapshot };
}
