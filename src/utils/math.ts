/**
 * 数学工具函数
 */

/**
 * 将数值四舍五入到指定小数位数
 *
 * 替代 `Math.round(x * 10^n) / 10^n` 惯用法，消除 4 处重复。
 *
 * @param value - 待四舍五入的数值
 * @param decimals - 保留的小数位数（0~20，默认 2）
 * @returns 四舍五入后的数值；value 为 NaN/Infinity 时原样返回
 */
export function roundTo(value: number, decimals = 2): number {
  // NaN/Infinity 不参与运算，避免 Math.round 返回意外结果
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * 正整数解析（单一真源）：缺省 / 非法 / ≤0 → undefined，否则返回 parseInt 结果。
 *
 * 供 `builtinToolHandlers`（read_file 分段 offset/limit）与 `toolResultCache`（去重主体）
 * 共用——两处语义一致（「缺省 / 非法 / <1 一律视为缺省，默认值交给调用方」），
 * 避免同一规则散落两处（legacy-contract-audit 重复实现）。
 *
 * @param v 输入（string | number 之外一律归 undefined；`"12px"` 这类前导数字按 parseInt 语义解析）
 * @returns 正整数，或 undefined
 */
export function positiveInt(v: unknown): number | undefined {
  const n = Number.parseInt(String(v), 10);
  return Number.isNaN(n) || n < 1 ? undefined : n;
}
