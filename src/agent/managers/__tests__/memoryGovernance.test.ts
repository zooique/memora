/**
 * MemoryGovernance 单元测试 — 记忆治理统一门面
 *
 * 覆盖范围：
 *   - 降级路径（核心）：底层 Manager 未注入时返回空报告（非抛错）
 *     - dedupManager=null → deduplicate() 返回 skippedReason
 *     - decayScheduler=null → evaluateTimeliness() 返回 skippedReason + decay() 无操作
 *     - memoryAdvisor=null → detectConflicts() 返回 skippedReason + sourceHealth()=null + suggest()=[]
 *   - 委托路径（回归）：底层 Manager 已注入时正确委托
 *     - decay() 委托 decayScheduler.runOnce()
 *     - deduplicate() 委托 dedupManager.deduplicateMemories()
 *     - evaluateTimeliness() 委托 decayScheduler.evaluateTimeliness()
 *     - detectConflicts() 委托 memoryAdvisor.detectConflicts()
 *     - sourceHealth() 委托 memoryAdvisor.sourceHealth()
 *     - suggest() 委托 memoryAdvisor.suggest()
 *
 * 测试范式：mock 底层 Manager，验证降级返回值 + 委托调用。
 * 门面类本身无业务逻辑，重点是降级路径覆盖（原仅 agent.test.ts 覆盖 happy path，降级路径裸奔）。
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryGovernance } from '@/agent/managers/memoryGovernance.js';
import type { DedupManager, DedupReport } from '@/agent/managers/dedupManager.js';
import type { MemoryDecayScheduler, TimelinessReport } from '@/agent/managers/memoryDecayScheduler.js';
import type { MemoryAdvisor, ConflictReport, SourceHealthReport, SuggestHit, SuggestOptions } from '@/agent/managers/memoryAdvisor.js';

// ─── Mock 工厂 ─────────────────────────────────────────────

/**
 * 创建 mock DedupManager
 * @param report deduplicateMemories 返回的报告（可选，默认空报告）
 */
function createMockDedupManager(report?: Partial<DedupReport>): DedupManager {
  return {
    deduplicateMemories: vi.fn().mockResolvedValue({
      scannedCount: 10,
      pairCount: 2,
      deduplicatedCount: 1,
      demotedIds: ['mem:1'],
      ...report,
    }),
  } as unknown as DedupManager;
}

/**
 * 创建 mock MemoryDecayScheduler
 * @param timelinessReport evaluateTimeliness 返回的报告（可选）
 */
function createMockDecayScheduler(timelinessReport?: Partial<TimelinessReport>): MemoryDecayScheduler {
  return {
    runOnce: vi.fn(),
    evaluateTimeliness: vi.fn().mockResolvedValue({
      scannedCount: 5,
      outdatedCount: 1,
      demotedIds: ['mem:2'],
      ...timelinessReport,
    }),
  } as unknown as MemoryDecayScheduler;
}

/**
 * 创建 mock MemoryAdvisor
 * @param healthReport sourceHealth 返回的报告（可选）
 * @param suggestHits suggest 返回的推荐列表（可选）
 */
function createMockMemoryAdvisor(
  healthReport?: SourceHealthReport | null,
  suggestHits?: SuggestHit[],
): MemoryAdvisor {
  return {
    sourceHealth: vi.fn().mockReturnValue(healthReport ?? null),
    suggest: vi.fn().mockReturnValue(suggestHits ?? []),
    detectConflicts: vi.fn().mockResolvedValue({
      scannedCount: 8,
      pairCount: 1,
      conflictCount: 0,
      conflicts: [],
    } as ConflictReport),
  } as unknown as MemoryAdvisor;
}

// ─── 测试 ──────────────────────────────────────────────────

describe('MemoryGovernance', () => {
  // ── 降级路径（核心） ────────────────────────────────────

  describe('降级路径 — 底层 Manager 未注入', () => {
    it('所有 Manager 均为 null 时，decay() 不抛错（无操作）', () => {
      // 验证：decay 调用 decayScheduler?.runOnce()，null 安全
      const governance = new MemoryGovernance(null, null, null);
      expect(() => governance.decay()).not.toThrow();
    });

    it('dedupManager=null 时，deduplicate() 返回 skippedReason 空报告', async () => {
      const governance = new MemoryGovernance(null, null, null);
      const report = await governance.deduplicate();
      expect(report).toEqual({
        scannedCount: 0,
        pairCount: 0,
        deduplicatedCount: 0,
        demotedIds: [],
        skippedReason: 'Agent 未初始化',
      });
    });

    it('decayScheduler=null 时，evaluateTimeliness() 返回 skippedReason 空报告', async () => {
      const governance = new MemoryGovernance(null, null, null);
      const report = await governance.evaluateTimeliness();
      expect(report).toEqual({
        scannedCount: 0,
        outdatedCount: 0,
        demotedIds: [],
        skippedReason: 'Agent 未初始化',
      });
    });

    it('memoryAdvisor=null 时，detectConflicts() 返回 skippedReason 空报告', async () => {
      const governance = new MemoryGovernance(null, null, null);
      const report = await governance.detectConflicts();
      expect(report).toEqual({
        scannedCount: 0,
        pairCount: 0,
        conflictCount: 0,
        conflicts: [],
        skippedReason: 'Agent 未初始化',
      });
    });

    it('memoryAdvisor=null 时，sourceHealth() 返回 null', () => {
      const governance = new MemoryGovernance(null, null, null);
      expect(governance.sourceHealth()).toBeNull();
    });

    it('memoryAdvisor=null 时，suggest() 返回空数组', () => {
      const governance = new MemoryGovernance(null, null, null);
      expect(governance.suggest()).toEqual([]);
      expect(governance.suggest('query')).toEqual([]);
    });

    it('部分 Manager 为 null 时，仅对应方法降级，其他方法正常委托', async () => {
      // dedupManager=null，但 decayScheduler 和 memoryAdvisor 已注入
      const mockDecay = createMockDecayScheduler();
      const mockAdvisor = createMockMemoryAdvisor();
      const governance = new MemoryGovernance(null, mockDecay, mockAdvisor);

      // deduplicate 应降级
      const dedupReport = await governance.deduplicate();
      expect(dedupReport.skippedReason).toBe('Agent 未初始化');

      // evaluateTimeliness 应正常委托
      const timelinessReport = await governance.evaluateTimeliness();
      expect(timelinessReport.scannedCount).toBe(5);
      expect(mockDecay.evaluateTimeliness).toHaveBeenCalledOnce();

      // detectConflicts 应正常委托
      const conflictReport = await governance.detectConflicts();
      expect(conflictReport.scannedCount).toBe(8);
      expect(mockAdvisor.detectConflicts).toHaveBeenCalledOnce();
    });
  });

  // ── 委托路径（回归） ────────────────────────────────────

  describe('委托路径 — 底层 Manager 已注入', () => {
    it('decay() 委托 decayScheduler.runOnce()', () => {
      const mockDecay = createMockDecayScheduler();
      const governance = new MemoryGovernance(null, mockDecay, null);
      governance.decay();
      expect(mockDecay.runOnce).toHaveBeenCalledOnce();
    });

    it('deduplicate() 委托 dedupManager.deduplicateMemories() 并透传 signal', async () => {
      const mockDedup = createMockDedupManager();
      const governance = new MemoryGovernance(mockDedup, null, null);
      const controller = new AbortController();
      await governance.deduplicate(controller.signal);
      expect(mockDedup.deduplicateMemories).toHaveBeenCalledWith(controller.signal);
    });

    it('evaluateTimeliness() 委托 decayScheduler.evaluateTimeliness() 并透传 signal', async () => {
      const mockDecay = createMockDecayScheduler();
      const governance = new MemoryGovernance(null, mockDecay, null);
      const controller = new AbortController();
      await governance.evaluateTimeliness(controller.signal);
      expect(mockDecay.evaluateTimeliness).toHaveBeenCalledWith(controller.signal);
    });

    it('detectConflicts() 委托 memoryAdvisor.detectConflicts() 并透传 signal', async () => {
      const mockAdvisor = createMockMemoryAdvisor();
      const governance = new MemoryGovernance(null, null, mockAdvisor);
      const controller = new AbortController();
      await governance.detectConflicts(controller.signal);
      expect(mockAdvisor.detectConflicts).toHaveBeenCalledWith(controller.signal);
    });

    it('sourceHealth() 委托 memoryAdvisor.sourceHealth()', () => {
      const expectedReport: SourceHealthReport = {
        sources: [],
        overallStatus: 'healthy',
        diagnosedAt: '2026-07-30T00:00:00.000Z',
      };
      const mockAdvisor = createMockMemoryAdvisor(expectedReport);
      const governance = new MemoryGovernance(null, null, mockAdvisor);
      expect(governance.sourceHealth()).toEqual(expectedReport);
      expect(mockAdvisor.sourceHealth).toHaveBeenCalledOnce();
    });

    it('suggest() 委托 memoryAdvisor.suggest() 并透传参数', () => {
      const expectedHits: SuggestHit[] = [
        { id: 'mem:1', name: 'test', source: 'content', relevance: 0.8, contentPreview: '预览', reason: '相关' },
      ];
      const mockAdvisor = createMockMemoryAdvisor(null, expectedHits);
      const governance = new MemoryGovernance(null, null, mockAdvisor);
      const options: SuggestOptions = { limit: 5 };
      const result = governance.suggest('query', options);
      expect(result).toEqual(expectedHits);
      expect(mockAdvisor.suggest).toHaveBeenCalledWith('query', options);
    });
  });
});
