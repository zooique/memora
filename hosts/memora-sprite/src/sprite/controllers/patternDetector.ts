/**
 * 记忆模式检测器 — 从记忆数据中自动发现用户的模式、习惯和知识缺口
 *
 * 职责：
 *   1. 检测重复主题：同一 source 下高频关键词聚类
 *   2. 检测知识缺口：用户问了但没被回答/记录的问题
 *   3. 检测兴趣漂移：近期记忆 topic 分布变化
 *   4. 纯代码计算，不依赖 LLM，不新增存储
 *
 * 设计原则：
 *   - 不存储模式——每次从现有数据实时推导
 *   - 不在核心库实现——纯宿主层逻辑
 *   - 为 ProactiveEngine 提供"说什么"的内容素材
 *   - 与感知系统（ContextAwareness/AffectController/RapportController）互补：
 *     感知系统 → 决定"何时说"+"用什么语气"
 *     PatternDetector → 决定"说什么内容"
 */

import type { Memory } from 'memora';
import { logger } from 'memora';
import { MS_PER_WEEK } from '../constants.js';

// ─── 类型定义 ────────────────────────────────────────────

/** 检测到的模式类型 */
export type PatternType = 'recurring_topic' | 'knowledge_gap' | 'interest_drift';

/** 检测到的用户模式 */
export interface DetectedPattern {
  /** 模式类型 */
  type: PatternType;
  /** 人类可读摘要 */
  summary: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 相关记忆 ID 列表 */
  relatedMemoryIds: string[];
  /** 建议操作（供 ProactiveEngine 生成提示） */
  suggestion?: string;
}

/** PatternDetector 构造选项 */
export interface PatternDetectorOptions {
  /** 近期分析窗口（毫秒），默认 7 天 */
  recentWindowMs: number;
  /** 重复主题最小出现次数，默认 3 */
  minTopicOccurrences: number;
  /** 兴趣漂移最小变化比例，默认 0.3 */
  minDriftRatio: number;
}

// ─── 常量 ────────────────────────────────────────────────

/** 默认近期窗口：7 天（= MS_PER_WEEK） */
const DEFAULT_RECENT_WINDOW_MS = MS_PER_WEEK;

/** 默认最小出现次数 */
const DEFAULT_MIN_OCCURRENCES = 3;

/** 默认最小漂移比例 */
const DEFAULT_MIN_DRIFT_RATIO = 0.3;

/** 知识缺口检测默认置信度 */
const DEFAULT_KNOWLEDGE_GAP_CONFIDENCE = 0.6;

/** 中文停用词（高频虚词，关键词提取时过滤） */
const STOP_WORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它', '们', '那', '些',
  '什么', '怎么', '如何', '为什么', '可以', '这个', '那个', '还是', '只是',
  '已经', '因为', '所以', '但是', '如果', '虽然', '而且', '然后', '之后',
  '之前', '时候', '现在', '以后', '需要', '应该', '可能', '能够', '知道',
  '觉得', '认为', '想', '让', '把', '被', '从', '对', '与', '或', '及',
  '等', '中', '其', '为', '以', '所', '而', '且', '但', '却', '则',
  '过', '还', '又', '再', '才', '刚', '将', '正', '正在', '一直',
  '用', '做', '能', '来', '里', '外', '前', '后',
  '比', '更', '最', '非常', '比较', '特别', '太', '真', '真的',
  '吗', '呢', '吧', '啊', '哦', '嗯', '哈', '呀', '嘛',
]);

/** 关键词最小长度（字符） */
const MIN_KEYWORD_LENGTH = 2;

// ─── PatternDetector 类 ──────────────────────────────────

/**
 * 记忆模式检测器
 *
 * 从记忆数据中自动发现用户的模式，为 ProactiveEngine 提供具体内容。
 * 纯宿主层实现，零内核改动，零存储开销。
 */
export class PatternDetector {
  private options: PatternDetectorOptions;

  constructor(options: Partial<PatternDetectorOptions> = {}) {
    this.options = {
      recentWindowMs: options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS,
      minTopicOccurrences: options.minTopicOccurrences ?? DEFAULT_MIN_OCCURRENCES,
      minDriftRatio: options.minDriftRatio ?? DEFAULT_MIN_DRIFT_RATIO,
    };
  }

  /**
   * 从记忆数据中检测所有模式
   *
   * @param memories 所有记忆列表
   * @returns 检测到的模式列表（按置信度降序）
   */
  detectPatterns(memories: Memory[]): DetectedPattern[] {
    if (memories.length === 0) return [];

    const patterns: DetectedPattern[] = [];

    // 分离近期和远期记忆
    const windowStart = Date.now() - this.options.recentWindowMs;
    const recentMemories = memories.filter(
      (m) => new Date(m.createdAt).getTime() >= windowStart,
    );
    const olderMemories = memories.filter(
      (m) => new Date(m.createdAt).getTime() < windowStart,
    );

    // 检测重复主题（基于近期记忆）
    if (recentMemories.length >= this.options.minTopicOccurrences) {
      const topicPatterns = this.detectRecurringTopics(recentMemories);
      patterns.push(...topicPatterns);
    }

    // 检测知识缺口（基于全部记忆）
    const gapPatterns = this.detectKnowledgeGaps(memories);
    patterns.push(...gapPatterns);

    // 检测兴趣漂移（需要近期和远期都有数据）
    if (recentMemories.length > 0 && olderMemories.length > 0) {
      const driftPatterns = this.detectInterestDrift(recentMemories, olderMemories);
      patterns.push(...driftPatterns);
    }

    // 按置信度降序排列
    patterns.sort((a, b) => b.confidence - a.confidence);

    logger.debug(
      { patternCount: patterns.length, types: patterns.map((p) => p.type) },
      'PatternDetector: 模式检测完成',
    );
    return patterns;
  }

  /**
   * 检测重复主题：在同一 source 下高频出现的关键词
   *
   * 策略：
   *   1. 按 source 分组
   *   2. 对每组提取关键词（分词 + 停用词过滤 + 频次统计）
   *   3. 关键词出现次数 ≥ minTopicOccurrences 且占比 ≥ 50% → 重复主题
   *
   * @param recentMemories 近期记忆列表
   * @returns 重复主题模式列表
   */
  private detectRecurringTopics(recentMemories: Memory[]): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    // 按 source 分组
    const sourceGroups = new Map<string, Memory[]>();
    for (const m of recentMemories) {
      const group = sourceGroups.get(m.source) ?? [];
      group.push(m);
      sourceGroups.set(m.source, group);
    }

    // 对每个 source 组检测重复主题
    for (const [source, group] of sourceGroups) {
      if (group.length < this.options.minTopicOccurrences) continue;

      // 提取该组的关键词及其频次
      const keywordCounts = this.extractKeywords(group);
      const groupTotal = group.length;

      // 找到高频关键词（占比 ≥ 50%）
      for (const [keyword, count] of keywordCounts) {
        const ratio = count / groupTotal;
        if (ratio >= 0.5) {
          // 生成中文 source 标签
          const sourceLabel = this.sourceLabel(source);
          patterns.push({
            type: 'recurring_topic',
            summary: `你在 ${sourceLabel} 方面反复讨论「${keyword}」（${count}/${groupTotal} 次）`,
            confidence: Math.min(1, ratio),
            relatedMemoryIds: group
              .filter((m) => m.content.includes(keyword))
              .map((m) => m.id),
            suggestion: `需要我帮你整理${sourceLabel}相关的记忆吗？`,
          });
        }
      }
    }

    return patterns;
  }

  /**
   * 检测知识缺口：用户问了但没找到答案的问题
   *
   * 策略：
   *   1. 找到所有包含 "?" 的记忆（问题）
   *   2. 检查每条问题之后是否有同 source 的后续记忆（可能的答案）
   *   3. 如果时间窗口内没有后续记忆 → 可能的知识缺口
   *
   * @param allMemories 所有记忆列表
   * @returns 知识缺口模式列表
   */
  private detectKnowledgeGaps(allMemories: Memory[]): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    // 按时间排序
    const sorted = [...allMemories].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    // 找到所有问题（包含 "?" 或 "？" 的记忆）
    const questions = sorted.filter(
      (m) => m.content.includes('?') || m.content.includes('？'),
    );

    for (const question of questions) {
      const questionTime = new Date(question.createdAt).getTime();

      // 找到该问题之后、同 source 的记忆（可能的答案）
      const hasFollowUp = sorted.some(
        (m) =>
          m.id !== question.id &&
          m.source === question.source &&
          new Date(m.createdAt).getTime() > questionTime &&
          new Date(m.createdAt).getTime() - questionTime <
            this.options.recentWindowMs,
      );

      // 没有后续记忆 → 可能的知识缺口
      if (!hasFollowUp) {
        // 提取问题中的关键主题词
        const questionText = question.content
          .replace(/[?？]/g, '')
          .trim()
          .slice(0, 30); // 取前 30 字符作为摘要

        patterns.push({
          type: 'knowledge_gap',
          summary: `你曾问过「${questionText}...」但还没有找到答案`,
          confidence: DEFAULT_KNOWLEDGE_GAP_CONFIDENCE, // 知识缺口判定有不确定性（可能用户自己解决了）
          relatedMemoryIds: [question.id],
          suggestion: `需要我帮你查找「${questionText}」的相关信息吗？`,
        });
      }
    }

    // 最多返回 3 个知识缺口（避免过多噪音）
    return patterns.slice(0, 3);
  }

  /**
   * 检测兴趣漂移：近期记忆的 source 分布 vs 远期记忆的 source 分布
   *
   * 策略：
   *   1. 分别统计近期和远期的 source 分布
   *   2. 计算每个 source 的比例变化
   *   3. 变化超过 minDriftRatio → 兴趣漂移
   *
   * @param recentMemories 近期记忆
   * @param olderMemories 远期记忆
   * @returns 兴趣漂移模式列表
   */
  private detectInterestDrift(
    recentMemories: Memory[],
    olderMemories: Memory[],
  ): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    // 计算近期 source 分布
    const recentSourceDist = this.getSourceDistribution(recentMemories);
    // 计算远期 source 分布
    const olderSourceDist = this.getSourceDistribution(olderMemories);

    // 合并所有 source
    const allSources = new Set([
      ...recentSourceDist.keys(),
      ...olderSourceDist.keys(),
    ]);

    for (const source of allSources) {
      const recentRatio = recentSourceDist.get(source) ?? 0;
      const olderRatio = olderSourceDist.get(source) ?? 0;
      const change = recentRatio - olderRatio;

      // 只关注显著变化
      if (Math.abs(change) < this.options.minDriftRatio) continue;

      const sourceLabel = this.sourceLabel(source);
      const direction = change > 0 ? '增加' : '减少';
      const absChange = Math.abs(change);

      patterns.push({
        type: 'interest_drift',
        summary: `你对 ${sourceLabel} 的关注度${direction}了 ${Math.round(absChange * 100)}%`,
        confidence: Math.min(1, absChange),
        relatedMemoryIds: recentMemories
          .filter((m) => m.source === source)
          .map((m) => m.id),
        suggestion:
          direction === '增加'
            ? `你最近似乎更关注${sourceLabel}了，需要我调整关注重点吗？`
            : undefined,
      });
    }

    return patterns;
  }

  /**
   * 从一组记忆中提取关键词及其频次
   *
   * 简单分词策略：按标点和空格切分 → 过滤停用词 → 过滤短词 → 统计频次
   *
   * @param memories 记忆列表
   * @returns 关键词 → 频次 映射（按频次降序）
   */
  private extractKeywords(memories: Memory[]): Map<string, number> {
    const keywordCounts = new Map<string, number>();

    for (const m of memories) {
      // 简单分词：按中英文标点和空格切分
      const tokens = m.content
        .split(/[\s,，。.!！?？;；:：、""''（）()【】\[\]《》<>\/\\|@#$%^&*+=~`]+/)
        .filter((t) => t.length >= MIN_KEYWORD_LENGTH) // 过滤短词
        .filter((t) => !STOP_WORDS.has(t)); // 过滤停用词

      // 同一记忆内去重（避免一条记忆反复出现同一词）
      const uniqueTokens = new Set(tokens);
      for (const token of uniqueTokens) {
        keywordCounts.set(token, (keywordCounts.get(token) ?? 0) + 1);
      }
    }

    // 按频次降序排列
    return new Map(
      [...keywordCounts.entries()].sort((a, b) => b[1] - a[1]),
    );
  }

  /**
   * 计算 source 分布（每个 source 的占比）
   *
   * @param memories 记忆列表
   * @returns source → 占比 映射
   */
  private getSourceDistribution(memories: Memory[]): Map<string, number> {
    const distribution = new Map<string, number>();
    const total = memories.length;
    if (total === 0) return distribution;

    for (const m of memories) {
      distribution.set(m.source, (distribution.get(m.source) ?? 0) + 1);
    }

    // 转为占比
    for (const [source, count] of distribution) {
      distribution.set(source, count / total);
    }

    return distribution;
  }

  /**
   * source 标签 → 中文友好名称
   *
   * @param source 原始 source 字符串
   * @returns 中文标签
   */
  private sourceLabel(source: string): string {
    const labels: Record<string, string> = {
      profile: '个人偏好',
      insight: '洞察',
      rule: '规则',
      skill: '技能',
      guardrail: '安全',
      chat: '对话',
      file: '文件',
      work: '工作',
      memory: '记忆',
      summary: '摘要',
      note: '笔记',
    };
    return labels[source] ?? source;
  }

  /**
   * 将检测到的用户模式转换为 LLM 可执行的行为指导文本，注入 system prompt
   *
   * 与 AffectController/RapportController/ContextAwareness 的 buildXxxPrompt 格式一致，
   * 输出自然语言行为指导，让 LLM 在对话中自然利用用户模式洞察。
   *
   * @param patterns detectPatterns() 返回的模式列表
   * @returns 注入到 system prompt 的行为指导文本；无模式时返回空字符串
   */
  buildPatternPrompt(patterns: DetectedPattern[]): string {
    if (patterns.length === 0) return '';

    const lines: string[] = ['【用户模式洞察】我从记忆数据中发现了以下模式，请在对话中自然地利用这些信息：'];

    // 按类型分组输出
    const recurringTopics = patterns.filter((p) => p.type === 'recurring_topic');
    const knowledgeGaps = patterns.filter((p) => p.type === 'knowledge_gap');
    const interestDrifts = patterns.filter((p) => p.type === 'interest_drift');

    if (recurringTopics.length > 0) {
      lines.push('- 关注焦点：');
      for (const p of recurringTopics.slice(0, 2)) {
        lines.push(`  · ${p.summary}`);
      }
      lines.push('  → 回应时可以主动关联这些反复出现的话题，体现你对其持续关注的了解');
    }

    if (knowledgeGaps.length > 0) {
      lines.push('- 悬而未决的问题：');
      for (const p of knowledgeGaps.slice(0, 2)) {
        lines.push(`  · ${p.summary}`);
      }
      lines.push('  → 如果话题相关，可以自然地提起这些未解答的问题，提供帮助');
    }

    if (interestDrifts.length > 0) {
      lines.push('- 兴趣变化：');
      for (const p of interestDrifts.slice(0, 2)) {
        lines.push(`  · ${p.summary}`);
      }
      lines.push('  → 注意用户关注重心的转移，适应当前的兴趣方向');
    }

    return lines.join('\n');
  }
}