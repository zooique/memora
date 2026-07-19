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
const { mockInputInjector, mockGetDefault, mockExecSync, mockReadFileSync, mockUnlinkSync } = vi.hoisted(() => ({
  mockInputInjector: {
    captureActiveWindow: vi.fn(),
    paste: vi.fn(),
  },
  mockGetDefault: vi.fn(),
  mockExecSync: vi.fn((): string => { throw new Error('mocked: PowerShell disabled in test'); }),
  mockReadFileSync: vi.fn(),
  mockUnlinkSync: vi.fn(),
}));

vi.mock('../../../electron/inputInjector.js', () => ({
  getDefaultInputInjector: mockGetDefault,
  InputInjector: vi.fn(), // 类构造函数 mock
}));

// mock node:child_process execSync（默认模拟 PowerShell 失败，避免测试环境真的调用 PowerShell）
// 单个测试可通过 mockExecSync.mockImplementation(() => {}) 覆盖为成功路径
vi.mock('node:child_process', () => ({
  execSync: mockExecSync,
}));

// mock node:fs（文件 I/O 方式获取标题：readFileSync 读取 PowerShell 写入的 UTF-16LE 临时文件）
vi.mock('node:fs', () => ({
  default: { readFileSync: mockReadFileSync, unlinkSync: mockUnlinkSync },
  readFileSync: mockReadFileSync,
  unlinkSync: mockUnlinkSync,
}));

import { PasteCoordinator } from '../../../electron/windows/pasteCoordinator.js';
import type { ActiveWindow, PasteResult } from '../../../electron/inputInjector.js';

/** mock HWND 值（nut-js Window.windowHandle） */
const MOCK_HWND = 12345678;

/** 创建 mock ActiveWindow（含 HWND 用于 PowerShell 标题修复） */
function createMockWindow(title: string): ActiveWindow {
  return {
    title: Promise.resolve(title),
    region: Promise.resolve({ left: 0, top: 0, width: 800, height: 600 }),
    focus: vi.fn(() => Promise.resolve()),
    hwnd: MOCK_HWND,
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

    it('将 floatWindowHwnd 传给 captureActiveWindow（排除浮窗自身）', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));

      const floatHwnd = 999888;
      await coordinator.capturePreviousWindow(floatHwnd);

      expect(mockInputInjector.captureActiveWindow).toHaveBeenCalledWith(floatHwnd);
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

  // ── getCapturedAppName + 乱码修复 ──

  describe('getCapturedAppName', () => {
    it('无捕获窗口时返回 null', async () => {
      const result = await coordinator.getCapturedAppName();
      expect(result).toBeNull();
    });

    it('非乱码标题：使用 nut-js 标题，不调用 PowerShell', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('无标题 - 记事本'));
      await coordinator.capturePreviousWindow();

      // execSync 不应被调用（非乱码场景）
      expect(mockExecSync).not.toHaveBeenCalled();

      const result = await coordinator.getCapturedAppName();
      expect(result).toBe('记事本');
    });

    it('非乱码标题：无 " - " 分隔符时返回完整标题', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));
      await coordinator.capturePreviousWindow();

      const result = await coordinator.getCapturedAppName();
      expect(result).toBe('记事本');
    });

    it('乱码标题：capturePreviousWindow 时立即通过 PowerShell 修复', async () => {
      // nut-js 返回含 U+FFFD 的乱码标题（模拟中文软件乱码）
      const garbledTitle = '无标题 - \uFFFD\uFFFD\uFFFD\uFFFD';
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow(garbledTitle));

      // PowerShell 通过文件 I/O 返回 UTF-16LE 编码的准确标题 "无标题 - 记事本"
      const accurateTitle = '无标题 - 记事本';
      mockExecSync.mockReturnValue(''); // PowerShell 成功（不抛错，返回值不使用）
      mockReadFileSync.mockReturnValue(Buffer.from(accurateTitle, 'utf16le'));

      await coordinator.capturePreviousWindow();

      // 关键断言：PowerShell 在 capturePreviousWindow 阶段被调用（此时浮窗未 show）
      // 这是修复时序问题的核心——PS 必须在浮窗显示前调用才能拿到目标窗口
      expect(mockExecSync).toHaveBeenCalledTimes(1);

      const result = await coordinator.getCapturedAppName();
      // getCapturedAppName 使用缓存的准确标题，不再调 PS
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      expect(result).toBe('记事本');
    });

    it('乱码标题：PowerShell 失败时降级使用 nut-js 乱码标题', async () => {
      const garbledTitle = '无标题 - \uFFFD\uFFFD\uFFFD\uFFFD';
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow(garbledTitle));
      // 显式重置 mockExecSync 为抛错（上一个测试设置了 mockImplementation，clearAllMocks 不重置实现）
      mockExecSync.mockReset();
      mockExecSync.mockImplementation(() => { throw new Error('mocked: PowerShell failed'); });

      await coordinator.capturePreviousWindow();

      const result = await coordinator.getCapturedAppName();
      // 降级到 nut-js 标题（含乱码），应用名提取仍尝试解析 " - " 分隔符
      expect(result).toBe('\uFFFD\uFFFD\uFFFD\uFFFD');
    });

    it('乱码标题：PowerShell 返回空文件时降级使用 nut-js 标题', async () => {
      const garbledTitle = '无标题 - \uFFFD\uFFFD\uFFFD\uFFFD';
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow(garbledTitle));
      mockExecSync.mockReturnValue(''); // PowerShell 成功
      mockReadFileSync.mockReturnValue(Buffer.alloc(0)); // 但文件为空

      await coordinator.capturePreviousWindow();

      const result = await coordinator.getCapturedAppName();
      expect(result).toBe('\uFFFD\uFFFD\uFFFD\uFFFD');
    });

    it('窗口切换时重新检测乱码并获取新标题', async () => {
      // 第一次捕获：非乱码窗口
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('文档1 - Word'));
      await coordinator.capturePreviousWindow();
      expect(mockExecSync).not.toHaveBeenCalled();
      const name1 = await coordinator.getCapturedAppName();
      expect(name1).toBe('Word');

      // 第二次捕获：乱码窗口
      const garbledTitle = '文档2 - \uFFFD\uFFFD\uFFFD\uFFFD';
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow(garbledTitle));
      const accurateTitle = '文档2 - Excel';
      mockExecSync.mockReturnValue(''); // PowerShell 成功
      mockReadFileSync.mockReturnValue(Buffer.from(accurateTitle, 'utf16le'));
      await coordinator.capturePreviousWindow();
      expect(mockExecSync).toHaveBeenCalledTimes(1);
      const name2 = await coordinator.getCapturedAppName();
      expect(name2).toBe('Excel');
    });
  });
});
