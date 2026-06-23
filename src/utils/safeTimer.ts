/**
 * 安全定时器工具 — 提供可追踪的生命周期管理
 *
 * 原生 setTimeout / setInterval 不跟踪定时器 ID，
 * 如果忘记清理可能导致内存泄漏。本模块提供轻量包装，
 * 统一管理定时器的创建和清理。
 */

/** 定时器注册表，用于跟踪所有活跃定时器 */
const activeTimers = new Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();

/**
 * 安全的 setTimeout 包装
 * 返回的 timer ID 可用于 clearSafeTimeout 清理
 */
export function safeSetTimeout(
  callback: () => void,
  ms: number,
): ReturnType<typeof setTimeout> {
  const id = setTimeout(() => {
    activeTimers.delete(id);
    callback();
  }, ms);
  activeTimers.add(id);
  return id;
}

/**
 * 安全的 setInterval 包装
 * 返回的 timer ID 可用于 clearSafeInterval 清理
 */
export function safeSetInterval(
  callback: () => void,
  ms: number,
): ReturnType<typeof setInterval> {
  const id = setInterval(callback, ms);
  activeTimers.add(id);
  return id;
}

/**
 * 清理安全的 setTimeout
 */
export function clearSafeTimeout(id: ReturnType<typeof setTimeout> | null): void {
  if (id !== null) {
    clearTimeout(id);
    activeTimers.delete(id);
  }
}

/**
 * 清理安全的 setInterval
 */
export function clearSafeInterval(id: ReturnType<typeof setInterval> | null): void {
  if (id !== null) {
    clearInterval(id);
    activeTimers.delete(id);
  }
}

/**
 * 清理所有活跃定时器
 * 用于进程退出或 Agent 完全关闭时调用
 */
export function clearAllSafeTimers(): void {
  for (const id of activeTimers) {
    clearTimeout(id);
  }
  activeTimers.clear();
}