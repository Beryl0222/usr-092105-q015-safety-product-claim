import { containment, DERIVATIVE_THRESHOLD } from "./textnorm.js";

/**
 * 判断素材是否承载某条声明，按信号强度依次：
 * 1. 直接标注的 claim_ids；
 * 2. 素材自带口播文本与声明文本实质相同（包含度达到阈值）；
 * 3. 素材自身没有任何标注与文本时，沿剪辑来源向上溯源。
 * 已有自身标注的剪辑（如只剪了另一句话的片段）不因同源而被株连。
 */
export function assetCarriesClaim(state, asset, claimId, seen = new Set()) {
  if (!asset || seen.has(asset.id)) return false;
  seen.add(asset.id);
  if (asset.claim_ids.includes(claimId)) return true;
  const claim = state.claims.get(claimId);
  const texts = Object.values(asset.claim_texts ?? {});
  if (claim && texts.length > 0) {
    return texts.some((text) => containment(text, claim.text) >= DERIVATIVE_THRESHOLD);
  }
  if (asset.claim_ids.length === 0 && texts.length === 0 && asset.clip_source) {
    return assetCarriesClaim(state, state.assets.get(asset.clip_source), claimId, seen);
  }
  return false;
}

/**
 * 派生物识别：找出未显式标注、但文本实质相同或剪辑自承载该声明素材的素材。
 * 原素材停投后，用它在新增素材中持续发现派生物。
 */
export function detectDerivativeAssets(state, claimId) {
  if (!state.claims.has(claimId)) return [];
  const found = [];
  for (const asset of state.assets.values()) {
    if (asset.claim_ids.includes(claimId)) continue;
    if (assetCarriesClaim(state, asset, claimId)) found.push(asset.id);
  }
  return found;
}
