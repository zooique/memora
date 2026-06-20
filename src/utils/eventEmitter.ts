/**
 * 轻量类型事件发射器 — 零外部依赖
 *
 * 供 Agent 向宿主项目广播对话外事件（记忆变更、角色切换、衰减完成等）。
 * 不依赖 Node.js EventEmitter，保持"零 native 依赖内核"约束。
 *
 * 使用方式：
 *   agent.on('memoryAdded', (e) => console.log(e.source, e.name));
 *   agent.off('memoryAdded', handler);
 */
import { getLogger } from '@/utils/loggerHolder.js';
import { toError } from '@/utils/errors.js';

/** Agent 事件映射表（事件名 → 事件载荷类型） */
export interface AgentEventMap {
  /** 记忆被写入存储（insight 提取、rule 注入、skill 注入等） */
  memoryAdded: { id: string; source: string; name: string };
  /** 角色被切换（自动匹配或手动指定） */
  personaSwitched: { from: string | null; to: string };
  /** 记忆衰减完成 */
  decayCompleted: { decayedCount: number };
  /** 记忆被召回（用于宿主 UI 展示"想起 X 条记忆"） */
  memoryRecalled: { count: number; query: string };
  /** 会话被分叉 */
  sessionForked: { from: string; to: string; messageCount: number };
  /** 洞察被提取 */
  insightExtracted: { source: string; insight: string };
  /** 项目被切换（A-003：宿主 UI 可据此刷新项目相关界面） */
  projectSwitched: { from: string | null; to: string; projectName: string };
  /** 技能被匹配（A-003：宿主 UI 可据此展示当前激活技能） */
  skillMatched: { skill: string; score: number };
}

/** 事件名联合类型 */
export type AgentEventName = keyof AgentEventMap;

/** 事件处理器类型 */
export type AgentEventHandler<T> = (event: T) => void;

/**
 * 类型安全的事件发射器
 *
 * 泛型参数 EventMap 约束了合法的事件名和对应的载荷类型，
 * 调用方在编译期就能获得类型检查和自动补全。
 */
export class TypedEventEmitter<EventMap extends object> {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  /**
   * 订阅事件
   * @param event - 事件名
   * @param handler - 事件处理器
   */
  on<K extends keyof EventMap & string>(event: K, handler: (event: EventMap[K]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (event: unknown) => void);
  }

  /**
   * 取消订阅
   * @param event - 事件名
   * @param handler - 要移除的处理器（必须是同一个引用）
   */
  off<K extends keyof EventMap & string>(event: K, handler: (event: EventMap[K]) => void): void {
    this.listeners.get(event)?.delete(handler as (event: unknown) => void);
  }

  /**
   * 订阅事件（仅触发一次，触发后自动移除）
   * @param event - 事件名
   * @param handler - 事件处理器
   */
  once<K extends keyof EventMap & string>(
    event: K,
    handler: (event: EventMap[K]) => void,
  ): void {
    const wrapper = ((data: EventMap[K]) => {
      this.off(event, wrapper as (event: EventMap[K]) => void);
      handler(data);
    }) as (event: EventMap[K]) => void;
    this.on(event, wrapper);
  }

  /**
   * 发射事件
   * @param event - 事件名
   * @param payload - 事件载荷
   */
  protected emit<K extends keyof EventMap & string>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        getLogger().warn({ event, err: toError(err).message }, '宿主事件处理器异常');
      }
    }
  }

  /**
   * 移除所有监听器（用于 close() 清理）
   */
  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}
