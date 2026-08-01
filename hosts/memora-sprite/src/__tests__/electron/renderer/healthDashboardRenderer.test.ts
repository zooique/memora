/**
 * 健康度仪表盘组件独立测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - showLoading()：加载态插入到 .health-metrics
 * - update({data})：迷你徽章 / 评分 / 等级徽章 / 三维度进度条 / 详情计数 / 健康描述 / 清理按钮可见性
 * - showError()：失败状态 + 重试按钮 + 回调触发
 * - onReloadHealth()：回调注册与触发
 * - destroy()：事件清理 + 回调清空（点击重试不再触发）
 *
 * 组件化后（HEAL-17 Phase B）：组件采纳静态容器 #memory-health-bar 为根并缓存内部引用，
 * 故 createRenderer 先 mount('#memory-health-bar')；渲染入口由 render(data) 改为 update({ data })。
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HealthDashboardComponent } from '../../../electron/renderer/components/data/healthDashboardComponent.js';
import type { HealthDashboardPayload } from '../../../electron/preload.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/**
 * 健康度面板完整 DOM 结构（与 index.html 对齐：所有内部 id 嵌套在 #memory-health-bar 内）
 * 组件 mount 时通过 this.el.querySelector 缓存这些内部引用。
 */
const HEALTH_HTML = `
  <div id="memory-health-bar" class="health-bar analysis-bar hidden">
    <div class="analysis-panel__header">
      <span class="analysis-panel__title">记忆健康度</span>
      <span class="panel-badge" id="health-badge">优秀</span>
    </div>
    <div class="panel-section">
      <div class="health-summary">
        <span class="panel-score" id="health-score">100</span>
        <span class="panel-score-sample" id="health-score-sample"></span>
      </div>
    </div>
    <div class="panel-section">
      <div class="health-metrics">
        <div class="health-metric">
          <div class="metric-track"><div class="metric-track__fill" id="health-uniqueness"></div></div>
          <span class="health-metric-value" id="health-uniqueness-val">100</span>
        </div>
        <div class="health-metric">
          <div class="metric-track"><div class="metric-track__fill" id="health-freshness"></div></div>
          <span class="health-metric-value" id="health-freshness-val">100</span>
        </div>
        <div class="health-metric">
          <div class="metric-track"><div class="metric-track__fill" id="health-completeness"></div></div>
          <span class="health-metric-value" id="health-completeness-val">100</span>
        </div>
      </div>
      <div class="health-details">
        <span class="panel-chip" id="health-duplicates">重复: 0</span>
        <span class="panel-chip" id="health-stale">过期: 0</span>
        <span class="panel-chip" id="health-low-quality">低质量: 0</span>
      </div>
    </div>
    <div class="panel-section">
      <p class="health-description" id="health-description"></p>
    </div>
    <div class="health-actions" id="health-actions">
      <button id="health-cleanup-duplicates">清理重复</button>
      <button id="health-cleanup-stale">清理过期</button>
      <button id="health-cleanup-all">一键清理</button>
    </div>
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

/** 创建组件实例并挂载到静态容器（已设置 DOM） */
function createRenderer(html?: string): HealthDashboardComponent {
  document.body.innerHTML = html ?? HEALTH_HTML;
  const component = new HealthDashboardComponent();
  component.mount('#memory-health-bar');
  return component;
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
    const component = createRenderer();
    component.showLoading();
    const metricsEl = document.querySelector('.health-metrics')!;
    expect(metricsEl.querySelector('.panel-loading')).not.toBeNull();
  });

  it('面板不存在时应安全降级（不抛错）', () => {
    document.body.innerHTML = '';
    const component = new HealthDashboardComponent();
    expect(() => component.showLoading()).not.toThrow();
  });
});

// ─── update({data}) · 健康度数据渲染 ──────────────────────

describe('update({data}) · 健康度数据', () => {
  it('应更新健康度评分和等级徽章', () => {
    const component = createRenderer();
    component.update({
      data: createHealth({
        scores: { overall: 92, uniqueness: 95, freshness: 90, completeness: 90 },
        healthLabel: 'excellent',
      }),
    });
    // R11：评分与样本量分离（#health-score 纯分数 + #health-score-sample 样本量）
    expect(document.getElementById('health-score')!.textContent).toBe('92');
    expect(document.getElementById('health-score-sample')!.textContent).toBe('（100 条）');
    expect(document.getElementById('health-badge')!.textContent).toBe('优秀');
    expect(document.getElementById('health-badge')!.classList.contains('excellent')).toBe(true);
  });

  it('未知 healthLabel 时徽章应显示原始值', () => {
    const component = createRenderer();
    component.update({ data: createHealth({ healthLabel: 'custom' }) });
    expect(document.getElementById('health-badge')!.textContent).toBe('custom');
  });

  it('应更新三维度进度条宽度和数值', () => {
    const component = createRenderer();
    component.update({
      data: createHealth({ scores: { overall: 80, uniqueness: 90, freshness: 70, completeness: 85 } }),
    });
    expect(document.getElementById('health-uniqueness')!.style.width).toBe('90%');
    expect(document.getElementById('health-uniqueness-val')!.textContent).toBe('90');
    expect(document.getElementById('health-freshness')!.style.width).toBe('70%');
    expect(document.getElementById('health-freshness-val')!.textContent).toBe('70');
    expect(document.getElementById('health-completeness')!.style.width).toBe('85%');
    expect(document.getElementById('health-completeness-val')!.textContent).toBe('85');
  });

  it('三维度进度条应更新样式类为对应维度名', () => {
    const component = createRenderer();
    component.update({ data: createHealth() });
    expect(document.getElementById('health-uniqueness')!.className).toContain('uniqueness');
    expect(document.getElementById('health-freshness')!.className).toContain('freshness');
    expect(document.getElementById('health-completeness')!.className).toContain('completeness');
  });

  it('有重复记忆应显示重复数和 warning 类', () => {
    const component = createRenderer();
    component.update({
      data: createHealth({
        duplicates: [
          {
            type: 'name',
            memories: [
              { id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' },
              { id: '2', name: 'a', source: 't', score: 0.5, contentPreview: 'p' },
            ],
          },
        ],
      }),
    });
    const el = document.getElementById('health-duplicates')!;
    expect(el.textContent).toContain('2');
    expect(el.classList.contains('warning')).toBe(true);
  });

  it('有过期记忆应显示过期数和 warning 类', () => {
    const component = createRenderer();
    component.update({
      data: createHealth({
        staleMemories: [
          { memory: { id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' }, reason: 'old_age', daysSinceAccess: 100 },
        ],
      }),
    });
    const el = document.getElementById('health-stale')!;
    expect(el.textContent).toContain('1');
    expect(el.classList.contains('warning')).toBe(true);
  });

  it('有低质量记忆应显示低质量数和 warning 类', () => {
    const component = createRenderer();
    component.update({ data: createHealth({ lowQualityCount: 3 }) });
    const el = document.getElementById('health-low-quality')!;
    expect(el.textContent).toContain('3');
    expect(el.classList.contains('warning')).toBe(true);
  });

  it('应更新健康描述文字', () => {
    const component = createRenderer();
    component.update({ data: createHealth({ healthDescription: '记忆健康度优秀，保持良好' }) });
    expect(document.getElementById('health-description')!.textContent).toBe('记忆健康度优秀，保持良好');
  });

  it('无可清理项时清理按钮应全部隐藏', () => {
    const component = createRenderer();
    component.update({ data: createHealth({ duplicates: [], staleMemories: [], lowQualityCount: 0 }) });
    expect(document.getElementById('health-cleanup-duplicates')!.style.display).toBe('none');
    expect(document.getElementById('health-cleanup-stale')!.style.display).toBe('none');
    expect(document.getElementById('health-cleanup-all')!.style.display).toBe('none');
    expect(document.getElementById('health-actions')!.style.display).toBe('none');
  });

  it('仅有重复记忆时应显示重复清理按钮和全部清理按钮', () => {
    const component = createRenderer();
    component.update({
      data: createHealth({
        duplicates: [
          { type: 'name', memories: [{ id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' }] },
        ],
        staleMemories: [],
      }),
    });
    expect(document.getElementById('health-cleanup-duplicates')!.style.display).not.toBe('none');
    expect(document.getElementById('health-cleanup-stale')!.style.display).toBe('none');
    expect(document.getElementById('health-cleanup-all')!.style.display).not.toBe('none');
    expect(document.getElementById('health-actions')!.style.display).not.toBe('none');
  });

  it('仅有过期记忆时应显示过期清理按钮和全部清理按钮', () => {
    const component = createRenderer();
    component.update({
      data: createHealth({
        duplicates: [],
        staleMemories: [
          { memory: { id: '1', name: 'a', source: 't', score: 0.5, contentPreview: 'p' }, reason: 'old_age', daysSinceAccess: 100 },
        ],
      }),
    });
    expect(document.getElementById('health-cleanup-duplicates')!.style.display).toBe('none');
    expect(document.getElementById('health-cleanup-stale')!.style.display).not.toBe('none');
    expect(document.getElementById('health-cleanup-all')!.style.display).not.toBe('none');
    expect(document.getElementById('health-actions')!.style.display).not.toBe('none');
  });
});

// ─── showError() · 错误态 + 重试回调 ─────────────────────

describe('showError() · 错误态', () => {
  it('应渲染"加载失败"文案', () => {
    const component = createRenderer();
    component.showError();
    const errorDiv = document.querySelector('#memory-health-bar .error-state')!;
    expect(errorDiv.textContent).toContain('加载失败');
  });

  it('应渲染重试按钮', () => {
    const component = createRenderer();
    component.showError();
    const retryBtn = document.querySelector('#memory-health-bar .error-retry-btn') as HTMLButtonElement;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.textContent).toBe('重试');
  });

  it('click 重试按钮应触发 onReloadHealth 回调', () => {
    const component = createRenderer();
    const cb = vi.fn();
    component.onReloadHealth(cb);
    component.showError();
    const retryBtn = document.querySelector('#memory-health-bar .error-retry-btn') as HTMLButtonElement;
    retryBtn.click();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('未注册回调时点击重试按钮不应抛错', () => {
    const component = createRenderer();
    component.showError();
    const retryBtn = document.querySelector('#memory-health-bar .error-retry-btn') as HTMLButtonElement;
    expect(() => retryBtn.click()).not.toThrow();
  });

  it('面板不存在时应安全降级（不抛错）', () => {
    document.body.innerHTML = '';
    const component = new HealthDashboardComponent();
    expect(() => component.showError()).not.toThrow();
  });
});

// ─── destroy() · 资源清理 ─────────────────────────────────

describe('destroy() · 资源清理', () => {
  it('destroy 后点击重试按钮不应触发回调（事件已解绑）', () => {
    const component = createRenderer();
    const cb = vi.fn();
    component.onReloadHealth(cb);
    component.showError();
    const retryBtn = document.querySelector('#memory-health-bar .error-retry-btn') as HTMLButtonElement;
    component.destroy();
    retryBtn.click();
    expect(cb).not.toHaveBeenCalled();
  });

  it('showError 多次调用不应累积多个重试按钮', () => {
    const component = createRenderer();
    component.showError();
    component.showError();
    // 每次 showError 在 metrics 中清空后插入 1 个 error-state
    expect(document.querySelectorAll('#memory-health-bar .error-state').length).toBe(1);
  });
});
