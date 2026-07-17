/**
 * 记忆控制器 — 记忆管理 + 仪表盘
 *
 * 职责：
 *   1. 记忆 CRUD 操作（list/show/delete/upsert）
 *   2. 记忆搜索（混合搜索 + 降级）
 *   3. 仪表盘数据聚合
 */
import type { Agent, SuggestHit, IVectorStore, Memory } from 'memora';
import type { MemoryRelation, RelationPath, RelationNeighbor } from 'memora';
// L1~L3 LLM 治理报告类型：用于 controller 委托方法返回类型注解（内核已 re-export）
import type { DedupReport, TimelinessReport, ConflictReport } from 'memora';
import { logger } from 'memora';
import { DEFAULT_LIST_LIMIT } from '../constants.js';
import { SpriteError, ErrorCode } from '../errors.js';
import { buildHealthDashboard } from './memoryHealth.js';
import type { HealthDashboard } from './memoryHealth.js';
import { buildReviewData } from './reviewManager.js';
import type { ReviewData } from './reviewManager.js';
// 文本截断工具（跨层共享，统一 ellipsis 为 '…'，ADR-017 枝叶层 2 次提取）
import { truncate } from '../../shared/truncate.js';

// ─── 内核类型 re-export（Phase 5.1/5.2：路径追溯 + 邻居查询） ──────
// 精灵层不重新定义平行结构，直接复用内核 RelationPath/RelationNeighbor（纯数据形态，
// 无 Date 等不可序列化字段）。preload 通过此 re-export 导入，保持"sprite 层是真理源"依赖方向。
export type { RelationPath, RelationNeighbor } from 'memora';

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
  /** 冲突关系数（type='contradicts' 的边数，用于健康度指标） */
  conflictCount: number;
}

/**
 * 关系图谱节点数上限
 *
 * 用于 getRelationGraph() 的节点截断，避免大规模记忆库（>200 条）返回过多节点
 * 导致渲染层性能问题。后续可由调用方配置，当前硬编码为经验值。
 */
const RELATION_GRAPH_MAX_NODES = 200;

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
  /** 创建时间（ISO 8601 字符串），用于列表项展示 */
  createdAt?: string;
}

/** 回收站记忆列表项 */
export interface DeletedMemoryListItem {
  /** 记忆唯一标识 */
  id: string;
  /** 记忆名称 */
  name: string;
  /** 来源标签 */
  source: string;
  /** 内容预览（截断到 100 字符） */
  contentPreview: string;
  /** 软删除时间（ISO 8601，用于回收站展示删除时间） */
  deletedAt: string;
}

/** 记忆详情中的关联记忆条目 */
export interface MemoryRelationItem {
  /** 关联的记忆 ID */
  targetId: string;
  /** 关联的记忆名称 */
  targetName: string;
  /** 关系类型 */
  type: string;
  /** 关系权重 */
  weight: number;
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
  /** 关联记忆列表（包含冲突/支持/跟随等关系） */
  relations: MemoryRelationItem[];
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
  /** 创建时间（ISO 8601，由内核 AgentSearchHit 透传，供 UI 层时间筛选/排序使用） */
  createdAt?: string;
}

/**
 * 记忆控制器
 */
export class MemoryController {
  private agent: Agent;
  private vectorStore: IVectorStore | null;
  /**
   * 每日消息计数提供者
   *
   * 由 Sprite 在实例化后通过 setMessageCountProvider 注入，避免 MemoryController
   * 反向依赖 Sprite（保持依赖方向：sprite → memoryController → reviewManager）。
   * 未注入时返回空对象，buildReviewData 内 ?? 0 兜底，保持向后兼容。
   */
  private messageCountProvider: () => Record<string, number> = () => ({});

  constructor(agent: Agent, vectorStore?: IVectorStore) {
    this.agent = agent;
    this.vectorStore = vectorStore ?? null;
  }

  /**
   * 注入每日消息计数提供者
   *
   * 由 Sprite 在构造后立即调用，将自身 dailyMessageCount Map 转换为 Record 暴露给本控制器。
   * 设计为 setter 而非构造参数，避免 MemoryController 构造签名变更影响测试。
   *
   * @param provider 返回最近 7 天每日消息计数的函数（key=YYYY-MM-DD）
   */
  setMessageCountProvider(provider: () => Record<string, number>): void {
    this.messageCountProvider = provider;
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

    return memories.map((m: Memory) => ({
      id: m.id,
      name: m.name,
      source: m.source,
      score: this.#formatScore(m.score),
      contentPreview: truncate(m.content, 100),
      // 携带创建时间用于列表项展示（m.createdAt 为 ISO 8601 字符串）
      createdAt: m.createdAt,
    }));
  }

  /**
   * 查看单条记忆详情
   *
   * @param id 记忆唯一标识（${source}:${name} 格式）
   * @returns 记忆详情（含关联记忆列表），不存在时返回 null
   */
  show(id: string): MemoryDetail | null {
    // 统一通过 agent.memory 访问
    const inspector = this.agent.memory;
    if (!inspector) return null;
    const m = inspector.getById(id);
    if (!m) return null;

    // 查询与该记忆直接关联的邻居（复用内核 getRelationNeighbors，替代手动遍历）
    const neighbors = inspector.getRelationNeighbors(id);
    const relations: MemoryRelationItem[] = neighbors.map((n) => ({
      targetId: n.memoryId,
      targetName: n.memoryName,
      type: n.relationType,
      weight: n.relationWeight,
    }));

    return {
      id: m.id,
      name: m.name,
      source: m.source,
      score: this.#formatScore(m.score),
      content: m.content,
      // R5 日期返回 ISO 8601 原始字符串，由 UI 层根据 locale 格式化
      // 非法日期字符串会导致 new Date(...).toISOString() 抛 RangeError，加 try/catch 降级
      createdAt: this.#toIso(m.createdAt),
      accessedAt: this.#toIso(m.accessedAt),
      relations,
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
   * 软删除记忆（移入回收站，保留向量索引以便恢复）
   *
   * 软删除后记忆不再出现在召回/搜索/列表中，但可通过 restore() 恢复。
   * 向量索引条目保留（recall 通过 getById 过滤已软删除的，不会误召回）。
   *
   * @param id 记忆唯一标识
   * @returns 是否成功软删除（不存在或已软删除时返回 false）
   */
  delete(id: string): boolean {
    // 读写统一走 MemoryInspector（writeXxx 前缀区分写操作）
    const memory = this.agent.memory;
    if (!memory) return false;
    // getById 返回 null 表示不存在或已软删除
    const exists = memory.getById(id);
    if (!exists) return false;
    memory.writeDelete(id);
    // 软删除不删除向量索引，restore 时无需重新嵌入
    return true;
  }

  /**
   * 批量删除记忆（逐条软删除）
   *
   * 逐条调用 delete 进行软删除，跳过不存在或已删除的记忆。
   * IPC handler 传入的 ids 可能含非法值，在此做类型守卫过滤。
   *
   * @param ids 记忆 ID 列表
   * @returns { deleted, total } 成功删除数量和传入总数
   */
  deleteBatch(ids: string[]): { deleted: number; total: number } {
    let deleted = 0;
    for (const id of ids) {
      // 跳过非字符串和空字符串（IPC 传入的 ids 可能含非法值）
      if (typeof id === 'string' && id.length > 0 && this.delete(id)) {
        deleted++;
      }
    }
    return { deleted, total: ids.length };
  }

  /**
   * 恢复软删除的记忆
   *
   * 将记忆从回收站恢复为活跃态。向量索引无需操作（软删除时未删除）。
   *
   * @param id 记忆唯一标识
   * @returns 是否成功恢复（不存在或未软删除时返回 false）
   */
  restore(id: string): boolean {
    // 读写统一走 MemoryInspector（writeXxx 前缀区分写操作）
    const memory = this.agent.memory;
    if (!memory) return false;
    // SEC-GAP6-02：用 getDeletedById 替代 listDeleted().some()，避免 50 条上限
    const deleted = memory.getDeletedById(id);
    if (!deleted) return false;
    memory.writeRestore(id);
    return true;
  }

  /**
   * 物理删除记忆（彻底删除，不可恢复）
   *
   * 从存储中永久删除，同时清理向量索引。
   * 仅用于回收站的"彻底删除"操作——只允许物理删除已软删除的记忆，
   * 活跃记忆必须先通过 delete() 软删除进入回收站，再从此处彻底删除。
   *
   * 安全约束（SEC-GAP6-01）：防止被攻陷的渲染进程通过 IPC 直接 purge
   * 活跃记忆绕过软删除保护，造成不可恢复的数据丢失。
   *
   * @param id 记忆唯一标识
   * @returns 是否成功删除（记忆不在回收站时返回 false）
   */
  purge(id: string): boolean {
    // 读写统一走 MemoryInspector（writeXxx 前缀区分写操作）
    const memory = this.agent.memory;
    if (!memory) return false;
    // SEC-GAP6-02：用 getDeletedById 替代 listDeleted().some()，避免 50 条上限
    const deleted = memory.getDeletedById(id);
    if (!deleted) return false;
    memory.writePurge(id);
    // 物理删除时同步清理向量索引（对齐 upsert 错误处理）
    if (this.vectorStore) {
      try {
        this.vectorStore.delete(id);
      } catch (err) {
        logger.warn({ err, id }, '向量索引删除失败，可能残留孤儿向量');
      }
    }
    // 物理删除时同步清理关系边，防止 memory_relations 残留孤儿边
    // （软删除时保留关系边，restore 后自然恢复）
    const removedRelations = memory.writeRemoveRelationsByMemoryId(id);
    if (removedRelations > 0) {
      logger.info({ id, removedRelations }, '物理删除记忆时清理了关联关系边');
    }
    return true;
  }

  /**
   * 列出回收站中的软删除记忆
   *
   * @param limit 返回数量上限，默认 50
   * @returns 回收站记忆列表项数组
   */
  listDeleted(limit = 50): DeletedMemoryListItem[] {
    const inspector = this.agent.memory;
    if (!inspector) return [];
    const deleted = inspector.listDeleted(limit);
    return deleted.map((m) => ({
      id: m.id,
      name: m.name,
      source: m.source,
      contentPreview: truncate(m.content, 100),
      // deletedAt 非 undefined 已由 listDeleted 保证
      deletedAt: m.deletedAt!,
    }));
  }

  /**
   * 批量恢复回收站中所有软删除记忆
   *
   * @returns 成功恢复的记忆数量
   */
  restoreAll(): { restored: number; failed: number } {
    const memory = this.agent.memory;
    if (!memory) return { restored: 0, failed: 0 };
    // 获取所有已删除记忆（不设上限）
    const deleted = memory.listDeleted(0);
    let restored = 0;
    let failed = 0;
    for (const m of deleted) {
      try {
        memory.writeRestore(m.id);
        restored++;
      } catch (err) {
        logger.warn({ err, id: m.id }, '批量恢复记忆失败');
        failed++;
      }
    }
    return { restored, failed };
  }

  /**
   * 批量彻底删除回收站中所有记忆
   *
   * @returns 成功删除的记忆数量
   */
  purgeAll(): { purged: number; failed: number } {
    const memory = this.agent.memory;
    if (!memory) return { purged: 0, failed: 0 };
    // 获取所有已删除记忆（不设上限）
    const deleted = memory.listDeleted(0);
    let purged = 0;
    let failed = 0;
    for (const m of deleted) {
      try {
        memory.writePurge(m.id);
        // 同步清理向量索引
        if (this.vectorStore) {
          try {
            this.vectorStore.delete(m.id);
          } catch (err) {
            logger.warn({ err, id: m.id }, '批量清空时向量索引删除失败');
          }
        }
        // 同步清理关系边（与 purge 单条语义一致）
        memory.writeRemoveRelationsByMemoryId(m.id);
        purged++;
      } catch (err) {
        logger.warn({ err, id: m.id }, '批量清空记忆失败');
        failed++;
      }
    }
    return { purged, failed };
  }

  /**
   * 添加或更新记忆
   *
   * 同时异步更新向量索引，失败时降级为纯关键词召回。
   *
   * 编辑场景下保留已有记忆的 score 和 createdAt，避免编辑后：
   * - score 重置为默认值（用户长期积累的高分被清零）
   * - createdAt 重置为当前时间（破坏时间线视图和按创建时间排序）
   * 首次创建时使用传入的 score 和当前时间。
   *
   * @param source 记忆来源
   * @param name 记忆名称
   * @param content 记忆内容
   * @param score 初始权重，默认 0.5（仅首次创建时生效，编辑时保留原值）
   * @returns 记忆唯一标识（${source}:${name} 格式）
   */
  upsert(source: string, name: string, content: string, score = 0.5): string {
    // 写操作走 MemoryInspector.writeUpsert
    const memory = this.agent.memory;
    if (!memory) throw new SpriteError(ErrorCode.STORAGE_ERROR, '存储不可用');
    const id = `${source}:${name}`;
    const now = new Date().toISOString();
    // 读取已有记忆以保留 score 和 createdAt（仅活跃记忆，软删除的同 ID 视为新建）
    const existing = memory.getById(id);
    memory.writeUpsert({
      id,
      source,
      name,
      content,
      // 编辑场景保留原 score（避免高分清零），首次创建使用传入 score
      score: existing ? existing.score : score,
      // 编辑场景保留原 createdAt（避免时间线错乱），首次创建使用当前时间
      createdAt: existing ? existing.createdAt : now,
      accessedAt: now,
    });
    // 异步更新向量索引
    if (this.vectorStore) {
      this.vectorStore.upsert(id, content).catch((err: unknown) => {
        logger.warn({ err, id }, '向量索引更新失败，降级为纯关键词召回');
      });
    }
    return id;
  }

  /**
   * 提升记忆的 score（L2 采纳反哺内核）
   *
   * 用户在补全模块采纳某条候选后调用此方法，将用户行为反馈到内核 Memory.score，
   * 实现"越常用越重要"的主动学习（与召回时被动 boost 语义一致）。
   *
   * @param id 记忆唯一标识（${source}:${name} 格式）
   * @returns 是否成功提升（记忆不存在时返回 false，如候选来自对话历史）
   */
  boostMemory(id: string): boolean {
    const memory = this.agent.memory;
    if (!memory) throw new SpriteError(ErrorCode.STORAGE_ERROR, '存储不可用');
    return memory.writeBoost(id);
  }

  // ─── LLM 记忆治理（L1~L3，G1：委托 agent 委托方法） ──
  // 这三个方法均为异步（调用 LLM），失败时由内核 manager 内部降级返回报告，不抛错。
  // 与 boostMemory 同模式：controller 仅透传，不附加业务逻辑。

  /**
   * L1 语义去重（委托 agent.deduplicateMemories）
   *
   * 扫描名称相似的记忆对，调用 LLM 判断语义等价，降级低分记忆（score→0.1）。
   * 仅降级不物理删除，用户可通过 restore() 恢复。
   *
   * @returns 去重报告（扫描数 / 降级 ID 列表 / 跳过原因）
   */
  async deduplicateMemories(): Promise<DedupReport> {
    return this.agent.deduplicateMemories();
  }

  /**
   * L2 时效性评估（委托 agent.evaluateTimeliness）
   *
   * 扫描低分记忆（score<0.3），调用 LLM 判断是否过时，降级过时记忆（score→0.05）。
   * 用于健康度面板"时效性评估"按钮手动触发。
   *
   * @returns 评估报告（扫描数 / 过时数 / 降级 ID 列表 / 跳过原因）
   */
  async evaluateTimeliness(): Promise<TimelinessReport> {
    return this.agent.evaluateTimeliness();
  }

  /**
   * L3 冲突检测（委托 agent.detectConflicts）
   *
   * 同 source 内配对，调用 LLM 判断语义冲突，仅检测不修复（需用户决策）。
   *
   * @returns 冲突报告（扫描数 / 冲突数 / 冲突详情列表 / 跳过原因）
   */
  async detectConflicts(): Promise<ConflictReport> {
    return this.agent.detectConflicts();
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
      return { total: 0, bySource: {}, suggestions: [], relationCount: 0, conflictCount: 0 };
    }
    const stats = memory.stats();
    const suggestions = memory.suggest(undefined, { limit: 5 });
    // 统计冲突关系数：遍历所有关系边，type === 'contradicts' 的即为冲突
    const allEdges = memory.getAllRelations();
    const conflictCount = allEdges.filter((e) => e.type === 'contradicts').length;
    return {
      total: stats.total,
      bySource: stats.bySource,
      suggestions,
      relationCount: stats.relationCount,
      conflictCount,
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
    // 节点：复用 list() 获取记忆（上限提取为常量 RELATION_GRAPH_MAX_NODES）
    const nodes = this.list(undefined, RELATION_GRAPH_MAX_NODES);
    // 边：通过 MemoryInspector.getAllRelations() 获取全量关系
    const edges = memory.getAllRelations();
    return { nodes, edges };
  }

  /**
   * 添加记忆关系（手动创建）
   *
   * 用于宿主 UI 关系图交互：右键菜单 → 连线 → 创建关系。
   * relationStore 未注入时静默降级。
   *
   * @param sourceId 关系起点记忆 ID
   * @param targetId 关系终点记忆 ID
   * @param type 关系类型（开放字符串，如 'supports'、'contradicts'）
   * @param weight 关系权重 0-1
   */
  addRelation(sourceId: string, targetId: string, type: string, weight: number): void {
    const memory = this.agent.memory;
    if (!memory) return;
    memory.writeAddRelation({
      sourceId,
      targetId,
      type,
      weight,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * 删除记忆关系
   *
   * 用于宿主 UI 关系图交互：编辑关系弹窗 → 删除关系。
   * relationStore 未注入时静默降级。
   *
   * @param sourceId 关系起点
   * @param targetId 关系终点
   * @param type 关系类型
   */
  removeRelation(sourceId: string, targetId: string, type: string): void {
    const memory = this.agent.memory;
    if (!memory) return;
    memory.writeRemoveRelation(sourceId, targetId, type);
  }

  /**
   * 更新记忆关系（先删后加，实现修改类型/权重）
   *
   * 用于宿主 UI 关系图交互：编辑关系弹窗 → 修改类型/权重 → 保存。
   *
   * 修复 T1：原实现仅调用 addRelation（UPSERT），修改 type 时旧三元组不被删除，
   * 留下孤儿边。现查询 (sourceId, targetId) 下所有现有 type，删除与新 type 不同的旧关系，
   * 再 addRelation 新三元组（同 type 时由 UPSERT 覆盖 weight）。
   *
   * @param sourceId 关系起点
   * @param targetId 关系终点
   * @param type 新的关系类型
   * @param weight 新的关系权重
   */
  updateRelation(sourceId: string, targetId: string, type: string, weight: number): void {
    const memory = this.agent.memory;
    if (!memory) return;
    // 查询 sourceId 出发的所有关系，筛选出 targetId 匹配的旧关系
    const existingRelations = memory.getRelations(sourceId, 'outgoing')
      .filter((r) => r.targetId === targetId);
    // 删除与新 type 不同的旧关系（同 type 由后续 addRelation UPSERT 覆盖 weight）
    for (const r of existingRelations) {
      if (r.type !== type) {
        memory.writeRemoveRelation(r.sourceId, r.targetId, r.type);
      }
    }
    // 添加新关系（UPSERT 语义：同三元组覆盖 weight）
    memory.writeAddRelation({
      sourceId,
      targetId,
      type,
      weight,
      createdAt: new Date().toISOString(),
    });
  }

  // ─── 记忆关系路径追溯与邻居查询（Phase 5.1/5.2 内核能力透传） ───

  /**
   * 获取记忆的关系路径（追溯来源或去向）
   *
   * 从指定记忆出发，沿关系边追溯完整路径，用于 UI 展示记忆的演化脉络。
   * 内核已实现 BFS 遍历 + visited 防环 + maxDepth 深度限制。
   * relationStore 未注入时仅返回起点节点（降级优先，ADR-014）。
   *
   * @param memoryId - 起点记忆 ID
   * @param maxDepth - 最大追溯深度（默认 5）
   * @param direction - 追溯方向：'incoming'（追溯来源，默认）/ 'outgoing' / 'both'
   * @returns 路径节点列表，按 depth 升序
   */
  getRelationPath(
    memoryId: string,
    maxDepth = 5,
    direction: 'incoming' | 'outgoing' | 'both' = 'incoming',
  ): RelationPath[] {
    const memory = this.agent.memory;
    if (!memory) return [];
    return memory.getRelationPath(memoryId, maxDepth, direction);
  }

  /**
   * 获取记忆的关系邻居（直接关联的记忆）
   *
   * 返回与指定记忆直接关联的记忆列表，含关系类型和方向。
   * 用于 UI 展示某记忆的直接关联记忆（如冲突记忆、支持记忆等）。
   * relationStore 未注入时返回空数组（降级优先，ADR-014）。
   *
   * @param memoryId - 基准记忆 ID
   * @param limit - 返回数量上限（默认 10）
   * @returns 邻居记忆列表，含关系类型/权重/方向
   */
  getRelationNeighbors(memoryId: string, limit = 10): RelationNeighbor[] {
    const memory = this.agent.memory;
    if (!memory) return [];
    return memory.getRelationNeighbors(memoryId, limit);
  }

  // ─── 记忆健康度（Phase 1：健康度诊断） ──────────────────

  /**
   * 获取记忆健康度仪表盘数据
   *
   * 纯计算，不依赖 LLM，不持久化。每次调用实时检测重复记忆、
   * 过期记忆和低质量记忆，生成健康度评分和清理建议。
   *
   * @returns 健康度仪表盘完整数据
   */
  getHealthDashboard(): HealthDashboard {
    const allMemories = this.list(undefined, DEFAULT_LIST_LIMIT);
    return buildHealthDashboard(allMemories);
  }

  // ─── 对话回顾（Phase 2：回顾与摘要） ──────────────────

  /**
   * 获取对话回顾数据
   *
   * 聚合最近对话的摘要、洞察和增长趋势。纯代码计算，不依赖 LLM。
   *
   * @returns 回顾面板完整数据
   */
  getReviewData(): ReviewData {
    const dashboard = this.dashboard();
    const allMemories = this.list(undefined, DEFAULT_LIST_LIMIT);
    // 注入每日消息计数，补齐 today.messageCount / daily[].messageCount
    return buildReviewData(dashboard, allMemories, this.messageCountProvider());
  }
}
