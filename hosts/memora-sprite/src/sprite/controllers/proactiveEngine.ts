/**
 * 主动提示引擎 — 事件累积 + 提示生成
 *
 * 职责：
 *   1. 累积待提示事件
 *   2. 冷却保护
 *   3. 上下文感知提示生成
 */
import type { IInteraction } from '../interaction.js';
import { logger } from 'memora';

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

/**
 * 主动提示引擎
 */
export class ProactiveEngine {
  private config: ProactiveConfig;
  private interaction: IInteraction | null = null;
  private emitSprite: SpriteEmitter | null = null;
  private pendingNotices: PendingNotice[] = [];
  private lastProactiveAt = 0;

  constructor(config: ProactiveConfig) {
    this.config = config;
  }

  /** 设置交互层 */
  setInteraction(interaction: IInteraction): void {
    this.interaction = interaction;
  }

  /** 设置事件发射器 */
  setEmitter(emit: SpriteEmitter): void {
    this.emitSprite = emit;
  }

  /** 更新配置 */
  updateConfig(config: Partial<ProactiveConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** 获取待提示事件数量 */
  get pendingCount(): number {
    return this.pendingNotices.length;
  }

  /** 累积待提示事件 */
  addNotice(type: string, summary: string): void {
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

    this.emitSprite?.('proactivePrompt', { prompt, triggers, silent: this.config.silentMode });

    // 通过交互层输出主动提示（传入 kind='proactive'，Electron 模式下由 banner 展示，避免重复）
    if (this.interaction) {
      this.interaction.output(`\n[精灵] ${prompt}\n`, 'proactive');
    }

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
}
