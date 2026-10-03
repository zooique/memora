/**
 * 单元测试：TypedEventEmitter 类型安全事件发射器
 *
 * 覆盖 on / off / once / emit / removeAllListeners 全部 5 个方法：
 *   - on + emit 基本订阅-发射
 *   - off 取消订阅（同一引用）
 *   - once 仅触发一次
 *   - emit 无监听器时不抛错
 *   - emit 处理器异常隔离（不中断其他处理器，logger 记录）
 *   - removeAllListeners 清空所有监听器
 *   - Set 去重（同一函数引用多次 on 只触发一次）
 *   - 不同事件名隔离
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TypedEventEmitter } from '@/utils/eventEmitter.js';
import { setLogger } from '@/utils/loggerHolder.js';

// 测试用事件映射类型
interface TestEventMap {
  foo: { value: number };
  bar: { text: string };
}

// 创建具体子类以测试 protected emit / removeAllListeners
class TestEmitter extends TypedEventEmitter<TestEventMap> {
  public doEmit<K extends keyof TestEventMap & string>(event: K, payload: TestEventMap[K]): void {
    this.emit(event, payload);
  }
  public doRemoveAll(): void {
    this.removeAllListeners();
  }
}

describe('utils/eventEmitter · TypedEventEmitter', () => {
  let emitter: TestEmitter;

  beforeEach(() => {
    emitter = new TestEmitter();
    // 重置 logger 为 noop，避免上个测试注入的 mock 干扰
    setLogger(undefined);
  });

  describe('on + emit', () => {
    it('应在 emit 时调用 on 注册的处理器', () => {
      const handler = vi.fn();
      emitter.on('foo', handler);
      emitter.doEmit('foo', { value: 42 });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ value: 42 });
    });

    it('应支持多个处理器同时订阅同一事件', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      emitter.on('foo', h1);
      emitter.on('foo', h2);
      emitter.doEmit('foo', { value: 1 });
      expect(h1).toHaveBeenCalledTimes(1);
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('同一函数引用多次 on 应去重（Set 语义）', () => {
      const handler = vi.fn();
      emitter.on('foo', handler);
      emitter.on('foo', handler); // 同一引用
      emitter.doEmit('foo', { value: 1 });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('不同事件名应隔离', () => {
      const fooHandler = vi.fn();
      const barHandler = vi.fn();
      emitter.on('foo', fooHandler);
      emitter.on('bar', barHandler);
      emitter.doEmit('foo', { value: 1 });
      expect(fooHandler).toHaveBeenCalledTimes(1);
      expect(barHandler).not.toHaveBeenCalled();
    });

    it('emit 无监听器时不应抛错', () => {
      expect(() => emitter.doEmit('foo', { value: 1 })).not.toThrow();
    });
  });

  describe('off', () => {
    it('应取消订阅指定处理器', () => {
      const handler = vi.fn();
      emitter.on('foo', handler);
      emitter.off('foo', handler);
      emitter.doEmit('foo', { value: 1 });
      expect(handler).not.toHaveBeenCalled();
    });

    it('off 未注册的处理器不应抛错', () => {
      const handler = vi.fn();
      expect(() => emitter.off('foo', handler)).not.toThrow();
    });

    it('off 不同事件名的处理器不应影响其他事件', () => {
      const fooHandler = vi.fn();
      emitter.on('foo', fooHandler);
      emitter.off('bar', fooHandler); // bar 上没有这个 handler
      emitter.doEmit('foo', { value: 1 });
      expect(fooHandler).toHaveBeenCalledTimes(1);
    });

    it('off 后再 on 同一处理器应恢复订阅', () => {
      const handler = vi.fn();
      emitter.on('foo', handler);
      emitter.off('foo', handler);
      emitter.on('foo', handler);
      emitter.doEmit('foo', { value: 1 });
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  describe('once', () => {
    it('once 注册的处理器应只触发一次', () => {
      const handler = vi.fn();
      emitter.once('foo', handler);
      emitter.doEmit('foo', { value: 1 });
      emitter.doEmit('foo', { value: 2 });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ value: 1 });
    });

    it('once 不应影响其他 on 注册的处理器', () => {
      const onceHandler = vi.fn();
      const onHandler = vi.fn();
      emitter.once('foo', onceHandler);
      emitter.on('foo', onHandler);
      emitter.doEmit('foo', { value: 1 });
      emitter.doEmit('foo', { value: 2 });
      expect(onceHandler).toHaveBeenCalledTimes(1);
      expect(onHandler).toHaveBeenCalledTimes(2);
    });

    it('once 处理器触发后应可再次 on 注册', () => {
      const handler = vi.fn();
      emitter.once('foo', handler);
      emitter.doEmit('foo', { value: 1 });
      emitter.on('foo', handler);
      emitter.doEmit('foo', { value: 2 });
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('emit 异常隔离', () => {
    it('单个处理器抛错不应中断其他处理器分发', () => {
      const goodHandler = vi.fn();
      const badHandler = vi.fn(() => {
        throw new Error('处理器异常');
      });
      // 先注册 bad，再注册 good，验证 bad 抛错后 good 仍被调用
      emitter.on('foo', badHandler);
      emitter.on('foo', goodHandler);
      expect(() => emitter.doEmit('foo', { value: 1 })).not.toThrow();
      expect(badHandler).toHaveBeenCalledTimes(1);
      expect(goodHandler).toHaveBeenCalledTimes(1);
    });

    it('处理器抛错应记录到 logger.warn', () => {
      const warnSpy = vi.fn();
      setLogger({
        debug: () => {},
        info: () => {},
        warn: warnSpy,
        error: () => {},
      });
      emitter.on('foo', () => {
        throw new Error('测试异常');
      });
      emitter.doEmit('foo', { value: 1 });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeAllListeners', () => {
    it('应清空所有事件的所有监听器', () => {
      const fooHandler = vi.fn();
      const barHandler = vi.fn();
      emitter.on('foo', fooHandler);
      emitter.on('bar', barHandler);
      emitter.doRemoveAll();
      emitter.doEmit('foo', { value: 1 });
      emitter.doEmit('bar', { text: 'x' });
      expect(fooHandler).not.toHaveBeenCalled();
      expect(barHandler).not.toHaveBeenCalled();
    });

    it('清空后可重新订阅', () => {
      const handler = vi.fn();
      emitter.on('foo', handler);
      emitter.doRemoveAll();
      emitter.on('foo', handler);
      emitter.doEmit('foo', { value: 1 });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('无监听器时调用 removeAllListeners 不应抛错', () => {
      expect(() => emitter.doRemoveAll()).not.toThrow();
    });
  });
});

/**
 * contextCompressed 载荷的 target 枚举守卫（CTX-WIN-2 落地连带）
 *
 * 守卫的是**类型层漂移**这一类伤：`AgentEventMap.contextCompressed.target` 曾另写一份
 * 字面量联合（与 loop 的 CompressTarget 平行），枚举增补 `earliest_steps` 时不跟随 ⇒
 * 事件类型不认新值 + 宿主文案落到旧标签。类型层已改为引用 CompressTarget，
 * 本用例锁住运行期一致性（键集与 COMPRESS_TARGETS 双向相等 + 标签非空）。
 */
describe('contextCompressed 载荷 · target 枚举一致性', () => {
  it('COMPRESS_TARGET_LABELS 键集与 COMPRESS_TARGETS 双向相等（穷尽 Record 已保证编译期，此处锁运行期）', async () => {
    const { COMPRESS_TARGETS, COMPRESS_TARGET_LABELS } = await import('@/agent/loop.js');
    expect(Object.keys(COMPRESS_TARGET_LABELS).sort()).toEqual([...COMPRESS_TARGETS].sort());
    // 每个 target 都有非空中文标签（空标签 = notice 渲染出「上下文已压缩：，替换…」）
    for (const t of COMPRESS_TARGETS) {
      expect(COMPRESS_TARGET_LABELS[t].length).toBeGreaterThan(0);
    }
  });

  it('新增 target 时标签表必须同步（点名的具体伤：earliest_steps 曾被宿主三元显示成「最大工具结果摘要」）', async () => {
    const { COMPRESS_TARGET_LABELS } = await import('@/agent/loop.js');
    expect(COMPRESS_TARGET_LABELS.earliest_steps).toBe('最早执行步骤摘要');
    // 三者互不相同——若两个 target 共用同一标签，notice 就无法区分实际压了什么
    const labels = Object.values(COMPRESS_TARGET_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
