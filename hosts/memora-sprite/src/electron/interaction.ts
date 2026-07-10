/**
 * Electron 交互层 — 实现 IInteraction
 *
 * 职责：
 * - 输出：向渲染进程发送系统消息（非流式）
 * - 关闭：监听窗口关闭事件
 *
 * 注意：流式输出（agent.chat() 的 AsyncGenerator）和用户输入
 * 由 ipcHandlers.ts 直接处理，不走此交互层。
 * 此交互层仅用于 Sprite 发送系统消息。
 * 主动提示通过 emitSprite('proactivePrompt') 事件发射，由 main.ts 监听并展示为 banner。
 */

import type { BrowserWindow } from 'electron';
import type { IInteraction, InputHandler, CloseHandler, OutputKind } from '../sprite/interaction.js';
import { MAIN_TO_RENDERER_CHANNELS } from './ipc/channels.js';

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

  /**
   * 输出 system 类型消息到渲染进程对话区
   *
   * 添加 isDestroyed 守卫，与 errorHandler/windowManager 的守卫模式一致。
   * `this.mainWindow?.webContents.send()` 仅检查 mainWindow 是否为 null，
   * 但窗口销毁后 mainWindow 引用仍存在（setMainWindow 未清空），webContents.send 会抛错。
   */
  output(text: string, _kind: OutputKind = 'system'): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT, { text });
  }

  /** 输出错误信息 */
  error(text: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, { text });
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
