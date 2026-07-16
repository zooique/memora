/**
 * 单元测试：createSingleton 同步单例工厂
 *
 * 覆盖范围：
 * - 首次调用执行 factory 创建实例
 * - 后续调用返回同一实例（引用相等）
 * - factory 仅执行一次（懒加载）
 * - 不同 createSingleton 调用相互独立
 */
import { describe, it, expect, vi } from 'vitest';
import { createSingleton } from '../../shared/singleton.js';

describe('shared/singleton · createSingleton', () => {
  it('首次调用应执行 factory 创建实例', () => {
    const factory = vi.fn(() => ({ value: 42 }));
    const getInstance = createSingleton(factory);
    const instance = getInstance();
    expect(instance).toEqual({ value: 42 });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('后续调用应返回同一实例（引用相等）', () => {
    const factory = vi.fn(() => ({ value: 'test' }));
    const getInstance = createSingleton(factory);
    const a = getInstance();
    const b = getInstance();
    expect(a).toBe(b); // 引用相等
    expect(factory).toHaveBeenCalledTimes(1); // factory 只执行一次
  });

  it('factory 仅执行一次（多次调用不重复创建）', () => {
    let callCount = 0;
    const factory = vi.fn(() => {
      callCount++;
      return { id: callCount };
    });
    const getInstance = createSingleton(factory);
    getInstance();
    getInstance();
    getInstance();
    getInstance();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(getInstance().id).toBe(1); // 仍是首次创建的实例
  });

  it('不同 createSingleton 调用应相互独立（不共享实例）', () => {
    const getInstanceA = createSingleton(() => ({ name: 'A' }));
    const getInstanceB = createSingleton(() => ({ name: 'B' }));
    expect(getInstanceA()).toEqual({ name: 'A' });
    expect(getInstanceB()).toEqual({ name: 'B' });
    expect(getInstanceA()).not.toBe(getInstanceB());
  });

  it('应支持泛型类型（类实例）', () => {
    class Counter {
      private count = 0;
      increment() {
        return ++this.count;
      }
    }
    const getCounter = createSingleton(() => new Counter());
    expect(getCounter().increment()).toBe(1);
    expect(getCounter().increment()).toBe(2); // 同一实例，count 累加
    expect(getCounter().increment()).toBe(3);
  });

  it('factory 返回 null/undefined 时应正常缓存（虽然不常见）', () => {
    const factory = vi.fn((): string | null => null);
    const getInstance = createSingleton(factory);
    expect(getInstance()).toBeNull();
    expect(getInstance()).toBeNull(); // 第二次仍返回缓存的 null
    expect(factory).toHaveBeenCalledTimes(1); // factory 只执行一次
  });
});
