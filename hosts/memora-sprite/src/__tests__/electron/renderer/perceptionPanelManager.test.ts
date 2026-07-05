/**
 * 感知面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - toggle：打开面板（拉取快照 + 刷新展示） / 关闭面板（动画流程）
 * - close：仅关闭面板，不拉取快照
 * - bindStatusBarToggle：click / Enter / Space 触发 toggle
 * - bindCloseButton：点击关闭
 * - bindMetricsToggle：折叠/展开 metrics 区域
 * - bindRecommendationClick：点击推荐记忆 → 跳转
 * - cleanup：清理事件监听器
 *
 * Mock 策略：
 * - Mock PerceptionPanelHost（triggerMemoryRecall / update*Display）
 * - Mock window.electronAPI.getPerceptionSnapshot
 * - DOM 元素手动构建（perception-panel + 各子区域）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PerceptionPanelManager } from '../../../electron/renderer/panels/perceptionPanelManager.js';
import type { PerceptionPanelHost } from '../../../electron/renderer/panels/perceptionPanelManager.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 Mock PerceptionPanelHost */
function createMockHost(): PerceptionPanelHost {
  return {
    triggerMemoryRecall: vi.fn(),
    updateAffectDisplay: vi.fn(),
    updateRapportDisplay: vi.fn(),
    updateContextDisplay: vi.fn(),
    updatePatternsDisplay: vi.fn(),
    updateProactiveStatsDisplay: vi.fn(),
  };
}

/** 构建感知面板最小 DOM 结构 */
function buildPanelDOM(): {
  panel: HTMLElement;
  statusBar: HTMLElement;
  closeBtn: HTMLElement;
  metricsToggle: HTMLElement;
  metricsGrid: HTMLElement;
  metricsArrow: HTMLElement;
  reviewToggle: HTMLElement;
  reviewContent: HTMLElement;
  reviewArrow: HTMLElement;
  sourceHealthToggle: HTMLElement;
  sourceHealthList: HTMLElement;
  sourceHealthArrow: HTMLElement;
  recList: HTMLElement;
} {
  const panel = document.createElement('div');
  panel.id = 'perception-panel';
  panel.classList.add('hidden');

  // 状态栏
  const statusBar = document.createElement('div');
  statusBar.id = 'sprite-status-bar';
  panel.appendChild(statusBar);

  // 关闭按钮
  const closeBtn = document.createElement('button');
  closeBtn.className = 'perception-panel-close';
  panel.appendChild(closeBtn);

  // 运行指标折叠区
  const metricsToggle = document.createElement('div');
  metricsToggle.id = 'perception-metrics-toggle';
  panel.appendChild(metricsToggle);
  const metricsGrid = document.createElement('div');
  metricsGrid.id = 'perception-metrics-grid';
  panel.appendChild(metricsGrid);
  const metricsArrow = document.createElement('span');
  metricsArrow.id = 'perception-metrics-arrow';
  metricsToggle.appendChild(metricsArrow);

  // 对话回顾折叠区
  const reviewToggle = document.createElement('div');
  reviewToggle.id = 'perception-review-toggle';
  panel.appendChild(reviewToggle);
  const reviewContent = document.createElement('div');
  reviewContent.id = 'perception-review';
  panel.appendChild(reviewContent);
  const reviewArrow = document.createElement('span');
  reviewArrow.id = 'perception-review-arrow';
  reviewToggle.appendChild(reviewArrow);

  // 记忆源健康折叠区
  const sourceHealthToggle = document.createElement('div');
  sourceHealthToggle.id = 'source-health-toggle';
  panel.appendChild(sourceHealthToggle);
  const sourceHealthList = document.createElement('div');
  sourceHealthList.id = 'source-health-list';
  panel.appendChild(sourceHealthList);
  const sourceHealthArrow = document.createElement('span');
  sourceHealthArrow.id = 'source-health-arrow';
  sourceHealthToggle.appendChild(sourceHealthArrow);

  // 推荐列表
  const recList = document.createElement('div');
  recList.id = 'recommendation-list';
  panel.appendChild(recList);

  document.body.appendChild(panel);
  return {
    panel, statusBar, closeBtn,
    metricsToggle, metricsGrid, metricsArrow,
    reviewToggle, reviewContent, reviewArrow,
    sourceHealthToggle, sourceHealthList, sourceHealthArrow,
    recList,
  };
}

/** 创建 PerceptionPanelManager 实例 */
function createManager(host: PerceptionPanelHost = createMockHost()): {
  manager: PerceptionPanelManager;
  host: PerceptionPanelHost;
} {
  return { manager: new PerceptionPanelManager(host), host };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  window.electronAPI = {
    getPerceptionSnapshot: vi.fn().mockResolvedValue({
      affect: { valence: 0.5, arousal: 0.3 },
      rapport: { level: 50 },
      context: { active: true },
      patterns: [],
      proactiveStats: null,
    }),
  } as unknown as typeof window.electronAPI;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── toggle · 面板展开/收起 ─────────────────────────────────

describe('toggle · 面板展开/收起', () => {
  it('首次调用应展开面板', () => {
    const { manager } = createManager();
    const { panel } = buildPanelDOM();
    manager.toggle();
    expect(panel.classList.contains('visible')).toBe(true);
    expect(panel.classList.contains('hidden')).toBe(false);
  });

  it('面板已展开时调用应关闭', () => {
    const { manager } = createManager();
    const { panel } = buildPanelDOM();
    // 先展开
    panel.classList.remove('hidden');
    panel.classList.add('visible');
    // 再关闭
    manager.toggle();
    expect(panel.classList.contains('hiding')).toBe(true);
  });
});

// ─── close · 仅关闭面板 ──────────────────────────────────

describe('close · 关闭面板', () => {
  it('应添加 hiding 类并移除 visible 类', () => {
    const { manager } = createManager();
    const { panel } = buildPanelDOM();
    panel.classList.remove('hidden');
    panel.classList.add('visible');
    manager.close();
    expect(panel.classList.contains('hiding')).toBe(true);
    expect(panel.classList.contains('visible')).toBe(false);
  });
});

// ─── bindStatusBarToggle · 状态栏点击/键盘 ─────────────────

describe('bindStatusBarToggle · 状态栏交互', () => {
  it('点击状态栏应展开面板', () => {
    const { manager } = createManager();
    const { panel, statusBar } = buildPanelDOM();
    manager.init();
    statusBar.click();
    expect(panel.classList.contains('visible')).toBe(true);
  });

  it('Enter 键应展开面板', () => {
    const { manager } = createManager();
    const { panel, statusBar } = buildPanelDOM();
    manager.init();
    statusBar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(panel.classList.contains('visible')).toBe(true);
  });

  it('Space 键应展开面板', () => {
    const { manager } = createManager();
    const { panel, statusBar } = buildPanelDOM();
    manager.init();
    statusBar.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(panel.classList.contains('visible')).toBe(true);
  });
});

// ─── bindCloseButton · 关闭按钮 ───────────────────────────

describe('bindCloseButton · 关闭按钮', () => {
  it('点击关闭按钮应关闭面板', () => {
    const { manager } = createManager();
    const { panel, closeBtn } = buildPanelDOM();
    panel.classList.remove('hidden');
    panel.classList.add('visible');
    manager.init();
    closeBtn.click();
    expect(panel.classList.contains('hiding')).toBe(true);
  });
});

// ─── bindMetricsToggle · 折叠区域 ──────────────────────────

describe('bindMetricsToggle · 折叠/展开', () => {
  it('点击 metrics 开关应切换 hidden 类', () => {
    const { manager } = createManager();
    const { metricsToggle, metricsGrid } = buildPanelDOM();
    manager.init();
    metricsToggle.click();
    expect(metricsGrid.classList.contains('hidden')).toBe(true);
    metricsToggle.click();
    expect(metricsGrid.classList.contains('hidden')).toBe(false);
  });

  it('点击应切换箭头 expanded 类', () => {
    const { manager } = createManager();
    const { metricsToggle, metricsArrow } = buildPanelDOM();
    manager.init();
    metricsToggle.click();
    expect(metricsArrow.classList.contains('expanded')).toBe(true);
    metricsToggle.click();
    expect(metricsArrow.classList.contains('expanded')).toBe(false);
  });
});

// ─── bindRecommendationClick · 推荐记忆 ────────────────────

describe('bindRecommendationClick · 推荐记忆点击', () => {
  it('点击推荐项应触发 jumpToMemory', () => {
    const { manager, host } = createManager();
    const { recList } = buildPanelDOM();
    // 添加推荐项
    const item = document.createElement('div');
    item.dataset.action = 'view-recommendation';
    item.dataset.memoryId = 'mem-123';
    recList.appendChild(item);
    manager.init();
    item.click();
    expect(host.triggerMemoryRecall).toHaveBeenCalledWith('mem-123');
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup · 资源清理', () => {
  it('cleanup 不应抛错', () => {
    const { manager } = createManager();
    buildPanelDOM();
    manager.init();
    expect(() => manager.cleanup()).not.toThrow();
  });
});