/**
 * 日期导航日历选择器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：change 事件绑定
 * - onDateNavJump：回调注册
 * - updateAvailableDates：更新可用日期集合
 * - setCurrentDate：设置当前显示日期
 * - onInvalidDate：无效日期回调
 * - cleanup：事件清理 + 回调清空
 *
 * 日历选择器（<input type="date">）替代了旧的下拉列表，
 * 时间流滚动加载已覆盖顺序浏览，日历选择器提供随机访问。
 *
 * 设计变更：
 * - 选择有记录的日期后不再清空 picker 值，保持显示当前日期
 * - 需要先调用 updateAvailableDates 设置可用日期集合
 * - 选择无记录的日期触发 invalidDateCallback
 *
 * Mock 策略：
 * - 使用真实 EventTracker（验证事件注册与清理）
 * - JSDOM 提供真实 DOM API
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DateNavManager } from '../../../electron/renderer/panels/dateNavManager.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 日历选择器 DOM 结构 */
const CALENDAR_HTML = `
  <div id="date-navigator">
    <input type="date" id="date-nav-picker" />
  </div>
`;

/** 测试用可用日期列表 */
const TEST_DATES = ['2026-06-25', '2026-06-26', '2026-06-30', '2026-07-01', '2026-07-06'];

/** 活跃 Manager 引用（afterEach 中统一 cleanup） */
let activeManager: DateNavManager | null = null;

/** 创建 DateNavManager 实例（默认已 init 并设置可用日期） */
function createManager(opts?: { init?: boolean; html?: string; dates?: string[] }): DateNavManager {
  document.body.innerHTML = opts?.html ?? CALENDAR_HTML;
  const manager = new DateNavManager();
  if (opts?.init !== false) {
    manager.init();
  }
  // 默认设置可用日期
  manager.updateAvailableDates(opts?.dates ?? TEST_DATES);
  activeManager = manager;
  return manager;
}

/** 在日历选择器上触发 change 事件（模拟用户选择日期） */
function dispatchCalendarChange(date: string): void {
  const picker = document.getElementById('date-nav-picker') as HTMLInputElement;
  if (!picker) return;
  picker.value = date;
  picker.dispatchEvent(new Event('change', { bubbles: true }));
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
  it('选择有记录的日期后应触发 jumpCallback 并保持显示', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);

    dispatchCalendarChange('2026-07-01');

    expect(callback).toHaveBeenCalledWith('2026-07-01');
    // 跳转后 picker.value 应保持显示当前日期（不再清空）
    const picker = document.getElementById('date-nav-picker') as HTMLInputElement;
    expect(picker.value).toBe('2026-07-01');
  });

  it('选择无记录的日期应触发 invalidDateCallback', () => {
    const manager = createManager();
    const jumpCallback = vi.fn();
    const invalidCallback = vi.fn();
    manager.onDateNavJump(jumpCallback);
    manager.onInvalidDate(invalidCallback);

    dispatchCalendarChange('2026-08-01');

    expect(jumpCallback).not.toHaveBeenCalled();
    expect(invalidCallback).toHaveBeenCalled();
  });

  it('选择日期后若未注册 jumpCallback 不应抛错', () => {
    createManager();
    expect(() => dispatchCalendarChange('2026-07-01')).not.toThrow();
  });

  it('picker 元素缺失时 init 不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new DateNavManager();
    expect(() => manager.init()).not.toThrow();
  });

  it('选择空日期（picker.value=""）不应触发回调', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);

    const picker = document.getElementById('date-nav-picker') as HTMLInputElement;
    picker.value = '';
    picker.dispatchEvent(new Event('change', { bubbles: true }));

    expect(callback).not.toHaveBeenCalled();
  });
});

// ─── onDateNavJump · 回调注册 ────────────────────────────

describe('onDateNavJump · 回调注册', () => {
  it('应注册跳转回调', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);

    dispatchCalendarChange('2026-06-30');

    expect(callback).toHaveBeenCalledWith('2026-06-30');
  });

  it('重复注册应覆盖旧回调', () => {
    const manager = createManager();
    const oldCallback = vi.fn();
    const newCallback = vi.fn();
    manager.onDateNavJump(oldCallback);
    manager.onDateNavJump(newCallback);

    dispatchCalendarChange('2026-07-01');

    expect(oldCallback).not.toHaveBeenCalled();
    expect(newCallback).toHaveBeenCalledWith('2026-07-01');
  });
});

// ─── updateAvailableDates · 可用日期更新 ──────────────────

describe('updateAvailableDates · 可用日期更新', () => {
  it('应更新可用日期集合', () => {
    const manager = createManager({ dates: ['2026-07-01'] });
    const jumpCallback = vi.fn();
    const invalidCallback = vi.fn();
    manager.onDateNavJump(jumpCallback);
    manager.onInvalidDate(invalidCallback);

    // 有效日期
    dispatchCalendarChange('2026-07-01');
    expect(jumpCallback).toHaveBeenCalled();

    // 无效日期
    dispatchCalendarChange('2026-07-02');
    expect(invalidCallback).toHaveBeenCalled();
  });

  it('更新后旧日期不再可用', () => {
    const manager = createManager({ dates: ['2026-07-01', '2026-07-02'] });
    const invalidCallback = vi.fn();
    manager.onInvalidDate(invalidCallback);

    // 更新前有效
    dispatchCalendarChange('2026-07-01');

    // 更新可用日期
    manager.updateAvailableDates(['2026-07-03']);

    // 更新后无效
    dispatchCalendarChange('2026-07-01');
    expect(invalidCallback).toHaveBeenCalled();
  });
});

// ─── setCurrentDate · 设置显示日期 ────────────────────────

describe('setCurrentDate · 设置显示日期', () => {
  it('应设置 picker 的 value', () => {
    const manager = createManager();
    manager.setCurrentDate('2026-07-06');

    const picker = document.getElementById('date-nav-picker') as HTMLInputElement;
    expect(picker.value).toBe('2026-07-06');
  });

  it('传入空字符串应清空 picker', () => {
    const manager = createManager();
    manager.setCurrentDate('2026-07-06');
    manager.setCurrentDate('');

    const picker = document.getElementById('date-nav-picker') as HTMLInputElement;
    expect(picker.value).toBe('');
  });

  it('picker 元素缺失时不应抛错', () => {
    document.body.innerHTML = '';
    const manager = new DateNavManager();
    expect(() => manager.setCurrentDate('2026-07-06')).not.toThrow();
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup · 事件与回调清理', () => {
  it('cleanup 后选择日期不应触发 jumpCallback', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);
    manager.cleanup();

    dispatchCalendarChange('2026-07-01');

    expect(callback).not.toHaveBeenCalled();
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
    dispatchCalendarChange('2026-07-01');
    expect(newCallback).toHaveBeenCalledWith('2026-07-01');
  });

  it('cleanup 后 onDateNavJump 应覆盖为 null', () => {
    const manager = createManager();
    manager.onDateNavJump(vi.fn());
    manager.cleanup();

    // 未重新注册回调时，选择日期不应抛错
    dispatchCalendarChange('2026-07-01');
    // 不应抛错（jumpCallback 为 null）
  });

  it('cleanup 应清空可用日期集合', () => {
    const manager = createManager();
    const jumpCallback = vi.fn();
    manager.onDateNavJump(jumpCallback);
    manager.cleanup();

    // cleanup 后所有日期都无效，jumpCallback 不应被调用
    dispatchCalendarChange('2026-07-01');
    expect(jumpCallback).not.toHaveBeenCalled();
  });
});