/**
 * 用户画像管理 — 实时归档 + SQLite 持久化
 *
 * 职责：
 *   - 每轮对话结束后扫描是否产生新画像条目
 *   - 5 个子分类：identity / preference / expertise / habit / history
 *   - 实时归档（用户前脚说"我叫张三"→ 后脚就写入 SQLite）
 *   - 启动时从 SQLite 全量加载（source = 'profile'）
 *   - confidence 机制：高置信度（≥0.8）直接归档，低置信度首次召回时确认
 *
 * 设计原则（architecture_philosophy_rules.md §2 永久性分级）：
 *   - 用户画像属于助手记忆，source = 'profile'，每轮必召回
 *   - 实时归档解决"重启进程短期身份丢失"的核心 bug
 *   - 确认机制防止正则误归档污染画像
 *   - identity / preference / expertise 实时归档，habit / history 每天归档时提炼
 */
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { SOURCE_LABELS, type Memory } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';
import { slugify } from '@/utils/strings.js';
import { toError } from '@/utils/errors.js';

/** 用户画像子分类 */
export type ProfileCategory = 'identity' | 'preference' | 'expertise' | 'habit' | 'history';

/** 用户画像条目 */
export interface UserProfileEntry {
  /** 画像唯一 ID（格式：profile:user-profile-{category}-{slug}） */
  id: string;
  /** 子分类 */
  category: ProfileCategory;
  /** 事实值（如 "姓名: 张三"） */
  value: string;
  /** 来源（哪一轮对话提到） */
  source: string;
  /** 权重（0-1） */
  weight: number;
  /** 是否已确认（false 表示首次召回时需用户确认） */
  confirmed: boolean;
  /** 最后更新时间（ISO 8601） */
  updatedAt: string;
}

/** extractUserFacts 的原始提取结果 */
export interface ExtractedFact {
  category: ProfileCategory;
  value: string;
  sourceTurn: string;
  /** 置信度 0-1（≥0.8 直接归档，否则标记待确认） */
  confidence: number;
}

/**
 * 用户画像管理器
 */
export class UserProfile {
  /** 内存缓存：启动时从 SQLite 全量加载 */
  private cache: Map<string, UserProfileEntry> = new Map();

  constructor(private readonly index: IMemoryStorage) {}

  /**
   * 启动时从 SQLite 加载所有已确认的画像条目
   *
   * 存储中只保存已确认的条目（confirmed = true），
   * 待确认条目仅存内存缓存，不写入存储。
   *
   * P2-5 content 字段使用 JSON 编码存储 category + value 元数据，
   * 兼容旧格式（name 字段 "${category}: ${value}"）作为降级路径。
   */
  async load(): Promise<UserProfileEntry[]> {
    const memories = this.index.getBySource(SOURCE_LABELS.PROFILE);
    const entries: UserProfileEntry[] = [];

    for (const m of memories) {
      // P2-5 优先从 content JSON 解码，降级到旧格式 name 解析
      const parsed = this.parseContentField(m.content, m.name);
      const entry: UserProfileEntry = {
        id: m.id,
        category: parsed.category,
        value: parsed.value,
        source: '',
        weight: m.score,
        confirmed: true, // 存储中只保存已确认条目
        updatedAt: m.accessedAt,
      };
      this.cache.set(entry.id, entry);
      entries.push(entry);
    }

    logger.info(
      {
        total: entries.length,
        confirmed: entries.filter((e) => e.confirmed).length,
        pending: entries.filter((e) => !e.confirmed).length,
      },
      '用户画像加载完成',
    );

    return entries;
  }

  /**
   * 实时归档：将提取的用户事实写入存储
   *
   * 每轮 chat() 结束后，由 Agent 调用 extractUserFacts() 提取事实后传入。
   * 高置信度（≥0.8）→ 直接归档为 confirmed
   * 低置信度 → 标记 confirmed = false，首次召回时 Agent 向用户确认
   *
   * @param facts 由 extractUserFacts() 提取的事实列表
   */
  async archiveFacts(facts: ExtractedFact[]): Promise<number> {
    if (facts.length === 0) return 0;

    let archived = 0;
    for (const fact of facts) {
      const entry = await this.upsertFact(fact);
      if (entry) archived++;
    }
    return archived;
  }

  /**
   * 获取所有已确认的画像条目（system prompt 注入用）
   */
  getConfirmed(): UserProfileEntry[] {
    return Array.from(this.cache.values()).filter((e) => e.confirmed);
  }

  /**
   * 获取所有待确认的画像条目（供宿主 UI 展示确认/拒绝操作）
   *
   * 待确认条目仅存内存缓存（未写入存储），进程重启后丢失。
   * 宿主应定期或在新对话后查询此方法，展示给用户确认。
   */
  getPending(): UserProfileEntry[] {
    return Array.from(this.cache.values()).filter((e) => !e.confirmed);
  }

  /**
   * 构建 system prompt 中的用户画像段
   *
   * 格式：
   *   【用户画像】
   *   - 身份：张三，男，25岁，住北京
   *   - 偏好：TypeScript, Python, VS Code
   *   - 专长：后端开发，系统架构
   *   - 习惯：上午工作，下午思考
   */
  buildSystemPrompt(): string {
    const confirmed = this.getConfirmed();

    if (confirmed.length === 0) return '';

    // 按分类聚合
    const grouped = new Map<ProfileCategory, string[]>();
    for (const e of confirmed) {
      const list = grouped.get(e.category) ?? [];
      list.push(
        e.value
          // "姓名: 张三" → "张三"
          .replace(/^[^:]+:\s*/, ''),
      );
      grouped.set(e.category, list);
    }

    const lines = ['【用户画像】'];
    for (const [cat, vals] of grouped) {
      const label = this.categoryLabel(cat);
      lines.push(`- ${label}：${vals.join('，')}`);
    }

    return lines.join('\n');
  }

  /**
   * 确认待确认条目（用户在对话中确认了）
   *
   * 确认后写入存储（此前仅存内存缓存）
   *
   * @param id 条目 ID
   */
  async confirm(id: string): Promise<void> {
    const entry = this.cache.get(id);
    if (!entry) return;

    entry.confirmed = true;
    // 确认后写入存储（此前仅存内存缓存）
    const memory = this.toMemory(entry);
    this.index.upsert(memory);
    logger.info({ id, category: entry.category, value: entry.value }, '用户画像条目已确认');
  }

  /**
   * 拒绝待确认条目（用户在对话中否认了）
   *
   * @param id 条目 ID
   */
  async reject(id: string): Promise<void> {
    this.cache.delete(id);
    try {
      this.index.delete(id);
    } catch (err) {
      // 索引中可能不存在（低置信度条目可能未写入）：记录 debug 日志便于排查
      logger.debug({ id, err: toError(err).message }, '索引删除失败（条目可能未写入索引）');
    }
    logger.info({ id }, '用户画像条目已删除（用户否认）');
  }

  // ── 私有方法 ──────────────────────────────────────

  /**
   * 写入单条事实到 SQLite
   *
   * 冲突解决策略：
   *   同分类（identity/preference/expertise/habit/history）的新事实
   *   会替换旧事实。因为用户画像是"当前状态"而非"历史记录"。
   *   例："我叫张三" → 后续说"我叫李四" → 只保留"李四"，张三被移除。
   *
   * @returns 成功写入的条目，或 null（写入失败）
   */
  private async upsertFact(fact: ExtractedFact): Promise<UserProfileEntry | null> {
    // 构造稳定 ID（profile: 前缀 + 分类 + slug）
    const id = `profile:user-profile-${fact.category}-${slugify(fact.value)}`;

    // 同分类冲突解决 — 删除旧条目（相同子分类 + 不同值 = 用户更新了信息）
    await this.removeConflictingEntries(fact);

    const entry: UserProfileEntry = {
      id,
      category: fact.category,
      value: fact.value,
      source: fact.sourceTurn,
      weight: 1.0,
      confirmed: fact.confidence >= 0.8, // 高置信度直接确认
      updatedAt: new Date().toISOString(),
    };

    try {
      // 仅已确认条目写入存储（待确认条目仅存内存缓存）
      if (entry.confirmed) {
        const memory = this.toMemory(entry);
        this.index.upsert(memory);
      }
      this.cache.set(id, entry);

      if (entry.confirmed) {
        logger.info(
          { id, category: fact.category, value: fact.value, confidence: fact.confidence },
          '用户画像实时归档（已确认）',
        );
      } else {
        logger.info(
          { id, category: fact.category, value: fact.value, confidence: fact.confidence },
          '用户画像待确认',
        );
      }
      return entry;
    } catch (err) {
      logger.warn({ err, id, category: fact.category }, '用户画像归档失败');
      return null;
    }
  }

  /**
   * 删除同分类的旧条目（用户更新了信息）
   *
   * 当用户说"我叫李四"替换之前的"我叫张三"时，移除旧的 identity 条目。
   * 策略：同分类（category）下，新值替换旧值。判断标准是旧条目的 value 前缀。
   *
   * P2-5 从 content JSON 解码 category，替代 name 字段隐式解析。
   * P2-3 构建 contentPrefix → entry 的 Map 索引，冲突检测从 O(n*m) 降为 O(m)。
   *
   * @param fact 当前提取到的新事实
   */
  private async removeConflictingEntries(fact: ExtractedFact): Promise<void> {
    try {
      const existing = this.index.getBySource(SOURCE_LABELS.PROFILE);
      // 提取新事实的核心模式（如 "姓名: 李四" → 前缀 "姓名"）
      const newPrefix = (fact.value.split(':')[0] ?? '').trim();

      // P2-3 构建 contentPrefix → Memory 的 Map 索引，冲突检测降为 O(m)
      const prefixIndex = new Map<string, Memory[]>();
      for (const m of existing) {
        // P2-5 从 content JSON 解码 category，替代 parseNameField
        const parsed = this.parseContentField(m.content, m.name);
        if (parsed.category !== fact.category) continue;
        const oldPrefix = (parsed.value.split(':')[0] ?? '').trim();
        if (!oldPrefix) continue;
        const key = `${parsed.category}:${oldPrefix}`;
        const list = prefixIndex.get(key);
        if (list) {
          list.push(m);
        } else {
          prefixIndex.set(key, [m]);
        }
      }

      // 在索引中查找冲突条目
      const conflictKey = `${fact.category}:${newPrefix}`;
      const conflicts = prefixIndex.get(conflictKey);
      if (conflicts) {
        for (const m of conflicts) {
          const parsed = this.parseContentField(m.content, m.name);
          if (parsed.value !== fact.value) {
            this.index.delete(m.id);
            logger.info(
              { oldId: m.id, oldValue: parsed.value, newValue: fact.value },
              '用户画像冲突已解决',
            );
          }
        }
      }
    } catch (err) {
      // 冲突解决失败不阻塞写入
      logger.debug({ err: toError(err).message }, '用户画像冲突解决失败');
    }
  }

  /**
   * 将 UserProfileEntry 转为 Memory（用于写入 SQLite）
   *
   * P2-5 content 字段使用 JSON 编码存储 category + value 元数据，
   * name 字段改为固定可读标签，不再隐式编码 category。
   * 确认状态：仅已确认条目调用此方法（待确认条目不写入存储）
   */
  private toMemory(entry: UserProfileEntry): Memory {
    const now = new Date().toISOString();
    return {
      id: entry.id,
      content: JSON.stringify({ category: entry.category, value: entry.value }),
      source: SOURCE_LABELS.PROFILE,
      name: `用户画像-${entry.category}`,
      createdAt: now,
      accessedAt: entry.updatedAt || now,
      score: entry.weight,
    };
  }

  /**
   * 从 content 字段解析 category 和 value
   *
   * P2-5 优先从 content JSON 解码元数据，降级到旧格式 name 字段解析，
   * 确保已有 SQLite 数据（旧格式 name="${category}: ${value}"）兼容加载。
   *
   * @param content Memory 的 content 字段（新格式为 JSON，旧格式为纯 value）
   * @param name Memory 的 name 字段（旧格式为 "${category}: ${value}"）
   * @returns 解析出的 category 和 value
   */
  private parseContentField(content: string, name: string): {
    category: ProfileCategory;
    value: string;
  } {
    // 优先尝试 JSON 解码（新格式）
    try {
      const parsed = JSON.parse(content) as { category?: string; value?: string };
      if (parsed.category && parsed.value) {
        const validCategories: ProfileCategory[] = ['identity', 'preference', 'expertise', 'habit', 'history'];
        if (validCategories.includes(parsed.category as ProfileCategory)) {
          return { category: parsed.category as ProfileCategory, value: parsed.value };
        }
      }
    } catch {
      // content 不是 JSON，降级到旧格式
    }

    // 降级：从 name 字段解析（旧格式 "${category}: ${value}"）
    const idx = name.indexOf(':');
    if (idx >= 0) {
      const category = name.slice(0, idx).trim() as ProfileCategory;
      const validCategories: ProfileCategory[] = ['identity', 'preference', 'expertise', 'habit', 'history'];
      if (validCategories.includes(category)) {
        const value = name.slice(idx + 1).trim();
        return { category, value: value || content };
      }
    }

    // 最终降级：默认 identity 分类
    return { category: 'identity', value: content };
  }

  /**
   * 分类标签
   */
  private categoryLabel(cat: ProfileCategory): string {
    const labels: Record<ProfileCategory, string> = {
      identity: '身份',
      preference: '偏好',
      expertise: '专长',
      habit: '习惯',
      history: '历史',
    };
    return labels[cat];
  }
}
