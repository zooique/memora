/**
 * 角色管理器 — 加载、切换、注入角色人格（personas/ 目录 + SQLite 存储）
 *
 * 职责：
 *   - 从 configDir/personas/*.md 加载角色文件
 *   - 解析 frontmatter（name / keywords / description）
 *   - 写入 SQLite 索引（source: persona, score: 1.0）
 *   - 将激活角色注入到 system prompt 顶部
 *   - 支持运行时切换角色 + 关键词自动匹配
 *
 * 设计原则（architecture_philosophy_rules.md §1）：
 *   - Persona 遵循"万物皆记忆"——存入 SQLite 作为 persona 来源记忆
 *   - 召回管线做特殊处理：bootstrap 只取当前激活角色的 1 条 persona 记忆
 *   - 角色可被会话关键词动态匹配自动切换，也可手动指定
 *
 * 目录约定：
 *   - 单层角色：只有宿主程序级 <configDir>/personas/*.md
 *   - 目录名 personas/ 与代码 Persona 术语一致，区别于用户身份信息
 */
import { scoreByKeywords } from '@/utils/segmenter.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';
import { SOURCE_LABELS } from '@/memory/types.js';
import type { Memory } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';
import { byScoreDesc } from '@/utils/array.js';
import { configError } from '@/utils/errors.js';
import type { Persona, PersonaMode } from '@/persona/types.js';
import { scanMarkdownDir, parseKeywords, resolveSubdir } from '@/utils/scanner.js';
import { safeSetTimeout, clearSafeTimeout } from '@/utils/safeTimer.js';
import { nowIso } from '@/utils/time.js';

/** 关键词匹配高置信度阈值：≥ 此值直接返回（低置信度由 agent 层决定是否调 LLM） */
const KEYWORD_HIGH_CONFIDENCE_THRESHOLD = 0.5;

/**
 * 从 frontmatter 解析 traits.* 键值对
 *
 * 遍历 frontmatter 中以 "traits." 开头的键，提取数值。
 * 非数值或超出 0-1 范围的值被静默忽略（防御性解析）。
 *
 * @param fm frontmatter 键值对映射
 * @returns traits 对象，无有效键时返回 undefined
 */
function parseTraits(fm: Record<string, string>): Record<string, number> | undefined {
  const traits: Record<string, number> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!key.startsWith('traits.')) continue;
    const traitName = key.slice(7); // 去掉 'traits.' 前缀
    if (!traitName) continue;
    const num = Number(value);
    // 防御性校验：必须是有效数值且在 0-1 范围内
    if (Number.isFinite(num) && num >= 0 && num <= 1) {
      traits[traitName] = num;
    }
  }
  return Object.keys(traits).length > 0 ? traits : undefined;
}

/**
 * 角色管理器（personas/ + SQLite + 关键词匹配）
 */
export class PersonaManager {
  /** 当前激活的角色 */
  private activePersona: Persona | null = null;
  /** 角色列表缓存（启动时扫描一次） */
  private personaList: Persona[] = [];
  /** 激活模式 */
  private mode: PersonaMode = 'auto';
  /** 角色切换时间戳列表（用于时间窗口缓冲） */
  private switchTimestamps: number[] = [];
  /** 缓冲区开关（60s 内 3 次切换后锁定） */
  private switchLocked = false;
  /** 锁定恢复计时器 */
  private unlockTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 锁定自动恢复时间戳（ms epoch）
   *
   * 锁定期间为 `Date.now() + AUTO_UNLOCK_MS`，解锁后清空为 null。
   * 供宿主 UI 展示剩余锁定时长（P0-2 用户体验打磨）。
   */
  private unlockAt: number | null = null;

  /** 时间窗口：60 秒 */
  private static readonly SWITCH_WINDOW_MS = 60_000;
  /** 窗口内最大切换次数 */
  private static readonly MAX_SWITCHES_IN_WINDOW = 3;
  /** 锁定后自动恢复时间：5 分钟 */
  private static readonly AUTO_UNLOCK_MS = 300_000;

  /**
   * @param configDir 配置目录（角色文件在 <configDir>/personas/ 下）
   * @param index SQLite 索引（用于写入 persona 记忆）
   */
  constructor(
    private readonly configDir?: string,
    private readonly index?: IMemoryStorage,
  ) {}

  /**
   * 启动时加载：扫描目录 + 激活指定角色 + 写入 SQLite
   *
   * @param activePersona 要激活的角色名（可选，不传则使用第一个找到的角色）
   * @returns 激活角色的 system prompt 段
   */
  async load(activePersona?: string): Promise<string> {
    this.personaList = await this.scanPersonas();

    if (this.personaList.length === 0) {
      logger.warn({ personaCount: 0 }, '未找到任何角色文件，将使用默认角色');
      this.activePersona = this.createDefaultPersona();
      this.writePersonaToIndex(this.activePersona);
      return this.buildSystemPrompt();
    }

    logger.info(
      { count: this.personaList.length, names: this.personaList.map((p) => p.name) },
      '角色文件加载完成',
    );

    // 写入 SQLite 索引（persona 遵循万物皆记忆）
    this.writeAllToIndex();

    // 激活指定角色
    if (activePersona) {
      const found = this.personaList.find((p) => p.name === activePersona);
      if (found) {
        this.activePersona = found;
      } else {
        logger.warn({ requested: activePersona }, '未找到指定角色，使用第一个');
        // QC-17 移除非空断言：personaList 已在第 72 行检查非空
        this.activePersona = this.personaList[0] ?? this.createDefaultPersona();
      }
    } else {
      // QC-17 移除非空断言：personaList 已在第 72 行检查非空
      this.activePersona = this.personaList[0] ?? this.createDefaultPersona();
    }

    logger.info({ persona: this.activePersona.name }, '角色已激活');
    return this.buildSystemPrompt();
  }

  /**
   * 获取当前激活的角色名（用于 bootstrap 过滤）
   */
  get activeName(): string {
    return this.activePersona?.name ?? 'default';
  }

  /**
   * 获取当前激活角色对象（Phase 2.1：AffectController 需要 traits 字段）
   *
   * 返回 null 时表示未加载任何角色（使用默认行为）。
   */
  getActive(): Persona | null {
    return this.activePersona;
  }

  /**
   * 切换角色（带时间窗口缓冲）
   *
   * 错误策略统一（IX-03）：角色不存在时抛 MemoraError，与 switchProject 一致。
   * 交换锁定时仍返回当前 prompt（非错误，是限流保护）。
   *
   * @param name 角色名
   * @returns 新角色的 system prompt 段
   * @throws MemoraError 如果角色不存在
   */
  switchPersona(name: string): string {
    // 缓冲区检查（限流保护，非错误）
    if (this.switchLocked) {
      logger.info({ persona: name }, '角色切换已锁定（60s 内超过 3 次），保持当前');
      return this.buildSystemPrompt();
    }

    const found = this.personaList.find((p) => p.name === name);
    if (!found) {
      // 统一错误策略：找不到目标时抛错，而非静默保持当前
      throw configError('角色切换失败', `角色 "${name}" 不存在`, [
        '使用 persona.list 查看可用角色',
        '在 agent-config/personas/ 目录下创建该角色配置文件',
      ]);
    }
    if (this.activePersona?.name === name) {
      return this.buildSystemPrompt(); // 同一角色，不需要切换
    }

    this.activePersona = found;
    this.recordSwitch();
    logger.info({ persona: name }, '角色已切换');
    return this.buildSystemPrompt();
  }

  /**
   * 根据用户输入自动匹配最合适的角色（关键词高置信度匹配）
   *
   * 匹配策略：
   *   - 关键词匹配高置信度（≥ KEYWORD_HIGH_CONFIDENCE_THRESHOLD）→ 直接返回
   *   - 关键词低置信度/无匹配 → 返回 null（由 agent 层决定是否调用 LLM 辅助）
   *
   * LLM 辅助语义匹配已迁移到 agent 层（agent/personaMatcher.ts），
   * 遵循 backend_layers_rules §分层职责：persona/ 不直接调 LLM。
   *
   * 匹配前置条件：
   *   - 当前模式为 'auto'（非手动锁定）
   *   - 缓冲区未锁定
   *   - 角色列表非空
   *   - 匹配的角色与当前角色不同
   *
   * @param userInput 用户输入文本
   * @returns 匹配的角色名，无匹配返回 null
   */
  async autoMatch(userInput: string): Promise<string | null> {
    if (this.mode !== 'auto') return null;
    if (this.switchLocked) return null;
    if (this.personaList.length === 0) return null;

    const keywordBest = this.findBestKeywordMatch(userInput);

    // 高置信度（≥ 阈值）：直接返回
    if (keywordBest && keywordBest.score >= KEYWORD_HIGH_CONFIDENCE_THRESHOLD) {
      if (this.activePersona?.name === keywordBest.name) return null;
      return keywordBest.name;
    }

    // 低置信度/无匹配：返回 null，由 agent 层决定是否调用 LLM 辅助
    return null;
  }

  /**
   * 检查是否满足自动匹配的前置条件
   *
   * 供 agent 层在调用 matchPersonaByLlm 前判断是否值得尝试 LLM 辅助匹配。
   * 前置条件与 autoMatch 内部检查一致：
   *   - 当前模式为 'auto'（非手动锁定）
   *   - 缓冲区未锁定
   *   - 角色列表非空
   *
   * @returns 是否满足自动匹配前置条件
   */
  canAutoMatch(): boolean {
    return this.mode === 'auto' && !this.switchLocked && this.personaList.length > 0;
  }

  /**
   * 关键词匹配：遍历角色列表，返回得分最高的角色
   *
   * @param userInput 用户输入文本
   * @returns 得分最高的角色和得分，无命中返回 null
   */
  private findBestKeywordMatch(
    userInput: string,
  ): { name: string; score: number } | null {
    const matches: Array<{ name: string; score: number }> = [];

    for (const persona of this.personaList) {
      if (persona.keywords.length === 0) continue;

      const score = scoreByKeywords(userInput, persona.keywords);
      if (score > 0) {
        matches.push({ name: persona.name, score });
      }
    }

    if (matches.length === 0) return null;

    matches.sort(byScoreDesc);
    return matches[0] ?? null;
  }

  /**
   * 设置激活模式
   *
   * @param mode 'auto'（自动匹配）| 'manual'（手动固定）
   */
  setMode(mode: PersonaMode): void {
    this.mode = mode;
    // 切回自动模式时清除锁定状态（同步清空 unlockAt，避免残留脏数据，P0-2 排雷雷点 4）
    if (mode === 'auto' && this.switchLocked) {
      this.switchLocked = false;
      this.switchTimestamps = [];
      this.unlockAt = null;
      logger.info({ mode: this.mode }, '角色切换锁定已解除（模式切回自动）');
    }
  }

  /**
   * 获取角色切换锁定状态（供宿主 UI 展示剩余锁定时长，P0-2 用户体验打磨）
   *
   * 锁定触发条件：60s 内切换 3 次后自动锁定 5 分钟（AUTO_UNLOCK_MS）。
   * 返回值用于宿主 IPC 透传到渲染层，区分"切换失败"原因。
   *
   * @returns locked 是否处于锁定状态；unlockAt 锁定自动恢复时间戳（ms epoch），未锁定时为 null
   */
  getSwitchLockStatus(): { locked: boolean; unlockAt: number | null } {
    return { locked: this.switchLocked, unlockAt: this.unlockAt };
  }

  /** 获取当前激活模式 */
  get currentMode(): PersonaMode {
    return this.mode;
  }

  /**
   * 获取角色列表
   */
  get list(): Persona[] {
    return this.personaList;
  }

  /**
   * 清理定时器资源（Agent.close() 时调用）
   *
   * PersonaManager 持有 unlockTimer（角色切换防抖锁的自动恢复计时器），
   * 若不清理，Agent 关闭后定时器仍会触发回调，在已关闭的实例上执行引发异常。
   * 同步清空锁定状态字段（switchLocked/unlockAt/switchTimestamps），
   * 避免 Agent 关闭后宿主查询 getSwitchLockStatus 返回脏数据（P0-2 排雷雷点 5）。
   */
  close(): void {
    if (this.unlockTimer) {
      clearSafeTimeout(this.unlockTimer);
      this.unlockTimer = null;
    }
    this.switchLocked = false;
    this.unlockAt = null;
    this.switchTimestamps = [];
  }

  /**
   * 重载角色：清空内存缓存 + 重新扫描目录 + 同步 SQLite 索引 + 保持当前激活角色
   *
   * 事件驱动重载：confirmConfigSuggestion 写入 persona 文件后或用户手动编辑
   * personas/ 目录后，调用此方法使当前会话立即生效，无需重启 Agent。
   *
   * 激活角色保持策略：
   * - 若当前激活角色在重载后仍存在 → 更新为重载后的版本（内容可能已变更）
   * - 若当前激活角色已被删除 → 回退到列表第一个角色（与 load() 默认行为一致）
   *
   * @returns 重载后的角色数量
   */
  async reload(): Promise<number> {
    const oldActiveName = this.activePersona?.name;
    this.personaList = await this.scanPersonas();
    this.writeAllToIndex();

    // 保持当前激活角色（若仍存在），否则回退到第一个
    if (oldActiveName) {
      const found = this.personaList.find((p) => p.name === oldActiveName);
      if (found) {
        this.activePersona = found;
      } else {
        this.activePersona = this.personaList[0] ?? this.createDefaultPersona();
        logger.warn(
          { oldActive: oldActiveName, newActive: this.activePersona.name },
          '激活角色已被删除，回退到默认',
        );
      }
    } else {
      this.activePersona = this.personaList[0] ?? this.createDefaultPersona();
    }

    logger.info(
      { count: this.personaList.length, active: this.activePersona.name },
      '角色已重载',
    );
    return this.personaList.length;
  }

  /**
   * 删除角色（设定面板调用）
   *
   * 从内存列表移除指定角色，并软删除 SQLite 中对应的 persona 记忆。
   * 若删除的是当前激活角色，自动回退到列表第一个角色（与 reload() 删除场景一致）。
   *
   * 文件层删除由宿主层 configFileManager 处理（本方法不操作文件）。
   * 调用方在删除后应通过 Agent.refreshPersonaPrefixOnLoop() 刷新 system prompt 前缀，
   * 本方法不直接操作 AgentLoop（保持与 reload() 一致的职责边界）。
   *
   * @param name 角色名
   * @returns true 删除成功；false 角色不存在
   */
  deletePersona(name: string): boolean {
    const idx = this.personaList.findIndex((p) => p.name === name);
    if (idx < 0) {
      logger.warn({ name }, '删除角色失败：角色不存在');
      return false;
    }

    const deleted = this.personaList[idx]!; // idx >= 0 已由上方 findIndex 检查保证
    this.personaList.splice(idx, 1);

    // 软删除 SQLite 中的 persona 记忆（id 优先取 frontmatter，回退 persona:name）
    const personaId = deleted.id ?? `persona:${name}`;
    if (this.index) {
      try {
        this.index.delete(personaId);
      } catch (err) {
        // SQLite 删除失败不阻断内存删除（内存已是最新的）
        logger.warn({ err, name, personaId }, '角色 SQLite 记忆软删除失败');
      }
    }

    // 若删除的是激活角色，回退到列表第一个或默认角色
    if (this.activePersona?.name === name) {
      this.activePersona = this.personaList[0] ?? this.createDefaultPersona();
      logger.warn(
        { deleted: name, newActive: this.activePersona.name },
        '激活角色已被删除，回退到默认',
      );
    }

    logger.info({ name, remaining: this.personaList.length }, '角色已删除');
    return true;
  }

  /**
   * 构建 system prompt 中的角色段
   */
  buildSystemPrompt(name?: string): string {
    const p = name ? this.personaList.find((item) => item.name === name) : this.activePersona;
    if (!p) return '';
    const meta = [`【当前角色】${p.name}`];
    if (p.description) meta.push(p.description);
    return `${meta.join(' · ')}\n\n${p.content}`;
  }

  // ── 私有方法 ──────────────────────────────────────

  /**
   * 记录一次角色切换（时间窗口缓冲）
   */
  private recordSwitch(): void {
    const now = Date.now();
    // 清理过期记录
    this.switchTimestamps = this.switchTimestamps.filter(
      (t) => now - t < PersonaManager.SWITCH_WINDOW_MS,
    );
    this.switchTimestamps.push(now);

    if (this.switchTimestamps.length >= PersonaManager.MAX_SWITCHES_IN_WINDOW) {
      logger.warn({ count: this.switchTimestamps.length }, '角色切换过于频繁，锁定 5 分钟');
      this.switchLocked = true;
      // 记录锁定自动恢复时间戳（供宿主 UI 展示剩余时长，P0-2 用户体验打磨）
      this.unlockAt = now + PersonaManager.AUTO_UNLOCK_MS;
      // 5 分钟后自动解锁（同步清空 unlockAt，避免残留脏数据）
      if (this.unlockTimer) clearSafeTimeout(this.unlockTimer);
      this.unlockTimer = safeSetTimeout(() => {
        this.switchLocked = false;
        this.switchTimestamps = [];
        this.unlockAt = null;
        logger.info({ mode: this.mode }, '角色切换锁定已自动解除');
      }, PersonaManager.AUTO_UNLOCK_MS);
    }
  }

  /**
   * 扫描单层目录，加载角色列表
   */
  private async scanPersonas(): Promise<Persona[]> {
    const list: Persona[] = [];

    const personasDir = resolveSubdir(this.configDir, 'personas');
    if (!personasDir) return list;

    const entries = await scanMarkdownDir(personasDir);

    for (const entry of entries) {
      const fm = entry.frontmatter;
      list.push({
        name: entry.name,
        id: fm['id'] ?? `persona:${entry.name}`,
        description: fm['description'],
        keywords: parseKeywords(fm),
        content: entry.body.trim(),
        filePath: entry.filePath,
        // Phase 2.1：解析 traits.* 键值对（如 traits.playfulness: 0.7）
        traits: parseTraits(fm),
      });
    }

    return list;
  }

  /**
   * 将所有角色写入 SQLite 索引
   *
   * 使用 try/catch 包裹每个 upsert 调用，防止单条写入失败阻断其余角色索引。
   * IMemoryStorage.upsert 是同步方法，但可能因底层存储故障（磁盘满/权限错误）抛异常。
   */
  private writeAllToIndex(): void {
    if (!this.index) return;
    let failedCount = 0;
    for (const persona of this.personaList) {
      try {
        this.writePersonaToIndex(persona);
      } catch (err) {
        failedCount++;
        logger.warn({ err, persona: persona.name }, '角色记忆写入 SQLite 失败');
      }
    }
    if (failedCount > 0) {
      logger.warn({ total: this.personaList.length, failed: failedCount }, '部分角色记忆写入失败');
    } else {
      logger.info({ count: this.personaList.length }, '角色记忆已写入 SQLite');
    }
  }

  /**
   * 将单个角色写入 SQLite 索引
   *
   * 函数体无 await，作为同步函数实现。index.upsert 是同步方法。
   */
  private writePersonaToIndex(persona: Persona): void {
    if (!this.index) return;
    const now = nowIso();
    const memory: Memory = {
      id: persona.id,
      content: persona.content,
      source: SOURCE_LABELS.PERSONA,
      name: persona.name,
      createdAt: now,
      accessedAt: now,
      score: 1.0,
    };
    this.index.upsert(memory);
  }

  /**
   * 创建默认角色
   */
  private createDefaultPersona(): Persona {
    return {
      name: 'default',
      id: 'persona:default',
      description: '默认通用助手',
      keywords: [],
      content: '你是一个通用 AI 助手，以专业、友好的态度回应用户。',
      filePath: '(built-in)',
    };
  }
}
