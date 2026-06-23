/**
 * 记忆控制器 — 记忆管理 + 仪表盘
 *
 * 职责：
 *   1. 记忆 CRUD 操作（list/show/delete/upsert）
 *   2. 记忆搜索（混合搜索 + 降级）
 *   3. 仪表盘数据聚合
 */
import type { Agent, SuggestHit, VectorStore } from 'memora';
import { logger } from 'memora';

/** 仪表盘数据 */
export interface DashboardData {
  /** 记忆总数 */
  total: number;
  /** 按来源分组的记忆数量 */
  bySource: Record<string, number>;
  /** 关联推荐列表 */
  suggestions: SuggestHit[];
}

/** 记忆列表项 */
export interface MemoryListItem {
  id: string;
  name: string;
  source: string;
  score: number;
  contentPreview: string;
  /** P3-FLOW-14 创建时间（ISO 8601 字符串），用于列表项展示 */
  createdAt?: string;
}

/** 记忆详情 */
export interface MemoryDetail {
  id: string;
  name: string;
  source: string;
  score: number;
  content: string;
  createdAt: string;
  accessedAt: string;
}

/** 搜索结果项 */
export interface MemorySearchResult {
  /** 记忆唯一标识（${source}:${name} 格式） */
  id: string;
  name: string;
  source: string;
  score: number;
  contentPreview: string;
  similarity?: number;
}

/**
 * 记忆控制器
 */
export class MemoryController {
  private agent: Agent;
  private vectorStore: VectorStore | null;

  constructor(agent: Agent, vectorStore?: VectorStore) {
    this.agent = agent;
    this.vectorStore = vectorStore ?? null;
  }

  // ─── 记忆 CRUD ────────────────────────────────────────

  /**
   * 列出记忆（可按 source 过滤）
   *
   * @param source 可选的来源过滤条件
   * @param limit 返回数量上限，默认 50
   * @returns 记忆列表项数组
   */
  list(source?: string, limit = 50): MemoryListItem[] {
    // P2-DESIGN-6 修复：统一通过 agent.memory 访问，不再绕过 inspector 直接访问 agent.storage
    const inspector = this.agent.memory;
    if (!inspector) return [];
    // P1-2 修复：传 source 时也应用 limit，避免全量返回破坏契约
    const memories = source
      ? inspector.getBySource(source).slice(0, limit)
      : inspector.list(limit);

    return memories.map(m => ({
      id: m.id,
      name: m.name,
      source: m.source,
      score: this.#formatScore(m.score),
      contentPreview: m.content.length > 100 ? m.content.slice(0, 100) + '...' : m.content,
      // P3-FLOW-14 携带创建时间用于列表项展示（m.createdAt 为 ISO 8601 字符串）
      createdAt: m.createdAt,
    }));
  }

  /**
   * 查看单条记忆详情
   *
   * @param id 记忆唯一标识（${source}:${name} 格式）
   * @returns 记忆详情，不存在时返回 null
   */
  show(id: string): MemoryDetail | null {
    // P2-DESIGN-6 修复：统一通过 agent.memory 访问
    const inspector = this.agent.memory;
    if (!inspector) return null;
    const m = inspector.getById(id);
    if (!m) return null;
    return {
      id: m.id,
      name: m.name,
      source: m.source,
      score: this.#formatScore(m.score),
      content: m.content,
      // R5 日期返回 ISO 8601 原始字符串，由 UI 层根据 locale 格式化
      // P1-3 修复：非法日期字符串会导致 new Date(...).toISOString() 抛 RangeError，加 try/catch 降级
      createdAt: this.#toIso(m.createdAt),
      accessedAt: this.#toIso(m.accessedAt),
    };
  }

  /** 安全转换为 ISO 字符串，非法日期降级为原始值 */
  #toIso(date: string | number): string {
    const parsed = new Date(date);
    return isNaN(parsed.getTime()) ? String(date) : parsed.toISOString();
  }

  /** 格式化记忆分数，保留两位小数 */
  #formatScore(score: number): number {
    return Math.round(score * 100) / 100;
  }

  /**
   * 删除记忆
   *
   * 同步删除向量索引中对应的向量条目。
   *
   * @param id 记忆唯一标识
   * @returns 是否成功删除
   */
  delete(id: string): boolean {
    // P2-DESIGN-6 修复：统一通过 agent.memory 访问
    const inspector = this.agent.memory;
    if (!inspector) return false;
    const exists = inspector.getById(id);
    if (!exists) return false;
    inspector.delete(id);
    // 同步删除向量索引
    this.vectorStore?.delete(id);
    return true;
  }

  /**
   * 添加或更新记忆
   *
   * 同时异步更新向量索引，失败时降级为纯关键词召回。
   *
   * @param source 记忆来源
   * @param name 记忆名称
   * @param content 记忆内容
   * @param score 初始权重，默认 0.5
   * @returns 记忆唯一标识（${source}:${name} 格式）
   */
  upsert(source: string, name: string, content: string, score = 0.5): string {
    // P2-DESIGN-6 修复：统一通过 agent.memory 访问
    const inspector = this.agent.memory;
    if (!inspector) throw new Error('存储不可用');
    const now = new Date().toISOString();
    const id = `${source}:${name}`;
    inspector.upsert({
      id,
      source,
      name,
      content,
      score,
      createdAt: now,
      accessedAt: now,
    });
    // 异步更新向量索引
    if (this.vectorStore) {
      this.vectorStore.upsert(id, content).catch(err => {
        logger.warn({ err, id }, '向量索引更新失败，降级为纯关键词召回');
      });
    }
    return id;
  }

  // ─── 记忆搜索 ──────────────────────────────────────────

  /**
   * 混合搜索记忆（语义 + 关键词双通道）
   *
   * 优先使用向量搜索，失败时降级为纯关键词搜索。
   *
   * @param query 搜索关键词
   * @param limit 返回数量上限，默认 10
   * @returns 搜索结果列表
   */
  async search(query: string, limit = 10): Promise<MemorySearchResult[]> {
    const inspector = this.agent.memory;
    if (!inspector) return [];
    try {
      return await inspector.searchHybrid(query, limit);
    } catch (error) {
      // 降级到纯关键词搜索，记录降级原因辅助排查
      logger.warn({ err: error, query }, '混合搜索失败，降级为纯关键词搜索');
      return inspector.search(query, limit);
    }
  }

  // ─── 仪表盘 ────────────────────────────────────────────

  /**
   * 获取记忆仪表盘数据
   *
   * @returns 仪表盘数据（总数、按来源分组、推荐列表）
   */
  dashboard(): DashboardData {
    // 空值守卫：memory 模块未初始化时返回空仪表盘（降级而非崩溃）
    const memory = this.agent.memory;
    if (!memory) {
      return { total: 0, bySource: {}, suggestions: [] };
    }
    const stats = memory.stats();
    const suggestions = memory.suggest(undefined, { limit: 5 });
    return {
      total: stats.total,
      bySource: stats.bySource,
      suggestions,
    };
  }

}
