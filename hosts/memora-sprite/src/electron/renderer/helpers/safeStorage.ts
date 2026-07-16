/**
 * localStorage 安全读写工具
 *
 * 职责：
 * - 提供 try-catch 静默降级的 JSON 读写函数
 * - 统一 localStorage 不可用 / JSON 损坏 / 配额超限等异常处理
 *
 * 设计原则（ADR-017 枝叶层 2 次提取原则）：
 * - 从 11 处散落的 try-catch 静默降级模式中提取
 * - 只负责"安全读取 + JSON 解析"和"安全序列化 + 写入"，业务校验由调用方处理
 * - 降级语义：读取失败返回 defaultValue，写入失败静默忽略
 *
 * 使用示例：
 * ```typescript
 * // 读取（调用方自行校验类型）
 * const parsed = safeGetJSON<unknown>(KEY, []);
 * if (!Array.isArray(parsed)) return [];
 * return parsed as MyType[];
 *
 * // 写入
 * safeSetJSON(KEY, myData);
 * ```
 */

/**
 * 安全读取 localStorage 并 JSON.parse
 *
 * try-catch 静默降级：localStorage 不可用、key 不存在、JSON 损坏时返回 defaultValue。
 * 调用方需自行校验返回值的类型（如 Array.isArray）。
 *
 * @param key localStorage 键名
 * @param defaultValue 降级时的默认值
 * @returns 解析后的值，或 defaultValue
 */
export function safeGetJSON<T>(key: string, defaultValue: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultValue;
    return JSON.parse(raw) as T;
  } catch {
    // localStorage 不可用或 JSON 损坏，静默降级
    return defaultValue;
  }
}

/**
 * 安全序列化并写入 localStorage
 *
 * try-catch 静默降级：写入失败（如配额超限、隐私模式）时静默忽略，不影响业务流程。
 *
 * @param key localStorage 键名
 * @param value 要序列化的值
 */
export function safeSetJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 写入失败静默降级（配额超限、隐私模式等）
  }
}
