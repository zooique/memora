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

  /** 列出记忆（可按 source 过滤） */
  list(source?: string, limit = 50): MemoryListItem[] {
    const storage = this.agent.storage;
    if (!storage) return [];
    const memories = source
      ? storage.getBySource(source)
      : storage.search('', limit);

    return memories.map(m => ({
      id: m.id,
      name: m.name,
      source: m.source,
      score: Math.round(m.score * 100) / 100,
      contentPreview: m.content.length > 100 ? m.content.slice(0, 100) + '...' : m.content,
    }));
  }

  /** 查看单条记忆详情 */
  show(id: string): MemoryDetail | null {
    const storage = this.agent.storage;
    if (!storage) return null;
    const m = storage.getById(id);
    if (!m) return null;
    return {
      id: m.id,
      name: m.name,
      source: m.source,
      score: Math.round(m.score * 100) / 100,
      content: m.content,
      createdAt: new Date(m.createdAt).toLocaleString('zh-CN'),
      accessedAt: new Date(m.accessedAt).toLocaleString('zh-CN'),
    };
  }

  /** 删除记忆 */
  delete(id: string): boolean {
    const storage = this.agent.storage;
    if (!storage) return false;
    const exists = storage.getById(id);
    if (!exists) return false;
    storage.delete(id);
    // 同步删除向量索引
    this.vectorStore?.delete(id);
    return true;
  }

  /** 添加或更新记忆 */
  upsert(source: string, name: string, content: string, score = 0.5): string {
    const storage = this.agent.storage;
    if (!storage) throw new Error('存储不可用');
    const now = new Date().toISOString();
    const id = `${source}:${name}`;
    storage.upsert({
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

  /** 混合搜索记忆（语义 + 关键词双通道） */
  async search(query: string, limit = 10): Promise<MemorySearchResult[]> {
    const inspector = this.agent.memory;
    if (!inspector) return [];
    try {
      return await inspector.searchHybrid(query, limit);
    } catch {
      // 降级到纯关键词
      return inspector.search(query, limit);
    }
  }

  // ─── 仪表盘 ────────────────────────────────────────────

  /** 获取记忆仪表盘数据 */
  dashboard(): DashboardData {
    const stats = this.agent.memory!.stats();
    const suggestions = this.agent.memory!.suggest(undefined, { limit: 5 });
    return {
      total: stats.total,
      bySource: stats.bySource,
      suggestions,
    };
  }

  /** 格式化仪表盘为可读文本 */
  formatDashboard(pendingNotices: number, proactiveThreshold: number, registeredTriggers: string[]): string {
    const data = this.dashboard();
    const lines: string[] = [];

    lines.push('── 记忆仪表盘 ──');
    lines.push(`总记忆数：${data.total}`);

    lines.push(`累积事件：${pendingNotices}（阈值 ${proactiveThreshold}）`);
    lines.push(`已注册触发器：${registeredTriggers.join(', ')}`);

    if (Object.keys(data.bySource).length > 0) {
      const sourceList = Object.entries(data.bySource)
        .sort(([, a], [, b]) => b - a)
        .map(([source, count]) => `  ${source}: ${count}`)
        .join('\n');
      lines.push(`按来源：\n${sourceList}`);
    }

    if (data.suggestions.length > 0) {
      lines.push('推荐关注：');
      for (const hit of data.suggestions) {
        lines.push(`  [${hit.source}] ${hit.name} (${hit.reason}, 相关度 ${hit.relevance})`);
      }
    } else {
      lines.push('暂无推荐（记忆库为空或尚无足够数据）');
    }

    return lines.join('\n');
  }
}
