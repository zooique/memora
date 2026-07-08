/**
 * MemoryDecayScheduler 单元测试
 *
 * 覆盖范围：
 *   - runOnce()：衰减执行 + 指标统计 + 事件发射 + 异常处理
 *   - start()/stop()：定时器生命周期
 *   - getMetrics()：指标快照
 *   - Tracer Span 埋点
 *
 * 测试范式：mock IMemoryStorageLike + mock ITracer + 真实 MemoryDecayScheduler 实例
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryDecayScheduler, type IMemoryStorageLike } from '@/agent/managers/memoryDecayScheduler.js';
import { TRACE_SPANS, type ITracer, type ISpan } from '@/agent/tracer.js';

// ─── 测试夹具 ─────────────────────────────────────────────

/**
 * 构造 mock storage（decayScores 可控制返回值和抛错）
 * @param decayedCount decayScores 返回值（默认 5）
 * @returns mock IMemoryStorageLike
 */
function createMockStorage(decayedCount: number = 5): IMemoryStorageLike & {
  calls: { sources: string[]; now: Date }[];
  setDecayedCount: (n: number) => void;
  setThrow: (e: Error | null) => void;
} {
  let count = decayedCount;
  let throwErr: Error | null = null;
  const calls: { sources: string[]; now: Date }[] = [];
  return {
    decayScores(sources: string[], now: Date): number {
      calls.push({ sources, now });
      if (throwErr) throw throwErr;
      return count;
    },
    calls,
    setDecayedCount: (n: number) => { count = n; },
    setThrow: (e: Error | null) => { throwErr = e; },
  };
}

/**
 * 构造 mock ITracer（记录 span 调用）
 */
function createMockTracer(): {
  tracer: ITracer;
  spans: { name: string; ended: boolean; exceptions: Error[]; attributes: Record<string, string | number | boolean> }[];
} {
  const spans: { name: string; ended: boolean; exceptions: Error[]; attributes: Record<string, string | number | boolean> }[] = [];
  const tracer: ITracer = {
    startSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan {
      const record = { name, ended: false, exceptions: [] as Error[], attributes: { ...attributes } };
      spans.push(record);
      return {
        setAttribute(key: string, value: string | number | boolean): void {
          record.attributes[key] = value;
        },
        end(): void { record.ended = true; },
        recordException(error: Error): void { record.exceptions.push(error); },
      };
    },
  };
  return { tracer, spans };
}

/** mock onDecayCompleted 回调 */
function createMockCallback(): {
  callback: (payload: { decayedCount: number }) => void;
  calls: { decayedCount: number }[];
} {
  const calls: { decayedCount: number }[] = [];
  const callback = (payload: { decayedCount: number }) => { calls.push(payload); };
  return { callback, calls };
}

// ─── 测试用例 ─────────────────────────────────────────────

describe('MemoryDecayScheduler', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let tracer: ReturnType<typeof createMockTracer>;
  let cb: ReturnType<typeof createMockCallback>;
  let scheduler: MemoryDecayScheduler;

  beforeEach(() => {
    storage = createMockStorage();
    tracer = createMockTracer();
    cb = createMockCallback();
    scheduler = new MemoryDecayScheduler({
      tracer: tracer.tracer,
      onDecayCompleted: cb.callback,
    });
  });

  describe('runOnce()', () => {
    it('未 start 时调用应静默返回（storage 为 null）', () => {
      scheduler.runOnce();
      expect(storage.calls).toHaveLength(0);
      expect(cb.calls).toHaveLength(0);
    });

    it('start 后调用应执行衰减并发射事件', () => {
      scheduler.start(storage, 60_000);
      // start 会立即执行一次 runOnce
      expect(storage.calls).toHaveLength(1);
      expect(cb.calls).toHaveLength(1);
      expect(cb.calls[0]).toEqual({ decayedCount: 5 });
    });

    it('应传递正确的 sources（insight/profile/work-projection）', () => {
      scheduler.start(storage, 60_000);
      expect(storage.calls[0]!.sources).toContain('insight');
      expect(storage.calls[0]!.sources).toContain('profile');
      expect(storage.calls[0]!.sources).toContain('work-projection');
    });

    it('应传递当前时间作为 now 参数', () => {
      scheduler.start(storage, 60_000);
      const now = storage.calls[0]!.now;
      expect(now).toBeInstanceOf(Date);
      // 时间应在合理范围内（1 秒内）
      expect(Date.now() - now.getTime()).toBeLessThan(1000);
    });

    it('storage 抛错时应记录异常但不中断调度器', () => {
      storage.setThrow(new Error('storage 不可用'));
      scheduler.start(storage, 60_000);
      // 衰减异常不应导致事件发射
      expect(cb.calls).toHaveLength(0);
      // 但 span 应记录异常
      expect(tracer.spans).toHaveLength(1);
      expect(tracer.spans[0]!.exceptions).toHaveLength(1);
      expect(tracer.spans[0]!.exceptions[0]!.message).toBe('storage 不可用');
    });
  });

  describe('指标统计', () => {
    it('runOnce 应累加 runCount 和 totalDecayedCount', () => {
      scheduler.start(storage, 60_000); // 立即执行 1 次，decayedCount=5
      storage.setDecayedCount(3);
      scheduler.runOnce(); // 手动执行 1 次，decayedCount=3

      const metrics = scheduler.getMetrics();
      expect(metrics.runCount).toBe(2);
      expect(metrics.totalDecayedCount).toBe(8); // 5 + 3
    });

    it('lastRunAt 应在每次 runOnce 后更新', () => {
      expect(scheduler.getMetrics().lastRunAt).toBeNull();
      scheduler.start(storage, 60_000);
      const firstRunAt = scheduler.getMetrics().lastRunAt;
      expect(firstRunAt).not.toBeNull();
      // 等待一小段时间后再次执行
      scheduler.runOnce();
      const secondRunAt = scheduler.getMetrics().lastRunAt;
      expect(secondRunAt).not.toBeNull();
    });

    it('storage 抛错时不应更新指标', () => {
      storage.setThrow(new Error('storage 不可用'));
      scheduler.start(storage, 60_000); // 异常执行
      const metrics = scheduler.getMetrics();
      expect(metrics.runCount).toBe(0);
      expect(metrics.totalDecayedCount).toBe(0);
    });
  });

  describe('Tracer Span 埋点', () => {
    it('runOnce 应启动 DECAY span 并在成功时 end', () => {
      scheduler.start(storage, 60_000);
      expect(tracer.spans).toHaveLength(1);
      expect(tracer.spans[0]!.name).toBe(TRACE_SPANS.DECAY);
      expect(tracer.spans[0]!.ended).toBe(true);
      expect(tracer.spans[0]!.exceptions).toHaveLength(0);
    });

    it('span 应记录 decayedCount 和 totalRuns 属性', () => {
      scheduler.start(storage, 60_000);
      const span = tracer.spans[0]!;
      expect(span.attributes.decayedCount).toBe(5);
      expect(span.attributes.totalRuns).toBe(1);
    });

    it('storage 抛错时 span 应 recordException 并 end', () => {
      storage.setThrow(new Error('storage 不可用'));
      scheduler.start(storage, 60_000);
      const span = tracer.spans[0]!;
      expect(span.exceptions).toHaveLength(1);
      expect(span.ended).toBe(true);
    });
  });

  describe('start()/stop() 生命周期', () => {
    it('stop 后 runOnce 应静默返回', () => {
      scheduler.start(storage, 60_000);
      scheduler.stop();
      const beforeCalls = storage.calls.length;
      scheduler.runOnce();
      expect(storage.calls.length).toBe(beforeCalls);
    });

    it('stop 后 getMetrics 应保留历史指标', () => {
      scheduler.start(storage, 60_000);
      scheduler.stop();
      const metrics = scheduler.getMetrics();
      expect(metrics.runCount).toBe(1);
      expect(metrics.totalDecayedCount).toBe(5);
    });

    it('多次 start/stop 循环应正常工作', () => {
      scheduler.start(storage, 60_000);
      scheduler.stop();
      scheduler.start(storage, 60_000);
      scheduler.stop();
      const metrics = scheduler.getMetrics();
      expect(metrics.runCount).toBe(2);
    });
  });

  describe('未注入 Tracer 时降级', () => {
    it('未注入 tracer 时应降级为 NOOP_TRACER（不抛错）', () => {
      const cb2 = createMockCallback();
      const schedulerNoTracer = new MemoryDecayScheduler({
        onDecayCompleted: cb2.callback,
      });
      const storage2 = createMockStorage(10);
      schedulerNoTracer.start(storage2, 60_000);
      // 应正常执行，不抛错
      expect(cb2.calls).toHaveLength(1);
      expect(cb2.calls[0]!.decayedCount).toBe(10);
    });
  });
});
