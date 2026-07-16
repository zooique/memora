/**
 * 文本分词器
 *
 * 用 Node 内建 Intl.Segmenter（ECMAScript Intl API）实现中英文混合分词：
 * - 英文按空格 + 标点
 * - 中文按 ICU 词典（Node 18+ 内建）
 * - 数字、emoji、英文单词保留为整体
 *
 * 避免引入 nodejieba（C++ 扩展，Windows + Node 24 prebuilt 不可靠）
 *
 * 性能：~10 万字/秒（Intl.Segmenter 是 ICU C++ 实现，比纯 JS 快 10 倍+）
 */
const ZH_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });

/**
 * 轻量关键词分词（用于关键词匹配场景）
 *
 * 内部函数，不在 index.ts 公共 API 导出。
 * 模块私有（0 外部消费者，仅 scoreByKeywords 内部调用）。
 * tokenizeKeywords 的行为通过 scoreByKeywords 间接验证（segmenter.test.ts 已覆盖）。
 *
 * 与 segmentText() 的区别：
 *   - segmentText：精确分词（Intl.Segmenter ICU 词典切分），用于 LLM 输出切分 + recall 关键词提取
 *   - tokenizeKeywords：轻量分词，用于 persona/skill 关键词匹配
 *     提取中文连续段（≥2 字）+ 英文词，不做 ICU 词典切分
 *
 * @param input - 用户输入文本
 * @returns 分词后的 token 列表（去重）
 */
function tokenizeKeywords(input: string): string[] {
  const tokens: string[] = [];
  // 提取中文连续段（2 字以上的中文 token）
  const chineseSegments = input.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  tokens.push(...chineseSegments);
  // 提取英文词
  const englishSegments = input.match(/[a-zA-Z0-9]+/g) ?? [];
  tokens.push(...englishSegments);
  // 去重（兑现 JSDoc "去重" 契约，避免重复 token 干扰关键词匹配评分）
  return [...new Set(tokens)];
}

/**
 * 关键词匹配评分（Persona/Skill 共享逻辑）
 *
 * 匹配策略：先分词，再对每个关键词做子串搜索（tokens + 原文双保险）。
 * 大小写不敏感，中英文混合友好。
 *
 * @param userInput - 用户输入文本
 * @param keywordList - 待匹配的关键词数组
 * @returns 匹配得分 (0~1)，0 表示无命中
 */
export function scoreByKeywords(userInput: string, keywordList: string[]): number {
  if (keywordList.length === 0) return 0;

  const normalizedInput = userInput.toLowerCase();
  const tokens = tokenizeKeywords(normalizedInput);

  let hitCount = 0;
  for (const kw of keywordList) {
    const kwLower = kw.toLowerCase();
    if (tokens.some((t) => t.includes(kwLower)) || normalizedInput.includes(kwLower)) {
      hitCount++;
    }
  }

  return hitCount / keywordList.length;
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

/**
 * 分词后小写化（文本预处理快捷方法）
 *
 * 组合 segmentText + toLowerCase，消除 6 处散落的 `.map((t) => t.toLowerCase())` 模式
 * （ADR-017 枝叶层 2 次提取原则）。
 * 用于关键词匹配/召回场景的文本预处理（大小写不敏感匹配）。
 *
 * @param text 原文
 * @returns 分词后的小写 token 数组
 */
export function segmentLower(text: string): string[] {
  return segmentText(text).map((t) => t.toLowerCase());
}

/**
 * 中文停用词集合
 * 用于关键词提取时过滤无意义词汇（从 memory/types.ts 迁入，
 * 因为停用词是分词/关键词提取的关注点，而非记忆类型定义）
 */
export const STOPWORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都',
  '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会',
  '着', '没有', '看', '好', '自己', '这', '那', '什么', '怎么', '可以',
  '这个', '那个', '他们', '我们', '因为', '所以', '但是', '如果', '虽然',
  '能', '把', '被', '让', '给', '对', '从', '为', '比', '与', '或',
  '吗', '呢', '吧', '啊', '哦', '嗯', '呀', '哈',
]);
