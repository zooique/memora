/**
 * 用户画像管理 — 实时归档 + SQLite 持久化
 *
 * 职责：
 *   - 每轮对话结束后扫描是否产生新画像条目
 *   - 5 个子分类：identity / preference / expertise / habit / history
 *   - 实时归档（用户前脚说"我叫张三"→ 后脚就写入 SQLite）
 *   - 启动时从 SQLite 全量加载（permanence: always）
 *   - confidence 机制：高置信度（≥0.8）直接归档，低置信度首次召回时确认
 *
 * 设计原则（01-主架构-v4.0.md §3.5）：
 *   - 用户画像属于助手记忆，permanence = always，每轮必召回
 *   - 实时归档解决"重启进程短期身份丢失"的核心 bug
 *   - 确认机制防止正则误归档污染画像
 *   - identity / preference / expertise 实时归档，habit / history 每天归档时提炼
 */
import type { MemoryIndex } from './index.js';
import type { Memory } from './types.js';
import { MemoryType, Permanence } from './types.js';
import { logger } from '@/logging/logger.js';

/** 用户画像子分类 */
export type ProfileCategory = 'identity' | 'preference' | 'expertise' | 'habit' | 'history';

/** 用户画像条目 */
export interface UserProfileEntry {
  /** 画像唯一 ID */
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
  /** 永久性（固定 always） */
  permanence: typeof Permanence.ALWAYS;
  /** 最后更新时间 */
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

  constructor(private readonly index: MemoryIndex) {}

  /**
   * 启动时从 SQLite 加载所有已确认的画像条目
   *
   * 未确认（confirmed = false）的条目跳过——它们在首次召回时由 Agent 向用户确认。
   * 对应 [01-主架构-v4.0.md §6.2] 的阶段一强制召回流程。
   */
  async load(): Promise<UserProfileEntry[]> {
    const memories = await this.index.getByType('personality');
    const entries: UserProfileEntry[] = [];

    for (const m of memories) {
      const meta = this.parseMetadata(m);
      const entry: UserProfileEntry = {
        id: m.id,
        category: meta.category ?? 'identity',
        value: m.content,
        source: meta.source ?? '',
        weight: m.weight,
        confirmed: meta.confirmed ?? true, // 旧数据无 confirmed 字段，默认 true
        permanence: Permanence.ALWAYS,
        updatedAt: m.updatedAt,
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
   * 实时归档：提取对话中的用户事实，写入 SQLite
   *
   * 每轮 chat() 结束后调用。
   * 高置信度（≥0.8）→ 直接归档为 confirmed
   * 低置信度 → 标记 confirmed = false，首次召回时 Agent 向用户确认
   *
   * @param userInput 本轮用户输入
   * @param turnIndex 当前轮次索引
   */
  async archive(userInput: string, turnIndex: string): Promise<number> {
    const facts = this.extractUserFacts(userInput, turnIndex);
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
    // 过滤掉待确认的条目
    const filtered = confirmed.filter((e) => e.confirmed);

    if (filtered.length === 0) return '';

    // 按分类聚合
    const grouped = new Map<ProfileCategory, string[]>();
    for (const e of filtered) {
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
   * @param id 条目 ID
   */
  async confirm(id: string): Promise<void> {
    const entry = this.cache.get(id);
    if (!entry) return;

    entry.confirmed = true;
    // 更新 SQLite
    const memory = this.toMemory(entry);
    await this.index.upsert(memory);
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
      await this.index.delete(id);
    } catch {
      // 索引中可能不存在（低置信度条目可能未写入），忽略
    }
    logger.info({ id }, '用户画像条目已删除（用户否认）');
  }

  // ── 私有方法 ──────────────────────────────────────

  /**
   * 从用户输入中提取事实
   *
   * 使用正则 + 关键词规则，兼顾阶段一的低成本需求。
   * 高置信度规则（≥0.9）→ 直接归档
   * 中置信度（0.7-0.8）→ 标记待确认
   *
   * @param input 用户原始输入
   * @param turnIndex 当前轮次标识
   */
  private extractUserFacts(input: string, turnIndex: string): ExtractedFact[] {
    const facts: ExtractedFact[] = [];

    // ── 高置信度：身份声明 ──
    // "我叫张三" "我是张三" "我的名字是张三"
    const identityMatch = input.match(/我(?:叫|是|的名字是)\s*([^\s，。,\.!！?？\n]{1,15})/);
    if (identityMatch) {
      facts.push({
        category: 'identity',
        value: `姓名: ${identityMatch[1]}`,
        sourceTurn: turnIndex,
        confidence: 0.95,
      });
    }

    // "我住在北京" "我家在上海"
    const locationMatch = input.match(/(?:我住在?|我家在)\s*([^\s，。,\.!！?？\n]{1,15})/);
    if (locationMatch) {
      facts.push({
        category: 'identity',
        value: `住址: ${locationMatch[1]}`,
        sourceTurn: turnIndex,
        confidence: 0.9,
      });
    }

    // "我(是|当|做).*?(的)" —— 职业声明
    const jobMatch = input.match(
      /我(?:是|当|做)(?:一[个名位])?\s*([^\s，。,\.!！?？\n]{1,10})(?:的)?/,
    );
    if (jobMatch && !identityMatch) {
      // 避免与 identityMatch 重复
      facts.push({
        category: 'identity',
        value: `职业: ${jobMatch[1]}`,
        sourceTurn: turnIndex,
        confidence: 0.85,
      });
    }

    // ── 高置信度：偏好声明 ──
    // "我喜欢TS" "我更喜欢Python" "我习惯用VS Code"
    // 移除外层可选标记，确保动词必须出现才能匹配
    const prefMatch = input.match(
      /(?:我(?:很|非常|最|更)?(?:喜欢|爱|习惯|偏好)(?:用|写|做|的))\s*([^\s，。,\.!！?？\n]{1,20})/,
    );
    if (prefMatch) {
      facts.push({
        category: 'preference',
        value: `偏好: ${prefMatch[1]}`,
        sourceTurn: turnIndex,
        confidence: 0.85,
      });
    }

    // ── 中置信度：工具/环境声明 ──
    // "我用VS Code" "我的环境是Windows"
    const toolMatch = input.match(/我(?:用|使用|的环境是)\s*([^\s，。,\.!！?？\n]{1,20})/);
    if (toolMatch && !prefMatch) {
      facts.push({
        category: 'preference',
        value: `工具: ${toolMatch[1]}`,
        sourceTurn: turnIndex,
        confidence: 0.8,
      });
    }

    // ── 较低置信度：专长声明 ──
    // "我熟悉React" "我擅长后端"
    const expertiseMatch = input.match(/我(?:熟悉|擅长|精通|会)\s*([^\s，。,\.!！?？\n]{1,20})/);
    if (expertiseMatch) {
      facts.push({
        category: 'expertise',
        value: `专长: ${expertiseMatch[1]}`,
        sourceTurn: turnIndex,
        confidence: 0.75,
      });
    }

    return facts;
  }

  /**
   * 写入单条事实到 SQLite
   *
   * 冲突解决策略（D-107）：
   *   同分类（identity/preference/expertise/habit/history）的新事实
   *   会替换旧事实。因为用户画像是"当前状态"而非"历史记录"。
   *   例："我叫张三" → 后续说"我叫李四" → 只保留"李四"，张三被移除。
   *
   * @returns 成功写入的条目，或 null（写入失败）
   */
  private async upsertFact(fact: ExtractedFact): Promise<UserProfileEntry | null> {
    // 构造稳定 ID（同分类同值同来源天然幂等）
    const id = `user-profile-${fact.category}-${this.slugify(fact.value)}`;

    // D-107：同分类冲突解决 — 删除旧条目（相同子分类 + 不同值 = 用户更新了信息）
    await this.removeConflictingEntries(fact);

    const entry: UserProfileEntry = {
      id,
      category: fact.category,
      value: fact.value,
      source: fact.sourceTurn,
      weight: 1.0,
      confirmed: fact.confidence >= 0.8, // 高置信度直接确认
      permanence: Permanence.ALWAYS,
      updatedAt: new Date().toISOString(),
    };

    try {
      const memory = this.toMemory(entry);
      await this.index.upsert(memory);
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
   * D-107：删除同分类的旧条目（用户更新了信息）
   *
   * 当用户说"我叫李四"替换之前的"我叫张三"时，移除旧的 identity 条目。
   * 策略：同分类（category）下，新值替换旧值。判断标准是旧条目的 value 前缀。
   *
   * @param fact 当前提取到的新事实
   */
  private async removeConflictingEntries(fact: ExtractedFact): Promise<void> {
    try {
      const existing = await this.index.getByType(MemoryType.PERSONALITY);
      // 提取新事实的核心模式（如 "姓名: 李四" → 前缀 "姓名"）
      const newPrefix = fact.value.split(':')[0]!.trim();

      for (const m of existing) {
        const tags = m.tags ?? [];
        if (!tags.includes('user-profile')) continue;

        const catTag = tags.find((t) => t.startsWith('category:'));
        const category = catTag?.replace('category:', '');

        // 同分类 + 不同值 → 冲突，删除旧条目
        if (category === fact.category && m.content !== fact.value) {
          const oldPrefix = m.content.split(':')[0]!.trim();
          // 核心模式相同（如 "姓名" vs "姓名"）→ 确认冲突
          if (oldPrefix === newPrefix) {
            await this.index.delete(m.id);
            logger.info(
              { oldId: m.id, oldValue: m.content, newValue: fact.value },
              '用户画像冲突已解决',
            );
          }
        }
      }
    } catch {
      // 冲突解决失败不阻塞写入
    }
  }

  /**
   * 将 UserProfileEntry 转为 Memory（用于写入 SQLite）
   *
   * tags 使用前缀编码格式传递结构化元数据：
   *   - 'user-profile' — 标记为画像条目
   *   - 'category:<category>' — 子分类
   *   - 'status:<confirmed|pending>' — 确认状态
   */
  private toMemory(entry: UserProfileEntry): Memory {
    const now = new Date().toISOString();
    return {
      id: entry.id,
      // 使用 MemoryType.PERSONALITY 作为 user-profile 的实际类型（统一索引表）
      type: MemoryType.PERSONALITY,
      permanence: Permanence.ALWAYS,
      name: `${entry.category}: ${entry.value}`,
      content: entry.value,
      tags: [
        'user-profile',
        `category:${entry.category}`,
        `status:${entry.confirmed ? 'confirmed' : 'pending'}`,
      ],
      weight: entry.weight,
      createdAt: now,
      updatedAt: entry.updatedAt || now,
    };
  }

  /**
   * 从 Memory.tags 中解析结构化字段
   *
   * tags 前缀格式（非位置依赖）：
   *   - 'category:identity' → category = 'identity'
   *   - 'status:confirmed' → confirmed = true
   *   - 'status:pending' → confirmed = false
   *   无 'user-profile' 标签 → 非画像条目
   */
  private parseMetadata(m: Memory): {
    category?: ProfileCategory;
    source?: string;
    confirmed?: boolean;
  } {
    const tags = m.tags ?? [];

    // 检查是否为画像条目
    if (!tags.includes('user-profile')) {
      return {};
    }

    // 从 tag 值中按前缀解析
    const categoryTag = tags.find((t) => t.startsWith('category:'));
    const category = categoryTag?.replace('category:', '') as ProfileCategory | undefined;

    const statusTag = tags.find((t) => t.startsWith('status:'));
    const confirmed =
      statusTag === 'status:confirmed' ? true : statusTag === 'status:pending' ? false : undefined;

    return { category, confirmed };
  }

  /**
   * 生成 URL 安全的标识符
   */
  private slugify(value: string): string {
    return value
      .replace(/[:\s]+/g, '-')
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff\-_]/g, '')
      .slice(0, 40);
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
