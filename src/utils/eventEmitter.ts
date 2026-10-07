/**
 * 轻量类型事件发射器（零 native 依赖）——Agent 向宿主广播外层事件：
 * agent.on('memoryAdded', (e) => ...)；off 解绑。
 */
import { getLogger } from '@/utils/loggerHolder.js';
import { toError } from '@/utils/toError.js';
import type { AskQuestion } from '@/agent/types.js';
import type { CompressTarget } from '@/agent/loop.js';
import type { BackgroundTaskNaturalStatus } from '@/agent/backgroundTasks.js';

/** Agent 事件名常量（运行时真理源，与 AgentEventMap 键集一致） */
export const AGENT_EVENTS = {
  memoryAdded: 'memoryAdded',
  rolePackSwitched: 'rolePackSwitched',
  memoryRecalled: 'memoryRecalled',
  sessionForked: 'sessionForked',
  /**
   * 会话身份切换完成（switchToSession 换会话成功后触发，载荷指向**被切走的旧会话**）。
   * 内核自消费事件：agent 归档监听器据此对旧会话做会话级归档（summary/keyTopics 进
   * SessionMeta 搜索索引）。宿主零消费 = 刻意设计（宿主是切换发起方，无增量信息），
   * protocolGuard V-2 已登记 KERNEL_SELF_CONSUMED_EVENTS 豁免。
   */
  sessionSwitched: 'sessionSwitched',
  projectSwitched: 'projectSwitched',
  archiveFailed: 'archiveFailed',
  /**
   * 会话归档写入成功（updatedFields 非空才发，与 archiveFailed 对称）。
   * 宿主据此重拉会话列表：切走时归档异步完成，列表快照若无此信号则条目摘要永不更新
   * （悬停 tooltip 一直为空）。手动触发同样经 ArchiveCoordinator 发射。
   */
  sessionArchived: 'sessionArchived',
  contextTruncated: 'contextTruncated',
  /** LLM 主动压缩完成（第二级压缩，与 contextTruncated 的内核自动截断区分） */
  contextCompressed: 'contextCompressed',
  configReloaded: 'configReloaded',
  archiveModeChanged: 'archiveModeChanged',
  rolePackSwitchLocked: 'rolePackSwitchLocked',
  workProjectionGenerated: 'workProjectionGenerated',
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
  sessionPaused: 'sessionPaused',
  sessionResumed: 'sessionResumed',
  sessionError: 'sessionError',
  sessionRecovered: 'sessionRecovered',
  /** 会话标题被 LLM 自动更新（SessionNamer 完成后触发，宿主据此刷新 UI） */
  sessionTitleUpdated: 'sessionTitleUpdated',
  /**
   * 轮次摘要生成完成（round-summary fire-and-forget 后台任务收口信号）。
   * 宿主据此解锁「问答闭环完整结束」的 UI 状态（删除/分叉按钮解禁）——
   * 避免 done 后立即删除导致孤儿 round-summary（摘要还在生成就删了源）。
   * 一次 chat() 只触发一次，载荷带 roundId 溯源。
   */
  roundSummaryGenerated: 'roundSummaryGenerated',
  /**
   * 后台任务**自然终态**（`run_command` background 进程自己跑完 / 到点超时强杀）。
   * 宿主据此推 UI 快照——脱管后 turn 已结束，宿主周期性推送（step_boundary /
   * background_report）覆盖不到「turn 结束后任务自然跑完」，缺此事件 UI 会一直显示
   * 假活跃的「运行中」。
   * ⚠️ **主动 kill 不发本事件**：注册表 kill 刻意不回调（防结果双份消费）——
   * UI 终止按钮路径由宿主 kill 后自行回拉快照；LLM 调 kill_command 后靠下一个
   * step_boundary（若 turn 当场结束则无推送点，已登记边界，见后台任务跨轮存活方案）。
   */
  backgroundTaskSettled: 'backgroundTaskSettled',
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
  /** date/session = 被切走的旧会话（归档对象）；fromSessionId/toSessionId = 旧/新完整会话标识 */
  sessionSwitched: {
    date: string;
    session: string;
    fromSessionId: string;
    toSessionId: string;
  };
  projectSwitched: { from: string | null; to: string; projectName: string };
  archiveFailed: { stage: 'session'; message: string };
  /** 会话归档写入成功载荷：sessionId = `${date}-${session}`；updatedFields = 实际落库字段（summary/keyTopics/autoName） */
  sessionArchived: { sessionId: string; updatedFields: string[] };
  contextTruncated: { skippedCount: number; keptCount: number };
  /** LLM 主动压缩完成载荷：压缩目标 + 被替换消息数 + 摘要长度
   * ⚠️ target 类型**引用 loop 的 CompressTarget**（不另写字面量联合）——枚举增补时
   * 本处自动跟随，禁在此复制一份（两份字面量 = 必然漂移）。 */
  contextCompressed: {
    target: CompressTarget;
    replacedCount: number;
    summaryLength: number;
  };
  configReloaded: { source: string };
  archiveModeChanged: { from: string; to: string };
  rolePackSwitchLocked: { reason: string; lockedSeconds: number };
  workProjectionGenerated: { sourcePath: string; summary: string };
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
  sessionPaused: { reason: string; source: string; sessionId?: string };
  sessionResumed: { sessionId?: string };
  sessionError: { cause: string; sessionId?: string };
  sessionRecovered: { sessionId?: string };
  /** 会话标题更新载荷：会话 ID + 新标题 */
  sessionTitleUpdated: { sessionId: string; title: string };
  /** 轮次摘要生成完成载荷：本轮 roundId（溯源）+ 成功/失败（失败时宿主仍需兜底解锁） */
  roundSummaryGenerated: { roundId: string; success: boolean };
  /**
   * 后台任务**自然终态**载荷：只读投影（与 `agent.listBackgroundTasks()` 的元素同形状）。
   *
   * ⚠️ **仅进程自行完成 / 超时发射**（status 类型即契约，running/killed 不可能出现）：
   * 主动 kill 不发此事件——注册表 `kill()` 刻意不回调 completion listener，防同一份输出
   * 被 `kill_command` 返回值与完成回流双份消费；kill 后的 UI 刷新走宿主 kill 处理路径
   * 自行回推快照。
   *
   * 宿主只需 taskId 即可推全量快照，**刻意不携带输出**（命令输出体量可达 KB~MB，
   * UI 不呈现——同 `BackgroundTaskView` 刻意不含 `result` 的口径）。
   */
  backgroundTaskSettled: {
    taskId: string;
    command: string;
    status: BackgroundTaskNaturalStatus;
  };
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
  once<K extends keyof EventMap & string>(event: K, handler: (event: EventMap[K]) => void): void {
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
