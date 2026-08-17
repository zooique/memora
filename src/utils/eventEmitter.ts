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
  projectSwitched: 'projectSwitched',
  skillMatched: 'skillMatched',
  archiveFailed: 'archiveFailed',
  contextTruncated: 'contextTruncated',
  configReloaded: 'configReloaded',
  archiveModeChanged: 'archiveModeChanged',
  personaSwitchLocked: 'personaSwitchLocked',
  workProjectionGenerated: 'workProjectionGenerated',
  boostPersistFailed: 'boostPersistFailed',
  dedupCompleted: 'dedupCompleted',
  sessionPauseTimedOut: 'sessionPauseTimedOut',
  sessionResumeBlocked: 'sessionResumeBlocked',
  /** 会话恢复失败（resumeExecution 中 resume() 返回 false，宿主可据此 toast 提示） */
  sessionResumeFailed: 'sessionResumeFailed',
  /** 任务表已生成（P2.5-2: LLM 通过 task_table_write 生成了任务表，宿主可展示接受/丢弃入口） */
  taskTableGenerated: 'taskTableGenerated',
  needClarify: 'needClarify',
  /**
   * Agent 主动提问（回答中检测到 LLM 结构化输出 [ASK] 时触发）
   *
   * 与 needClarify 同构但触发源不同：needClarify 来自目标槽位补全链（P4），
   * questionPending 来自回答中 LLM 输出解析。两者共享同一套暂停/恢复机制。
   */
  questionPending: 'questionPending',
  goalDriftDetected: 'goalDriftDetected',
  /** 会话暂停（用户/Agent/系统触发） */
  sessionPaused: 'sessionPaused',
  /** 会话恢复（暂停后恢复） */
  sessionResumed: 'sessionResumed',
  /** 会话异常（LLM 超时等） */
  sessionError: 'sessionError',
  /** 会话从异常恢复 */
  sessionRecovered: 'sessionRecovered',
} as const;

/** 事件名联合类型（由 AGENT_EVENTS 推导，单一真理源，新增事件只需在此对象加一项） */
export type AgentEventName = keyof typeof AGENT_EVENTS;

/** 运行时校验用 Set（由 AGENT_EVENTS 派生） */
export const AGENT_EVENT_SET: ReadonlySet<string> = new Set(Object.values(AGENT_EVENTS));

/** Agent 事件映射表（事件名 → 事件载荷类型），键集受 AgentEventName 约束 */
export interface AgentEventMap extends Record<AgentEventName, unknown> {
  /** 记忆被写入存储（round-summary 沉淀、content 会话归档、rule/skill 注入等） */
  memoryAdded: { id: string; source: string; name: string };
  /** 角色被切换（自动匹配或手动指定） */
  personaSwitched: { from: string | null; to: string };
  /** 记忆衰减完成 */
  decayCompleted: { decayedCount: number };
  /** 记忆被召回（用于宿主 UI 展示"想起 X 条记忆"） */
  memoryRecalled: { count: number; query: string };
  /** 会话被分叉 */
  sessionForked: { from: string; to: string; messageCount: number };
  /** 项目被切换（宿主 UI 可据此刷新项目相关界面） */
  projectSwitched: { from: string | null; to: string; projectName: string };
  /** 技能被匹配（宿主 UI 可据此展示当前激活技能） */
  skillMatched: { skill: string; score: number };
  /** 归档操作失败（fire-and-forget catch 分支发射，宿主可通知用户） */
  archiveFailed: {
    /** 失败阶段：content（会话内容归档），洞察层已收敛移除 */
    stage: 'content';
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
    /** 重载来源（persona/rule/skill） */
    source: string;
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
  /**
   * 暂停超时，检查点已自动清理（唯一写点：SessionManager.markSessionTimedOut）
   *
   * 两条触发路径：启动加载（loadPersistedCheckpoint）与运行时定时器（checkPauseTimeout）。
   * 唯一消费点：Agent.registerPauseTimeoutArchiver()——清理 Agent 残留暂停状态 + 触发归档。
   * F1.3 广播式改造支持多监听器，不再依赖一次性消费模式。
   */
  sessionPauseTimedOut: {
    /** 超时的会话标识 */
    sessionId: string;
    /** 暂停持续时间（毫秒） */
    pauseDuration: number;
    /** 超时会话日期（YYYY-MM-DD，符合 SESSION_ID_PATTERN 时提供，供归档消费） */
    date?: string;
    /** 超时会话名（不含日期前缀，符合 SESSION_ID_PATTERN 时提供，供归档消费） */
    session?: string;
  };
  /**
   * 恢复被阻止（唯一写点：SessionManager.resume）
   *
   * 暂停超时后检查点已被清理，无法恢复，通知宿主"需重新开始"。
   */
  sessionResumeBlocked: {
    /** 被阻止的会话标识 */
    sessionId: string;
    /** 阻止原因 */
    reason: string;
  };
  /**
   * 恢复失败（唯一写点：SessionManager.resumeExecution）
   *
   * resume() 返回 false 时发射，宿主可据此 toast 提示用户。
   * 注意：与 sessionResumeBlocked 的区别——blocked 是超时拦截（检查点已清理），
   * failed 是恢复操作本身执行失败（如存储层异常）。
   */
  sessionResumeFailed: {
    /** 恢复失败的会话标识 */
    sessionId?: string;
    /** 失败原因 */
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
  /**
   * Agent 主动提问（回答中 LLM 结构化输出 [ASK] 解析结果）
   *
   * 与 needClarify 载荷同构，宿主可渲染提问 UI；用户回答后经 resumeExecution 续跑。
   */
  questionPending: {
    /** 目标槽位（当前统一为 'ask'，为未来多槽位预留） */
    slot: string;
    /** 问题文本 */
    question: string;
  }[];
  /**
   * 目标漂移检测结果（P3.1 目标版本一致性校验）
   *
   * 唯一写点：SessionManager.updateGoal()——在 GoalConsistencyChecker 检测到
   * 新目标与原始目标（mainGoal）差异超过阈值时发射。
   *
   * 注意：内核当前无此事件的监听方（宿主 UI 未建，SSOT 排雷 T2-1 复核确认）——
   * 事件保留为通知钩子，drift 级自动暂停（sessionManager.updateGoal 内）是当前
   * 唯一的实际处置路径。宿主接入「暂停 + 确认」UI 时须监听此事件。
   */
  goalDriftDetected: {
    /** 会话标识 */
    sessionId: string;
    /** 原始目标（防漂移锚点） */
    mainGoal: string;
    /** 用户提出的新目标 */
    newGoal: string;
    /** 文本相似度（0-1） */
    similarity: number;
    /** 漂移等级 */
    level: 'same' | 'confirm' | 'drift';
    /** 关键约束列表 */
    constraints: string[];
    /** 目标变更序号（T11 改名：原 goalVersion，仅事件载荷不承担校验） */
    goalChangeSeq: number;
  };
  /**
   * 会话暂停（唯一写点：SessionManager.requestPause）
   *
   * 暂停时 SessionManager 创建检查点、启动超时检测定时器后发射此事件。
   * 内核内部无消费者——宿主通过 agent.on('sessionPaused') 监听作 UI 响应。
   */
  sessionPaused: {
    /** 暂停原因 */
    reason: string;
    /** 暂停来源 */
    source: string;
    /** 会话标识 */
    sessionId?: string;
  };
  /**
   * 会话恢复（唯一写点：SessionManager.resume）
   *
   * 恢复成功后在 resume() 中发射。不包含旧状态——宿主可自行缓存。
   * 内核内部无消费者——宿主监听用于 UI 刷新。
   */
  sessionResumed: {
    /** 会话标识 */
    sessionId?: string;
  };
  /**
   * 会话异常（唯一写点：SessionManager 的 pause() 中 error→pause 路径）
   *
   * 状态机翻转至 error 后发射，内含异常原因。暂停超时路径不发射此事件——
   * 超时直接进入 PAUSED 态，由 sessionPauseTimedOut 替代通知。
   * 内核内部无消费者——宿主监听用于 toast 提示。
   */
  sessionError: {
    /** 异常原因 */
    cause: string;
    /** 会话标识 */
    sessionId?: string;
  };
  /**
   * 会话从异常恢复（唯一写点：SessionManager 的 recoverFromError 路径）
   *
   * 恢复成功后在状态机翻转至 RUNNING 后发射。
   * 内核内部无消费者——宿主监听用于 UI 刷新。
   */
  sessionRecovered: {
    /** 会话标识 */
    sessionId?: string;
  };
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
