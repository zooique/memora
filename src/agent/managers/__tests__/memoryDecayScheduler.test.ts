/**
 * MemoryDecayScheduler 单元测试
 *
 * 覆盖范围：
 *   - runOnce()：衰减执行 + 指标统计 + 事件发射 + 异常处理
 *   - start()/stop()：定时器生命周期
 *   - getMetrics()：指标快照
 *   - Tracer Span 埋点
 *   - evaluateTimeliness()：L2 时效性评估（降级 / 核心流程 / 限制排序 / 异常处理）
 *
 * 测试范式：mock IMemoryStorageLike + mock ITracer + 真实 MemoryDecayScheduler 实例
 *           L2 测试额外 mock LlmProvider + IMemoryStorage（getBySource + upsert）
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryDecayScheduler, type IMemoryStorageLike } from '@/agent/managers/memoryDecayScheduler.js';
import { TRACE_SPANS, type ITracer, type ISpan } from '@/agent/tracer.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';

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

// ─── L2 时效性评估测试夹具 ─────────────────────────────────

/** mock LLM 响应类型：正常 JSON 或抛错 */
type MockLlmResponse =
  | { type: 'json'; content: string }
  | { type: 'error'; message: string };

/**
 * 构造 mock LlmProvider（按调用顺序返回预设响应队列）
 *
 * @param responseQueue LLM 响应队列（按 chat 调用顺序消费，耗尽后返回默认"未过时"）
 * @returns mock LlmProvider 实例（chatCalls 记录每次调用的 messages）
 */
function createMockLlmProvider(
  responseQueue: MockLlmResponse[] = [],
): LlmProvider & { chatCalls: Message[][] } {
  const chatCalls: Message[][] = [];
  const queue = [...responseQueue];
  return {
    name: 'mock-timeliness-provider',
    chatCalls,
    chat(messages: Message[]): AsyncIterable<LlmChunk> {
      chatCalls.push(messages);
      const resp = queue.shift() ?? { type: 'json' as const, content: '{"isOutdated": false, "reason": "默认未过时"}' };
      return (async function* () {
        if (resp.type === 'error') throw new Error(resp.message);
        yield { content: resp.content } as LlmChunk;
      })();
    },
  } as unknown as LlmProvider & { chatCalls: Message[][] };
}

/**
 * 构造 mock IMemoryStorage（仅实现 evaluateTimeliness 所需的 getBySource + upsert）
 *
 * @param memoriesBySource 按 source 分组的预设记忆
 * @returns mock IMemoryStorage 实例（upsertCalls 记录所有 upsert 调用）
 */
function createMockMemoryStorage(
  memoriesBySource: Record<string, Memory[]> = {},
): IMemoryStorage & { upsertCalls: Memory[] } {
  const store = new Map<string, Memory[]>(Object.entries(memoriesBySource));
  const upsertCalls: Memory[] = [];
  return {
    getBySource(source: string): Memory[] {
      return store.get(source) ?? [];
    },
    upsert(memory: Memory): void {
      upsertCalls.push(memory);
    },
    upsertCalls,
  } as unknown as IMemoryStorage & { upsertCalls: Memory[] };
}

/**
 * 构造测试用 Memory 对象（提供合理默认值，仅需指定 id/name/source）
 * @param overrides 覆盖字段（必须包含 id/name/source）
 * @returns 符合 MemorySchema 的记忆对象
 */
function createMemory(overrides: Partial<Memory> & { id: string; name: string; source: string }): Memory {
  return {
    content: '测试记忆内容',
    createdAt: '2025-01-01T00:00:00.000Z',
    accessedAt: '2025-01-01T00:00:00.000Z',
    score: 0.2,
    ...overrides,
  };
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

  // ─── L2 时效性评估 ──────────────────────────────────────

  describe('evaluateTimeliness() · L2 时效性评估', () => {
    let mockStorage: ReturnType<typeof createMockMemoryStorage>;
    let mockProvider: ReturnType<typeof createMockLlmProvider>;
    let l2Scheduler: MemoryDecayScheduler;

    beforeEach(() => {
      mockStorage = createMockMemoryStorage();
      mockProvider = createMockLlmProvider();
      l2Scheduler = new MemoryDecayScheduler({
        tracer: tracer.tracer,
        onDecayCompleted: cb.callback,
        backgroundProvider: mockProvider,
        index: mockStorage,
      });
    });

    describe('降级场景', () => {
      it('backgroundProvider 未注入时返回 skippedReason', async () => {
        const schedulerNoProvider = new MemoryDecayScheduler({
          onDecayCompleted: cb.callback,
          index: mockStorage,
        });
        const report = await schedulerNoProvider.evaluateTimeliness();
        expect(report.scannedCount).toBe(0);
        expect(report.outdatedCount).toBe(0);
        expect(report.demotedIds).toEqual([]);
        expect(report.skippedReason).toBe('backgroundProvider 或 index 未注入');
      });

      it('index 未注入时返回 skippedReason', async () => {
        const schedulerNoIndex = new MemoryDecayScheduler({
          onDecayCompleted: cb.callback,
          backgroundProvider: mockProvider,
        });
        const report = await schedulerNoIndex.evaluateTimeliness();
        expect(report.scannedCount).toBe(0);
        expect(report.skippedReason).toBe('backgroundProvider 或 index 未注入');
      });

      it('无低分记忆时返回 skippedReason', async () => {
        mockStorage = createMockMemoryStorage({
          [SOURCE_LABELS.INSIGHT]: [
            createMemory({ id: 'insight:1', name: 'm1', source: 'insight', score: 0.5 }),
          ],
        });
        l2Scheduler = new MemoryDecayScheduler({
          tracer: tracer.tracer,
          onDecayCompleted: cb.callback,
          backgroundProvider: mockProvider,
          index: mockStorage,
        });
        const report = await l2Scheduler.evaluateTimeliness();
        expect(report.scannedCount).toBe(0);
        expect(report.skippedReason).toBe('无低分记忆需评估');
      });
    });

    describe('核心流程', () => {
      it('LLM 判定过时时降级 score 到 0.05', async () => {
        mockStorage = createMockMemoryStorage({
          [SOURCE_LABELS.INSIGHT]: [
            createMemory({ id: 'insight:old', name: '旧版本记忆', source: 'insight', score: 0.15, content: '用户使用 React 16 开发' }),
          ],
        });
        mockProvider = createMockLlmProvider([
          { type: 'json', content: '{"isOutdated": true, "reason": "React 16 已过时"}' },
        ]);
        l2Scheduler = new MemoryDecayScheduler({
          tracer: tracer.tracer,
          onDecayCompleted: cb.callback,
          backgroundProvider: mockProvider,
          index: mockStorage,
        });

        const report = await l2Scheduler.evaluateTimeliness();
        expect(report.scannedCount).toBe(1);
        expect(report.outdatedCount).toBe(1);
        expect(report.demotedIds).toEqual(['insight:old']);
        // 验证降级写入：score 被设为 0.05，id 保持不变
        expect(mockStorage.upsertCalls).toHaveLength(1);
        expect(mockStorage.upsertCalls[0]!.score).toBe(0.05);
        expect(mockStorage.upsertCalls[0]!.id).toBe('insight:old');
      });

      it('LLM 判定未过时时保持原 score（不调用 upsert）', async () => {
        mockStorage = createMockMemoryStorage({
          [SOURCE_LABELS.PROFILE]: [
            createMemory({ id: 'profile:1', name: '用户偏好', source: 'profile', score: 0.2, content: '用户偏好函数式编程' }),
          ],
        });
        mockProvider = createMockLlmProvider([
          { type: 'json', content: '{"isOutdated": false, "reason": "编程风格偏好通常是长期的"}' },
        ]);
        l2Scheduler = new MemoryDecayScheduler({
          tracer: tracer.tracer,
          onDecayCompleted: cb.callback,
          backgroundProvider: mockProvider,
          index: mockStorage,
        });

        const report = await l2Scheduler.evaluateTimeliness();
        expect(report.outdatedCount).toBe(0);
        expect(report.demotedIds).toEqual([]);
        // 未过时 → 不应触发 upsert
        expect(mockStorage.upsertCalls).toHaveLength(0);
      });

      it('多 source 低分记忆混合收集', async () => {
        mockStorage = createMockMemoryStorage({
          [SOURCE_LABELS.INSIGHT]: [
            createMemory({ id: 'insight:1', name: 'i1', source: 'insight', score: 0.1 }),
          ],
          [SOURCE_LABELS.PROFILE]: [
            createMemory({ id: 'profile:1', name: 'p1', source: 'profile', score: 0.15 }),
          ],
          [SOURCE_LABELS.WORK_PROJECTION]: [
            createMemory({ id: 'work:1', name: 'w1', source: 'work-projection', score: 0.2 }),
          ],
        });
        mockProvider = createMockLlmProvider([
          { type: 'json', content: '{"isOutdated": true, "reason": "过时"}' },
          { type: 'json', content: '{"isOutdated": false, "reason": "未过时"}' },
          { type: 'json', content: '{"isOutdated": true, "reason": "过时"}' },
        ]);
        l2Scheduler = new MemoryDecayScheduler({
          tracer: tracer.tracer,
          onDecayCompleted: cb.callback,
          backgroundProvider: mockProvider,
          index: mockStorage,
        });

        const report = await l2Scheduler.evaluateTimeliness();
        expect(report.scannedCount).toBe(3);
        expect(report.outdatedCount).toBe(2);
        expect(report.demotedIds).toHaveLength(2);
      });
    });

    describe('限制与排序', () => {
      it('超过 20 条时截断为 20', async () => {
        // 生成 25 条低分记忆（全部 score=0.1，低于 0.3 阈值）
        const memories: Memory[] = Array.from({ length: 25 }, (_, i) =>
          createMemory({ id: `insight:${i}`, name: `m${i}`, source: 'insight', score: 0.1 }),
        );
        mockStorage = createMockMemoryStorage({ [SOURCE_LABELS.INSIGHT]: memories });
        mockProvider = createMockLlmProvider(
          Array.from({ length: 25 }, (): MockLlmResponse => ({ type: 'json', content: '{"isOutdated": false, "reason": "未过时"}' })),
        );
        l2Scheduler = new MemoryDecayScheduler({
          tracer: tracer.tracer,
          onDecayCompleted: cb.callback,
          backgroundProvider: mockProvider,
          index: mockStorage,
        });

        const report = await l2Scheduler.evaluateTimeliness();
        expect(report.scannedCount).toBe(20);
        expect(mockProvider.chatCalls).toHaveLength(20);
      });

      it('按 score 升序排列（最低分优先评估）', async () => {
        mockStorage = createMockMemoryStorage({
          [SOURCE_LABELS.INSIGHT]: [
            createMemory({ id: 'insight:high', name: 'score较高的记忆', source: 'insight', score: 0.25 }),
            createMemory({ id: 'insight:low', name: 'score最低的记忆', source: 'insight', score: 0.05 }),
            createMemory({ id: 'insight:mid', name: 'score居中的记忆', source: 'insight', score: 0.15 }),
          ],
        });
        mockProvider = createMockLlmProvider([
          { type: 'json', content: '{"isOutdated": true, "reason": "最低分先评估"}' },
          { type: 'json', content: '{"isOutdated": false, "reason": "中间分后评估"}' },
          { type: 'json', content: '{"isOutdated": false, "reason": "最高分最后评估"}' },
        ]);
        l2Scheduler = new MemoryDecayScheduler({
          tracer: tracer.tracer,
          onDecayCompleted: cb.callback,
          backgroundProvider: mockProvider,
          index: mockStorage,
        });

        await l2Scheduler.evaluateTimeliness();
        // 验证 LLM 调用顺序：score 最低的先被评估
        const firstCallUserMsg = mockProvider.chatCalls[0]!.find(m => m.role === 'user')!.content;
        expect(firstCallUserMsg).toContain('score最低的记忆');
        const secondCallUserMsg = mockProvider.chatCalls[1]!.find(m => m.role === 'user')!.content;
        expect(secondCallUserMsg).toContain('score居中的记忆');
      });
    });

    describe('异常处理', () => {
      it('LLM 返回非法 JSON 时跳过该条', async () => {
        mockStorage = createMockMemoryStorage({
          [SOURCE_LABELS.INSIGHT]: [
            createMemory({ id: 'insight:bad', name: '非法响应', source: 'insight', score: 0.1 }),
          ],
        });
        mockProvider = createMockLlmProvider([
          { type: 'json', content: '这不是合法的 JSON' },
        ]);
        l2Scheduler = new MemoryDecayScheduler({
          tracer: tracer.tracer,
          onDecayCompleted: cb.callback,
          backgroundProvider: mockProvider,
          index: mockStorage,
        });

        const report = await l2Scheduler.evaluateTimeliness();
        expect(report.scannedCount).toBe(1);
        expect(report.outdatedCount).toBe(0);
        expect(report.demotedIds).toEqual([]);
        // 非法 JSON → 未降级 → 不应触发 upsert
        expect(mockStorage.upsertCalls).toHaveLength(0);
      });

      it('单条 LLM 调用抛错时不阻塞后续评估', async () => {
        mockStorage = createMockMemoryStorage({
          [SOURCE_LABELS.INSIGHT]: [
            createMemory({ id: 'insight:err', name: '会抛错的记忆', source: 'insight', score: 0.05 }),
            createMemory({ id: 'insight:ok', name: '正常的记忆', source: 'insight', score: 0.1 }),
          ],
        });
        mockProvider = createMockLlmProvider([
          { type: 'error', message: 'LLM 调用失败' },
          { type: 'json', content: '{"isOutdated": true, "reason": "过时"}' },
        ]);
        l2Scheduler = new MemoryDecayScheduler({
          tracer: tracer.tracer,
          onDecayCompleted: cb.callback,
          backgroundProvider: mockProvider,
          index: mockStorage,
        });

        const report = await l2Scheduler.evaluateTimeliness();
        expect(report.scannedCount).toBe(2);
        expect(report.outdatedCount).toBe(1);
        expect(report.demotedIds).toEqual(['insight:ok']);
      });

      it('部分成功部分失败的混合场景', async () => {
        // 3 条记忆按 score 升序：outdated(0.05) → badjson(0.1) → valid(0.15)
        mockStorage = createMockMemoryStorage({
          [SOURCE_LABELS.INSIGHT]: [
            createMemory({ id: 'insight:outdated', name: '过时记忆', source: 'insight', score: 0.05 }),
            createMemory({ id: 'insight:badjson', name: '非法JSON', source: 'insight', score: 0.1 }),
            createMemory({ id: 'insight:valid', name: '有效记忆', source: 'insight', score: 0.15 }),
          ],
        });
        mockProvider = createMockLlmProvider([
          { type: 'json', content: '{"isOutdated": true, "reason": "已过时"}' },
          { type: 'json', content: '非法 JSON 内容' },
          { type: 'json', content: '{"isOutdated": false, "reason": "仍有效"}' },
        ]);
        l2Scheduler = new MemoryDecayScheduler({
          tracer: tracer.tracer,
          onDecayCompleted: cb.callback,
          backgroundProvider: mockProvider,
          index: mockStorage,
        });

        const report = await l2Scheduler.evaluateTimeliness();
        expect(report.scannedCount).toBe(3);
        expect(report.outdatedCount).toBe(1);
        expect(report.demotedIds).toEqual(['insight:outdated']);
        // 仅过时记忆被降级写入
        expect(mockStorage.upsertCalls).toHaveLength(1);
        expect(mockStorage.upsertCalls[0]!.score).toBe(0.05);
      });
    });
  });
});
