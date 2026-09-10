/**
 * 单元测试：垃圾回收服务（GC Service）
 * 验证引用计数和孤立 Round 清理机制
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import { InMemoryStorage } from '@/memory/inMemoryStorage.js';
import { GCService, createDefaultGCService } from '@/memory/gcService.js';
import {
  createPendingRound,
  completeRound,
  generateSummaryId,
} from '@/memory/roundStore.js';
import type { Memory } from '@/memory/types.js';
import type { IVectorStore } from '@/memory/vectorStore.js';

describe('垃圾回收服务', () => {
  let roundStore: InMemoryRoundStore;
  let memoryStorage: InMemoryStorage;
  let gc: GCService;

  beforeEach(() => {
    roundStore = new InMemoryRoundStore();
    memoryStorage = new InMemoryStorage();
    gc = new GCService(roundStore, memoryStorage, {
      minAgeMs: 0, // 测试时设置为 0，忽略存活时间
      batchSize: 10,
      cleanUpMemory: true,
      verbose: false,
    });
  });

  describe('基本功能', () => {
    it('应该清理孤立的 Round', () => {
      // 创建孤立的 Round（refCount=0, complete 状态）
      const round = createPendingRound('孤立的问题');
      const completed = completeRound(round, '孤立的回答');
      completed.refCount = 0;
      roundStore.save(completed);

      // 验证存在
      expect(roundStore.size()).toBe(1);

      // 执行 GC
      const result = gc.run();
      expect(result.deleted).toBe(1);
      expect(result.orphaned).toBe(1);

      // 验证已清理
      expect(roundStore.size()).toBe(0);
    });

    it('不应该清理仍被引用的 Round', () => {
      // 创建被引用的 Round
      const round = createPendingRound('被引用的问题');
      const completed = completeRound(round, '被引用的回答');
      completed.refCount = 2; // 被 2 个会话引用
      roundStore.save(completed);

      // 执行 GC
      const result = gc.run();
      expect(result.deleted).toBe(0); // 不会删除
      expect(result.orphaned).toBe(0); // 不会被标记为孤立

      // 验证仍存在
      expect(roundStore.size()).toBe(1);
    });

    it('应该清理 pending 状态的孤立 Round（崩溃残留）', () => {
      // 创建 pending 状态的 Round（refCount=0 = 从未登记会话，如 appendUser 后崩溃残留）。
      // GC 不按状态过滤——pending 残留同样是孤儿，超龄（minAgeMs=0）即可回收，
      // 进行中轮由超龄判龄保护而非状态保护。
      const round = createPendingRound('待处理的问题');
      round.refCount = 0;
      roundStore.save(round);

      // 执行 GC
      const result = gc.run();
      expect(result.deleted).toBe(1);

      // 验证已清理
      expect(roundStore.size()).toBe(0);
    });

    it('不应该清理 refCount>0 的 pending Round（进行中轮）', () => {
      // 进行中轮被会话持有引用（refCount=1）：仅由删除会话/分叉释放引用，GC 不动
      const round = createPendingRound('进行中的问题');
      roundStore.save(round); // createPendingRound 默认 refCount=1

      const result = gc.run();
      expect(result.deleted).toBe(0);
      expect(result.orphaned).toBe(0);
      expect(roundStore.size()).toBe(1);
    });

    it('应该清理关联的记忆摘要', () => {
      // 创建 Round 并完成
      const round = createPendingRound('需要清理摘要');
      const completed = completeRound(round, '完成回答');
      completed.refCount = 0;
      roundStore.save(completed);

      // 创建关联的记忆摘要（规范两段式 ID，宿主实际写入形态）
      const summaryId = `round-summary:2026-09-10-main:${round.id}`;
      const summaryMemory: Memory = {
        id: summaryId,
        content: '对话摘要内容',
        source: 'round-summary',
        name: round.id,
        roundId: round.id,
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
      };
      memoryStorage.upsert(summaryMemory);

      // 验证摘要存在
      expect(memoryStorage.getById(summaryId)).not.toBeNull();

      // 执行 GC（cleanUpMemory=true）——按 roundId 顶层字段反查两段式摘要
      const result = gc.run();
      expect(result.memoryCleaned).toBe(1);

      // 验证摘要已清理
      expect(memoryStorage.getById(summaryId)).toBeNull();
    });

    it('单段 ID 摘要走兜底寻址清理（历史/异常形态）', () => {
      const round = createPendingRound('单段兜底');
      const completed = completeRound(round, '回答');
      completed.refCount = 0;
      roundStore.save(completed);

      // 单段 ID（无会话段）——两段式下不会出现，仅异常/历史数据
      const legacyId = generateSummaryId(round.id);
      memoryStorage.upsert({
        id: legacyId,
        content: '历史摘要',
        source: 'round-summary',
        name: round.id,
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
      } as Memory);

      const result = gc.run();
      expect(result.memoryCleaned).toBe(1);
      expect(memoryStorage.getById(legacyId)).toBeNull();
    });

    it('应该按批处理清理', () => {
      // 创建多个孤立的 Round
      for (let i = 0; i < 25; i++) {
        const round = createPendingRound(`问题 ${i}`);
        const completed = completeRound(round, `回答 ${i}`);
        completed.refCount = 0;
        roundStore.save(completed);
      }

      expect(roundStore.size()).toBe(25);

      // 执行 GC（batchSize=10）
      const result = gc.run();
      expect(result.deleted).toBe(25);
      expect(result.orphaned).toBe(25);

      // 验证已清理
      expect(roundStore.size()).toBe(0);
    });
  });

  describe('配置选项', () => {
    it('应该尊重 minAgeMs 配置', () => {
      // 使用较大的 minAgeMs
      const gcWithMinAge = new GCService(roundStore, memoryStorage, {
        minAgeMs: 10 * 60 * 1000, // 10 分钟
        batchSize: 10,
        cleanUpMemory: false,
        verbose: false,
      });

      // 创建孤立的 Round（存活时间不够）
      const round = createPendingRound('新的问题');
      const completed = completeRound(round, '新的回答');
      completed.refCount = 0;
      roundStore.save(completed);

      // 执行 GC
      const result = gcWithMinAge.run();
      expect(result.deleted).toBe(0); // 不会删除，存活时间不够
    });

    it('应该支持不清理记忆摘要', () => {
      const gcNoMemory = new GCService(roundStore, memoryStorage, {
        minAgeMs: 0,
        batchSize: 10,
        cleanUpMemory: false, // 不清理记忆
        verbose: false,
      });

      // 创建 Round
      const round = createPendingRound('不清理摘要');
      const completed = completeRound(round, '回答');
      completed.refCount = 0;
      roundStore.save(completed);

      // 创建关联的记忆
      const summaryId = `round-summary:2026-09-10-main:${round.id}`;
      const summaryMemory: Memory = {
        id: summaryId,
        content: '摘要内容',
        source: 'round-summary',
        name: round.id,
        roundId: round.id,
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
      };
      memoryStorage.upsert(summaryMemory);

      // 执行 GC
      const result = gcNoMemory.run();
      expect(result.deleted).toBe(1);
      expect(result.memoryCleaned).toBe(0); // 不会清理记忆

      // 验证记忆仍存在
      expect(memoryStorage.getById(summaryId)).not.toBeNull();
    });

    it('应该支持更新配置', () => {
      const config1 = gc.getConfig();
      expect(config1.batchSize).toBe(10);

      gc.updateConfig({ batchSize: 50 });

      const config2 = gc.getConfig();
      expect(config2.batchSize).toBe(50);
    });
  });

  describe('结果统计', () => {
    it('应该返回正确的统计信息', () => {
      // 创建一些 Round
      const orphaned1 = createPendingRound('孤立1');
      const completed1 = completeRound(orphaned1, '回答1');
      completed1.refCount = 0;
      roundStore.save(completed1);

      const active = createPendingRound('活跃的');
      const completedActive = completeRound(active, '活跃回答');
      completedActive.refCount = 3; // 被引用
      roundStore.save(completedActive);

      const orphaned2 = createPendingRound('孤立2');
      const completed2 = completeRound(orphaned2, '回答2');
      completed2.refCount = 0;
      roundStore.save(completed2);

      // 执行 GC
      const result = gc.run();

      // 验证统计
      expect(result.scanned).toBe(3); // 扫描了 3 个 Round
      expect(result.orphaned).toBe(2); // 2 个孤立的
      expect(result.deleted).toBe(2); // 删除了 2 个
      expect(result.failedDueToRefCount).toBe(0);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('应该处理空存储', () => {
      const result = gc.run();

      expect(result.scanned).toBe(0);
      expect(result.orphaned).toBe(0);
      expect(result.deleted).toBe(0);
    });
  });

  describe('工厂函数', () => {
    it('应该创建默认配置的 GC 服务', () => {
      const defaultGC = createDefaultGCService(roundStore, memoryStorage);
      const config = defaultGC.getConfig();

      expect(config.minAgeMs).toBe(5 * 60 * 1000);
      expect(config.batchSize).toBe(100);
      expect(config.cleanUpMemory).toBe(true);
      expect(config.syncVectorDelete).toBe(true);
      expect(config.verbose).toBe(false);
    });

    it('shouldSkip 忙碌时应跳过本次 GC（长任务保护）', () => {
      // shouldSkip=true 模拟 chatLock busy
      const busyGC = new GCService(roundStore, memoryStorage, {
        minAgeMs: 0,
        batchSize: 10,
        cleanUpMemory: true,
        verbose: false,
        shouldSkip: () => true,
      });

      // 孤立 Round 已就绪（超龄、refCount=0）
      const round = createPendingRound('忙时的孤儿');
      round.refCount = 0;
      roundStore.save(round);

      const result = busyGC.run();
      expect(result.deleted).toBe(0); // 跳过，不清理
      expect(result.orphaned).toBe(0); // 未扫描
      expect(roundStore.size()).toBe(1); // Round 保留

      // 释放忙后正常执行
      const idleGC = new GCService(roundStore, memoryStorage, {
        minAgeMs: 0,
        batchSize: 10,
        cleanUpMemory: true,
        verbose: false,
        shouldSkip: () => false,
      });
      const idleResult = idleGC.run();
      expect(idleResult.deleted).toBe(1);
      expect(roundStore.size()).toBe(0);
    });

    it('purge 摘要时同步删除向量索引', async () => {
      // 注入 mock vectorStore
      const mockVectorStore = {
        delete: vi.fn().mockResolvedValue(undefined),
      } as unknown as IVectorStore;

      const gcWithVector = new GCService(
        roundStore,
        memoryStorage,
        {
          minAgeMs: 0,
          batchSize: 10,
          cleanUpMemory: true,
          syncVectorDelete: true,
          verbose: false,
        },
        mockVectorStore,
      );

      // 孤立的 complete Round + 关联摘要（规范两段式 ID：round-summary:{session}:{roundId}）
      const round = createPendingRound('向量同步');
      const completed = completeRound(round, '回答');
      completed.refCount = 0;
      roundStore.save(completed);
      const summaryId = `round-summary:2026-09-10-main:${round.id}`;
      memoryStorage.upsert({
        id: summaryId,
        content: '摘要',
        source: 'round-summary',
        name: round.id,
        roundId: round.id,
        createdAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
      } as Memory);

      gcWithVector.run();
      expect(mockVectorStore.delete).toHaveBeenCalledWith(summaryId);

      // 等待 fire-and-forget 的 catch 链完成（无断言，仅防未处理 rejection）
      await new Promise((r) => setTimeout(r, 10));
    });
  });
});
