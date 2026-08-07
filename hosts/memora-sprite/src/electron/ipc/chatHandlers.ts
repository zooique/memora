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
import { logger } from 'memora';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from './channels.js';
import type { IpcContext } from './types.js';
import { requireAgent } from './types.js';
import { handleUserInput } from './chatStreamHandler.js';
import { isValidContent } from './inputValidation.js';
import type { SessionCheckpoint } from 'memora';

/**
 * 注册对话相关 IPC 处理器
 *
 * @param ctx IPC 上下文
 */
export function registerChatHandlers(ctx: IpcContext): void {
  /**
   * 用户输入处理 — 委托到 chatStreamHandler.handleUserInput
   *
   * 流式输出架构：主进程直接消费 agent.chat()，通过专用 IPC 通道发送 chunk。
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

  /** 暂停会话 */
  ipcMain.handle(IPC_CHANNELS.SESSION_PAUSE, async (_event, reason: string) => {
    const agent = requireAgent(ctx);
    const result = agent.pause(reason ?? '用户主动暂停', 'user');
    // 广播状态变更到渲染进程
    if (result) {
      const fullWindow = ctx.windowManager.getFullWindow();
      if (fullWindow && !fullWindow.isDestroyed()) {
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SESSION_STATUS_CHANGED, {
          status: 'paused',
          reason: reason ?? '用户主动暂停',
        });
      }
    }
    return { paused: result };
  });

  /** 恢复会话 */
  ipcMain.handle(IPC_CHANNELS.SESSION_RESUME, async () => {
    const agent = requireAgent(ctx);
    const result = agent.resume();
    // 广播状态变更到渲染进程
    if (result) {
      const fullWindow = ctx.windowManager.getFullWindow();
      if (fullWindow && !fullWindow.isDestroyed()) {
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SESSION_STATUS_CHANGED, {
          status: 'running',
        });
      }
    }
    return { resumed: result };
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
    const messageCount = agent.restoreFromCheckpoint(checkpoint);
    return { restored: true, messageCount };
  });
}
