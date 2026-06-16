/**
 * 精灵主控 — 唤醒调度 + 对话管理
 *
 * 职责：
 *   1. 监听触发器事件，决定是否唤醒精灵
 *   2. 唤醒后启动对话交互
 *   3. 管理精灵状态（idle / active / sleeping）
 *   4. 提供记忆仪表盘（stats + suggest）
 *
 * 设计原则（ADR-SP-004）：
 *   上下文感知而非内容感知——精灵通过文件变化、时间等上下文信号唤醒，
 *   不监听键盘输入内容。
 */
import type { Agent } from 'memora';
import type { SuggestHit } from 'memora';
import { TriggerBus } from './triggers.js';

/** 精灵状态 */
export type SpriteState = 'idle' | 'active' | 'sleeping';

/** 仪表盘数据 */
export interface DashboardData {
  /** 记忆总数 */
  total: number;
  /** 按来源分组的记忆数量 */
  bySource: Record<string, number>;
  /** 关联推荐列表 */
  suggestions: SuggestHit[];
}

/**
 * 精灵主控
 */
export class Sprite {
  private agent: Agent;
  private state: SpriteState = 'idle';
  private triggerBus: TriggerBus;
  private running = false;

  constructor(agent: Agent) {
    this.agent = agent;
    this.triggerBus = new TriggerBus();
  }

  /** 启动精灵主控循环 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.state = 'idle';

    // 注册触发器回调
    this.triggerBus.on((reason: string) => {
      this.handleTrigger(reason);
    });

    this.triggerBus.start();
    console.log('[Sprite] 精灵已启动，等待唤醒...');
  }

  /** 停止精灵主控 */
  stop(): void {
    this.running = false;
    this.triggerBus.stop();
    this.state = 'idle';
  }

  /** 获取当前状态 */
  getState(): SpriteState {
    return this.state;
  }

  /** 手动唤醒精灵 */
  async wakeup(input: string): Promise<string> {
    this.state = 'active';
    try {
      return await this.agent.chatSync(input);
    } finally {
      this.state = 'idle';
    }
  }

  /** 获取记忆仪表盘数据 */
  dashboard(): DashboardData {
    const stats = this.agent.memory!.stats();
    const suggestions = this.agent.memory!.suggest(undefined, { limit: 5 });
    return {
      total: stats.total,
      bySource: stats.bySource,
      suggestions,
    };
  }

  /** 格式化仪表盘为可读文本 */
  formatDashboard(): string {
    const data = this.dashboard();
    const lines: string[] = [];

    lines.push('── 记忆仪表盘 ──');
    lines.push(`总记忆数：${data.total}`);

    if (Object.keys(data.bySource).length > 0) {
      const sourceList = Object.entries(data.bySource)
        .sort(([, a], [, b]) => b - a)
        .map(([source, count]) => `  ${source}: ${count}`)
        .join('\n');
      lines.push(`按来源：\n${sourceList}`);
    }

    if (data.suggestions.length > 0) {
      lines.push('推荐关注：');
      for (const hit of data.suggestions) {
        lines.push(`  [${hit.source}] ${hit.name} (${hit.reason}, 相关度 ${hit.relevance})`);
      }
    } else {
      lines.push('暂无推荐（记忆库为空或尚无足够数据）');
    }

    return lines.join('\n');
  }

  /** 处理触发器事件 */
  private handleTrigger(reason: string): void {
    if (this.state !== 'idle') return;
    console.log(`[Sprite] 触发唤醒：${reason}`);
    // 定时触发时展示仪表盘摘要
    console.log(this.formatDashboard());
  }
}
