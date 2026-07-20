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
const { mockInputInjector, mockGetDefault, mockGetWindowTextLengthW, mockGetWindowTextW, mockGetForegroundWindow, mockGetShellWindow, mockSetForegroundWindow } = vi.hoisted(() => ({
  mockInputInjector: {
    captureActiveWindow: vi.fn(),
    paste: vi.fn(),
  },
  mockGetDefault: vi.fn(),
  // koffi FFI mock：GetWindowTextLengthW 默认返回 0（模拟空标题窗口）
  mockGetWindowTextLengthW: vi.fn(() => 0),
  // koffi FFI mock：GetWindowTextW 默认空实现
  mockGetWindowTextW: vi.fn(),
  // koffi FFI mock：GetForegroundWindow 默认返回有效 HWND（模拟有前台窗口）
  mockGetForegroundWindow: vi.fn(() => 1181106),
  // koffi FFI mock：GetShellWindow 默认返回 0（无桌面窗口，避免误排除）
  mockGetShellWindow: vi.fn(() => 0),
  // koffi FFI mock：SetForegroundWindow 用于合成 ActiveWindow.focus()
  mockSetForegroundWindow: vi.fn(),
}));

vi.mock('../../../electron/inputInjector.js', () => ({
  getDefaultInputInjector: mockGetDefault,
  InputInjector: vi.fn(), // 类构造函数 mock
}));

// mock koffi FFI（用 mock 函数替代真实 Win32 API 调用，避免测试环境依赖 user32.dll）
vi.mock('koffi', () => ({
  load: vi.fn(() => ({
    func: vi.fn((definition: string) => {
      if (definition.includes('GetWindowTextLengthW')) return mockGetWindowTextLengthW;
      if (definition.includes('GetWindowTextW')) return mockGetWindowTextW;
      if (definition.includes('GetForegroundWindow')) return mockGetForegroundWindow;
      if (definition.includes('GetShellWindow')) return mockGetShellWindow;
      if (definition.includes('SetForegroundWindow')) return mockSetForegroundWindow;
      return vi.fn();
    }),
  })),
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

    it('非乱码标题：返回完整标题', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('无标题 - 记事本'));
      await coordinator.capturePreviousWindow();

      // koffi FFI 不应被调用（非乱码场景）
      expect(mockGetWindowTextLengthW).not.toHaveBeenCalled();
      expect(mockGetWindowTextW).not.toHaveBeenCalled();

      const result = await coordinator.getCapturedAppName();
      // 直接返回完整窗口标题，不再截取应用名
      expect(result).toBe('无标题 - 记事本');
    });

    it('非乱码标题：无 " - " 分隔符时返回完整标题', async () => {
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('记事本'));
      await coordinator.capturePreviousWindow();

      const result = await coordinator.getCapturedAppName();
      expect(result).toBe('记事本');
    });

    it('乱码标题：capturePreviousWindow 时立即通过 koffi FFI 修复', async () => {
      // nut-js 返回含 U+FFFD 的乱码标题（模拟中文软件乱码）
      const garbledTitle = '无标题 - \uFFFD\uFFFD\uFFFD\uFFFD';
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow(garbledTitle));

      // koffi FFI 返回 UTF-16LE 编码的准确标题 "无标题 - 记事本"
      const accurateTitle = '无标题 - 记事本';
      // GetWindowTextLengthW 返回标题长度
      mockGetWindowTextLengthW.mockReturnValue(accurateTitle.length);
      // GetWindowTextW 将标题写入传入的 Buffer（模拟 Win32 API 行为）
      mockGetWindowTextW.mockImplementation((_hwnd: number, buf: Buffer, _maxCount: number) => {
        buf.fill(0);
        buf.write(accurateTitle, 0, 'utf16le');
      });

      await coordinator.capturePreviousWindow();

      // 关键断言：koffi FFI 在 capturePreviousWindow 阶段被调用（此时浮窗未 show）
      expect(mockGetWindowTextLengthW).toHaveBeenCalledTimes(1);
      expect(mockGetWindowTextW).toHaveBeenCalledTimes(1);

      const result = await coordinator.getCapturedAppName();
      // getCapturedAppName 使用缓存的准确标题，不再调 koffi FFI
      expect(mockGetWindowTextLengthW).toHaveBeenCalledTimes(1);
      expect(mockGetWindowTextW).toHaveBeenCalledTimes(1);
      expect(result).toBe('无标题 - 记事本');
    });

    it('乱码标题：koffi FFI 失败时降级使用 nut-js 乱码标题', async () => {
      const garbledTitle = '无标题 - \uFFFD\uFFFD\uFFFD\uFFFD';
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow(garbledTitle));
      // GetWindowTextLengthW 抛出异常（模拟 koffi FFI 调用失败）
      mockGetWindowTextLengthW.mockReset();
      mockGetWindowTextLengthW.mockImplementation(() => { throw new Error('koffi: user32.dll not available'); });

      await coordinator.capturePreviousWindow();

      const result = await coordinator.getCapturedAppName();
      // 降级到 nut-js 标题（含乱码），返回完整标题不再截取
      expect(result).toBe('无标题 - \uFFFD\uFFFD\uFFFD\uFFFD');
    });

    it('乱码标题：GetWindowTextLengthW 返回 0 时降级使用 nut-js 标题', async () => {
      const garbledTitle = '无标题 - \uFFFD\uFFFD\uFFFD\uFFFD';
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow(garbledTitle));
      // GetWindowTextLengthW 返回 0（窗口无标题或 HWND 无效）
      mockGetWindowTextLengthW.mockReturnValue(0);
      // GetWindowTextW 不应被调用
      mockGetWindowTextW.mockReset();

      await coordinator.capturePreviousWindow();

      const result = await coordinator.getCapturedAppName();
      // 降级到 nut-js 标题（含乱码），返回完整标题不再截取
      expect(result).toBe('无标题 - \uFFFD\uFFFD\uFFFD\uFFFD');
    });

    it('窗口切换时重新检测乱码并获取新标题', async () => {
      // 第一次捕获：非乱码窗口
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow('文档1 - Word'));
      await coordinator.capturePreviousWindow();
      expect(mockGetWindowTextLengthW).not.toHaveBeenCalled();
      const name1 = await coordinator.getCapturedAppName();
      expect(name1).toBe('文档1 - Word');

      // 第二次捕获：乱码窗口
      const garbledTitle = '文档2 - \uFFFD\uFFFD\uFFFD\uFFFD';
      mockInputInjector.captureActiveWindow.mockResolvedValue(createMockWindow(garbledTitle));
      const accurateTitle = '文档2 - Excel';
      mockGetWindowTextLengthW.mockReturnValue(accurateTitle.length);
      mockGetWindowTextW.mockImplementation((_hwnd: number, buf: Buffer, _maxCount: number) => {
        buf.fill(0);
        buf.write(accurateTitle, 0, 'utf16le');
      });
      await coordinator.capturePreviousWindow();
      expect(mockGetWindowTextLengthW).toHaveBeenCalledTimes(1);
      expect(mockGetWindowTextW).toHaveBeenCalledTimes(1);
      const name2 = await coordinator.getCapturedAppName();
      expect(name2).toBe('文档2 - Excel');
    });
  });

  /** recapture() 方法测试：浮窗可见时重新捕获前台窗口 */
  describe('recapture()', () => {
    /** 为 recapture 测试设置 mock 标题（模拟 koffi GetWindowTextW 写入 UTF-16LE 标题） */
    function setMockTitle(title: string): void {
      // GetWindowTextLengthW 返回字符数（Win32 API 返回 wchar 长度）
      mockGetWindowTextLengthW.mockReturnValue(title.length);
      // GetWindowTextW 的第 2 个参数是 char16* 数组，直接写入 UTF-16LE 字节到 ArrayBuffer
      mockGetWindowTextW.mockImplementation((_hwnd: number, _buf: unknown, _len: number) => {
        const arr = (_buf as unknown) as Uint16Array;
        // 通过底层 ArrayBuffer 写入 UTF-16LE 字节（绕过 Uint16Array 的编码转换）
        const rawBytes = new Uint8Array(arr.buffer);
        const utf16le = Buffer.from(title, 'utf16le');
        for (let i = 0; i < utf16le.length && i < rawBytes.length; i++) {
          rawBytes[i] = utf16le[i]!;
        }
        return title.length;
      });
    }

    beforeEach(() => {
      // 重置 koffi mock 为默认值
      mockGetForegroundWindow.mockReturnValue(1181106);
      mockGetShellWindow.mockReturnValue(0);
      // 重置 nut-js mock
      mockInputInjector.captureActiveWindow.mockReset();
      mockGetDefault.mockResolvedValue(mockInputInjector);
    });

    it('成功捕获前台窗口完整标题', async () => {
      setMockTitle('无标题 - 记事本');
      const coordinator = new PasteCoordinator();

      const result = await coordinator.recapture();

      expect(result).not.toBeNull();
      expect(result!.title).toBe('无标题 - 记事本');
    });

    it('返回 null 当 GetForegroundWindow 返回 0（无前台窗口）', async () => {
      mockGetForegroundWindow.mockReturnValue(0);
      const coordinator = new PasteCoordinator();

      const result = await coordinator.recapture();

      expect(result).toBeNull();
    });

    it('返回 null 当浮窗自身是前台窗口（floatHwnd 排除）', async () => {
      const floatHwnd = 1181106;
      mockGetForegroundWindow.mockReturnValue(floatHwnd);
      const coordinator = new PasteCoordinator();

      const result = await coordinator.recapture(floatHwnd);

      expect(result).toBeNull();
    });

    it('返回 null 当桌面是前台窗口（GetShellWindow 排除）', async () => {
      const desktopHwnd = 65535;
      mockGetForegroundWindow.mockReturnValue(desktopHwnd);
      mockGetShellWindow.mockReturnValue(desktopHwnd);
      const coordinator = new PasteCoordinator();

      const result = await coordinator.recapture();

      expect(result).toBeNull();
    });

    it('返回 null 当标题为空', async () => {
      setMockTitle('');
      // GetWindowTextLengthW 返回 0 → getWindowTitle 返回 null
      mockGetWindowTextLengthW.mockReturnValue(0);
      const coordinator = new PasteCoordinator();

      const result = await coordinator.recapture();

      expect(result).toBeNull();
    });

    it('返回完整窗口标题（无截取，直接返回原始标题）', async () => {
      setMockTitle('Windows PowerShell');
      const coordinator = new PasteCoordinator();

      const result = await coordinator.recapture();

      expect(result).not.toBeNull();
      expect(result!.title).toBe('Windows PowerShell');
    });

    it('recapture 使用 koffi SetForegroundWindow 合成 ActiveWindow（绕过 nut-js bug）', async () => {
      setMockTitle('文档 - Word');
      const coordinator = new PasteCoordinator();

      const result = await coordinator.recapture();

      // 标题直接返回完整窗口标题（不再截取应用名）
      expect(result).not.toBeNull();
      expect(result!.title).toBe('文档 - Word');
    });

    it('recapture 后 getCapturedAppName 返回完整标题', async () => {
      setMockTitle('测试文档 - VS Code');
      const coordinator = new PasteCoordinator();

      await coordinator.recapture();
      const title = await coordinator.getCapturedAppName();

      // 直接返回完整标题，不再截取为 "VS Code"
      expect(title).toBe('测试文档 - VS Code');
    });
  });

  // ── checkAndRecapture（轮询同步重捕获）──

  describe('checkAndRecapture()', () => {
    /** 为 checkAndRecapture 测试设置 mock 标题 */
    function setMockTitle(title: string): void {
      mockGetWindowTextLengthW.mockReturnValue(title.length);
      mockGetWindowTextW.mockImplementation((_hwnd: number, _buf: unknown, _len: number) => {
        const arr = (_buf as unknown) as Uint16Array;
        const rawBytes = new Uint8Array(arr.buffer);
        const utf16le = Buffer.from(title, 'utf16le');
        for (let i = 0; i < utf16le.length && i < rawBytes.length; i++) {
          rawBytes[i] = utf16le[i]!;
        }
        return title.length;
      });
    }

    const FLOAT_HWND = 999888;

    beforeEach(() => {
      mockGetForegroundWindow.mockReturnValue(1181106);
      mockGetShellWindow.mockReturnValue(0);
    });

    it('前台窗口变化时返回新标题', () => {
      setMockTitle('浏览器 - Chrome');
      const coordinator = new PasteCoordinator();

      const result = coordinator.checkAndRecapture(FLOAT_HWND);

      expect(result).not.toBeNull();
      expect(result!.title).toBe('浏览器 - Chrome');
    });

    it('前台窗口未变化时返回 null（避免无效 SetForegroundWindow）', () => {
      setMockTitle('浏览器 - Chrome');
      const coordinator = new PasteCoordinator();

      // 第一次：捕获 Chrome
      coordinator.checkAndRecapture(FLOAT_HWND);
      // 第二次：前台窗口未变，应返回 null
      const result = coordinator.checkAndRecapture(FLOAT_HWND);

      expect(result).toBeNull();
    });

    it('前台窗口是浮窗自身时返回 null', () => {
      setMockTitle('浮窗标题');
      mockGetForegroundWindow.mockReturnValue(FLOAT_HWND);
      const coordinator = new PasteCoordinator();

      const result = coordinator.checkAndRecapture(FLOAT_HWND);

      expect(result).toBeNull();
    });

    it('前台窗口是桌面时返回 null', () => {
      const desktopHwnd = 65535;
      mockGetForegroundWindow.mockReturnValue(desktopHwnd);
      mockGetShellWindow.mockReturnValue(desktopHwnd);
      const coordinator = new PasteCoordinator();

      const result = coordinator.checkAndRecapture(FLOAT_HWND);

      expect(result).toBeNull();
    });

    it('连续两次切换到不同窗口均返回正确标题', () => {
      const coordinator = new PasteCoordinator();

      // 第一次切换
      setMockTitle('文档 - Word');
      const result1 = coordinator.checkAndRecapture(FLOAT_HWND);
      expect(result1!.title).toBe('文档 - Word');

      // 模拟切换到另一个窗口（更换 HWND）
      mockGetForegroundWindow.mockReturnValue(2222222);
      setMockTitle('表格 - Excel');
      const result2 = coordinator.checkAndRecapture(FLOAT_HWND);
      expect(result2!.title).toBe('表格 - Excel');
    });
  });
});
