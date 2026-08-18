/**
 * 角色包管理器 — 继承 ConfigResourceManager，管理角色包的生命周期
 *
 * 2026-08-18 收敛形态（M3 完成，PersonaManager 完全合并）：
 *   - 角色包统一为**文件夹形态**，`manifest.json` 是唯一核心控制文件。
 *   - 内容文件（persona.md / rules.md / skills/*）独立于 manifest，由 manifest
 *     按路径注册装载——用户既可独立移植内容文档，也可整体装载角色包。
 *   - PersonaManager 职责已完全合并到 RolePackManager：
 *     * system prompt 注入（buildSystemPrompt）
 *     * 角色切换防抖锁（activate 内置）
 *     * 关键词高置信度匹配（autoMatch）
 *     * 角色 traits 提取（persona.md frontmatter）
 *
 * 设计原则：
 *   - 继承 ConfigResourceManager 基类（复用关键词匹配 / 生命周期）
 *   - 角色包特有状态（activeRolePack / 粘性匹配 / 自建扫描 / 切换防抖）保留在子类
 */
import { readFile, readdir, access, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { logger } from '@/logging/logger.js';
import { getLogger } from '@/utils/loggerHolder.js';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import { resolveSubdir, scanMarkdownDir, discoverLayer3, resolveSafePath, type ScannedMarkdownEntry } from '@/utils/scanner.js';
import { parseFrontmatter } from '@/utils/frontmatter.js';
import { validateManifest, checkCompanionContentRedline } from '@/role-pack/validator.js';
import type {
  RolePack,
  RolePackMeta,
  RolePackManifestSkill,
  RolePackCapability,
  RolePackAssembly,
  BehaviorStrategy,
} from '@/role-pack/types.js';
import { assembleRolePack } from '@/role-pack/types.js';

/** 合规字段默认值：formatVersion 缺省按 1.0.0（spec §五） */
const DEFAULT_FORMAT_VERSION = '1.0.0';

/** 角色包自动匹配关键词置信度阈值（scoredByKeywords） */
const AUTO_MATCH_THRESHOLD = 0.3;

/**
 * L2 策略键别名映射（旧实现键 → 标准键，role-pack-spec §六 命名归标准）
 *
 * 存量 manifest 若误写私有键名 act.toolCalls / reflect.endingHandoff，
 * 装载时自动映射到标准键 + warn 提示（平滑兼容，不阻塞装载）。
 */
const STRATEGY_KEY_ALIASES: Readonly<Record<string, string>> = {
  'act.toolCalls': 'act.toolMode',
  'reflect.endingHandoff': 'reflect.handoff',
};

/** 角色包扫描需排除的非包文件（如 README 等允许放在包根） */
const EXCLUDED_FILES = new Set(['manifest.json']);

/**
 * 规则文件的约定文件名（2026-08-18 简化）
 *
 * rules.md 为角色包的**约定俗成规则文件**——manifest 未声明 rules 路径时回退此名，
 * 消除「路径写错静默丢规则」错误面。仓库全部角色包均使用此名。
 */
const DEFAULT_RULES_FILENAME = 'rules.md';

/**
 * 身份设定文件的约定文件名（2026-08-18 简化，与 rules.md 对称）
 *
 * persona.md 为角色包的**约定俗成身份文件**——manifest 未声明 persona 路径时回退此名。
 * 仓库全部角色包均使用此名。
 */
const DEFAULT_PERSONA_FILENAME = 'persona.md';

/**
 * 策略阶段键名规范化：旧实现键 → 标准键（spec §六 命名归标准）
 *
 * @param stage 策略阶段（prepare / act / reflect / global）
 * @param fields 该阶段的键值对（来自 manifest.strategy）
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
 * 从 manifest.strategy 节点解析策略声明（JSON 已是嵌套对象）
 *
 * 只取四阶段下声明过的键，未声明的阶段为 undefined（由 mergeStrategy 补默认值）。
 * 旧实现键 → 标准键 别名迁移（spec §六 命名归标准）。
 *
 * @param strategyNode manifest.strategy 节点
 * @returns 解析后的策略声明，无 strategy 返回 undefined
 */
function parseStrategyNode(strategyNode: unknown): BehaviorStrategy | undefined {
  if (typeof strategyNode !== 'object' || strategyNode === null) return undefined;

  const stages: Record<string, Record<string, unknown>> = {};
  for (const [stage, node] of Object.entries(strategyNode as Record<string, unknown>)) {
    if (typeof node !== 'object' || node === null) continue;
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      fields[key] = value;
    }
    if (Object.keys(fields).length > 0) stages[stage] = normalizeStageKeys(stage, fields);
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
 * 从 manifest 解析 keywords（兼容数组与逗号字符串两种写法）
 *
 * 同时合并 `trigger` 数组（role-pack-spec §二/§三 字段）：
 * 匹配词只有一个来源 keywords，触发词统一汇入（单一真理源）。
 *
 * 设计决策：角色包 trigger 为字符串数组（精确/包含匹配），不是正则。
 * 正则匹配仅在 Skill 系统中存在（parseTrigger → RegExp.test）。
 * 角色包场景为"角色切换"，关键词匹配已足够；Skill 场景为"精确技能触发"，需要正则。
 *
 * @param manifest 解析后的 manifest 对象
 * @returns 关键词数组（keywords ∪ trigger，去重）
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

/**
 * 从 persona.md frontmatter 解析 traits.* 键值对
 *
 * 与 PersonaManager.parseTraits 同源，迁移到 RolePackManager 后统一入口。
 *
 * @param personaContent persona.md 的原始内容（含 frontmatter）
 * @returns traits 键值对（数值），无 traits 时返回 undefined
 */
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

/**
 * 解析互斥声明数组（exclusiveWith）
 *
 * 支持数组与逗号串两种写法。
 *
 * @param raw manifest.exclusiveWith 原始值
 * @returns 互斥角色包名列表，未声明返回 undefined
 */
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

/**
 * 解析接手衔接提示词（manifest.handoffPrompt，角色包自洽声明）
 *
 * 该角色包被宿主「带入对话」时预填的特色话术。非字符串 / 空白视为未声明（undefined），
 * 由宿主回退通用话术——角色包只描述自己，不引用其他角色包（§11 插卡解耦）。
 *
 * @param raw manifest.handoffPrompt 原始值
 * @returns 非空提示词，未声明/非法返回 undefined
 */
function parseHandoffPrompt(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw.trim();
}

/**
 * 扫描角色包 skills/ 目录注册技能（目录扫描 + frontmatter，2026-08-18 C3）
 *
 * skills 从「manifest 注册」改为「目录动态扫描」——与全局技能同构（复用
 * scanMarkdownDir：frontmatter 的 name/description + 正文）。新增技能只写文件，
 * 无需改 manifest。manifest.skills 保留为**可选过滤**：声明了 file 路径时按
 * file 过滤扫描结果（白名单语义），未声明则全部扫描（默认零配置）。
 *
 * @param packDir 角色包目录
 * @param skillsNode manifest.skills 节点（可选过滤，null = 全量扫描）
 * @returns 技能注册列表
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
  // manifest.skills 声明时按 file 过滤（白名单语义）；未声明返回全部
  if (!Array.isArray(skillsNode)) return resolved;
  const allowedFiles = new Set(
    skillsNode
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((record) => record['file'])
      .filter((f): f is string => typeof f === 'string' && f.trim() !== ''),
  );
  if (allowedFiles.size === 0) return resolved;
  return resolved.filter((s) => s.file && allowedFiles.has(s.file));
}

/**
 * 从 manifest.capabilities 顶层数组解析能力声明（C2，2026-08-18 独立模块）
 *
 * 能力面（工具白名单）与内容面（技能正文）分离：capabilities 是角色可调用的
 * 中立能力声明，独立于 skills 技能文件。经 capabilityMap 映射为工具白名单
 * （agent.ts applyRolePackToolExposure，「换装 = 换 Agent」）。
 *
 * @param capabilitiesNode manifest.capabilities 节点
 * @returns 能力声明列表
 */
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

/**
 * 从 rules.md 内容解析规则列表
 *
 * 支持两种 Markdown 列表格式：
 *   - 无序列表：`- 规则内容` 或 `* 规则内容`
 *   - 有序列表：`1. 规则内容`、`2. 规则内容` 等
 *
 * @param content rules 文件内容
 * @returns 规则字符串列表
 */
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

/**
 * 安全读取内容文件（相对包根的路径），失败返回空串（内容文件可选）
 *
 * @param filePath 绝对路径
 * @returns 文件内容，读取失败返回空串
 */
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
  /** 当前激活模式 */
  private mode: 'auto' | 'manual' = 'auto';
  /**
   * 粘性锁定标志（agent-design-philosophy §6.2 粘性匹配）
   *
   * 当前会话内首次 autoMatch 命中后置 true：后续外部输入不再全量重匹配，
   * 仅当输入命中与当前激活包互斥（exclusiveWith）的包时才切换。
   * 会话切换时由宿主调用 resetSticky() 复位——粘性不跨会话。
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

  /**
   * 启动时加载：扫描含 manifest.json 的角色包文件夹
   *
   * 覆盖基类 loadItems()：基类扫描只支持单文件 *.md，无法覆盖文件夹包形态。
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
   * 扫描角色包目录（仅 manifest.json 文件夹形态）
   *
   * 每个子目录为一个角色包，须含 manifest.json（核心控制文件）。
   * 命名：manifest.name 优先，其次文件夹名。
   */
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
   * 集合级互斥声明对称性检查（role-pack-spec §13 粘性匹配）
   *
   * 互斥是**双向关系**：角色包 A 声明 `exclusiveWith: ['B']`，则 B 应反向声明 A。
   * 本方法在装载后扫描全部角色包，对非对称声明给出 warning——非对称不会导致
   * 运行时错误（isExclusiveBetween 采用"单边命中即互斥"），但声明不完整会削弱
   * 粘性切换的确定性，故提示作者补全。
   *
   * 检出的两类问题：
   *   - 悬空引用：A 声明互斥 B，但角色包 B 不存在；
   *   - 非对称：A 声明互斥 B，但 B 未反向声明 A。
   *
   * @param packs 已装载的角色包列表
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
        (f) => !f.startsWith('.') && !f.startsWith('_') && !EXCLUDED_FILES.has(f),
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
        if (!st.isDirectory()) continue; // 仅文件夹形态
        const pack = await this.parseManifestPack(fullPath, entry);
        if (pack) map.set(pack.name, pack);
      } catch (err) {
        getLogger().warn({ entry, err }, '扫描角色包失败');
      }
    }
    return Array.from(map.values());
  }

  /**
   * 解析单个角色包（manifest.json + 独立内容文件）
   *
   * @param packDir 角色包文件夹绝对路径
   * @param fallbackName 无 manifest.name 时的兜底名（文件夹名）
   * @returns 角色包对象，解析失败返回 null
   */
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

    // 内容路径注册（persona 约定俗成为 persona.md，2026-08-18 简化）：
    // manifest 声明路径时尊重（向后兼容），未声明/空串时回退约定名。
    // 与 rules.md 对称——身份设定与规则均约定固定文件名，消除路径错误面。
    const declaredPersonaPath =
      typeof manifest['persona'] === 'string' && manifest['persona'].trim() !== ''
        ? manifest['persona']
        : null;
    const personaPath = declaredPersonaPath ?? DEFAULT_PERSONA_FILENAME;
    // rules 约定俗成为固定文件名 rules.md（2026-08-18 简化）：
    // manifest 声明路径时尊重（向后兼容），未声明/空串时回退约定名。
    // 消除「路径写错静默丢规则」错误面——规则本就约定在此文件。
    const declaredRulesPath =
      typeof manifest['rules'] === 'string' && manifest['rules'].trim() !== ''
        ? manifest['rules']
        : null;
    const rulesPath = declaredRulesPath ?? DEFAULT_RULES_FILENAME;

    // 装载独立内容文件
    // persona.md 需要解析 frontmatter 提取 traits，正文仅取 body 部分
    const rawPersonaContent = personaPath ? await readContentSafe(join(packDir, personaPath)) : '';
    const { body: personaBody } = parseFrontmatter(rawPersonaContent);
    const personaContent = personaBody; // 去除 frontmatter 后的正文
    const traits = parseTraits(rawPersonaContent); // 从 frontmatter 解析 traits
    const rulesContent = rulesPath ? await readContentSafe(join(packDir, rulesPath)) : '';
    const rules = parseRules(rulesContent);

    // 内嵌技能：目录动态扫描 + frontmatter（C3，manifest.skills 可选过滤；新增技能只写文件）
    const skills = await scanPackSkills(packDir, manifest['skills']);
    // 能力声明（顶层数组，C2 独立模块——能力面与技能内容分离）
    const capabilities = parseManifestCapabilities(manifest['capabilities']);

    // companion 内容红线（§七 第 5 条）：正文在独立内容文件，由装载方读取后检测
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

    return {
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
      skills,
      capabilities,
      strategy,
    };
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
   * 获取当前激活角色包的规则列表（宿主 API：设定记忆归角色包后，规则以角色包为准）
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
   * 激活指定角色包（带时间窗口缓冲）
   *
   * 30s 内超过 5 次切换后锁定 2 分钟（防抖保护，避免频繁切换导致的状态抖动）。
   *
   * @param name 角色包名
   * @returns 是否成功激活（锁定或角色不存在时返回 false）
   */
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

    // 记录切换时间戳并检查是否达到锁定阈值
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

  /**
   * 获取角色切换锁定状态
   *
   * @returns locked 是否处于锁定状态；unlockAt 锁定自动恢复时间戳（ms epoch），未锁定时为 null
   */
  getSwitchLockStatus(): { locked: boolean; unlockAt: number | null } {
    return { locked: this.switchLocked, unlockAt: this.unlockAt };
  }

  /**
   * 获取当前激活角色包的 traits
   *
   * @returns traits 键值对，无激活角色包或无 traits 时返回 undefined
   */
  getActiveTraits(): Record<string, number> | undefined {
    if (!this.activePackName) return undefined;
    const pack = this.items.find((p) => p.meta.name === this.activePackName);
    return pack?.traits;
  }

  /**
   * 设置激活模式（auto / manual）
   *
   * @param mode 激活模式
   */
  setMode(mode: 'auto' | 'manual'): void {
    this.mode = mode;
  }

  /**
   * 根据用户输入粘性匹配最合适的角色包（agent-design-philosophy §6.2）
   *
   * 粘性语义（状态粘性，非"永不切换"）：
   *   - 首次外部输入（未锁定）：全量关键词匹配，命中即锁定当前会话；
   *   - 后续外部输入（已锁定）：仅当输入命中与当前激活包互斥（exclusiveWith）
   *     的包时才自动切换，否则保持当前；
   *   - 显式切换由宿主调用 activate() 完成，不经过本方法。
   *
   * @param userInput 用户输入文本
   * @returns 需切换到的角色包名，无匹配/无需切换返回 null
   */
  autoMatch(userInput: string): string | null {
    if (this.mode !== 'auto') return null;
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

  /**
   * 复位粘性锁定（会话切换时由宿主调用）
   *
   * 粘性不跨会话：新会话的首条外部输入重新进行全量匹配。幂等，可重复调用。
   */
  resetSticky(): void {
    this.stickyLocked = false;
  }

  /**
   * 清理资源（关闭时调用）
   *
   * 清理切换防抖锁的计时器，防止关闭后回调触发。
   */
  close(): void {
    if (this.unlockTimer) {
      clearTimeout(this.unlockTimer);
      this.unlockTimer = null;
      this.switchLocked = false;
      this.unlockAt = null;
      this.switchTimestamps = [];
    }
  }

  /**
   * 判断两个角色包是否互斥（exclusiveWith 双向声明其一即互斥）
   *
   * @param a 角色包 A 名
   * @param b 角色包 B 名
   * @returns A 与 B 是否互斥
   */
  private isExclusiveBetween(a: string, b: string): boolean {
    const packA = this.items.find((p) => p.meta.name === a);
    const packB = this.items.find((p) => p.meta.name === b);
    const aExcludesB = packA?.meta.exclusiveWith?.includes(b) ?? false;
    const bExcludesA = packB?.meta.exclusiveWith?.includes(a) ?? false;
    return aExcludesB || bExcludesA;
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
   * 基类抽象方法实现（不再被调用）
   *
   * RolePackManager 覆写了 load()/reload() 使用自建扫描路径（parseManifestPack），
   * 基类 scanAndBuild() 依赖的 loadItems()/reload() 均被覆写，此方法不可达。
   * 保留实现以满足抽象约束；若被意外调用，显式报错而非静默错误。
   */
  protected createEntry(_entry: ScannedMarkdownEntry): RolePack {
    throw new Error(
      'RolePackManager 使用自建扫描路径（load/reload → parseManifestPack），createEntry 不应被调用',
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
    const assembly = assembleRolePack(pack);

    // L1 常驻元数据（渐进披露 L1）：暴露内嵌技能清单给 LLM（name + description）
    // 每技能一行，省 token；LLM 据此判断何时调用 read_skill 读取正文（渐进披露 L2）。
    // 若技能含 L3 资源/脚本，附加 "(含资源/脚本)" 提示，引导 LLM 利用 L3 能力。
    const listed = assembly.skills
      .filter((s) => s.name || s.file)
      .map((s) => {
        // 优先使用 frontmatter name，回退到从 file 路径提取（兼容无 name 的旧技能）
        const label = s.name ?? (s.file ? this.deriveSkillNameFromFile(s.file) : '');
        const desc = s.description ? `：${s.description}` : '';
        const l3Tag = s.layer3 && (s.layer3.resources.length > 0 || s.layer3.scripts.length > 0)
          ? '（含资源/脚本）'
          : '';
        return `- ${label}${desc}${l3Tag}`;
      });
    const skillListBlock =
      listed.length > 0 ? `\n\n【可用技能（渐进披露 L1，按需调用 read_skill 读取正文）】\n${listed.join('\n')}` : '';

    return assembly.personaPrompt + skillListBlock;
  }

  /**
   * 读取激活角色包内嵌技能正文（渐进披露 L2，read_skill 工具的数据源）
   *
   * 角色包 `manifest.skills` 的 `file` 指向包内技能文件（如 `skills/write.md`），
   * 正文当前不预装载（role-pack-spec §四 诚实声明）。本方法在 LLM 按需调用
   * read_skill 时按技能名读取对应正文——file 从"生态指针"变为"装载入口"。
   *
   * 路径安全：技能文件路径固定相对于角色包目录（manifest.json 所在目录），
   * 不接外部输入路径，天然受限在角色包内，无需额外白名单校验。
   *
   * @param skillName 技能名（manifest.skills[].name，缺省取 fileName 去扩展名）
   * @param packName 角色包名（可选，缺省用当前激活角色包）
   * @returns 技能正文；技能不存在或读取失败返回 null
   */
  async readSkillContent(skillName: string, packName?: string): Promise<string | null> {
    const found = this.findSkillByName(skillName, packName);
    if (!found || !found.skill.file) return null;
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

  /**
   * 从技能文件路径推导技能名
   *
   * 单文件形式：skills/write.md → write
   * 文件夹形式：skills/my-skill/SKILL.md → my-skill
   */
  private deriveSkillNameFromFile(file: string): string {
    const parts = file.split(/[\\/]/);
    const last = parts.pop() ?? '';
    if (last === 'SKILL.md' || last === 'SKILL.MD') {
      return parts.pop() ?? ''; // 文件夹形式
    }
    return last.replace(/\.(md|markdown)$/i, ''); // 单文件形式
  }

  /**
   * 按技能名在指定角色包中查找技能条目
   *
   * 匹配策略：frontmatter name 精确匹配优先，其次从 file 路径推导
   *
   * @param skillName 技能名
   * @param packName 角色包名（可选，默认激活角色包）
   * @returns 匹配的角色包和技能条目，未找到返回 null
   */
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

  /**
   * 解析技能所在目录（供 L3 资源/脚本访问使用）
   *
   * 与 readSkillContent 共享相同的技能定位逻辑：
   *   - 按技能名匹配 manifest.skills 项（name 优先，缺省按路径推导）
   *   - 返回技能文件所在目录（SKILL.md 所在目录或 .md 文件所在目录）
   */
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

  /**
   * 读取技能的 L3 资源文件（渐进披露 L3）
   *
   * @param skillName 技能名
   * @param resourcePath 相对 resources/ 的路径
   * @param packName 角色包名（可选，默认激活角色包）
   * @returns 资源文件内容，不存在返回 null
   */
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

  /**
   * 获取技能的 L3 脚本完整路径
   *
   * @param skillName 技能名
   * @param scriptPath 相对 scripts/ 的路径
   * @param packName 角色包名（可选）
   * @returns 脚本完整路径，不存在返回 null
   */
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

  /**
   * 获取技能的 L3 脚本元信息（runtime、timeout）
   *
   * 从脚本扩展名推断 runtime，或从 SKILL.md frontmatter 的 scripts 声明获取。
   *
   * @param skillName 技能名
   * @param scriptPath 相对 scripts/ 的路径
   * @param packName 角色包名（可选）
   * @returns 脚本元信息，不存在返回 null
   */
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
    const fs = require('node:fs');
    return fs.statSync(path);
  } catch {
    return null;
  }
}

/**
 * 安全的 access 同步调用（内部工具，不对外导出）
 */
function accessSyncSafe(path: string): boolean {
  try {
    const fs = require('node:fs');
    return fs.existsSync(path);
  } catch {
    return false;
  }
}
