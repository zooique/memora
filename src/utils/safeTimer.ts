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
 * 获取活跃定时器数量（仅供测试 + 调试用，验证 activeTimers 注册表清理）
 *
 * 场景：safeSetTimeout 触发后应自动从注册表移除；clearSafeTimeout/clearSafeInterval
 * 应立即从注册表移除。此函数用于直接断言注册表状态，而非仅通过回调触发间接验证。
 *
 * @returns 当前活跃定时器数量
 */
export function getActiveTimerCount(): number {
  return activeTimers.size;
}

/**
 * 清理所有活跃定时器（兜底清理机制）
 *
 * 场景：
 *   - 测试隔离：每个测试 beforeEach 调用，确保 activeTimers 注册表无残留
 *
 * 注意：此函数会清理所有通过 safeSetTimeout/safeSetInterval 创建的定时器，
 *       包括尚未触发的 timeout 和正在重复的 interval。
 */
export function clearAllSafeTimers(): void {
  for (const id of activeTimers) {
    clearTimeout(id);
    clearInterval(id);
  }
  activeTimers.clear();
}