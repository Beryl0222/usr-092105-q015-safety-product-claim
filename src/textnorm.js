import { createHash } from "node:crypto";

/** 归一化口播文本：去掉空白、标点与符号并统一小写，确保同一句口播得到同一个声明标识。 */
export function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function sha1(text) {
  return createHash("sha1").update(text, "utf8").digest("hex");
}

/** 声明标识由口播文本内容决定：同一句话出现在直播、脚本或任何剪辑中，都落到同一条声明。 */
export function claimIdFor(text) {
  return `claim-${sha1(normalizeText(text)).slice(0, 12)}`;
}

/** 素材内容指纹：素材所含声明集合的摘要，用于识别实质相同的派生物。 */
export function fingerprintFor(claimIds) {
  return sha1([...claimIds].sort().join("|")).slice(0, 16);
}
