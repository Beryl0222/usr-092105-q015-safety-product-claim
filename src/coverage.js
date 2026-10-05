/**
 * 证据覆盖判定：系统只判断“现有证据能否覆盖声明”，不替监管作行政认定。
 * 证据过期或撤销只影响对应型号、声明和时段，此前已发生的投放不受影响。
 */

/** 判断一条证据在指定时刻是否有效。 */
export function evidenceActiveAt(evidence, at) {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return false;
  if (evidence.valid_from && t < Date.parse(evidence.valid_from)) return false;
  if (evidence.valid_to && t > Date.parse(evidence.valid_to)) return false;
  if (evidence.revoked_at && t >= Date.parse(evidence.revoked_at)) return false;
  return true;
}

/**
 * 以单句声明为核对单位：在该型号、该时段下，声明要求的每个场景是否都有有效证据。
 * 返回 { status, covered_scenarios, missing_scenarios, evidence_used }，
 * status 为 covered / partial / uncovered，仅描述证据覆盖情况。
 */
export function coverageFor(claim, modelId, evidenceList, at) {
  const relevant = evidenceList.filter((e) => e.model_id === modelId);
  const active = relevant.filter((e) => evidenceActiveAt(e, at));
  const covered = [];
  const missing = [];
  for (const scenario of claim.required_scenarios) {
    if (active.some((e) => e.scenarios.includes(scenario))) covered.push(scenario);
    else missing.push(scenario);
  }
  const status = missing.length === 0 ? "covered" : covered.length === 0 ? "uncovered" : "partial";
  return {
    status,
    covered_scenarios: covered,
    missing_scenarios: missing,
    evidence_used: active.map((e) => e.id),
  };
}
