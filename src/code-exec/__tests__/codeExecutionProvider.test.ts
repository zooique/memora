/**
 * 代码执行集成入口单元测试
 *
 * 覆盖 safeExecuteCode 函数：
 *   - 成功返回执行结果
 *   - 执行失败时降级返回错误结果（exitCode=-1，不抛异常）
 *   - 执行超时时降级返回超时结果（不抛异常）
 *   - 非 Error 类型异常降级处理
 *   - options.timeoutMs 传入执行器
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { CodeExecutionOptions, CodeExecutionResult, ICodeExecutionProvider } from '@/code-exec/types.js';
import { safeExecuteCode } from '@/code-exec/codeExecutionProvider.js';

/** 创建一个模拟的执行提供者（总是成功） */
function createMockProvider(
  result: CodeExecutionResult = { stdout: 'hello', stderr: '', exitCode: 0, timedOut: false },
): ICodeExecutionProvider {
  return {
    async execute(_code, _language, _options) {
      return result;
    },
  };
}

/** 创建一个模拟的执行提供者（总是抛异常） */
function createFailingProvider(errorMsg = '解释器不可用'): ICodeExecutionProvider {
  return {
    async execute() {
      throw new Error(errorMsg);
    },
  };
}

describe('safeExecuteCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应返回执行提供者返回的结果', async () => {
    const result: CodeExecutionResult = { stdout: '42', stderr: '', exitCode: 0, timedOut: false };
    const provider = createMockProvider(result);
    const out = await safeExecuteCode(provider, 'print(42)', 'python');
    expect(out).toEqual(result);
  });

  it('应传递 language 与 options 给执行提供者', async () => {
    const spy = vi.fn(
      async (_code: string, _language: string, _options?: CodeExecutionOptions) => ({
        stdout: '',
        stderr: '',
        exitCode: 0,
        timedOut: false,
      }),
    );
    const provider: ICodeExecutionProvider = { execute: spy };
    await safeExecuteCode(provider, 'console.log(1)', 'node', { timeoutMs: 5000 });
    expect(spy).toHaveBeenCalledWith('console.log(1)', 'node', { timeoutMs: 5000 });
  });

  it('执行失败时应降级返回错误结果而非抛出异常', async () => {
    const provider = createFailingProvider('语法错误');
    const result = await safeExecuteCode(provider, 'def foo(', 'python');
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('执行失败');
    expect(result.stderr).toContain('语法错误');
    expect(result.timedOut).toBe(false);
  });

  it('执行超时时应降级返回结果而非抛出异常', async () => {
    const provider = createFailingProvider('代码执行超时（外层兜底）');
    const result = await safeExecuteCode(provider, 'while True: pass', 'python');
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('执行失败');
  });

  it('非 Error 类型的异常应降级处理', async () => {
    const provider: ICodeExecutionProvider = {
      async execute() {
        throw '字符串异常';
      },
    };
    const result = await safeExecuteCode(provider, 'x', 'node');
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain('执行失败');
  });
});
