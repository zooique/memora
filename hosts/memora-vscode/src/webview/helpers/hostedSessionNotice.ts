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
 *   - 创建者实例**还没装配**（真机：重启后子会话先落定、创建者面板尚未装配）时，
 *     通知压进待办、等实例就位由 `flushPending` 放出——**不许直接丢**（丢了用户永远看不到结果）。
 *   - 只通知**本进程内登记过创建者、且当前仍由代理驱动**的会话。登记来源两条：
 *     代理建会话（`create_session`）与代理派发接管（`send_to_session`）。
 *     `SessionMeta.origin` 只记出生事实（用户自建会话被派发后仍是 `'user'`），不作通知判据；
 *     用户自己选托管新建、且从未被派发过的会话没有创建者记录 ⇒ 不会向任何代理发通知；
 *   - 同一会话同一轮只写一条（成功 / 失败 / 中断共用同一去重键，重复信号不再打扰主控）；
 *   - 宁晚不打断：创建者正在跑流、挂着待答提问、暂停中，或用户正在输入框里打字时，
 *     不立刻唤醒——把事实压进内存待办，等创建者本轮收场后由 `flushPending` 合并成一轮浮现；
 *   - 事件带身份 + 结论（+ 失败 / 中断原因），成功轮另带**落盘原文的截断投影**（交付摘录，
 *     上限与工作台末轮摘要共用 `textClip`）；**不带重新生成的摘要**——摘录只剪不改写，
 *     失败 / 中断轮不带（半截回答不能冒充交付）。
 *
 * 第六切片（HOSTED-ASK-ROUTE-1）：除落定外再发一档「等你拍板」（`needs-answer`）——
 * 托管子会话挂上 ask_user 提问时，同样走本投递器叫醒创建者（题面 + 选项随事实带出），
 * 替代「等 30 分钟超时由子会话自己代选」。与落定**共用**投递 / 去重 / 待办 / 唤醒骨架，
 * 只换事实正文与去重键前缀；不另造第二通道、不用 `chat()` 伪造用户发言。
 * 2026-11-18 用户拍板：正文指令为「按判断拍板继续、不阻塞任务」（可代答 / 转述 / 换活），
 * 不再强制「立即逐题作答」——助手是判断者，不是被绑定的答题器；30 分钟保底仍不动。
 * 2026-11-21 用户再拍板（ASK-PROXY-PREFER-1）：「能判断就代答」——并列退路被真机证伪为
 * 空串跳过（模型对偏好题一律交空串，子会话再问、循环放大）。正文改为**有选项优先代选**、
 * 只有确实无法判断才转述 / 换活；不可逆操作边界不动，仍不替用户做不可逆决定。
 *
 * 第七切片（P2 Hand back）：Worker 超界交回走同一投递器的 `handback` 档——收场文本以
 * `[HAND_BACK]` 开头时接管本轮落定通知（只投一条，防双醒），正文带原派活边界
 * `workOrder` 供 Router 决策；去重键前缀与落定 / needs-answer 隔离。不启用第二套消费者。
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
import type { PendingQuestionDto } from '../../shared/protocol.js';
// 交付摘录与工作台末轮摘要同一截断口径（阈值只定义一次）
import { clipSummaryText } from './textClip.js';
import {
  formatHandBackMessage,
  isHandBackMessage,
  parseHandBackMessage,
  type HandBackMessage,
} from './handBackMessage.js';

/** 通知器依赖（全部由面板注入闭包；本类不持有面板实例） */
export interface HostedSessionNoticeDeps {
  /** 按会话读元数据（真源 = 宿主 SessionStore） */
  readSessionMeta: (sessionId: string) => SessionMeta | undefined;
  /** 该会话当前是否仍是助手会话（创建者不再是助手会话时不打扰它） */
  isManaged: (sessionId: string) => boolean;
  /**
   * 目标会话当前是否仍由代理驱动（唯一的「现在归谁」判据）
   *
   * 与创建者账本（出生记录）分开：用户接管中或盘读异常时，即使账本还记着「代理开的」也不通知。
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

/** 「等你作答」通知入参（HOSTED-ASK-ROUTE-1）：来自 questionPending 事件的现成值 */
export interface NeedsAnswerNoticeInput {
  /** 挂起提问的子会话（工作会话） */
  sessionId: string;
  /** 在途提问（题面 + 选项真源 = 协议 PendingQuestionDto，宿主不自造摘要） */
  questions: readonly PendingQuestionDto[];
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
 * 拼一条通知正文（会话标题 + 落定结论 + 交付摘录 + sid/round，人不能只靠 id 认会话）
 *
 * @param delivered 成功轮的交付摘录（已截断；缺省 = 失败 / 中断 / 无正文，不拼该段）
 */
function formatNotice(
  title: string,
  sessionId: string,
  roundId: string | undefined,
  detail: string,
  delivered?: string,
): string {
  const roundSuffix = roundId ? `，round=${roundId}` : '';
  const excerpt = delivered ? ` 交付摘录：${delivered}` : '';
  return `[托管会话已落定] 会话《${title}》（sid=${sessionId}${roundSuffix}）：${detail}${excerpt}`;
}

/**
 * 把「等你作答」拼成一条 system 事实句（喂给创建者 agent，非用户发言）
 *
 * 题面 + 选项真源走协议 `PendingQuestionDto`，宿主不另造摘要、不改题面：
 * 助手据此判断处置（有选项优先代选 / 无法判断才转述用户 / 继续别的活）。正文带
 * 「按判断拍板继续、别阻塞、别拖到 30 分钟让子会话自己代选」——唤醒种子文案说的是
 * 「落定汇报」，这条事实要把「需要决策」的语义补回来，否则助手被叫醒后只汇报不处置
 * （判据①要求拿到题面并触发处置，不是等 30 分钟）。2026-11-18 用户拍板：助手判断后
 * 拍板继续、不阻塞任务；原「立即逐题作答」强指令随之改为「按判断处置」。
 * 2026-11-21 订正（ASK-PROXY-PREFER-1）：真机里「任选」退化为偏好题一律交空串跳过 ⇒
 * 收紧为有选项优先代选；工具契约不变（空串仍是用户自助跳过的合法形态），只改这条
 * 唤醒正文的处置优先级。不可逆操作边界不动。
 *
 * @param title 挂起提问的会话标题
 * @param sessionId 挂起提问的会话 id
 * @param questions 在途提问（含题面与候选）
 */
function formatNeedsAnswer(
  title: string,
  sessionId: string,
  questions: readonly PendingQuestionDto[],
): string {
  const lines = questions.map((q, i) => {
    const options = q.options && q.options.length > 0 ? `（选项：${q.options.join(' / ')}）` : '';
    const custom = q.allowCustom ? '（可自定义回答）' : '';
    return `  ${i + 1}. ${q.question}${options}${custom}`;
  });
  return (
    `[托管会话需要你拍板] 会话《${title}》（sid=${sessionId}）在等待回答。` +
    `请你按判断拍板继续、不要阻塞任务（有选项时按题面与上下文直接代选一项并说明代选理由；` +
    `只有确实无法判断时才转述用户或继续别的活；不可逆操作不代答、仍留用户决定，` +
    `别拖到超时让子会话自己代选）：\n` +
    lines.join('\n')
  );
}

/**
 * 「等你作答」的去重键（批级）
 *
 * 题身份真源 = 内核 `askCallId`，缺失（旧 dist）回退题面文本，口径与
 * `AskCoordinator.postRow` 的 inputId 一致——同批重复事件同键只叫一次，
 * 换一批（题不同）能再次唤醒。`needs-answer:` 前缀与落定的 `${sid}:${roundId}` 键空间隔离，
 * 否则同一轮「先提问、后落定」时落定通知会被提问键吞掉。
 */
function needsAnswerKey(sessionId: string, questions: readonly PendingQuestionDto[]): string {
  const signature = questions.map((q) => q.askCallId ?? q.question).join('|');
  return `needs-answer:${sessionId}:${signature}`;
}

/**
 * 把 Worker 交回拼成一条 system 事实句（喂给创建者 Router，非用户发言）
 *
 * 格式真源 = `handBackMessage.ts` 的 B6/B9；本函数只负责通知外壳与「原派活边界」，
 * 不另造第二份解析或格式化。`workOrder` 是唯一运行时读取点：交回时把派活边界
 * 一并带出，Router 才能据此决定转新活 / 合并 / 转述用户。
 */
function formatHandBack(
  title: string,
  sessionId: string,
  msg: HandBackMessage,
  workOrder: string | undefined,
): string {
  const boundary = workOrder ? `\n原派活边界：${workOrder}` : '';
  return (
    `[托管会话交回] 会话《${title}》（sid=${sessionId}）超出派活边界，请决定转新活 / 合并到现有活 / 转述用户：\n` +
    `${formatHandBackMessage(msg)}${boundary}`
  );
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
   * 列出「压在这个创建者名下、尚未浮现的落定汇报」条数
   *
   * 只读待办队列，不触发投递：用于如实读出「还有几条结果尚未浮现到这条会话」。
   * 创建者不再是助手会话时 `resolveTarget` 的 `isManaged` 判据不成立 ⇒ 待办不会再浮现；
   * 这条事实必须能被读出，否则容易把「压着没送」误说成「没有结果」。
   *
   * @param creatorSessionId 主控会话 id
   * @returns 待浮现条数（无待办 = 0）
   */
  pendingReportCount(creatorSessionId: string): number {
    return this.pendingReports.get(creatorSessionId)?.length ?? 0;
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
    // 交付摘录：只在成功轮取盘上已定型的 assistantMessage（判据调内核单点）；
    // 失败 / 中断不取——半截回答不是交付物。截断口径与工作台末轮摘要共用 textClip。
    const delivered = isRoundSuccessful(round.status)
      ? clipSummaryText(round.assistantMessage?.content ?? '')
      : '';
    const text = formatNotice(
      target.title,
      input.sessionId,
      round.id,
      detail,
      delivered || undefined,
    );
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
   * 挂起提问 → 叫醒创建者（HOSTED-ASK-ROUTE-1「等你作答」档，非阻塞）
   *
   * 子会话进入 `wait_ask` 时由面板 `questionPending` 处理器调用：题面 + 选项随事实
   * 压进创建者的 system 事件队列，空闲时立刻替它起一轮作答，不等 30 分钟超时
   * （超时保底 `armAskTimeout` 由 AskCoordinator 保留不动，这条只是主通道）。
   *
   * 与落定通知**共用** `resolveTarget` / `deliver` / 去重 / 待办 / 唤醒骨架：
   *   - 负例天然成立：`resolveTarget` 的 `isAgentDriven` 判据让「无戳的轮 / 用户自助会话」
   *     直接返回 undefined，不叫代理，仍只有 `_attention.onAskWaiting` 的用户提醒；
   *   - 创建者忙 / 正在输入 / 实例未装配 → 走 `deliver` 既有纪律压待办、不丢、收场后合并浮现；
   *   - 同批重复事件 → 去重键拦住不重复叫；换一批题 → 新键可再次唤醒。
   *
   * @param input 挂起提问的子会话 + 在途提问（事件现成值）
   * @returns true = 已投递或已受理压待办；false = 不该通知 / 无题
   */
  noteNeedsAnswer(input: NeedsAnswerNoticeInput): boolean {
    if (input.questions.length === 0) return false;
    const target = this.resolveTarget(input.sessionId);
    if (!target) return false;
    const key = needsAnswerKey(input.sessionId, input.questions);
    if (this.notified.has(key)) return false;
    const text = formatNeedsAnswer(target.title, input.sessionId, input.questions);
    return this.deliver(target.creator, text, key);
  }

  /**
   * Worker 超界交回 → 注入创建者 Router（P2 · 与落定 / needs-answer 共骨架）
   *
   * @returns true = 命中交回并已投递 / 压待办 / 同因已投过（调用方据此抑制落定通知）；
   *          false = 不是交回消息、解析失败、或目标不该通知（调用方照常发落定通知）
   */
  noteHandBack(sessionId: string, rawText: string): boolean {
    if (!isHandBackMessage(rawText)) return false;
    const msg = parseHandBackMessage(rawText);
    if (!msg) return false;
    const key = `handback:${sessionId}:${msg.reason}`;
    // 同因重复信号：算已受理（抑制落定通知），但不再投第二条
    if (this.notified.has(key)) return true;
    const target = this.resolveTarget(sessionId);
    if (!target) return false;
    const workOrder = this.deps.readSessionMeta(sessionId)?.workOrder;
    const text = formatHandBack(target.title, sessionId, msg, workOrder);
    const delivered = this.deliver(target.creator, text, key);
    // deliver 在未装配 / 忙时压待办也返回 false，但已记去重键 ⇒ 视为受理
    return delivered || this.notified.has(key);
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
    // 当前驱动权判据（与停止 / 暂停 / 工作台清单同一判断）：用户接管中 / 非托管来源不通知
    if (!this.deps.isAgentDriven(sessionId)) return undefined;
    // 创建者已不是助手会话（或已关窗）：不拿代理的事实打扰它
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
   * 受理即记去重键——三种受理形态（直接投递 / 忙时压待办 / 实例未装配时压待办）都算受理，
   * 只有「判定不该通知」才不记。创建者实例还没装配时**不许直接丢**：真机场景是
   * 「子会话先落定、创建者面板尚未装配」，丢掉等于用户永远看不到这条结果。压进待办后，
   * 装配完成的当口由 `agentForSession` 调 `flushPending` 放出。
   *
   * @returns true = 已投进创建者事件队列（或已决定稍后自动放出）；false = 本轮不通知
   */
  private deliver(creator: string, text: string, key: string | undefined): boolean {
    if (key) this.notified.add(key);
    const loop = this.deps.getAgent(creator)?.agentLoop;
    // 实例未装配（或刚被摘）：先压待办，等实例就位再放；不丢、也不装作已送达
    if (!loop) {
      this.enqueuePending(creator, text);
      return false;
    }
    if (!this.deps.canWakeCreator(creator)) {
      this.enqueuePending(creator, text);
      return true;
    }
    loop.enqueueCommandResult(text);
    // 事实已入队；立刻起一轮让主控主动汇报。起不来（实例刚被摘）时事实仍在队列，
    // 下次用户说话时照样带进上下文——不丢事实，只是不主动开口这一种降级。
    this.deps.wakeCreator(creator);
    return true;
  }

  /**
   * 把一条待浮现正文压进创建者的待办（同一轮重复信号不会重复排队：去重键在 `deliver` 入口就记了）
   *
   * @param creator 创建者会话
   * @param text 已拼好的通知正文
   */
  private enqueuePending(creator: string, text: string): void {
    const queue = this.pendingReports.get(creator);
    if (queue) queue.push(text);
    else this.pendingReports.set(creator, [text]);
  }
}

/**
 * 收场分流单点：交回命中则接管本轮，未命中照常落定
 *
 * 面板只调这一处，避免在 chatPanel 里写第二份「先交回还是先落定」的判据。
 */
export function noteHandBackOrSettlement(
  notifier: HostedSessionNotifier,
  sessionId: string,
  roundId: string | undefined,
  finalText: string | undefined,
  paused: boolean,
  hostAborted: boolean,
): void {
  if (finalText && notifier.noteHandBack(sessionId, finalText)) return;
  notifier.noteSettledFlow(sessionId, roundId, paused, hostAborted);
}
