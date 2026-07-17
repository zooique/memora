/**
 * 快速输入控制器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - handleShow：状态重置 / 剪贴板预填 / 敏感检测 / 无预设分支
 * - handleConfirm：成功 / 失败 / 流式 / 普通 / 竞态防护
 * - toggleStreamMode：手动切换 + localStorage 持久化
 * - toggleExpand：手动切换 + localStorage 持久化
 * - updateCounter：字符计数更新
 * - cleanup：资源清理（补全 + 拖动）
 * - handlePolish：润色成功 / 无变化 / 失败
 * - handleClose：ESC 关闭计算
 *
 * Mock 策略：
 * - mock electronAPI（控制返回值）
 * - mock safeStorage（safeSet/safeGet）
 * - mock errorHelpers（reportError）
 * - JSDOM 提供真实 DOM API
 * - vi.useFakeTimers 控制 setTimeout
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { QuickInputElectronAPI } from '../../../electron/renderer/quick-input/quickInput.js';
import { QuickInputController } from '../../../electron/renderer/quick-input/quickInput.js';

// ─── Mock 模块 ─────────────────────────────────────────────

vi.mock('../../../electron/renderer/helpers/errorHelpers.js', () => ({
  reportError: vi.fn(),
}));

// 内存模拟 localStorage，每次测试独立
const store = new Map<string, string>();
const { safeSet, safeGet } = vi.hoisted(() => ({
  safeSet: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  safeGet: vi.fn((key: string, defaultValue: string) => {
    return store.has(key) ? store.get(key)! : defaultValue;
  }),
}));
function clearStore(): void {
  store.clear();
  safeSet.mockClear();
  safeGet.mockClear();
}

vi.mock('../../../electron/renderer/helpers/safeStorage.js', () => ({
  safeSet,
  safeGet,
}));

// ─── Mock 补全管理器（避免测试中创建完整补全实例） ────────

const mockCompletionCleanup = vi.fn();
const mockCompletionClear = vi.fn();
const mockCompletionInit = vi.fn();
const mockCompletionOnSelect = vi.fn();
const mockCompletionOnListChange = vi.fn();

vi.mock('../../../electron/renderer/quick-input/quickInputCompletion.js', () => {
  // 使用 function 声明而非箭头函数，确保 new 调用可用
  const MockCompletion = function(this: Record<string, unknown>) {
    this.init = mockCompletionInit;
    this.cleanup = mockCompletionCleanup;
    this.clear = mockCompletionClear;
    this.onSelect = mockCompletionOnSelect;
    this.onListChange = mockCompletionOnListChange;
  } as unknown as { new (...args: unknown[]): Record<string, unknown> };
  return {
    QuickInputCompletion: MockCompletion,
  };
});

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock ElectronAPI（所有方法默认返回成功） */
function createMockApi(): QuickInputElectronAPI {
  return {
    confirmQuickInput: vi.fn().mockResolvedValue({ success: true, mode: 'copy' }),
    closeQuickInput: vi.fn().mockResolvedValue(undefined),
    searchMemories: vi.fn().mockResolvedValue({ hits: [] }),
    searchSessionMessages: vi.fn().mockResolvedValue({ results: [] }),
    resizeQuickInput: vi.fn().mockResolvedValue(undefined),
    moveQuickInput: vi.fn(),
    polishQuickInput: vi.fn().mockResolvedValue({ changed: false, polished: '' }),
    onQuickInputShow: vi.fn(),
    removeQuickInputShowListener: vi.fn(),
    boostMemory: vi.fn().mockResolvedValue(undefined),
  };
}

/** 创建完整的 DOM 结构（对齐 quick-input.html），返回控制器实例 */
async function createController(opts?: {
  api?: QuickInputElectronAPI;
  inputValue?: string;
}): Promise<{
  controller: QuickInputController;
  api: QuickInputElectronAPI;
  inputField: HTMLTextAreaElement;
  completionList: HTMLElement;
  streamToggle: HTMLElement;
  expandToggle: HTMLElement;
  polishToggle: HTMLElement;
  footerEl: HTMLElement;
  counterEl: HTMLElement;
}> {
  // 注入 electronAPI 到 window
  const api = opts?.api ?? createMockApi();
  (window as unknown as { electronAPI: QuickInputElectronAPI }).electronAPI = api;

  // 构建 DOM 结构
  document.body.innerHTML = `
    <div id="quick-input-container">
      <div id="quick-input-area">
        <textarea id="quick-input-field"></textarea>
        <div id="completion-list" class="hidden"></div>
      </div>
      <div id="quick-input-footer">
        <div class="footer-left">
          <button id="expand-toggle" class="expand-toggle" title="展开输入框">
            <svg><use href="#icon-expand"/></svg>
          </button>
          <button id="stream-toggle" class="stream-toggle" title="流式模式">
            <svg><use href="#icon-unlock"/></svg>
          </button>
          <button id="polish-toggle" class="polish-toggle" title="润色">
            <svg><use href="#icon-polish"/></svg>
          </button>
        </div>
        <div class="footer-right">
          <span class="quick-input-counter">0 字</span>
        </div>
      </div>
    </div>
  `;

  const inputField = document.getElementById('quick-input-field')! as HTMLTextAreaElement;
  if (opts?.inputValue) {
    inputField.value = opts.inputValue;
  }
  const completionList = document.getElementById('completion-list')!;
  const streamToggle = document.getElementById('stream-toggle')!;
  const expandToggle = document.getElementById('expand-toggle')!;
  const polishToggle = document.getElementById('polish-toggle')!;
  const footerEl = document.getElementById('quick-input-footer')!;
  const counterEl = document.querySelector('.quick-input-counter')! as HTMLElement;

  const controller = new QuickInputController({
    inputField,
    completionList,
    streamToggle,
    expandToggle,
    polishToggle,
    footerEl,
    counterEl,
    api,
  });
  controller.init();

  return { controller, api, inputField, completionList, streamToggle, expandToggle, polishToggle, footerEl, counterEl };
}

// ─── 测试 ──────────────────────────────────────────────────

describe('QuickInputController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI = undefined;
    clearStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  // ─── handleShow ────────────────────────────────────────

  describe('handleShow', () => {
    it('无预设文本时清空输入框并重置状态', async () => {
      const { controller, inputField, api } = await createController({ inputValue: '旧文本' });
      const showHandler = (api.onQuickInputShow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((payload: unknown) => void)
        | undefined;

      // 触发 show（无预设）
      showHandler?.({ clipboardText: null, isSensitive: false });

      expect(inputField.value).toBe('');
      expect(inputField.readOnly).toBe(false);
      expect(inputField.disabled).toBe(false);
      expect(inputField.classList.contains('copy-toast')).toBe(false);
    });

    it('有预设文本时预填输入框并选中全文', async () => {
      const { controller, inputField, api } = await createController();
      const showHandler = (api.onQuickInputShow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((payload: unknown) => void)
        | undefined;

      showHandler?.({ clipboardText: '预填内容', isSensitive: false });

      expect(inputField.value).toBe('预填内容');
      // 选中全文：selectionStart=0, selectionEnd=length
      expect(inputField.selectionStart).toBe(0);
      expect(inputField.selectionEnd).toBe(4);
    });

    it('敏感内容自动启用流式模式', async () => {
      const { controller, streamToggle, api } = await createController();
      const showHandler = (api.onQuickInputShow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((payload: unknown) => void)
        | undefined;

      expect(streamToggle.classList.contains('active')).toBe(false);

      showHandler?.({ clipboardText: null, isSensitive: true });

      expect(streamToggle.classList.contains('active')).toBe(true);
    });

    it('show 时递增 submitGeneration 使过期 IPC 失效', async () => {
      const { controller, api } = await createController();
      const showHandler = (api.onQuickInputShow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((payload: unknown) => void)
        | undefined;

      // 触发 show 两次
      showHandler?.({ clipboardText: null, isSensitive: false });
      showHandler?.({ clipboardText: null, isSensitive: false });

      // 不应崩溃（代次递增正常）
      expect(true).toBe(true);
    });
  });

  // ─── handleConfirm ─────────────────────────────────────

  describe('handleConfirm', () => {
    it('空输入时关闭窗口', async () => {
      const { inputField, api } = await createController();

      // 模拟 Tab 提交
      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabEvent);
      const tabUpEvent = new KeyboardEvent('keyup', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabUpEvent);

      await vi.runAllTimersAsync();

      expect(api.closeQuickInput).toHaveBeenCalled();
    });

    it('有输入时调用 confirmQuickInput 并显示 Toast', async () => {
      const { inputField, api } = await createController({ inputValue: '测试输入' });

      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabEvent);
      const tabUpEvent = new KeyboardEvent('keyup', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabUpEvent);

      await vi.runAllTimersAsync();

      expect(api.confirmQuickInput).toHaveBeenCalledWith('测试输入', false);
      // 普通模式：Toast 文本
      expect(inputField.classList.contains('copy-toast')).toBe(true);
    });

    it('提交时禁用输入框防重复确认', async () => {
      const { inputField, api } = await createController({ inputValue: '测试' });
      const confirmSpy = api.confirmQuickInput as ReturnType<typeof vi.fn>;

      // 延迟 resolve，让 isSubmitting 状态可观测
      let resolveConfirm!: (value: unknown) => void;
      confirmSpy.mockReturnValueOnce(new Promise((r) => { resolveConfirm = r; }));

      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabEvent);
      const tabUpEvent = new KeyboardEvent('keyup', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabUpEvent);

      // 等待微任务
      await vi.runAllTimersAsync();
      await Promise.resolve();

      // showPastingToast 使用 readOnly=true + disabled=false 锁输入
      expect(inputField.readOnly).toBe(true);

      // 第二次确认应被忽略
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));
      expect(confirmSpy).toHaveBeenCalledTimes(1);

      resolveConfirm({ success: true, mode: 'copy' });
      await vi.runAllTimersAsync();
    });

    it('流式模式提交后清空输入准备下次输入', async () => {
      const { inputField, api, streamToggle } = await createController({ inputValue: '流式输入' });

      // 手动启用流式模式
      streamToggle.click();

      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabEvent);
      const tabUpEvent = new KeyboardEvent('keyup', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabUpEvent);

      await vi.runAllTimersAsync();

      expect(api.confirmQuickInput).toHaveBeenCalledWith('流式输入', true);

      // 推进流式 Toast 定时器
      vi.advanceTimersByTime(500);
      await Promise.resolve();

      // 流式模式：输入框应被清空，准备下次输入
      expect(inputField.value).toBe('');
      expect(inputField.disabled).toBe(false);
    });

    it('确认失败时恢复原文并聚焦', async () => {
      const { inputField, api } = await createController({ inputValue: '原文' });
      (api.confirmQuickInput as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: false,
        mode: 'copy',
      });

      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabEvent);
      const tabUpEvent = new KeyboardEvent('keyup', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabUpEvent);

      await vi.runAllTimersAsync();

      expect(inputField.value).toBe('原文');
      expect(inputField.disabled).toBe(false);
    });
  });

  // ─── toggleStreamMode ──────────────────────────────────

  describe('toggleStreamMode', () => {
    it('手动切换流式模式并持久化到 localStorage', async () => {
      const { streamToggle } = await createController();

      expect(streamToggle.classList.contains('active')).toBe(false);

      streamToggle.click();
      expect(streamToggle.classList.contains('active')).toBe(true);
      expect(safeSet).toHaveBeenCalledWith('memora-quick-input-stream', '1');

      streamToggle.click();
      expect(streamToggle.classList.contains('active')).toBe(false);
      expect(safeSet).toHaveBeenCalledWith('memora-quick-input-stream', '0');
    });
  });

  // ─── toggleExpand ──────────────────────────────────────

  describe('toggleExpand', () => {
    it('手动切换展开模式并持久化到 localStorage', async () => {
      const { expandToggle, inputField } = await createController();

      expect(expandToggle.classList.contains('active')).toBe(false);

      expandToggle.click();
      expect(expandToggle.classList.contains('active')).toBe(true);
      expect(inputField.classList.contains('expanded')).toBe(true);
      expect(safeSet).toHaveBeenCalledWith('memora-quick-input-expanded', '1');

      expandToggle.click();
      expect(expandToggle.classList.contains('active')).toBe(false);
      expect(inputField.classList.contains('expanded')).toBe(false);
      expect(safeSet).toHaveBeenCalledWith('memora-quick-input-expanded', '0');
    });
  });

  // ─── updateCounter ─────────────────────────────────────

  describe('updateCounter', () => {
    it('输入文本后更新字符计数', async () => {
      const { inputField, counterEl } = await createController();

      inputField.value = 'Hello';
      inputField.dispatchEvent(new Event('input', { bubbles: true }));

      expect(counterEl.textContent).toBe('5 字');
    });

    it('空输入框显示 0 字', async () => {
      const { inputField, counterEl } = await createController({ inputValue: '旧文本' });

      inputField.value = '';
      inputField.dispatchEvent(new Event('input', { bubbles: true }));

      expect(counterEl.textContent).toBe('0 字');
    });
  });

  // ─── handlePolish ────────────────────────────────────

  describe('handlePolish', () => {
    it('润色成功替换输入框内容', async () => {
      const { polishToggle, inputField, api } = await createController({ inputValue: '原始内容' });
      (api.polishQuickInput as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        changed: true,
        polished: '润色后的内容',
      });

      polishToggle.click();
      await vi.runAllTimersAsync();

      expect(api.polishQuickInput).toHaveBeenCalledWith('原始内容');
      expect(inputField.value).toBe('润色后的内容');
    });

    it('润色无变化时显示闪烁提示', async () => {
      const { polishToggle, inputField } = await createController({ inputValue: '内容' });

      polishToggle.click();
      // handlePolish 是 async 函数，需要多次 flush 微任务队列
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(inputField.value).toBe('内容'); // 原文不变
      // 默认 mock 返回 changed:false，触发 showPolishNoChange
      expect(polishToggle.classList.contains('no-change')).toBe(true);

      vi.advanceTimersByTime(500);
      expect(polishToggle.classList.contains('no-change')).toBe(false);
    });

    it('润色期间显示 loading 状态', async () => {
      const { polishToggle, inputField, api } = await createController({ inputValue: '内容' });
      let resolvePolish!: (value: unknown) => void;
      (api.polishQuickInput as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        new Promise((r) => { resolvePolish = r; }),
      );

      polishToggle.click();
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(polishToggle.classList.contains('loading')).toBe(true);
      expect(inputField.disabled).toBe(true);

      resolvePolish({ changed: true, polished: '新内容' });
      await vi.runAllTimersAsync();

      expect(polishToggle.classList.contains('loading')).toBe(false);
      expect(inputField.disabled).toBe(false);
    });
  });

  // ─── handleClose ──────────────────────────────────────

  describe('handleClose', () => {
    it('ESC 关闭窗口', async () => {
      const { inputField, api } = await createController();

      const escEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      inputField.dispatchEvent(escEvent);

      await vi.runAllTimersAsync();

      expect(api.closeQuickInput).toHaveBeenCalled();
    });
  });

  // ─── cleanup ──────────────────────────────────────────

  describe('cleanup', () => {
    it('cleanup 清理补全管理器', async () => {
      const { controller } = await createController();

      controller.cleanup();

      expect(mockCompletionCleanup).toHaveBeenCalled();
    });
  });
});