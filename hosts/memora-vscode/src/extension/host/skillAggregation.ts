/**
 * 宿主技能三源聚合（SSOT 收紧，2026-08-25）
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
 * 同名去重优先级（数值小 = 胜出）。**角色包 > 用户 > 内置**（2026-09-22 反转 builtin/user 位，
 * 对齐主流「用户可覆盖内置」）——与（a）内核装载层 loadExtraDir 用户同名覆盖内置（S5）同向；
 * （b）注入面（`skillPromptFor` / 内核 `read_skill`）同向：角色包优先、全局池次之。
 * 反转前为「内置 > 用户」——与内核装载层方向相反，UI 呈现与实际生效者错位。
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
      push(sourceOf(s.filePath, s.layer, configDir, userSkillsDir), s.name, s.description, s.filePath);
    }
  }

  // 源 2：激活角色包内嵌技能（RolePackManager.listSkills 只读枚举）
  const rpm = agent.rolePackManager;
  if (rpm) {
    for (const s of rpm.listSkills ? rpm.listSkills() : []) {
      push('rolepack', s.name, s.description);
    }
  }

  return [...byName.values()].sort((a, b) => {
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
 * ⚠️ 顺序是契约（2026-09-22 收口）：此前宿主有**两份**各自实现且**方向相反**——
 * composer 注入（本模块，2026-09-21 订正为角色包优先）与设置面板 L2 预览
 * （settingsPanel 原「全局优先」未同步），同名技能双存时「面板里点开看到的正文」
 * 与「composer 注入 / LLM `read_skill` 拿到的正文」分叉。
 * 现统一收口到本函数：**新增消费点一律调它，勿再自写两级回退**。
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