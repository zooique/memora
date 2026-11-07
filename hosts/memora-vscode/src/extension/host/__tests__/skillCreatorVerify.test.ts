/**
 * 技能生成器校验闸的回归测试（verify-skill.mjs）
 *
 * 目的：证明 6 条硬判据不是说明书，而是可执行闸门。重点覆盖两个真实坑：
 * 1. frontmatter 带引号——内核逐行解析不剥引号（`src/utils/frontmatter.ts`），照抄外部模板会产出错名；
 * 2. 正文引用不存在的 `references/x.md`——内核 L3 只索引实际落盘文件（`src/utils/scanner.ts`）。
 *
 * 脚本路径直接指向源目录（构建期 `copyAssetsRecursive` 会把它同步到 dist）；
 * 每个用例使用独立临时 workspace，避免污染仓库 `.memora/`。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 宿主源码侧的技能池目录 */
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');

/** 待测脚本绝对路径 */
const VERIFY_SKILL = join(SKILLS_DIR, 'skill-creator', 'scripts', 'verify-skill.mjs');

/** 脚手架脚本绝对路径（用于验证「复制填槽 → 校验」闭环） */
const SKAFFOLD_SKILL = join(SKILLS_DIR, 'skill-creator', 'scripts', 'skaffold-skill.mjs');

/** 用例级临时工作区，afterEach 统一清理 */
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * 创建临时工作区
 * @returns {string} 工作区绝对路径
 */
function createWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'memora-skill-verify-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * 写入一份技能文件
 * @param {string} workspace 工作区
 * @param {string} dirName 技能目录名
 * @param {string} frontmatter frontmatter 内文（不含 --- 边界）
 * @param {string} body 正文
 * @returns {string} SKILL.md 绝对路径
 */
function writeSkill(workspace: string, dirName: string, frontmatter: string, body: string): string {
  const skillDir = join(workspace, '.memora', 'skills', dirName);
  mkdirSync(skillDir, { recursive: true });
  const filePath = join(skillDir, 'SKILL.md');
  writeFileSync(filePath, `---\n${frontmatter}\n---\n\n${body}`, 'utf8');
  return filePath;
}

/**
 * 运行校验脚本
 * @param {string} workspace 临时工作区
 * @param {string} target 技能目录或 SKILL.md
 * @returns {import('node:child_process').SpawnSyncReturns<string>} 进程结果
 */
function runVerify(workspace: string, target: string) {
  return spawnSync(process.execPath, [VERIFY_SKILL, target, '--workspace', workspace], {
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('skill-creator 的确定性校验闸（verify-skill.mjs）', () => {
  it('合法技能通过，并对正文引用的脚本做一次冒烟', () => {
    const workspace = createWorkspace();
    const skillFile = writeSkill(
      workspace,
      'demo-skill',
      'name: demo-skill\ndescription: 把示例文本整理成清单。当用户要求整理示例文本时使用，输入文本，返回清单。\nlayer: project',
      '# 示例技能\n\n见 `scripts/smoke.mjs`。\n',
    );
    const scriptsDir = join(dirname(skillFile), 'scripts');
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, 'smoke.mjs'), "console.log('ok');\n", 'utf8');

    const result = runVerify(workspace, dirname(skillFile));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('全部硬判据通过');
    expect(result.stdout).toContain('[scripts]');
  });

  it('frontmatter 带引号必须报错（引号会进入 name/description 值）', () => {
    const workspace = createWorkspace();
    const skillFile = writeSkill(
      workspace,
      'quoted-skill',
      'name: quoted-skill\ndescription: "带引号的用途"',
      '# 引号技能\n',
    );

    const result = runVerify(workspace, dirname(skillFile));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[description]');
    expect(result.stdout).toContain('不得带引号');
  });

  it('正文引用不存在的 references 文件必须报错', () => {
    const workspace = createWorkspace();
    const skillFile = writeSkill(
      workspace,
      'missing-ref-skill',
      'name: missing-ref-skill\ndescription: 检查引用闭合。当用户要求检查引用时使用，输入技能目录，返回校验结果。',
      '# 引用技能\n\n见 `references/missing.md`。\n',
    );

    const result = runVerify(workspace, dirname(skillFile));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[doc-refs]');
    expect(result.stdout).toContain('references/missing.md');
  });

  it('name 与目录名不一致必须报错', () => {
    const workspace = createWorkspace();
    const skillFile = writeSkill(
      workspace,
      'disk-name',
      'name: declared-name\ndescription: 检查命名一致性。当用户要求检查命名时使用，输入技能目录，返回校验结果。',
      '# 命名技能\n',
    );

    const result = runVerify(workspace, dirname(skillFile));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[name]');
    expect(result.stdout).toContain('与磁盘名');
  });

  it('正文出现 assets 目录必须报错（内核 L3 不索引它）', () => {
    const workspace = createWorkspace();
    const skillFile = writeSkill(
      workspace,
      'asset-skill',
      'name: asset-skill\ndescription: 检查目录白名单。当用户要求检查目录时使用，输入技能目录，返回校验结果。',
      '# 目录技能\n\n数据见 `assets/data.json`。\n',
    );

    const result = runVerify(workspace, dirname(skillFile));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[assets]');
  });

  it('与随插件分发的内置技能重名必须报错（重名会被 UI 静默去重）', () => {
    const workspace = createWorkspace();
    // code-review 是内置池的稳定锚点（守卫生效的前提是脚本能扫到内置池本身）
    const skillFile = writeSkill(
      workspace,
      'code-review',
      'name: code-review\ndescription: 检查代码质量。当用户要求检查代码时使用，输入代码，返回问题清单。',
      '# 代码检查\n',
    );

    const result = runVerify(workspace, dirname(skillFile));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('[collision]');
  });

  it('脚手架缺省展示名也能产出可通过校验的骨架（复制填槽闭环）', () => {
    const workspace = createWorkspace();
    const scaffold = spawnSync(
      process.execPath,
      [
        SKAFFOLD_SKILL,
        'scaffold-demo',
        '--desc',
        '整理示例流程。当用户要求整理流程时使用，输入文本，返回清单。',
        '--workspace',
        workspace,
      ],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(scaffold.status).toBe(0);

    const result = runVerify(workspace, join(workspace, '.memora', 'skills', 'scaffold-demo'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('全部硬判据通过');
  });
});
