/**
 * 记忆治理统一门面 — 聚合 L0-L3 记忆治理操作（L0 衰减/L1 去重/L2 时效性/L3 冲突/诊断）。
 * 根本动机：6 个治理方法原散落 Agent 45 个公开 API 中职责碎片化，收束为单一门面 `agent.governance.xxx()`。
 * 门面仅做委托 + 空值降级不引入新逻辑（每层抽象对应一个真实故障点）；
 * 底层 Manager 未注入时返回空报告（非抛错），符合"降级优先"，与 L1/L2/L3 skippedReason 语义一致。
 */
import type { DedupManager, DedupReport } from '@/agent/managers/dedupManager.js';
import type { MemoryDecayScheduler, TimelinessReport } from '@/agent/managers/memoryDecayScheduler.js';
import type {
  MemoryAdvisor,
  ConflictReport,
} from '@/agent/managers/memoryAdvisor.js';
import type { SourceHealthReport, SuggestOptions, SuggestHit } from '@/agent/managers/memoryAdvisor.js';

export class MemoryGovernance {
  constructor(
    private readonly dedupManager: DedupManager | null,
    private readonly decayScheduler: MemoryDecayScheduler | null,
    private readonly memoryAdvisor: MemoryAdvisor | null,
  ) {}

  // ── L0 衰减 ──────────────────────────────────────────

  /** 手动触发一次记忆衰减（纯 score 递减，无 LLM 调用） */
  decay(): void {
    this.decayScheduler?.runOnce();
  }

  // ── L1 语义去重 ──────────────────────────────────────

  /** 语义去重：扫描名称相似记忆对，LLM 判断等价性，降级重复记忆 */
  async deduplicate(signal?: AbortSignal): Promise<DedupReport> {
    if (!this.dedupManager) {
      return { scannedCount: 0, pairCount: 0, deduplicatedCount: 0, demotedIds: [], skippedReason: 'Agent 未初始化' };
    }
    return this.dedupManager.deduplicateMemories(signal);
  }

  // ── L2 时效性评估 ────────────────────────────────────

  /** 时效性评估：LLM 判断低分记忆是否过时，降级过时记忆 */
  async evaluateTimeliness(signal?: AbortSignal): Promise<TimelinessReport> {
    if (!this.decayScheduler) {
      return { scannedCount: 0, outdatedCount: 0, demotedIds: [], skippedReason: 'Agent 未初始化' };
    }
    return this.decayScheduler.evaluateTimeliness(signal);
  }

  // ── L3 冲突检测 ──────────────────────────────────────

  /** 冲突检测：LLM 判断同 source 记忆是否存在语义矛盾 */
  async detectConflicts(signal?: AbortSignal): Promise<ConflictReport> {
    if (!this.memoryAdvisor) {
      return { scannedCount: 0, pairCount: 0, conflictCount: 0, conflicts: [], skippedReason: 'Agent 未初始化' };
    }
    return this.memoryAdvisor.detectConflicts(signal);
  }

  // ── 诊断 ─────────────────────────────────────────────

  /** 记忆源健康诊断（纯只读）；advisor 未注入返回 null */
  sourceHealth(): SourceHealthReport | null {
    return this.memoryAdvisor?.sourceHealth() ?? null;
  }

  /** 记忆关联推荐（纯只读） */
  suggest(query?: string, options?: SuggestOptions): SuggestHit[] {
    return this.memoryAdvisor?.suggest(query, options) ?? [];
  }
}
