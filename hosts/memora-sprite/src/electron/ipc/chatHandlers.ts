/**
 * 对话相关 IPC 处理器（薄层）
 *
 * 职责：
 *   1. 注册 USER_INPUT 通道（委托到 chatStreamHandler.handleUserInput）
 *   2. 注册 CHAT_ABORT 通道（AbortController + reason 携带中断原因）
 *
 * 流式输出业务逻辑（handleUserInput ~240 行）已提取到
 * chatStreamHandler.ts，本文件回归"IPC 通道注册"的薄层职责。
 *
 * 流式输出架构（方案 §6.2 排雷修正）：
 *   主进程直接消费 agent.chat()，通过专用 IPC 通道发送 chunk，
 *   不走 IInteraction（IInteraction 仅负责非流式输出）。
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from './channels.js';
import type { IpcContext } from './types.js';
import { handleUserInput } from './chatStreamHandler.js';
import { isValidContent } from './inputValidation.js';

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
      return;
    }
    void handleUserInput(text, ctx);
  });

  /** 中断当前对话 */
  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT, async () => {
    // P2-DESIGN-7 修复：使用 AbortController.reason 携带中断原因，替代共享布尔标志
    const ctrl = ctx.getAbortController();
    if (ctrl) {
      // 使用 DOMException 模拟标准 AbortController.abort(reason) 行为
      // reason='user' 标识用户主动中断，catch 块据此发送系统消息
      ctrl.abort(new DOMException('用户手动停止', 'AbortError'));
      // 不在此处 setAbortController(null)：catch 块需通过 ctrl.signal.reason 判断是否用户主动中断。
      // 旧实现立即清空引用，导致 catch 块获取的 ctrl 为 null，wasUserAborted 永远为 false，
      // 用户取消后会收到误导性的"对话出错"提示。清理统一由 finally 块执行。
    }
    return { aborted: true };
  });
}
