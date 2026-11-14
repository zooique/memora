/**
 * 对话面板 · 运行控制域（自 `chatPanel.ts` 按 op 组外置 · B9-D-6）
 *
 * 职责：一次 turn 运行期的三个**用户控制**入口——停止（`handleStop`）、暂停 toggle
 * （`handlePause`）、恢复（`resumeInput`）。它们共同回答「用户想干预正在跑的这轮时，宿主怎么反应」，
 * 且都依赖同一对会话级运行态（`runtimeFor`）与提问协调器（`askFor`），故同域承载。
 *
 * 与输入收口（`handleInput` 相位路由）的分工：本域**不做相位裁决**——能否停/暂停/恢复由
 * 内核状态机与 UI 可见性决定（`handleInput` 负责把输入分派到这里），本域只执行并给出点击反馈。
 * 与待发送队列投影的分工：丢弃信号 `postPendingDiscarded` 与快照 `syncPendingQueue` 留在面板
 * （它们是队列投影的一对，与运行控制共享的只是「停止会丢弃排队插话」这一个调用点）。
 */
import * as vscode from 'vscode';
import type { Agent, AgentChunk } from '@zooique/memora';
import { toNoticeText } from '../../extension/host/noticeText.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import type { HostedStopResult } from '../../extension/host/workSessionTools.js';
import type {
  HostedPauseResult,
  HostedResumeResult,
} from '../../extension/host/workSessionTools.js';
// 主控停止复用本域 handleStop 的同一条实现（门禁 → 停止 → 结果信封），见 helpers 模块头
import { stopHostedSession } from '../helpers/hostedSessionStop.js';
// 主控暂停 / 恢复：按目标 sid 取既有实例，调实例现有公开方法（内核签名不动）
import { pauseHostedSession, resumeHostedSession } from '../helpers/hostedSessionRunControl.js';

/** 本域读到的会话级运行态（`runtimeFor()` 的窄投影，只读本域需要的两个字段） */
export interface RunControlRuntime {
  /** 是否正在流式生成（thinking 态判定） */
  streaming: boolean;
  /** 本轮 AbortController（stop 的中断把手） */
  abortController?: AbortController;
}

/** 本域用到的提问协调器（停止时的「彻底放弃」走 ask 域，保证未答行与盘面同文案） */
export interface RunControlAsk {
  pendingQuestions(): unknown[];
  abandonOnStop(): Promise<boolean>;
}

/** 运行控制域的注入面（唯一构造点 = 面板字段初始化处） */
export interface ChatRunControlOpsDeps {
  /** 向 webview 投递协议消息（面板 `post` 单点） */
  post: (msg: ExtensionToWebviewMessage) => void;
  /** 推送 turn_update（骨架真源 = `turn_update.state`，暂停申请在途变化必须同步补推） */
  postTurnUpdate: () => void;
  /** 取**指定会话**的运行态（缺省由调用方传当前显示会话） */
  runtimeFor: (sessionId: string) => RunControlRuntime;
  /** 取**指定会话**的提问协调器 */
  askFor: (sessionId: string) => RunControlAsk;
  /** 取**指定会话**的实例（停止/暂停的目标；未就绪时静默返回） */
  getAgent: (sessionId: string) => Agent | undefined;
  /** 当前**显示会话**（用于把后台会话的停止副作用挡在界面外） */
  currentSessionId: () => string;
  /** 调用方是否托管（主控停止的纵深防守；归属裁决不在本域，见 helpers 模块头） */
  isManaged: (sessionId: string) => boolean;
  /**
   * 跑一轮 Agent 流（恢复复用 sendInput 的同一条 runFlow 通路）
   *
   * `sessionId` 缺省 = 当前显示会话；主控恢复等后台入口必须显式传入目标 sid，
   * 否则流状态会写到切换后的另一个会话记录上（与 `dispatchHostedInput` 同口径）。
   */
  runFlow: (
    factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>,
    sessionId?: string,
  ) => Promise<void>;
  /** 重投影待发送队列（`force` = 绕长度守卫，停止路径必须无条件推相位） */
  syncPendingQueue: (force?: boolean) => void;
  /** 丢弃排队插话的可见信号（先读后丢，由面板提供） */
  postPendingDiscarded: (items: readonly string[]) => void;
  /**
   * paused 态停止已收场后的回调（本切片：托管子会话中断通知）
   *
   * `roundId` 由本域在 `abandonOnStop()` **之前**取好——内核收场后当前轮标识可能已变，
   * 晚取会与流尾的轮 id 对不上、造成重复通知。
   *
   * ⚠️ 必须带上**被停的会话 id**：面板显示可能停在别的会话，读当前会话会把通知记到错的人头上。
   */
  onUserStopped?: (agent: Agent, roundId: string, sessionId: string) => void;
}

/** 运行控制域对外方法（与面板私有方法一一对应） */
export interface ChatRunControlOps {
  /** 停止指定会话（缺省 = 当前显示会话）；返回是否真的停到了活 */
  handleStop(sessionId?: string): Promise<boolean>;
  handlePause(): void;
  resumeInput(): Promise<void>;
  /** 主控停止入口（工具 `stop_work_session`）：与用户点停止同一条路径，只多一层调用方门禁 */
  stopHostedSession: (
    callingSessionId: string,
    targetSessionId: string,
  ) => Promise<HostedStopResult>;
  /** 主控暂停入口（工具 `pause_work_session`）：按目标 sid 取既有实例调 `requestPause` */
  pauseHostedSession: (
    callingSessionId: string,
    targetSessionId: string,
  ) => Promise<HostedPauseResult>;
  /** 主控恢复入口（工具 `resume_work_session`）：按目标 sid 取既有实例走既有续跑通路 */
  resumeHostedSession: (
    callingSessionId: string,
    targetSessionId: string,
  ) => Promise<HostedResumeResult>;
}

/**
 * 面板对外暴露的「主控运行控制」窄面（三个工具入口）
 *
 * 面板只持有这一份投影，不逐个复制字段：面板行数已贴 `max-lines` 基线，
 * 且三入口本就同源（都是 `_runOps`），拆开声明只会多出重复行。
 */
export type HostedRunControlOps = Pick<
  ChatRunControlOps,
  'stopHostedSession' | 'pauseHostedSession' | 'resumeHostedSession'
>;

/**
 * 构造运行控制域
 *
 * @param deps 面板注入的窄接口（见 {@link ChatRunControlOpsDeps}）
 */
export function createChatRunControlOps(deps: ChatRunControlOpsDeps): ChatRunControlOps {
  // 先落对象再返回：stopHostedSession 要复用同一个 handleStop（自引用只在调用期解引用，安全）
  const ops: ChatRunControlOps = {
    /**
     * 停止生成：中断指定会话的执行（暂停/恢复能力下的硬停止对齐）
     *
     * 用户点停止与主控 `stop_work_session` **走同一条路**：前者不传 sessionId（= 当前显示会话），
     * 后者传目标子会话 id。三种运行态行为：
     *   - thinking（runtime.streaming=true）→ abort() 当前流，内核在下一 await 点退出 yield aborted
     *   - paused（status=paused, runtime.streaming=false）→ **以中断收场**：`abandonOnStop`
     *     （对称语义：pause=想继续；stop=彻底放弃——用户说过的话必须留下痕迹）
     *   - done 态 → 什么也不做（返回 false）
     *
     * ⚠️ paused 分支不能只 `discardCurrentCheckpoint`（ADR-044 决策 3）：ask 挂起轮无正文
     * ⇒ 内核 `appendAssistant` 空正文守卫直接返回 ⇒ 该轮**没有任何收场调用点**。只弃检查点会
     * 留下 pending 僵尸轮，且宿主 pending 未清 ⇒ 相位恒 waiting/ask ⇒ 用户下一条输入被路由成
     * 「回答一个已死的提问」（内核内存消费、不落盘）。
     *
     * ⚠️ 后台会话（sessionId ≠ 当前显示）只执行停止本身：状态 / 提示 / 队列重投影**一律不投递**，
     * 否则会把 A 的停止画到 B 的界面上（跨会话串台）。
     *
     * @param sessionId 目标会话（缺省 = 当前显示会话）
     * @returns 是否真的停到了活（false = 目标已收场 / 无流）
     */
    async handleStop(sessionId?: string): Promise<boolean> {
      const targetId = sessionId ?? deps.currentSessionId();
      // 停止按钮只作用于目标会话：运行态与 ask 协调器都按会话取
      const runtime = deps.runtimeFor(targetId);
      const ask = deps.askFor(targetId);
      // 界面副作用只对当前显示会话发生（后台停止不重绘用户正在看的页面）
      const visible = targetId === deps.currentSessionId();
      // thinking 态：已有路径
      if (runtime.streaming && runtime.abortController) {
        runtime.abortController.abort();
        return true;
      }
      // paused 态：收场 + 彻底放弃暂停检查点（对称 pause 语义）
      const agent = deps.getAgent(targetId);
      if (agent?.sessionManager?.status === 'paused') {
        // 先读后弃：abandonTurn 协同清理排队插话（内核 agent.ts 单点），
        // 被弃条目 = 丢弃（蒸发不落盘）→ 必须发丢弃信号，否则 webview diff 误判「消费」误上屏
        const before = agent.getPendingInterjections?.() ?? [];
        const hadAsk = ask.pendingQuestions().length > 0;
        // 轮 id 必须在 abandon 之前取（收场后当前轮标识可能已变，见 onUserStopped 注释）。
        // 这是**实时读实例**，不是清单快照——避免拿过期轮去停一个已经收场的轮。
        const roundId = agent.currentRoundId();
        // ask 域先清宿主镜像 + 逐条透出「未回答」行（与盘面同文案、同题身份），再走内核收场
        const checkpointDiscarded = await ask.abandonOnStop();
        if (visible) deps.post({ type: 'status', state: 'done' });
        if (checkpointDiscarded && visible) {
          // 有提问时已由 ask 域给出「N 个提问未回答」，此处只补纯暂停态的旧提示
          if (!hadAsk) {
            deps.post({
              type: 'notice',
              level: 'info',
              message: vscode.l10n.t('Stopped; the pause checkpoint has been cleared'),
            });
          }
          if (before.length > 0) {
            deps.postPendingDiscarded([...before]);
          }
        }
        // 相位无条件重投影（force 绕长度守卫）：① 排在丢弃信号**之后**——FIFO 契约要求
        // 「信号先于新快照」；② 无条件——队列本就为空或未弃检查点时长度不变，守卫会吞掉这一帧，
        // 而 `_turnState` 是快照、不重算就停在 waiting/ask ⇒ 下一条输入被当成「回答死提问」
        // 由内核内存消费、不落盘（用户输入凭空蒸发）。
        if (visible) deps.syncPendingQueue(true);
        // 收场完成后再通知（失败/异常由调用方自己兜，本域不吞）：此时盘上是 interrupted；
        // 通知对象是**被停的那个会话**（创建者通知按会话归属，不能读当前显示会话）
        deps.onUserStopped?.(agent, roundId, targetId);
        return true;
      }
      return false;
    },

    /**
     * 暂停按钮行为 toggle（宿主层裁决，UI 纯投影）
     *
     * UI 只负责显示 pause（‖）图标，不维护任何本地 toggle 状态——图标永远不变，
     * hidden 由会话状态机驱动（thinking 显示，paused/done 隐藏）。
     * 点击后的行为裁决完全在宿主层，点击即反馈：
     *   - agent.isPausePending()=true → cancelPauseRequest()（反悔）+ 告知已取消
     *   - 否则 requestPause()：
     *      返回 true（运行中入队）→ 告知「暂停申请已发送，将在当前步骤完成后暂停」
     *      返回 false（空闲守卫作废 / 幂等 / paused、error）→ 告知「任务已结束，申请未生效」
     * 不再对 requestPause 返回值保持沉默——「有按钮就有反馈」。
     */
    handlePause(): void {
      // 暂停 / 恢复只作用于当前显示会话（与用户点击的按钮一致）
      const agent = deps.getAgent(deps.currentSessionId());
      if (!agent) return;
      if (agent.isPausePending()) {
        agent.cancelPauseRequest();
        // 骨架真源 = turn_update.state——申请在途变化处同步补推
        //（deriveTurnState：pausePending=false → running），否则申请/取消无按钮反馈
        deps.postTurnUpdate();
        // 点击即反馈：取消申请也要明确告知（「有按钮就有反馈」）
        deps.post({
          type: 'notice',
          level: 'info',
          message: vscode.l10n.t('Pause request canceled; the run continues'),
        });
        return;
      }
      const ok = agent.requestPause('user-pause', 'user');
      if (ok) {
        // 申请在途同步补推 turn_update（deriveTurnState → waiting{pausePending}，
        // 发送按钮随之切「停止生成」保持、暂停按钮切可反悔「继续 ▶」）
        // 点击即反馈：申请已入队，step 边界生效（用户知情，不「点了没反应」）
        deps.postTurnUpdate();
        deps.post({
          type: 'notice',
          level: 'info',
          message: vscode.l10n.t('Pause requested; it takes effect after the current step'),
        });
      } else {
        // 作废路径：空闲守卫（任务已结束）/ 幂等 / paused、error 态——统一明确告知
        // （空闲不翻状态机，任务结束的暂停申请直接作废）
        // 作废同样补推 turn_update（骨架保持运行中，按钮不动）
        deps.postTurnUpdate();
        deps.post({
          type: 'notice',
          level: 'info',
          message: vscode.l10n.t('The current task has ended; the pause request had no effect'),
        });
      }
    },

    /**
     * resume 意图：从暂停状态恢复执行
     *
     * 复用 runFlow + agent.resumeExecution 路径，与对主动提问的回答同构。
     * 无暂停会话时内核会阻断，宿主捕获后提示用户。
     * 守卫（Agent 就绪 / 会话存在）与错位拦截收归 `handleInput` 相位路由，
     * 此处仅保证相位为 waiting/pause（路由层已校验）。
     */
    async resumeInput(): Promise<void> {
      // 恢复只作用于当前显示会话（handleInput 守卫保证非空）
      const agent = deps.getAgent(deps.currentSessionId());
      try {
        await deps.runFlow((signal) => agent!.resumeExecution(undefined, signal));
      } catch (err) {
        deps.post({
          type: 'notice',
          level: 'error',
          message: toNoticeText(err),
        });
      }
    },

    /**
     * 主控停止：门禁 → 复用 `handleStop` → 结果信封（实现与文案见 helpers/hostedSessionStop.ts）
     *
     * 停止动作本身与用户点停止**同一条实现**，本处只补「谁能停」的调用方门禁；
     * 目标归属（只能停自己开的活）由工具层按创建者账本 + 历史判，这里不重判（见模块头）。
     */
    stopHostedSession: (callingSessionId, targetSessionId) =>
      stopHostedSession(
        { isManaged: deps.isManaged, handleStop: (id) => ops.handleStop(id) },
        callingSessionId,
        targetSessionId,
      ),

    /**
     * 主控暂停：门禁 → 按目标 sid 取既有实例 → 调无参 `requestPause` → 结果信封
     *
     * 与用户暂停（`handlePause`）共用同一个内核方法，但**不做 toggle**：
     * 代理重复调用只应得到「已暂停」的幂等回执，绝不能把暂停反悔成继续。
     */
    pauseHostedSession: (callingSessionId, targetSessionId) =>
      pauseHostedSession(
        {
          isManaged: deps.isManaged,
          getAgent: deps.getAgent,
          hasPendingQuestion: (id) => deps.askFor(id).pendingQuestions().length > 0,
          currentSessionId: deps.currentSessionId,
          postTurnUpdate: deps.postTurnUpdate,
        },
        callingSessionId,
        targetSessionId,
      ),

    /**
     * 主控恢复：门禁 → 按目标 sid 取既有实例 → 复核 paused → 走既有 runFlow 续跑
     *
     * 等用户回答的暂停不恢复（代理不得代答）；这不是猜测，是读实例态 + 提问队列后的如实拒绝。
     */
    resumeHostedSession: (callingSessionId, targetSessionId) =>
      resumeHostedSession(
        {
          isManaged: deps.isManaged,
          getAgent: deps.getAgent,
          hasPendingQuestion: (id) => deps.askFor(id).pendingQuestions().length > 0,
          currentSessionId: deps.currentSessionId,
          postTurnUpdate: deps.postTurnUpdate,
          // 复用既有 runFlow 通路并显式带目标 sid；void 不等待——工具要的是「已启动」
          runResume: (sessionId, agent) =>
            void deps.runFlow((signal) => agent.resumeExecution(undefined, signal), sessionId),
        },
        callingSessionId,
        targetSessionId,
      ),
  };
  return ops;
}
