/**
 * 用户资产（技能 / 角色包）名字净化与写入路径解析（宿主写入用户的唯一判据面）。
 *
 * 为什么单独成模块：任何「把用户给的名字变成一个落在用户目录内的路径」的入口
 * （压缩包导入 / 对话写入的安装窄口）都要回答同一个问题。若各写一份正则与逃逸断言，
 * 两份判据从落笔那一刻起就会漂移（其中一个漏掉 `..` 或绝对路径），且没有任何测试会红。
 *
 * 硬约束：本模块只做**判据**与**路径推导**，不碰 SecurityGuard / allowedPaths，
 * 也不做任何写入——写入的唯一落点在 `./write.ts`。
 */

import { resolve, sep } from 'node:path';
import { stat } from 'node:fs/promises';

/**
 * 用户资产名字合法性正则：中文 / 字母 / 数字 / 下划线 / 连字符，1-64 字符。
 *
 * 不含 `.`、`/`、`\`、`:`：既排除 `..` 与路径分隔符，也排除 Windows 盘符与绝对路径；
 * 中文允许是因为技能名常以中文书写（如「资料整理」），且内核按 frontmatter 名寻址。
 */
export const USER_ASSET_NAME_RE = /^[A-Za-z0-9\u4e00-\u9fa5_-]{1,64}$/;

/** 名字净化结果：ok=true 带净化后名字，否则带拒绝原因（原因直接进用户提示） */
export type SanitizeResult = { ok: true; name: string } | { ok: false; reason: string };

/**
 * 净化用户输入的名字（所有写入入口的唯一判据）
 *
 * @param raw 用户原始输入（可能带首尾空格）
 * @returns 通过时返回 trim 后的名字；拒绝时给出可读原因
 */
export function sanitizeAssetName(raw: string): SanitizeResult {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, reason: '名字不能为空' };
  }
  // 首尾空格不再静默 trim 后放行：用户以为名字含空格，落盘却不同名，属隐式改写
  if (trimmed !== raw) {
    return { ok: false, reason: '名字首尾不得有空格' };
  }
  if (!USER_ASSET_NAME_RE.test(trimmed)) {
    return {
      ok: false,
      reason:
        '名字只能包含中文、字母、数字、下划线、连字符（最长 64 字符），不得含路径分隔符、.. 或首尾空格',
    };
  }
  return { ok: true, name: trimmed };
}

/**
 * 在根目录内解析一个子路径，并断言**未逃出根目录**（最终路径逃逸的唯一防线）。
 *
 * 判据：`path.resolve(root, segment)` 的结果必须以 `root + 分隔符` 开头。
 * 覆盖三类逃逸：`..` 上跳、绝对路径（resolve 直接丢弃 root）、盘符切换。
 *
 * @param root 用户资产根目录（如 globalStorage/skills）
 * @param segment 子路径片段（单文件形态传 `name.md`，目录形态传 `name`）
 */
export function resolveInsideDir(
  root: string,
  segment: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  const safeRoot = resolve(root);
  const target = resolve(safeRoot, segment);
  if (!target.startsWith(safeRoot + sep)) {
    return { ok: false, reason: `写入路径越出用户目录：${target}` };
  }
  return { ok: true, path: target };
}

/** 路径是否已存在（用于「同名已存在 ⇒ 拒绝覆盖」与「目标目录已存在 ⇒ 拒绝创建」） */
export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
