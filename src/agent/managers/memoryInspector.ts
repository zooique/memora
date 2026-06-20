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
import type { VectorStore } from '@/memory/vectorStore.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { AgentLoop } from '@/agent/loop.js';
import { configError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';
import {
  RECALL_LIMIT_MULTIPLIER,
  VECTOR_SCORE_WEIGHT,
  MEMORY_SCORE_WEIGHT,
  ONE_DAY_MS,
} from '@/memory/recall.js';

// ─── 常量 ────────────────────────────────────────────────

/** 工作记忆预览条数（最近 N 条） */
const WORKING_PREVIEW = 5;
/** 内容预览字符数 */
const CONTENT_PREVIEW_LEN = 80;

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
  currentSession: string;
  /** 当前会话全名（含日期前缀，与 sessions/*.md 文件名一致） */
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
}

/** 记忆库统计数据 */
export interface AgentStats {
  /** 按来源标签分组的记忆数量 */
  bySource: Record<string, number>;
  /** 记忆总数 */
  total: number;
}

/** 关联推荐选项 */
export interface SuggestOptions {
  /** 返回数量上限（默认 5） */
  limit?: number;
  /** 排除的 source 标签（默认排除 persona、rule、skill） */
  excludeSources?: string[];
  /** 时效性权重（0-1，默认 0.3）：越高越偏好最近访问的记忆 */
  recencyWeight?: number;
}

/** 关联推荐结果 */
export interface SuggestHit {
  /** 记忆名称 */
  name: string;
  /** 来源标签 */
  source: string;
  /** 推荐分数（0-1，由 score + recency 综合计算） */
  relevance: number;
  /** 内容预览（截断到 120 字符） */
  contentPreview: string;
  /** 推荐理由 */
  reason: string;
}

// ─── 类 ──────────────────────────────────────────────────

export class MemoryInspector {
  /** 向量存储（可选，提供时 searchHybrid 启用语义搜索） */
  private vectorStore: VectorStore | null = null;

  /**
   * @param index - 记忆存储（用于搜索 + 统计）
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
  setVectorStore(vs: VectorStore | null): void {
    this.vectorStore = vs;
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
      // 截断长内容到 120 字符
      contentPreview: m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content,
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
      contentPreview: memory.content.length > 120 ? memory.content.slice(0, 120) + '...' : memory.content,
    }));
  }

  // ─── 统计 ─────────────────────────────────────────────

  /**
   * 记忆库统计
   *
   * 返回记忆来源分布、数据库大小等关键指标。
   * 自动发现所有 source 标签（包括宿主自定义的），不依赖硬编码列表。
   */
  stats(): AgentStats {
    const total = this.index.count();

    // 已知 source 标签 + 通过 getBySource 发现的自定义标签
    const knownSources = Object.values(SOURCE_LABELS);
    const bySource: Record<string, number> = {};

    for (const source of knownSources) {
      const c = this.index.countBySource(source);
      if (c > 0) bySource[source] = c;
    }

    // 补充：通过空查询发现不在已知列表中的自定义 source
    // （宿主可能注册了自定义 source 标签）
    if (total > Object.values(bySource).reduce((a, b) => a + b, 0)) {
      const allMemories = this.index.search('', Math.min(total, 1000));
      for (const m of allMemories) {
        if (!(m.source in bySource)) {
          bySource[m.source] = (bySource[m.source] ?? 0) + 1;
        }
      }
    }

    return { bySource, total };
  }

  // ─── 关联推荐 ─────────────────────────────────────────

  /**
   * 关联推荐：基于已有记忆数据，推荐你可能感兴趣的记忆
   *
   * 不调 LLM，纯计算。综合 score（权重）+ accessedAt（时效性）+ source 多样性，
   * 返回"与你当前关注点相关但尚未直接搜索到"的记忆。
   *
   * 适用场景：
   * - 用户搜索后，展示"你可能还想看"
   * - 对话开始时，展示"最近你可能关心的记忆"
   * - 宿主程序构建个性化推荐面板
   *
   * @param query - 可选的搜索关键词（提供时结合搜索结果推荐，省略时基于全局热度推荐）
   * @param options - 推荐选项
   */
  suggest(query?: string, options: SuggestOptions = {}): SuggestHit[] {
    const {
      limit = 5,
      excludeSources = [SOURCE_LABELS.PERSONA, SOURCE_LABELS.RULE, SOURCE_LABELS.SKILL],
      recencyWeight = 0.3,
    } = options;

    const scoreWeight = 1 - recencyWeight;
    const now = Date.now();

    // 收集候选记忆
    const candidates = new Map<string, { memory: Memory; searchHit: boolean }>();

    // 如果有 query，先搜索直接匹配的记忆（标记为 searchHit）
    if (query && query.trim()) {
      const directHits = this.index.search(query, limit * 3);
      for (const m of directHits) {
        if (!excludeSources.includes(m.source)) {
          candidates.set(m.id, { memory: m, searchHit: true });
        }
      }
    }

    // 补充：按 source 分组采样，确保来源多样性
    const knownSources = [SOURCE_LABELS.INSIGHT, SOURCE_LABELS.PROFILE, SOURCE_LABELS.WORK_PROJECTION];
    for (const source of knownSources) {
      const count = this.index.countBySource(source);
      if (count > 0 && !excludeSources.includes(source)) {
        const memories = this.index.getBySource(source);
        // 取 score 最高的前 3 条
        const top = memories.sort((a, b) => b.score - a.score).slice(0, 3);
        for (const m of top) {
          if (!candidates.has(m.id)) {
            candidates.set(m.id, { memory: m, searchHit: false });
          }
        }
      }
    }

    if (candidates.size === 0) return [];

    // 计算综合推荐分数
    const scored: Array<{ memory: Memory; searchHit: boolean; relevance: number; reason: string }> = [];

    for (const { memory, searchHit } of candidates.values()) {
      // 时效性分：7 天内线性衰减，超过 30 天归零
      const accessedAt = new Date(memory.accessedAt);
      const daysSinceAccess = isNaN(accessedAt.getTime())
        ? 30
        : (now - accessedAt.getTime()) / ONE_DAY_MS;
      const recency = Math.max(0, 1 - daysSinceAccess / 30);

      const relevance = memory.score * scoreWeight + recency * recencyWeight;

      // 生成推荐理由
      let reason: string;
      if (searchHit) {
        reason = '与搜索相关';
      } else if (daysSinceAccess < 1) {
        reason = '最近访问';
      } else if (memory.score >= 0.8) {
        reason = '高频记忆';
      } else {
        reason = `${memory.source} 推荐`;
      }

      scored.push({ memory, searchHit, relevance, reason });
    }

    // 排序：搜索命中优先，然后按 relevance 降序
    scored.sort((a, b) => {
      if (a.searchHit !== b.searchHit) return a.searchHit ? -1 : 1;
      return b.relevance - a.relevance;
    });

    return scored.slice(0, limit).map(({ memory, relevance, reason }) => ({
      name: memory.name,
      source: memory.source,
      relevance: Math.round(relevance * 100) / 100,
      contentPreview: memory.content.length > 120 ? memory.content.slice(0, 120) + '...' : memory.content,
      reason,
    }));
  }
}
