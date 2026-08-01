/**
 * 伙伴洞察组件独立测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围（对齐 Component 生命周期）：
 * - mount()：采纳 #partner-insights 静态容器 / 容器缺失安全降级
 * - update()：空数据隐藏 / 有数据显示 / 三部分联动渲染（等价原 render）
 * - renderProfileCards：最多 6 张截断 / 无 profile 引导提示 / 内容预览 80 字符截断
 * - renderKnowledgeGaps：占比 < 5% 提示 / 全部充足显示"全面" / 最多 3 条
 * - renderGrowthChart：Canvas 绘制 / 无 canvas 降级 / 总数更新
 * - onMemoryClick：回调注册与触发（经 trackEvent 清理）
 * - repaintOnThemeChange：主题切换重绘（依赖缓存数据）
 * - destroy：监听移除（点击不再触发）/ 不移除共享容器 / 幂等
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API（含 Canvas getContext 降级）
 * - 无外部依赖注入（模式 D 自包含）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PartnerInsightsComponent, type PartnerMemory } from '../../../electron/renderer/components/data/partnerInsightsComponent.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 伙伴洞察面板完整 DOM 结构（匹配 index.html：#partner-insights 包裹全部内部 id） */
const PARTNER_HTML = `
  <div id="partner-insights" class="partner-insights analysis-bar hidden">
    <span class="panel-badge good" id="partner-insights-badge">0 条了解</span>
    <div class="profile-cards"></div>
    <div class="gap-list"></div>
    <span id="partner-growth-total"></span>
    <canvas id="partner-growth-chart"></canvas>
  </div>
`;

/** 缺少 canvas 的面板结构（测试 Canvas 缺失降级） */
const PARTNER_NO_CANVAS = `
  <div id="partner-insights" class="hidden">
    <div class="profile-cards"></div>
    <div class="gap-list"></div>
  </div>
`;

/** 创建测试用记忆数据 */
function createMemories(overrides?: Partial<PartnerMemory> & { count?: number }): PartnerMemory[] {
  const count = overrides?.count ?? 1;
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    name: `记忆 ${i}`,
    source: overrides?.source ?? 'profile',
    contentPreview: overrides?.contentPreview ?? `预览 ${i}`,
    createdAt: overrides?.createdAt ?? new Date().toISOString(),
  }));
}

/** 创建并挂载组件（已设置 DOM） */
function createComponent(html?: string): PartnerInsightsComponent {
  document.body.innerHTML = html ?? PARTNER_HTML;
  const comp = new PartnerInsightsComponent();
  comp.mount('#partner-insights');
  return comp;
}

/** Mock Canvas 2D 上下文（JSDOM 不支持真实 Canvas 绘制） */
function mockCanvasContext(): void {
  const mockCtx = {
    scale: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fillText: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    font: '',
    textAlign: 'start',
  };
  const canvas = document.getElementById('partner-growth-chart') as HTMLCanvasElement;
  if (canvas) {
    // JSDOM 的 getContext 返回 null，用 Object.defineProperty 注入 mock
    Object.defineProperty(canvas, 'getContext', {
      value: () => mockCtx,
      configurable: true,
    });
    // getBoundingClientRect 也需要 mock（JSDOM 返回全 0）
    Object.defineProperty(canvas, 'getBoundingClientRect', {
      value: () => ({ width: 300, height: 120, top: 0, left: 0, right: 300, bottom: 120, x: 0, y: 0 }),
      configurable: true,
    });
  }
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

// ─── mount() 挂载 ──────────────────────────────────────────

describe('mount() · 挂载', () => {
  it('应采纳 #partner-insights 为根元素', () => {
    const comp = createComponent();
    const el = comp.getElement()!;
    expect(el).toBe(document.getElementById('partner-insights'));
    expect(el.classList.contains('partner-insights')).toBe(true);
  });

  it('容器缺失时应安全降级（不抛错，getElement 为 null）', () => {
    document.body.innerHTML = '';
    const comp = new PartnerInsightsComponent();
    expect(() => comp.mount('#partner-insights')).not.toThrow();
    expect(comp.getElement()).toBeNull();
  });
});

// ─── update() 主入口（等价原 render） ─────────────────────

describe('update() · 主入口', () => {
  it('空记忆列表应隐藏面板', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({ memories: [] });
    expect(document.getElementById('partner-insights')!.classList.contains('hidden')).toBe(true);
  });

  it('有记忆应显示面板（移除 hidden 类）', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({ memories: createMemories({ count: 1 }) });
    expect(document.getElementById('partner-insights')!.classList.contains('hidden')).toBe(false);
  });

  it('面板不存在时应安全降级（不抛错）', () => {
    document.body.innerHTML = '';
    const comp = new PartnerInsightsComponent();
    comp.mount('#partner-insights');
    expect(() => comp.update({ memories: createMemories({ count: 1 }) })).not.toThrow();
  });

  it('有数据应缓存记忆（供主题切换重绘使用）', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({ memories: createMemories({ count: 3 }) });
    // 通过 repaintOnThemeChange 验证缓存生效（不抛错即说明有缓存数据）
    expect(() => comp.repaintOnThemeChange()).not.toThrow();
  });
});

// ─── 卡片网格 ────────────────────────────────────────────

describe('update() · 卡片网格', () => {
  it('应渲染 profile 记忆卡片（最多 6 张）', () => {
    const comp = createComponent();
    mockCanvasContext();
    const profileMems = Array.from({ length: 8 }, (_, i) => ({
      id: `profile:${i}`,
      name: `卡片 ${i}`,
      source: 'profile',
      contentPreview: `预览 ${i}`,
    }));
    comp.update({ memories: profileMems });
    const cards = document.querySelectorAll('.profile-card');
    expect(cards.length).toBe(6);
  });

  it('无 profile 记忆应显示引导提示', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({
      memories: [{ id: 'm1', name: '非 profile', source: 'test', contentPreview: 'p' }],
    });
    expect(document.querySelector('.partner-empty-hint')!.textContent).toContain('精灵还不了解你');
  });

  it('内容预览超过 80 字符应截断', () => {
    const comp = createComponent();
    mockCanvasContext();
    const longPreview = 'A'.repeat(100);
    comp.update({
      memories: [{ id: 'm1', name: '长预览', source: 'profile', contentPreview: longPreview }],
    });
    const previewEl = document.querySelector('.profile-card-preview') as HTMLElement;
    expect(previewEl.textContent!.length).toBe(81); // 80 + '…'
  });

  it('内容预览不超过 80 字符应保持原样', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({
      memories: [{ id: 'm1', name: '短预览', source: 'profile', contentPreview: '短内容' }],
    });
    const previewEl = document.querySelector('.profile-card-preview') as HTMLElement;
    expect(previewEl.textContent).toBe('短内容');
  });

  it('卡片应显示记忆名称', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({
      memories: [{ id: 'm1', name: '测试名称', source: 'profile', contentPreview: 'p' }],
    });
    const nameEl = document.querySelector('.profile-card-name') as HTMLElement;
    expect(nameEl.textContent).toBe('测试名称');
  });
});

// ─── 知识缺口 ────────────────────────────────────────────

describe('update() · 知识缺口', () => {
  it('应渲染知识缺口（占比 < 5% 的 source 类型）', () => {
    const comp = createComponent();
    mockCanvasContext();
    // 100 条记忆全是 test，profile 占比 0% < 5%，应提示
    const memories = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`,
      name: `m${i}`,
      source: 'test',
      contentPreview: 'p',
    }));
    comp.update({ memories });
    const gaps = document.querySelectorAll('.gap-item');
    expect(gaps.length).toBeGreaterThan(0);
  });

  it('所有 source 类型都充足应显示"全面"提示', () => {
    const comp = createComponent();
    mockCanvasContext();
    // 构造每种 source 都 >= 5% 的数据
    const sources = ['profile', 'insight', 'skill', 'rule', 'guardrail', 'persona', 'session', 'test'];
    const memories = sources.flatMap((source) =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `${source}:${i}`,
        name: source,
        source,
        contentPreview: 'p',
      })),
    );
    comp.update({ memories });
    expect(document.querySelector('.partner-empty-hint')!.textContent).toContain('全面');
  });

  it('知识缺口最多展示 3 条', () => {
    const comp = createComponent();
    mockCanvasContext();
    // 只有 1 条记忆，所有已知 source 类型都 < 5%，应有缺口但最多 3 条
    comp.update({
      memories: [{ id: 'm1', name: '唯一', source: 'test', contentPreview: 'p' }],
    });
    const gaps = document.querySelectorAll('.gap-item');
    expect(gaps.length).toBeLessThanOrEqual(3);
  });
});

// ─── 趋势图 ──────────────────────────────────────────────

describe('update() · 趋势图', () => {
  it('应更新总数显示', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({ memories: createMemories({ count: 5 }) });
    const totalEl = document.getElementById('partner-growth-total');
    expect(totalEl!.textContent).toBe('5 条');
  });

  it('Canvas 不存在时应安全降级（不抛错）', () => {
    const comp = createComponent(PARTNER_NO_CANVAS);
    expect(() => comp.update({ memories: createMemories({ count: 1 }) })).not.toThrow();
  });

  it('Canvas context 获取失败时应安全降级', () => {
    const comp = createComponent();
    const canvas = document.getElementById('partner-growth-chart') as HTMLCanvasElement;
    Object.defineProperty(canvas, 'getContext', {
      value: () => null,
      configurable: true,
    });
    expect(() => comp.update({ memories: createMemories({ count: 1 }) })).not.toThrow();
  });
});

// ─── onMemoryClick · 回调注册 ────────────────────────────

describe('onMemoryClick · 回调注册', () => {
  it('click profile 卡片应触发 onMemoryClick 回调', () => {
    const comp = createComponent();
    mockCanvasContext();
    const cb = vi.fn();
    comp.onMemoryClick(cb);
    comp.update({
      memories: [{ id: 'profile:click-test', name: '卡片', source: 'profile', contentPreview: 'p' }],
    });
    const card = document.querySelector('.profile-card') as HTMLElement;
    card.click();
    expect(cb).toHaveBeenCalledWith('profile:click-test');
  });

  it('未注册回调时点击卡片不应抛错', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({
      memories: [{ id: 'm1', name: '卡片', source: 'profile', contentPreview: 'p' }],
    });
    const card = document.querySelector('.profile-card') as HTMLElement;
    expect(() => card.click()).not.toThrow();
  });
});

// ─── repaintOnThemeChange · 主题切换重绘 ──────────────────

describe('repaintOnThemeChange · 主题切换重绘', () => {
  it('有缓存数据时应重绘趋势图（不抛错）', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({ memories: createMemories({ count: 2 }) });
    expect(() => comp.repaintOnThemeChange()).not.toThrow();
  });

  it('无缓存数据时不应重绘（不抛错）', () => {
    const comp = createComponent();
    expect(() => comp.repaintOnThemeChange()).not.toThrow();
  });

  it('destroy 后调用 repaintOnThemeChange 不应重绘（已销毁，不抛错）', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({ memories: createMemories({ count: 1 }) });
    comp.destroy();
    expect(() => comp.repaintOnThemeChange()).not.toThrow();
  });
});

// ─── destroy · 资源清理 ───────────────────────────────────

describe('destroy · 资源清理', () => {
  it('destroy 应移除卡片点击监听（点击卡片不再触发回调）', () => {
    const comp = createComponent();
    mockCanvasContext();
    const cb = vi.fn();
    comp.onMemoryClick(cb);
    comp.update({
      memories: [{ id: 'm1', name: '卡片', source: 'profile', contentPreview: 'p' }],
    });
    const card = document.querySelector('.profile-card') as HTMLElement;
    comp.destroy();
    card.click();
    expect(cb).not.toHaveBeenCalled();
  });

  it('destroy 不应移除共享静态容器 #partner-insights', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({ memories: createMemories({ count: 1 }) });
    comp.destroy();
    expect(document.getElementById('partner-insights')).not.toBeNull();
    expect(comp.getElement()).toBeNull();
  });

  it('destroy 应幂等（调用两次不抛错）', () => {
    const comp = createComponent();
    mockCanvasContext();
    comp.update({ memories: createMemories({ count: 1 }) });
    expect(() => {
      comp.destroy();
      comp.destroy();
    }).not.toThrow();
    expect(comp.isDestroyed()).toBe(true);
  });
});
