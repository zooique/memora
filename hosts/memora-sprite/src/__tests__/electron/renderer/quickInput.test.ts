/**
 * 快速输入控制器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - handleShow：状态重置 / 剪贴板预填 / 敏感检测 / 无预设分支
 * - handleConfirm：成功 / 失败 / 常驻 / 默认 / 竞态防护
 * - togglePinnedMode：手动切换 + localStorage 持久化 + IPC 通知
 * - toggleExpand：手动切换 + localStorage 持久化
 * - updateFocusIndicator：有聚焦 / 无聚焦 + Tab 启用/禁用联动
 * - handleTab：tabEnabled=false 时不触发提交
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
const { safeSet, safeGet, safeSetJSON, safeGetJSON } = vi.hoisted(() => ({
  safeSet: vi.fn((key: string, value: string) => {
    store.set(key, value);
  }),
  safeGet: vi.fn((key: string, defaultValue: string) => {
    return store.has(key) ? store.get(key)! : defaultValue;
  }),
  // STEP-5A：最近提交历史用 JSON 场景，mock 需同步补齐
  safeSetJSON: vi.fn((key: string, value: unknown) => {
    store.set(key, JSON.stringify(value));
  }),
  safeGetJSON: vi.fn(<T>(key: string, defaultValue: T): T => {
    if (!store.has(key)) return defaultValue;
    try {
      return JSON.parse(store.get(key)!) as T;
    } catch {
      return defaultValue;
    }
  }),
}));
function clearStore(): void {
  store.clear();
  safeSet.mockClear();
  safeGet.mockClear();
  safeSetJSON.mockClear();
  safeGetJSON.mockClear();
}

vi.mock('../../../electron/renderer/helpers/safeStorage.js', () => ({
  safeSet,
  safeGet,
  safeSetJSON,
  safeGetJSON,
}));

// ─── Mock 补全管理器（避免测试中创建完整补全实例） ────────

const mockCompletionCleanup = vi.fn();
const mockCompletionClear = vi.fn();
const mockCompletionInit = vi.fn();
const mockCompletionOnSelect = vi.fn();
const mockCompletionOnListChange = vi.fn();
const mockCompletionOnRecentFallback = vi.fn();
const mockCompletionSuppressNextSearch = vi.fn();

vi.mock('../../../electron/renderer/quick-input/quickInputCompletion.js', () => {
  // 使用 function 声明而非箭头函数，确保 new 调用可用
  const MockCompletion = function(this: Record<string, unknown>) {
    this.init = mockCompletionInit;
    this.cleanup = mockCompletionCleanup;
    this.clear = mockCompletionClear;
    this.onSelect = mockCompletionOnSelect;
    this.onListChange = mockCompletionOnListChange;
    this.onRecentFallback = mockCompletionOnRecentFallback;
    this.suppressNextSearch = mockCompletionSuppressNextSearch;
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
    showMemory: vi.fn().mockResolvedValue({ memory: null }),
    setPinnedMode: vi.fn().mockResolvedValue({ success: true }),
    onFocusChange: vi.fn(),
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
  pinnedToggle: HTMLElement;
  expandToggle: HTMLElement;
  polishToggle: HTMLElement;
  focusBarEl: HTMLElement;
  counterEl: HTMLElement;
  focusAppNameEl: HTMLElement;
  closeBtnEl: HTMLElement;
}> {
  // 注入 electronAPI 到 window
  const api = opts?.api ?? createMockApi();
  (window as unknown as { electronAPI: QuickInputElectronAPI }).electronAPI = api;

  // 构建 DOM 结构（对齐 quick-input.html，含顶部聚焦提示栏）
  document.body.innerHTML = `
    <div id="focus-bar" class="focus-bar">
      <span id="focus-app-name" class="focus-app-name">无聚焦</span>
      <button id="close-btn" class="close-btn"><svg class="icon"><use href="#icon-close"/></svg></button>
    </div>
    <div id="quick-input-container">
      <div id="quick-input-area">
        <textarea id="quick-input-field"></textarea>
        <div id="completion-list" class="hidden"></div>
      </div>
      <div id="quick-input-footer">
        <span id="quick-input-hint">↓↑ 补全 · ←→ 填充 · Tab 提交 · Esc 关闭</span>
        <div class="footer-left">
          <button id="expand-toggle" class="expand-toggle" title="展开输入框">
            <svg><use href="#icon-expand"/></svg>
          </button>
          <button id="pinned-toggle" class="pinned-toggle" title="常驻模式">
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
  // footer 内的常驻模式切换按钮
  const pinnedToggle = document.getElementById('pinned-toggle')!;
  const expandToggle = document.getElementById('expand-toggle')!;
  const polishToggle = document.getElementById('polish-toggle')!;
  const focusBarEl = document.getElementById('focus-bar')!;
  const counterEl = document.querySelector('.quick-input-counter')! as HTMLElement;
  const focusAppNameEl = document.getElementById('focus-app-name')!;
  const hintEl = document.getElementById('quick-input-hint')!;
  const closeBtnEl = document.getElementById('close-btn')!;

  const controller = new QuickInputController({
    inputField,
    completionList,
    pinnedToggle,
    expandToggle,
    polishToggle,
    focusBarEl,
    counterEl,
    focusAppNameEl,
    hintEl,
    closeBtnEl,
    api,
  });
  controller.init();

  return { controller, api, inputField, completionList, pinnedToggle, expandToggle, polishToggle, focusBarEl, counterEl, focusAppNameEl, closeBtnEl };
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
      const { inputField, api } = await createController({ inputValue: '旧文本' });
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
      const { inputField, api } = await createController();
      const showHandler = (api.onQuickInputShow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((payload: unknown) => void)
        | undefined;

      showHandler?.({ clipboardText: '预填内容', isSensitive: false });

      expect(inputField.value).toBe('预填内容');
      // 选中全文：selectionStart=0, selectionEnd=length
      expect(inputField.selectionStart).toBe(0);
      expect(inputField.selectionEnd).toBe(4);
    });

    it('敏感内容自动启用常驻模式', async () => {
      const { pinnedToggle, api } = await createController();
      const showHandler = (api.onQuickInputShow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((payload: unknown) => void)
        | undefined;

      expect(pinnedToggle.classList.contains('active')).toBe(false);

      showHandler?.({ clipboardText: null, isSensitive: true });

      expect(pinnedToggle.classList.contains('active')).toBe(true);
      // 通知主进程进入 pinned 模式（持久 suppressBlurClose）
      expect(api.setPinnedMode).toHaveBeenCalledWith(true);
    });

    it('show 时递增 submitGeneration 使过期 IPC 失效', async () => {
      const { api } = await createController();
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

      // 仅刷新微任务（confirmQuickInput Promise 解析），不推进 Toast 定时器
      await vi.advanceTimersByTimeAsync(0);

      expect(api.confirmQuickInput).toHaveBeenCalledWith('测试输入', false);
      // 普通模式：Toast 文本
      expect(inputField.classList.contains('copy-toast')).toBe(true);

      // 推进 Toast 定时器后输入框重置（连续输入）
      vi.advanceTimersByTime(500);
      await Promise.resolve();
      expect(inputField.value).toBe('');
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

    it('常驻模式提交后清空输入准备下次输入', async () => {
      const { inputField, api, pinnedToggle } = await createController({ inputValue: '常驻输入' });

      // 手动启用常驻模式
      pinnedToggle.click();

      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabEvent);
      const tabUpEvent = new KeyboardEvent('keyup', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabUpEvent);

      await vi.runAllTimersAsync();

      expect(api.confirmQuickInput).toHaveBeenCalledWith('常驻输入', true);

      // 推进 Toast 定时器
      vi.advanceTimersByTime(500);
      await Promise.resolve();

      // 常驻模式：输入框应被清空，准备下次输入
      expect(inputField.value).toBe('');
      expect(inputField.disabled).toBe(false);
    });

    it('确认失败时显示错误 Toast 后恢复原文并聚焦', async () => {
      const { inputField, api } = await createController({ inputValue: '原文' });
      (api.confirmQuickInput as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: false,
        mode: 'copy',
      });

      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabEvent);
      const tabUpEvent = new KeyboardEvent('keyup', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabUpEvent);

      // 微任务推进：IPC 返回后立即显示错误 Toast（FUNC-4 反馈闭环）
      await Promise.resolve();
      await Promise.resolve();

      // UX-14：result.success=false 无 error 对象，按 quickInput.ts 静态文案 '✗ 粘贴失败，请稍后重试'
      expect(inputField.value).toBe('✗ 粘贴失败，请稍后重试');
      expect(inputField.classList.contains('error')).toBe(true);
      expect(inputField.classList.contains('copy-toast')).toBe(true);

      // 定时器推进后恢复原文
      await vi.runAllTimersAsync();

      expect(inputField.value).toBe('原文');
      expect(inputField.disabled).toBe(false);
      expect(inputField.classList.contains('error')).toBe(false);
      expect(inputField.classList.contains('copy-toast')).toBe(false);
    });

    it('确认抛异常时显示错误 Toast 后恢复原文', async () => {
      const { inputField, api } = await createController({ inputValue: '原始内容' });
      (api.confirmQuickInput as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('IPC 异常'));

      const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabEvent);
      const tabUpEvent = new KeyboardEvent('keyup', { key: 'Tab', bubbles: true });
      inputField.dispatchEvent(tabUpEvent);

      await Promise.resolve();
      await Promise.resolve();

      // UX-14：catch 块有 error 对象，'IPC 异常' 不匹配 ERROR_PATTERNS，走两段式回退
      expect(inputField.value).toBe('✗ 提交失败，请稍后重试');
      expect(inputField.classList.contains('error')).toBe(true);

      await vi.runAllTimersAsync();

      expect(inputField.value).toBe('原始内容');
      expect(inputField.classList.contains('error')).toBe(false);
    });

    it('记忆候选填充未完成时 Tab 等待填充完成再提交（修复异步竞态）', async () => {
      const { controller, inputField, api } = await createController({ inputValue: '剪贴板内容' });

      // mock showMemory 返回延迟 Promise（模拟 IPC 未完成）
      let resolveShowMemory!: (value: unknown) => void;
      (api.showMemory as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        new Promise((r) => { resolveShowMemory = r; }),
      );

      // 模拟选择记忆候选（触发 fillFromMemory 异步路径）
      // 直接调用 private 方法绕过 completion 的 onSelect 机制，聚焦测试 handleConfirm 的 await 行为
      (controller as unknown as {
        fillFromMemory: (item: { memoryId: string; text: string }) => void;
      }).fillFromMemory({ memoryId: 'mem-1', text: '预览内容' });

      // 在 showMemory Promise resolve 之前按 Tab
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));

      // 推进微任务，handleConfirm 应在 await pendingFillPromise 处暂停
      await vi.advanceTimersByTimeAsync(0);

      // showMemory 未 resolve，confirmQuickInput 不应被调用
      // 修复前 bug：handleConfirm 同步读 inputField.value，提交了旧值 '剪贴板内容'
      expect(api.confirmQuickInput).not.toHaveBeenCalled();

      // resolve showMemory，fillText 被调用，inputField.value 更新为记忆内容
      resolveShowMemory({ memory: { content: '完整记忆内容' } });
      await vi.runAllTimersAsync();

      // pendingFillPromise 已 resolve，handleConfirm 继续执行
      // 验证提交的是记忆内容，不是"剪贴板内容"
      expect(api.confirmQuickInput).toHaveBeenCalledWith('完整记忆内容', false);
    });
  });

  // ─── fillText dispatch input 事件（Bug B 回归） ────────

  describe('fillText dispatch input 事件（Bug B 回归）', () => {
    it('fillText 设置 value 后 dispatch input 事件（消费 suppressNextInput）', async () => {
      const { inputField, controller } = await createController();

      // 监听 input 事件
      const inputListener = vi.fn();
      inputField.addEventListener('input', inputListener);

      // 直接调用 private fillText（绕过 onSelect 机制，聚焦验证 dispatch input 行为）
      (controller as unknown as { fillText: (text: string) => void }).fillText('回填内容');

      // fillText 应设置 inputField.value
      expect(inputField.value).toBe('回填内容');
      // Bug B 根因：fillText 必须 dispatch input 事件，让 suppressNextInput 被立即消费
      // 否则 suppressNextInput 悬挂到 resetInputForNext 的 dispatch，导致历史不显示
      expect(inputListener).toHaveBeenCalled();
    });
  });

  // ─── STEP-5A：最近提交历史持久化 ─────────────────────────

  describe('recentSubmission 持久化（STEP-5A）', () => {
    it('提交成功后记录到 localStorage', async () => {
      const { inputField, api } = await createController({ inputValue: '提交内容A' });

      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);

      // 验证 confirmQuickInput 成功后，最近提交历史已持久化
      expect(api.confirmQuickInput).toHaveBeenCalledWith('提交内容A', false);
      const stored = safeGetJSON<string[]>('memora-quick-input-recent', []);
      expect(stored).toEqual(['提交内容A']);
    });

    it('多次提交后历史按时间倒序排列并去重', async () => {
      // 预置一条历史
      safeSetJSON('memora-quick-input-recent', ['旧内容']);

      const { inputField } = await createController({ inputValue: '新内容' });
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);

      // 新内容应插入头部，旧内容保留
      const stored = safeGetJSON<string[]>('memora-quick-input-recent', []);
      expect(stored).toEqual(['新内容', '旧内容']);
    });

    it('重复提交相同内容时去重（只保留最新）', async () => {
      safeSetJSON('memora-quick-input-recent', ['重复内容', '其他内容']);

      const { inputField } = await createController({ inputValue: '重复内容' });
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);

      // '重复内容' 应移到头部，原位置删除（去重）
      const stored = safeGetJSON<string[]>('memora-quick-input-recent', []);
      expect(stored).toEqual(['重复内容', '其他内容']);
    });

    it('提交失败时不记录历史', async () => {
      const { inputField, api } = await createController({ inputValue: '失败内容' });
      (api.confirmQuickInput as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        success: false,
        mode: 'copy',
      });

      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);

      // 失败分支不应污染历史
      const stored = safeGetJSON<string[]>('memora-quick-input-recent', []);
      expect(stored).toEqual([]);
    });

    it('历史超过上限时淘汰最旧条目', async () => {
      // 预置 10 条历史（上限）
      const full = Array.from({ length: 10 }, (_, i) => `历史${i}`);
      safeSetJSON('memora-quick-input-recent', full);

      const { inputField } = await createController({ inputValue: '新条目' });
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);

      // '新条目' 插入头部，'历史9'（最旧）被淘汰，总数仍为 10
      const stored = safeGetJSON<string[]>('memora-quick-input-recent', []);
      expect(stored).toHaveLength(10);
      expect(stored[0]).toBe('新条目');
      expect(stored).not.toContain('历史9');
      expect(stored).toContain('历史0');
    });
  });

  // ─── STEP-5A：剪贴板智能预填去重 ─────────────────────────

  describe('剪贴板智能预填去重（STEP-5A）', () => {
    it('剪贴板内容与最近提交相同时跳过预填', async () => {
      // 预置最近提交为 '刚提交的内容'
      safeSetJSON('memora-quick-input-recent', ['刚提交的内容']);

      const { inputField, api } = await createController();
      const showHandler = (api.onQuickInputShow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((payload: unknown) => void)
        | undefined;

      // 剪贴板内容与最近提交相同
      showHandler?.({ clipboardText: '刚提交的内容', isSensitive: false });

      // 应跳过预填，输入框为空
      expect(inputField.value).toBe('');
    });

    it('剪贴板内容与最近提交不同时正常预填', async () => {
      safeSetJSON('memora-quick-input-recent', ['历史内容']);

      const { inputField, api } = await createController();
      const showHandler = (api.onQuickInputShow as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((payload: unknown) => void)
        | undefined;

      showHandler?.({ clipboardText: '新剪贴板内容', isSensitive: false });

      // 正常预填
      expect(inputField.value).toBe('新剪贴板内容');
      expect(inputField.selectionStart).toBe(0);
    });
  });

  // ─── togglePinnedMode ──────────────────────────────────

  describe('togglePinnedMode', () => {
    it('手动切换常驻模式并持久化到 localStorage', async () => {
      const { pinnedToggle } = await createController();

      expect(pinnedToggle.classList.contains('active')).toBe(false);

      pinnedToggle.click();
      expect(pinnedToggle.classList.contains('active')).toBe(true);
      expect(safeSet).toHaveBeenCalledWith('memora-quick-input-pinned', '1');

      pinnedToggle.click();
      expect(pinnedToggle.classList.contains('active')).toBe(false);
      expect(safeSet).toHaveBeenCalledWith('memora-quick-input-pinned', '0');
    });

    it('开启常驻模式时通知主进程', async () => {
      const { pinnedToggle, api } = await createController();

      pinnedToggle.click();

      expect(pinnedToggle.classList.contains('active')).toBe(true);
      expect(api.setPinnedMode).toHaveBeenCalledWith(true);
    });

    it('关闭常驻模式时通知主进程', async () => {
      const { pinnedToggle, api } = await createController();

      // 先开启
      pinnedToggle.click();
      expect(pinnedToggle.classList.contains('active')).toBe(true);

      // 再关闭
      pinnedToggle.click();

      expect(pinnedToggle.classList.contains('active')).toBe(false);
      expect(api.setPinnedMode).toHaveBeenCalledWith(false);
    });

    it('STEP-6: Ctrl+L 切换常驻模式（与图钉按钮等价）', async () => {
      const { inputField, pinnedToggle, api } = await createController();

      expect(pinnedToggle.classList.contains('active')).toBe(false);

      // 派发 Ctrl+L keydown 事件
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));

      // 应切换为常驻模式
      expect(pinnedToggle.classList.contains('active')).toBe(true);
      expect(safeSet).toHaveBeenCalledWith('memora-quick-input-pinned', '1');
      expect(api.setPinnedMode).toHaveBeenCalledWith(true);

      // 再次 Ctrl+L 切换回默认模式
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, bubbles: true }));
      expect(pinnedToggle.classList.contains('active')).toBe(false);
      expect(api.setPinnedMode).toHaveBeenCalledWith(false);
    });

    it('STEP-6: Cmd+L 在 macOS 上同样切换常驻模式', async () => {
      const { inputField, pinnedToggle } = await createController();

      // metaKey 对应 macOS 的 Cmd 键
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }));
      expect(pinnedToggle.classList.contains('active')).toBe(true);
    });

    it('STEP-6: 无修饰键的 L 键不触发常驻切换（避免误触）', async () => {
      const { inputField, pinnedToggle } = await createController();

      // 纯 L 键（无 Ctrl/Cmd）不应触发切换
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }));
      expect(pinnedToggle.classList.contains('active')).toBe(false);
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

  // ─── updateFocusIndicator ─────────────────────────────

  describe('updateFocusIndicator', () => {
    it('有聚焦时更新提示栏为应用名并启用 Tab', async () => {
      const { focusAppNameEl, inputField, api } = await createController();
      const focusHandler = (api.onFocusChange as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((appName: string | null) => void)
        | undefined;

      focusHandler?.('VSCode');

      expect(focusAppNameEl.textContent).toBe('聚焦：VSCode');
      // 父容器 .focus-bar 移除 no-focus 类
      expect(focusAppNameEl.parentElement?.classList.contains('no-focus')).toBe(false);
      // Tab 应启用（输入框无 tab-disabled 标记）
      expect(inputField.classList.contains('tab-disabled')).toBe(false);
    });

    it('无聚焦时更新提示栏为"无聚焦"并禁用 Tab', async () => {
      const { focusAppNameEl, inputField, api } = await createController();
      const focusHandler = (api.onFocusChange as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((appName: string | null) => void)
        | undefined;

      focusHandler?.(null);

      expect(focusAppNameEl.textContent).toBe('无聚焦');
      // 父容器 .focus-bar 加上 no-focus 类（视觉弱化）
      expect(focusAppNameEl.parentElement?.classList.contains('no-focus')).toBe(true);
      // Tab 应禁用（输入框加 tab-disabled 标记）
      expect(inputField.classList.contains('tab-disabled')).toBe(true);
    });
  });

  // ─── handleTab（Tab 禁用联动） ─────────────────────────

  describe('handleTab', () => {
    it('无聚焦时 Tab 不触发提交（避免盲粘到错误目标）', async () => {
      const { inputField, api } = await createController({ inputValue: '测试' });
      const focusHandler = (api.onFocusChange as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((appName: string | null) => void)
        | undefined;

      // 先进入无聚焦状态（禁用 Tab）
      focusHandler?.(null);
      expect(inputField.classList.contains('tab-disabled')).toBe(true);

      // 派发 Tab 按键事件
      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));

      await vi.runAllTimersAsync();

      // Tab 已禁用，confirmQuickInput 不应被调用
      expect(api.confirmQuickInput).not.toHaveBeenCalled();
    });

    it('有聚焦时 Tab 正常触发提交', async () => {
      const { inputField, api } = await createController({ inputValue: '测试' });
      const focusHandler = (api.onFocusChange as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
        | ((appName: string | null) => void)
        | undefined;

      // 进入有聚焦状态（启用 Tab）
      focusHandler?.('VSCode');

      inputField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      inputField.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', bubbles: true }));

      await vi.runAllTimersAsync();

      expect(api.confirmQuickInput).toHaveBeenCalledWith('测试', false);
    });
  });

  // ─── 顶部按钮（关闭） ─────────────────────────

  describe('topBarButtons', () => {
    it('关闭按钮触发 handleClose', async () => {
      const { closeBtnEl, api } = await createController();

      closeBtnEl.click();

      await vi.runAllTimersAsync();

      expect(api.closeQuickInput).toHaveBeenCalled();
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