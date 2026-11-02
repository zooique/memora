/**
 * 项目级来源信任门 · 宿主侧单测
 *
 * 锁住四件事（内核扫描行为已由内核测试覆盖，本文件只验宿主编排）：
 *   1. 单点推导：`projectAssetDirsFor` 同时负责「信任门判定」与「目录推导」，
 *      调用方不再自行拼目录（B 修复的回归锁）；
 *   2. 信任门判据：未信任 ⇒ 目录对为空（装配拿不到项目级目录实参）；
 *   3. 注入顺序：先 loadExtraDir('project')，再 resync（顺序反了会错记分账 / 覆盖方向漂移）；
 *   4. 授予信任后的补注入会同时重扫技能与角色包（不重启即生效的宿主侧承诺）。
 */
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@zooique/memora';
import { injectProjectAssets, projectAssetDirsFor } from '../userAssets/projectScope.js';

/** 工作区根（测试夹具，只用于推导目录） */
const WORKSPACE = join('/w');

/** 预期目录对（由单点函数推导，测试不复刻拼接逻辑以外的口径） */
const DIRS = {
  skills: join(WORKSPACE, '.memora', 'skills'),
  rolePacks: join(WORKSPACE, '.memora', 'role-packs'),
} as const;

/**
 * 构造记录调用的 Agent 桩（只实现项目级注入用到的四个方法）
 * @returns agent 桩 + 调用记录数组
 */
function makeRecordingAgent(): { agent: Agent; calls: string[] } {
  const calls: string[] = [];
  const agent = {
    skills: {
      loadExtraDir: vi.fn(async (dir: string, tier?: string) => {
        calls.push(`skills.loadExtraDir:${dir}:${tier}`);
      }),
      resyncUserSkills: vi.fn(async () => {
        calls.push('skills.resync');
        return { added: 0, removed: [], updated: [] };
      }),
    },
    rolePacks: {
      loadExtraDir: vi.fn(async (dir: string, tier?: string) => {
        calls.push(`rolePacks.loadExtraDir:${dir}:${tier}`);
      }),
      resyncUserPacks: vi.fn(async (dir: string, tier?: string) => {
        calls.push(`rolePacks.resync:${dir}:${tier}`);
        return { added: 0, removed: [], updated: [] };
      }),
    },
  } as unknown as Agent;
  return { agent, calls };
}

describe('projectAssetDirsFor · 单点推导 + 信任门判据', () => {
  it('未信任工作区 ⇒ 空目录对（项目级不注入，用户级/内置照常由各自参数注入）', () => {
    expect(projectAssetDirsFor({ isTrusted: false, workspaceFolderPath: WORKSPACE })).toEqual({});
  });

  it('已信任工作区 ⇒ 由工作区根推导 `.memora/skills` 与 `.memora/role-packs`', () => {
    expect(projectAssetDirsFor({ isTrusted: true, workspaceFolderPath: WORKSPACE })).toEqual(DIRS);
  });

  it('无工作区 ⇒ 空目录对（不回填、不抛错）', () => {
    expect(projectAssetDirsFor({ isTrusted: true })).toEqual({});
    expect(projectAssetDirsFor({ isTrusted: false })).toEqual({});
  });
});

describe('injectProjectAssets · 授予信任后的补注入顺序', () => {
  it('先注入 project 档位、再重扫技能与角色包（顺序即覆盖方向）', async () => {
    const { agent, calls } = makeRecordingAgent();
    await injectProjectAssets(agent, DIRS);
    expect(calls).toEqual([
      `skills.loadExtraDir:${DIRS.skills}:project`,
      `rolePacks.loadExtraDir:${DIRS.rolePacks}:project`,
      'skills.resync',
      `rolePacks.resync:${DIRS.rolePacks}:project`,
    ]);
  });

  it('未信任（空目录对）⇒ 零动作（不扫描、不重扫）', async () => {
    const { agent, calls } = makeRecordingAgent();
    await injectProjectAssets(
      agent,
      projectAssetDirsFor({ isTrusted: false, workspaceFolderPath: WORKSPACE }),
    );
    expect(calls).toEqual([]);
  });
});
