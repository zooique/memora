/**
 * memoryView 测试 — 记忆管理面板渲染分支
 *
 * 覆盖新增的记忆管理视图渲染路径：
 *   - 顶栏统计（statBar：总数 + source 分布）
 *   - 记忆卡片（名称 + source 徽章 + score 圆点 + 单行预览）
 *   - 点击展开详情（全文 content + 创建时间元数据）
 *   - 搜索结果渲染（search-summary 摘要 + 命中条目）
 *   - 空态引导（memory_loaded 空列表 / 搜索无命中）
 *   - 搜索框输入 → postMessage memory_search（防抖后）；清空 → memory_load
 * 用 jsdom 环境 + 注入 mock acquireVsCodeApi，通过 createMemoryView 工厂驱动 render。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createMemoryView } from '../scripts/memoryView.js';
import type { MemoryItemDto, MemoryStatsDto } from '../../shared/protocol.js';

/** 覆盖 createMemoryView 全部查询引用的最小 HTML 骨架（子视图挂载在 #memory-root 根容器内，
 *  与设置视图选项卡合并后的 id 空间隔离约定一致） */
const HTML = `
  <div id="memory-root">
    <div class="header">
      <h2>记忆</h2>
      <span id="statBar" class="stat-bar" hidden></span>
    </div>
    <div class="search-wrap">
      <input id="searchInput" class="search-input" type="text" placeholder="搜索记忆…" />
    </div>
    <div id="list"><p class="hint">加载中…</p></div>
    <p class="footer-hint">记忆按重要度排序，点击条目查看全文。</p>
  </div>
`;

/** 挂载 createMemoryView 并返回 postMessage mock（含首屏 memory_load 断言辅助） */
function mountMemoryView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  const root = document.getElementById('memory-root') as HTMLElement;
  createMemoryView({
    acquireVsCodeApi: () => ({ postMessage }),
    window: window as unknown as Window,
    root,
  });
  return { postMessage };
}

/** 向 webview 分发一条 memory_loaded 消息，驱动 render */
function dispatchLoaded(stats: MemoryStatsDto, memories: MemoryItemDto[]): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'memory_loaded', stats, memories },
    }),
  );
}

/** 向 webview 分发一条 memory_search_result 消息，驱动 render */
function dispatchSearchResult(query: string, hits: MemoryItemDto[]): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'memory_search_result', query, hits },
    }),
  );
}

/** 构造一条测试记忆 */
function makeMemory(overrides: Partial<MemoryItemDto> = {}): MemoryItemDto {
  return {
    id: 'round-summary:设计决策',
    name: '设计决策',
    source: 'round-summary',
    score: 0.9,
    content: '确认采用独立记忆视图承载资产全貌。',
    createdAt: '2026-08-17T10:00:00.000Z',
    ...overrides,
  };
}

describe('memoryView 渲染（2026-08-17 独立记忆管理视图）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('首屏加载 → postMessage memory_load', () => {
    const { postMessage } = mountMemoryView();
    expect(postMessage).toHaveBeenCalledWith({ type: 'memory_load' });
  });

  it('memory_loaded 渲染顶栏统计 + 记忆卡片（名称/source 徽章/score 圆点/预览）', () => {
    mountMemoryView();
    dispatchLoaded(
      { total: 3, bySource: { 'round-summary': 2, profile: 1 } },
      [
        makeMemory({ score: 0.9 }),
        makeMemory({ id: 'profile:偏好', name: '偏好', source: 'profile', score: 0.3, content: '偏好简洁界面。' }),
      ],
    );
    // 顶栏统计：总数 + source 分布
    expect(document.getElementById('statBar')?.textContent).toBe('共 3 条 · round-summary 2 · profile 1');
    const cards = document.querySelectorAll('.mem-card');
    expect(cards).toHaveLength(2);
    // 名称 + source 徽章
    expect(cards[0]?.querySelector('.mem-card-name')?.textContent).toBe('设计决策');
    expect(cards[0]?.querySelector('.source-badge')?.textContent).toBe('round-summary');
    // score 圆点：高分点亮 high 类
    expect(cards[0]?.querySelector('.score-dot')?.classList.contains('score-dot-high')).toBe(true);
    expect(cards[1]?.querySelector('.score-dot')?.classList.contains('score-dot-high')).toBe(false);
    // 单行预览
    expect(cards[0]?.querySelector('.mem-card-preview')?.textContent).toBe('确认采用独立记忆视图承载资产全貌。');
  });

  it('点击卡片展开详情（全文 content + 创建时间），再点击收起', () => {
    mountMemoryView();
    dispatchLoaded(
      { total: 1, bySource: { 'round-summary': 1 } },
      [makeMemory()],
    );
    const card = document.querySelector('.mem-card') as HTMLElement;
    // 初始未展开
    expect(card.classList.contains('expanded')).toBe(false);
    expect(card.querySelector('.mem-card-detail')).toBeNull();
    // 展开：全文 + 元数据时间
    card.click();
    expect(card.classList.contains('expanded')).toBe(true);
    expect(card.getAttribute('aria-expanded')).toBe('true');
    const detail = card.querySelector('.mem-card-detail');
    expect(detail?.textContent).toContain('确认采用独立记忆视图承载资产全貌。');
    expect(detail?.querySelector('.mem-card-meta')?.textContent).toContain('2026-');
    // 再点击收起
    card.click();
    expect(card.classList.contains('expanded')).toBe(false);
    expect(card.querySelector('.mem-card-detail')).toBeNull();
  });

  it('memory_search_result 渲染搜索结果（命中摘要 + 条目）', () => {
    mountMemoryView();
    // 真实流程：搜索前用户已输入 query（竞态守卫要求 query 与输入框一致）
    (document.getElementById('searchInput') as HTMLInputElement).value = '记忆视图';
    dispatchSearchResult('记忆视图', [makeMemory()]);
    expect(document.querySelector('.search-summary')?.textContent).toBe('「记忆视图」命中 1 条');
    expect(document.querySelectorAll('.mem-card')).toHaveLength(1);
  });

  it('迟到的搜索结果（query 与输入框不一致）被丢弃，不覆盖列表态', () => {
    mountMemoryView();
    // 先渲染列表态
    dispatchLoaded({ total: 1, bySource: { 'round-summary': 1 } }, [makeMemory()]);
    expect(document.querySelectorAll('.mem-card')).toHaveLength(1);
    // 用户已清空输入，迟到的旧搜索结果（query 仍为 '记忆视图'）应被丢弃
    dispatchSearchResult('记忆视图', [makeMemory({ name: '过期结果' })]);
    expect(document.querySelector('.search-summary')).toBeNull();
    expect(document.querySelectorAll('.mem-card')).toHaveLength(1);
    expect(document.querySelector('.mem-card-name')?.textContent).toBe('设计决策');
  });

  it('memory_loaded 空列表 → 渲染空态引导', () => {
    mountMemoryView();
    dispatchLoaded({ total: 0, bySource: {} }, []);
    expect(document.querySelector('.empty-title')?.textContent).toBe('暂无记忆');
  });

  it('搜索无命中 → 渲染空态引导（带关键词）', () => {
    mountMemoryView();
    (document.getElementById('searchInput') as HTMLInputElement).value = '不存在';
    dispatchSearchResult('不存在', []);
    expect(document.querySelector('.empty-title')?.textContent).toBe('没有匹配的记忆');
    expect(document.querySelector('.empty-hint')?.textContent).toContain('不存在');
  });

  it('搜索框输入 → 防抖后 postMessage memory_search；清空 → 回到列表', () => {
    vi.useFakeTimers();
    try {
      const { postMessage } = mountMemoryView();
      const input = document.getElementById('searchInput') as HTMLInputElement;
      // 输入关键词 → 防抖 300ms 后发搜索
      input.value = '记忆';
      input.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(300);
      expect(postMessage).toHaveBeenCalledWith({ type: 'memory_search', query: '记忆' });
      // 清空 → 若处于搜索模式则回列表
      postMessage.mockClear();
      input.value = '';
      input.dispatchEvent(new Event('input'));
      vi.advanceTimersByTime(300);
      expect(postMessage).toHaveBeenCalledWith({ type: 'memory_load' });
    } finally {
      vi.useRealTimers();
    }
  });
});
