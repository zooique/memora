/**
 * 审计日志面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：幂等保护 / DOM 元素获取 / null 降级 / refreshBtn + clearBtn 绑定
 * - load：成功渲染 / 空列表提示 / IPC 失败显示错误 / listEl 缺失静默降级
 * - render：计数更新 / 事件类型符号映射（5 已知 + 未知降级）/ 元信息拼接
 * - clear 流程：成功调用 clearAuditLog + reload / 失败显示错误条
 * - cleanup：EventTracker 清理后按钮不再触发
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - mock window.electronAPI.listAuditLog/clearAuditLog（异步 IPC）
 * - JSDOM 提供真实 DOM API（classList/appendChild/dispatchEvent）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AuditPanelManager } from '../../../electron/renderer/panels/auditPanelManager.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 审计面板完整 DOM 结构 */
const AUDIT_HTML = `
  <button id="btn-audit-refresh">刷新</button>
  <button id="btn-audit-clear">清空</button>
  <div id="audit-list"></div>
  <span id="audit-count">0</span>
`;

/** 审计条目类型 */
interface AuditEntry {
  type: string;
  path?: string;
  tool?: string;
  reason?: string;
  timestamp: string;
  sessionId: string;
}

/** 创建测试用审计条目 */
function createEntry(overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    type: 'path-allow',
    path: '/tmp/test.md',
    tool: 'read_file',
    reason: '白名单匹配',
    timestamp: '2026-07-01T10:30:00.000Z',
    sessionId: 'session-1',
    ...overrides,
  };
}

/** 创建 AuditPanelManager 实例（默认已 init） */
function createManager(opts?: { init?: boolean; html?: string }): AuditPanelManager {
  document.body.innerHTML = opts?.html ?? AUDIT_HTML;
  const manager = new AuditPanelManager();
  if (opts?.init !== false) {
    manager.init();
  }
  return manager;
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  // 初始化 window.electronAPI（listAuditLog 默认返回空数组）
  window.electronAPI = {
    listAuditLog: vi.fn().mockResolvedValue([]),
    clearAuditLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── init ────────────────────────────────────────────────

describe('init · 幂等与 DOM 获取', () => {
  it('应获取所有 DOM 元素引用并绑定 refresh 事件', () => {
    createManager();
    // 通过 click refreshBtn 验证引用已获取（触发 load）
    document.getElementById('btn-audit-refresh')!.click();
    expect(window.electronAPI.listAuditLog).toHaveBeenCalled();
  });

  it('二次调用 init 不应重复绑定事件（幂等保护）', async () => {
    const manager = createManager();
    manager.init(); // 二次调用
    document.getElementById('btn-audit-refresh')!.click();
    // listAuditLog 应只被调用一次（幂等后不重复绑定）
    expect(window.electronAPI.listAuditLog).toHaveBeenCalledTimes(1);
  });

  it('DOM 元素全部缺失时不应抛错（静默降级）', () => {
    document.body.innerHTML = '';
    const manager = new AuditPanelManager();
    manager.init();
    // 无 DOM 元素，init 应静默退出
    expect(window.electronAPI.listAuditLog).not.toHaveBeenCalled();
  });

  it('refreshBtn 缺失时不应绑定事件', () => {
    document.body.innerHTML = `
      <div id="audit-list"></div>
      <span id="audit-count">0</span>
      <button id="btn-audit-clear">清空</button>
    `;
    const manager = new AuditPanelManager();
    manager.init();
    expect(window.electronAPI.listAuditLog).not.toHaveBeenCalled();
  });

  it('clearBtn 应绑定清空事件', async () => {
    createManager();
    document.getElementById('btn-audit-clear')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.electronAPI.clearAuditLog).toHaveBeenCalled();
  });
});

// ─── load ────────────────────────────────────────────────

describe('load · 成功与失败', () => {
  it('成功时应渲染条目到列表', async () => {
    const entries = [
      createEntry({ type: 'path-allow' }),
      createEntry({ type: 'write-confirm' }),
    ];
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue(entries);
    const manager = createManager();
    await manager.load();
    expect(document.querySelectorAll('#audit-list .audit-item').length).toBe(2);
  });

  it('应以 LOAD_LIMIT=50 调用 listAuditLog', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([]);
    const manager = createManager();
    await manager.load();
    expect(window.electronAPI.listAuditLog).toHaveBeenCalledWith(50);
  });

  it('空数组应显示"暂无审计记录"提示', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('#audit-list .profile-empty')!.textContent).toBe('暂无审计记录');
  });

  it('失败时应显示错误提示', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockRejectedValue(new Error('网络错误'));
    const manager = createManager();
    await manager.load();
    const errorEl = document.querySelector('#audit-list .profile-empty');
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent).toContain('加载失败');
  });

  it('listEl 缺失时 load 应静默退出', async () => {
    document.body.innerHTML = `
      <button id="btn-audit-refresh">刷新</button>
      <span id="audit-count">0</span>
    `;
    const manager = new AuditPanelManager();
    manager.init();
    await expect(manager.load()).resolves.toBeUndefined();
  });
});

// ─── render · 计数与符号映射 ─────────────────────────────

describe('render · 计数更新', () => {
  it('应更新 audit-count 文本为条目数', async () => {
    const entries = [createEntry(), createEntry(), createEntry()];
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue(entries);
    const manager = createManager();
    await manager.load();
    expect(document.getElementById('audit-count')!.textContent).toBe('3');
  });
});

describe('render · 事件类型符号映射', () => {
  it('path-allow 应映射为 ✓', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([createEntry({ type: 'path-allow' })]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.audit-item-name')!.textContent).toContain('✓');
  });

  it('path-deny 应映射为 ✗', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([createEntry({ type: 'path-deny' })]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.audit-item-name')!.textContent).toContain('✗');
  });

  it('write-confirm 应映射为 ⚑', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([createEntry({ type: 'write-confirm' })]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.audit-item-name')!.textContent).toContain('⚑');
  });

  it('write-auto 应映射为 ◯', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([createEntry({ type: 'write-auto' })]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.audit-item-name')!.textContent).toContain('◯');
  });

  it('write-decline 应映射为 ↩', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([createEntry({ type: 'write-decline' })]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.audit-item-name')!.textContent).toContain('↩');
  });

  it('未知类型应降级为 ?', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([createEntry({ type: 'unknown-event' })]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.audit-item-name')!.textContent).toContain('?');
  });
});

describe('render · 元信息拼接', () => {
  it('应拼接 path/tool/reason 三项（用 · 分隔）', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([
      createEntry({ path: '/a.md', tool: 'write_file', reason: '用户确认' }),
    ]);
    const manager = createManager();
    await manager.load();
    const content = document.querySelector('.audit-item-content')!.textContent;
    expect(content).toContain('路径: /a.md');
    expect(content).toContain('工具: write_file');
    expect(content).toContain('原因: 用户确认');
    expect(content).toContain('·');
  });

  it('无 path/tool/reason 时应显示 —', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([
      createEntry({ path: undefined, tool: undefined, reason: undefined }),
    ]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.audit-item-content')!.textContent).toBe('—');
  });

  it('应使用 textContent 防 XSS', async () => {
    const malicious = '<img src=x onerror=alert(1)>';
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([
      createEntry({ type: malicious, path: malicious }),
    ]);
    const manager = createManager();
    await manager.load();
    const nameEl = document.querySelector('.audit-item-name')!;
    expect(nameEl.querySelector('img')).toBeNull();
  });
});

// ─── clear 流程 ──────────────────────────────────────────

describe('clear 流程', () => {
  it('click clearBtn 成功应调用 clearAuditLog 并 reload', async () => {
    window.electronAPI.listAuditLog = vi.fn().mockResolvedValue([createEntry()]);
    window.electronAPI.clearAuditLog = vi.fn().mockResolvedValue(undefined);
    const manager = createManager();
    await manager.load();
    expect(window.electronAPI.listAuditLog).toHaveBeenCalledTimes(1);

    document.getElementById('btn-audit-clear')!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(window.electronAPI.clearAuditLog).toHaveBeenCalled();
    // reload 应再次调用 listAuditLog
    expect(window.electronAPI.listAuditLog).toHaveBeenCalledTimes(2);
  });

  it('click clearBtn 失败应显示错误条', async () => {
    window.electronAPI.clearAuditLog = vi.fn().mockRejectedValue(new Error('清除失败'));
    createManager();
    document.getElementById('btn-audit-clear')!.click();
    await Promise.resolve();
    await Promise.resolve();

    const errorEl = document.querySelector('#audit-list .profile-empty');
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent).toBe('清空审计日志失败');
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup', () => {
  it('cleanup 后 refreshBtn click 不应触发 load', () => {
    const manager = createManager();
    manager.cleanup();
    document.getElementById('btn-audit-refresh')!.click();
    expect(window.electronAPI.listAuditLog).not.toHaveBeenCalled();
  });

  it('cleanup 后 clearBtn click 不应触发 clearAuditLog', async () => {
    const manager = createManager();
    manager.cleanup();
    document.getElementById('btn-audit-clear')!.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.electronAPI.clearAuditLog).not.toHaveBeenCalled();
  });
});
