/**
 * 记忆管理器 — 统一的记忆读写入口（从 Agent 拆分）。
 * 写方法 writeXxx 前缀区分写操作。同步返回避免数据不一致；每层只返回前 N 条 + 总数（轻量）。
 * L1 语义去重迁至 DedupManager；detectConflicts/sourceHealth/suggest 由 Agent 门面直连 MemoryAdvisor，
 * 本类回归纯存储读写 + 查询入口。ADR-014 记忆关系图谱已收敛移除。
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
import { backgroundTask } from '@/utils/backgroundTask.js';
// 融合排序算法 + 常量从 hybridMerge 导入（消除对 recall.ts 内部常量的依赖）
import { hybridMerge, RECALL_LIMIT_MULTIPLIER } from '@/memory/hybridMerge.js';
// LLM 治理共享常量（统一由 governance.ts 维护）
import { BOOST_INCREMENT } from '@/memory/governance.js';

// sourceHealth/suggest 类型再导出，维持 src/index.ts 公共 API 兼容（类型定义在 memoryAdvisor.ts）
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
    /** 权重（0-1） */
    score: number;
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
  /** 权重（0-1） */
  score: number;
  /** 内容预览（截断到 120 字符） */
  contentPreview: string;
  /** 语义相似度（0-1，仅 searchHybrid 返回） */
  similarity?: number;
  /** 创建时间（ISO 8601，供 UI 时间筛选） */
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
   * 列出所有记忆（供宿主记忆管理面板）。允许空查询，返回按 score 降序列表。
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

    // 第 2 层 Bootstrap 恒空：ADR-025 设定记忆唯一归角色包，索引不再新增，rolePackPrompt 承载规则注入。
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
      score: m.score,
      // 截断长内容到搜索预览长度
      contentPreview: truncate(m.content, SEARCH_PREVIEW_LEN),
      createdAt: m.createdAt,
    }));
  }

  /**
   * 混合搜索记忆（语义 + 关键词双通道）。VectorStore 可用时补强语义缺口，向量搜索失败静默降级到关键词。
   * 融合排序委托 hybridMerge（与 recall() 共享，避免跨模块常量依赖）。
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

    // 综合排序（hybridMerge 纯函数，与 recall() 共享）
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

  // sourceHealth()/suggest() 已移除，由 Agent 门面直连 MemoryAdvisor（同 detectConflicts），消除 3 层转发。

  // ─── 写操作（writeXxx 前缀，IMemoryStorage 透传） ───

  /** 插入或更新记忆 */
  writeUpsert(memory: Memory): void {
    this.index.upsert(memory);
  }

  /**
   * 提升记忆 score（L2 采纳反哺内核）：用户采纳候选后反哺，与 recall 的 boostScore 语义一致但触发主动。
   * 记忆不存在时静默返回 false（候选可能来自对话历史，无对应记忆）。
   */
  writeBoost(id: string, increment: number = BOOST_INCREMENT): boolean {
    // 用 incrementScore 原子操作，消除 read-modify-write 并发冲突（原四步改为存储层一条原子更新）
    return this.index.incrementScore(id, increment, nowIso());
  }

  /** 软删除记忆（写入 deletedAt） */
  writeDelete(id: string): void {
    this.index.delete(id);
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
