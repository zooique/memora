/**
 * Mixin 工具函数：将多个 mixin 对象的方法复制到目标类的原型上
 *
 * 用于 UIManager 委托方法群的物理隔离——委托方法定义在独立文件中，
 * 通过此函数在运行时注入到 UIManager.prototype。
 *
 * 设计原则：
 * - 纯运行时工具，不引入类型约束（类型安全由 interface extends 保证）
 * - 遍历 mixin 对象的自身属性，跳过非函数属性
 */

/**
 * 将 mixin 对象的方法复制到目标类的原型上
 *
 * @param target 目标类构造器（如 UIManager）
 * @param mixins mixin 对象数组，每个对象包含一组方法
 */
export function applyMixins(
  target: new (...args: unknown[]) => unknown,
  mixins: readonly object[],
): void {
  const proto = target.prototype as Record<string, unknown>;
  for (const mixin of mixins) {
    for (const name of Object.getOwnPropertyNames(mixin)) {
      const value = (mixin as Record<string, unknown>)[name];
      if (name !== 'prototype' && typeof value === 'function') {
        proto[name] = value;
      }
    }
  }
}
