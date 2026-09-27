/**
 * 错误类型测试
 * 覆盖 4 大类错误工厂 + format + log
 * ToolErrorCode + isRetryableErrorCode + securityError + errorCode 字段测试
 */
import { describe, it, expect } from 'vitest';
import {
  configError,
  networkError,
  llmError,
  toolError,
  securityError,
  MemoraError,
  ToolErrorCode,
  isRetryableErrorCode,
  isAbortError,
  isTimeoutAbortSignal,
  isTimeoutError,
} from '@/utils/errors.js';

describe('MemoraError · 错误信息友好化', () => {
  it('应该构造带标题/详情/建议的错误', () => {
    const err = configError('API Key 缺失', 'MEMORA_API_KEY 未设置', ['设置环境变量']);
    expect(err.title).toBe('API Key 缺失');
    expect(err.detail).toBe('MEMORA_API_KEY 未设置');
    expect(err.suggestions).toEqual(['设置环境变量']);
    expect(err.category).toBe('config');
  });

  it('format 应该输出中文错误 + 建议列表', () => {
    const err = networkError('连接失败', 'timeout 5s', ['检查网络', '重试']);
    const formatted = err.format();
    expect(formatted).toContain('❌ 连接失败');
    expect(formatted).toContain('原因：timeout 5s');
    expect(formatted).toContain('建议：');
    expect(formatted).toContain('检查网络');
    expect(formatted).toContain('重试');
  });

  it('4 大类错误应该正确分类', () => {
    expect(configError('a', 'b', []).category).toBe('config');
    expect(networkError('a', 'b', []).category).toBe('network');
    expect(llmError('a', 'b', []).category).toBe('llm');
    expect(toolError('a', 'b', []).category).toBe('tool');
  });

  it('format 无 detail 时应省略原因行', () => {
    const err = toolError('路径越界', undefined, ['改用白名单路径']);
    const formatted = err.format();
    expect(formatted).toContain('❌ 路径越界');
    expect(formatted).not.toContain('原因');
    expect(formatted).toContain('建议：');
  });

  it('format 无 suggestions 时应省略建议行', () => {
    const err = toolError('路径越界', '/etc/passwd', []);
    const formatted = err.format();
    expect(formatted).toContain('❌ 路径越界');
    expect(formatted).toContain('原因：/etc/passwd');
    expect(formatted).not.toContain('建议');
  });

  it('错误应该保留原始 cause 用于调试', () => {
    const cause = new Error('ECONNREFUSED');
    const err = networkError('LLM 不可达', '无法连接', ['检查网络'], cause);
    expect(err.cause).toBe(cause);
    expect(err.stack).toBeDefined();
  });
});

// ─── ToolErrorCode 错误码值定义 ──────────────────────

describe('ToolErrorCode · 错误码值定义', () => {
  it('应定义 9 种错误码', () => {
    // 验证 ToolErrorCode 对象包含 9 个键
    const codes = Object.keys(ToolErrorCode);
    expect(codes).toHaveLength(9);
  });

  it('每种错误码的键与值相同（as const 语义）', () => {
    // as const 使键值相同，便于日志检索 + 跨进程序列化
    expect(ToolErrorCode.PATH_NOT_ALLOWED).toBe('PATH_NOT_ALLOWED');
    expect(ToolErrorCode.FILE_NOT_FOUND).toBe('FILE_NOT_FOUND');
    expect(ToolErrorCode.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
    expect(ToolErrorCode.ARGUMENT_ERROR).toBe('ARGUMENT_ERROR');
    expect(ToolErrorCode.WRITE_REJECTED).toBe('WRITE_REJECTED');
    expect(ToolErrorCode.DIR_NOT_FOUND).toBe('DIR_NOT_FOUND');
    expect(ToolErrorCode.UNKNOWN_TOOL).toBe('UNKNOWN_TOOL');
    expect(ToolErrorCode.CUSTOM_TOOL_FAILED).toBe('CUSTOM_TOOL_FAILED');
    expect(ToolErrorCode.UNKNOWN).toBe('UNKNOWN');
  });
});

// ─── isRetryableErrorCode 可重试判断 ────────────────

describe('isRetryableErrorCode · AgentLoop Reflection 核心', () => {
  it('FILE_NOT_FOUND 应可重试（LLM 可能用错路径）', () => {
    expect(isRetryableErrorCode(ToolErrorCode.FILE_NOT_FOUND)).toBe(true);
  });

  it('ARGUMENT_ERROR 应可重试（LLM 可修正参数格式）', () => {
    expect(isRetryableErrorCode(ToolErrorCode.ARGUMENT_ERROR)).toBe(true);
  });

  it('DIR_NOT_FOUND 应可重试（LLM 可能用错路径）', () => {
    expect(isRetryableErrorCode(ToolErrorCode.DIR_NOT_FOUND)).toBe(true);
  });

  it('CUSTOM_TOOL_FAILED 应可重试', () => {
    expect(isRetryableErrorCode(ToolErrorCode.CUSTOM_TOOL_FAILED)).toBe(true);
  });

  it('PATH_NOT_ALLOWED 应不可重试（权限问题，重试无意义）', () => {
    expect(isRetryableErrorCode(ToolErrorCode.PATH_NOT_ALLOWED)).toBe(false);
  });

  it('PERMISSION_DENIED 应不可重试', () => {
    expect(isRetryableErrorCode(ToolErrorCode.PERMISSION_DENIED)).toBe(false);
  });

  it('WRITE_REJECTED 应不可重试（用户拒绝，重试无意义）', () => {
    expect(isRetryableErrorCode(ToolErrorCode.WRITE_REJECTED)).toBe(false);
  });

  it('UNKNOWN_TOOL 应不可重试（工具未注册）', () => {
    expect(isRetryableErrorCode(ToolErrorCode.UNKNOWN_TOOL)).toBe(false);
  });

  it('UNKNOWN 应不可重试（通用错误兜底）', () => {
    expect(isRetryableErrorCode(ToolErrorCode.UNKNOWN)).toBe(false);
  });

  it('4 个 retryable + 5 个 non-retryable 边界完整覆盖', () => {
    // 统计验证：9 个错误码中恰好 4 个可重试 + 5 个不可重试
    // 注：TOOL_TIMEOUT 删除后，retryable 从 5 → 4
    const allCodes = Object.values(ToolErrorCode);
    const retryable = allCodes.filter((c) => isRetryableErrorCode(c));
    const nonRetryable = allCodes.filter((c) => !isRetryableErrorCode(c));
    expect(retryable).toHaveLength(4);
    expect(nonRetryable).toHaveLength(5);
  });
});

// ─── securityError 工厂函数 ─────────────────────────

describe('securityError · 安全错误工厂', () => {
  it('应构造 category=security 的错误', () => {
    const err = securityError('路径越界', '/etc/passwd 不在白名单', ['检查路径']);
    expect(err.category).toBe('security');
    expect(err.title).toBe('路径越界');
    expect(err.detail).toBe('/etc/passwd 不在白名单');
    expect(err.suggestions).toEqual(['检查路径']);
  });

  it('format 应输出安全错误信息', () => {
    const err = securityError('禁止访问', '命中黑名单', ['联系管理员']);
    const formatted = err.format();
    expect(formatted).toContain('❌ 禁止访问');
    expect(formatted).toContain('原因：命中黑名单');
    expect(formatted).toContain('联系管理员');
  });

  it('应保留 cause 用于调试', () => {
    const cause = new Error('EACCES');
    const err = securityError('权限拒绝', '无写入权限', ['chmod'], cause);
    expect(err.cause).toBe(cause);
  });
});

// ─── MemoraError.errorCode 字段 ─────────────────────

describe('MemoraError.errorCode · 工具错误码字段', () => {
  it('toolError 透传 errorCode 到 MemoraError', () => {
    const err = toolError(
      '文件不存在',
      '/tmp/foo',
      ['检查路径'],
      undefined,
      ToolErrorCode.FILE_NOT_FOUND,
    );
    expect(err.errorCode).toBe(ToolErrorCode.FILE_NOT_FOUND);
    expect(err.category).toBe('tool');
  });

  it('toolError 未传 errorCode 时字段为 undefined', () => {
    const err = toolError('路径越界', '/etc', ['改用白名单']);
    expect(err.errorCode).toBeUndefined();
  });

  it('其他工厂函数不设置 errorCode（undefined）', () => {
    // configError/networkError/llmError/securityError 均不接收 errorCode 参数
    expect(configError('a', 'b', []).errorCode).toBeUndefined();
    expect(networkError('a', 'b', []).errorCode).toBeUndefined();
    expect(llmError('a', 'b', []).errorCode).toBeUndefined();
    expect(securityError('a', 'b', []).errorCode).toBeUndefined();
  });

  it('直接构造 MemoraError 可指定 errorCode + unknown 分类', () => {
    // 测试 ErrorCategory 的 unknown 分类
    const err = new MemoraError({
      title: '未知错误',
      detail: '未分类',
      suggestions: [],
      category: 'unknown',
      errorCode: ToolErrorCode.UNKNOWN,
    });
    expect(err.category).toBe('unknown');
    expect(err.errorCode).toBe(ToolErrorCode.UNKNOWN);
    expect(isRetryableErrorCode(err.errorCode!)).toBe(false);
  });

  it('MemoraError 是 Error 子类（instanceof 校验）', () => {
    const err = toolError('a', 'b', [], undefined, ToolErrorCode.ARGUMENT_ERROR);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MemoraError);
    expect(err.name).toBe('MemoraError');
  });
});

// ─── isAbortError AbortError 判定 ─────────────────────

describe('isAbortError · AbortError 统一判定', () => {
  it('原生 Error with name=AbortError 应识别', () => {
    const err = new Error('用户取消');
    err.name = 'AbortError';
    expect(isAbortError(err)).toBe(true);
  });

  it('DOMException with name=AbortError 应识别（modern Node 18+ DOMException 是 Error 子类）', () => {
    // DOMException 在 Node 18+ / 浏览器中是 Error 子类，isAbortError 应直接识别
    const err = new DOMException('用户取消', 'AbortError');
    expect(isAbortError(err)).toBe(true);
  });

  it('普通 Error 不应识别', () => {
    expect(isAbortError(new Error('普通错误'))).toBe(false);
  });

  it('MemoraError 不应识别（name=MemoraError 非 AbortError）', () => {
    expect(isAbortError(configError('a', 'b', []))).toBe(false);
  });

  it('非 Error 类型应安全返回 false（不抛错）', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError('字符串错误')).toBe(false);
    expect(isAbortError({ name: 'AbortError' })).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });

  it('Error 子类（如 TypeError）不应识别', () => {
    expect(isAbortError(new TypeError('type error'))).toBe(false);
    expect(isAbortError(new RangeError('range error'))).toBe(false);
  });
});

// ─── isTimeoutError 超时判定（非 abort 载体） ─────────────────────

describe('isTimeoutError · 超时错误判定（与 isAbortError 互斥）', () => {
  it('DOMException with name=TimeoutError 应识别（SSE 停摆看门狗的真实载体）', () => {
    expect(isTimeoutError(new DOMException('SSE 阶段停摆超时', 'TimeoutError'))).toBe(true);
  });

  it('普通 Error with name=TimeoutError 应识别（兼容非 DOMException 载体）', () => {
    const err = new Error('请求超时');
    err.name = 'TimeoutError';
    expect(isTimeoutError(err)).toBe(true);
  });

  it('互斥性：AbortError 不得被判为超时（否则用户取消会谎报成超时）', () => {
    const abortErr = new DOMException('用户取消', 'AbortError');
    expect(isTimeoutError(abortErr)).toBe(false);
    expect(isAbortError(abortErr)).toBe(true);
  });

  it('互斥性：TimeoutError 不得被判为取消（否则超时会谎报成用户取消）', () => {
    const timeoutErr = new DOMException('停摆', 'TimeoutError');
    expect(isAbortError(timeoutErr)).toBe(false);
    expect(isTimeoutError(timeoutErr)).toBe(true);
  });

  it('两种载体语义同源：signal.reason 与抛出错误判据一致（同一 name 常量）', () => {
    // 同一 DOMException 分别作为「signal.reason」与「抛出的错误」——两个判据须给出一致结论
    const reason = new DOMException('停摆', 'TimeoutError');
    const ctrl = new AbortController();
    ctrl.abort(reason);
    expect(isTimeoutAbortSignal(ctrl.signal)).toBe(true);
    expect(isTimeoutError(reason)).toBe(true);
  });

  it('普通 Error / MemoraError / 非 Error 类型应安全返回 false（不抛错）', () => {
    expect(isTimeoutError(new Error('普通错误'))).toBe(false);
    expect(isTimeoutError(configError('a', 'b', []))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
    expect(isTimeoutError('TimeoutError')).toBe(false);
    expect(isTimeoutError({ name: 'TimeoutError' })).toBe(false);
  });
});
