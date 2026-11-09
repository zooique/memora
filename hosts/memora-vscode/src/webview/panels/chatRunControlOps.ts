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
  /** 取当前**显示会话**的运行态 */
  runtimeFor: () => RunControlRuntime;
  /** 取当前**显示会话**的提问协调器 */
  askFor: () => RunControlAsk;
  /** 当前显示会话实例（停止/暂停的目标；未就绪时静默返回） */
  getAgent: () => Agent | undefined;
  /** 跑一轮 Agent 流（恢复复用 sendInput 的同一条 runFlow 通路） */
  runFlow: (
    factory: (signal: AbortSignal) => AsyncGenerator<AgentChunk, void, unknown>,
  ) => Promise<void>;
  /** 重投影待发送队列（`force` = 绕长度守卫，停止路径必须无条件推相位） */
  syncPendingQueue: (force?: boolean) => void;
  /** 丢弃排队插话的可见信号（先读后丢，由面板提供） */
  postPendingDiscarded: (items: readonly string[]) => void;
}

/** 运行控制域对外方法（与面板私有方法一一对应） */
export interface ChatRunControlOps {
  handleStop(): Promise<void>;
  handlePause(): void;
  resumeInput(): Promise<void>;
}

/**
 * 构造运行控制域
 *
 * @param deps 面板注入的窄接口（见 {@link ChatRunControlOpsDeps}）
 */
export function createChatRunControlOps(deps: ChatRunControlOpsDeps): ChatRunControlOps {
  return {
    /**
     * 停止生成：用户主动中断执行（暂停/恢复能力下的硬停止对齐）
     *
     * 三种运行态行为：
     *   - thinking（runtime.streaming=true）→ abort() 当前流，内核在下一 await 点退出 yield aborted
     *   - paused（status=paused, runtime.streaming=false）→ **以中断收场**：`abandonOnStop`
     *     （对称语义：pause=想继续；stop=彻底放弃——用户说过的话必须留下痕迹）
     *   - done 态无停止按钮（UI 隐藏）。
     *
     * ⚠️ paused 分支不能只 `discardCurrentCheckpoint`（ADR-044 决策 3）：ask 挂起轮无正文
     * ⇒ 内核 `appendAssistant` 空正文守卫直接返回 ⇒ 该轮**没有任何收场调用点**。只弃检查点会
     * 留下 pending 僵尸轮，且宿主 pending 未清 ⇒ 相位恒 waiting/ask ⇒ 用户下一条输入被路由成
     * 「回答一个已死的提问」（内核内存消费、不落盘）。
     */
    async handleStop(): Promise<void> {
      // 停止按钮只作用于当前可见会话：取当前会话的运行态与 ask 协调器
      const runtime = deps.runtimeFor();
      const ask = deps.askFor();
      // thinking 态：已有路径
      if (runtime.streaming && runtime.abortController) {
        runtime.abortController.abort();
        return;
      }
      // paused 态：收场 + 彻底放弃暂停检查点（对称 pause 语义）
      const agent = deps.getAgent();
      if (agent?.sessionManager?.status === 'paused') {
        // 先读后弃：abandonTurn 协同清理排队插话（内核 agent.ts 单点），
        // 被弃条目 = 丢弃（蒸发不落盘）→ 必须发丢弃信号，否则 webview diff 误判「消费」误上屏
        const before = agent.getPendingInterjections?.() ?? [];
        const hadAsk = ask.pendingQuestions().length > 0;
        // ask 域先清宿主镜像 + 逐条透出「未回答」行（与盘面同文案、同题身份），再走内核收场
        const checkpointDiscarded = await ask.abandonOnStop();
        deps.post({ type: 'status', state: 'done' });
        if (checkpointDiscarded) {
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
        deps.syncPendingQueue(true);
      }
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
      const agent = deps.getAgent();
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
      const agent = deps.getAgent(); // handleInput 守卫保证非空
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
  };
}
