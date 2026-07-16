/**
 * 纯逻辑 toError — 零依赖，浏览器 / Node.js 通用
 *
 * 将 catch 块中的 unknown 值安全转换为 Error 对象。
 * 从 errors.ts 中提取，确保浏览器端可直接 import 而不引入 logging（pino）依赖。
 *
 * 转换规则（5 分支，与精灵 shared/toError.ts 行为对齐）：
 *   1. Error 实例：原样返回
 *   2. 字符串：包装为 Error
 *   3. 含 message 属性的对象：提取 message 包装为 Error
 *   4. 普通对象（无 message）：JSON 序列化（try-catch 防循环引用）
 *   5. 其他类型（number/boolean/symbol/null/undefined）：String() 转换
 *
 * null/undefined 返回 '未知错误'，比 'null'/'undefined' 更友好。
 */
export function toError(err: unknown): Error {
  // 1. Error 实例直接返回（最常见路径）
  if (err instanceof Error) return err;
  // 2. 字符串包装为 Error
  if (typeof err === 'string') return new Error(err);
  // 3. 含 message 属性的对象（如 IPC 序列化错误）提取 message
  if (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string'
  ) {
    return new Error((err as { message: string }).message);
  }
  // 4. 普通对象（无 message 属性）：JSON 序列化保留调试信息，try-catch 防止循环引用抛错
  if (typeof err === 'object' && err !== null) {
    try {
      return new Error(JSON.stringify(err));
    } catch {
      // 循环引用等无法序列化的情况，降级到 String()
      return new Error(String(err));
    }
  }
  // 5. 基础类型（number/boolean/symbol/null/undefined）
  return new Error(String(err ?? '未知错误'));
}
