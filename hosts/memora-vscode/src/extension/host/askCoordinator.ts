import type { Agent, AgentChunk } from '@zooique/memora';
import type {
  PendingQuestionDto,
  TurnState,
  ExtensionToWebviewMessage,
} from '../../shared/protocol.js';

/**
 * ask_user 提问等待超时（ms）：超时未答 → cancelAsk（[ASK_ABORTED] 占位）
 * + resumeExecution('timeout') 自动续跑（LLM 自决）。0/负值 = 禁用超时保底。
 * 语义 = 保底而非打扰：选项/自由输入仍是唯一主动通道，无「跳过」按钮。
 *
 * 时长取值（2026-10-13 真机实测订正，120s → 30min，用户拍板对齐 confirm 时长）：
 * 依据 = ask 超时是**自动继续**（无副作用），超时长度不带来安全风险（风险来自「超时后做什么」
 * 而非「等多久」）；代价仅是 loop 多挂起一会儿（不烧 token）。实测 2 分钟对「细纲/文风要不要
 * 继续」这类需读完长文才能决策的问题偏短，且超时后模型代选继续 = 用户失去否决窗口。
 *
 * ⚠️ **只对齐时长，严禁对齐语义**（详见 `confirmCoordinator.ts` 的 `CONFIRM_TIMEOUT_MS` 注释的风险分级说明）：
 * 本常量超时 = 自动**继续**，confirm 侧超时 = 自动**拒绝**。两者虽同为 30 分钟，
 * **仍是两个独立常量、两种相反终态**——合并即 fail-open 安全模型反转 = 造伤。
 */
const ASK_TIMEOUT_MS = 30 * 60 * 1000;

/** ask 超时交互记录正文（镜像内核 orchestrator.ts ASK_TIMEOUT_NOTICE，防运行时/重放
 * 文案分叉——post 给 webview 即时渲染与内核落盘 content 必须同值；改此须同步内核。
 *
 * 语义补充见内核 orchestrator.ts 同名常量注释（一个字符串服务「渲染给用户」+「进模型上下文」
 * 两个语境，故含代选指令：模型须从选项中选一项推荐的并声明代选及理由）。 */
const ASK_TIMEOUT_NOTICE =
  '用户未在时限内回答，已自动继续——请从上面的选项里选一项你推荐的方案继续推进，并在答复中说明这是你代选的及理由；不可逆操作仍需向我确认';

/** ask 域全部反向依赖（5 个；均由 chatPanel 构造时注入） */
export interface AskDeps {
  /** 读**最新** agent（getter 委托，非快照） */
  getAgent: () => Agent | undefined;
  /**
   * 相位判据单点（`chatPanel.isAskWaiting`）
   *
   * 🔴 **本模块不得另立「是否 ask 等待」的守卫/分流判断**（第二处判据 = SSOT 违例）：
   * 判据真源与另外两个调用点都在 chatPanel，此处一律消费注入的 `isAskWaiting()`。
   *
   * 唯一例外 = **TS 类型收窄**（不算另立判据）：`TurnState` 是可辨识联合、`questions` 只存在于
   * waiting 变体，访问前必须写 `state.phase === 'waiting'`（`boolean` 返回值不做收窄，注入替代不了）。
   * 该字面只此半句；`reason === 'ask'` 的语义判断走注入判据，不在本模块重写。
   */
  isAskWaiting: () => boolean;
  /** 读**最新** `_turnState`（getter 委托——postTurnUpdate 每次投影整体替换该对象） */
  getTurnState: () => TurnState;
  /** 消息投递单点（chatPanel 既有 `this.post`） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /**
   * 起流续跑（chatPanel 的 `runFlow`，**18 行包装**而非 529 行的 consumeFlow 主循环）
   *
   * 类型只声明第 1 参：域内只用 factory，`seed?` 是可选参数（函数类型兼容），
   * 故 chatPanel 侧传 `(factory) => this.runFlow(factory)` 即可。
   */
  runFlow: (factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>) => Promise<void>;
}

/**
 * ask 提问域协调器（自 chatPanel.ts 迁出，2026-10-21 · HOST-SPLIT-1 第 4 刀）
 *
 * 职责 = 承接提问写入源 + 超时保底计时 + 超时自动续跑。
 * **不拥有**相位判据（依赖注入）、不拥有 turnState 投影（`deriveTurnState` 真源在 helpers）、
 * 不拥有事件订阅（订阅生命周期归宿主）。
 */
export class AskCoordinator {
  /**
   * 在途主动提问（questionPending 事件 / 流尾兜底 chunk 的**写入源头**）
   *
   * overwrite 全量写入（新提问覆盖旧提问），读取一律经 `_turnState.waiting.questions`
   * （postTurnUpdate 每次投影时派生），仅在提问被回答 / 超时 / 被新提问覆盖时整体清空——
   * 无「消费式 splice 逐条弹出」的时序约束。
   * 提问的原始权威仍在内核 loop.pendingAsk（宿主侧仅此一处 intake，非第二真相）。
   */
  private _pending: PendingQuestionDto[] = [];
  /**
   * ask 提问等待超时计时器（超时保底）：onPendingQuestion / 流尾兜底提问渲染时
   * 启动（覆写式），用户回答/补充消费提问时清除；到点未答 → handleAskTimeout 自动续跑。
   * 生命周期仅限「存在未答提问」窗口——不随 consumeFlow finally 清（ask 暂停后流已结束但等待仍活）。
   */
  private _timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly _deps: AskDeps) {}

  /** 提问写入源（overwrite 全量写）：事件驱动与流尾兜底两处共用 */
  setPending(questions: PendingQuestionDto[]): void {
    this._pending = questions;
  }

  /** 在途提问只读投影（供宿主 `deriveTurnState` 派生 turnState 用） */
  pendingQuestions(): PendingQuestionDto[] {
    return this._pending;
  }

  /** 提问被回答 / 被新提问覆盖 ⇒ 整体清空（非消费式 splice 逐条弹出） */
  clearPending(): void {
    this._pending = [];
  }

  /** 启动/重置 ask 等待超时计时器（覆写式；超时保底入口） */
  armAskTimeout(): void {
    this.clearAskTimeout();
    if (!ASK_TIMEOUT_MS || ASK_TIMEOUT_MS <= 0) return;
    this._timer = setTimeout(() => {
      void this.handleAskTimeout();
    }, ASK_TIMEOUT_MS);
  }

  /** 清除 ask 等待超时计时器（用户回答/补充消费提问、离开等待态时调用） */
  clearAskTimeout(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
  }

  /**
   * ask 提问等待超时（保底，非打扰通道）：用户未在时限内回答 →
   * ① 渲染「问 + 未回答」交互行（与 qa 同构，question/options 随行透出）；
   * ② cancelAsk 注入 [ASK_ABORTED] 占位 tool result（转存提问快照供落盘）；
   * ③ resumeExecution('timeout') 自动续跑——LLM 看到「用户未回答该提问」自决最优方案。
   * 选项/自由输入仍是唯一主动通道，超时只是保底（用户明确不要「跳过」按钮）。
   *
   * ⚠️ **八步顺序不可调换**（详见方案 §2.2 T3/T4）：timer 置空 → pending 空守卫 →
   * 相位守卫 → 读提问原文 → 清 pending → post 超时记录 → cancelAsk → resume。
   * 其中 ⑦ 在 ⑧ 之前：cancelAsk 先注入占位 + 转存快照，`runResume` timeout 分支取走落盘 question。
   */
  async handleAskTimeout(): Promise<void> {
    const agent = this._deps.getAgent();
    if (!agent) return;
    this._timer = undefined; // 一次性触发
    if (this._pending.length === 0) return; // 已被回答/补充消费
    if (!this._deps.isAskWaiting()) return; // 已离开 waiting(ask)（异常/新流）；守卫用相位判据（不查 sessionManager.status）
    // 提问原文从 _turnState.waiting.questions 读（统一读取源，不维护镜像）；
    // `phase` 字面 = TS 收窄所必需（questions 仅 waiting 变体存在，见 AskDeps.isAskWaiting 注释），
    // 不另写 `reason === 'ask'`——ask 语义由上方 isAskWaiting() 守卫 + 投影真源双保证
    //（deriveTurnState 恒派生：pause/pausePending 分支不带 questions，questions 非空即 ask）
    const state = this._deps.getTurnState();
    const pendingQ = state.phase === 'waiting' ? state.questions?.[0] : undefined;
    this._pending = []; // 提问已超时消费（整体清空，非 splice 逐条弹出）
    const now = new Date().toISOString();
    this._deps.post({
      type: 'user',
      text: ASK_TIMEOUT_NOTICE, // 镜像内核 orchestrator ASK_TIMEOUT_NOTICE（运行时 = 重放同构）
      ts: now,
      kind: 'timeout',
      ...(pendingQ?.question ? { question: pendingQ.question, options: pendingQ.options } : {}),
    });
    // cancelAsk 先于 resume：注入 [ASK_ABORTED] 占位 + 转存提问快照（runResume timeout 分支取走落盘 question）
    agent.cancelAsk();
    await this._deps.runFlow((signal) => agent.resumeExecution(undefined, signal, 'timeout'));
  }
}