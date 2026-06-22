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
   * name 字段格式：`${category}: ${value}`（如 "identity: 姓名: 张三"）
   */
  async load(): Promise<UserProfileEntry[]> {
    const memories = this.index.getBySource(SOURCE_LABELS.PROFILE);
    const entries: UserProfileEntry[] = [];

    for (const m of memories) {
      // 从 name 字段解析 category（格式：${category}: ${value}）
      const { category, value } = this.parseNameField(m.name);
      const entry: UserProfileEntry = {
        id: m.id,
        category: category ?? 'identity',
        value: value ?? m.content,
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
    } catch {
      // 索引中可能不存在（低置信度条目可能未写入），忽略
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
   * 新模型中从 name 字段解析 category（格式：${category}: ${value}）
   *
   * @param fact 当前提取到的新事实
   */
  private async removeConflictingEntries(fact: ExtractedFact): Promise<void> {
    try {
      const existing = this.index.getBySource(SOURCE_LABELS.PROFILE);
      // 提取新事实的核心模式（如 "姓名: 李四" → 前缀 "姓名"）
      const newPrefix = (fact.value.split(':')[0] ?? '').trim();

      for (const m of existing) {
        // 从 name 字段解析 category（格式：${category}: ${value}）
        const { category } = this.parseNameField(m.name);

        // 同分类 + 不同值 → 冲突，删除旧条目
        if (category === fact.category && m.content !== fact.value) {
          const oldPrefix = (m.content.split(':')[0] ?? '').trim();
          // 核心模式相同（如 "姓名" vs "姓名"）→ 确认冲突
          if (oldPrefix === newPrefix) {
            this.index.delete(m.id);
            logger.info(
              { oldId: m.id, oldValue: m.content, newValue: fact.value },
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
   * 分类信息编码在 name 字段中：${category}: ${value}
   * 确认状态：仅已确认条目调用此方法（待确认条目不写入存储）
   */
  private toMemory(entry: UserProfileEntry): Memory {
    const now = new Date().toISOString();
    return {
      id: entry.id,
      content: entry.value,
      source: SOURCE_LABELS.PROFILE,
      name: `${entry.category}: ${entry.value}`,
      createdAt: now,
      accessedAt: entry.updatedAt || now,
      score: entry.weight,
    };
  }

  /**
   * 从 name 字段解析分类和值
   *
   * name 字段格式：${category}: ${value}
   * 例如："identity: 姓名: 张三" → { category: 'identity', value: '姓名: 张三' }
   *
   * @param name - Memory 的 name 字段
   * @returns 解析出的 category 和 value
   */
  private parseNameField(name: string): {
    category?: ProfileCategory;
    value?: string;
  } {
    const idx = name.indexOf(':');
    if (idx < 0) return {};

    const category = name.slice(0, idx).trim() as ProfileCategory;
    const value = name.slice(idx + 1).trim();

    // 校验 category 是否为合法的 ProfileCategory
    const validCategories: ProfileCategory[] = ['identity', 'preference', 'expertise', 'habit', 'history'];
    if (!validCategories.includes(category)) return {};

    return { category, value: value || undefined };
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
