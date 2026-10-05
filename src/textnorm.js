/** 文本归一化：全角转半角、去标点与空白、转小写，用于识别实质相同的派生表述。 */
export function normalizeText(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 字符二元组集合，作为一句表述的指纹。 */
export function bigrams(text) {
  const norm = normalizeText(text);
  if (norm.length === 0) return new Set();
  if (norm.length === 1) return new Set([norm]);
  const grams = new Set();
  for (let i = 0; i < norm.length - 1; i += 1) grams.add(norm.slice(i, i + 2));
  return grams;
}

/**
 * 包含度：两个表述的共有二元组占较短一方的比例。
 * 剪辑派生物往往只是原口播的截短或改写，用包含度比 Jaccard 更贴合“实质相同”的识别。
 */
export function containment(a, b) {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter += 1;
  return inter / Math.min(ga.size, gb.size);
}

/** 达到该包含度即视为实质相同表述的候选，需结合剪辑来源一并判断。 */
export const DERIVATIVE_THRESHOLD = 0.5;
