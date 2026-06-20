/**
 * 纯逻辑 toError — 零依赖，浏览器 / Node.js 通用
 *
 * 将 catch 块中的 unknown 值安全转换为 Error 对象。
 * 从 errors.ts 中提取，确保浏览器端可直接 import 而不引入 logging（pino）依赖。
 *
 * 转换规则：
 * - Error 实例：原样返回
 * - 对象且含 message 属性：包装为 Error
 * - 其他：调用 String() 转为 message
 */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return new Error((err as { message: string }).message);
  }
  return new Error(String(err));
}