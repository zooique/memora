/**
 * 角色管理器 — 过渡期宿主 API 层
 *
 * 职责（ADR-025 档 2-1 后）：
 *   - 宿主角色切换 API：switchPersona / autoMatch / setMode
 *   - 角色切换防抖（30s 内 5 次后锁定 2 分钟）
 *   - 关键词高置信度匹配（autoMatch）
 *   - 角色 traits 提取（供 affectController 等宿主情感计算）
 *
 * 历史职责（已移除）：
 *   - 从 configDir/personas/*.md 加载角色 → 角色包（RolePackManager）唯一承载
 *   - 将角色内容注入 system prompt → 角色包唯一注入
 *
 * 设计原则：
 *   - 过渡期只读模式：PersonaManager 不再写 system prompt，仅承载宿主 API
 *   - 关键词/ traits 仍需从 personas/*.md 解析（角色包目前未承载此能力）
 *   - 未来目标：角色包承载关键词 + traits 后，PersonaManager 可完全删除
 *
 * 与角色包的关系：
 *   - RolePackManager.buildSystemPrompt() → 唯一 system prompt 注入源
 *   - PersonaManager.switchPersona() → 宿主切换 API，同时通知 RolePackManager 激活
 *   - 两者并行存在，角色包优先
 */
import { logger } from '@/logging/logger.js';
import { configError } from '@/utils/errors.js';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import type { Persona, PersonaMode } from '@/persona/types.js';
import { parseKeywords } from '@/utils/scanner.js';
import type { ScannedMarkdownEntry } from '@/utils/scanner.js';
import { safeSetTimeout, clearSafeTimeout } from '@/utils/safeTimer.js';

/**
 * 关键词匹配高置信度阈值：≥ 此值直接返回（低置信度由 agent 层决定是否调 LLM）
 */
const KEYWORD_HIGH_CONFIDENCE_THRESHOLD = 0.3;

/**
 * 从 frontmatter 解析 traits.* 键值对
 */
function parseTraits(fm: Record<string, string>): Record<string, number> | undefined {
  const traits: Record<string, number> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!key.startsWith('traits.')) continue;
    const traitName = key.slice(7);
    if (!traitName) continue;
    const num = Number(value);
    if (Number.isFinite(num) && num >= 0 && num <= 1) {
      traits[traitName] = num;
    }
  }
  return Object.keys(traits).length > 0 ? traits : undefined;
}

/**
 * 角色管理器
 */
export class PersonaManager extends ConfigResourceManager<Persona, string> {
  /** 当前激活的角色 */
  private activePersona: Persona | null = null;
  /** 激活模式 */
  private mode: PersonaMode = 'auto';
  /** 角色切换时间戳列表（用于时间窗口缓冲） */
  private switchTimestamps: number[] = [];
  /** 缓冲区开关（30s 内 5 次切换后锁定） */
  private switchLocked = false;
  /** 锁定恢复计时器 */
  private unlockTimer: ReturnType<typeof setTimeout> | null = null;
  /** 锁定自动恢复时间戳（ms epoch） */
  private unlockAt: number | null = null;

  /** 时间窗口：30 秒 */
  private static readonly SWITCH_WINDOW_MS = 30_000;
  /** 窗口内最大切换次数：5 次 */
  private static readonly MAX_SWITCHES_IN_WINDOW = 5;
  /** 锁定后自动恢复时间：2 分钟 */
  private static readonly AUTO_UNLOCK_MS = 120_000;

  /**
   * @param configDir 配置目录（角色文件在 <configDir>/personas/ 下）
   */
  constructor(configDir?: string) {
    super(configDir, 'personas');
  }

  // ── 生命周期 ───────────────────────────────────

  /**
   * 启动时加载：扫描目录 + 激活指定角色
   *
   * @param activePersona 要激活的角色名（可选，不传则使用第一个找到的角色）
   * @returns 激活角色的 system prompt 段
   */
  async load(activePersona?: string): Promise<string> {
    await this.loadItems(activePersona);
    logger.info({ persona: this.activePersona?.name }, '角色已激活');
    return this.buildSystemPrompt();
  }

  /**
   * 重载角色：清空内存缓存 + 重新扫描 + 保持当前激活角色
   */
  async reload(): Promise<number> {
    const oldActiveName = this.activePersona?.name;
    const count = await super.reload();

    // 保持当前激活角色（若仍存在），否则回退到第一个
    if (oldActiveName) {
      const found = this.items.find((p) => p.name === oldActiveName);
      if (found) {
        this.activePersona = found;
      } else {
        this.activePersona = this.items[0] ?? this.createDefaultPersona();
        logger.warn(
          { oldActive: oldActiveName, newActive: this.activePersona.name },
          '激活角色已被删除，回退到默认',
        );
      }
    } else {
      this.activePersona = this.items[0] ?? this.createDefaultPersona();
    }

    logger.info(
      { count, active: this.activePersona.name },
      '角色已重载',
    );
    return count;
  }

  // ── 加载后钩子（选择激活角色） ─────────────────────

  /**
   * load() 完成后选择激活角色
   *
   * @param _items 已加载的角色列表
   * @param activeName 指定的激活角色名（options 参数）
   */
  protected onAfterLoad(_items: Persona[], activeName?: string): void {
    if (this.items.length === 0) {
      logger.warn({ personaCount: 0 }, '未找到任何角色文件，将使用默认角色');
      this.activePersona = this.createDefaultPersona();
      return;
    }

    if (activeName) {
      const found = this.items.find((p) => p.name === activeName);
      if (found) {
        this.activePersona = found;
      } else {
        logger.warn({ requested: activeName }, '未找到指定角色，使用第一个');
        this.activePersona = this.items[0] ?? this.createDefaultPersona();
      }
    } else {
      this.activePersona = this.items[0] ?? this.createDefaultPersona();
    }

    logger.info({ persona: this.activePersona.name }, '角色已激活');
  }

  // ── 角色管理 ──────────────────────────────────────

  /** 当前激活的角色名 */
  get activeName(): string {
    return this.activePersona?.name ?? 'default';
  }

  /** 获取当前激活角色对象 */
  getActive(): Persona | null {
    return this.activePersona;
  }

  /** 获取角色列表（委托基类） */
  get list(): Persona[] {
    return this.items;
  }

  /**
   * 切换角色（带时间窗口缓冲）
   *
   * @param name 角色名
   * @returns 新角色的 system prompt 段
   * @throws MemoraError 如果角色不存在
   */
  switchPersona(name: string): string {
    // 缓冲区检查（限流保护，非错误）
    if (this.switchLocked) {
      logger.info({ persona: name }, '角色切换已锁定（30s 内超过 5 次），保持当前');
      return this.buildSystemPrompt();
    }

    const found = this.items.find((p) => p.name === name);
    if (!found) {
      throw configError('角色切换失败', `角色 "${name}" 不存在`, [
        '使用 persona.list 查看可用角色',
        '在 agent-config/personas/ 目录下创建该角色配置文件',
      ]);
    }
    if (this.activePersona?.name === name) {
      return this.buildSystemPrompt();
    }

    this.activePersona = found;
    this.recordSwitch();
    logger.info({ persona: name }, '角色已切换');
    return this.buildSystemPrompt();
  }

  /**
   * 根据用户输入自动匹配最合适的角色（关键词高置信度匹配）
   *
   * @param userInput 用户输入文本
   * @returns 匹配的角色名，无匹配返回 null
   */
  autoMatch(userInput: string): string | null {
    if (this.mode !== 'auto') return null;
    if (this.switchLocked) return null;
    if (this.items.length === 0) return null;

    const keywordBest = this.findBestKeywordMatch(userInput, KEYWORD_HIGH_CONFIDENCE_THRESHOLD);

    if (keywordBest) {
      if (this.activePersona?.name === keywordBest.item.name) return null;
      return keywordBest.item.name;
    }

    return null;
  }

  /**
   * 检查是否满足自动匹配的前置条件
   */
  canAutoMatch(): boolean {
    return this.mode === 'auto' && !this.switchLocked && this.items.length > 0;
  }

  /** 设置激活模式 */
  setMode(mode: PersonaMode): void {
    this.mode = mode;
    if (mode === 'auto' && this.switchLocked) {
      this.switchLocked = false;
      this.switchTimestamps = [];
      this.unlockAt = null;
      logger.info({ mode: this.mode }, '角色切换锁定已解除（模式切回自动）');
    }
  }

  /** 获取角色切换锁定状态 */
  getSwitchLockStatus(): { locked: boolean; unlockAt: number | null } {
    return { locked: this.switchLocked, unlockAt: this.unlockAt };
  }

  /** 获取当前激活模式 */
  get currentMode(): PersonaMode {
    return this.mode;
  }

  /**
   * 清理定时器资源（Agent.close() 时调用）
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
   * 删除角色
   *
   * 若删除的是激活角色，自动回退到列表第一个或默认角色。
   *
   * @param name 角色名
   * @returns true 删除成功；false 角色不存在
   */
  deletePersona(name: string): boolean {
    // 先检查是否为激活角色（删除前捕获，因 deleteItem 会改变 items）
    const isActive = this.activePersona?.name === name;

    const deleted = this.deleteItem(name);
    if (!deleted) return false;

    // 若删除的是激活角色，回退
    if (isActive) {
      this.activePersona = this.items[0] ?? this.createDefaultPersona();
      logger.warn(
        { deleted: name, newActive: this.activePersona.name },
        '激活角色已被删除，回退到默认',
      );
    }

    return true;
  }

  // ── 系统提示 ──────────────────────────────────────

  /**
   * 构建 system prompt 中的角色段
   *
   * @deprecated ADR-025 档 2-1 后，system prompt 注入唯一由 RolePackManager 承载。
   * 本方法仅保留为宿主 API 层返回值（switchPersona 返回的字符串），不再注入实际 prompt。
   * 未来版本将移除。
   */
  buildSystemPrompt(name?: string): string {
    const p = name ? this.items.find((item) => item.name === name) : this.activePersona;
    if (!p) return '';
    const meta = [`【当前角色】${p.name}`];
    if (p.description) meta.push(p.description);
    return `${meta.join(' · ')}\n\n${p.content}`;
  }

  // ── 基类抽象方法实现 ──────────────────────────────

  protected createEntry(entry: ScannedMarkdownEntry): Persona {
    const fm = entry.frontmatter;
    return {
      name: entry.name,
      id: fm['id'] ?? `persona:${entry.name}`,
      description: fm['description'],
      keywords: parseKeywords(fm),
      content: entry.body.trim(),
      filePath: entry.filePath,
      traits: parseTraits(fm),
    };
  }

  // ── 私有方法 ──────────────────────────────────────

  /**
   * 记录一次角色切换（时间窗口缓冲）
   */
  private recordSwitch(): void {
    const now = Date.now();
    this.switchTimestamps = this.switchTimestamps.filter(
      (t) => now - t < PersonaManager.SWITCH_WINDOW_MS,
    );
    this.switchTimestamps.push(now);

    if (this.switchTimestamps.length >= PersonaManager.MAX_SWITCHES_IN_WINDOW) {
      logger.warn({ count: this.switchTimestamps.length }, '角色切换过于频繁，锁定 2 分钟');
      this.switchLocked = true;
      this.unlockAt = now + PersonaManager.AUTO_UNLOCK_MS;
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
