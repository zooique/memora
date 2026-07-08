/**
 * 叙事摘要生成器 — 跨事件累积感知数据，合成一句话叙事
 *
 * 从 PerceptionRenderer 和 PerceptionPanelManager 的重复代码中提取。
 * 两个类各有一份完全相同的 lastNarrative* 状态 + generateNarrative 方法，
 * 违反 DRY 原则，统一提取为此类。
 *
 * 职责：
 * - 累积情感/默契/上下文/模式/在场 5 类感知数据
 * - 合成一句话叙事摘要（纯客户端，不触发 IPC，不依赖 LLM）
 *
 * 使用方式：
 * - 各感知数据更新时调用对应的 updateXxx() 方法
 * - 调用 generateNarrative() 获取当前叙事摘要文本
 */
import type {
  AffectPayload,
  RapportPayload,
  ContextPayload,
  PatternsPayload,
  PresencePayload,
} from './ipcListeners.js';

/** 情感基调阈值：超过此值认为该维度显著 */
const AFFECT_TONE_THRESHOLD = 0.6;

/**
 * 叙事摘要生成器类
 *
 * 累积 5 类感知数据，通过 generateNarrative() 合成一句话摘要。
 * 无 DOM 依赖，纯逻辑类，可被多个渲染器共享。
 */
export class NarrativeGenerator {
  // ─── 叙事摘要状态（跨事件累积，供 generateNarrative 合成） ──

  /** 对话上下文（节奏/连贯性/深度/主导来源） */
  private lastNarrativeContext: Pick<ContextPayload, 'rhythm' | 'coherence' | 'depth' | 'dominantSource'> | null = null;
  /** 情感基调（完整 AffectPayload） */
  private lastNarrativeAffect: AffectPayload | null = null;
  /** 默契度（等级 + 信任度） */
  private lastNarrativeRapport: Pick<RapportPayload, 'level' | 'trust'> | null = null;
  /** 模式洞察（类型 + 摘要，过滤掉置信度等技术细节） */
  private lastNarrativePatterns: Array<{ type: string; summary: string }> = [];
  /** 在场状态（present/away + 离开时间戳） */
  private lastNarrativePresence: { state: 'present' | 'away'; awaySince: number | null } | null = null;

  // ─── 数据更新方法 ─────────────────────────────────────────

  /**
   * 更新情感基调数据
   *
   * @param affect 情感基调 payload
   */
  updateAffect(affect: AffectPayload): void {
    this.lastNarrativeAffect = affect;
  }

  /**
   * 更新默契度数据（仅取叙事需要的 level + trust）
   *
   * @param rapport 默契度 payload
   */
  updateRapport(rapport: RapportPayload): void {
    this.lastNarrativeRapport = { level: rapport.level, trust: rapport.trust };
  }

  /**
   * 更新对话上下文数据（仅取叙事需要的字段）
   *
   * @param context 对话上下文 payload
   */
  updateContext(context: ContextPayload): void {
    this.lastNarrativeContext = {
      rhythm: context.rhythm,
      coherence: context.coherence,
      depth: context.depth,
      dominantSource: context.dominantSource,
    };
  }

  /**
   * 更新模式洞察数据（仅保留 type + summary，过滤技术细节）
   *
   * @param payload 模式洞察 payload
   */
  updatePatterns(payload: PatternsPayload): void {
    this.lastNarrativePatterns = payload.patterns.map((p) => ({
      type: p.type,
      summary: p.summary,
    }));
  }

  /**
   * 更新在场状态
   *
   * @param payload 在场状态 payload
   */
  updatePresence(payload: PresencePayload): void {
    if (payload.state === 'present') {
      this.lastNarrativePresence = { state: 'present', awaySince: null };
    } else {
      // awayDurationMs 是离开持续时间（毫秒），计算离开起始时间戳
      const awaySince = payload.awayDurationMs !== null && payload.awayDurationMs !== undefined
        ? Date.now() - payload.awayDurationMs
        : Date.now();
      this.lastNarrativePresence = { state: 'away', awaySince };
    }
  }

  // ─── 叙事合成 ─────────────────────────────────────────────

  /**
   * 生成叙事摘要文本
   *
   * 基于累积的 5 类感知数据，合成一句话自然语言描述。
   * 纯客户端合成，不触发 IPC，不依赖 LLM。
   *
   * @returns 叙事摘要文本
   */
  generateNarrative(): string {
    const parts: string[] = [];

    // 在场状态（用户离开时优先展示，覆盖其他叙事）
    if (this.lastNarrativePresence?.state === 'away' && this.lastNarrativePresence.awaySince !== null) {
      const awayMinutes = Math.max(1, Math.floor((Date.now() - this.lastNarrativePresence.awaySince) / 60000));
      parts.push(`用户已离开 ${awayMinutes} 分钟`);
    }

    // 对话上下文
    if (this.lastNarrativeContext && this.lastNarrativeContext.rhythm !== 'idle') {
      const rhythmLabel = this.describeRhythm(this.lastNarrativeContext.rhythm);
      parts.push(`对话节奏${rhythmLabel}`);
    }
    if (
      this.lastNarrativeContext &&
      this.lastNarrativeContext.coherence === 'focused' &&
      this.lastNarrativeContext.dominantSource
    ) {
      parts.push(`正在专注讨论${this.lastNarrativeContext.dominantSource}相关话题`);
    } else if (this.lastNarrativeContext && this.lastNarrativeContext.coherence === 'scattered') {
      parts.push('话题较为分散');
    }

    // 互动基调
    if (this.lastNarrativeAffect) {
      const tones: string[] = [];
      if (this.lastNarrativeAffect.warmth > AFFECT_TONE_THRESHOLD) tones.push('温暖');
      if (this.lastNarrativeAffect.directness > AFFECT_TONE_THRESHOLD) tones.push('直接');
      if (this.lastNarrativeAffect.initiative > AFFECT_TONE_THRESHOLD) tones.push('主动');
      if (tones.length > 0) {
        parts.push(`基调${tones.join('、')}`);
      }
    }

    // 默契度
    if (this.lastNarrativeRapport) {
      const levelLabel = this.getRapportLevelLabel(this.lastNarrativeRapport.level);
      if (levelLabel !== '初识') {
        parts.push(`默契度：${levelLabel}`);
      }
    }

    // 模式洞察
    if (this.lastNarrativePatterns.length > 0) {
      const recurringCount = this.lastNarrativePatterns.filter(
        (p) => p.type === 'recurring_topic',
      ).length;
      const gapCount = this.lastNarrativePatterns.filter(
        (p) => p.type === 'knowledge_gap',
      ).length;
      const patternDescs: string[] = [];
      if (recurringCount > 0) patternDescs.push(`${recurringCount} 个重复主题`);
      if (gapCount > 0) patternDescs.push(`${gapCount} 个知识缺口`);
      if (patternDescs.length > 0) {
        parts.push(`检测到${patternDescs.join('、')}`);
      }
    }

    if (parts.length === 0) {
      return '精灵正在感知中...';
    }

    return parts.join('，') + '。';
  }

  // ─── 私有辅助方法 ─────────────────────────────────────────

  /**
   * 默契度等级 → 中文标签映射
   *
   * 与 RapportLevel 真理源（stranger/acquaintance/familiar/close）保持一致。
   *
   * @param level 默契度等级字符串
   * @returns 中文标签（初识/相识/熟悉/亲密）
   */
  private getRapportLevelLabel(level: string): string {
    const labelMap: Record<string, string> = {
      stranger: '初识',
      acquaintance: '相识',
      familiar: '熟悉',
      close: '亲密',
    };
    return labelMap[level] ?? level;
  }

  /**
   * 对话节奏 → 中文标签映射
   *
   * 与 ContextAwareness.describeRhythm 真理源保持一致（rapid/normal/slow/idle）。
   *
   * @param rhythm 节奏类型
   * @returns 中文标签（快节奏/正常/慢节奏/空闲）
   */
  private describeRhythm(rhythm: string): string {
    const rhythmMap: Record<string, string> = {
      rapid: '快节奏',
      normal: '正常',
      slow: '慢节奏',
      idle: '空闲',
    };
    return rhythmMap[rhythm] ?? rhythm;
  }

  // ─── 状态查询（供外部判断是否 idle 等） ─────────────────

  /**
   * 当前对话是否处于 idle（停滞）状态
   *
   * 用于精灵状态条等场景：idle 状态下不更新显示，保持默认文字。
   *
   * @returns true 表示 idle 状态或无上下文数据
   */
  isIdle(): boolean {
    return this.lastNarrativeContext?.rhythm === 'idle' || !this.lastNarrativeContext;
  }

  // ─── 重置（切换会话/项目时清理） ──────────────────────────

  /**
   * 重置所有叙事状态
   *
   * 切换会话或项目时调用，清除累积的感知数据。
   */
  reset(): void {
    this.lastNarrativeContext = null;
    this.lastNarrativeAffect = null;
    this.lastNarrativeRapport = null;
    this.lastNarrativePatterns = [];
    this.lastNarrativePresence = null;
  }
}
