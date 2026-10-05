import { assetCarriesClaim } from "./derivative.js";
import { coverageFor } from "./coverage.js";

/**
 * 计算一项审核决定需要暂停的投放：
 * 仅限该决定指向的声明与型号，且投放仍在进行；其他型号、其他声明一律不动。
 */
export function suspensionTargets(state, decision) {
  const targets = [];
  for (const d of state.distributions.values()) {
    if (d.status !== "active") continue;
    const asset = state.assets.get(d.asset_id);
    if (!asset) continue;
    if (!asset.model_ids.includes(decision.model_id)) continue;
    if (!assetCarriesClaim(state, asset, decision.claim_id)) continue;
    targets.push(d.id);
  }
  return targets.sort();
}

/** 由审核决定生成暂停事件；事件标识确定，重复执行可幂等入仓。 */
export function suspensionEvents(state, decision, { at }) {
  return suspensionTargets(state, decision).map((distId) => ({
    event_id: `evt-susp-${decision.id}-${distId}`,
    event_type: "DELIVERY_SUSPENDED",
    aggregate_type: "distribution_instance",
    aggregate_id: distId,
    occurred_at: at,
    version: 1,
    summary: `依据审核决定 ${decision.id} 暂停投放 ${distId}`,
    payload: { decision_id: decision.id, claim_id: decision.claim_id, model_id: decision.model_id },
  }));
}

/**
 * 消费者更正说明：必须指明产品型号、原表述、证据实际覆盖的场景与暂无证据的场景，
 * 不允许只写“宣传不规范”这类笼统提示。
 */
export function correctionNotice(state, decision, { at }) {
  const claim = state.claims.get(decision.claim_id);
  const coverage = claim
    ? coverageFor(claim, decision.model_id, [...state.evidence.values()], at)
    : { covered_scenarios: [], missing_scenarios: [] };
  const claimText = claim ? claim.text : decision.claim_id;
  const parts = [
    `更正说明：关于产品「${decision.model_id}」的宣传“${claimText}”。`,
    coverage.covered_scenarios.length > 0
      ? `现有检测证据仅覆盖：${coverage.covered_scenarios.join("、")}。`
      : "目前没有任何检测证据支持该表述。",
    coverage.missing_scenarios.length > 0
      ? `以下场景暂无证据支持：${coverage.missing_scenarios.join("、")}。`
      : "",
    "该产品在已列明场景内的宣传不受影响。",
  ].filter(Boolean);
  return {
    model_id: decision.model_id,
    claim_id: decision.claim_id,
    covered_scenarios: coverage.covered_scenarios,
    missing_scenarios: coverage.missing_scenarios,
    text: parts.join(""),
  };
}
