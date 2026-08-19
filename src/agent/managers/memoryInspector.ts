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
 *
 * 方法清单：
 *   - 只读查询：snapshot / search / searchHybrid / stats /
 *     getById / getBySource / list / listDeleted / getDeletedById
 *   - 写操作（writeXxx 前缀）：
 *     writeUpsert / writeDelete / writeRestore / writePurge / writePurgeExpired
 *
 * 拆分历史：
 *   - L1 语义去重（deduplicateMemories）拆分至 DedupManager
 *   - detectConflicts 直连 MemoryAdvisor（消除 3 层代理）
 *   - sourceHealth/suggest 直连 MemoryAdvisor，删除本类转发方法 + advisor 字段，
 *     Agent 作为门面委托 advisor（与 detectConflicts 同模式）。本类回归纯存储读写 + 查询入口。
 *   - ADR-014 记忆关系图谱已收敛移除：关系查询/写入方法
 *     （getRelations/getAllRelations/getRelationPath/getRelationNeighbors/
 *     writeAddRelation/writeRemoveRelation）及 relationStore 注入全部删除。
 */
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { AgentLoop } from '@/agent/loop.js';
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
// MIND2-L3：SCORE_CEILING 不再需要（incrementScore 内部 clamp），仅保留 BOOST_INCREMENT
import { BOOST_INCREMENT } from '@/memory/governance.js';

// 类型再导出，保持公共 API 不变（src/index.ts 通过本文件再导出这些类型）
// sourceHealth/suggest 实现已迁回 MemoryAdvisor 直连，类型仍在此再导出
// 以维持 src/index.ts 公共 API 兼容（类型定义本身在 memoryAdvisor.ts）
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

// ─── 类型 ────────────────────────────────────────────────

/** 记忆快照 */
export interface MemorySnapshot {
  /** 第 1 层：工作记忆（messages 数组） */
  working: WorkingMemorySnapshot;
  /** 第 2 层：Bootstrap 记忆（永驻 + 领域） */
  bootstrap: BootstrapSnapshot;
  /** 第 3 层：归档记忆（round-summary + work-projection） */
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

/** 第 3 层：归档记忆快照（round-summary + work-projection） */
export interface ArchiveSnapshot {
  /** 归档记忆总数（round-summary + work-projection） */
  archiveCount: number;
  currentSession: string;
  /** 当前会话全名（含日期前缀） */
  currentSessionName: string;
  hint: string;
  /** 归档记忆来源分布 */
  stats: {
    'round-summary': number;
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
}

// ─── 类 ──────────────────────────────────────────────────

export class MemoryInspector {
  /** 向量存储（可选，提供时 searchHybrid 启用语义搜索） */
  private vectorStore: IVectorStore | null = null;

  /**
   * 构造记忆管理器
   *
   * sourceHealth/suggest 由 Agent 直接委托 MemoryAdvisor（与 detectConflicts 同模式），
   * 本类不持有 advisor，消除 3 层代理。
   *
   * @param index - 记忆存储（用于读写操作）
   * @param loop - AgentLoop（用于获取工作记忆）
   * @param history - MessageHistory（用于获取当前会话信息）
   */
  constructor(
    private readonly index: IMemoryStorage,
    private readonly loop: AgentLoop,
    private readonly history: MessageHistory,
  ) {}

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
   * @param limit 返回数量上限。`limit <= 0` 或 `undefined` 表示不设上限（返回全部）；
   *              正整数 N 表示返回最近 N 条。默认 undefined（全部）。
   * @returns 软删除记忆列表（按 deletedAt 降序）
   */
  listDeleted(limit?: number): Memory[] {
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
   * @param source 来源标签（如 'persona'、'rule'、'round-summary'）
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

    // 第 2 层：Bootstrap 记忆（永驻 + 领域）—— 已空实现
    // ADR-025：设定记忆（persona/rule/skill）唯一归角色包，索引不再新增；
    // getBootstrapMemories 已恒空，rolePackPrompt 承载规则注入。
    // 此处保留空壳接口供 UI 层调用，避免宿主代码变更。

    // 第 3 层：归档记忆计数（round-summary + work-projection）
    const roundSummaryCount = this.index.countBySource(SOURCE_LABELS.ROUND_SUMMARY);
    const workProjectionCount = this.index.countBySource(SOURCE_LABELS.WORK_PROJECTION);
    const archiveTotal = roundSummaryCount + workProjectionCount;

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
        total: 0,
        items: [],
      },
      archive: {
        archiveCount: archiveTotal,
        currentSession: this.history.session ?? '(none)',
        currentSessionName: this.history.currentSessionName ?? '(none)',
        hint: '调 listAllSessions() 获取文件清单',
        stats: {
          'round-summary': roundSummaryCount,
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

    return { bySource, total };
  }

  // ─── 源健康诊断 + 关联推荐 ───
  //
  // sourceHealth() / suggest() 已从此处删除。
  // 调用方应通过 Agent 门面访问：
  //   - agent.sourceHealth()  →  MemoryAdvisor.sourceHealth()
  //   - agent.suggest(...)    →  MemoryAdvisor.suggest(...)
  // 与 detectConflicts 同模式（agent.detectConflicts → advisor.detectConflicts），
  // 消除"inspector 三层纯转发"的设计气味。

  // ─── 写操作（writeXxx 前缀，IMemoryStorage 透传） ───

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
   *   - score 上限 1.0（与 recall.ts SCORE_CEILING 一致）
   *   - 同步更新 accessedAt，避免被衰减机制误降级
   *   - 记忆不存在时静默返回 false（补全候选可能来自对话历史，无对应记忆）
   *
   * @param id 记忆唯一标识（${source}:${name} 格式）
   * @param increment score 提升量（默认 0.05，与 recall.ts BOOST_INCREMENT 一致）
   * @returns 是否成功提升（记忆不存在时返回 false）
   */
  writeBoost(id: string, increment: number = BOOST_INCREMENT): boolean {
    // MIND2-L3：改用 incrementScore 原子操作，消除 read-modify-write 并发冲突
    // 原 getById → spread → boostScore → upsert 四步合并为存储层一条原子更新
    return this.index.incrementScore(id, increment, nowIso());
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
    // 手动 purge 同时清理向量，防止孤儿向量被语义召回。
    // vectorStore.delete 为异步（内部立即 save），本方法同步签名（宿主 IPC 同步调用），
    // 故 fire-and-forget + catch 降级——delete 首行同步 entries.delete，内存立即失效。
    if (this.vectorStore) {
      void this.vectorStore.delete(id).catch((err) => {
        logger.warn({ err, memoryId: id }, '物理删除记忆的向量失败，可能残留孤儿向量');
      });
    }
    // 再物理删除记忆
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
    // 1. 先查询待清理的软删除记忆（listDeleted 不传 limit = 全部）
    //    用 before 时间戳过滤，避免清理未过期的记忆
    const beforeMs = before.getTime();
    const candidates = this.index
      .listDeleted()
      .filter((m) => m.deletedAt && new Date(m.deletedAt).getTime() < beforeMs);

    // 2. 向量清理（T2-5 / F3-5）：防止 30 天自动清理产生孤儿向量被召回。
    //    vectorStore 未注入时跳过（降级优先）。
    //    delete 为异步（内部立即 save），本方法保持同步签名（宿主定时器同步消费返回值），
    //    故 fire-and-forget + catch 降级——delete 首行同步 entries.delete，内存立即失效，
    //    持久化失败仅影响冷启动复活概率（vectorStore.delete 已立即 save 兜底）。
    if (this.vectorStore && candidates.length > 0) {
      for (const m of candidates) {
        void this.vectorStore.delete(m.id).catch((err) => {
          logger.warn({ err, memoryId: m.id }, '清理过期记忆的向量失败，可能残留孤儿向量');
        });
      }
    }

    // 3. 物理删除记忆（IMemoryStorage.purgeExpired 返回被清理的数量）
    return this.index.purgeExpired(before);
  }
}
