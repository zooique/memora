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
 * 6. 写入完成后由调用方重扫（`resyncUserSkills` / `resyncUserPacks`）并刷新 UI。
 *
 * **不执行包内任何脚本**：只把条目当普通文件落盘（`.js` / `.py` 只写不跑）。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseFrontmatter, validateManifestText } from '@zooique/memora';
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
    for (const target of existing) {
      await rm(target, { recursive: true, force: true });
    }
  }

  try {
    // 单文件形态：targetPath 本身即文件；目录形态：targetPath 是目录
    const targetDir = plan.singleFile ? targetRoot : targetPath;
    let fileCount = 0;
    for (const entry of plan.entries) {
      if (!plan.singleFile) {
        // 逐条目二次逃逸断言（路径校验已在读包时做过，此处防「蓝图拼接」引入新逃逸）
        const destination = resolveInsideDir(targetDir, entry.relPath);
        if (!destination.ok) {
          return {
            ok: false,
            reason: `条目写入路径越出目标目录：${entry.relPath}`,
            asset: { kind: plan.kind, name: plan.name },
          };
        }
        await mkdir(dirname(destination.path), { recursive: true });
        await writeFile(destination.path, entry.data);
        fileCount += 1;
        continue;
      }
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, entry.data);
      fileCount += 1;
    }
    return {
      ok: true,
      asset: { kind: plan.kind, name: plan.name, targetPath, fileCount },
    };
  } catch (err) {
    return {
      ok: false,
      reason: `写入失败：${(err as Error).message}`,
      asset: { kind: plan.kind, name: plan.name },
    };
  }
}
