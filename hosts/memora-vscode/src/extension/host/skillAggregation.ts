/**
 * 宿主技能三源聚合（SSOT 收紧，2026-08-25）
 *
 * 技能清单唯一来源 = 内核自身持有的三源，宿主只做「展示聚合」与「按名取提示」：
 *   1. 系统内置 —— <configDir>/skills/（SkillManager.load 磁盘真理源）
 *   2. 启用角色包内置 —— 激活角色包内嵌技能（RolePackManager.listSkills 只读枚举）
 *   3. 用户本地目录 —— <userSkillsDir>/（SkillManager.loadExtraDir 运行时注入）
 *
 * settingsPanel / chatPanel 共用本模块，避免两处各自拼接清单造成第二份来源。
 * 来源判定用 filePath 前缀（configDir 与 userSkillsDir 天然不重叠，同名技能已被内核 loadExtraDir
 * 的「内置优先去重」保证不冲突），不改内核 SkillEntry 契约。
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
 * 三源聚合技能清单（settingsPanel / chatPanel 共用，单一真理源）。
 * 同名去重（内置优先）；按来源排序（内置 → 角色包 → 用户），组内按名。
 */
export function listVisibleSkills(ctx: SkillAggregateContext): SkillDto[] {
  const { agent, configDir, userSkillsDir } = ctx;
  const out: SkillDto[] = [];
  const seen = new Set<string>();
  const push = (
    layer: SkillSource,
    name: string,
    description: string | undefined,
    keywords: readonly string[],
    trigger?: RegExp,
    filePath?: string,
  ): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ name, description: description ?? '', keywords: [...keywords], trigger: trigger?.source, filePath, layer });
  };

  // 源 1 + 3：SkillManager.list（内置 configDir/skills + 用户 loadExtraDir 注入）
  const sm = agent.skills;
  if (sm) {
    for (const s of sm.list) {
      push(sourceOf(s.filePath, s.layer, configDir, userSkillsDir), s.name, s.description, s.keywords, s.trigger, s.filePath);
    }
  }

  // 源 2：激活角色包内嵌技能（RolePackManager.listSkills 只读枚举）
  const rpm = agent.rolePackManager;
  if (rpm) {
    for (const s of rpm.listSkills ? rpm.listSkills() : []) {
      push('rolepack', s.name, s.description, []);
    }
  }

  return out.sort((a, b) => {
    if (SOURCE_ORDER[a.layer ?? 'builtin'] !== SOURCE_ORDER[b.layer ?? 'builtin']) {
      return SOURCE_ORDER[a.layer ?? 'builtin'] - SOURCE_ORDER[b.layer ?? 'builtin'];
    }
    return a.name.localeCompare(b.name);
  });
}

/**
 * 按技能名生成提示块（composer 选中技能后注入内核，SSOT 彻底化）。
 * 两级回退与内核 read_skill 同序：全局 SkillManager → 激活角色包内嵌技能。
 * 返回空串表示技能不存在（host 不注入，不影响正常发送）。
 */
export async function skillPromptFor(agent: Agent, skillName: string): Promise<string> {
  const sm = agent.skills;
  const global = sm ? sm.get(skillName) : null;
  if (global) {
    // buildSystemPrompt 输出「【当前技能】name\ncontent」（SSOT 统一格式）
    return sm!.buildSystemPrompt(skillName);
  }
  const rpm = agent.rolePackManager;
  if (rpm) {
    const content = await rpm.readSkillContent(skillName);
    if (content) return `【当前技能】${skillName}\n${content}`;
  }
  return '';
}