/**
 * 渲染层错误处理辅助模块测试
 *
 * 覆盖范围：
 * - toError：未知错误转 Error 的纯函数（Error 实例 / 字符串 / 含 message 对象 / 其他类型）
 * - reportError：统一日志格式（[context] 前缀）+ 主进程日志上报（FOUNDATION-SEAL Phase 4）
 * - createIpcErrorHandler：IPC 错误处理闭包（日志 + 可选 toast）
 *
 * 测试环境说明：
 * - toError / createIpcErrorHandler：纯逻辑测试，无 JSDOM 依赖
 * - reportError 渲染进程日志上报：通过 vi.stubGlobal mock window.electronAPI
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toError, reportError, createIpcErrorHandler } from '../../../electron/renderer/helpers/errorHelpers.js';
import type { UIManager } from '../../../electron/renderer/ui.js';

/** 创建 UIManager mock（仅需 showToast 方法） */
function createMockUIManager(): Pick<UIManager, 'showToast'> {
  return {
    showToast: vi.fn(),
  };
}

// ─── toError ────────────────────────────────────────────────

describe('toError', () => {
  it('Error 实例应原样返回', () => {
    const original = new Error('原始错误');
    expect(toError(original)).toBe(original);
  });

  it('Error 子类实例应原样返回', () => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }
    const original = new CustomError('自定义错误');
    expect(toError(original)).toBe(original);
    expect(toError(original).name).toBe('CustomError');
  });

  it('字符串应转为 Error', () => {
    const result = toError('字符串错误');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('字符串错误');
  });

  it('含 message 字符串属性的对象应提取 message', () => {
    const obj = { message: '对象错误', code: 500 };
    const result = toError(obj);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('对象错误');
  });

  it('含 message 非字符串属性的对象应走 JSON 序列化兜底', () => {
    // message 是 number，不满足 typeof === 'string'，应走 JSON 序列化兜底
    // JSON 序列化保留调试信息（源码有意设计，优于无用的 "[object Object]"）
    const obj = { message: 12345 };
    const result = toError(obj);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(JSON.stringify(obj));
  });

  it('null 应转为"未知错误"', () => {
    const result = toError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('未知错误');
  });

  it('undefined 应转为"未知错误"', () => {
    const result = toError(undefined);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('未知错误');
  });

  it('数字应转为字符串 message', () => {
    const result = toError(404);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('404');
  });

  it('普通对象应 JSON 序列化为 message', () => {
    // 源码有意使用 JSON 序列化保留调试信息，优于无用的 "[object Object]"
    const obj = { code: 500, detail: '服务器错误' };
    const result = toError(obj);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(JSON.stringify(obj));
  });
});

// ─── reportError ────────────────────────────────────────────

describe('reportError', () => {
  beforeEach(() => {
    // vi.restoreAllMocks 确保每个测试的 spy 调用计数从 0 开始，
    // 避免 vi.spyOn 重复调用时累积前一个测试的调用记录
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('应输出 [context] 前缀的错误信息', () => {
    const error = new Error('测试错误');
    reportError('loadPersonaList', error);
    expect(console.error).toHaveBeenCalledWith('[loadPersonaList]', error);
  });

  it('字符串错误也应正常记录', () => {
    reportError('fetchData', '网络超时');
    expect(console.error).toHaveBeenCalledWith('[fetchData]', '网络超时');
  });

  it('不同 context 应生成不同前缀', () => {
    reportError('onMemoryDelete', new Error('删除失败'));
    reportError('onPersonaSwitch', new Error('切换失败'));
    expect(console.error).toHaveBeenNthCalledWith(1, '[onMemoryDelete]', expect.any(Error));
    expect(console.error).toHaveBeenNthCalledWith(2, '[onPersonaSwitch]', expect.any(Error));
  });
});

// ─── reportError - 渲染进程日志上报（FOUNDATION-SEAL Phase 4） ─────
//
// reportError 的双通道记录：
// 1. console.error：保留渲染进程控制台输出
// 2. window.electronAPI.rendererLog：上报主进程 logger（生产环境可观测性）
//
// 降级路径：IPC 不可用时（window 缺失 / electronAPI 缺失 / rendererLog 抛错）
// 仅 console.error，不向上抛出。

describe('reportError - 渲染进程日志上报（FOUNDATION-SEAL Phase 4）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // 清理 window stub，防止影响后续测试（node 环境默认无 window）
    vi.unstubAllGlobals();
  });

  it('应调用 window.electronAPI.rendererLog 上报错误到主进程', () => {
    const rendererLog = vi.fn();
    vi.stubGlobal('window', { electronAPI: { rendererLog } });

    const error = new Error('测试错误');
    reportError('loadPersonaList', error);

    // 验证双通道：console.error + rendererLog
    expect(console.error).toHaveBeenCalledWith('[loadPersonaList]', error);
    expect(rendererLog).toHaveBeenCalledWith('error', 'loadPersonaList', '测试错误');
  });

  it('字符串错误也应提取 message 上报到主进程', () => {
    const rendererLog = vi.fn();
    vi.stubGlobal('window', { electronAPI: { rendererLog } });

    reportError('fetchData', '网络超时');

    expect(rendererLog).toHaveBeenCalledWith('error', 'fetchData', '网络超时');
  });

  it('含 message 字段的对象应提取 message 上报', () => {
    const rendererLog = vi.fn();
    vi.stubGlobal('window', { electronAPI: { rendererLog } });

    reportError('onFetch', { message: '对象错误', code: 500 });

    expect(rendererLog).toHaveBeenCalledWith('error', 'onFetch', '对象错误');
  });

  it('window.electronAPI 不存在时仅 console.error，不抛错', () => {
    // electronAPI 为 undefined（preload 加载失败的场景）
    vi.stubGlobal('window', {});

    expect(() => reportError('ctx', new Error('err'))).not.toThrow();
    expect(console.error).toHaveBeenCalledWith('[ctx]', expect.any(Error));
  });

  it('window 不存在时仅 console.error，不抛错', () => {
    // node 环境默认无 window，不 stub 即可模拟此场景
    expect(() => reportError('ctx', new Error('err'))).not.toThrow();
    expect(console.error).toHaveBeenCalledWith('[ctx]', expect.any(Error));
  });

  it('rendererLog 抛错时应降级到 console.error，不向上抛出', () => {
    // 模拟 IPC 通道已关闭或 rendererLog 实现异常
    const rendererLog = vi.fn(() => {
      throw new Error('IPC 通道已关闭');
    });
    vi.stubGlobal('window', { electronAPI: { rendererLog } });

    expect(() => reportError('ctx', new Error('原错误'))).not.toThrow();
    expect(console.error).toHaveBeenCalledWith('[ctx]', expect.any(Error));
  });
});

// ─── createIpcErrorHandler ─────────────────────────────────

describe('createIpcErrorHandler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('应返回一个函数', () => {
    const mockUI = createMockUIManager();
    const handler = createIpcErrorHandler(mockUI as UIManager);
    expect(typeof handler).toBe('function');
  });

  it('不传 toastPrefix 时仅记录日志，不显示 toast', () => {
    const mockUI = createMockUIManager();
    const handler = createIpcErrorHandler(mockUI as UIManager);
    const error = new Error('IPC 失败');

    handler('onMemoryDelete', error);

    expect(console.error).toHaveBeenCalledWith('[onMemoryDelete]', error);
    expect(mockUI.showToast).not.toHaveBeenCalled();
  });

  it('传 toastPrefix 时应记录日志 + 显示错误 toast', () => {
    const mockUI = createMockUIManager();
    const handler = createIpcErrorHandler(mockUI as UIManager);
    const error = new Error('删除失败');

    handler('onMemoryDelete', error, '删除记忆失败');

    expect(console.error).toHaveBeenCalledWith('[onMemoryDelete]', error);
    expect(mockUI.showToast).toHaveBeenCalledWith('删除记忆失败：删除失败', 'error');
  });

  it('toast 消息应提取未知错误的 message', () => {
    const mockUI = createMockUIManager();
    const handler = createIpcErrorHandler(mockUI as UIManager);

    // 传入字符串而非 Error，验证 toError 转换被调用
    handler('onFetch', '网络超时', '获取数据失败');

    expect(mockUI.showToast).toHaveBeenCalledWith('获取数据失败：网络超时', 'error');
  });

  it('闭包应绑定传入的 uiManager，多个 handler 互不影响', () => {
    const mockUI1 = createMockUIManager();
    const mockUI2 = createMockUIManager();
    const handler1 = createIpcErrorHandler(mockUI1 as UIManager);
    const handler2 = createIpcErrorHandler(mockUI2 as UIManager);

    handler1('ctx1', new Error('err1'), '前缀1');
    handler2('ctx2', new Error('err2'), '前缀2');

    expect(mockUI1.showToast).toHaveBeenCalledTimes(1);
    expect(mockUI1.showToast).toHaveBeenCalledWith('前缀1：err1', 'error');
    expect(mockUI2.showToast).toHaveBeenCalledTimes(1);
    expect(mockUI2.showToast).toHaveBeenCalledWith('前缀2：err2', 'error');
  });
});
