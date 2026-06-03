/**
 * 角色管理器 — 加载、切换、注入角色人格
 *
 * 职责：
 *   - 从 configDir/personas/*.md 加载角色文件
 *   - 解析 frontmatter（name / domain / description / keywords / tools）
 *   - 将激活角色注入到 system prompt 顶部
 *   - 支持运行时切换角色（不影响用户画像和话题记忆）
 *
 * 设计原则（01-主架构-v4.0.md §1.3）：
 *   - Agent = 纯记忆引擎（记什么、怎么召回）
 *   - 角色 = 人格载体（怎么说、什么风格）
 *   - 两者分离。换角色不丢记忆，改记忆不影响角色
 *   - 角色文件不进入 SQLite 记忆索引——它是"配置"，不是"记忆"
 *
 * 目录约定：
 *   - 项目级：<configDir>/personas/*.md（可选，缺失时使用全局角色）
 *   - 全局级：~/.memora/global/personas/*.md（所有项目可用）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { parseFrontmatter } from '@/memory/frontmatter.js';
import { logger } from '@/logging/logger.js';

/**
 * 角色定义（从 personas/*.md frontmatter 解析）
 */
export interface Persona {
  /** 角色名（文件名去 .md） */
  name: string;
  /** 领域（可选） */
  domain?: string;
  /** 角色描述（可选） */
  description?: string;
  /** 关键词（用于角色列表选择） */
  keywords: string[];
  /** 可用工具列表（v0.2 安全维度） */
  tools: PersonaTool[];
  /** 人格正文（frontmatter 之后的 markdown 内容） */
  content: string;
  /** 来源路径 */
  filePath: string;
}

/** 角色工具条目 */
export interface PersonaTool {
  name: string;
  defaultMode: ('owner' | 'guest')[];
  allowedDomains?: string[];
  requireConfirmation?: boolean;
}

/**
 * 角色管理器
 */
export class PersonaManager {
  /** 当前激活的角色 */
  private activePersona: Persona | null = null;
  /** 角色列表缓存（启动时扫描一次） */
  private personaList: Persona[] = [];

  /**
   * @param configDir 配置目录（角色文件在 <configDir>/personas/ 下）
   * @param globalDir 全局角色目录（可选，默认 ~/.memora/global/personas/）
   */
  constructor(
    private readonly configDir?: string,
    private readonly globalDir: string = resolve(homedir(), '.memora', 'global', 'personas'),
  ) {}

  /**
   * 启动时加载：扫描目录 + 激活指定角色
   *
   * @param activePersona 要激活的角色名（可选，不传则使用第一个找到的角色）
   * @returns 激活角色的 system prompt 段
   */
  load(activePersona?: string): string {
    this.personaList = this.scanPersonas();

    if (this.personaList.length === 0) {
      logger.warn('未找到任何角色文件，将使用默认角色');
      this.activePersona = this.createDefaultPersona();
      return this.buildSystemPrompt();
    }

    logger.info(
      { count: this.personaList.length, names: this.personaList.map((p) => p.name) },
      '角色文件加载完成',
    );

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
   * 切换角色
   *
   * 换角色不丢记忆——用户画像、话题历史完全不变。
   *
   * @param name 角色名
   * @returns 新角色的 system prompt 段
   */
  switchPersona(name: string): string {
    const found = this.personaList.find((p) => p.name === name);
    if (!found) {
      logger.warn({ requested: name }, '未找到指定角色，保持当前角色');
      return this.buildSystemPrompt();
    }
    this.activePersona = found;
    logger.info({ persona: name }, '角色已切换');
    return this.buildSystemPrompt();
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
   *
   * 格式（注入到 system prompt 顶部）：
   *   【当前角色】名（描述）
   *   领域：xxx
   *   人格正文...
   */
  private buildSystemPrompt(): string {
    if (!this.activePersona) return '';
    const p = this.activePersona;
    const meta = [`【当前角色】${p.name}`];
    if (p.description) meta.push(p.description);
    if (p.domain) meta.push(`领域：${p.domain}`);

    return `${meta.join(' · ')}\n\n${p.content}`;
  }

  /**
   * 扫描两层目录，合并角色列表
   * 项目级角色覆盖全局级同名角色
   */
  private scanPersonas(): Persona[] {
    const map = new Map<string, Persona>();

    // 1. 全局角色（先加载，后加载的项目级会覆盖）
    this.scanDir(this.globalDir, map);

    // 2. 项目级角色
    if (this.configDir) {
      const projectPersonasDir = resolve(this.configDir, 'personas');
      this.scanDir(projectPersonasDir, map);
    }

    return Array.from(map.values());
  }

  /**
   * 扫描单个目录下的 *.md 文件，解析角色
   */
  private scanDir(dir: string, map: Map<string, Persona>): void {
    if (!existsSync(dir)) return;

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
        const persona: Persona = {
          name,
          domain: fm['domain'],
          description: fm['description'],
          keywords: fm['keywords']?.split(',').map((s: string) => s.trim()) ?? [],
          tools: this.parseTools(fm['tools']),
          content: body.trim(),
          filePath,
        };

        map.set(name, persona); // 同名覆盖（项目级覆盖全局级）
      } catch (err) {
        logger.warn({ file, err }, '解析角色文件失败');
      }
    }
  }

  /**
   * 解析 frontmatter 中的 tools 字段
   * 格式（YAML 字符串）：未直接支持嵌套 YAML，暂用 JSON 字符串
   */
  private parseTools(raw?: string): PersonaTool[] {
    if (!raw) return [];
    try {
      return JSON.parse(raw) as PersonaTool[];
    } catch {
      // 不是 JSON，尝试简单解析（逗号分隔的工具名列表）
      return raw.split(',').map((s) => ({ name: s.trim(), defaultMode: ['owner' as const] }));
    }
  }

  /**
   * 创建默认角色（没有任何角色文件时的兜底）
   */
  private createDefaultPersona(): Persona {
    return {
      name: 'default',
      description: '默认通用助手',
      keywords: [],
      tools: [],
      content: '你是一个通用 AI 助手，以专业、友好的态度回应用户。',
      filePath: '(built-in)',
    };
  }
}
