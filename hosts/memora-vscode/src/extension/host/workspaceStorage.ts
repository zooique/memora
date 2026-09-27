/**
 * 工作区记忆存储 — IMemoryStorage 实现（JSON 文件落盘）
 *
 * 职责：
 *   - 将 memora 记忆持久化到工作区 `.memora/memories.json`（单文件 JSON 数组）
 *   - 实现 IMemoryStorage 接口，注入 Agent，让记忆跨会话存活
 *   - 软删除语义与内核一致：delete 写 deletedAt，查询自动过滤
 *   - source 校验：upsert 时调 validateSource 拦截无效 source（路径遍历/空字节/首尾空格）
 *   - 读档校验：load 逐条经内核 parseMemory 白名单构造，未知字段（旧档 score）剥离即清洗
 *   - 设定记忆存量清理：migrateRetiredSettingSources 软删 persona/rule/skill 存量行（迁移出口）
 *
 * 最小可用实现（内存 Map + 每次变更落盘）。
 * 如需高性能检索，可换 SQLite 等更强实现。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  segmentLower,
  validateSource,
  parseMemory,
  SOURCE_LABELS,
  type IMemoryStorage,
  type Memory,
} from '@zooique/memora';
import { atomicWriteFileSync } from './atomicWriteSync.js';

/**
 * 退役 source 集合：设定记忆标签（persona/rule/skill）。
 * 设定归角色包承载，记忆库单轨只留摘要记忆；
 * 标签本身仍被内核 SOURCE_LABELS 识别（typo 检测/存量行识别），但不是可写入来源。
 */
const RETIRED_SETTING_SOURCES = new Set<string>([
  SOURCE_LABELS.PERSONA,
  SOURCE_LABELS.RULE,
  SOURCE_LABELS.SKILL,
]);

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

  /**
   * 启动时从文件加载记忆（文件不存在则空库）
   *
   * 逐条经内核 `parseMemory` 白名单校验：未知字段（旧档遗留的 `score` 等）被剥离，
   * 读一次即完成数据层清洗，后续 save() 写回的 JSON 自动不含退役字段。
   * 单条损坏只跳过该条并告警——不因一条脏数据清空整个记忆库（整库清空会让用户静默丢记忆）。
   */
  load(): void {
    if (!existsSync(this.filePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      // 记忆文件不可读时降级为空库（不阻塞插件启动），避免静默吞错（记日志由上层处理）
      console.warn('Memora 记忆文件读取失败，降级为空库', err);
      this.store.clear();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn('Memora 记忆文件 JSON 解析失败，降级为空库', err);
      this.store.clear();
      return;
    }

    if (!Array.isArray(parsed)) {
      console.warn('Memora 记忆文件格式非法（顶层非数组），降级为空库');
      this.store.clear();
      return;
    }

    this.store.clear();
    for (const item of parsed) {
      try {
        const memory = parseMemory(item);
        this.store.set(memory.id, memory);
      } catch (err) {
        // 跳过损坏条目：保住其余记忆，不让一条脏数据拖垮整个库
        console.warn('Memora 跳过一条无法解析的记忆', err);
      }
    }
  }

  /** 将当前内存原子写回文件（先写 .tmp 再 rename，防崩溃损坏） */
  private save(): void {
    const list = [...this.store.values()];
    atomicWriteFileSync(this.filePath, JSON.stringify(list, null, 2));
  }

  /** 是否为活跃记忆（未软删除） */
  private isActive(m: Memory): boolean {
    return m.deletedAt === undefined;
  }

  upsert(memory: Memory): void {
    // 对齐内核 validateSource：拦截路径遍历/空字节/首尾空格等无效 source
    const result = validateSource(memory.source);
    if (result.severity === 'block') {
      throw new Error(`source 校验失败：${result.warning}`);
    }
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

  /**
   * 一次性迁移（设定记忆出口）：把设定记忆存量行（source ∈ persona/rule/skill）软删出记忆库
   *
   * 设定归角色包承载，记忆库单轨只留摘要记忆。存量行按删除语义打
   * deletedAt——回收站可 restore 兜底，purgeExpired 定期彻底回收（迁移不直删）。
   * 幂等：已软删行与非退役 source 行不重复标记，二次执行零动作、不重复落盘。
   *
   * @returns 本次软删的行数
   */
  migrateRetiredSettingSources(): number {
    // 同批迁移共享同一时间戳，回收站按 deletedAt 排序时同批可见
    const now = new Date().toISOString();
    let count = 0;
    for (const m of this.store.values()) {
      if (m.deletedAt !== undefined) continue;
      if (!RETIRED_SETTING_SOURCES.has(m.source)) continue;
      m.deletedAt = now;
      count++;
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

  /**
   * 关键词搜索（复刻内核 InMemoryStorage.search 语义）
   *
   * 先对 query 分词，再逐个 token 匹配（任一 token 命中即返回），
   * 避免"整串子串匹配"对多关键词短语召回失败（任务 D 实测暴露的缺陷）。
   */
  search(query: string, limit = 10): Memory[] {
    const q = query.trim();
    const active = [...this.store.values()].filter((m) => this.isActive(m));
    // 空查询：按 accessedAt 降序（最近使用优先）返回
    if (!q) {
      return this.topByAccessed(active, limit);
    }
    // 规范分词（与内核 keywordsTouch.ts 的 extractKeywords 共用 segmentText）
    const tokens = segmentLower(q);
    if (tokens.length === 0) {
      return this.topByAccessed(active, limit);
    }
    const hits = active.filter((m) => {
      const text = `${m.content} ${m.name}`.toLowerCase();
      // 任一 token 命中即可
      return tokens.some((t) => text.includes(t));
    });
    return this.topByAccessed(hits, limit);
  }

  /** 按 accessedAt 降序排序并截断返回浅拷贝（最近使用优先，对齐内核 search 契约；消除 search 内重复排序逻辑） */
  private topByAccessed(memories: Memory[], limit: number): Memory[] {
    return memories
      .slice()
      .sort((a, b) => (b.accessedAt ?? '').localeCompare(a.accessedAt ?? ''))
      .slice(0, limit)
      .map((m) => ({ ...m }));
  }

  count(): number {
    return [...this.store.values()].filter((m) => this.isActive(m)).length;
  }

  countBySource(source: string): number {
    return [...this.store.values()].filter((m) => this.isActive(m) && m.source === source).length;
  }

  /** 刷新记忆 accessedAt（使用轨迹写位，对齐内核 IMemoryStorage 契约）；不存在/已软删除返回 false */
  touch(id: string, now: string): boolean {
    const m = this.store.get(id);
    if (!m || !this.isActive(m)) return false;
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
