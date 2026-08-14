/**
 * 角色包管理器 — 继承 ConfigResourceManager，管理角色包的生命周期
 *
 * 2026-08-14 收敛形态（单一形态，无旧格式兼容）：
 *   角色包统一为**文件夹形态**，`manifest.json` 是唯一核心控制文件。
 *   内容文件（persona.md / rules.md / skills/*）独立于 manifest，由 manifest
 *   按路径注册装载——用户既可独立移植内容文档，也可整体装载角色包。
 *   系统此前未启用角色包（无存量包），故不保留单文件 .md / role-pack.md 旧格式。
 *
 * 职责：
 *   - 从 configDir/role-packs/<名>/ 扫描含 manifest.json 的角色包
 *   - 解析 manifest.json（元数据 + L2 策略 + 内容路径注册 + 内嵌技能注册）
 *   - 按路径装载 persona.md / rules.md 正文；skills 仅转译注册形状（正文不装载，
 *     capability 为内核唯一行为入口，见 role-pack-spec §四）
 *   - 提供角色包激活、粘性匹配、互斥切换功能
 *
 * 与 PersonaManager 的关系：
 *   角色包是更上层的抽象，Persona 是角色包 L1 内容层的一部分。
 *   当前角色包管理器为可选组件，与 PersonaManager 共存（M3 远期可替代）。
 *
 * 设计原则：
 *   - 继承 ConfigResourceManager 基类（复用关键词匹配 / 生命周期）
 *   - 角色包特有状态（activeRolePack / 粘性匹配 / 自建扫描）保留在子类
 */
import { readFile, readdir, access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '@/logging/logger.js';
import { getLogger } from '@/utils/loggerHolder.js';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import { resolveSubdir } from '@/utils/scanner.js';
import { validateManifest, checkCompanionContentRedline } from '@/role-pack/validator.js';
import type {
  RolePack,
  RolePackMeta,
  RolePackManifestSkill,
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
 * 从 manifest.skills 数组解析技能注册（对象数组，支持多个添加）
 *
 * 每项结构：`{ file?, name?, description?, capability? }`，file 或 capability 至少其一。
 * 承载转译为 RolePack.skills 的原始注册形状；capability 由 assembleRolePack 派生为能力声明。
 * file 为**生态兼容指针**（§四）——仅记录路径供生态互认/移植，**正文不装载**。
 *
 * @param skillsNode manifest.skills 节点
 * @returns 技能注册列表
 */
function parseManifestSkills(skillsNode: unknown): RolePackManifestSkill[] {
  if (!Array.isArray(skillsNode)) return [];
  const skills: RolePackManifestSkill[] = [];
  for (const item of skillsNode) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const file = record['file'];
    const capability = record['capability'];
    // file（生态指针）或 capability（能力声明）至少其一（§四）：
    // 纯能力声明项（无 file 但有 capability）不丢弃，保留能力暴露面（雷-3a）
    const hasFile = typeof file === 'string' && file.trim() !== '';
    const hasCapability = typeof capability === 'string' && capability.trim() !== '';
    if (!hasFile && !hasCapability) continue;
    const name = record['name'];
    const description = record['description'];
    skills.push({
      file: hasFile ? file : undefined,
      name: typeof name === 'string' ? name : undefined,
      description: typeof description === 'string' ? description : undefined,
      capability: hasCapability ? capability : undefined,
    });
  }
  return skills;
}

/**
 * 从 rules.md 内容解析规则列表（逐行 `- ` 无序列表）
 *
 * @param content rules 文件内容
 * @returns 规则字符串列表
 */
function parseRules(content: string): string[] {
  if (!content) return [];
  const rules: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    const match = /^[-*]\s+(.+)$/.exec(trimmed);
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
      description: str(manifest['description']),
      version: str(manifest['version']),
      keywords: parseKeywordsAny(manifest),
      author: str(manifest['author']),
      formatVersion: str(manifest['formatVersion']) ?? DEFAULT_FORMAT_VERSION,
      interactionType: manifest['interactionType'] === 'companion' ? 'companion' : 'tool_assistant',
      aiIdentityDisclosure: manifest['aiIdentityDisclosure'] === false ? false : true,
      minorProtection: 'required',
      exclusiveWith: parseExclusiveWith(manifest['exclusiveWith']),
    };

    // 解析 L2 策略
    const strategy = parseStrategyNode(manifest['strategy']);

    // 内容路径注册（persona 允许缺省；null = 未声明）
    const personaPath =
      typeof manifest['persona'] === 'string' && manifest['persona'].trim() !== ''
        ? manifest['persona']
        : null;
    const rulesPath =
      typeof manifest['rules'] === 'string' && manifest['rules'].trim() !== ''
        ? manifest['rules']
        : null;

    // 装载独立内容文件
    const personaContent = personaPath ? await readContentSafe(join(packDir, personaPath)) : '';
    const rulesContent = rulesPath ? await readContentSafe(join(packDir, rulesPath)) : '';
    const rules = parseRules(rulesContent);

    // 内嵌技能注册（对象数组，支持多个）
    const skills = parseManifestSkills(manifest['skills']);

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
      rules,
      skills,
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
   * 获取当前激活角色包的规则列表（Rule→guardrail 桥接用）
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
   * 基类抽象方法实现（不再被调用）
   *
   * RolePackManager 覆写了 load()/reload() 使用自建扫描路径（parseManifestPack），
   * 基类 scanAndBuild() 依赖的 loadItems()/reload() 均被覆写，此方法不可达。
   * 保留实现以满足抽象约束；若被意外调用，显式报错而非静默错误。
   */
  protected createEntry(): RolePack {
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
    return assembleRolePack(pack).personaPrompt;
  }
}