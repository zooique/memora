/**
 * 剪贴板保护管理器（数据/状态层）测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - setOnChange：注入回调，状态变更时被调用
 * - addPendingItem：去重 / FIFO 淘汰 / 倒序插入 / onChange 触发 / isStale 重置
 * - removePendingItem：移除条目 / 不存在时不触发 onChange
 * - clearPendingItems：清空 / 空列表不触发 onChange
 * - getPendingItems：返回只读副本（外部修改不影响内部状态）
 * - getPendingCount：返回数量
 * - hasStaleItem：返回是否较旧
 * - refreshStaleFlags：超过 24h 标记 + 触发 onChange + 未变化不触发
 * - showSensitiveWarning：warning Toast 5s 自动消失
 * - showClipboardConfirmDialog：用户确认/取消 / 长内容截断 / 短内容不截断 / addMemory 调用 / 防 XSS
 * - cleanup：清空 pendingItems + 移除 onChange 引用
 *
 * Mock 策略：
 * - Mock ToastManager（验证 showToast 调用参数）
 * - Mock ModalManager（控制 showConfirmDialog 返回值）
 * - Mock window.electronAPI.clipboardAnalyze / addMemory
 * - vi.useFakeTimers 控制 Date.now() 测试较旧标记
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ClipboardManager,
  MAX_PENDING_ITEMS,
  BADGE_MAX_DISPLAY,
  STALE_THRESHOLD_MS,
} from '../../../electron/renderer/panels/clipboardManager.js';
import type { ClipboardPendingItem } from '../../../electron/renderer/panels/clipboardManager.js';
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
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-18T12:00:00Z'));
  // 清除 localStorage 确保每个测试从空历史开始
  //（构造函数会调用 loadPendingItems() 从 localStorage 恢复上次会话的待处理列表）
  localStorage.clear();
  window.electronAPI = {
    clipboardAnalyze: vi.fn().mockResolvedValue(undefined),
    addMemory: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.electronAPI;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── addPendingItem · 基本 ──────────────────────────────

describe('addPendingItem · 基本行为', () => {
  it('应将新条目插入到列表头部（倒序）', () => {
    const { manager } = createManager();
    manager.addPendingItem('内容A', 10);
    manager.addPendingItem('内容B', 20);
    const items = manager.getPendingItems();
    expect(items).toHaveLength(2);
    expect(items[0].preview).toBe('内容B');
    expect(items[1].preview).toBe('内容A');
  });

  it('应触发 onChange 回调', () => {
    const { manager } = createManager();
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    manager.addPendingItem('内容', 10);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('未设置 onChange 时不应抛错', () => {
    const { manager } = createManager();
    expect(() => manager.addPendingItem('内容', 10)).not.toThrow();
  });

  it('应记录内容预览、长度和检测时间', () => {
    const { manager } = createManager();
    manager.addPendingItem('预览文本', 100);
    const items = manager.getPendingItems();
    expect(items[0].preview).toBe('预览文本');
    expect(items[0].length).toBe(100);
    expect(items[0].detectedAt).toBe(Date.now());
    expect(items[0].isStale).toBe(false);
  });

  it('每条目应有唯一 ID', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    // 推进时间避免时间戳相同
    vi.advanceTimersByTime(10);
    manager.addPendingItem('B', 1);
    const items = manager.getPendingItems();
    expect(items[0].id).not.toBe(items[1].id);
  });
});

// ─── addPendingItem · 去重 ─────────────────────────────

describe('addPendingItem · 去重', () => {
  it('相同 preview 不重复添加', () => {
    const { manager } = createManager();
    manager.addPendingItem('重复内容', 10);
    manager.addPendingItem('重复内容', 10);
    expect(manager.getPendingCount()).toBe(1);
  });

  it('重复添加时将已有条目移到列表头部', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    manager.addPendingItem('B', 2);
    manager.addPendingItem('C', 3);
    // 重复添加 A，A 应移到头部
    manager.addPendingItem('A', 1);
    const items = manager.getPendingItems();
    expect(items).toHaveLength(3);
    expect(items[0].preview).toBe('A');
  });

  it('重复添加时应更新 detectedAt 为当前时间', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    const originalTime = manager.getPendingItems()[0].detectedAt;
    // 推进时间 1 分钟
    vi.advanceTimersByTime(60000);
    manager.addPendingItem('A', 1);
    const updatedItem = manager.getPendingItems()[0];
    expect(updatedItem.detectedAt).toBe(originalTime + 60000);
  });

  it('重复添加时应重置 isStale 标记', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    // 推进时间超过 24h 让条目变较旧
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1);
    manager.refreshStaleFlags();
    expect(manager.hasStaleItem()).toBe(true);
    // 重复添加触发重置
    manager.addPendingItem('A', 1);
    const item = manager.getPendingItems()[0];
    expect(item.isStale).toBe(false);
  });

  it('重复添加时也应触发 onChange', () => {
    const { manager } = createManager();
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    manager.addPendingItem('A', 1);
    manager.addPendingItem('A', 1);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

// ─── addPendingItem · FIFO 淘汰 ────────────────────────

describe('addPendingItem · FIFO 淘汰', () => {
  it('超出上限时应丢弃最旧条目', () => {
    const { manager } = createManager();
    // 添加 MAX_PENDING_ITEMS 条
    for (let i = 0; i < MAX_PENDING_ITEMS; i++) {
      manager.addPendingItem(`内容${i}`, i);
      vi.advanceTimersByTime(1);
    }
    expect(manager.getPendingCount()).toBe(MAX_PENDING_ITEMS);
    // 再添加 1 条，最旧的应被丢弃
    manager.addPendingItem('新内容', 999);
    expect(manager.getPendingCount()).toBe(MAX_PENDING_ITEMS);
    // 最旧的"内容0"应已被丢弃
    const items = manager.getPendingItems();
    expect(items.find((item) => item.preview === '内容0')).toBeUndefined();
    // 最新条目应在头部
    expect(items[0].preview).toBe('新内容');
  });
});

// ─── removePendingItem ─────────────────────────────────

describe('removePendingItem', () => {
  it('应按 ID 移除指定条目', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    manager.addPendingItem('B', 2);
    const idToRemove = manager.getPendingItems()[1].id; // A 的 id
    manager.removePendingItem(idToRemove);
    expect(manager.getPendingCount()).toBe(1);
    expect(manager.getPendingItems()[0].preview).toBe('B');
  });

  it('移除时应触发 onChange', () => {
    const { manager } = createManager();
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    manager.addPendingItem('A', 1);
    onChange.mockClear();
    const id = manager.getPendingItems()[0].id;
    manager.removePendingItem(id);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ID 不存在时不应触发 onChange', () => {
    const { manager } = createManager();
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    manager.addPendingItem('A', 1);
    onChange.mockClear();
    manager.removePendingItem('不存在的ID');
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ─── clearPendingItems ─────────────────────────────────

describe('clearPendingItems', () => {
  it('应清空所有待处理条目', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    manager.addPendingItem('B', 2);
    manager.clearPendingItems();
    expect(manager.getPendingCount()).toBe(0);
  });

  it('清空时应触发 onChange', () => {
    const { manager } = createManager();
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    manager.addPendingItem('A', 1);
    onChange.mockClear();
    manager.clearPendingItems();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('列表已为空时不应触发 onChange', () => {
    const { manager } = createManager();
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    manager.clearPendingItems();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ─── getPendingItems · 只读副本 ────────────────────────

describe('getPendingItems · 只读副本', () => {
  it('返回的数组修改不应影响内部状态', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    const items = manager.getPendingItems();
    // 尝试修改返回的数组
    (items as ClipboardPendingItem[]).push({
      id: 'fake',
      preview: 'fake',
      length: 0,
      detectedAt: 0,
      isStale: false,
    });
    // 内部状态不应受影响
    expect(manager.getPendingCount()).toBe(1);
  });
});

// ─── getPendingCount ───────────────────────────────────

describe('getPendingCount', () => {
  it('应返回当前待处理数量', () => {
    const { manager } = createManager();
    expect(manager.getPendingCount()).toBe(0);
    manager.addPendingItem('A', 1);
    expect(manager.getPendingCount()).toBe(1);
    manager.addPendingItem('B', 2);
    expect(manager.getPendingCount()).toBe(2);
  });
});

// ─── getUnviewedCount / markAllViewed ──────────────────

describe('未查看计数', () => {
  it('初始应为 0', () => {
    const { manager } = createManager();
    expect(manager.getUnviewedCount()).toBe(0);
  });

  it('新增条目应增加未查看计数', () => {
    const { manager } = createManager();
    manager.addPendingItem('内容A', 10);
    expect(manager.getUnviewedCount()).toBe(1);
    manager.addPendingItem('内容B', 20);
    expect(manager.getUnviewedCount()).toBe(2);
  });

  it('重复条目不应增加未查看计数', () => {
    const { manager } = createManager();
    manager.addPendingItem('内容A', 10);
    expect(manager.getUnviewedCount()).toBe(1);
    // 重复添加相同 preview
    manager.addPendingItem('内容A', 10);
    expect(manager.getUnviewedCount()).toBe(1);
  });

  it('markAllViewed 应清零未查看计数', () => {
    const { manager } = createManager();
    manager.addPendingItem('内容A', 10);
    manager.addPendingItem('内容B', 20);
    expect(manager.getUnviewedCount()).toBe(2);

    manager.markAllViewed();
    expect(manager.getUnviewedCount()).toBe(0);
  });

  it('已清零后再次调用 markAllViewed 不应重复触发 onChange', () => {
    const { manager } = createManager();
    let callCount = 0;
    manager.setOnChange(() => { callCount++; });
    manager.addPendingItem('内容', 10);
    callCount = 0; // 重置计数

    manager.markAllViewed();
    expect(callCount).toBe(1); // 第一次清零触发 onChange

    manager.markAllViewed();
    expect(callCount).toBe(1); // 已经为 0，不应再次触发
  });
});

// ─── hasStaleItem · 较旧标记 ───────────────────────────

describe('hasStaleItem', () => {
  it('无条目时应返回 false', () => {
    const { manager } = createManager();
    expect(manager.hasStaleItem()).toBe(false);
  });

  it('所有条目均未超 24h 时应返回 false', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    vi.advanceTimersByTime(1000);
    manager.refreshStaleFlags();
    expect(manager.hasStaleItem()).toBe(false);
  });

  it('存在超过 24h 的条目时应返回 true', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1);
    manager.refreshStaleFlags();
    expect(manager.hasStaleItem()).toBe(true);
  });
});

// ─── refreshStaleFlags ─────────────────────────────────

describe('refreshStaleFlags', () => {
  it('应将超过 24h 的条目标记为 isStale', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1);
    manager.refreshStaleFlags();
    expect(manager.getPendingItems()[0].isStale).toBe(true);
  });

  it('新增标记时应触发 onChange', () => {
    const { manager } = createManager();
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    manager.addPendingItem('A', 1);
    onChange.mockClear();
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1);
    manager.refreshStaleFlags();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('未发生变化时不应触发 onChange', () => {
    const { manager } = createManager();
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    manager.addPendingItem('A', 1);
    onChange.mockClear();
    // 时间未推进，无变化
    manager.refreshStaleFlags();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('已较旧条目再次调用不应重复触发 onChange', () => {
    const { manager } = createManager();
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    manager.addPendingItem('A', 1);
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1);
    manager.refreshStaleFlags();
    onChange.mockClear();
    // 再次调用，状态未变
    manager.refreshStaleFlags();
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ─── showSensitiveWarning ──────────────────────────────

describe('showSensitiveWarning', () => {
  it('应显示 warning Toast，5 秒自动消失', () => {
    const { manager, toast } = createManager();
    manager.showSensitiveWarning('token');
    const mockToast = toast as unknown as { __calls: Array<{ message: string; type: string; duration?: number }> };
    expect(mockToast.__calls).toHaveLength(1);
    expect(mockToast.__calls[0].message).toContain('token');
    expect(mockToast.__calls[0].type).toBe('warning');
    expect(mockToast.__calls[0].duration).toBe(5000);
  });

  it('消息文案应包含敏感类型', () => {
    const { manager, toast } = createManager();
    manager.showSensitiveWarning('password');
    const mockToast = toast as unknown as { __calls: Array<{ message: string }> };
    expect(mockToast.__calls[0].message).toContain('password');
  });

  it('不应将敏感内容添加到待处理列表', () => {
    const { manager } = createManager();
    manager.showSensitiveWarning('token');
    expect(manager.getPendingCount()).toBe(0);
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
  it('内容超过 200 字符应截断 + 添加 …', async () => {
    const modal = createMockModalManager(false); // 取消，不触发 addMemory
    const { manager } = createManager(createMockToastManager(), modal);
    const longContent = 'a'.repeat(250);
    await manager.showClipboardConfirmDialog(longContent);
    // 通过 showConfirmDialog 调用参数中的 messageNodes 验证预览内容
    const callArgs = (modal.showConfirmDialog as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const container = callArgs.messageNodes[0] as HTMLElement;
    const codeEl = container.querySelector('code');
    expect(codeEl?.textContent).toBe('a'.repeat(200) + '…');
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

describe('cleanup', () => {
  it('应清空待处理列表', () => {
    const { manager } = createManager();
    manager.addPendingItem('A', 1);
    manager.addPendingItem('B', 2);
    manager.cleanup();
    expect(manager.getPendingCount()).toBe(0);
  });

  it('应移除 onChange 引用（后续 addPendingItem 不再触发回调）', () => {
    const { manager } = createManager();
    const onChange = vi.fn();
    manager.setOnChange(onChange);
    manager.cleanup();
    manager.addPendingItem('A', 1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('空列表时不应抛错', () => {
    const { manager } = createManager();
    expect(() => manager.cleanup()).not.toThrow();
  });
});

// ─── 常量导出验证 ───────────────────────────────────────

describe('常量导出', () => {
  it('MAX_PENDING_ITEMS 应为 20', () => {
    expect(MAX_PENDING_ITEMS).toBe(20);
  });

  it('BADGE_MAX_DISPLAY 应为 99', () => {
    expect(BADGE_MAX_DISPLAY).toBe(99);
  });

  it('STALE_THRESHOLD_MS 应为 24 小时', () => {
    expect(STALE_THRESHOLD_MS).toBe(24 * 60 * 60 * 1000);
  });
});
