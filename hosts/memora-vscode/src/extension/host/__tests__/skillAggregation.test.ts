/**
 * 宿主技能三源聚合单元测试（SSOT 收紧，2026-08-25）
 *
 * 锁住三类不变量，防「内置显示为用户」类来源错标复发：
 *   1. 来源判定：filePath 前缀 → builtin/user；rolePackManager → rolepack
 *   2. 同名去重：内置优先
 *   3. 排序：内置 → 角色包 → 用户
 * 以及 skillPromptFor 的两级回退（全局 SkillManager → 激活角色包）。
 */
import { describe, it, expect } from 'vitest';
import type { Agent } from '@zooique/memora';
import { join } from 'node:path';
import { listVisibleSkills, skillPromptFor } from '../skillAggregation.js';

const configDir = 'C:/app/dist/extension';
const userSkillsDir = 'C:/Users/t/.vscode/globalStorage/skills';

/** 构造最小 Agent 桩：skills（全局）+ rolePackManager（角色包技能）两级来源 */
function makeAgent(opts: {
  global: Array<{ name: string; filePath: string; description?: string; layer?: string }>;
  roleSkills?: Array<{ name: string; description?: string }>;
  roleContent?: { [name: string]: string };
}): Agent {
  return {
    skills: {
      list: opts.global.map((g) => ({
        name: g.name,
        description: g.description,
        filePath: g.filePath,
        layer: (g.layer ?? 'project') as 'agent' | 'project',
      })),
      get: (n: string) => opts.global.find((g) => g.name === n) ?? null,
      buildSystemPrompt: (n: string) => `【当前技能】${n}`,
    },
    rolePackManager: {
      listSkills: () => opts.roleSkills ?? [],
      readSkillContent: async (n: string) => opts.roleContent?.[n] ?? null,
    },
  } as unknown as Agent;
}

describe('listVisibleSkills · 三源技能聚合', () => {
  it('来源判定：configDir → builtin，userSkillsDir → user，角色包 → rolepack，并按序排列', () => {
    const agent = makeAgent({
      global: [
        { name: '内置A', filePath: join(configDir, 'skills', 'a.md') },
        { name: '用户B', filePath: join(userSkillsDir, 'b.md') },
      ],
      roleSkills: [{ name: '角色C' }],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    expect(out.map((s) => `${s.layer}:${s.name}`)).toEqual([
      'builtin:内置A',
      'rolepack:角色C',
      'user:用户B',
    ]);
  });

  it('同名去重：内置优先于用户', () => {
    const agent = makeAgent({
      global: [
        { name: '同名', filePath: join(configDir, 'skills', 'dup.md') },
        { name: '同名', filePath: join(userSkillsDir, 'dup.md') },
      ],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    expect(out).toHaveLength(1);
    expect(out[0].layer).toBe('builtin');
  });

  it('无路径回退：内核 layer=project 视作用户、agent 视作内置', () => {
    const agent = makeAgent({
      global: [
        { name: '无路径用户', filePath: '', layer: 'project' },
        { name: '无路径内置', filePath: '', layer: 'agent' },
      ],
    });
    const out = listVisibleSkills({ agent, configDir, userSkillsDir });
    expect(out.find((s) => s.name === '无路径用户')?.layer).toBe('user');
    expect(out.find((s) => s.name === '无路径内置')?.layer).toBe('builtin');
  });
});

describe('skillPromptFor · 两级回退', () => {
  it('先查全局 SkillManager，命中返回内核 buildSystemPrompt', async () => {
    const agent = makeAgent({
      global: [{ name: 'g', filePath: join(configDir, 'skills', 'g.md') }],
    });
    expect(await skillPromptFor(agent, 'g')).toBe('【当前技能】g');
  });

  it('全局未命中回退激活角色包内嵌技能正文', async () => {
    const agent = makeAgent({
      global: [],
      roleContent: { r: '角色包正文' },
    });
    expect(await skillPromptFor(agent, 'r')).toBe('【当前技能】r\n角色包正文');
  });

  it('两级均未命中返回空串（host 不注入）', async () => {
    const agent = makeAgent({ global: [] });
    expect(await skillPromptFor(agent, '不存在')).toBe('');
  });
});