/**
 * 日期导航下拉列表测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：按钮点击展开/收起，外部点击关闭
 * - onDateNavJump：回调注册
 * - updateAvailableDates：更新可用日期集合
 * - setCurrentDate：设置当前显示日期
 * - renderDateList：日期列表渲染（倒序、高亮、计数）
 * - cleanup：事件清理 + 回调清空
 *
 * 从原生 <input type="date"> 重构为自定义下拉列表。
 * 只显示有对话记录的日期，无记录日期不显示。
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理）
 * - JSDOM 提供真实 DOM API
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DateNavManager } from '../../../electron/renderer/panels/dateNavManager.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 日期导航 DOM 结构（按钮 + 下拉列表） */
const NAV_HTML = `
  <div id="date-navigator">
    <button id="date-nav-btn" aria-expanded="false">
      <span id="date-nav-label">选择日期</span>
    </button>
    <div id="date-nav-dropdown" class="hidden">
      <div id="date-nav-list"></div>
    </div>
  </div>
`;

/** 测试用可用日期列表 */
const TEST_DATES = ['2026-06-25', '2026-06-26', '2026-06-30', '2026-07-01', '2026-07-06'];

/** 活跃 Manager 引用（afterEach 中统一 cleanup） */
let activeManager: DateNavManager | null = null;

/** 创建 DateNavManager 实例（默认已 init 并设置可用日期） */
function createManager(opts?: { init?: boolean; html?: string; dates?: string[] }): DateNavManager {
  document.body.innerHTML = opts?.html ?? NAV_HTML;
  const manager = new DateNavManager();
  if (opts?.init !== false) {
    manager.init();
  }
  // 默认设置可用日期
  manager.updateAvailableDates(opts?.dates ?? TEST_DATES);
  activeManager = manager;
  return manager;
}

/** 点击日期按钮（展开下拉） */
function clickNavBtn(): void {
  const btn = document.getElementById('date-nav-btn');
  if (!btn) return;
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** 点击日期列表中的某一项 */
function clickDateItem(date: string): void {
  const item = document.querySelector(`.date-nav-item[data-date="${date}"]`);
  if (!item) return;
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** 点击外部区域（关闭下拉） */
function clickOutside(): void {
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  if (activeManager) {
    activeManager.cleanup();
    activeManager = null;
  }
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── init · 事件绑定 ─────────────────────────────────────

describe('init · 事件绑定', () => {
  it('点击按钮应展开下拉列表', () => {
    createManager();
    const dropdown = document.getElementById('date-nav-dropdown');
    const btn = document.getElementById('date-nav-btn');
    expect(dropdown?.classList.contains('hidden')).toBe(true);
    expect(btn?.getAttribute('aria-expanded')).toBe('false');

    clickNavBtn();

    expect(dropdown?.classList.contains('hidden')).toBe(false);
    expect(btn?.getAttribute('aria-expanded')).toBe('true');
  });

  it('再次点击按钮应收起下拉列表', () => {
    createManager();
    clickNavBtn(); // 展开
    clickNavBtn(); // 收起

    const dropdown = document.getElementById('date-nav-dropdown');
    expect(dropdown?.classList.contains('hidden')).toBe(true);
  });

  it('点击外部区域应关闭下拉', () => {
    createManager();
    clickNavBtn(); // 展开

    clickOutside();

    const dropdown = document.getElementById('date-nav-dropdown');
    expect(dropdown?.classList.contains('hidden')).toBe(true);
  });

  it('按 Esc 应关闭下拉', () => {
    createManager();
    clickNavBtn(); // 展开

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    const dropdown = document.getElementById('date-nav-dropdown');
    expect(dropdown?.classList.contains('hidden')).toBe(true);
  });

  it('选择有记录的日期应触发 jumpCallback', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);

    clickNavBtn();
    clickDateItem('2026-07-01');

    expect(callback).toHaveBeenCalledWith('2026-07-01');
  });

  it('选择日期后应自动关闭下拉', () => {
    createManager();
    clickNavBtn();
    clickDateItem('2026-07-01');

    const dropdown = document.getElementById('date-nav-dropdown');
    expect(dropdown?.classList.contains('hidden')).toBe(true);
  });

  it('按钮元素缺失时 init 不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new DateNavManager();
    expect(() => manager.init()).not.toThrow();
  });
});

// ─── onDateNavJump · 回调注册 ────────────────────────────

describe('onDateNavJump · 回调注册', () => {
  it('应注册跳转回调', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);

    clickNavBtn();
    clickDateItem('2026-06-30');

    expect(callback).toHaveBeenCalledWith('2026-06-30');
  });

  it('重复注册应覆盖旧回调', () => {
    const manager = createManager();
    const oldCallback = vi.fn();
    const newCallback = vi.fn();
    manager.onDateNavJump(oldCallback);
    manager.onDateNavJump(newCallback);

    clickNavBtn();
    clickDateItem('2026-07-01');

    expect(oldCallback).not.toHaveBeenCalled();
    expect(newCallback).toHaveBeenCalledWith('2026-07-01');
  });

  it('未注册回调时选择日期不应抛错', () => {
    createManager();
    clickNavBtn();
    expect(() => clickDateItem('2026-07-01')).not.toThrow();
  });
});

// ─── updateAvailableDates · 可用日期更新 ──────────────────

describe('updateAvailableDates · 可用日期更新', () => {
  it('应更新可用日期集合并重新渲染列表', () => {
    const manager = createManager({ dates: ['2026-07-01'] });
    clickNavBtn();

    let items = document.querySelectorAll('.date-nav-item');
    expect(items.length).toBe(1);

    manager.updateAvailableDates(['2026-07-01', '2026-07-02', '2026-07-03']);
    // 关闭后重新打开以触发渲染
    clickNavBtn();
    clickNavBtn();

    items = document.querySelectorAll('.date-nav-item');
    expect(items.length).toBe(3);
  });

  it('日期应按倒序排列（最新在前）', () => {
    createManager({ dates: ['2026-06-25', '2026-07-01', '2026-06-30'] });
    clickNavBtn();

    const items = document.querySelectorAll('.date-nav-item');
    expect(items[0]?.getAttribute('data-date')).toBe('2026-07-01');
    expect(items[1]?.getAttribute('data-date')).toBe('2026-06-30');
    expect(items[2]?.getAttribute('data-date')).toBe('2026-06-25');
  });

  it('当前选中日期不在新列表中时应回退到最近日期', () => {
    const manager = createManager({ dates: ['2026-07-01', '2026-07-02'] });
    manager.setCurrentDate('2026-07-02');

    manager.updateAvailableDates(['2026-06-30']);

    const label = document.getElementById('date-nav-label');
    expect(label?.textContent).toBe('06/30');
  });

  it('空日期列表应显示空状态', () => {
    createManager({ dates: [] });
    clickNavBtn();

    const empty = document.querySelector('.date-nav-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('暂无');
  });
});

// ─── setCurrentDate · 设置显示日期 ────────────────────────

describe('setCurrentDate · 设置显示日期', () => {
  it('应更新按钮标签文字（非今天/昨天的日期显示月/日）', () => {
    const manager = createManager();
    // 选一个肯定不是今天或昨天的日期
    manager.setCurrentDate('2026-01-15');

    const label = document.getElementById('date-nav-label');
    expect(label?.textContent).toBe('01/15');
  });

  it('今天的日期应显示「今天」', () => {
    const manager = createManager();
    // 使用本地日期而非 UTC 日期，避免时区差异导致测试失败
    // （dateNavManager 内部用 getFullYear/getMonth/getDate 本地日期计算）
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const today = `${y}-${m}-${d}`;
    manager.setCurrentDate(today);

    const label = document.getElementById('date-nav-label');
    expect(label?.textContent).toBe('今天');
  });

  it('传入空字符串应显示默认文字', () => {
    const manager = createManager();
    manager.setCurrentDate('2026-07-06');
    manager.setCurrentDate('');

    const label = document.getElementById('date-nav-label');
    expect(label?.textContent).toBe('选择日期');
  });

  it('label 元素缺失时不应抛错', () => {
    document.body.innerHTML = '<div id="date-navigator"></div>';
    const manager = new DateNavManager();
    manager.init();
    expect(() => manager.setCurrentDate('2026-07-06')).not.toThrow();
  });
});

// ─── 列表项渲染细节 ──────────────────────────────────────

describe('列表渲染 · 细节验证', () => {
  it('当前选中日期应有 active 类', () => {
    const manager = createManager();
    manager.setCurrentDate('2026-07-01');
    clickNavBtn();

    const activeItem = document.querySelector('.date-nav-item.active');
    expect(activeItem).not.toBeNull();
    expect(activeItem?.getAttribute('data-date')).toBe('2026-07-01');
  });

  it('每个日期项应显示会话数', () => {
    createManager({ dates: ['2026-07-01'] });
    clickNavBtn();

    const count = document.querySelector('.date-nav-item-count');
    expect(count).not.toBeNull();
    expect(count?.textContent).toContain('条');
  });

  it('自定义 counts Map 应显示正确的会话数', () => {
    const manager = createManager({ dates: [] });
    const counts = new Map<string, number>();
    counts.set('2026-07-01', 5);
    counts.set('2026-07-02', 12);
    manager.updateAvailableDates(['2026-07-01', '2026-07-02'], counts);
    clickNavBtn();

    const items = document.querySelectorAll('.date-nav-item');
    const countsText = Array.from(items).map((item) =>
      item.querySelector('.date-nav-item-count')?.textContent,
    );
    expect(countsText).toContain('12 条');
    expect(countsText).toContain('5 条');
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup · 事件与回调清理', () => {
  it('cleanup 后点击按钮不应展开下拉', () => {
    const manager = createManager();
    manager.cleanup();

    clickNavBtn();

    const dropdown = document.getElementById('date-nav-dropdown');
    expect(dropdown?.classList.contains('hidden')).toBe(true);
  });

  it('cleanup 应清空回调引用', () => {
    const manager = createManager();
    manager.onDateNavJump(vi.fn());
    manager.cleanup();

    // cleanup 后再注册新回调 + 重新 init 应正常工作
    const newCallback = vi.fn();
    manager.onDateNavJump(newCallback);
    manager.updateAvailableDates(TEST_DATES);
    manager.init();
    clickNavBtn();
    clickDateItem('2026-07-01');
    expect(newCallback).toHaveBeenCalledWith('2026-07-01');
  });

  it('cleanup 应清空可用日期集合', () => {
    const manager = createManager();
    const jumpCallback = vi.fn();
    manager.onDateNavJump(jumpCallback);
    manager.cleanup();

    // cleanup 后再 init 并点击按钮，下拉应为空
    manager.init();
    clickNavBtn();
    const items = document.querySelectorAll('.date-nav-item');
    expect(items.length).toBe(0);
  });
});
