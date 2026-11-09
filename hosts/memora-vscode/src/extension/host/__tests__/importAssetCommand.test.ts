// @vitest-environment node
/**
 * `memora.importAsset` 命令层 · 回归测试
 *
 * 被测不变量：
 *   1. 三入口共用同一处理器：命令层只做「开框 → 选目标级 → 执行 → 重扫 → toast」，
 *      项目目录与信任判定由注入的 `readProjectDirs`（`projectAssetDirsFor` 单点）给出；
 *   2. 未信任 + 选项目级 ⇒ 明确警告并零写入（不静默降级为用户级）；
 *   3. 用户级成功 ⇒ 写入 + `resyncUserSkills` + 两面板刷新 + toast 含类型/名称/落点/文件数；
 *   4. 项目级成功 ⇒ 先 `loadExtraDir(..., 'project')` 再重扫（顺序即覆盖方向）；
 *   5. 同名覆盖取消 ⇒ 原文件 **hash / mtime 零改动**、无 `.import-tmp-` / `.bak-` / `.recovery-` 残留
 *      + 失败提示给出具体原因（不是「导入失败」四个字）；确认模态**只传一个 item**（不出现双取消）；
 *   6. 角色包走 `resyncUserPacks`（档位与目标级一致）+ 角色列表刷新；
 *   7. 角色包与**内置包同名** ⇒ 拒绝且零写入（不询问覆盖、不创建目录）；
 *   8. 同名**用户级**角色包 ⇒ 仍走既有覆盖确认流（内置判定不误伤）；
 *   9. 同名覆盖确认 ⇒ 内容替换成功且事务无残留（暂存 / 备份 / 恢复备份）。
 *
 * vscode 全量 mock（命令层是唯一交互面；执行面 `zipImport.ts` 用真实实现 + 真实 zip 夹具）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import type { Agent } from '@zooique/memora';
import { importAssetCommand } from '../../commands/importAsset.js';
import type { MemoraChatViewProvider } from '../../../webview/panels/chatPanel.js';
import type { MemoraSettingsPanel } from '../../../webview/panels/settingsPanel.js';

/** vscode 交互面桩（hoisted：vi.mock 工厂在模块加载前执行） */
const vscodeMock = vi.hoisted(() => ({
  /** 打开文件对话框 */
  showOpenDialog: vi.fn(),
  /** 目标级选择 */
  showQuickPick: vi.fn(),
  /** 警告 / 覆盖确认（modal）共用 */
  showWarningMessage: vi.fn(),
  /** 成功 toast */
  showInformationMessage: vi.fn(),
  /** 失败 toast */
  showErrorMessage: vi.fn(),
}));

/** l10n.t 替身：{0}/{1} 占位符按参替换（vi.hoisted——mock 工厂先于 import 执行，import 绑定不可用） */
const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]): string => {
  let out = msg;
  args.forEach((arg, i) => {
    out = out.replaceAll(`{${i}}`, String(arg));
  });
  return out;
});

// vscode 命名空间只用到 window 交互面（命令层不碰 workspace / env）；l10n.t = 占位符替换替身
// （切片 2：提示串经 vscode.l10n.t 产出，断言口径 = 英文原文键；中文译文归 bundle 守卫与真机）
vi.mock('vscode', () => ({ window: vscodeMock, l10n: { t: tStub } }));

/** 本文件创建的临时目录（afterEach 统一清理） */
const tempDirs: string[] = [];

/** 建临时目录并登记清理 */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 计算文件 sha256（「零改动」判据必须逐字节，不靠“看起来一样”）
 *
 * @param filePath 文件绝对路径
 */
function sha256Of(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** 目录里是否还有导入事务残留（暂存 / 备份；`.recovery-` 是主动保留的恢复备份，也算残留） */
function hasLeftovers(dir: string): boolean {
  return readdirSync(dir).some(
    (name) =>
      name.startsWith('.import-tmp-') ||
      /\.bak-[0-9a-f]{12}$/.test(name) ||
      /\.recovery-[0-9a-f]{12}$/.test(name),
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

/**
 * 生成单文件技能 zip（夹具）
 *
 * @param zipPath 目标路径
 * @param name 技能名（同时作为文件名与 frontmatter name）
 * @param description 技能描述
 * @param body 正文
 */
async function makeSkillZip(
  zipPath: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(`---\nname: ${name}\ndescription: ${description}\n---\n${body}`, 'utf-8'),
    `${name}.md`,
  );
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    zip.outputStream.on('error', reject);
    out.on('error', reject);
    out.on('close', () => resolve());
    zip.outputStream.pipe(out);
    zip.end();
  });
}

/** 生成角色包 zip（manifest + persona） */
async function makeRolePackZip(zipPath: string, name: string): Promise<void> {
  const zip = new ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify({ name })), 'pack/manifest.json');
  zip.addBuffer(Buffer.from('你是测试角色。'), 'pack/persona.md');
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    zip.outputStream.on('error', reject);
    out.on('error', reject);
    out.on('close', () => resolve());
    zip.outputStream.pipe(out);
    zip.end();
  });
}

/** Agent 桩（记录技能/角色包重扫调用） */
function makeAgentStub(): { agent: Agent; calls: string[] } {
  const calls: string[] = [];
  const agent = {
    skills: {
      loadExtraDir: vi.fn(async (_dir: string, tier?: string) => {
        calls.push(`skills.loadExtraDir:${tier}`);
      }),
      resyncUserSkills: vi.fn(async () => {
        calls.push('skills.resync');
        return { added: 0, removed: [], updated: [] };
      }),
    },
    rolePackManager: {
      // 内置同名判定的快速命中通道：桩返回 null（未命中）⇒ 走内置目录清单判定
      get: vi.fn((_name: string) => null),
      resyncUserPacks: vi.fn(async (_dir: string, tier?: string) => {
        calls.push(`rolePacks.resync:${tier}`);
        return { added: 0, removed: [], updated: [], activeFallback: false };
      }),
    },
  };
  return { agent: agent as unknown as Agent, calls };
}

/** 面板桩 */
function makePanels(): {
  chatProvider: MemoraChatViewProvider;
  settingsProvider: MemoraSettingsPanel;
  chatRefreshes: number;
  settingsSkillRefreshes: number;
  settingsRoleRefreshes: number;
} {
  const counters = { chatRefreshes: 0, settingsSkillRefreshes: 0, settingsRoleRefreshes: 0 };
  const chatProvider = {
    refreshSkillList: () => {
      counters.chatRefreshes += 1;
    },
  } as unknown as MemoraChatViewProvider;
  const settingsProvider = {
    refreshSkillList: async () => {
      counters.settingsSkillRefreshes += 1;
    },
    refreshRolePackList: async () => {
      counters.settingsRoleRefreshes += 1;
    },
  } as unknown as MemoraSettingsPanel;
  return {
    chatProvider,
    settingsProvider,
    // 用 getter 读实时计数（展开 `...counters` 只会复制调用时刻的快照）
    get chatRefreshes() {
      return counters.chatRefreshes;
    },
    get settingsSkillRefreshes() {
      return counters.settingsSkillRefreshes;
    },
    get settingsRoleRefreshes() {
      return counters.settingsRoleRefreshes;
    },
  };
}

describe('importAssetCommand · 信任门与目标级', () => {
  it('未信任 + 选项目级 ⇒ 警告「未受信任」且零写入、零重扫', async () => {
    const dir = makeTempDir('memora-import-untrusted-');
    const zipPath = join(dir, 'skill.zip');
    await makeSkillZip(zipPath, 'trusted-skill', '演示', '正文');
    const userSkillsDir = join(dir, 'user-skills');
    const userRolePacksDir = join(dir, 'user-role-packs');
    const { agent, calls } = makeAgentStub();
    const panels = makePanels();

    vscodeMock.showOpenDialog.mockResolvedValue([{ fsPath: zipPath }]);
    vscodeMock.showQuickPick.mockResolvedValue({ label: '项目级', level: 'project' });
    vscodeMock.showWarningMessage.mockResolvedValue(undefined);

    await importAssetCommand({
      userSkillsDir,
      userRolePacksDir,
      builtinRolePacksDir: join(dir, 'builtin-role-packs'),
      readProjectDirs: () => ({}),
      tryGetAgent: async () => agent,
      chatProvider: panels.chatProvider,
      settingsProvider: panels.settingsProvider,
    });

    expect(vscodeMock.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('The workspace is not trusted'),
    );
    expect(calls).toEqual([]);
    expect(vscodeMock.showInformationMessage).not.toHaveBeenCalled();
  });
});

describe('importAssetCommand · 用户级导入成功', () => {
  it('技能 ⇒ 落盘 + resyncUserSkills + 两面板刷新 + toast 四要素', async () => {
    const dir = makeTempDir('memora-import-user-skill-');
    const zipPath = join(dir, 'skill.zip');
    await makeSkillZip(zipPath, 'demo-skill', '演示技能', '正文内容');
    const userSkillsDir = join(dir, 'user-skills');
    const userRolePacksDir = join(dir, 'user-role-packs');
    const { agent, calls } = makeAgentStub();
    const panels = makePanels();

    vscodeMock.showOpenDialog.mockResolvedValue([{ fsPath: zipPath }]);
    vscodeMock.showQuickPick.mockResolvedValue({ label: '用户级（默认）', level: 'user' });

    await importAssetCommand({
      userSkillsDir,
      userRolePacksDir,
      builtinRolePacksDir: join(dir, 'builtin-role-packs'),
      readProjectDirs: () => ({}),
      tryGetAgent: async () => agent,
      chatProvider: panels.chatProvider,
      settingsProvider: panels.settingsProvider,
    });

    const target = join(userSkillsDir, 'demo-skill.md');
    expect(readFileSync(target, 'utf-8')).toContain('正文内容');
    expect(calls).toEqual(['skills.resync']);
    expect(panels.chatRefreshes).toBe(1);
    expect(panels.settingsSkillRefreshes).toBe(1);
    const toast = vscodeMock.showInformationMessage.mock.calls[0]?.[0] as string;
    expect(toast).toContain('skill');
    expect(toast).toContain('demo-skill');
    expect(toast).toContain(target);
    expect(toast).toContain('1 file(s)');
  });

  it('角色包 ⇒ resyncUserPacks(user) + 角色列表刷新', async () => {
    const dir = makeTempDir('memora-import-user-pack-');
    const zipPath = join(dir, 'pack.zip');
    await makeRolePackZip(zipPath, 'demo-role');
    const userSkillsDir = join(dir, 'user-skills');
    const userRolePacksDir = join(dir, 'user-role-packs');
    const { agent, calls } = makeAgentStub();
    const panels = makePanels();

    vscodeMock.showOpenDialog.mockResolvedValue([{ fsPath: zipPath }]);
    vscodeMock.showQuickPick.mockResolvedValue({ label: '用户级（默认）', level: 'user' });

    await importAssetCommand({
      userSkillsDir,
      userRolePacksDir,
      builtinRolePacksDir: join(dir, 'builtin-role-packs'),
      readProjectDirs: () => ({}),
      tryGetAgent: async () => agent,
      chatProvider: panels.chatProvider,
      settingsProvider: panels.settingsProvider,
    });

    expect(calls).toEqual(['rolePacks.resync:user']);
    expect(panels.settingsRoleRefreshes).toBe(1);
    expect(panels.chatRefreshes).toBe(0);
  });
});

describe('importAssetCommand · 项目级导入成功（已信任）', () => {
  it('技能 ⇒ 先 loadExtraDir(project) 再 resync（顺序即覆盖方向）', async () => {
    const dir = makeTempDir('memora-import-project-skill-');
    const zipPath = join(dir, 'skill.zip');
    await makeSkillZip(zipPath, 'project-skill', '项目技能', '正文');
    const projectSkills = join(dir, 'project-skills');
    const projectRolePacks = join(dir, 'project-role-packs');
    const { agent, calls } = makeAgentStub();
    const panels = makePanels();

    vscodeMock.showOpenDialog.mockResolvedValue([{ fsPath: zipPath }]);
    vscodeMock.showQuickPick.mockResolvedValue({ label: '项目级', level: 'project' });

    await importAssetCommand({
      userSkillsDir: join(dir, 'user-skills'),
      userRolePacksDir: join(dir, 'user-role-packs'),
      builtinRolePacksDir: join(dir, 'builtin-role-packs'),
      readProjectDirs: () => ({ skills: projectSkills, rolePacks: projectRolePacks }),
      tryGetAgent: async () => agent,
      chatProvider: panels.chatProvider,
      settingsProvider: panels.settingsProvider,
    });

    expect(readFileSync(join(projectSkills, 'project-skill.md'), 'utf-8')).toContain('正文');
    expect(calls).toEqual(['skills.loadExtraDir:project', 'skills.resync']);
    expect(vscodeMock.showInformationMessage.mock.calls[0]?.[0]).toContain(projectSkills);
  });
});

describe('importAssetCommand · 同名覆盖确认', () => {
  it('用户点 VS Code 自带 Cancel（undefined）⇒ 原文件 hash / mtime 零改动、无事务残留、具体原因', async () => {
    const dir = makeTempDir('memora-import-cancel-');
    const zipPath = join(dir, 'skill.zip');
    await makeSkillZip(zipPath, 'dup-skill', '新', '新正文');
    const userSkillsDir = join(dir, 'user-skills');
    mkdirSync(userSkillsDir, { recursive: true });
    const existing = join(userSkillsDir, 'dup-skill.md');
    writeFileSync(existing, '---\nname: dup-skill\ndescription: 旧\n---\n旧正文', 'utf-8');
    // 取消前快照：逐字节 hash + mtime（「零改动」的判据，不靠“看起来一样”）
    const hashBefore = sha256Of(existing);
    const mtimeBefore = statSync(existing).mtimeMs;
    const { agent, calls } = makeAgentStub();
    const panels = makePanels();

    vscodeMock.showOpenDialog.mockResolvedValue([{ fsPath: zipPath }]);
    vscodeMock.showQuickPick.mockResolvedValue({ label: '用户级（默认）', level: 'user' });
    // VS Code modal 自带的 Cancel / Esc / 关 X 统一解析为 undefined（我们不再自拼「取消」）
    vscodeMock.showWarningMessage.mockResolvedValue(undefined);

    await importAssetCommand({
      userSkillsDir,
      userRolePacksDir: join(dir, 'user-role-packs'),
      builtinRolePacksDir: join(dir, 'builtin-role-packs'),
      readProjectDirs: () => ({}),
      tryGetAgent: async () => agent,
      chatProvider: panels.chatProvider,
      settingsProvider: panels.settingsProvider,
    });

    expect(sha256Of(existing)).toBe(hashBefore);
    expect(statSync(existing).mtimeMs).toBe(mtimeBefore);
    expect(hasLeftovers(userSkillsDir)).toBe(false);
    expect(calls).toEqual([]);
    const err = vscodeMock.showErrorMessage.mock.calls[0]?.[0] as string;
    expect(err).toContain('Import failed');
    expect(err).toContain('Import cancelled');
    // 覆盖确认只有「确认项 + options」两个实参，不存在取消 item（双取消的结构性防线）
    const confirmArgs = vscodeMock.showWarningMessage.mock.calls.find((args) =>
      String(args[0]).includes('Target already exists'),
    ) as unknown[];
    expect(confirmArgs).toHaveLength(3);
    expect(confirmArgs[2]).toBe('Overwrite');
  });

  it('用户点「覆盖」⇒ 内容替换 + 无事务残留 + resync 一次', async () => {
    const dir = makeTempDir('memora-import-overwrite-');
    const zipPath = join(dir, 'skill.zip');
    await makeSkillZip(zipPath, 'dup-skill', '新', '新正文');
    const userSkillsDir = join(dir, 'user-skills');
    mkdirSync(userSkillsDir, { recursive: true });
    const existing = join(userSkillsDir, 'dup-skill.md');
    writeFileSync(existing, '---\nname: dup-skill\ndescription: 旧\n---\n旧正文', 'utf-8');
    const hashBefore = sha256Of(existing);
    const { agent, calls } = makeAgentStub();
    const panels = makePanels();

    vscodeMock.showOpenDialog.mockResolvedValue([{ fsPath: zipPath }]);
    vscodeMock.showQuickPick.mockResolvedValue({ label: '用户级（默认）', level: 'user' });
    vscodeMock.showWarningMessage.mockResolvedValue('Overwrite');

    await importAssetCommand({
      userSkillsDir,
      userRolePacksDir: join(dir, 'user-role-packs'),
      builtinRolePacksDir: join(dir, 'builtin-role-packs'),
      readProjectDirs: () => ({}),
      tryGetAgent: async () => agent,
      chatProvider: panels.chatProvider,
      settingsProvider: panels.settingsProvider,
    });

    expect(readFileSync(existing, 'utf-8')).toContain('新正文');
    expect(sha256Of(existing)).not.toBe(hashBefore);
    // 事务成功：暂存 / 备份 / 恢复备份均不得残留
    expect(hasLeftovers(userSkillsDir)).toBe(false);
    expect(calls).toEqual(['skills.resync']);
  });
});

describe('importAssetCommand · 角色包同名判定（内置 vs 用户级）', () => {
  it('同名内置角色包 ⇒ 拒绝且零写入（不询问覆盖、不创建目录）', async () => {
    const dir = makeTempDir('memora-import-builtin-dup-');
    const zipPath = join(dir, 'pack.zip');
    await makeRolePackZip(zipPath, 'demo-role');
    const userRolePacksDir = join(dir, 'user-role-packs');
    // 内置目录里放一份同名包（目录名 + manifest name 双重命中）
    const builtinRolePacksDir = join(dir, 'builtin-role-packs');
    mkdirSync(join(builtinRolePacksDir, 'demo-role'), { recursive: true });
    writeFileSync(
      join(builtinRolePacksDir, 'demo-role', 'manifest.json'),
      JSON.stringify({ name: 'demo-role' }),
      'utf-8',
    );
    const { agent, calls } = makeAgentStub();
    const panels = makePanels();

    vscodeMock.showOpenDialog.mockResolvedValue([{ fsPath: zipPath }]);
    vscodeMock.showQuickPick.mockResolvedValue({ label: '用户级（默认）', level: 'user' });

    await importAssetCommand({
      userSkillsDir: join(dir, 'user-skills'),
      userRolePacksDir,
      builtinRolePacksDir,
      readProjectDirs: () => ({}),
      tryGetAgent: async () => agent,
      chatProvider: panels.chatProvider,
      settingsProvider: panels.settingsProvider,
    });

    const err = vscodeMock.showErrorMessage.mock.calls[0]?.[0] as string;
    expect(err).toContain('built-in role pack with the same name');
    // 零写入：连用户角色包根目录都没被创建（判定在 mkdir 之前）
    expect(existsSync(userRolePacksDir)).toBe(false);
    expect(vscodeMock.showWarningMessage).not.toHaveBeenCalled();
    expect(vscodeMock.showInformationMessage).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('同名用户级角色包 ⇒ 仍走既有覆盖确认流（内置判定不误伤）', async () => {
    const dir = makeTempDir('memora-import-user-dup-pack-');
    const zipPath = join(dir, 'pack.zip');
    await makeRolePackZip(zipPath, 'dup-role');
    const userRolePacksDir = join(dir, 'user-role-packs');
    mkdirSync(join(userRolePacksDir, 'dup-role'), { recursive: true });
    writeFileSync(
      join(userRolePacksDir, 'dup-role', 'manifest.json'),
      JSON.stringify({ name: 'dup-role' }),
      'utf-8',
    );
    const { agent, calls } = makeAgentStub();
    const panels = makePanels();

    vscodeMock.showOpenDialog.mockResolvedValue([{ fsPath: zipPath }]);
    vscodeMock.showQuickPick.mockResolvedValue({ label: '用户级（默认）', level: 'user' });
    // 覆盖确认弹窗返回「取消」
    vscodeMock.showWarningMessage.mockResolvedValue('取消');

    await importAssetCommand({
      userSkillsDir: join(dir, 'user-skills'),
      userRolePacksDir,
      builtinRolePacksDir: join(dir, 'builtin-role-packs'),
      readProjectDirs: () => ({}),
      tryGetAgent: async () => agent,
      chatProvider: panels.chatProvider,
      settingsProvider: panels.settingsProvider,
    });

    // 确认弹窗文案须与事务化实现一致（备份并替换，而非「先删除」）
    // 主行在 message、说明行在原生 options.detail（helper 不把 detail 并入 message）
    const confirmArgs = vscodeMock.showWarningMessage.mock.calls[0] as unknown as [
      string,
      { detail?: string },
    ];
    const confirmText = `${confirmArgs?.[0] ?? ''}\n${confirmArgs?.[1]?.detail ?? ''}`;
    expect(confirmText).toContain('Overwriting backs up and replaces the existing content');
    expect(calls).toEqual([]);
    expect(vscodeMock.showErrorMessage.mock.calls[0]?.[0]).toContain('Import cancelled');
  });
});
