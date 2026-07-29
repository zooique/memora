/**
 * 对话内容搜索管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：DOM 绑定、元素缺失降级、快捷键、输入防抖、事件委托
 * - open/close：可见性、焦点、背景滚动、清空状态
 * - scheduleSearch：防抖定时器、弹窗关闭时不调度
 * - performSearch：最小长度、重复关键词跳过、IPC 调用、结果渲染、错误处理
 * - renderResults：日期分组、今天/昨天标签、空结果
 * - createResultItem：角色徽章、时间、内容高亮
 * - highlightKeyword：XSS 安全、多关键词、正则特殊字符
 * - onResultClick：回调注册与触发
 * - cleanup：事件清理、定时器清理、回调清空
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API
 * - Mock window.electronAPI.searchSessionMessages
 * - vi.useFakeTimers 控制防抖定时器
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SearchMessagesManager } from '../../../electron/renderer/panels/searchMessagesManager.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建搜索弹窗 DOM 结构 */
function setupDOM(): {
  modal: HTMLElement;
  input: HTMLInputElement;
  results: HTMLElement;
  searchBtn: HTMLElement;
} {
  document.body.innerHTML = `
    <button id="btn-search-messages">搜索</button>
    <div id="search-messages-modal" class="hidden">
      <input id="search-messages-input" type="text" />
      <div id="search-messages-results"></div>
    </div>
  `;
  return {
    modal: document.getElementById('search-messages-modal') as HTMLElement,
    input: document.getElementById('search-messages-input') as HTMLInputElement,
    results: document.getElementById('search-messages-results') as HTMLElement,
    searchBtn: document.getElementById('btn-search-messages') as HTMLElement,
  };
}

/** Mock electronAPI.searchSessionMessages */
function mockSearchAPI(results: Array<{ date: string; session: string; role: string; content: string; timestamp: string }> = []): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ results }));
  Object.defineProperty(window, 'electronAPI', {
    value: { searchSessionMessages: fn, rendererLog: vi.fn() },
    configurable: true,
    writable: true,
  });
  return fn;
}

/** 模拟输入并触发防抖搜索（需配合 vi.useFakeTimers） */
function typeAndTriggerSearch(manager: SearchMessagesManager, input: HTMLInputElement, text: string): void {
  manager.open();
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  // 推进防抖定时器
  vi.advanceTimersByTime(300);
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  mockSearchAPI();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── 1. init ───────────────────────────────────────────

describe('init', () => {
  it('应绑定 DOM 元素并注册事件监听器', () => {
    const dom = setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    // 点击搜索按钮应打开弹窗
    dom.searchBtn.click();
    expect(dom.modal.classList.contains('hidden')).toBe(false);
    manager.cleanup();
  });

  it('DOM 元素缺失应降级（不绑定事件）', () => {
    document.body.innerHTML = '<button id="btn-search-messages">搜索</button>';
    const manager = new SearchMessagesManager();
    expect(() => manager.init()).not.toThrow();
    // 搜索按钮点击不应打开弹窗（modal 不存在）
    const btn = document.getElementById('btn-search-messages') as HTMLElement;
    btn.click();
    manager.cleanup();
  });

  it('Ctrl+Shift+F 应切换弹窗可见性', () => {
    const dom = setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    // Ctrl+Shift+F 打开
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', ctrlKey: true, shiftKey: true, bubbles: true,
    }));
    expect(dom.modal.classList.contains('hidden')).toBe(false);
    // Ctrl+Shift+F 关闭
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'F', ctrlKey: true, shiftKey: true, bubbles: true,
    }));
    expect(dom.modal.classList.contains('hidden')).toBe(true);
    manager.cleanup();
  });

  it('Cmd+Shift+F 应也切换弹窗（macOS）', () => {
    const dom = setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'f', metaKey: true, shiftKey: true, bubbles: true,
    }));
    expect(dom.modal.classList.contains('hidden')).toBe(false);
    manager.cleanup();
  });

  it('输入框 Esc 应关闭弹窗', () => {
    const dom = setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    manager.open();
    dom.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dom.modal.classList.contains('hidden')).toBe(true);
    manager.cleanup();
  });

  it('点击遮罩层应关闭弹窗', () => {
    const dom = setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    manager.open();
    // 点击 modal 本身（遮罩）
    dom.modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dom.modal.classList.contains('hidden')).toBe(true);
    manager.cleanup();
  });
});

// ─── 2. open / close ───────────────────────────────────

describe('open / close', () => {
  it('open 应移除 hidden 类、清空输入、聚焦输入框、阻止背景滚动', () => {
    const dom = setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    manager.open();
    expect(dom.modal.classList.contains('hidden')).toBe(false);
    expect(dom.input.value).toBe('');
    expect(document.activeElement).toBe(dom.input);
    expect(document.body.style.overflow).toBe('hidden');
    manager.cleanup();
  });

  it('open 应显示初始空状态提示', () => {
    const dom = setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    manager.open();
    const empty = dom.results.querySelector('.empty-state');
    expect(empty?.textContent).toContain('输入关键词搜索');
    manager.cleanup();
  });

  it('close 应添加 hidden 类、清空输入、恢复背景滚动', () => {
    const dom = setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    manager.open();
    manager.close();
    expect(dom.modal.classList.contains('hidden')).toBe(true);
    expect(dom.input.value).toBe('');
    expect(document.body.style.overflow).toBe('');
    manager.cleanup();
  });

  it('close 应取消待执行的防抖定时器', () => {
    const dom = setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    manager.open();
    dom.input.value = 'test';
    dom.input.dispatchEvent(new Event('input', { bubbles: true }));
    manager.close();
    // 推进定时器不应触发搜索
    vi.advanceTimersByTime(300);
    const empty = dom.results.querySelector('.empty-state');
    // 应仍是初始空状态，不是搜索中或搜索结果
    expect(empty?.textContent).toContain('输入关键词搜索');
    manager.cleanup();
  });

  it('DOM 元素为 null 时 open 应静默返回', () => {
    const manager = new SearchMessagesManager();
    expect(() => manager.open()).not.toThrow();
  });

  it('DOM 元素为 null 时 close 应静默返回', () => {
    const manager = new SearchMessagesManager();
    expect(() => manager.close()).not.toThrow();
  });
});

// ─── 3. scheduleSearch / performSearch ─────────────────

describe('scheduleSearch / performSearch', () => {
  it('输入应触发 300ms 防抖搜索', async () => {
    const dom = setupDOM();
    const searchFn = mockSearchAPI([
      { date: '2026-07-12', session: 'main', role: 'user', content: 'hello world', timestamp: '2026-07-12T10:00:00' },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'hello');
    // 等待异步搜索完成
    await vi.mocked(searchFn).mock.results[0]?.value;
    expect(searchFn).toHaveBeenCalledWith({ keyword: 'hello', limit: 50 });
    manager.cleanup();
  });

  it('关键词少于 2 字符应显示提示', async () => {
    const dom = setupDOM();
    const searchFn = mockSearchAPI();
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'a');
    expect(searchFn).not.toHaveBeenCalled();
    const empty = dom.results.querySelector('.empty-state');
    expect(empty?.textContent).toContain('至少 2 个字符');
    manager.cleanup();
  });

  it('相同关键词应跳过搜索', async () => {
    const dom = setupDOM();
    const searchFn = mockSearchAPI([]);
    const manager = new SearchMessagesManager();
    manager.init();
    // 第一次搜索
    typeAndTriggerSearch(manager, dom.input, 'test');
    await vi.mocked(searchFn).mock.results[0]?.value;
    expect(searchFn).toHaveBeenCalledTimes(1);
    // 第二次相同关键词
    dom.input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(300);
    expect(searchFn).toHaveBeenCalledTimes(1);
    manager.cleanup();
  });

  it('搜索中状态应防止并发请求', async () => {
    const dom = setupDOM();
    let resolveSearch: (value: { results: unknown[] }) => void = () => {};
    const searchFn = vi.fn(() => new Promise<{ results: unknown[] }>((resolve) => { resolveSearch = resolve; }));
    Object.defineProperty(window, 'electronAPI', {
      value: { searchSessionMessages: searchFn, rendererLog: vi.fn() },
      configurable: true, writable: true,
    });
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'test');
    // 第一次搜索还在 pending，再次输入不同关键词
    dom.input.value = 'test2';
    dom.input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(300);
    // 应只有 1 次调用（第二次被 isSearching 拦截）
    expect(searchFn).toHaveBeenCalledTimes(1);
    // 解析第一次搜索
    resolveSearch({ results: [] });
    await vi.mocked(searchFn).mock.results[0]?.value;
    manager.cleanup();
  });

  it('搜索应显示加载状态', async () => {
    const dom = setupDOM();
    let resolveSearch: (value: { results: unknown[] }) => void = () => {};
    const searchFn = vi.fn(() => new Promise<{ results: unknown[] }>((resolve) => { resolveSearch = resolve; }));
    Object.defineProperty(window, 'electronAPI', {
      value: { searchSessionMessages: searchFn, rendererLog: vi.fn() },
      configurable: true, writable: true,
    });
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'test');
    const loading = dom.results.querySelector('.search-messages-loading');
    expect(loading?.textContent).toContain('搜索中');
    resolveSearch({ results: [] });
    await vi.mocked(searchFn).mock.results[0]?.value;
    manager.cleanup();
  });

  it('搜索失败应显示错误提示', async () => {
    const dom = setupDOM();
    const searchFn = vi.fn(async () => { throw new Error('搜索失败'); });
    Object.defineProperty(window, 'electronAPI', {
      value: { searchSessionMessages: searchFn, rendererLog: vi.fn() },
      configurable: true, writable: true,
    });
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'test');
    await vi.waitFor(() => {
      const empty = dom.results.querySelector('.empty-state');
      expect(empty?.textContent).toContain('搜索失败');
    });
    manager.cleanup();
  });

  it('弹窗在搜索期间关闭后不应渲染结果', async () => {
    const dom = setupDOM();
    let resolveSearch: (value: { results: unknown[] }) => void = () => {};
    const searchFn = vi.fn(() => new Promise<{ results: unknown[] }>((resolve) => { resolveSearch = resolve; }));
    Object.defineProperty(window, 'electronAPI', {
      value: { searchSessionMessages: searchFn, rendererLog: vi.fn() },
      configurable: true, writable: true,
    });
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'test');
    // 搜索 pending 期间关闭弹窗
    manager.close();
    resolveSearch({ results: [{ date: '2026-07-12', session: 'main', role: 'user', content: 'test', timestamp: '2026-07-12T10:00:00' }] });
    await vi.mocked(searchFn).mock.results[0]?.value;
    // 弹窗关闭后不应渲染结果（results 应为空状态或初始提示）
    const items = dom.results.querySelectorAll('.search-messages-item');
    expect(items.length).toBe(0);
    manager.cleanup();
  });

  // R1 修复回归测试：搜索期间用户输入新关键词，被 isSearching 守卫拦截后，
  // 搜索完成后应自动重新调度搜索，确保最新关键词的搜索结果最终呈现给用户
  it('搜索期间输入新关键词，搜索完成后应自动触发新搜索（R1 修复）', async () => {
    const dom = setupDOM();
    let resolveFirst: (value: { results: unknown[] }) => void = () => {};
    let resolveSecond: (value: { results: unknown[] }) => void = () => {};
    // 第一次搜索 pending，第二次搜索也 pending（模拟 IPC 慢响应）
    const searchFn = vi.fn(() => new Promise<{ results: unknown[] }>((resolve) => {
      // 第一次调用挂起在 resolveFirst，第二次挂起在 resolveSecond
      if (searchFn.mock.calls.length === 1) {
        resolveFirst = resolve;
      } else {
        resolveSecond = resolve;
      }
    }));
    Object.defineProperty(window, 'electronAPI', {
      value: { searchSessionMessages: searchFn, rendererLog: vi.fn() },
      configurable: true, writable: true,
    });
    const manager = new SearchMessagesManager();
    manager.init();
    // 第一次输入 "test"，触发防抖搜索
    typeAndTriggerSearch(manager, dom.input, 'test');
    expect(searchFn).toHaveBeenCalledTimes(1);
    // 第一次搜索 pending 期间，用户输入新关键词 "test2"
    dom.input.value = 'test2';
    dom.input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(300);
    // 第二次 performSearch 被 isSearching 守卫拦截，searchFn 仍只被调用 1 次
    expect(searchFn).toHaveBeenCalledTimes(1);
    // 解析第一次搜索 → finally 块检测到 inputEl.value="test2" !== lastKeyword="test" → 重新调度
    resolveFirst({ results: [] });
    await vi.mocked(searchFn).mock.results[0]?.value;
    // 推进防抖定时器，第二次搜索应被触发
    vi.advanceTimersByTime(300);
    expect(searchFn).toHaveBeenCalledTimes(2);
    expect(searchFn).toHaveBeenNthCalledWith(2, { keyword: 'test2', limit: 50 });
    // 清理：解析第二次搜索避免悬挂 Promise
    resolveSecond({ results: [] });
    await vi.mocked(searchFn).mock.results[1]?.value;
    manager.cleanup();
  });

  // R1 修复反向测试：搜索完成后关键词未变化时不应无限重新调度（避免死循环）
  it('搜索完成后关键词未变化时不应重新调度搜索（R1 修复防死循环）', async () => {
    const dom = setupDOM();
    const searchFn = mockSearchAPI([]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'test');
    await vi.mocked(searchFn).mock.results[0]?.value;
    // 关键词未变化，不应再次调用 searchFn
    vi.advanceTimersByTime(300);
    expect(searchFn).toHaveBeenCalledTimes(1);
    manager.cleanup();
  });
});

// ─── 4. renderResults ──────────────────────────────────

describe('renderResults', () => {
  it('空结果应显示无匹配提示', async () => {
    const dom = setupDOM();
    mockSearchAPI([]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'nomatch');
    await vi.waitFor(() => {
      const empty = dom.results.querySelector('.empty-state');
      expect(empty?.textContent).toContain('无匹配结果');
    });
    manager.cleanup();
  });

  it('结果应按日期倒序分组', async () => {
    const dom = setupDOM();
    mockSearchAPI([
      { date: '2026-07-10', session: 'main', role: 'user', content: 'old', timestamp: '2026-07-10T10:00:00' },
      { date: '2026-07-12', session: 'main', role: 'user', content: 'new', timestamp: '2026-07-12T10:00:00' },
      { date: '2026-07-11', session: 'main', role: 'user', content: 'mid', timestamp: '2026-07-11T10:00:00' },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'test');
    await vi.waitFor(() => {
      const groups = dom.results.querySelectorAll('.search-messages-group');
      expect(groups.length).toBe(3);
      // 倒序：07-12 → 07-11 → 07-10
      expect(groups[0].textContent).toContain('2026-07-12');
      expect(groups[1].textContent).toContain('2026-07-11');
      expect(groups[2].textContent).toContain('2026-07-10');
    });
    manager.cleanup();
  });

  it('今天的日期应显示"今天"标签', async () => {
    const dom = setupDOM();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    mockSearchAPI([
      { date: todayStr, session: 'main', role: 'user', content: 'today', timestamp: today.toISOString() },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'today');
    await vi.waitFor(() => {
      const group = dom.results.querySelector('.search-messages-group');
      expect(group?.textContent).toContain('今天');
    });
    manager.cleanup();
  });
});

// ─── 5. createResultItem / highlightKeyword ────────────

describe('createResultItem / highlightKeyword', () => {
  it('结果项应包含角色徽章和时间', async () => {
    const dom = setupDOM();
    mockSearchAPI([
      { date: '2026-07-12', session: 'main', role: 'user', content: 'hello', timestamp: '2026-07-12T10:30:00' },
      { date: '2026-07-12', session: 'main', role: 'assistant', content: 'hi', timestamp: '2026-07-12T10:31:00' },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'hello');
    await vi.waitFor(() => {
      const items = dom.results.querySelectorAll('.search-messages-item');
      expect(items.length).toBe(2);
      // user 角色徽章应为"我"
      const userBadge = items[0].querySelector('.search-messages-role');
      expect(userBadge?.textContent).toBe('我');
      // assistant 角色徽章应为"精灵"
      const assistantBadge = items[1].querySelector('.search-messages-role');
      expect(assistantBadge?.textContent).toBe('精灵');
    });
    manager.cleanup();
  });

  it('结果项应包含 data-date 和 data-session 属性', async () => {
    const dom = setupDOM();
    mockSearchAPI([
      { date: '2026-07-12', session: 'main', role: 'user', content: 'test', timestamp: '2026-07-12T10:00:00' },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'test');
    await vi.waitFor(() => {
      const item = dom.results.querySelector('.search-messages-item') as HTMLElement;
      expect(item.dataset.date).toBe('2026-07-12');
      expect(item.dataset.session).toBe('main');
    });
    manager.cleanup();
  });

  it('关键词应被 <mark> 标签高亮', async () => {
    const dom = setupDOM();
    mockSearchAPI([
      { date: '2026-07-12', session: 'main', role: 'user', content: 'hello world', timestamp: '2026-07-12T10:00:00' },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'hello');
    await vi.waitFor(() => {
      const content = dom.results.querySelector('.search-messages-content');
      expect(content?.innerHTML).toContain('<mark>hello</mark>');
    });
    manager.cleanup();
  });

  it('多关键词应分别高亮', async () => {
    const dom = setupDOM();
    mockSearchAPI([
      { date: '2026-07-12', session: 'main', role: 'user', content: 'hello world foo', timestamp: '2026-07-12T10:00:00' },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'hello world');
    await vi.waitFor(() => {
      const content = dom.results.querySelector('.search-messages-content');
      expect(content?.innerHTML).toContain('<mark>hello</mark>');
      expect(content?.innerHTML).toContain('<mark>world</mark>');
    });
    manager.cleanup();
  });

  it('XSS 内容应被转义（不解析为 HTML）', async () => {
    const dom = setupDOM();
    mockSearchAPI([
      { date: '2026-07-12', session: 'main', role: 'user', content: '<script>alert(1)</script>', timestamp: '2026-07-12T10:00:00' },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'script');
    await vi.waitFor(() => {
      const content = dom.results.querySelector('.search-messages-content');
      // < > 应被转义为 &lt; &gt;，不应有 <script> 标签
      expect(content?.innerHTML).not.toContain('<script>');
      // 高亮后关键词被 <mark> 包裹，&lt; 和 &gt; 分属 mark 标签两侧
      expect(content?.innerHTML).toContain('&lt;<mark>script</mark>&gt;');
      expect(content?.innerHTML).toContain('&lt;/<mark>script</mark>&gt;');
    });
    manager.cleanup();
  });

  it('正则特殊字符的关键词应安全高亮', async () => {
    const dom = setupDOM();
    mockSearchAPI([
      { date: '2026-07-12', session: 'main', role: 'user', content: 'price: $50 (USD)', timestamp: '2026-07-12T10:00:00' },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, '$50');
    await vi.waitFor(() => {
      const content = dom.results.querySelector('.search-messages-content');
      expect(content?.innerHTML).toContain('<mark>$50</mark>');
    });
    manager.cleanup();
  });
});

// ─── 6. onResultClick ──────────────────────────────────

describe('onResultClick', () => {
  it('点击结果项应触发回调并关闭弹窗', async () => {
    const dom = setupDOM();
    mockSearchAPI([
      { date: '2026-07-12', session: 'main', role: 'user', content: 'test', timestamp: '2026-07-12T10:00:00' },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    const callback = vi.fn();
    manager.onResultClick(callback);
    typeAndTriggerSearch(manager, dom.input, 'test');
    await vi.waitFor(() => {
      const item = dom.results.querySelector('.search-messages-item') as HTMLElement;
      expect(item).toBeTruthy();
    });
    const item = dom.results.querySelector('.search-messages-item') as HTMLElement;
    item.click();
    expect(callback).toHaveBeenCalledWith('2026-07-12', 'main');
    expect(dom.modal.classList.contains('hidden')).toBe(true);
    manager.cleanup();
  });

  it('未注册回调时点击结果项应静默返回', async () => {
    const dom = setupDOM();
    mockSearchAPI([
      { date: '2026-07-12', session: 'main', role: 'user', content: 'test', timestamp: '2026-07-12T10:00:00' },
    ]);
    const manager = new SearchMessagesManager();
    manager.init();
    typeAndTriggerSearch(manager, dom.input, 'test');
    await vi.waitFor(() => {
      const item = dom.results.querySelector('.search-messages-item') as HTMLElement;
      expect(item).toBeTruthy();
    });
    const item = dom.results.querySelector('.search-messages-item') as HTMLElement;
    expect(() => item.click()).not.toThrow();
    manager.cleanup();
  });
});

// ─── 7. cleanup ────────────────────────────────────────

describe('cleanup', () => {
  it('应清理事件监听器', () => {
    const dom = setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    manager.cleanup();
    // cleanup 后点击搜索按钮不应打开弹窗
    dom.searchBtn.click();
    expect(dom.modal.classList.contains('hidden')).toBe(true);
  });

  it('应清理防抖定时器', () => {
    const dom = setupDOM();
    const searchFn = mockSearchAPI([]);
    const manager = new SearchMessagesManager();
    manager.init();
    manager.open();
    dom.input.value = 'test';
    dom.input.dispatchEvent(new Event('input', { bubbles: true }));
    manager.cleanup();
    vi.advanceTimersByTime(300);
    expect(searchFn).not.toHaveBeenCalled();
  });

  it('应清空回调引用', () => {
    setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    manager.onResultClick(vi.fn());
    manager.cleanup();
    // cleanup 后不应有回调引用（通过点击结果项不触发来间接验证）
    // 重新 init 不应报错
    expect(() => manager.init()).not.toThrow();
  });

  it('打开状态下 cleanup 应恢复背景滚动', () => {
    setupDOM();
    const manager = new SearchMessagesManager();
    manager.init();
    manager.open();
    expect(document.body.style.overflow).toBe('hidden');
    manager.cleanup();
    expect(document.body.style.overflow).toBe('');
  });
});
