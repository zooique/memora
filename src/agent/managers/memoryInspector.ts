/**
 * 记忆管理器 — 统一的记忆读写入口
 *
 * 从 Agent 拆分出来，负责记忆的查询 + 写入操作。
 * 写方法以 writeXxx 前缀命名，与读方法明确区分。
 *
 * 设计原则：
 *   - 读写统一入口——writeXxx 前缀区分写操作，降低认知负荷
 *   - 同步返回——避免数据不一致（不调 LLM、不调 SQLite 异步写入）
 *   - 轻量——每层只返回前 N 条 + 总数
 *   - 静默降级——relationStore 未注入时关系方法静默 no-op（ADR-014 降级优先）
 *
 * 方法清单：
 *   - 只读查询：snapshot / search / searchHybrid / stats /
 *     getRelations / getAllRelations / getRelationPath / getRelationNeighbors /
 *     getById / getBySource / list / listDeleted / getDeletedById /
 *     sourceHealth / suggest
 *   - 写操作（writeXxx 前缀）：
 *     writeUpsert / writeDelete / writeRestore / writePurge / writePurgeExpired /
 *     writeAddRelation / writeRemoveRelation
 *   - LLM 记忆治理（异步，backgroundProvider 未注入时静默降级）：
 *     deduplicateMemories（语义去重）
 *
 * v2 PROXY-1 闭环：原 detectConflicts 转发方法已删除，Agent.detectConflicts
 * 改为直接调用 MemoryAdvisor。inspector 职责收缩为"读写 + 查询入口"，
 * 不再含 L3 冲突检测转发。
 */
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
// ADR-014 记忆关系图谱：可选注入，未注入时跳过关系查询
import type { IMemoryRelationStore } from '@/memory/relationStore.js';
import type { MemoryRelation, RelationDirection, RelationPath, RelationNeighbor } from '@/memory/types.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { AgentLoop } from '@/agent/loop.js';
import { byScoreDesc } from '@/utils/array.js';
import { configError } from '@/utils/errors.js';
import { nowIso } from '@/utils/time.js';
import { truncate } from '@/utils/strings.js';
import { logger } from '@/logging/logger.js';
// 双通道融合排序算法 + 常量从 hybridMerge 导入（不再绕道 recall.ts）
// 消除"agent 模块依赖 memory/recall.ts 内部常量"的分层违规
import {
  hybridMerge,
  RECALL_LIMIT_MULTIPLIER,
} from '@/memory/hybridMerge.js';
// LLM 治理共享常量（v2 REPEAT-1/2 闭环，消除 5 处独立维护的治理源列表 + 2 处 score 常量重复）
import { GOVERNANCE_SOURCES, BOOST_INCREMENT, SCORE_CEILING } from '@/memory/governance.js';
// sourceHealth() + suggest() 已提取到 MemoryAdvisor
// 删除兜底分支后 MemoryAdvisor 仅用于类型注解，改用 import type
// v2 PROXY-1：detectConflicts 已迁移至 Agent 直接调用 advisor，ConflictReport 不再在此 import
import type {
  MemoryAdvisor,
  SourceHealthReport,
  SuggestOptions,
  SuggestHit,
} from '@/agent/managers/memoryAdvisor.js';
// LLM 语义去重（L1）：backgroundProvider 注入 + 流式累积，参照 TextPolishManager 模式
import type { LlmProvider, Message } from '@/llm/provider.js';
// LLM judge 三件套高阶函数（流式累积 + parseLlmJson + configError 异常封装）
import { judgeWithLlm } from '@/agent/managers/llmJudgeHelper.js';
// levenshtein 用于名称相似度计算（复用 sourceValidation 中的实现，避免重复造轮子）
import { levenshtein } from '@/memory/sourceValidation.js';

// 类型再导出，保持公共 API 不变（src/index.ts 通过本文件再导出这些类型）
export type {
  SourceHealthStatus,
  SourceHealthEntry,
  SourceHealthReport,
  SuggestOptions,
  SuggestHit,
} from '@/agent/managers/memoryAdvisor.js';

// ─── 常量 ────────────────────────────────────────────────

/** 工作记忆预览条数（最近 N 条） */
const WORKING_PREVIEW = 5;
/** 内容预览字符数（快照层） */
const CONTENT_PREVIEW_LEN = 80;
/** 搜索结果内容预览字符数（比快照层略长，便于用户判断相关性） */
const SEARCH_PREVIEW_LEN = 120;

// ─── L1 语义去重常量 ────────────────────────────────────
// 注：DEDUP_SOURCES 已统一为 GOVERNANCE_SOURCES（governance.ts），消除 5 处独立维护
/** 单次去重扫描的候选记忆条数上限（控制内存和 LLM 调用量） */
const DEDUP_CANDIDATE_LIMIT = 50;
/** 单次 LLM 判断的候选对数上限（每对约 200 tokens，10 对 ≈ 2000 tokens） */
const DEDUP_PAIR_LIMIT = 10;
/** 名称相似度阈值（归一化 Levenshtein 距离 ≤ 此值视为名称高度相似，进入 LLM 判断） */
const DEDUP_NAME_SIMILARITY_THRESHOLD = 0.3;
/** LLM 去重判断超时（ms），与 TextPolishManager 一致 */
const DEDUP_TIMEOUT_MS = 15_000;
/** 被判定为重复的记忆降级到此 score（接近 0 但保留可恢复性，不物理删除） */
const DEDUP_LOW_SCORE = 0.1;
/** 候选记忆内容预览长度（截断后送入 LLM，控制 token 消耗） */
const DEDUP_CONTENT_PREVIEW_LEN = 200;

// ─── 类型 ────────────────────────────────────────────────

/** 记忆快照 */
export interface MemorySnapshot {
  /** 第 1 层：工作记忆（messages 数组） */
  working: WorkingMemorySnapshot;
  /** 第 2 层：Bootstrap 记忆（永驻 + 领域） */
  bootstrap: BootstrapSnapshot;
  /** 第 3 层：归档洞察（insight 记忆） */
  archive: ArchiveSnapshot;
}

/** 第 1 层：工作记忆快照 */
export interface WorkingMemorySnapshot {
  total: number;
  preview: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    contentPreview: string;
    contentLength: number;
  }>;
}

/** 第 2 层：Bootstrap 记忆快照 */
export interface BootstrapSnapshot {
  total: number;
  items: Array<{
    id: string;
    /** 来源标签（开放字符串） */
    source: string;
    name: string;
    contentPreview: string;
    /** 权重（0-1） */
    score: number;
  }>;
}

/** 第 3 层：归档记忆快照（insight + profile + work-projection） */
export interface ArchiveSnapshot {
  /** 归档记忆总数（insight + profile + work-projection） */
  archiveCount: number;
  /** 关系边总数（ADR-014，relationStore 未注入时为 0） */
  relationCount: number;
  currentSession: string;
  /** 当前会话全名（含日期前缀） */
  currentSessionName: string;
  hint: string;
  /** 归档记忆来源分布 */
  stats: {
    insight: number;
    profile: number;
    'work-projection': number;
  };
}

/** Agent 记忆搜索结果（cli 友好的扁平结构） */
export interface AgentSearchHit {
  /** 记忆唯一标识（${source}:${name} 格式，供 showMemory/deleteMemory 等操作使用） */
  id: string;
  /** 记忆名称 */
  name: string;
  /** 来源标签 */
  source: string;
  /** 权重（0-1） */
  score: number;
  /** 内容预览（截断到 120 字符） */
  contentPreview: string;
  /** 语义相似度（0-1，仅 searchHybrid 返回，纯关键词搜索时无此字段） */
  similarity?: number;
  /** 创建时间（ISO 8601，供 UI 层时间筛选/排序使用） */
  createdAt?: string;
}

/** 记忆库统计数据 */
export interface AgentStats {
  /** 按来源标签分组的记忆数量 */
  bySource: Record<string, number>;
  /** 记忆总数 */
  total: number;
  /** 关系边总数（ADR-014，relationStore 未注入时为 0） */
  relationCount: number;
}

// ─── L1 语义去重类型 ────────────────────────────────────

/** 名称高度相似的候选记忆对（待 LLM 判断语义等价性） */
export interface DedupPair {
  /** 记忆 A（score 较高，作为保留候选） */
  a: Memory;
  /** 记忆 B（score 较低，作为降级候选） */
  b: Memory;
  /** 名称归一化相似度（0-1，越小越相似） */
  nameSimilarity: number;
}

/** LLM 对单对记忆的语义等价判断结果 */
export interface DedupVerdict {
  /** 是否语义等价（true → 降级低分记忆） */
  isDuplicate: boolean;
  /** 合并后的内容（isDuplicate=true 时提供，保留更完整的信息） */
  mergedContent?: string;
  /** LLM 判断理由（便于审计和调试） */
  reason: string;
}

/** 降级记忆的审计详情（DedupReport.verdicts 元素，供 UI 展示"为什么降级"） */
export interface DedupVerdictSummary {
  /** 被降级的记忆 ID（与 demotedIds 元素一一对应） */
  demotedId: string;
  /** LLM 判断理由（便于用户审计降级是否合理） */
  reason: string;
  /** 合并后的完整内容（便于用户验证合并质量；未提供 mergedContent 时省略，渲染器负责截断展示） */
  mergedContent?: string;
}

/** 语义去重报告（deduplicateMemories 返回值） */
export interface DedupReport {
  /** 扫描的候选记忆总数 */
  scannedCount: number;
  /** 发现的名称相似对数 */
  pairCount: number;
  /** LLM 判定为语义等价并执行降级的对数 */
  deduplicatedCount: number;
  /** 被降级的记忆 ID 列表（score 降至 DEDUP_LOW_SCORE，未物理删除） */
  demotedIds: string[];
  /** 降级审计详情（与 demotedIds 一一对应，供 UI 展示 reason + mergedContentPreview） */
  verdicts?: DedupVerdictSummary[];
  /** 跳过原因（LLM 不可用 / 无候选对 / LLM 失败降级） */
  skippedReason?: string;
}

// ─── 类 ──────────────────────────────────────────────────

export class MemoryInspector {
  /** 向量存储（可选，提供时 searchHybrid 启用语义搜索） */
  private vectorStore: IVectorStore | null = null;
  /** 关系存储（可选，ADR-014 侧车，未注入时关系方法静默降级） */
  private readonly relationStore: IMemoryRelationStore | null;
  /** 记忆顾问（sourceHealth + suggest 委托） */
  private readonly advisor: MemoryAdvisor;
  /** 后台 LLM Provider（可选，用于语义去重等异步治理任务，未注入时降级跳过） */
  private readonly backgroundProvider: LlmProvider | null;

  /**
   * @param index - 记忆存储（用于读写操作）
   * @param loop - AgentLoop（用于获取工作记忆）
   * @param history - MessageHistory（用于获取当前会话信息）
   * @param advisor - 记忆顾问（组合根一致性，由 assembler.ts 显式注入，必填）
   * @param relationStore - 关系存储侧车（可选，ADR-014，未注入时关系方法降级返回空/no-op）
   * @param backgroundProvider - 后台 LLM Provider（可选，用于语义去重，未注入时降级跳过）
   */
  constructor(
    private readonly index: IMemoryStorage,
    private readonly loop: AgentLoop,
    private readonly history: MessageHistory,
    advisor: MemoryAdvisor,
    relationStore: IMemoryRelationStore | null = null,
    backgroundProvider: LlmProvider | null = null,
  ) {
    // 组合根一致性——advisor 由 assembler.ts 显式注入（必填，不再内部创建）
    this.advisor = advisor;
    this.relationStore = relationStore;
    this.backgroundProvider = backgroundProvider;
  }

  /**
   * 注入向量存储（由 Agent 在初始化后调用，解决构造时序）
   */
  setVectorStore(vs: IVectorStore | null): void {
    this.vectorStore = vs;
  }

  // ─── 只读查询（IMemoryStorage 透传） ───────────────────
  // 写操作以 writeXxx 前缀命名，集中在本类末尾的"写操作"section。

  /**
   * 列出回收站中的软删除记忆（只读查询）
   *
   * @param limit 返回数量上限（默认 50）
   * @returns 软删除记忆列表（按 deletedAt 降序）
   */
  listDeleted(limit = 50): Memory[] {
    return this.index.listDeleted(limit);
  }

  /**
   * 按 ID 获取单条软删除记忆（只读查询）
   *
   * 用于 restore/purge 操作前的存在性校验，避免 listDeleted 默认 50 上限
   * 导致回收站超量时操作失效。
   *
   * @param id 记忆唯一标识
   * @returns 软删除记忆，不存在或未软删除时返回 null
   */
  getDeletedById(id: string): Memory | null {
    return this.index.getDeletedById(id);
  }

  /**
   * 按 ID 获取单条活跃记忆（已软删除的返回 null）
   *
   * @param id 记忆唯一标识
   * @returns 记忆对象，不存在或已软删除时返回 null
   */
  getById(id: string): Memory | null {
    return this.index.getById(id);
  }

  /**
   * 按来源标签获取记忆列表
   *
   * @param source 来源标签（如 'persona'、'rule'、'insight'）
   * @returns 该来源的所有记忆
   */
  getBySource(source: string): Memory[] {
    return this.index.getBySource(source);
  }

  /**
   * 列出所有记忆（用于宿主项目的记忆管理面板）
   *
   * 与 search() 不同，本方法允许空查询，返回按 score 降序排列的记忆列表。
   * search() 拒绝空查询是为了防止"静默全量返回"的误用；
   * list() 则是显式声明"我要列出所有记忆"的意图。
   *
   * @param limit 返回数量上限（默认 50）
   * @returns 记忆列表（按 score 降序）
   */
  list(limit = 50): Memory[] {
    return this.index.search('', limit);
  }

  // ─── 快照 ─────────────────────────────────────────────

  /**
   * 统一查看记忆快照（3 层）
   *
   * 简化为 3 层（工作记忆 / Bootstrap / 归档记忆）。
   *
   * 设计原则：
   * - **纯只读**——不动任何组件状态
   * - **同步返回**——避免数据不一致（不调 LLM、不调 SQLite）
   * - **轻量**——每层只返回前 N 条 + 总数
   */
  snapshot(): MemorySnapshot {
    // 第 1 层：工作记忆（AgentLoop 的 messages 数组）
    const workingFull = this.loop.getMessages();
    const workingTotal = workingFull.length;
    const working = workingFull.slice(-WORKING_PREVIEW);

    // 第 2 层：Bootstrap 记忆（永驻 + 领域）
    // 直接按 source 查询，避免 search('', 50) 全量扫描
    const rules = this.index.getBySource(SOURCE_LABELS.RULE);
    const personas = this.index.getBySource(SOURCE_LABELS.PERSONA);
    const skills = this.index.getBySource(SOURCE_LABELS.SKILL);
    const bootstrap = [...rules, ...personas, ...skills];

    // 第 3 层：归档记忆计数（insight + profile + work-projection）
    const insightCount = this.index.countBySource(SOURCE_LABELS.INSIGHT);
    const profileCount = this.index.countBySource(SOURCE_LABELS.PROFILE);
    const workProjectionCount = this.index.countBySource(SOURCE_LABELS.WORK_PROJECTION);
    const archiveTotal = insightCount + profileCount + workProjectionCount;

    return {
      working: {
        total: workingTotal,
        preview: working.map(
          (m: { role: 'system' | 'user' | 'assistant' | 'tool'; content: string }) => ({
            role: m.role,
            contentPreview: m.content.slice(0, CONTENT_PREVIEW_LEN),
            contentLength: m.content.length,
          }),
        ),
      },
      bootstrap: {
        total: bootstrap.length,
        items: bootstrap.map((m: Memory) => ({
          id: m.id,
          source: m.source,
          name: m.name,
          contentPreview: m.content.slice(0, CONTENT_PREVIEW_LEN),
          score: m.score,
        })),
      },
      archive: {
        archiveCount: archiveTotal,
        // ADR-014 关系边总数（relationStore 未注入时为 0）
        relationCount: this.countRelations(),
        currentSession: this.history.session ?? '(none)',
        currentSessionName: this.history.currentSessionName ?? '(none)',
        hint: '调 listAllSessions() 获取文件清单',
        stats: {
          insight: insightCount,
          profile: profileCount,
          'work-projection': workProjectionCount,
        },
      },
    };
  }

  // ─── 搜索 ─────────────────────────────────────────────

  /**
   * 搜索记忆（关键词 + FTS5 索引）
   *
   * 返回 CLI 友好的扁平结构（已处理内容截断）
   */
  search(query: string, limit = 10): AgentSearchHit[] {
    // 空 query 会让 search() 退化为"返回所有"，对宿主程序是静默误导
    if (!query || query.trim() === '') {
      throw configError('搜索关键词为空', 'search() 需要非空 query', [
        '传入非空字符串关键词',
        '使用 snapshot().bootstrap.items 列出所有引导记忆',
      ]);
    }
    if (limit <= 0 || !Number.isInteger(limit)) {
      throw configError('无效 limit', `limit 必须是正整数，收到 ${limit}`, [
        '使用 limit = 10（默认值）',
      ]);
    }
    const hits = this.index.search(query, limit);
    return hits.map((m: Memory) => ({
      id: m.id,
      name: m.name,
      source: m.source,
      score: m.score,
      // 截断长内容到搜索预览长度
      contentPreview: truncate(m.content, SEARCH_PREVIEW_LEN),
      createdAt: m.createdAt,
    }));
  }

  /**
   * 混合搜索记忆（语义 + 关键词双通道）
   *
   * 当 VectorStore 可用时，启用语义搜索通道，补强关键词召回的语义缺口。
   * 向量搜索失败时静默降级到纯关键词（降级优先原则）。
   *
   * 融合排序算法已提取到 hybridMerge.ts，与 recall() 共享同一实现，
   * 避免跨模块常量依赖。
   *
   * @returns 混合排序后的搜索结果（含相似度分数）
   */
  async searchHybrid(query: string, limit = 10): Promise<AgentSearchHit[]> {
    if (!query || query.trim() === '') {
      throw configError('搜索关键词为空', 'searchHybrid() 需要非空 query', [
        '传入非空字符串关键词',
      ]);
    }
    if (limit <= 0 || !Number.isInteger(limit)) {
      throw configError('无效 limit', `limit 必须是正整数，收到 ${limit}`, [
        '使用 limit = 10（默认值）',
      ]);
    }

    const merged = new Map<string, { memory: Memory; vectorScore: number }>();

    // ── 通道 1：语义搜索（VectorStore 可用时） ──
    if (this.vectorStore && this.vectorStore.size > 0) {
      try {
        const vectorResults = await this.vectorStore.search(query, limit * RECALL_LIMIT_MULTIPLIER, 0.3);
        for (const vr of vectorResults) {
          const memory = this.index.getById(vr.id);
          if (memory) {
            merged.set(memory.id, { memory, vectorScore: vr.similarity });
          }
        }
      } catch (err) {
        logger.debug({ err }, '语义搜索失败，降级到关键词');
      }
    }

    // ── 通道 2：关键词搜索（补齐语义通道未覆盖的） ──
    const keywordResults = this.index.search(query, limit * RECALL_LIMIT_MULTIPLIER);
    for (const m of keywordResults) {
      if (!merged.has(m.id)) {
        merged.set(m.id, { memory: m, vectorScore: 0 });
      }
    }

    // ── 综合排序：委托给 hybridMerge 纯函数（与 recall() 共享） ──
    const sorted = hybridMerge(merged.values(), limit);

    return sorted.map(({ memory, vectorScore }) => ({
      id: memory.id,
      name: memory.name,
      source: memory.source,
      score: memory.score,
      similarity: vectorScore,
      contentPreview: truncate(memory.content, SEARCH_PREVIEW_LEN),
      createdAt: memory.createdAt,
    }));
  }

  // ─── 统计 ─────────────────────────────────────────────

  /**
   * 记忆库统计
   *
   * 返回记忆来源分布、数据库大小等关键指标。
   * 优化：使用 getAllSources() 一次查询替代多次 countBySource + 全量 search，
   * 复杂度从 O(n*knownSources + n) 降为 O(distinctSources)。
   */
  stats(): AgentStats {
    const total = this.index.count();

    // 直接使用 getAllSources() 获取所有 source 分布（含宿主自定义标签）
    const sourceMap = this.index.getAllSources();
    const bySource: Record<string, number> = {};
    for (const [source, count] of sourceMap) {
      if (count > 0) bySource[source] = count;
    }

    return { bySource, total, relationCount: this.countRelations() };
  }

  // ─── 关系查询（ADR-014 侧车） ───────────────────────────

  /**
   * 查询指定记忆的关系边
   *
   * ADR-014 侧车模型：关系数据独立于 Memory 7 字段基元，存储在 IMemoryRelationStore。
   * relationStore 未注入时返回空数组（向后兼容）。
   *
   * @param memoryId - 记忆 ID
   * @param direction - 方向过滤：'outgoing'（出边）/ 'incoming'（入边）/ 'both'（双向，默认）
   * @returns 关系边数组，按 createdAt 降序
   */
  getRelations(memoryId: string, direction: RelationDirection = 'both'): MemoryRelation[] {
    if (!this.relationStore) return [];
    return this.relationStore.getRelations(memoryId, direction);
  }

  /**
   * 查询全部关系边
   *
   * 用于宿主 UI 渲染拓扑可视化（阶段 2.4）。
   * relationStore 未注入时返回空数组（向后兼容）。
   *
   * @returns 全部关系边数组
   */
  getAllRelations(): MemoryRelation[] {
    if (!this.relationStore) return [];
    return this.relationStore.getAllRelations();
  }

  // 关系写操作以 writeAddRelation / writeRemoveRelation 命名，见本类末尾"写操作"section。

  /**
   * 记忆关系路径追溯（ADR-014 扩展，Phase 5.1）
   *
   * 从指定记忆出发，沿关系边追溯来源或去向，返回完整路径。
   * 用于宿主 UI 展示记忆的演化脉络（如 insight-a → refines → insight-b → follows → insight-c）。
   *
   * 防环设计：使用 visited Set 记录已访问节点，防止环导致无限递归。
   * 深度限制：maxDepth 控制最大追溯步数，防止路径过长。
   *
   * relationStore 未注入时返回仅含起点节点的数组（向后兼容，ADR-014 降级优先）。
   *
   * @param memoryId - 起点记忆 ID
   * @param maxDepth - 最大追溯深度（默认 5，防止路径过长）
   * @param direction - 追溯方向：'incoming'（追溯来源，默认）/ 'outgoing'（追溯去向） / 'both'
   * @returns 路径节点列表，按 depth 升序（起点在前）
   */
  getRelationPath(
    memoryId: string,
    maxDepth = 5,
    direction: RelationDirection = 'incoming',
  ): RelationPath[] {
    // 起点节点（无论 relationStore 是否注入都返回）
    const startMemory = this.index.getById(memoryId);
    const path: RelationPath[] = [
      {
        memoryId,
        memoryName: startMemory?.name ?? '(unknown)',
        memorySource: startMemory?.source ?? '(unknown)',
        relationType: null,
        relationWeight: null,
        depth: 0,
      },
    ];

    // relationStore 未注入时仅返回起点（降级优先，ADR-014）
    if (!this.relationStore) return path;

    // BFS 遍历，visited 防环
    const visited = new Set<string>([memoryId]);
    const queue: Array<{ id: string; depth: number; relationType: string; relationWeight: number }> = [
      { id: memoryId, depth: 0, relationType: '', relationWeight: 0 },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      const relations = this.relationStore.getRelations(current.id, direction);
      for (const rel of relations) {
        // 根据每条边的实际方向判断邻居，不依赖 direction 参数
        // （direction='both' 时返回的边可能 incoming 也可能 outgoing，
        //   旧实现按 direction 取 neighborId 会漏掉 incoming 邻居）
        const neighborId = rel.sourceId === current.id ? rel.targetId : rel.sourceId;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborMemory = this.index.getById(neighborId);
        path.push({
          memoryId: neighborId,
          memoryName: neighborMemory?.name ?? '(unknown)',
          memorySource: neighborMemory?.source ?? '(unknown)',
          relationType: rel.type,
          relationWeight: rel.weight,
          depth: current.depth + 1,
        });

        queue.push({
          id: neighborId,
          depth: current.depth + 1,
          relationType: rel.type,
          relationWeight: rel.weight,
        });
      }
    }

    return path;
  }

  /**
   * 记忆关系邻居查询（ADR-014 扩展，Phase 5.2）
   *
   * 返回与指定记忆直接关联的记忆列表，含关系类型和方向。
   * 用于宿主 UI 展示某记忆的直接关联记忆（如冲突记忆、支持记忆、后续记忆等）。
   *
   * relationStore 未注入时返回空数组（向后兼容，ADR-014 降级优先）。
   *
   * @param memoryId - 基准记忆 ID
   * @param limit - 返回数量上限（默认 10，防止过多邻居导致 UI 拥挤）
   * @returns 邻居记忆列表，含关系类型/权重/方向
   */
  getRelationNeighbors(memoryId: string, limit = 10): RelationNeighbor[] {
    // relationStore 未注入时返回空数组（降级优先，ADR-014）
    if (!this.relationStore) return [];

    const neighbors: RelationNeighbor[] = [];
    const seen = new Set<string>(); // 去重（同一邻居可能有多条关系）

    // outgoing：memoryId 是 sourceId，邻居是 targetId
    const outgoing = this.relationStore.getRelations(memoryId, 'outgoing');
    for (const rel of outgoing) {
      if (seen.has(rel.targetId)) continue;
      seen.add(rel.targetId);
      const neighborMemory = this.index.getById(rel.targetId);
      neighbors.push({
        memoryId: rel.targetId,
        memoryName: neighborMemory?.name ?? '(unknown)',
        memorySource: neighborMemory?.source ?? '(unknown)',
        memoryScore: neighborMemory?.score ?? 0,
        relationType: rel.type,
        relationWeight: rel.weight,
        direction: 'outgoing',
      });
    }

    // incoming：memoryId 是 targetId，邻居是 sourceId
    const incoming = this.relationStore.getRelations(memoryId, 'incoming');
    for (const rel of incoming) {
      if (seen.has(rel.sourceId)) continue;
      seen.add(rel.sourceId);
      const neighborMemory = this.index.getById(rel.sourceId);
      neighbors.push({
        memoryId: rel.sourceId,
        memoryName: neighborMemory?.name ?? '(unknown)',
        memorySource: neighborMemory?.source ?? '(unknown)',
        memoryScore: neighborMemory?.score ?? 0,
        relationType: rel.type,
        relationWeight: rel.weight,
        direction: 'incoming',
      });
    }

    return neighbors.slice(0, limit);
  }

  /**
   * 统计关系边总数
   *
   * 用于 stats() 和 snapshot() 的 relationCount 字段。
   * relationStore 未注入时返回 0（向后兼容）。
   */
  private countRelations(): number {
    if (!this.relationStore) return 0;
    return this.relationStore.getAllRelations().length;
  }

  // ─── 源健康诊断 + 关联推荐（委托给 MemoryAdvisor） ───

  /**
   * 记忆源健康诊断（委托给 MemoryAdvisor）
   *
   * 为每个 source 计算健康指标（数量、平均 score、新鲜度、状态）。
   * 实现已迁移至 MemoryAdvisor，此处保留委托以维持 API 契约。
   */
  sourceHealth(): SourceHealthReport {
    return this.advisor.sourceHealth();
  }

  /**
   * 关联推荐（委托给 MemoryAdvisor）
   *
   * 基于 score + 时效性 + source 多样性推荐记忆。
   * 实现已迁移至 MemoryAdvisor，此处保留委托以维持 API 契约。
   *
   * @param query - 可选的搜索关键词（提供时结合搜索结果推荐，省略时基于全局热度推荐）
   * @param options - 推荐选项
   */
  suggest(query?: string, options?: SuggestOptions): SuggestHit[] {
    return this.advisor.suggest(query, options);
  }

  // v2 PROXY-1 闭环：原 detectConflicts 转发方法已删除，
  // Agent.detectConflicts 改为直接调用 advisor（消除 3 层无意义代理）。
  // sourceHealth / suggest 保留转发以保持 agent.memory.xxx() 公共 API 统一入口语义。

  // ─── 写操作（writeXxx 前缀，IMemoryStorage / IMemoryRelationStore 透传） ───

  /**
   * 插入或更新记忆
   *
   * @param memory 完整记忆对象
   */
  writeUpsert(memory: Memory): void {
    this.index.upsert(memory);
  }

  /**
   * 提升记忆的 score（L2 采纳反哺内核）
   *
   * 用户在补全模块采纳某条候选后，通过 IPC 调用此方法反哺到内核 Memory.score。
   * 与 recall.ts 的 boostScore 路径语义一致（"越常用越重要"），但触发源不同：
   *   - recall.ts boostScore：召回时触发（被动）
   *   - writeBoost：用户主动采纳时触发（主动）
   *
   * 设计原则：
   *   - 复用现有 upsert 路径，不新增存储层接口
   *   - score 上限 1.0（与 recall.ts SCORE_CEILING 一致）
   *   - 同步更新 accessedAt，避免被衰减机制误降级
   *   - 记忆不存在时静默返回 false（补全候选可能来自对话历史，无对应记忆）
   *
   * @param id 记忆唯一标识（${source}:${name} 格式）
   * @param increment score 提升量（默认 0.05，与 recall.ts BOOST_INCREMENT 一致）
   * @returns 是否成功提升（记忆不存在时返回 false）
   */
  writeBoost(id: string, increment: number = BOOST_INCREMENT): boolean {
    const memory = this.index.getById(id);
    if (!memory) return false;
    const boosted: Memory = {
      ...memory,
      score: Math.min(SCORE_CEILING, memory.score + increment),
      accessedAt: nowIso(),
    };
    this.index.upsert(boosted);
    return true;
  }

  /**
   * 软删除记忆（写入 deletedAt）
   *
   * @param id 记忆唯一标识（${source}:${name} 格式）
   */
  writeDelete(id: string): void {
    this.index.delete(id);
  }

  /**
   * 恢复软删除的记忆（清除 deletedAt）
   *
   * @param id 记忆唯一标识
   */
  writeRestore(id: string): void {
    this.index.restore(id);
  }

  /**
   * 物理删除记忆（不可恢复，用于回收站彻底删除）
   *
   * @param id 记忆唯一标识
   */
  writePurge(id: string): void {
    this.index.purge(id);
  }

  /**
   * 清理过期的软删除记忆
   *
   * 物理删除所有 deletedAt 早于 before 的记忆。
   * 由宿主项目的定时器调用（默认 30 天保留期）。
   *
   * @param before 时间阈值，deletedAt 早于此值的记忆将被物理删除
   * @returns 被清理的记忆数量
   */
  writePurgeExpired(before: Date): number {
    return this.index.purgeExpired(before);
  }

  /**
   * 添加记忆关系（透传 relationStore）
   *
   * 用于宿主 UI 手动创建关系（关系图右键菜单 → 连线 → 创建关系）。
   * relationStore 未注入时静默降级（不阻塞）。
   *
   * @param relation 关系边数据
   */
  writeAddRelation(relation: MemoryRelation): void {
    if (!this.relationStore) return;
    this.relationStore.addRelation(relation);
  }

  /**
   * 删除记忆关系（透传 relationStore）
   *
   * 用于宿主 UI 手动删除关系（关系图右键菜单 → 编辑关系 → 删除）。
   * relationStore 未注入时静默降级（不阻塞）。
   *
   * @param sourceId 关系起点
   * @param targetId 关系终点
   * @param type 关系类型
   */
  writeRemoveRelation(sourceId: string, targetId: string, type: string): void {
    if (!this.relationStore) return;
    this.relationStore.removeRelation(sourceId, targetId, type);
  }

  /**
   * 删除某记忆的所有关系边（透传 relationStore）
   *
   * 用于记忆软删除/物理删除场景，防止 memory_relations 表残留孤儿边。
   * relationStore 未注入时静默降级（不阻塞记忆删除主流程）。
   *
   * @param memoryId 记忆 ID
   * @returns 被删除的关系数量（relationStore 未注入时返回 0）
   */
  writeRemoveRelationsByMemoryId(memoryId: string): number {
    if (!this.relationStore) return 0;
    return this.relationStore.removeRelationsByMemoryId(memoryId);
  }

  // ─── LLM 记忆治理（异步，backgroundProvider 未注入时静默降级） ───

  /**
   * 语义去重：扫描名称高度相似的记忆对，调用 LLM 判断语义等价性
   *
   * 流程：
   *   1. 从 insight/profile/work-projection 加载候选记忆（上限 50 条）
   *   2. 按名称归一化 Levenshtein 距离筛选相似对（上限 10 对）
   *   3. 对每对调用 LLM 判断语义等价性（结构化 JSON 输出）
   *   4. 等价则降级低分记忆（score → 0.1，不物理删除，保留可恢复性）
   *   5. 返回去重报告
   *
   * 安全设计：
   *   - 不物理删除——仅降级 score，用户可通过宿主 UI 手动恢复
   *   - LLM 失败降级——返回已处理的报告，不阻塞调用方
   *   - 异步执行——不阻塞主对话热路径（由宿主定时任务或用户手动触发）
   *   - backgroundProvider 未注入时静默跳过（返回 skippedReason）
   *
   * @param signal 可选的 AbortSignal（取消正在进行的 LLM 判断）
   * @returns 去重报告
   */
  async deduplicateMemories(signal?: AbortSignal): Promise<DedupReport> {
    // backgroundProvider 未注入时静默降级（向后兼容）
    if (!this.backgroundProvider) {
      return {
        scannedCount: 0,
        pairCount: 0,
        deduplicatedCount: 0,
        demotedIds: [],
        skippedReason: 'backgroundProvider 未注入',
      };
    }

    // ── 步骤 1：加载候选记忆（按 score 降序，取前 50 条） ──
    const candidates: Memory[] = [];
    for (const source of GOVERNANCE_SOURCES) {
      const memories = this.index.getBySource(source);
      candidates.push(...memories);
    }
    // 按 score 降序排列，优先处理高分记忆（更可能产生重复）
    candidates.sort(byScoreDesc);
    const limited = candidates.slice(0, DEDUP_CANDIDATE_LIMIT);

    // ── 步骤 2：筛选名称高度相似的记忆对 ──
    const pairs = this.findNameOverlapPairs(limited);
    if (pairs.length === 0) {
      return {
        scannedCount: limited.length,
        pairCount: 0,
        deduplicatedCount: 0,
        demotedIds: [],
        skippedReason: '未发现名称相似的记忆对',
      };
    }

    // ── 步骤 3：逐对调用 LLM 判断语义等价性 ──
    const demotedIds: string[] = [];
    const verdicts: DedupVerdictSummary[] = [];
    let deduplicatedCount = 0;

    for (const pair of pairs) {
      try {
        const verdict = await this.judgeDuplicate(pair, signal);
        if (verdict.isDuplicate) {
          // 降级低分记忆（b 的 score ≤ a 的 score，因 candidates 已按 score 降序）
          this.demoteMemory(pair.b, verdict.mergedContent);
          demotedIds.push(pair.b.id);
          // 收集审计详情（供 UI 展示"为什么降级"和"合并后保留了什么"）
          verdicts.push({
            demotedId: pair.b.id,
            reason: verdict.reason,
            mergedContent: verdict.mergedContent,
          });
          deduplicatedCount++;
          logger.info(
            { demotedId: pair.b.id, keptId: pair.a.id, reason: verdict.reason },
            '语义去重：降级重复记忆',
          );
        }
      } catch (err) {
        // 单对 LLM 判断失败不阻塞后续对，记录警告继续
        logger.warn(
          { err, pairId: `${pair.a.id}↔${pair.b.id}` },
          '语义去重：LLM 判断失败，跳过此对',
        );
      }
    }

    return {
      scannedCount: limited.length,
      pairCount: pairs.length,
      deduplicatedCount,
      demotedIds,
      verdicts,
    };
  }

  /**
   * 筛选名称高度相似的候选记忆对
   *
   * 判定规则（满足任一即视为名称相似）：
   *   1. 归一化 Levenshtein 距离 ≤ 0.3（如 "用户偏好" vs "用户偏爱"）
   *   2. 一个名称包含另一个（如 "用户偏好" vs "用户偏好设置"）
   *
   * 去重设计：
   *   - 已配对的记忆不再参与后续配对（避免 A-B-C 三元组产生 A-B + A-C + B-C 三对）
   *   - 候选对按相似度升序排列（越相似越优先），取前 10 对
   *
   * @param candidates 候选记忆列表（已按 score 降序）
   * @returns 名称相似的记忆对列表（a.score ≥ b.score）
   */
  private findNameOverlapPairs(candidates: Memory[]): DedupPair[] {
    const pairs: DedupPair[] = [];
    const usedIds = new Set<string>();

    // 双重循环生成所有可能的对，按相似度排序后贪心选取
    const allPairs: Array<{ a: Memory; b: Memory; nameSimilarity: number }> = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i]!; // i 循环内，score 较高
        const b = candidates[j]!; // j > i，score 较低或相等
        const similarity = MemoryInspector.computeNameSimilarity(a.name, b.name);
        if (similarity <= DEDUP_NAME_SIMILARITY_THRESHOLD) {
          allPairs.push({ a, b, nameSimilarity: similarity });
        }
      }
    }

    // 按相似度升序排列（越相似越优先处理）
    allPairs.sort((x, y) => x.nameSimilarity - y.nameSimilarity);

    // 贪心选取：已配对的记忆不再参与后续配对
    for (const { a, b, nameSimilarity } of allPairs) {
      if (usedIds.has(a.id) || usedIds.has(b.id)) continue;
      pairs.push({ a, b, nameSimilarity });
      usedIds.add(a.id);
      usedIds.add(b.id);
      if (pairs.length >= DEDUP_PAIR_LIMIT) break;
    }

    return pairs;
  }

  /**
   * 计算两个名称的归一化相似度（0-1，越小越相似）
   *
   * 综合两种规则取较小值：
   *   1. 归一化 Levenshtein 距离 = distance / max(len_a, len_b)
   *   2. 包含关系：若一个名称包含另一个，相似度 = 0（完全相似）
   *
   * @param nameA 名称 A
   * @param nameB 名称 B
   * @returns 相似度（0=完全相似，1=完全不同）
   */
  private static computeNameSimilarity(nameA: string, nameB: string): number {
    // 规则 2：包含关系（如 "用户偏好" vs "用户偏好设置"）
    if (nameA.includes(nameB) || nameB.includes(nameA)) {
      return 0;
    }

    // 规则 1：归一化 Levenshtein 距离
    const maxLen = Math.max(nameA.length, nameB.length);
    if (maxLen === 0) return 0; // 两个空字符串视为完全相似
    const distance = levenshtein(nameA, nameB);
    return distance / maxLen;
  }

  /**
   * 调用 LLM 判断单对记忆的语义等价性
   *
   * 使用结构化 JSON 输出（isDuplicate + mergedContent + reason），
   * 流式累积 + parseLlmJson + 异常封装委托给 llmJudgeHelper.judgeWithLlm。
   *
   * LLM 失败时抛出 MemoraError（由 deduplicateMemories 捕获并降级跳过此对）。
   *
   * @param pair 候选记忆对
   * @param signal 可选的 AbortSignal
   * @returns LLM 判断结果
   */
  private async judgeDuplicate(pair: DedupPair, signal?: AbortSignal): Promise<DedupVerdict> {
    const messages = buildDedupMessages(pair);
    const parsed = await judgeWithLlm<{
      isDuplicate?: boolean;
      mergedContent?: string;
      reason?: string;
    }>(
      this.backgroundProvider!,
      messages,
      { maxTokens: 300, timeoutMs: DEDUP_TIMEOUT_MS, signal },
      'LLM 去重判断返回非法 JSON',
    );

    return {
      isDuplicate: parsed.isDuplicate === true,
      mergedContent: typeof parsed.mergedContent === 'string' ? parsed.mergedContent : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '(LLM 未提供理由)',
    };
  }

  /**
   * 降级重复记忆（score → DEDUP_LOW_SCORE，可选合并内容）
   *
   * 安全设计：
   *   - 不物理删除，仅降低 score，保留可恢复性
   *   - 若提供 mergedContent，更新保留记忆（a）的 content 为合并后内容
   *   - 通过 upsert 覆盖原记忆（保持 id/source/name/createdAt 不变）
   *
   * @param memory 待降级的记忆（低分方）
   * @param mergedContent 可选的合并后内容（更新到保留方，由调用方负责）
   */
  private demoteMemory(memory: Memory, mergedContent?: string): void {
    const demoted: Memory = {
      ...memory,
      score: DEDUP_LOW_SCORE,
      // 更新 accessedAt，标记最近被处理过
      accessedAt: nowIso(),
    };
    this.index.upsert(demoted);

    // 若提供合并内容，调用方可通过 writeUpsert 单独更新保留方
    // 此处不直接修改保留方，保持职责单一（仅降级低分方）
    if (mergedContent) {
      logger.debug({ demotedId: memory.id, mergedContentLen: mergedContent.length }, '语义去重：合并内容已生成（需调用方手动更新保留方）');
    }
  }
}

// ─── L1 语义去重 Prompt 模板（模块级函数，与 TextPolishManager.buildPolishMessages 同模式） ───

/**
 * 构建语义去重判断的 LLM 消息
 *
 * 设计要点：
 *   - system 消息定义判断规则（语义等价 = 表达同一事实/偏好/洞察）
 *   - user 消息携带候选对的内容预览（截断到 200 字符）
 *   - 要求输出结构化 JSON（isDuplicate + mergedContent + reason）
 *   - few-shot 示例降低 LLM 误判率
 *
 * @param pair 候选记忆对
 * @returns system + user 消息数组
 */
function buildDedupMessages(pair: DedupPair): Message[] {
  const contentA = pair.a.content.length > DEDUP_CONTENT_PREVIEW_LEN
    ? truncate(pair.a.content, DEDUP_CONTENT_PREVIEW_LEN, '…[截断]')
    : pair.a.content;
  const contentB = pair.b.content.length > DEDUP_CONTENT_PREVIEW_LEN
    ? truncate(pair.b.content, DEDUP_CONTENT_PREVIEW_LEN, '…[截断]')
    : pair.b.content;

  return [
    {
      role: 'system',
      content: `你是记忆去重助手。判断给定的两条记忆是否语义等价（表达同一事实/偏好/洞察）。

判断规则：
- 语义等价 = 核心信息相同，仅措辞/格式/细节程度不同
- 语义不等价 = 核心信息不同，或一条是另一条的补充/细化（非等价）
- 忽略时间戳、ID 等元数据差异
- 忽略措辞风格差异（如"喜欢"vs"偏爱"）

输出 JSON 格式：
{
  "isDuplicate": true/false,
  "mergedContent": "合并后的内容（仅 isDuplicate=true 时提供，保留两条记忆的完整信息）",
  "reason": "判断理由（简短说明）"
}

示例：
输入 A: "用户偏好简洁的 UI 设计"
输入 B: "用户喜欢简洁的界面风格"
输出: {"isDuplicate": true, "mergedContent": "用户偏好简洁的 UI/界面设计风格", "reason": "核心偏好相同，仅措辞差异"}

输入 A: "用户是 TypeScript 开发者"
输入 B: "用户偏好使用 TypeScript 进行后端开发"
输出: {"isDuplicate": false, "reason": "B 是 A 的细化（限定后端），非语义等价"}`,
    },
    {
      role: 'user',
      content: `请判断以下两条记忆是否语义等价：

记忆 A（score: ${pair.a.score}，保留候选）：
- 名称：${pair.a.name}
- 来源：${pair.a.source}
- 内容：${contentA}

记忆 B（score: ${pair.b.score}，降级候选）：
- 名称：${pair.b.name}
- 来源：${pair.b.source}
- 内容：${contentB}

名称相似度：${pair.nameSimilarity.toFixed(2)}（0=完全相同，1=完全不同）

请输出 JSON 判断结果。`,
    },
  ];
}
