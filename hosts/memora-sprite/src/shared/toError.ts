/**
 * 跨进程错误转换工具（纯函数，无 Node 依赖）
 *
 * 职责：将 unknown 类型的捕获值统一转为 Error 实例，
 * 供渲染进程、主进程、Web 模式共用。
 *
 * 设计原则：
 *   - 纯函数，零运行时依赖，可被任意进程安全导入
 *   - 行为与内核 memora/src/utils/toError 完全对齐（5 分支结构 + 相同语义）
 *   - 作为渲染进程 toError 的单一真理源（替代 errorHelpers.ts 中的本地实现）
 *
 * 架构位置：
 *   - 本模块位于 shared/ 层（纯函数，无 Node 依赖）
 *   - electron/renderer/helpers/errorHelpers.ts 从本模块导入并 re-export
 *   - 主进程继续从 memora 包导入（内核依赖合法）
 */

/**
 * 将未知错误转为 Error
 *
 * 处理优先级：
 *   1. Error 实例直接返回
 *   2. 字符串包装为 Error
 *   3. 含 message 属性的对象提取 message
 *   4. 普通对象 JSON 序列化（try-catch 防循环引用）
 *   5. 其他类型 String() 转换
 *
 * @param err 捕获的未知错误
 * @returns 转换后的 Error 实例
 */
export function toError(err: unknown): Error {
  // Error 实例直接返回（最常见路径）
  if (err instanceof Error) return err;
  // 字符串包装为 Error
  if (typeof err === 'string') return new Error(err);
  // 含 message 属性的对象（如 IPC 序列化错误）
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') {
    return new Error((err as { message: string }).message);
  }
  // 普通对象（无 message 属性）：JSON 序列化保留调试信息，try-catch 防止循环引用抛错
  if (typeof err === 'object' && err !== null) {
    try {
      return new Error(JSON.stringify(err));
    } catch {
      // 循环引用等无法序列化的情况，降级到 String()
      return new Error(String(err));
    }
  }
  // 基础类型（number/boolean/symbol/null/undefined）
  return new Error(String(err ?? '未知错误'));
}
