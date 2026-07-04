/**
 * 路径工具函数
 *
 * 从 workProjection.ts 提取的公共路径处理函数，
 * 消除跨模块 `filePath.split(/[/\\]/).pop()` 内联重复。
 * 跨平台兼容（同时处理 / 和 \ 分隔符）。
 */

import { homedir } from 'node:os';

/**
 * 提取路径的 basename（最后一段）
 *
 * 命名为 getBaseName 以避免与 node:path.basename 同名冲突。
 * 差异：node:path.basename 按平台分隔符处理 + 支持 ext 参数；
 *       本函数跨平台（同时处理 / 和 \），单参数。
 *
 * 跨平台兼容：同时处理 Unix `/` 和 Windows `\` 分隔符。
 * 空路径或纯分隔符路径返回空字符串。
 *
 * @param filePath 文件路径
 * @returns basename，如 "/a/b/c.txt" → "c.txt"
 */
export function getBaseName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() ?? '';
}

/**
 * 展开路径中的 `~` 为用户家目录
 *
 * 仅处理开头的 `~`，不处理 `~otheruser` 等形式。
 * 不含 `~` 的路径原样返回。
 *
 * @param p 可能包含 `~` 的路径字符串
 * @returns 展开后的路径，如 "~/data" → "C:\\Users\\SJ\\data"
 */
export function expandHome(p: string): string {
  return p.replace(/^~/, homedir());
}
