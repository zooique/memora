/**
 * 允许路径合并（用户配置白名单 ∪ 宿主注入的用户资产目录）。
 *
 * 为什么单独成模块：装配期（`assemble.ts`）与配置热更新（`extension.ts` 的
 * `memora.allowedPaths` 变更监听）**必须得到同一份结果**。两处各写一遍合并逻辑，
 * 热更新时漏掉用户资产目录 ⇒ 「刚装好能写、改一次设置就写不进去」的静默失效，
 * 且没有任何测试会红。
 *
 * 与内核的边界：本模块只产「待注入的额外白名单」（去重后原样交给内核）。
 * 条数上限真源在内核（`SecurityGuard` / `config/loader` 的 MAX_ALLOWED_PATHS），
 * 宿主**不裁剪**——超限由内核如实报错。
 */

import { normalize } from 'node:path';

/**
 * 合并「用户配置的允许路径」与「宿主必须可写的资产目录」，并按平台口径去重。
 *
 * 去重键：realpath 化交给内核（这里只做轻量 `normalize`）；Windows 大小写不敏感，
 * 故 win32 下用小写键，其余平台保持原样（避免误合并 Linux 上仅大小写不同的两个目录）。
 *
 * @param configured 用户配置的 `memora.allowedPaths`
 * @param userAssets 宿主注入的用户资产目录（可含 undefined，表示该目录未配置）
 * @returns 去重后的额外白名单（顺序：用户配置在前，注入目录在后）
 */
export function mergeAllowedPathsWithUserAssets(
  configured: readonly string[],
  userAssets: readonly (string | undefined)[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const candidate of [...configured, ...userAssets]) {
    if (!candidate) continue;
    const normalized = normalize(candidate);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged;
}
