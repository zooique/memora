/**
 * 角色包管理器 — 继承 ConfigResourceManager，管理角色包的生命周期
 *
 * M2 中期实现（2026-08-11）：
 *   角色包文件格式 + 角色包管理器，复用 ConfigResourceManager 基类。
 *   继承式扩展，不动基类。
 *
 * 职责：
 *   - 从 configDir/role-packs/*.md 扫描角色包文件
 *   - 解析 frontmatter（元数据 + 策略声明）
 *   - 解析 body 中的结构化章节（Persona / Rules / Skills / Knowledge）
 *   - 提供角色包激活、匹配、切换功能
 *
 * 与 PersonaManager 的关系：
 *   角色包是更上层的抽象，Persona 是角色包 L1 内容层的一部分。
 *   在 M2 阶段，角色包管理器作为可选组件，与 PersonaManager 共存。
 *   未来角色包管理器可完全替代 PersonaManager（M3 远期）。
 *
 * 设计原则：
 *   - 继承 ConfigResourceManager 基类（消除重复扫描/匹配/生命周期）
 *   - 角色包特有状态（activeRolePack / 匹配逻辑）保留在子类
 *   - 与 PersonaManager + SkillManager 兼容，不破坏现有装载通道
 */
import { logger } from '@/logging/logger.js';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import { parseKeywords } from '@/utils/scanner.js';
import type { ScannedMarkdownEntry } from '@/utils/scanner.js';
import type {
  RolePack,
  RolePackMeta,
  RolePackSkillRef,
  RolePackKnowledgeRef,
  RolePackAssembly,
  BehaviorStrategy,
} from '@/role-pack/types.js';
import { assembleRolePack } from '@/role-pack/types.js';

/**
 * 从 body 中提取 `## 标题` 章节内容
 *
 * @param body Markdown 正文
 * @param sectionName 章节标题（不含 ##）
 * @returns 章节内容，未找到返回空字符串
 */
function extractSection(body: string, sectionName: string): string {
  const regex = new RegExp(`##\\s*${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|\\n*$)`, 'i');
  const match = regex.exec(body);
  if (!match) return '';
  return match[1]?.trim() ?? '';
}

/**
 * 从章节内容中解析技能引用列表
 *
 * 格式：每一行 `- skill:技能名` 或 `- 技能名`
 *
 * @param sectionBody 技能章节内容
 * @returns 技能引用列表
 */
function parseSkillRefs(sectionBody: string): RolePackSkillRef[] {
  if (!sectionBody) return [];
  const refs: RolePackSkillRef[] = [];
  for (const line of sectionBody.split('\n')) {
    const trimmed = line.trim();
    // 支持 - skill:name 和 - name 两种格式
    const match = /^-\s*(?:skill:\s*)?(.+)$/.exec(trimmed);
    if (match) {
      refs.push({ name: match[1]?.trim() ?? '' });
    }
  }
  return refs;
}

/**
 * 从章节内容中解析知识引用列表
 *
 * 格式：每一行 `- path:路径` 或 `- memory:标识`
 *
 * @param sectionBody 知识章节内容
 * @returns 知识引用列表
 */
function parseKnowledgeRefs(sectionBody: string): RolePackKnowledgeRef[] {
  if (!sectionBody) return [];
  const refs: RolePackKnowledgeRef[] = [];
  for (const line of sectionBody.split('\n')) {
    const trimmed = line.trim();
    // 支持 - path:xxx 和 - memory:xxx 格式
    const pathMatch = /^-\s*path:\s*(.+)$/.exec(trimmed);
    if (pathMatch) {
      refs.push({ type: 'path', target: pathMatch[1]?.trim() ?? '' });
      continue;
    }
    const memoryMatch = /^-\s*memory:\s*(.+)$/.exec(trimmed);
    if (memoryMatch) {
      refs.push({ type: 'memory', target: memoryMatch[1]?.trim() ?? '' });
    }
  }
  return refs;
}

/**
 * 从规则章节内容中解析规则列表
 *
 * 格式：`- 规则内容` 或 `* 规则内容`
 *
 * @param sectionBody 规则章节内容
 * @returns 规则字符串列表
 */
function parseRules(sectionBody: string): string[] {
  if (!sectionBody) return [];
  const rules: string[] = [];
  for (const line of sectionBody.split('\n')) {
    const trimmed = line.trim();
    // 匹配无序列表项：- 或 * 开头
    const match = /^[-*]\s+(.+)$/.exec(trimmed);
    if (match) {
      rules.push(match[1]?.trim() ?? '');
    }
  }
  return rules;
}

/**
 * 从 frontmatter 中解析 strategy 字段
 *
 * frontmatter 中策略字段使用点号命名法：
 *   strategy.prepare.understandingConfirm: off
 *   strategy.act.toolCalls: block
 *   strategy.global.errorHandling: stop
 *
 * @param fm frontmatter 键值对
 * @returns 解析后的策略声明（只含声明值，未声明字段为 undefined）
 */
function parseStrategyFromFrontmatter(fm: Record<string, string>): BehaviorStrategy | undefined {
  const prepare: Record<string, unknown> = {};
  const act: Record<string, unknown> = {};
  const reflect: Record<string, unknown> = {};
  const global: Record<string, unknown> = {};

  let hasStrategy = false;

  for (const [key, rawValue] of Object.entries(fm)) {
    if (!key.startsWith('strategy.')) continue;
    hasStrategy = true;

    // 去掉 'strategy.' 前缀，如 'strategy.prepare.understandingConfirm' → 'prepare.understandingConfirm'
    const path = key.slice(9);
    const dotIdx = path.indexOf('.');
    if (dotIdx < 0) continue;

    const stage = path.slice(0, dotIdx); // prepare / act / reflect / global
    const field = path.slice(dotIdx + 1);

    // 解析数值或保留字符串
    const value: string | number | boolean = tryParseValue(rawValue);

    // 字段名驼峰转换：understanding_confirm → understandingConfirm
    const camelField = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

    // 按阶段填充
    switch (stage) {
      case 'prepare':
        prepare[camelField] = value;
        break;
      case 'act':
        act[camelField] = value;
        break;
      case 'reflect':
        reflect[camelField] = value;
        break;
      case 'global':
        global[camelField] = value;
        break;
    }
  }

  if (!hasStrategy) return undefined;

  return {
    prepare: Object.keys(prepare).length > 0 ? (prepare as PrepareStrategyShim) : undefined,
    act: Object.keys(act).length > 0 ? (act as ActStrategyShim) : undefined,
    reflect: Object.keys(reflect).length > 0 ? (reflect as ReflectStrategyShim) : undefined,
    global: Object.keys(global).length > 0 ? (global as GlobalStrategyShim) : undefined,
  };
}

// 运行时策略类型（用 Record 替代 readonly 接口，满足运行时动态赋值）
interface PrepareStrategyShim extends Record<string, unknown> {}
interface ActStrategyShim extends Record<string, unknown> {}
interface ReflectStrategyShim extends Record<string, unknown> {}
interface GlobalStrategyShim extends Record<string, unknown> {}

/**
 * 尝试解析字符串值：数字优先，布尔其次，保留字符串
 *
 * @param raw 原始字符串
 * @returns 解析后的值
 */
function tryParseValue(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  // 尝试解析数字
  const num = Number(trimmed);
  if (!Number.isNaN(num) && trimmed !== '') return num;
  // 尝试解析布尔
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  // 保留字符串
  return trimmed;
}

/**
 * 角色包管理器
 */
export class RolePackManager extends ConfigResourceManager<RolePack> {
  /** 当前激活的角色包名 */
  private activePackName: string | null = null;
  /** 当前激活模式 */
  private mode: 'auto' | 'manual' = 'auto';

  /**
   * @param configDir 配置目录（角色包文件在 <configDir>/role-packs/ 下）
   */
  constructor(configDir?: string) {
    super(configDir, 'role-packs');
  }

  // ── 生命周期 ──────────────────────────────────────

  /**
   * 启动时加载：扫描角色包目录
   *
   * @param activePack 要激活的角色包名（可选）
   * @returns 加载的角色包数量
   */
  async load(activePack?: string): Promise<number> {
    const count = await this.loadItems();
    if (activePack) {
      this.activate(activePack);
    } else if (this.items.length > 0) {
      // 默认激活第一个角色包
      this.activePackName = this.items[0]!.name;
    }
    logger.info({ count, active: this.activePackName }, '角色包加载完成');
    return count;
  }

  /**
   * 重载角色包（清空内存缓存 + 重新扫描）
   */
  async reload(): Promise<number> {
    const oldActiveName = this.activePackName;
    const count = await super.reload();

    // 保持当前激活角色包（若仍存在）
    if (oldActiveName) {
      const found = this.items.find((p) => p.meta.name === oldActiveName);
      if (found) {
        this.activePackName = found.meta.name;
      } else if (this.items.length > 0) {
        this.activePackName = this.items[0]!.meta.name;
        logger.warn(
          { oldActive: oldActiveName, newActive: this.activePackName },
          '激活角色包已被删除，回退到第一个',
        );
      } else {
        this.activePackName = null;
      }
    }

    logger.info({ count, active: this.activePackName }, '角色包已重载');
    return count;
  }

  // ── 角色包管理 ────────────────────────────────────

  /** 当前激活的角色包名 */
  get activeName(): string | null {
    return this.activePackName;
  }

  /**
   * 获取当前激活的角色包装载结果
   *
   * @returns 角色包装载结果，无激活角色包时返回 null
   */
  getActive(): RolePackAssembly | null {
    if (!this.activePackName) return null;
    const pack = this.items.find((p) => p.meta.name === this.activePackName);
    return pack ? assembleRolePack(pack) : null;
  }

  /**
   * 按名称获取角色包装载结果
   *
   * @param name 角色包名
   * @returns 角色包装载结果，不存在返回 null
   */
  get(name: string): RolePackAssembly | null {
    const pack = this.items.find((p) => p.meta.name === name);
    return pack ? assembleRolePack(pack) : null;
  }

  /**
   * 激活指定角色包
   *
   * @param name 角色包名
   * @returns 是否成功激活
   */
  activate(name: string): boolean {
    const found = this.items.find((p) => p.meta.name === name);
    if (!found) {
      logger.warn({ name }, '角色包不存在，激活失败');
      return false;
    }
    this.activePackName = name;
    logger.info({ name }, '角色包已激活');
    return true;
  }

  /**
   * 根据用户输入匹配最合适的角色包（关键词匹配）
   *
   * @param userInput 用户输入文本
   * @returns 匹配的角色包名，无匹配返回 null
   */
  autoMatch(userInput: string): string | null {
    if (this.mode !== 'auto') return null;
    if (this.items.length === 0) return null;

    const best = this.findBestKeywordMatch(userInput, 0.3);
    if (!best) return null;
    if (this.activePackName === best.item.meta.name) return null;

    return best.item.meta.name;
  }

  /** 设置激活模式 */
  setMode(mode: 'auto' | 'manual'): void {
    this.mode = mode;
  }

  /** 获取当前激活模式 */
  get currentMode(): 'auto' | 'manual' {
    return this.mode;
  }

  /**
   * 获取所有角色包摘要列表
   *
   * @returns 角色包元数据列表
   */
  listMeta(): RolePackMeta[] {
    return this.items.map((p) => p.meta);
  }

  // ── 基类抽象方法实现 ──────────────────────────────

  /**
   * 从扫描条目构建角色包对象
   *
   * 解析 frontmatter 中的元数据字段和策略字段，
   * 解析 body 中的结构化章节。
   *
   * 返回的 RolePack 同时满足 ConfigResource 约束（name/keywords/content/filePath），
   * 支持基类的关键词匹配和生命周期管理。
   *
   * @param entry 扫描器返回的原始条目
   * @returns 角色包对象
   */
  protected createEntry(entry: ScannedMarkdownEntry): RolePack {
    const fm = entry.frontmatter;
    const body = entry.body;

    // 解析元数据
    const meta: RolePackMeta = {
      name: fm['name'] ?? entry.name,
      description: fm['description'],
      version: fm['version'],
      keywords: parseKeywords(fm),
      author: fm['author'],
    };

    // 解析结构化章节
    const personaContent = extractSection(body, 'Persona');
    const rulesSection = extractSection(body, 'Rules');
    const skillsSection = extractSection(body, 'Skills');
    const knowledgeSection = extractSection(body, 'Knowledge');

    const rules = parseRules(rulesSection);
    const skills = parseSkillRefs(skillsSection);
    const knowledgeRefs = parseKnowledgeRefs(knowledgeSection);

    // 解析策略声明
    const strategy = parseStrategyFromFrontmatter(fm);

    // 内容正文：优先使用 Persona 章节，无则回退到全量正文
    const content = personaContent || body.trim();

    return {
      // ConfigResource 约束字段
      name: meta.name,
      keywords: meta.keywords ? [...meta.keywords] : [],
      content,
      filePath: entry.filePath,
      // 角色包特有字段
      meta,
      personaContent,
      rules,
      skills,
      knowledgeRefs,
      strategy,
    };
  }

  // ── 系统提示 ──────────────────────────────────────

  /**
   * 构建 system prompt 中的角色包段
   *
   * @param name 角色包名（可选，不传使用当前激活角色包）
   * @returns 角色包 prompt 正文
   */
  buildSystemPrompt(name?: string): string {
    const targetName = name ?? this.activePackName;
    if (!targetName) return '';
    const pack = this.items.find((p) => p.meta.name === targetName);
    if (!pack) return '';
    return assembleRolePack(pack).personaPrompt;
  }
}