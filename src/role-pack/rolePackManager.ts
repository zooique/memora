/**
 * 角色包管理器 — 继承 ConfigResourceManager，管理角色包的生命周期
 *
 * M2 中期实现（2026-08-11）：
 *   角色包文件格式 + 角色包管理器，复用 ConfigResourceManager 基类。
 *   继承式扩展，不动基类。
 *
 * M2.1 行业校准（2026-08-12，对齐 role-pack-spec §二/§四/§五）：
 *   - 扫描：自建扫描路径，同时支持**单文件最小形态**（`role-packs/*.md`）
 *     与**文件夹包完整形态**（`role-packs/<名>/role-pack.md`）——基类 scanMarkdownDir
 *     只扫 `*.md` 不递归，无法覆盖文件夹包，故子类自建扫描（基类生命周期/匹配复用）。
 *   - 解析：改用嵌套 YAML frontmatter 解析器（`frontmatter.ts`，轻量子集），
 *     支持 strategy 嵌套对象 + skills 能力声明数组（capabilities）。
 *   - 兼容：旧格式点号命名法（`strategy.prepare.understandingConfirm`）warn 降级解析；
 *     旧 `## Skills` 正文 `- skill: 名字` 引用仍兼容（capabilities 优先）。
 *   - 合规：meta 解析 formatVersion / interactionType / aiIdentityDisclosure / minorProtection。
 *
 * 职责：
 *   - 从 configDir/role-packs/*.md 与 configDir/role-packs/<名>/role-pack.md 扫描角色包
 *   - 解析嵌套 frontmatter（元数据 + 策略 + 能力声明）
 *   - 解析 body 中的结构化章节（Persona / Rules / Skills / Knowledge）
 *   - 提供角色包激活、匹配、切换功能
 *
 * 与 PersonaManager 的关系：
 *   角色包是更上层的抽象，Persona 是角色包 L1 内容层的一部分。
 *   在 M2 阶段，角色包管理器作为可选组件，与 PersonaManager 共存。
 *   未来角色包管理器可完全替代 PersonaManager（M3 远期）。
 *
 * 设计原则：
 *   - 继承 ConfigResourceManager 基类（消除重复匹配/生命周期）
 *   - 角色包特有状态（activeRolePack / 匹配逻辑 / 自建扫描）保留在子类
 *   - 与 PersonaManager + SkillManager 兼容，不破坏现有装载通道
 */
import { readFile, readdir, access, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { logger } from '@/logging/logger.js';
import { getLogger } from '@/utils/loggerHolder.js';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import { resolveSubdir } from '@/utils/scanner.js';
import type { ScannedMarkdownEntry } from '@/utils/scanner.js';
import { parseRolePackFrontmatter } from '@/role-pack/frontmatter.js';
import type {
  RolePack,
  RolePackMeta,
  RolePackSkillRef,
  RolePackCapability,
  RolePackKnowledgeRef,
  RolePackAssembly,
  BehaviorStrategy,
} from '@/role-pack/types.js';
import { assembleRolePack } from '@/role-pack/types.js';
import { validateRolePack } from '@/role-pack/validator.js';

/** 排除的文件名（不纳入扫描） */
const EXCLUDED_FILES = new Set(['README.md', 'CHANGELOG.md', 'LICENSE']);

/** 合规字段默认值：formatVersion 缺省按 1.0.0（spec §五） */
const DEFAULT_FORMAT_VERSION = '1.0.0';

/**
 * L2 策略键别名映射（旧实现键 → 标准键，role-pack-spec §六 命名归标准）
 *
 * P0 键集对齐（2026-08-12）：memora 曾使用私有键名 act.toolCalls / reflect.endingHandoff，
 * 标准键为 act.toolMode / reflect.handoff。存量角色包若仍写旧键，
 * 装载时自动映射到标准键 + warn 提示（平滑迁移，不阻塞装载）。
 * 映射在嵌套新格式与点号旧格式两条解析路径出口统一执行。
 */
const STRATEGY_KEY_ALIASES: Readonly<Record<string, string>> = {
  'act.toolCalls': 'act.toolMode',
  'reflect.endingHandoff': 'reflect.handoff',
};

/**
 * 策略阶段键名规范化：旧实现键 → 标准键（spec §六 命名归标准）
 *
 * 未知键保留原样（键级渐进：已知生效、未知 warn 忽略由调用方/校验器处理）。
 *
 * @param stage 策略阶段（prepare / act / reflect / global）
 * @param fields 该阶段的键值对（解析自嵌套或点号 frontmatter）
 * @returns 规范化后的键值对
 */
function normalizeStageKeys(stage: string, fields: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const legacyPath = `${stage}.${key}`;
    const standardKey = STRATEGY_KEY_ALIASES[legacyPath];
    if (standardKey) {
      getLogger().warn(
        { legacyKey: key, standardKey: standardKey.slice(stage.length + 1) },
        `策略键 ${legacyPath} 为旧实现命名，已自动迁移到标准键 ${standardKey}（role-pack-spec §六 命名归标准）`,
      );
      normalized[standardKey.slice(stage.length + 1)] = value;
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

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
 *   strategy.act.toolMode: block
 *   strategy.global.errorHandling: stop
 *
 * @param fm frontmatter 键值对
 * @returns 解析后的策略声明（只含声明值，未声明字段为 undefined）
 */
// 运行时策略类型（用 Record 替代 readonly 接口，满足运行时动态赋值）
interface PrepareStrategyShim extends Record<string, unknown> {}
interface ActStrategyShim extends Record<string, unknown> {}
interface ReflectStrategyShim extends Record<string, unknown> {}
interface GlobalStrategyShim extends Record<string, unknown> {}

/**
 * 从嵌套 frontmatter 解析 strategy（新格式，优先）
 *
 * 结构：`strategy: { prepare: { contextAssembly: hybrid, ... }, act: {...}, ... }`
 * 只取四阶段下声明过的键，未声明的阶段为 undefined（由 mergeStrategy 补默认值）。
 *
 * @param strategyNode frontmatter.strategy 节点
 * @returns 解析后的策略声明，无 strategy 返回 undefined
 */
function parseStrategyNested(strategyNode: unknown): BehaviorStrategy | undefined {
  if (typeof strategyNode !== 'object' || strategyNode === null) return undefined;

  const stages: Record<string, Record<string, unknown>> = {};
  for (const [stage, node] of Object.entries(strategyNode as Record<string, unknown>)) {
    if (typeof node !== 'object' || node === null) continue;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      // 未知键保留原样（键级渐进：已知生效、未知 warn 忽略由调用方处理）
      fields[key] = value;
    }
    // 旧实现键 → 标准键 别名迁移（spec §六 命名归标准）
    if (Object.keys(fields).length > 0) stages[stage] = normalizeStageKeys(stage, fields);
  }

  if (Object.keys(stages).length === 0) return undefined;

  return {
    prepare: stages['prepare'] as PrepareStrategyShim | undefined,
    act: stages['act'] as ActStrategyShim | undefined,
    reflect: stages['reflect'] as ReflectStrategyShim | undefined,
    global: stages['global'] as GlobalStrategyShim | undefined,
  };
}

/**
 * 从点号 frontmatter 解析 strategy（旧格式，兼容降级）
 *
 * 旧格式：`strategy.prepare.understandingConfirm: off`（点号平铺 + snake/camel 混合）。
 * M2.1 行业校准：新格式定案嵌套 YAML（camelCase），旧格式保留解析能力但 **warn 提示迁移**。
 *
 * @param fm frontmatter 键值对
 * @returns 解析后的策略声明（只含声明值，未声明字段为 undefined）
 */
function parseStrategyLegacy(fm: Record<string, string>): BehaviorStrategy | undefined {
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
    prepare: Object.keys(prepare).length > 0 ? (normalizeStageKeys('prepare', prepare) as PrepareStrategyShim) : undefined,
    act: Object.keys(act).length > 0 ? (normalizeStageKeys('act', act) as ActStrategyShim) : undefined,
    reflect: Object.keys(reflect).length > 0 ? (normalizeStageKeys('reflect', reflect) as ReflectStrategyShim) : undefined,
    global: Object.keys(global).length > 0 ? (normalizeStageKeys('global', global) as GlobalStrategyShim) : undefined,
  };
}

/**
 * 从 frontmatter 解析 skills 能力声明数组（新格式，优先）
 *
 * 结构：`skills: [{ capability: 'file:write', description: '...' }, ...]`
 * 兼容旧 `## Skills` 正文引用（`- skill: 名字`），由 createEntry 兜底。
 *
 * @param skillsNode frontmatter.skills 节点
 * @returns 能力声明列表
 */
function parseCapabilities(skillsNode: unknown): RolePackCapability[] {
  if (!Array.isArray(skillsNode)) return [];
  const caps: RolePackCapability[] = [];
  for (const item of skillsNode) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const capability = record['capability'];
    if (typeof capability !== 'string' || capability === '') continue;
    const description = record['description'];
    caps.push({
      capability,
      description: typeof description === 'string' ? description : undefined,
    });
  }
  return caps;
}

/**
 * 从嵌套 frontmatter 解析 keywords（兼容数组与逗号字符串两种写法）
 *
 * 新格式：`keywords: [写作, 小说]`（数组）；旧格式：`keywords: 写作, 小说`（逗号串）。
 *
 * @param fm 嵌套 frontmatter
 * @returns 关键词数组
 */
function parseKeywordsAny(fm: Record<string, unknown>): string[] | undefined {
  const raw = fm['keywords'];
  if (Array.isArray(raw)) {
    return raw.map((k) => String(k)).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return undefined;
}

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
   * 启动时加载：自建扫描角色包目录
   *
   * 覆盖基类 loadItems()：基类扫描（scanMarkdownDir）只支持单文件 *.md 且用扁平
   * frontmatter，无法覆盖文件夹包形态（role-packs/<名>/role-pack.md）与嵌套 YAML。
   * 生命周期（runtime 记账 / deleteItem / 匹配）仍复用基类。
   *
   * @param activePack 要激活的角色包名（可选）
   * @returns 加载的角色包数量
   */
  async load(activePack?: string): Promise<number> {
    const count = await this.scanRolePacks();
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
   * 重载角色包（重新扫描 + 保持激活态）
   *
   * 覆盖基类 reload()：同 load() 原因，基类扫描无法覆盖文件夹包形态。
   * 角色包无运行时注入（无 register 通道），故不涉及基类 runtime 记账保留逻辑。
   */
  async reload(): Promise<number> {
    const oldActiveName = this.activePackName;
    const count = await this.scanRolePacks();

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

  /**
   * 扫描角色包目录（单文件最小形态 + 文件夹包完整形态）
   *
   * 双形态（role-pack-spec §二）：
   *   - `role-packs/*.md` → 单文件最小形态（无资源零依赖装载 L1）
   *   - `role-packs/<名>/role-pack.md` → 文件夹包完整形态（skills/ references/ 等）
   * 命名：frontmatter.name 优先，其次文件夹名 / 文件名去 .md。
   */
  private async scanRolePacks(): Promise<number> {
    const dir = resolveSubdir(this.configDir, this.subdir);
    if (!dir) {
      this.items = [];
      return 0;
    }
    this.items = await this.buildFromDir(dir);
    return this.items.length;
  }

  /**
   * 从角色包目录构建条目列表
   *
   * @param dir 角色包目录（<configDir>/role-packs/）
   * @returns 角色包对象列表
   */
  private async buildFromDir(dir: string): Promise<RolePack[]> {
    let entries: string[];
    try {
      await access(dir);
      entries = (await readdir(dir)).filter(
        (f) => !f.startsWith('.') && !f.startsWith('_'),
      );
    } catch {
      getLogger().debug({ dir }, '角色包目录不存在，跳过');
      return [];
    }

    const map = new Map<string, RolePack>();
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const st = await stat(fullPath);
        if (st.isDirectory()) {
          // 文件夹包：找 role-pack.md
          const packFile = join(fullPath, 'role-pack.md');
          try {
            await access(packFile);
            const pack = await this.parsePackFile(packFile, entry, 'folder');
            if (pack) map.set(pack.name, pack);
          } catch {
            // 文件夹无 role-pack.md：不是角色包，跳过
          }
        } else if (entry.endsWith('.md') && !EXCLUDED_FILES.has(entry)) {
          // 单文件最小形态
          const pack = await this.parsePackFile(fullPath, basename(entry, '.md'), 'single-file');
          if (pack) map.set(pack.name, pack);
        }
      } catch (err) {
        getLogger().warn({ entry, err }, '扫描角色包失败');
      }
    }
    return Array.from(map.values());
  }

  /**
   * 解析单个角色包文件（嵌套 frontmatter + 章节）
   *
   * @param filePath role-pack.md 或 <名>.md 的绝对路径
   * @param fallbackName 无 frontmatter.name 时的兜底名（文件夹名 / 文件名去 .md）
   * @returns 角色包对象，解析失败返回 null
   */
  private async parsePackFile(
    filePath: string,
    fallbackName: string,
    form: 'single-file' | 'folder' = 'single-file',
  ): Promise<RolePack | null> {
    try {
      const raw = await readFile(filePath, 'utf-8');
      const { frontmatter: fm, body } = parseRolePackFrontmatter(raw);

      // A-2（role-pack-spec §八）：接入格式校验器——校验失败记录 warning，不阻塞装载
      // 角色包当前处"草案演进期"，打断坏包会破坏现有装载；以 warn 暴露问题待修，
      // 待标准 v1 冻结后再收紧为"拒绝加载"。
      const validation = validateRolePack({ frontmatter: fm, body, form });
      if (!validation.valid) {
        const errors = validation.issues.filter((i) => i.severity === 'error');
        getLogger().warn(
          { file: filePath, errors: errors.map((e) => e.message) },
          '角色包校验未通过（警告级，暂不拒绝装载）',
        );
      }

      // 解析元数据（嵌套 frontmatter：值可能为 string/number/boolean）
      const str = (v: unknown): string | undefined =>
        typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v);
      const meta: RolePackMeta = {
        name: str(fm['name']) ?? fallbackName,
        description: str(fm['description']),
        version: str(fm['version']),
        keywords: parseKeywordsAny(fm),
        author: str(fm['author']),
        formatVersion: str(fm['formatVersion']) ?? DEFAULT_FORMAT_VERSION,
        interactionType: fm['interactionType'] === 'companion' ? 'companion' : 'tool_assistant',
        aiIdentityDisclosure: fm['aiIdentityDisclosure'] === false ? false : true,
        minorProtection: fm['minorProtection'] === undefined ? 'required' : 'required',
      };

      // 解析结构化章节（L1 内容层）
      const personaContent = extractSection(body, 'Persona');
      const rulesSection = extractSection(body, 'Rules');
      const skillsSection = extractSection(body, 'Skills');
      const knowledgeSection = extractSection(body, 'Knowledge');

      const rules = parseRules(rulesSection);
      const skills = parseSkillRefs(skillsSection);
      const knowledgeRefs = parseKnowledgeRefs(knowledgeSection);
      // 能力声明：frontmatter.skills 数组优先（新格式），旧 ## Skills 正文引用兜底
      const capabilities = parseCapabilities(fm['skills']);

      // 策略：嵌套 frontmatter 优先（新格式），点号平铺兼容降级（旧格式 warn）
      const strategy = parseStrategyNested(fm['strategy']) ?? (() => {
        const legacy = parseStrategyLegacy(fm as unknown as Record<string, string>);
        if (legacy) {
          getLogger().warn(
            { file: filePath },
            '角色包使用旧格式点号策略声明，建议迁移为嵌套 YAML（role-pack-spec §二）',
          );
        }
        return legacy;
      })();

      // 内容正文：优先使用 Persona 章节，无则回退到全量正文
      const content = personaContent || body.trim();

      return {
        // ConfigResource 约束字段
        name: meta.name,
        keywords: meta.keywords ? [...meta.keywords] : [],
        content,
        filePath,
        // 角色包特有字段
        meta,
        personaContent,
        rules,
        skills,
        capabilities,
        knowledgeRefs,
        strategy,
      };
    } catch (err) {
      getLogger().warn({ filePath, err }, '解析角色包失败');
      return null;
    }
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
   * 获取当前激活角色包的规则列表（Rule→guardrail 桥接用）
   *
   * 角色包规则是自然语言指令（如"不得擅自增删原文内容"），
   * 与 guardrail 系统的 regex 规则格式不同，但纳入同一规则池后
   * 未来可扩展自然语言规则匹配机制。
   *
   * @returns 规则字符串列表，无激活角色包时返回空数组
   */
  getActiveRules(): readonly string[] {
    if (!this.activePackName) return [];
    const pack = this.items.find((p) => p.meta.name === this.activePackName);
    return pack?.rules ?? [];
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
   * 基类抽象方法实现（M2.1 起不再被调用）
   *
   * RolePackManager 覆写了 load()/reload() 使用自建扫描路径（parsePackFile），
   * 基类 scanAndBuild() 依赖的 loadItems()/reload() 均被覆写，此方法不可达。
   * 保留实现以满足抽象约束；若被（未来新增的）基类路径意外调用，显式报错而非静默错误。
   */
  protected createEntry(_entry: ScannedMarkdownEntry): RolePack {
    throw new Error(
      'RolePackManager 使用自建扫描路径（load/reload → parsePackFile），createEntry 不应被调用',
    );
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