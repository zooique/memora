/**
 * 记忆治理统一门面 — 聚合 L0–L3 记忆治理操作
 *
 * 职责：
 *   - L0 衰减：手动触发 score 自然衰减
 *   - L1 去重：语义重复检测与合并
 *   - L2 时效性：LLM 驱动的时效性评估
 *   - L3 冲突：LLM 驱动的语义冲突检测
 *   - 诊断：source 健康度 + 记忆推荐
 *
 * 设计原则（§2.2 借力生长）：
 *   - 6 个治理方法原散落在 Agent 的 45 个公开 API 中，职责碎片化
 *   - 收束为单一门面，Agent 只暴露 `agent.governance.xxx()`，减少 6 个直接 API 入口
 *   - 门面仅做委托和空值降级，不引入新逻辑——每一层抽象对应一个真实故障点
 *
 * 空值降级策略：
 *   - 底层 Manager 未注入时返回空报告（非抛错），符合"降级优先"原则
 *   - 与 L1/L2/L3 层的 skippedReason 语义一致
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

  /**
   * 手动触发一次记忆衰减（纯 score 递减，无 LLM 调用）
   */
  decay(): void {
    this.decayScheduler?.runOnce();
  }

  // ── L1 语义去重 ──────────────────────────────────────

  /**
   * 语义去重：扫描名称相似记忆对，LLM 判断等价性，降级重复记忆
   */
  async deduplicate(signal?: AbortSignal): Promise<DedupReport> {
    if (!this.dedupManager) {
      return { scannedCount: 0, pairCount: 0, deduplicatedCount: 0, demotedIds: [], skippedReason: 'Agent 未初始化' };
    }
    return this.dedupManager.deduplicateMemories(signal);
  }

  // ── L2 时效性评估 ────────────────────────────────────

  /**
   * 时效性评估：LLM 判断低分记忆是否过时，降级过时记忆
   */
  async evaluateTimeliness(signal?: AbortSignal): Promise<TimelinessReport> {
    if (!this.decayScheduler) {
      return { scannedCount: 0, outdatedCount: 0, demotedIds: [], skippedReason: 'Agent 未初始化' };
    }
    return this.decayScheduler.evaluateTimeliness(signal);
  }

  // ── L3 冲突检测 ──────────────────────────────────────

  /**
   * 冲突检测：LLM 判断同 source 记忆是否存在语义矛盾
   */
  async detectConflicts(signal?: AbortSignal): Promise<ConflictReport> {
    if (!this.memoryAdvisor) {
      return { scannedCount: 0, pairCount: 0, conflictCount: 0, conflicts: [], skippedReason: 'Agent 未初始化' };
    }
    return this.memoryAdvisor.detectConflicts(signal);
  }

  // ── 诊断 ─────────────────────────────────────────────

  /**
   * 记忆源健康诊断（纯只读，不修改状态）
   *
   * @returns 健康报告；advisor 未注入时返回 null
   */
  sourceHealth(): SourceHealthReport | null {
    return this.memoryAdvisor?.sourceHealth() ?? null;
  }

  /**
   * 记忆关联推荐（纯只读，不修改状态）
   */
  suggest(query?: string, options?: SuggestOptions): SuggestHit[] {
    return this.memoryAdvisor?.suggest(query, options) ?? [];
  }
}
