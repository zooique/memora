/**
 * 主动提示引擎 — 事件累积 + 提示生成
 *
 * 职责：
 *   1. 累积待提示事件
 *   2. 冷却保护
 *   3. 上下文感知提示生成
 *
 * 移除 interaction 双通道输出，仅通过 emitSprite 发射 proactivePrompt 事件，
 * 宿主（main.ts 的事件监听器）负责接收事件并决定是否展示为 banner。
 */
import { logger } from 'memora';
import type { DashboardData } from './memoryController.js';
import type { ContextState } from './contextAwareness.js';
import type { AffectState } from './affectController.js';
import type { DetectedPattern } from './patternDetector.js';
import type { ProactiveStats } from '../../shared/spriteStats.js';
// MS_PER_DAY 用于连续拒绝时间衰减（距上次拒绝超过 24h 自动 -1，破解死锁）
import { MS_PER_DAY } from '../constants.js';

/** 待提示事件 */
interface PendingNotice {
  type: string;
  summary: string;
  timestamp: number;
  /** Phase 2.3：是否为里程碑事件（专属样式+庆祝反馈） */
  isMilestone?: boolean;
  /** 优先级：normal=受全部抑制约束 | high=绕过节奏抑制 | critical=绕过节奏+冷却 */
  priority?: 'normal' | 'high' | 'critical';
}

/** 主动提示配置 */
export interface ProactiveConfig {
  /** 事件阈值 */
  threshold: number;
  /** 冷却时间（毫秒） */
  cooldownMs: number;
  /** 是否静默模式 */
  silentMode: boolean;
}

/**
 * ProactiveEngine 可持久化状态快照
 *
 * 由 Sprite 在构造时从 spriteConfig 加载传入，运行时通过 persistCallback
 * 在状态变更后写回 spriteConfig。三项字段共同避免重启后的体验断点：
 *   - noticedMagnitudes/knownSources：避免重启重复触发同一里程碑
 *   - lastRejectAt：使 consecutiveRejects 衰减得以跨重启延续，破解死锁
 */
export interface ProactivePersistentState {
  /** 已通知的记忆量级列表（Math.log10(total) 取整，如 2=百/3=千） */
  noticedMagnitudes: number[];
  /** 已知 source 类型集合（chat/insight/profile/rule 等） */
  knownSources: string[];
  /** 上次用户拒绝时间戳；null 表示从未拒绝或已完全衰减 */
  lastRejectAt: number | null;
}

/**
 * 状态持久化回调类型（由 Sprite 注入，写入 spriteConfig）
 *
 * 在 noticedMagnitudes/knownSources/lastRejectAt 任一变更时调用。
 */
export type ProactiveStateCallback = (state: ProactivePersistentState) => void;

/** 精灵事件发射器 */
export type SpriteEmitter = (event: 'proactivePrompt', payload: {
  prompt: string;
  triggers: string[];
  silent: boolean;
  isMilestone?: boolean;
  /** 轻量提示标志：true 时宿主跳过系统通知，仅托盘脉冲 + 窗口内提示（方向 A 召回场景） */
  lightweight?: boolean;
}) => void;

/** 里程碑事件回调（Phase 2.3：供 Sprite 发射专门的 milestoneAchieved 事件） */
export type MilestoneCallback = (milestone: MilestoneTrigger) => void;

/** 里程碑触发结果（Phase 2.3） */
export interface MilestoneTrigger {
  /** 里程碑类型标识（如 memory_magnitude_2、new_source_profile） */
  type: string;
  /** 人类可读描述（用于 addNotice 摘要） */
  summary: string;
}

/** 主动提示引擎 */
export class ProactiveEngine {
  /** pendingNotices 最大累积上限，防止长时间静默或 cooldown 期间内存泄漏 */
  private static readonly MAX_PENDING_NOTICES = 100;
  /** 单次发射事件上限，防止 banner 文本溢出（剩余留待下次冷却结束后发射） */
  private static readonly MAX_EMIT_BATCH = 5;
  /** 连续拒绝衰减阈值，距上次拒绝每过 24h 自动 -1 */
  private static readonly REJECT_DECAY_MS = MS_PER_DAY;

  /** Phase 2.3：已通知的记忆量级（跨重启持久化保留） */
  private noticedMagnitudes: Set<number> = new Set();
  /** Phase 2.3：已知的 source 类型（首次出现时触发里程碑；跨重启持久化保留） */
  private knownSources: Set<string> = new Set();
  /** 首次 checkMilestones 仅初始化已知状态，不触发通知（避免冷启动首发提示） */
  private milestoneInitialized = false;

  /** Phase 2.1：主动提示次数（供 AffectController 计算接受率） */
  private suggestCount = 0;
  /** Phase 2.1：用户接受次数（供 AffectController 计算接受率） */
  private acceptCount = 0;

  private config: ProactiveConfig;
  private emitSprite: SpriteEmitter | null = null;
  /** Phase 2.3：里程碑事件回调（供 Sprite 发射专门的 milestoneAchieved 事件） */
  private onMilestone: MilestoneCallback | null = null;
  /** 状态持久化回调（noticedMagnitudes/knownSources/lastRejectAt 变更时调用） */
  private persistCallback: ProactiveStateCallback | null = null;
  private pendingNotices: PendingNotice[] = [];
  private lastProactiveAt = 0;

  /** 连续拒绝次数上限（防止冷却时间无限增长，上限约 6x 基础冷却） */
  private static readonly MAX_CONSECUTIVE_REJECTS = 10;

  // ─── Phase 1：智能触发时机（感知系统整合） ──────────────
  /** 当前对话上下文状态（ContextAwareness 推导） */
  private contextState: ContextState | null = null;
  /** 当前默契度等级 0-1（RapportController 推导） */
  private rapportLevel = 0;
  /** 连续拒绝次数（自适应冷却：每次拒绝延长冷却，接受重置；跨重启时间衰减） */
  private consecutiveRejects = 0;
  /** 上次用户拒绝时间戳，用于时间衰减 consecutiveRejects；null 表示从未拒绝或已完全衰减 */
  private lastRejectAt: number | null = null;
  /** 当前情感基调（Phase 2：个性化提示内容） */
  private affectState: AffectState | null = null;

  // ─── Phase 2+：模式驱动提示（PatternDetector 集成） ──────────────
  /** 检测到的用户模式（PatternDetector 最新结果） */
  private detectedPatterns: DetectedPattern[] = [];
  /** 已通过模式提示过的模式摘要（幂等保护，避免重复提示同一模式） */
  private promptedPatterns: Set<string> = new Set();

  /**
   * @param config 主动提示配置
   * @param initialState 可选持久化状态（跨重启保留里程碑幂等集合与拒绝衰减时间戳）
   */
  constructor(config: ProactiveConfig, initialState?: ProactivePersistentState) {
    this.config = config;

    // 从持久化状态恢复已知集合，避免重启后对已有量级/source 重复触发里程碑
    if (initialState) {
      for (const m of initialState.noticedMagnitudes) {
        this.noticedMagnitudes.add(m);
      }
      for (const s of initialState.knownSources) {
        this.knownSources.add(s);
      }
      this.lastRejectAt = initialState.lastRejectAt;
      // 已有持久化状态时，跳过首次 checkMilestones 的"仅初始化不触发"逻辑，
      // 否则会导致已知集合被重置后又触发一遍同一里程碑。
      if (initialState.noticedMagnitudes.length > 0 || initialState.knownSources.length > 0) {
        this.milestoneInitialized = true;
      }
      // 重启后立即应用一次时间衰减，破解"连拒 10 次后冷却 6x 死锁"。
      // 不写回状态（构造阶段回调尚未注入），由后续变更触发持久化。
      this.applyRejectDecay();
    }
  }

  /** 设置事件发射器 */
  setEmitter(emit: SpriteEmitter): void {
    this.emitSprite = emit;
  }

  /**
   * 设置里程碑事件回调（Phase 2.3）
   *
   * 由 Sprite 在构造时设置，用于在检测到里程碑时发射专门的 milestoneAchieved 事件。
   * 里程碑事件比普通主动提示更重要，需要：
   *   1. 系统通知使用"🎉 里程碑达成"标题
   *   2. Banner 使用金色渐变庆祝样式
   *   3. 仪表盘记录里程碑历史
   */
  setMilestoneCallback(callback: MilestoneCallback): void {
    this.onMilestone = callback;
  }

  /**
   * 设置状态持久化回调（由 Sprite 在构造后注入）
   *
   * 在 noticedMagnitudes/knownSources/lastRejectAt 任一变更时调用，
   * 由 Sprite 写回 spriteConfig，避免重启后冷却状态/里程碑幂等集合丢失。
   */
  setPersistCallback(callback: ProactiveStateCallback): void {
    this.persistCallback = callback;
  }

  /**
   * 获取当前可持久化状态快照
   *
   * 由 Sprite 在持久化回调中接收，也可在外部主动读取（如批量保存前）。
   */
  getPersistentState(): ProactivePersistentState {
    return {
      noticedMagnitudes: Array.from(this.noticedMagnitudes),
      knownSources: Array.from(this.knownSources),
      lastRejectAt: this.lastRejectAt,
    };
  }

  /**
   * 通知状态变更（触发持久化回调）
   *
   * 仅在回调已注入时调用，避免构造阶段（回调尚未注入）的无效写入。
   */
  private notifyStateChange(): void {
    if (this.persistCallback) {
      this.persistCallback(this.getPersistentState());
    }
  }

  /**
   * 时间衰减 consecutiveRejects（破解"连拒 10 次后冷却 6x 死锁"）
   *
   * 策略：距上次拒绝每过 REJECT_DECAY_MS（24h），自动 -1；衰减到 0 时清除时间戳。
   *
   * 调用时机：
   *   1. 构造函数加载持久化状态后调用一次（重启后立即衰减）
   *   2. tryEmit 中每次计算冷却前调用（运行时持续衰减）
   */
  private applyRejectDecay(): void {
    if (this.lastRejectAt === null) return;
    const now = Date.now();
    const elapsed = now - this.lastRejectAt;
    if (elapsed < ProactiveEngine.REJECT_DECAY_MS) return;
    // 按整天数衰减（避免每分钟调用都触发持久化）
    const decaySteps = Math.floor(elapsed / ProactiveEngine.REJECT_DECAY_MS);
    const before = this.consecutiveRejects;
    this.consecutiveRejects = Math.max(0, this.consecutiveRejects - decaySteps);
    // 衰减到 0 后清除时间戳，避免记录无意义的时间戳
    if (this.consecutiveRejects === 0) {
      this.lastRejectAt = null;
    } else {
      // 保留剩余未衰减时间的起点（向过去移动 decaySteps 天）
      this.lastRejectAt = now - (elapsed % ProactiveEngine.REJECT_DECAY_MS);
    }
    if (this.consecutiveRejects !== before) {
      this.notifyStateChange();
    }
  }

  /**
   * 更新配置
   *
   * @param config 部分配置更新（threshold / cooldownMs / silentMode）
   */
  updateConfig(config: Partial<ProactiveConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** 获取待提示事件数量 */
  get pendingCount(): number {
    return this.pendingNotices.length;
  }

  /**
   * 获取主动提示接受率（Phase 2.1：AffectController 情感推导）
   *
   * 纯计算，零副作用。suggestCount 为 0 时返回默认值 0.5。
   *
   * @returns 接受率 0-1
   */
  get acceptanceRate(): number {
    if (this.suggestCount === 0) return 0.5;
    return this.acceptCount / this.suggestCount;
  }

  /**
   * 聚合主动提示统计指标（供 UI 感知面板展示）
   *
   * 将分散的内部统计字段打包为统一快照，供 getPerceptionSnapshot() 透传到渲染层。
   * 包含两类信息：
   *   1. 历史反馈：suggestCount/acceptCount/acceptanceRate（用户与精灵的互动累计）
   *   2. 当前生效参数：consecutiveRejects/effectiveCooldownMs/baseCooldownMs
   *      （解释"为什么连续拒绝后精灵变安静"的自适应冷却机制）
   *
   * effectiveCooldownMs 与 tryEmit 内部计算保持一致：
   *   baseCooldown × (1 - rapportLevel × 0.5) × (1 + consecutiveRejects × 0.5)
   *
   * @returns 主动提示统计快照
   */
  getStats(): ProactiveStats {
    const rapportMultiplier = 1 - this.rapportLevel * 0.5;
    const rejectMultiplier = 1 + this.consecutiveRejects * 0.5;
    return {
      suggestCount: this.suggestCount,
      acceptCount: this.acceptCount,
      acceptanceRate: this.acceptanceRate,
      consecutiveRejects: this.consecutiveRejects,
      effectiveCooldownMs: Math.round(this.config.cooldownMs * rapportMultiplier * rejectMultiplier),
      baseCooldownMs: this.config.cooldownMs,
    };
  }

  /**
   * 记录用户接受了一次主动提示（Phase 2.1）
   *
   * 由宿主 UI 在用户点击"好的"时调用。
   */
  recordAccept(): void {
    this.acceptCount++;
    // 自适应冷却：接受后重置连续拒绝计数，缩短冷却
    this.consecutiveRejects = 0;
    // 接受后清除拒绝时间戳，避免下次衰减误把刚清零的计数再降
    if (this.lastRejectAt !== null) {
      this.lastRejectAt = null;
      this.notifyStateChange();
    }
  }

  /**
   * 记录用户拒绝/忽略了一次主动提示（Phase 1：自适应冷却）
   *
   * 由宿主 UI 在用户点击"稍后"或关闭提示时调用。
   * 每次拒绝递增计数器，使冷却时间逐步延长，避免频繁打扰。
   */
  recordReject(): void {
    // 连续拒绝次数有上限，防止冷却时间无限增长（MAX_CONSECUTIVE_REJECTS = 10 → 最大 6x）
    if (this.consecutiveRejects < ProactiveEngine.MAX_CONSECUTIVE_REJECTS) {
      this.consecutiveRejects++;
    }
    // 记录拒绝时间戳，供下次 tryEmit/构造时按 24h 衰减
    this.lastRejectAt = Date.now();
    this.notifyStateChange();
  }

  /**
   * 注入当前对话上下文状态（Phase 1：智能触发时机）
   *
   * 由 Sprite 在每次 wakeup 推导后调用，用于在 tryEmit 中判断是否适合触发提示。
   *
   * @param state ContextAwareness 推导的上下文状态
   */
  setContextState(state: ContextState): void {
    this.contextState = state;
  }

  /**
   * 注入当前默契度等级（Phase 1：自适应冷却）
   *
   * 由 Sprite 在每次 wakeup 推导后调用，用于调整冷却时间。
   * 默契度越高 → 冷却越短 → 提示更频繁。
   *
   * @param level 默契度等级 0-1
   */
  setRapportLevel(level: number): void {
    this.rapportLevel = Math.max(0, Math.min(1, level));
  }

  /**
   * 注入当前情感基调（Phase 2：个性化提示内容）
   *
   * 由 Sprite 在每次 wakeup 推导后调用，用于 buildPrompt 中调整提示语气。
   *
   * @param state AffectController 推导的情感基调
   */
  setAffectState(state: AffectState): void {
    this.affectState = state;
  }

  /**
   * 注入检测到的用户模式（Phase 2+：模式驱动提示）
   *
   * 由 Sprite 在每次 wakeup 推导后调用，将 PatternDetector 的结果注入。
   * 模式数据用于 buildPrompt 生成更具体、更有价值的提示内容。
   *
   * @param patterns 检测到的用户模式列表
   */
  setPatterns(patterns: DetectedPattern[]): void {
    this.detectedPatterns = patterns;
  }

  /**
   * 检查待提示事件并尝试发射（Phase 3.2：用户回来时触发）
   *
   * 与 addNotice 内部的自动触发不同，此方法用于外部主动检查。
   * 例如用户离开一段时间后回来，应检查是否有累积的待提示事件。
   * 受 silentMode、cooldownMs 和 context rhythm 约束，但无视阈值（ignoreThreshold）。
   */
  checkPending(): void {
    this.tryEmit({ ignoreThreshold: true });
  }

  /**
   * 查看待处理的里程碑事件摘要（Phase 2.3：供 LLM 注入使用）
   *
   * 不消费里程碑事件（UI 仍需展示 banner），仅返回里程碑摘要列表。
   * 里程碑是一次性的特殊时刻信号，下次对话时 LLM 应该感知到。
   *
   * @returns 待处理里程碑的人类可读摘要列表；无里程碑时返回空数组
   */
  peekPendingMilestones(): string[] {
    return this.pendingNotices
      .filter((n) => n.isMilestone)
      .map((n) => n.summary);
  }

  /**
   * 累积待提示事件
   *
   * 当事件数量达到阈值时自动触发 tryEmit。
   * MAX_PENDING_NOTICES 上限保护应用于所有模式（非仅 silentMode），
   * 防止 cooldown 期间事件持续累积导致内存增长。
   *
   * @param type 事件类型（memory/insight/persona/file/milestone）
   * @param summary 事件摘要
   * @param isMilestone 是否为里程碑事件（Phase 2.3）
   */
  addNotice(type: string, summary: string, isMilestone = false, priority: 'normal' | 'high' | 'critical' = 'normal'): void {
    // 全局上限保护：所有模式下都限制累积上限，防止 cooldown 期间事件持续累积
    if (this.pendingNotices.length >= ProactiveEngine.MAX_PENDING_NOTICES) {
      // FIFO 淘汰时优先丢弃最旧的非里程碑事件，里程碑事件保留到最后
      //   仅当队列中全部为里程碑时，才按原 FIFO 顺序淘汰（保证不会无限增长）
      const firstNormalIndex = this.pendingNotices.findIndex((n) => !n.isMilestone);
      const dropIndex = firstNormalIndex >= 0 ? firstNormalIndex : 0;
      this.pendingNotices.splice(dropIndex, 1);
    }
    this.pendingNotices.push({ type, summary, timestamp: Date.now(), isMilestone, priority });
    if (this.pendingNotices.length >= this.config.threshold) {
      this.tryEmit();
    }
  }

  /** 尝试发射主动提示（Phase 1：智能触发时机 + Phase 2+：模式驱动内容） */
  private tryEmit(options?: { ignoreThreshold?: boolean }): void {
    if (this.pendingNotices.length === 0 && this.detectedPatterns.length === 0) return;
    if (this.config.silentMode) return;

    // 分级通知：高优先级事件绕过节奏抑制，critical 绕过冷却
    const hasHighPriority = this.pendingNotices.some(n => n.priority === 'high' || n.priority === 'critical');
    const hasCriticalPriority = this.pendingNotices.some(n => n.priority === 'critical');

    // Phase 1：对话节奏过快时不打断用户（rapid 节奏下静默）
    // 高优先级事件绕过节奏抑制（里程碑不应因快速对话而永远不展示）
    if (this.contextState?.rhythm === 'rapid' && !hasHighPriority) {
      return;
    }

    const now = Date.now();

    // 时间衰减 consecutiveRejects，避免长时间未交互后冷却仍处于高位
    //   必须在计算 effectiveCooldown 之前调用，否则衰减不会反映到本次冷却
    this.applyRejectDecay();

    // Phase 1：自适应冷却时间计算
    //   基础冷却 × 默契度系数（高默契 → 短冷却）× 拒绝惩罚（连续拒绝 → 长冷却）
    const rapportMultiplier = 1 - this.rapportLevel * 0.5; // 0.5x ~ 1.0x
    const rejectMultiplier = 1 + this.consecutiveRejects * 0.5; // 每次拒绝 +50%
    const effectiveCooldown = this.config.cooldownMs * rapportMultiplier * rejectMultiplier;

    // critical 优先级绕过冷却（健康警告等紧急信息不应被冷却延迟）
    if (now - this.lastProactiveAt < effectiveCooldown && !hasCriticalPriority) return;

    // Phase 2+：注入未提示过的模式作为待提示事件
    this.injectPatternNotices();

    // Phase 1：空闲节奏下降低触发阈值（更主动）
    // checkPending() 无视阈值约束（ignoreThreshold=true），仅检查 pending 非空
    const effectiveThreshold = options?.ignoreThreshold
      ? 1
      : this.contextState?.rhythm === 'idle'
        ? Math.max(1, Math.floor(this.config.threshold * 0.5))
        : this.config.threshold;
    if (this.pendingNotices.length < effectiveThreshold) return;

    // 取出待提示事件（单次最多 MAX_EMIT_BATCH 个，里程碑优先，剩余留待下次冷却结束）
    const notices = this.takeEmitBatch();
    this.lastProactiveAt = now;
    // 生成上下文感知提示文本
    const triggers = notices.map(n => n.type);
    const summaries = notices.map(n => n.summary);
    const prompt = this.buildPrompt(triggers, summaries);
    // Phase 2.3：检测本次提示是否包含里程碑事件
    const hasMilestone = notices.some(n => n.isMilestone);
    // 方向 A：召回类提示标记为 lightweight，宿主据此跳过系统通知
    const lightweight = triggers.includes('recalled');

    // silent 字段恒为 false（tryEmit 已在 silentMode 时 return）
    this.emitSprite?.('proactivePrompt', { prompt, triggers, silent: false, isMilestone: hasMilestone, lightweight });
    // Phase 2.1：记录一次主动提示（供 AffectController 计算接受率）
    this.suggestCount++;

    logger.info({ prompt, effectiveCooldown, effectiveThreshold, hasMilestone }, '主动提示');
  }

  /**
   * 取出本批次待发射事件（单次上限 MAX_EMIT_BATCH，里程碑优先）
   *
   * 当 pendingNotices 超过 MAX_EMIT_BATCH 时，优先取出里程碑事件，再用普通事件补齐。
   * 剩余事件保留在队列中，下次冷却结束后继续发射，避免一次性发射 100 条导致 banner 文本溢出。
   *
   * @returns 本批次待发射事件数组（已从 pendingNotices 中移除）
   */
  private takeEmitBatch(): PendingNotice[] {
    if (this.pendingNotices.length <= ProactiveEngine.MAX_EMIT_BATCH) {
      return this.pendingNotices.splice(0);
    }
    // 超过上限：优先取里程碑事件，再用普通事件补齐
    const milestones = this.pendingNotices.filter((n) => n.isMilestone);
    const normals = this.pendingNotices.filter((n) => !n.isMilestone);
    const pickedMilestones = milestones.slice(0, ProactiveEngine.MAX_EMIT_BATCH);
    const remainingSlots = ProactiveEngine.MAX_EMIT_BATCH - pickedMilestones.length;
    const pickedNormals = normals.slice(0, Math.max(0, remainingSlots));
    // 取出选中项的原始对象引用（保留时间顺序），剩余按原顺序保留在 pendingNotices
    const pickedSet = new Set(pickedMilestones.concat(pickedNormals));
    const picked = this.pendingNotices.filter((n) => pickedSet.has(n));
    this.pendingNotices = this.pendingNotices.filter((n) => !pickedSet.has(n));
    return picked;
  }

  /**
   * 将未提示过的模式注入待提示队列（Phase 2+）
   *
   * 策略：
   *   1. 过滤已提示过的模式（幂等保护）
   *   2. 按置信度取 top-3
   *   3. 注入为 pattern 类型事件
   */
  private injectPatternNotices(): void {
    if (this.detectedPatterns.length === 0) return;

    // 过滤已提示过的模式，按置信度降序取 top-3
    const newPatterns = this.detectedPatterns
      .filter((p) => !this.promptedPatterns.has(p.summary))
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3);

    for (const pattern of newPatterns) {
      // 通过 addNotice 注入，保证 MAX_PENDING_NOTICES 上限保护生效
      this.addNotice('pattern', pattern.suggestion ?? pattern.summary);
      // 标记为已提示（幂等保护）
      this.promptedPatterns.add(pattern.summary);
    }
  }

  /**
   * 按事件类型构建描述片段
   *
   * @param typeCounts 事件类型 → 出现次数的映射
   * @returns 描述片段列表（如"积累了 3 条新记忆"）
   */
  private buildEventParts(typeCounts: Map<string, number>): string[] {
    const parts: string[] = [];
    if (typeCounts.has('memory')) {
      const count = typeCounts.get('memory')!;
      parts.push(count > 1 ? `积累了 ${count} 条新记忆` : '有新的记忆');
    }
    if (typeCounts.has('insight')) {
      const count = typeCounts.get('insight')!;
      parts.push(count > 1 ? `提取了 ${count} 条洞察` : '获得了新的洞察');
    }
    if (typeCounts.has('persona')) {
      parts.push('角色发生了变化');
    }
    if (typeCounts.has('file')) {
      const count = typeCounts.get('file')!;
      parts.push(count > 1 ? `检测到 ${count} 次文件变化` : '检测到文件变化');
    }
    if (typeCounts.has('milestone')) {
      const count = typeCounts.get('milestone')!;
      parts.push(count > 1 ? `达成了 ${count} 个里程碑` : '达成了新的里程碑');
    }
    return parts;
  }

  /**
   * 尝试用特殊类型（suggestion/recalled/pattern）构建完整提示
   *
   * 这些类型的摘要已是完整句子，优先于事件统计返回。
   *
   * @returns 命中时返回完整提示文本，未命中时返回 null
   */
  private trySpecialPrompt(
    typeCounts: Map<string, number>,
    triggers: string[],
    summaries: string[],
    parts: string[],
  ): string | null {
    // 智能建议（健康度/回顾/画像）——建议类文本已是完整句子，直接作为提示主体
    if (typeCounts.has('suggestion')) {
      const summary = this.findSummaryByType(triggers, summaries, 'suggestion');
      if (summary && parts.length === 0) {
        return `${summary}——需要我帮你处理吗？`;
      }
      if (summary) {
        return `${summary}（同时${parts.join('，')}）`;
      }
    }
    // 欢迎回来记忆召回——summary 已包含时长 + 数量 + 名称
    if (typeCounts.has('recalled')) {
      const summary = this.findSummaryByType(triggers, summaries, 'recalled');
      if (summary) {
        if (parts.length === 0) {
          return `${summary}——要看看吗？${this.buildSuffix()}`;
        }
        return `${summary}（同时${parts.join('，')}）${this.buildSuffix()}`;
      }
    }
    // 模式检测结果——比事件统计更有价值，优先返回
    if (typeCounts.has('pattern')) {
      const summary = this.findSummaryByType(triggers, summaries, 'pattern');
      if (summary) {
        if (parts.length === 0) {
          return summary;
        }
        return `${summary}（同时${parts.join('，')}）`;
      }
    }
    return null;
  }

  /** 根据累积事件生成上下文感知提示文本 */
  private buildPrompt(triggers: string[], summaries: string[]): string {
    // 按事件类型分组统计
    const typeCounts = new Map<string, number>();
    for (const t of triggers) {
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }

    // 构建事件描述片段
    const parts = this.buildEventParts(typeCounts);

    // 优先用特殊类型（suggestion/recalled/pattern）构建完整提示
    const specialPrompt = this.trySpecialPrompt(typeCounts, triggers, summaries, parts);
    if (specialPrompt !== null) {
      return specialPrompt;
    }

    // 默认：组装事件描述 + 最佳摘要 + 语气后缀
    const bestSummary = summaries.find((s) => s.length > 0);
    if (parts.length === 0) {
      return '有些事情发生了变化，你可能想看看。';
    }

    let prompt = parts.join('，');
    if (bestSummary) {
      prompt += `（${bestSummary}）`;
    }
    // 基于情感基调选择结尾语气
    prompt += this.buildSuffix();
    return prompt;
  }

  /**
   * 按 trigger 类型查找对应的摘要文本
   *
   * triggers 和 summaries 是平行数组，triggers[i] 对应 summaries[i]。
   * 此方法返回指定 trigger 类型的第一个非空摘要，避免取到其他类型的摘要。
   *
   * @param triggers 事件类型数组
   * @param summaries 摘要文本数组（与 triggers 平行）
   * @param type 目标事件类型
   * @returns 匹配类型的首个非空摘要，无匹配时返回 undefined
   */
  private findSummaryByType(triggers: string[], summaries: string[], type: string): string | undefined {
    for (let i = 0; i < triggers.length; i++) {
      if (triggers[i] === type && summaries[i] && summaries[i]!.length > 0) {
        return summaries[i];
      }
    }
    return undefined;
  }

  /**
   * 基于当前情感基调生成提示结尾语气（Phase 2：个性化提示内容）
   *
   * 不同维度影响结尾措辞：
   *   - 温暖度高 → 亲切关心型
   *   - 直接度高 → 简洁干练型
   *   - 调皮度高 → 幽默活泼型
   *   - 温暖度低 → 正式礼貌型（默认）
   */
  private buildSuffix(): string {
    const affect = this.affectState;
    if (!affect) return '——需要我帮你整理一下吗？';

    // 调皮度优先：高调皮度使用幽默语气
    if (affect.playfulness >= 0.67) {
      const options = [
        '——要不要我帮你理一理？保证不把你的记忆搞乱~',
        '——需要我施展整理魔法吗？✨',
        '——让我来帮你理理？我可是专业的（大概）',
      ];
      return options[Math.floor(Math.random() * options.length)]!;
    }

    // 温暖度高：亲切关心
    if (affect.warmth >= 0.67) {
      const options = [
        '——需要我帮你整理一下吗？',
        '——想让我帮你理一理这些吗？',
        '——我来帮你梳理一下吧~',
      ];
      return options[Math.floor(Math.random() * options.length)]!;
    }

    // 直接度高：简洁干练
    if (affect.directness >= 0.67) {
      return '——需要整理吗？';
    }

    // 默认（温暖度低、直接度低）：正式礼貌
    return '——需要我帮你整理一下吗？';
  }

  // ─── 里程碑模式检测（Phase 2.3） ─────────────────────────

  /**
   * 检测里程碑事件并注入到待提示队列
   *
   * 从仪表盘数据实时推导，不依赖 LLM，不新增存储。
   * 幂等保护：已通知的量级/源不会重复触发（重启重置符合"自然遗忘"原则）。
   *
   * 检测模式：
   *   1. 记忆量级突破（Math.log10(total) ≥ 2，即首次达到 100/1000/...条）
   *   2. 新 source 类型首次出现
   *
   * @param dashboard 记忆仪表盘数据
   * @returns 本次检测触发的里程碑列表（已注入 addNotice，返回值仅供测试/调试用）
   */
  checkMilestones(dashboard: DashboardData): MilestoneTrigger[] {
    const triggers: MilestoneTrigger[] = [];

    // 首次调用仅初始化已知状态（knownSources + noticedMagnitudes），
    // 不触发 addNotice，避免冷启动时用户毫无操作就弹出"积累了上百条记忆"的困惑提示。
    // 后续调用才正常检测新增的里程碑。
    if (!this.milestoneInitialized) {
      this.milestoneInitialized = true;
      // 初始化已知 source 集合（不触发通知）
      const currentSources = Object.keys(dashboard.bySource);
      for (const source of currentSources) {
        this.knownSources.add(source);
      }
      // 初始化已知量级（不触发通知）
      if (dashboard.total > 0) {
        const magnitude = Math.floor(Math.log10(dashboard.total));
        if (magnitude >= 2) {
          this.noticedMagnitudes.add(magnitude);
        }
      }
      return triggers; // 首次调用返回空数组，不触发任何通知
    }

    // 模式 1：记忆量级突破（不硬编码具体数字，用数量级）
    // magnitude ≥ 2 表示首次达到 100 条（10^2）
    if (dashboard.total > 0) {
      const magnitude = Math.floor(Math.log10(dashboard.total));
      if (magnitude >= 2 && !this.noticedMagnitudes.has(magnitude)) {
        const label = this.magnitudeLabel(magnitude);
        triggers.push({
          type: `memory_magnitude_${magnitude}`,
          summary: `积累了${label}记忆`,
        });
        this.noticedMagnitudes.add(magnitude);
      }
    }

    // 模式 2：新 source 类型首次出现
    const currentSources = Object.keys(dashboard.bySource);
    for (const source of currentSources) {
      if (!this.knownSources.has(source)) {
        triggers.push({
          type: `new_source_${source}`,
          summary: `首次从 ${source} 中提取了记忆`,
        });
        this.knownSources.add(source);
      }
    }

    // 将触发的里程碑注入待提示队列（标记为里程碑事件，使用专属样式）
    for (const trigger of triggers) {
      this.addNotice('milestone', trigger.summary, true, 'high');
      // Phase 2.3：通知里程碑回调（供 Sprite 发射专门的 milestoneAchieved 事件）
      if (this.onMilestone) {
        this.onMilestone(trigger);
      }
    }

    // 里程碑状态变更后持久化（noticedMagnitudes/knownSources 任一新增时触发）
    //   避免重启后对已通知过的量级/已知的 source 重复触发里程碑
    if (triggers.length > 0) {
      this.notifyStateChange();
    }

    return triggers;
  }

  /**
   * 量级数字转人类可读标签
   *
   * @param magnitude 数量级（2=百，3=千，4=万...）
   * @returns 中文量级描述
   */
  private magnitudeLabel(magnitude: number): string {
    const labels: Record<number, string> = {
      2: '上百条',
      3: '上千条',
      4: '上万条',
      5: '十万条',
    };
    return labels[magnitude] ?? `10^${magnitude} 条`;
  }
}
