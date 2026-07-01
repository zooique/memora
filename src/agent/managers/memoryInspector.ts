/**
 * 记忆查看器 — 统一查看记忆快照 + 搜索 + 统计
 *
 * 从 Agent 拆分出来，负责只读记忆查询操作。
 *
 * 设计原则：
 *   - 纯只读——不动任何组件状态
 *   - 同步返回——避免数据不一致（不调 LLM、不调 SQLite 写入）
 *   - 轻量——每层只返回前 N 条 + 总数
 */
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
// ADR-014 记忆关系图谱：可选注入，未注入时跳过关系查询
import type { IMemoryRelationStore } from '@/memory/relationStore.js';
import type { MemoryRelation, RelationDirection } from '@/memory/types.js';
import type { VectorStore } from '@/memory/vectorStore.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { AgentLoop } from '@/agent/loop.js';
import { configError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';
import {
  RECALL_LIMIT_MULTIPLIER,
  VECTOR_SCORE_WEIGHT,
  MEMORY_SCORE_WEIGHT,
} from '@/memory/recall.js';
// QC-R2-11：sourceHealth() + suggest() 已提取到 MemoryAdvisor
import { MemoryAdvisor } from '@/agent/managers/memoryAdvisor.js';
import type {
  SourceHealthReport,
  SuggestOptions,
  SuggestHit,
} from '@/agent/managers/memoryAdvisor.js';

// QC-R2-11：类型再导出，保持公共 API 不变（src/index.ts 通过本文件再导出这些类型）
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

// ─── 类 ──────────────────────────────────────────────────

export class MemoryInspector {
  /** 向量存储（可选，提供时 searchHybrid 启用语义搜索） */
  private vectorStore: VectorStore | null = null;
  /** 关系存储（可选，ADR-014 侧车，未注入时跳过关系查询） */
  private readonly relationStore: IMemoryRelationStore | null;
  /** 记忆顾问（QC-R2-11：sourceHealth + suggest 委托） */
  private readonly advisor: MemoryAdvisor;

  /**
   * @param index - 记忆存储（用于搜索 + 统计）
   * @param loop - AgentLoop（用于获取工作记忆）
   * @param history - MessageHistory（用于获取当前会话信息）
   * @param relationStore - 关系存储侧车（可选，ADR-014，未注入时关系相关方法降级返回空）
   */
  constructor(
    private readonly index: IMemoryStorage,
    private readonly loop: AgentLoop,
    private readonly history: MessageHistory,
    relationStore: IMemoryRelationStore | null = null,
  ) {
    this.relationStore = relationStore;
    // QC-R2-11：记忆顾问共享 index 引用（只读访问）
    this.advisor = new MemoryAdvisor(index);
  }

  /**
   * 注入向量存储（由 Agent 在初始化后调用，解决构造时序）
   */
  setVectorStore(vs: VectorStore | null): void {
    this.vectorStore = vs;
  }

  // ─── 写操作代理 ───────────────────────────────────────
  // 宿主项目通过 agent.memory 访问写操作，
  // 无需绕过 inspector 直接访问 agent.storage（分层违规）。
  // 代理方法内部委托给 this.index（IMemoryStorage 实例）。

  /**
   * 插入或更新记忆
   *
   * @param memory 完整记忆对象
   */
  upsert(memory: Memory): void {
    this.index.upsert(memory);
  }

  /**
   * 删除记忆
   *
   * @param id 记忆唯一标识（${source}:${name} 格式）
   */
  delete(id: string): void {
    this.index.delete(id);
  }

  /**
   * 按 ID 获取单条记忆
   *
   * @param id 记忆唯一标识
   * @returns 记忆对象，不存在时返回 null
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
      contentPreview: m.content.length > SEARCH_PREVIEW_LEN ? m.content.slice(0, SEARCH_PREVIEW_LEN) + '...' : m.content,
      createdAt: m.createdAt,
    }));
  }

  /**
   * 混合搜索记忆（语义 + 关键词双通道）
   *
   * V-101：当 VectorStore 可用时，启用语义搜索通道，补强关键词召回的语义缺口。
   * 向量搜索失败时静默降级到纯关键词（降级优先原则）。
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

    // ── 综合排序：vectorScore（语义相关度）+ memory.score（权重） ──
    const sorted = [...merged.values()].sort((a, b) => {
      const scoreA = a.vectorScore * VECTOR_SCORE_WEIGHT + a.memory.score * MEMORY_SCORE_WEIGHT;
      const scoreB = b.vectorScore * VECTOR_SCORE_WEIGHT + b.memory.score * MEMORY_SCORE_WEIGHT;
      return scoreB - scoreA;
    });

    return sorted.slice(0, limit).map(({ memory, vectorScore }) => ({
      id: memory.id,
      name: memory.name,
      source: memory.source,
      score: memory.score,
      similarity: vectorScore,
      contentPreview: memory.content.length > SEARCH_PREVIEW_LEN ? memory.content.slice(0, SEARCH_PREVIEW_LEN) + '...' : memory.content,
      createdAt: memory.createdAt,
    }));
  }

  // ─── 统计 ─────────────────────────────────────────────

  /**
   * 记忆库统计
   *
   * 返回记忆来源分布、数据库大小等关键指标。
   * P2-2 优化：使用 getAllSources() 一次查询替代多次 countBySource + 全量 search，
   * 复杂度从 O(n*knownSources + n) 降为 O(distinctSources)。
   */
  stats(): AgentStats {
    const total = this.index.count();

    // P2-2 直接使用 getAllSources() 获取所有 source 分布（含宿主自定义标签）
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

  /**
   * 添加记忆关系（透传 relationStore）
   *
   * 用于宿主 UI 手动创建关系（关系图右键菜单 → 连线 → 创建关系）。
   * relationStore 未注入时静默降级（不阻塞）。
   *
   * @param relation 关系边数据
   */
  addRelation(relation: MemoryRelation): void {
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
  removeRelation(sourceId: string, targetId: string, type: string): void {
    if (!this.relationStore) return;
    this.relationStore.removeRelation(sourceId, targetId, type);
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

  // ─── 源健康诊断 + 关联推荐（QC-R2-11：委托给 MemoryAdvisor） ───

  /**
   * 记忆源健康诊断（委托给 MemoryAdvisor）
   *
   * 为每个 source 计算健康指标（数量、平均 score、新鲜度、状态）。
   * 实现已迁移至 MemoryAdvisor（QC-R2-11），此处保留委托以维持 API 契约。
   */
  sourceHealth(): SourceHealthReport {
    return this.advisor.sourceHealth();
  }

  /**
   * 关联推荐（委托给 MemoryAdvisor）
   *
   * 基于 score + 时效性 + source 多样性推荐记忆。
   * 实现已迁移至 MemoryAdvisor（QC-R2-11），此处保留委托以维持 API 契约。
   *
   * @param query - 可选的搜索关键词（提供时结合搜索结果推荐，省略时基于全局热度推荐）
   * @param options - 推荐选项
   */
  suggest(query?: string, options?: SuggestOptions): SuggestHit[] {
    return this.advisor.suggest(query, options);
  }
}
