/**
 * PasteCoordinator 测试 —— 自动粘贴协调器
 *
 * 覆盖范围：
 *   1. capturePreviousWindow：懒创建 InputInjector + 排除浮窗自身 + 保持上次窗口
 *   2. attemptPaste：三重条件降级（未启用/未注入 suppressNextChange/InputInjector 不可用）
 *   3. attemptPaste：成功路径（委托 InputInjector.paste）
 *   4. setSuppressNextChange / setAutoPasteEnabled：配置注入
 *
 * 测试策略：
 *   - mock getDefaultInputInjector 返回可控的 InputInjector 实例
 *   - 不依赖真实 nut-js / electron clipboard
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// mock getDefaultInputInjector，返回可控的 InputInjector mock
const { mockInputInjector, mockGetDefault } = vi.hoisted(() => ({
  mockInputInjector: {
    captureActiveWindow: vi.fn(),
    paste: vi.fn(),
  },
  mockGetDefault: vi.fn(),
}));

vi.mock('../../../electron/inputInjector.js', () => ({
  getDefaultInputInjector: mockGetDefault,
  InputInjector: vi.fn(), // 类构造函数 mock
}));

import { PasteCoordinator } from '../../../electron/windows/pasteCoordinator.js';
import type { ActiveWindow, PasteResult } from '../../../electron/inputInjector.js';

/** 创建 mock ActiveWindow */
function createMockWindow(title: string): ActiveWindow {
  return {
    title: Promise.resolve(title),
    region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
    focus: vi.fn(() => Promise.resolve()),
  };
}

/** 创建 mock PasteResult（粘贴成功） */
function createPasteResult(appName?: string): PasteResult {
  return { success: true, mode: 'paste', appName };
}

describe('PasteCoordinator', () => {
  let coordinator: PasteCoordinator;

  beforeEach(() => {
    vi.clearAllMocks();
    // 默认 mock：getDefaultInputInjector 返回 mockInputInjector
    mockGetDefault.mockResolvedValue(mockInputInjector);
    coordinator = new PasteCoordinator();
  });

  // ── capturePreviousWindow ──

  describe('capturePreviousWindow', () => {
    it('首次调用时懒创建 InputInjector', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));

      await coordinator.capturePreviousWindow();

      expect(mockGetDefault).toHaveBeenCalledTimes(1);
    });

    it('第二次调用时复用 InputInjector（不重复创建）', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));

      await coordinator.capturePreviousWindow();
      await coordinator.capturePreviousWindow();

      expect(mockGetDefault).toHaveBeenCalledTimes(1);
    });

    it('将 floatTitle 传给 captureActiveWindow（排除浮窗自身）', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));

      await coordinator.capturePreviousWindow('Memora 快速输入');

      expect(mockInputInjector.captureActiveWindow).toHaveBeenCalledWith('Memora 快速输入');
    });

    it('captureActiveWindow 返回 null（浮窗自身）时保持上一次的 previousWindow', async () => {
      // 第一次捕获到真实窗口
      const realWindow = createMockWindow('记事本');
      mockInputInjector.captureActiveWindow.mockResolvedValue(realWindow);
      await coordinator.capturePreviousWindow();

      // 第二次捕获到浮窗自身（返回 null）
      mockInputInjector.captureActiveWindow.mockResolvedValue(null);
      await coordinator.capturePreviousWindow();

      // previousWindow 应保持第一次的值（通过后续 attemptPaste 间接验证）
      mockInputInjector.paste.mockResolvedValue(createPasteResult('记事本'));
      coordinator.setSuppressNextChange(() => {});
      const result = await coordinator.attemptPaste('test', () => {});

      expect(result.mode).toBe('paste');
      expect(mockInputInjector.paste).toHaveBeenCalledWith('test', realWindow, expect.any(Function), expect.any(Function));
    });

    it('captureActiveWindow 返回新窗口时更新 previousWindow', async () => {
      const window1 = createMockWindow('记事本');
      mockInputInjector.captureActiveWindow.mockResolvedValue(window1);
      await coordinator.capturePreviousWindow();

      const window2 = createMockWindow('浏览器');
      mockInputInjector.captureActiveWindow.mockResolvedValue(window2);
      await coordinator.capturePreviousWindow();

      mockInputInjector.paste.mockResolvedValue(createPasteResult('浏览器'));
      coordinator.setSuppressNextChange(() => {});
      await coordinator.attemptPaste('test', () => {});

      expect(mockInputInjector.paste).toHaveBeenCalledWith('test', window2, expect.any(Function), expect.any(Function));
    });
  });

  // ── attemptPaste ──

  describe('attemptPaste', () => {
    it('未注入 suppressNextChange 时返回降级结果', async () => {
      // 先捕获窗口（创建 InputInjector）
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));
      await coordinator.capturePreviousWindow();

      // 不调用 setSuppressNextChange
      const result = await coordinator.attemptPaste('test', () => {});

      expect(result.success).toBe(false);
      expect(result.mode).toBe('copy');
      expect(result.reason).toBe('no_deps');
      expect(mockInputInjector.paste).not.toHaveBeenCalled();
    });

    it('autoPasteEnabled=false 时返回降级结果', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));
      await coordinator.capturePreviousWindow();

      coordinator.setSuppressNextChange(() => {});
      coordinator.setAutoPasteEnabled(false);

      const result = await coordinator.attemptPaste('test', () => {});

      expect(result.success).toBe(false);
      expect(result.mode).toBe('copy');
      expect(mockInputInjector.paste).not.toHaveBeenCalled();
    });

    it('未调用 capturePreviousWindow（InputInjector 为 null）时返回降级结果', async () => {
      coordinator.setSuppressNextChange(() => {});

      const result = await coordinator.attemptPaste('test', () => {});

      expect(result.success).toBe(false);
      expect(result.mode).toBe('copy');
      expect(result.reason).toBe('no_deps');
    });

    it('条件满足时委托 InputInjector.paste 并返回结果', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));
      await coordinator.capturePreviousWindow();

      const suppressFn = vi.fn();
      coordinator.setSuppressNextChange(suppressFn);

      const hideFloat = vi.fn();
      mockInputInjector.paste.mockResolvedValue(createPasteResult('记事本'));

      const result = await coordinator.attemptPaste('hello world', hideFloat);

      expect(result.success).toBe(true);
      expect(result.mode).toBe('paste');
      expect(result.appName).toBe('记事本');
      expect(mockInputInjector.paste).toHaveBeenCalledWith(
        'hello world',
        expect.any(Object), // previousWindow
        hideFloat,
        suppressFn,
      );
    });

    it('InputInjector.paste 返回失败时透传结果', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));
      await coordinator.capturePreviousWindow();
      coordinator.setSuppressNextChange(() => {});

      mockInputInjector.paste.mockResolvedValue({ success: false, mode: 'copy', reason: 'focus_failed' });

      const result = await coordinator.attemptPaste('test', () => {});

      expect(result.success).toBe(false);
      expect(result.mode).toBe('copy');
      expect(result.reason).toBe('focus_failed');
    });
  });

  // ── setSuppressNextChange / setAutoPasteEnabled ──

  describe('配置注入', () => {
    it('setSuppressNextChange 后 attemptPaste 不再返回 no_deps', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));
      await coordinator.capturePreviousWindow();

      coordinator.setSuppressNextChange(() => {});
      mockInputInjector.paste.mockResolvedValue(createPasteResult());

      const result = await coordinator.attemptPaste('test', () => {});

      expect(result.mode).toBe('paste');
    });

    it('setAutoPasteEnabled(false) 后再 setAutoPasteEnabled(true) 恢复粘贴', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));
      await coordinator.capturePreviousWindow();

      coordinator.setSuppressNextChange(() => {});
      coordinator.setAutoPasteEnabled(false);

      const result1 = await coordinator.attemptPaste('test', () => {});
      expect(result1.mode).toBe('copy');

      coordinator.setAutoPasteEnabled(true);
      mockInputInjector.paste.mockResolvedValue(createPasteResult());

      const result2 = await coordinator.attemptPaste('test', () => {});
      expect(result2.mode).toBe('paste');
    });
  });

  // ── getCapturedAppName ──

  describe('getCapturedAppName', () => {
    it('未捕获窗口时返回 null', async () => {
      const result = await coordinator.getCapturedAppName();
      expect(result).toBeNull();
    });

    it('窗口标题含 " - " 分隔符时返回末段应用名', async () => {
      // 模拟 VSCode 窗口标题："main.ts - my-project - Visual Studio Code"
      mockInputInjector.captureActiveWindow.mockResolvedValue(
        createMockWindow('main.ts - my-project - Visual Studio Code'),
      );
      await coordinator.capturePreviousWindow();

      const result = await coordinator.getCapturedAppName();
      expect(result).toBe('Visual Studio Code');
    });

    it('窗口标题无 " - " 分隔符时返回完整标题', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));
      await coordinator.capturePreviousWindow();

      const result = await coordinator.getCapturedAppName();
      expect(result).toBe('记事本');
    });

    it('title Promise 抛错时返回 null（防御异常窗口对象）', async () => {
      const errorWindow: ActiveWindow = {
        title: Promise.reject(new Error('title 不可访问')),
        region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
        focus: vi.fn(() => Promise.resolve()),
      };
      mockInputInjector.captureActiveWindow.mockResolvedValue(errorWindow);
      await coordinator.capturePreviousWindow();

      const result = await coordinator.getCapturedAppName();
      expect(result).toBeNull();
    });
  });
});
