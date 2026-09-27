/**
 * 安全定时器工具——原生 setTimeout/setInterval 不跟踪 ID，忘记清理会内存泄漏；
 * 本模块统一登记创建与清理，提供可追踪的生命周期管理。
 */

/** 所有活跃定时器注册表（供统一清理与调试断言） */
const activeTimers = new Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();

/** 安全 setTimeout：触发后自动从注册表移除；返回 timer ID */
export function safeSetTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  const id = setTimeout(() => {
    activeTimers.delete(id);
    callback();
  }, ms);
  activeTimers.add(id);
  return id;
}

/** 安全 setInterval：周期定时器，返回 timer ID */
export function safeSetInterval(callback: () => void, ms: number): ReturnType<typeof setInterval> {
  const id = setInterval(callback, ms);
  activeTimers.add(id);
  return id;
}

/** 清理安全 setTimeout（同时从注册表移除） */
export function clearSafeTimeout(id: ReturnType<typeof setTimeout> | null): void {
  if (id !== null) {
    clearTimeout(id);
    activeTimers.delete(id);
  }
}

/** 清理安全 setInterval（同时从注册表移除） */
export function clearSafeInterval(id: ReturnType<typeof setInterval> | null): void {
  if (id !== null) {
    clearInterval(id);
    activeTimers.delete(id);
  }
}

/** 获取活跃定时器数量（测试 + 调试用，验证注册表清理） */
export function getActiveTimerCount(): number {
  return activeTimers.size;
}

/** 清理所有活跃定时器（兜底，用于测试隔离，清理含未触发 timeout 与运行中 interval） */
export function clearAllSafeTimers(): void {
  for (const id of activeTimers) {
    clearTimeout(id);
    clearInterval(id);
  }
  activeTimers.clear();
}
