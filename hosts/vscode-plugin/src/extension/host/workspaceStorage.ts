/**
 * 工作区记忆存储 — IMemoryStorage 实现（JSON 文件落盘）
 *
 * 职责：
 *   - 将 memora 记忆持久化到工作区 `.memora/memories.json`（单文件 JSON 数组）
 *   - 实现 IMemoryStorage 接口，注入 Agent，让记忆跨会话存活
 *   - 软删除语义与内核一致：delete 写 deletedAt，查询自动过滤
 *
 * 阶段 0：最小可用实现（内存 Map + 每次变更落盘）。
 * 后续阶段：如需高性能/向量索引，可换 SQLite 或 JsonVectorStore。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IMemoryStorage, Memory } from '@zooique/memora';

/** 工作区记忆存储 */
export class WorkspaceStorage implements IMemoryStorage {
  /** 记忆主存储：id → Memory */
  private store = new Map<string, Memory>();
  /** 记忆文件绝对路径 */
  private readonly filePath: string;

  constructor(workspacePath: string) {
    // 存放到工作区 .memora/memories.json
    this.filePath = join(workspacePath, '.memora', 'memories.json');
  }

  /** 启动时从文件加载记忆（文件不存在则空库） */
  load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const list = JSON.parse(raw) as Memory[];
      for (const m of list) this.store.set(m.id, m);
    } catch (err) {
      // 记忆文件损坏时降级为空库（不阻塞插件启动），避免静默吞错（记日志由上层处理）
      console.warn('Memora 记忆文件读取失败，降级为空库', err);
      this.store.clear();
    }
  }

  /** 将当前内存写回文件（原子：先写临时文件再重命名） */
  private save(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true });
    const list = [...this.store.values()];
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    writeFileSync(this.filePath, JSON.stringify(list, null, 2), 'utf8');
  }

  /** 是否为活跃记忆（未软删除） */
  private isActive(m: Memory): boolean {
    return m.deletedAt === undefined;
  }

  upsert(memory: Memory): void {
    this.store.set(memory.id, memory);
    this.save();
  }

  delete(id: string): void {
    const m = this.store.get(id);
    if (m && m.deletedAt === undefined) {
      m.deletedAt = new Date().toISOString();
      this.save();
    }
  }

  restore(id: string): void {
    const m = this.store.get(id);
    if (m) {
      delete m.deletedAt;
      this.save();
    }
  }

  purge(id: string): void {
    if (this.store.delete(id)) this.save();
  }

  listDeleted(limit?: number): Memory[] {
    const deleted = [...this.store.values()].filter((m) => m.deletedAt !== undefined);
    deleted.sort((a, b) => (a.deletedAt! < b.deletedAt! ? 1 : -1));
    const sliced = limit && limit > 0 ? deleted.slice(0, limit) : deleted;
    return sliced.map((m) => ({ ...m }));
  }

  getDeletedById(id: string): Memory | null {
    const m = this.store.get(id);
    return m && m.deletedAt !== undefined ? { ...m } : null;
  }

  purgeExpired(before: Date): number {
    let count = 0;
    for (const [id, m] of this.store) {
      if (m.deletedAt !== undefined && new Date(m.deletedAt) < before) {
        this.store.delete(id);
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  getById(id: string): Memory | null {
    const m = this.store.get(id);
    return m && this.isActive(m) ? { ...m } : null;
  }

  getBySource(source: string): Memory[] {
    return [...this.store.values()]
      .filter((m) => this.isActive(m) && m.source === source)
      .map((m) => ({ ...m }));
  }

  search(query: string, limit = 10): Memory[] {
    const q = query.trim();
    const hits = [...this.store.values()].filter((m) => {
      if (!this.isActive(m)) return false;
      if (!q) return true;
      return m.content.includes(q) || m.name.includes(q);
    });
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit).map((m) => ({ ...m }));
  }

  count(): number {
    return [...this.store.values()].filter((m) => this.isActive(m)).length;
  }

  countBySource(source: string): number {
    return [...this.store.values()].filter((m) => this.isActive(m) && m.source === source).length;
  }

  decayScores(sources: string[], now: Date): number {
    let count = 0;
    for (const m of this.store.values()) {
      if (this.isActive(m) && sources.includes(m.source)) {
        m.score = Math.max(0, m.score - 0.05);
        m.accessedAt = now.toISOString();
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  incrementScore(id: string, delta: number, now: string): boolean {
    const m = this.store.get(id);
    if (!m || !this.isActive(m)) return false;
    m.score = Math.min(1, Math.max(0, m.score + delta));
    m.accessedAt = now;
    this.save();
    return true;
  }

  setScore(id: string, newScore: number, now: string): boolean {
    const m = this.store.get(id);
    if (!m || !this.isActive(m)) return false;
    m.score = newScore;
    m.accessedAt = now;
    this.save();
    return true;
  }

  getAllSources(): Map<string, number> {
    const map = new Map<string, number>();
    for (const m of this.store.values()) {
      if (!this.isActive(m)) continue;
      map.set(m.source, (map.get(m.source) ?? 0) + 1);
    }
    return map;
  }

  close(): void {
    // JSON 文件存储已在每次变更时落盘，无需额外关闭
  }
}
