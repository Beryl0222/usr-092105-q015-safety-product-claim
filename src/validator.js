const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

/** 与 contracts/domain.schema.json 保持一致的事件类型。 */
export const EVENT_TYPES = [
  "CLAIM_DEFINED",
  "EVIDENCE_REGISTERED",
  "EVIDENCE_REVOKED",
  "ASSET_REGISTERED",
  "DISTRIBUTION_LAUNCHED",
  "DERIVATIVE_DETECTED",
  "REVIEW_RECORDED",
  "DELIVERY_SUSPENDED",
  "APPEAL_FILED",
  "APPEAL_DECIDED",
  "CORRECTION_PUBLISHED",
];

/** 与 contracts/domain.schema.json 保持一致的聚合类型。 */
export const AGGREGATE_TYPES = ["claim_evidence", "creative_asset", "distribution_instance", "review_decision"];

/** 返回可以直接展示给接入方的中文错误。 */
export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) errors.push("version 必须是正整数");
  if ("event_type" in record && !EVENT_TYPES.includes(record.event_type)) errors.push(`event_type 不在领域允许范围内：${record.event_type}`);
  if ("aggregate_type" in record && !AGGREGATE_TYPES.includes(record.aggregate_type)) errors.push(`aggregate_type 不在领域允许范围内：${record.aggregate_type}`);
  return errors;
}
