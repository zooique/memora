/**
 * 角色包管理器：继承 ConfigResourceManager 复用关键词匹配/生命周期；
 * 角色包特有状态（activeRolePack / 粘性匹配 / 自建扫描 / 切换防抖）保留在子类。
 * manifest.json 为唯一核心控制文件，内容文件独立按路径注册装载。
 */
import { readFile, readdir, access, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger } from '@/logging/logger.js';
import { getLogger } from '@/utils/loggerHolder.js';
import { ConfigResourceManager } from '@/utils/configResourceManager.js';
import { resolveSubdir, scanMarkdownDir, discoverLayer3, resolveSafePath, isFolderFormSkill, SKILL_MAIN_FILE, type ScannedMarkdownEntry } from '@/utils/scanner.js';
import { parseFrontmatter } from '@/utils/frontmatter.js';
import {
  validateManifest,
  checkCompanionContentRedline,
  MAX_HANDOFF_PROMPT_LEN,
} from '@/role-pack/validator.js';
import { BUILTIN_FALLBACK_PACK, MAX_TEAM_MEMBERS } from '@/role-pack/constants.js';
import { SkillManager, L1_COMPRESSED_THRESHOLD, L1_LIST_TOOL_THRESHOLD } from '@/skill/skillManager.js';
import type {
  RolePack,
  RolePackMeta,
  RolePackManifestSkill,
  RolePackCapability,
  RolePackAssembly,
  RolePackTeam,
  BehaviorStrategy,
} from '@/role-pack/types.js';
import { assembleRolePack } from '@/role-pack/strategyResolver.js';

/** formatVersion 缺省值（未声明时按 1.0.0） */
const DEFAULT_FORMAT_VERSION = '1.0.0';

/** 角色包扫描需排除的非包文件（如 README 等允许放在包根） */
const EXCLUDED_FILES = new Set(['manifest.json']);

/** 规则文件约定名：manifest 未声明 rules 路径时回退 rules.md（消除路径写错静默丢规则） */
const DEFAULT_RULES_FILENAME = 'rules.md';

/** persona 约定文件名：manifest 未声明 persona 路径时回退 persona.md（与 rules.md 对称） */
const DEFAULT_PERSONA_FILENAME = 'persona.md';

/**
 * 内容文件正文最大长度（字符）：persona/rules/skills 全文防膨胀，超限截断。
 * 外部可控内容（角色包正文）装载进内存/上下文前统一限长，对齐 toolExecutor 外部内容防护。
 */
const MAX_CONTENT_FILE_LEN = 200_000;

/**
 * manifest.json 最大长度（字符）：JSON 必须完整解析不可截断，超限直接跳过装载。
 */
const MAX_MANIFEST_LEN = 512 * 1024;

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

/** 解析接手衔接提示词（宿主带入对话时预填的话术）；非空字符串，否则 undefined。角色包只描述自己（插卡解耦）。长度上限运行时兜底（validator 报错，此处截断）。 */
function parseHandoffPrompt(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > MAX_HANDOFF_PROMPT_LEN
    ? trimmed.slice(0, MAX_HANDOFF_PROMPT_LEN)
    : trimmed;
}

/**
 * 扫描 skills/ 目录动态注册技能：复用 scanMarkdownDir，frontmatter 的 name/description+正文。
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

    // L3 隔离纪律（2026-08-30 对齐 Claude Code 主流，与 skillManager.createEntry 同源）：
    // 仅「文件夹形态」（入口为 SKILL.md）发现 resources/ scripts/；顶层裸 .md 的目录 = 技能池共享根，
    // 同级扫描会误并入其他技能的资源/脚本 → 污染。故裸 .md 为纯 L1/L2，带 L3 必须用文件夹+SKILL.md。
    const skillDir = dirname(absPath);
    const isFolderForm = isFolderFormSkill(absPath);
    const l3 = isFolderForm ? await discoverLayer3(skillDir) : { resources: [], scripts: [] };
    const hasL3 = l3.resources.length > 0 || l3.scripts.length > 0;

    return {
      file: relPath,
      name: entry.name,
      description: entry.frontmatter['description'] ?? undefined,
      layer3: hasL3 ? {
        resources: l3.resources.map((r) => ({ path: r.path, size: r.size, subdir: r.subdir })),
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
      // 路径穿越防护：复用 resolveSafePath（边界前缀 + sep，防兄弟目录前缀绕过），确保结果仍在 packDir 内
      if (!resolveSafePath(packDir, file)) {
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

/** 从 manifest.capabilities 解析能力声明（能力面与技能内容分离，经 capabilityMap 映射为工具白名单） */
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
 * 解析 rules 内容为规则字符串列表（ADR-025 档 3：rule 语义对齐，支持常见 markdown 写法）。
 *
 * 拆规则标准（保守、可预测、向前兼容）：
 *   - 列表行（- / * / 数字. ）→ 逐条规则（保留历史行为）；
 *   - 连续普通段落文本 → 整段合并为一条规则（段落是一个完整规则语义）；
 *   - 引用块（> ）→ 去 > 前缀后按段落处理（无空行分隔则并入相邻段落）；
 *   - 排除非规则内容：标题（# ）、代码块（``` 围栏）、HTML 注释、空行、分隔线、表格行。
 *
 * 确定性注入、装载时全量，不允许丢规则——无法识别的内容宁可并入最近的段落也不静默丢弃。
 */
function parseRules(content: string): string[] {
  if (!content) return [];
  const rules: string[] = [];
  // 段落累积缓冲：连续普通文本行合并为一条规则（保序）
  let paraBuffer: string[] = [];
  // 代码块围栏状态：围栏内的行跳过（不是规则）
  let inCodeBlock = false;

  /** 段落收尾：把累积的段落作为一条规则推入（保证"能识别的都不丢"） */
  const flushPara = (): void => {
    if (paraBuffer.length > 0) {
      // 段落内部多行用空格连接、压缩连续空白，保持单条语义
      const rule = paraBuffer.join(' ').replace(/\s+/g, ' ').trim();
      if (rule) rules.push(rule);
      paraBuffer = [];
    }
  };

  const lines = content.split('\n');
  for (const raw of lines) {
    const trimmed = raw.trim();

    // 代码块围栏：切换状态并收尾当前段落（围栏内行不作为规则）
    if (/^```/.test(trimmed)) {
      inCodeBlock = !inCodeBlock;
      flushPara();
      continue;
    }
    if (inCodeBlock) continue;

    // 非规则内容：空行 / HTML 注释 / 分隔线 / 表格行 → 段落边界
    if (trimmed === '' || /^<!--/.test(trimmed) || /^---+$/.test(trimmed) || trimmed.startsWith('|')) {
      flushPara();
      continue;
    }

    // 列表行（无序 -/* 或有序 n.）→ 逐条规则
    const listMatch = /^[-*]\s+(.+)$/.exec(trimmed) || /^\d+\.\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      flushPara(); // 列表项前后是独立规则边界
      const rule = listMatch[1]?.trim() ?? '';
      if (rule) rules.push(rule);
      continue;
    }

    // 标题（# 至 ######）→ 段落边界（标题本身不是规则，其下内容继续解析）
    if (/^#{1,6}\s+/.test(trimmed)) {
      flushPara();
      continue;
    }

    // 普通段落 / 引用块：累积进段落缓冲（引用块去 > 前缀）
    paraBuffer.push(trimmed.replace(/^>\s?/, ''));
  }
  flushPara();
  return rules;
}

/**
 * 安全读取内容文件，失败按缺省返回空串（内容文件可选）；超长截断防膨胀。
 * @param filePath 文件绝对路径
 * @param maxLen 最大长度（字符），超限截断（默认 MAX_CONTENT_FILE_LEN）
 */
async function readContentSafe(filePath: string, maxLen = MAX_CONTENT_FILE_LEN): Promise<string> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.length > maxLen ? content.slice(0, maxLen) : content;
  } catch {
    getLogger().warn({ file: filePath }, '角色包内容文件读取失败，按缺省处理');
    return '';
  }
}

/**
 * 角色包管理器
 */
export class RolePackManager extends ConfigResourceManager<RolePack> {
  /** 激活角色包变更回调（首次参数为变前，第二参数为变后；宿主据此同步 UI/记忆标题） */
  private onActiveChanged: ((from: string | null, to: string | null) => void) | null = null;
  /** 切换锁定触发回调（宿主据此展示「角色切换已锁定 2 分钟」提示） */
  private onSwitchLocked: ((reason: string, lockedSeconds: number) => void) | null = null;
  /** 当前激活的角色包名 */
  private activePackName: string | null = null;
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

  /** 宿主装配级兜底角色覆盖（§4.6：覆盖值须存在，否则回退内核常量 BUILTIN_FALLBACK_PACK） */
  private builtinFallbackRole: string | null = null;

  /** 组（宿主装配级）：组长角色包 + 组员名单（会议名单容器，非选择对象） */
  private rolePackTeams: readonly RolePackTeam[] = [];

  /**
   * 本轮表层装配视角（会议机制）：任务项级临时覆盖（persona/rules/skills 换、键不换）。
   * 仅在本轮 prepare 生效，用完即回——非会议/越界时置 null 回落 activePack；不改 activePack。
   */
  private roundAssemblyRole: string | null = null;

  /**
   * @param configDir 配置目录（角色包在 <configDir>/role-packs/ 下）
   */
  constructor(configDir?: string) {
    super(configDir, 'role-packs');
  }

  /**
   * 设置宿主装配级兜底角色覆盖（可选）：须指向存在的角色包，覆盖值不存在时回退内核常量。
   * 由装配层在 load() 前调用（AgentOptions.builtinFallbackRole）。
   */
  setBuiltinFallbackRole(role: string | null): void {
    this.builtinFallbackRole = role;
  }

  /**
   * 设置组数据（宿主装配级，会议名单容器）：组长角色包 + 组员名单。
   * 数据归宿主（用户级持久化），内核仅装配时校验（validateTeams）；组员仅会议参与，不用于日常。
   */
  setRolePackTeams(teams: readonly RolePackTeam[]): void {
    this.rolePackTeams = teams;
  }

  /**
   * 获取当前 activePack 作为组长的队伍（供宿主 UI 消费的只读快照）。
   * SSOT 出口：宿主拿 team 数据的唯一公共方法，不绕过内核直接读 globalState。
   * 内部成员名单走 activeTeamMembers 截断（会议消费端约束超限部分不参与），
   * 保证宿主看到的参与名单与内核会议实际消费一致。
   *
   * @returns 队伍快照（组长 + 截断后的组员）；activePack 非组长或无队伍时返回 null
   */
  getActiveTeam(): RolePackTeam | null {
    if (!this.activePackName) return null;
    const team = this.rolePackTeams.find((t) => t.leader === this.activePackName);
    if (!team) return null;
    return { leader: team.leader, members: [...this.activeTeamMembers] };
  }

  /**
   * 组数据校验（S4，装载后执行）：组长身份唯一 / 成员名单非空 / 引用悬空 / 组长组员互斥 → warning（不阻塞装载）。
   * 组员失效 → 会议时缺员跳过（resolveRoundAssemblyRole 内判定）；组长失效 → 该组失效（仅影响会议）。
   */
  private validateTeams(): void {
    const leaderCount = new Map<string, number>();
    for (const team of this.rolePackTeams) {
      if (team.members.length === 0) {
        getLogger().warn(
          { leader: team.leader },
          '组员名单为空，组不成立（仅影响会议，不影响日常）',
        );
      }
      if (!this.items.some((p) => p.meta.name === team.leader)) {
        getLogger().warn(
          { leader: team.leader },
          '组组长引用的角色包不存在（悬空引用，该组失效仅影响会议）',
        );
      }
      if (team.members.includes(team.leader)) {
        getLogger().warn(
          { leader: team.leader },
          '组长与组员身份互斥：组长不能同时是组员（该组成员名单含组长，会议时按组员跳过）',
        );
      }
      for (const member of team.members) {
        if (!this.items.some((p) => p.meta.name === member)) {
          getLogger().warn(
            { leader: team.leader, member },
            '组员引用的角色包不存在（悬空引用，会议时缺员跳过）',
          );
        }
      }
      if (team.members.length > MAX_TEAM_MEMBERS) {
        getLogger().warn(
          { leader: team.leader, count: team.members.length, max: MAX_TEAM_MEMBERS },
          '组员数量超上限（队长 1 + 组员 ≤ 4 = 5 人组）：超出部分不参与会议（仅影响会议）',
        );
      }
      leaderCount.set(team.leader, (leaderCount.get(team.leader) ?? 0) + 1);
    }
    for (const [leader, count] of leaderCount) {
      if (count > 1) {
        getLogger().warn({ leader, count }, '组长身份不唯一：一个角色包只能是一个组的组长');
      }
    }
  }

  /**
   * 设置本轮表层装配视角（会议机制）：任务项级临时覆盖。
   * 由 prepare 期按 active 步骤 rolePack 解析结果设置；非会议/越界 → null（回落 activePack）。
   */
  setRoundAssemblyRole(role: string | null): void {
    this.roundAssemblyRole = role;
  }

  /** 本轮表层装配视角（会议机制）：非会议返回 null（回落 activePack） */
  get roundAssemblyPerspective(): string | null {
    return this.roundAssemblyRole;
  }

  /**
   * 会议组员的**唯一消费入口**（SSOT 收口）：当前激活角色作为组长时的会议组员名单，超限截断至
   * `MAX_TEAM_MEMBERS` 名。
   *
   * 截断只发生在消费端——`rolePackTeams` 存储保持原样（超限数据不裁切，用户可自行修正），
   * 因此「超限仅影响会议、不影响日常」的语义成立。所有会议消费点（装配角色解析 / 上下文块 /
   * 会议步骤）必须走本 getter，禁止直连 `team.members`，否则「超出部分不参与会议」即成假契约。
   */
  private get activeTeamMembers(): readonly string[] {
    if (!this.activePackName) return [];
    const team = this.rolePackTeams.find((t) => t.leader === this.activePackName);
    return team ? team.members.slice(0, MAX_TEAM_MEMBERS) : [];
  }

  /**
   * 会议机制：解析本轮表层装配角色（范围校验前置，防 LLM 幻觉角色名）。
   * rolePack 必须 ∈ {组长(activePack)} ∪ {组员}；越界 → 忽略该覆盖 + warning 返回 null；
   * 组员角色包不存在（缺员）→ 跳过 + warning 返回 null。
   *
   * @param declared 任务项声明的 rolePack（无声明 = 非会议，返回 null）
   * @returns 有效覆盖角色名；无覆盖/越界/缺员返回 null
   */
  resolveRoundAssemblyRole(declared: string | undefined): string | null {
    if (!declared) return null;
    // 组长（activePack）恒有效
    if (declared === this.activePackName) return declared;
    // 组员：须在「组长 == activePack」的会议名单内（超限部分已被截断，不参与会议），且角色包存在
    const isMember = this.activeTeamMembers.includes(declared);
    if (isMember) {
      if (this.items.some((p) => p.meta.name === declared)) return declared;
      getLogger().warn(
        { declared, active: this.activePackName },
        '会议任务项声明的组员角色包不存在（缺员），忽略该覆盖',
      );
      return null;
    }
    getLogger().warn(
      { declared, active: this.activePackName },
      '会议任务项声明越界：rolePack 必须 ∈ {组长} ∪ {组员}，忽略该覆盖',
    );
    return null;
  }

  /**
   * 技能加载目标角色（会议机制）：packName 显式指定优先 → 本轮装配视角（会议）→ 激活角色包。
   * 会议内 skills 加载跟随任务项角色（组员技能正文读得到），键/工具面仍恒为 activePack。
   */
  private resolveSkillTarget(packName?: string): string | null {
    return packName ?? this.roundAssemblyRole ?? this.activePackName;
  }

  /**
   * 构建「组长 + 组员名单」上下文块（会议机制实施前提②：组/成员清单暴露给 LLM，防编造角色名）。
   * 仅当 activePack 是某个组的组长且名单非空时产出；非组长返回空串（不注入）。
   *
   * 内容只描述系统编排的会议机制，不指挥 LLM 自建任务表（确定性触发由 tryBuildMeetingPlan 承担，
   * 见 ADR-028 收敛补记）：LLM 在每步只需按当前步骤角色视角作答，并用 task_table_update 标记完成。
   */
  buildTeamContextBlock(): string {
    if (!this.activePackName) return '';
    const members = this.activeTeamMembers;
    if (members.length === 0) return '';
    return (
      `【小组会议角色（组长：${this.activePackName}；组员：${members.join(' / ')}）】` +
      `用户以「小组会议：主题」发起时，系统自动预置任务表（组员各一步发言 + 一步汇总），` +
      `无需你自建任务表；你只需按当前步骤角色视角作答，并用 task_table_update 将该步标记为 done 或 blocked。`
    );
  }

  /**
   * 会议机制：确定性输入触发（SSOT 单一入口，ADR-028 收敛补记）。
   *
   * 用户消息含「小组会议」**且** activePack 是某组组长 → 复用既有任务表泛型能力，
   * 程序化预置步骤：组员各一步（`rolePack=成员`，触发表层装配硬切换）+ 一步汇总（无 rolePack = 组长视角）。
   * 不引入会议引擎：仅用 PlanStep.rolePack 表层覆盖 + 既有步 turn 执行（orchestrator 直调 completeExternalTask）。
   *
   * 主题取自「小组会议」后文（冒号/逗号/空格分隔均可），为空则步骤仅标「发言/汇总」由 LLM 见用户消息展开。
   * 无 keyword / activePack 非组长 / 组名单空 → 返回 null（不触发，回落普通闭环）。
   *
   * @param input 用户输入
   * @returns 预置步骤（description + 可选 rolePack）；不触发返回 null
   */
  tryBuildMeetingPlan(input: string): Array<{ description: string; rolePack?: string }> | null {
    if (!this.activePackName) return null;
    if (!/小组会议/.test(input)) return null;
    const members = this.activeTeamMembers;
    if (members.length === 0) return null;
    const topic = input.replace(/^\s*小组会议\s*[:：,，]?\s*/, '').trim();
    const suffix = topic ? `：${topic}` : '';
    const steps: Array<{ description: string; rolePack?: string }> = members.map((m) => ({
      description: `${m} 发言${suffix}`,
      rolePack: m,
    }));
    steps.push({ description: `汇总各方观点${suffix}` });
    return steps;
  }

  // ── 生命周期 ──────────────────────────────────────

  /**
   * 启动加载：扫描含 manifest.json 的角色包文件夹（覆盖基类 loadItems——基类只支持单文件扫描，生命周期其余仍复用基类）。
   * 默认激活路径 = §4.1 单链：activePack（宿主注入）→ 兜底包（builtinFallbackRole ?? BUILTIN_FALLBACK_PACK）。
   */
  async load(activePack?: string): Promise<number> {
    const count = await this.scanRolePacks();
    this.validateTeams();
    if (activePack && this.items.some((p) => p.meta.name === activePack)) {
      this.setActivePackName(activePack);
    } else {
      if (activePack) {
        logger.warn({ activePack }, '激活角色包不存在，落兜底包');
      }
      this.activateFallback();
    }
    logger.info({ count, active: this.activePackName }, '角色包加载完成');
    return count;
  }

  /** 重载角色包：重新扫描 + 保持激活态（覆盖基类 reload，基类扫描无法覆盖文件夹包形态）；激活包被删 → 落兜底包（§4.1 单链） */
  async reload(): Promise<number> {
    const oldActiveName = this.activePackName;
    // 磁盘扫描 + 保留 loadExtraDir 注入的运行时项（retainRuntimeItems 记账合并，同名以磁盘为准）——
    // 与基类 reload 语义一致：重载不抹除无磁盘真理源的运行时注入用户角色包
    const scanned = await this.scanRolePacksForReload();
    this.items = this.retainRuntimeItems(scanned);
    this.validateTeams();
    const count = this.items.length;

    // 保持当前激活角色包（若仍存在）；否则落兜底包
    if (oldActiveName) {
      const found = this.items.find((p) => p.meta.name === oldActiveName);
      if (found) {
        this.setActivePackName(found.meta.name);
      } else {
        this.activateFallback();
        logger.warn(
          { oldActive: oldActiveName, newActive: this.activePackName },
          '激活角色包已被删除，落兜底包',
        );
      }
    } else {
      this.activateFallback();
    }

    logger.info({ count, active: this.activePackName }, '角色包已重载');
    return count;
  }

  /**
   * §4.1 单链兜底：激活兜底包（builtinFallbackRole ?? BUILTIN_FALLBACK_PACK）。
   * 兜底包运行时缺失（用户手动删文件）→ 无 persona 继续运行 + warning（§7 降级优先，不装配失败）。
   */
  private activateFallback(): void {
    const fallback =
      this.builtinFallbackRole && this.items.some((p) => p.meta.name === this.builtinFallbackRole)
        ? this.builtinFallbackRole
        : BUILTIN_FALLBACK_PACK;
    if (this.items.some((p) => p.meta.name === fallback)) {
      this.setActivePackName(fallback);
    } else {
      getLogger().warn(
        { fallback },
        '兜底角色包运行时缺失（构建期应拦截），无 persona 继续运行（降级优先）',
      );
      this.setActivePackName(null);
    }
  }

  /** 扫描角色包目录：每个子目录为一个角色包，须含 manifest.json；manifest.name 优先于文件夹名 */
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
   * 扫描角色包目录但只返回扫描结果（不改写 items）：供 reload 复用 retainRuntimeItems 合并逻辑。
   * 与 scanRolePacks 的差异：scanRolePacks 直接替换 items（load 场景），本方法返回纯扫描数组
   * （reload 场景还需与运行时注入项合并，不能整体覆盖）。
   */
  private async scanRolePacksForReload(): Promise<RolePack[]> {
    const dir = resolveSubdir(this.configDir, this.subdir);
    if (!dir) return [];
    return this.buildFromDir(dir);
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
      const manifestRaw = await readFile(manifestPath, 'utf-8');
      // manifest.json 必须完整解析不可截断，超限直接跳过装载（防超大 JSON 撑爆内存）
      if (manifestRaw.length > MAX_MANIFEST_LEN) {
        getLogger().warn(
          { manifestPath, size: manifestRaw.length, max: MAX_MANIFEST_LEN },
          'manifest.json 超出大小上限，跳过该角色包',
        );
        return null;
      }
      // 防御：VSCode 等编辑器保存 JSON 时可能加 UTF-8 BOM（U+FEFF），Node.js JSON.parse 不认
      manifest = JSON.parse(manifestRaw.replace(/^\uFEFF/, '')) as Record<string, unknown>;
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
      keywords: undefined,
      author: str(manifest['author']),
      formatVersion: str(manifest['formatVersion']) ?? DEFAULT_FORMAT_VERSION,
      interactionType: manifest['interactionType'] === 'companion' ? 'companion' : 'tool_assistant',
      aiIdentityDisclosure: manifest['aiIdentityDisclosure'] === false ? false : true,
      // 未成年人保护为强制项（非可配置）：恒为 'required'，与 validator「仅支持 required」一致；
      // 若 manifest 声明其他值，validator 会拒绝装载，故此处无需读取声明值。
      minorProtection: 'required',
      // 接手衔接提示词（自洽声明，宿主 prefill；空白视为未声明）
      handoffPrompt: parseHandoffPrompt(manifest['handoffPrompt']),
    };

    // 解析 L2 策略
    const strategy = parseStrategyNode(manifest['strategy']);

    // 内容文件约定俗成固定文件名（消除 manifest 路径声明，避免路径写错静默丢内容）
    // persona 需解析 frontmatter 提取 traits，正文仅取 body 部分
    const rawPersonaContent = await readContentSafe(join(packDir, DEFAULT_PERSONA_FILENAME));
    const { body: personaBody } = parseFrontmatter(rawPersonaContent);
    const personaContent = personaBody;
    const traits = parseTraits(rawPersonaContent);
    const rulesContent = await readContentSafe(join(packDir, DEFAULT_RULES_FILENAME));
    const rules = parseRules(rulesContent);

    // 内嵌技能：目录动态扫描 + frontmatter（manifest.skills 可选过滤；新增技能只写文件）
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

    // 能力声明（顶层数组，能力面与技能内容分离）
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
      // ConfigResource 约束字段（keywords 永远空数组——角色包已无自动匹配消费，手动切换唯一入口）
      name: meta.name,
      keywords: [],
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

  /**
   * 注册激活角色包变更监听：每次激活状态实际变化（切换 / 默认激活 / 回退）时回调。
   * @param handler 收到（from, to）；to 为 null 表示激活被清空；同名不变不触发
   */
  onRolePackActivated(handler: (from: string | null, to: string | null) => void): void {
    this.onActiveChanged = handler;
  }

  /**
   * 注册切换锁定触发监听：30s 内超过 5 次切换触发锁定时回调（2 分钟自动恢复）。
   * @param handler 收到（reason, lockedSeconds）；reason 为锁定原因描述
   */
  onRolePackSwitchLocked(handler: (reason: string, lockedSeconds: number) => void): void {
    this.onSwitchLocked = handler;
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
    // 幂等短路（SSOT）：同包重复激活是 no-op——无回调、无副作用，不应消耗切换限流配额。
    // 「激活目标 == 当前激活」这一事实归属操作本身（而非门面），保证原生 API 与门面语义一致。
    if (this.activePackName === name) {
      return true;
    }

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
      const lockedSeconds = Math.round(RolePackManager.AUTO_UNLOCK_MS / 1000);
      const lockReason = `30s 内 ${this.switchTimestamps.length} 次切换，限流锁定 ${lockedSeconds}s`;
      this.unlockTimer = setTimeout(() => {
        this.switchLocked = false;
        this.unlockAt = null;
        this.unlockTimer = null;
        this.switchTimestamps = [];
        logger.info('角色包切换锁已自动恢复');
      }, RolePackManager.AUTO_UNLOCK_MS);
      logger.warn('角色包切换过于频繁，已锁定 2 分钟');
      // 触发锁定回调：宿主据此展示锁定提示
      this.onSwitchLocked?.(lockReason, lockedSeconds);
    }

    this.setActivePackName(name);
    logger.info({ name }, '角色包已激活');
    return true;
  }

  /** 统一激活态赋值：实际变化时触发 onActiveChanged 回调（宿主同步 UI/记忆标题） */
  private setActivePackName(next: string | null): void {
    const prev = this.activePackName;
    this.activePackName = next;
    if (prev !== next) {
      try {
        this.onActiveChanged?.(prev, next);
      } catch (err) {
        logger.warn({ err, from: prev, to: next }, '角色包激活回调执行失败');
      }
    }
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
   * 枚举激活角色包的内嵌技能（渐进披露 L1 清单来源，供宿主技能三源聚合展示）。
   * 技能加载跟随本轮装配视角（会议内 = 任务项角色；非会议 = activePack）。
   * name 缺省时按文件名去扩展名推导；无装配角色返回空数组。SSOT：技能清单只由
   * 角色包自身持有，宿主不重复扫描目录。
   */
  listSkills(): Array<{ name: string; description?: string }> {
    const target = this.resolveSkillTarget();
    if (!target) return [];
    const pack = this.items.find((p) => p.meta.name === target);
    if (!pack) return [];
    return pack.skills
      .map((s) => ({
        name: s.name ?? this.deriveSkillNameFromFile(s.file ?? ''),
        description: s.description,
      }))
      .filter((s) => s.name.length > 0);
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
    // 判定「文件夹形态」复用 SKILL_MAIN_FILE 常量（SSOT），兼容 Windows 大小写变体（SKILL.MD）
    if (last.toLowerCase() === SKILL_MAIN_FILE.toLowerCase()) {
      return parts.pop() ?? ''; // 文件夹形式
    }
    return last.replace(/\.(md|markdown)$/i, ''); // 单文件形式
  }

  /** 按技能名在装配视角角色包中查找技能条目（跟随本轮装配视角）；frontmatter name 精确匹配优先，其次 file 路径推导；未找到返回 null */
  private findSkillByName(
    skillName: string,
    packName: string | undefined,
  ): { pack: RolePack; skill: RolePackManifestSkill } | null {
    const targetName = this.resolveSkillTarget(packName);
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
    // layer3 白名单前置检查：资源必须已由 scanPackSkills 发现并登记（与全局 SkillManager 同标准），
    // 防止未在清单内的路径（含兄弟目录前缀、escape 符）被 resolveSafePath 误放行
    const found = this.findSkillByName(skillName, packName);
    const resourceMeta = found?.skill.layer3?.resources.find((r) => r.path === resourcePath);
    if (!resourceMeta) return null;

    const skillDir = this.resolveSkillDir(skillName, packName);
    if (!skillDir) return null;

    // 路径穿越防护：双层——layer3 白名单 + resolveSafePath 边界前缀。
    // 读取基目录按条目来源 subdir 选择（resources/ 或 references/，B1 兼容主流 references/ 目录）
    const baseDir = resourceMeta.subdir ?? 'resources';
    const resourceFullPath = resolveSafePath(join(skillDir, baseDir), resourcePath);
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
    // layer3 白名单前置检查：脚本必须已由 scanPackSkills 发现并登记（与 getSkillScriptInfo 同标准），
    // 防止未在清单内的路径被 resolveSafePath 误放行（对齐 readSkillResource 的双层防护）
    const found = this.findSkillByName(skillName, packName);
    const registered = found && found.skill.layer3?.scripts.some((s) => s.path === scriptPath);
    if (!registered) return null;

    const skillDir = this.resolveSkillDir(skillName, packName);
    if (!skillDir) return null;

    // 路径穿越防护：双层——layer3 白名单 + resolveSafePath 边界前缀（确保 scriptPath 不逃逸技能 scripts/ 目录）
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

  /**
   * 加载用户目录的角色包（宿主调用，用于扩展内置角色包池）
   *
   * 与 load() 的区别：
   * - load() 从 configDir/role-packs/ 扫描内置角色包（有磁盘真理源）
   * - loadExtraDir() 从额外目录扫描用户角色包（运行时注入，reload 时保留）
   *
   * 设计哲学：内核保持单一真理源（configDir/role-packs/），宿主负责扩展用户目录。
   * 用户角色包通过 registerRuntimeItem 注入，reload() 时会保留（同名冲突以磁盘为准）。
   *
   * @param dir 用户角色包目录（每个子目录为一个角色包，须含 manifest.json）
   * @returns 加载的角色包数量
   */
  async loadExtraDir(dir: string): Promise<number> {
    let count = 0;
    try {
      // buildFromDir 接受任意目录路径，不依赖 configDir
      const packs = await this.buildFromDir(dir);
      for (const pack of packs) {
        // 跳过已存在的角色包（内置优先）
        if (this.items.some((p) => p.meta.name === pack.meta.name)) {
          logger.info({ name: pack.meta.name }, '用户角色包与内置重名，跳过');
          continue;
        }
        this.registerRuntimeItem(pack);
        count++;
      }
    } catch (err) {
      logger.warn({ dir, err }, '加载用户角色包失败');
    }
    logger.info({ count, dir }, '用户角色包加载完成');
    return count;
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
