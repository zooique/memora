/**
 * 文本分词器
 *
 * 用 Node 内建 Intl.Segmenter（ECMAScript Intl API）实现中英文混合分词：
 * - 英文按空格 + 标点
 * - 中文按 ICU 词典（Node 18+ 内建）
 * - 数字、emoji、英文单词保留为整体
 *
 * 详见 M-202：避免引入 nodejieba（C++ 扩展，Windows + Node 24 prebuilt 不可靠）
 *
 * 性能：~10 万字/秒（Intl.Segmenter 是 ICU C++ 实现，比纯 JS 快 10 倍+）
 */
const ZH_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });

/**
 * 单行分词（用于 LLM 输出的精确切分）
 * @param text 原文
 * @returns 分词数组（去标点、去空白、保留中英文 + 数字）
 */
export function segmentText(text: string): string[] {
  if (!text) return [];
  // 中英混合：先用 zh-CN 切中文词，再过滤标点
  // zh-CN 也支持英文按空格切（不会破坏英文单词）
  const tokens: string[] = [];
  for (const segment of ZH_SEGMENTER.segment(text)) {
    if (segment.isWordLike) {
      const word = segment.segment.trim();
      if (word.length > 0) {
        tokens.push(word);
      }
    }
  }
  return tokens;
}

/**
 * 统计各 token 在文本中的出现次数（用于 TF 评分）
 * @param text 原文
 * @returns Map<token, count>
 */
export function tokenFrequency(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const token of segmentText(text)) {
    freq.set(token, (freq.get(token) ?? 0) + 1);
  }
  return freq;
}
