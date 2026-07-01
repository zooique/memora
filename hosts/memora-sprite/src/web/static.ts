/**
 * 静态文件服务（DWM-01：双模式 Web 调试）
 *
 * 为 Web 模式提供 renderer/ 目录的静态文件服务。
 * 复用 Electron 的 renderer/ 目录（HTML/CSS/JS），零 duplication。
 *
 * 职责：
 *   1. 根据文件扩展名设置 Content-Type
 *   2. 文件不存在时返回 404
 *   3. 读取文件内容并返回
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';

/**
 * 文件扩展名 → MIME 类型映射表
 *
 * 覆盖 renderer/ 目录中所有文件类型：
 * HTML/CSS/JS/JSON/SVG/PNG/ICO/WOFF2
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 提供静态文件服务
 *
 * @param res HTTP 响应对象
 * @param filePath 文件绝对路径（已通过路径穿越校验）
 */
export async function serveStaticFile(
  res: ServerResponse,
  filePath: string,
): Promise<void> {
  // 文件不存在检查
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  try {
    const content = await readFile(filePath);
    // 根据扩展名获取 MIME 类型，默认 octet-stream
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`500 Internal Server Error: ${error instanceof Error ? error.message : 'unknown'}`);
  }
}
