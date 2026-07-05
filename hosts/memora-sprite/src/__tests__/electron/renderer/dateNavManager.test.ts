/**
 * 日期导航面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：3 事件绑定（date-nav-btn / date-nav-list / document click）
 * - onDateNavJump / onDateNavOpen：回调注册
 * - toggleDateNavDropdown：切换 + 打开时触发 loadCallback
 * - closeDateNavDropdown：关闭
 * - renderDateNavList：空列表 / 今天/昨天/前天/其他日期 / active 高亮 / 列表项 click 跳转
 * - cleanup：EventTracker 清理 + 回调清空
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理）
 * - JSDOM 提供真实 DOM API
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DateNavManager } from '../../../electron/renderer/panels/dateNavManager.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 日期导航完整 DOM 结构（按钮 + 列表 + 下拉容器） */
const NAV_HTML = `
  <div id="date-navigator">
    <button id="date-nav-btn">日期</button>
    <div id="date-nav-dropdown" class="hidden">
      <ul id="date-nav-list"></ul>
    </div>
  </div>
`;

/** 活跃 Manager 引用（afterEach 中统一 cleanup，避免 document 事件跨测试残留） */
let activeManager: DateNavManager | null = null;

/** 创建 DateNavManager 实例（默认已 init） */
function createManager(opts?: { init?: boolean; html?: string }): DateNavManager {
  document.body.innerHTML = opts?.html ?? NAV_HTML;
  const manager = new DateNavManager();
  if (opts?.init !== false) {
    manager.init();
  }
  activeManager = manager;
  return manager;
}

/** 创建测试用日期列表项 */
function createDateItem(overrides?: Partial<{ date: string; messageCount: number; isToday: boolean }>) {
  return {
    date: '2026-07-01',
    messageCount: 5,
    isToday: true,
    ...overrides,
  };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  // 固定当前日期为 2026-07-01（避免"今天"判定受真实日期影响）
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-01T12:00:00Z'));
  document.body.innerHTML = '';
});

afterEach(() => {
  // 统一 cleanup 活跃 Manager，避免 document 事件监听器跨测试残留
  // （document 是全局共享，body.innerHTML='' 不移除 document 上的事件）
  if (activeManager) {
    activeManager.cleanup();
    activeManager = null;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── init · 事件绑定 ─────────────────────────────────────

describe('init · 事件绑定', () => {
  it('点击 date-nav-btn 应切换下拉显示', () => {
    createManager();
    const dropdown = document.getElementById('date-nav-dropdown')!;
    expect(dropdown.classList.contains('hidden')).toBe(true);
    document.getElementById('date-nav-btn')!.click();
    expect(dropdown.classList.contains('hidden')).toBe(false);
  });

  it('再次点击 date-nav-btn 应切换回隐藏', () => {
    createManager();
    const dropdown = document.getElementById('date-nav-dropdown')!;
    document.getElementById('date-nav-btn')!.click();
    document.getElementById('date-nav-btn')!.click();
    expect(dropdown.classList.contains('hidden')).toBe(true);
  });

  it('点击外部区域应关闭下拉', () => {
    createManager();
    // 先打开下拉
    document.getElementById('date-nav-btn')!.click();
    expect(document.getElementById('date-nav-dropdown')!.classList.contains('hidden')).toBe(false);
    // 模拟点击外部（document body 上非 navigator 区域）
    const outside = document.createElement('div');
    outside.id = 'outside-area';
    document.body.appendChild(outside);
    outside.click();
    expect(document.getElementById('date-nav-dropdown')!.classList.contains('hidden')).toBe(true);
  });

  it('date-nav-btn 缺失时 init 不应抛错', () => {
    document.body.innerHTML = `<div id="date-nav-dropdown" class="hidden"></div>`;
    const manager = new DateNavManager();
    expect(() => manager.init()).not.toThrow();
  });

  it('date-nav-list 缺失时 init 不应抛错', () => {
    document.body.innerHTML = `
      <div id="date-navigator">
        <button id="date-nav-btn">日期</button>
        <div id="date-nav-dropdown" class="hidden"></div>
      </div>
    `;
    const manager = new DateNavManager();
    expect(() => manager.init()).not.toThrow();
  });
});

// ─── onDateNavJump / onDateNavOpen ──────────────────────

describe('回调注册', () => {
  it('onDateNavJump 应注册跳转回调', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);
    // 渲染列表 + 点击列表项触发跳转
    manager.renderDateNavList([createDateItem({ date: '2026-07-01' })], '2026-07-01');
    const item = document.querySelector('[data-action="jump-to-date"]') as HTMLElement;
    item.click();
    expect(callback).toHaveBeenCalledWith('2026-07-01');
  });

  it('onDateNavOpen 应注册加载回调（下拉打开时触发）', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavOpen(callback);
    document.getElementById('date-nav-btn')!.click();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('未注册 onDateNavOpen 时打开下拉不应抛错', () => {
    createManager();
    expect(() => {
      document.getElementById('date-nav-btn')!.click();
    }).not.toThrow();
  });
});

// ─── toggleDateNavDropdown ───────────────────────────────

describe('toggleDateNavDropdown', () => {
  it('应切换 hidden 类', () => {
    const manager = createManager();
    const dropdown = document.getElementById('date-nav-dropdown')!;
    expect(dropdown.classList.contains('hidden')).toBe(true);
    manager.toggleDateNavDropdown();
    expect(dropdown.classList.contains('hidden')).toBe(false);
    manager.toggleDateNavDropdown();
    expect(dropdown.classList.contains('hidden')).toBe(true);
  });

  it('从隐藏切换到显示时应触发 loadCallback', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavOpen(callback);
    manager.toggleDateNavDropdown();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('从显示切换到隐藏时不应触发 loadCallback', () => {
    const manager = createManager();
    // 先打开
    manager.toggleDateNavDropdown();
    const callback = vi.fn();
    manager.onDateNavOpen(callback);
    // 再关闭
    manager.toggleDateNavDropdown();
    expect(callback).not.toHaveBeenCalled();
  });

  it('dropdown 元素缺失时不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new DateNavManager();
    expect(() => manager.toggleDateNavDropdown()).not.toThrow();
  });
});

// ─── closeDateNavDropdown ────────────────────────────────

describe('closeDateNavDropdown', () => {
  it('应添加 hidden 类', () => {
    const manager = createManager();
    // 先打开
    document.getElementById('date-nav-btn')!.click();
    expect(document.getElementById('date-nav-dropdown')!.classList.contains('hidden')).toBe(false);
    manager.closeDateNavDropdown();
    expect(document.getElementById('date-nav-dropdown')!.classList.contains('hidden')).toBe(true);
  });

  it('dropdown 元素缺失时不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new DateNavManager();
    expect(() => manager.closeDateNavDropdown()).not.toThrow();
  });
});

// ─── renderDateNavList · 空列表 ──────────────────────────

describe('renderDateNavList · 空列表', () => {
  it('空数组应显示"暂无历史对话"', () => {
    const manager = createManager();
    manager.renderDateNavList([], '');
    const empty = document.querySelector('.date-nav-empty');
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe('暂无历史对话');
  });

  it('空列表应清空旧内容', () => {
    const manager = createManager();
    // 先渲染有数据
    manager.renderDateNavList([createDateItem()], '2026-07-01');
    expect(document.querySelectorAll('.date-nav-item').length).toBe(1);
    // 再渲染空列表
    manager.renderDateNavList([], '');
    expect(document.querySelectorAll('.date-nav-item').length).toBe(0);
    expect(document.querySelector('.date-nav-empty')).not.toBeNull();
  });

  it('list 元素缺失时不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new DateNavManager();
    expect(() => manager.renderDateNavList([], '')).not.toThrow();
  });
});

// ─── renderDateNavList · 日期显示 ────────────────────────

describe('renderDateNavList · 日期文本显示', () => {
  it('isToday=true 应显示"今天"', () => {
    const manager = createManager();
    manager.renderDateNavList([createDateItem({ isToday: true })], '2026-07-01');
    expect(document.querySelector('.date-nav-item-date')!.textContent).toBe('今天');
  });

  it('昨天（diffDays=1）应显示"昨天"', () => {
    const manager = createManager();
    manager.renderDateNavList([createDateItem({ date: '2026-06-30', isToday: false })], '2026-07-01');
    expect(document.querySelector('.date-nav-item-date')!.textContent).toBe('昨天');
  });

  it('前天（diffDays=2）应显示"前天"', () => {
    const manager = createManager();
    manager.renderDateNavList([createDateItem({ date: '2026-06-29', isToday: false })], '2026-07-01');
    expect(document.querySelector('.date-nav-item-date')!.textContent).toBe('前天');
  });

  it('更早的日期应显示完整日期', () => {
    const manager = createManager();
    manager.renderDateNavList([createDateItem({ date: '2026-06-20', isToday: false })], '2026-07-01');
    expect(document.querySelector('.date-nav-item-date')!.textContent).toBe('2026-06-20');
  });

  it('应显示消息数', () => {
    const manager = createManager();
    manager.renderDateNavList([createDateItem({ messageCount: 12 })], '2026-07-01');
    expect(document.querySelector('.date-nav-item-count')!.textContent).toBe('12 条');
  });
});

// ─── renderDateNavList · active 高亮 ─────────────────────

describe('renderDateNavList · active 高亮', () => {
  it('date === currentDate 应添加 active 类', () => {
    const manager = createManager();
    manager.renderDateNavList([
      createDateItem({ date: '2026-07-01' }),
      createDateItem({ date: '2026-06-30', isToday: false }),
    ], '2026-07-01');
    const items = document.querySelectorAll('.date-nav-item');
    expect(items[0].classList.contains('active')).toBe(true);
    expect(items[1].classList.contains('active')).toBe(false);
  });

  it('应设置 data-action 和 data-date 属性', () => {
    const manager = createManager();
    manager.renderDateNavList([createDateItem({ date: '2026-07-01' })], '2026-07-01');
    const item = document.querySelector('.date-nav-item') as HTMLElement;
    expect(item.dataset.action).toBe('jump-to-date');
    expect(item.dataset.date).toBe('2026-07-01');
  });
});

// ─── renderDateNavList · 列表项点击跳转 ──────────────────

describe('renderDateNavList · 列表项点击跳转', () => {
  it('点击列表项应触发 jumpCallback 并关闭下拉', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);
    // 先打开下拉
    document.getElementById('date-nav-btn')!.click();
    expect(document.getElementById('date-nav-dropdown')!.classList.contains('hidden')).toBe(false);
    manager.renderDateNavList([createDateItem({ date: '2026-07-01' })], '2026-07-01');
    const item = document.querySelector('[data-action="jump-to-date"]') as HTMLElement;
    item.click();
    expect(callback).toHaveBeenCalledWith('2026-07-01');
    // 点击跳转后应关闭下拉
    expect(document.getElementById('date-nav-dropdown')!.classList.contains('hidden')).toBe(true);
  });

  it('未注册 jumpCallback 时点击列表项不应抛错', () => {
    const manager = createManager();
    manager.renderDateNavList([createDateItem({ date: '2026-07-01' })], '2026-07-01');
    const item = document.querySelector('[data-action="jump-to-date"]') as HTMLElement;
    expect(() => item.click()).not.toThrow();
  });

  it('列表项 data-date 为空时不应触发跳转', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);
    manager.renderDateNavList([createDateItem({ date: '2026-07-01' })], '2026-07-01');
    const item = document.querySelector('[data-action="jump-to-date"]') as HTMLElement;
    item.dataset.date = ''; // 模拟 data-date 为空
    item.click();
    expect(callback).not.toHaveBeenCalled();
  });
});

// ─── renderDateNavList · 删除按钮 ──────────────────────

describe('renderDateNavList · 删除按钮', () => {
  it('非今天日期应渲染删除按钮', () => {
    const manager = createManager();
    manager.renderDateNavList([
      createDateItem({ date: '2026-06-30', isToday: false }),
    ], '2026-06-30');
    const deleteBtn = document.querySelector('[data-action="delete-date"]') as HTMLElement;
    expect(deleteBtn).not.toBeNull();
    expect(deleteBtn.dataset.date).toBe('2026-06-30');
  });

  it('今天日期不应渲染删除按钮', () => {
    const manager = createManager();
    manager.renderDateNavList([
      createDateItem({ date: '2026-07-01', isToday: true }),
    ], '2026-07-01');
    const deleteBtn = document.querySelector('[data-action="delete-date"]');
    expect(deleteBtn).toBeNull();
  });

  it('点击删除按钮应触发 deleteCallback 且不触发 jumpCallback', () => {
    const manager = createManager();
    const jumpCallback = vi.fn();
    const deleteCallback = vi.fn();
    manager.onDateNavJump(jumpCallback);
    manager.onDateNavDelete(deleteCallback);
    manager.renderDateNavList([
      createDateItem({ date: '2026-06-30', isToday: false }),
    ], '2026-06-30');
    const deleteBtn = document.querySelector('[data-action="delete-date"]') as HTMLElement;
    deleteBtn.click();
    // 删除回调应被调用
    expect(deleteCallback).toHaveBeenCalledWith('2026-06-30');
    // 跳转回调不应被调用（stopPropagation 阻止冒泡）
    expect(jumpCallback).not.toHaveBeenCalled();
  });

  it('未注册 deleteCallback 时点击删除按钮不应抛错', () => {
    const manager = createManager();
    manager.renderDateNavList([
      createDateItem({ date: '2026-06-30', isToday: false }),
    ], '2026-06-30');
    const deleteBtn = document.querySelector('[data-action="delete-date"]') as HTMLElement;
    expect(() => deleteBtn.click()).not.toThrow();
  });

  it('删除按钮 data-date 为空时不应触发 deleteCallback', () => {
    const manager = createManager();
    const deleteCallback = vi.fn();
    manager.onDateNavDelete(deleteCallback);
    manager.renderDateNavList([
      createDateItem({ date: '2026-06-30', isToday: false }),
    ], '2026-06-30');
    const deleteBtn = document.querySelector('[data-action="delete-date"]') as HTMLElement;
    deleteBtn.dataset.date = '';
    deleteBtn.click();
    expect(deleteCallback).not.toHaveBeenCalled();
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup · 事件与回调清理', () => {
  it('cleanup 后 date-nav-btn click 不应切换下拉', () => {
    const manager = createManager();
    manager.cleanup();
    document.getElementById('date-nav-btn')!.click();
    // cleanup 后 events 已清理，click 不应触发 toggle
    expect(document.getElementById('date-nav-dropdown')!.classList.contains('hidden')).toBe(true);
  });

  it('cleanup 后列表项 click 不应触发 jumpCallback', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);
    manager.renderDateNavList([createDateItem({ date: '2026-07-01' })], '2026-07-01');
    manager.cleanup();
    const item = document.querySelector('[data-action="jump-to-date"]') as HTMLElement;
    item.click();
    expect(callback).not.toHaveBeenCalled();
  });

  it('cleanup 后外部点击不应触发 close 或 toggle', () => {
    const manager = createManager();
    // 直接调用 toggle 打开下拉（不通过 click 触发事件冒泡）
    manager.toggleDateNavDropdown();
    // spy 监控 cleanup 后是否还有方法被调用
    const closeSpy = vi.spyOn(manager, 'closeDateNavDropdown');
    const toggleSpy = vi.spyOn(manager, 'toggleDateNavDropdown');
    manager.cleanup();
    // 模拟外部区域点击
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    outside.click();
    // document click 事件已解绑，close 和 toggle 都不应被调用
    expect(closeSpy).not.toHaveBeenCalled();
    expect(toggleSpy).not.toHaveBeenCalled();
  });

  it('cleanup 应清空 jumpCallback、deleteCallback 和 loadCallback 引用', () => {
    const manager = createManager();
    manager.onDateNavJump(vi.fn());
    manager.onDateNavDelete(vi.fn());
    manager.onDateNavOpen(vi.fn());
    manager.cleanup();
    // cleanup 后再注册新回调 + 触发应正常工作（验证引用已清空但机制仍可用）
    const newJump = vi.fn();
    const newDelete = vi.fn();
    const newLoad = vi.fn();
    manager.onDateNavJump(newJump);
    manager.onDateNavDelete(newDelete);
    manager.onDateNavOpen(newLoad);
    // 注意：cleanup 后 events 已清理，需重新 init 才能绑定事件
    manager.init();
    manager.renderDateNavList([createDateItem({ date: '2026-06-30', isToday: false })], '2026-06-30');
    document.querySelector('[data-action="jump-to-date"]')!.click();
    expect(newJump).toHaveBeenCalledWith('2026-06-30');
    document.querySelector('[data-action="delete-date"]')!.click();
    expect(newDelete).toHaveBeenCalledWith('2026-06-30');
  });
});
