/**
 * AbortSignal 合并工具
 *
 * 从 openaiCompatible.ts 和 embedding.ts 提取的公共"外部信号 + 超时信号"合并逻辑（二者同构）。
 *
 * 确保用户取消（optsSignal）和请求超时都能中断 fetch 和流读取。
 */

/**
 * 合并外部 AbortSignal + 超时 AbortSignal
 *
 * 创建内部 AbortController，将外部 optsSignal 和超时信号合并到其 signal 上。
 * 返回 signal 供 fetch 使用，以及两个清理函数：
 *   - clearTimer：只清超时定时器（流式读取前调用，保留 optsSignal 监听用于 SSE 取消）
 *   - dispose：完整清理（清超时 + 移除 optsSignal 监听，最终清理时调用）
 *
 * @param optsSignal 外部传入的 AbortSignal（可选，用户取消信号）
 * @param timeoutMs 超时毫秒数
 * @param timeoutErrorName 超时错误名称（如 'LLM 请求超时' / 'Embedding 请求超时'）
 * @returns { signal, clearTimer, dispose } 合并后的 signal 和清理函数
 */
export function mergeAbortSignals(
  optsSignal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutErrorName: string,
): {
  signal: AbortSignal;
  clearTimer: () => void;
  dispose: () => void;
} {
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(new DOMException(timeoutErrorName, 'TimeoutError')),
    timeoutMs,
  );
  const onOptsAbort = () => abortController.abort(optsSignal?.reason);
  if (optsSignal) {
    if (optsSignal.aborted) {
      abortController.abort(optsSignal.reason);
    } else {
      optsSignal.addEventListener('abort', onOptsAbort, { once: true });
    }
  }

  // 只清超时定时器（流式读取前调用，保留 optsSignal 监听用于 SSE 阶段取消）
  const clearTimer = () => clearTimeout(timeoutId);
  // 完整清理：清超时 + 移除 optsSignal 监听（最终清理时调用，防止监听器常驻泄漏）
  const dispose = () => {
    clearTimeout(timeoutId);
    if (optsSignal) optsSignal.removeEventListener('abort', onOptsAbort);
  };

  return { signal: abortController.signal, clearTimer, dispose };
}
