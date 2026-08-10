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
 *
 * 文件层契约（SSOT 排雷 T3-2 定性，2026-08-09）：
 *   配置文件是真理源，SQLite 是运行时检索索引，重启后由文件（MemoryLoader）自愈。
 *   本类所有写 API（addRule/deleteRule/updateRule/deleteSkill）只同步 SQLite 层，
 *   调用方必须先完成文件层写入/删除（如宿主 configFileSyncer 先写/删文件再调本方法）。
 *   ⚠ 绕过文件层直接调用本类写 API 的写操作不持久——重启后会被文件恢复原状
 *   （「重启复活」）。此旁路当前零生产调用者（宿主链路已正确排序），契约仅文档化，
 *   不注入文件同步器（会与宿主文件层双写、且违背「不直接操作文件」原则）。
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
  /**
   * 可选：写入配置文件 frontmatter 的额外元数据
   *
   * 键值对会合并到 frontmatter 中（如 `keywords`、`description`），
   * 供 PersonaManager.parseKeywords / SkillManager 等加载时解析。
   * 不传时 frontmatter 仅含标准字段（id/source/score/createdAt/accessedAt）。
   */
  metadata?: Record<string, string>;
}

/** 配置建议回调函数类型 */
export type ConfigSuggestionHandler = (suggestion: ConfigSuggestion) => void;

// ─── 类 ──────────────────────────────────────────────────

export class ConfigManager {
  /** 配置建议回调（模式 3） */
  private suggestionHandler: ConfigSuggestionHandler | null = null;

  /**
   * 安全刷新 bootstrap 记忆（F3.2 失败降级）
   *
   * 包装 refreshBootstrapMemories() 调用，捕获异常并通过 logger.warn 记录。
   * 历史版本曾提供 onBootstrapSyncFailed 回调供宿主重试/告警，但全仓零注册
   * （SSOT 排雷 T2-3 复核确认）——属「定义完善却永不兑现的死契约」，已删除。
   * 失败可观测性统一由 logger.warn 承担（宿主日志链路已消费该告警）。
   * 所有 CRUD 操作中的 refreshBootstrapMemories 均通过此方法调用。
   */
  private safeRefreshBootstrapMemories(): void {
    try {
      this.refreshBootstrapMemories();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.warn({ err: error }, 'bootstrap 记忆同步失败（system prompt 与存储可能不一致）');
    }
  }

  /**
   * @param index - 记忆存储（规则写入 SQLite）
   * @param skillManager - 技能管理器（运行时注入技能）
   * @param injectSystemMessage - 注入 system 消息的回调（来自 AgentLoop）
   * @param refreshBootstrapMemories - 刷新 AgentLoop system prompt 中 bootstrap 段的回调
   *   设定 CRUD（deleteRule/updateRule/deleteSkill）后调用，使 system prompt 中的
   *   rule/skill 段立即同步。由 Agent 在装配时注入（assembler.ts）。
   *   必选参数：CRUD 操作后必须同步 bootstrap 段，否则 system prompt 与存储不一致（SSOT 违反）。
   * @param writeConfigFile - 写入配置文件的回调（来自 Agent，解耦 FileStore 依赖）
   * @param removeRelationsByMemoryId - 删除记忆时清理关联关系边的回调（可选，P0-1 孤儿边清理）
 *   传入 memoryInspector.writeRemoveRelationsByMemoryId 的绑定版本。
 *   未注入时删除记忆不清理关系边（向后兼容，但可能残留孤儿边）。
 * @param fileConsistencyCheck - 文件层前置条件断言回调（可选，T5：两段式契约结构化）
 *   注入时，deleteRule/deleteSkill/updateRule 入口先校验宿主是否已完成文件操作。
 *   `expected='absent'` 校验文件应已被宿主删除；`expected='exists'` 校验文件应已写入。
 *   校验失败抛 configError（fail-fast），未注入时完全降级为现状。
 *   注意：此校验是快照断言，不保证文件操作与索引操作之间的原子性（本地文件架构固有边界）。
 */
  constructor(
    private readonly index: IMemoryStorage,
    private readonly skillManager: SkillManager,
    private readonly injectSystemMessage: (message: string) => void,
    private readonly refreshBootstrapMemories: () => void,
    private readonly writeConfigFile?: (memory: Memory) => Promise<void>,
    private readonly removeRelationsByMemoryId?: (memoryId: string) => number,
    private readonly fileConsistencyCheck?: (id: string, expected: 'exists' | 'absent') => boolean,
  ) {}

  /**
   * 文件层前置条件断言（T5：两段式契约结构化）
   *
   * 注入 `fileConsistencyCheck` 时，在校验失败时抛 configError（fail-fast）；
   * 未注入时完全降级为现状（向后兼容）。
   */
  private assertFileConsistency(id: string, expected: 'exists' | 'absent'): void {
    if (!this.fileConsistencyCheck) return;
    if (!this.fileConsistencyCheck(id, expected)) {
      throw configError(
        '文件层前置条件未满足',
        `文件层前置条件校验失败：${expected === 'absent' ? '文件应已被删除' : '文件应已存在'}（id: ${id}）`,
        ['先经宿主 configFileSyncer 完成文件操作，再调用 ConfigManager'],
      );
    }
  }

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

    // 路径穿越防御：suggestion.name 直落 FileStore.getFilePath 的文件名
    // （store.ts:118 `${name}.md`，未经 sanitize，仅 source 经 validateSource 校验，name 不校验）。
    // LLM 生成的 name 若含 '/'、'..'、'\' 等即可路径遍历逃出 configDir。
    // 在入口收口白名单，最早失败、早于一切副作用（磁盘写入 / SQLite upsert）。
    if (!/^[\w\u4e00-\u9fa5-]{1,64}$/.test(suggestion.name)) {
      throw configError(
        '配置建议名称非法',
        `name='${suggestion.name}' 含路径穿越字符或超长（仅允许字母/数字/下划线/中文/连字符，1-64 字）`,
        ['使用安全的规则/技能/人设命名（如 my-rule、项目规范）'],
      );
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
    // 写入 SQLite index（运行时索引）：配置文件是真理源，SQLite 是运行时检索索引
    // 两层写入语义：配置文件保证重启后自动加载；SQLite 保证当前会话 search_memories 可检索
    const now = nowIso();
    const memory: Memory = {
      id: `${source}:${suggestion.name}`,
      content: suggestion.content,
      source,
      name: suggestion.name,
      createdAt: now,
      accessedAt: now,
      score: suggestion.confidence,
      // metadata 透传到 FileStore.write，合并到 frontmatter（如 keywords/description）
      metadata: suggestion.metadata,
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

    // 同步写入 SQLite index：当前会话的 search_memories / recall 可立即检索到新创建的配置
    // persona/skill 后续由 reloadConfig → SkillManager.reload / PersonaManager.reload 重新扫描覆盖，
    // 但 rule 的 reloadConfig 是 no-op（agent.ts 内跳过），必须在此显式同步
    // 重建同名已软删记忆前先 restore，与 loader.ts:100 / updateRule 对称。
    // 否则 upsert 会因「以活跃态覆盖软删除态」抛错，而磁盘文件已在上方 :216 写入，
    // 造成「文件落盘 + SQLite 索引分叉」的半成功状态。restore 对活跃/不存在记忆为 no-op（loader.ts:85），安全。
    this.index.restore(memory.id);
    this.index.upsert(memory);

    // 如果是规则，立即注入到 AgentLoop（当前会话生效，重启后由配置文件自动加载）
    if (suggestion.type === 'rule') {
      const rulePrompt = `【项目规则】${suggestion.name}\n${suggestion.content}`;
      this.injectSystemMessage(rulePrompt);
      // 刷新 bootstrap 段（messages[0] 中的 rule 全集）。
      // 与 deleteRule:346 / updateRule:393 / deleteSkill:430 对称——此前缺此调用，
      // 且 agent.reloadConfig('rule') 是显式 no-op（agent.ts 内跳过），
      // 导致确认的新规则只靠一条易被截断的临时 system 消息生效，重启前永进不了 bootstrap。
      // upsert(:199) 已完成 → 回调内 getBootstrapMemories 经 getBySource(RULE) 必然包含新规则，
      // loop.refreshBootstrapMemories 是替换式重建，幂等无副作用。
      this.safeRefreshBootstrapMemories();
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
   * 规则写入 SQLite 索引后，仅写 SQLite 索引；
   * 重启后无文件支撑，将在启动对账中被 evictOrphanRules 软删。
   * 跨会话持久化请走 confirmConfigSuggestion 写配置文件。
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
   * ⚠ 文件层前置条件（T3-2）：调用方必须先删除配置文件（真理源）再调本方法，
   * 否则本方法删除的只是 SQLite 索引，重启后由文件恢复原状（「重启复活」）。
   * 宿主正确路径：configFileSyncer 先 deleteConfigFile 再调本方法。
   *
   * @param name 规则名（与 frontmatter name 字段一致）
   * @returns true 删除成功；false 规则不存在
   */
  deleteRule(name: string): boolean {
    const id = `rule:${name}`;
    // 文件层前置条件断言——文件应已被宿主删除
    this.assertFileConsistency(id, 'absent');
    const existing = this.index.getById(id);
    if (!existing) {
      logger.warn({ name, id }, '删除规则失败：规则不存在');
      return false;
    }
    // 先清理关联关系边，防止 memory_relations 表残留孤儿边
    this.removeRelationsByMemoryId?.(id);
    this.index.delete(id);
    this.safeRefreshBootstrapMemories();
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
   * ⚠ 文件层前置条件（T3-2）：调用方必须先更新配置文件（真理源）再调本方法，
   * 否则本方法更新的只是 SQLite 索引，重启后由文件恢复旧内容（「重启复活」）。
   * 宿主正确路径：configFileSyncer 先 saveConfigFile 再调本方法。
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
    // 文件层前置条件断言——文件应已由宿主写入
    this.assertFileConsistency(id, 'exists');
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
    this.safeRefreshBootstrapMemories();
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
    // 文件层前置条件断言——文件应已被宿主删除
    this.assertFileConsistency(id, 'absent');
    const existing = this.index.getById(id);
    if (!existing) {
      logger.warn({ name, id }, '删除技能失败：技能不存在');
      return false;
    }
    // P0-1：先清理关联关系边，防止 memory_relations 表残留孤儿边
    this.removeRelationsByMemoryId?.(id);
    this.index.delete(id);
    // 同步清理 SkillManager 内存缓存（deleteSkill 内部处理 name 不存在的情况）
    this.skillManager.deleteSkill(name);
    this.safeRefreshBootstrapMemories();
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
   * 获取 bootstrap 记忆（仅 Rule，供 AgentLoop 刷新 system prompt）
   *
   * AgentLoop 的 system prompt 中包含 bootstrap 段（rule 记忆）。
   * Skill 已迁移到 per-round matchAndInjectSkill 动态注入，不再放入 bootstrap。
   * 设定 CRUD 后调用 refreshBootstrapMemories 回调，回调内部调用此方法
   * 获取最新的 rule 记忆，传给 AgentLoop.refreshBootstrapMemories()。
   *
   * @returns rule 活跃记忆数组
   */
  getBootstrapMemories(): Memory[] {
    return [
      ...this.index.getBySource(SOURCE_LABELS.RULE),
    ];
  }
}
