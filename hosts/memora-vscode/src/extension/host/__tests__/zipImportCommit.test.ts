// @vitest-environment node
/**
 * 压缩包导入 · 暂存换名提交与失败回滚（覆盖写入的原子性回归测试）
 *
 * 立此用例的血训：旧实现「先 `rm(recursive)` 旧目标 → 再逐条写」，中途失败（磁盘满 / 进程被杀）
 * 会留下**半包**且旧包已不可恢复；而既有用例只覆盖「取消不动」与「成功替换」，失败中断完全没有射程。
 *
 * 被测不变量：
 *   1. 写入阶段失败 ⇒ 目标一个字节都没被改动（旧内容逐字节一致），暂存被清理；
 *   2. 换名提交失败 ⇒ 备份反向换名回滚，目标仍是旧版，备份与暂存均被清理；
 *   3. 成功覆盖 ⇒ 旧内容消失、新内容完整（补充断言：不残留 `.bak-`）；
 *   4. 目标不存在 ⇒ 直接换名提交，不产生任何 `.bak-`；
 *   5. 导入前清理过期残留（`.import-tmp-*` / `*.bak-*`），但**不删刚创建的**（可能属并发导入）；
 *   6. 回滚本身失败 ⇒ 备份转成 `.recovery-` 形态留盘（旧内容的唯一副本），且后续清理永不删它。
 *
 * 失败注入方式：`vi.mock('node:fs/promises')` 默认透传真实实现，仅按调用序号抛错——
 * 生产代码不留测试专用开关（不为可测性引入第二套写盘路径）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ZipFile } from 'yazl';

// vscode 替身：拒绝原因经 `vscode.l10n` 出键面（默认语言下原样返回英文源键，`{0}` 照常插值）
vi.mock('vscode', () => ({
  l10n: {
    t: (message: string, ...args: unknown[]) =>
      message.replace(/\{(\d+)\}/g, (m, i) => String(args[Number(i)] ?? m)),
  },
}));

/** 写盘 / 换名的失败注入控制（序号 = 0 基调用计数；空数组表示不注入） */
const fsControl = vi.hoisted(() => ({
  /** 需抛错的 writeFile 调用序号（可多点注入，如「提交失败 + 回滚失败」） */
  failWriteAt: [] as number[],
  /** writeFile 调用计数 */
  writeCalls: 0,
  /** 需抛错的 rename 调用序号（可多点注入，如「提交失败 + 回滚失败」） */
  failRenameAt: [] as number[],
  /** rename 调用计数 */
  renameCalls: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn(async (path: unknown, data: unknown, opts?: unknown) => {
      const index = fsControl.writeCalls++;
      if (fsControl.failWriteAt.includes(index)) throw new Error('注入失败：模拟磁盘写入失败');
      return (
        actual.writeFile as unknown as (p: unknown, d: unknown, o?: unknown) => Promise<void>
      )(path, data, opts);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const index = fsControl.renameCalls++;
      if (fsControl.failRenameAt.includes(index)) throw new Error('注入失败：模拟换名失败');
      return actual.rename(from, to);
    }),
  };
});

import { copyAssetToRoot, importAssetZip } from '../userAssets/zipImport.js';

/** 本文件创建的临时目录（afterEach 统一清理） */
const tempDirs: string[] = [];

/**
 * 计算文件 sha256（复制一致性判据：逐字节等价，不靠「看起来一样」）
 *
 * @param filePath 文件绝对路径
 */
function sha256Of(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/**
 * 建一个临时目录并登记清理
 *
 * @param prefix 目录名前缀（便于定位失败用例）
 */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 用 yazl 生成压缩包（测试夹具写入器）
 *
 * @param zipPath 目标 zip 路径
 * @param entries 条目清单（路径 → 内容）
 */
async function makeZip(zipPath: string, entries: { name: string; data: string }[]): Promise<void> {
  const zip = new ZipFile();
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.data), entry.name);
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    zip.outputStream.on('error', reject);
    out.on('error', reject);
    out.on('close', () => resolve());
    zip.outputStream.pipe(out);
    zip.end();
  });
}

/** 目录里是否还有导入残留（暂存 / 备份）——`.recovery-` 是**主动保留**的恢复备份，不算残留 */
function hasLeftovers(dir: string): boolean {
  return readdirSync(dir).some(
    (name) => name.startsWith('.import-tmp-') || /\.bak-[0-9a-f]{12}$/.test(name),
  );
}

/**
 * 找出目录里的恢复备份（形如 `.<目标名>.recovery-<12 位 hex>`）
 *
 * @param dir 目标父目录
 * @returns 命中的目录项名；未命中返回 undefined
 */
function findRecovery(dir: string): string | undefined {
  return readdirSync(dir).find((name) => /\.recovery-[0-9a-f]{12}$/.test(name));
}

beforeEach(() => {
  fsControl.failWriteAt = [];
  fsControl.writeCalls = 0;
  fsControl.failRenameAt = [];
  fsControl.renameCalls = 0;
});

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** 旧角色包内容（逐字节比对的基准） */
const OLD_MANIFEST = '{\n  "name": "demo-role",\n  "displayName": "旧版"\n}\n';
/** 旧角色包附带的旧资源文件 */
const OLD_EXTRA = '旧版资源内容：不得被半包污染';

/**
 * 准备「已存在同名角色包」的覆盖场景（旧目录含 manifest 与旧资源）
 *
 * @param fail 失败注入（组件在用例内设置 fsControl 后调用）
 */
function setupExistingRolePack(): { zipPath: string; root: string; targetDir: string } {
  const dir = makeTempDir('memora-zip-commit-');
  const root = join(dir, 'role-packs');
  const targetDir = join(root, 'demo-role');
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'manifest.json'), OLD_MANIFEST, 'utf-8');
  writeFileSync(join(targetDir, 'old.md'), OLD_EXTRA, 'utf-8');
  const zipPath = join(dir, 'demo-role.zip');
  return { zipPath, root, targetDir };
}

describe('importAssetZip · 暂存换名（失败中断不得损坏旧目标）', () => {
  it('写到一半失败 ⇒ 旧目标逐字节完好且暂存被清理', async () => {
    const { zipPath, root, targetDir } = setupExistingRolePack();
    await makeZip(zipPath, [
      { name: 'rp/manifest.json', data: JSON.stringify({ name: 'demo-role' }) },
      { name: 'rp/persona.md', data: '新版人格设定' },
      { name: 'rp/extra.md', data: '新版资源' },
    ]);
    // 第 2 次写盘失败（manifest 已写进暂存，persona 失败）⇒ 目标应完全未动
    fsControl.failWriteAt = [1];

    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite: async () => true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('写入失败');
    // 旧内容逐字节一致（不是「看起来还在」，而是字节相等）
    expect(readFileSync(join(targetDir, 'manifest.json'), 'utf-8')).toBe(OLD_MANIFEST);
    expect(readFileSync(join(targetDir, 'old.md'), 'utf-8')).toBe(OLD_EXTRA);
    expect(readdirSync(targetDir).sort()).toEqual(['manifest.json', 'old.md']);
    // 暂存必须被清理（否则会污染下一次扫描 / 被当成技能）
    expect(hasLeftovers(root)).toBe(false);
  });

  it('换名提交失败 ⇒ 回滚到旧版，备份与暂存均被清理', async () => {
    const { zipPath, root, targetDir } = setupExistingRolePack();
    await makeZip(zipPath, [
      { name: 'rp/manifest.json', data: JSON.stringify({ name: 'demo-role' }) },
      { name: 'rp/persona.md', data: '新版人格设定' },
    ]);
    // rename 序：① 目标→备份（成功）② 暂存→目标（注入失败）③ 备份→目标（回滚，成功）
    fsControl.failRenameAt = [1];

    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite: async () => true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('已回滚');
    // 回滚后目标仍是旧版（逐字节一致），且没有新版文件混入
    expect(readFileSync(join(targetDir, 'manifest.json'), 'utf-8')).toBe(OLD_MANIFEST);
    expect(readFileSync(join(targetDir, 'old.md'), 'utf-8')).toBe(OLD_EXTRA);
    expect(readdirSync(targetDir).sort()).toEqual(['manifest.json', 'old.md']);
    expect(hasLeftovers(root)).toBe(false);
  });

  it('回滚失败 ⇒ 旧内容转成 .recovery- 留盘，后续导入的清理也不删它', async () => {
    const { zipPath, root, targetDir } = setupExistingRolePack();
    await makeZip(zipPath, [
      { name: 'rp/manifest.json', data: JSON.stringify({ name: 'demo-role' }) },
      { name: 'rp/persona.md', data: '新版人格设定' },
    ]);
    // rename 序：① 目标→备份（成功）② 暂存→目标（失败）③ 备份→目标（回滚也失败）
    //          ④ 备份→`.recovery-`（标记成功，旧内容得以留盘）
    fsControl.failRenameAt = [1, 2];

    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite: async () => true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('回滚未完成');
    // 目标位置已无旧内容（旧内容的唯一副本迁到了恢复备份）
    expect(existsSync(targetDir)).toBe(false);
    // 恢复备份存在且旧内容逐字节完好
    const recoveryName = findRecovery(root);
    expect(recoveryName).toBeDefined();
    const recoveryDir = join(root, recoveryName!);
    expect(readFileSync(join(recoveryDir, 'manifest.json'), 'utf-8')).toBe(OLD_MANIFEST);
    expect(readFileSync(join(recoveryDir, 'old.md'), 'utf-8')).toBe(OLD_EXTRA);
    // 暂存与 `.bak-` 均已清理（`.recovery-` 不算残留）
    expect(hasLeftovers(root)).toBe(false);

    // 把恢复备份的 mtime 回拨 2 小时（超过清理阈值），再用一次成功导入触发 cleanupStaleArtifacts
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(recoveryDir, twoHoursAgo, twoHoursAgo);
    const secondZip = join(dirname(zipPath), 'fresh-skill.zip');
    await makeZip(secondZip, [
      {
        name: 'fresh-skill.md',
        data: '---\nname: fresh-skill\ndescription: 新技能\n---\n正文',
      },
    ]);
    const second = await importAssetZip(secondZip, {
      targetRootFor: () => root,
      confirmOverwrite: async () => false,
    });
    expect(second.ok).toBe(true);
    // 清理跑过一轮，恢复备份仍在（清理逻辑无条件跳过 `.recovery-`），旧内容未被销毁
    expect(findRecovery(root)).toBe(recoveryName);
    expect(readFileSync(join(recoveryDir, 'manifest.json'), 'utf-8')).toBe(OLD_MANIFEST);
    expect(readFileSync(join(recoveryDir, 'old.md'), 'utf-8')).toBe(OLD_EXTRA);
  });

  it('成功覆盖 ⇒ 旧内容消失、新内容完整、不残留备份', async () => {
    const { zipPath, root, targetDir } = setupExistingRolePack();
    await makeZip(zipPath, [
      { name: 'rp/manifest.json', data: JSON.stringify({ name: 'demo-role' }) },
      { name: 'rp/persona.md', data: '新版人格设定' },
    ]);

    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite: async () => true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.asset.fileCount).toBe(2);
    expect(readFileSync(join(targetDir, 'persona.md'), 'utf-8')).toBe('新版人格设定');
    // 旧目录里的旧文件随旧版整体被替换，不残留
    expect(readdirSync(targetDir).sort()).toEqual(['manifest.json', 'persona.md']);
    expect(hasLeftovers(root)).toBe(false);
  });

  it('目标不存在 ⇒ 直接换名提交，不产生任何 .bak', async () => {
    const dir = makeTempDir('memora-zip-fresh-');
    const root = join(dir, 'skills');
    const zipPath = join(dir, 'fresh.zip');
    await makeZip(zipPath, [
      {
        name: 'fresh-skill.md',
        data: '---\nname: fresh-skill\ndescription: 新技能\n---\n正文',
      },
    ]);

    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.asset.targetPath).toBe(join(root, 'fresh-skill.md'));
    expect(readdirSync(root)).toEqual(['fresh-skill.md']);
    expect(hasLeftovers(root)).toBe(false);
  });

  it('导入前清理过期残留，但不删刚创建的暂存', async () => {
    const dir = makeTempDir('memora-zip-stale-');
    const root = join(dir, 'skills');
    mkdirSync(root, { recursive: true });
    // 过期残留：一个暂存目录 + 一个备份文件（mtime 回拨 2 小时）
    const staleTmp = join(root, '.import-tmp-0123456789ab');
    const staleBak = join(root, 'old-skill.md.bak-0123456789ab');
    mkdirSync(staleTmp, { recursive: true });
    writeFileSync(staleBak, '备份内容', 'utf-8');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);
    utimesSync(staleBak, twoHoursAgo, twoHoursAgo);
    // 新鲜残留：可能是并发导入的暂存，必须保留
    const freshTmp = join(root, '.import-tmp-fedcba987654');
    mkdirSync(freshTmp);

    const zipPath = join(dir, 'new.zip');
    await makeZip(zipPath, [
      {
        name: 'new-skill.md',
        data: '---\nname: new-skill\ndescription: 新技能\n---\n正文',
      },
    ]);

    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(true);
    expect(readdirSync(root).sort()).toEqual(['.import-tmp-fedcba987654', 'new-skill.md']);
  });
});

describe('copyAssetToRoot · 项目级 → 用户级（拷贝非同步，复用同一提交原语）', () => {
  it('单文件技能：内容逐字节一致，落点 = 同名 .md，回执 1 个文件', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const source = join(project, 'TESTSKILL-A.md');
    writeFileSync(source, '# TESTSKILL-A\n正文一行\n', 'utf-8');

    const result = await copyAssetToRoot(source, user, {
      kind: 'skill',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetPath).toBe(join(user, 'TESTSKILL-A.md'));
    expect(readFileSync(result.targetPath, 'utf-8')).toBe('# TESTSKILL-A\n正文一行\n');
    // 逐字节一致（sha256），不是「内容看起来一样」
    expect(sha256Of(result.targetPath)).toBe(sha256Of(source));
    expect(result.fileCount).toBe(1);
    // 拷贝而非链接：项目侧删掉后用户侧仍在（内容已实体化）
    rmSync(source);
    expect(readFileSync(result.targetPath, 'utf-8')).toBe('# TESTSKILL-A\n正文一行\n');
  });

  it('角色包目录：整目录递归复制，文件数如实统计', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const source = join(project, 'TESTPACK-A');
    mkdirSync(join(source, 'skills'), { recursive: true });
    writeFileSync(join(source, 'manifest.json'), '{"name":"TESTPACK-A"}', 'utf-8');
    writeFileSync(join(source, 'skills', 'demo.md'), 'demo', 'utf-8');

    const result = await copyAssetToRoot(source, user, {
      // 角色包按整目录复制：kind 由调用方显式给出，执行面不得按源形态推断
      kind: 'rolePack',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fileCount).toBe(2);
    expect(readFileSync(join(result.targetPath, 'manifest.json'), 'utf-8')).toBe(
      '{"name":"TESTPACK-A"}',
    );
    expect(readFileSync(join(result.targetPath, 'skills', 'demo.md'), 'utf-8')).toBe('demo');
  });

  it('同名已存在 + 用户取消 ⇒ 目标一字未动，回执说明原因（不静默跳过）', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const source = join(project, 'TESTSKILL-B.md');
    writeFileSync(source, '新版内容', 'utf-8');
    const target = join(user, 'TESTSKILL-B.md');
    writeFileSync(target, '旧版内容', 'utf-8');

    const result = await copyAssetToRoot(source, user, {
      kind: 'skill',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('已取消复制');
    expect(readFileSync(target, 'utf-8')).toBe('旧版内容');
    expect(hasLeftovers(user)).toBe(false);
  });

  it('同名已存在 + 用户确认覆盖 ⇒ 新内容生效，事务备份按同原语清理（无残留）', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const source = join(project, 'TESTSKILL-C.md');
    writeFileSync(source, '新版内容', 'utf-8');
    const target = join(user, 'TESTSKILL-C.md');
    writeFileSync(target, '旧版内容', 'utf-8');

    const result = await copyAssetToRoot(source, user, {
      kind: 'skill',
      confirmOverwrite: async () => true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(target, 'utf-8')).toBe('新版内容');
    // 与压缩包导入同一语义：备份是事务内临时物，提交成功后清理；失败路径由上方回滚用例覆盖
    expect(hasLeftovers(user)).toBe(false);
  });

  it('源资产不存在 ⇒ 明确失败，不创建任何目标', async () => {
    const user = makeTempDir('memora-copy-user-');
    const result = await copyAssetToRoot(join(user, 'missing.md'), user, {
      kind: 'skill',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('源资产不存在');
    expect(readdirSync(user)).toEqual([]);
  });

  // ── 角色包专属回归（真机缺陷：manifest.json 被当技能平铺复制到用户根） ──
  it('角色包来源误传 manifest.json ⇒ 必须拒绝，用户根目录不得出现平铺 manifest.json', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const packDir = join(project, 'TESTPACK-COPY');
    mkdirSync(packDir, { recursive: true });
    const manifestPath = join(packDir, 'manifest.json');
    writeFileSync(manifestPath, '{"name":"TESTPACK-COPY"}', 'utf-8');

    // 旧实现会把普通文件当单文件技能：name 只剥 .md ⇒ manifest.json 平铺进用户根目录
    const result = await copyAssetToRoot(manifestPath, user, {
      kind: 'rolePack',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('必须是包目录');
    expect(result.reason).toContain(manifestPath);
    expect(readdirSync(user)).toEqual([]);
    expect(hasLeftovers(user)).toBe(false);
  });

  it('角色包按包目录复制：产出 <pkg>/manifest.json + persona.md + rules.md，根目录无平铺文件', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const packDir = join(project, 'TESTPACK-COPY');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, 'manifest.json'), '{"name":"TESTPACK-COPY"}', 'utf-8');
    writeFileSync(join(packDir, 'persona.md'), 'persona-body', 'utf-8');
    writeFileSync(join(packDir, 'rules.md'), 'rules-body', 'utf-8');

    const result = await copyAssetToRoot(packDir, user, {
      kind: 'rolePack',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetPath).toBe(join(user, 'TESTPACK-COPY'));
    expect(result.fileCount).toBe(3);
    expect(readFileSync(join(result.targetPath, 'manifest.json'), 'utf-8')).toBe(
      '{"name":"TESTPACK-COPY"}',
    );
    expect(readFileSync(join(result.targetPath, 'persona.md'), 'utf-8')).toBe('persona-body');
    expect(readFileSync(join(result.targetPath, 'rules.md'), 'utf-8')).toBe('rules-body');
    // 三文件逐字节一致（sha256 对源）
    for (const file of ['manifest.json', 'persona.md', 'rules.md']) {
      expect(sha256Of(join(result.targetPath, file))).toBe(sha256Of(join(packDir, file)));
    }
    // 用户级根目录只应有包目录，不得出现平铺的 manifest.json（真机缺陷形态）
    expect(readdirSync(user)).toEqual(['TESTPACK-COPY']);
    expect(hasLeftovers(user)).toBe(false);
  });

  it('角色包目录缺 manifest.json ⇒ 拒绝并给绝对路径，不落半份', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const packDir = join(project, 'BROKEN-PACK');
    mkdirSync(packDir, { recursive: true });
    writeFileSync(join(packDir, 'persona.md'), 'persona', 'utf-8');

    const result = await copyAssetToRoot(packDir, user, {
      kind: 'rolePack',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('manifest.json');
    expect(result.reason).toContain(packDir);
    expect(readdirSync(user)).toEqual([]);
  });

  // ── 目录式技能 / 单文件技能：同一通病（宿主拿到的 path 是入口，不是包根） ──
  it('目录式技能：包根 = 技能目录 ⇒ 入口与资源随包复制，sha256 一致，根目录无平铺入口', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const skillDir = join(project, 'TEST-SKILL-DIR');
    mkdirSync(join(skillDir, 'resources'), { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: TEST-SKILL-DIR\n---\n# 目录式技能',
      'utf-8',
    );
    writeFileSync(join(skillDir, 'resources', 'ref.md'), '资源正文', 'utf-8');
    // 兄弟技能放在同一扫描根：整包复制只能搬这个目录，不得带走根下裸 .md
    writeFileSync(join(project, 'SIBLING-SKILL.md'), '兄弟技能', 'utf-8');

    const result = await copyAssetToRoot(skillDir, user, {
      kind: 'skill',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetPath).toBe(join(user, 'TEST-SKILL-DIR'));
    expect(result.fileCount).toBe(2);
    // 入口与资源都在包目录内，且逐字节一致
    expect(sha256Of(join(result.targetPath, 'SKILL.md'))).toBe(
      sha256Of(join(skillDir, 'SKILL.md')),
    );
    expect(sha256Of(join(result.targetPath, 'resources', 'ref.md'))).toBe(
      sha256Of(join(skillDir, 'resources', 'ref.md')),
    );
    // 用户根只应有技能目录：不得散落平铺 SKILL.md，也不得搬走兄弟技能
    expect(readdirSync(user)).toEqual(['TEST-SKILL-DIR']);
    expect(existsSync(join(user, 'SKILL.md'))).toBe(false);
    expect(existsSync(join(user, 'SIBLING-SKILL.md'))).toBe(false);
    expect(hasLeftovers(user)).toBe(false);
  });

  it('目录式技能误传入口文件（旧调用方形态）⇒ 拒绝，不得只复制入口丢资源', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const skillDir = join(project, 'TEST-SKILL-DIR');
    mkdirSync(join(skillDir, 'resources'), { recursive: true });
    const entry = join(skillDir, 'SKILL.md');
    writeFileSync(entry, '---\nname: TEST-SKILL-DIR\n---\n# 目录式技能', 'utf-8');
    writeFileSync(join(skillDir, 'resources', 'ref.md'), '资源正文', 'utf-8');

    // 旧调用方（拿 SkillEntry.filePath 直接复制）传入的是入口文件：必须拒，不许猜成 dirname
    const result = await copyAssetToRoot(entry, user, {
      kind: 'skill',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('技能目录作为包根');
    expect(result.reason).toContain(entry);
    // 零写入：用户根既无平铺 SKILL.md，也无任何残留
    expect(readdirSync(user)).toEqual([]);
    expect(hasLeftovers(user)).toBe(false);
  });

  it('单文件技能：只复制该文件，不搬兄弟技能（专打 dirname 反推）', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const skillsDir = join(project, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const source = join(skillsDir, 'TESTSKILL-ONE.md');
    writeFileSync(source, '# TESTSKILL-ONE\n正文\n', 'utf-8');
    // 兄弟技能在同一目录：若把 dirname(入口) 当包根，就会整目录搬走
    writeFileSync(join(skillsDir, 'TESTSKILL-TWO.md'), '# TESTSKILL-TWO\n', 'utf-8');

    const result = await copyAssetToRoot(source, user, {
      kind: 'skill',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetPath).toBe(join(user, 'TESTSKILL-ONE.md'));
    expect(result.fileCount).toBe(1);
    expect(sha256Of(result.targetPath)).toBe(sha256Of(source));
    // 只有这一个文件；兄弟技能不得被搬过来
    expect(readdirSync(user)).toEqual(['TESTSKILL-ONE.md']);
    expect(existsSync(join(user, 'TESTSKILL-TWO.md'))).toBe(false);
    expect(hasLeftovers(user)).toBe(false);
  });

  it('目录式技能包根缺入口 ⇒ 拒绝并给绝对路径，零写入', async () => {
    const project = makeTempDir('memora-copy-project-');
    const user = makeTempDir('memora-copy-user-');
    const broken = join(project, 'BROKEN-SKILL');
    mkdirSync(join(broken, 'resources'), { recursive: true });
    writeFileSync(join(broken, 'resources', 'ref.md'), '资源', 'utf-8');

    const result = await copyAssetToRoot(broken, user, {
      kind: 'skill',
      confirmOverwrite: async () => false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('SKILL.md');
    expect(result.reason).toContain(broken);
    expect(readdirSync(user)).toEqual([]);
    expect(hasLeftovers(user)).toBe(false);
  });
});
