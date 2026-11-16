/**
 * 草稿页配置面测试 —— 无 Agent 的技能三源聚合（`buildDraftSkillList`）
 *
 * 锁住的判据：
 *   ① 全局池三源（内置 / 用户 / 项目）都能在没有 Agent 时被扫到；
 *   ② 角色包内嵌技能经注入的 loader 进入同一份清单（与角色页同一扫描器）；
 *   ③ 同名去重仍走 `listVisibleSkills` 的既有优先级（角色包 > 项目 > 用户 > 内置）；
 *   ④ 禁用集标注来自内核生效集（不是宿主自读副本）；
 *   ⑤ 角色包 loader 返回 null 时降级为全局池，不抛错。
 *
 * 用真实内核 `SkillManager` 扫真临时目录（不桩扫描器）——桩掉就会测成「桩自己的语义」。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RolePackManager } from '@zooique/memora';
import { makeTempDir } from '../../__tests__/helpers/tmpDir.js';
import { buildDraftSkillList } from '../helpers/draftConfigSurface.js';
import type { RolePackLoader } from '../../extension/host/rolePackCatalog.js';

// vscode 桩：被测聚合链经 `skillAggregation → userAssets/path` 值导入 `vscode.l10n`；
// 禁用集经唯一读点 `skillSync.readDisabledSkills` 读 `memora.disabledSkills`（默认空数组）。
vi.mock('vscode', () => ({
  l10n: { t: (message: string) => message },
  workspace: {
    getConfiguration: vi.fn(() => ({ get: (_key: string, def?: unknown) => def })),
  },
}));

/**
 * 临时改禁用集读值（`memora.disabledSkills`）
 *
 * 用完必须还原：`clearAllMocks` 只清调用记录、不清实现，泄漏会让后续用例读到不同配置。
 *
 * @param names 要返回的禁用名
 * @returns 还原函数（在 finally 中调用）
 */
function mockDisabled(names: string[]): () => void {
  const cfg = vscode.workspace.getConfiguration as unknown as {
    getMockImplementation(): (() => unknown) | undefined;
    mockImplementation(fn: () => unknown): void;
    mockReturnValue(value: unknown): void;
  };
  const prev = cfg.getMockImplementation();
  cfg.mockReturnValue({
    get: (key: string, def?: unknown) => (key === 'disabledSkills' ? names : def),
  });
  return () => {
    if (prev) cfg.mockImplementation(prev);
  };
}

/**
 * 在指定目录写一个单文件技能（frontmatter name/description + 正文）
 *
 * @param dir 技能目录（不存在则创建）
 * @param file 文件名（含 .md）
 * @param name frontmatter 里的技能名
 * @param body 正文（仅用于确认读到的是这一份）
 */
function writeSkill(dir: string, file: string, name: string, body = '正文'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, file),
    `---\nname: ${name}\ndescription: ${name} 描述\n---\n${body}`,
    'utf8',
  );
}

/** 造一个只提供 `listSkills` 的角色包管理器桩（本用例只消费技能枚举面） */
function rolePackStub(skills: { name: string; description?: string }[]): RolePackManager {
  return { listSkills: () => skills } as unknown as RolePackManager;
}

/** 造一个三源目录齐备的草稿现场 */
function setupDirs(): {
  configDir: string;
  userSkillsDir: string;
  projectSkillsDir: string;
} {
  const root = makeTempDir('memora-draft-config-');
  const configDir = join(root, 'config');
  const userSkillsDir = join(root, 'user-skills');
  const projectSkillsDir = join(root, 'project-skills');
  writeSkill(join(configDir, 'skills'), 'builtin.md', '内置技能');
  writeSkill(userSkillsDir, 'user.md', '用户技能');
  writeSkill(projectSkillsDir, 'project.md', '项目技能');
  return { configDir, userSkillsDir, projectSkillsDir };
}

describe('buildDraftSkillList · 草稿页无 Agent 的技能聚合', () => {
  it('四源合并：内置 + 用户 + 项目 + 角色包，来源标注与展示顺序按既有口径', async () => {
    const dirs = setupDirs();
    const load: RolePackLoader = async () => rolePackStub([{ name: '角色技能' }]);

    const skills = await buildDraftSkillList({
      ...dirs,
      rolePackName: '草稿角色',
      loadRolePackManager: load,
    });

    expect(skills.map((s) => s.name).sort()).toEqual(
      ['内置技能', '用户技能', '项目技能', '角色技能'].sort(),
    );
    const layerOf = (name: string) => skills.find((s) => s.name === name)!.layer;
    expect(layerOf('内置技能')).toBe('builtin');
    expect(layerOf('用户技能')).toBe('user');
    expect(layerOf('项目技能')).toBe('project');
    expect(layerOf('角色技能')).toBe('rolepack');
    // 展示排序：项目 → 内置 → 角色包 → 用户（SOURCE_ORDER，与去重优先级是两件事）
    expect(skills.map((s) => s.layer)).toEqual(['project', 'builtin', 'rolepack', 'user']);
  });

  it('同名去重：角色包压过全局池（DEDUP_PRIORITY，与注入面同向）', async () => {
    const dirs = setupDirs();
    writeSkill(dirs.userSkillsDir, 'dup.md', '同名技能');
    const load: RolePackLoader = async () => rolePackStub([{ name: '同名技能' }]);

    const skills = await buildDraftSkillList({
      ...dirs,
      rolePackName: '草稿角色',
      loadRolePackManager: load,
    });

    const dup = skills.filter((s) => s.name === '同名技能');
    expect(dup).toHaveLength(1);
    expect(dup[0]!.layer).toBe('rolepack');
  });

  it('禁用集来自内核生效集：仅标注禁用，不隐藏条目（与设置页同一判据）', async () => {
    const dirs = setupDirs();
    const restore = mockDisabled(['用户技能']);
    try {
      const skills = await buildDraftSkillList({
        ...dirs,
        rolePackName: '草稿角色',
        loadRolePackManager: async () => rolePackStub([]),
      });

      const disabled = skills.find((s) => s.name === '用户技能')!;
      expect(disabled.disabled).toBe(true);
      // 只在全局池层打标（角色包技能对禁用集免疫）
      expect(skills.find((s) => s.name === '内置技能')!.disabled).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('角色包读不到（loader 返回 null）：降级为全局池，不抛错', async () => {
    const dirs = setupDirs();

    const skills = await buildDraftSkillList({
      ...dirs,
      rolePackName: '不存在的角色',
      loadRolePackManager: async () => null,
    });

    expect(skills.map((s) => s.name).sort()).toEqual(['内置技能', '用户技能', '项目技能'].sort());
    expect(skills.some((s) => s.layer === 'rolepack')).toBe(false);
  });
});
