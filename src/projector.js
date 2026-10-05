import { normalizeText } from "./textnorm.js";

/** 空领域状态。 */
export function emptyState() {
  return {
    claims: new Map(),
    evidence: new Map(),
    assets: new Map(),
    distributions: new Map(),
    decisions: new Map(),
    appeals: new Map(),
    notices: [],
  };
}

/** 把一条事件折叠进领域状态。 */
export function applyEvent(state, event) {
  const p = event.payload ?? {};
  switch (event.event_type) {
    case "CLAIM_DEFINED":
      state.claims.set(event.aggregate_id, {
        id: event.aggregate_id,
        text: p.text,
        normalized: normalizeText(p.text),
        model_ids: p.model_ids ?? [],
        required_scenarios: p.required_scenarios ?? [],
        allowed_phrasing: p.allowed_phrasing ?? [],
        banned_comparisons: p.banned_comparisons ?? [],
        source: p.source ?? null,
        defined_at: event.occurred_at,
      });
      break;
    case "EVIDENCE_REGISTERED":
      state.evidence.set(event.aggregate_id, {
        id: event.aggregate_id,
        report_no: p.report_no ?? null,
        model_id: p.model_id,
        standard: p.standard ?? null,
        scenarios: p.scenarios ?? [],
        valid_from: p.valid_from ?? null,
        valid_to: p.valid_to ?? null,
        revoked_at: null,
        status: "active",
      });
      break;
    case "EVIDENCE_REVOKED": {
      const ev = state.evidence.get(event.aggregate_id);
      if (ev) {
        ev.status = "revoked";
        ev.revoked_at = p.revoked_at ?? event.occurred_at;
      }
      break;
    }
    case "ASSET_REGISTERED":
      state.assets.set(event.aggregate_id, {
        id: event.aggregate_id,
        kind: p.kind ?? null,
        model_ids: p.model_ids ?? [],
        claim_ids: p.claim_ids ?? [],
        claim_texts: p.claim_texts ?? {},
        clip_source: p.clip_source ?? null,
        script_id: p.script_id ?? null,
        live_id: p.live_id ?? null,
        influencer_id: p.influencer_id ?? null,
        authorization: p.authorization ?? null,
      });
      break;
    case "DISTRIBUTION_LAUNCHED":
      state.distributions.set(event.aggregate_id, {
        id: event.aggregate_id,
        asset_id: p.asset_id,
        account_id: p.account_id,
        platform: p.platform ?? null,
        started_at: p.started_at ?? event.occurred_at,
        status: "active",
        suspended_by: null,
        suspended_at: null,
      });
      break;
    case "REVIEW_RECORDED":
      state.decisions.set(event.aggregate_id, {
        id: event.aggregate_id,
        claim_id: p.claim_id,
        model_id: p.model_id,
        action: p.action ?? "suspend",
        effective_from: p.effective_from ?? event.occurred_at,
        reason: p.reason ?? "",
        status: "effective",
        remaining_scenarios: null,
      });
      break;
    case "DELIVERY_SUSPENDED": {
      const d = state.distributions.get(event.aggregate_id);
      if (d) {
        d.status = "suspended";
        d.suspended_by = p.decision_id ?? null;
        d.suspended_at = event.occurred_at;
      }
      break;
    }
    case "APPEAL_FILED":
      state.appeals.set(event.aggregate_id, {
        id: event.aggregate_id,
        decision_id: p.decision_id,
        appellant: p.appellant ?? null,
        evidence_ids: p.evidence_ids ?? [],
        statement: p.statement ?? "",
        status: "pending",
        resolved_scenarios: [],
      });
      break;
    case "APPEAL_DECIDED": {
      const appeal = state.appeals.get(event.aggregate_id);
      if (appeal) {
        appeal.status = p.outcome ?? "rejected";
        appeal.resolved_scenarios = p.resolved_scenarios ?? [];
        const decision = state.decisions.get(appeal.decision_id);
        if (decision) {
          if (p.outcome === "upheld") {
            decision.status = "overturned";
            // 申诉成立：恢复仅因该决定被暂停的投放。
            for (const d of state.distributions.values()) {
              if (d.suspended_by === decision.id && d.status === "suspended") {
                d.status = "reinstated";
              }
            }
          } else if (p.outcome === "partially_upheld") {
            // 部分成立：原素材仍含未覆盖表述，维持暂停，仅记录已解决的场景。
            decision.status = "partially_overturned";
            decision.remaining_scenarios = p.remaining_scenarios ?? [];
          }
        }
      }
      break;
    }
    case "CORRECTION_PUBLISHED":
      state.notices.push({
        id: event.aggregate_id,
        decision_id: p.decision_id ?? null,
        text: p.text ?? "",
        published_at: event.occurred_at,
      });
      break;
    default:
      break;
  }
  return state;
}

/** 对有序事件流做投影，得到领域状态。 */
export function project(events) {
  const state = emptyState();
  for (const event of events) applyEvent(state, event);
  return state;
}
