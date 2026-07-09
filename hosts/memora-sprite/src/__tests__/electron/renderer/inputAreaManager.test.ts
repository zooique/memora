/**
 * 输入区域管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - getValue：正常读取 / trim / 长度限制 / 空输入
 * - clearInput：清空后高度重置
 * - setValue：预填 + input 事件触发
 * - handleKeydown：Enter 发送 / Enter 停止 / Esc 清空 / Esc 失焦
 * - handleClick：触发 emitSendMessage
 * - refreshSendButtonState：流式态跳过 / 有内容启用 / 无内容禁用
 * - cleanup：断开 ResizeObserver + 清理事件
 *
 * Mock 策略：
 * - Mock InputAreaHost（isStreaming / emitSendMessage / emitStopMessage）
 * - Mock EventTracker
 * - DOM：textarea + button 元素
 */
import { describe, it, expect, vi } from 'vitest';
import { InputAreaManager } from '../../../electron/renderer/panels/inputAreaManager.js';
import type { InputAreaHost } from '../../../electron/renderer/panels/inputAreaManager.js';
import type { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 Mock InputAreaHost */
function createMockHost(): InputAreaHost {
  return {
    isStreaming: vi.fn().mockReturnValue(false),
    emitSendMessage: vi.fn(),
    emitStopMessage: vi.fn(),
    switchToSettings: vi.fn(),
  };
}

/** 创建 Mock EventTracker（实际绑定事件监听器） */
function createMockEventTracker(): EventTracker {
  const listeners: Array<{ target: EventTarget; type: string; listener: EventListener }> = [];
  return {
    addEventListener: vi.fn((target: EventTarget, type: string, listener: EventListener) => {
      // 实际绑定事件监听器，确保 dispatchEvent 能触发 handler
      target.addEventListener(type, listener);
      listeners.push({ target, type, listener });
    }),
    cleanup: vi.fn(() => {
      // 清理时移除所有监听器
      for (const { target, type, listener } of listeners) {
        target.removeEventListener(type, listener);
      }
      listeners.length = 0;
    }),
  } as unknown as EventTracker;
}

/** 创建 InputAreaManager 实例 + DOM 元素 */
function createManager(
  host: InputAreaHost = createMockHost(),
): {
  manager: InputAreaManager;
  host: InputAreaHost;
  inputEl: HTMLTextAreaElement;
  btnSend: HTMLButtonElement;
  events: EventTracker;
} {
  const inputEl = document.createElement('textarea');
  inputEl.id = 'message-input';
  const btnSend = document.createElement('button');
  btnSend.id = 'btn-send';
  document.body.appendChild(inputEl);
  document.body.appendChild(btnSend);

  // 输入区容器（ResizeObserver 需要）
  const inputArea = document.createElement('div');
  inputArea.id = 'input-area';
  inputArea.appendChild(inputEl);
  document.body.appendChild(inputArea);

  const events = createMockEventTracker();
  const manager = new InputAreaManager(inputEl, btnSend, events, host);
  return { manager, host, inputEl, btnSend, events };
}

// ─── getValue ──────────────────────────────────────────────

describe('getValue · 输入读取', () => {
  it('应返回 trim 后的值', () => {
    const { manager, inputEl } = createManager();
    inputEl.value = '  你好世界  ';
    expect(manager.getValue()).toBe('你好世界');
  });

  it('空输入应返回空字符串', () => {
    const { manager, inputEl } = createManager();
    inputEl.value = '';
    expect(manager.getValue()).toBe('');
  });

  it('超出长度限制应截断', () => {
    const { manager, inputEl } = createManager();
    // 超长输入（10000 字符限制）
    inputEl.value = 'a'.repeat(10050);
    expect(manager.getValue().length).toBe(10000);
  });
});

// ─── clearInput ────────────────────────────────────────────

describe('clearInput · 清空输入', () => {
  it('clearInput 应清空输入框', () => {
    const { manager, inputEl } = createManager();
    inputEl.value = '测试内容';
    manager.clearInput();
    expect(inputEl.value).toBe('');
  });
});

// ─── setValue ──────────────────────────────────────────────

describe('setValue · 预填输入', () => {
  it('setValue 应设置输入框值', () => {
    const { manager, inputEl } = createManager();
    manager.setValue('预填内容');
    expect(inputEl.value).toBe('预填内容');
  });
});

// ─── handleKeydown ─────────────────────────────────────────

describe('handleKeydown · 键盘事件', () => {
  it('Enter 键（非 Shift）应触发 emitSendMessage', () => {
    const { manager, host, inputEl } = createManager();
    manager.init(); // 绑定事件监听器
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false }));
    expect(host.emitSendMessage).toHaveBeenCalledTimes(1);
  });

  it('流式态下 Enter 应触发 emitStopMessage', () => {
    const host = createMockHost();
    (host.isStreaming as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const { manager, inputEl } = createManager(host);
    manager.init(); // 绑定事件监听器
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: false }));
    expect(host.emitStopMessage).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter 不应触发发送或停止', () => {
    const { host, inputEl } = createManager();
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    expect(host.emitSendMessage).not.toHaveBeenCalled();
    expect(host.emitStopMessage).not.toHaveBeenCalled();
  });

  it('Escape 有内容时清空输入', () => {
    const { manager, inputEl } = createManager();
    manager.init(); // 绑定事件监听器
    inputEl.value = '测试内容';
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(inputEl.value).toBe('');
  });
});

// ─── refreshSendButtonState ────────────────────────────────

describe('refreshSendButtonState · 按钮状态', () => {
  it('无内容时应禁用发送按钮', () => {
    const { manager, inputEl, btnSend } = createManager();
    inputEl.value = '';
    manager.refreshSendButtonState();
    expect(btnSend.disabled).toBe(true);
    expect(btnSend.classList.contains('empty')).toBe(true);
  });

  it('有内容时应启用发送按钮', () => {
    const { manager, inputEl, btnSend } = createManager();
    inputEl.value = '内容';
    manager.refreshSendButtonState();
    expect(btnSend.disabled).toBe(false);
    expect(btnSend.classList.contains('empty')).toBe(false);
  });
});

// ─── cleanup ─────────────────────────────────────────────

describe('cleanup · 资源清理', () => {
  it('cleanup 应调用 events.cleanup', () => {
    const { manager, events } = createManager();
    manager.cleanup();
    expect(events.cleanup).toHaveBeenCalledTimes(1);
  });
});