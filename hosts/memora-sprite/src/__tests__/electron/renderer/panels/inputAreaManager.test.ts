/**
 * 输入区域管理器测试（panels/ 专属，覆盖全部公开方法 + 关键私有分支）
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - getValue/clearInput/setValue/refreshSendButtonState：基础读写 + 状态管理
 * - handleKeydown：Enter 发送/停止、Shift+Enter、Esc 清空/失焦、IME 合成守卫（isComposing / keyCode 229）
 * - handleClick：发送按钮点击
 * - initResizeObserver：创建 observer / 元素缺失降级 / undefined 降级 / 回调更新 CSS 变量（borderBoxSize 优先 + contentRect 回退 + height<=0 跳过）
 * - initCompletion：候选列表存在时初始化 / 缺失时降级 / onSelect 回填文本 + input 事件
 * - initProviderSelector：元素缺失降级 / 点击切换 / 点击关闭 / 项切换（含 warning 跳设置）/ 空状态跳设置 / 键盘导航（↓↑ Enter Esc）
 * - loadProviderSelector：空列表渲染 / 正常渲染 / active 回退 / 加载失败降级
 * - refreshTokenUsage：元素缺失降级 / 无数据 / 正常显示 / 格式化 / 颜色分级 / 紧凑态 / tooltip / 异常降级
 * - cleanup：断开 observer + 清理事件 + 清理补全
 *
 * Mock 策略：
 * - vi.mock errorHelpers.reportError（避免 console 噪音 + IPC 调用）
 * - window.electronAPI 通过 Partial<ElectronAPI> as ElectronAPI 注入（仅含 InputAreaManager 依赖的 IPC）
 * - 使用真实 EventTracker（确保事件绑定/清理真实可测，避免类型断言）
 * - ResizeObserver 通过 vi.stubGlobal 注入 mock 实现（jsdom 未提供）
 * - QuickInputCompletion 通过 vi.mock 替换为可控 mock（验证 init/onSelect/cleanup 调用，不测试补全内部逻辑）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InputAreaManager } from '../../../../electron/renderer/panels/inputAreaManager.js';
import type { InputAreaHost } from '../../../../electron/renderer/panels/inputAreaManager.js';
import type { ElectronAPI } from '../../../../electron/preload.js';
import { EventTracker } from '../../../../electron/renderer/helpers/eventTracker.js';
// mock 后的 reportError（vi.mock 替换为 vi.fn()，导入即为 mock 函数）
import { reportError } from '../../../../electron/renderer/helpers/errorHelpers.js';

// ─── Mock errorHelpers（reportError 依赖 window.electronAPI.rendererLog + console） ───
vi.mock('../../../../electron/renderer/helpers/errorHelpers.js', () => ({
  reportError: vi.fn(),
  createIpcErrorHandler: vi.fn(() => vi.fn()),
  toError: vi.fn((err: unknown) => ({
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : 'Error',
  })),
}));

// ─── Mock domHelpers（inputAreaManager 仅使用 clearElement，提供真实实现避免下拉项累积） ───
// mock 后 domHelpers/constants/errors 不再出现在覆盖率报告中（与 errorHelpers 同模式），
// 避免共享工具文件的未使用函数拉低单文件测试的全局覆盖率阈值
vi.mock('../../../../electron/renderer/helpers/domHelpers.js', () => ({
  // clearElement 提供 while+removeChild 真实实现（与源码一致），
  // 确保 loadProviderSelector 多次调用时下拉项不累积（键盘导航测试依赖此行为）
  clearElement: vi.fn((el: Element) => {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }),
}));

// ─── Mock QuickInputCompletion（验证 init/onSelect/cleanup 调用，不测试补全内部逻辑） ───
// vi.hoisted 确保变量在 vi.mock 提升前可用
const { mockOnSelectCallbacks, MockQuickInputCompletion } = vi.hoisted(() => {
  /** 存储 onSelect 回调，用于测试时模拟用户选择候选项 */
  const mockOnSelectCallbacks: Array<(text: string) => void> = [];
  /** Mock QuickInputCompletion 构造函数 */
  const MockQuickInputCompletion = vi.fn();
  return { mockOnSelectCallbacks, MockQuickInputCompletion };
});

vi.mock('../../../../electron/renderer/quick-input/quickInputCompletion.js', () => ({
  // 使用普通函数（非箭头函数）作为 constructor implementation
  // 箭头函数没有 [[Construct]] 内部方法，不能被 new 调用
  // constructor 返回对象时，new 操作符使用返回的对象（而非 this）
  QuickInputCompletion: MockQuickInputCompletion.mockImplementation(function () {
    return {
      onSelect: vi.fn((cb: (text: string) => void) => {
        mockOnSelectCallbacks.push(cb);
      }),
      init: vi.fn(),
      cleanup: vi.fn(),
    };
  }),
}));

// ─── Mock ResizeObserver（jsdom 未实现，需注入 mock） ───

/** Mock ResizeObserver 实例类型（构造函数返回的 observe/unobserve/disconnect 对象） */
interface MockResizeObserverInstance {
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

/** 存储 ResizeObserver 回调的引用（测试时手动触发用） */
let resizeObserverCallback: ResizeObserverCallback | null = null;

/** Mock ResizeObserver 构造函数（vi.fn 包装，支持 mock.results 访问实例） */
// 使用普通函数（非箭头函数）支持 new 调用；constructor 返回对象时 new 使用返回值
const MockResizeObserver = vi.fn(function (cb: ResizeObserverCallback) {
  resizeObserverCallback = cb;
  return {
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
});

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock InputAreaHost（含可断言的 mocks 引用） */
function createMockHost(streaming = false): InputAreaHost & {
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
  return { ...mocks, mocks };
}

/** 创建 mock electronAPI（仅包含 InputAreaManager 依赖的 IPC 方法） */
function createMockElectronAPI(): ElectronAPI {
  const api: Partial<ElectronAPI> = {
    listLlmProviders: vi.fn().mockResolvedValue({ active: '', providers: [] }),
    setActiveLlmProvider: vi.fn().mockResolvedValue({ success: true, error: null }),
    getDashboard: vi.fn().mockResolvedValue({ metrics: null }),
    searchMemories: vi.fn().mockResolvedValue({ hits: [] }),
    searchSessionMessages: vi.fn().mockResolvedValue({ results: [] }),
  };
  // Partial<T> as T 单层断言（仅含子集方法，测试中按需覆盖返回值）
  return api as ElectronAPI;
}

/** 设置完整 DOM（包含 InputAreaManager 可能引用的所有元素） */
function setupDOM(): void {
  document.body.innerHTML = `
    <div id="input-area">
      <textarea id="chat-input"></textarea>
      <button id="btn-send" disabled>发送</button>
    </div>
    <div id="provider-selector" tabindex="0"></div>
    <span id="provider-name"></span>
    <div id="provider-dropdown"></div>
    <ul id="chat-completion-list"></ul>
    <div id="token-usage"></div>
    <span id="token-usage-text"></span>
    <div id="token-usage-fill"></div>
  `;
}

// ─── 测试主体 ─────────────────────────────────────────────

describe('InputAreaManager', () => {
  let inputEl: HTMLTextAreaElement;
  let btnSend: HTMLButtonElement;
  let events: EventTracker;
  let manager: InputAreaManager;
  let host: ReturnType<typeof createMockHost>;
  let mockApi: ElectronAPI;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    resizeObserverCallback = null;
    mockApi = createMockElectronAPI();
    // 通过 defineProperty 设置 window.electronAPI（避免类型断言）
    Object.defineProperty(window, 'electronAPI', {
      value: mockApi,
      writable: true,
      configurable: true,
    });
    setupDOM();
    inputEl = document.getElementById('chat-input') as HTMLTextAreaElement;
    btnSend = document.getElementById('btn-send') as HTMLButtonElement;
    events = new EventTracker();
    host = createMockHost();
    manager = new InputAreaManager(inputEl, btnSend, events, host);
  });

  afterEach(() => {
    manager.cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mockOnSelectCallbacks.length = 0;
    resizeObserverCallback = null;
    document.body.innerHTML = '';
  });

  // ─── getValue · 输入读取 ────────────────────────────────

  describe('getValue · 输入读取', () => {
    it('应返回 trim 后的值', () => {
      inputEl.value = '  你好世界  ';
      expect(manager.getValue()).toBe('你好世界');
    });

    it('空输入应返回空字符串', () => {
      inputEl.value = '   ';
      expect(manager.getValue()).toBe('');
    });

    it('超出 10000 字符限制应截断', () => {
      inputEl.value = 'a'.repeat(10050);
      expect(manager.getValue()).toHaveLength(10000);
    });

    it('10000 字符以内不应截断', () => {
      inputEl.value = 'a'.repeat(5000);
      expect(manager.getValue()).toHaveLength(5000);
    });
  });

  // ─── clearInput · 清空输入 ──────────────────────────────

  describe('clearInput · 清空输入', () => {
    it('应清空输入框值', () => {
      inputEl.value = '有内容';
      manager.clearInput();
      expect(inputEl.value).toBe('');
    });

    it('清空后发送按钮应禁用', () => {
      inputEl.value = '有内容';
      manager.clearInput();
      expect(btnSend.disabled).toBe(true);
      expect(btnSend.classList.contains('empty')).toBe(true);
    });
  });

  // ─── setValue · 预填内容 ────────────────────────────────

  describe('setValue · 预填内容', () => {
    it('应设置输入框值', () => {
      manager.setValue('预填内容');
      expect(inputEl.value).toBe('预填内容');
    });

    it('设置后应触发 input 事件（更新按钮状态）', () => {
      manager.init(); // 绑定 input 事件监听器，使 setValue 触发的 input 事件能被捕获
      manager.setValue('预填内容');
      expect(btnSend.disabled).toBe(false);
      expect(btnSend.classList.contains('empty')).toBe(false);
    });
  });

  // ─── refreshSendButtonState · 按钮状态 ──────────────────

  describe('refreshSendButtonState · 按钮状态', () => {
    it('流式态时应直接返回（不更新按钮）', () => {
      host.mocks.isStreaming.mockReturnValue(true);
      inputEl.value = '有内容';
      // init 时 input 为空 → btnSend.disabled=true，流式态不更新
      manager.refreshSendButtonState();
      expect(btnSend.disabled).toBe(true);
    });

    it('空闲态有内容时应启用按钮', () => {
      host.mocks.isStreaming.mockReturnValue(false);
      inputEl.value = '内容';
      manager.refreshSendButtonState();
      expect(btnSend.disabled).toBe(false);
      expect(btnSend.classList.contains('empty')).toBe(false);
    });

    it('空闲态无内容时应禁用按钮', () => {
      host.mocks.isStreaming.mockReturnValue(false);
      inputEl.value = '';
      manager.refreshSendButtonState();
      expect(btnSend.disabled).toBe(true);
      expect(btnSend.classList.contains('empty')).toBe(true);
    });
  });

  // ─── handleKeydown · 键盘事件 ───────────────────────────

  describe('handleKeydown · 键盘事件', () => {
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

    it('IME 合成期（isComposing=true）Enter 不应触发发送', () => {
      manager.init();
      // isComposing=true 模拟中文输入法选词时按 Enter 确认候选词
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true }));
      expect(host.mocks.emitSendMessage).not.toHaveBeenCalled();
      expect(host.mocks.emitStopMessage).not.toHaveBeenCalled();
    });

    it('keyCode 229（旧版浏览器 IME 兼容）Enter 不应触发发送', () => {
      manager.init();
      // keyCode 229 是旧版浏览器 IME 合成期标识
      const event = new KeyboardEvent('keydown', { key: 'Enter' });
      Object.defineProperty(event, 'keyCode', { value: 229 });
      inputEl.dispatchEvent(event);
      expect(host.mocks.emitSendMessage).not.toHaveBeenCalled();
    });

    it('其他键不应触发任何回调', () => {
      manager.init();
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
      expect(host.mocks.emitSendMessage).not.toHaveBeenCalled();
      expect(host.mocks.emitStopMessage).not.toHaveBeenCalled();
    });
  });

  // ─── handleClick · 发送按钮点击 ─────────────────────────

  describe('handleClick · 发送按钮点击', () => {
    it('点击发送按钮应触发 emitSendMessage', () => {
      manager.init();
      inputEl.value = '测试内容';
      btnSend.disabled = false;
      btnSend.click();
      expect(host.mocks.emitSendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // ─── initResizeObserver · ResizeObserver ────────────────

  describe('initResizeObserver · ResizeObserver', () => {
    it('input-area 元素存在时应创建 ResizeObserver 并 observe', () => {
      manager.init();
      const observer = MockResizeObserver.mock.results[0]?.value as MockResizeObserverInstance | undefined;
      expect(observer).toBeDefined();
      expect(observer!.observe).toHaveBeenCalledWith(document.getElementById('input-area'));
    });

    it('input-area 元素不存在时应静默降级', () => {
      document.body.innerHTML = '';
      // 重新创建必需元素（inputEl/btnSend 已在 beforeEach 获取引用）
      expect(() => manager.init()).not.toThrow();
    });

    it('ResizeObserver 未定义时应静默降级', () => {
      vi.unstubAllGlobals(); // 移除 ResizeObserver mock
      expect(() => manager.init()).not.toThrow();
    });

    it('回调应使用 borderBoxSize 更新 --input-area-height CSS 变量', () => {
      manager.init();
      // 手动触发 ResizeObserver 回调（borderBoxSize 优先）
      const entry = {
        borderBoxSize: [{ blockSize: 200, inlineSize: 400 }],
        contentRect: { height: 150 },
      } as Partial<ResizeObserverEntry> as ResizeObserverEntry;
      resizeObserverCallback!([entry], new MockResizeObserver(() => {}));

      expect(document.documentElement.style.getPropertyValue('--input-area-height')).toBe('200px');
    });

    it('borderBoxSize 缺失时应回退到 contentRect.height', () => {
      manager.init();
      const entry = {
        contentRect: { height: 180 },
      } as Partial<ResizeObserverEntry> as ResizeObserverEntry;
      resizeObserverCallback!([entry], new MockResizeObserver(() => {}));

      expect(document.documentElement.style.getPropertyValue('--input-area-height')).toBe('180px');
    });

    it('height <= 0 时不应更新 CSS 变量', () => {
      manager.init();
      document.documentElement.style.setProperty('--input-area-height', '999px');
      const entry = {
        borderBoxSize: [{ blockSize: 0, inlineSize: 0 }],
        contentRect: { height: 0 },
      } as Partial<ResizeObserverEntry> as ResizeObserverEntry;
      resizeObserverCallback!([entry], new MockResizeObserver(() => {}));

      // CSS 变量保持原值（不被 0 覆盖）
      expect(document.documentElement.style.getPropertyValue('--input-area-height')).toBe('999px');
    });
  });

  // ─── initCompletion · 输入补全 ──────────────────────────

  describe('initCompletion · 输入补全', () => {
    it('候选列表容器存在时应初始化 QuickInputCompletion', () => {
      manager.init();
      // QuickInputCompletion 构造函数应被调用（传入 inputEl + completionList + electronAPI）
      expect(MockQuickInputCompletion).toHaveBeenCalledWith(
        inputEl,
        document.getElementById('chat-completion-list'),
        mockApi,
      );
    });

    it('候选列表容器缺失时应静默降级（不初始化补全）', () => {
      document.getElementById('chat-completion-list')?.remove();
      MockQuickInputCompletion.mockClear();
      expect(() => manager.init()).not.toThrow();
      expect(MockQuickInputCompletion).not.toHaveBeenCalled();
    });

    it('onSelect 回调应回填文本到输入框并触发 input 事件', () => {
      manager.init();
      // 模拟 QuickInputCompletion 触发 onSelect 回调
      expect(mockOnSelectCallbacks).toHaveLength(1);
      mockOnSelectCallbacks[0]!('回填的候选文本');

      expect(inputEl.value).toBe('回填的候选文本');
      // input 事件应触发 handleInputChange → 发送按钮启用
      expect(btnSend.disabled).toBe(false);
    });

    it('onSelect 回调应将光标移到末尾', () => {
      manager.init();
      const setSelectionSpy = vi.spyOn(inputEl, 'setSelectionRange');
      mockOnSelectCallbacks[0]!('候选文本');
      // setSelectionRange 应以 (length, length) 调用（光标移到末尾）
      expect(setSelectionSpy).toHaveBeenCalledWith(4, 4);
    });
  });

  // ─── initProviderSelector · Provider 选择器事件 ────────

  describe('initProviderSelector · Provider 选择器事件', () => {
    it('providerSelector 或 providerDropdown 缺失时应静默降级', () => {
      document.getElementById('provider-selector')?.remove();
      document.getElementById('provider-dropdown')?.remove();
      expect(() => manager.init()).not.toThrow();
    });

    it('点击 provider 按钮应切换下拉 hidden 类', () => {
      manager.init();
      const dropdown = document.getElementById('provider-dropdown')!;
      // init 后初始为 hidden
      expect(dropdown.classList.contains('hidden')).toBe(true);

      // 第一次点击 → 移除 hidden（显示）
      document.getElementById('provider-selector')!.click();
      expect(dropdown.classList.contains('hidden')).toBe(false);

      // 第二次点击 → 添加 hidden（隐藏）
      document.getElementById('provider-selector')!.click();
      expect(dropdown.classList.contains('hidden')).toBe(true);
    });

    it('点击 document 其他区域应关闭下拉', () => {
      manager.init();
      const dropdown = document.getElementById('provider-dropdown')!;
      // 先打开下拉
      document.getElementById('provider-selector')!.click();
      expect(dropdown.classList.contains('hidden')).toBe(false);

      // 点击 document 关闭下拉
      document.dispatchEvent(new MouseEvent('click'));
      expect(dropdown.classList.contains('hidden')).toBe(true);
    });

    it('点击 provider 项应调用 setActiveLlmProvider 并关闭下拉', async () => {
      // 先渲染 provider 列表
      const providerData = {
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7 },
          { key: 'anthropic', name: 'Anthropic', provider: 'anthropic', model: 'claude-3', baseUrl: '', apiKey: '', temperature: 0.7 },
        ],
      };
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue(providerData);

      manager.init(); // 绑定事件委托（dropdown click 事件）
      await manager.loadProviderSelector();
      const dropdown = document.getElementById('provider-dropdown')!;
      const anthropicItem = dropdown.querySelector('[data-provider-key="anthropic"]') as HTMLElement;

      // 点击 Anthropic 项
      anthropicItem.click();

      // 等待 async 事件处理器完成
      await vi.waitFor(() => {
        expect(mockApi.setActiveLlmProvider).toHaveBeenCalledWith('anthropic');
      });
      expect(dropdown.classList.contains('hidden')).toBe(true);
    });

    it('setActiveLlmProvider 返回 warning 时应跳转到设置', async () => {
      const providerData = {
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7 },
        ],
      };
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue(providerData);
      (mockApi.setActiveLlmProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        error: null,
        warning: 'Agent 未初始化',
      });

      manager.init(); // 绑定事件委托
      await manager.loadProviderSelector();
      const dropdown = document.getElementById('provider-dropdown')!;
      const item = dropdown.querySelector('[data-provider-key="openai"]') as HTMLElement;
      item.click();

      await vi.waitFor(() => {
        expect(host.mocks.switchToSettings).toHaveBeenCalledTimes(1);
      });
    });

    it('点击空状态提示项应跳转到设置面板', async () => {
      // providers 为空时渲染空状态提示项
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({ active: '', providers: [] });
      manager.init(); // 绑定事件委托
      await manager.loadProviderSelector();

      const dropdown = document.getElementById('provider-dropdown')!;
      const hintBtn = dropdown.querySelector('[data-action="goto-settings"]') as HTMLElement;
      expect(hintBtn).toBeTruthy();

      hintBtn.click();
      expect(host.mocks.switchToSettings).toHaveBeenCalledTimes(1);
      expect(dropdown.classList.contains('hidden')).toBe(true);
    });

    it('providerSelector 上按 Escape 应关闭下拉并聚焦按钮', () => {
      manager.init();
      const selector = document.getElementById('provider-selector')!;
      const dropdown = document.getElementById('provider-dropdown')!;
      const focusSpy = vi.spyOn(selector, 'focus');

      // 先打开下拉
      selector.click();
      // 按 Escape 关闭
      selector.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(dropdown.classList.contains('hidden')).toBe(true);
      expect(focusSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ─── initProviderSelector · 键盘导航 ────────────────────

  describe('initProviderSelector · 键盘导航', () => {
    beforeEach(async () => {
      // 渲染 provider 列表（3 个 provider）
      const providerData = {
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7 },
          { key: 'anthropic', name: 'Anthropic', provider: 'anthropic', model: 'claude-3', baseUrl: '', apiKey: '', temperature: 0.7 },
          { key: 'google', name: 'Google', provider: 'google', model: 'gemini', baseUrl: '', apiKey: '', temperature: 0.7 },
        ],
      };
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue(providerData);
      manager.init();
      await manager.loadProviderSelector();
    });

    it('ArrowDown 应向下移动焦点', () => {
      const dropdown = document.getElementById('provider-dropdown')!;
      const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item[data-provider-key]');

      // 初始无焦点 → ArrowDown 焦点到第一项
      dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(document.activeElement).toBe(items[0]);

      // 再次 ArrowDown → 焦点到第二项
      dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(document.activeElement).toBe(items[1]);
    });

    it('ArrowDown 在最后一项应停留在最后一项', () => {
      const dropdown = document.getElementById('provider-dropdown')!;
      const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item[data-provider-key]');

      // 焦点到最后一项
      items[2]!.focus();
      dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
      expect(document.activeElement).toBe(items[2]);
    });

    it('ArrowUp 应向上移动焦点', () => {
      const dropdown = document.getElementById('provider-dropdown')!;
      const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item[data-provider-key]');

      // 先焦点到第二项
      items[1]!.focus();
      // ArrowUp → 焦点到第一项
      dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      expect(document.activeElement).toBe(items[0]);
    });

    it('ArrowUp 在第一项应循环到最后一项', () => {
      const dropdown = document.getElementById('provider-dropdown')!;
      const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item[data-provider-key]');

      // 初始无焦点（currentIdx < 0）→ ArrowUp 焦点到最后一项
      dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
      expect(document.activeElement).toBe(items[2]);
    });

    it('Enter 应选择当前焦点项', async () => {
      const dropdown = document.getElementById('provider-dropdown')!;

      // 焦点到第二项
      const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item[data-provider-key]');
      items[1]!.focus();

      // 按 Enter 选择
      dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      await vi.waitFor(() => {
        expect(mockApi.setActiveLlmProvider).toHaveBeenCalledWith('anthropic');
      });
      expect(dropdown.classList.contains('hidden')).toBe(true);
    });

    it('Enter 无焦点项时不应触发选择', () => {
      const dropdown = document.getElementById('provider-dropdown')!;
      // 初始无焦点 → Enter 不应触发
      dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(mockApi.setActiveLlmProvider).not.toHaveBeenCalled();
    });

    it('Enter 项无 providerKey 时不应触发选择', () => {
      const dropdown = document.getElementById('provider-dropdown')!;
      // 移除 data-provider-key 属性
      const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item[data-provider-key]');
      items[0]!.removeAttribute('data-provider-key');
      items[0]!.focus();
      dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(mockApi.setActiveLlmProvider).not.toHaveBeenCalled();
    });

    it('Enter 选择返回 warning 时应跳转到设置', async () => {
      (mockApi.setActiveLlmProvider as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        error: null,
        warning: '需初始化',
      });
      const dropdown = document.getElementById('provider-dropdown')!;
      const items = dropdown.querySelectorAll<HTMLElement>('.dropdown-item[data-provider-key]');
      items[0]!.focus();

      dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

      await vi.waitFor(() => {
        expect(host.mocks.switchToSettings).toHaveBeenCalledTimes(1);
      });
    });

    it('dropdown 上按 Escape 应关闭下拉并聚焦 providerSelector', () => {
      const dropdown = document.getElementById('provider-dropdown')!;
      const selector = document.getElementById('provider-selector')!;
      const focusSpy = vi.spyOn(selector, 'focus');

      dropdown.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

      expect(dropdown.classList.contains('hidden')).toBe(true);
      expect(focusSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ─── loadProviderSelector · 加载 Provider 列表 ──────────

  describe('loadProviderSelector · 加载 Provider 列表', () => {
    it('providerNameEl 或 providerDropdown 缺失时应静默降级', async () => {
      document.getElementById('provider-name')?.remove();
      await expect(manager.loadProviderSelector()).resolves.not.toThrow();
    });

    it('providers 为空时应显示"未配置"并渲染空状态提示项', async () => {
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({ active: '', providers: [] });

      await manager.loadProviderSelector();

      const nameEl = document.getElementById('provider-name')!;
      const dropdown = document.getElementById('provider-dropdown')!;
      expect(nameEl.textContent).toBe('未配置');
      expect(document.getElementById('provider-selector')!.classList.contains('configured')).toBe(false);

      // 空状态提示项
      const hintBtn = dropdown.querySelector('[data-action="goto-settings"]') as HTMLElement;
      expect(hintBtn).toBeTruthy();
      expect(hintBtn.textContent).toBe('请在设置中添加 API');
    });

    it('正常渲染时应更新名称 + configured 类 + 下拉项', async () => {
      const providerData = {
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7 },
          { key: 'anthropic', name: 'Anthropic', provider: 'anthropic', model: 'claude-3', baseUrl: '', apiKey: '', temperature: 0.7 },
        ],
      };
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue(providerData);

      await manager.loadProviderSelector();

      const nameEl = document.getElementById('provider-name')!;
      const dropdown = document.getElementById('provider-dropdown')!;
      expect(nameEl.textContent).toBe('OpenAI');
      expect(document.getElementById('provider-selector')!.classList.contains('configured')).toBe(true);

      // 下拉项
      const items = dropdown.querySelectorAll('.dropdown-item[data-provider-key]');
      expect(items).toHaveLength(2);
      // active 项应有 active 类 + aria-selected="true"
      expect(items[0]!.classList.contains('active')).toBe(true);
      expect(items[0]!.getAttribute('aria-selected')).toBe('true');
      expect(items[1]!.classList.contains('active')).toBe(false);
      expect(items[1]!.getAttribute('aria-selected')).toBe('false');
    });

    it('active provider 不在列表中时应回退到第一个', async () => {
      const providerData = {
        active: 'nonexistent',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7 },
        ],
      };
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue(providerData);

      await manager.loadProviderSelector();

      const nameEl = document.getElementById('provider-name')!;
      // active 不匹配 → 回退到 providers[0]
      expect(nameEl.textContent).toBe('OpenAI');
    });

    it('加载失败时应显示"加载失败"并调用 reportError', async () => {
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 失败'));

      await manager.loadProviderSelector();

      const nameEl = document.getElementById('provider-name')!;
      expect(nameEl.textContent).toBe('加载失败');
      expect(reportError).toHaveBeenCalledWith('InputAreaManager.loadProviderSelector', expect.any(Error));
    });
  });

  // ─── refreshTokenUsage · Token 用量刷新 ─────────────────

  describe('refreshTokenUsage · Token 用量刷新', () => {
    it('tokenUsageText 缺失时应静默降级', async () => {
      document.getElementById('token-usage-text')?.remove();
      await expect(manager.refreshTokenUsage()).resolves.not.toThrow();
    });

    it('tokenUsageFill 缺失时应静默降级', async () => {
      document.getElementById('token-usage-fill')?.remove();
      await expect(manager.refreshTokenUsage()).resolves.not.toThrow();
    });

    it('无 metrics 时应显示 -- 并隐藏进度条', async () => {
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({ metrics: null });

      await manager.refreshTokenUsage();

      const textEl = document.getElementById('token-usage-text')!;
      const fillEl = document.getElementById('token-usage-fill')!;
      const usageEl = document.getElementById('token-usage')!;
      expect(textEl.textContent).toBe('--');
      expect(fillEl.style.width).toBe('0%');
      expect(usageEl.classList.contains('token-usage-compact')).toBe(true);
    });

    it('有 metrics.llm 时应显示已用/总量格式', async () => {
      // total = 500 + 300 = 800，contextWindow = 32768
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
        metrics: { llm: { callCount: 5, totalInputTokens: 500, totalOutputTokens: 300 } },
      });
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7, contextWindow: 32768 },
        ],
      });

      await manager.refreshTokenUsage();

      const textEl = document.getElementById('token-usage-text')!;
      // 800 < 1000 → "800"，32768 >= 1000 → "32.8K"
      expect(textEl.textContent).toBe('800/32.8K');
      const fillEl = document.getElementById('token-usage-fill')!;
      // ratio = 800/32768 ≈ 0.0244 → 2%
      expect(fillEl.style.width).toBe('2%');
      // ratio < 0.6 → compact
      expect(document.getElementById('token-usage')!.classList.contains('token-usage-compact')).toBe(true);
    });

    it('大数字应格式化为 K 格式', async () => {
      // total = 1500 + 2000 = 3500，contextWindow = 32768
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
        metrics: { llm: { callCount: 10, totalInputTokens: 1500, totalOutputTokens: 2000 } },
      });
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7, contextWindow: 32768 },
        ],
      });

      await manager.refreshTokenUsage();

      const textEl = document.getElementById('token-usage-text')!;
      // 3500 >= 1000 → "3.5K"，32768 → "32.8K"
      expect(textEl.textContent).toBe('3.5K/32.8K');
    });

    it('contextWindow 缺失时应使用默认值 32768', async () => {
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
        metrics: { llm: { callCount: 1, totalInputTokens: 100, totalOutputTokens: 50 } },
      });
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: 'openai',
        providers: [
          // 无 contextWindow 字段
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7 },
        ],
      });

      await manager.refreshTokenUsage();

      const textEl = document.getElementById('token-usage-text')!;
      // 使用默认 32768 → "32.8K"
      expect(textEl.textContent).toBe('150/32.8K');
    });

    it('active provider 不在列表中时应使用默认 contextWindow', async () => {
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
        metrics: { llm: { callCount: 1, totalInputTokens: 100, totalOutputTokens: 50 } },
      });
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: 'nonexistent',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7, contextWindow: 8000 },
        ],
      });

      await manager.refreshTokenUsage();

      // active 不匹配 → activeProvider 为 undefined → 使用默认 32768
      const textEl = document.getElementById('token-usage-text')!;
      expect(textEl.textContent).toBe('150/32.8K');
    });

    it('ratio >= 0.9 时应添加 level-danger 类', async () => {
      // total = 30000，contextWindow = 32768 → ratio ≈ 0.916
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
        metrics: { llm: { callCount: 20, totalInputTokens: 20000, totalOutputTokens: 10000 } },
      });
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7, contextWindow: 32768 },
        ],
      });

      await manager.refreshTokenUsage();

      const fillEl = document.getElementById('token-usage-fill')!;
      expect(fillEl.classList.contains('level-danger')).toBe(true);
      expect(fillEl.classList.contains('level-warning')).toBe(false);
      // ratio >= 0.6 → 非 compact
      expect(document.getElementById('token-usage')!.classList.contains('token-usage-compact')).toBe(false);
    });

    it('0.7 <= ratio < 0.9 时应添加 level-warning 类', async () => {
      // total = 25000，contextWindow = 32768 → ratio ≈ 0.763
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
        metrics: { llm: { callCount: 15, totalInputTokens: 15000, totalOutputTokens: 10000 } },
      });
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7, contextWindow: 32768 },
        ],
      });

      await manager.refreshTokenUsage();

      const fillEl = document.getElementById('token-usage-fill')!;
      expect(fillEl.classList.contains('level-warning')).toBe(true);
      expect(fillEl.classList.contains('level-danger')).toBe(false);
    });

    it('ratio < 0.7 时不应添加 level 类', async () => {
      // total = 2000，contextWindow = 32768 → ratio ≈ 0.061
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
        metrics: { llm: { callCount: 5, totalInputTokens: 1000, totalOutputTokens: 1000 } },
      });
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7, contextWindow: 32768 },
        ],
      });

      await manager.refreshTokenUsage();

      const fillEl = document.getElementById('token-usage-fill')!;
      expect(fillEl.classList.contains('level-warning')).toBe(false);
      expect(fillEl.classList.contains('level-danger')).toBe(false);
    });

    it('ratio >= 0.6 时应移除 token-usage-compact 类', async () => {
      // total = 20000，contextWindow = 32768 → ratio ≈ 0.610
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
        metrics: { llm: { callCount: 10, totalInputTokens: 12000, totalOutputTokens: 8000 } },
      });
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7, contextWindow: 32768 },
        ],
      });

      await manager.refreshTokenUsage();

      expect(document.getElementById('token-usage')!.classList.contains('token-usage-compact')).toBe(false);
    });

    it('应设置 data-tooltip 属性展示输入/输出分解', async () => {
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
        metrics: { llm: { callCount: 5, totalInputTokens: 1500, totalOutputTokens: 2000 } },
      });
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7, contextWindow: 32768 },
        ],
      });

      await manager.refreshTokenUsage();

      const usageEl = document.getElementById('token-usage')!;
      expect(usageEl.getAttribute('data-tooltip')).toBe('输入 1.5K / 输出 2.0K / 上下文窗口 32.8K');
    });

    it('ratio 超过 100% 时进度条应截断到 100%', async () => {
      // total = 40000，contextWindow = 32768 → ratio > 1
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockResolvedValue({
        metrics: { llm: { callCount: 30, totalInputTokens: 25000, totalOutputTokens: 15000 } },
      });
      (mockApi.listLlmProviders as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: 'openai',
        providers: [
          { key: 'openai', name: 'OpenAI', provider: 'openai', model: 'gpt-4', baseUrl: '', apiKey: '', temperature: 0.7, contextWindow: 32768 },
        ],
      });

      await manager.refreshTokenUsage();

      const fillEl = document.getElementById('token-usage-fill')!;
      expect(fillEl.style.width).toBe('100%');
    });

    it('getDashboard 异常时应显示 -- 并调用 reportError', async () => {
      (mockApi.getDashboard as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('IPC 崩溃'));

      await manager.refreshTokenUsage();

      const textEl = document.getElementById('token-usage-text')!;
      expect(textEl.textContent).toBe('--');
      expect(document.getElementById('token-usage')!.classList.contains('token-usage-compact')).toBe(true);
      expect(reportError).toHaveBeenCalledWith('InputAreaManager.refreshTokenUsage', expect.any(Error));
    });
  });

  // ─── cleanup · 资源清理 ─────────────────────────────────

  describe('cleanup · 资源清理', () => {
    it('应断开 ResizeObserver', () => {
      manager.init();
      const observer = MockResizeObserver.mock.results[0]?.value as MockResizeObserverInstance | undefined;
      manager.cleanup();
      expect(observer!.disconnect).toHaveBeenCalledTimes(1);
    });

    it('应清理事件监听器（键盘事件不再触发回调）', () => {
      manager.init();
      manager.cleanup();
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(host.mocks.emitSendMessage).not.toHaveBeenCalled();
    });

    it('应清理补全管理器', () => {
      manager.init();
      const completionInstance = MockQuickInputCompletion.mock.results[0]?.value as { cleanup: ReturnType<typeof vi.fn> } | undefined;
      manager.cleanup();
      expect(completionInstance!.cleanup).toHaveBeenCalledTimes(1);
    });

    it('无 ResizeObserver 时 cleanup 不应抛错', () => {
      // 不调用 init → resizeObserver 为 null
      expect(() => manager.cleanup()).not.toThrow();
    });
  });
});
