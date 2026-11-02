/**
 * 用户资产校验 / 写盘回归测试（表单入口剪枝后，判据不得跟着消失）
 *
 * 被测不变量：
 *   1. 技能：description 缺失 / 含换行 / 正文为空 ⇒ 拒绝且**不落盘**；同名用户文件 ⇒ 拒绝；
 *      合法输入 ⇒ 唯一一次 writeFile，frontmatter 不带引号、正文原样落盘；
 *   2. 角色包：同名用户目录 ⇒ 拒绝；池内同名（内置）⇒ 拒绝并给出换名指引；
 *      正常创建 ⇒ manifest 显式 `formatVersion: 1.0.0`、占位符全部替换；
 *   3. 两个函数都**不交互**（不 import vscode、不弹框）——入口剪掉后仍可被
 *      「压缩包导入 / 对话写入」直接调用。
 *
 * 模板读取走真实文件（`src/extension/skills/role-pack-creator/templates/standard`），
 * 写盘与 stat 被 mock —— 断言的是调用次数与写入内容，不触用户磁盘。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** fs 可观测桩（readFile 默认透传真实实现，可按用例覆盖 manifest 内容） */
const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  stat: vi.fn(),
  existingPaths: new Set<string>(),
  /** 非 null 时，对 manifest.json 的读取直接返回该字符串（用于「缺 formatVersion」用例） */
  manifestOverride: null as string | null,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: fsMock.mkdir,
    writeFile: fsMock.writeFile,
    stat: fsMock.stat,
    readFile: vi.fn(async (p: unknown, ...rest: unknown[]) => {
      if (fsMock.manifestOverride && String(p).endsWith('manifest.json')) {
        return fsMock.manifestOverride;
      }
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(p, ...rest);
    }),
  };
});

import { writeUserRolePackFiles, writeUserSkillFile } from '../userAssets/write.js';

/** 测试用用户技能目录（绝对路径） */
const SKILLS_DIR = resolve(process.cwd(), 'tmp-user-skills');
/** 测试用用户角色包目录（绝对路径） */
const ROLE_PACKS_DIR = resolve(process.cwd(), 'tmp-user-role-packs');
/** 内置模板目录（真实源码路径；与运行时 dist 副本结构一致） */
const TEMPLATE_DIR = fileURLToPath(
  new URL('../../skills/role-pack-creator/templates/standard', import.meta.url),
);

beforeEach(() => {
  fsMock.mkdir.mockClear();
  fsMock.writeFile.mockClear();
  fsMock.stat.mockReset();
  fsMock.existingPaths.clear();
  fsMock.manifestOverride = null;
  // 默认真实文件系统的 stat：只有登记在 existingPaths 的路径才算存在
  fsMock.stat.mockImplementation(async (p: unknown) => {
    if (fsMock.existingPaths.has(resolve(String(p)))) return {};
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
});

describe('writeUserSkillFile（技能校验 + 写盘）', () => {
  it('description 缺失 ⇒ 拒绝且不落盘', async () => {
    const result = await writeUserSkillFile(SKILLS_DIR, {
      name: 'demo',
      description: '   ',
      content: '# Demo\n正文',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('description');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('description 含换行 ⇒ 拒绝且不落盘（换行会提前闭合 frontmatter）', async () => {
    const result = await writeUserSkillFile(SKILLS_DIR, {
      name: 'demo',
      description: '第一行\n第二行',
      content: '# Demo',
    });
    expect(result.ok).toBe(false);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('正文为空 ⇒ 拒绝且不落盘（空技能对模型无用）', async () => {
    const result = await writeUserSkillFile(SKILLS_DIR, {
      name: 'demo',
      description: '说明',
      content: '  \n  ',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('正文不能为空');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('名字含路径分隔符 ⇒ 拒绝且不落盘', async () => {
    const result = await writeUserSkillFile(SKILLS_DIR, {
      name: 'a/b',
      description: '说明',
      content: '# Demo',
    });
    expect(result.ok).toBe(false);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('同名用户文件已存在 ⇒ 拒绝且不落盘（不静默覆盖）', async () => {
    fsMock.existingPaths.add(resolve(SKILLS_DIR, 'demo.md'));
    const result = await writeUserSkillFile(SKILLS_DIR, {
      name: 'demo',
      description: '说明',
      content: '# Demo',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('同名用户技能文件已存在');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('合法输入 ⇒ 唯一一次 writeFile，路径落在技能目录内，正文原样写入', async () => {
    const result = await writeUserSkillFile(SKILLS_DIR, {
      name: 'demo',
      description: '说明',
      content: '# Demo\n正文内容',
    });
    expect(result.ok).toBe(true);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    if (result.ok) {
      expect(result.filePath).toBe(resolve(SKILLS_DIR, 'demo.md'));
      const [filePath, content] = fsMock.writeFile.mock.calls[0] as unknown as [string, string];
      expect(resolve(String(filePath))).toBe(result.filePath);
      // frontmatter 值不裹引号（内核 parseFrontmatter 不剥引号）
      expect(String(content)).toContain('description: 说明');
      expect(String(content)).not.toContain('description: "');
      // 正文由调用方提供，必须原样落盘（不套用任何空壳模板）
      expect(String(content)).toContain('# Demo\n正文内容');
    }
  });
});

describe('writeUserRolePackFiles（角色包校验 + 写盘）', () => {
  it('同名用户角色包目录已存在 ⇒ 拒绝且不落盘', async () => {
    fsMock.existingPaths.add(resolve(ROLE_PACKS_DIR, 'demo'));
    const result = await writeUserRolePackFiles(
      ROLE_PACKS_DIR,
      TEMPLATE_DIR,
      { name: 'demo', displayName: 'Demo', description: '说明' },
      () => false,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('同名用户角色包目录已存在');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('池内同名（内置）⇒ 拒绝且不写盘（否则创建成功但永远不装载）', async () => {
    const result = await writeUserRolePackFiles(
      ROLE_PACKS_DIR,
      TEMPLATE_DIR,
      { name: 'demo', displayName: 'Demo' },
      (name) => name === 'demo',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('不能与内置角色包「demo」同名，请换个名字');
      expect(result.reason).toContain('不会被装载');
    }
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('标识含路径分隔符 ⇒ 拒绝且不写盘', async () => {
    const result = await writeUserRolePackFiles(
      ROLE_PACKS_DIR,
      TEMPLATE_DIR,
      { name: 'a/b' },
      () => false,
    );
    expect(result.ok).toBe(false);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('正常创建 ⇒ manifest 显式含 formatVersion 1.0.0 与输入字段，占位符不残留', async () => {
    const result = await writeUserRolePackFiles(
      ROLE_PACKS_DIR,
      TEMPLATE_DIR,
      { name: 'demo', displayName: '演示角色', description: '一句话说明' },
      () => false,
    );
    expect(result.ok).toBe(true);
    const calls = fsMock.writeFile.mock.calls as unknown as [string, string][];
    const manifestCall = calls.find(([p]) => String(p).endsWith('manifest.json'));
    expect(manifestCall).toBeDefined();
    const manifestText = String(manifestCall![1]);
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    expect(manifest['name']).toBe('demo');
    expect(manifest['displayName']).toBe('演示角色');
    expect(manifest['description']).toBe('一句话说明');
    expect(manifest['formatVersion']).toBe('1.0.0');
    // 模板占位符不得残留（残留 = 调用方拿到一份未填值的包）
    expect(manifestText).not.toContain('{{PACK_');
  });

  it('模板缺 formatVersion ⇒ 写盘时显式补 1.0.0（不依赖运行时默认）', async () => {
    fsMock.manifestOverride = JSON.stringify({
      name: '{{PACK_NAME}}',
      displayName: '{{PACK_DISPLAY_NAME}}',
      description: '{{PACK_DESCRIPTION}}',
      handoffPrompt: '{{PACK_HANDOFF}}',
    });
    const result = await writeUserRolePackFiles(
      ROLE_PACKS_DIR,
      TEMPLATE_DIR,
      { name: 'demo', displayName: 'Demo', description: '' },
      () => false,
    );
    expect(result.ok).toBe(true);
    const calls = fsMock.writeFile.mock.calls as unknown as [string, string][];
    const manifestCall = calls.find(([p]) => String(p).endsWith('manifest.json'));
    const manifest = JSON.parse(String(manifestCall![1])) as Record<string, unknown>;
    expect(manifest['formatVersion']).toBe('1.0.0');
  });
});
