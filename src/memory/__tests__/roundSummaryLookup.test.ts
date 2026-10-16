/**
 * 对拍测试：round-summary 联动裁决双路径（寻址单源 + 处置语义分叉）
 *
 * 背景（memory-as-summary.md §5.1 删除规则表）：「Round 退出 → 派生摘要处置」共 4 个面，
 * 其中软删面（MemoryInspector.softDeleteRoundSummaries，宿主删会话/回溯截断/孤儿清扫）
 * 与物理 purge 面（GCService.cleanUpRoundSummary）共用寻址单源 roundSummaryLookup，
 * 但处置语义有意分叉（用户删可反悔 / GC 不可反悔）。
 *
 * 本文件对拍两条路径（先例：roundRefLifecycle.test.ts 跨层引入内核实现）：
 *   - 选择集一致性：同一 roundId（含多会话命名空间两段式 ID）两路径命中完全相同
 *   - 处置分叉：软删 → 进回收站 + 溯源脱钩；GC → 物理消失（不进回收站）
 *   - 顺序语义：先软删后 GC 不重复处置（getBySource 只见活跃面）
 *   - 寻址边界：roundId 缺失的摘要不属于派生集，两路径都不动
 */
import { describe, expect, it, vi } from 'vitest';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import { GCService } from '@/memory/gcService.js';
import { findRoundSummaries } from '@/memory/roundSummaryLookup.js';
import { MemoryInspector } from '@/agent/managers/memoryInspector.js';
import { createPendingRound, completeRound } from '@/memory/roundStore.js';
import type { Memory } from '@/memory/types.js';
import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory } from '@/agent/messageHistory.js';

/** 测试轮次 ID（两段式摘要的溯源目标） */
const ROUND_ID = 'r-lookup-1';
/** 非目标轮次 ID（验证选择集不越界） */
const OTHER_ROUND_ID = 'r-lookup-2';

/**
 * 造一条规范两段式 round-summary（roundSummaryGenerator 实际写入形态）
 *
 * @param session 会话段（同轮可被多会话引用 → 验证全命名空间覆盖）
 * @param roundId 溯源轮次 ID
 */
function seedSummary(session: string, roundId: string): Memory {
  return {
    id: `round-summary:${session}:${roundId}`,
    content: `摘要 ${session}`,
    source: 'round-summary',
    name: roundId,
    sessionName: session,
    roundId,
    createdAt: '2026-10-16T08:00:00.000Z',
    accessedAt: '2026-10-16T08:00:00.000Z',
  } as Memory;
}

/** Mock AgentLoop（MemoryInspector 构造依赖，仅实现被消费的 getMessages） */
function createMockLoop(): AgentLoop {
  return { getMessages: vi.fn(() => []) } as unknown as AgentLoop;
}

/** Mock MessageHistory（同上） */
function createMockHistory(): MessageHistory {
  return { getMessages: vi.fn(() => []) } as unknown as MessageHistory;
}

describe('roundSummaryLookup · 联动裁决双路径对拍', () => {
  describe('寻址单源（选择集一致性）', () => {
    it('findRoundSummaries 覆盖全部会话命名空间，不越界到其他轮', () => {
      const storage = new InMemoryStorage();
      storage.upsert(seedSummary('2026-10-15-a', ROUND_ID));
      storage.upsert(seedSummary('2026-10-16-b', ROUND_ID));
      storage.upsert(seedSummary('2026-10-16-b', OTHER_ROUND_ID));

      const hits = findRoundSummaries(storage, new Set([ROUND_ID]));

      expect(hits).toHaveLength(2);
      expect(hits.map((m) => m.id).sort()).toEqual([
        'round-summary:2026-10-15-a:r-lookup-1',
        'round-summary:2026-10-16-b:r-lookup-1',
      ]);
    });

    it('空集合不触碰存储（免全量扫描）', () => {
      const storage = new InMemoryStorage();
      storage.upsert(seedSummary('2026-10-16-b', ROUND_ID));

      expect(findRoundSummaries(storage, new Set())).toEqual([]);
    });

    it('roundId 缺失的历史摘要不属派生集（两路径共同不触碰）', () => {
      const storage = new InMemoryStorage();
      const legacy = { ...seedSummary('2026-10-16-b', ROUND_ID), roundId: undefined } as Memory;
      storage.upsert(legacy);

      expect(findRoundSummaries(storage, new Set([ROUND_ID]))).toEqual([]);
    });
  });

  describe('处置语义对拍（软删 vs 物理 purge 有意分叉）', () => {
    it('同一 roundId：软删面进回收站 + 溯源脱钩；GC 面物理消失不进回收站', () => {
      // 路径 A：宿主软删面
      const softStorage = new InMemoryStorage();
      softStorage.upsert(seedSummary('2026-10-15-a', ROUND_ID));
      const inspector = new MemoryInspector(softStorage, createMockLoop(), createMockHistory());

      const count = inspector.softDeleteRoundSummaries([ROUND_ID]);

      expect(count).toBe(1);
      // 活跃面消失
      expect(softStorage.getById(`round-summary:2026-10-15-a:${ROUND_ID}`)).toBeNull();
      // 进回收站（可恢复）
      const trashed = softStorage.listDeleted();
      expect(trashed).toHaveLength(1);
      // 溯源脱钩（恢复后为独立记忆）
      expect(trashed[0]!.roundId).toBeUndefined();
      expect(trashed[0]!.sessionName).toBeUndefined();

      // 路径 B：GC 面（同一选择集，物理 purge）
      const purgeStorage = new InMemoryStorage();
      purgeStorage.upsert(seedSummary('2026-10-15-a', ROUND_ID));
      const roundStore = new InMemoryRoundStore();
      const round = completeRound(createPendingRound('q'), 'a');
      round.id = ROUND_ID;
      round.refCount = 0;
      roundStore.save(round);
      const gc = new GCService(roundStore, purgeStorage, {
        minAgeMs: 0,
        batchSize: 10,
        cleanUpMemory: true,
        verbose: false,
      });

      const result = gc.run();

      expect(result.memoryCleaned).toBe(1);
      // 物理消失：活跃面与回收站都不在（不可恢复——系统治理决定）
      expect(purgeStorage.getById(`round-summary:2026-10-15-a:${ROUND_ID}`)).toBeNull();
      expect(purgeStorage.listDeleted()).toHaveLength(0);
    });

    it('顺序语义：先软删后 GC 不重复处置（软删摘要退出活跃面，GC 选择集为空）', () => {
      const storage = new InMemoryStorage();
      storage.upsert(seedSummary('2026-10-15-a', ROUND_ID));
      const inspector = new MemoryInspector(storage, createMockLoop(), createMockHistory());

      inspector.softDeleteRoundSummaries([ROUND_ID]);

      // 软删后选择集为空 → GC 无残留可处置（无双写残留）
      expect(findRoundSummaries(storage, new Set([ROUND_ID]))).toEqual([]);
    });

    it('GC 只按引用归零的轮处置，非目标轮的摘要保留', () => {
      const storage = new InMemoryStorage();
      storage.upsert(seedSummary('2026-10-16-b', OTHER_ROUND_ID));
      const roundStore = new InMemoryRoundStore();
      const other = completeRound(createPendingRound('q'), 'a');
      other.id = OTHER_ROUND_ID;
      other.refCount = 1; // 仍被会话引用
      roundStore.save(other);
      const gc = new GCService(roundStore, storage, {
        minAgeMs: 0,
        batchSize: 10,
        cleanUpMemory: true,
        verbose: false,
      });

      const result = gc.run();

      expect(result.memoryCleaned).toBe(0);
      expect(storage.getById(`round-summary:2026-10-16-b:${OTHER_ROUND_ID}`)).not.toBeNull();
    });
  });
});
