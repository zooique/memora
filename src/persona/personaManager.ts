/**
 * 角色管理器 — 加载、切换、注入角色人格（v1.1：identities/ 目录 + SQLite 存储）
 *
 * 职责：
 *   - 从 configDir/identities/*.md 加载角色文件
 *   - 解析 frontmatter（name / keywords / description）
 *   - 写入 SQLite 索引（type: personality, permanence: always）
 *   - 将激活角色注入到 system prompt 顶部
 *   - 支持运行时切换角色 + 关键词自动匹配
 *
 * 设计原则（architecture_philosophy_rules.md §1 · v1.1 更新）：
 *   - Persona 遵循"万物皆记忆"——存入 SQLite 作为 personality 类型记忆
 *   - 召回管线做特殊处理：bootstrap 只取当前激活身份的 1 条 personality
 *   - 身份可被话题关键词动态匹配自动切换，也可手动指定
 *
 * 目录约定（L7 修正）：
 *   - 项目级：<configDir>/identities/*.md
 *   - 全局级：~/.memora/global/identities/*.md
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter } from '@/memory/frontmatter.js';
import { MemoryType } from '@/memory/types.js';
import type { MemoryIndex } from '@/memory/index.js';
import type { Memory } from '@/memory/types.js';
import { logger } from '@/logging/logger.js';

/**
 * 角色定义（从 identities/*.md frontmatter 解析）
 */
export interface Persona {
  /** 角色名（文件名去 .md） */
  name: string;
  /** 唯一 id（用于 SQLite 索引） */
  id: string;
  /** 角色描述（可选） */
  description?: string;
  /** 关键词（用于自动匹配切换） */
  keywords: string[];
  /** 人格正文（frontmatter 之后的 markdown 内容） */
  content: string;
  /** 来源路径 */
  filePath: string;
  /** 来源层（agent / project） */
  layer: 'agent' | 'project';
}

/** 角色激活模式 */
export type PersonaMode = 'auto' | 'manual';

/**
 * 角色管理器（v1.1：identities/ + SQLite + 关键词匹配）
 */
export class PersonaManager {
  /** 当前激活的角色 */
  private activePersona: Persona | null = null;
  /** 角色列表缓存（启动时扫描一次） */
  private personaList: Persona[] = [];
  /** 激活模式 */
  private mode: PersonaMode = 'auto';
  /** 身份切换时间戳列表（用于时间窗口缓冲 · L5 修正） */
  private switchTimestamps: number[] = [];
  /** 缓冲区开关（60s 内 3 次切换后锁定） */
  private switchLocked = false;
  /** 锁定恢复计时器 */
  private unlockTimer: ReturnType<typeof setTimeout> | null = null;

  /** 时间窗口：60 秒 */
  private static readonly SWITCH_WINDOW_MS = 60_000;
  /** 窗口内最大切换次数 */
  private static readonly MAX_SWITCHES_IN_WINDOW = 3;
  /** 锁定后自动恢复时间：5 分钟 */
  private static readonly AUTO_UNLOCK_MS = 300_000;

  /**
   * @param configDir 配置目录（角色文件在 <configDir>/identities/ 下）
   * @param globalDir 全局角色目录（可选，默认 ~/.memora/global/identities/）
   * @param index SQLite 索引（用于写入 personality 记忆）
   */
  constructor(
    private readonly configDir?: string,
    private readonly globalDir: string = resolve(homedir(), '.memora', 'global', 'identities'),
    private readonly index?: MemoryIndex,
  ) {}

  /**
   * 启动时加载：扫描目录 + 激活指定角色 + 写入 SQLite
   *
   * @param activePersona 要激活的角色名（可选，不传则使用第一个找到的角色）
   * @returns 激活角色的 system prompt 段
   */
  async load(activePersona?: string): Promise<string> {
    this.personaList = this.scanPersonas();

    if (this.personaList.length === 0) {
      logger.warn('未找到任何角色文件，将使用默认角色');
      this.activePersona = this.createDefaultPersona();
      await this.writePersonaToIndex(this.activePersona);
      return this.buildSystemPrompt();
    }

    logger.info(
      { count: this.personaList.length, names: this.personaList.map((p) => p.name) },
      '角色文件加载完成',
    );

    // 写入 SQLite 索引（L1 修正：persona 遵循万物皆记忆）
    await this.writeAllToIndex();

    // 激活指定角色
    if (activePersona) {
      const found = this.personaList.find((p) => p.name === activePersona);
      if (found) {
        this.activePersona = found;
      } else {
        logger.warn({ requested: activePersona }, '未找到指定角色，使用第一个');
        this.activePersona = this.personaList[0]!;
      }
    } else {
      this.activePersona = this.personaList[0]!;
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
   * 切换角色（v1.1：带时间窗口缓冲 · L5 修正）
   *
   * @param name 角色名
   * @returns 新角色的 system prompt 段，角色不存在返回当前 prompt
   */
  switchPersona(name: string): string {
    // 缓冲区检查
    if (this.switchLocked) {
      logger.info({ persona: name }, '身份切换已锁定（60s 内超过 3 次），保持当前');
      return this.buildSystemPrompt();
    }

    const found = this.personaList.find((p) => p.name === name);
    if (!found) {
      logger.warn({ requested: name }, '未找到指定角色，保持当前角色');
      return this.buildSystemPrompt();
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
   * 根据用户输入自动匹配最合适的角色（v1.1 · L4 修正）
   *
   * 匹配条件：
   *   - 当前模式为 'auto'（非手动锁定）
   *   - 缓冲区未锁定
   *   - 匹配得分 ≥ 0.5
   *   - 匹配的角色与当前角色不同
   *
   * @param userInput 用户输入文本
   * @returns 匹配的角色名，无匹配返回 null
   */
  autoMatch(userInput: string): string | null {
    if (this.mode !== 'auto') return null;
    if (this.switchLocked) return null;
    if (this.personaList.length === 0) return null;

    const matches: Array<{ name: string; score: number }> = [];
    const tokens = this.tokenize(userInput.toLowerCase());

    for (const persona of this.personaList) {
      if (persona.keywords.length === 0) continue;

      let hitCount = 0;
      for (const kw of persona.keywords) {
        const kwLower = kw.toLowerCase();
        if (tokens.some((t) => t.includes(kwLower)) || userInput.includes(kwLower)) {
          hitCount++;
        }
      }

      if (hitCount > 0) {
        const score = hitCount / Math.max(persona.keywords.length, 1);
        matches.push({ name: persona.name, score });
      }
    }

    if (matches.length === 0) return null;

    // 得分从高到低排序
    matches.sort((a, b) => b.score - a.score);
    const best = matches[0]!;

    // 阈值检查（L4 修正：≥ 0.5）
    if (best.score < 0.5) return null;

    // 与当前角色相同则不需要切换
    if (this.activePersona?.name === best.name) return null;

    return best.name;
  }

  /**
   * 设置激活模式
   *
   * @param mode 'auto'（自动匹配）| 'manual'（手动固定）
   */
  setMode(mode: PersonaMode): void {
    this.mode = mode;
    // 切回自动模式时清除锁定状态
    if (mode === 'auto' && this.switchLocked) {
      this.switchLocked = false;
      this.switchTimestamps = [];
      logger.info('身份切换锁定已解除（模式切回自动）');
    }
  }

  /** 获取当前激活模式 */
  get currentMode(): PersonaMode {
    return this.mode;
  }

  /**
   * 获取当前激活的角色
   */
  get active(): Persona | null {
    return this.activePersona;
  }

  /**
   * 获取角色列表
   */
  get list(): Persona[] {
    return this.personaList;
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
   * 记录一次身份切换（时间窗口缓冲 · L5 修正）
   */
  private recordSwitch(): void {
    const now = Date.now();
    // 清理过期记录
    this.switchTimestamps = this.switchTimestamps.filter(
      (t) => now - t < PersonaManager.SWITCH_WINDOW_MS,
    );
    this.switchTimestamps.push(now);

    if (this.switchTimestamps.length >= PersonaManager.MAX_SWITCHES_IN_WINDOW) {
      logger.warn({ count: this.switchTimestamps.length }, '身份切换过于频繁，锁定 5 分钟');
      this.switchLocked = true;
      // 5 分钟后自动解锁
      if (this.unlockTimer) clearTimeout(this.unlockTimer);
      this.unlockTimer = setTimeout(() => {
        this.switchLocked = false;
        this.switchTimestamps = [];
        logger.info('身份切换锁定已自动解除');
      }, PersonaManager.AUTO_UNLOCK_MS);
    }
  }

  /**
   * 扫描两层目录，合并角色列表
   */
  private scanPersonas(): Persona[] {
    const map = new Map<string, Persona>();

    // 1. 全局角色
    this.scanDir(this.globalDir, 'agent', map);

    // 2. 项目级角色（同名覆盖 · L7 修正：identities/ 目录）
    if (this.configDir) {
      const projectIdentitiesDir = resolve(this.configDir, 'identities');
      this.scanDir(projectIdentitiesDir, 'project', map);
    }

    return Array.from(map.values());
  }

  /**
   * 扫描单个目录下的 *.md 文件，解析角色
   */
  private scanDir(dir: string, layer: 'agent' | 'project', map: Map<string, Persona>): void {
    if (!existsSync(dir)) {
      logger.debug({ dir }, '角色目录不存在，跳过');
      return;
    }

    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      logger.warn({ dir }, '扫描角色目录失败');
      return;
    }

    for (const file of files) {
      try {
        const filePath = join(dir, file);
        const raw = readFileSync(filePath, 'utf-8');
        const { frontmatter: fm, body } = parseFrontmatter(raw);

        const name = fm['name'] ?? file.replace(/\.md$/, '');
        const id = fm['id'] ?? `personality:${name}`;
        const persona: Persona = {
          name,
          id,
          description: fm['description'],
          keywords:
            fm['keywords']
              ?.split(',')
              .map((s: string) => s.trim())
              .filter(Boolean) ?? [],
          content: body.trim(),
          filePath,
          layer,
        };

        map.set(name, persona);
      } catch (err) {
        logger.warn({ file, err }, '解析角色文件失败');
      }
    }
  }

  /**
   * 将所有角色写入 SQLite 索引（L1 修正）
   */
  private async writeAllToIndex(): Promise<void> {
    if (!this.index) return;
    for (const persona of this.personaList) {
      await this.writePersonaToIndex(persona);
    }
    logger.info({ count: this.personaList.length }, '角色记忆已写入 SQLite');
  }

  /**
   * 将单个角色写入 SQLite 索引
   */
  private async writePersonaToIndex(persona: Persona): Promise<void> {
    if (!this.index) return;
    const now = new Date().toISOString();
    const memory: Memory = {
      id: persona.id,
      type: MemoryType.PERSONALITY,
      permanence: 'always',
      name: persona.name,
      content: persona.content,
      tags: ['角色', ...persona.keywords],
      weight: 1.0,
      createdAt: now,
      updatedAt: now,
    };
    await this.index.upsert(memory);
  }

  /**
   * 简单分词（中英文混合，复用 SkillManager 逻辑）
   */
  private tokenize(input: string): string[] {
    const tokens: string[] = [];
    const chineseSegments = input.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    tokens.push(...chineseSegments);
    const englishSegments = input.match(/[a-zA-Z0-9]+/g) ?? [];
    tokens.push(...englishSegments);
    return tokens;
  }

  /**
   * 创建默认角色
   */
  private createDefaultPersona(): Persona {
    return {
      name: 'default',
      id: 'personality:default',
      description: '默认通用助手',
      keywords: [],
      content: '你是一个通用 AI 助手，以专业、友好的态度回应用户。',
      filePath: '(built-in)',
      layer: 'agent',
    };
  }
}
