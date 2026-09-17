/**
 * 记忆治理统一门面 — 聚合记忆治理操作（L1 去重 / L3 冲突 / 诊断）。
 * 治理模型收敛为 supersede（写时取代）+ 命中刷新 accessedAt（只 touch、不做重要度加权；score 已于 2026-09-09 物理退役），衰减已移除（见架构决策）。
 * 根本动机：治理方法原散落 Agent 公开 API 中职责碎片化，收束为单一门面 `agent.governance.xxx()`。
 * 门面仅做委托 + 空值降级不引入新逻辑（每层抽象对应一个真实故障点）；
 * 底层 Manager 未注入时返回空报告（非抛错），符合"降级优先"。
 */
import type { DedupManager, DedupReport } from '@/agent/managers/dedupManager.js';
import type {
  MemoryAdvisor,
  ConflictReport,
} from '@/agent/managers/memoryAdvisor.js';
import type { SourceHealthReport, SuggestOptions, SuggestHit } from '@/agent/managers/memoryAdvisor.js';

export class MemoryGovernance {
  constructor(
    private readonly dedupManager: DedupManager | null,
    private readonly memoryAdvisor: MemoryAdvisor | null,
  ) {}

  // ── L1 语义去重 ──────────────────────────────────────

  /** 语义去重：扫描名称相似记忆对，LLM 判断等价性，降级重复记忆 */
  async deduplicate(signal?: AbortSignal): Promise<DedupReport> {
    if (!this.dedupManager) {
      return { scannedCount: 0, pairCount: 0, deduplicatedCount: 0, demotedIds: [], skippedReason: 'Agent 未初始化' };
    }
    return this.dedupManager.deduplicateMemories(signal);
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
