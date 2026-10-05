import { REASON_MESSAGES } from "./coverage.js";

const ts = (s) => Date.parse(s);

function reasonLine(reason) {
  switch (reason.code) {
    case "SCENARIO_OUT_OF_SCOPE":
      return `声明涉及的场景（${reason.detail.join("、")}）超出已登记证据的认证范围`;
    case "PROHIBITED_COMPARISON":
      return `表述触碰证据登记的禁用比较（“${reason.detail}”）`;
    case "PERFORMER_NOT_AUTHORIZED":
      return `该表述为达人 ${reason.detail} 自行加入，不在品牌授权范围内`;
    case "EVIDENCE_REVOKED":
      return `相关证据已被出具方撤销（${(reason.detail ?? []).join("、")}）`;
    default:
      return REASON_MESSAGES[reason.code] ?? reason.code;
  }
}

function evidenceStatusLine(e, at) {
  if (e.revoked_at) return `已于 ${e.revoked_at.slice(0, 10)} 被出具方撤销`;
  if (ts(e.valid_until) < ts(at)) return `有效期至 ${e.valid_until.slice(0, 10)}（已过期）`;
  return `有效期 ${e.valid_from.slice(0, 10)} 至 ${e.valid_until.slice(0, 10)}`;
}

/**
 * 生成给消费者看的更正说明。
 * 要求：点明具体产品型号与适用场景、说清证据情况与处置范围，
 * 不使用“宣传不规范”这类笼统措辞，也不代替监管作行政认定。
 */
export function buildCorrectionNotice({ claim, modelId, decision, evidenceList, assets, distributions, at }) {
  const lines = [];
  lines.push(`更正说明：型号 ${modelId} 产品的宣传内容`);
  lines.push(`涉及表述：“${claim.text}”。`);
  lines.push(`涉及产品：仅型号 ${modelId}，不涉及其他型号。`);

  if (evidenceList.length > 0) {
    const parts = evidenceList.map(
      (e) => `报告 ${e.report_no}（认证范围：${(e.scenarios ?? []).join("、") || "未列明"}，${evidenceStatusLine(e, at)}）`,
    );
    lines.push(`该型号已登记证据：${parts.join("；")}。`);
  } else {
    lines.push("该型号暂无已登记的检测或认证证据。");
  }

  for (const reason of decision.reasons) {
    lines.push(`未覆盖原因：${reasonLine(reason)}。`);
  }

  const accounts = [...new Set(distributions.map((d) => d.account_id))];
  const suspended = distributions.filter((d) => d.status === "suspended").length;
  const since = (decision.window?.from ?? decision.decided_at).slice(0, 10);
  lines.push(
    `处置情况：自 ${since} 起，涉及该表述的素材 ${assets.length} 条、投放账户 ${accounts.length} 个，已停止投放 ${suspended} 个投放实例。`,
  );

  // 正向说明哪些内容仍有证据支持，避免消费者误以为整个产品都不行。
  const validEvidence = evidenceList.filter((e) => !e.revoked_at && ts(e.valid_from) <= ts(at) && ts(e.valid_until) >= ts(at));
  const coveredScenarios = [...new Set(validEvidence.flatMap((e) => e.scenarios ?? []))];
  const allowedExamples = [...new Set(validEvidence.flatMap((e) => e.allowed_phrasings_raw ?? []))]
    .filter((t) => t !== claim.text)
    .slice(0, 2);
  if (coveredScenarios.length > 0) {
    const example = allowedExamples.length > 0 ? `（如“${allowedExamples.join("”“")}”）` : "";
    lines.push(`不受影响的内容：该型号在 ${coveredScenarios.join("、")} 场景下有证据支持的表述${example}不在本次处置范围内。`);
  }

  lines.push("本说明仅陈述现有证据对该表述的覆盖情况，供消费者参考，不构成行政认定。");
  return lines.join("\n");
}
