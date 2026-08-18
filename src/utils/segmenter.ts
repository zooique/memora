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

/** 评分分母上限：防止关键词多的角色被惩罚（命中 2 个即视为强匹配） */
const KEYWORD_SCORE_DENOMINATOR_MAX = 3;

/**
 * 关键词匹配评分（Persona/Skill 共享逻辑）
 *
 * 匹配策略：先分词，再对每个关键词做子串搜索（tokens + 原文双保险）。
 * 大小写不敏感，中英文混合友好。
 *
 * 评分公式：hitCount / Math.min(keywordList.length, KEYWORD_SCORE_DENOMINATOR_MAX)
 *
 * 分母上限 KEYWORD_SCORE_DENOMINATOR_MAX = 3，避免关键词多的角色被惩罚：
 *   - 10 个 keywords 命中 2 个：原 2/10=0.2（被误判低置信度），现 2/3=0.67（高置信度）
 *   - 2 个 keywords 命中 2 个：原 2/2=1.0，现 2/2=1.0（不变）
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

  // 分母取 min(关键词总数, 3)：命中 2+ 个即高置信度，不受关键词总量影响
  return hitCount / Math.min(keywordList.length, KEYWORD_SCORE_DENOMINATOR_MAX);
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

// ─── 启发式词性规则（用于增强关键词权重） ──────────────────

/**
 * 动作/意图词汇表（粗略识别动词）
 * 用于在关键词提取时提升核心动作的权重
 */
const ACTION_WORDS = new Set([
  '创建', '删除', '修改', '更新', '查询', '搜索', '生成', '发送', '接收',
  '处理', '计算', '分析', '评估', '测试', '运行', '部署', '配置', '安装',
  '读取', '写入', '保存', '加载', '下载', '上传', '移动', '复制', '粘贴',
  '打开', '关闭', '启动', '停止', '执行', '调用', '使用', '操作',
  '添加', '移除', '检查', '验证', '确认', '提交', '撤销', '回滚',
  '设计', '开发', '实现', '优化', '重构', '修复', '调试', '解释', '翻译',
  '获取', '设置', '切换', '切换到', '打印', '输出', '输入',
  '导出', '导入', '转换', '解析', '格式化', '加密', '解密',
  '连接', '断开', '绑定', '解绑', '订阅', '发布', '监听', '触发',
  '比较', '排序', '筛选', '过滤', '分组', '聚合', '统计', '汇总',
  '构建', '编译', '打包', '集成', '交付',
]);

/**
 * 实体/对象后缀（粗略识别名词）
 * 以这些后缀结尾的词可能是重要实体
 */
const ENTITY_SUFFIXES = ['器', '表', '图', '库', '类', '型', '函数', '方法', '模块', '系统', '服务', '应用', '组件'];

/**
 * 增强关键词提取（带权重）
 *
 * 在 segmentLower 的基础上，对提取的关键词进行启发式词性分析：
 * - 识别为动作/意图的词汇 → 权重 2.0
 * - 识别为实体/对象的词汇 → 权重 1.5
 * - 其他词汇 → 权重 1.0
 *
 * 用于取代检测等场景，使得核心动作和实体在相似度计算中更具区分度。
 *
 * @param input - 输入文本
 * @returns 带权重的关键词列表 [{ word, weight }]
 */
export function extractEnhancedKeywords(input: string): { word: string; weight: number }[] {
  const basicTokens = segmentLower(input);
  const enriched: { word: string; weight: number }[] = [];

  for (const token of basicTokens) {
    // 过滤停用词和过短词
    if (STOPWORDS.has(token) || token.length < 2) continue;

    let weight = 1.0;
    const tokenLower = token.toLowerCase();

    // 1. 检查是否为动作/意图词
    if (ACTION_WORDS.has(tokenLower) || ACTION_WORDS.has(token)) {
      weight = 2.0;
    } else {
      // 2. 检查是否以实体后缀结尾（粗粒度名词识别）
      for (const suffix of ENTITY_SUFFIXES) {
        if (token.endsWith(suffix)) {
          weight = 1.5;
          break;
        }
      }
    }

    enriched.push({ word: token, weight });
  }

  return enriched;
}

/**
 * 加权 Jaccard 相似度计算
 *
 * 标准 Jaccard: |A ∩ B| / |A ∪ B|
 * 加权 Jaccard: Σ(intersection权重) / Σ(union权重)
 *
 * 用于取代检测场景：
 * - 动作/意图词（权重 2.0）在相似度计算中贡献更大
 * - 实体词（权重 1.5）次之
 * - 其他词（权重 1.0）作为基础对比
 *
 * 这样在"多轮逐步细化"场景下（关键词重叠度低但意图延续），
 * 核心动作词的重叠会显著提升相似度，更准确地识别主题延续。
 *
 * @param keywordsA - 第一组带权重关键词
 * @param keywordsB - 第二组带权重关键词
 * @returns 加权 Jaccard 相似度 (0~1)
 */
export function calculateWeightedJaccard(
  keywordsA: { word: string; weight: number }[],
  keywordsB: { word: string; weight: number }[],
): number {
  if (keywordsA.length === 0 && keywordsB.length === 0) return 0;

  // 构建 Map 以便快速查找（word -> weight）
  const mapB = new Map(keywordsB.map((k) => [k.word, k.weight]));

  let intersectionWeight = 0;
  let unionWeight = 0;

  // 遍历 A，计算交集和并集权重
  const processedWords = new Set<string>();
  for (const { word, weight: weightA } of keywordsA) {
    processedWords.add(word);
    const weightB = mapB.get(word);
    if (weightB !== undefined) {
      // 交集：取较大权重
      intersectionWeight += Math.max(weightA, weightB);
    }
    // 并集：取较大权重（A 的部分）
    unionWeight += Math.max(weightA, weightB ?? 0);
  }

  // 遍历 B 中不在 A 里的词，补充并集权重
  for (const { word, weight } of keywordsB) {
    if (!processedWords.has(word)) {
      unionWeight += weight;
    }
  }

  if (unionWeight === 0) return 0;
  return intersectionWeight / unionWeight;
}
