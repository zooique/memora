/**
 * 剪贴板面板管理器（UI 渲染层）测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：DOM 元素获取 / onChange 注入 / 首次渲染 / DOM 缺失降级
 * - refresh：由 ClipboardManager.onChange 触发自动刷新 / 列表 + 角标 + 空状态 + 引导气泡联动
 * - 列表渲染：单条 / 多条倒序 / 较旧标签 / 预览文本 / 防 XSS
 * - 角标更新：0 隐藏 / 1-99 数字 / >99 显示 99+ / 较旧警告色
 * - 空状态切换：列表为空显示引导，有内容隐藏
 * - 批量操作按钮显隐：列表为空时隐藏
 * - 单条归档：乐观移除 + clipboardAnalyze 触发 / 失败 toast 提示
 * - 单条忽略：removePendingItem
 * - 批量归档：二次确认 + clearPendingItems + clipboardAnalyze
 * - 批量忽略：二次确认 + clearPendingItems + 成功 toast
 * - 首次引导气泡：localStorage dismissed 控制 / 切换显隐
 * - cleanup：清理事件监听器
 *
 * Mock 策略：
 * - 真实 ClipboardManager（验证数据层与 UI 层的完整联动）
 * - Mock ToastManager / ModalManager（数据层依赖）
 * - Mock ClipboardPanelHost（提供 showConfirmDialog / showToast）
 * - Mock window.electronAPI.clipboardAnalyze（归档流程触发）
 * - JSDOM 提供真实 DOM API
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ClipboardManager, MAX_PENDING_ITEMS, BADGE_MAX_DISPLAY, STALE_THRESHOLD_MS } from '../../../electron/renderer/panels/clipboardManager.js';
import { ClipboardPanelManager } from '../../../electron/renderer/panels/clipboardPanelManager.js';
import type { ClipboardPanelHost } from '../../../electron/renderer/panels/clipboardPanelManager.js';
import { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';
import type { ToastManager } from '../../../electron/renderer/components/toast.js';
import type { ModalManager } from '../../../electron/renderer/components/modal.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 剪贴板面板完整 DOM 结构 */
const PANEL_HTML = `
  <div id="clipboard-actions" class="clipboard-actions">
    <button id="btn-clipboard-archive-all">全部归档</button>
    <button id="btn-clipboard-ignore-all">全部忽略</button>
  </div>
  <div id="clipboard-onboarding-tip" class="hidden">
    <button id="clipboard-onboarding-close">×</button>
  </div>
  <div id="clipboard-pending-list"></div>
  <div id="clipboard-empty-state" class="hidden">暂无待处理内容</div>
  <span id="clipboard-nav-badge" class="nav-badge-hidden"></span>
`;

/** Toast 选项类型（与 toast.ts ToastOptions 一致） */
interface ToastOptions {
  actionLabel?: string;
  onAction?: () => void;
}

/** 创建 Mock ToastManager */
function createMockToastManager() {
  const calls: Array<{ message: string; type: string; duration?: number; options?: ToastOptions }> = [];
  return {
    showToast: vi.fn((message: string, type: string = 'info', duration?: number, options?: ToastOptions) => {
      calls.push({ message, type, duration, options });
    }),
    __calls: calls,
  } as unknown as ToastManager & { __calls: typeof calls };
}

/** 创建 Mock ModalManager */
function createMockModalManager(confirmResult: boolean) {
  return {
    showConfirmDialog: vi.fn().mockResolvedValue(confirmResult),
    initModalListeners: vi.fn(),
    hideModal: vi.fn(),
  } as unknown as ModalManager;
}

/** 创建 Mock ClipboardPanelHost */
function createMockHost(confirmResult: boolean = true): ClipboardPanelHost & {
  _toast: ReturnType<typeof createMockToastManager>;
  _confirmCalls: Array<{ title?: string; message: string; danger?: boolean }>;
} {
  const toast = createMockToastManager();
  const confirmCalls: Array<{ title?: string; message: string; danger?: boolean }> = [];
  return {
    showConfirmDialog: vi.fn(async (opts) => {
      confirmCalls.push({ title: opts.title, message: opts.message, danger: opts.danger });
      return confirmResult;
    }),
    showToast: toast.showToast,
    _toast: toast,
    _confirmCalls: confirmCalls,
  } as unknown as ClipboardPanelHost & { _toast: ReturnType<typeof createMockToastManager>; _confirmCalls: typeof confirmCalls };
}

/** 创建组合实例：ClipboardManager + ClipboardPanelManager */
function createManagers(opts?: {
  html?: string;
  init?: boolean;
  confirmResult?: boolean;
}): {
  clipboardManager: ClipboardManager;
  panelManager: ClipboardPanelManager;
  host: ReturnType<typeof createMockHost>;
  events: EventTracker;
} {
  document.body.innerHTML = opts?.html ?? PANEL_HTML;
  const toast = createMockToastManager();
  const modal = createMockModalManager(opts?.confirmResult ?? true);
  const clipboardManager = new ClipboardManager(toast, modal);
  const host = createMockHost(opts?.confirmResult ?? true);
  const events = new EventTracker();
  const panelManager = new ClipboardPanelManager(clipboardManager, host, events);
  if (opts?.init !== false) {
    panelManager.init();
  }
  return { clipboardManager, panelManager, host, events };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-18T12:00:00Z'));
  window.electronAPI = {
    clipboardAnalyze: vi.fn().mockResolvedValue(undefined),
    addMemory: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.electronAPI;
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── init ────────────────────────────────────────────────

describe('init · DOM 元素获取与 onChange 注入', () => {
  it('应获取所有 DOM 元素引用并通过 onChange 注入回调', () => {
    const { clipboardManager } = createManagers();
    // onChange 已注入：addPendingItem 应自动触发列表刷新
    clipboardManager.addPendingItem('内容A', 10);
    const listEl = document.getElementById('clipboard-pending-list')!;
    expect(listEl.children).toHaveLength(1);
    expect(listEl.children[0].querySelector('.clipboard-item-preview')?.textContent).toBe('内容A');
  });

  it('首次渲染应反映 ClipboardManager 当前状态（空列表显示空状态）', () => {
    createManagers();
    const emptyState = document.getElementById('clipboard-empty-state')!;
    expect(emptyState.classList.contains('hidden')).toBe(false);
  });

  it('首次渲染应反映 ClipboardManager 当前状态（有内容隐藏空状态）', () => {
    // 先创建未 init 的实例，预填充数据后再 init
    document.body.innerHTML = PANEL_HTML;
    const toast = createMockToastManager();
    const modal = createMockModalManager(true);
    const clipboardManager = new ClipboardManager(toast, modal);
    clipboardManager.addPendingItem('预填充内容', 100);
    const host = createMockHost(true);
    const panelManager = new ClipboardPanelManager(clipboardManager, host, new EventTracker());
    panelManager.init();
    const emptyState = document.getElementById('clipboard-empty-state')!;
    expect(emptyState.classList.contains('hidden')).toBe(true);
    const listEl = document.getElementById('clipboard-pending-list')!;
    expect(listEl.children).toHaveLength(1);
  });

  it('DOM 元素全部缺失时不应抛错（静默降级）', () => {
    document.body.innerHTML = '';
    const toast = createMockToastManager();
    const modal = createMockModalManager(true);
    const clipboardManager = new ClipboardManager(toast, modal);
    const host = createMockHost(true);
    const panelManager = new ClipboardPanelManager(clipboardManager, host, new EventTracker());
    expect(() => panelManager.init()).not.toThrow();
    // 即使 DOM 缺失，onChange 仍应注入
    expect(() => clipboardManager.addPendingItem('A', 1)).not.toThrow();
  });
});

// ─── 列表渲染 ───────────────────────────────────────────

describe('列表渲染', () => {
  it('应按倒序渲染条目（最新在最前）', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    vi.advanceTimersByTime(10);
    clipboardManager.addPendingItem('B', 2);
    const listEl = document.getElementById('clipboard-pending-list')!;
    expect(listEl.children).toHaveLength(2);
    expect(listEl.children[0].querySelector('.clipboard-item-preview')?.textContent).toBe('B');
    expect(listEl.children[1].querySelector('.clipboard-item-preview')?.textContent).toBe('A');
  });

  it('应渲染长度标签', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('内容', 100);
    const listEl = document.getElementById('clipboard-pending-list')!;
    expect(listEl.children[0].querySelector('.clipboard-item-length')?.textContent).toBe('100字');
  });

  it('应渲染时间标签（刚刚）', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('内容', 10);
    const listEl = document.getElementById('clipboard-pending-list')!;
    expect(listEl.children[0].querySelector('.clipboard-item-time')?.textContent).toBe('刚刚');
  });

  it('应渲染时间标签（N 分钟前）', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('内容', 10);
    vi.advanceTimersByTime(5 * 60000); // 5 分钟
    // 触发 refresh 重新渲染时间
    clipboardManager.addPendingItem('触发刷新', 1);
    const listEl = document.getElementById('clipboard-pending-list')!;
    // 最新条目"触发刷新"在头部，"内容"在第二位
    expect(listEl.children[1].querySelector('.clipboard-item-time')?.textContent).toBe('5 分钟前');
  });

  it('较旧条目应渲染较旧标签 + clipboard-item-stale 类', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('旧内容', 10);
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1);
    // 触发 refresh 重新渲染（refresh 会调用 refreshStaleFlags）
    clipboardManager.addPendingItem('新内容', 1);
    const listEl = document.getElementById('clipboard-pending-list')!;
    // 第二个是"旧内容"（被移到头部后又新增"新内容"到头部）
    const oldItem = listEl.children[1];
    expect(oldItem.classList.contains('clipboard-item-stale')).toBe(true);
    expect(oldItem.querySelector('.clipboard-item-stale-tag')?.textContent).toBe('较旧');
  });

  it('每条目应渲染归档和忽略按钮', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('内容', 10);
    const listEl = document.getElementById('clipboard-pending-list')!;
    const item = listEl.children[0];
    expect(item.querySelector('.clipboard-item-btn-archive')).toBeTruthy();
    expect(item.querySelector('.clipboard-item-btn-ignore')).toBeTruthy();
  });

  it('预览文本应使用 textContent 防 XSS', () => {
    const { clipboardManager } = createManagers();
    const malicious = '<img src=x onerror=alert(1)>';
    clipboardManager.addPendingItem(malicious, malicious.length);
    const listEl = document.getElementById('clipboard-pending-list')!;
    // 预览元素内不应有 img 标签
    expect(listEl.querySelector('.clipboard-item-preview img')).toBeNull();
    // 应保留原始文本
    expect(listEl.querySelector('.clipboard-item-preview')?.textContent).toBe(malicious);
  });

  it('列表清空后应移除所有条目 DOM', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    clipboardManager.addPendingItem('B', 2);
    const listEl = document.getElementById('clipboard-pending-list')!;
    expect(listEl.children).toHaveLength(2);
    clipboardManager.clearPendingItems();
    expect(listEl.children).toHaveLength(0);
  });
});

// ─── 角标更新 ───────────────────────────────────────────

describe('角标更新', () => {
  it('count=0 时角标应隐藏', () => {
    createManagers();
    const badge = document.getElementById('clipboard-nav-badge')!;
    expect(badge.classList.contains('nav-badge-hidden')).toBe(true);
    expect(badge.textContent).toBe('');
  });

  it('count=1 时角标应显示数字 1', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const badge = document.getElementById('clipboard-nav-badge')!;
    expect(badge.classList.contains('nav-badge-hidden')).toBe(false);
    expect(badge.textContent).toBe('1');
  });

  it('count=15 时角标应显示数字 15', () => {
    const { clipboardManager } = createManagers();
    for (let i = 0; i < 15; i++) {
      clipboardManager.addPendingItem(`内容${i}`, 1);
    }
    const badge = document.getElementById('clipboard-nav-badge')!;
    expect(badge.textContent).toBe('15');
  });

  it(`count>${BADGE_MAX_DISPLAY} 时角标应显示 99+（通过 mock getPendingItems 绕过 FIFO 上限）`, () => {
    const { clipboardManager } = createManagers();
    // mock getPendingItems 返回 100 条假数据，模拟"未来 MAX_PENDING_ITEMS 调大后"的场景
    // updateBadge 使用 items.length 而非 getPendingCount，故需 mock getPendingItems
    const fakeItems = Array.from({ length: 100 }, (_, i) => ({
      id: `fake-${i}`,
      preview: `内容${i}`,
      length: 1,
      detectedAt: Date.now(),
      isStale: false,
    }));
    vi.spyOn(clipboardManager, 'getPendingItems').mockReturnValue(fakeItems);
    vi.spyOn(clipboardManager, 'getPendingCount').mockReturnValue(100);
    // 触发 refresh 重新渲染角标
    clipboardManager.addPendingItem('触发刷新', 1);
    const badge = document.getElementById('clipboard-nav-badge')!;
    expect(badge.textContent).toBe('99+');
  });

  it('存在较旧条目时角标应追加 nav-badge-stale 类', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    vi.advanceTimersByTime(STALE_THRESHOLD_MS + 1);
    // 触发 refresh（refresh 内会调用 refreshStaleFlags）
    clipboardManager.addPendingItem('B', 1);
    const badge = document.getElementById('clipboard-nav-badge')!;
    expect(badge.classList.contains('nav-badge-stale')).toBe(true);
  });

  it('无较旧条目时角标不应有 nav-badge-stale 类', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const badge = document.getElementById('clipboard-nav-badge')!;
    expect(badge.classList.contains('nav-badge-stale')).toBe(false);
  });

  it('条目全部移除后角标应回到隐藏状态', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    clipboardManager.clearPendingItems();
    const badge = document.getElementById('clipboard-nav-badge')!;
    expect(badge.classList.contains('nav-badge-hidden')).toBe(true);
    expect(badge.textContent).toBe('');
  });
});

// ─── 空状态切换 ─────────────────────────────────────────

describe('空状态切换', () => {
  it('列表为空时应显示空状态', () => {
    createManagers();
    const emptyState = document.getElementById('clipboard-empty-state')!;
    expect(emptyState.classList.contains('hidden')).toBe(false);
  });

  it('列表有内容时应隐藏空状态', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const emptyState = document.getElementById('clipboard-empty-state')!;
    expect(emptyState.classList.contains('hidden')).toBe(true);
  });

  it('清空后应重新显示空状态', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    clipboardManager.clearPendingItems();
    const emptyState = document.getElementById('clipboard-empty-state')!;
    expect(emptyState.classList.contains('hidden')).toBe(false);
  });
});

// ─── 批量操作按钮显隐 ───────────────────────────────────

describe('批量操作按钮显隐', () => {
  it('列表为空时应隐藏批量操作按钮', () => {
    createManagers();
    const actions = document.getElementById('clipboard-actions')!;
    expect(actions.classList.contains('clipboard-actions-hidden')).toBe(true);
  });

  it('列表有内容时应显示批量操作按钮', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const actions = document.getElementById('clipboard-actions')!;
    expect(actions.classList.contains('clipboard-actions-hidden')).toBe(false);
  });
});

// ─── 单条归档 ───────────────────────────────────────────

describe('单条归档', () => {
  it('点击归档按钮应乐观移除条目', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const listEl = document.getElementById('clipboard-pending-list')!;
    expect(listEl.children).toHaveLength(1);
    const archiveBtn = listEl.children[0].querySelector('.clipboard-item-btn-archive') as HTMLButtonElement;
    archiveBtn.click();
    // 同步：条目立即从列表移除
    expect(listEl.children).toHaveLength(0);
  });

  it('点击归档按钮应触发 clipboardAnalyze', async () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const listEl = document.getElementById('clipboard-pending-list')!;
    const archiveBtn = listEl.children[0].querySelector('.clipboard-item-btn-archive') as HTMLButtonElement;
    archiveBtn.click();
    // 异步：clipboardAnalyze 被调用
    await vi.waitFor(() => {
      expect(window.electronAPI.clipboardAnalyze).toHaveBeenCalledTimes(1);
    });
  });

  it('clipboardAnalyze 失败时应显示 error toast', async () => {
    window.electronAPI = {
      clipboardAnalyze: vi.fn().mockRejectedValue(new Error('网络错误')),
    } as unknown as typeof window.electronAPI;
    const { clipboardManager, host } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const listEl = document.getElementById('clipboard-pending-list')!;
    const archiveBtn = listEl.children[0].querySelector('.clipboard-item-btn-archive') as HTMLButtonElement;
    archiveBtn.click();
    await vi.waitFor(() => {
      expect(host._toast.__calls.some((c) => c.message === '归档失败，请稍后重试' && c.type === 'error')).toBe(true);
    });
  });
});

// ─── 单条忽略 ───────────────────────────────────────────

describe('单条忽略', () => {
  it('点击忽略按钮应移除条目', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const listEl = document.getElementById('clipboard-pending-list')!;
    expect(listEl.children).toHaveLength(1);
    const ignoreBtn = listEl.children[0].querySelector('.clipboard-item-btn-ignore') as HTMLButtonElement;
    ignoreBtn.click();
    expect(listEl.children).toHaveLength(0);
  });

  it('点击忽略按钮不应触发 clipboardAnalyze', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const listEl = document.getElementById('clipboard-pending-list')!;
    const ignoreBtn = listEl.children[0].querySelector('.clipboard-item-btn-ignore') as HTMLButtonElement;
    ignoreBtn.click();
    expect(window.electronAPI.clipboardAnalyze).not.toHaveBeenCalled();
  });
});

// ─── 批量归档 ───────────────────────────────────────────

describe('批量归档', () => {
  it('点击全部归档按钮应弹出二次确认', async () => {
    const { clipboardManager, host } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    document.getElementById('btn-clipboard-archive-all')!.click();
    await vi.waitFor(() => {
      expect(host._confirmCalls).toHaveLength(1);
    });
    expect(host._confirmCalls[0].title).toBe('全部归档');
  });

  it('用户确认后应清空列表 + 触发 clipboardAnalyze', async () => {
    const { clipboardManager } = createManagers({ confirmResult: true });
    clipboardManager.addPendingItem('A', 1);
    clipboardManager.addPendingItem('B', 2);
    document.getElementById('btn-clipboard-archive-all')!.click();
    await vi.waitFor(() => {
      expect(window.electronAPI.clipboardAnalyze).toHaveBeenCalledTimes(1);
    });
    expect(clipboardManager.getPendingCount()).toBe(0);
  });

  it('用户取消时不应清空列表也不应触发 clipboardAnalyze', async () => {
    const { clipboardManager } = createManagers({ confirmResult: false });
    clipboardManager.addPendingItem('A', 1);
    document.getElementById('btn-clipboard-archive-all')!.click();
    await vi.waitFor(() => {
      // 等待 promise 解决
    });
    expect(clipboardManager.getPendingCount()).toBe(1);
    expect(window.electronAPI.clipboardAnalyze).not.toHaveBeenCalled();
  });
});

// ─── 批量忽略 ───────────────────────────────────────────

describe('批量忽略', () => {
  it('点击全部忽略按钮应弹出二次确认（danger 风格）', async () => {
    const { clipboardManager, host } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    document.getElementById('btn-clipboard-ignore-all')!.click();
    await vi.waitFor(() => {
      expect(host._confirmCalls).toHaveLength(1);
    });
    expect(host._confirmCalls[0].title).toBe('全部忽略');
    expect(host._confirmCalls[0].danger).toBe(true);
  });

  it('用户确认后应清空列表 + 显示成功 toast', async () => {
    const { clipboardManager, host } = createManagers({ confirmResult: true });
    clipboardManager.addPendingItem('A', 1);
    clipboardManager.addPendingItem('B', 2);
    document.getElementById('btn-clipboard-ignore-all')!.click();
    await vi.waitFor(() => {
      expect(host._toast.__calls.some((c) => c.message === '已清空待处理列表' && c.type === 'success')).toBe(true);
    });
    expect(clipboardManager.getPendingCount()).toBe(0);
  });

  it('用户取消时不应清空列表', async () => {
    const { clipboardManager } = createManagers({ confirmResult: false });
    clipboardManager.addPendingItem('A', 1);
    document.getElementById('btn-clipboard-ignore-all')!.click();
    await vi.waitFor(() => {
      // 等待 promise 解决
    });
    expect(clipboardManager.getPendingCount()).toBe(1);
  });
});

// ─── 首次引导气泡 ───────────────────────────────────────

describe('首次引导气泡', () => {
  it('未关闭过 + 有内容时应显示引导气泡', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const tip = document.getElementById('clipboard-onboarding-tip')!;
    expect(tip.classList.contains('hidden')).toBe(false);
  });

  it('未关闭过 + 无内容时应隐藏引导气泡', () => {
    createManagers();
    const tip = document.getElementById('clipboard-onboarding-tip')!;
    expect(tip.classList.contains('hidden')).toBe(true);
  });

  it('点击关闭按钮应隐藏引导气泡 + 记录到 localStorage', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const tip = document.getElementById('clipboard-onboarding-tip')!;
    expect(tip.classList.contains('hidden')).toBe(false);
    document.getElementById('clipboard-onboarding-close')!.click();
    expect(tip.classList.contains('hidden')).toBe(true);
    expect(localStorage.getItem('memora:clipboard-onboarding-dismissed')).toBe('1');
  });

  it('localStorage 已记录 dismissed 时不应显示引导气泡', () => {
    localStorage.setItem('memora:clipboard-onboarding-dismissed', '1');
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const tip = document.getElementById('clipboard-onboarding-tip')!;
    expect(tip.classList.contains('hidden')).toBe(true);
  });

  it('已关闭后再添加新内容也不应再显示', () => {
    const { clipboardManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    document.getElementById('clipboard-onboarding-close')!.click();
    clipboardManager.addPendingItem('B', 2);
    const tip = document.getElementById('clipboard-onboarding-tip')!;
    expect(tip.classList.contains('hidden')).toBe(true);
  });
});

// ─── cleanup ────────────────────────────────────────────

describe('cleanup', () => {
  it('cleanup 后批量操作按钮点击不应再有响应', async () => {
    const { clipboardManager, panelManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    panelManager.cleanup();
    document.getElementById('btn-clipboard-archive-all')!.click();
    // fake timers 下用 microtask 推进，避免 setTimeout 永不执行
    await Promise.resolve();
    // 由于事件监听器已清理，clipboardAnalyze 不应被调用
    expect(window.electronAPI.clipboardAnalyze).not.toHaveBeenCalled();
  });

  it('cleanup 后单条归档按钮点击不应再有响应', () => {
    const { clipboardManager, panelManager } = createManagers();
    clipboardManager.addPendingItem('A', 1);
    const listEl = document.getElementById('clipboard-pending-list')!;
    const archiveBtn = listEl.children[0].querySelector('.clipboard-item-btn-archive') as HTMLButtonElement;
    panelManager.cleanup();
    archiveBtn.click();
    // 因为 events 已清理，点击不应触发 clipboardAnalyze
    // 注：clipboardAnalyze 是异步的，但同步点击后立即检查应未被调用
    expect(window.electronAPI.clipboardAnalyze).not.toHaveBeenCalled();
  });

  it('cleanup 不应抛错', () => {
    const { panelManager } = createManagers();
    expect(() => panelManager.cleanup()).not.toThrow();
  });
});

// ─── FIFO 淘汰场景下的列表渲染 ─────────────────────────

describe('FIFO 淘汰场景', () => {
  it(`超过 ${MAX_PENDING_ITEMS} 条时列表应只渲染最新 ${MAX_PENDING_ITEMS} 条`, () => {
    const { clipboardManager } = createManagers();
    // 添加 25 条（i=0~24），最新的是"内容24"
    for (let i = 0; i < MAX_PENDING_ITEMS + 5; i++) {
      clipboardManager.addPendingItem(`内容${i}`, 1);
    }
    const listEl = document.getElementById('clipboard-pending-list')!;
    expect(listEl.children).toHaveLength(MAX_PENDING_ITEMS);
    // 最新的"内容24"应在头部（FIFO 淘汰最旧的 5 条：内容0~内容4）
    expect(listEl.children[0].querySelector('.clipboard-item-preview')?.textContent).toBe('内容24');
  });
});
