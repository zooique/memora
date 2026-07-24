/**
 * InputInjector 测试 —— Phase 4 自动粘贴核心模块
 *
 * 覆盖范围：
 *   1. 降级模式：deps=null / previousWindow=null / 非文本剪贴板 / focus 失败 / paste 异常
 *   2. 成功路径：paste 成功返回 mode='paste'（koffi keybd_event 失败时降级到 nut-js keyboard）
 *   3. captureActiveWindow：排除浮窗自身 / nut-js 不可用
 *   4. 剪贴板恢复：失败/降级路径恢复原剪贴板；成功路径保留提交文本（契约对齐：下次唤起去重）
 *   5. suppressNextChange 调用次数：每次 writeText 都需调用
 *
 * 测试策略：
 *   - mock electron clipboard（availableFormats/readText/writeText）
 *   - mock koffi keybd_event 抛异常（强制降级到 nut-js keyboard，避免测试环境真发送 Ctrl+V）
 *   - 注入 mock NutJsDeps（getActiveWindow/keyboard/Key）
 *   - 不依赖真实 nut-js native 模块，不真的发送 Ctrl+V
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted 确保 mock 在 vi.mock factory 中可访问（vi.mock 会提升到文件顶部）
const { clipboardMock } = vi.hoisted(() => ({
  clipboardMock: {
    availableFormats: vi.fn<(formats: void) => string[]>(),
    readText: vi.fn<(text: void) => string>(),
    writeText: vi.fn<(text: string) => void>(),
  },
}));

// mock electron clipboard（InputInjector 直接 import electron 的 clipboard）
vi.mock('electron', () => ({
  clipboard: clipboardMock,
}));

// mock koffi FFI（默认 mock keybd_event 抛异常，强制降级到 nut-js keyboard，
// 避免测试环境真的发送 Ctrl+V 按键）
vi.mock('koffi', () => {
  const mockKeybdEvent = vi.fn(() => { throw new Error('mocked: keybd_event disabled in test'); });
  return {
    load: vi.fn(() => ({
      func: vi.fn((definition: string) => {
        if (definition.includes('keybd_event')) return mockKeybdEvent;
        return vi.fn();
      }),
    })),
  };
});

import { InputInjector, type NutJsDeps, type ActiveWindow } from '../../electron/inputInjector.js';

/** 创建 mock ActiveWindow（含 HWND 用于 ADR-SP-018 绕过 nut-js 标题编码 bug） */
function createMockWindow(title: string, focusShouldThrow = false, hwnd?: number): ActiveWindow {
  return {
    title: Promise.resolve(title),
    region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
    focus: focusShouldThrow
      ? () => Promise.reject(new Error('focus failed'))
      : () => Promise.resolve(),
    // HWND 用于 captureActiveWindow 排除浮窗自身（ADR-SP-018：绕过 nut-js 标题编码 bug）
    hwnd: hwnd ?? Math.floor(Math.random() * 100000),
  };
}

/** 创建 mock NutJsDeps */
function createMockDeps(getActiveWindowResult: ActiveWindow | null = null): NutJsDeps {
  return {
    getActiveWindow: getActiveWindowResult
      ? () => Promise.resolve(getActiveWindowResult)
      : () => Promise.reject(new Error('getActiveWindow failed')),
    keyboard: {
      pressKey: vi.fn(() => Promise.resolve()),
      releaseKey: vi.fn(() => Promise.resolve()),
    },
    Key: {
      LeftControl: 'LeftControl' as unknown,
      V: 'V' as unknown,
    },
  };
}

/** 创建 suppressNextChange mock（用于断言调用次数） */
function createSuppressMock() {
  return vi.fn<() => void>();
}

describe('InputInjector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认剪贴板为纯文本格式 + 有原内容
    clipboardMock.availableFormats.mockReturnValue(['text/plain']);
    clipboardMock.readText.mockReturnValue('原剪贴板内容');
    clipboardMock.writeText.mockImplementation(() => {});
  });

  describe('paste 降级模式', () => {
    it('deps=null 时返回 no_deps 降级', async () => {
      const injector = new InputInjector(null);
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();

      const result = await injector.paste('test', null, hideFloat, suppress);

      expect(result.success).toBe(false);
      expect(result.mode).toBe('copy');
      expect(result.reason).toBe('no_deps');
      // 降级时不应该操作剪贴板或隐藏浮窗
      expect(clipboardMock.writeText).not.toHaveBeenCalled();
      expect(hideFloat).not.toHaveBeenCalled();
    });

    it('previousWindow=null 时返回 no_previous_window 降级', async () => {
      const injector = new InputInjector(createMockDeps());
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();

      const result = await injector.paste('test', null, hideFloat, suppress);

      expect(result.success).toBe(false);
      expect(result.mode).toBe('copy');
      expect(result.reason).toBe('no_previous_window');
      expect(clipboardMock.writeText).not.toHaveBeenCalled();
    });

    it('非文本剪贴板（图片）时返回 non_text_clipboard 降级', async () => {
      const injector = new InputInjector(createMockDeps());
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本');
      clipboardMock.availableFormats.mockReturnValue(['image/png']);  // 图片格式

      const result = await injector.paste('test', window, hideFloat, suppress);

      expect(result.success).toBe(false);
      expect(result.mode).toBe('copy');
      expect(result.reason).toBe('non_text_clipboard');
      expect(clipboardMock.writeText).not.toHaveBeenCalled();
    });

    it('空剪贴板格式时降级', async () => {
      const injector = new InputInjector(createMockDeps());
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本');
      clipboardMock.availableFormats.mockReturnValue([]);  // 空格式

      const result = await injector.paste('test', window, hideFloat, suppress);

      expect(result.reason).toBe('non_text_clipboard');
    });

    it('focus 失败时返回 focus_failed 降级', async () => {
      const injector = new InputInjector(createMockDeps());
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本', true);  // focus 抛异常

      const result = await injector.paste('test', window, hideFloat, suppress);

      expect(result.success).toBe(false);
      expect(result.mode).toBe('copy');
      expect(result.reason).toBe('focus_failed');
      // focus 失败但仍应恢复剪贴板（finally 块）
      expect(clipboardMock.writeText).toHaveBeenCalledWith('原剪贴板内容');
    });
  });

  describe('paste 成功路径', () => {
    it('成功粘贴返回 mode=paste（koffi keybd_event 失败降级到 nut-js keyboard）', async () => {
      const deps = createMockDeps();
      const injector = new InputInjector(deps);
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本');

      const result = await injector.paste('补全文本', window, hideFloat, suppress);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('paste');
      // 验证 hideFloat 被调用（保留接口兼容，当前为 no-op）
      expect(hideFloat).toHaveBeenCalledTimes(1);
      // 验证 keyboard 降级：koffi keybd_event 失败后 fallback 到 nut-js keyboard（Ctrl+V press+release）
      expect(deps.keyboard.pressKey).toHaveBeenCalledTimes(1);
      expect(deps.keyboard.releaseKey).toHaveBeenCalledTimes(1);
    });

    it('成功粘贴时 suppressNextChange 调用 1 次（仅写入目标，不恢复）', async () => {
      const injector = new InputInjector(createMockDeps());
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本');

      await injector.paste('test', window, hideFloat, suppress);

      // 成功路径仅在写入目标文本时抑制一次；不恢复剪贴板（契约对齐：剪贴板停留为提交文本）
      expect(suppress).toHaveBeenCalledTimes(1);
      expect(clipboardMock.writeText).toHaveBeenCalledTimes(1);  // 仅写入目标
    });

    it('成功粘贴时剪贴板保留为提交文本（不恢复为原内容）', async () => {
      const injector = new InputInjector(createMockDeps());
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本');
      clipboardMock.readText.mockReturnValue('用户原复制的文本');

      await injector.paste('补全内容', window, hideFloat, suppress);

      // 写入目标文本，且不恢复原内容（供下次唤起时剪贴板==最近提交→去重显历史）
      expect(clipboardMock.writeText).toHaveBeenNthCalledWith(1, '补全内容');
      expect(clipboardMock.writeText).not.toHaveBeenCalledWith('用户原复制的文本');
      expect(clipboardMock.readText()).toBe('用户原复制的文本'); // 原内容仍在原变量，但剪贴板未恢复
    });

    it('回归：编辑后提交（原剪贴板 P + 提交 P+extra）剪贴板应停留为 P+extra', async () => {
      // 复现用户 bug 场景：清空→黏贴 P→补字→提交 P+extra。
      // 修复前 finally 会把剪贴板恢复为 P，导致①目标收到 P ②下次唤起去重失败不显历史。
      // 修复后成功路径不恢复，剪贴板停在被提交的 P+extra。
      const injector = new InputInjector(createMockDeps());
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本');
      clipboardMock.readText.mockReturnValue('P'); // 用户最初复制的内容

      const result = await injector.paste('P+extra', window, hideFloat, suppress);

      expect(result.success).toBe(true);
      // 剪贴板最终值 == 被提交文本（目标应用读到 P+extra；下次唤起剪贴板==最近提交→去重显历史）
      expect(clipboardMock.writeText).toHaveBeenLastCalledWith('P+extra');
      expect(clipboardMock.writeText).not.toHaveBeenCalledWith('P');
    });
  });

  describe('paste 异常处理', () => {
    it('keyboard 异常时降级 + 恢复剪贴板', async () => {
      const deps = createMockDeps();
      // pressKey 抛异常模拟键盘模拟失败
      deps.keyboard.pressKey.mockRejectedValueOnce(new Error('keyboard error'));
      const injector = new InputInjector(deps);
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本');

      const result = await injector.paste('test', window, hideFloat, suppress);

      expect(result.success).toBe(false);
      expect(result.mode).toBe('copy');
      expect(result.reason).toBe('paste_failed');
      // finally 块应恢复剪贴板
      expect(clipboardMock.writeText).toHaveBeenCalledWith('原剪贴板内容');
      expect(suppress).toHaveBeenCalledTimes(2);  // 写入 + 恢复都调用了
    });
  });

  describe('captureActiveWindow', () => {
    it('deps=null 时返回 null', async () => {
      const injector = new InputInjector(null);
      const result = await injector.captureActiveWindow();
      expect(result).toBeNull();
    });

    it('getActiveWindow 失败时返回 null（不抛异常）', async () => {
      const injector = new InputInjector(createMockDeps(null));  // getActiveWindow reject
      const result = await injector.captureActiveWindow();
      expect(result).toBeNull();
    });

    it('成功捕获时返回窗口', async () => {
      const window = createMockWindow('记事本');
      const injector = new InputInjector(createMockDeps(window));
      const result = await injector.captureActiveWindow();
      expect(result).not.toBeNull();
      expect(await result?.title).toBe('记事本');
    });

    it('排除浮窗自身（HWND 匹配时返回 null）', async () => {
      const floatHwnd = 12345;
      const window = createMockWindow('快速输入', false, floatHwnd);  // 浮窗的 HWND
      const injector = new InputInjector(createMockDeps(window));
      const result = await injector.captureActiveWindow(floatHwnd);
      expect(result).toBeNull();
    });

    it('不排除 HWND 不同的窗口', async () => {
      const floatHwnd = 12345;
      const window = createMockWindow('记事本', false, 99999);  // 不同 HWND
      const injector = new InputInjector(createMockDeps(window));
      const result = await injector.captureActiveWindow(floatHwnd);
      expect(result).not.toBeNull();
    });
  });
});
