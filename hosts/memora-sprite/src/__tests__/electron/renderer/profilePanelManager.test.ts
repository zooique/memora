/**
 * 用户画像面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：幂等保护 / DOM 元素获取 / null 降级 / refreshBtn 绑定
 * - load：成功渲染 / 失败显示错误条 / IPC 调用
 * - render：按 confirmed 分组 / 计数更新
 * - renderList：空列表提示 / null 容器降级 / 清空旧内容
 * - createEntryCard：类别标签映射（5 已知 + 未知降级）/ 头部渲染 /
 *   待确认按钮（确认/拒绝）/ 已确认按钮（删除）/ 防 XSS
 * - 确认流程：成功移除 / 失败恢复按钮
 * - 拒绝流程：成功移除 / 失败恢复按钮
 * - 删除流程：成功移除 / 失败恢复按钮
 * - cleanup：EventTracker 清理
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - mock window.electronAPI.listUserProfile/confirmUserProfile/rejectUserProfile（异步 IPC）
 * - JSDOM 提供真实 DOM API（classList/appendChild/querySelector/dispatchEvent）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProfilePanelManager } from '../../../electron/renderer/panels/profilePanelManager.js';
import type { UserProfileEntryPayload } from '../../../electron/preload.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 画像面板完整 DOM 结构 */
const PROFILE_HTML = `
  <button id="btn-profile-refresh">刷新</button>
  <div id="profile-pending-list"></div>
  <div id="profile-confirmed-list"></div>
  <span id="profile-pending-count">0</span>
  <span id="profile-confirmed-count">0</span>
`;

/** 创建测试用画像条目 */
function createEntry(overrides?: Partial<UserProfileEntryPayload>): UserProfileEntryPayload {
  return {
    id: 'profile:user-profile-preference-ts-style',
    category: 'preference',
    value: '偏好函数式风格',
    source: '第 3 轮对话',
    weight: 0.85,
    confirmed: false,
    updatedAt: '2026-06-27T00:00:00.000Z',
    ...overrides,
  };
}

/** 创建 ProfilePanelManager 实例（已 init） */
function createManager(opts?: { init?: boolean; html?: string }): ProfilePanelManager {
  document.body.innerHTML = opts?.html ?? PROFILE_HTML;
  const manager = new ProfilePanelManager();
  if (opts?.init !== false) {
    manager.init();
  }
  return manager;
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  // 初始化 window.electronAPI（listUserProfile 默认返回空，单测可覆盖）
  window.electronAPI = {
    listUserProfile: vi.fn().mockResolvedValue({ entries: [] }),
    confirmUserProfile: vi.fn().mockResolvedValue(undefined),
    rejectUserProfile: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── init ────────────────────────────────────────────────

describe('init · 幂等与 DOM 获取', () => {
  it('应获取所有 DOM 元素引用', () => {
    createManager();
    // 通过 click refreshBtn 验证引用已获取（触发 load）
    document.getElementById('btn-profile-refresh')!.click();
    expect(window.electronAPI.listUserProfile).toHaveBeenCalled();
  });

  it('二次调用 init 不应重复绑定事件（幂等保护）', async () => {
    const manager = createManager();
    manager.init(); // 二次调用
    document.getElementById('btn-profile-refresh')!.click();
    // listUserProfile 应只被调用一次（幂等后不重复绑定）
    expect(window.electronAPI.listUserProfile).toHaveBeenCalledTimes(1);
  });

  it('DOM 元素全部缺失时不应抛错（静默降级）', () => {
    document.body.innerHTML = '';
    const manager = new ProfilePanelManager();
    manager.init();
    // 无 DOM 元素，init 应静默退出，无任何副作用
    expect(window.electronAPI.listUserProfile).not.toHaveBeenCalled();
  });

  it('refreshBtn 缺失时不应绑定事件', () => {
    document.body.innerHTML = `
      <div id="profile-pending-list"></div>
      <div id="profile-confirmed-list"></div>
      <span id="profile-pending-count">0</span>
      <span id="profile-confirmed-count">0</span>
    `;
    const manager = new ProfilePanelManager();
    manager.init();
    // 无 refreshBtn，不应有任何 IPC 调用
    expect(window.electronAPI.listUserProfile).not.toHaveBeenCalled();
  });
});

// ─── load ────────────────────────────────────────────────

describe('load · 成功与失败', () => {
  it('成功时应调用 render 渲染条目', async () => {
    const entries = [
      createEntry({ id: 'p1', confirmed: false }),
      createEntry({ id: 'c1', confirmed: true }),
    ];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    // 应渲染到对应列表
    expect(document.querySelectorAll('#profile-pending-list .profile-card').length).toBe(1);
    expect(document.querySelectorAll('#profile-confirmed-list .profile-card').length).toBe(1);
  });

  it('失败时应显示错误提示', async () => {
    window.electronAPI.listUserProfile = vi.fn().mockRejectedValue(new Error('网络错误'));
    const manager = createManager();
    await manager.load();
    // pendingList 应显示错误条
    const errorEl = document.querySelector('#profile-pending-list .profile-error');
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent).toBe('加载失败，请点击刷新重试');
  });

  it('失败 + pendingList 缺失时不应抛错', async () => {
    window.electronAPI.listUserProfile = vi.fn().mockRejectedValue(new Error('网络错误'));
    document.body.innerHTML = '<button id="btn-profile-refresh">刷新</button>';
    const manager = new ProfilePanelManager();
    manager.init();
    await expect(manager.load()).resolves.toBeUndefined();
  });
});

// ─── render · 分组与计数 ─────────────────────────────────

describe('render · 分组与计数', () => {
  it('应按 confirmed 字段分组到对应列表', async () => {
    const entries = [
      createEntry({ id: 'p1', confirmed: false }),
      createEntry({ id: 'p2', confirmed: false }),
      createEntry({ id: 'c1', confirmed: true }),
    ];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    expect(document.querySelectorAll('#profile-pending-list .profile-card').length).toBe(2);
    expect(document.querySelectorAll('#profile-confirmed-list .profile-card').length).toBe(1);
  });

  it('应更新 pendingCount 和 confirmedCount 文本', async () => {
    const entries = [
      createEntry({ id: 'p1', confirmed: false }),
      createEntry({ id: 'p2', confirmed: false }),
      createEntry({ id: 'c1', confirmed: true }),
      createEntry({ id: 'c2', confirmed: true }),
      createEntry({ id: 'c3', confirmed: true }),
    ];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    expect(document.getElementById('profile-pending-count')!.textContent).toBe('2');
    expect(document.getElementById('profile-confirmed-count')!.textContent).toBe('3');
  });

  it('空数组应显示空列表提示', async () => {
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries: [] });
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('#profile-pending-list .profile-empty')!.textContent).toBe('暂无待确认条目');
    expect(document.querySelector('#profile-confirmed-list .profile-empty')!.textContent).toBe('暂无已确认条目');
  });

  it('renderList 容器为 null 时应静默退出', async () => {
    // 缺失 pendingList 和 confirmedList
    document.body.innerHTML = `
      <button id="btn-profile-refresh">刷新</button>
      <span id="profile-pending-count">0</span>
      <span id="profile-confirmed-count">0</span>
    `;
    const entries = [createEntry({ confirmed: false })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = new ProfilePanelManager();
    manager.init();
    await expect(manager.load()).resolves.toBeUndefined();
  });
});

// ─── createEntryCard · 类别标签映射 ──────────────────────

describe('createEntryCard · 类别标签映射', () => {
  it('identity 应显示"身份"', async () => {
    const entries = [createEntry({ category: 'identity' })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.profile-category')!.textContent).toBe('身份');
  });

  it('preference 应显示"偏好"', async () => {
    const entries = [createEntry({ category: 'preference' })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.profile-category')!.textContent).toBe('偏好');
  });

  it('expertise 应显示"专长"', async () => {
    const entries = [createEntry({ category: 'expertise' })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.profile-category')!.textContent).toBe('专长');
  });

  it('habit 应显示"习惯"', async () => {
    const entries = [createEntry({ category: 'habit' })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.profile-category')!.textContent).toBe('习惯');
  });

  it('history 应显示"历史"', async () => {
    const entries = [createEntry({ category: 'history' })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.profile-category')!.textContent).toBe('历史');
  });

  it('未知类别应降级显示原始 category 值', async () => {
    // 类型断言绕过 TS 检查以测试运行时降级
    const entries = [createEntry({ category: 'unknown' as UserProfileEntryPayload['category'] })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.profile-category')!.textContent).toBe('unknown');
  });
});

// ─── createEntryCard · 头部与内容 ───────────────────────

describe('createEntryCard · 头部与内容', () => {
  it('应显示来源信息', async () => {
    const entries = [createEntry({ source: '第 5 轮对话' })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.profile-source')!.textContent).toBe('来源: 第 5 轮对话');
  });

  it('应显示更新时间（formatTimeAgo）', async () => {
    const entries = [createEntry({ updatedAt: '2026-06-27T00:00:00.000Z' })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    // formatTimeAgo 会返回相对时间（如"刚刚"/"X 分钟前"），仅验证非空
    expect(document.querySelector('.profile-updated')!.textContent).not.toBe('');
  });

  it('应显示画像值（防 XSS）', async () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const entries = [createEntry({ value: malicious })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    const valueEl = document.querySelector('.profile-value')!;
    expect(valueEl.textContent).toBe(malicious);
    expect(valueEl.querySelector('img')).toBeNull();
  });

  it('应设置 data-entry-id 属性', async () => {
    const entries = [createEntry({ id: 'profile:test-id' })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    const card = document.querySelector('.profile-card') as HTMLElement;
    expect(card.dataset.entryId).toBe('profile:test-id');
  });
});

// ─── createEntryCard · 按钮渲染 ─────────────────────────

describe('createEntryCard · 按钮渲染', () => {
  it('待确认条目应显示确认 + 拒绝按钮', async () => {
    const entries = [createEntry({ confirmed: false })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    const acceptBtn = document.querySelector('#profile-pending-list .profile-btn.accept') as HTMLButtonElement;
    const rejectBtn = document.querySelector('#profile-pending-list .profile-btn.reject') as HTMLButtonElement;
    expect(acceptBtn).not.toBeNull();
    expect(acceptBtn.textContent).toBe('确认');
    expect(rejectBtn).not.toBeNull();
    expect(rejectBtn.textContent).toBe('拒绝');
  });

  it('已确认条目应显示删除按钮', async () => {
    const entries = [createEntry({ confirmed: true })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    const deleteBtn = document.querySelector('#profile-confirmed-list .profile-btn.reject') as HTMLButtonElement;
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn.textContent).toBe('删除');
  });
});

// ─── 确认流程 ────────────────────────────────────────────

describe('确认流程 · 待确认条目', () => {
  it('click 确认按钮成功应移除卡片', async () => {
    const entries = [createEntry({ id: 'profile:confirm-test', confirmed: false })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    const acceptBtn = document.querySelector('#profile-pending-list .profile-btn.accept') as HTMLButtonElement;
    acceptBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.electronAPI.confirmUserProfile).toHaveBeenCalledWith('profile:confirm-test');
    // 卡片应被移除
    expect(document.querySelectorAll('#profile-pending-list .profile-card').length).toBe(0);
  });

  // 验证 loading 中状态（disabled + 文案）
  it('click 确认按钮时应显示 loading 状态（disabled + "处理中..."）', async () => {
    const entries = [createEntry({ confirmed: false })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    // 用未 resolve 的 promise 锁定 loading 中状态
    let resolveConfirm: () => void;
    window.electronAPI.confirmUserProfile = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => { resolveConfirm = resolve; }),
    );
    const manager = createManager();
    await manager.load();
    const acceptBtn = document.querySelector('#profile-pending-list .profile-btn.accept') as HTMLButtonElement;
    acceptBtn.click();
    await Promise.resolve();

    // loading 中状态
    expect(acceptBtn.disabled).toBe(true);
    expect(acceptBtn.textContent).toBe('处理中...');

    // 恢复
    resolveConfirm!();
    await Promise.resolve();
    await Promise.resolve();
  });

  it('click 确认按钮失败应恢复按钮状态', async () => {
    const entries = [createEntry({ confirmed: false })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    window.electronAPI.confirmUserProfile = vi.fn().mockRejectedValue(new Error('IPC 失败'));
    const manager = createManager();
    await manager.load();
    const acceptBtn = document.querySelector('#profile-pending-list .profile-btn.accept') as HTMLButtonElement;
    const rejectBtn = document.querySelector('#profile-pending-list .profile-btn.reject') as HTMLButtonElement;
    acceptBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(acceptBtn.disabled).toBe(false);
    expect(rejectBtn.disabled).toBe(false);
    expect(acceptBtn.textContent).toBe('确认');
    // 卡片不应被移除
    expect(document.querySelectorAll('#profile-pending-list .profile-card').length).toBe(1);
  });
});

// ─── 拒绝流程 ────────────────────────────────────────────

describe('拒绝流程 · 待确认条目', () => {
  it('click 拒绝按钮成功应移除卡片', async () => {
    const entries = [createEntry({ id: 'profile:reject-test', confirmed: false })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    const rejectBtn = document.querySelector('#profile-pending-list .profile-btn.reject') as HTMLButtonElement;
    rejectBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.electronAPI.rejectUserProfile).toHaveBeenCalledWith('profile:reject-test');
    expect(document.querySelectorAll('#profile-pending-list .profile-card').length).toBe(0);
  });

  it('click 拒绝按钮失败应恢复按钮状态', async () => {
    const entries = [createEntry({ confirmed: false })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    window.electronAPI.rejectUserProfile = vi.fn().mockRejectedValue(new Error('IPC 失败'));
    const manager = createManager();
    await manager.load();
    const rejectBtn = document.querySelector('#profile-pending-list .profile-btn.reject') as HTMLButtonElement;
    const acceptBtn = document.querySelector('#profile-pending-list .profile-btn.accept') as HTMLButtonElement;
    rejectBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(rejectBtn.disabled).toBe(false);
    expect(acceptBtn.disabled).toBe(false);
    expect(document.querySelectorAll('#profile-pending-list .profile-card').length).toBe(1);
  });
});

// ─── 删除流程 ────────────────────────────────────────────

describe('删除流程 · 已确认条目', () => {
  it('click 删除按钮成功应移除卡片', async () => {
    const entries = [createEntry({ id: 'profile:delete-test', confirmed: true })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    const deleteBtn = document.querySelector('#profile-confirmed-list .profile-btn.reject') as HTMLButtonElement;
    deleteBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.electronAPI.rejectUserProfile).toHaveBeenCalledWith('profile:delete-test');
    expect(document.querySelectorAll('#profile-confirmed-list .profile-card').length).toBe(0);
  });

  it('click 删除按钮失败应恢复按钮状态', async () => {
    const entries = [createEntry({ confirmed: true })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    window.electronAPI.rejectUserProfile = vi.fn().mockRejectedValue(new Error('IPC 失败'));
    const manager = createManager();
    await manager.load();
    const deleteBtn = document.querySelector('#profile-confirmed-list .profile-btn.reject') as HTMLButtonElement;
    deleteBtn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(deleteBtn.disabled).toBe(false);
    expect(deleteBtn.textContent).toBe('删除');
    expect(document.querySelectorAll('#profile-confirmed-list .profile-card').length).toBe(1);
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup', () => {
  it('cleanup 后 refreshBtn click 不应触发 load', () => {
    const manager = createManager();
    manager.cleanup();
    document.getElementById('btn-profile-refresh')!.click();
    expect(window.electronAPI.listUserProfile).not.toHaveBeenCalled();
  });

  it('cleanup 后条目按钮 click 不应触发 IPC', async () => {
    const entries = [createEntry({ confirmed: false })];
    window.electronAPI.listUserProfile = vi.fn().mockResolvedValue({ entries });
    const manager = createManager();
    await manager.load();
    // cleanup 前获取按钮引用
    const acceptBtn = document.querySelector('#profile-pending-list .profile-btn.accept') as HTMLButtonElement;
    manager.cleanup();
    acceptBtn.click();
    await Promise.resolve();
    expect(window.electronAPI.confirmUserProfile).not.toHaveBeenCalled();
  });
});
