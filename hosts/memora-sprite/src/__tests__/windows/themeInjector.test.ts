/**
 * 主题初始化脚本注入器测试
 *
 * 覆盖范围：
 * - injectThemeScript：注册 did-start-loading 监听器
 * - 监听器触发时 isDestroyed 守卫（已销毁跳过 executeJavaScript）
 * - 正常注入应调用 executeJavaScript
 * - executeJavaScript 返回 Promise（成功路径）
 * - executeJavaScript 抛错应静默降级（catch 不传播）
 *
 * Mock 策略：
 * - WebContents：简单对象 mock on/isDestroyed/executeJavaScript
 * - executeJavaScript 返回 Promise 以测试 catch 降级路径
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { injectThemeScript } from '../../electron/windows/themeInjector.js';
import type { WebContents } from 'electron';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock WebContents（捕获 on/isDestroyed/executeJavaScript 调用） */
function createMockWebContents(destroyed = false): WebContents & {
  on: ReturnType<typeof vi.fn>;
  isDestroyed: ReturnType<typeof vi.fn>;
  executeJavaScript: ReturnType<typeof vi.fn>;
  /** 触发 did-start-loading 监听器（测试辅助） */
  triggerDidStartLoading: () => void;
} {
  let didStartLoadingCallback: (() => void) | null = null;
  return {
    on: vi.fn((event: string, callback: () => void) => {
      if (event === 'did-start-loading') {
        didStartLoadingCallback = callback;
      }
    }),
    isDestroyed: vi.fn(() => destroyed),
    executeJavaScript: vi.fn(() => Promise.resolve()),
    triggerDidStartLoading: () => {
      didStartLoadingCallback?.();
    },
  } as unknown as WebContents & {
    on: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    executeJavaScript: ReturnType<typeof vi.fn>;
    triggerDidStartLoading: () => void;
  };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('injectThemeScript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应注册 did-start-loading 事件监听器', () => {
    const webContents = createMockWebContents();
    injectThemeScript(webContents);

    expect(webContents.on).toHaveBeenCalledWith('did-start-loading', expect.any(Function));
  });

  it('did-start-loading 触发时 webContents 已销毁应跳过 executeJavaScript', () => {
    const webContents = createMockWebContents(true); // destroyed = true
    injectThemeScript(webContents);

    // 触发 did-start-loading
    webContents.triggerDidStartLoading();

    expect(webContents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('did-start-loading 触发时 webContents 正常应调用 executeJavaScript', () => {
    const webContents = createMockWebContents(false);
    injectThemeScript(webContents);

    webContents.triggerDidStartLoading();

    expect(webContents.executeJavaScript).toHaveBeenCalled();
    // 注入脚本应包含 localStorage.getItem('memora-theme') 逻辑
    const script = webContents.executeJavaScript.mock.calls[0][0] as string;
    expect(script).toContain("localStorage.getItem('memora-theme')");
    expect(script).toContain("data-theme");
    expect(script).toContain("dark");
  });

  it('executeJavaScript 成功应正常完成（不抛错）', async () => {
    const webContents = createMockWebContents(false);
    webContents.executeJavaScript = vi.fn(() => Promise.resolve());
    injectThemeScript(webContents);

    // 触发并等待 Promise 微任务完成
    webContents.triggerDidStartLoading();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 无异常即通过
    expect(webContents.executeJavaScript).toHaveBeenCalled();
  });

  it('executeJavaScript 抛错应静默降级（catch 不传播）', async () => {
    const webContents = createMockWebContents(false);
    webContents.executeJavaScript = vi.fn(() => Promise.reject(new Error('注入失败')));
    injectThemeScript(webContents);

    // 触发 did-start-loading，executeJavaScript reject 应被 catch 静默处理
    expect(() => {
      webContents.triggerDidStartLoading();
    }).not.toThrow();

    // 等待 Promise 微任务完成（reject 会被 catch 处理，不会导致 unhandledRejection）
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(webContents.executeJavaScript).toHaveBeenCalled();
  });

  it('注入脚本应包含 try-catch 降级逻辑（localStorage 不可用时不崩溃）', () => {
    const webContents = createMockWebContents(false);
    injectThemeScript(webContents);

    webContents.triggerDidStartLoading();

    const script = webContents.executeJavaScript.mock.calls[0][0] as string;
    // 脚本内部应包含 try-catch 块，localStorage 不可用时降级
    expect(script).toContain('try');
    expect(script).toContain('catch');
  });
});
