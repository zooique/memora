/**
 * 目标一致性校验器（目标版本一致性校验）。
 * 两层校验：确定性层（关键约束提取 + 文本相似度）+ LLM 层（可选，仅对需确认场景生成解释）。
 * 关键约束由确定性规则提取而非 LLM（防自我引用）。漂移等级：same(>0.7 无需确认)/confirm(0.4-0.7 建议确认)/drift(<0.4 需确认)。
 */

/** 漂移等级：same(>0.7 自动应用)/confirm(0.4-0.7 建议确认)/drift(<0.4 需确认) */
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

/** 目标一致性校验器：纯函数式（无状态无副作用），SessionManager / Agent 层直接可用，不依赖外部服务 */
export class GoalConsistencyChecker {
  /** 提取关键约束：从目标描述中按确定性规则提取"必须/不能/需要/确保"等关键词句段（不依赖 LLM 防自我引用），去重返回 */
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

  /** 计算文本相似度：长文本（>20 字符）用 Jaccard，短文本用字符级 bigram（对短文本更敏感） */
  computeSimilarity(a: string, b: string): number {
    if (!a && !b) return 1;
    if (!a || !b) return 0;

    const aTrim = a.trim();
    const bTrim = b.trim();

    if (aTrim === bTrim) return 1;

    // 短文本：字符级 bigram（对短文本更敏感）
    if (aTrim.length <= 20 || bTrim.length <= 20) {
      return this.bigramSimilarity(aTrim, bTrim);
    }

    // 长文本：Jaccard
    return this.jaccardSimilarity(aTrim, bTrim);
  }

  /** 执行一致性校验：提取约束 → 算相似度定漂移等级（>0.7 same / >=0.4 confirm / else drift）→ 检查约束是否仍满足 */
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

  /** 检查约束在新目标是否仍满足：对每条约束提取核心词，任一命中即视为满足；全不满足则标记冲突 */
  private checkConstraintsConsistent(
    constraints: string[],
    newGoal: string,
  ): { constraintsConsistent: boolean; conflictExplanation?: string } {
    if (constraints.length === 0) {
      return { constraintsConsistent: true };
    }

    const conflictConstraints: string[] = [];

    for (const constraint of constraints) {
      // 提取约束核心词并检查新目标是否包含
      const keywords = this.extractKeywords(constraint);
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

  /** 提取约束核心词：去除标记词保留核心名词短语（如"必须使用TypeScript" → "使用TypeScript"），再按分隔符切分 */
  private extractKeywords(constraint: string): string[] {
    const cleaned = constraint
      .replace(/^(必须|不能|需要|确保|禁止|只能|至少|不允许|应当|不得)/, '')
      .trim();
    const parts = cleaned.split(/[,，、\s]+/).filter(Boolean);
    return parts.length > 0 ? parts : [cleaned];
  }

  /** Jaccard 相似度：分词后交集/并集。分词策略：中文字符逐字 + 英文单词 + 数字 */
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

  /** 字符级 bigram 相似度：拆相邻字符对求交集/并集，适用于短文本 */
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

  /** 分词：提取中文字符（逐字，对中文更敏感）+ 英文单词（小写）+ 数字；零外部依赖 */
  private tokenize(text: string): Set<string> {
    const tokens = new Set<string>();

    // 中文字符序列（逐字作为 token）
    const chineseChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g);
    if (chineseChars) {
      for (const seq of chineseChars) {
        for (const char of seq) {
          tokens.add(char);
        }
      }
    }

    // 英文单词（小写归一化，大小写不敏感）
    const englishWords = text.match(/[a-zA-Z_][a-zA-Z0-9_]*/g);
    if (englishWords) {
      for (const word of englishWords) {
        tokens.add(word.toLowerCase());
      }
    }

    // 数字
    const numbers = text.match(/\d+/g);
    if (numbers) {
      for (const num of numbers) {
        tokens.add(num);
      }
    }

    return tokens;
  }

  /** 获取字符级 bigram：拆相邻字符对（如 "TypeScript" → ["Ty","yp",...]） */
  private getBigrams(text: string): Set<string> {
    const bigrams = new Set<string>();
    for (let i = 0; i < text.length - 1; i++) {
      bigrams.add(text.slice(i, i + 2));
    }
    return bigrams;
  }
}