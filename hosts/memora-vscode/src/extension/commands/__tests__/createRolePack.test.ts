/**
 * 「新建用户角色包」命令回归测试
 *
 * 被测不变量：
 *   1. 同名内置角色包 ⇒ **必须拒绝**（内核 loadExtraDir 对同名包直接跳过 ⇒
 *      「创建成功但永远不装载」，创建即白建）；
 *   2. 正常创建：manifest 复用内置模板字段并显式写入 `formatVersion: 1.0.0`；
 *   3. 写后调用 `resyncUserPacks(<用户角色包目录>)` 使新包进入池（可见性由重扫保证）；
 *   4. 同名用户目录已存在 ⇒ 拒绝且不落盘（不静默覆盖）。
 *
 * 模板读取走真实文件（`hosts/memora-vscode/src/extension/skills/.../templates/standard`），
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

const vsMock = vi.hoisted(() => ({
  showInputBox: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  executeCommand: vi.fn(),
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

vi.mock('vscode', () => ({
  window: {
    showInputBox: vsMock.showInputBox,
    showWarningMessage: vsMock.showWarningMessage,
    showInformationMessage: vsMock.showInformationMessage,
  },
  commands: { executeCommand: vsMock.executeCommand },
  Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file' }) },
}));

import type { Agent } from '@zooique/memora';
import { createRolePackCommand, writeUserRolePackFiles } from '../createRolePack.js';

/** 用户角色包根目录（绝对路径） */
const ROLE_PACKS_DIR = resolve(process.cwd(), 'tmp-user-role-packs');

/** 内置模板目录（真实源码路径；与运行时 dist 副本结构一致） */
const TEMPLATE_DIR = fileURLToPath(
  new URL('../../skills/role-pack-creator/templates/standard', import.meta.url),
);

/** 构造命令依赖（rpm 桩只暴露本命令消费面） */
function setupDeps(existingPackNames: string[]): {
  deps: Parameters<typeof createRolePackCommand>[0];
  resync: ReturnType<typeof vi.fn>;
  refreshSettings: ReturnType<typeof vi.fn>;
} {
  const resync = vi.fn(async () => ({ added: 0, removed: [], updated: [], activeFallback: false }));
  const refreshSettings = vi.fn(async () => undefined);
  const rpm = {
    get: (name: string) =>
      existingPackNames.includes(name) ? { name, displayName: name } : undefined,
    resyncUserPacks: resync,
  };
  const agent = { rolePackManager: rpm } as unknown as Agent;
  return {
    deps: {
      userRolePacksDir: ROLE_PACKS_DIR,
      templateDir: TEMPLATE_DIR,
      tryGetAgent: async () => agent,
      settingsProvider: { refreshRolePackList: refreshSettings } as never,
    },
    resync,
    refreshSettings,
  };
}

beforeEach(() => {
  fsMock.mkdir.mockClear();
  fsMock.writeFile.mockClear();
  fsMock.stat.mockReset();
  fsMock.existingPaths.clear();
  fsMock.manifestOverride = null;
  fsMock.stat.mockImplementation(async (p: unknown) => {
    if (fsMock.existingPaths.has(resolve(String(p)))) return {};
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  vsMock.showInputBox.mockReset();
  vsMock.showWarningMessage.mockReset();
  vsMock.showInformationMessage.mockReset();
  vsMock.executeCommand.mockReset();
});

describe('writeUserRolePackFiles（唯一写盘实现）', () => {
  it('同名用户角色包目录已存在 ⇒ 拒绝且不落盘', async () => {
    fsMock.existingPaths.add(resolve(ROLE_PACKS_DIR, 'demo'));
    const result = await writeUserRolePackFiles(ROLE_PACKS_DIR, TEMPLATE_DIR, {
      name: 'demo',
      displayName: 'Demo',
      description: '说明',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('同名用户角色包目录已存在');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('正常创建 ⇒ manifest 显式含 formatVersion 1.0.0 与用户输入字段', async () => {
    const result = await writeUserRolePackFiles(ROLE_PACKS_DIR, TEMPLATE_DIR, {
      name: 'demo',
      displayName: '演示角色',
      description: '一句话说明',
    });
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
    // 模板占位符不得残留（残留 = 用户拿到一份未填值的包）
    expect(manifestText).not.toContain('{{PACK_');
  });

  it('模板缺 formatVersion ⇒ 写盘时显式补 1.0.0（不依赖运行时默认）', async () => {
    fsMock.manifestOverride = JSON.stringify({
      name: '{{PACK_NAME}}',
      displayName: '{{PACK_DISPLAY_NAME}}',
      description: '{{PACK_DESCRIPTION}}',
      handoffPrompt: '{{PACK_HANDOFF}}',
    });
    const result = await writeUserRolePackFiles(ROLE_PACKS_DIR, TEMPLATE_DIR, {
      name: 'demo',
      displayName: 'Demo',
      description: '',
    });
    expect(result.ok).toBe(true);
    const calls = fsMock.writeFile.mock.calls as unknown as [string, string][];
    const manifestCall = calls.find(([p]) => String(p).endsWith('manifest.json'));
    const manifest = JSON.parse(String(manifestCall![1])) as Record<string, unknown>;
    expect(manifest['formatVersion']).toBe('1.0.0');
  });
});

describe('createRolePackCommand（命令面板与设置页共用入口）', () => {
  it('同名内置角色包 ⇒ 拒绝且不写盘（否则创建成功但永远不装载）', async () => {
    vsMock.showInputBox.mockResolvedValueOnce('demo');
    const { deps, resync } = setupDeps(['demo']);

    await createRolePackCommand(deps);

    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
    expect(vsMock.showWarningMessage).toHaveBeenCalledTimes(1);
    expect(vsMock.showWarningMessage.mock.calls[0][0]).toContain('不会被装载');
  });

  it('正常创建 ⇒ 写盘 + resyncUserPacks(用户目录) + 刷新角色列表', async () => {
    vsMock.showInputBox
      .mockResolvedValueOnce('demo') // 标识
      .mockResolvedValueOnce('演示角色') // 显示名
      .mockResolvedValueOnce('一句话说明'); // 描述
    vsMock.showInformationMessage.mockResolvedValueOnce(undefined);
    const { deps, resync, refreshSettings } = setupDeps([]);

    await createRolePackCommand(deps);

    expect(fsMock.writeFile).toHaveBeenCalled();
    expect(resync).toHaveBeenCalledWith(ROLE_PACKS_DIR);
    expect(refreshSettings).toHaveBeenCalledTimes(1);
    // 回显实际写入目录路径
    expect(vsMock.showInformationMessage.mock.calls[0][0]).toContain(
      resolve(ROLE_PACKS_DIR, 'demo'),
    );
  });

  it('标识含路径分隔符 ⇒ 拒绝且不写盘', async () => {
    vsMock.showInputBox.mockResolvedValueOnce('a/b');
    const { deps, resync } = setupDeps([]);

    await createRolePackCommand(deps);

    expect(fsMock.writeFile).not.toHaveBeenCalled();
    expect(resync).not.toHaveBeenCalled();
    expect(vsMock.showWarningMessage).toHaveBeenCalledTimes(1);
  });
});
