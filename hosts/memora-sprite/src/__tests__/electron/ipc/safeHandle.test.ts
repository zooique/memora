/**
 * safeHandle IPC 错误兜底包装测试
 *
 * 覆盖范围：
 * - 同步 fn 成功：返回 fn 结果
 * - 异步 fn 成功：返回 Promise 结果
 * - 同步 fn 抛错：返回 fallback + 调用 errorHandler.handle
 * - 异步 fn reject：返回 fallback + 调用 errorHandler.handle
 * - code 参数：默认 UNKNOWN + 显式指定
 * - context 参数：传递给 errorHandler.handle
 *
 * Mock 策略：
 * - errorHandler.handle：vi.fn() 捕获调用，避免真实错误处理副作用
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock errorHandler 模块 ──────────────────────────────
// safeHandle 内部调用 errorHandler.handle(error, { code, context })
// mock 后可验证调用参数，避免依赖真实 ErrorHandler 逻辑
// 使用 vi.hoisted 确保 mockHandle 在 vi.mock factory 提升时已初始化

const { mockHandle } = vi.hoisted(() => ({
  mockHandle: vi.fn(),
}));

vi.mock('../../../electron/errorHandler.js', () => ({
  errorHandler: {
    handle: mockHandle,
  },
  ErrorCode: {
    UNKNOWN: 'UNKNOWN',
    NETWORK_ERROR: 'NETWORK_ERROR',
    FILE_READ_FAILED: 'FILE_READ_FAILED',
  },
}));

// 导入被测函数（在 mock 之后）
import { safeHandle, throwingHandle } from '../../../electron/ipc/types.js';
import { ErrorCode } from '../../../electron/errorHandler.js';

describe('safeHandle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── 成功路径 ──────────────────────────────────────────

  it('同步 fn 成功应返回 fn 结果', async () => {
    const result = await safeHandle('测试上下文', '降级值', () => '成功结果');
    expect(result).toBe('成功结果');
  });

  it('异步 fn 成功应返回 Promise 结果', async () => {
    const result = await safeHandle('测试上下文', '降级值', async () => {
      return '异步成功结果';
    });
    expect(result).toBe('异步成功结果');
  });

  it('fn 返回数字应正确传递', async () => {
    const result = await safeHandle('计数', 0, () => 42);
    expect(result).toBe(42);
  });

  it('fn 返回对象应正确传递', async () => {
    const result = await safeHandle('查询', null, () => ({ items: [1, 2, 3] }));
    expect(result).toEqual({ items: [1, 2, 3] });
  });

  // ─── 失败路径 ──────────────────────────────────────────

  it('同步 fn 抛错应返回 fallback', async () => {
    const result = await safeHandle('同步操作', '降级值', () => {
      throw new Error('同步错误');
    });
    expect(result).toBe('降级值');
  });

  it('异步 fn reject 应返回 fallback', async () => {
    const result = await safeHandle('异步操作', '降级值', async () => {
      throw new Error('异步错误');
    });
    expect(result).toBe('降级值');
  });

  it('fn 抛错应调用 errorHandler.handle 传递错误和上下文', async () => {
    const error = new Error('测试错误');
    await safeHandle('对话处理', '降级值', () => {
      throw error;
    });

    expect(mockHandle).toHaveBeenCalledWith(error, {
      code: ErrorCode.UNKNOWN,
      context: '对话处理',
    });
  });

  it('显式指定 code 应传递给 errorHandler.handle', async () => {
    const error = new Error('网络错误');
    await safeHandle(
      'API 请求',
      '降级值',
      () => {
        throw error;
      },
      ErrorCode.NETWORK_ERROR,
    );

    expect(mockHandle).toHaveBeenCalledWith(error, {
      code: ErrorCode.NETWORK_ERROR,
      context: 'API 请求',
    });
  });

  it('默认 code 应为 UNKNOWN', async () => {
    await safeHandle('测试', 'fallback', () => {
      throw new Error('err');
    });

    expect(mockHandle).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: ErrorCode.UNKNOWN }),
    );
  });

  it('非 Error 对象抛错也应被捕获（字符串）', async () => {
    const result = await safeHandle('测试', '降级值', () => {
      throw '字符串错误';
    });
    expect(result).toBe('降级值');
    expect(mockHandle).toHaveBeenCalledWith('字符串错误', expect.any(Object));
  });
});

// ─── throwingHandle 测试（查询类错误透传包装） ──────────

describe('throwingHandle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── 成功路径（与 safeHandle 一致） ─────────────────────

  it('同步 fn 成功应返回 fn 结果', async () => {
    const result = await throwingHandle('测试上下文', () => '成功结果');
    expect(result).toBe('成功结果');
  });

  it('异步 fn 成功应返回 Promise 结果', async () => {
    const result = await throwingHandle('测试上下文', async () => '异步成功结果');
    expect(result).toBe('异步成功结果');
  });

  // ─── 失败路径（与 safeHandle 的关键区别：re-throw 而非降级） ───

  it('同步 fn 抛错应 re-throw（不返回降级值）', async () => {
    await expect(
      throwingHandle('同步操作', () => {
        throw new Error('同步错误');
      }),
    ).rejects.toThrow('同步错误');
  });

  it('异步 fn reject 应 re-throw（不返回降级值）', async () => {
    await expect(
      throwingHandle('异步操作', async () => {
        throw new Error('异步错误');
      }),
    ).rejects.toThrow('异步错误');
  });

  it('fn 抛错应调用 errorHandler.handle 传递错误和上下文', async () => {
    const error = new Error('测试错误');
    await expect(
      throwingHandle('查询处理', () => {
        throw error;
      }),
    ).rejects.toThrow();

    expect(mockHandle).toHaveBeenCalledWith(error, {
      code: ErrorCode.UNKNOWN,
      context: '查询处理',
    });
  });

  it('显式指定 code 应传递给 errorHandler.handle', async () => {
    const error = new Error('网络错误');
    await expect(
      throwingHandle(
        'API 请求',
        () => {
          throw error;
        },
        ErrorCode.NETWORK_ERROR,
      ),
    ).rejects.toThrow();

    expect(mockHandle).toHaveBeenCalledWith(error, {
      code: ErrorCode.NETWORK_ERROR,
      context: 'API 请求',
    });
  });

  it('默认 code 应为 UNKNOWN', async () => {
    await expect(
      throwingHandle('测试', () => {
        throw new Error('err');
      }),
    ).rejects.toThrow();

    expect(mockHandle).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ code: ErrorCode.UNKNOWN }),
    );
  });

  it('非 Error 对象抛错也应 re-throw（字符串）', async () => {
    await expect(
      throwingHandle('测试', () => {
        throw '字符串错误';
      }),
    ).rejects.toBe('字符串错误');
    expect(mockHandle).toHaveBeenCalledWith('字符串错误', expect.any(Object));
  });
});
