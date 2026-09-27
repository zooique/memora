/**
 * 技能 L3 路径解析（skillLayer3）守卫测试
 *
 * 背景：L3 安全访问模型（layer3 白名单 + resolveSafePath 边界防护）原在
 * SkillManager（全局技能）与 RolePackManager（角色包内嵌技能）各实现一遍，
 * 现收敛到 skillLayer3 单一收口。收敛前该模型**只有角色包侧有测试覆盖**，
 * 全局技能侧的 readResource / getScriptPath 无直接用例——故为共享模块本身补守卫，
 * 使两侧同时受益（防任一侧改动悄悄削弱安全模型）。
 *
 * 守的是什么（缺一即被绕过）：
 * 1. 白名单前置：未在 layer3 登记的路径不得进入解析（含兄弟目录前缀、escape 符）；
 * 2. 边界防护：已登记但逃逸来源子目录（../）的路径不得放行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_RESOURCE_SUBDIR,
  SCRIPTS_SUBDIR,
  discoverSkillLayer3,
  resolveSkillDir,
  findLayer3Resource,
  findLayer3Script,
  resolveLayer3ResourcePath,
  resolveLayer3ScriptPath,
  type SkillLayer3Like,
} from '@/skill/skillLayer3.js';

let skillDir: string;

const layer3: SkillLayer3Like = {
  resources: [{ path: 'api.md' }, { path: 'modes.md', subdir: 'references' }],
  scripts: [{ path: 'build.mjs' }],
};

beforeEach(() => {
  skillDir = mkdtempSync(join(tmpdir(), 'skill-l3-'));
  mkdirSync(join(skillDir, DEFAULT_RESOURCE_SUBDIR), { recursive: true });
  mkdirSync(join(skillDir, 'references'), { recursive: true });
  mkdirSync(join(skillDir, SCRIPTS_SUBDIR), { recursive: true });
  writeFileSync(join(skillDir, DEFAULT_RESOURCE_SUBDIR, 'api.md'), 'api');
  writeFileSync(join(skillDir, 'references', 'modes.md'), 'modes');
  writeFileSync(join(skillDir, SCRIPTS_SUBDIR, 'build.mjs'), '// build');
  // 逃逸目标：确实存在于磁盘，确保「返回 null」不是因为文件不存在
  writeFileSync(join(skillDir, 'secret.txt'), 'secret');
  mkdirSync(join(skillDir, 'evil'), { recursive: true });
  writeFileSync(join(skillDir, 'evil', 'evil.sh'), 'evil');
});

afterEach(() => {
  rmSync(skillDir, { recursive: true, force: true });
});

describe('skillLayer3 · 资源路径解析', () => {
  it('白名单命中（默认 resources/ 基目录）→ 返回绝对路径', () => {
    const p = resolveLayer3ResourcePath(skillDir, layer3, 'api.md');
    expect(p).toBe(join(skillDir, DEFAULT_RESOURCE_SUBDIR, 'api.md'));
  });

  it('白名单命中且 subdir=references → 基目录切到 references/', () => {
    const p = resolveLayer3ResourcePath(skillDir, layer3, 'modes.md');
    expect(p).toBe(join(skillDir, 'references', 'modes.md'));
  });

  it('未登记的路径 → null（白名单前置，与磁盘是否存在无关）', () => {
    // 该文件在磁盘上存在，但不在白名单 → 必须仍为 null
    expect(resolveLayer3ResourcePath(skillDir, layer3, 'secret.txt')).toBeNull();
    expect(findLayer3Resource(layer3, 'secret.txt')).toBeNull();
  });

  it('已登记但逃逸（../evil/secret.txt）→ null（边界防护）', () => {
    const evilLayer3: SkillLayer3Like = { resources: [{ path: '../evil/secret.txt' }] };
    expect(resolveLayer3ResourcePath(skillDir, evilLayer3, '../evil/secret.txt')).toBeNull();
  });

  it('layer3 缺失 / 未装载 → null（不抛异常）', () => {
    expect(resolveLayer3ResourcePath(skillDir, undefined, 'api.md')).toBeNull();
    expect(resolveLayer3ResourcePath(skillDir, {}, 'api.md')).toBeNull();
  });
});

describe('skillLayer3 · 目录解析（双形态 SSOT）', () => {
  it('路径指向 SKILL.md（文件夹形态）→ 返回所在目录', () => {
    const folderSkill = join(skillDir, 'folder-skill');
    mkdirSync(folderSkill, { recursive: true });
    const skillMd = join(folderSkill, 'SKILL.md');
    writeFileSync(skillMd, '---\nname: x\n---\n');
    expect(resolveSkillDir(skillMd)).toBe(folderSkill);
  });

  it('路径指向裸 .md（单文件形态）→ 返回所在目录（即技能池共享根）', () => {
    const bare = join(skillDir, 'write.md');
    writeFileSync(bare, '# write');
    expect(resolveSkillDir(bare)).toBe(skillDir);
  });

  it('路径直接指向目录（兼容 manifest.file 写目录的形态）→ 返回目录本身', () => {
    const dirAsSkill = join(skillDir, 'as-dir');
    mkdirSync(dirAsSkill, { recursive: true });
    expect(resolveSkillDir(dirAsSkill)).toBe(dirAsSkill);
  });
});

describe('skillLayer3 · L3 发现（仅文件夹形态有归属权）', () => {
  it('文件夹形态：发现 resources/ 与 scripts/', async () => {
    const folderSkill = join(skillDir, 'folder-skill');
    mkdirSync(join(folderSkill, DEFAULT_RESOURCE_SUBDIR), { recursive: true });
    mkdirSync(join(folderSkill, SCRIPTS_SUBDIR), { recursive: true });
    writeFileSync(join(folderSkill, DEFAULT_RESOURCE_SUBDIR, 'guide.md'), 'g');
    writeFileSync(join(folderSkill, SCRIPTS_SUBDIR, 'run.mjs'), '// run');

    const l3 = await discoverSkillLayer3(join(folderSkill, 'SKILL.md'));
    expect(l3.resources.map((r) => r.path)).toContain('guide.md');
    expect(l3.scripts.map((s) => s.path)).toContain('run.mjs');
  });

  it('裸 .md：恒返回空索引（防误并入技能池共享根的同级资源 → 污染）', async () => {
    // skillDir 下已有 resources/api.md（见 beforeEach）——裸 .md 不得把它认作自己的 L3
    const bare = join(skillDir, 'write.md');
    writeFileSync(bare, '# write');
    const l3 = await discoverSkillLayer3(bare);
    expect(l3.resources).toEqual([]);
    expect(l3.scripts).toEqual([]);
  });
});

describe('skillLayer3 · 目录名约定（外部标准锚点）', () => {
  // 目录名是 Agent Skills 开放标准的对外契约（L3 归属 scripts/ 与 resources/），不是内部实现细节——
  // 故此处锚定**字面量**而非引用常量自身：本文件其余用例用 `join(skillDir, SCRIPTS_SUBDIR, …)`
  // 构造期望值，期望与被测同源 → 常量值被改错也恒绿（实测：改成 'scripts-probe' 仍 14 passed）。
  // 该盲区在 role-pack 层由硬编码字面量的用例间接兜底，此处把契约显式锚定，不再依赖他人副作用。
  it('常量取值须等于标准约定的目录名', () => {
    expect(DEFAULT_RESOURCE_SUBDIR).toBe('resources');
    expect(SCRIPTS_SUBDIR).toBe('scripts');
  });
});

describe('skillLayer3 · 脚本路径解析', () => {
  it('白名单命中 → 返回 scripts/ 下绝对路径', () => {
    const p = resolveLayer3ScriptPath(skillDir, layer3, 'build.mjs');
    expect(p).toBe(join(skillDir, SCRIPTS_SUBDIR, 'build.mjs'));
  });

  it('未登记的脚本 → null', () => {
    expect(resolveLayer3ScriptPath(skillDir, layer3, 'other.mjs')).toBeNull();
    expect(findLayer3Script(layer3, 'other.mjs')).toBeNull();
  });

  it('已登记但逃逸（../evil/evil.sh）→ null（边界防护）', () => {
    const evilLayer3: SkillLayer3Like = { scripts: [{ path: '../evil/evil.sh' }] };
    expect(resolveLayer3ScriptPath(skillDir, evilLayer3, '../evil/evil.sh')).toBeNull();
  });

  it('layer3 缺失 → null（不抛异常）', () => {
    expect(resolveLayer3ScriptPath(skillDir, undefined, 'build.mjs')).toBeNull();
  });
});
