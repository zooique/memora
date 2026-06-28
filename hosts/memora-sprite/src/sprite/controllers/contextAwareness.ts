/**
 * 对话上下文感知器 — 从记忆数据中实时推导当前对话的节奏、话题和深度
 *
 * 职责：
 *   1. 从最近记忆推导对话节奏（消息频率、活跃时段）
 *   2. 从 source 分布推导话题连贯性（是否在连续讨论同一话题）
 *   3. 从内容特征推导对话深度（浅层问答 vs 深度讨论）
 *   4. 生成自然语言上下文提示，注入到 Agent system prompt
 *   5. 纯代码计算，不依赖 LLM，不新增存储
 *
 * 设计原则：
 *   - 不存储上下文状态——每次从现有数据实时推导
 *   - 不在核心库实现——纯宿主层逻辑
 *   - 与 AffectController / RapportController 互补，形成完整感知三角：
 *     AffectController → 当前互动基调（语气）
 *     RapportController → 长期关系质量（信任）
 *     ContextAwareness → 当前对话上下文（节奏 + 话题 + 深度）
 *
 * 数据源：
 *   - agent.memory.list() → 所有记忆（含 createdAt、source、content）
 *   - 分析窗口：最近 1 小时内的记忆（可配置）
 */

import type { Memory } from 'memora';
import { logger } from 'memora';

// ─── 类型定义 ────────────────────────────────────────────

/** 对话节奏类型 */
export type RhythmType = 'rapid' | 'normal' | 'slow' | 'idle';

/** 话题连贯性等级 */
export type CoherenceLevel = 'focused' | 'moderate' | 'scattered' | 'none';

/** 对话深度等级 */
export type DepthLevel = 'deep' | 'moderate' | 'shallow' | 'none';

/** 对话上下文状态 */
export interface ContextState {
  /** 对话节奏 */
  rhythm: RhythmType;
  /** 话题连贯性 */
  coherence: CoherenceLevel;
  /** 对话深度 */
  depth: DepthLevel;
  /** 当前主导话题域（基于 source 分布最多的 source） */
  dominantSource: string | null;
  /** 上下文描述（自然语言，用于 UI 展示） */
  description: string;
}

/** ContextAwareness 构造选项 */
export interface ContextAwarenessOptions {
  /** 分析窗口（毫秒），默认 1 小时 */
  analysisWindowMs: number;
  /** 最近消息数上限（用于节奏分析），默认 50 */
  maxRecentMessages: number;
}

// ─── 常量 ────────────────────────────────────────────────

/** 默认分析窗口：1 小时 */
const DEFAULT_ANALYSIS_WINDOW_MS = 60 * 60 * 1000;

/** 默认最近消息数上限 */
const DEFAULT_MAX_RECENT = 50;

/** 节奏判定：每小时消息数阈值 */
const RAPID_THRESHOLD = 20; // 每小时 > 20 条 → 快节奏
const SLOW_THRESHOLD = 5;   // 每小时 < 5 条 → 慢节奏
const IDLE_THRESHOLD = 1;   // 每小时 < 1 条 → 空闲

/** 连贯性判定：主导 source 占比阈值 */
const FOCUSED_THRESHOLD = 0.7;  // 主导 source 占比 > 70% → 专注
const SCATTERED_THRESHOLD = 0.3; // 主导 source 占比 < 30% → 分散

/** 深度判定：平均内容长度阈值 */
const DEEP_LENGTH_THRESHOLD = 200;    // 平均长度 > 200 字符 → 深度
const SHALLOW_LENGTH_THRESHOLD = 50;  // 平均长度 < 50 字符 → 浅层

// ─── ContextAwareness 类 ─────────────────────────────────

/**
 * 对话上下文感知器
 *
 * 从最近记忆数据中实时推导对话节奏、话题连贯性和对话深度。
 * 纯宿主层实现，零内核改动，零存储开销。
 */
export class ContextAwareness {
  private options: ContextAwarenessOptions;

  constructor(options: Partial<ContextAwarenessOptions> = {}) {
    this.options = {
      analysisWindowMs: options.analysisWindowMs ?? DEFAULT_ANALYSIS_WINDOW_MS,
      maxRecentMessages: options.maxRecentMessages ?? DEFAULT_MAX_RECENT,
    };
  }

  /**
   * 更新配置
   */
  updateOptions(options: Partial<ContextAwarenessOptions>): void {
    if (options.analysisWindowMs !== undefined) {
      this.options.analysisWindowMs = options.analysisWindowMs;
    }
    if (options.maxRecentMessages !== undefined) {
      this.options.maxRecentMessages = options.maxRecentMessages;
    }
  }

  /**
   * 从记忆数据中推导对话上下文
   *
   * @param memories 所有记忆列表（将按时间窗口过滤）
   * @returns 对话上下文状态
   */
  deriveContext(memories: Memory[]): ContextState {
    // 过滤分析窗口内的记忆
    const windowStart = Date.now() - this.options.analysisWindowMs;
    const recentMemories = memories
      .filter((m) => new Date(m.createdAt).getTime() >= windowStart)
      .slice(0, this.options.maxRecentMessages);

    // 无最近记忆 → 空闲状态
    if (recentMemories.length === 0) {
      const idleState: ContextState = {
        rhythm: 'idle',
        coherence: 'none',
        depth: 'none',
        dominantSource: null,
        description: '当前没有最近的对话活动',
      };
      logger.debug({ ...idleState }, 'ContextAwareness: 上下文已推导（空闲）');
      return idleState;
    }

    // 推导三个维度
    const rhythm = this.deriveRhythm(recentMemories);
    const coherence = this.deriveCoherence(recentMemories);
    const depth = this.deriveDepth(recentMemories);
    const dominantSource = this.getDominantSource(recentMemories);

    const context: ContextState = {
      rhythm,
      coherence,
      depth,
      dominantSource,
      description: this.buildDescription(rhythm, coherence, depth, dominantSource),
    };

    logger.debug({ ...context }, 'ContextAwareness: 上下文已推导');
    return context;
  }

  /**
   * 推导对话节奏
   *
   * 基于分析窗口内记忆数量推算消息频率（条/小时）
   */
  private deriveRhythm(memories: Memory[]): RhythmType {
    const hoursSpan = this.options.analysisWindowMs / (1000 * 60 * 60);
    const messagesPerHour = memories.length / hoursSpan;

    if (messagesPerHour >= RAPID_THRESHOLD) return 'rapid';
    if (messagesPerHour >= SLOW_THRESHOLD) return 'normal';
    if (messagesPerHour >= IDLE_THRESHOLD) return 'slow';
    return 'idle';
  }

  /**
   * 推导话题连贯性
   *
   * 基于 source 分布：主导 source 占比越高 → 话题越连贯
   */
  private deriveCoherence(memories: Memory[]): CoherenceLevel {
    if (memories.length === 0) return 'none';

    const sourceCounts = new Map<string, number>();
    for (const m of memories) {
      sourceCounts.set(m.source, (sourceCounts.get(m.source) ?? 0) + 1);
    }

    // 找到最高频 source
    let maxCount = 0;
    for (const count of sourceCounts.values()) {
      if (count > maxCount) maxCount = count;
    }

    const dominantRatio = maxCount / memories.length;

    if (dominantRatio >= FOCUSED_THRESHOLD) return 'focused';
    if (dominantRatio >= SCATTERED_THRESHOLD) return 'moderate';
    return 'scattered';
  }

  /**
   * 推导对话深度
   *
   * 基于最近记忆的平均内容长度
   */
  private deriveDepth(memories: Memory[]): DepthLevel {
    if (memories.length === 0) return 'none';

    const avgLength = memories.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) / memories.length;

    if (avgLength >= DEEP_LENGTH_THRESHOLD) return 'deep';
    if (avgLength >= SHALLOW_LENGTH_THRESHOLD) return 'moderate';
    return 'shallow';
  }

  /**
   * 获取主导 source（最高频）
   */
  private getDominantSource(memories: Memory[]): string | null {
    if (memories.length === 0) return null;

    const sourceCounts = new Map<string, number>();
    for (const m of memories) {
      sourceCounts.set(m.source, (sourceCounts.get(m.source) ?? 0) + 1);
    }

    let maxSource: string | null = null;
    let maxCount = 0;
    for (const [source, count] of sourceCounts) {
      if (count > maxCount) {
        maxCount = count;
        maxSource = source;
      }
    }

    return maxSource;
  }

  /**
   * 构建上下文描述文本
   */
  private buildDescription(
    rhythm: RhythmType,
    coherence: CoherenceLevel,
    depth: DepthLevel,
    dominantSource: string | null,
  ): string {
    const rhythmLabel = ContextAwareness.describeRhythm(rhythm);
    const coherenceLabel = ContextAwareness.describeCoherence(coherence);
    const depthLabel = ContextAwareness.describeDepth(depth);

    let desc = `节奏：${rhythmLabel}，话题：${coherenceLabel}，深度：${depthLabel}`;
    if (dominantSource) {
      desc += `，主导域：${dominantSource}`;
    }
    return desc;
  }

  /**
   * 将上下文状态转换为自然语言描述（注入 system prompt 用）
   *
   * 生成格式：
   *   "【当前对话上下文】节奏：快节奏 | 话题：专注 | 深度：深度讨论"
   *
   * 与 AffectController.buildAffectPrompt / RapportController.buildRapportPrompt 互补。
   *
   * @param context 上下文状态
   * @returns 自然语言描述文本
   */
  buildContextPrompt(context: ContextState): string {
    const rhythmLabel = ContextAwareness.describeRhythm(context.rhythm);
    const coherenceLabel = ContextAwareness.describeCoherence(context.coherence);
    const depthLabel = ContextAwareness.describeDepth(context.depth);

    return `【当前对话上下文】节奏：${rhythmLabel} | 话题：${coherenceLabel} | 深度：${depthLabel}`;
  }

  // ─── 静态工具方法 ──────────────────────────────────────

  /** 节奏 → 中文标签 */
  static describeRhythm(rhythm: RhythmType): string {
    switch (rhythm) {
      case 'rapid': return '快节奏';
      case 'normal': return '正常';
      case 'slow': return '慢节奏';
      case 'idle': return '空闲';
    }
  }

  /** 连贯性 → 中文标签 */
  static describeCoherence(coherence: CoherenceLevel): string {
    switch (coherence) {
      case 'focused': return '专注';
      case 'moderate': return '中等';
      case 'scattered': return '分散';
      case 'none': return '无';
    }
  }

  /** 深度 → 中文标签 */
  static describeDepth(depth: DepthLevel): string {
    switch (depth) {
      case 'deep': return '深度讨论';
      case 'moderate': return '一般讨论';
      case 'shallow': return '浅层问答';
      case 'none': return '无';
    }
  }
}