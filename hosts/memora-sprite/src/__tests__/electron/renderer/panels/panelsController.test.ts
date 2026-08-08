/**
 * 面板控制器组合测试（P1）
 *
 * 覆盖目标：
 *   - InputAreaManager：键盘事件 + 自适应高度 + ResizeObserver + getValue/setValue/clearInput
 *
 * Mock 策略：
 * - jsdom 环境 + setupDOM() 设置完整 DOM
 * - DI 注入 mock Host 接口
 * - mock ResizeObserver（jsdom 未实现）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputAreaManager } from '../../../../electron/renderer/panels/inputAreaManager.js';
import type { InputAreaHost } from '../../../../electron/renderer/panels/inputAreaManager.js';
import { EventTracker } from '../../../../electron/renderer/helpers/eventTracker.js';

// ─── 全局 Mock ResizeObserver（jsdom 未实现） ────────────
class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// ─── 测试辅助 ─────────────────────────────────────────────

/** 设置 InputAreaManager 所需的完整 DOM */
function setupInputAreaDOM(): void {
  document.body.innerHTML = `
    <div id="input-area">
      <textarea id="chat-input"></textarea>
      <button id="btn-send" disabled>发送</button>
    </div>
  `;
}

/** 创建 mock InputAreaHost */
function createMockInputHost(streaming = false): InputAreaHost & {
  mocks: {
    isStreaming: ReturnType<typeof vi.fn>;
    emitSendMessage: ReturnType<typeof vi.fn>;
    emitStopMessage: ReturnType<typeof vi.fn>;
    switchToSettings: ReturnType<typeof vi.fn>;
  };
} {
  const mocks = {
    isStreaming: vi.fn(() => streaming),
    emitSendMessage: vi.fn(),
    emitStopMessage: vi.fn(),
    switchToSettings: vi.fn(),
  };
  return {
    ...mocks,
    mocks,
  };
}

// ─── InputAreaManager 测试 ──────────────────────────────

describe('InputAreaManager', () => {
  let inputEl: HTMLTextAreaElement;
  let btnSend: HTMLButtonElement;
  let events: EventTracker;
  let manager: InputAreaManager;
  let host: ReturnType<typeof createMockInputHost>;

  beforeEach(() => {
    setupInputAreaDOM();
    inputEl = document.getElementById('chat-input') as HTMLTextAreaElement;
    btnSend = document.getElementById('btn-send') as HTMLButtonElement;
    events = new EventTracker();
    host = createMockInputHost();
    manager = new InputAreaManager(inputEl, btnSend, events, host);
  });

  afterEach(() => {
    manager.cleanup();
  });

  describe('handleKeydown 键盘事件', () => {
    it('Enter（非 Shift）空闲态应触发 emitSendMessage', () => {
      manager.init();
      host.mocks.isStreaming.mockReturnValue(false);

      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      expect(host.mocks.emitSendMessage).toHaveBeenCalledTimes(1);
      expect(host.mocks.emitStopMessage).not.toHaveBeenCalled();
    });

    it('Enter（非 Shift）流式态应触发 emitStopMessage', () => {
      manager.init();
      host.mocks.isStreaming.mockReturnValue(true);

      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      expect(host.mocks.emitStopMessage).toHaveBeenCalledTimes(1);
      expect(host.mocks.emitSendMessage).not.toHaveBeenCalled();
    });

    it('Shift+Enter 不应触发发送或停止（允许换行）', () => {
      manager.init();

      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));

      expect(host.mocks.emitSendMessage).not.toHaveBeenCalled();
      expect(host.mocks.emitStopMessage).not.toHaveBeenCalled();
    });

    it('Escape 有内容时应清空输入框', () => {
      manager.init();
      inputEl.value = '有内容';

      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(inputEl.value).toBe('');
    });

    it('Escape 无内容时应失焦', () => {
      manager.init();
      const blurSpy = vi.spyOn(inputEl, 'blur');

      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(blurSpy).toHaveBeenCalledTimes(1);
    });

    it('其他键不应触发任何回调', () => {
      manager.init();

      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));

      expect(host.mocks.emitSendMessage).not.toHaveBeenCalled();
      expect(host.mocks.emitStopMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleInputChange 自适应高度', () => {
    it('input 事件应触发高度调整', () => {
      manager.init();
      // scrollHeight 在 jsdom 中为 0，但方法应被调用
      const heightSpy = vi.spyOn(inputEl.style, 'height', 'set');

      inputEl.value = '测试内容';
      inputEl.dispatchEvent(new Event('input'));

      // 应设置 height（先 'auto' 再计算值）
      expect(heightSpy).toHaveBeenCalled();
    });

    it('有内容时发送按钮应启用（disabled=false + 移除 empty 类）', () => {
      manager.init();
      inputEl.value = '有内容';

      inputEl.dispatchEvent(new Event('input'));

      expect(btnSend.disabled).toBe(false);
      expect(btnSend.classList.contains('empty')).toBe(false);
    });

    it('无内容时发送按钮应禁用（disabled=true + 添加 empty 类）', () => {
      manager.init();
      inputEl.value = '';

      inputEl.dispatchEvent(new Event('input'));

      expect(btnSend.disabled).toBe(true);
      expect(btnSend.classList.contains('empty')).toBe(true);
    });
  });

  describe('handleClick 发送按钮点击', () => {
    it('点击发送按钮应触发 emitSendMessage', () => {
      manager.init();
      // init 时 input 为空 → btnSend 被禁用，需先设置内容并启用
      inputEl.value = '测试内容';
      btnSend.disabled = false;

      btnSend.click();

      expect(host.mocks.emitSendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('getValue 输入读取', () => {
    it('应返回 trim 后的值', () => {
      manager.init();
      inputEl.value = '  测试内容  ';

      expect(manager.getValue()).toBe('测试内容');
    });

    it('空内容应返回空字符串', () => {
      manager.init();
      inputEl.value = '   ';

      expect(manager.getValue()).toBe('');
    });

    it('超长内容应被截断到 10000 字符', () => {
      manager.init();
      inputEl.value = 'a'.repeat(15000);

      expect(manager.getValue()).toHaveLength(10000);
    });

    it('10000 字符内不应截断', () => {
      manager.init();
      inputEl.value = 'a'.repeat(5000);

      expect(manager.getValue()).toHaveLength(5000);
    });
  });

  describe('clearInput 清空输入', () => {
    it('应清空输入框值', () => {
      manager.init();
      inputEl.value = '有内容';

      manager.clearInput();

      expect(inputEl.value).toBe('');
    });

    it('清空后发送按钮应禁用', () => {
      manager.init();
      inputEl.value = '有内容';
      inputEl.dispatchEvent(new Event('input'));

      manager.clearInput();

      expect(btnSend.disabled).toBe(true);
      expect(btnSend.classList.contains('empty')).toBe(true);
    });
  });

  describe('setValue 预填内容', () => {
    it('应设置输入框值', () => {
      manager.init();
      manager.setValue('预填内容');

      expect(inputEl.value).toBe('预填内容');
    });

    it('设置后应触发 input 事件（调整高度 + 更新按钮状态）', () => {
      manager.init();
      manager.setValue('预填内容');

      // input 事件应已触发 handleInputChange → 发送按钮启用
      expect(btnSend.disabled).toBe(false);
      expect(btnSend.classList.contains('empty')).toBe(false);
    });
  });

  describe('refreshSendButtonState 刷新按钮状态', () => {
    it('流式态时应切换为暂停姿态且可点击（不锁定发送按钮）', () => {
      manager.init();
      host.mocks.isStreaming.mockReturnValue(true);
      inputEl.value = '有内容';

      manager.refreshSendButtonState();

      // 流式态下发送按钮变为暂停姿态，始终可点击（用户可中断工作通道）
      expect(btnSend.disabled).toBe(false);
      expect(btnSend.getAttribute('aria-label')).toBe('暂停会话（不中断，保留当前进度）');
    });

    it('空闲态下应根据内容更新按钮状态', () => {
      manager.init();
      host.mocks.isStreaming.mockReturnValue(false);
      inputEl.value = '';

      manager.refreshSendButtonState();

      expect(btnSend.disabled).toBe(true);
      expect(btnSend.classList.contains('empty')).toBe(true);
    });
  });

  describe('initResizeObserver', () => {
    it('input-area 元素存在时应创建 ResizeObserver', () => {
      // spy ResizeObserver 构造函数，验证 observe 被调用
      const observeSpy = vi.fn();
      const disconnectSpy = vi.fn();
      const origObserver = globalThis.ResizeObserver;
      globalThis.ResizeObserver = class {
        observe = observeSpy;
        unobserve = vi.fn();
        disconnect = disconnectSpy;
      } as unknown as typeof ResizeObserver;

      manager.init();

      expect(observeSpy).toHaveBeenCalledWith(document.getElementById('input-area'));

      globalThis.ResizeObserver = origObserver;
    });

    it('input-area 元素不存在时应静默降级（不创建 observer）', () => {
      document.body.innerHTML = ''; // 清空 DOM
      // 重新创建 inputEl/btnSend（已在 beforeEach 中获取）
      // 此时 input-area 不存在，init 不应抛错
      expect(() => manager.init()).not.toThrow();
    });
  });

  describe('cleanup 资源清理', () => {
    it('cleanup 应断开 ResizeObserver', () => {
      // spy ResizeObserver 构造函数
      const disconnectSpy = vi.fn();
      const origObserver = globalThis.ResizeObserver;
      globalThis.ResizeObserver = class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = disconnectSpy;
      } as unknown as typeof ResizeObserver;

      manager.init();
      manager.cleanup();

      expect(disconnectSpy).toHaveBeenCalledTimes(1);

      globalThis.ResizeObserver = origObserver;
    });

    it('cleanup 后键盘事件不应再触发回调', () => {
      manager.init();
      manager.cleanup();

      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      expect(host.mocks.emitSendMessage).not.toHaveBeenCalled();
    });
  });
});
