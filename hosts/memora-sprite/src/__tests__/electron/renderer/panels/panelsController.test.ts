/**
 * 面板控制器组合测试（P1）
 *
 * 覆盖目标：
 *   - PerceptionPanelManager（218 行/0 测试）：toggle/close + 6 个 init 子绑定 + cleanup
 *   - InputAreaManager（214 行/0 测试）：键盘事件 + 自适应高度 + ResizeObserver + getValue/setValue/clearInput
 *
 * Mock 策略：
 * - jsdom 环境 + setupDOM() 设置完整 DOM
 * - DI 注入 mock Host 接口
 * - mock window.electronAPI.getPerceptionSnapshot（异步拉取感知快照）
 * - mock ResizeObserver（jsdom 未实现）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PerceptionPanelManager } from '../../../../electron/renderer/panels/perceptionPanelManager.js';
import type { PerceptionPanelHost } from '../../../../electron/renderer/panels/perceptionPanelManager.js';
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

// ─── Mock window.electronAPI（PerceptionPanelManager.toggle 拉取快照） ──
const mockGetPerceptionSnapshot = vi.fn();
vi.stubGlobal('electronAPI', {
  getPerceptionSnapshot: mockGetPerceptionSnapshot,
});

// ─── 测试辅助 ─────────────────────────────────────────────

/** 设置 PerceptionPanelManager 所需的完整 DOM */
function setupPerceptionDOM(): void {
  document.body.innerHTML = `
    <div id="sprite-status-bar" tabindex="0">状态条</div>
    <div id="perception-panel" class="hidden">
      <button class="perception-panel-close">关闭</button>
      <button id="perception-metrics-toggle">运行指标</button>
      <div id="perception-metrics-grid" class="hidden"></div>
      <div id="perception-metrics-arrow"></div>
      <button id="perception-review-toggle">对话回顾</button>
      <div id="perception-review" class="hidden"></div>
      <div id="perception-review-arrow"></div>
      <button id="source-health-toggle">记忆源健康</button>
      <div id="source-health-list" class="hidden"></div>
      <div id="source-health-arrow"></div>
    </div>
    <div id="recommendation-list">
      <div data-action="view-recommendation" data-memory-id="mem-1">推荐1</div>
      <div data-action="view-recommendation" data-memory-id="mem-2">推荐2</div>
    </div>
  `;
}

/** 设置 InputAreaManager 所需的完整 DOM */
function setupInputAreaDOM(): void {
  document.body.innerHTML = `
    <div id="input-area">
      <textarea id="chat-input"></textarea>
      <button id="btn-send" disabled>发送</button>
    </div>
  `;
}

/** 创建 mock PerceptionPanelHost */
function createMockPerceptionHost(): PerceptionPanelHost & {
  mocks: {
    triggerMemoryRecall: ReturnType<typeof vi.fn>;
    updateAffectDisplay: ReturnType<typeof vi.fn>;
    updateRapportDisplay: ReturnType<typeof vi.fn>;
    updateContextDisplay: ReturnType<typeof vi.fn>;
    updatePatternsDisplay: ReturnType<typeof vi.fn>;
    updateProactiveStatsDisplay: ReturnType<typeof vi.fn>;
  };
} {
  const mocks = {
    triggerMemoryRecall: vi.fn(),
    updateAffectDisplay: vi.fn(),
    updateRapportDisplay: vi.fn(),
    updateContextDisplay: vi.fn(),
    updatePatternsDisplay: vi.fn(),
    updateProactiveStatsDisplay: vi.fn(),
  };
  return {
    ...mocks,
    mocks,
  };
}

/** 创建 mock InputAreaHost */
function createMockInputHost(streaming = false): InputAreaHost & {
  mocks: {
    isStreaming: ReturnType<typeof vi.fn>;
    emitSendMessage: ReturnType<typeof vi.fn>;
    emitStopMessage: ReturnType<typeof vi.fn>;
  };
} {
  const mocks = {
    isStreaming: vi.fn(() => streaming),
    emitSendMessage: vi.fn(),
    emitStopMessage: vi.fn(),
  };
  return {
    ...mocks,
    mocks,
  };
}

// ─── PerceptionPanelManager 测试 ─────────────────────

describe('PerceptionPanelManager', () => {
  let controller: PerceptionPanelManager;
  let host: ReturnType<typeof createMockPerceptionHost>;

  beforeEach(() => {
    vi.useFakeTimers();
    setupPerceptionDOM();
    host = createMockPerceptionHost();
    controller = new PerceptionPanelManager(host);
    mockGetPerceptionSnapshot.mockReset();
  });

  afterEach(() => {
    controller.cleanup();
    vi.useRealTimers();
  });

  describe('toggle 面板展开/收起', () => {
    it('初始 hidden 状态下 toggle 应展开面板（移除 hidden + 添加 visible）', async () => {
      controller.init();
      const panel = document.getElementById('perception-panel')!;
      expect(panel.classList.contains('hidden')).toBe(true);

      // 展开面板（需推进 fake timers 让 setTimeout 执行）
      mockGetPerceptionSnapshot.mockResolvedValue(null);
      controller.toggle();
      await vi.runAllTimersAsync();

      expect(panel.classList.contains('visible')).toBe(true);
      expect(panel.classList.contains('hidden')).toBe(false);
    });

    it('展开时应拉取感知快照并更新四块感知展示', async () => {
      controller.init();
      const snapshot = {
        affect: { mood: 'happy', energy: 0.8 },
        rapport: { level: 'familiar' },
        context: { topic: '编程' },
        patterns: [{ type: 'work-session' }],
        proactiveStats: { acceptanceRate: 0.75 },
      };
      mockGetPerceptionSnapshot.mockResolvedValue(snapshot);

      controller.toggle();
      await vi.runAllTimersAsync();

      expect(mockGetPerceptionSnapshot).toHaveBeenCalledTimes(1);
      expect(host.mocks.updateAffectDisplay).toHaveBeenCalledWith(snapshot.affect);
      expect(host.mocks.updateRapportDisplay).toHaveBeenCalledWith(snapshot.rapport);
      expect(host.mocks.updateContextDisplay).toHaveBeenCalledWith(snapshot.context);
      expect(host.mocks.updatePatternsDisplay).toHaveBeenCalledWith({ patterns: snapshot.patterns });
      expect(host.mocks.updateProactiveStatsDisplay).toHaveBeenCalledWith(snapshot.proactiveStats);
    });

    it('快照为 null 时应静默返回（不更新任何展示）', async () => {
      controller.init();
      mockGetPerceptionSnapshot.mockResolvedValue(null);

      controller.toggle();
      await vi.runAllTimersAsync();

      expect(mockGetPerceptionSnapshot).toHaveBeenCalledTimes(1);
      expect(host.mocks.updateAffectDisplay).not.toHaveBeenCalled();
    });

    it('拉取快照异常时应静默失败（不抛错、不阻塞面板展开）', async () => {
      controller.init();
      mockGetPerceptionSnapshot.mockRejectedValue(new Error('网络错误'));

      // 不应抛错
      expect(() => controller.toggle()).not.toThrow();
      await vi.runAllTimersAsync();

      // 面板应已展开（拉取异常不阻塞）
      const panel = document.getElementById('perception-panel')!;
      expect(panel.classList.contains('visible')).toBe(true);
    });

    it('visible 状态下 toggle 应收起面板（150ms 动画后添加 hidden）', async () => {
      controller.init();
      const panel = document.getElementById('perception-panel')!;
      // 模拟已展开状态
      panel.classList.remove('hidden');
      panel.classList.add('visible');

      // 收起面板
      controller.toggle();
      // 动画期间应有 hiding 类
      expect(panel.classList.contains('hiding')).toBe(true);
      expect(panel.classList.contains('visible')).toBe(false);

      // 推进 150ms 后应添加 hidden
      await vi.advanceTimersByTimeAsync(150);
      expect(panel.classList.contains('hidden')).toBe(true);
      expect(panel.classList.contains('hiding')).toBe(false);
    });

    it('panel 元素不存在时应静默返回', () => {
      document.body.innerHTML = ''; // 清空 DOM
      expect(() => controller.toggle()).not.toThrow();
    });
  });

  describe('close 关闭面板', () => {
    it('visible 状态下 close 应播放收起动画并添加 hidden', async () => {
      controller.init();
      const panel = document.getElementById('perception-panel')!;
      panel.classList.remove('hidden');
      panel.classList.add('visible');

      controller.close();
      expect(panel.classList.contains('hiding')).toBe(true);
      expect(panel.classList.contains('visible')).toBe(false);

      await vi.advanceTimersByTimeAsync(150);
      expect(panel.classList.contains('hidden')).toBe(true);
    });

    it('panel 不存在时应静默返回', () => {
      document.body.innerHTML = '';
      expect(() => controller.close()).not.toThrow();
    });
  });

  describe('bindRecommendationClick 推荐记忆点击', () => {
    it('点击推荐项应调用 triggerMemoryRecall 跳转', () => {
      controller.init();
      const item = document.querySelector('[data-action="view-recommendation"]') as HTMLElement;

      item.click();

      expect(host.mocks.triggerMemoryRecall).toHaveBeenCalledWith('mem-1');
    });

    it('点击非推荐项区域不应触发 triggerMemoryRecall', () => {
      controller.init();
      const list = document.getElementById('recommendation-list')!;

      list.click(); // 点击容器本身

      expect(host.mocks.triggerMemoryRecall).not.toHaveBeenCalled();
    });

    it('memoryId 为空时不应触发 triggerMemoryRecall', () => {
      controller.init();
      const item = document.querySelector('[data-action="view-recommendation"]') as HTMLElement;
      item.removeAttribute('data-memory-id');

      item.click();

      expect(host.mocks.triggerMemoryRecall).not.toHaveBeenCalled();
    });

    it('recommendation-list 不存在时应静默返回（init 不抛错）', () => {
      document.body.innerHTML = '';
      expect(() => controller.init()).not.toThrow();
    });
  });

  describe('bindStatusBarToggle 状态条触发', () => {
    it('点击状态条应触发 toggle', async () => {
      controller.init();
      mockGetPerceptionSnapshot.mockResolvedValue(null);
      const statusBar = document.getElementById('sprite-status-bar')!;

      statusBar.click();
      await vi.runAllTimersAsync();

      const panel = document.getElementById('perception-panel')!;
      expect(panel.classList.contains('visible')).toBe(true);
    });

    it('Enter 键应触发 toggle（可访问性）', async () => {
      controller.init();
      mockGetPerceptionSnapshot.mockResolvedValue(null);
      const statusBar = document.getElementById('sprite-status-bar')!;

      statusBar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await vi.runAllTimersAsync();

      const panel = document.getElementById('perception-panel')!;
      expect(panel.classList.contains('visible')).toBe(true);
    });

    it('Space 键应触发 toggle（可访问性）', async () => {
      controller.init();
      mockGetPerceptionSnapshot.mockResolvedValue(null);
      const statusBar = document.getElementById('sprite-status-bar')!;

      statusBar.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      await vi.runAllTimersAsync();

      const panel = document.getElementById('perception-panel')!;
      expect(panel.classList.contains('visible')).toBe(true);
    });

    it('其他键不应触发 toggle', () => {
      controller.init();
      const statusBar = document.getElementById('sprite-status-bar')!;

      statusBar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));

      const panel = document.getElementById('perception-panel')!;
      expect(panel.classList.contains('visible')).toBe(false);
    });
  });

  describe('bindCloseButton 关闭按钮', () => {
    it('点击关闭按钮应触发 close', async () => {
      controller.init();
      const closeBtn = document.querySelector('.perception-panel-close') as HTMLElement;
      const panel = document.getElementById('perception-panel')!;
      panel.classList.remove('hidden');
      panel.classList.add('visible');

      closeBtn.click();

      expect(panel.classList.contains('hiding')).toBe(true);
      await vi.advanceTimersByTimeAsync(150);
      expect(panel.classList.contains('hidden')).toBe(true);
    });
  });

  describe('三块折叠区域', () => {
    it('点击运行指标 toggle 应切换 grid/arrow 状态', () => {
      controller.init();
      const toggle = document.getElementById('perception-metrics-toggle')!;
      const grid = document.getElementById('perception-metrics-grid')!;
      const arrow = document.getElementById('perception-metrics-arrow')!;

      expect(grid.classList.contains('hidden')).toBe(true);
      expect(arrow.classList.contains('expanded')).toBe(false);

      toggle.click();

      expect(grid.classList.contains('hidden')).toBe(false);
      expect(arrow.classList.contains('expanded')).toBe(true);

      toggle.click();

      expect(grid.classList.contains('hidden')).toBe(true);
      expect(arrow.classList.contains('expanded')).toBe(false);
    });

    it('点击对话回顾 toggle 应切换 review/arrow 状态', () => {
      controller.init();
      const toggle = document.getElementById('perception-review-toggle')!;
      const review = document.getElementById('perception-review')!;
      const arrow = document.getElementById('perception-review-arrow')!;

      toggle.click();

      expect(review.classList.contains('hidden')).toBe(false);
      expect(arrow.classList.contains('expanded')).toBe(true);
    });

    it('点击记忆源健康 toggle 应切换 list/arrow 状态', () => {
      controller.init();
      const toggle = document.getElementById('source-health-toggle')!;
      const list = document.getElementById('source-health-list')!;
      const arrow = document.getElementById('source-health-arrow')!;

      toggle.click();

      expect(list.classList.contains('hidden')).toBe(false);
      expect(arrow.classList.contains('expanded')).toBe(true);
    });
  });

  describe('cleanup 事件清理', () => {
    it('cleanup 后点击状态条不应再触发 toggle', () => {
      controller.init();
      controller.cleanup();

      const statusBar = document.getElementById('sprite-status-bar')!;
      statusBar.click();

      // toggle 不应被触发（panel 仍为 hidden）
      const panel = document.getElementById('perception-panel')!;
      expect(panel.classList.contains('visible')).toBe(false);
    });
  });
});

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
    it('流式态时应直接返回（不更新按钮）', () => {
      manager.init();
      host.mocks.isStreaming.mockReturnValue(true);
      // init 时 input 为空 → btnSend.disabled=true，流式态下不更新此状态
      inputEl.value = '有内容';

      manager.refreshSendButtonState();

      // 流式态下按钮状态不变（init 时因 input 为空已禁用）
      expect(btnSend.disabled).toBe(true);
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
