/**
 * 压缩包资产导入（技能 / 角色包）——**宿主唯一解压执行面**。
 *
 * ## 定位
 * 本模块只做「读 zip → 校验 → 落盘」，不弹框、不问 Agent、不执行包内脚本：
 * 交互（开文件框 / 选目标级 / 覆盖确认 / toast）归命令层（`commands/importAsset.ts`）。
 * 这样命令面板、设置页技能区、设置页角色包区三个入口共用同一处理器，本模块保持可单测。
 *
 * ## 校验流水线（顺序固定，任一步不过即拒绝且不落盘）
 * 1. 解压前上限：条目数 / 单条解压后大小 / 总解压大小（防 zip bomb），
 *    流式读取时再按**实际字节**二次校验（中央目录声明可被伪造）；
 * 2. 逐条目路径校验：拒绝对路径、盘符、`..`、`\`、空名；拒绝符号链接条目；
 *    最终写入路径必须落在目标目录内（`resolveInsideDir` 二次断言）；
 * 3. 类型识别：含 `manifest.json` ⇒ 角色包；否则含带 `description` 的 `.md`（或 `SKILL.md`
 *    文件夹形态）⇒ 技能；两者都不满足 ⇒ 拒绝并说明原因；
 * 4. 格式校验：技能走 `validateSkillAsset`，角色包走内核 `validateManifestText`
 *    （`formatVersion` 缺省补 `1.0.0` 后再校验与落盘）；
 * 5. 同名处置：目标已存在 ⇒ 由调用方明确询问「覆盖 / 取消」，取消则什么都不写；
 * 6. **暂存 + 换名提交**：全部内容先写进目标同父目录的隐藏暂存区（同卷 ⇒ `rename` 原子），
 *    确认写入完成后再换名；目标已存在时先换名成备份、提交成功才删备份，任一步失败即回滚
 *    （旧内容按字节原样恢复）。**不再「先删旧目标再逐条写」**——中途失败会留半包且旧包不可恢复。
 * 7. 写入完成后由调用方重扫（`resyncUserSkills` / `resyncUserPacks`）并刷新 UI。
 *
 * **不执行包内任何脚本**：只把条目当普通文件落盘（`.js` / `.py` 只写不跑）。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { logger, parseFrontmatter, validateManifestText } from '@zooique/memora';
import * as yauzl from 'yauzl';
import { pathExists, resolveInsideDir, sanitizeAssetName } from './path.js';
import { validateSkillAsset } from './write.js';

/** 解压上限（防 zip bomb；按「解压后」口径，不是压缩包大小） */
export const ZIP_IMPORT_LIMITS = {
  /** 条目数上限（含目录条目） */
  maxEntries: 500,
  /** 单条解压后大小上限（5 MB） */
  maxEntryBytes: 5 * 1024 * 1024,
  /** 全部条目解压后总大小上限（20 MB） */
  maxTotalBytes: 20 * 1024 * 1024,
} as const;

/** 暂存区名字前缀（只由本模块创建；清理按「前缀正则 + 过期时间」双判据，不碰其他文件） */
export const IMPORT_TMP_PREFIX = '.import-tmp-';
/** 覆盖前备份名标记：`<目标名>.bak-<12 位 hex>`；**不带 `.md` 后缀**，避免被技能扫描器当成新技能 */
const IMPORT_BAK_MARK = '.bak-';
/** 残留清理的过期阈值（1 小时）：只删过期残留，避免删掉并发进行中的导入暂存 */
const STALE_ARTIFACT_MS = 60 * 60 * 1000;
/** 暂存目录 / 暂存文件名的严格形态（12 位 hex，可选 `.md`） */
const TMP_ARTIFACT_RE = /^\.import-tmp-[0-9a-f]{12}(\.md)?$/;
/** 备份名的严格形态（`.bak-` + 12 位 hex 结尾） */
const BAK_ARTIFACT_RE = /\.bak-[0-9a-f]{12}$/;

/** 生成 12 位随机十六进制后缀（暂存 / 备份名唯一化，防同名并发互踩） */
function makeSuffix(): string {
  return randomBytes(6).toString('hex');
}

/**
 * 清理同目录下的导入残留（过期 `.import-tmp-*` 与 `*.bak-*`）
 *
 * 只匹配本模块自己的命名形态 + 只删超过阈值的项：刚创建的暂存可能属于**正在进行的另一次导入**，
 * 无条件删除会制造「导入进行中目标突然消失」的假失败。清理失败只记日志，**不升级为导入失败**。
 *
 * @param dir 目标父目录（暂存与备份都落在这里，与目标同卷）
 */
async function cleanupStaleArtifacts(dir: string): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const now = Date.now();
  for (const name of names) {
    if (!TMP_ARTIFACT_RE.test(name) && !BAK_ARTIFACT_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      const info = await stat(full);
      if (now - info.mtimeMs < STALE_ARTIFACT_MS) continue;
      await rm(full, { recursive: true, force: true });
    } catch (err) {
      logger.warn({ err, full }, '压缩包导入残留清理失败（不影响本次导入）');
    }
  }
}

/**
 * 换名提交暂存区（覆盖路径的唯一提交点）
 *
 * 顺序：备份已存在目标 → `rename(暂存 → 目标)` → 删备份。
 * 任一步失败：反向 `rename(备份 → 目标)` 恢复旧内容并删除暂存，保证**回滚后目标与导入前逐字节一致**
 * （备份是 `rename` 出来的，不是复制，字节零损耗）。
 *
 * @param stagedPath 暂存区绝对路径（目录形态为目录，单文件形态为 `<parent>/.import-tmp-xxxx.md`）
 * @param targetPath 目标绝对路径（首个命中的同名候选）
 * @param extraTargets 其余同名候选（单文件技能的「同名目录」占位；无新内容，仅备份后删除）
 * @param suffix 本次导入的随机后缀（备份名与之配对，便于清理）
 */
async function commitStaged(
  stagedPath: string,
  targetPath: string,
  extraTargets: string[],
  suffix: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  /** 已完成的备份（回滚时反向换名；`from` = 备份路径，`to` = 原目标路径） */
  const backups: { from: string; to: string }[] = [];
  try {
    for (const target of [targetPath, ...extraTargets]) {
      if (!(await pathExists(target))) continue;
      const backup = `${target}${IMPORT_BAK_MARK}${suffix}`;
      await rename(target, backup);
      backups.push({ from: backup, to: target });
    }
    await rename(stagedPath, targetPath);
  } catch (err) {
    // 回滚：先清掉可能已落到目标位置的新内容（正常路径下目标应不存在），再反向换名恢复旧内容
    for (const { from, to } of backups.reverse()) {
      try {
        if (await pathExists(to)) await rm(to, { recursive: true, force: true });
        await rename(from, to);
      } catch (rollbackErr) {
        logger.error({ rollbackErr, from, to }, '压缩包导入回滚失败（备份保留在磁盘，请手工恢复）');
      }
    }
    await rm(stagedPath, { recursive: true, force: true }).catch((cleanupErr: unknown) => {
      logger.warn({ cleanupErr, stagedPath }, '压缩包导入失败后清理暂存失败（不影响回滚结果）');
    });
    return {
      ok: false,
      reason: `换名提交失败，已回滚（目标保持导入前内容）：${(err as Error).message}`,
    };
  }
  // 提交成功后才删备份；删失败只记日志——此时目标已是新内容，把清理失败当导入失败属误报
  for (const { from } of backups) {
    await rm(from, { recursive: true, force: true }).catch((cleanupErr: unknown) => {
      logger.warn({ cleanupErr, from }, '压缩包导入备份清理失败（残留将被下次导入清理）');
    });
  }
  return { ok: true };
}

/** 资产类型（由压缩包内容识别，不由入口预设） */
export type AssetKind = 'skill' | 'rolePack';

/** 导入成功回执（toast 直接消费） */
export interface ImportedAsset {
  /** 识别出的资产类型 */
  kind: AssetKind;
  /** 资产名（技能名 / 角色包名） */
  name: string;
  /** 落点绝对路径（技能为 .md 文件或目录；角色包为目录） */
  targetPath: string;
  /** 实际写入的文件数（不含目录条目） */
  fileCount: number;
}

/** 同名覆盖确认入参 */
export interface OverwritePrompt {
  /** 资产类型 */
  kind: AssetKind;
  /** 资产名 */
  name: string;
  /** 已存在的目标路径（首个命中项） */
  targetPath: string;
}

/** 导入结果（失败必须给**具体原因**，不返回笼统「导入失败」） */
export type ImportZipResult =
  | { ok: true; asset: ImportedAsset }
  | { ok: false; reason: string; asset?: Pick<ImportedAsset, 'kind' | 'name'> };

/** 导入执行参数 */
export interface ImportZipOptions {
  /**
   * 按资产类型解析目标根目录。
   *
   * 类型由包内容识别，故目标根不能在调用前确定（技能 → skills 根，角色包 → role-packs 根）。
   * 用户级 / 项目级的选择在命令层完成，本模块只接收最终根路径。
   */
  targetRootFor: (kind: AssetKind) => string;
  /**
   * 同名已存在时的确认回调：true = 覆盖，false = 取消（**缺省语义即取消**）。
   * 不允许本模块自行决定覆盖——静默覆盖用户资产是最不可接受的失败形态。
   */
  confirmOverwrite: (prompt: OverwritePrompt) => Promise<boolean>;
}

/** 压缩包内一个已通过路径校验的文件条目（路径统一为 `/` 分隔的相对路径） */
interface ZipFileEntry {
  /** 相对路径（不含前导 `./`，`/` 分隔） */
  relPath: string;
  /** 原始字节 */
  data: Buffer;
}

/**
 * 校验并规范化单个条目路径（防 zip-slip 的唯一判据）
 *
 * @param raw 压缩包条目原名
 * @returns 通过时返回 `/` 分隔的相对路径；拒绝时给出具体原因
 */
export function validateArchiveEntryPath(
  raw: string,
): { ok: true; relPath: string } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: '条目名为空' };
  // 反斜杠在 zip 规范里不是分隔符，但 Windows 上会被当作分隔符 ⇒ 跨平台歧义，一律拒绝
  if (raw.includes('\\')) {
    return { ok: false, reason: `条目名含反斜杠（跨平台路径歧义）：${raw}` };
  }
  if (raw.startsWith('/')) return { ok: false, reason: `条目名为绝对路径：${raw}` };
  if (/^[A-Za-z]:/.test(raw)) return { ok: false, reason: `条目名含 Windows 盘符：${raw}` };
  if (raw.includes('\0')) return { ok: false, reason: '条目名含空字符' };
  // 允许并剥离前导 `./`（部分打包工具会带），剥离后仍按严格规则校验
  let normalized = raw;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.includes('//')) return { ok: false, reason: `条目名含空路径段：${raw}` };
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return { ok: false, reason: `条目名含路径穿越或空路径段：${raw}` };
  }
  return { ok: true, relPath: segments.join('/') };
}

/**
 * 判定条目是否为符号链接（Unix 模式下 mode 高 4 位 = 0o120000）
 *
 * 符号链接若落盘，后续读技能资源时会逃出目标目录（zip-slip 的变体），故一律拒绝。
 *
 * @param entry yauzl 条目元数据
 */
function isSymlinkEntry(entry: yauzl.Entry): boolean {
  // versionMadeBy 高字节 = 3 表示 Unix 创建（外部属性高 16 位才是文件模式）
  return (
    entry.versionMadeBy >> 8 === 3 &&
    ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
  );
}

/**
 * 读取 zip 全部文件条目（带解压上限与路径校验）
 *
 * 上限在两级校验：① 读数据前看中央目录声明；② 流式读取时按实际字节累计——
 * 只信声明会被伪造的 uncompressedSize 绕过（zip bomb 的常见变体）。
 *
 * @param zipPath zip 绝对路径
 * @returns 通过校验的文件条目（目录条目已跳过）
 */
async function readZipFileEntries(zipPath: string): Promise<ZipFileEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      { lazyEntries: true, autoClose: true, decodeStrings: true, strictFileNames: false },
      (openErr, zipFile) => {
        if (openErr || !zipFile) {
          reject(new Error(`不是有效的 zip 文件：${openErr?.message ?? '无法打开'}`));
          return;
        }
        const files: ZipFileEntry[] = [];
        /** 条目总数（含目录条目） */
        let entryCount = 0;
        /** 中央目录声明的总解压字节数 */
        let declaredTotal = 0;
        /** 实际读出的总字节数 */
        let actualTotal = 0;
        /** 是否已结束（防 close 后仍回调） */
        let settled = false;
        /** 统一的失败出口（幂等：先 close 再 reject） */
        const fail = (reason: string): void => {
          if (settled) return;
          settled = true;
          zipFile.close();
          reject(new Error(reason));
        };

        zipFile.on('error', (err) => fail(`读取压缩包失败：${err.message}`));
        zipFile.on('entry', (entry) => {
          if (settled) return;
          entryCount += 1;
          if (entryCount > ZIP_IMPORT_LIMITS.maxEntries) {
            fail(`压缩包条目数超过上限（${ZIP_IMPORT_LIMITS.maxEntries} 条）`);
            return;
          }
          // 目录条目只表达结构，不读数据、不计数；但仍做路径校验（防后续条目借目录名穿越）
          const validated = validateArchiveEntryPath(entry.fileName.replace(/\/$/, ''));
          if (!validated.ok) {
            fail(validated.reason);
            return;
          }
          if (entry.fileName.endsWith('/')) {
            zipFile.readEntry();
            return;
          }
          if (isSymlinkEntry(entry)) {
            fail(`压缩包包含符号链接条目（拒绝解压）：${entry.fileName}`);
            return;
          }
          // macOS 打包元数据不属资产内容，跳过（否则会污染技能目录 / 干扰根目录识别）
          if (
            validated.relPath.startsWith('__MACOSX/') ||
            basename(validated.relPath) === '.DS_Store'
          ) {
            zipFile.readEntry();
            return;
          }
          if (entry.uncompressedSize > ZIP_IMPORT_LIMITS.maxEntryBytes) {
            fail(
              `条目解压后超过单条上限（${ZIP_IMPORT_LIMITS.maxEntryBytes} 字节）：${entry.fileName}`,
            );
            return;
          }
          declaredTotal += entry.uncompressedSize;
          if (declaredTotal > ZIP_IMPORT_LIMITS.maxTotalBytes) {
            fail(`压缩包解压后总大小超过上限（${ZIP_IMPORT_LIMITS.maxTotalBytes} 字节）`);
            return;
          }
          zipFile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              fail(`读取条目失败：${entry.fileName}（${streamErr?.message ?? '无数据流'}）`);
              return;
            }
            const chunks: Buffer[] = [];
            let entryBytes = 0;
            stream.on('data', (chunk: Buffer) => {
              if (settled) return;
              entryBytes += chunk.length;
              actualTotal += chunk.length;
              if (entryBytes > ZIP_IMPORT_LIMITS.maxEntryBytes) {
                fail(`条目实际解压大小超过单条上限：${entry.fileName}`);
                return;
              }
              if (actualTotal > ZIP_IMPORT_LIMITS.maxTotalBytes) {
                fail(`压缩包实际解压总大小超过上限（${ZIP_IMPORT_LIMITS.maxTotalBytes} 字节）`);
                return;
              }
              chunks.push(chunk);
            });
            stream.on('error', (err) => fail(`读取条目失败：${entry.fileName}（${err.message}）`));
            stream.on('end', () => {
              if (settled) return;
              files.push({ relPath: validated.relPath, data: Buffer.concat(chunks) });
              zipFile.readEntry();
            });
          });
        });
        zipFile.on('end', () => {
          if (settled) return;
          settled = true;
          resolve(files);
        });
        zipFile.readEntry();
      },
    );
  });
}

/** 解析后的资产计划（类型识别 + 格式校验后的落盘蓝图） */
interface AssetPlan {
  kind: AssetKind;
  /** 资产名（已净化） */
  name: string;
  /** 相对资产根的条目（relPath 已是相对资产根） */
  entries: ZipFileEntry[];
  /** 目标路径在目标根下的**目录**名（技能单文件形态为 `<name>.md`） */
  targetName: string;
  /** 是否为技能单文件形态（决定落点是文件还是目录） */
  singleFile: boolean;
}

/**
 * 在条目集合中按「最短深度」挑唯一候选
 *
 * @param entries 候选条目
 * @returns 唯一命中；0 个或多个同深度命中均返回 undefined（后者属歧义）
 */
function pickShallowest<T extends { relPath: string }>(entries: T[]): T | undefined {
  if (entries.length === 0) return undefined;
  const depth = (relPath: string): number => relPath.split('/').length;
  const minDepth = Math.min(...entries.map((e) => depth(e.relPath)));
  const shallow = entries.filter((e) => depth(e.relPath) === minDepth);
  return shallow.length === 1 ? shallow[0] : undefined;
}

/**
 * 收集某目录下的全部条目（relPath 相对该目录；根目录为空串）
 *
 * @param entries 全部文件条目
 * @param rootDir 资产根目录（`manifest.json` / `SKILL.md` 所在目录）
 */
function entriesUnder(entries: ZipFileEntry[], rootDir: string): ZipFileEntry[] {
  const prefix = rootDir ? `${rootDir}/` : '';
  return entries
    .filter((e) => e.relPath.startsWith(prefix))
    .map((e) => ({ relPath: e.relPath.slice(prefix.length), data: e.data }))
    .filter((e) => e.relPath !== '');
}

/**
 * 识别压缩包资产类型并做格式校验（流水线第 3、4 步）
 *
 * @param entries 已通过路径校验的文件条目
 * @returns 落盘蓝图；不符合规范或校验失败时返回具体原因
 */
function planAsset(
  entries: ZipFileEntry[],
): { ok: true; plan: AssetPlan } | { ok: false; reason: string } {
  if (entries.length === 0) {
    return { ok: false, reason: '压缩包为空（没有可导入的文件）' };
  }

  // ── 角色包：含 manifest.json ──
  const manifestEntry = pickShallowest(
    entries.filter((e) => basename(e.relPath) === 'manifest.json'),
  );
  if (manifestEntry) {
    return planRolePack(entries, manifestEntry);
  }

  // ── 技能：文件夹形态 SKILL.md 优先，其次单文件 .md ──
  const folderEntry = pickShallowest(
    entries.filter((e) => basename(e.relPath).toLowerCase() === 'skill.md'),
  );
  if (folderEntry) return planFolderSkill(entries, folderEntry);

  return planFlatSkill(entries);
}

/**
 * 构造角色包蓝图（manifest 校验 + `formatVersion` 缺省补值）
 */
function planRolePack(
  entries: ZipFileEntry[],
  manifestEntry: ZipFileEntry,
): { ok: true; plan: AssetPlan } | { ok: false; reason: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(manifestEntry.data.toString('utf-8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: '角色包 manifest.json 不是合法的 JSON' };
  }
  // formatVersion 缺省补 1.0.0（与角色包 schema 默认同源；写入为让文件自描述）
  if (!parsed['formatVersion']) parsed['formatVersion'] = '1.0.0';
  const manifestText = `${JSON.stringify(parsed, null, 2)}\n`;
  const validation = validateManifestText(manifestText);
  const firstError = validation.issues.find((issue) => issue.severity === 'error');
  if (firstError) {
    return { ok: false, reason: `角色包 manifest 校验失败：${firstError.message}` };
  }
  const name = typeof parsed['name'] === 'string' ? parsed['name'] : '';
  const sanitized = sanitizeAssetName(name);
  if (!sanitized.ok) {
    return { ok: false, reason: `角色包名不可用作目录名：${sanitized.reason}` };
  }
  const rootDir = dirname(manifestEntry.relPath);
  // 根目录的 manifest.json 合法（rootDir 为 '.'，按空串处理）
  const assetRoot = rootDir === '.' ? '' : rootDir;
  const assetEntries = entriesUnder(entries, assetRoot);
  // manifest 内容替换为补全 formatVersion 后的规范化文本（其余条目原样）
  const normalized = assetEntries.map((e) =>
    e.relPath === 'manifest.json' ? { relPath: e.relPath, data: Buffer.from(manifestText) } : e,
  );
  return {
    ok: true,
    plan: {
      kind: 'rolePack',
      name: sanitized.name,
      entries: normalized,
      targetName: sanitized.name,
      singleFile: false,
    },
  };
}

/**
 * 构造文件夹形态技能蓝图（`<dir>/SKILL.md` + 资源/脚本目录）
 */
function planFolderSkill(
  entries: ZipFileEntry[],
  skillEntry: ZipFileEntry,
): { ok: true; plan: AssetPlan } | { ok: false; reason: string } {
  const parsed = parseFrontmatter(skillEntry.data.toString('utf-8'));
  const rootDir = dirname(skillEntry.relPath);
  const dirName = rootDir === '.' ? '' : basename(rootDir);
  const name = parsed.frontmatter['name'] ?? dirName;
  if (!name) {
    return {
      ok: false,
      reason: '文件夹形态技能缺少 frontmatter name，且压缩包内目录名为空（无法确定技能名）',
    };
  }
  const invalid = validateSkillAsset({
    name,
    description: parsed.frontmatter['description'] ?? '',
    content: parsed.body,
  });
  if (invalid) return { ok: false, reason: `技能校验失败：${invalid}` };
  const sanitized = sanitizeAssetName(name);
  if (!sanitized.ok) return { ok: false, reason: `技能名不可用作目录名：${sanitized.reason}` };
  const assetEntries = entriesUnder(entries, rootDir === '.' ? '' : rootDir);
  return {
    ok: true,
    plan: {
      kind: 'skill',
      name: sanitized.name,
      entries: assetEntries,
      targetName: sanitized.name,
      singleFile: false,
    },
  };
}

/**
 * 构造单文件形态技能蓝图（带 `description` frontmatter 的 `.md`，可位于包装目录内）
 *
 * 只认**最短深度**的唯一条目：多份同深度候选属歧义，直接拒绝而不是任选一个。
 */
function planFlatSkill(
  entries: ZipFileEntry[],
): { ok: true; plan: AssetPlan } | { ok: false; reason: string } {
  const candidates = entries.filter((e) => {
    if (!e.relPath.toLowerCase().endsWith('.md')) return false;
    const parsed = parseFrontmatter(e.data.toString('utf-8'));
    return Boolean(parsed.frontmatter['description']?.trim());
  });
  if (candidates.length === 0) {
    return {
      ok: false,
      reason:
        '压缩包不符合技能或角色包规范（未找到 manifest.json，也没有带 description 的 .md 技能文件）',
    };
  }
  const picked = pickShallowest(candidates);
  if (!picked) {
    return {
      ok: false,
      reason: `压缩包内含多个技能文件（${candidates.map((e) => e.relPath).join('、')}），无法确定导入哪一个`,
    };
  }
  const parsed = parseFrontmatter(picked.data.toString('utf-8'));
  const name = parsed.frontmatter['name'] ?? basename(picked.relPath, '.md');
  const invalid = validateSkillAsset({
    name,
    description: parsed.frontmatter['description'] ?? '',
    content: parsed.body,
  });
  if (invalid) return { ok: false, reason: `技能校验失败：${invalid}` };
  const sanitized = sanitizeAssetName(name);
  if (!sanitized.ok) return { ok: false, reason: `技能名不可用作目录名：${sanitized.reason}` };
  return {
    ok: true,
    plan: {
      kind: 'skill',
      name: sanitized.name,
      entries: [picked],
      targetName: `${sanitized.name}.md`,
      singleFile: true,
    },
  };
}

/**
 * 解析目标落点（含同名候选：单文件技能同时防「同名目录」占位）
 *
 * @param targetRoot 目标根目录
 * @param plan 资产蓝图
 */
function resolveTargets(
  targetRoot: string,
  plan: AssetPlan,
): { ok: true; targets: string[] } | { ok: false; reason: string } {
  const resolved = resolveInsideDir(targetRoot, plan.targetName);
  if (!resolved.ok) return resolved;
  // 单文件技能：同名目录也算冲突（内核按技能名去重，文件与目录同名会导致装载歧义）
  const targets = plan.singleFile ? [resolved.path, join(targetRoot, plan.name)] : [resolved.path];
  return { ok: true, targets };
}

/**
 * 导入压缩包为技能或角色包（唯一执行入口）
 *
 * @param zipPath zip 绝对路径
 * @param options 目标根解析 + 同名覆盖确认
 * @returns 成功回执 / 具体失败原因（**失败时不落盘**）
 */
export async function importAssetZip(
  zipPath: string,
  options: ImportZipOptions,
): Promise<ImportZipResult> {
  let entries: ZipFileEntry[];
  try {
    entries = await readZipFileEntries(zipPath);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const planned = planAsset(entries);
  if (!planned.ok) return { ok: false, reason: planned.reason };
  const { plan } = planned;

  const targetRoot = options.targetRootFor(plan.kind);
  const resolved = resolveTargets(targetRoot, plan);
  if (!resolved.ok)
    return { ok: false, reason: resolved.reason, asset: { kind: plan.kind, name: plan.name } };
  const targets = resolved.targets;
  const targetPath = targets[0]!;

  // 同名处置：任一候选已存在 ⇒ 必须由调用方明确确认；取消则什么都不写
  const existing: string[] = [];
  for (const target of targets) {
    if (await pathExists(target)) existing.push(target);
  }
  if (existing.length > 0) {
    const overwrite = await options.confirmOverwrite({
      kind: plan.kind,
      name: plan.name,
      targetPath: existing[0]!,
    });
    if (!overwrite) {
      return {
        ok: false,
        reason: `已取消导入：目标已存在（${existing[0]}），未做任何写入`,
        asset: { kind: plan.kind, name: plan.name },
      };
    }
    // 确认覆盖后**不在这里删旧目标**：删除动作归 `commitStaged`（先换名成备份，提交失败可回滚）
  }

  // ── 暂存写入：全部内容写进目标同父目录的隐藏暂存区，此阶段目标一字未动 ──
  const parentDir = dirname(targetPath);
  await mkdir(parentDir, { recursive: true }).catch(() => undefined);
  await cleanupStaleArtifacts(parentDir);
  const suffix = makeSuffix();
  const stagedPath = plan.singleFile
    ? join(parentDir, `${IMPORT_TMP_PREFIX}${suffix}.md`)
    : join(parentDir, `${IMPORT_TMP_PREFIX}${suffix}`);

  try {
    if (plan.singleFile) {
      await writeFile(stagedPath, plan.entries[0]!.data);
    } else {
      for (const entry of plan.entries) {
        // 逐条目二次逃逸断言（路径校验已在读包时做过，此处防「蓝图拼接」引入新逃逸）
        const destination = resolveInsideDir(stagedPath, entry.relPath);
        if (!destination.ok) throw new Error(`条目写入路径越出目标目录：${entry.relPath}`);
        await mkdir(dirname(destination.path), { recursive: true });
        await writeFile(destination.path, entry.data);
      }
    }
  } catch (err) {
    // 写入阶段失败：目标从未被改动，只需清掉暂存（清理失败只记日志，不掩盖原始错误）
    await rm(stagedPath, { recursive: true, force: true }).catch((cleanupErr: unknown) => {
      logger.warn({ cleanupErr, stagedPath }, '压缩包导入写入失败后清理暂存失败');
    });
    return {
      ok: false,
      reason: `写入失败（目标未改动）：${(err as Error).message}`,
      asset: { kind: plan.kind, name: plan.name },
    };
  }

  // ── 换名提交：备份 → rename → 删备份；任一步失败回滚到导入前内容 ──
  const committed = await commitStaged(stagedPath, targetPath, targets.slice(1), suffix);
  if (!committed.ok) {
    return { ok: false, reason: committed.reason, asset: { kind: plan.kind, name: plan.name } };
  }

  return {
    ok: true,
    asset: {
      kind: plan.kind,
      name: plan.name,
      targetPath,
      fileCount: plan.entries.length,
    },
  };
}
