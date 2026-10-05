/** 领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
}

/** 本领域支持的业务对象类型。 */
export type AggregateType =
  | "claim_evidence"
  | "creative_asset"
  | "distribution_instance"
  | "review_decision";

/** 本领域支持的事件类型。 */
export type EventType =
  | "EVIDENCE_REGISTERED"
  | "EVIDENCE_REVOKED"
  | "CLAIM_PUBLISHED"
  | "DERIVATIVE_DETECTED"
  | "DISTRIBUTION_STARTED"
  | "REVIEW_DECIDED"
  | "DELIVERY_SUSPENDED"
  | "DELIVERY_REINSTATED"
  | "APPEAL_FILED"
  | "APPEAL_DECIDED";

/** 一句可传播声明：平台核对的最小单位。 */
export interface ClaimInput {
  /** 口播原文。 */
  text: string;
  /** 声明涉及的使用场景，如 自行车 / 电动车 / 摩托车。 */
  scenarios?: string[];
}

/** 达人授权信息：登记达人被允许使用的表述清单。 */
export interface PerformerInfo {
  influencer_id: string;
  authorized_phrasings: string[];
}

/** claim_evidence：检测报告 / 认证及其适用范围。 */
export interface EvidencePayload {
  report_no?: string;
  issuer?: string;
  model_ids: string[];
  /** 认证范围（场景）。 */
  scenarios: string[];
  /** 证据允许使用的表述清单。 */
  allowed_phrasings: string[];
  /** 证据登记的禁用比较。 */
  prohibited_comparisons?: string[];
  valid_from: string;
  valid_until: string;
}

/** creative_asset：脚本、直播、短视频等素材。 */
export interface CreativeAssetPayload {
  asset_kind: "script" | "livestream" | "short_video";
  title?: string;
  model_ids: string[];
  /** 剪辑来源：指向上游素材。 */
  source_asset_id?: string;
  platform?: string;
  external_asset_id?: string;
  performer?: PerformerInfo;
  claims: ClaimInput[];
}

/** distribution_instance：一次具体投放。 */
export interface DistributionPayload {
  asset_id: string;
  account_id: string;
  started_at?: string;
}

/** review_decision：审核决定，只陈述证据覆盖情况，不作行政认定。 */
export interface ReviewDecisionPayload {
  claim_text?: string;
  claim_id?: string;
  model_id: string;
  asset_id?: string;
  window?: { from: string; to?: string };
  reviewer?: string;
  note?: string;
}

/** 申诉材料与申诉决定。 */
export interface AppealPayload {
  appeal_id: string;
  appellant?: string;
  statement?: string;
  /** 申诉材料：通常为新的证据标识。 */
  materials?: string[];
  outcome?: "upheld" | "overturned" | "partial";
  scope?: { claim_ids?: string[]; claim_texts?: string[]; model_ids?: string[] };
  effective_from?: string;
  note?: string;
}
