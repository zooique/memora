// @vitest-environment node
/**
 * 压缩包导入流水线 · 回归测试
 *
 * 被测不变量（对齐 `zipImport.ts` 文件头的七步流水线）：
 *   1. 路径校验（zip-slip）：`..` / 绝对路径 / 盘符 / 反斜杠 / 空名 / 空路径段一律拒绝；
 *   2. zip bomb：条目数 / 单条 / 总解压量超限 ⇒ 拒绝且不落盘；
 *   3. 类型识别：`manifest.json` ⇒ 角色包；`SKILL.md` ⇒ 文件夹技能；带 description 的 `.md`
 *      ⇒ 单文件技能；都不满足 ⇒ 明确拒绝；
 *   4. 格式校验：技能走 `validateSkillAsset`、角色包走 `validateManifestText`（缺省补 formatVersion）；
 *   5. 同名处置：确认回调返回 false ⇒ 一个字节都不写；true ⇒ 覆盖；
 *   6. 符号链接条目拒绝；非 zip / 空 zip 给出具体原因。
 *
 * 夹具：常规压缩包用 `yazl` 生成；zip-slip 条目无法经 yazl 构造（其 `validateMetadataPath`
 * 会直接拒绝 `..` / 绝对路径），故用「等长文件名字节替换」在生成的 zip 上改包——
 * 只改条目名字节，不手写解压器（生产解压仍全部走 yauzl）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import {
  importAssetZip,
  validateArchiveEntryPath,
  ZIP_IMPORT_LIMITS,
} from '../userAssets/zipImport.js';

/** 本文件创建的临时目录（afterEach 统一清理） */
const tempDirs: string[] = [];

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

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** 夹具条目 */
interface FixtureEntry {
  /** 条目路径（`/` 分隔） */
  name: string;
  /** 条目内容（文本或原始字节） */
  data: string | Buffer;
  /** yazl 选项（mode 可造符号链接条目） */
  options?: { mode?: number };
}

/**
 * 用 yazl 生成压缩包（测试夹具写入器，非生产解压器）
 *
 * @param zipPath 目标 zip 路径
 * @param entries 条目清单
 */
async function makeZip(zipPath: string, entries: FixtureEntry[]): Promise<void> {
  const zip = new ZipFile();
  for (const entry of entries) {
    zip.addBuffer(Buffer.from(entry.data), entry.name, entry.options);
  }
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(zipPath);
    zip.outputStream.on('error', reject);
    out.on('error', reject);
    out.on('close', () => resolve());
    zip.outputStream.pipe(out);
    zip.end();
  });
}

/**
 * 在已生成的 zip 上「等长改名」（构造 yazl 拒绝生成的恶意条目名）
 *
 * 前提：from 与 to 字节数相同 ⇒ 只替换文件名字节，不动长度字段 / CRC / 偏移。
 *
 * @param zipPath 目标 zip
 * @param from 原条目名（等长占位名）
 * @param to 恶意条目名（与 from 等长）
 */
function renameEntryBytes(zipPath: string, from: string, to: string): void {
  const fromBuf = Buffer.from(from);
  const toBuf = Buffer.from(to);
  if (fromBuf.length !== toBuf.length) {
    throw new Error(`夹具改名要求等长：${from}(${fromBuf.length}) vs ${to}(${toBuf.length})`);
  }
  const raw = readFileSync(zipPath);
  let index = raw.indexOf(fromBuf);
  while (index !== -1) {
    toBuf.copy(raw, index);
    index = raw.indexOf(fromBuf, index + fromBuf.length);
  }
  writeFileSync(zipPath, raw);
}

/** 默认覆盖确认（多数用例不需要覆盖） */
const neverOverwrite = vi.fn(async () => false);

describe('validateArchiveEntryPath · zip-slip 判据（单一真理源）', () => {
  /** 断言拒绝且原因含关键词 */
  function expectRejected(raw: string, keyword: string): void {
    const result = validateArchiveEntryPath(raw);
    expect(result.ok, `${raw} 应被拒绝`).toBe(false);
    if (!result.ok) expect(result.reason).toContain(keyword);
  }

  it('拒绝 `..` 上跳', () => {
    expectRejected('../../x.md', '路径穿越');
    expectRejected('a/../b.md', '路径穿越');
  });

  it('拒绝绝对路径与 Windows 盘符', () => {
    expectRejected('/absolute/x.md', '绝对路径');
    expectRejected('C:/evil.md', '盘符');
  });

  it('拒绝反斜杠（跨平台路径歧义）', () => {
    expectRejected('dir\\evil.md', '反斜杠');
    // 盘符 + 反斜杠同时出现时，先命中的判据是反斜杠（语义上两者都属拒绝理由）
    expectRejected('c:\\evil.md', '反斜杠');
  });

  it('拒绝空名 / 空路径段 / 单点段', () => {
    expectRejected('', '为空');
    expectRejected('a//b.md', '空路径段');
    expectRejected('a/./b.md', '空路径段');
  });

  it('允许并剥离前导 `./`（部分打包工具会带）', () => {
    const result = validateArchiveEntryPath('./ok.md');
    expect(result).toEqual({ ok: true, relPath: 'ok.md' });
  });
});

describe('importAssetZip · 包级拒绝（非 zip / 空包 / zip bomb / 符号链接）', () => {
  it('非 zip 文件 ⇒ 具体原因（不是「导入失败」四个字）', async () => {
    const dir = makeTempDir('memora-zip-notzip-');
    const zipPath = join(dir, 'fake.zip');
    writeFileSync(zipPath, 'this is not a zip', 'utf-8');
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => join(dir, 'out'),
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/不是有效的 zip 文件/);
  });

  it('空 zip ⇒ 明确说明压缩包为空', async () => {
    const dir = makeTempDir('memora-zip-empty-');
    const zipPath = join(dir, 'empty.zip');
    await makeZip(zipPath, []);
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => join(dir, 'out'),
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('压缩包为空');
  });

  it('总解压量超过上限 ⇒ 拒绝（zip bomb）', async () => {
    const dir = makeTempDir('memora-zip-bomb-');
    const zipPath = join(dir, 'bomb.zip');
    // 5 份各 5 MB（单条恰好未超，总量 25 MB 超过 20 MB 上限）；重复字符极易压缩
    const chunk = Buffer.alloc(5 * 1024 * 1024, 97);
    const entries: FixtureEntry[] = Array.from({ length: 5 }, (_, i) => ({
      name: `big-${i}.txt`,
      data: chunk,
    }));
    await makeZip(zipPath, entries);
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => join(dir, 'out'),
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(
        new RegExp(`总大小超过上限（${ZIP_IMPORT_LIMITS.maxTotalBytes}`),
      );
    }
  });

  it('符号链接条目 ⇒ 拒绝（防资源读取逃出目标目录）', async () => {
    const dir = makeTempDir('memora-zip-symlink-');
    const zipPath = join(dir, 'symlink.zip');
    await makeZip(zipPath, [{ name: 'link.md', data: 'target', options: { mode: 0o120777 } }]);
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => join(dir, 'out'),
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('符号链接');
  });

  it('zip-slip（`../`）⇒ 拒绝且不落盘', async () => {
    const dir = makeTempDir('memora-zip-slip-dotdot-');
    const zipPath = join(dir, 'slip.zip');
    const root = join(dir, 'out');
    await makeZip(zipPath, [{ name: 'aaaaaaaaaa', data: 'x' }]);
    renameEntryBytes(zipPath, 'aaaaaaaaaa', '../../x.md');
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/relative path|路径穿越|读取压缩包失败/);
    // 逃逸目标不应出现（写入从未开始）：目标根未被创建
    expect(existsSync(root)).toBe(false);
  });

  it('zip-slip（绝对路径）⇒ 拒绝', async () => {
    const dir = makeTempDir('memora-zip-slip-abs-');
    const zipPath = join(dir, 'slip-abs.zip');
    await makeZip(zipPath, [{ name: 'bbbbbbbbb', data: 'x' }]);
    renameEntryBytes(zipPath, 'bbbbbbbbb', '/abs/x.md');
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => join(dir, 'out'),
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/absolute path|绝对路径|读取压缩包失败/);
  });

  it('zip-slip（Windows 盘符）⇒ 拒绝', async () => {
    const dir = makeTempDir('memora-zip-slip-drive-');
    const zipPath = join(dir, 'slip-drive.zip');
    await makeZip(zipPath, [{ name: 'cccccccccc', data: 'x' }]);
    renameEntryBytes(zipPath, 'cccccccccc', 'C:/evil.md');
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => join(dir, 'out'),
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/absolute path|盘符|读取压缩包失败/);
  });
});

describe('importAssetZip · 类型识别与格式校验', () => {
  it('单文件技能（带 description 的 .md）⇒ 落 `<name>.md`', async () => {
    const dir = makeTempDir('memora-zip-skill-flat-');
    const root = join(dir, 'skills');
    const zipPath = join(dir, 'skill.zip');
    await makeZip(zipPath, [
      {
        name: 'demo-skill.md',
        data: '---\nname: demo-skill\ndescription: 演示技能\n---\n\n正文内容',
      },
    ]);
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.asset.kind).toBe('skill');
      expect(result.asset.name).toBe('demo-skill');
      expect(result.asset.targetPath).toBe(join(root, 'demo-skill.md'));
      expect(result.asset.fileCount).toBe(1);
    }
  });

  it('文件夹技能（SKILL.md + 资源）⇒ 整目录落盘', async () => {
    const dir = makeTempDir('memora-zip-skill-folder-');
    const root = join(dir, 'skills');
    const zipPath = join(dir, 'folder-skill.zip');
    await makeZip(zipPath, [
      {
        name: 'wrapped/SKILL.md',
        data: '---\nname: folder-skill\ndescription: 文件夹技能\n---\n\n正文',
      },
      { name: 'wrapped/resources/note.txt', data: '资源文件' },
    ]);
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.asset.kind).toBe('skill');
      expect(result.asset.targetPath).toBe(join(root, 'folder-skill'));
      expect(result.asset.fileCount).toBe(2);
    }
  });

  it('角色包（manifest.json）⇒ 补全 formatVersion 并落目录', async () => {
    const dir = makeTempDir('memora-zip-rolepack-');
    const root = join(dir, 'role-packs');
    const zipPath = join(dir, 'rolepack.zip');
    await makeZip(zipPath, [
      {
        name: 'rp/manifest.json',
        data: JSON.stringify({ name: 'demo-role', displayName: '演示角色' }),
      },
      { name: 'rp/persona.md', data: '你是演示角色。' },
    ]);
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.asset.kind).toBe('rolePack');
      expect(result.asset.name).toBe('demo-role');
      expect(result.asset.targetPath).toBe(join(root, 'demo-role'));
      const manifest = JSON.parse(
        readFileSync(join(result.asset.targetPath, 'manifest.json'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(manifest['formatVersion']).toBe('1.0.0');
    }
  });

  it('两者都不像 ⇒ 说明「不符合技能或角色包规范」', async () => {
    const dir = makeTempDir('memora-zip-unknown-');
    const zipPath = join(dir, 'unknown.zip');
    await makeZip(zipPath, [{ name: 'readme.txt', data: '普通文本' }]);
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => join(dir, 'out'),
      confirmOverwrite: neverOverwrite,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('不符合技能或角色包规范');
  });
});

describe('importAssetZip · 同名处置（不许静默覆盖）', () => {
  /** 准备「已存在同名技能」的场景 */
  async function setupExisting(): Promise<{ zipPath: string; root: string; existingPath: string }> {
    const dir = makeTempDir('memora-zip-overwrite-');
    const root = join(dir, 'skills');
    mkdirSync(root, { recursive: true });
    const existingPath = join(root, 'dup-skill.md');
    const zipPath = join(dir, 'dup.zip');
    writeFileSync(existingPath, '---\nname: dup-skill\ndescription: 旧\n---\n旧正文', 'utf-8');
    await makeZip(zipPath, [
      { name: 'dup-skill.md', data: '---\nname: dup-skill\ndescription: 新\n---\n新正文' },
    ]);
    return { zipPath, root, existingPath };
  }

  it('确认回调返回 false（取消）⇒ 原文件一字未改', async () => {
    const { zipPath, root, existingPath } = await setupExisting();
    const before = readFileSync(existingPath, 'utf-8');
    const confirmOverwrite = vi.fn(async () => false);
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('已取消导入');
    expect(confirmOverwrite).toHaveBeenCalledTimes(1);
    expect(readFileSync(existingPath, 'utf-8')).toBe(before);
  });

  it('确认回调返回 true（覆盖）⇒ 内容替换', async () => {
    const { zipPath, root, existingPath } = await setupExisting();
    const confirmOverwrite = vi.fn(async () => true);
    const result = await importAssetZip(zipPath, {
      targetRootFor: () => root,
      confirmOverwrite,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.asset.fileCount).toBe(1);
    expect(readFileSync(existingPath, 'utf-8')).toContain('新正文');
  });
});
