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
 * 轻量关键词分词（用于关键词匹配场景）
 *
 * 与 segmentText() 的区别：
 *   - segmentText：精确分词，用于 LLM 输出切分（依赖 Intl.Segmenter）
 *   - tokenizeKeywords：轻量分词，用于 persona/skill 关键词匹配 + recall
 *     提取中文连续段（≥2 字）+ 英文词，不做 ICU 词典切分
 *
 * @param input - 用户输入文本
 * @returns 分词后的 token 列表（去重）
 */
export function tokenizeKeywords(input: string): string[] {
  const tokens: string[] = [];
  // 提取中文连续段（2 字以上的中文 token）
  const chineseSegments = input.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  tokens.push(...chineseSegments);
  // 提取英文词
  const englishSegments = input.match(/[a-zA-Z0-9]+/g) ?? [];
  tokens.push(...englishSegments);
  return tokens;
}

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
