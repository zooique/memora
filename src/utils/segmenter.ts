/**
 * 文本分词器——用 Node 内建 Intl.Segmenter 做中英文混合分词
 * （英文按空格+标点、中文按 ICU 词典、数字/emoji/英文词保留整体）。
 * 避免引入 nodejieba（C++ 扩展，Windows + Node 24 prebuilt 不可靠）。
 */
const ZH_SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });

/** 单行精确分词（用于 LLM 输出切分）：去标点空白，保留中英文 + 数字 */
export function segmentText(text: string): string[] {
  if (!text) return [];
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

/** 分词后小写化（文本预处理快捷方法，用于关键词匹配/召回的大小写不敏感匹配） */
export function segmentLower(text: string): string[] {
  return segmentText(text).map((t) => t.toLowerCase());
}

/** 中文停用词集合（用于关键词提取时过滤无意义词汇） */
export const STOPWORDS = new Set([
  '的',
  '了',
  '是',
  '在',
  '我',
  '有',
  '和',
  '就',
  '不',
  '人',
  '都',
  '一',
  '一个',
  '上',
  '也',
  '很',
  '到',
  '说',
  '要',
  '去',
  '你',
  '会',
  '着',
  '没有',
  '看',
  '好',
  '自己',
  '这',
  '那',
  '什么',
  '怎么',
  '可以',
  '这个',
  '那个',
  '他们',
  '我们',
  '因为',
  '所以',
  '但是',
  '如果',
  '虽然',
  '能',
  '把',
  '被',
  '让',
  '给',
  '对',
  '从',
  '为',
  '比',
  '与',
  '或',
  '吗',
  '呢',
  '吧',
  '啊',
  '哦',
  '嗯',
  '呀',
  '哈',
]);

/** 动作/意图词汇表（启发式词性识别，用于提升核心动作权重） */
const ACTION_WORDS = new Set([
  '创建',
  '删除',
  '修改',
  '更新',
  '查询',
  '搜索',
  '生成',
  '发送',
  '接收',
  '处理',
  '计算',
  '分析',
  '评估',
  '测试',
  '运行',
  '部署',
  '配置',
  '安装',
  '读取',
  '写入',
  '保存',
  '加载',
  '下载',
  '上传',
  '移动',
  '复制',
  '粘贴',
  '打开',
  '关闭',
  '启动',
  '停止',
  '执行',
  '调用',
  '使用',
  '操作',
  '添加',
  '移除',
  '检查',
  '验证',
  '确认',
  '提交',
  '撤销',
  '回滚',
  '设计',
  '开发',
  '实现',
  '优化',
  '重构',
  '修复',
  '调试',
  '解释',
  '翻译',
  '获取',
  '设置',
  '切换',
  '切换到',
  '打印',
  '输出',
  '输入',
  '导出',
  '导入',
  '转换',
  '解析',
  '格式化',
  '加密',
  '解密',
  '连接',
  '断开',
  '绑定',
  '解绑',
  '订阅',
  '发布',
  '监听',
  '触发',
  '比较',
  '排序',
  '筛选',
  '过滤',
  '分组',
  '聚合',
  '统计',
  '汇总',
  '构建',
  '编译',
  '打包',
  '集成',
  '交付',
]);

/** 实体/对象后缀（启发式词性识别，用于识别名词实体） */
const ENTITY_SUFFIXES = [
  '器',
  '表',
  '图',
  '库',
  '类',
  '型',
  '函数',
  '方法',
  '模块',
  '系统',
  '服务',
  '应用',
  '组件',
];

/**
 * 增强关键词提取（带权重）——用于取代检测等场景：
 * 动作/意图词权重 2.0、实体（后缀命中）1.5、其他 1.0。
 */
export function extractEnhancedKeywords(input: string): { word: string; weight: number }[] {
  const basicTokens = segmentLower(input);
  const enriched: { word: string; weight: number }[] = [];

  for (const token of basicTokens) {
    // 过滤停用词和过短词
    if (STOPWORDS.has(token) || token.length < 2) continue;

    let weight = 1.0;
    const tokenLower = token.toLowerCase();

    if (ACTION_WORDS.has(tokenLower) || ACTION_WORDS.has(token)) {
      weight = 2.0;
    } else {
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
 * 加权 Jaccard 相似度：加权后核心动作/实体重叠在"多轮逐步细化"下
 * 更能识别主题延续。加权 Jaccard = Σ(交集大权重) / Σ(并集大权重)。
 */
export function calculateWeightedJaccard(
  keywordsA: { word: string; weight: number }[],
  keywordsB: { word: string; weight: number }[],
): number {
  if (keywordsA.length === 0 && keywordsB.length === 0) return 0;

  const mapB = new Map(keywordsB.map((k) => [k.word, k.weight]));

  let intersectionWeight = 0;
  let unionWeight = 0;

  // 遍历 A：交集/并集均取较大权重
  const processedWords = new Set<string>();
  for (const { word, weight: weightA } of keywordsA) {
    processedWords.add(word);
    const weightB = mapB.get(word);
    if (weightB !== undefined) {
      intersectionWeight += Math.max(weightA, weightB);
    }
    unionWeight += Math.max(weightA, weightB ?? 0);
  }

  // 遍历 B 中不在 A 的词，补并集权重
  for (const { word, weight } of keywordsB) {
    if (!processedWords.has(word)) {
      unionWeight += weight;
    }
  }

  if (unionWeight === 0) return 0;
  return intersectionWeight / unionWeight;
}
