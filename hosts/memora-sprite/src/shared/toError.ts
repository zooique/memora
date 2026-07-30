/**
 * 纯逻辑 toError — 零依赖，浏览器 / Node.js 通用
 *
 * 将 catch 块中的 unknown 值安全转换为 Error 对象。
 *
 * 转换规则（5 分支，与内核 src/utils/toError.ts 行为完全对齐）：
 *   1. Error 实例：原样返回
 *   2. 字符串：包装为 Error
 *   3. 含 message 属性的对象：提取 message 包装为 Error
 *   4. 普通对象（无 message）：JSON 序列化（try-catch 防循环引用）
 *   5. 其他类型（number/boolean/symbol/null/undefined）：String() 转换
 *
 * null/undefined 返回 '未知错误'，比 'null'/'undefined' 更友好。
 *
 * 为什么 shared 层有副本而非从 'memora' 导入：
 * 渲染进程是浏览器环境，无法解析裸模块标识符 'memora'（ESM 规范要求相对路径）。
 * MIND-D4 原始方案是创建 @memora/shared 零依赖包统一真理源，
 * 在该包创建之前，shared 层副本是必要妥协（ADR-002 内核/宿主分离约束）。
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
