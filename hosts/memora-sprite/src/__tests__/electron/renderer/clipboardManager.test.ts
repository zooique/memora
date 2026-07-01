/**
 * 剪贴板保护面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - showClipboardChangedToast：Toast 调用参数 + action 回调触发 clipboardAnalyze
 * - showClipboardConfirmDialog：用户确认/取消 / 长内容截断 / 短内容不截断 / addMemory 调用
 * - cleanup：空实现不应抛错
 *
 * Mock 策略：
 * - Mock ToastManager（验证 showToast 调用参数 + 触发 onAction 回调）
 * - Mock ModalManager（控制 showConfirmDialog 返回值）
 * - Mock window.electronAPI.clipboardAnalyze / addMemory
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClipboardManager } from '../../../electron/renderer/panels/clipboardManager.js';
import type { ToastManager } from '../../../electron/renderer/components/toast.js';
import type { ModalManager } from '../../../electron/renderer/components/modal.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** Toast 选项类型（与 toast.ts ToastOptions 一致） */
interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
}

/** 创建 Mock ToastManager（捕获 showToast 调用参数） */
function createMockToastManager() {
  const calls: Array<{ message: string; type: string; duration?: number; options?: ToastOptions }> = [];
  return {
    showToast: vi.fn((message: string, type: string = 'info', duration?: number, options?: ToastOptions) => {
      calls.push({ message, type, duration, options });
    }),
    __calls: calls,
  } as unknown as ToastManager & { __calls: typeof calls };
}

/** 创建 Mock ModalManager（控制 showConfirmDialog 返回值） */
function createMockModalManager(confirmResult: boolean) {
  return {
    showConfirmDialog: vi.fn().mockResolvedValue(confirmResult),
    initModalListeners: vi.fn(),
    hideModal: vi.fn(),
  } as unknown as ModalManager;
}

/** 创建 ClipboardManager 实例（注入 Mock 依赖） */
function createManager(
  toastManager: ToastManager = createMockToastManager(),
  modalManager: ModalManager = createMockModalManager(true),
): { manager: ClipboardManager; toast: ToastManager; modal: ModalManager } {
  return { manager: new ClipboardManager(toastManager, modalManager), toast: toastManager, modal: modalManager };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  window.electronAPI = {
    clipboardAnalyze: vi.fn().mockResolvedValue(undefined),
    addMemory: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── showClipboardChangedToast ──────────────────────────

describe('showClipboardChangedToast · Toast 调用', () => {
  it('应调用 showToast 显示 info Toast', () => {
    const { manager, toast } = createManager();
    const mockToast = toast as unknown as { __calls: Array<{ message: string; type: string; duration?: number }> };
    manager.showClipboardChangedToast();
    expect(mockToast.__calls).toHaveLength(1);
    expect(mockToast.__calls[0].message).toBe('剪贴板有新内容');
    expect(mockToast.__calls[0].type).toBe('info');
  });

  it('应设置 duration=0（不自动消失）', () => {
    const { manager, toast } = createManager();
    const mockToast = toast as unknown as { __calls: Array<{ duration?: number }> };
    manager.showClipboardChangedToast();
    expect(mockToast.__calls[0].duration).toBe(0);
  });

  it('应提供"分析"按钮 + onAction 回调', () => {
    const { manager, toast } = createManager();
    const mockToast = toast as unknown as { __calls: Array<{ options?: ToastOptions }> };
    manager.showClipboardChangedToast();
    expect(mockToast.__calls[0].options?.actionLabel).toBe('分析');
    expect(typeof mockToast.__calls[0].options?.onAction).toBe('function');
  });

  it('点击"分析"按钮应调用 clipboardAnalyze', () => {
    const { manager, toast } = createManager();
    const mockToast = toast as unknown as { __calls: Array<{ options?: ToastOptions }> };
    manager.showClipboardChangedToast();
    mockToast.__calls[0].options?.onAction?.();
    expect(window.electronAPI.clipboardAnalyze).toHaveBeenCalledTimes(1);
  });
});

// ─── showClipboardConfirmDialog · 用户确认 ────────────────

describe('showClipboardConfirmDialog · 用户确认流程', () => {
  it('用户确认时应调用 addMemory + 显示 success toast', async () => {
    const toast = createMockToastManager();
    const modal = createMockModalManager(true);
    const { manager } = createManager(toast, modal);
    await manager.showClipboardConfirmDialog('测试内容');
    expect(window.electronAPI.addMemory).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.addMemory).toHaveBeenCalledWith({
      content: '测试内容',
      source: 'clipboard',
      name: expect.stringContaining('剪贴板记忆'),
    });
    const mockToast = toast as unknown as { __calls: Array<{ message: string; type: string }> };
    expect(mockToast.__calls).toHaveLength(1);
    expect(mockToast.__calls[0].message).toBe('已存为记忆');
    expect(mockToast.__calls[0].type).toBe('success');
  });

  it('用户取消时不应调用 addMemory', async () => {
    const toast = createMockToastManager();
    const modal = createMockModalManager(false);
    const { manager } = createManager(toast, modal);
    await manager.showClipboardConfirmDialog('测试内容');
    expect(window.electronAPI.addMemory).not.toHaveBeenCalled();
  });

  it('应调用 modalManager.showConfirmDialog', async () => {
    const { manager, modal } = createManager();
    await manager.showClipboardConfirmDialog('内容');
    expect(modal.showConfirmDialog).toHaveBeenCalledTimes(1);
  });
});

// ─── showClipboardConfirmDialog · 内容截断 ─────────────────

describe('showClipboardConfirmDialog · 长内容截断', () => {
  it('内容超过 200 字符应截断 + 添加 ...', async () => {
    const modal = createMockModalManager(false); // 取消，不触发 addMemory
    const { manager } = createManager(createMockToastManager(), modal);
    const longContent = 'a'.repeat(250);
    await manager.showClipboardConfirmDialog(longContent);
    // 通过 showConfirmDialog 调用参数中的 messageNodes 验证预览内容
    const callArgs = (modal.showConfirmDialog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const container = callArgs.messageNodes[0] as HTMLElement;
    const codeEl = container.querySelector('code');
    expect(codeEl?.textContent).toBe('a'.repeat(200) + '...');
  });

  it('内容不超过 200 字符不应截断', async () => {
    const modal = createMockModalManager(false);
    const { manager } = createManager(createMockToastManager(), modal);
    const shortContent = 'a'.repeat(100);
    await manager.showClipboardConfirmDialog(shortContent);
    const callArgs = (modal.showConfirmDialog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const container = callArgs.messageNodes[0] as HTMLElement;
    const codeEl = container.querySelector('code');
    expect(codeEl?.textContent).toBe(shortContent);
  });

  it('内容恰好 200 字符不应截断', async () => {
    const modal = createMockModalManager(false);
    const { manager } = createManager(createMockToastManager(), modal);
    const exactContent = 'a'.repeat(200);
    await manager.showClipboardConfirmDialog(exactContent);
    const callArgs = (modal.showConfirmDialog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const container = callArgs.messageNodes[0] as HTMLElement;
    const codeEl = container.querySelector('code');
    expect(codeEl?.textContent).toBe(exactContent);
  });

  it('应使用 textContent 防 XSS', async () => {
    const modal = createMockModalManager(false);
    const { manager } = createManager(createMockToastManager(), modal);
    const malicious = '<img src=x onerror=alert(1)>';
    await manager.showClipboardConfirmDialog(malicious);
    const callArgs = (modal.showConfirmDialog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const container = callArgs.messageNodes[0] as HTMLElement;
    // 预览 code 元素内不应有 img 标签
    expect(container.querySelector('code img')).toBeNull();
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup · 空实现', () => {
  it('cleanup 不应抛错（空实现，与其他 Manager 保持统一生命周期接口）', () => {
    const { manager } = createManager();
    expect(() => manager.cleanup()).not.toThrow();
  });
});
