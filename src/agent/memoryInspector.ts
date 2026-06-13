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
import type { MessageHistory } from './messageHistory.js';
import type { AgentLoop } from './loop.js';
import { configError } from '@/utils/errors.js';

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
}

/** Agent 记忆搜索结果（cli 友好的扁平结构） */
export interface AgentSearchHit {
  /** 记忆名称 */
  name: string;
  /** 来源标签 */
  source: string;
  /** 权重（0-1） */
  score: number;
  /** 内容预览（截断到 120 字符） */
  contentPreview: string;
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
    const archiveTotal =
      this.index.countBySource(SOURCE_LABELS.INSIGHT) +
      this.index.countBySource(SOURCE_LABELS.PROFILE) +
      this.index.countBySource(SOURCE_LABELS.WORK_PROJECTION);

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
      name: m.name,
      source: m.source,
      score: m.score,
      // 截断长内容到 120 字符
      contentPreview: m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content,
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
}
