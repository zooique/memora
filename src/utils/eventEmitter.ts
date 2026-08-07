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
import { toError } from '@/utils/toError.js';

/** Agent 事件名常量（运行时真理源，与下方 AgentEventMap 键集一致） */
export const AGENT_EVENTS = {
  memoryAdded: 'memoryAdded',
  personaSwitched: 'personaSwitched',
  decayCompleted: 'decayCompleted',
  memoryRecalled: 'memoryRecalled',
  sessionForked: 'sessionForked',
  insightExtracted: 'insightExtracted',
  conflictDetected: 'conflictDetected',
  projectSwitched: 'projectSwitched',
  skillMatched: 'skillMatched',
  archiveFailed: 'archiveFailed',
  contextTruncated: 'contextTruncated',
  configReloaded: 'configReloaded',
  guardrailError: 'guardrailError',
  archiveModeChanged: 'archiveModeChanged',
  personaSwitchLocked: 'personaSwitchLocked',
  workProjectionGenerated: 'workProjectionGenerated',
  boostPersistFailed: 'boostPersistFailed',
  dedupCompleted: 'dedupCompleted',
  sessionPauseTimedOut: 'sessionPauseTimedOut',
  sessionResumeBlocked: 'sessionResumeBlocked',
  needClarify: 'needClarify',
} as const;

/** 事件名联合类型（由 AGENT_EVENTS 推导，单一真理源，新增事件只需在此对象加一项） */
export type AgentEventName = keyof typeof AGENT_EVENTS;

/** 运行时校验用 Set（由 AGENT_EVENTS 派生） */
export const AGENT_EVENT_SET: ReadonlySet<string> = new Set(Object.values(AGENT_EVENTS));

/** Agent 事件映射表（事件名 → 事件载荷类型），键集受 AgentEventName 约束 */
export interface AgentEventMap extends Record<AgentEventName, unknown> {
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
  /** 记忆冲突被检测到（contradicts 关系写入时触发，宿主可通知用户） */
  conflictDetected: { newMemoryId: string; newInsight: string; targetId: string; targetContent: string };
  /** 项目被切换（宿主 UI 可据此刷新项目相关界面） */
  projectSwitched: { from: string | null; to: string; projectName: string };
  /** 技能被匹配（宿主 UI 可据此展示当前激活技能） */
  skillMatched: { skill: string; score: number };
  /** 归档操作失败（fire-and-forget catch 分支发射，宿主可通知用户） */
  archiveFailed: {
    /** 失败阶段：profile（用户画像）/ insight（洞察提取）/ content（会话内容归档） */
    stage: 'profile' | 'insight' | 'content';
    /** 失败原因摘要（error.message，截断 200 字符避免 payload 过大） */
    message: string;
  };
  /** 上下文窗口截断（消息超出 token 上限被裁剪，宿主可通知用户消息被丢弃） */
  contextTruncated: {
    /** 被裁剪掉的消息数量 */
    skippedCount: number;
    /** 保留的消息数量 */
    keptCount: number;
  };
  /** 配置热重载完成（含对话期间暂存后补执行的 reload） */
  configReloaded: {
    /** 重载来源（persona/rule/skill/guardrail） */
    source: string;
  };
  /** Guardrail 规则正则编译失败（安全放行但应通知用户规则未生效） */
  guardrailError: {
    /** 规则原文（截断 100 字符） */
    rule: string;
    /** 编译失败原因 */
    message: string;
  };
  /** 归档模式切换 */
  archiveModeChanged: {
    /** 切换前模式 */
    from: string;
    /** 切换后模式 */
    to: string;
  };
  /** 角色切换锁定状态变化（防抖期间用户尝试切换被拒绝时通知） */
  personaSwitchLocked: {
    /** 锁定原因 */
    reason: string;
    /** 锁定时长（秒） */
    lockedSeconds: number;
  };
  /** 作品投影生成/更新（宿主可据此刷新作品面板） */
  workProjectionGenerated: {
    /** 源文件路径 */
    sourcePath: string;
    /** 投影摘要 */
    summary: string;
  };
  /** boost score 持久化失败（宿主可通知用户记忆权重可能丢失） */
  boostPersistFailed: {
    /** 记忆 ID */
    memoryId: string;
    /** 失败原因 */
    message: string;
  };
  /** 语义去重完成（宿主可据此刷新记忆面板） */
  dedupCompleted: {
    /** 被降级的记忆数 */
    deduplicatedCount: number;
    /** 被降级的记忆 ID 列表 */
    demotedIds: string[];
  };
  /** 暂停超时，检查点已自动清理（宿主可通知用户或触发归档） */
  sessionPauseTimedOut: {
    /** 超时的会话标识 */
    sessionId: string;
    /** 暂停持续时间（毫秒） */
    pauseDuration: number;
  };
  /** 恢复被阻止（暂停超时后无法恢复，需重新开始） */
  sessionResumeBlocked: {
    /** 被阻止的会话标识 */
    sessionId: string;
    /** 阻止原因 */
    reason: string;
  };
  /** 暂停询问（P4：需要用户澄清某个槽位） */
  needClarify: {
    /** 目标槽位 */
    slot: string;
    /** 问题文本 */
    question: string;
    /** 默认选项（可选） */
    options?: string[];
  }[];
}

// AgentEventName 已由上方 AGENT_EVENTS 推导（单一真理源）

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
