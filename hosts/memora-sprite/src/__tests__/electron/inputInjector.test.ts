/**
 * InputInjector 测试 —— Phase 4 自动粘贴核心模块
 *
 * 覆盖范围：
 *   1. 降级模式：deps=null / previousWindow=null / 非文本剪贴板 / focus 失败 / paste 异常
 *   2. 成功路径：paste 成功返回 mode='paste' + appName
 *   3. captureActiveWindow：排除浮窗自身 / nut-js 不可用
 *   4. 剪贴板恢复：无论成功失败都恢复原剪贴板内容
 *   5. suppressNextChange 调用次数：每次 writeText 都需调用
 *
 * 测试策略：
 *   - mock electron clipboard（availableFormats/readText/writeText）
 *   - 注入 mock NutJsDeps（getActiveWindow/keyboard/Key）
 *   - 不依赖真实 nut-js native 模块
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

import { InputInjector, type NutJsDeps, type ActiveWindow } from '../../electron/inputInjector.js';

/** 创建 mock ActiveWindow */
function createMockWindow(title: string, focusShouldThrow = false): ActiveWindow {
  return {
    title: Promise.resolve(title),
    region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
    focus: focusShouldThrow
      ? () => Promise.reject(new Error('focus failed'))
      : () => Promise.resolve(),
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
    it('成功粘贴返回 mode=paste + appName', async () => {
      const deps = createMockDeps();
      const injector = new InputInjector(deps);
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本');

      const result = await injector.paste('补全文本', window, hideFloat, suppress);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('paste');
      expect(result.appName).toBe('记事本');
      // 验证隐藏浮窗被调用（排雷修正雷 1.2：在恢复焦点之前）
      expect(hideFloat).toHaveBeenCalledTimes(1);
      // 验证 keyboard 操作：Ctrl+V（press+release）
      expect(deps.keyboard.pressKey).toHaveBeenCalledTimes(1);
      expect(deps.keyboard.releaseKey).toHaveBeenCalledTimes(1);
    });

    it('成功粘贴时 suppressNextChange 调用 2 次（写入 + 恢复）', async () => {
      const injector = new InputInjector(createMockDeps());
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本');

      await injector.paste('test', window, hideFloat, suppress);

      // 排雷修正雷 1.1：一次性抑制，每次 writeText 都需调用
      expect(suppress).toHaveBeenCalledTimes(2);
      expect(clipboardMock.writeText).toHaveBeenCalledTimes(2);  // 写入目标 + 恢复原内容
    });

    it('成功粘贴时剪贴板恢复为原内容', async () => {
      const injector = new InputInjector(createMockDeps());
      const suppress = createSuppressMock();
      const hideFloat = vi.fn();
      const window = createMockWindow('记事本');
      clipboardMock.readText.mockReturnValue('用户原复制的文本');

      await injector.paste('补全内容', window, hideFloat, suppress);

      // 第一次写入目标文本，第二次恢复原内容
      expect(clipboardMock.writeText).toHaveBeenNthCalledWith(1, '补全内容');
      expect(clipboardMock.writeText).toHaveBeenNthCalledWith(2, '用户原复制的文本');
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

    it('排除浮窗自身（标题匹配时返回 null）', async () => {
      const window = createMockWindow('快速输入');
      const injector = new InputInjector(createMockDeps(window));
      const result = await injector.captureActiveWindow('快速输入');
      expect(result).toBeNull();
    });

    it('不排除非浮窗标题', async () => {
      const window = createMockWindow('记事本');
      const injector = new InputInjector(createMockDeps(window));
      const result = await injector.captureActiveWindow('快速输入');
      expect(result).not.toBeNull();
    });
  });

  describe('getWindowTitle', () => {
    it('window=null 时返回 undefined', async () => {
      const injector = new InputInjector(null);
      const result = await injector.getWindowTitle(null);
      expect(result).toBeUndefined();
    });

    it('成功返回标题', async () => {
      const injector = new InputInjector(null);
      const window = createMockWindow('VSCode');
      const result = await injector.getWindowTitle(window);
      expect(result).toBe('VSCode');
    });

    it('title getter 异常时返回 undefined', async () => {
      const injector = new InputInjector(null);
      const window: ActiveWindow = {
        title: Promise.reject(new Error('title error')),
        region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
        focus: () => Promise.resolve(),
      };
      const result = await injector.getWindowTitle(window);
      expect(result).toBeUndefined();
    });
  });
});
