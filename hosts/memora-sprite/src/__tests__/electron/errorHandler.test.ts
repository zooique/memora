/**
 * 错误处理器测试
 *
 * 覆盖范围：
 * - MemoraError 类：构造器、code/context 字段、继承 Error
 * - ErrorCode 枚举：7 种错误码完整覆盖
 * - ErrorHandler.handle：code 优先级（explicitCode > MemoraError.code > 字符串推断 > UNKNOWN）
 * - getUserFriendlyMessage：7 种 ErrorCode 映射（通过 handle 间接验证）
 * - extractErrorCode：降级路径（ENOENT/网络/初始化/UNKNOWN）
 * - showErrorToUser：mainWindow 未设置/已销毁/正常发送
 *
 * Mock 策略：
 * - memora.logger：vi.fn() 捕获日志调用
 * - mainWindow：简单对象 mock isDestroyed/webContents.send
 * - 通过 new ErrorHandler() 创建独立实例，避免全局单例污染
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock memora 模块 ─────────────────────────────────────
// errorHandler.ts 顶部 import { toError, logger } from 'memora'
// toError 保留默认实现（仅做错误对象标准化），logger 用 vi.fn() 捕获

vi.mock('memora', () => ({
  toError: (err: unknown): Error => {
    if (err instanceof Error) return err;
    if (typeof err === 'string') return new Error(err);
    if (err === null || err === undefined) return new Error(String(err));
    return new Error(String(err));
  },
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

// 导入被测模块（在 mock 之后）
import { MemoraError, ErrorHandler, ErrorCode } from '../../electron/errorHandler.js';
import { logger } from 'memora';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 mock BrowserWindow（isDestroyed 返回 false，webContents.send 捕获调用） */
function createMockWindow(): {
  isDestroyed: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
} {
  return {
    isDestroyed: vi.fn(() => false),
    webContents: { send: vi.fn() },
  };
}

/** 创建独立 ErrorHandler 实例（避免全局单例污染） */
function createErrorHandler(): ErrorHandler {
  return new ErrorHandler();
}

// ─── MemoraError 类 ──────────────────────────────────────

describe('MemoraError', () => {
  it('应携带 code 和 message', () => {
    const err = new MemoraError(ErrorCode.FILE_READ_FAILED, '文件不存在');
    expect(err.code).toBe(ErrorCode.FILE_READ_FAILED);
    expect(err.message).toBe('文件不存在');
  });

  it('应继承 Error，name 为 MemoraError', () => {
    const err = new MemoraError(ErrorCode.UNKNOWN, 'test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MemoraError);
    expect(err.name).toBe('MemoraError');
  });

  it('应携带可选 context（结构化数据）', () => {
    const err = new MemoraError(ErrorCode.NETWORK_ERROR, '请求失败', {
      context: { url: 'https://api.example.com', status: 500 },
    });
    expect(err.context).toEqual({ url: 'https://api.example.com', status: 500 });
  });

  it('无 context 时 context 字段为 undefined', () => {
    const err = new MemoraError(ErrorCode.UNKNOWN, 'test');
    expect(err.context).toBeUndefined();
  });

  it('应支持 Error cause 链（options.cause）', () => {
    const cause = new Error('原始原因');
    const err = new MemoraError(ErrorCode.API_ERROR, 'API 失败', { cause });
    expect(err.cause).toBe(cause);
  });
});

// ─── ErrorCode 枚举 ──────────────────────────────────────

describe('ErrorCode 枚举', () => {
  it('应包含 9 种错误码', () => {
    expect(Object.values(ErrorCode).length).toBe(9);
  });

  it('每种错误码应为字符串值', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(typeof code).toBe('string');
    }
  });

  it('错误码值应与枚举名一致（大写下划线）', () => {
    expect(ErrorCode.UNKNOWN).toBe('UNKNOWN');
    expect(ErrorCode.INITIALIZATION_FAILED).toBe('INITIALIZATION_FAILED');
    expect(ErrorCode.CONFIG_LOAD_FAILED).toBe('CONFIG_LOAD_FAILED');
    expect(ErrorCode.WINDOW_CREATE_FAILED).toBe('WINDOW_CREATE_FAILED');
    expect(ErrorCode.FILE_READ_FAILED).toBe('FILE_READ_FAILED');
    expect(ErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR');
    expect(ErrorCode.API_ERROR).toBe('API_ERROR');
    // 存储与校验错误码
    expect(ErrorCode.STORAGE_ERROR).toBe('STORAGE_ERROR');
    expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
  });
});

// ─── ErrorHandler.handle（code 优先级） ─────────────────

describe('ErrorHandler.handle code 优先级', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('优先级 1：explicitCode 应覆盖 MemoraError.code', () => {
    const handler = createErrorHandler();
    // MemoraError 携带 FILE_READ_FAILED，但 explicitCode 指定 NETWORK_ERROR
    const err = new MemoraError(ErrorCode.FILE_READ_FAILED, '文件读取失败');
    const appError = handler.handle(err, { code: ErrorCode.NETWORK_ERROR });

    expect(appError.code).toBe(ErrorCode.NETWORK_ERROR);
  });

  it('优先级 2：MemoraError.code 应优先于字符串推断', () => {
    const handler = createErrorHandler();
    // message 含 "网络" 会触发字符串推断为 NETWORK_ERROR，
    // 但 MemoraError 携带 FILE_READ_FAILED 应优先
    const err = new MemoraError(ErrorCode.FILE_READ_FAILED, '网络文件读取失败');
    const appError = handler.handle(err);

    expect(appError.code).toBe(ErrorCode.FILE_READ_FAILED);
  });

  it('优先级 3：普通 Error 应走字符串推断降级路径', () => {
    const handler = createErrorHandler();
    // 普通 Error 无 code 字段，message 含 "ENOENT" 应推断为 FILE_READ_FAILED
    const err = new Error('ENOENT: no such file or directory');
    const appError = handler.handle(err);

    expect(appError.code).toBe(ErrorCode.FILE_READ_FAILED);
  });

  it('优先级 4：无法匹配的 Error 应降级为 UNKNOWN', () => {
    const handler = createErrorHandler();
    const err = new Error('一些无法识别的错误信息');
    const appError = handler.handle(err);

    expect(appError.code).toBe(ErrorCode.UNKNOWN);
  });
});

// ─── ErrorHandler.handle（extractErrorCode 降级路径） ────

describe('extractErrorCode 字符串推断降级路径', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('message 含 ENOENT 应推断为 FILE_READ_FAILED', () => {
    const handler = createErrorHandler();
    const appError = handler.handle(new Error('ENOENT: file not found'));
    expect(appError.code).toBe(ErrorCode.FILE_READ_FAILED);
  });

  it('message 含 "文件" 应推断为 FILE_READ_FAILED', () => {
    const handler = createErrorHandler();
    const appError = handler.handle(new Error('文件打开失败'));
    expect(appError.code).toBe(ErrorCode.FILE_READ_FAILED);
  });

  it('message 含 "网络" 应推断为 NETWORK_ERROR', () => {
    const handler = createErrorHandler();
    const appError = handler.handle(new Error('网络连接超时'));
    expect(appError.code).toBe(ErrorCode.NETWORK_ERROR);
  });

  it('message 含 "fetch" 应推断为 NETWORK_ERROR', () => {
    const handler = createErrorHandler();
    const appError = handler.handle(new Error('fetch failed'));
    expect(appError.code).toBe(ErrorCode.NETWORK_ERROR);
  });

  it('message 含 "初始化" 应推断为 INITIALIZATION_FAILED', () => {
    const handler = createErrorHandler();
    const appError = handler.handle(new Error('初始化失败'));
    expect(appError.code).toBe(ErrorCode.INITIALIZATION_FAILED);
  });

  it('message 含 "init" 应推断为 INITIALIZATION_FAILED', () => {
    const handler = createErrorHandler();
    const appError = handler.handle(new Error('init error'));
    expect(appError.code).toBe(ErrorCode.INITIALIZATION_FAILED);
  });
});

// ─── ErrorHandler.handle（AppError 结构） ───────────────

describe('handle 返回的 AppError 结构', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应包含 code/message/originalError/timestamp', () => {
    const handler = createErrorHandler();
    const original = new Error('测试错误');
    const appError = handler.handle(original);

    expect(appError.code).toBeDefined();
    expect(appError.message).toBe('测试错误');
    expect(appError.originalError).toBe(original);
    expect(appError.timestamp).toBeInstanceOf(Date);
  });

  it('应携带 context 描述（options.context）', () => {
    const handler = createErrorHandler();
    const appError = handler.handle(new Error('err'), { context: '对话流式输出' });

    expect(appError.context).toEqual({ description: '对话流式输出' });
  });

  it('无 context 时 context 字段为 undefined', () => {
    const handler = createErrorHandler();
    const appError = handler.handle(new Error('err'));

    expect(appError.context).toBeUndefined();
  });
});

// ─── getUserFriendlyMessage（通过 handle 间接验证） ──────

describe('getUserFriendlyMessage 用户友好消息映射', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('UNKNOWN 应映射为未知错误提示', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    handler.setMainWindow(mockWin);
    handler.handle(new Error('未知错误'));

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'app-error',
      expect.objectContaining({ message: '发生未知错误，请稍后重试' }),
    );
  });

  it('FILE_READ_FAILED 应映射为文件读取失败提示', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    handler.setMainWindow(mockWin);
    handler.handle(new MemoraError(ErrorCode.FILE_READ_FAILED, '原始消息'));

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'app-error',
      expect.objectContaining({ message: '文件读取失败，请检查文件权限' }),
    );
  });

  it('NETWORK_ERROR 应映射为网络连接失败提示', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    handler.setMainWindow(mockWin);
    handler.handle(new MemoraError(ErrorCode.NETWORK_ERROR, '原始消息'));

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'app-error',
      expect.objectContaining({ message: '网络连接失败，请检查网络设置' }),
    );
  });

  it('API_ERROR 应映射为 API 调用失败提示', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    handler.setMainWindow(mockWin);
    handler.handle(new MemoraError(ErrorCode.API_ERROR, '原始消息'));

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'app-error',
      expect.objectContaining({ message: 'API调用失败，请稍后重试' }),
    );
  });

  it('INITIALIZATION_FAILED 应映射为 Agent 初始化失败提示', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    handler.setMainWindow(mockWin);
    handler.handle(new MemoraError(ErrorCode.INITIALIZATION_FAILED, '原始消息'));

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'app-error',
      expect.objectContaining({ message: 'Agent 初始化失败，请查看对话区的详细错误信息' }),
    );
  });

  it('CONFIG_LOAD_FAILED 应映射为配置加载失败提示', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    handler.setMainWindow(mockWin);
    handler.handle(new MemoraError(ErrorCode.CONFIG_LOAD_FAILED, '原始消息'));

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'app-error',
      expect.objectContaining({ message: '配置加载失败，使用默认配置' }),
    );
  });

  it('WINDOW_CREATE_FAILED 应映射为窗口创建失败提示', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    handler.setMainWindow(mockWin);
    handler.handle(new MemoraError(ErrorCode.WINDOW_CREATE_FAILED, '原始消息'));

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'app-error',
      expect.objectContaining({ message: '窗口创建失败，请重启应用' }),
    );
  });

  // P1：新增错误码的友好消息映射测试（翠幕天罗审查补齐）
  it('STORAGE_ERROR 应映射为存储操作失败提示', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    handler.setMainWindow(mockWin);
    handler.handle(new MemoraError(ErrorCode.STORAGE_ERROR, '原始消息'));

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'app-error',
      expect.objectContaining({ message: '存储操作失败，请检查数据目录权限' }),
    );
  });

  it('VALIDATION_ERROR 应映射为数据校验失败提示', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    handler.setMainWindow(mockWin);
    handler.handle(new MemoraError(ErrorCode.VALIDATION_ERROR, '原始消息'));

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'app-error',
      expect.objectContaining({ message: '数据校验失败，请检查输入内容' }),
    );
  });
});

// ─── showErrorToUser（窗口状态边界） ────────────────────

describe('showErrorToUser 窗口状态边界', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mainWindow 未设置时不应抛错（静默跳过）', () => {
    const handler = createErrorHandler();
    // 不调用 setMainWindow，mainWindow 为 null
    expect(() => handler.handle(new Error('err'))).not.toThrow();
  });

  it('mainWindow 已销毁时不应发送消息', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    mockWin.isDestroyed = vi.fn(() => true);
    handler.setMainWindow(mockWin);

    handler.handle(new Error('err'));

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it('webContents.send 抛错时不应传播（TOCTOU 竞态兜底）', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    mockWin.webContents.send = vi.fn(() => {
      throw new Error('窗口在 send 瞬间被销毁');
    });
    handler.setMainWindow(mockWin);

    // send 抛错被 try-catch 兜底，handle 不应传播异常
    expect(() => handler.handle(new Error('err'))).not.toThrow();
  });

  it('正常发送应携带 SerializedAppError 结构（code/message/timestamp）', () => {
    const handler = createErrorHandler();
    const mockWin = createMockWindow();
    handler.setMainWindow(mockWin);

    handler.handle(new MemoraError(ErrorCode.FILE_READ_FAILED, '原始消息'));

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'app-error',
      expect.objectContaining({
        code: ErrorCode.FILE_READ_FAILED,
        message: expect.any(String),
        timestamp: expect.any(String), // ISO 8601 字符串
      }),
    );
  });
});

// ─── logError 结构化日志 ─────────────────────────────────

describe('logError 结构化日志', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('应调用 logger.error 输出结构化日志', () => {
    const handler = createErrorHandler();
    // appError.context 来自 options.context（人类可读描述），非 MemoraError.context
    const err = new MemoraError(ErrorCode.NETWORK_ERROR, '请求超时');
    handler.handle(err, { context: 'API 请求阶段' });

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        code: ErrorCode.NETWORK_ERROR,
        context: { description: 'API 请求阶段' },
        originalError: err,
      }),
      '请求超时',
    );
  });
});
