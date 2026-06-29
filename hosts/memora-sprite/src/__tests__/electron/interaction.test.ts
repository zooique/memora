/**
 * Electron 交互层测试
 *
 * 覆盖范围：
 * - setMainWindow：设置窗口引用
 * - start：占位实现（无操作，IPC 由 ipcHandlers 处理）
 * - output：发送系统消息（mainWindow=null/已销毁/正常发送 3 路径）
 * - error：发送错误消息（mainWindow=null/已销毁/正常发送 3 路径）
 * - stop：占位实现
 * - onClose：注册关闭回调
 *
 * Mock 策略：
 * - BrowserWindow：简单对象 mock isDestroyed/webContents.send/on
 * - 不依赖 ipcMain，直接调用类方法
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ElectronInteraction } from '../../electron/interaction.js';
import { MAIN_TO_RENDERER_CHANNELS } from '../../electron/ipc/channels.js';
import type { BrowserWindow } from 'electron';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock BrowserWindow（捕获 webContents.send / on 调用） */
function createMockWindow(destroyed = false): BrowserWindow & {
  webContents: { send: ReturnType<typeof vi.fn> };
  on: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
} {
  return {
    webContents: { send: vi.fn() },
    on: vi.fn(),
    isDestroyed: vi.fn(() => destroyed),
  } as unknown as BrowserWindow & {
    webContents: { send: ReturnType<typeof vi.fn> };
    on: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('ElectronInteraction', () => {
  let interaction: ElectronInteraction;

  beforeEach(() => {
    interaction = new ElectronInteraction();
    vi.clearAllMocks();
  });

  // ─── setMainWindow ─────────────────────────────────────

  it('setMainWindow 应设置主窗口引用', () => {
    const win = createMockWindow();
    interaction.setMainWindow(win);

    // 通过 output 间接验证 mainWindow 已设置
    interaction.output('test');
    expect(win.webContents.send).toHaveBeenCalled();
  });

  // ─── start ─────────────────────────────────────────────

  it('start 应为占位实现（不抛错，不依赖 handler）', () => {
    expect(() => interaction.start(vi.fn())).not.toThrow();
  });

  // ─── output ────────────────────────────────────────────

  it('output 在 mainWindow=null 时应静默跳过', () => {
    // 不调用 setMainWindow，mainWindow 为 null
    expect(() => interaction.output('test')).not.toThrow();
  });

  it('output 在窗口已销毁时应静默跳过', () => {
    const win = createMockWindow(true); // destroyed = true
    interaction.setMainWindow(win);

    interaction.output('test');

    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('output 正常应通过 SPRITE_OUTPUT 通道发送消息', () => {
    const win = createMockWindow();
    interaction.setMainWindow(win);

    interaction.output('系统消息内容');

    expect(win.webContents.send).toHaveBeenCalledWith(
      MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT,
      { text: '系统消息内容' },
    );
  });

  it('output 应支持 kind 参数（默认 system）', () => {
    const win = createMockWindow();
    interaction.setMainWindow(win);

    // kind 参数在 ElectronInteraction 中未使用（仅占位），但应接受不抛错
    interaction.output('消息', 'warning');

    expect(win.webContents.send).toHaveBeenCalled();
  });

  // ─── error ─────────────────────────────────────────────

  it('error 在 mainWindow=null 时应静默跳过', () => {
    expect(() => interaction.error('错误信息')).not.toThrow();
  });

  it('error 在窗口已销毁时应静默跳过', () => {
    const win = createMockWindow(true);
    interaction.setMainWindow(win);

    interaction.error('错误信息');

    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('error 正常应通过 SPRITE_ERROR 通道发送消息', () => {
    const win = createMockWindow();
    interaction.setMainWindow(win);

    interaction.error('错误信息内容');

    expect(win.webContents.send).toHaveBeenCalledWith(
      MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR,
      { text: '错误信息内容' },
    );
  });

  // ─── stop ──────────────────────────────────────────────

  it('stop 应为占位实现（不抛错）', () => {
    expect(() => interaction.stop()).not.toThrow();
  });

  // ─── onClose ───────────────────────────────────────────

  it('onClose 应在 mainWindow 上注册 closed 事件回调', () => {
    const win = createMockWindow();
    interaction.setMainWindow(win);
    const handler = vi.fn();

    interaction.onClose(handler);

    expect(win.on).toHaveBeenCalledWith('closed', handler);
  });

  it('onClose 在 mainWindow=null 时应静默跳过（不抛错）', () => {
    expect(() => interaction.onClose(vi.fn())).not.toThrow();
  });
});
