/** 领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
  payload?: Record<string, unknown>;
}

export type AggregateType =
  | "claim_evidence"
  | "creative_asset"
  | "distribution_instance"
  | "review_decision";

export type EventType =
  | "CLAIM_DEFINED"
  | "EVIDENCE_REGISTERED"
  | "EVIDENCE_REVOKED"
  | "ASSET_REGISTERED"
  | "DISTRIBUTION_LAUNCHED"
  | "DERIVATIVE_DETECTED"
  | "REVIEW_RECORDED"
  | "DELIVERY_SUSPENDED"
  | "APPEAL_FILED"
  | "APPEAL_DECIDED"
  | "CORRECTION_PUBLISHED";

/** 证据覆盖结论：只描述证据能否覆盖声明，不作行政认定。 */
export type CoverageStatus = "covered" | "partial" | "uncovered";

export interface CoverageResult {
  status: CoverageStatus;
  covered_scenarios: string[];
  missing_scenarios: string[];
  evidence_used: string[];
}
