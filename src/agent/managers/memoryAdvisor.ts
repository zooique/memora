/**
 * 记忆顾问 — 健康诊断 + 关联推荐
 *
 * QC-R2-11 拆分：从 MemoryInspector 提取 sourceHealth() + suggest() 为独立模块。
 * 两者均为纯只读分析计算，仅依赖 IMemoryStorage，不修改任何状态。
 *
 * 设计原则（延续 MemoryInspector）：
 *   - 纯只读——只读 IMemoryStorage，不修改任何状态
 *   - 同步返回——不调 LLM、不调 SQLite 写入
 *   - 无状态——所有数据从 IMemoryStorage 实时读取
 */
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { ONE_DAY_MS } from '@/memory/recall.js';
import { nowIso } from '@/utils/time.js';

// ─── 常量 ────────────────────────────────────────────────

/** 关联推荐：每个 source 采样 top-N 条 */
const SUGGEST_TOP_PER_SOURCE = 3;
/** 关联推荐：时效性衰减窗口（天），超过此天数归零 */
const SUGGEST_RECENCY_WINDOW_DAYS = 30;
/** 推荐结果内容预览字符数（与 MemoryInspector.SEARCH_PREVIEW_LEN 一致，独立维护以便各模块独立演进） */
const ADVISOR_PREVIEW_LEN = 120;
/** source 健康度阈值（低于此值或超期触发 critical/warning） */
const SOURCE_HEALTH_THRESHOLDS = {
  /** 平均 score 低于此值 → critical */
  CRITICAL_SCORE: 0.2,
  /** 平均 score 低于此值 → warning */
  WARNING_SCORE: 0.5,
  /** 超过此天数未访问 → critical */
  CRITICAL_DAYS: 30,
  /** 超过此天数未访问 → warning */
  WARNING_DAYS: 7,
} as const;

// ─── 类型 ────────────────────────────────────────────────

/** 记忆源健康状态 */
export type SourceHealthStatus = 'healthy' | 'warning' | 'critical';

/** 单个 source 的健康指标 */
export interface SourceHealthEntry {
  /** 来源标签 */
  source: string;
  /** 记忆数量 */
  count: number;
  /** 平均 score（0-1） */
  avgScore: number;
  /** 距上次访问的天数（取该 source 中最近访问的记忆） */
  daysSinceLastAccess: number;
  /** 健康状态：healthy（score≥0.5 且 7 天内有访问）/ warning（score<0.5 或 7-30 天未访问）/ critical（score<0.2 或 30 天以上未访问） */
  status: SourceHealthStatus;
}

/** 记忆源健康诊断报告 */
export interface SourceHealthReport {
  /** 各 source 健康指标 */
  sources: SourceHealthEntry[];
  /** 整体健康状态（取最差 source 的状态） */
  overallStatus: SourceHealthStatus;
  /** 诊断时间（ISO 8601） */
  diagnosedAt: string;
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
  /** 记忆唯一标识（source:name 格式） */
  id: string;
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

/**
 * 记忆顾问
 *
 * 从 MemoryInspector 拆分（QC-R2-11），负责基于记忆数据的分析计算：
 *   - sourceHealth()：记忆源健康诊断（数量、score、新鲜度）
 *   - suggest()：关联推荐（基于 score + 时效性 + 多样性）
 *
 * 与 MemoryInspector 的分工：
 *   - MemoryInspector：直接数据查询（snapshot/search/stats/relations + 写操作代理）
 *   - MemoryAdvisor：分析计算（健康诊断 + 推荐排序）
 */
export class MemoryAdvisor {
  /**
   * @param index - 记忆存储（只读访问，用于健康诊断和推荐计算）
   */
  constructor(private readonly index: IMemoryStorage) {}

  // ─── 源健康诊断 ─────────────────────────────────────────

  /**
   * 记忆源健康诊断
   *
   * 为每个 source 计算健康指标（数量、平均 score、新鲜度、状态），
   * 帮助宿主项目判断是否需要触发衰减、清理或补充。
   *
   * 健康状态判定：
   * - healthy：avgScore ≥ 0.5 且 7 天内有访问
   * - warning：avgScore < 0.5 或 7-30 天未访问
   * - critical：avgScore < 0.2 或 30 天以上未访问
   *
   * 纯只读、同步、不调 LLM，与 stats() 互补（stats 只有数量，本方法有质量指标）。
   * P2-2 优化：使用 getAllSources() 发现所有 source 标签，替代全量 search。
   */
  sourceHealth(): SourceHealthReport {
    const now = Date.now();

    // P2-2 使用 getAllSources() 获取所有有数据的 source 标签
    const sourceMap = this.index.getAllSources();
    const sourceSet = new Set<string>();
    for (const [source, count] of sourceMap) {
      if (count > 0) sourceSet.add(source);
    }

    // 逐 source 计算健康指标
    const entries: SourceHealthEntry[] = [];
    for (const source of sourceSet) {
      const memories = this.index.getBySource(source);
      const count = memories.length;

      // 平均 score
      const avgScore = count > 0
        ? memories.reduce((sum, m) => sum + m.score, 0) / count
        : 0;

      // 最近访问时间（取该 source 中最新的 accessedAt）
      const latestAccess = memories
        .map((m) => new Date(m.accessedAt).getTime())
        .filter((t) => !isNaN(t))
        .sort((a, b) => b - a)[0] ?? 0;
      const daysSinceLastAccess = latestAccess > 0
        ? (now - latestAccess) / ONE_DAY_MS
        : Infinity;

      // 健康状态判定
      let status: SourceHealthStatus;
      if (avgScore < SOURCE_HEALTH_THRESHOLDS.CRITICAL_SCORE || daysSinceLastAccess > SOURCE_HEALTH_THRESHOLDS.CRITICAL_DAYS) {
        status = 'critical';
      } else if (avgScore < SOURCE_HEALTH_THRESHOLDS.WARNING_SCORE || daysSinceLastAccess > SOURCE_HEALTH_THRESHOLDS.WARNING_DAYS) {
        status = 'warning';
      } else {
        status = 'healthy';
      }

      entries.push({
        source,
        count,
        avgScore: Math.round(avgScore * 1000) / 1000,
        daysSinceLastAccess: Math.round(daysSinceLastAccess * 10) / 10,
        status,
      });
    }

    // 整体状态取最差 source
    const statusPriority: Record<SourceHealthStatus, number> = { healthy: 0, warning: 1, critical: 2 };
    const overallStatus = entries.reduce<SourceHealthStatus>(
      (worst, e) => statusPriority[e.status] > statusPriority[worst] ? e.status : worst,
      'healthy',
    );

    return {
      sources: entries.sort((a, b) => statusPriority[b.status] - statusPriority[a.status]),
      overallStatus,
      diagnosedAt: nowIso(),
    };
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
        // 取 score 最高的前 N 条
        const top = memories.sort((a, b) => b.score - a.score).slice(0, SUGGEST_TOP_PER_SOURCE);
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
      // 时效性分：窗口内线性衰减，超过窗口归零
      const accessedAt = new Date(memory.accessedAt);
      const daysSinceAccess = isNaN(accessedAt.getTime())
        ? SUGGEST_RECENCY_WINDOW_DAYS
        : (now - accessedAt.getTime()) / ONE_DAY_MS;
      const recency = Math.max(0, 1 - daysSinceAccess / SUGGEST_RECENCY_WINDOW_DAYS);

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
      id: memory.id,
      name: memory.name,
      source: memory.source,
      relevance: Math.round(relevance * 100) / 100,
      contentPreview: memory.content.length > ADVISOR_PREVIEW_LEN ? memory.content.slice(0, ADVISOR_PREVIEW_LEN) + '...' : memory.content,
      reason,
    }));
  }
}
