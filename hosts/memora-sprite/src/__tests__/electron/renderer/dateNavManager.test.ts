/**
 * 日期导航日历选择器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - init：change 事件绑定
 * - onDateNavJump：回调注册
 * - cleanup：事件清理 + 回调清空
 *
 * 日历选择器（<input type="date">）替代了旧的下拉列表，
 * 时间流滚动加载已覆盖顺序浏览，日历选择器提供随机访问。
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

/** 活跃 Manager 引用（afterEach 中统一 cleanup） */
let activeManager: DateNavManager | null = null;

/** 创建 DateNavManager 实例（默认已 init） */
function createManager(opts?: { init?: boolean; html?: string }): DateNavManager {
  document.body.innerHTML = opts?.html ?? CALENDAR_HTML;
  const manager = new DateNavManager();
  if (opts?.init !== false) {
    manager.init();
  }
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
  it('选择日期后应触发 jumpCallback 并清空 picker 值', () => {
    const manager = createManager();
    const callback = vi.fn();
    manager.onDateNavJump(callback);

    dispatchCalendarChange('2026-07-01');

    expect(callback).toHaveBeenCalledWith('2026-07-01');
    // 跳转后 picker.value 应被清空（还原为占位状态）
    const picker = document.getElementById('date-nav-picker') as HTMLInputElement;
    expect(picker.value).toBe('');
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
});