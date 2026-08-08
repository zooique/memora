/**
 * 对话相关 IPC 处理器（薄层）
 *
 * 职责：
 *   1. 注册 USER_INPUT 通道（委托到 chatStreamHandler.handleUserInput）
 *   2. 注册 CHAT_ABORT 通道（AbortController + reason 携带中断原因）
 *   3. 注册会话状态管理通道（SESSION_PAUSE / SESSION_RESUME / SESSION_RECOVER / 检查点管理）
 *
 * 本文件仅负责 IPC 通道注册，流式输出业务逻辑由 chatStreamHandler.ts 承担。
 *
 * 流式输出架构：
 *   主进程通过 agent.processEvent() 处理结构化 SessionEvent，通过专用 IPC 通道发送 chunk，
 *   不走 IInteraction（IInteraction 仅负责非流式输出）。
 */

import { ipcMain } from 'electron';
import { logger, AGENT_EVENTS } from 'memora';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from './channels.js';
import type { IpcContext } from './types.js';
import { requireAgent } from './types.js';
import { handleUserInput, handleResume } from './chatStreamHandler.js';
import { isValidContent } from './inputValidation.js';
import type { SessionCheckpoint, SessionEvent, PauseMeta } from 'memora';

/**
 * 澄清暂停超时自动续跑（Finding A）
 *
 * 仅 agent 主动询问（needClarify）触发计时；用户手动暂停走 SESSION_PAUSE，不发 needClarify，天然豁免。
 * 超时后自动构造「择优决策」回答注入会话：内核 clarify→chat 转换 + Composer 补全链下，
 * role/standard/resource 走 P3 兜底、task 延续 currentGoal 或取回答文本，回答非空即不 re-pause，
 * agent 直接收敛本轮，不再永久卡在暂停。
 */
export const CLARIFY_AUTO_RESOLVE_MS = 5 * 60 * 1000;
let clarifyTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * 注册对话相关 IPC 处理器
 *
 * @param ctx IPC 上下文
 */
export function registerChatHandlers(ctx: IpcContext): void {
  /**
   * 用户输入处理 — 委托到 chatStreamHandler.handleUserInput
   *
   * 流式输出架构：主进程通过 agent.processEvent() 处理结构化 SessionEvent，通过专用 IPC 通道发送 chunk，
   */
  ipcMain.on(IPC_CHANNELS.USER_INPUT, (_event, text: string) => {
    // 校验用户输入长度，防止超大文本触发内存/CPU 耗尽
    if (!isValidContent(text)) {
      logger.warn({ textLen: text?.length }, '用户输入校验失败，已拒绝');
      return;
    }
    void handleUserInput(text, ctx);
  });

  /** 中断当前对话 */
  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT, async () => {
    // 使用 AbortController.reason 携带中断原因
    const ctrl = ctx.getAbortController();
    if (ctrl) {
      // 使用 DOMException 模拟标准 AbortController.abort(reason) 行为
      // reason='user' 标识用户主动中断，catch 块据此发送系统消息
      ctrl.abort(new DOMException('用户手动停止', 'AbortError'));
      // 不在此处 setAbortController(null)：catch 块需通过 ctrl.signal.reason 判断是否用户主动中断。
      // 清理统一由 finally 块执行。
    }
    return { aborted: true };
  });

  /**
   * 强制释放对话锁（应急恢复入口）
   *
   * 使用场景：LLM Provider 网络挂起但未触发 60s 无进展超时，用户已确认对话卡死。
   * 与 CHAT_ABORT 的区别：abort 只中断流（依赖 generator 响应 signal），
   * 而强制释放直接清理内核锁 + AbortController，让用户能立即发起新对话。
   *
   * 安全机制（内核 agent.ts:558 forceReleaseChatLock）：
   *   - 递增 _chatLockToken 让原 chat() 的 finally 块跳过清理（避免误清新调用者资源）
   *   - abort chatAbortController（响应 signal 的 await 点会 throw 退出）
   *   - 幂等：_chatBusy 已 false 时 no-op
   *
   * @returns released 表示是否真的释放了锁（true=之前有锁，false=本来就没锁）
   */
  ipcMain.handle(IPC_CHANNELS.CHAT_FORCE_RELEASE_LOCK, async () => {
    // 通过 AbortController 是否存在判断当前是否有进行中的对话
    // （agent._chatBusy 是私有字段，宿主无法直接读取）
    const hadActiveChat = ctx.getAbortController() !== null;
    // 调用内核强制释放（幂等，无锁时 no-op）
    // Agent 为 null 时静默跳过：此时无锁可释放，AbortController 仍需清理
    ctx.getAgent()?.forceReleaseChatLock();
    // 清理宿主侧的 AbortController 引用（与 chatStreamHandler finally 块职责对齐）
    ctx.setAbortController(null);
    return { released: hadActiveChat };
  });

  // ─── 会话状态管理（不中断工作模型） ─────────────────────

  /** 暂停会话（不中断工作模型 v2.1：软暂停 = 内核在 loop 边界挂起，保留 messages 可续跑） */
  ipcMain.handle(IPC_CHANNELS.SESSION_PAUSE, async (_event, reason: string) => {
    const agent = requireAgent(ctx);
    // 软暂停：请求内核在 loop 下一迭代边界挂起生成器（不 abort，保留 this.messages）。
    // 状态机翻 PAUSED 延后到 loop 边界真正挂起时（内核事实驱动，修 D1），
    // 由下方 agent.on(AGENT_EVENTS.sessionPaused) 监听统一广播 SESSION_STATUS_CHANGED{paused}（与 resume 同构）。
    // 区别于硬停止（CHAT_ABORT 的 signal.abort）：硬停止杀生成器不可续跑，软暂停可经 resumeExecution 续跑。
    agent.requestPause(reason ?? '用户主动暂停', 'user');
    return { paused: true, resumable: agent.canContinueWithoutInput() };
  });

  /** 恢复会话（软暂停续跑：驱动内核 loop.continueAfterPause，流式输出经 chatStreamHandler.handleResume 转发） */
  ipcMain.handle(IPC_CHANNELS.SESSION_RESUME, async (_event, input?: string) => {
    // 状态广播统一由下方内核 sessionResumed 事件监听转发（Finding B），此处不再手动 emit，避免双发。
    // resumeExecution 内部翻 RUNNING 并驱动 loop 续跑；空 input 续跑原路径，有 input 注入修正后续轮。
    // agent 经 ctx 由 handleResume 内部获取，本 handler 仅做 IPC 薄层转发。
    void handleResume(input, ctx);
    return { resumed: true };
  });

  /** 从异常恢复会话 */
  ipcMain.handle(IPC_CHANNELS.SESSION_RECOVER, async () => {
    const agent = requireAgent(ctx);
    const result = agent.recover();
    // 广播状态变更到渲染进程
    if (result) {
      const fullWindow = ctx.windowManager.getFullWindow();
      if (fullWindow && !fullWindow.isDestroyed()) {
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SESSION_STATUS_CHANGED, {
          status: 'running',
          resumable: agent.canContinueWithoutInput(),
        });
      }
    }
    return { recovered: result };
  });

  /** 创建会话检查点 */
  ipcMain.handle(IPC_CHANNELS.CREATE_CHECKPOINT, async (_event, mainGoal?: string) => {
    const agent = requireAgent(ctx);
    const checkpoint = agent.createCheckpoint(mainGoal);
    return { checkpoint };
  });

  /** 获取当前检查点 */
  ipcMain.handle(IPC_CHANNELS.GET_CHECKPOINT, async () => {
    const agent = requireAgent(ctx);
    const checkpoint = agent.getCheckpoint();
    return { checkpoint };
  });

  /** 从检查点恢复会话 */
  ipcMain.handle(IPC_CHANNELS.RESTORE_CHECKPOINT, async (_event, checkpoint: SessionCheckpoint) => {
    const agent = requireAgent(ctx);
    const messageCount = await agent.restoreFromCheckpoint(checkpoint);
    return { restored: true, messageCount };
  });

  // ─── P1-6: 暂停模型 IPC ──────────────────────────────────

  /** 取消待处理的暂停请求（requesting 态 → 取消，loop 继续运行） */
  ipcMain.handle(IPC_CHANNELS.SESSION_CANCEL_PAUSE, async () => {
    const agent = requireAgent(ctx);
    agent.cancelPauseRequest();
    // 广播状态（取消暂停后状态回 running）
    const fullWindow = ctx.windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SESSION_STATUS_CHANGED, {
        status: 'running',
        resumable: agent.canContinueWithoutInput(),
      });
    }
    return { canceled: true };
  });

  /** 放弃暂停（清暂停状态+暂停点，会话回 idle） */
  ipcMain.handle(IPC_CHANNELS.SESSION_ABANDON, async () => {
    const agent = requireAgent(ctx);
    agent.abandonPause();
    // 广播状态回 idle
    const fullWindow = ctx.windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SESSION_STATUS_CHANGED, {
        status: 'idle',
        resumable: false,
      });
    }
    return { abandoned: true };
  });

  /** 获取工作上下文（plan + 暂停态，供任务表面板渲染） */
  ipcMain.handle(IPC_CHANNELS.SESSION_GET_WORK_CONTEXT, async () => {
    const agent = requireAgent(ctx);
    const checkpoint = agent.getCheckpoint();
    const plan = checkpoint?.plan ?? [];
    const activeStep = plan.find((s) => s.status === 'active');
    const pauseMeta = (checkpoint as { pauseMeta?: PauseMeta } | undefined)?.pauseMeta;
    return {
      plan: plan.map((s) => ({ order: s.order, description: s.description, status: s.status })),
      activeStepOrder: activeStep?.order ?? -1,
      pausePhase: pauseMeta?.phase,
      pauseReason: pauseMeta?.reason,
    };
  });

  /** 追加计划步骤（用户侧追加任务到 plan 末尾） */
  ipcMain.handle(IPC_CHANNELS.SESSION_APPEND_TASK, async (_event, description: string) => {
    const agent = requireAgent(ctx);
    const totalSteps = agent.appendPlanStep(description);
    return { appended: true, totalSteps };
  });

  /**
   * 注册 needClarify 事件监听：Agent 发射 needClarify 事件时，
   * 通过 SESSION_NEED_CLARIFY 通道转发到渲染进程，触发澄清面板展示。
   */
  const agent = requireAgent(ctx);
  // AgentEventMap.needClarify 的 slot 类型为 string（比 ClarifyQuestion 的 keyof FourTuple 更宽），
  // 此处使用 AgentEventMap 的推断类型避免类型不兼容错误
  agent.on(AGENT_EVENTS.needClarify, (questions: { slot: string; question: string; options?: string[] }[]) => {
    const fullWindow = ctx.windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SESSION_NEED_CLARIFY, questions);
    }
    // 武装超时自动续跑计时器（仅 agent 主动询问触发；用户手动暂停不发 needClarify，天然豁免）
    clearTimeout(clarifyTimeout ?? undefined);
    clarifyTimeout = setTimeout(() => {
      clarifyTimeout = null;
      autoResolveClarify(ctx, questions);
    }, CLARIFY_AUTO_RESOLVE_MS);
  });

  /**
   * Finding B 修复：内核 auto-resume（processEvent 内 PAUSED + 非 command 事件）
   * 直接调 agent.resume() 仅发 sessionResumed 内核事件；渲染层只订阅 SESSION_STATUS_CHANGED IPC，
   * 若不在此转发，暂停态注入后 UI 徽标会卡死在「已暂停」。
   * 状态广播统一由内核事件驱动：显式 SESSION_RESUME 与 auto-resume 共用此监听器，
   * 故 SESSION_RESUME handler 内不再手动 emit（避免双发）。
   */
  agent.on(AGENT_EVENTS.sessionResumed, () => {
    // 任意恢复路径（显式/手动回答/超时自动）均经此监听——清除可能待触发的澄清超时计时器
    if (clarifyTimeout) {
      clearTimeout(clarifyTimeout);
      clarifyTimeout = null;
    }
    const fullWindow = ctx.windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SESSION_STATUS_CHANGED, {
        status: 'running',
        // 恢复态的 resumable 反映当前会话是否仍可续跑（多轮任务 / 自主步）
        resumable: agent.canContinueWithoutInput(),
      });
    }
  });

  /**
   * P0-2：内核事实驱动暂停广播——与 sessionResumed 同构。
   * 状态机在 loop 迭代边界真正挂起时翻 PAUSED（requestPause 不再同步翻转，修 D1），
   * 内核经 forwardEvent 转发 sessionPaused 事件，此处统一广播 SESSION_STATUS_CHANGED{paused}。
   */
  agent.on(AGENT_EVENTS.sessionPaused, (payload) => {
    const reason = (payload as { reason?: string } | undefined)?.reason ?? '用户主动暂停';
    const fullWindow = ctx.windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SESSION_STATUS_CHANGED, {
        status: 'paused',
        reason,
        // 暂停态必可续跑（空输入继续 / 补充输入修正后续轮）
        resumable: agent.canContinueWithoutInput(),
      });
    }
  });

  /**
   * 处理用户回答的澄清问题
   *
   * 渲染进程提交文案回答后，构造 SessionEvent 恢复会话。
   * 将回答序列化为 JSON 字符串作为 clarify 事件的内容，
   * 内核 Composer 的 P4 补全链会解析此内容并填入对应槽位。
   */
  ipcMain.handle(IPC_CHANNELS.SESSION_CLARIFY_ANSWER, async (_event, answers: Array<{ slot: string; answer: string }>) => {
    // 用户主动回答：取消待触发的澄清超时自动续跑计时器（不依赖下方 resume 必然经 sessionResumed 清除）
    if (clarifyTimeout) {
      clearTimeout(clarifyTimeout);
      clarifyTimeout = null;
    }
    const agent = requireAgent(ctx);
    const event: SessionEvent = {
      type: 'clarify',
      content: JSON.stringify(answers),
      delta: {},
    };
    // 使用 processEvent 将澄清回答注入到事件处理流
    // 不等待流式输出（回答后由 Composer 补全槽位，继续 P1-P3 流程）
    void agent.processEvent(event);
    return { success: true };
  });

  /**
   * 超时自动续跑（Finding A）
   *
   * needClarify 计时器触发：用户长时间未响应 agent 的澄清询问。
   * 构造「择优决策」回答——有预置选项取首选项，否则按 slot 生成中性自动决策文本——
   * 注入会话。内核 clarify→chat 转换 + Composer 补全链下，回答非空即不会 re-pause，
   * agent 直接收敛本轮（详见顶部 CLARIFY_AUTO_RESOLVE_MS 注释）。
   */
  function autoResolveClarify(
    ctx: IpcContext,
    questions: { slot: string; question: string; options?: string[] }[],
  ): void {
    const agent = requireAgent(ctx);
    const answers = questions.map((q) => ({
      slot: q.slot,
      answer:
        q.options && q.options.length > 0
          ? q.options[0]
          : autoDecisionText(q.slot, q.question),
    }));
    logger.info({ questionCount: questions.length }, '澄清暂停超时，自动择优续跑');
    // 通知渲染进程插入系统提示（用户可感知超时自动继续，而非静默续跑）
    const fullWindow = ctx.windowManager.getFullWindow();
    if (fullWindow && !fullWindow.isDestroyed()) {
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.CLARIFY_AUTO_RESOLVED, {
        autoResolved: true,
      });
    }
    const event: SessionEvent = {
      type: 'clarify',
      content: JSON.stringify(answers),
      delta: {},
    };
    // 复用澄清回答注入逻辑：processEvent 内 PAUSED + 非 command 事件会触发 auto-resume
    void agent.processEvent(event);
  }

  /** 超时自动决策文案（无预置选项时，按 slot 生成中性可收敛文本） */
  function autoDecisionText(slot: string, question: string): string {
    if (slot === 'task') {
      return '沿用当前目标与上下文，由 Agent 自主推进（超时自动继续）';
    }
    return `由 Agent 基于上下文自主决策（超时未响应，已自动继续）：${question}`;
  }
}
