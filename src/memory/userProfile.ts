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
import { toError } from '@/utils/toError.js';
import { nowIso } from '@/utils/time.js';

/** 用户画像子分类 */
export type ProfileCategory = 'identity' | 'preference' | 'expertise' | 'habit' | 'history';

/** 有效的画像分类列表（模块级常量，消除 parseContentField 内 2 次重复数组） */
const VALID_PROFILE_CATEGORIES: ProfileCategory[] = ['identity', 'preference', 'expertise', 'habit', 'history'];

/**
 * 从 value 字符串前缀提取字段名（兼容旧数据）
 *
 * 旧数据 value 格式为 "字段名: 值"（如 "姓名: 张三"），fieldName 未显式存储。
 * 本函数从 value 前缀提取字段名，用于：
 *   - parseContentField 降级路径（旧 JSON 数据无 fieldName 字段）
 *   - removeConflictingEntries 兼容旧持久化数据
 *
 * @param value 事实值（可能含 "字段名: " 前缀）
 * @returns 提取的字段名；无法提取时返回 'unknown'（冲突检测会跳过该条目）
 */
function extractFieldNameFromValue(value: string): string {
  const prefix = (value.split(':')[0] ?? '').trim();
  return prefix || 'unknown';
}

/** profile content JSON 结构（含可选 fieldName，兼容旧数据） */
interface ProfileContent {
  category: ProfileCategory;
  value: string;
  /** 显式字段名，新数据必填；旧数据可能缺失，由 parseContentField 降级从 value 前缀提取 */
  fieldName?: string;
  /** 确认态标记（M10）：缺省视为已确认，向后兼容旧数据 */
  confirmed?: boolean;
}

/**
 * 类型守卫：检查未知对象是否为合法的 profile content 结构
 *
 * 替代 `as { category?: string; value?: string }` 断言，
 * 与 lockManager/projectRegistry 的类型守卫风格一致。
 *
 * fieldName 为可选字段（旧数据可能缺失），不参与结构校验，
 * 由 parseContentField 决定降级策略。
 *
 * @param obj 从 JSON.parse 得到的未知对象
 * @returns obj 是否为 { category: ProfileCategory; value: string } 结构
 */
function isProfileContent(obj: unknown): obj is ProfileContent {
  if (typeof obj !== 'object' || obj === null) return false;
  const record = obj as Record<string, unknown>;
  return (
    typeof record.category === 'string' &&
    typeof record.value === 'string' &&
    VALID_PROFILE_CATEGORIES.includes(record.category as ProfileCategory)
  );
}

/** 用户画像条目 */
export interface UserProfileEntry {
  /** 画像唯一 ID（格式：profile:user-profile-{category}-{slug}） */
  id: string;
  /** 子分类 */
  category: ProfileCategory;
  /**
   * 显式字段名
   *
   * 标识同 category 下的具体字段（如 identity 下 "姓名"/"住址"/"职业"），
   * 用于冲突检测——同 category + 同 fieldName 视为同一字段的更新。
   */
  fieldName: string;
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
  /**
   * 显式字段名
   *
   * 由提取器显式填充（如 "姓名"/"住址"/"职业"/"偏好"/"工具"/"专长"），
   * 冲突检测基于 category + fieldName，即使 value 格式变化（如 LLM 输出无前缀），
   * 仍能正确识别冲突。
   */
  fieldName: string;
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
   * content 字段使用 JSON 编码存储 category + value 元数据，
   * 兼容旧格式（name 字段 "${category}: ${value}"）作为降级路径。
   */
  async load(): Promise<UserProfileEntry[]> {
    const memories = this.index.getBySource(SOURCE_LABELS.PROFILE);
    const entries: UserProfileEntry[] = [];

    for (const m of memories) {
    // 优先从 content JSON 解码，降级到旧格式 name 解析
    const parsed = this.parseContentField(m.content, m.name);
    const entry: UserProfileEntry = {
      id: m.id,
      category: parsed.category,
      // fieldName 由 parseContentField 统一填充（新数据直接读，旧数据从 value 前缀降级提取）
      fieldName: parsed.fieldName,
      value: parsed.value,
      source: '',
      weight: m.score,
      // M10 修复：从 content 还原确认态（旧数据无 confirmed 字段 → 默认已确认，向后兼容）
      confirmed: parsed.confirmed,
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
  async archiveFacts(facts: ExtractedFact[]): Promise<UserProfileEntry[]> {
    // 返回写入的条目列表（供 Agent 发射 memoryAdded 事件）
    if (facts.length === 0) return [];

    const written: UserProfileEntry[] = [];
    for (const fact of facts) {
      const entry = await this.upsertFact(fact);
      if (entry) written.push(entry);
    }
    return written;
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
    // M3 修复：id 维度纳入 fieldName，与冲突检测维度（category+fieldName）一致。
    // 否则不同 fieldName 经 slugify 撞车时分配同一 id → 后写覆盖前写 → 跨字段记忆静默丢失。
    const id = `profile:user-profile-${fact.category}-${slugify(fact.fieldName)}-${slugify(fact.value)}`;

    // 同分类冲突解决 — 删除旧条目（相同子分类 + 不同值 = 用户更新了信息）
    await this.removeConflictingEntries(fact);

    const entry: UserProfileEntry = {
      id,
      category: fact.category,
      // 显式存储 fieldName，供冲突检测使用
      fieldName: fact.fieldName,
      value: fact.value,
      source: fact.sourceTurn,
      weight: 1.0,
      confirmed: fact.confidence >= 0.8, // 高置信度直接确认
      updatedAt: nowIso(),
    };

    // M2 修复：已确认条目不因同 value 的低置信度重提取而降级。
    // 同一 id 若缓存中已是 confirmed=true，保留确认态（用户已确认该事实，低置信重提取不应撤销）。
    const existingInCache = this.cache.get(id);
    if (existingInCache?.confirmed && !entry.confirmed) {
      entry.confirmed = true;
    }

    try {
      // M10 修复：待确认条目也持久化（content 含 confirmed=false 标记），
      // 重启后由 load() 恢复为 pending，消除"确认前无兜底"的不可逆损失点。
      const memory = this.toMemory(entry);
      this.index.upsert(memory);
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
   * 删除同分类同字段的旧条目（用户更新了信息）
   *
   * 当用户说"我叫李四"替换之前的"我叫张三"时，移除旧的 identity/姓名 条目。
   *
   * 冲突判定基于 `category + fieldName`：
   * - 新数据：fact.fieldName 由提取器显式填充，parseContentField 返回 parsed.fieldName
   * - 旧数据：parseContentField 降级从 value 前缀提取 fieldName（兼容历史持久化数据）
   * - 同 category + 同 fieldName + 不同 value = 用户更新了该字段，删除旧条目
   *
   * 构建 `category:fieldName` → Memory[] 的 Map 索引，冲突检测从 O(n*m) 降为 O(m)。
   *
   * @param fact 当前提取到的新事实
   */
  private async removeConflictingEntries(fact: ExtractedFact): Promise<void> {
    try {
      const existing = this.index.getBySource(SOURCE_LABELS.PROFILE);

      // 构建 `category:fieldName` → Memory[] 的 Map 索引，冲突检测降为 O(m)
      const fieldIndex = new Map<string, Memory[]>();
      for (const m of existing) {
        const parsed = this.parseContentField(m.content, m.name);
        if (parsed.category !== fact.category) continue;
        if (!parsed.fieldName) continue;
        const key = `${parsed.category}:${parsed.fieldName}`;
        const list = fieldIndex.get(key);
        if (list) {
          list.push(m);
        } else {
          fieldIndex.set(key, [m]);
        }
      }

      // 在索引中查找同 category + 同 fieldName 的冲突条目
      const conflictKey = `${fact.category}:${fact.fieldName}`;
      const conflicts = fieldIndex.get(conflictKey);
      if (conflicts) {
        for (const m of conflicts) {
          const parsed = this.parseContentField(m.content, m.name);
          if (parsed.value !== fact.value) {
            this.index.delete(m.id);
            // 同步删除内存缓存中的旧条目，避免 storage 与 cache 不一致
            // 导致 getConfirmed() 仍返回已被替换的旧值
            this.cache.delete(m.id);
            logger.info(
              { oldId: m.id, oldValue: parsed.value, newValue: fact.value, fieldName: fact.fieldName },
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
   * content 字段使用 JSON 编码存储 category + value + fieldName 元数据，
   * name 字段为固定可读标签，category 通过 content 的 JSON 元数据显式编码。
   * 确认状态：仅已确认条目调用此方法（待确认条目不写入存储）
   */
  private toMemory(entry: UserProfileEntry): Memory {
    const now = nowIso();
    return {
      id: entry.id,
      // 序列化 fieldName，与 parseContentField 反序列化对称
      content: JSON.stringify({
        category: entry.category,
        value: entry.value,
        fieldName: entry.fieldName,
        confirmed: entry.confirmed,
      }),
      source: SOURCE_LABELS.PROFILE,
      name: `用户画像-${entry.category}`,
      createdAt: now,
      accessedAt: entry.updatedAt || now,
      score: entry.weight,
    };
  }

  /**
   * 从 content 字段解析 category / value / fieldName
   *
   * 优先从 content JSON 解码元数据，降级到旧格式 name 字段解析，
   * 确保已有 SQLite 数据（旧格式 name="${category}: ${value}"）兼容加载。
   *
   * fieldName 解析优先级：
   *   1. content JSON 含 fieldName → 直接返回（新数据）
   *   2. content JSON 无 fieldName → 从 value 前缀提取（旧 JSON 数据，无 fieldName 字段）
   *   3. name 字段旧格式 → 从 value 前缀提取
   *   4. 最终降级 → fieldName = 'unknown'（无法识别字段名，冲突检测会跳过）
   *
   * @param content Memory 的 content 字段（新格式为 JSON，旧格式为纯 value）
   * @param name Memory 的 name 字段（旧格式为 "${category}: ${value}"）
   * @returns 解析出的 category / value / fieldName
   */
  private parseContentField(content: string, name: string): {
    category: ProfileCategory;
    value: string;
    fieldName: string;
    confirmed: boolean;
  } {
    // 优先尝试 JSON 解码（新格式）
    try {
      const parsed = JSON.parse(content);
      if (isProfileContent(parsed)) {
        // 新数据含 fieldName 直接返回；旧 JSON 数据无 fieldName 时从 value 前缀降级提取
        const fieldName = parsed.fieldName ?? extractFieldNameFromValue(parsed.value);
        // M10：confirmed 缺失（旧数据）默认 true，向后兼容；新数据按实际标记还原
        const confirmed = typeof parsed.confirmed === 'boolean' ? parsed.confirmed : true;
        return { category: parsed.category, value: parsed.value, fieldName, confirmed };
      }
    } catch {
      // content 不是 JSON，降级到旧格式
    }

    // 降级：从 name 字段解析（旧格式 "${category}: ${value}"）
    const idx = name.indexOf(':');
    if (idx >= 0) {
      const category = name.slice(0, idx).trim() as ProfileCategory;
      if (VALID_PROFILE_CATEGORIES.includes(category)) {
        const value = name.slice(idx + 1).trim() || content;
        // 旧格式数据无 fieldName，从 value 前缀提取（如 "姓名: 张三" → "姓名"）
        return { category, value, fieldName: extractFieldNameFromValue(value), confirmed: true };
      }
    }

    // 最终降级：默认 history 分类（中性默认，避免 identity 高敏感类别污染画像）
    // fieldName = 'unknown'：无法识别字段名，removeConflictingEntries 会跳过该条目
    return { category: 'history', value: content, fieldName: 'unknown', confirmed: true };
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
