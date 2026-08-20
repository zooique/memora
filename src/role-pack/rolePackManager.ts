/**
 * 角色包管理器：继承 ConfigResourceManager 复用关键词匹配/生命周期；
 * 角色包特有状态（activeRolePack / 粘性匹配 / 自建扫描 / 切换防抖）保留在子类。
 * manifest.json 为唯一核心控制文件，内容文件独立按路径注册装载。
 */
import { readFile, readdir, access, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { logger } from '@/logging/logger.js';
import { getLogger } from '@/utils/loggerHolder.js';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import { resolveSubdir, scanMarkdownDir, discoverLayer3, resolveSafePath, type ScannedMarkdownEntry } from '@/utils/scanner.js';
import { parseFrontmatter } from '@/utils/frontmatter.js';
import { validateManifest, checkCompanionContentRedline } from '@/role-pack/validator.js';
import { SkillManager } from '@/skill/skillManager.js';
import type {
  RolePack,
  RolePackMeta,
  RolePackManifestSkill,
  RolePackCapability,
  RolePackAssembly,
  BehaviorStrategy,
} from '@/role-pack/types.js';
import { assembleRolePack } from '@/role-pack/types.js';

/** L1 阈值保护：技能数超过此值时压缩 L1 描述为 20 字摘要 */
const L1_COMPRESSED_THRESHOLD = 30;
/** L1 阈值保护：技能数超过此值时切换为 list_skills 工具动态查询 */
const L1_LIST_TOOL_THRESHOLD = 50;

/** formatVersion 缺省值（未声明时按 1.0.0） */
const DEFAULT_FORMAT_VERSION = '1.0.0';

/** 角色包自动匹配关键词置信度阈值（scoredByKeywords） */
const AUTO_MATCH_THRESHOLD = 0.3;

/** 角色包扫描需排除的非包文件（如 README 等允许放在包根） */
const EXCLUDED_FILES = new Set(['manifest.json']);

/** 规则文件约定名：manifest 未声明 rules 路径时回退 rules.md（消除路径写错静默丢规则） */
const DEFAULT_RULES_FILENAME = 'rules.md';

/** persona 约定文件名：manifest 未声明 persona 路径时回退 persona.md（与 rules.md 对称） */
const DEFAULT_PERSONA_FILENAME = 'persona.md';

/** 从 manifest.strategy 解析策略声明（只取四阶段下声明过的键，未声明阶段由 mergeStrategy 补默认值，无 strategy 返回 undefined） */
function parseStrategyNode(strategyNode: unknown): BehaviorStrategy | undefined {
  if (typeof strategyNode !== 'object' || strategyNode === null) return undefined;

  const stages: Record<string, Record<string, unknown>> = {};
  for (const [stage, node] of Object.entries(strategyNode as Record<string, unknown>)) {
    if (typeof node !== 'object' || node === null) continue;
    stages[stage] = { ...(node as Record<string, unknown>) };
  }

  if (Object.keys(stages).length === 0) return undefined;

  return {
    prepare: stages['prepare'],
    act: stages['act'],
    reflect: stages['reflect'],
    global: stages['global'],
  } as BehaviorStrategy;
}

/**
 * 解析 keywords（数组/逗号串）并合并 trigger 去重（匹配词单一真理源）。
 * 角色包 trigger 为字符串数组（精确/包含匹配）而非正则——正则仅 Skill 系统存在。
 */
function parseKeywordsAny(manifest: Record<string, unknown>): string[] | undefined {
  const parseField = (key: string): string[] | undefined => {
    const raw = manifest[key];
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
  };
  return [...new Set([...(parseField('keywords') ?? []), ...(parseField('trigger') ?? [])])];
}

/** 从 persona.md frontmatter 解析 traits.* 数值键值对（clamp 0-1），无 traits 返回 undefined */
function parseTraits(personaContent: string): Record<string, number> | undefined {
  if (!personaContent) return undefined;
  const { frontmatter } = parseFrontmatter(personaContent);
  const traits: Record<string, number> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!key.startsWith('traits.')) continue;
    const traitName = key.slice(7);
    const numVal = Number(value);
    if (!Number.isNaN(numVal)) {
      traits[traitName] = Math.max(0, Math.min(1, numVal)); // clamp 0-1
    }
  }
  return Object.keys(traits).length > 0 ? traits : undefined;
}

/** 解析互斥声明 exclusiveWith（支持数组与逗号串），未声明返回 undefined */
function parseExclusiveWith(raw: unknown): string[] | undefined {
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

/** 解析接手衔接提示词（宿主带入对话时预填的话术）；非空字符串，否则 undefined。角色包只描述自己（§11 插卡解耦）。 */
function parseHandoffPrompt(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw.trim();
}

/**
 * 扫描 skills/ 目录动态注册技能（C3）：复用 scanMarkdownDir，frontmatter 的 name/description+正文。
 * manifest.skills 仅作可选白名单过滤（声明 file 路径时），未声明则全量扫描（零配置）。
 */
async function scanPackSkills(
  packDir: string,
  skillsNode: unknown,
): Promise<RolePackManifestSkill[]> {
  const scanned = await scanMarkdownDir(join(packDir, 'skills'));
  // 用 entry.filePath 计算相对路径（支持单文件 .md 和文件夹 SKILL.md 两种形式）
  const skills = scanned.map(async (entry) => {
    // 从绝对路径计算相对于 packDir 的路径，统一用正斜杠
    const absPath = entry.filePath;
    let relPath = absPath.slice(packDir.length);
    if (relPath.startsWith('/') || relPath.startsWith('\\')) relPath = relPath.slice(1);
    relPath = relPath.replace(/\\/g, '/');

    // L3 发现：扫描技能目录下的 resources/ 和 scripts/
    // 技能目录：SKILL.md 在文件夹内 → 文件夹根；单文件 .md → 文件所在目录
    const skillDir = dirname(absPath);
    const l3 = await discoverLayer3(skillDir);
    const hasL3 = l3.resources.length > 0 || l3.scripts.length > 0;

    return {
      file: relPath,
      name: entry.name,
      description: entry.frontmatter['description'] ?? undefined,
      layer3: hasL3 ? {
        resources: l3.resources.map((r) => ({ path: r.path, size: r.size })),
        scripts: l3.scripts.map((s) => ({ path: s.path, runtime: s.runtime, size: s.size })),
      } : undefined,
    };
  });
  const resolved = await Promise.all(skills);

  // 区分「未声明 skills」（全量扫描）与「skills: []」（零技能）
  if (!Array.isArray(skillsNode)) return resolved;
  if ((skillsNode as unknown[]).length === 0) return [];

  // manifest.skills 声明了 name/description 时覆盖 frontmatter 原值
  // 构建 manifest 配置映射，按 file 路径关联
  const manifestSkillConfigs = new Map<string, Record<string, unknown>>();
  for (const item of skillsNode) {
    if (typeof item !== 'object' || item === null) continue;
    const config = item as Record<string, unknown>;
    const file = config['file'];
    if (typeof file === 'string' && file.trim() !== '') {
      // 路径穿越防护：file 拼接 + resolve 规范化，确保结果仍在 packDir 内
      const resolvedPath = resolve(packDir, file);
      if (!resolvedPath.startsWith(resolve(packDir))) {
        logger.warn({ file, packDir }, 'manifest.skills.file 路径穿越被阻止，已忽略');
        continue;
      }
      manifestSkillConfigs.set(file, config);
    }
  }

  // 白名单过滤 + manifest 元数据覆盖
  const allowedFiles = new Set(manifestSkillConfigs.keys());
  return resolved
    .filter((s) => s.file && allowedFiles.has(s.file))
    .map((entry) => {
      const config = manifestSkillConfigs.get(entry.file!);
      if (!config) return entry;
      // manifest 声明的 name/description 覆盖 frontmatter 值；未声明则保留原值
      return {
        ...entry,
        name: (typeof config['name'] === 'string' && config['name']!.trim() !== '')
          ? config['name']!
          : entry.name,
        description: (typeof config['description'] === 'string' && config['description']!.trim() !== '')
          ? config['description']!
          : entry.description,
      };
    });
}

/** 从 manifest.capabilities 解析能力声明（C2：能力面与技能内容分离，经 capabilityMap 映射为工具白名单） */
function parseManifestCapabilities(capabilitiesNode: unknown): RolePackCapability[] {
  if (!Array.isArray(capabilitiesNode)) return [];
  const capabilities: RolePackCapability[] = [];
  for (const item of capabilitiesNode) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const capability = record['capability'];
    if (typeof capability !== 'string' || capability.trim() === '') continue;
    const description = record['description'];
    capabilities.push({
      capability,
      description: typeof description === 'string' ? description : undefined,
    });
  }
  return capabilities;
}

/** 解析 rules 内容：支持无序（- / *）与有序（n. ）Markdown 列表，返回规则字符串列表 */
function parseRules(content: string): string[] {
  if (!content) return [];
  const rules: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // 优先匹配无序列表（- 或 *），再匹配有序列表（数字.）
    const match = /^[-*]\s+(.+)$/.exec(trimmed) || /^\d+\.\s+(.+)$/.exec(trimmed);
    if (match) {
      const rule = match[1]?.trim() ?? '';
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

/** 安全读取内容文件，失败按缺省返回空串（内容文件可选） */
async function readContentSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    getLogger().warn({ file: filePath }, '角色包内容文件读取失败，按缺省处理');
    return '';
  }
}

/**
 * 角色包管理器
 */
export class RolePackManager extends ConfigResourceManager<RolePack> {
  /** 当前激活的角色包名 */
  private activePackName: string | null = null;
  /**
   * 粘性锁定：会话内首次 autoMatch 命中置 true，后续外部输入不再全量重匹配，
   * 仅当命中与当前激活包互斥（exclusiveWith）的包时才切换；resetSticky 复位，不跨会话。
   */
  private stickyLocked = false;
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
   * @param configDir 配置目录（角色包在 <configDir>/role-packs/ 下）
   */
  constructor(configDir?: string) {
    super(configDir, 'role-packs');
  }

  // ── 生命周期 ──────────────────────────────────────

  /** 启动加载：扫描含 manifest.json 的角色包文件夹（覆盖基类 loadItems——基类只支持单文件扫描，生命周期其余仍复用基类） */
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

  /** 重载角色包：重新扫描 + 保持激活态（覆盖基类 reload，基类扫描无法覆盖文件夹包形态） */
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

  /** 扫描角色包目录：每个子目录为一个角色包，须含 manifest.json；manifest.name 优先于文件夹名 */
  private async scanRolePacks(): Promise<number> {
    const dir = resolveSubdir(this.configDir, this.subdir);
    if (!dir) {
      this.items = [];
      return 0;
    }
    this.items = await this.buildFromDir(dir);
    this.checkExclusiveSymmetry(this.items);
    return this.items.length;
  }

  /**
   * 集合级互斥声明对称性检查：互斥是双向关系（A 声明排除 B，B 应反向声明 A）。
   * 非对称不会导致运行时错误（isExclusiveBetween 单边命中即互斥），但削弱粘性切换确定性，故 warning 提示补全。
   */
  private checkExclusiveSymmetry(packs: readonly RolePack[]): void {
    const byName = new Map(packs.map((p) => [p.meta.name, p.meta.exclusiveWith ?? []]));
    for (const pack of packs) {
      const target = pack.meta.exclusiveWith;
      if (!target || target.length === 0) continue;
      for (const name of target) {
        const peer = byName.get(name);
        if (!peer) {
          getLogger().warn(
            { pack: pack.meta.name, target: name },
            '角色包互斥声明指向不存在的角色包（悬空引用，role-pack-spec §13）',
          );
        } else if (!peer.includes(pack.meta.name)) {
          getLogger().warn(
            { pack: pack.meta.name, target: name },
            '角色包互斥声明非对称：目标未反向声明本包（role-pack-spec §13），建议补全',
          );
        }
      }
    }
  }

  /** 从角色包目录构建条目列表（仅文件夹形态） */
  private async buildFromDir(dir: string): Promise<RolePack[]> {
    let entries: string[];
    try {
      await access(dir);
      // 按字典序排序，保证扫描顺序确定性（避免文件系统依赖）
      entries = (await readdir(dir)).filter(
        (f) => !f.startsWith('.') && !f.startsWith('_') && !EXCLUDED_FILES.has(f),
      ).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    } catch {
      getLogger().debug({ dir }, '角色包目录不存在，跳过');
      return [];
    }

    const map = new Map<string, RolePack>();
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const st = await stat(fullPath);
        if (!st.isDirectory()) continue; // 仅文件夹形态
        const pack = await this.parseManifestPack(fullPath, entry);
        if (pack) map.set(pack.name, pack);
      } catch (err) {
        getLogger().warn({ entry, err }, '扫描角色包失败');
      }
    }
    return Array.from(map.values());
  }

  /** 解析单个角色包（manifest.json + 独立内容文件），失败返回 null */
  private async parseManifestPack(
    packDir: string,
    fallbackName: string,
  ): Promise<RolePack | null> {
    const manifestPath = join(packDir, 'manifest.json');

    // 读取并解析 manifest.json
    let manifest: Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      getLogger().warn({ manifestPath, err }, 'manifest.json 读取或解析失败，跳过该角色包');
      return null;
    }

    // 接入格式校验器——校验失败记录 warning，不阻塞装载（草案演进期宽松容错）
    const validation = validateManifest(manifest);
    if (!validation.valid) {
      const errors = validation.issues.filter((i) => i.severity === 'error');
      getLogger().warn(
        { file: manifestPath, errors: errors.map((e) => e.message) },
        '角色包校验未通过（警告级，暂不拒绝装载）',
      );
    }

    // 解析元数据（manifest 唯一权威）
    const str = (v: unknown): string | undefined =>
      typeof v === 'string' ? v : v === undefined || v === null ? undefined : String(v);
    const meta: RolePackMeta = {
      name: str(manifest['name']) ?? fallbackName,
      displayName: str(manifest['displayName']),
      description: str(manifest['description']),
      version: str(manifest['version']),
      keywords: parseKeywordsAny(manifest),
      author: str(manifest['author']),
      formatVersion: str(manifest['formatVersion']) ?? DEFAULT_FORMAT_VERSION,
      interactionType: manifest['interactionType'] === 'companion' ? 'companion' : 'tool_assistant',
      aiIdentityDisclosure: manifest['aiIdentityDisclosure'] === false ? false : true,
      minorProtection: 'required',
      exclusiveWith: parseExclusiveWith(manifest['exclusiveWith']),
      // 接手衔接提示词（自洽声明，宿主 prefill；空白视为未声明）
      handoffPrompt: parseHandoffPrompt(manifest['handoffPrompt']),
    };

    // 解析 L2 策略
    const strategy = parseStrategyNode(manifest['strategy']);

    // 内容路径注册：manifest 声明路径时尊重（向后兼容），未声明/空串时回退约定名 persona.md
    const declaredPersonaPath =
      typeof manifest['persona'] === 'string' && manifest['persona'].trim() !== ''
        ? manifest['persona']
        : null;
    const personaPath = declaredPersonaPath ?? DEFAULT_PERSONA_FILENAME;
    // rules 未声明/空串时回退约定名 rules.md（消除路径写错静默丢规则）
    const declaredRulesPath =
      typeof manifest['rules'] === 'string' && manifest['rules'].trim() !== ''
        ? manifest['rules']
        : null;
    const rulesPath = declaredRulesPath ?? DEFAULT_RULES_FILENAME;

    // persona 需解析 frontmatter 提取 traits，正文仅取 body 部分
    const rawPersonaContent = personaPath ? await readContentSafe(join(packDir, personaPath)) : '';
    const { body: personaBody } = parseFrontmatter(rawPersonaContent);
    const personaContent = personaBody;
    const traits = parseTraits(rawPersonaContent);
    const rulesContent = rulesPath ? await readContentSafe(join(packDir, rulesPath)) : '';
    const rules = parseRules(rulesContent);

    // 内嵌技能：目录动态扫描 + frontmatter（C3，manifest.skills 可选过滤；新增技能只写文件）
    const skills = await scanPackSkills(packDir, manifest['skills']);

    // 装载时预缓存技能正文（与全局技能一致，消除 readSkillContent 磁盘 IO）
    const skillsWithContent = await Promise.all(
      skills.map(async (skill) => {
        if (!skill.file) return { ...skill, content: null };
        const skillAbsPath = join(packDir, skill.file);
        try {
          const content = await readContentSafe(skillAbsPath);
          return { ...skill, content };
        } catch {
          return { ...skill, content: null };
        }
      }),
    );

    // 能力声明（顶层数组，C2：能力面与技能内容分离）
    const capabilities = parseManifestCapabilities(manifest['capabilities']);

    // companion 内容红线：正文在独立内容文件，由装载方读取后检测
    if (meta.interactionType === 'companion') {
      const redline = checkCompanionContentRedline(personaContent + rulesContent);
      if (redline.length > 0) {
        getLogger().error(
          { file: manifestPath, errors: redline.map((i) => i.message) },
          'companion 角色包触发内容红线，拒绝装载',
        );
        return null;
      }
    }

    // 内容正文：persona（无 persona 时为空串）
    const content = personaContent;

    // 预计算装配结果并缓存（角色包装载后不可变，缓存安全）
    const pack: RolePack = {
      // ConfigResource 约束字段
      name: meta.name,
      keywords: meta.keywords ? [...meta.keywords] : [],
      content,
      filePath: manifestPath,
      // 角色包特有字段
      meta,
      personaContent,
      traits,
      rules,
      skills: skillsWithContent,
      capabilities,
      strategy,
    };
    // 预计算装配结果（mergeStrategy + personaPrompt 构建）
    const cachedAssembly = assembleRolePack(pack);
    return { ...pack, _cachedAssembly: cachedAssembly };
  }

  // ── 角色包管理 ────────────────────────────────────

  /** 当前激活的角色包名 */
  get activeName(): string | null {
    return this.activePackName;
  }

  /** 返回 parseManifestPack 时预缓存的 Assembly，避免重复 mergeStrategy + personaPrompt 构建；无激活返回 null */
  getActive(): RolePackAssembly | null {
    if (!this.activePackName) return null;
    const pack = this.items.find((p) => p.meta.name === this.activePackName);
    return pack?._cachedAssembly ?? null;
  }

  /** 当前激活角色包的规则列表（设定记忆归角色包后，规则以角色包为准）；无激活返回空数组 */
  getActiveRules(): readonly string[] {
    if (!this.activePackName) return [];
    const pack = this.items.find((p) => p.meta.name === this.activePackName);
    return pack?.rules ?? [];
  }

  /** 按名称获取预缓存的装配结果，不存在返回 null */
  get(name: string): RolePackAssembly | null {
    const pack = this.items.find((p) => p.meta.name === name);
    return pack?._cachedAssembly ?? null;
  }

  /** 激活指定角色包（30s 内超 5 次切换后锁定 2 分钟防抖，避免状态抖动）；锁定或不存在返回 false */
  activate(name: string): boolean {
    // 缓冲区检查（限流保护，非错误）
    if (this.switchLocked) {
      logger.info({ name }, '角色包切换已锁定（30s 内超过 5 次），保持当前');
      return false;
    }

    const found = this.items.find((p) => p.meta.name === name);
    if (!found) {
      logger.warn({ name }, '角色包不存在，激活失败');
      return false;
    }

    // 记录切换时间戳并判定是否达到锁定阈值
    const now = Date.now();
    this.switchTimestamps.push(now);
    const windowStart = now - RolePackManager.SWITCH_WINDOW_MS;
    this.switchTimestamps = this.switchTimestamps.filter((t) => t > windowStart);

    if (this.switchTimestamps.length >= RolePackManager.MAX_SWITCHES_IN_WINDOW) {
      this.switchLocked = true;
      this.unlockAt = now + RolePackManager.AUTO_UNLOCK_MS;
      this.unlockTimer = setTimeout(() => {
        this.switchLocked = false;
        this.unlockAt = null;
        this.unlockTimer = null;
        this.switchTimestamps = [];
        logger.info('角色包切换锁已自动恢复');
      }, RolePackManager.AUTO_UNLOCK_MS);
      logger.warn('角色包切换过于频繁，已锁定 2 分钟');
    }

    this.activePackName = name;
    logger.info({ name }, '角色包已激活');
    return true;
  }

  /** 角色切换锁定状态；unlockAt 为自动恢复时间戳（ms epoch），未锁定 null */
  getSwitchLockStatus(): { locked: boolean; unlockAt: number | null } {
    return { locked: this.switchLocked, unlockAt: this.unlockAt };
  }

  /** 当前激活角色包的 traits，无则 undefined */
  getActiveTraits(): Record<string, number> | undefined {
    if (!this.activePackName) return undefined;
    const pack = this.items.find((p) => p.meta.name === this.activePackName);
    return pack?.traits;
  }

  /**
   * 输入粘性匹配角色包：首次外部输入全量匹配命中即锁定当前会话；
   * 已锁定后仅当命中与当前激活包互斥（exclusiveWith）时才切换；显式切换走 activate()。
   */
  autoMatch(userInput: string): string | null {
    if (this.items.length === 0) return null;

    const best = this.findBestKeywordMatch(userInput, AUTO_MATCH_THRESHOLD);
    if (!best) return null;
    const matchedName = best.item.meta.name;

    // 首次匹配：命中即锁定当前会话（即使命中当前激活包，也标记已锁定）
    if (!this.stickyLocked) {
      this.stickyLocked = true;
      return this.activePackName === matchedName ? null : matchedName;
    }

    // 已锁定：仅当命中包与当前激活包互斥时才切换，否则保持当前
    if (!this.activePackName || this.activePackName === matchedName) return null;
    return this.isExclusiveBetween(this.activePackName, matchedName) ? matchedName : null;
  }

  /** 复位粘性锁定（会话切换由宿主调用，幂等——粘性不跨会话） */
  resetSticky(): void {
    this.stickyLocked = false;
  }

  /** 清理资源：清除切换防抖锁计时器，防止关闭后回调触发 */
  close(): void {
    if (this.unlockTimer) {
      clearTimeout(this.unlockTimer);
      this.unlockTimer = null;
      this.switchLocked = false;
      this.unlockAt = null;
      this.switchTimestamps = [];
    }
  }

  /** 判断两角色包是否互斥：exclusiveWith 双向声明其一即互斥 */
  private isExclusiveBetween(a: string, b: string): boolean {
    const packA = this.items.find((p) => p.meta.name === a);
    const packB = this.items.find((p) => p.meta.name === b);
    const aExcludesB = packA?.meta.exclusiveWith?.includes(b) ?? false;
    const bExcludesA = packB?.meta.exclusiveWith?.includes(a) ?? false;
    return aExcludesB || bExcludesA;
  }

  /** 所有角色包元数据摘要列表 */
  listMeta(): RolePackMeta[] {
    return this.items.map((p) => p.meta);
  }

  // ── 基类抽象方法实现 ──────────────────────────────

  /**
   * 基类抽象实现：本管理器用自建扫描（parseManifestPack/buildFromDir）覆盖了
   * loadItems/reload，不用基类单文件扫描，恒返回 null 以满足抽象约束。
   */
  protected async createEntry(_entry: ScannedMarkdownEntry): Promise<RolePack | null> {
    // 角色包不用基类的单文件扫描，返回 null 跳过
    return null;
  }

  // ── 系统提示 ──────────────────────────────────────

  /** 构建 system prompt 的角色包段：personaPrompt + L1 技能清单（渐进披露）；name 缺省用当前激活包 */
  buildSystemPrompt(name?: string): string {
    const targetName = name ?? this.activePackName;
    if (!targetName) return '';
    const pack = this.items.find((p) => p.meta.name === targetName);
    if (!pack) return '';
    // 使用预缓存的 Assembly，避免重复构建
    const assembly = pack._cachedAssembly ?? assembleRolePack(pack);

    const skills = assembly.skills.filter((s) => s.name || s.file);
    const skillCount = skills.length;

    // L1 阈值保护（token 经济性）：
    //   ≤ 30 技能：完整 L1（name + full description + L3 tag）
    //   31-50 技能：压缩 L1（name + 20 字摘要）
    //   > 50 技能：切换 list_skills 工具动态查询，不在 system prompt 枚举
    if (skillCount > L1_LIST_TOOL_THRESHOLD) {
      return assembly.personaPrompt + `\n\n【可用技能（${skillCount} 个，数量较多，使用 list_skills 工具查询具体清单）】`;
    }

    const compressed = skillCount > L1_COMPRESSED_THRESHOLD;
    const listed = skills.map((s) => {
      const fallbackName = s.file ? this.deriveSkillNameFromFile(s.file) : undefined;
      // SSOT: 使用 SkillManager.formatSkillForPrompt 统一格式化，压缩逻辑由 compress 参数控制
      return SkillManager.formatSkillForPrompt(s, fallbackName, compressed);
    }).filter(Boolean);

    const modeNote = compressed ? '（技能较多，描述已压缩至 20 字，可用 read_skill 读取完整正文）' : '（按需调用 read_skill 读取正文）';
    const skillListBlock =
      listed.length > 0 ? `\n\n【可用技能（渐进披露 L1）${modeNote}】\n${listed.join('\n')}` : '';

    return assembly.personaPrompt + skillListBlock;
  }

  /**
   * 读激活角色包内嵌技能正文（渐进披露 L2，read_skill 数据源）。优先返回 parseManifestPack
   * 时缓存的正文；路径相对角色包目录天然受限，无需额外白名单校验。
   */
  async readSkillContent(skillName: string, packName?: string): Promise<string | null> {
    const found = this.findSkillByName(skillName, packName);
    if (!found || !found.skill.file) return null;

    // 优先返回 parseManifestPack 时缓存的正文；缓存未就绪（如动态添加的技能）时回退实时读磁盘
    if (found.skill.content !== undefined && found.skill.content !== null) {
      return found.skill.content;
    }
    const skillFilePath = found.skill.file;
    const { pack } = found;

    // 技能文件路径相对角色包目录（manifest.json 所在目录）
    const skillPath = join(dirname(pack.filePath), skillFilePath);
    try {
      return await readContentSafe(skillPath);
    } catch (err) {
      getLogger().warn(
        { pack: pack.meta.name, skill: skillName, skillPath, err },
        'read_skill 读取技能正文失败',
      );
      return null;
    }
  }

  // ── L3 资源/脚本访问 ──────────────────────────────────

  /** 从技能文件路径推导技能名（单文件 write.md → write；文件夹 my-skill/SKILL.md → my-skill） */
  deriveSkillNameFromFile(file: string): string {
    const parts = file.split(/[\\/]/);
    const last = parts.pop() ?? '';
    if (last === 'SKILL.md' || last === 'SKILL.MD') {
      return parts.pop() ?? ''; // 文件夹形式
    }
    return last.replace(/\.(md|markdown)$/i, ''); // 单文件形式
  }

  /** 按技能名在角色包中查找技能条目：frontmatter name 精确匹配优先，其次 file 路径推导；未找到返回 null */
  private findSkillByName(
    skillName: string,
    packName: string | undefined,
  ): { pack: RolePack; skill: RolePackManifestSkill } | null {
    const targetName = packName ?? this.activePackName;
    if (!targetName) return null;
    const pack = this.items.find((p) => p.meta.name === targetName);
    if (!pack) return null;

    const skill = pack.skills.find((s) => {
      if (s.name && s.name === skillName) return true;
      if (!s.file) return false;
      return this.deriveSkillNameFromFile(s.file) === skillName;
    });
    if (!skill) return null;
    return { pack, skill };
  }

  /** 解析技能所在目录（SKILL.md 所在目录或 .md 文件所在目录），供 L3 资源/脚本访问 */
  private resolveSkillDir(skillName: string, packName?: string): string | null {
    const found = this.findSkillByName(skillName, packName);
    if (!found || !found.skill.file) return null;
    const skillFilePath = found.skill.file;
    const { pack } = found;

    const fullSkillPath = join(dirname(pack.filePath), skillFilePath);
    // 技能目录：SKILL.md 在文件夹内 → 文件夹根；单文件 .md → 文件所在目录
    const skillStat = statSyncSafe(fullSkillPath);
    if (skillStat?.isDirectory()) {
      return fullSkillPath; // 文件夹形式：skills/my-skill/SKILL.md → skills/my-skill/
    }
    return dirname(fullSkillPath); // 单文件形式：skills/write.md → skills/
  }

  /** 读取技能 L3 资源文件内容（渐进披露 L3），不存在或读取失败返回 null */
  async readSkillResource(skillName: string, resourcePath: string, packName?: string): Promise<string | null> {
    const skillDir = this.resolveSkillDir(skillName, packName);
    if (!skillDir) return null;

    // 路径穿越防护：确保 resourcePath 不逃逸技能 resources/ 目录
    const resourceFullPath = resolveSafePath(join(skillDir, 'resources'), resourcePath);
    if (!resourceFullPath) {
      getLogger().warn(
        { skill: skillName, resourcePath },
        'read_resource 路径穿越被阻止',
      );
      return null;
    }
    try {
      return await readContentSafe(resourceFullPath);
    } catch (err) {
      getLogger().warn(
        { skill: skillName, resourcePath, err },
        'read_resource 读取技能资源失败',
      );
      return null;
    }
  }

  /** 列出技能 L3 资源清单，无资源返回空数组 */
  listSkillResources(skillName: string, packName?: string): ReadonlyArray<{ readonly path: string; readonly size: number }> {
    const found = this.findSkillByName(skillName, packName);
    return found?.skill.layer3?.resources ?? [];
  }

  /** 获取技能 L3 脚本完整路径，不存在返回 null */
  getSkillScriptPath(skillName: string, scriptPath: string, packName?: string): string | null {
    const skillDir = this.resolveSkillDir(skillName, packName);
    if (!skillDir) return null;

    // 路径穿越防护：确保 scriptPath 不逃逸技能 scripts/ 目录
    const fullPath = resolveSafePath(join(skillDir, 'scripts'), scriptPath);
    if (!fullPath) return null;
    if (accessSyncSafe(fullPath)) {
      return fullPath;
    }
    return null;
  }

  /** 获取技能 L3 脚本元信息（runtime 从扩展名或 SKILL.md frontmatter 的 scripts 声明推断） */
  getSkillScriptInfo(
    skillName: string,
    scriptPath: string,
    packName?: string,
  ): { runtime: 'node' | 'python' | 'shell'; timeout?: number } | null {
    // 优先使用已扫描的 L3 数据（scanPackSkills 已发现 layer3.scripts）
    const found = this.findSkillByName(skillName, packName);
    if (found?.skill.layer3?.scripts) {
      const scriptMeta = found.skill.layer3.scripts.find((s) => s.path === scriptPath);
      if (scriptMeta) {
        return { runtime: scriptMeta.runtime };
      }
    }
    // 回退：从扩展名推断 runtime
    const ext = scriptPath.slice(scriptPath.lastIndexOf('.')).toLowerCase();
    const runtimeMap: Record<string, 'node' | 'python' | 'shell'> = {
      '.ts': 'node', '.js': 'node', '.mjs': 'node', '.cjs': 'node',
      '.py': 'python',
      '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
    };
    const runtime = runtimeMap[ext];
    if (!runtime) return null;
    return { runtime };
  }
}

/**
 * 安全的 stat 同步调用（内部工具，不对外导出）
 */
function statSyncSafe(path: string): { isDirectory(): boolean } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/**
 * 安全的 exists 同步调用（内部工具，不对外导出）
 */
function accessSyncSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
