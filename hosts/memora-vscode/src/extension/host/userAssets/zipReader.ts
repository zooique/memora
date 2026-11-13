/**
 * 压缩包读取与路径防线（zip-slip / zip bomb 的唯一判据处）
 *
 * ## 为什么独立成模块（B10-A，2026-11-10）
 * `zipImport.ts` 已逼近 lint 的 1000 行基线（现 833），且它承担了两件不同职责：
 * **① 把 zip 读成内存条目表（带体量与路径防线）**、**② 判定资产形态并落盘**。
 * 本轮本地化把 `reason` 逐条改 `vscode.l10n.t` 后必然涨行，故按职责切开——
 * 这里只做 ①：不解压到磁盘、不识别资产类型、不弹框。
 *
 * ## 判据位置（单一真理源，勿在他处再写一份）
 * - **路径**：`validateArchiveEntryPath`（拒绝空名 / 反斜杠 / 绝对路径 / 盘符 / 空字符 /
 *   空路径段 / `..` 穿越），并统一成 `/` 分隔相对路径。
 * - **体量**：`ZIP_IMPORT_LIMITS` 两级校验——先看中央目录声明（快速拒），
 *   流式读取时再按**实际字节**累计（声明可被伪造，zip bomb 的常见变体）。
 * - **符号链接**：`isSymlinkEntry` 命中即拒（落盘后读资源会逃出目标目录）。
 *
 * 文案口径：`reason` 全部经 `vscode.l10n.t()`（命令层按 `Import failed: {0}` 直接上屏）。
 */
import { basename } from 'node:path';
import * as vscode from 'vscode';
import * as yauzl from 'yauzl';

/** 解压上限（防 zip bomb；按「解压后」口径，不是压缩包大小） */
export const ZIP_IMPORT_LIMITS = {
  /** 条目数上限（含目录条目） */
  maxEntries: 500,
  /** 单条解压后大小上限（5 MB） */
  maxEntryBytes: 5 * 1024 * 1024,
  /** 全部条目解压后总大小上限（20 MB） */
  maxTotalBytes: 20 * 1024 * 1024,
} as const;

/** 压缩包内一个已通过路径校验的文件条目（路径统一为 `/` 分隔的相对路径） */
export interface ZipFileEntry {
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
  if (!raw) return { ok: false, reason: vscode.l10n.t('The entry name is empty') };
  // 反斜杠在 zip 规范里不是分隔符，但 Windows 上会被当作分隔符 ⇒ 跨平台歧义，一律拒绝
  if (raw.includes('\\')) {
    return {
      ok: false,
      reason: vscode.l10n.t(
        'The entry name contains a backslash (ambiguous across platforms): {0}',
        raw,
      ),
    };
  }
  if (raw.startsWith('/')) {
    return {
      ok: false,
      reason: vscode.l10n.t('The entry name is an absolute path: {0}', raw),
    };
  }
  if (/^[A-Za-z]:/.test(raw)) {
    return {
      ok: false,
      reason: vscode.l10n.t('The entry name contains a Windows drive letter: {0}', raw),
    };
  }
  if (raw.includes('\0')) {
    return { ok: false, reason: vscode.l10n.t('The entry name contains a null character') };
  }
  // 允许并剥离前导 `./`（部分打包工具会带），剥离后仍按严格规则校验
  let normalized = raw;
  while (normalized.startsWith('./')) normalized = normalized.slice(2);
  if (normalized.includes('//')) {
    return {
      ok: false,
      reason: vscode.l10n.t('The entry name contains an empty path segment: {0}', raw),
    };
  }
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return {
      ok: false,
      reason: vscode.l10n.t(
        'The entry name contains path traversal or an empty path segment: {0}',
        raw,
      ),
    };
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
export async function readZipFileEntries(zipPath: string): Promise<ZipFileEntry[]> {
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
          reject(
            new Error(
              vscode.l10n.t(
                'Not a valid zip file: {0}',
                openErr?.message ?? vscode.l10n.t('cannot open the file'),
              ),
            ),
          );
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

        zipFile.on('error', (err) =>
          fail(vscode.l10n.t('Failed to read the archive: {0}', err.message)),
        );
        zipFile.on('entry', (entry) => {
          if (settled) return;
          entryCount += 1;
          if (entryCount > ZIP_IMPORT_LIMITS.maxEntries) {
            fail(
              vscode.l10n.t(
                'The archive has more entries than the limit ({0} entries)',
                ZIP_IMPORT_LIMITS.maxEntries,
              ),
            );
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
            fail(
              vscode.l10n.t(
                'The archive contains a symbolic-link entry (refusing to extract): {0}',
                entry.fileName,
              ),
            );
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
              vscode.l10n.t(
                'A single entry exceeds the per-entry limit after extraction ({0} bytes): {1}',
                ZIP_IMPORT_LIMITS.maxEntryBytes,
                entry.fileName,
              ),
            );
            return;
          }
          declaredTotal += entry.uncompressedSize;
          if (declaredTotal > ZIP_IMPORT_LIMITS.maxTotalBytes) {
            fail(
              vscode.l10n.t(
                'The archive exceeds the total size limit after extraction ({0} bytes)',
                ZIP_IMPORT_LIMITS.maxTotalBytes,
              ),
            );
            return;
          }
          zipFile.openReadStream(entry, (streamErr, stream) => {
            if (streamErr || !stream) {
              fail(
                vscode.l10n.t(
                  'Failed to read entry {0}: {1}',
                  entry.fileName,
                  streamErr?.message ?? vscode.l10n.t('no data stream'),
                ),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let entryBytes = 0;
            stream.on('data', (chunk: Buffer) => {
              if (settled) return;
              entryBytes += chunk.length;
              actualTotal += chunk.length;
              if (entryBytes > ZIP_IMPORT_LIMITS.maxEntryBytes) {
                fail(
                  vscode.l10n.t(
                    'An entry exceeds the per-entry limit in actual extracted size: {0}',
                    entry.fileName,
                  ),
                );
                return;
              }
              if (actualTotal > ZIP_IMPORT_LIMITS.maxTotalBytes) {
                fail(
                  vscode.l10n.t(
                    'The archive exceeds the total size limit in actual extracted size ({0} bytes)',
                    ZIP_IMPORT_LIMITS.maxTotalBytes,
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });
            stream.on('error', (err) =>
              fail(vscode.l10n.t('Failed to read entry {0}: {1}', entry.fileName, err.message)),
            );
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
