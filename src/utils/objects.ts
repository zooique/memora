/**
 * 对象类型守卫工具函数
 *
 * 从多个模块提取的公共对象类型校验函数，
 * 消除跨模块重复的类型守卫代码。
 */

/**
 * 判断值是否为普通对象（非 null、非数组）
 *
 * 用于校验 JSON.parse 的结果，避免对非对象类型执行展开或属性访问。
 *
 * @param value 待校验的值
 * @returns true 表示是普通对象（类型收窄为 Record<string, unknown>）
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
