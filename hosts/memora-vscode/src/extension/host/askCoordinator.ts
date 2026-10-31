import { LOOP_CONSTANTS } from '@zooique/memora';
import type { Agent, AgentChunk } from '@zooique/memora';
import type { PendingQuestionDto, ExtensionToWebviewMessage } from '../../shared/protocol.js';

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

/** ask 域全部反向依赖（3 个；均由 chatPanel 构造时注入） */
export interface AskDeps {
  /** 读**最新** agent（getter 委托，非快照） */
  getAgent: () => Agent | undefined;
  /** 消息投递单点（chatPanel 既有 `this.post`） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /**
   * 起流续跑（chatPanel 的 `runFlow`，**18 行包装**而非 529 行的 consumeFlow 主循环）
   *
   * 类型只声明第 1 参：域内只用 factory，`seed?` 是可选参数（函数类型兼容），
   * 故 chatPanel 侧传 `(factory) => this.runFlow(factory)` 即可。
   */
  runFlow: (
    factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>,
  ) => Promise<void>;
}

/**
 * ask 提问域协调器（自 chatPanel.ts 迁出，2026-10-21 · HOST-SPLIT-1 第 4 刀）
 *
 * 职责 = 承接提问写入源 + 超时保底计时 + 超时续跑/收场 + 停止时收场。
 * 判据全部落在**本域自己的事实**上（在途快照 `_pending` 是否为空），
 * 不消费相位投影（`deriveTurnState` 由该快照派生，反向依赖即第二真相）；
 * 不拥有 turnState 投影、不拥有事件订阅（订阅生命周期归宿主）。
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
   * ① 整批逐条渲染「问 + 未回答」交互行（与 qa 同构，question/options 随行透出）；
   * ② 消费在途提问（cancelAsk 注入 [ASK_ABORTED] 占位，转存快照供落盘）；
   * ③ **仍可续跑** → resumeExecution('timeout') 自动续跑（LLM 看到「用户未回答」自决）；
   *    **不可续跑** → `agent.abandonTurn()` 以中断收场（不再「假续跑」空耗）。
   * 选项/自由输入仍是唯一主动通道，超时只是保底（用户明确不要「跳过」按钮）。
   *
   * 多问批次整批逐条 post（与内核 runResume timeout 分支整组落盘同构）——
   * 屏上 / 盘面 / 重放三面同为 N 条（ASK-MULTI-Q-1）。
   *
   * **判据只认一件事：提问是否仍未被消费**（本域在途快照 `_pending` 非空）。
   * 不设相位守卫（2026-10-31 去相位化，ADR-044 决策 4）：
   * - 相位本就由该快照派生（`deriveTurnState` 以 questions 优先 ⇒ 非空即 `waiting/ask`），
   *   再判一次相位 = 同一事实两处判据，只会制造「一处为真、一处为假」的分叉；
   * - 停止/异常后需求恰恰相反：**这时才最需要保底收场**，相位守卫却会把回调挡在门外。
   *
   * ⚠️ 顺序不可调换：timer 置空 → 快照判据 → 取快照并清空 → 逐条 post → 消费提问 → 续跑/收场。
   * 消费必须在续跑前：cancelAsk 先注入占位 + 转存快照，`runResume` timeout 分支才取得走落盘。
   */
  async handleAskTimeout(): Promise<void> {
    const agent = this._deps.getAgent();
    if (!agent) return;
    this._timer = undefined; // 一次性触发
    // 唯一判据：提问是否仍未被消费（事实源 = 本域在途快照，非相位投影）
    const pendingQs = this._pending;
    if (pendingQs.length === 0) return;
    this._pending = []; // 提问已超时消费（整体清空，非 splice 逐条弹出）
    this.postQaRows(pendingQs, 'timeout', ASK_TIMEOUT_NOTICE);
    // 可续跑的唯一事实 = 内核仍持暂停检查点：`resumeExecution` 内部判据同源
    //（`status !== 'paused'` 直接 return）。不先问这一句，就会在无可续跑点时
    // 打出一批只上屏、不落盘的「未回答」行，且轮永久 pending（真机实证）。
    if (agent.sessionManager?.status === 'paused') {
      agent.cancelAsk();
      await this._deps.runFlow((signal) => agent.resumeExecution(undefined, signal, 'timeout'));
      return;
    }
    // 不可续跑（用户已停止 / 检查点被弃 / 流异常收场）⇒ 以中断收场，题面整组落盘为 unanswered
    await agent.abandonTurn();
  }

  /**
   * 用户停止（提问等待态）：消费在途提问并**以中断收场**（ADR-044 决策 3）。
   *
   * 为什么停止不能只「丢弃暂停检查点」：ask 挂起轮无正文 ⇒ 内核 `appendAssistant`
   * 空正文守卫直接返回 ⇒ 该轮没有任何收场调用点。只丢检查点会留下
   * 「pending + 残留 pendingAsk」的僵尸轮，并连带两个可观测故障：
   * ① 轮永久 pending（视图里永挂，超时保底也因无可续跑点而无从接续）；
   * ② 宿主 `_pending` 未清 ⇒ 相位恒 `waiting/ask` ⇒ 用户下一条输入被路由成
   *    「回答一个已死的提问」（内核内存里消费、不落盘）—— 输入凭空蒸发。
   *
   * @returns 是否清掉了暂停检查点（宿主据此给「检查点已清理」类提示）
   */
  async abandonOnStop(): Promise<boolean> {
    const agent = this._deps.getAgent();
    if (!agent) return false;
    const pendingQs = this._pending;
    this._pending = [];
    this.clearAskTimeout();
    // 未答提问逐条留痕：与内核 appendInterrupted 落盘的 unanswered 行**同文案、同题身份**，
    // 保证运行时与重放同面（题面与候选不丢）
    if (pendingQs.length > 0) {
      this.postQaRows(pendingQs, 'unanswered', LOOP_CONSTANTS.ASK_UNANSWERED_NOTICE);
    }
    const checkpointDiscarded = await agent.abandonTurn();
    if (pendingQs.length > 0) {
      this._deps.post({
        type: 'notice',
        level: 'info',
        message: `已停止：${pendingQs.length} 个提问未回答（已记为中断）`,
      });
    }
    return checkpointDiscarded;
  }

  /**
   * 交互行逐条透出单点（超时「未回答」与停止「未回答」共用）。
   *
   * inputId = 批内唯一身份（去重键真源）：同批共享 ms 级 `ts`，按 ts 去重会丢第 2..N 条。
   * ADR-043：身份真源 = 内核题身份 `askCallId`；缺失（旧 dist）时回退批内序号，
   * 只保同批不互相吃掉（保留 `live-input-` 前缀 = 真机排查一眼可见走了回退）。
   */
  private postQaRows(
    questions: readonly PendingQuestionDto[],
    kind: 'timeout' | 'unanswered',
    text: string,
  ): void {
    const now = new Date().toISOString();
    questions.forEach((q, i) => {
      this._deps.post({
        type: 'user',
        text,
        ts: now,
        kind,
        inputId: q.askCallId ?? `live-input-${now}-${i}`,
        ...(q.question ? { question: q.question, options: q.options } : {}),
      });
    });
  }
}
