/**
 * 同步单例工厂（ADR-017 枝叶层 2 次提取）
 *
 * 职责：
 *   封装"let 变量 + 懒创建 + 返回实例"的同步单例模式，
 *   消除各模块重复的样板代码。
 *
 * 设计原则：
 *   - 纯函数 + 闭包，零运行时依赖
 *   - 仅封装同步创建场景；异步创建（如动态 import + 降级）因内部逻辑差异大，
 *     不强行抽象（参数化复杂度抵消复用收益）
 *   - 实例闭包私有，外部仅通过返回的 getter 访问
 *   - 使用 sentinel 区分"未初始化"与"已初始化为 null/undefined"，
 *     避免 factory 返回 null 时重复创建
 *
 * 使用示例：
 *   ```typescript
 *   export const getCompletionMetrics = createSingleton(() => new CompletionMetrics());
 *   ```
 *
 * 架构位置：
 *   - 位于 shared/ 层（与 toError / dateUtils / truncate 同级）
 *   - 不与内核 memora 共享（ADR-002 内核零依赖约束）
 */

// sentinel 值：区分"未初始化"与"已初始化为 null/undefined"
// 使用唯一 Symbol 保证不与任何 factory 返回值冲突
const NOT_INITIALIZED = Symbol('NOT_INITIALIZED');

/**
 * 创建同步单例 getter
 *
 * 首次调用时执行 factory 创建实例并缓存，后续调用返回同一实例。
 * factory 仅执行一次（懒加载）。即使 factory 返回 null/undefined 也会被正确缓存。
 *
 * @param factory 实例工厂函数（同步，无参，返回 T）
 * @returns 单例 getter 函数，调用返回缓存的 T 实例
 */
export function createSingleton<T>(factory: () => T): () => T {
  // 使用 sentinel 初始化，避免 null/undefined 与"未初始化"状态混淆
  let instance: T | typeof NOT_INITIALIZED = NOT_INITIALIZED;
  return () => {
    // 首次调用时创建实例（懒加载）
    if (instance === NOT_INITIALIZED) {
      instance = factory();
    }
    return instance;
  };
}
