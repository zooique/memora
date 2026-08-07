/**
 * 目标一致性校验器（P3.1 目标版本一致性校验）
 *
 * 提供两层校验：确定性层（关键约束提取 + 文本相似度）+ LLM 层（可选，仅对需确认场景生成解释）。
 * 关键约束为用户显式声明或确定性规则提取，不依赖 LLM 提取（防自我引用）。
 *
 * 设计文档：docs/根基/不中断工作模型演进.html §07
 *
 * 漂移等级：
 * - same（>0.7）：目标一致，无需用户确认
 * - confirm（0.4-0.7）：目标有变化，建议用户确认
 * - drift（<0.4）：目标漂移，需要用户确认
 */

/**
 * 漂移等级
 *
 * 基于文本相似度阈值划分：
 * - same: 相似度 > 0.7，目标基本一致，自动应用
 * - confirm: 相似度 0.4-0.7，目标有变化，建议用户确认
 * - drift: 相似度 < 0.4，目标漂移，需要用户确认
 */
export type DriftLevel = 'same' | 'confirm' | 'drift';

/** 一致性校验结果 */
export interface GoalConsistencyResult {
  /** 漂移等级 */
  level: DriftLevel;
  /** 文本相似度（0-1） */
  similarity: number;
  /** 从 mainGoal 中提取的关键约束列表 */
  constraints: string[];
  /** 约束一致性（true = 所有约束均满足，false = 有约束冲突） */
  constraintsConsistent: boolean;
  /** 冲突的约束说明（可选，仅 constraintsConsistent 为 false 时有值） */
  conflictExplanation?: string;
}

/**
 * 目标一致性校验器
 *
 * 纯函数式设计，无状态、无副作用。
 * 可在 SessionManager 或 Agent 层直接使用，不依赖任何外部服务。
 */
export class GoalConsistencyChecker {
  /**
   * 提取关键约束
   *
   * 从目标描述中提取用户显式声明的约束条件。
   * 使用确定性规则提取，不依赖 LLM（防自我引用）。
   *
   * 提取规则：
   * - 包含"必须"、"不能"、"需要"、"确保"、"禁止"、"只能"、"至少"等关键词的句子段
   * - 去重后返回
   *
   * @param goal - 目标描述
   * @returns 关键约束列表
   */
  extractConstraints(goal: string): string[] {
    if (!goal || goal.trim() === '') return [];

    const constraints: string[] = [];

    // 约束关键词匹配模式——直接提取包含约束关键词的文本片段
    const constraintPatterns = [
      /必须[^，。！？；\n,;.!?]*/g,
      /不能[^，。！？；\n,;.!?]*/g,
      /需要[^，。！？；\n,;.!?]*/g,
      /确保[^，。！？；\n,;.!?]*/g,
      /禁止[^，。！？；\n,;.!?]*/g,
      /只能[^，。！？；\n,;.!?]*/g,
      /至少[^，。！？；\n,;.!?]*/g,
      /不允许[^，。！？；\n,;.!?]*/g,
      /应当[^，。！？；\n,;.!?]*/g,
      /不得[^，。！？；\n,;.!?]*/g,
    ];

    for (const pattern of constraintPatterns) {
      const matches = goal.match(pattern);
      if (matches) {
        constraints.push(...matches.map(m => m.trim()));
      }
    }

    // 去重
    return [...new Set(constraints)];
  }

  /**
   * 计算文本相似度
   *
   * 使用 Jaccard 相似度 + 字符级 bigram 混合策略：
   * - 长文本（> 20 字符）：Jaccard 相似度（基于 token 分词）
   * - 短文本（<= 20 字符）：字符级 bigram 相似度
   *
   * @param a - 文本 A
   * @param b - 文本 B
   * @returns 相似度（0-1）
   */
  computeSimilarity(a: string, b: string): number {
    if (!a && !b) return 1;
    if (!a || !b) return 0;

    const aTrim = a.trim();
    const bTrim = b.trim();

    if (aTrim === bTrim) return 1;

    // 短文本：字符级 bigram 相似度（对短文本更敏感）
    if (aTrim.length <= 20 || bTrim.length <= 20) {
      return this.bigramSimilarity(aTrim, bTrim);
    }

    // 长文本：Jaccard 相似度
    return this.jaccardSimilarity(aTrim, bTrim);
  }

  /**
   * 执行一致性校验
   *
   * 两步校验：
   * 1. 提取 mainGoal 的关键约束
   * 2. 计算 mainGoal 与 newGoal 的文本相似度，确定漂移等级
   * 3. 检查约束在新目标中是否仍然满足
   *
   * @param mainGoal - 原始目标（防漂移锚点）
   * @param newGoal - 新目标（用户提出的修正）
   * @returns 一致性校验结果
   */
  checkConsistency(mainGoal: string, newGoal: string): GoalConsistencyResult {
    const constraints = this.extractConstraints(mainGoal);
    const similarity = this.computeSimilarity(mainGoal, newGoal);

    // 确定漂移等级
    let level: DriftLevel;
    if (similarity > 0.7) {
      level = 'same';
    } else if (similarity >= 0.4) {
      level = 'confirm';
    } else {
      level = 'drift';
    }

    // 检查约束一致性
    const { constraintsConsistent, conflictExplanation } = this.checkConstraintsConsistent(constraints, newGoal);

    return {
      level,
      similarity,
      constraints,
      constraintsConsistent,
      conflictExplanation,
    };
  }

  /**
   * 检查约束在新目标中是否仍然满足
   *
   * 对每个约束，提取其核心关键词（去除标记词），
   * 检查新目标是否包含这些关键词。
   * 全部满足则约束一致，否则标记冲突。
   *
   * @param constraints - 关键约束列表
   * @param newGoal - 新目标
   * @returns 约束一致性检查结果
   */
  private checkConstraintsConsistent(
    constraints: string[],
    newGoal: string,
  ): { constraintsConsistent: boolean; conflictExplanation?: string } {
    if (constraints.length === 0) {
      return { constraintsConsistent: true };
    }

    const conflictConstraints: string[] = [];

    for (const constraint of constraints) {
      // 提取约束中的核心关键词（去除标记词）
      const keywords = this.extractKeywords(constraint);
      // 检查新目标是否包含这些关键词
      const satisfied = keywords.some(k => newGoal.includes(k));
      if (!satisfied) {
        conflictConstraints.push(constraint);
      }
    }

    if (conflictConstraints.length > 0) {
      return {
        constraintsConsistent: false,
        conflictExplanation: `以下约束在新目标中未体现：${conflictConstraints.join('；')}`,
      };
    }

    return { constraintsConsistent: true };
  }

  /**
   * 提取约束中的核心关键词
   *
   * 去除约束标记词（必须/不能/需要等），保留核心名词短语。
   * 如"必须使用TypeScript" → "使用TypeScript"
   *
   * @param constraint - 约束文本
   * @returns 核心关键词列表
   */
  private extractKeywords(constraint: string): string[] {
    const cleaned = constraint
      .replace(/^(必须|不能|需要|确保|禁止|只能|至少|不允许|应当|不得)/, '')
      .trim();
    // 进一步按分隔符提取关键词
    const parts = cleaned.split(/[,，、\s]+/).filter(Boolean);
    return parts.length > 0 ? parts : [cleaned];
  }

  /**
   * Jaccard 相似度
   *
   * 将文本分词后计算交集/并集。
   * 分词策略：中文字符逐字 + 英文单词 + 数字。
   *
   * @param a - 文本 A
   * @param b - 文本 B
   * @returns Jaccard 相似度（0-1）
   */
  private jaccardSimilarity(a: string, b: string): number {
    const tokensA = this.tokenize(a);
    const tokensB = this.tokenize(b);

    if (tokensA.size === 0 && tokensB.size === 0) return 1;
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const token of tokensA) {
      if (tokensB.has(token)) intersection++;
    }

    const union = tokensA.size + tokensB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * 字符级 bigram 相似度
   *
   * 适用于短文本的相似度计算。
   * 将文本拆分为相邻字符对，计算交集/并集。
   *
   * @param a - 文本 A
   * @param b - 文本 B
   * @returns bigram 相似度（0-1）
   */
  private bigramSimilarity(a: string, b: string): number {
    const bigramsA = this.getBigrams(a);
    const bigramsB = this.getBigrams(b);

    if (bigramsA.size === 0 && bigramsB.size === 0) return 1;
    if (bigramsA.size === 0 || bigramsB.size === 0) return 0;

    let intersection = 0;
    for (const bigram of bigramsA) {
      if (bigramsB.has(bigram)) intersection++;
    }

    const union = bigramsA.size + bigramsB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  /**
   * 分词
   *
   * 提取中文字符（逐字）、英文单词（小写）、数字。
   * 不依赖第三方分词库，零外部依赖。
   *
   * @param text - 待分词文本
   * @returns token 集合
   */
  private tokenize(text: string): Set<string> {
    const tokens = new Set<string>();

    // 提取中文字符序列（逐字作为 token，对中文更敏感）
    const chineseChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g);
    if (chineseChars) {
      for (const seq of chineseChars) {
        for (const char of seq) {
          tokens.add(char);
        }
      }
    }

    // 提取英文单词（小写归一化，大小写不敏感）
    const englishWords = text.match(/[a-zA-Z_][a-zA-Z0-9_]*/g);
    if (englishWords) {
      for (const word of englishWords) {
        tokens.add(word.toLowerCase());
      }
    }

    // 提取数字
    const numbers = text.match(/\d+/g);
    if (numbers) {
      for (const num of numbers) {
        tokens.add(num);
      }
    }

    return tokens;
  }

  /**
   * 获取字符级 bigram
   *
   * 将文本拆分为相邻字符对。
   * 如 "TypeScript" → ["Ty", "yp", "pe", "eS", "Sc", "cr", "ri", "ip", "pt"]
   *
   * @param text - 文本
   * @returns bigram 集合
   */
  private getBigrams(text: string): Set<string> {
    const bigrams = new Set<string>();
    for (let i = 0; i < text.length - 1; i++) {
      bigrams.add(text.slice(i, i + 2));
    }
    return bigrams;
  }
}