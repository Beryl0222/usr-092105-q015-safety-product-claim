import { coverageFor } from "./coverage.js";
import { assetCarriesClaim } from "./derivative.js";

/**
 * 处置视图：从任一句口播声明展开它对应的型号、证据与全部派生投放。
 * 每个投放附带其发起时刻的证据覆盖状态，体现“证据过期只影响对应时段”。
 */
export function claimDispositionView(state, claimId, { at }) {
  const claim = state.claims.get(claimId);
  if (!claim) return null;
  const evidenceAll = [...state.evidence.values()];

  const models = claim.model_ids.map((modelId) => ({
    model_id: modelId,
    coverage: coverageFor(claim, modelId, evidenceAll, at),
    evidence: evidenceAll.filter((e) => e.model_id === modelId),
  }));

  const assets = [...state.assets.values()]
    .filter((a) => assetCarriesClaim(state, a, claimId))
    .map((a) => ({ ...a, derivative_of: a.clip_source ?? null }));
  const assetIds = new Set(assets.map((a) => a.id));

  const distributions = [...state.distributions.values()]
    .filter((d) => assetIds.has(d.asset_id))
    .map((d) => {
      const asset = state.assets.get(d.asset_id);
      return {
        ...d,
        account_id: d.account_id,
        coverage_at_launch: asset.model_ids.map((modelId) => ({
          model_id: modelId,
          status: coverageFor(claim, modelId, evidenceAll, d.started_at).status,
        })),
      };
    });

  const decisions = [...state.decisions.values()].filter((d) => d.claim_id === claimId);
  const decisionIds = new Set(decisions.map((d) => d.id));
  const appeals = [...state.appeals.values()].filter((a) => decisionIds.has(a.decision_id));
  const notices = state.notices.filter((n) => decisionIds.has(n.decision_id));

  return { claim, models, assets, distributions, decisions, appeals, notices };
}
