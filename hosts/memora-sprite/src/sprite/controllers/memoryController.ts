/**
 * 记忆控制器 — 记忆管理 + 仪表盘
 *
 * 职责：
 *   1. 记忆 CRUD 操作（list/show/delete/upsert）
 *   2. 记忆搜索（混合搜索 + 降级）
 *   3. 仪表盘数据聚合
 */
import type { Agent, SuggestHit, VectorStore } from 'memora';
import type { MemoryRelation } from 'memora';
import { logger } from 'memora';

// ─── 默契度阈值常量（Phase 2.2） ─────────────────────────
// 经验值，后续基于真实数据校准
/** stranger → acquaintance 阈值：记忆总数 */
const RAPPORT_THRESHOLD_TOTAL_STRANGER = 5;
/** acquaintance → familiar 阈值：用户画像记忆数 */
const RAPPORT_THRESHOLD_PROFILE_ACQUAINTANCE = 10;
/** familiar → close 阈值：洞察记忆数 */
const RAPPORT_THRESHOLD_INSIGHT_FAMILIAR = 50;

/** 仪表盘数据 */
export interface DashboardData {
  /** 记忆总数 */
  total: number;
  /** 按来源分组的记忆数量 */
  bySource: Record<string, number>;
  /** 关联推荐列表 */
  suggestions: SuggestHit[];
  /** 关系边总数（ADR-014，relationStore 未注入时为 0） */
  relationCount: number;
}

/**
 * 默契度等级（Phase 2.2）
 *
 * 从记忆仪表盘数据实时推导，不持久化、不依赖 LLM。
 * 阈值为经验值，后续基于真实数据校准。
 */
export type RapportLevel = 'stranger' | 'acquaintance' | 'familiar' | 'close';

/** 默契度评估结果 */
export interface RapportAssessment {
  /** 默契度等级 */
  level: RapportLevel;
  /** 等级描述（用于 UI 展示） */
  description: string;
  /** 影响因素列表（用于 UI 展示） */
  factors: string[];
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
    // 统一通过 agent.memory 访问
    const inspector = this.agent.memory;
    if (!inspector) return [];
    // 传 source 时也应用 limit，避免全量返回
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
      return { total: 0, bySource: {}, suggestions: [], relationCount: 0 };
    }
    const stats = memory.stats();
    const suggestions = memory.suggest(undefined, { limit: 5 });
    return {
      total: stats.total,
      bySource: stats.bySource,
      suggestions,
      relationCount: stats.relationCount,
    };
  }

  // ─── 默契度（Phase 2.2） ───────────────────────────────

  /**
   * 评估默契度等级（纯代码推导，不依赖 LLM）
   *
   * 从仪表盘数据实时推导，不持久化。阈值为经验值，后续基于真实数据校准。
   *
   * 判定逻辑（按优先级）：
   *   1. totalMemories < 5 → stranger（初识）
   *   2. profileCount < 10 → acquaintance（相识）
   *   3. insightCount < 50 → familiar（熟悉）
   *   4. else → close（亲密）
   *
   * @returns 默契度评估结果（等级 + 描述 + 影响因素）
   */
  rapportLevel(): RapportAssessment {
    const dashboard = this.dashboard();
    const totalMemories = dashboard.total;
    const profileCount = dashboard.bySource['profile'] ?? 0;
    const insightCount = dashboard.bySource['insight'] ?? 0;
    const relationCount = dashboard.relationCount;

    // 等级判定（按优先级，命中即返回）
    if (totalMemories < RAPPORT_THRESHOLD_TOTAL_STRANGER) {
      return {
        level: 'stranger',
        description: '初识阶段，精灵正在了解你',
        factors: [`记忆总数 ${totalMemories}/${RAPPORT_THRESHOLD_TOTAL_STRANGER}`],
      };
    }

    if (profileCount < RAPPORT_THRESHOLD_PROFILE_ACQUAINTANCE) {
      return {
        level: 'acquaintance',
        description: '相识阶段，精灵记住了你的部分偏好',
        factors: [
          `用户画像 ${profileCount}/${RAPPORT_THRESHOLD_PROFILE_ACQUAINTANCE}`,
          `记忆总数 ${totalMemories}`,
        ],
      };
    }

    if (insightCount < RAPPORT_THRESHOLD_INSIGHT_FAMILIAR) {
      return {
        level: 'familiar',
        description: '熟悉阶段，精灵理解了你的习惯',
        factors: [
          `洞察记忆 ${insightCount}/${RAPPORT_THRESHOLD_INSIGHT_FAMILIAR}`,
          `用户画像 ${profileCount}`,
          `关系边 ${relationCount}`,
        ],
      };
    }

    return {
      level: 'close',
      description: '亲密阶段，精灵与你默契十足',
      factors: [
        `洞察记忆 ${insightCount}`,
        `用户画像 ${profileCount}`,
        `关系边 ${relationCount}`,
      ],
    };
  }

  // ─── 关系图谱（ADR-014） ────────────────────────────────

  /**
   * 获取记忆关系图谱（节点 + 边）
   *
   * 用于宿主 UI 渲染拓扑可视化。返回所有记忆作为节点，所有关系作为边。
   * relationStore 未注入时 edges 为空数组（向后兼容）。
   *
   * @returns 图谱数据：nodes（记忆列表）+ edges（关系边列表）
   */
  getRelationGraph(): { nodes: MemoryListItem[]; edges: MemoryRelation[] } {
    const memory = this.agent.memory;
    if (!memory) {
      return { nodes: [], edges: [] };
    }
    // 节点：复用 list() 获取所有记忆
    const nodes = this.list(undefined, 200);
    // 边：通过 MemoryInspector.getAllRelations() 获取全量关系
    const edges = memory.getAllRelations();
    return { nodes, edges };
  }
}
