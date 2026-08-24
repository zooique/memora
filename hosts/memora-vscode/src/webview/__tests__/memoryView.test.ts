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
import type { GovernanceStatsDto, MemoryItemDto, MemoryStatsDto } from '../../shared/protocol.js';

/** 覆盖 createMemoryView 全部查询引用的最小 HTML 骨架（子视图挂载在 #memory-root 根容器内，
 *  与设置视图选项卡合并后的 id 空间隔离约定一致；含 G4 记忆治理区骨架） */
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
    <div id="governance" class="governance">
      <div class="governance-stats">
        <div class="governance-stat"><span id="govActive" class="gov-num">0</span><span class="gov-label">活跃</span></div>
        <div class="governance-stat"><span id="govDeleted" class="gov-num">0</span><span class="gov-label">回收站</span></div>
        <div class="governance-stat"><span id="govDecayRun" class="gov-num">0</span><span class="gov-label">衰减次数</span></div>
      </div>
      <div class="governance-actions">
        <button id="btnDecay" class="btn btn-secondary">触发衰减</button>
        <button id="btnCleanup" class="btn btn-danger">清理过期</button>
      </div>
      <p id="govDetail" class="governance-detail" hidden></p>
    </div>
    <p class="footer-hint">记忆按重要度排序，点击条目查看全文。</p>
    <details id="recycle" class="recycle" role="region" aria-label="回收站">
      <summary>回收站</summary>
      <div id="recycleList"><p class="hint">回收站为空。</p></div>
    </details>
    <p id="memHint" class="mem-hint" hidden></p>
  </div>
`;

/** 挂载 createMemoryView 并返回 postMessage mock（含首屏 memory_load 断言辅助） */
function mountMemoryView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  const root = document.getElementById('memory-root') as HTMLElement;
  createMemoryView({
    vscode: { postMessage },
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

/** 向 webview 分发一条 governance_loaded 消息，驱动治理区渲染 */
function dispatchGovernanceLoaded(stats: GovernanceStatsDto): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'governance_loaded', stats },
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
    // 卡片 tooltip：提示可点击展开/收起（可发现性，对齐角色/配置卡）
    expect(cards[0]?.getAttribute('title')).toBe('点击展开 / 收起详情');
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

  // ─── G4 记忆治理区（2026-08-23） ───

  it('首屏加载 → 额外发送 governance_load', () => {
    const { postMessage } = mountMemoryView();
    expect(postMessage).toHaveBeenCalledWith({ type: 'governance_load' });
  });

  it('governance_loaded 渲染治理统计（活跃/回收站/衰减次数 + 累计详情）', () => {
    mountMemoryView();
    dispatchGovernanceLoaded({
      active: 5,
      deleted: 2,
      bySource: { 'round-summary': 5 },
      decay: { runCount: 3, totalDecayedCount: 12, lastRunAt: '2026-08-23T00:00:00.000Z' },
    });
    expect(document.getElementById('govActive')?.textContent).toBe('5');
    expect(document.getElementById('govDeleted')?.textContent).toBe('2');
    expect(document.getElementById('govDecayRun')?.textContent).toBe('3');
    // 累计衰减详情可见（totalDecayedCount > 0）
    const detail = document.getElementById('govDetail');
    expect(detail?.hidden).toBe(false);
    expect(detail?.textContent).toContain('12 条');
  });

  it('governance_loaded 无衰减记录 → 衰减次数 0 且详情隐藏', () => {
    mountMemoryView();
    dispatchGovernanceLoaded({ active: 0, deleted: 0, bySource: {} });
    expect(document.getElementById('govDecayRun')?.textContent).toBe('0');
    expect(document.getElementById('govDetail')?.hidden).toBe(true);
  });

  it('点击「触发衰减」→ postMessage governance_decay', () => {
    const { postMessage } = mountMemoryView();
    (document.getElementById('btnDecay') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'governance_decay' });
  });

  it('点击「清理过期」→ postMessage governance_cleanup', () => {
    const { postMessage } = mountMemoryView();
    (document.getElementById('btnCleanup') as HTMLButtonElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'governance_cleanup' });
  });

  it('governance_result 显示结果并重新拉取治理数据 + 列表', () => {
    const { postMessage } = mountMemoryView();
    postMessage.mockClear();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'governance_result', ok: true, message: '已清理 3 条过期记忆', action: 'cleanup' },
      }),
    );
    expect(document.getElementById('govDetail')?.textContent).toBe('已清理 3 条过期记忆');
    expect(postMessage).toHaveBeenCalledWith({ type: 'governance_load' });
    expect(postMessage).toHaveBeenCalledWith({ type: 'memory_load' });
  });

  it('governance_result 失败 → 详情带错误样式', () => {
    mountMemoryView();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'governance_result', ok: false, message: 'Agent 未就绪', action: 'decay' },
      }),
    );
    const detail = document.getElementById('govDetail') as HTMLElement;
    expect(detail.hidden).toBe(false);
    expect(detail.classList.contains('gov-error')).toBe(true);
  });

  // ─── G19 单条删除 / 回收站（2026-08-25） ───

  it('memory_loaded 渲染的卡片含删除按钮（✕），点击 → postMessage memory_delete 且阻止卡片展开', () => {
    const { postMessage } = mountMemoryView();
    dispatchLoaded({ total: 1, bySource: { 'round-summary': 1 } }, [makeMemory()]);
    const card = document.querySelector('#list .mem-card') as HTMLElement;
    const delBtn = card.querySelector('.mem-del-btn') as HTMLButtonElement;
    expect(delBtn).not.toBeNull();
    expect(delBtn.getAttribute('aria-label')).toBe('删除记忆');
    // 点击删除：发消息 + stopPropagation（卡片不应展开）
    delBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'memory_delete', id: 'round-summary:设计决策' });
    expect(card.classList.contains('expanded')).toBe(false);
  });

  it('回收站展开（toggle）→ postMessage memory_recycle_load', () => {
    const { postMessage } = mountMemoryView();
    const recycle = document.getElementById('recycle') as HTMLDetailsElement;
    recycle.open = true;
    recycle.dispatchEvent(new Event('toggle'));
    expect(postMessage).toHaveBeenCalledWith({ type: 'memory_recycle_load' });
  });

  it('memory_recycle_loaded 渲染回收站卡片（含删除时间 + 恢复按钮），点击恢复 → postMessage memory_restore', () => {
    const { postMessage } = mountMemoryView();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'memory_recycle_loaded',
          items: [makeMemory({ id: 'round-summary:设计决策', deletedAt: '2026-08-25T08:00:00.000Z' })],
        },
      }),
    );
    const cards = document.querySelectorAll('#recycleList .mem-recycle-card');
    expect(cards).toHaveLength(1);
    // 删除时间被消费（deletedAt 非死字段）
    expect(cards[0]?.querySelector('.mem-recycle-meta')?.textContent).toContain('删除于');
    const restoreBtn = cards[0]?.querySelector('.mem-restore-btn') as HTMLButtonElement;
    expect(restoreBtn).not.toBeNull();
    restoreBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'memory_restore', id: 'round-summary:设计决策' });
  });

  it('memory_recycle_loaded 空列表 → 渲染空态引导', () => {
    mountMemoryView();
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'memory_recycle_loaded', items: [] } }),
    );
    expect(document.querySelector('#recycleList .empty-title')?.textContent).toBe('回收站为空');
  });

  it('memory_deleted 失败（ok:false）→ 显示错误提示 memHint（error 样式）', () => {
    mountMemoryView();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'memory_deleted', ok: false, id: 'x', message: '内核拒绝删除' },
      }),
    );
    const hint = document.getElementById('memHint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toBe('内核拒绝删除');
    expect(hint.classList.contains('mem-hint-error')).toBe(true);
  });

  it('memory_restored 成功且回收站已展开 → 重新拉取回收站列表', () => {
    const { postMessage } = mountMemoryView();
    const recycle = document.getElementById('recycle') as HTMLDetailsElement;
    recycle.open = true;
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'memory_restored', ok: true, id: 'x' } }),
    );
    expect(postMessage).toHaveBeenCalledWith({ type: 'memory_recycle_load' });
  });
});
