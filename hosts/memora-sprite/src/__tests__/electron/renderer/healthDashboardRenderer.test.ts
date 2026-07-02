/**
 * 健康度仪表盘渲染器独立测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - showLoading()：加载态插入到 .health-metrics
 * - render()：迷你徽章 / 评分 / 等级徽章 / 三维度进度条 / 详情计数 / 健康描述 / 清理按钮可见性
 * - showError()：失败状态 + 重试按钮 + 回调触发
 * - onReloadHealth()：回调注册与触发
 * - cleanup()：事件清理 + 回调清空（点击重试不再触发）
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HealthDashboardRenderer } from '../../../electron/renderer/panels/healthDashboardRenderer.js';
import type { HealthDashboardPayload } from '../../../electron/preload.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 健康度面板完整 DOM 结构 */
const HEALTH_HTML = `
  <div id="memory-health-bar">
    <div class="health-metrics"></div>
  </div>
  <span id="health-mini-score" class="hidden"></span>
  <span id="health-score"></span>
  <span id="health-badge" class="health-badge"></span>
  <div id="health-uniqueness" class="health-metric-fill uniqueness" style="width: 0%"></div>
  <span id="health-uniqueness-val"></span>
  <div id="health-freshness" class="health-metric-fill freshness" style="width: 0%"></div>
  <span id="health-freshness-val"></span>
  <div id="health-completeness" class="health-metric-fill completeness" style="width: 0%"></div>
  <span id="health-completeness-val"></span>
  <span id="health-duplicates" class="health-detail-item"></span>
  <span id="health-stale" class="health-detail-item"></span>
  <span id="health-low-quality" class="health-detail-item"></span>
  <span id="health-description"></span>
  <div id="health-actions" style="display: none">
    <button id="health-cleanup-duplicates">清理重复</button>
    <button id="health-cleanup-stale">清理过期</button>
    <button id="health-cleanup-all">全部清理</button>
  </div>
`;

/** 创建测试用 HealthDashboardPayload */
function createHealth(overrides?: Partial<HealthDashboardPayload>): HealthDashboardPayload {
  return {
    scores: { overall: 85, uniqueness: 90, freshness: 80, completeness: 85 },
    duplicates: [],
    staleMemories: [],
    lowQualityCount: 0,
    totalMemories: 100,
    healthLabel: 'good',
    healthDescription: '记忆健康状况良好',
    ...overrides,
  };
}

/** 创建渲染器实例（已设置 DOM） */
function createRenderer(html?: string): HealthDashboardRenderer {
  document.body.innerHTML = html ?? HEALTH_HTML;
  return new HealthDashboardRenderer();
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

// ─── showLoading() · 加载态 ──────────────────────────────

describe('showLoading() · 加载态', () => {
  it('应在 .health-metrics 区域插入加载态', () => {
    const renderer = createRenderer();
    renderer.showLoading();
    const metricsEl = document.querySelector('.health-metrics')!;
    expect(metricsEl.querySelector('.panel-loading')).not.toBeNull();
  });

  it('面板不存在时应安全降级（不抛错）', () => {
    document.body.innerHTML = '';
    const renderer = new HealthDashboardRenderer();
    expect(() => renderer.showLoading()).not.toThrow();
  });
});

// ─── render() · 健康度数据渲染 ───────────────────────────

describe('render() · 健康度数据', () => {
  it('应更新迷你健康分徽章（移除 hidden + 设置等级类）', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({ scores: { overall: 85, uniqueness: 90, freshness: 80, completeness: 85 }, healthLabel: 'good' }));
    const mini = document.getElementById('health-mini-score')!;
    expect(mini.textContent).toBe('85');
    expect(mini.classList.contains('hidden')).toBe(false);
    expect(mini.classList.contains('good')).toBe(true);
  });

  it('应更新健康度评分和等级徽章', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({
      scores: { overall: 92, uniqueness: 95, freshness: 90, completeness: 90 },
      healthLabel: 'excellent',
    }));
    expect(document.getElementById('health-score')!.textContent).toBe('92');
    expect(document.getElementById('health-badge')!.textContent).toBe('优秀');
    expect(document.getElementById('health-badge')!.classList.contains('excellent')).toBe(true);
  });

  it('未知 healthLabel 时徽章应显示原始值', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({ healthLabel: 'custom' }));
    expect(document.getElementById('health-badge')!.textContent).toBe('custom');
  });

  it('应更新三维度进度条宽度和数值', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({ scores: { overall: 80, uniqueness: 90, freshness: 70, completeness: 85 } }));
    expect(document.getElementById('health-uniqueness')!.style.width).toBe('90%');
    expect(document.getElementById('health-uniqueness-val')!.textContent).toBe('90');
    expect(document.getElementById('health-freshness')!.style.width).toBe('70%');
    expect(document.getElementById('health-freshness-val')!.textContent).toBe('70');
    expect(document.getElementById('health-completeness')!.style.width).toBe('85%');
    expect(document.getElementById('health-completeness-val')!.textContent).toBe('85');
  });

  it('三维度进度条应更新样式类为对应维度名', () => {
    const renderer = createRenderer();
    renderer.render(createHealth());
    expect(document.getElementById('health-uniqueness')!.className).toContain('uniqueness');
    expect(document.getElementById('health-freshness')!.className).toContain('freshness');
    expect(document.getElementById('health-completeness')!.className).toContain('completeness');
  });

  it('有重复记忆应显示重复数和 warning 类', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({
      duplicates: [
        {
          type: 'name',
          memories: [
            { id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' },
            { id: '2', name: 'a', source: 't', score: 0.5, contentPreview: 'p' },
          ],
        },
      ],
    }));
    const el = document.getElementById('health-duplicates')!;
    expect(el.textContent).toContain('2');
    expect(el.classList.contains('warning')).toBe(true);
  });

  it('有过期记忆应显示过期数和 warning 类', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({
      staleMemories: [
        { memory: { id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' }, reason: 'old_age', daysSinceAccess: 100 },
      ],
    }));
    const el = document.getElementById('health-stale')!;
    expect(el.textContent).toContain('1');
    expect(el.classList.contains('warning')).toBe(true);
  });

  it('有低质量记忆应显示低质量数和 warning 类', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({ lowQualityCount: 3 }));
    const el = document.getElementById('health-low-quality')!;
    expect(el.textContent).toContain('3');
    expect(el.classList.contains('warning')).toBe(true);
  });

  it('应更新健康描述文字', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({ healthDescription: '记忆健康度优秀，保持良好' }));
    expect(document.getElementById('health-description')!.textContent).toBe('记忆健康度优秀，保持良好');
  });

  it('无可清理项时清理按钮应全部隐藏', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({ duplicates: [], staleMemories: [], lowQualityCount: 0 }));
    expect(document.getElementById('health-cleanup-duplicates')!.style.display).toBe('none');
    expect(document.getElementById('health-cleanup-stale')!.style.display).toBe('none');
    expect(document.getElementById('health-cleanup-all')!.style.display).toBe('none');
    expect(document.getElementById('health-actions')!.style.display).toBe('none');
  });

  it('仅有重复记忆时应显示重复清理按钮和全部清理按钮', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({
      duplicates: [
        { type: 'name', memories: [{ id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' }] },
      ],
      staleMemories: [],
    }));
    expect(document.getElementById('health-cleanup-duplicates')!.style.display).not.toBe('none');
    expect(document.getElementById('health-cleanup-stale')!.style.display).toBe('none');
    expect(document.getElementById('health-cleanup-all')!.style.display).not.toBe('none');
    expect(document.getElementById('health-actions')!.style.display).not.toBe('none');
  });

  it('仅有过期记忆时应显示过期清理按钮和全部清理按钮', () => {
    const renderer = createRenderer();
    renderer.render(createHealth({
      duplicates: [],
      staleMemories: [
        { memory: { id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' }, reason: 'old_age', daysSinceAccess: 100 },
      ],
    }));
    expect(document.getElementById('health-cleanup-duplicates')!.style.display).toBe('none');
    expect(document.getElementById('health-cleanup-stale')!.style.display).not.toBe('none');
    expect(document.getElementById('health-cleanup-all')!.style.display).not.toBe('none');
    expect(document.getElementById('health-actions')!.style.display).not.toBe('none');
  });
});

// ─── showError() · 错误态 + 重试回调 ─────────────────────

describe('showError() · 错误态', () => {
  it('应渲染"加载失败"文案', () => {
    const renderer = createRenderer();
    renderer.showError();
    const errorDiv = document.querySelector('#memory-health-bar .error-state')!;
    expect(errorDiv.textContent).toContain('加载失败');
  });

  it('应渲染重试按钮', () => {
    const renderer = createRenderer();
    renderer.showError();
    const retryBtn = document.querySelector('#memory-health-bar .inline-retry-btn') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.textContent).toBe('重试');
  });

  it('click 重试按钮应触发 onReloadHealth 回调', () => {
    const renderer = createRenderer();
    const cb = vi.fn();
    renderer.onReloadHealth(cb);
    renderer.showError();
    const retryBtn = document.querySelector('#memory-health-bar .inline-retry-btn') as HTMLButtonElement;
    retryBtn.click();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('未注册回调时点击重试按钮不应抛错', () => {
    const renderer = createRenderer();
    renderer.showError();
    const retryBtn = document.querySelector('#memory-health-bar .inline-retry-btn') as HTMLButtonElement;
    expect(() => retryBtn.click()).not.toThrow();
  });

  it('面板不存在时应安全降级（不抛错）', () => {
    document.body.innerHTML = '';
    const renderer = new HealthDashboardRenderer();
    expect(() => renderer.showError()).not.toThrow();
  });
});

// ─── cleanup() · 资源清理 ─────────────────────────────────

describe('cleanup() · 资源清理', () => {
  it('cleanup 后点击重试按钮不应触发回调（事件已解绑）', () => {
    const renderer = createRenderer();
    const cb = vi.fn();
    renderer.onReloadHealth(cb);
    renderer.showError();
    const retryBtn = document.querySelector('#memory-health-bar .inline-retry-btn') as HTMLButtonElement;
    renderer.cleanup();
    retryBtn.click();
    expect(cb).not.toHaveBeenCalled();
  });

  it('cleanup 后再次调用 showError 不应累积多个重试按钮', () => {
    const renderer = createRenderer();
    renderer.showError();
    renderer.showError();
    // 第一次 showError 在 metrics 中插入 1 个 error-state
    expect(document.querySelectorAll('#memory-health-bar .error-state').length).toBe(1);
  });
});
