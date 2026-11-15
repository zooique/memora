/**
 * 代理接管会话的落定通知器（第三切片：中断通知 → 第四切片：会话级落定 → 第五切片：主动浮现）
 *
 * 职责：把「某条归代理驱动的会话本轮已落定」这一事实，投递给创建 / 派发它的主控会话。
 * 第五切片起**不再等用户下次开口**：创建者空闲时立刻替它起一轮（读结果 → 整理 → 汇报），
 * 用户不需要先说话。落定结论三档：
 *   - `success`：轮以 `complete` 收场（跑完了）；
 *   - `failed`：轮以 `interrupted` 收场，且现场有 `error` 事件（跑挂了）；
 *   - `interrupted`：轮以 `interrupted` 收场，但原因是用户停 / 超时 / 不可知（被打断）。
 *
 * 边界（刻意收窄）：
 *   - 不写会话历史、不造轮：事实本体复用内核 `AgentLoop.enqueueCommandResult` 的系统事件注入队列
 *     （system 角色、跨空闲期留存、下一 turn 首个 step 边界注入），不伪装成用户发言；
 *     「起一轮」由面板经既有托管通道（`chat(origin='hosted')` + `runFlow`）完成，不新造通道；
 *   - 不落盘、不加 `SessionMeta` 字段：创建者关系与待汇报队列都只在进程内有效。重启后内存队列
 *     随之丢失，**刻意不补发**（宁可漏报一条旧落定，也不在重启后刷一屏历史）；
 *   - 只通知**本进程内登记过创建者、且当前仍由代理驱动**的会话。登记来源两条：
 *     代理建会话（`create_session`）与代理派发接管（`send_to_session`）。
 *     `SessionMeta.origin` 只记出生事实（用户自建会话被派发后仍是 `'user'`），不作通知判据；
 *     用户自己选托管新建、且从未被派发过的会话没有创建者记录 ⇒ 不会向任何代理发通知；
 *   - 同一会话同一轮只写一条（成功 / 失败 / 中断共用同一去重键，重复信号不再打扰主控）；
 *   - 宁晚不打断：创建者正在跑流、挂着待答提问、暂停中，或用户正在输入框里打字时，
 *     不立刻唤醒——把事实压进内存待办，等创建者本轮收场后由 `flushPending` 合并成一轮浮现；
 *   - 事件只带身份 + 结论（+ 失败 / 中断原因），**不带正文**：结论细节由主控按需调
 *     `list_work_sessions` / `read_memory_summary` 读，不在通知里另造一份摘要。
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
  /**
   * 目标会话当前是否仍由代理驱动（唯一的「现在归谁」判据）
   *
   * 与创建者账本（出生记录）分开：用户收回后，即使账本还记着「代理开的」也不再通知。
   */
  isAgentDriven: (sessionId: string) => boolean;
  /** 同步取已绑定实例（不 await 装配：取不到就如实不投） */
  getAgent: (sessionId: string) => Agent | undefined;
  /** 按轮 id 读盘上轮（paused 停止路径用；正常流尾由调方直接给轮） */
  readRound: (roundId: string) => Round | undefined;
  /** 此刻能否唤醒创建者（空闲 + 用户没在输入框里打字）——「不抢 / 不打断」的唯一判据 */
  canWakeCreator: (creatorSessionId: string) => boolean;
  /**
   * 替创建者立刻起一轮汇报（面板实现：既有托管通道 `chat(origin='hosted')` + `runFlow`）
   *
   * @returns false = 起不来（实例未就绪 / 此刻不空闲）；调用方据此保留待办、不装作已浮现
   */
  wakeCreator: (creatorSessionId: string) => boolean;
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
 * 落定结论三档（只作 `deriveSettlement` 的内部判别依据，不对外暴露）
 *
 *   - `success` = 跑完了；`failed` = 跑挂了（有 error 事件）；
 *   - `interrupted` = 被停 / 超时 / 原因不可知（可判定为「没跑完」，但不冒充失败）。
 */
type SettlementVerdict = 'success' | 'failed' | 'interrupted';

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
 * 把一轮终态翻译成落定结论文案
 *
 * 判据全部走内核单点（`isRoundSuccessful` / `isRoundSettled`），宿主不自己比较状态字面量：
 *   - 成功 = `complete`；
 *   - 失败 = `interrupted` 且现场有 `error` 事件（`deriveInterruptReason` 的 `error` 档）；
 *   - 其余 `interrupted` = 中断（用户停 / 超时 / 原因不可知）。
 *
 * 失败与中断刻意分开：主控汇报时「跑挂了」和「被叫停」是两种结论，不能混成一句「已停止」。
 *
 * @param round 盘上已收场的轮
 * @param hostAborted 宿主这一轮是否真的 abort 过
 * @returns 可直接拼进通知的结论文案
 */
function deriveSettlement(round: Round, hostAborted: boolean): string {
  if (isRoundSuccessful(round.status)) return '成功';
  const derived = deriveInterruptReason(round.processEvents ?? [], { hostAborted });
  // error 事件 = 跑挂了；其余（user / timeout / unavailable）都算中断，不冒充失败
  const verdict: SettlementVerdict = derived.stopper === 'error' ? 'failed' : 'interrupted';
  return verdict === 'failed'
    ? `失败（${describeStopper(derived)}）`
    : `中断（${describeStopper(derived)}）`;
}

/**
 * 拼一条通知正文（会话标题 + 落定结论 + sid/round，人不能只靠 id 认会话）
 */
function formatNotice(
  title: string,
  sessionId: string,
  roundId: string | undefined,
  detail: string,
): string {
  const roundSuffix = roundId ? `，round=${roundId}` : '';
  return `[托管会话已落定] 会话《${title}》（sid=${sessionId}${roundSuffix}）：${detail}`;
}

/**
 * 代理接管会话的落定通知器（每个面板一个实例，状态仅存于本进程）
 */
export class HostedSessionNotifier {
  /** 子会话 → 接管它的主控会话（代理建会话或代理派发接管时登记） */
  private readonly childToCreator = new Map<string, string>();

  /** 已投递过的 `${sessionId}:${roundId}`（同一轮重复信号只写一条） */
  private readonly notified = new Set<string>();

  /**
   * 创建者 → 压着待浮现的落定正文（创建者忙 / 用户正在输入时暂存）
   *
   * 只存正文、不存轮身份：去重键在入待办时就已记下，同一轮不会再排第二次。
   * 内存态、随进程消失（重启不补发，见模块头边界）。
   */
  private readonly pendingReports = new Map<string, string[]>();

  constructor(private readonly deps: HostedSessionNoticeDeps) {}

  /**
   * 登记「这条会话归某个主控代理驱动」
   *
   * 两种来源：代理建会话（`create_session`）与代理派发接管（`send_to_session`）。
   * 必须在首轮流启动**之前**调用（真实故障：首轮流可能先失败/被停，晚登记会漏通知）。
   *
   * @param childSessionId 被接管的会话
   * @param creatorSessionId 创建 / 派发它的主控会话
   */
  remember(childSessionId: string, creatorSessionId: string): void {
    this.childToCreator.set(childSessionId, creatorSessionId);
  }

  /**
   * 列出「某主控会话接管过的会话」（只读创建者账本）
   *
   * 工作台的「最近在办什么」直接用这份账本：`SessionMeta.origin === 'hosted'` 只说明
   * 「托管通道出生」，区分不了代理开的会话与用户自己选的托管新建，不能当清单判据。
   *
   * @param creatorSessionId 主控会话 id
   * @returns 被接管会话 id（按登记顺序；账本仅本进程有效，重启后为空）
   */
  childrenOf(creatorSessionId: string): string[] {
    const children: string[] = [];
    for (const [child, creator] of this.childToCreator) {
      if (creator === creatorSessionId) children.push(child);
    }
    return children;
  }

  /**
   * 流通用收尾：若本会话是代理开的且本轮已落定，把结论通知创建者
   *
   * 成功 / 失败 / 中断三档都会通知（判据见 `deriveSettlement`）；暂停可续跑，
   * 不是终态，直接跳过。
   *
   * @param input 流尾素材（会话 / 轮 / 是否宿主 abort）
   * @returns true = 真的投递了一条；false = 不该投 / 投不出去
   */
  noteFlowEnd(input: FlowEndNoticeInput): boolean {
    // 暂停可续跑，不是终态；只有真正收场的轮才通知。
    // 判据一律调内核单点，宿主不自写状态字面量比较（roundStore 的判据单源守卫会拦）。
    if (input.paused || !input.round) return false;
    const round = input.round;
    if (!isRoundSettled(round.status)) return false;
    const target = this.resolveTarget(input.sessionId);
    if (!target) return false;
    // 同一会话同一轮只写一条：成功 / 失败 / 中断共用同一去重键，重复信号不再打扰主控
    const key = `${input.sessionId}:${round.id}`;
    if (this.notified.has(key)) return false;
    const detail = deriveSettlement(round, input.hostAborted);
    const text = formatNotice(target.title, input.sessionId, round.id, detail);
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
   * 这是「会话跑挂」的另一条落点（无 roundId），结论固定为失败。
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
    const text = formatNotice(
      target.title,
      input.sessionId,
      undefined,
      `失败（异常终止：${message}）`,
    );
    return this.deliver(target.creator, text, undefined);
  }

  /**
   * 判定该会话是否该通知，并取出标题与创建者
   *
   * @returns undefined = 不通知（无元数据 / 没有创建者账本 / 目标已不由代理驱动 / 创建者已非托管）
   */
  private resolveTarget(sessionId: string): { creator: string; title: string } | undefined {
    const meta = this.deps.readSessionMeta(sessionId);
    // 元数据缺失 = 会话已删 / 未落盘：连标题都无从谈起，如实不投
    if (!meta) return undefined;
    const creator = this.childToCreator.get(sessionId);
    if (!creator) return undefined;
    // 当前驱动权判据（与停止 / 暂停 / 工作台清单同一判断）：用户收回后当前归用户，不再通知
    if (!this.deps.isAgentDriven(sessionId)) return undefined;
    // 创建者已被收回托管（或已关窗）：它现在是普通会话，不拿代理的事实打扰它
    if (!this.deps.isManaged(creator)) return undefined;
    return { creator, title: getSessionDisplayName(meta) || sessionId };
  }

  /**
   * 创建者本轮收场后，补浮现被压着的落定（面板在 `runFlow` 收尾时调）
   *
   * 合并成**一轮**：多条落定一次唤醒，避免逐条刷屏。仍不空闲 / 用户仍在输入则继续压着
   * （宁晚不打断）；实例已不在则如实留在待办里，不装作已浮现。
   *
   * @param creator 刚收场的那个会话（通常只是子会话，无待办时立即返回）
   */
  flushPending(creator: string): void {
    const pending = this.pendingReports.get(creator);
    if (!pending || pending.length === 0) return;
    const loop = this.deps.getAgent(creator)?.agentLoop;
    if (!loop) return;
    if (!this.deps.canWakeCreator(creator)) return;
    this.pendingReports.delete(creator);
    for (const text of pending) loop.enqueueCommandResult(text);
    this.deps.wakeCreator(creator);
  }

  /**
   * 真正投递：压入创建者的系统事件注入队列，并（空闲时）替它起一轮汇报
   *
   * 只有投递成功才记去重键——取不到实例时如实不投，不装作已送达。
   * 「忙 / 用户正在输入」不抢：正文进内存待办，等收场后由 `flushPending` 统一浮现。
   */
  private deliver(creator: string, text: string, key: string | undefined): boolean {
    const loop = this.deps.getAgent(creator)?.agentLoop;
    if (!loop) return false;
    if (key) this.notified.add(key);
    if (!this.deps.canWakeCreator(creator)) {
      const queue = this.pendingReports.get(creator);
      if (queue) queue.push(text);
      else this.pendingReports.set(creator, [text]);
      return true;
    }
    loop.enqueueCommandResult(text);
    // 事实已入队；立刻起一轮让主控主动汇报。起不来（实例刚被摘）时事实仍在队列，
    // 下次用户说话时照样带进上下文——不丢事实，只是不主动开口这一种降级。
    this.deps.wakeCreator(creator);
    return true;
  }
}
