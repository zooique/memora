/**
 * 主动提示引擎 — 事件累积 + 提示生成
 *
 * 职责：
 *   1. 累积待提示事件
 *   2. 冷却保护
 *   3. 上下文感知提示生成
 *
 * P2-DESIGN-5 修复：移除 interaction 双通道输出，仅通过 emitSprite 发射 proactivePrompt 事件，
 * 宿主（main.ts 的事件监听器）负责接收事件并决定是否展示为 banner。
 */
import { logger } from 'memora';
import type { DashboardData } from './memoryController.js';

/** 待提示事件 */
interface PendingNotice {
  type: string;
  summary: string;
  timestamp: number;
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

/** 精灵事件发射器 */
export type SpriteEmitter = (event: 'proactivePrompt', payload: { prompt: string; triggers: string[]; silent: boolean }) => void;

/** 里程碑触发结果（Phase 2.3） */
export interface MilestoneTrigger {
  /** 里程碑类型标识（如 memory_magnitude_2、new_source_profile） */
  type: string;
  /** 人类可读描述（用于 addNotice 摘要） */
  summary: string;
}

/** 主动提示引擎 */
export class ProactiveEngine {
  /** P1-7 修复：pendingNotices 最大累积上限，防止长时间静默或 cooldown 期间内存泄漏 */
  private static readonly MAX_PENDING_NOTICES = 100;

  /** Phase 2.3：已通知的记忆量级（幂等保护，重启重置符合"自然遗忘"） */
  private noticedMagnitudes: Set<number> = new Set();
  /** Phase 2.3：已知的 source 类型（首次出现时触发里程碑） */
  private knownSources: Set<string> = new Set();
  /** QC-SPRITE-06：首次 checkMilestones 仅初始化已知状态，不触发通知（避免冷启动首发提示） */
  private milestoneInitialized = false;

  /** Phase 2.1：主动提示次数（供 AffectController 计算接受率） */
  private suggestCount = 0;
  /** Phase 2.1：用户接受次数（供 AffectController 计算接受率） */
  private acceptCount = 0;

  private config: ProactiveConfig;
  private emitSprite: SpriteEmitter | null = null;
  private pendingNotices: PendingNotice[] = [];
  private lastProactiveAt = 0;

  constructor(config: ProactiveConfig) {
    this.config = config;
  }

  /** 设置事件发射器 */
  setEmitter(emit: SpriteEmitter): void {
    this.emitSprite = emit;
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
   * 记录用户接受了一次主动提示（Phase 2.1）
   *
   * 由宿主 UI 在用户点击"好的"时调用。
   */
  recordAccept(): void {
    this.acceptCount++;
  }

  /**
   * 检查待提示事件并尝试发射（Phase 3.2：用户回来时触发）
   *
   * 与 addNotice 内部的自动触发不同，此方法用于外部主动检查。
   * 例如用户离开一段时间后回来，应检查是否有累积的待提示事件。
   * 受 silentMode 和 cooldownMs 约束，与自动触发行为一致。
   */
  checkPending(): void {
    this.tryEmit();
  }

  /**
   * 累积待提示事件
   *
   * 当事件数量达到阈值时自动触发 tryEmit。
   * P2-CODE-1 修复：MAX_PENDING_NOTICES 上限保护应用于所有模式（非仅 silentMode），
   * 防止 cooldown 期间事件持续累积导致内存增长。
   *
   * @param type 事件类型（memory/insight/persona/file）
   * @param summary 事件摘要
   */
  addNotice(type: string, summary: string): void {
    // 全局上限保护：所有模式下都限制累积上限，防止 cooldown 期间事件持续累积
    if (this.pendingNotices.length >= ProactiveEngine.MAX_PENDING_NOTICES) {
      // 丢弃最旧的事件，保留最近的事件（FIFO 淘汰）
      this.pendingNotices.shift();
    }
    this.pendingNotices.push({ type, summary, timestamp: Date.now() });
    if (this.pendingNotices.length >= this.config.threshold) {
      this.tryEmit();
    }
  }

  /** 尝试发射主动提示 */
  private tryEmit(): void {
    if (this.pendingNotices.length === 0) return;
    if (this.config.silentMode) return;

    const now = Date.now();
    if (now - this.lastProactiveAt < this.config.cooldownMs) return;

    // 取出所有待提示事件
    const notices = this.pendingNotices.splice(0);
    this.lastProactiveAt = now;
    // 生成上下文感知提示文本
    const triggers = notices.map(n => n.type);
    const summaries = notices.map(n => n.summary);
    const prompt = this.buildPrompt(triggers, summaries);

    // P1-8 修复：silent 字段恒为 false（tryEmit 已在 silentMode 时 return），移除死字段
    this.emitSprite?.('proactivePrompt', { prompt, triggers, silent: false });
    // Phase 2.1：记录一次主动提示（供 AffectController 计算接受率）
    this.suggestCount++;

    // P2-DESIGN-5 修复：移除 interaction.output 双通道输出，仅通过 emitSprite 发射事件。
    // 宿主（main.ts 的事件监听器）负责接收 proactivePrompt 事件并决定是否展示为 banner。
    // 原 interaction.output(text, 'proactive') 与 emitSprite 双发，依赖 ElectronInteraction
    // 对 proactive 类型的隐式 guard 跳过避免重复显示，新增 IInteraction 实现会破坏该契约。
    logger.info({ prompt }, '主动提示');
  }

  /** 根据累积事件生成上下文感知提示文本 */
  private buildPrompt(triggers: string[], summaries: string[]): string {
    const parts: string[] = [];

    // 按事件类型分组统计
    const typeCounts = new Map<string, number>();
    for (const t of triggers) {
      typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
    }

    // 构建提示
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

    // 摘要中最有信息量的一条
    const bestSummary = summaries.find(s => s.length > 0);

    if (parts.length === 0) {
      return '有些事情发生了变化，你可能想看看。';
    }

    let prompt = parts.join('，');
    if (bestSummary) {
      prompt += `（${bestSummary}）`;
    }
    prompt += '——需要我帮你整理一下吗？';

    return prompt;
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

    // QC-SPRITE-06：首次调用仅初始化已知状态（knownSources + noticedMagnitudes），
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

    // 将触发的里程碑注入待提示队列
    for (const trigger of triggers) {
      this.addNotice('milestone', trigger.summary);
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
