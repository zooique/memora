/**
 * 配置管理器 — 规则/技能注入 + 配置建议持久化 + 设定 CRUD
 *
 * 从 Agent 拆分出来，负责：
 *   - addRule / addSimpleRule：运行时规则注入（SQLite + System Prompt）
 *   - addSkill / addSimpleSkill：运行时技能注入（仅 SkillManager，session-only）
 *   - onConfigSuggestion / confirmConfigSuggestion：模式 3 配置建议回调 + 持久化
 *   - deleteRule / updateRule / listRules：规则单条 CRUD（SQLite + System Prompt 同步）
 *   - deleteSkill / listSkills：技能单条删除与列表（SQLite + SkillManager 内存同步）
 *   - getBootstrapMemories：获取 rule + skill 记忆（供 AgentLoop 刷新 system prompt）
 *
 * 设计原则：
 *   - 独立于 Agent 生命周期，仅依赖 Storage / SkillManager / 回调
 *   - 不持有 LLM Provider（纯配置操作）
 *   - 不直接操作文件（文件 CRUD 由宿主层 configFileManager 处理，本类只管 SQLite + system prompt 同步）
 */
import type { Memory } from '@/memory/types.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import type { SkillManager } from '@/skill/skillManager.js';
import { configError, toError } from '@/utils/errors.js';
import { logger } from '@/logging/logger.js';
import { nowIso } from '@/utils/time.js';
// parseFrontmatter：与 FileStore.parseMemory 保持一致的 content 处理（只存 body，去掉 frontmatter）
import { parseFrontmatter } from '@/utils/frontmatter.js';

// ─── 类型 ────────────────────────────────────────────────

/**
 * 配置建议（模式 3 · Agent 智能总结）
 *
 * AutoConfigRefiner 从对话中提取的配置建议，通过 onConfigSuggestion 回调通知宿主。
 * 宿主决定展示方式（桌宠气泡 / CLI 打印 / WebUI 弹窗），
 * 用户确认后调用 confirmConfigSuggestion() 写入配置文件。
 *
 * 与 addRule() 的区别：
 * - addRule() 写入 SQLite（运行时注入，会话级）
 * - confirmConfigSuggestion() 写入配置文件（持久化，重启后依然生效）
 */
export interface ConfigSuggestion {
  /**
   * 建议类型（开放字符串，对齐 ADR-004 基元驱动模型）
   *
   * 约定值：'rule' | 'persona' | 'skill'（由 sourceMap 映射到 SOURCE_LABELS）
   * 扩展值：任意字符串，需配合 `memorySource` 字段直接指定记忆 source 标签
   */
  type: string;
  /** 建议名称（如"代码风格"、"TypeScript 偏好"） */
  name: string;
  /** 建议内容（Markdown 格式） */
  content: string;
  /** 置信度 0-1，低于阈值时宿主可选择性忽略 */
  confidence: number;
  /** 建议来源（如对话摘要、用户画像分析） */
  source?: string;
  /**
   * 可选：直接指定记忆 source 标签（绕过 sourceMap）
   *
   * 当 type 不在约定值内时，必须提供此字段，否则 confirmConfigSuggestion 抛 configError。
   */
  memorySource?: string;
}

/** 配置建议回调函数类型 */
export type ConfigSuggestionHandler = (suggestion: ConfigSuggestion) => void;

// ─── 类 ──────────────────────────────────────────────────

export class ConfigManager {
  /** 配置建议回调（模式 3） */
  private suggestionHandler: ConfigSuggestionHandler | null = null;

  /**
   * @param index - 记忆存储（规则写入 SQLite）
   * @param skillManager - 技能管理器（运行时注入技能）
   * @param injectSystemMessage - 注入 system 消息的回调（来自 AgentLoop）
   * @param writeConfigFile - 写入配置文件的回调（来自 Agent，解耦 FileStore 依赖）
   * @param refreshBootstrapMemories - 刷新 AgentLoop system prompt 中 bootstrap 段的回调
   *   设定 CRUD（deleteRule/updateRule/deleteSkill）后调用，使 system prompt 中的
   *   rule/skill 段立即同步。由 Agent 在装配时注入（assembler.ts）。
   */
  constructor(
    private readonly index: IMemoryStorage,
    private readonly skillManager: SkillManager,
    private readonly injectSystemMessage: (message: string) => void,
    private readonly writeConfigFile?: (memory: Memory) => Promise<void>,
    private readonly refreshBootstrapMemories?: () => void,
  ) {}

  // ─── 配置建议 ─────────────────────────────────────────

  /**
   * 注册配置建议回调（模式 3）
   *
   * 宿主项目通过此方法注册回调，当 AutoConfigRefiner 从对话中
   * 提取到配置建议时，通过此回调通知宿主。
   */
  onConfigSuggestion(handler: ConfigSuggestionHandler): void {
    this.suggestionHandler = handler;
  }

  /** 获取当前注册的配置建议回调 */
  get suggestionCallback(): ConfigSuggestionHandler | null {
    return this.suggestionHandler;
  }

  /**
   * 确认配置建议并写入配置文件（模式 3）
   *
   * 用户确认配置建议后，宿主调用此方法将建议持久化到 configDir/ 目录。
   * 写入的是配置文件（真理源），下次启动时 MemoryLoader 自动扫描加载到 SQLite。
   *
   * 与 addRule() 的关键区别：
   * - addRule() → 写入 SQLite（运行时注入，会话级，重启后需重新注入）
   * - confirmConfigSuggestion() → 写入配置文件（持久化，重启后自动加载）
   */
  async confirmConfigSuggestion(suggestion: ConfigSuggestion): Promise<void> {
    if (!this.writeConfigFile) {
      throw configError('writeConfigFile 未设置', '模式 3 需要注入配置文件写入回调才能持久化', [
        '在 Agent 构造时传入 configDir 参数（Agent 会自动创建 FileStore 并注入回调）',
      ]);
    }

    // 根据建议类型映射到 source 标签（ADR-004：开放字符串，约定值走 sourceMap，扩展值走 memorySource）
    const sourceMap: Record<string, string> = {
      rule: SOURCE_LABELS.RULE,
      persona: SOURCE_LABELS.PERSONA,
      skill: SOURCE_LABELS.SKILL,
    };
    // 优先级：memorySource（扩展值）> sourceMap[type]（约定值）
    const source = suggestion.memorySource ?? sourceMap[suggestion.type];
    if (!source) {
      throw configError(
        '无法确定配置建议的 source 标签',
        `type='${suggestion.type}' 不在约定值（rule/persona/skill）内，且未提供 memorySource 字段`,
        [
          '使用约定 type 值（rule/persona/skill）',
          '或提供 memorySource 字段指定自定义 source 标签',
        ],
      );
    }

    // 构造记忆对象并写入配置文件（真理源）
    // 不写入 SQLite——遵守"配置文件是真理源"约束
    const now = nowIso();
    const memory: Memory = {
      id: `${source}:${suggestion.name}`,
      content: suggestion.content,
      source,
      name: suggestion.name,
      createdAt: now,
      accessedAt: now,
      score: suggestion.confidence,
    };
    // 包裹错误处理：磁盘满/权限不足/路径越界等异常转为友好的 configError
    try {
      await this.writeConfigFile(memory);
    } catch (err) {
      const e = toError(err);
      throw configError(
        '配置文件写入失败',
        `source=${source} name=${suggestion.name} 错误：${e.message}`,
        [
          '检查 configDir 路径是否存在且可写',
          '确认磁盘空间充足',
          '确认进程对配置目录有写权限',
        ],
        e,
      );
    }

    // 如果是规则，立即注入到 AgentLoop（当前会话生效，重启后由配置文件自动加载）
    if (suggestion.type === 'rule') {
      const rulePrompt = `【项目规则】${suggestion.name}\n${suggestion.content}`;
      this.injectSystemMessage(rulePrompt);
    }

    logger.info(
      { type: suggestion.type, name: suggestion.name, confidence: suggestion.confidence },
      '配置建议已确认并写入配置文件',
    );
  }

  // ─── 规则注入 ─────────────────────────────────────────

  /**
   * 新增项目规则记忆（Q-701 · v1.1）
   *
   * 宿主项目可通过此 API 在运行时动态注入规则记忆。
   * 规则写入 SQLite 索引后，重启时由 bootstrap 自动召回。
   * 当前轮次以 system 消息注入 AgentLoop。
   */
  async addRule(memory: Memory): Promise<void> {
    if (memory.source !== SOURCE_LABELS.RULE) {
      throw configError('无效来源', `addRule 只接受 source='rule'，收到 '${memory.source}'`, [
        '使用 SOURCE_LABELS.RULE 作为 source 字段',
      ]);
    }

    this.index.upsert(memory);

    const rulePrompt = `【项目规则】${memory.name}\n${memory.content}`;
    this.injectSystemMessage(rulePrompt);

    logger.info({ name: memory.name, source: memory.source }, '项目规则已注入');
  }

  /**
   * 新增项目规则的便捷方法
   *
   * 宿主程序只需提供 name + content 两个业务字段，
   * 内部自动填充 id / source / createdAt / accessedAt / score 等字段。
   */
  async addSimpleRule(name: string, content: string): Promise<void> {
    const now = nowIso();
    const memory: Memory = {
      id: `rule:${name}`,
      content,
      source: SOURCE_LABELS.RULE,
      name,
      createdAt: now,
      accessedAt: now,
      score: 0.8,
    };
    await this.addRule(memory);
  }

  // ─── 技能注入 ─────────────────────────────────────────

  /**
   * 运行时动态注入技能（session-only）
   *
   * 技能在 Skill 的设计中属于"配置型记忆"——
   * 由 SkillManager 在内存中管理，通过关键词匹配触发，
   * 同时写入 SQLite 索引（source: skill）以支持 recall() 检索。
   *
   * 路径一（文件加载）：SkillManager.load() 扫描 configDir/skills/*.md → 内存 + SQLite
   * 路径二（运行时注入）：addSkill() → SkillManager.register() → 内存 + SQLite
   * 路径三（持久化新增）：config.confirmConfigSuggestion({type:'skill',...}) → 写配置文件 → 下次 load() 自动加载
   *
   * 注意：运行时注入的技能仅在当前会话内生效，重启后需重新注入。
   * 如需跨会话持久化，宿主应调用 config.confirmConfigSuggestion() 写入配置文件。
   */
  async addSkill(memory: Memory): Promise<void> {
    if (memory.source !== SOURCE_LABELS.SKILL) {
      throw configError('无效来源', `addSkill 只接受 source='skill'，收到 '${memory.source}'`, [
        '使用 SOURCE_LABELS.SKILL 作为 source 字段',
      ]);
    }

    // 写入 SQLite 索引（遵循"万物皆记忆"——与 PersonaManager 一致）
    this.index.upsert(memory);

    // 同时注册到 SkillManager（内存缓存，用于关键词匹配）
    this.skillManager.register({
      name: memory.name,
      keywords: [],
      content: memory.content,
      description: memory.content.slice(0, 80),
      filePath: '',
      layer: 'agent',
    });

    logger.info({ name: memory.name }, '技能已注入');
  }

  /**
   * 运行时注入技能的便捷方法（session-only）
   *
   * 宿主程序只需提供 name + content 两个业务字段，
   * 内部自动填充 id / source / createdAt / accessedAt / score。
   * 注入后仅在当前会话生效，持久化需调用 config.confirmConfigSuggestion()。
   */
  async addSimpleSkill(name: string, content: string, keywords: string[] = []): Promise<void> {
    void keywords; // 基元驱动模型下关键词暂不存储到 Memory，由 SkillManager 管理
    const now = nowIso();
    const memory: Memory = {
      id: `skill:${name}`,
      content,
      source: SOURCE_LABELS.SKILL,
      name,
      createdAt: now,
      accessedAt: now,
      score: 0.7,
    };
    await this.addSkill(memory);
  }

  // ─── 设定 CRUD（设定面板专用） ───────────────────────

  /**
   * 删除规则（设定面板调用）
   *
   * 软删除 SQLite 中 source='rule' name=name 的记忆，
   * 并刷新 AgentLoop system prompt 中的 bootstrap 段。
   *
   * 文件层删除由宿主层 configFileManager 处理（本方法不操作文件）。
   * 删除后调用 refreshBootstrapMemories 回调，使 system prompt 立即同步。
   *
   * @param name 规则名（与 frontmatter name 字段一致）
   * @returns true 删除成功；false 规则不存在
   */
  deleteRule(name: string): boolean {
    const id = `rule:${name}`;
    const existing = this.index.getById(id);
    if (!existing) {
      logger.warn({ name, id }, '删除规则失败：规则不存在');
      return false;
    }
    this.index.delete(id);
    this.refreshBootstrapMemories?.();
    logger.info({ name, id }, '规则已删除');
    return true;
  }

  /**
   * 更新规则内容（设定面板调用）
   *
   * upsert SQLite 中 source='rule' name=name 的记忆，
   * 并刷新 AgentLoop system prompt 中的 bootstrap 段。
   *
   * 文件层更新由宿主层 configFileManager 处理（本方法不操作文件）。
   * 与 addRule 的区别：addRule 是新增（追加 system 消息），
   * updateRule 是覆盖更新（刷新 bootstrap 段，不追加 system 消息）。
   *
   * content 处理：调用方传入的是完整文件内容（含 frontmatter + body），
   * 本方法用 parseFrontmatter 解析后只存 body.trim()，
   * 与 FileStore.parseMemory（store.ts）保持一致——避免 system prompt bootstrap 段
   * 含 frontmatter 噪音，且重启后 MemoryLoader 重新加载时内容一致。
   *
   * @param name 规则名
   * @param content 新的规则文件内容（含 frontmatter + body）
   */
  updateRule(name: string, content: string): void {
    const id = `rule:${name}`;
    const existing = this.index.getById(id);
    const now = nowIso();
    // 与 FileStore.parseMemory 保持一致：只存 body（去掉 frontmatter），避免 system prompt 含噪音
    const { body } = parseFrontmatter(content);
    const memory: Memory = {
      id,
      content: body.trim(),
      source: SOURCE_LABELS.RULE,
      name,
      createdAt: existing?.createdAt ?? now,
      accessedAt: now,
      score: existing?.score ?? 0.8,
    };
    // 若 existing 已软删除，需先 restore 再 upsert（避免"通过 upsert 复活软删除记忆"校验失败）
    if (existing?.deletedAt) {
      this.index.restore(id);
    }
    this.index.upsert(memory);
    this.refreshBootstrapMemories?.();
    logger.info({ name, id }, '规则已更新');
  }

  /**
   * 列出所有规则（设定面板调用）
   *
   * @returns 所有 source='rule' 的活跃记忆（按 score 降序）
   */
  listRules(): Memory[] {
    return this.index.getBySource(SOURCE_LABELS.RULE);
  }

  /**
   * 删除技能（设定面板调用）
   *
   * 软删除 SQLite 中 source='skill' name=name 的记忆，
   * 同步清理 SkillManager 内存缓存，
   * 并刷新 AgentLoop system prompt 中的 bootstrap 段。
   *
   * 文件层删除由宿主层 configFileManager 处理（本方法不操作文件）。
   *
   * @param name 技能名
   * @returns true 删除成功；false 技能不存在
   */
  deleteSkill(name: string): boolean {
    const id = `skill:${name}`;
    const existing = this.index.getById(id);
    if (!existing) {
      logger.warn({ name, id }, '删除技能失败：技能不存在');
      return false;
    }
    this.index.delete(id);
    // 同步清理 SkillManager 内存缓存（deleteSkill 内部处理 name 不存在的情况）
    this.skillManager.deleteSkill(name);
    this.refreshBootstrapMemories?.();
    logger.info({ name, id }, '技能已删除');
    return true;
  }

  /**
   * 列出所有技能（设定面板调用）
   *
   * @returns 所有 source='skill' 的活跃记忆（按 score 降序）
   */
  listSkills(): Memory[] {
    return this.index.getBySource(SOURCE_LABELS.SKILL);
  }

  /**
   * 获取 bootstrap 记忆（rule + skill，供 AgentLoop 刷新 system prompt）
   *
   * AgentLoop 的 system prompt 中包含 bootstrap 段（rule + skill 记忆）。
   * 设定 CRUD 后调用 refreshBootstrapMemories 回调，回调内部调用此方法
   * 获取最新的 rule + skill 记忆，传给 AgentLoop.refreshBootstrapMemories()。
   *
   * @returns rule + skill 活跃记忆数组
   */
  getBootstrapMemories(): Memory[] {
    return [
      ...this.index.getBySource(SOURCE_LABELS.RULE),
      ...this.index.getBySource(SOURCE_LABELS.SKILL),
    ];
  }
}
