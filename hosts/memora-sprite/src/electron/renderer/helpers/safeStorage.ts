/**
 * localStorage 安全读写工具
 *
 * 职责：
 * - 提供 try-catch 静默降级的读写函数（JSON 场景 + 字符串场景）
 * - 统一 localStorage 不可用 / JSON 损坏 / 配额超限等异常处理
 *
 * 设计原则（ADR-017 枝叶层 2 次提取原则）：
 * - JSON 场景：safeGetJSON/safeSetJSON，从 quickInputCompletion/completionMetrics 等 5 处提取
 * - 字符串场景：safeGet/safeSet，从 float/themeManager/onboarding/renderer/quickInput 等 9 处提取
 * - 只负责"安全读写"，业务校验由调用方处理
 * - 降级语义：读取失败返回 defaultValue，写入失败静默忽略
 *
 * 使用示例：
 * ```typescript
 * // JSON 读取（调用方自行校验类型）
 * const parsed = safeGetJSON<unknown>(KEY, []);
 * if (!Array.isArray(parsed)) return [];
 * return parsed as MyType[];
 *
 * // 字符串读取（如 '1'/'0' 标记位）
 * const seen = safeGet(DRAG_HINT_KEY, '0') === '1';
 *
 * // 字符串写入
 * safeSet(DRAG_HINT_KEY, '1');
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

/**
 * 安全读取 localStorage 字符串值（非 JSON 场景）
 *
 * try-catch 静默降级：localStorage 不可用（隐私模式/cookie 禁用）时返回 defaultValue。
 * 适用于 '1'/'0' 标记位、主题名等字符串场景，无需 JSON.parse。
 *
 * @param key localStorage 键名
 * @param defaultValue 降级时的默认值
 * @returns 原始字符串值，或 defaultValue
 */
export function safeGet(key: string, defaultValue: string): string {
  try {
    return localStorage.getItem(key) ?? defaultValue;
  } catch {
    // localStorage 不可用（隐私模式等），静默降级
    return defaultValue;
  }
}

/**
 * 安全写入 localStorage 字符串值（非 JSON 场景）
 *
 * try-catch 静默降级：写入失败时静默忽略，不影响业务流程。
 * 适用于 '1'/'0' 标记位、主题名等字符串场景，无需 JSON.stringify。
 *
 * @param key localStorage 键名
 * @param value 原始字符串值
 */
export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 写入失败静默降级（配额超限、隐私模式等）
  }
}
