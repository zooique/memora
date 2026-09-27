/**
 * 宿主技能三源聚合（SSOT 收紧）
 *
 * 技能清单唯一来源 = 内核自身持有的三源，宿主只做「展示聚合」与「按名取提示」：
 *   1. 系统内置 —— <configDir>/skills/（SkillManager.load 磁盘真理源）
 *   2. 启用角色包内置 —— 激活角色包内嵌技能（RolePackManager.listSkills 只读枚举）
 *   3. 用户本地目录 —— <userSkillsDir>/（SkillManager.loadExtraDir 运行时注入）
 *
 * settingsPanel / chatPanel 共用本模块，避免两处各自拼接清单造成第二份来源。
 * 来源判定用 filePath 前缀（configDir 与 userSkillsDir 天然不重叠，同名冲突按
 * 去重表 DEDUP_PRIORITY 裁决——用户可覆盖内置，见下），不改内核 SkillEntry 契约。
 */
import type { Agent } from '@zooique/memora';
import { join } from 'node:path';
import type { SkillDto } from '../../shared/protocol.js';

/** 技能来源三分类（与 SkillDto.layer 对应） */
export type SkillSource = 'builtin' | 'rolepack' | 'user';

/** 三源聚合所需上下文 */
export interface SkillAggregateContext {
  agent: Agent;
  /** 系统内置配置目录（<configDir>/skills/ 所在父目录） */
  configDir: string;
  /** 用户本地技能目录 */
  userSkillsDir: string;
}

/** 来源排序权重（内置优先，其次角色包，最后用户） */
const SOURCE_ORDER: Record<SkillSource, number> = { builtin: 0, rolepack: 1, user: 2 };

/**
 * 判断内核技能条目归属源：优先按 filePath 前缀命中（userSkillsDir → user，configDir/skills → builtin），
 * 无路径/未命中回退内核 layer（project=用户兜底，agent=内置）。
 */
function sourceOf(
  filePath: string | undefined,
  layer: string | undefined,
  configDir: string,
  userSkillsDir: string,
): SkillSource {
  if (filePath) {
    if (userSkillsDir && filePath.startsWith(userSkillsDir)) return 'user';
    if (filePath.startsWith(join(configDir, 'skills'))) return 'builtin';
  }
  return layer === 'project' ? 'user' : 'builtin';
}

/**
 * 同名去重优先级（数值小 = 胜出）。**角色包 > 用户 > 内置**（对齐主流「用户可覆盖内置」）——
 * 与（a）内核装载层 loadExtraDir 用户同名覆盖内置同向；
 * （b）注入面（`skillPromptFor` / 内核 `read_skill`）同向：角色包优先、全局池次之。
 * 若为「内置 > 用户」则与内核装载层方向相反，UI 呈现与实际生效者错位。
 *
 * ⚠️ 与 `SOURCE_ORDER` 是两件事，不可合并：本表管**同名时留谁**，`SOURCE_ORDER` 管**列表怎么排**。
 */
const DEDUP_PRIORITY: Record<SkillSource, number> = { rolepack: 0, user: 1, builtin: 2 };

/**
 * 三源聚合技能清单（settingsPanel / chatPanel 共用，单一真理源）。
 * 同名去重（**角色包 > 用户 > 内置**，DEDUP_PRIORITY 裁决）；按来源排序
 * （内置 → 角色包 → 用户，SOURCE_ORDER），组内按名。
 */
export function listVisibleSkills(ctx: SkillAggregateContext): SkillDto[] {
  const { agent, configDir, userSkillsDir } = ctx;
  const byName = new Map<string, SkillDto>();
  const push = (
    layer: SkillSource,
    name: string,
    description: string | undefined,
    filePath?: string,
  ): void => {
    if (!name) return;
    const prev = byName.get(name);
    // 新来源优先级不高于已有 → 保留已有（去重方向必须对齐注入面，故不可用「先到先得」）
    if (prev && DEDUP_PRIORITY[prev.layer ?? 'builtin'] <= DEDUP_PRIORITY[layer]) return;
    byName.set(name, { name, description: description ?? '', filePath, layer });
  };

  // 源 1 + 3：SkillManager.list（内置 configDir/skills + 用户 loadExtraDir 注入）
  const sm = agent.skills;
  if (sm) {
    for (const s of sm.list) {
      push(
        sourceOf(s.filePath, s.layer, configDir, userSkillsDir),
        s.name,
        s.description,
        s.filePath,
      );
    }
  }

  // 源 2：激活角色包内嵌技能（RolePackManager.listSkills 只读枚举）
  const rpm = agent.rolePackManager;
  if (rpm) {
    for (const s of rpm.listSkills ? rpm.listSkills() : []) {
      push('rolepack', s.name, s.description);
    }
  }

  // 禁用标记：真源 = 内核 `disabledSkillNames`（即 `get()` 判据的同一集合）。
  // 宿主**不自读**一份 workspace 配置——两源会在 reloadConfig 重设禁用集后分叉，
  // 出现「UI 说已禁用、实际仍生效」（或反之）。此处只做**标注**，不隐藏条目（见 SkillDto.disabled）。
  //
  // ⚠️ **作用域限全局技能池（builtin/user）**：`disabledNames` 是 `SkillManager` 的判据集，
  // 而角色包技能走 `rolePackManager`、**不经** `SkillManager.get()` ⇒ 对角色包技能禁用本就无效。
  // 故此处不得给 `rolepack` 层打标——那是 UI 谎报（「声明与实现不同源」）。
  //
  // **定案**：角色包技能**与禁用清单免疫**——它属于当前角色、与角色融为一体，
  // 启停语义 = **随角色启停**（不激活该角色即不可用，切换角色即技能集切换）。不存在「按名禁用
  // 角色包技能」的合法请求：想停 = 换角色 / 改角色包内容，而非禁用清单加名。本作用域是**定案约束**。测试锚点：
  // `listVisibleSkills` 禁标守卫（rolepack 层禁打标）+ `isSkillDisabled` 判据同源守卫。
  const disabledNames = new Set(sm?.disabledSkillNames ?? []);
  return [...byName.values()]
    .map((s) => {
      const inGlobalPool = s.layer === 'builtin' || s.layer === 'user';
      return inGlobalPool && disabledNames.has(s.name) ? { ...s, disabled: true } : s;
    })
    .sort((a, b) => {
      if (SOURCE_ORDER[a.layer ?? 'builtin'] !== SOURCE_ORDER[b.layer ?? 'builtin']) {
        return SOURCE_ORDER[a.layer ?? 'builtin'] - SOURCE_ORDER[b.layer ?? 'builtin'];
      }
      return a.name.localeCompare(b.name);
    });
}

/** 技能正文解析结果（含命中来源，供调用方决定组装格式） */
export interface ResolvedSkill {
  /** 技能正文（不含任何包装） */
  content: string;
  /** 命中来源：rolepack = 角色包内嵌技能；global = 全局技能池（内置 + 用户目录） */
  source: 'rolepack' | 'global';
}

/**
 * 技能正文解析**唯一收口**（SSOT）：角色包 → 全局（与内核 `read_skill` 同序）。
 *
 * ⚠️ 顺序是契约：composer 注入（本模块，角色包优先）与设置面板 L2 预览
 * 必须同序（「全局优先」与之方向相反），否则同名技能双存时「面板里点开看到的正文」
 * 与「composer 注入 / LLM `read_skill` 拿到的正文」分叉。
 * 本函数是唯一收口：**新增消费点一律调它，勿再自写两级回退**。
 *
 * @returns 命中则返回 `{ content, source }`；两源都没有返回 null（空态由调用方决定）
 */
export async function resolveSkill(agent: Agent, skillName: string): Promise<ResolvedSkill | null> {
  // 第一级：激活角色包内嵌技能（当前人格视角）
  const rpm = agent.rolePackManager;
  if (rpm) {
    const content = await rpm.readSkillContent(skillName);
    if (content) return { content, source: 'rolepack' };
  }
  // 第二级：全局技能池（内置 + 用户目录）
  const sm = agent.skills;
  const global = sm ? sm.get(skillName) : null;
  if (global?.content) return { content: global.content, source: 'global' };
  return null;
}

/**
 * 按技能名生成提示块（composer 选中技能后注入内核，SSOT 彻底化）。
 *
 * 解析顺序收口于 `resolveSkill`（角色包 → 全局）；格式沿用内核 SSOT：命中全局时走
 * `SkillManager.buildSystemPrompt`（内核唯一格式源），命中角色包时按同格式组装。
 * 返回空串表示技能不存在（host 不注入，不影响正常发送）。
 */
export async function skillPromptFor(agent: Agent, skillName: string): Promise<string> {
  const resolved = await resolveSkill(agent, skillName);
  if (!resolved) return '';
  if (resolved.source === 'global' && agent.skills) {
    return agent.skills.buildSystemPrompt(skillName);
  }
  return `【当前技能】${skillName}\n${resolved.content}`;
}

/**
 * 技能是否因「已禁用」而不可用。
 *
 * 为何需要：用户通道（composer 下拉按名指定）在技能被禁用时**静默落空** ——
 * `skillPromptFor` 按既有契约返回空串「技能不存在，不影响正常发送」（该契约本身是对的，
 * 此处不改），于是消息照常发出、技能未注入、界面零提示。对照主流（Claude Code / WorkBuddy
 * 的 `off` 态）按名调用**明确报错**。本函数供调用方补上「响亮失败」所需的判据。
 *
 * 判据与 `resolveSkill` **同序**（角色包 → 全局池），不可自行反序：
 *   ① 角色包内嵌同名技能命中 → **未禁用**（`disabledNames` 是 `SkillManager` 的判据集，
 *      对 `rolePackManager` 无管辖权——角色包技能随角色启停、对禁用集免疫，见
 *      `listVisibleSkills` 内的定案声明）；
 *   ② 全局池快照（`list`，**含**禁用项）内确实存在该名且命中 `disabledSkillNames` → 已禁用。
 *
 * ⚠️ 判据源必须是内核 `disabledSkillNames`（**实际生效集**），**不得**改读宿主 workspace 配置：
 * 两源会在 `reloadConfig` 重设禁用集后分叉，导致「UI 说已禁用、实际仍生效」（或反之）。
 *
 * 名字既不在角色包也不在全局池 ⇒ 属「技能不存在」而非「已禁用」，返回 false ——
 * 两种落空的用户提示语义不同，由调用方分流；本函数只回答「禁用与否」这一问。
 */
export function isSkillDisabled(agent: Agent, skillName: string): boolean {
  const sm = agent.skills;
  if (!sm || !sm.disabledSkillNames.includes(skillName)) return false;
  const rpm = agent.rolePackManager;
  if (rpm && rpm.listSkills ? rpm.listSkills().some((s) => s.name === skillName) : false)
    return false;
  return sm.list.some((s) => s.name === skillName);
}

/**
 * 找出禁用集里**未匹配任何技能**的名字。
 *
 * 语义（用户定案）：**「未找到需要禁用的技能」**——如实报告匹配结果，不归咎用户写错，
 * 从而兼容「提前禁用尚未安装的技能」（配置随仓库/机器分发时合法）。提示是非阻断的
 * UI 展示，不影响禁用判定本身。
 *
 * 判据：`disabledNames`（内核真源）∖ 三源清单名集（`listVisibleSkills` 聚合结果）。
 * ⚠️ 名单只用 `listVisibleSkills` **同一次聚合**，不得自造第二份技能名集 —— 否则与
 * UI 展示的清单分叉（血的教训：同一清单多通道仅改一处）。因此入参直接收
 * 已聚合的 `SkillDto[]` 而非重新聚合，调用方（settingsPanel.loadSkills）复用既有结果。
 *
 * @param disabledNames 禁用名（内核 `agent.skills.disabledSkillNames`，真源）
 * @param visibleSkills 三源聚合清单（`listVisibleSkills` 的结果，与 UI 展示同名集）
 * @returns 未匹配的禁用名（保持配置填写顺序）
 */
export function findUnmatchedDisabled(
  disabledNames: string[],
  visibleSkills: SkillDto[],
): string[] {
  if (disabledNames.length === 0) return [];
  const visible = new Set(visibleSkills.map((s) => s.name));
  return disabledNames.filter((n) => !visible.has(n));
}
