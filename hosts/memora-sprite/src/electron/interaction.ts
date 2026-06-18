/**
 * Electron 交互层 — 实现 IInteraction
 *
 * 职责：
 * - 输出：向渲染进程发送主动提示 / 系统消息（非流式）
 * - 关闭：监听窗口关闭事件
 *
 * 注意：流式输出（agent.chat() 的 AsyncGenerator）和用户输入
 * 由 ipcHandlers.ts 直接处理，不走此交互层。
 * 此交互层仅用于 Sprite 的 ProactiveEngine 发送主动提示。
 */

import type { BrowserWindow } from 'electron';
import type { IInteraction, InputHandler, CloseHandler, OutputKind } from '../sprite/interaction.js';

export class ElectronInteraction implements IInteraction {
  private mainWindow: BrowserWindow | null = null;

  /** 设置主窗口引用（由 main.ts 注入） */
  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  /**
   * 启动交互层
   *
   * Electron 模式下用户输入由 ipcHandlers.ts 直接处理（流式输出），
   * 此方法仅作为 IInteraction 接口的占位实现。
   */
  start(_handler: InputHandler): void {
    // 无操作——用户输入由 ipcHandlers.ts 处理
  }

  /** 输出主动提示或系统消息 */
  output(text: string, kind: OutputKind = 'system'): void {
    this.mainWindow?.webContents.send('sprite-output', { text, kind });
  }

  /** 输出错误信息 */
  error(text: string): void {
    this.mainWindow?.webContents.send('sprite-error', { text });
  }

  /** 停止交互层 */
  stop(): void {
    // 无操作——IPC 监听器由 ipcHandlers.ts 管理
  }

  /** 注册关闭回调 */
  onClose(handler: CloseHandler): void {
    this.mainWindow?.on('closed', handler);
  }
}
