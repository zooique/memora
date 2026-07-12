/**
 * 快捷键捕获子系统辅助测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - keyEventToAccelerator：Esc/Backspace/修饰键/字母/数字/F键/方向键/空格/不支持键
 * - isShortcutConflict：冲突检测、排除动作、空字符串不冲突
 * - initShortcutCapture：focus/blur 状态、keydown 捕获、Esc 取消、Backspace 清除、冲突检测
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API（input 元素 + focus/blur/keydown 事件）
 * - 使用真实 EventTracker（验证事件注册与清理）
 * - mock ctx.onCapture/onClear/onConflict 回调
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  keyEventToAccelerator,
  isShortcutConflict,
  initShortcutCapture,
  type ShortcutCaptureContext,
  type ShortcutInputBinding,
} from '../../../electron/renderer/helpers/shortcutCapture.js';
import { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';
import type { ShortcutConfig } from '../../../shared/shortcutDefaults.js';

// ─── 辅助函数 ─────────────────────────────────────────────

/** 创建 KeyboardEvent mock */
function createKeyEvent(key: string, opts?: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: opts?.ctrlKey ?? false,
    metaKey: opts?.metaKey ?? false,
    altKey: opts?.altKey ?? false,
    shiftKey: opts?.shiftKey ?? false,
  });
}

/** 创建 ShortcutConfig */
function createShortcutConfig(accelerators: Record<string, string> = {}): ShortcutConfig {
  return { enabled: true, accelerators };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── 1. keyEventToAccelerator ──────────────────────────

describe('keyEventToAccelerator', () => {
  it('Esc 应返回 __cancel__', () => {
    expect(keyEventToAccelerator(createKeyEvent('Escape'))).toBe('__cancel__');
  });

  it('Backspace 无修饰键应返回 __clear__', () => {
    expect(keyEventToAccelerator(createKeyEvent('Backspace'))).toBe('__clear__');
  });

  it('Backspace 有修饰键应继续等待（返回 null）', () => {
    // Backspace + Ctrl：有修饰键，但 Backspace 不在主键映射中
    // 实际：有修饰键时 Backspace 不匹配 keyMap/字母/数字/F键，返回 null
    expect(keyEventToAccelerator(createKeyEvent('Backspace', { ctrlKey: true }))).toBeNull();
  });

  it('单独的修饰键应返回 null（继续等待）', () => {
    expect(keyEventToAccelerator(createKeyEvent('Control', { ctrlKey: true }))).toBeNull();
    expect(keyEventToAccelerator(createKeyEvent('Shift', { shiftKey: true }))).toBeNull();
    expect(keyEventToAccelerator(createKeyEvent('Alt', { altKey: true }))).toBeNull();
    expect(keyEventToAccelerator(createKeyEvent('Meta', { metaKey: true }))).toBeNull();
  });

  it('Ctrl+字母 应返回 "Ctrl+X" 格式', () => {
    expect(keyEventToAccelerator(createKeyEvent('a', { ctrlKey: true }))).toBe('Ctrl+A');
    expect(keyEventToAccelerator(createKeyEvent('z', { ctrlKey: true }))).toBe('Ctrl+Z');
  });

  it('Ctrl+Shift+字母 应按顺序排列修饰键', () => {
    expect(keyEventToAccelerator(createKeyEvent('a', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+A');
  });

  it('Ctrl+Cmd+Alt+Shift+字母 应按规范顺序排列', () => {
    const result = keyEventToAccelerator(createKeyEvent('a', {
      ctrlKey: true, metaKey: true, altKey: true, shiftKey: true,
    }));
    expect(result).toBe('Ctrl+Cmd+Alt+Shift+A');
  });

  it('Ctrl+数字 应返回 "Ctrl+数字"', () => {
    expect(keyEventToAccelerator(createKeyEvent('1', { ctrlKey: true }))).toBe('Ctrl+1');
    expect(keyEventToAccelerator(createKeyEvent('0', { ctrlKey: true }))).toBe('Ctrl+0');
  });

  it('Ctrl+空格 应返回 "Ctrl+Space"', () => {
    expect(keyEventToAccelerator(createKeyEvent(' ', { ctrlKey: true }))).toBe('Ctrl+Space');
  });

  it('Ctrl+方向键 应返回 "Ctrl+Up" 等', () => {
    expect(keyEventToAccelerator(createKeyEvent('ArrowUp', { ctrlKey: true }))).toBe('Ctrl+Up');
    expect(keyEventToAccelerator(createKeyEvent('ArrowDown', { ctrlKey: true }))).toBe('Ctrl+Down');
    expect(keyEventToAccelerator(createKeyEvent('ArrowLeft', { ctrlKey: true }))).toBe('Ctrl+Left');
    expect(keyEventToAccelerator(createKeyEvent('ArrowRight', { ctrlKey: true }))).toBe('Ctrl+Right');
  });

  it('Ctrl+Enter 应返回 "Ctrl+Return"', () => {
    expect(keyEventToAccelerator(createKeyEvent('Enter', { ctrlKey: true }))).toBe('Ctrl+Return');
  });

  it('Ctrl+Tab 应返回 "Ctrl+Tab"', () => {
    expect(keyEventToAccelerator(createKeyEvent('Tab', { ctrlKey: true }))).toBe('Ctrl+Tab');
  });

  it('Ctrl+Home/End 应正确映射', () => {
    expect(keyEventToAccelerator(createKeyEvent('Home', { ctrlKey: true }))).toBe('Ctrl+Home');
    expect(keyEventToAccelerator(createKeyEvent('End', { ctrlKey: true }))).toBe('Ctrl+End');
  });

  it('Ctrl+PageUp/PageDown 应正确映射', () => {
    expect(keyEventToAccelerator(createKeyEvent('PageUp', { ctrlKey: true }))).toBe('Ctrl+PageUp');
    expect(keyEventToAccelerator(createKeyEvent('PageDown', { ctrlKey: true }))).toBe('Ctrl+PageDown');
  });

  it('Ctrl+Insert/Delete 应正确映射', () => {
    expect(keyEventToAccelerator(createKeyEvent('Insert', { ctrlKey: true }))).toBe('Ctrl+Insert');
    expect(keyEventToAccelerator(createKeyEvent('Delete', { ctrlKey: true }))).toBe('Ctrl+Delete');
  });

  it('Ctrl+F1-F12 应返回大写功能键', () => {
    expect(keyEventToAccelerator(createKeyEvent('F1', { ctrlKey: true }))).toBe('Ctrl+F1');
    expect(keyEventToAccelerator(createKeyEvent('F12', { ctrlKey: true }))).toBe('Ctrl+F12');
  });

  it('Ctrl+F24 应支持两位数功能键', () => {
    expect(keyEventToAccelerator(createKeyEvent('F24', { ctrlKey: true }))).toBe('Ctrl+F24');
  });

  it('不支持的键（无修饰键）应返回 null', () => {
    // 标点符号等不在映射表中的键
    expect(keyEventToAccelerator(createKeyEvent('!'))).toBeNull();
    expect(keyEventToAccelerator(createKeyEvent('@'))).toBeNull();
  });

  it('Ctrl+不支持的键应返回 null', () => {
    expect(keyEventToAccelerator(createKeyEvent('!', { ctrlKey: true }))).toBeNull();
  });

  it('Cmd+Shift+A 应正确排列（macOS 风格）', () => {
    expect(keyEventToAccelerator(createKeyEvent('a', { metaKey: true, shiftKey: true }))).toBe('Cmd+Shift+A');
  });

  it('Alt+P 应返回 "Alt+P"', () => {
    expect(keyEventToAccelerator(createKeyEvent('p', { altKey: true }))).toBe('Alt+P');
  });
});

// ─── 2. isShortcutConflict ─────────────────────────────

describe('isShortcutConflict', () => {
  it('相同 accelerator 应检测到冲突', () => {
    const existing = createShortcutConfig({
      'toggle-window': 'Ctrl+Shift+Space',
      'show-settings': 'Ctrl+Shift+S',
    });
    expect(isShortcutConflict('Ctrl+Shift+Space', existing)).toBe(true);
  });

  it('不同 accelerator 应无冲突', () => {
    const existing = createShortcutConfig({
      'toggle-window': 'Ctrl+Shift+Space',
      'show-settings': 'Ctrl+Shift+S',
    });
    expect(isShortcutConflict('Ctrl+Shift+D', existing)).toBe(false);
  });

  it('excludeAction 应排除自身动作', () => {
    const existing = createShortcutConfig({
      'toggle-window': 'Ctrl+Shift+Space',
    });
    // 检查 Ctrl+Shift+Space 是否与 toggle-window 之外的动作冲突
    expect(isShortcutConflict('Ctrl+Shift+Space', existing, 'toggle-window')).toBe(false);
  });

  it('空字符串 accelerator 不视为冲突', () => {
    const existing = createShortcutConfig({
      'toggle-window': '',
      'show-settings': '',
    });
    expect(isShortcutConflict('', existing)).toBe(false);
  });

  it('空配置应无冲突', () => {
    const existing = createShortcutConfig({});
    expect(isShortcutConflict('Ctrl+Shift+Space', existing)).toBe(false);
  });

  it('多个动作中有一个冲突应返回 true', () => {
    const existing = createShortcutConfig({
      'toggle-window': 'Ctrl+Shift+Space',
      'show-settings': 'Ctrl+Shift+S',
      'capture-clipboard': 'Ctrl+Shift+C',
    });
    expect(isShortcutConflict('Ctrl+Shift+C', existing)).toBe(true);
  });

  it('excludeAction 不存在的动作应正常检测冲突', () => {
    const existing = createShortcutConfig({
      'toggle-window': 'Ctrl+Shift+Space',
    });
    expect(isShortcutConflict('Ctrl+Shift+Space', existing, 'non-existent')).toBe(true);
  });
});

// ─── 3. initShortcutCapture ────────────────────────────

describe('initShortcutCapture', () => {
  /** 创建快捷键输入框 + 绑定 */
  function createInput(action: string, value = ''): { input: HTMLInputElement; binding: ShortcutInputBinding } {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    document.body.appendChild(input);
    return { input, binding: { input, action } };
  }

  /** 创建 ShortcutCaptureContext mock */
  function createCtx(inputs: ShortcutInputBinding[]): {
    ctx: ShortcutCaptureContext;
    events: EventTracker;
    onCapture: ReturnType<typeof vi.fn>;
    onClear: ReturnType<typeof vi.fn>;
    onConflict: ReturnType<typeof vi.fn>;
  } {
    const events = new EventTracker();
    const onCapture = vi.fn();
    const onClear = vi.fn();
    const onConflict = vi.fn();
    const ctx: ShortcutCaptureContext = { inputs, events, onCapture, onClear, onConflict };
    return { ctx, events, onCapture, onClear, onConflict };
  }

  it('focus 应进入捕获状态并显示提示', () => {
    const { input, binding } = createInput('toggle-window');
    const { ctx, events } = createCtx([binding]);
    initShortcutCapture(ctx);
    input.focus();
    expect(input.classList.contains('capturing')).toBe(true);
    expect(input.placeholder).toContain('按下组合键');
    events.cleanup();
  });

  it('blur 应退出捕获状态并恢复默认提示', () => {
    const { input, binding } = createInput('toggle-window');
    const { ctx, events } = createCtx([binding]);
    initShortcutCapture(ctx);
    input.focus();
    input.blur();
    expect(input.classList.contains('capturing')).toBe(false);
    expect(input.placeholder).toBe('点击捕获组合键');
    events.cleanup();
  });

  it('捕获成功应填入 accelerator 并调用 onCapture', () => {
    const { input, binding } = createInput('toggle-window');
    const { ctx, events, onCapture } = createCtx([binding]);
    initShortcutCapture(ctx);
    input.focus();
    input.dispatchEvent(createKeyEvent('a', { ctrlKey: true }));
    expect(input.value).toBe('Ctrl+A');
    expect(onCapture).toHaveBeenCalledWith('toggle-window', 'Ctrl+A');
    events.cleanup();
  });

  it('Esc 应取消捕获并恢复原值', () => {
    const { input, binding } = createInput('toggle-window', 'Ctrl+B');
    const { ctx, events, onCapture } = createCtx([binding]);
    initShortcutCapture(ctx);
    input.focus();
    input.dispatchEvent(createKeyEvent('Escape'));
    // 应恢复原值
    expect(input.value).toBe('Ctrl+B');
    // onCapture 不应被调用
    expect(onCapture).not.toHaveBeenCalled();
    events.cleanup();
  });

  it('Backspace 无修饰键应清除快捷键并调用 onClear', () => {
    const { input, binding } = createInput('toggle-window', 'Ctrl+B');
    const { ctx, events, onClear } = createCtx([binding]);
    initShortcutCapture(ctx);
    input.focus();
    input.dispatchEvent(createKeyEvent('Backspace'));
    expect(input.value).toBe('');
    expect(onClear).toHaveBeenCalledWith('toggle-window');
    events.cleanup();
  });

  it('不支持的键应继续等待（不填入值）', () => {
    const { input, binding } = createInput('toggle-window');
    const { ctx, events, onCapture } = createCtx([binding]);
    initShortcutCapture(ctx);
    input.focus();
    // 单独的修饰键不构成有效快捷键
    input.dispatchEvent(createKeyEvent('Control', { ctrlKey: true }));
    expect(input.value).toBe('');
    expect(onCapture).not.toHaveBeenCalled();
    events.cleanup();
  });

  it('冲突的快捷键应调用 onConflict 且不填入值', () => {
    const input1 = document.createElement('input');
    input1.value = 'Ctrl+Shift+Space';
    document.body.appendChild(input1);
    const input2 = document.createElement('input');
    document.body.appendChild(input2);
    const bindings: ShortcutInputBinding[] = [
      { input: input1, action: 'toggle-window' },
      { input: input2, action: 'show-settings' },
    ];
    const { ctx, events, onCapture, onConflict } = createCtx(bindings);
    initShortcutCapture(ctx);
    input2.focus();
    // 捕获 Ctrl+Shift+Space（与 toggle-window 冲突）
    input2.dispatchEvent(createKeyEvent(' ', { ctrlKey: true, shiftKey: true }));
    expect(onConflict).toHaveBeenCalledWith('show-settings', 'Ctrl+Shift+Space');
    expect(onCapture).not.toHaveBeenCalled();
    expect(input2.value).toBe('');
    events.cleanup();
  });

  it('非冲突的快捷键应正常捕获', () => {
    const input1 = document.createElement('input');
    input1.value = 'Ctrl+Shift+Space';
    document.body.appendChild(input1);
    const input2 = document.createElement('input');
    document.body.appendChild(input2);
    const bindings: ShortcutInputBinding[] = [
      { input: input1, action: 'toggle-window' },
      { input: input2, action: 'show-settings' },
    ];
    const { ctx, events, onCapture, onConflict } = createCtx(bindings);
    initShortcutCapture(ctx);
    input2.focus();
    // 捕获 Ctrl+Shift+D（不冲突）
    input2.dispatchEvent(createKeyEvent('d', { ctrlKey: true, shiftKey: true }));
    expect(onCapture).toHaveBeenCalledWith('show-settings', 'Ctrl+Shift+D');
    expect(onConflict).not.toHaveBeenCalled();
    expect(input2.value).toBe('Ctrl+Shift+D');
    events.cleanup();
  });

  it('未 focus 时 keydown 不应触发捕获', () => {
    const { input, binding } = createInput('toggle-window');
    const { ctx, events, onCapture } = createCtx([binding]);
    initShortcutCapture(ctx);
    // 不 focus 直接 dispatch keydown
    input.dispatchEvent(createKeyEvent('a', { ctrlKey: true }));
    expect(onCapture).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    events.cleanup();
  });

  it('cleanup 应移除所有事件监听器', () => {
    const { input, binding } = createInput('toggle-window');
    const { ctx, events, onCapture } = createCtx([binding]);
    initShortcutCapture(ctx);
    events.cleanup();
    // cleanup 后 focus 不应进入捕获状态
    input.focus();
    expect(input.classList.contains('capturing')).toBe(false);
    // keydown 不应触发捕获
    input.dispatchEvent(createKeyEvent('a', { ctrlKey: true }));
    expect(onCapture).not.toHaveBeenCalled();
  });

  it('捕获成功后应自动 blur 退出捕获状态', () => {
    const { input, binding } = createInput('toggle-window');
    const { ctx, events } = createCtx([binding]);
    initShortcutCapture(ctx);
    input.focus();
    expect(input.classList.contains('capturing')).toBe(true);
    input.dispatchEvent(createKeyEvent('a', { ctrlKey: true }));
    // blur 后应移除 capturing 类
    expect(input.classList.contains('capturing')).toBe(false);
    events.cleanup();
  });
});
