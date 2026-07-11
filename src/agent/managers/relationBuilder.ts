/**
 * 关系构建器 — ADR-014 记忆关系构建的专职 Manager
 *
 * 从 InsightExtractor 拆分出来，负责：
 *   - 召回关系判断候选记忆（top-5 关键词搜索）
 *   - 构建关系判断 prompt 片段（候选列表 + 关系类型说明）
 *   - 解析 LLM 输出的 relations 字段并写入 IMemoryRelationStore
 *   - contradicts 关系检测 + onConflict 回调通知
 *
 * 设计原则：
 *   - 独立于 InsightExtractor 生命周期，仅依赖 IMemoryStorage + IMemoryRelationStore
 *   - 静默降级——relationStore 未注入时所有方法返回空/no-op（ADR-014 降级优先）
 *   - 薄层代理——关系写入直接透传到 IMemoryRelationStore，仅增加 weight 推断 + targetId 校验
 *
 * 与 InsightExtractor 的分工（1.0 接口稳定化）：
 *   - InsightExtractor：insight 提取 + 去重 + 写入 + 输入分类
 *   - RelationBuilder：候选召回 + prompt 构建 + 关系写入 + 冲突检测
 *
 * 详见 ADR-014（记忆关系侧车模型）
 */
import type { Memory } from '@/memory/types.js';
import { RELATION_WEIGHTS } from '@/memory/types.js';
import { escapeLike } from '@/memory/sourceValidation.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IMemoryRelationStore } from '@/memory/relationStore.js';
import { logger } from '@/logging/logger.js';
import { nowIso } from '@/utils/time.js';

// ─── 常量 ────────────────────────────────────────────────

/** 关系判断：召回候选记忆数量上限（top-5） */
const RELATION_CANDIDATE_LIMIT = 5;

/** 关系判断：候选记忆 content 注入 prompt 的截断上限（字符） */
const RELATION_CANDIDATE_CONTENT_LIMIT = 100;

// ─── 类型 ────────────────────────────────────────────────

/**
 * 冲突信息（contradicts 关系检测到时传递给宿主）
 *
 * 由 RelationBuilder.buildRelations 检测到 contradicts 关系时构造，
 * 通过 onConflict 回调传递给 Agent，Agent emit('conflictDetected') 通知宿主。
 */
export interface ConflictInfo {
  /** 新写入的 insight 记忆 ID */
  newMemoryId: string;
  /** 新洞察内容（用于 UI 展示） */
  newInsight: string;
  /** 被矛盾的已有记忆 ID */
  targetId: string;
  /** 被矛盾的已有记忆内容（用于 UI 展示） */
  targetContent: string;
}

// ─── 类 ──────────────────────────────────────────────────

/**
 * 关系构建器
 *
 * 封装 ADR-014 记忆关系构建的全部逻辑，从 InsightExtractor 拆分。
 * relationStore 未注入时所有方法静默降级（返回空/no-op）。
 */
export class RelationBuilder {
  /** 冲突检测回调（由 Agent 通过 bindOnConflict 注入，检测到 contradicts 时触发） */
  private onConflict: ((info: ConflictInfo) => void) | null = null;

  /**
   * @param index 记忆存储（用于候选召回的关键词搜索）
   * @param relationStore 记忆关系存储（可选，未注入时所有方法静默降级）
   */
  constructor(
    private readonly index: IMemoryStorage,
    private readonly relationStore: IMemoryRelationStore | null = null,
  ) {}

  /** 关系构建是否启用（relationStore 已注入时为 true） */
  get enabled(): boolean {
    return this.relationStore !== null;
  }

  /**
   * 绑定冲突检测回调
   *
   * 由 Agent.init() 在创建 InsightExtractor 后调用（与 bindGetRecentHistory 同模式），
   * 解决 Agent 实例晚于 InsightExtractor 创建的时序循环依赖。
   * buildRelations 检测到 contradicts 关系时调用此回调，Agent 在回调中 emit('conflictDetected')。
   *
   * @param fn 冲突检测回调（传入 null 可解除绑定）
   */
  bindOnConflict(fn: ((info: ConflictInfo) => void) | null): void {
    this.onConflict = fn;
  }

  // ─── 候选召回 + Prompt 构建 ───────────────────────────

  /**
   * 召回关系判断候选记忆（top-5）
   *
   * 用用户输入关键词搜索已有记忆，作为 LLM 关系判断的参考。
   * 用户输入与提取出的 insight 通常相关，候选记忆也相关。
   * relationStore 未注入时返回空数组（降级）。
   *
   * @param userInput 用户输入（用于关键词搜索）
   * @returns 候选记忆列表（id + content 截断）
   */
  recallRelationCandidates(userInput: string): Memory[] {
    if (!this.relationStore) return [];
    const snippet = escapeLike(userInput.slice(0, 50));
    return this.index.search(snippet, RELATION_CANDIDATE_LIMIT);
  }

  /**
   * 构建候选记忆列表的 prompt 片段
   *
   * 格式：
   *   已有记忆（供关系判断参考）：
   *   [1] id: xxx, content: xxx
   *   [2] id: xxx, content: xxx
   *
   * @param candidates 候选记忆列表
   * @returns prompt 片段（空候选时返回空字符串）
   */
  buildCandidatesPrompt(candidates: Memory[]): string {
    if (candidates.length === 0) return '';
    const lines = candidates.map((m, i) => {
      const safeContent = m.content.length > RELATION_CANDIDATE_CONTENT_LIMIT
        ? m.content.slice(0, RELATION_CANDIDATE_CONTENT_LIMIT) + '…'
        : m.content;
      return `[${i + 1}] id: ${m.id}, content: ${safeContent}`;
    });
    return '\n\n已有记忆（供关系判断参考）：\n' + lines.join('\n');
  }

  /**
   * 构建关系判断的 prompt 指令片段
   *
   * 包含 relations 字段格式说明 + 关系类型说明 + 注意事项。
   * relationStore 未注入时返回空字符串（降级，不影响 insight 提取主流程）。
   *
   * @returns prompt 指令片段（relationStore 未注入时为空字符串）
   */
  buildRelationsPrompt(): string {
    if (!this.relationStore) return '';
    return `\n\n如果提取了 insight，还需判断它与已有记忆的关系，输出 relations 字段：
relations: [{"targetId": "已有记忆ID", "type": "contradicts|supports|follows|refines|caused|related"}]

关系类型说明：
- contradicts：矛盾（新信息与已有记忆冲突）
- supports：支持（新信息佐证已有记忆）
- follows：时间先后（新信息在已有记忆之后发生）
- refines：细化/演化（新信息细化已有记忆）
- caused：因果（新信息由已有记忆导致）
- related：泛相关（有关但非上述类型）

注意：
- targetId 必须是上方"已有记忆"列表中的 ID
- 无关系时输出空数组 []
- 不增加额外 LLM 调用，在本次提取中一并完成`;
  }

  // ─── 关系写入 + 冲突检测 ─────────────────────────────

  /**
   * 构建关系（写入 IMemoryRelationStore）
   *
   * 解析 LLM 输出的 relations 字段，验证 targetId 在候选列表中，写入关系存储。
   * 降级策略：relationStore 未注入/relations 为空/targetId 无效 → 跳过，不阻塞主流程。
   *
   * 检测到 contradicts 关系时，通过 onConflict 回调通知 Agent，
   * Agent emit('conflictDetected') 触发宿主消费链路（ProactiveBanner 通知用户）。
   *
   * @param insightId 新写入的 insight ID
   * @param insightContent 新写入的 insight 内容（用于冲突通知 UI 展示）
   * @param relations LLM 输出的关系列表
   * @param candidates 候选记忆列表（用于验证 targetId + 查找 targetContent）
   */
  buildRelations(
    insightId: string,
    insightContent: string,
    relations: Array<{ targetId?: unknown; type?: unknown }>,
    candidates: Memory[],
  ): void {
    if (!this.relationStore || relations.length === 0) return;

    const candidateIds = new Set(candidates.map((m) => m.id));
    const candidateMap = new Map(candidates.map((m) => [m.id, m]));
    const now = nowIso();
    let built = 0;

    for (const rel of relations) {
      // 运行时类型校验（不可信的 LLM 输出）
      if (typeof rel.targetId !== 'string' || typeof rel.type !== 'string') continue;
      // targetId 必须在候选列表中（LLM 可能输出不存在的 ID）
      if (!candidateIds.has(rel.targetId)) continue;

      this.relationStore.addRelation({
        sourceId: insightId,
        targetId: rel.targetId,
        type: rel.type,
        weight: this.weightByType(rel.type),
        createdAt: now,
      });
      built++;

      // contradicts 关系写入时，通过 onConflict 回调通知宿主
      if (rel.type === 'contradicts' && this.onConflict) {
        const targetMemory = candidateMap.get(rel.targetId);
        if (targetMemory) {
          this.onConflict({
            newMemoryId: insightId,
            newInsight: insightContent,
            targetId: rel.targetId,
            targetContent: targetMemory.content,
          });
        }
      }
    }

    if (built > 0) {
      logger.info({ insightId, built }, 'RelationBuilder: 关系构建完成');
    }
  }

  // ─── 私有：工具方法 ───────────────────────────────────

  /**
   * 根据关系类型推断 weight（ADR-014 §4）
   *
   * LLM 只输出 type，weight 由代码层推断：
   * - contradicts → 1.0（确定关系，矛盾是强关系）
   * - supports/follows/refines/caused → 0.7（强相关）
   * - related → 0.3（弱相关）
   * - 未知类型 → 0.5（未判断兜底）
   *
   * 设计理由：降低 LLM 认知负担，离散值比连续浮点稳定
   */
  private weightByType(type: string): number {
    switch (type) {
      case 'contradicts': return RELATION_WEIGHTS.CERTAIN;
      case 'supports':
      case 'follows':
      case 'refines':
      case 'caused':
        return RELATION_WEIGHTS.STRONG;
      case 'related': return RELATION_WEIGHTS.WEAK;
      default: return RELATION_WEIGHTS.UNDEFINED;
    }
  }
}
