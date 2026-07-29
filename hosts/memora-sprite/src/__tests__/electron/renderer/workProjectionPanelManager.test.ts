/**
 * 作品投影面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：幂等保护 / DOM 元素获取 / null 降级 / refreshBtn 绑定
 * - load：成功渲染卡片 / 空列表提示 / IPC 失败显示错误
 * - render：计数更新 / 空列表双层提示
 * - createProjectionCard：文件图标映射 / 文件名提取 / 概要 / 结构列表 /
 *   关键决策列表 / 展开折叠按钮 / 防 XSS
 * - cleanup：EventTracker 清理后按钮不再触发
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - mock window.electronAPI.listWorkProjections（异步 IPC）
 * - JSDOM 提供真实 DOM API（classList/appendChild/dispatchEvent）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkProjectionPanelManager } from '../../../electron/renderer/panels/workProjectionPanelManager.js';
import type { WorkProjectionPayload } from '../../../electron/preload.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 作品投影面板完整 DOM 结构 */
const WORK_HTML = `
  <button id="btn-work-projection-refresh">刷新</button>
  <div id="work-projection-list"></div>
  <span id="work-projection-count">0</span>
`;

/** 创建测试用投影条目 */
function createEntry(overrides?: Partial<WorkProjectionPayload>): WorkProjectionPayload {
  return {
    id: 'work-proj-test-file',
    sourcePath: '/project/src/index.ts',
    fileHash: 'abc123',
    summary: '这是一个测试文件的概要摘要',
    structure: ['模块 A', '模块 B'],
    keyDecisions: ['决策 1：使用 ESM', '决策 2：启用严格模式'],
    updatedAt: '2026-07-01T10:30:00.000Z',
    ...overrides,
  };
}

/** 创建 WorkProjectionPanelManager 实例（默认已 init） */
function createManager(opts?: { init?: boolean; html?: string }): WorkProjectionPanelManager {
  document.body.innerHTML = opts?.html ?? WORK_HTML;
  const manager = new WorkProjectionPanelManager();
  if (opts?.init !== false) {
    manager.init();
  }
  return manager;
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  // 初始化 window.electronAPI（listWorkProjections 默认返回空数组）
  window.electronAPI = {
    listWorkProjections: vi.fn().mockResolvedValue([]),
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
    document.getElementById('btn-work-projection-refresh')!.click();
    expect(window.electronAPI.listWorkProjections).toHaveBeenCalled();
  });

  it('二次调用 init 不应重复绑定事件（幂等保护）', async () => {
    const manager = createManager();
    manager.init(); // 二次调用
    document.getElementById('btn-work-projection-refresh')!.click();
    expect(window.electronAPI.listWorkProjections).toHaveBeenCalledTimes(1);
  });

  it('DOM 元素全部缺失时不应抛错（静默降级）', () => {
    document.body.innerHTML = '';
    const manager = new WorkProjectionPanelManager();
    manager.init();
    expect(window.electronAPI.listWorkProjections).not.toHaveBeenCalled();
  });

  it('refreshBtn 缺失时不应绑定事件', () => {
    document.body.innerHTML = `
      <div id="work-projection-list"></div>
      <span id="work-projection-count">0</span>
    `;
    const manager = new WorkProjectionPanelManager();
    manager.init();
    expect(window.electronAPI.listWorkProjections).not.toHaveBeenCalled();
  });
});

// ─── load ────────────────────────────────────────────────

describe('load · 成功与失败', () => {
  it('成功时应渲染卡片到列表', async () => {
    const entries = [createEntry(), createEntry({ id: 'work-proj-2' })];
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue(entries);
    const manager = createManager();
    await manager.load();
    expect(document.querySelectorAll('#work-projection-list .work-projection-card').length).toBe(2);
  });

  it('空数组应显示空列表提示和引导文字', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.empty-state')!.textContent).toBe('暂无作品投影');
    expect(document.querySelector('.work-projection-empty-hint')!.textContent).toContain('精灵');
  });

  it('失败时应显示错误提示（体系 B：.error-state 四件套）', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockRejectedValue(new Error('网络错误'));
    const manager = createManager();
    await manager.load();
    // 错误态对齐体系 B（.error-state + .error-icon + .error-message + .error-retry-btn）
    const errorEl = document.querySelector('.error-state');
    expect(errorEl).not.toBeNull();
    expect(errorEl!.querySelector('.error-message')?.textContent).toContain('加载作品投影失败');
    // 重试按钮存在
    expect(errorEl!.querySelector('.error-retry-btn')).not.toBeNull();
  });

  it('listEl 缺失时 load 不应抛错', async () => {
    document.body.innerHTML = `
      <button id="btn-work-projection-refresh">刷新</button>
      <span id="work-projection-count">0</span>
    `;
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([createEntry()]);
    const manager = new WorkProjectionPanelManager();
    manager.init();
    await expect(manager.load()).resolves.toBeUndefined();
  });
});

// ─── render · 计数更新 ───────────────────────────────────

describe('render · 计数更新', () => {
  it('应更新 work-projection-count 文本为条目数', async () => {
    const entries = [createEntry(), createEntry(), createEntry()];
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue(entries);
    const manager = createManager();
    await manager.load();
    expect(document.getElementById('work-projection-count')!.textContent).toBe('3');
  });
});

// ─── createProjectionCard · 图标映射 ─────────────────────

describe('createProjectionCard · 文件图标映射', () => {
  it('.ts 文件应映射为 icon-file-ts SVG', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ sourcePath: '/a/b/c.ts' }),
    ]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.work-projection-icon')!.innerHTML).toContain('icon-file-ts');
  });

  it('.py 文件应映射为 icon-file-py SVG', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ sourcePath: '/a/b/c.py' }),
    ]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.work-projection-icon')!.innerHTML).toContain('icon-file-py');
  });

  it('.md 文件应映射为 icon-file-md SVG', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ sourcePath: '/a/b/README.md' }),
    ]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.work-projection-icon')!.innerHTML).toContain('icon-file-md');
  });

  it('未知扩展名应降级为 icon-file-default SVG', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ sourcePath: '/a/b/c.unknown' }),
    ]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.work-projection-icon')!.innerHTML).toContain('icon-file-default');
  });
});

// ─── createProjectionCard · 头部与概要 ───────────────────

describe('createProjectionCard · 头部与概要', () => {
  it('应从完整路径提取文件名', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ sourcePath: '/project/src/components/Button.tsx' }),
    ]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.work-projection-filename')!.textContent).toBe('Button.tsx');
  });

  it('Windows 路径应正确提取文件名', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ sourcePath: 'C:\\project\\src\\index.ts' }),
    ]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.work-projection-filename')!.textContent).toBe('index.ts');
  });

  it('文件名应设置 title 为完整路径（tooltip）', async () => {
    const fullPath = '/very/long/path/to/file.ts';
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ sourcePath: fullPath }),
    ]);
    const manager = createManager();
    await manager.load();
    expect((document.querySelector('.work-projection-filename') as HTMLElement)!.title).toBe(fullPath);
  });

  it('应显示概要文本', async () => {
    const summary = '这是文件的概要内容';
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ summary }),
    ]);
    const manager = createManager();
    await manager.load();
    expect(document.querySelector('.work-projection-summary')!.textContent).toBe(summary);
  });

  it('应显示相对更新时间（formatTimeAgo）', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ updatedAt: '2026-07-01T10:30:00.000Z' }),
    ]);
    const manager = createManager();
    await manager.load();
    // formatTimeAgo 返回相对时间（非空即可，具体值依赖于当前时间）
    expect(document.querySelector('.work-projection-updated')!.textContent).not.toBe('');
  });
});

// ─── createProjectionCard · 结构与决策 ───────────────────

describe('createProjectionCard · 结构与关键决策', () => {
  it('应渲染结构列表项', async () => {
    // 清空 keyDecisions 以避免两节 li 互相干扰
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ structure: ['模块 A', '模块 B', '模块 C'], keyDecisions: [] }),
    ]);
    const manager = createManager();
    await manager.load();
    const structureItems = document.querySelectorAll('.work-projection-details .work-projection-list li');
    expect(structureItems.length).toBe(3);
    expect(structureItems[0]!.textContent).toBe('模块 A');
  });

  it('应渲染关键决策列表项', async () => {
    // 清空 structure 以避免两节 li 互相干扰
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ structure: [], keyDecisions: ['决策 1', '决策 2'] }),
    ]);
    const manager = createManager();
    await manager.load();
    const decisionItems = document.querySelectorAll('.work-projection-details .work-projection-list li');
    expect(decisionItems.length).toBe(2);
    expect(decisionItems[0]!.textContent).toBe('决策 1');
  });

  it('空 structure 不应渲染结构节', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ structure: [], keyDecisions: ['决策 1'] }),
    ]);
    const manager = createManager();
    await manager.load();
    // 只有决策节，无结构节
    const sections = document.querySelectorAll('.work-projection-section');
    expect(sections.length).toBe(1);
    expect(sections[0]!.querySelector('.work-projection-section-title')!.textContent).toBe('关键决策');
  });

  it('空 keyDecisions 不应渲染决策节', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ structure: ['结构 1'], keyDecisions: [] }),
    ]);
    const manager = createManager();
    await manager.load();
    const sections = document.querySelectorAll('.work-projection-section');
    expect(sections.length).toBe(1);
    expect(sections[0]!.querySelector('.work-projection-section-title')!.textContent).toBe('结构');
  });

  it('应使用 textContent 防 XSS', async () => {
    const malicious = '<img src=x onerror=alert(1)>';
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([
      createEntry({ summary: malicious, structure: [malicious] }),
    ]);
    const manager = createManager();
    await manager.load();
    const summaryEl = document.querySelector('.work-projection-summary')!;
    expect(summaryEl.querySelector('img')).toBeNull();
  });
});

// ─── createProjectionCard · 展开/折叠 ────────────────────

describe('createProjectionCard · 展开/折叠按钮', () => {
  it('初始状态应显示"展开详情"且 details hidden', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([createEntry()]);
    const manager = createManager();
    await manager.load();
    const expandBtn = document.querySelector('.work-projection-expand-btn') as HTMLButtonElement;
    const details = document.querySelector('.work-projection-details') as HTMLElement;
    expect(expandBtn.textContent).toBe('展开详情');
    expect(details.hidden).toBe(true);
  });

  it('click 展开按钮应切换 details 可见性和按钮文本', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([createEntry()]);
    const manager = createManager();
    await manager.load();
    const expandBtn = document.querySelector('.work-projection-expand-btn') as HTMLButtonElement;
    const details = document.querySelector('.work-projection-details') as HTMLElement;

    // 展开
    expandBtn.click();
    expect(details.hidden).toBe(false);
    expect(expandBtn.textContent).toBe('收起详情');

    // 折叠
    expandBtn.click();
    expect(details.hidden).toBe(true);
    expect(expandBtn.textContent).toBe('展开详情');
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup', () => {
  it('cleanup 后 refreshBtn click 不应触发 load', () => {
    const manager = createManager();
    manager.cleanup();
    document.getElementById('btn-work-projection-refresh')!.click();
    expect(window.electronAPI.listWorkProjections).not.toHaveBeenCalled();
  });

  it('cleanup 后展开按钮 click 不应再受 EventTracker 管理', async () => {
    window.electronAPI.listWorkProjections = vi.fn().mockResolvedValue([createEntry()]);
    const manager = createManager();
    await manager.load();
    const expandBtn = document.querySelector('.work-projection-expand-btn') as HTMLButtonElement;
    const details = document.querySelector('.work-projection-details') as HTMLElement;
    manager.cleanup();
    // cleanup 后 expandBtn 事件监听器已被移除，click 不应切换 hidden 状态
    const initialHidden = details.hidden;
    expandBtn.click();
    expect(details.hidden).toBe(initialHidden);
  });
});
