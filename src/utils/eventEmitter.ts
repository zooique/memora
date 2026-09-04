/**
 * 轻量类型事件发射器（零 native 依赖）——Agent 向宿主广播外层事件：
 * agent.on('memoryAdded', (e) => ...)；off 解绑。
 */
import { getLogger } from '@/utils/loggerHolder.js';
import { toError } from '@/utils/toError.js';
import type { AskQuestion } from '@/agent/types.js';

/** Agent 事件名常量（运行时真理源，与 AgentEventMap 键集一致） */
export const AGENT_EVENTS = {
  memoryAdded: 'memoryAdded',
  rolePackSwitched: 'rolePackSwitched',
  memoryRecalled: 'memoryRecalled',
  sessionForked: 'sessionForked',
  projectSwitched: 'projectSwitched',
  archiveFailed: 'archiveFailed',
  contextTruncated: 'contextTruncated',
  /** LLM 主动压缩完成（第二级压缩，与 contextTruncated 的内核自动截断区分） */
  contextCompressed: 'contextCompressed',
  configReloaded: 'configReloaded',
  archiveModeChanged: 'archiveModeChanged',
  rolePackSwitchLocked: 'rolePackSwitchLocked',
  workProjectionGenerated: 'workProjectionGenerated',
  boostPersistFailed: 'boostPersistFailed',
  dedupCompleted: 'dedupCompleted',
  sessionPauseTimedOut: 'sessionPauseTimedOut',
  sessionResumeBlocked: 'sessionResumeBlocked',
  /** 订阅时宿主据此判断重要事件并 toast 提示 */
  sessionResumeFailed: 'sessionResumeFailed',
  /** 装配前判负（洞 3）：触发输入过大，剩余预算无法支撑至少一轮正文——与软上限不同失败原因 */
  inputTooLarge: 'inputTooLarge',
  /** 回答中 LLM 调 ask_user 工具主动提问（唯一「提问后暂停」通道） */
  questionPending: 'questionPending',
  goalDriftDetected: 'goalDriftDetected',
  /** 目标被主动更新（用户/系统直接改写 currentGoal，与 goalDriftDetected 的 LLM 漂移检测区分） */
  goalUpdated: 'goalUpdated',
  sessionPaused: 'sessionPaused',
  sessionResumed: 'sessionResumed',
  sessionError: 'sessionError',
  sessionRecovered: 'sessionRecovered',
  /** 会话标题被 LLM 自动更新（SessionNamer 完成后触发，宿主据此刷新 UI） */
  sessionTitleUpdated: 'sessionTitleUpdated',
} as const;

/** 事件名联合类型（由 AGENT_EVENTS 推导，新增事件只需在此加一项） */
export type AgentEventName = keyof typeof AGENT_EVENTS;

/** 运行时校验用集合（由 AGENT_EVENTS 派生） */
export const AGENT_EVENT_SET: ReadonlySet<string> = new Set(Object.values(AGENT_EVENTS));

/** 事件名 → 载荷类型映射（键集受 AgentEventName 约束） */
export interface AgentEventMap extends Record<AgentEventName, unknown> {
  memoryAdded: { id: string; source: string; name: string };
  rolePackSwitched: { from: string | null; to: string };
  memoryRecalled: { count: number; query: string };
  sessionForked: { from: string; to: string; roundCount: number };
  projectSwitched: { from: string | null; to: string; projectName: string };
  archiveFailed: { stage: 'session'; message: string };
  contextTruncated: { skippedCount: number; keptCount: number };
  /** LLM 主动压缩完成载荷：压缩目标 + 被替换消息数 + 摘要长度 */
  contextCompressed: {
    target: 'earliest_round' | 'largest_tool_result';
    replacedCount: number;
    summaryLength: number;
  };
  configReloaded: { source: string };
  archiveModeChanged: { from: string; to: string };
  rolePackSwitchLocked: { reason: string; lockedSeconds: number };
  workProjectionGenerated: { sourcePath: string; summary: string };
  boostPersistFailed: { memoryId: string; message: string };
  dedupCompleted: { deduplicatedCount: number; demotedIds: string[] };
  sessionPauseTimedOut: {
    sessionId: string;
    pauseDuration: number;
    date?: string;
    session?: string;
  };
  sessionResumeBlocked: { sessionId: string; reason: string };
  sessionResumeFailed: { sessionId?: string; reason: string };
  /** 装配前判负载荷：剩余预算详情 + 给宿主的降级提示（建议放文件用 read_file 读） */
  inputTooLarge: {
    inputLength: number;
    remainingTokens: number;
    hint: string;
  };
  questionPending: AskQuestion[];
  goalDriftDetected: {
    sessionId: string;
    mainGoal: string;
    newGoal: string;
    similarity: number;
    level: 'same' | 'confirm' | 'drift';
    constraints: string[];
    /** 原名 goalVersion，仅载荷不承担校验 */
    goalChangeSeq: number;
  };
  goalUpdated: {
    newGoal: string;
    goalChangeSeq: number;
    sessionId: string;
  };
  sessionPaused: { reason: string; source: string; sessionId?: string };
  sessionResumed: { sessionId?: string };
  sessionError: { cause: string; sessionId?: string };
  sessionRecovered: { sessionId?: string };
  /** 会话标题更新载荷：会话 ID + 新标题 */
  sessionTitleUpdated: { sessionId: string; title: string };
}

/** 事件处理器类型 */
export type AgentEventHandler<T> = (event: T) => void;

/**
 * 类型安全事件发射器——泛型 EventMap 约束合法事件名与载荷类型，
 * 调用方在编译期获得类型检查和自动补全。
 */
export class TypedEventEmitter<EventMap extends object> {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  /** 订阅事件（同一 handler 引用加入 Set，天然避免重复监听） */
  on<K extends keyof EventMap & string>(event: K, handler: (event: EventMap[K]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (event: unknown) => void);
  }

  /** 取消订阅（必须是与 on 相同的引用） */
  off<K extends keyof EventMap & string>(event: K, handler: (event: EventMap[K]) => void): void {
    this.listeners.get(event)?.delete(handler as (event: unknown) => void);
  }

  /** 一次性订阅：触发后自动移除，再转发给 handler（防泄漏） */
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

  /** 发射事件；单处理器异常不阻断其余监听器 */
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

  /** 移除所有监听器（用于 close() 清理） */
  protected removeAllListeners(): void {
    this.listeners.clear();
  }
}