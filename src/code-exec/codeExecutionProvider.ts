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
 * 外层兜底超时错误标记（Symbol 键）：区分「执行器超时无响应」与「执行器执行失败」。
 * 用 Symbol 而非字符串匹配——宿主执行器抛同名文案不误判（字符串耦合脆弱）。
 */
const TIMEOUT_FLAG = Symbol('safeExecuteCodeTimeout');

/**
 * 带超时和错误处理的执行包装：超时或失败时不抛异常，返回降级结果。
 *
 * @param provider 宿主注入的执行器
 * @param code 要执行的代码
 * @param language 代码语言
 * @param options 执行选项（timeoutMs 同时用于外层兜底超时）
 * @returns 执行结果（失败时 exitCode=-1 并附降级提示；外层兜底超时时 timedOut=true）
 */
export async function safeExecuteCode(
  provider: ICodeExecutionProvider,
  code: string,
  language: string,
  options?: CodeExecutionOptions,
): Promise<CodeExecutionResult> {
  const timeoutMs = options?.timeoutMs ?? EXECUTION_TIMEOUT_MS;
  // 外部持有定时器 + finally 清理：执行器正常返回时兜底定时器仍挂起会延迟进程退出
  // （对齐 safeSearch/safeFetch/safeSearchProjectFiles 已收敛的同款定时器模式）
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<CodeExecutionResult>((_, reject) => {
    timer = setTimeout(() => {
      // 打标超时错误：外层兜底超时是「执行器无响应」而非执行失败，须还原 timedOut 位
      const err = new Error('代码执行超时（外层兜底）') as Error & { [TIMEOUT_FLAG]?: boolean };
      err[TIMEOUT_FLAG] = true;
      reject(err);
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([provider.execute(code, language, options), timeoutPromise]);
    return result;
  } catch (err) {
    // 外层兜底超时（执行器无响应）→ 降级为超时结果（timedOut=true，三态判定走 CODE_TIMEOUT）
    const isTimeout =
      typeof err === 'object' && err !== null && (err as { [TIMEOUT_FLAG]?: boolean })[TIMEOUT_FLAG] === true;
    if (isTimeout) {
      return { stdout: '', stderr: '执行超时（外层兜底：执行器无响应）', exitCode: -1, timedOut: true };
    }
    // 执行失败不抛异常，返回降级提示
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: `执行失败：${message}`, exitCode: -1, timedOut: false };
  } finally {
    // 正常完成或失败时清理兜底定时器，防 event loop 挂起（进程退出延迟）
    if (timer) clearTimeout(timer);
  }
}
