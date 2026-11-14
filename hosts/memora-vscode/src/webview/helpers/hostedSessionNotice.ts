/**
 * 托管子会话中断通知器（第三切片：中断通知）
 *
 * 职责：把「某条代理开出去的会话被停 / 异常终止」这一事实，投递给创建它的主控会话，
 * 让主控**下次说话时**在上下文里看到（它空闲时不会自己刷新）。
 *
 * 边界（刻意收窄）：
 *   - 不写会话历史、不造轮：复用内核 `AgentLoop.enqueueCommandResult` 的系统事件注入队列
 *     （system 角色、跨空闲期留存、下一 turn 首个 step 边界注入），不伪装成用户发言；
 *   - 不落盘、不加 `SessionMeta` 字段：创建者关系只在进程内有效，重启即失（如实不通知）；
 *   - 只通知 `SessionMeta.origin === 'hosted'` 且**本次进程内记录了创建者**的会话；
 *     用户自己选托管新建的会话同为 `hosted`，但它没有创建者记录 ⇒ 不会向任何代理发通知；
 *   - 同一会话同一轮只写一条（重复的停止信号不再打扰主控）。
 */
import {
  getSessionDisplayName,
  isRoundSettled,
  isRoundSuccessful,
  type Agent,
  type Round,
  type SessionMeta,
} from '@zooique/memora';
import { deriveInterruptReason } from '../../shared/interruptReason.js';

/** 通知器依赖（全部由面板注入闭包；本类不持有面板实例） */
export interface HostedSessionNoticeDeps {
  /** 按会话读元数据（真源 = 宿主 SessionStore） */
  readSessionMeta: (sessionId: string) => SessionMeta | undefined;
  /** 该会话当前是否仍是托管装配（创建者被收回后不再打扰它） */
  isManaged: (sessionId: string) => boolean;
  /** 同步取已绑定实例（不 await 装配：取不到就如实不投） */
  getAgent: (sessionId: string) => Agent | undefined;
  /** 按轮 id 读盘上轮（paused 停止路径用；正常流尾由调方直接给轮） */
  readRound: (roundId: string) => Round | undefined;
}

/** 流尾通知入参（对象化只为可读；字段都来自流尾现成值） */
export interface FlowEndNoticeInput {
  /** 刚收场的会话 */
  sessionId: string;
  /** 盘上本轮（缺省 = 无轮可归属，不通知） */
  round?: Round;
  /** 该轮是否软暂停（暂停可续跑，不是终态，不通知） */
  paused?: boolean;
  /** 宿主这一轮是否真的 abort 过（`controller.signal.aborted`） */
  hostAborted: boolean;
}

/**
 * 把停手者翻译成中文事实句
 *
 * 事实层单独出文案（不复用 webview 的 l10n 展示键）：通知是给模型读的，
 * 且 `friendlyErrorMessage` 会吞掉原始错误细节，这里必须保留原文。
 *
 * @param stopper 原因投影结果
 * @returns 可直接拼进通知的中文原因
 */
function describeStopper(derived: ReturnType<typeof deriveInterruptReason>): string {
  switch (derived.stopper) {
    case 'user':
      return '用户主动停止';
    case 'timeout':
      return '请求超时';
    case 'error':
      // error 分支必有 error 事件；无文本时如实说「未提供」，不编造原因
      return `异常终止：${derived.source?.type === 'error' ? derived.source.payload.message : '未提供错误信息'}`;
    case 'unavailable':
      // 取不到就如实标取不到：不回落「用户停」，也不用 unknown 当垃圾桶
      return '原因不可知（本轮以中断收场，但未收到停止原因）';
  }
}

/**
 * 拼一条通知正文（会话标题 + 停手者 + sid/round，人不能只靠 id 认会话）
 */
function formatNotice(
  title: string,
  sessionId: string,
  roundId: string | undefined,
  stopperText: string,
): string {
  const roundSuffix = roundId ? `，round=${roundId}` : '';
  return `[托管会话已停止] 会话《${title}》（sid=${sessionId}${roundSuffix}）：${stopperText}`;
}

/**
 * 托管会话中断通知器（每个面板一个实例，状态仅存于本进程）
 */
export class HostedSessionNotifier {
  /** 子会话 → 创建它的主控会话（只记代理建会话，不记派发） */
  private readonly childToCreator = new Map<string, string>();

  /** 已投递过的 `${sessionId}:${roundId}`（同一轮重复信号只写一条） */
  private readonly notified = new Set<string>();

  constructor(private readonly deps: HostedSessionNoticeDeps) {}

  /**
   * 登记「代理创建了这条会话」
   *
   * 必须在首轮流启动**之前**调用（真实故障：首轮流可能先失败/被停，晚登记会漏通知）。
   *
   * @param childSessionId 子会话
   * @param creatorSessionId 创建它的主控会话
   */
  remember(childSessionId: string, creatorSessionId: string): void {
    this.childToCreator.set(childSessionId, creatorSessionId);
  }

  /**
   * 列出「某主控会话开出去的子会话」（只读创建者账本）
   *
   * 工作台的「最近在办什么」直接用这份账本：`SessionMeta.origin === 'hosted'` 只说明
   * 「托管通道出生」，区分不了代理开的会话与用户自己选的托管新建，不能当清单判据。
   *
   * @param creatorSessionId 主控会话 id
   * @returns 子会话 id（按登记顺序；账本仅本进程有效，重启后为空）
   */
  childrenOf(creatorSessionId: string): string[] {
    const children: string[] = [];
    for (const [child, creator] of this.childToCreator) {
      if (creator === creatorSessionId) children.push(child);
    }
    return children;
  }

  /**
   * 流通用收尾：若本会话是代理开的且本轮非正常收场，通知创建者
   *
   * @param input 流尾素材（会话 / 轮 / 事件 / 是否宿主 abort）
   * @returns true = 真的投递了一条；false = 不该投 / 投不出去
   */
  noteFlowEnd(input: FlowEndNoticeInput): boolean {
    // 暂停可续跑，不是终态；只有「已收场且未成功」（= interrupted）才通知。
    // 判据一律调内核单点，宿主不自写状态字面量比较（roundStore 的判据单源守卫会拦）。
    if (input.paused || !input.round) return false;
    const round = input.round;
    if (!isRoundSettled(round.status) || isRoundSuccessful(round.status)) return false;
    const target = this.resolveTarget(input.sessionId);
    if (!target) return false;
    // 同一会话同一轮只写一条：重复的停止信号（如收尾分支再次触发）不再打扰主控
    const key = `${input.sessionId}:${round.id}`;
    if (this.notified.has(key)) return false;
    const derived = deriveInterruptReason(round.processEvents ?? [], {
      hostAborted: input.hostAborted,
    });
    const text = formatNotice(target.title, input.sessionId, round.id, describeStopper(derived));
    return this.deliver(target.creator, text, key);
  }

  /**
   * 流收场入口（面板只需给轮 id，轮本体回盘上读）
   *
   * 为什么要回盘读：流尾的 `latestRoundId` 指向刚收场的轮，`abort/error` 事件此时已随
   * checkpoint 落盘；读盘保证「原因」与「重放看到的现场」是同一份数据，不另造事件副本。
   *
   * @param roundId 刚收场的轮（缺省 = 无轮可归属，不通知）
   * @param paused 是否软暂停（暂停可续跑，不是终态）
   * @param hostAborted 宿主这一轮是否真的 abort 过
   */
  noteSettledFlow(
    sessionId: string,
    roundId: string | undefined,
    paused: boolean,
    hostAborted: boolean,
  ): boolean {
    const round = roundId ? this.deps.readRound(roundId) : undefined;
    return this.noteFlowEnd({
      sessionId,
      ...(round ? { round } : {}),
      paused,
      hostAborted,
    });
  }

  /**
   * paused 态用户停止：该轮没有活跃流可捕获尾部，只能按轮 id 回盘上读
   *
   * `hostAborted` 是直接证据（调用方就是用户停止入口），原因归用户；轮 id 由调用方在
   * `abandonOnStop()` **之前**取好，避免收场后标识变化导致与流尾重复。
   */
  notePausedStop(sessionId: string, roundId: string): boolean {
    return this.noteSettledFlow(sessionId, roundId, false, true);
  }

  /**
   * 同步抛错收尾（`runFlow` 的 catch）：没有轮、没有事件，原因就是抛出的异常本身
   *
   * @param input.sessionId 抛错的会话
   * @param input.error 抛出的异常
   * @returns true = 真的投递了一条
   */
  noteSyncThrow(input: { sessionId: string; error: unknown }): boolean {
    const target = this.resolveTarget(input.sessionId);
    if (!target) return false;
    // 无 roundId：不参与去重（不写 `sid:undefined`，那会永久吞掉该会话后续所有失败）
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    const text = formatNotice(target.title, input.sessionId, undefined, `异常终止：${message}`);
    return this.deliver(target.creator, text, undefined);
  }

  /**
   * 判定该会话是否该通知，并取出标题与创建者
   *
   * @returns undefined = 不通知（非代理开的 / 创建者不在 / 创建者已非托管）
   */
  private resolveTarget(sessionId: string): { creator: string; title: string } | undefined {
    const meta = this.deps.readSessionMeta(sessionId);
    // 出生来源判据：缺省（旧会话 / 用户自助）与 'user' 一律不通知
    if (meta?.origin !== 'hosted') return undefined;
    const creator = this.childToCreator.get(sessionId);
    if (!creator) return undefined;
    // 创建者已被收回托管（或已关窗）：它现在是普通会话，不拿代理的事实打扰它
    if (!this.deps.isManaged(creator)) return undefined;
    return { creator, title: getSessionDisplayName(meta) || sessionId };
  }

  /**
   * 真正投递：压入创建者的系统事件注入队列
   *
   * 只有压入成功才记去重键——取不到实例 / 队列不可用时如实不投，不装作已送达。
   */
  private deliver(creator: string, text: string, key: string | undefined): boolean {
    const loop = this.deps.getAgent(creator)?.agentLoop;
    if (!loop) return false;
    loop.enqueueCommandResult(text);
    if (key) this.notified.add(key);
    return true;
  }
}
