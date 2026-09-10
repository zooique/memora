/**
 * 记忆管理器 — 统一的记忆读写入口。
 * 写方法 writeXxx 前缀区分写操作。同步返回避免数据不一致；每层只返回前 N 条 + 总数（轻量）。
 * 职责边界：本类只做存储读写与查询；语义去重在 DedupManager，冲突检测/建议在 MemoryAdvisor。
 */
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { IVectorStore } from '@/memory/vectorStore.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { AgentLoop } from '@/agent/loop.js';
import { configError } from '@/utils/errors.js';
import { truncate } from '@/utils/strings.js';
import { logger } from '@/logging/logger.js';
import { backgroundTask } from '@/utils/backgroundTask.js';
// 融合排序算法 + 常量从 hybridMerge 导入（消除对 recall.ts 内部常量的依赖）
import { hybridMerge, RECALL_LIMIT_MULTIPLIER } from '@/memory/hybridMerge.js';

// ─── 常量 ────────────────────────────────────────────────

/** 工作记忆预览条数（最近 N 条） */
const WORKING_PREVIEW = 5;
/** 内容预览字符数（快照层） */
const CONTENT_PREVIEW_LEN = 80;
/** 搜索结果内容预览字符数（比快照层略长，便于用户判断相关性） */
const SEARCH_PREVIEW_LEN = 120;

// ─── 类型 ────────────────────────────────────────────────

/** 记忆快照（3 层：工作 / Bootstrap / 归档） */
export interface MemorySnapshot {
  /** 第 1 层：工作记忆（messages 数组） */
  working: WorkingMemorySnapshot;
  /** 第 2 层：Bootstrap 记忆 */
  bootstrap: BootstrapSnapshot;
  /** 第 3 层：归档记忆（round-summary） */
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
  }>;
}

/** 第 3 层：归档记忆快照（round-summary） */
export interface ArchiveSnapshot {
  archiveCount: number;
  currentSession: string;
  /** 当前会话全名（含日期前缀） */
  currentSessionName: string;
  hint: string;
  /** 归档记忆来源分布 */
  stats: {
    'round-summary': number;
  };
}

/** Agent 记忆搜索结果（cli 友好的扁平结构） */
export interface AgentSearchHit {
  /** 记忆唯一标识（${source}:${name} 格式） */
  id: string;
  name: string;
  /** 来源标签 */
  source: string;
  /** 内容预览（截断到 120 字符） */
  contentPreview: string;
  /** 语义相似度（0-1，仅 searchHybrid 返回） */
  similarity?: number;
  /** 创建时间（ISO 8601，供 UI 时间筛选） */
  createdAt?: string;
  /** 最近使用时间（ISO 8601，工具命中即 touch 刷新，§3.3/§5.2 事实字段：LLM 按此定「最近使用优先」） */
  accessedAt?: string;
  /** 溯源（round-summary 命中项）：会话标识（YYYY-MM-DD-sessionName，trace_summary 参数直通） */
  sessionId?: string;
  /** 溯源（round-summary 命中项）：轮次 ID（trace_summary 参数直通），LLM 零解析直用 */
  roundId?: string;
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
   * 构造记忆管理器。sourceHealth/suggest 由 Agent 门面直连 MemoryAdvisor，本类不持有 advisor（消除 3 层代理）。
   */
  constructor(
    private readonly index: IMemoryStorage,
    private readonly loop: AgentLoop,
    private readonly history: MessageHistory,
  ) {}

  /** 注入向量存储（Agent 初始化后调用，解决构造时序） */
  setVectorStore(vs: IVectorStore | null): void {
    this.vectorStore = vs;
  }

  // ─── 只读查询（IMemoryStorage 透传） ───────────────────

  /** 列出回收站软删除记忆。limit<=0 或 undefined 表示不设上限，否则返回最近 N 条（默认 undefined=全部）。 */
  listDeleted(limit?: number): Memory[] {
    return this.index.listDeleted(limit);
  }

  /** 按 ID 获取软删除记忆（用于 restore/purge 前存在性校验，避免 listDeleted 默认 50 上限导致超量时操作失效） */
  getDeletedById(id: string): Memory | null {
    return this.index.getDeletedById(id);
  }

  /** 按 ID 获取单条活跃记忆（已软删除的返回 null） */
  getById(id: string): Memory | null {
    return this.index.getById(id);
  }

  /** 按来源标签获取记忆列表（如 'persona'、'rule'、'round-summary'） */
  getBySource(source: string): Memory[] {
    return this.index.getBySource(source);
  }

  /**
   * 列出所有记忆（供宿主记忆管理面板）。允许空查询，返回按 accessedAt 降序列表。
   * search() 拒绝空查询防"静默全量返回"误用；list() 是显式声明列举全部。
   */
  list(limit = 50): Memory[] {
    return this.index.search('', limit);
  }

  // ─── 快照 ─────────────────────────────────────────────

  /** 统一查看记忆快照（3 层）：纯只读、同步返回、每层只返回前 N 条 + 总数。 */
  snapshot(): MemorySnapshot {
    // 第 1 层：工作记忆（AgentLoop 的 messages 数组）
    const workingFull = this.loop.getMessages();
    const workingTotal = workingFull.length;
    const working = workingFull.slice(-WORKING_PREVIEW);

    // 第 2 层 Bootstrap 恒空：设定记忆唯一归角色包，索引不再新增，rolePackPrompt 承载规则注入。
    // 保留空壳接口供 UI 层调用，避免宿主代码变更。

    // 第 3 层：归档记忆计数（round-summary，记忆库唯一对话记忆）
    const roundSummaryCount = this.index.countBySource(SOURCE_LABELS.ROUND_SUMMARY);
    const archiveTotal = roundSummaryCount;

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
        },
      },
    };
  }

  // ─── 搜索 ─────────────────────────────────────────────

  /** 搜索记忆（关键词 + FTS5 索引），返回 CLI 友好扁平结构（已截断） */
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
      // 截断长内容到搜索预览长度
      contentPreview: truncate(m.content, SEARCH_PREVIEW_LEN),
      createdAt: m.createdAt,
    }));
  }

  /**
   * 混合搜索记忆（语义 + 关键词双通道）。VectorStore 可用时补强语义缺口，向量搜索失败静默降级到关键词。
   * 融合排序委托 hybridMerge（与 recall() 共享，避免跨模块常量依赖）。
   *
   * 边界声明（v3 分层分轨，2026-08-27）：searchHybrid 是「记忆搜索工具」，不是召回管线——保持融合排序
   * **不分层分轨**：不应用 L1/L2 分层、不进池策略（preference 无条件进池 / intent 排除）、不做 cap 内分配
   * （capTokens / minSemanticShare）。分层分轨属「召回编排」（recall()，现仅由检查点恢复路径
   * `checkpointRestoreCoordinator.warmRecall` 调用；自动注入退役后 contextPreparer 已不再调用），搜索工具
   * 只暴露融合相关性结果，供宿主/上层按需自取（D2，见 memory-as-summary §4.5 边界标注）。
   *
   * @param excludeRoundIds 排除的轮次 ID 集合（可选）：这些轮次的 round-summary 已被装配期载入正文，
   *                       不重复返回（工具召回与装配期正文互斥，§5.1）；缺省不过滤。
   */
  async searchHybrid(
    query: string,
    limit = 10,
    excludeRoundIds?: ReadonlySet<string>,
  ): Promise<AgentSearchHit[]> {
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

    // 通道 1：语义搜索（VectorStore 可用时）
    if (this.vectorStore && this.vectorStore.size > 0) {
      try {
        const vectorResults = await this.vectorStore.search(
          query,
          limit * RECALL_LIMIT_MULTIPLIER,
          0.3,
        );
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

    // 通道 2：关键词搜索（补齐语义通道未覆盖的）
    const keywordResults = this.index.search(query, limit * RECALL_LIMIT_MULTIPLIER);
    for (const m of keywordResults) {
      if (!merged.has(m.id)) {
        merged.set(m.id, { memory: m, vectorScore: 0 });
      }
    }

    // 融合排序（hybridMerge 纯函数，与 recall() 共享）
    // 前置 superseded 过滤（与 recall 读路径 recall.ts:221 一致）：被 supersededBy 取代的摘要不作为当前事实
    // 返回（仍保留可回溯，trace_summary 可精确取原文）。在排序前过滤，避免占据 top-N 槽位挤掉有效命中。
    const active = [...merged.values()].filter((e) => !e.memory.supersededBy);
    // 工具召回与装配期正文互斥（§5.1）：排除当前会话最近已载入正文轮次的 round-summary，
    // 避免 LLM 拿回眼前内容的摘要重复（excludeRoundIds 由调用方按 getRecentRoundIds 计算，天然不含当轮）。
    // 被排除者不补位（工具语义）：返回更聚焦的结果即可，不强制凑满 limit。
    const unexcluded =
      excludeRoundIds && excludeRoundIds.size > 0
        ? active.filter((e) => !e.memory.roundId || !excludeRoundIds.has(e.memory.roundId))
        : active;
    const sorted = hybridMerge(unexcluded, limit);

    // 排序语义（§5.2 定案）：仅返回 hybridMerge 融合序（语义相关主），不引入 accessedAt 时间主序——
    // accessedAt 只作为事实字段揭示（工具命中 touch 刷新），优先级判断归 LLM 结合任务定夺。
    return sorted.map(({ memory, vectorScore }) => ({
      id: memory.id,
      name: memory.name,
      source: memory.source,
      similarity: vectorScore,
      contentPreview: truncate(memory.content, SEARCH_PREVIEW_LEN),
      createdAt: memory.createdAt,
      accessedAt: memory.accessedAt,
      // 结构化溯源（§3.3「返回」行）：round-summary 命中项显式附 sessionId/roundId，
      // 与 trace_summary 参数直通——LLM 零解析直用（替代原先隐式埋在 name 的未文档化格式契约）。
      // 字段值源：round-summary 顶层持久化 sessionName（= YYYY-MM-DD-sessionName，即 trace_summary 的 sessionId）
      // + roundId，A1 边界定案：宿主 SQLite 不持久化 metadata，故不从 metadata 读。
      sessionId: memory.sessionName,
      roundId: memory.roundId,
    }));
  }

  // ─── 统计 ─────────────────────────────────────────────

  /** 记忆库统计：用 getAllSources() 一次查询来源分布（含宿主自定义标签），避免逐 source 多次 count */
  stats(): AgentStats {
    const total = this.index.count();

    const sourceMap = this.index.getAllSources();
    const bySource: Record<string, number> = {};
    for (const [source, count] of sourceMap) {
      if (count > 0) bySource[source] = count;
    }

    return { bySource, total };
  }

  // ─── 写操作（writeXxx 前缀，IMemoryStorage 透传） ───

  /** 插入或更新记忆 */
  writeUpsert(memory: Memory): void {
    this.index.upsert(memory);
  }

  /** 软删除记忆（写入 deletedAt） */
  writeDelete(id: string): void {
    this.index.delete(id);
  }

  /**
   * 随问答闭环删除的摘要记忆软删（⑥，2026-08-29）：Round 引用归 0 被物理删除后联动。
   *
   * 软删即脱钩：命中 roundId 的 round-summary 清空溯源（sessionName/roundId）后再软删——
   * 原会话/轮已不存在（物理回收），溯源悬空无意义；恢复后即为「无需溯源的独立记忆」。
   * 宿主 SQLite 不持久化 metadata，故不用标记位，直接清顶层溯源字段最简。
   * 治理页单条软删（writeDelete）不清溯源：误删恢复仍保留关联。
   *
   * @param roundIds 被物理删除（引用归 0）的 Round ID 集合
   * @returns 软删的摘要数量（0 = 无可联动记忆）
   */
  softDeleteRoundSummaries(roundIds: string[]): number {
    if (roundIds.length === 0) return 0;
    const idSet = new Set(roundIds);
    let count = 0;
    for (const memory of this.index.getBySource(SOURCE_LABELS.ROUND_SUMMARY)) {
      if (memory.roundId && idSet.has(memory.roundId)) {
        // 脱钩溯源（覆盖写为无溯源副本，仅清除顶层字段不动内容/权重）→ 软删进回收站
        this.index.upsert({ ...memory, sessionName: undefined, roundId: undefined });
        this.index.delete(memory.id);
        count++;
      }
    }
    return count;
  }

  /** 恢复软删除记忆（清除 deletedAt） */
  writeRestore(id: string): void {
    this.index.restore(id);
  }

  /**
   * 物理删除记忆（不可恢复）。同时清理向量防孤儿向量被语义召回。
   * delete 异步、本方法同步签名（宿主 IPC 同步消费），故 fire-and-forget + catch 降级（内存立即失效）。
   */
  writePurge(id: string): void {
    if (this.vectorStore) {
      backgroundTask('vector-delete', () => this.vectorStore!.delete(id));
    }
    this.index.purge(id);
  }

  /** 清理 deletedAt 早于 before 的软删除记忆（宿主定时器调用，默认 30 天保留期） */
  writePurgeExpired(before: Date): number {
    // 先过滤待清理候选，避免清理未过期记忆
    const beforeMs = before.getTime();
    const candidates = this.index
      .listDeleted()
      .filter((m) => m.deletedAt && new Date(m.deletedAt).getTime() < beforeMs);

    // 同步清理向量防孤儿向量（fire-and-forget；delete 异步但内存立即失效，持久化失败仅影响冷启动复活）
    if (this.vectorStore && candidates.length > 0) {
      for (const m of candidates) {
        backgroundTask('vector-delete', () => this.vectorStore!.delete(m.id));
      }
    }

    return this.index.purgeExpired(before);
  }
}
