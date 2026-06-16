/**
 * 精灵主控 — 唤醒调度 + 对话管理
 *
 * 职责：
 *   1. 监听触发器事件，决定是否唤醒精灵
 *   2. 唤醒后启动对话交互
 *   3. 管理精灵状态（idle / active / sleeping）
 *
 * 设计原则（ADR-SP-004）：
 *   上下文感知而非内容感知——精灵通过文件变化、时间等上下文信号唤醒，
 *   不监听键盘输入内容。
 */
import type { Agent } from 'memora';
import { TriggerBus } from './triggers.js';

/** 精灵状态 */
export type SpriteState = 'idle' | 'active' | 'sleeping';

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

  /** 处理触发器事件 */
  private handleTrigger(reason: string): void {
    if (this.state !== 'idle') return;
    console.log(`[Sprite] 触发唤醒：${reason}`);
    // 阶段一：仅打印日志，不自动发起对话
    // 阶段二：根据触发类型自动发起对话
  }
}
