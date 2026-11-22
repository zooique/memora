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
import type { Agent, AgentChunk, ProcessEvent } from '@zooique/memora';
import { toNoticeText } from '../../extension/host/noticeText.js';
import type { ExtensionToWebviewMessage } from '../../shared/protocol.js';
import {
  CREATE_SESSION_TOOL_NAME,
  INTERNAL_SEED_SENDER,
  SEND_TO_SESSION_TOOL_NAME,
} from '../../shared/constants.js';
import type { HostedStopResult } from '../../extension/host/workSessionTools.js';
import type {
  HostedPauseResult,
  HostedResumeResult,
} from '../../extension/host/workSessionTools.js';
// 主控停止复用本域 handleStop 的同一条实现（门禁 → 停止 → 结果信封），见 helpers 模块头
import { stopHostedSession } from '../helpers/hostedSessionStop.js';
// 主控暂停 / 恢复：按目标 sid 取既有实例，调实例现有公开方法（内核签名不动）
import { pauseHostedSession, resumeHostedSession } from '../helpers/hostedSessionRunControl.js';
// 本轮运行时种子（开轮上屏素材；单一类型源在会话级运行态模块）
import type { FlowSeed } from '../helpers/sessionRuntime.js';
// 完成门判据（宿主侧，与凭证共用同一回执真源）；本文件只做门控与起轮
import {
  shouldNudgeDispatchRepair,
  type DispatchRepairInput,
} from '../helpers/dispatchRepairGate.js';
// 判据输入的事件合并单点（与 step 检查点 / 流尾 / live 重放同一 seq 幂等语义）
import { mergeProcessEvents } from '../helpers/processEventMerge.js';
// 唤醒档位：由通知器声明「这次是哪一档事实」，本域只按档位给种子（档位不散、文案不散）
import type { WakeKind } from '../helpers/hostedSessionNotice.js';

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
  /** 向 webview 投递协议消息（面板 `post` 单点；带 `sessionId` 时按该会话路由到绑定它的视图） */
  post: (msg: ExtensionToWebviewMessage, sessionId?: string) => void;
  /** 推送 turn_update（骨架真源 = `turn_update.state`，暂停申请在途变化必须同步补推） */
  postTurnUpdate: (sessionId?: string) => void;
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
    seed?: FlowSeed,
  ) => Promise<void>;
  /** 重投影待发送队列（`force` = 绕长度守卫，停止路径必须无条件推相位） */
  syncPendingQueue: (force?: boolean) => void;
  /** 丢弃排队插话的可见信号（先读后丢，由面板提供；带 `sessionId` 时投给该会话的视图） */
  postPendingDiscarded: (items: readonly string[], sessionId?: string) => void;
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
  handlePause(sessionId?: string): void;
  resumeInput(sessionId?: string): Promise<void>;
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
  /** 某会话此刻是否空闲（不在跑流 / 没有待答提问 / 没有暂停挂起）——落定汇报的「不打断」判据 */
  isSessionIdle(sessionId: string): boolean;
  /**
   * 托管事实「主动起一轮」：替接收方开一轮处置（落定汇报 / 待拍板代答 / 交回裁决）
   *
   * 与托管派发同一条 `runFlow` + `chat(origin='hosted')` 通路，不新造通道、不新造面板；
   * 事实本体由通知器压入接收方的系统事件队列，本方法只负责「起一轮」并把**该档的处置口径**
   * 写进种子。档位由通知器给（它知道投的是哪一档），文案只在本处持有——第四档 `pending`
   * = 待办合并浮现（可跨档），种子据实说「若干条、可能已被取代」。
   *
   * @param creator 接收方（托管主控）会话 id
   * @param kind 本次唤醒的事实档位
   * @returns 是否真的起了一轮（false = 实例未就绪 / 不空闲 / 未开跑）
   */
  wakeNoticeTurn(creator: string, kind: WakeKind): boolean;

  /**
   * 完成门「补派检查」：轮末声称已派但无受理回执 ⇒ 起一轮内部种子
   *
   * 只提醒不代发：真正的派发仍必须在补派轮里由模型调用工具完成；内部种子轮不再触发
   * （判据侧按 `isInternalSeedSender` 排除），防无限自唤。
   *
   * @param sessionId 源会话（必须托管且空闲）
   * @param sourceRoundId 触发检查的源轮 id（写进种子，供模型回看）
   * @returns 是否真的起了一轮
   */
  wakeDispatchRepair(sessionId: string, sourceRoundId: string): boolean;

  /**
   * 完成门入口：判据成立就**延后一拍**起一轮补派检查
   *
   * 为什么延后（重入隔离，不是等 streaming 清空）：调用点在 `consumeFlow` 的正常收场分支，
   * 此刻 `runtime.streaming` 已在 finally 里清掉；但本函数起的补派轮会走同一个 `runFlow`，
   * 若同步调用，新流的开场（置 streaming / 挂摘要监听）会与旧流余下的收场逻辑
   * （摘要解锁 / 派发租约归还）交错。延后一拍 = 等本流彻底收场后再起新流。
   * 只做三件事：托管门控 → 判据 → 调 `wakeDispatchRepair`；不复制判据、不代发。
   *
   * @param sessionId 源会话
   * @param round 源轮（只读；缺省直接返回；判据见 `shouldNudgeDispatchRepair`）
   * @param sourceRoundId 源轮 id（缺省 / 空串直接返回）
   * @param liveRound 本轮内存轮快照（只读，只取 processEvents 与盘面按 seq 合并后喂判据，防 resume 续跑丢前段回执）
   */
  maybeWakeDispatchRepair(
    sessionId: string,
    round: DispatchRepairInput | null | undefined,
    sourceRoundId: string | undefined,
    liveRound?: { readonly processEvents?: readonly ProcessEvent[] } | undefined,
  ): void;
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
     * ⚠️ 后台会话（sessionId ≠ 当前显示）的界面副作用**按目标会话投递**（有视图绑它才到屏），
     * 单份长度缓存（syncPendingQueue）仍只服务当前显示会话——绝不把 A 的停止画到 B 的界面上。
     *
     * @param sessionId 目标会话（缺省 = 当前显示会话）
     * @returns 是否真的停到了活（false = 目标已收场 / 无流）
     */
    async handleStop(sessionId?: string): Promise<boolean> {
      const targetId = sessionId ?? deps.currentSessionId();
      // 停止按钮只作用于目标会话：运行态与 ask 协调器都按会话取
      const runtime = deps.runtimeFor(targetId);
      const ask = deps.askFor(targetId);
      // 界面副作用按目标会话投递；单份长度缓存只对当前显示会话刷新（见下）
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
        if (visible) {
          // 轮级收场必发：paused 态没有活跃流，runFlow 收尾不会发 interrupted——漏了这一条，
          // ask 挂起前建的续接骨架（D3 既定形态）就永不收场，留下带角色名头的「等待输入」
          // 空壳（2026-11-22 真机「一轮里两个角色名」正是此因）。顺序与 thinking 态停止同构：
          // 先轮级收场（finalize + 底栏「用户中断」），再切骨架显隐。
          deps.post({ type: 'interrupted', roundId }, targetId);
          deps.post({ type: 'status', state: 'done' }, targetId);
        }
        if (checkpointDiscarded) {
          // 有提问时已由 ask 域给出「N 个提问未回答」，此处只补纯暂停态的旧提示
          if (!hadAsk) {
            deps.post(
              {
                type: 'notice',
                level: 'info',
                message: vscode.l10n.t('Stopped; the pause checkpoint has been cleared'),
              },
              targetId,
            );
          }
          if (before.length > 0) {
            deps.postPendingDiscarded([...before], targetId);
          }
        }
        // 相位无条件重投影（force 绕长度守卫）：① 排在丢弃信号**之后**——FIFO 契约要求
        // 「信号先于新快照」；② 无条件——队列本就为空或未弃检查点时长度不变，守卫会吞掉这一帧，
        // 而 `_turnState` 是快照、不重算就停在 waiting/ask ⇒ 下一条输入被当成「回答死提问」
        // 由内核内存消费、不落盘（用户输入凭空蒸发）。
        // 宿主长度缓存只有侧栏一份：显示会话走 syncPendingQueue，后台（助手窗）走按会话投影。
        if (visible) deps.syncPendingQueue(true);
        else deps.postTurnUpdate(targetId);
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
    handlePause(sessionId?: string): void {
      // 暂停 / 恢复作用于目标会话（缺省 = 当前显示会话；助手窗显式传助手会话）
      const targetId = sessionId ?? deps.currentSessionId();
      const agent = deps.getAgent(targetId);
      if (!agent) return;
      if (agent.isPausePending()) {
        agent.cancelPauseRequest();
        // 骨架真源 = turn_update.state——申请在途变化处同步补推
        //（deriveTurnState：pausePending=false → running），否则申请/取消无按钮反馈
        deps.postTurnUpdate(targetId);
        // 点击即反馈：取消申请也要明确告知（「有按钮就有反馈」）
        deps.post(
          {
            type: 'notice',
            level: 'info',
            message: vscode.l10n.t('Pause request canceled; the run continues'),
          },
          targetId,
        );
        return;
      }
      const ok = agent.requestPause('user-pause', 'user');
      if (ok) {
        // 申请在途同步补推 turn_update（deriveTurnState → waiting{pausePending}，
        // 发送按钮随之切「停止生成」保持、暂停按钮切可反悔「继续 ▶」）
        // 点击即反馈：申请已入队，step 边界生效（用户知情，不「点了没反应」）
        deps.postTurnUpdate(targetId);
        deps.post(
          {
            type: 'notice',
            level: 'info',
            message: vscode.l10n.t('Pause requested; it takes effect after the current step'),
          },
          targetId,
        );
      } else {
        // 作废路径：空闲守卫（任务已结束）/ 幂等 / paused、error 态——统一明确告知
        // （空闲不翻状态机，任务结束的暂停申请直接作废）
        // 作废同样补推 turn_update（骨架保持运行中，按钮不动）
        deps.postTurnUpdate(targetId);
        deps.post(
          {
            type: 'notice',
            level: 'info',
            message: vscode.l10n.t('The current task has ended; the pause request had no effect'),
          },
          targetId,
        );
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
    async resumeInput(sessionId?: string): Promise<void> {
      // 恢复作用于目标会话（缺省 = 当前显示会话；handleInput 守卫保证非空）
      const targetId = sessionId ?? deps.currentSessionId();
      const agent = deps.getAgent(targetId);
      try {
        await deps.runFlow((signal) => agent!.resumeExecution(undefined, signal), targetId);
      } catch (err) {
        deps.post(
          {
            type: 'notice',
            level: 'error',
            message: toNoticeText(err),
          },
          targetId,
        );
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

    /**
     * 某会话此刻是否空闲（落定汇报的「不打断」判据）
     *
     * 三档都算「不空」：正在跑流（抢跑 = 打断）、挂着待答提问（用户正要答）、
     * 暂停可续跑（等用户决定续不续）。宁晚不打断：不空时通知器把落定压进内存待办，
     * 等本轮收场后再浮现。
     */
    isSessionIdle(sessionId: string): boolean {
      if (deps.runtimeFor(sessionId).streaming) return false;
      if (deps.askFor(sessionId).pendingQuestions().length > 0) return false;
      const agent = deps.getAgent(sessionId);
      if (agent?.sessionManager?.status === 'paused' || agent?.isPausePending()) return false;
      return true;
    },

    /**
     * 托管事实「主动起一轮」：按档位写处置口径（第八切片 HOSTED-NOTICE-KIND-1）
     *
     * 走既有托管通道（`chat(origin='hosted')` + `runFlow`），不新造流、不新造面板：
     * 事实本体已由通知器压入接收方的系统事件队列（首个 step 边界注入），本方法只管种子。
     * 种子气泡与普通托管输入同型：role 仍是 `user`，只盖来源戳 `origin='hosted'`
     * （界面据此标「由助手发送」）；不另造角色。
     *
     * 为什么必须分档（真机证据）：三条通道共用一句「有一条托管会话刚落定」时，
     * 「子会话在等你拍板」那次唤醒也被通知「已落定」，模型于是先汇报交付、顺手代答；
     * `handback` 被同样错告知，交回裁决变成交付汇报。档位是通知器的事实，口径是本域的指令
     * —— 两处各持一半，档位不散、文案不散。
     */
    wakeNoticeTurn(creator: string, kind: WakeKind): boolean {
      // 四档口径各写一段，不共用首句：首句就是模型据以定性的那句
      const seeds: Record<WakeKind, string> = {
        // 落定：**讲交付物**（通知里带成功轮的交付摘录）→ 结果 → 下一步或需用户决定。
        // 不许答「哪条会话 / round / 成功」这类元信息：那些通知里已有，答它们等于零信息。
        settlement: vscode.l10n.t(
          'A managed session has just settled. The settlement notice in context includes an excerpt of what it actually delivered. Report what it delivered (quote the excerpt or summarize its key points — do not answer with which session, round id, or "success"), then one sentence on the outcome, and the next step or what you need me to decide.',
        ),
        // 待拍板：首句必须否掉「已落定」，并把处置优先级写成可执行的一条
        'needs-answer': vscode.l10n.t(
          'A managed session is waiting for your decision — it has NOT settled. The pending question and its options are in the fact notice above. Decide it and unblock the work: pick an option with a stated reason whenever the question and the context allow it; only pass it back to me when you genuinely cannot judge; never make an irreversible decision for me. Close with one sentence on what you decided.',
        ),
        // 交回：事实是「超界」，动作是三选一，不是汇报交付
        handback: vscode.l10n.t(
          'A managed session has handed the work back to you — it went beyond the assignment you gave it. The handback notice in context carries that original boundary. Decide which of the three you want (start a new assignment / merge it into the work you already have / hand it to me) and say why.',
        ),
        // 合并浮现：可能跨档，据实说「若干条 + 时间 + 可能已被取代」，不许假装单一档
        pending: vscode.l10n.t(
          'Several managed-session facts were queued while you were busy; they are now in context, oldest first. Each line starts with how long ago it was produced — a later line may already have superseded an earlier one, so read the age before acting and never treat an old settlement as the current state of that session. Handle them in the order that makes sense, then give me one short summary.',
        ),
      };
      // seedId 带档位：重放 / 排查时一眼看出这一轮是被哪一档唤醒的（不再一律叫 settlement）
      return startInternalSeedTurn(
        creator,
        `live-notice-${kind}-${new Date().toISOString()}`,
        seeds[kind],
      );
    },

    wakeDispatchRepair(sessionId: string, sourceRoundId: string): boolean {
      // 只在托管会话里补派：与提示的助手形态同域，用户自建会话不打扰
      if (!deps.isManaged(sessionId)) return false;
      // 种子只陈述系统见证的事实（本轮没有受理回执），不复述模型上轮的话术——
      // 「你声称已派」会给模型一个「我确实说过」的记忆锚，反过来加固撒谎的形态。
      // 工具名插值真源（与回执判据 dispatchedSidTextsFromEvents 同源），不写死字面量
      const seedText = [
        `Round ${sourceRoundId} ended without an accepted session-dispatch receipt.`,
        'Do not treat the previous answer as evidence. If what I asked still needs an action,',
        `actually call ${SEND_TO_SESSION_TOOL_NAME} (or ${CREATE_SESSION_TOOL_NAME}) with the right arguments;`,
        'otherwise say plainly that no action was taken, and why.',
      ].join(' ');
      return startInternalSeedTurn(sessionId, `live-dispatch-repair-${sourceRoundId}`, seedText);
    },

    maybeWakeDispatchRepair(sessionId, round, sourceRoundId, liveRound): void {
      if (!round || !sourceRoundId) return;
      if (!deps.isManaged(sessionId)) return;
      // 判据输入 = 盘面快照 ∪ 本轮内存事件（mergeProcessEvents 单点、按 seq 幂等）：
      // 盘面快照在流尾 checkpoint 前读，末段回执可能只在内存；resume 续跑流内存段又只含
      // 续跑部分——单取任一方都会漏判回执而误起补派轮。字段其余部分不变（只读投影）。
      const judged: DispatchRepairInput = {
        ...round,
        processEvents: mergeProcessEvents(round.processEvents ?? [], [
          ...(liveRound?.processEvents ?? []),
        ]),
      };
      if (!shouldNudgeDispatchRepair(judged)) return;
      // 延后一拍 = 重入隔离：等本流 runFlow 收场（摘要解锁 / 租约归还）跑完再起补派轮，
      // 否则新流开场与本流收尾交错（streaming 置位 / 双重摘要监听）。
      setTimeout(() => {
        ops.wakeDispatchRepair(sessionId, sourceRoundId);
      }, 0);
    },
  };

  /**
   * 起一轮内部种子（落定汇报 / 完成门补派检查共用）
   *
   * 与托管派发同一条 `runFlow` + `chat(origin='hosted')` 通路：不新造流、不新造面板。
   * 两个写端同值：seed.userMessage.name 与 chat opts.senderName 都标 `INTERNAL_SEED_SENDER`，
   * 内核据此落 `RoundMessage.name`，重放跳过 user 气泡（HOSTED-INTERNAL-SEED-1）。
   *
   * @param sessionId 目标会话（必须空闲）
   * @param seedId 种子消息 id（实时投影 / 幂等定位共用）
   * @param seedText 进模型上下文的种子正文
   * @returns 是否真的起了一轮
   */
  function startInternalSeedTurn(sessionId: string, seedId: string, seedText: string): boolean {
    const agent = deps.getAgent(sessionId);
    if (!agent || !ops.isSessionIdle(sessionId)) return false;
    const seed: FlowSeed = {
      userMessage: {
        id: seedId,
        role: 'user',
        content: seedText,
        timestamp: new Date().toISOString(),
        // HOSTED-INTERNAL-SEED-1：显式标记内部种子，重放跳过 user 气泡；
        // 真正用户托管输入的 name = HOSTED_SENDER_NAME，不撞车。
        name: INTERNAL_SEED_SENDER,
      },
      origin: 'hosted',
    };
    const start = (): void => {
      void deps.runFlow(
        (signal) =>
          agent.chat(seedText, signal, undefined, {
            origin: 'hosted',
            senderName: INTERNAL_SEED_SENDER,
          }),
        sessionId,
        seed,
      );
    };
    // 与 dispatchHostedInput 同一对齐判据：内核当前会话错位会把这一轮写进别的会话
    const manager = agent.sessionManager;
    const info = manager?.getCurrentSessionInfo();
    if (manager && info && `${info.date}-${info.session}` !== sessionId) {
      void manager.switchToSession(sessionId).then(start, () => undefined);
      return true;
    }
    start();
    return true;
  }
  return ops;
}
