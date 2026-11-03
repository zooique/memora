/**
 * 压缩包资产导入（技能 / 角色包）——**宿主唯一解压执行面**。
 *
 * ## 定位
 * 本模块只做「读 zip → 校验 → 落盘」，不弹框、不问 Agent、不执行包内脚本：
 * 交互（开文件框 / 选目标级 / 覆盖确认 / toast）归命令层（`commands/importAsset.ts`）。
 * 这样命令面板、设置页技能区、设置页角色包区三个入口共用同一处理器，本模块保持可单测。
 *
 * **第二个消费面（2026-11-03）**：设置页「添加到用户级」把**项目级**技能 / 角色包从
 * **资产包根**（内核 `SkillEntry.packageRoot` / `RolePack.packageRoot`）复制到用户目录
 * （`copyAssetToRoot`）。它不读 zip，但**必须复用同一套暂存 / 备份 / 换名 / 回滚 /
 * `.recovery-` 原语**——再写一份「复制 + 覆盖」就是第二套覆盖语义，两份从落笔起必然漂移。
 *
 * ## 校验流水线（顺序固定，任一步不过即拒绝且不落盘）
 * 1. 解压前上限：条目数 / 单条解压后大小 / 总解压大小（防 zip bomb），
 *    流式读取时再按**实际字节**二次校验（中央目录声明可被伪造）；
 * 2. 逐条目路径校验：拒绝对路径、盘符、`..`、`\`、空名；拒绝符号链接条目；
 *    最终写入路径必须落在目标目录内（`resolveInsideDir` 二次断言）；
 * 3. 类型识别：含 `manifest.json` ⇒ 角色包；否则含带 `description` 的 `.md`（或 `SKILL.md`
 *    文件夹形态）⇒ 技能；两者都不满足 ⇒ 拒绝并说明原因；
 * 4. 格式校验：技能走 `validateSkillAsset`（`./validateSkill.ts`，只校验不落盘），
 *    角色包走内核 `validateManifestText`（`formatVersion` 缺省补 `1.0.0` 后再校验与落盘）；
 * 5. 同名处置：**内置角色包**同名 ⇒ 由调用方经 `isNameTaken` 直接拒绝（内置属产品组成，
 *    被同名用户包顶掉会让人以为功能消失）；其余目标已存在 ⇒ 明确询问「覆盖 / 取消」，取消则零写入；
 * 6. **暂存 + 换名提交**：全部内容先写进目标同父目录的隐藏暂存区（同卷 ⇒ `rename` 原子），
 *    确认写入完成后再换名；目标已存在时先换名成备份、提交成功才删备份，任一步失败即回滚
 *    （旧内容按字节原样恢复）。**不再「先删旧目标再逐条写」**——中途失败会留半包且旧包不可恢复。
 *    回滚本身失败时，备份改名为 `.<目标名>.recovery-<hex>`（前导点让扫描器跳过）——
 *    这是旧内容的**唯一副本**，残留清理永不删除它，日志写绝对路径供人工恢复。
 * 7. 写入完成后由调用方重扫（`resyncUserSkills` / `resyncUserPacks`）并刷新 UI。
 *
 * **不执行包内任何脚本**：只把条目当普通文件落盘（`.js` / `.py` 只写不跑）。
 */
import { randomBytes } from 'node:crypto';
import { cp, copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { logger, parseFrontmatter, SKILL_MAIN_FILE, validateManifestText } from '@zooique/memora';
import * as yauzl from 'yauzl';
import { pathExists, resolveInsideDir, sanitizeAssetName } from './path.js';
import { validateSkillAsset } from './validateSkill.js';

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
/** 回滚失败的恢复备份标记：`.<目标名>.recovery-<12 位 hex>` */
const IMPORT_RECOVERY_MARK = '.recovery-';
/** 恢复备份名的严格形态（匹配即**永不清理**——它是用户旧内容的唯一副本） */
const RECOVERY_ARTIFACT_RE = /\.recovery-[0-9a-f]{12}$/;

/** 生成 12 位随机十六进制后缀（暂存 / 备份名唯一化，防同名并发互踩） */
function makeSuffix(): string {
  return randomBytes(6).toString('hex');
}

/**
 * 恢复备份路径：`<父目录>/.<目标名>.recovery-<hex>`
 *
 * 前导点不是装饰——技能 / 角色包扫描器都跳过 `.` 开头的条目，否则恢复出来的旧目录
 * 会被当成同名资产再次装载（用旧内容顶掉刚提交的新内容）。
 */
function recoveryPathFor(target: string, suffix: string): string {
  return join(dirname(target), `.${basename(target)}${IMPORT_RECOVERY_MARK}${suffix}`);
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
    // 恢复备份是回滚失败时旧内容的唯一副本 ⇒ 无条件跳过，永不按过期时间清理
    if (RECOVERY_ARTIFACT_RE.test(name)) continue;
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
 * 回滚本身失败（如目标位置满 / 权限突变）：备份改名为 `.recovery-` 形态并**留在磁盘**，
 * 残留清理永不删除它——旧内容此时只有这一份，删掉等于替用户销毁数据。
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
  /** 回滚失败后保留的恢复备份绝对路径（供回执与日志告知用户手工恢复） */
  const recoveries: string[] = [];
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
        // 回滚失败：旧内容此刻只在这份备份里 ⇒ 改成清理永不碰的恢复形态并记录绝对路径
        const recovery = recoveryPathFor(to, suffix);
        try {
          await rename(from, recovery);
          recoveries.push(recovery);
          logger.error({ rollbackErr, recovery }, '压缩包导入回滚失败（旧内容已保留为恢复备份）');
        } catch (markErr) {
          // 连改名都失败：备份仍是 `.bak-` 形态，必须在回执里点名，避免用户误以为已恢复
          recoveries.push(from);
          logger.error(
            { rollbackErr, markErr, backup: from },
            '压缩包导入回滚失败且无法标记恢复形态（旧内容仍在原备份路径）',
          );
        }
      }
    }
    await rm(stagedPath, { recursive: true, force: true }).catch((cleanupErr: unknown) => {
      logger.warn({ cleanupErr, stagedPath }, '压缩包导入失败后清理暂存失败（不影响回滚结果）');
    });
    return recoveries.length > 0
      ? {
          ok: false,
          reason: `换名提交失败且回滚未完成，旧内容保留为恢复备份：${recoveries.join('、')}（请手工恢复）：${(err as Error).message}`,
        }
      : {
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
  /**
   * 名字是否已被**内置角色包**占用（仅角色包调用；技能不走本判据）。
   *
   * 命中即拒绝且零写入：内置包属产品组成，被同名用户 / 项目包顶掉会让人以为功能消失。
   * 判定归调用方（内置目录清单是宿主知识），本模块只消费布尔结果。
   */
  isNameTaken?: (name: string) => boolean | Promise<boolean>;
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
 * `validateEntrySizes: false` 是刻意关掉的：yauzl 的尺寸断言会在业务层之前直接报错
 * （deflated 走 `AssertByteCountStream`、stored 在中央目录解析阶段比对 compressed/uncompressed），
 * 结果是「实际字节二次校验」成死代码。关掉后**上限判据全部归本模块**：声明照看（快速拒），
 * 实际字节照算（防伪造），两级都在这里。
 *
 * @param zipPath zip 绝对路径
 * @returns 通过校验的文件条目（目录条目已跳过）
 */
async function readZipFileEntries(zipPath: string): Promise<ZipFileEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      zipPath,
      {
        lazyEntries: true,
        autoClose: true,
        decodeStrings: true,
        strictFileNames: false,
        // 见上方说明：尺寸断言交给本模块的两级上限，否则「按实际字节」永远不可达
        validateEntrySizes: false,
      },
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
  // 单文件技能：同名目录也算冲突（内核按技能名去重，文件与目录同名会导致装载歧义）
  const candidates = plan.singleFile ? [plan.targetName, plan.name] : [plan.targetName];
  const targets: string[] = [];
  // 路径推导只经 `resolveInsideDir`（单点纪律）：裸 `join` 会绕开逃逸断言
  for (const candidate of candidates) {
    const resolved = resolveInsideDir(targetRoot, candidate);
    if (!resolved.ok) return resolved;
    targets.push(resolved.path);
  }
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

  // 内置同名判定：只对角色包生效，且在解析目标 / 建目录之前 ⇒ 命中即零写入
  if (plan.kind === 'rolePack' && options.isNameTaken && (await options.isNameTaken(plan.name))) {
    return {
      ok: false,
      reason: `已存在同名角色包（内置）「${plan.name}」，请改名后再导入`,
      asset: { kind: plan.kind, name: plan.name },
    };
  }

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

/** 复制资产到另一根目录（项目级 → 用户级）的入参 */
export interface CopyAssetOptions {
  /**
   * 资产类型：**只决定校验规则与文案，绝不决定复制单元**。
   *
   * 复制单元恒为调用方传进来的「资产包根」（见 {@link copyAssetToRoot} 的 `packageRoot`）。
   * 若用 kind 反推复制单元（或按「源是文件 ⇒ 技能」推断），角色包（入口 `manifest.json`）
   * 会被当单文件平铺，单文件技能取 `dirname` 又会把 `skills/` 根当包根、误搬兄弟技能。
   */
  kind: AssetKind;
  /**
   * 同名已存在时的确认回调：true = 覆盖，false = 取消（**缺省语义即取消**）。
   *
   * 与压缩包导入共用同一语义：绝不静默覆盖用户已有资产，也绝不「点了没反应」——
   * 取消时回执里写明目标路径，让用户知道为什么没动。
   */
  confirmOverwrite: (prompt: OverwritePrompt) => Promise<boolean>;
}

/** 复制结果（失败必须给具体原因；成功带回实际落点与文件数） */
export type CopyAssetResult =
  { ok: true; targetPath: string; fileCount: number } | { ok: false; reason: string };

/**
 * 递归统计目录内文件数（仅用于成功回执；不跟随符号链接）
 *
 * @param root 资产目录绝对路径
 */
async function countFilesInDir(root: string): Promise<number> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    // 目录递归；文件与其它类型都计 1（与压缩包导入的「文件数」口径一致：只数叶子）
    if (entry.isDirectory()) count += await countFilesInDir(join(root, entry.name));
    else count += 1;
  }
  return count;
}

/**
 * 目录内是否存在技能入口文件（大小写不敏感，口径 = 内核 `SKILL_MAIN_FILE` 的同一约定）
 *
 * @param dir 候选技能目录绝对路径
 */
async function hasSkillEntry(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => []);
  return entries.some((name) => name.toLowerCase() === SKILL_MAIN_FILE.toLowerCase());
}

/**
 * 把项目级资产从**包根**复制到用户级根目录（**拷贝，不是移动/链接**）
 *
 * 与压缩包导入共用同一条提交原语：内容先复制到目标同父目录的隐藏暂存区 →
 * 目标已存在则先换名成 `.bak-<hex>` 备份 → `rename(暂存 → 目标)` → 成功才删备份；
 * 任一步失败反向换名回滚，回滚再失败则把备份转成 `.recovery-<hex>`（清理永不删除）。
 *
 * ## 复制单元 = 包根（唯一判据，本模块不推导）
 *   - 角色包 ⇒ 包目录（含 `manifest.json`）：`cp -r` 整目录；
 *   - 目录式技能 ⇒ 技能目录（含入口 `SKILL.md`）：`cp -r` 整目录（资源随包）；
 *   - 单文件技能 ⇒ 该文件本身：按文件复制。
 * `packageRoot` 由内核条目字段给出（`SkillEntry.packageRoot` / `RolePack.packageRoot`）——
 * 宿主不得自行 `dirname(filePath)` 或按「同目录有没有 SKILL.md」猜（猜法必与扫描器漂移）。
 *
 * 调用方负责「取包根 + 重扫 + UI 刷新」；本模块只按 `options.kind` 校验与执行，
 * 不碰 Agent、不碰 UI 状态。
 *
 * @param packageRoot 项目级资产**包根**绝对路径（见上；不是入口文件路径）
 * @param targetRoot 用户级资产根目录（skills / role-packs）
 * @param options 资产类型（仅校验 / 文案）+ 同名覆盖确认
 */
export async function copyAssetToRoot(
  packageRoot: string,
  targetRoot: string,
  options: CopyAssetOptions,
): Promise<CopyAssetResult> {
  let sourceIsDir: boolean;
  try {
    const info = await stat(packageRoot);
    sourceIsDir = info.isDirectory();
  } catch (err) {
    return { ok: false, reason: `源资产不存在或不可读：${(err as Error).message}` };
  }

  // 前置校验（按包根，先验来源再动盘）：任一条不满足即拒绝并给绝对路径，暂存 / 换名一步都不做
  if (options.kind === 'rolePack') {
    if (!sourceIsDir) {
      return { ok: false, reason: `角色包包根必须是包目录，收到文件路径：${packageRoot}` };
    }
    if (!(await pathExists(join(packageRoot, 'manifest.json')))) {
      return { ok: false, reason: `角色包目录缺少 manifest.json：${packageRoot}` };
    }
  } else {
    // 技能分支只校验「包根形态与 entry 是否自洽」，自身不推导包根：
    if (sourceIsDir) {
      if (!(await hasSkillEntry(packageRoot))) {
        // 目录式技能：内核已判定包根是目录，则该目录必须有入口文件；缺入口 = 坏包，拒复制
        return {
          ok: false,
          reason: `目录式技能包根缺少入口文件 ${SKILL_MAIN_FILE}：${packageRoot}`,
        };
      }
    } else if (basename(packageRoot).toLowerCase() === SKILL_MAIN_FILE.toLowerCase()) {
      // 反向误传：目录式技能的入口文件被当成包根（旧调用方按 filePath 传参的形态）。
      // 此时只复制入口会丢 resources/ 等随包资源，且会在用户根散落平铺 SKILL.md ⇒ 直接拒，不猜目录。
      return {
        ok: false,
        // 含修复指引：单文件技能若恰好叫 SKILL.md，路径上无法与目录式入口区分 ⇒ 宁可拒也不误搬
        reason:
          `目录式技能应传入技能目录作为包根，收到入口文件：${packageRoot}` +
          `（若这是单文件技能本身，请改用其它文件名——${SKILL_MAIN_FILE} 是目录式入口约定）`,
      };
    }
  }

  const sourceName = basename(packageRoot);
  // 单文件技能落点 = 原文件名（如 `foo.md`）；目录式资产落点 = 目录名（技能目录 / 角色包名目录）
  const singleFile = !sourceIsDir;
  const name = singleFile ? sourceName.replace(/\.md$/i, '') : sourceName;

  // 候选目标：单文件技能同时防「同名目录」占位（与压缩包导入的 resolveTargets 同判据）
  const candidates = singleFile ? [sourceName, name] : [sourceName];
  const targets: string[] = [];
  for (const candidate of candidates) {
    const resolved = resolveInsideDir(targetRoot, candidate);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    targets.push(resolved.path);
  }
  const targetPath = targets[0]!;

  // 同名处置：任一候选已存在 ⇒ 必须由调用方明确确认；取消则零写入
  const existing: string[] = [];
  for (const target of targets) {
    if (await pathExists(target)) existing.push(target);
  }
  if (existing.length > 0) {
    const overwrite = await options.confirmOverwrite({
      // 类型直接取自调用方声明，不再按源形态推断（否则角色包会被叫成「同名技能」）
      kind: options.kind,
      name,
      targetPath: existing[0]!,
    });
    if (!overwrite) {
      return { ok: false, reason: `已取消复制：目标已存在（${existing[0]}），未做任何写入` };
    }
  }

  // ── 暂存复制：内容先落进隐藏暂存区，此阶段目标一字未动 ──
  const parentDir = dirname(targetPath);
  await mkdir(parentDir, { recursive: true }).catch(() => undefined);
  await cleanupStaleArtifacts(parentDir);
  const suffix = makeSuffix();
  const stagedPath = singleFile
    ? join(parentDir, `${IMPORT_TMP_PREFIX}${suffix}.md`)
    : join(parentDir, `${IMPORT_TMP_PREFIX}${suffix}`);

  try {
    if (singleFile) {
      await copyFile(packageRoot, stagedPath);
    } else {
      // dereference=true：把链接指向的真实内容复制进来，用户目录里不留可逃出根外的符号链接
      await cp(packageRoot, stagedPath, { recursive: true, dereference: true });
    }
  } catch (err) {
    // 复制阶段失败：目标从未被改动，只需清掉暂存
    await rm(stagedPath, { recursive: true, force: true }).catch((cleanupErr: unknown) => {
      logger.warn({ cleanupErr, stagedPath }, '复制到用户级写入失败后清理暂存失败');
    });
    return { ok: false, reason: `复制失败（目标未改动）：${(err as Error).message}` };
  }

  // ── 换名提交：与压缩包导入完全同一原语（备份 → rename → 删备份；失败回滚） ──
  const committed = await commitStaged(stagedPath, targetPath, targets.slice(1), suffix);
  if (!committed.ok) return { ok: false, reason: committed.reason };

  return {
    ok: true,
    targetPath,
    fileCount: singleFile ? 1 : await countFilesInDir(targetPath),
  };
}
