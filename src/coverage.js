import { normalizeText } from "./textnorm.js";

/** 覆盖判定原因代码对应的中文说明，全部只陈述证据事实，不使用行政认定措辞。 */
export const REASON_MESSAGES = {
  NO_EVIDENCE_FOR_MODEL: "没有覆盖该型号的已登记证据",
  EVIDENCE_EXPIRED: "证据不在有效期内（尚未生效或已过有效期）",
  EVIDENCE_REVOKED: "证据已被出具方撤销",
  SCENARIO_OUT_OF_SCOPE: "声明场景超出证据认证范围",
  PHRASING_NOT_ALLOWED: "表述不在证据允许的表述清单内",
  PROHIBITED_COMPARISON: "表述触碰证据登记的禁用比较",
  PERFORMER_NOT_AUTHORIZED: "达人未获授权使用该表述",
};

const ts = (s) => Date.parse(s);

function dedupeReasons(reasons) {
  const seen = new Set();
  return reasons.filter((r) => {
    const key = `${r.code}|${r.evidence_id ?? ""}|${JSON.stringify(r.detail ?? null)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 判断现有证据能否覆盖某句声明在某个型号、某个时刻的使用。
 * 只回答“证据是否覆盖”，不回答“是否违法”。
 *
 * @param claim 声明（text + scenarios，normalized 可缺省）
 * @param modelId 产品型号
 * @param asset 声明所在素材（用于核对达人授权，可为空）
 * @param evidenceList 全部已登记证据
 * @param at 判定时刻（投放发生时间）
 */
export function evaluateCoverage({ claim, modelId, asset, evidenceList, at }) {
  const atTs = ts(at);
  const normalized = claim.normalized ?? normalizeText(claim.text);
  const scenarios = claim.scenarios ?? [];
  const reasons = [];
  const forModel = evidenceList.filter((e) => (e.model_ids ?? []).includes(modelId));

  if (forModel.length === 0) {
    reasons.push({ code: "NO_EVIDENCE_FOR_MODEL", message: REASON_MESSAGES.NO_EVIDENCE_FOR_MODEL });
  }

  // 时段核对：证据过期或撤销只影响其有效期之外的投放，不追溯既往。
  const timeValid = [];
  const expired = [];
  const revoked = [];
  for (const e of forModel) {
    if (e.revoked_at && ts(e.revoked_at) <= atTs) revoked.push(e);
    else if (ts(e.valid_from) > atTs || ts(e.valid_until) < atTs) expired.push(e);
    else timeValid.push(e);
  }
  if (forModel.length > 0 && timeValid.length === 0) {
    if (revoked.length > 0) {
      reasons.push({
        code: "EVIDENCE_REVOKED",
        message: REASON_MESSAGES.EVIDENCE_REVOKED,
        detail: revoked.map((e) => e.evidence_id),
      });
    } else {
      reasons.push({
        code: "EVIDENCE_EXPIRED",
        message: REASON_MESSAGES.EVIDENCE_EXPIRED,
        detail: expired.map((e) => e.evidence_id),
      });
    }
  }

  const matched = [];
  for (const e of timeValid) {
    const missing = scenarios.filter((s) => !(e.scenarios ?? []).includes(s));
    const phrasingOk = (e.allowed_phrasings ?? []).includes(normalized);
    const hit = (e.prohibited_comparisons ?? []).find((p) => p && normalized.includes(p));
    if (missing.length === 0 && phrasingOk && !hit) {
      matched.push(e.evidence_id);
      continue;
    }
    if (missing.length > 0) {
      reasons.push({
        code: "SCENARIO_OUT_OF_SCOPE",
        message: REASON_MESSAGES.SCENARIO_OUT_OF_SCOPE,
        evidence_id: e.evidence_id,
        detail: missing,
      });
    }
    if (!phrasingOk) {
      reasons.push({
        code: "PHRASING_NOT_ALLOWED",
        message: REASON_MESSAGES.PHRASING_NOT_ALLOWED,
        evidence_id: e.evidence_id,
      });
    }
    if (hit) {
      reasons.push({
        code: "PROHIBITED_COMPARISON",
        message: REASON_MESSAGES.PROHIBITED_COMPARISON,
        evidence_id: e.evidence_id,
        detail: hit,
      });
    }
  }

  // 达人授权核对：素材由达人产出时，声明须在其被授权的表述清单内。
  if (asset?.performer) {
    const authorized = (asset.performer.authorized_phrasings ?? []).includes(normalized);
    if (!authorized) {
      reasons.push({
        code: "PERFORMER_NOT_AUTHORIZED",
        message: REASON_MESSAGES.PERFORMER_NOT_AUTHORIZED,
        detail: asset.performer.influencer_id,
      });
    }
  }

  const performerBlocked = reasons.some((r) => r.code === "PERFORMER_NOT_AUTHORIZED");
  const covered = matched.length > 0 && !performerBlocked;
  return {
    covered,
    reasons: covered ? [] : dedupeReasons(reasons),
    matched_evidence_ids: matched,
  };
}
