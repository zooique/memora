/**
 * 代码执行集成入口：提供带超时保护的加载包装，组合宿主注入的执行器。
 * 执行失败时降级返回友好错误结果，不中断对话流程（超时防卡死 Agent 主循环）。
 */
import type {
  CodeExecutionOptions,
  CodeExecutionResult,
  ICodeExecutionProvider,
} from '@/code-exec/types.js';

/** 代码执行外层兜底超时（毫秒）：对齐 run_skill_script 的最大执行超时 */
const EXECUTION_TIMEOUT_MS = 120_000;

/**
 * 带超时和错误处理的执行包装：超时或失败时不抛异常，返回降级结果。
 *
 * @param provider 宿主注入的执行器
 * @param code 要执行的代码
 * @param language 代码语言
 * @param options 执行选项（timeoutMs 同时用于外层兜底超时）
 * @returns 执行结果（失败时 exitCode=-1 并附降级提示）
 */
export async function safeExecuteCode(
  provider: ICodeExecutionProvider,
  code: string,
  language: string,
  options?: CodeExecutionOptions,
): Promise<CodeExecutionResult> {
  const timeoutMs = options?.timeoutMs ?? EXECUTION_TIMEOUT_MS;
  const timeoutPromise = new Promise<CodeExecutionResult>((_, reject) => {
    const id = setTimeout(() => {
      clearTimeout(id);
      reject(new Error('代码执行超时（外层兜底）'));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([provider.execute(code, language, options), timeoutPromise]);
    return result;
  } catch (err) {
    // 执行失败不抛异常，返回降级提示
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: `执行失败：${message}`, exitCode: -1, timedOut: false };
  }
}
