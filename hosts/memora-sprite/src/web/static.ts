/**
 * 静态文件服务
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
import { logger } from 'memora';
// 真理源：安全响应头常量（消除与 routes/types.ts 的双副本）
import { SECURITY_HEADERS } from '../shared/securityHeaders.js';

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

// 安全响应头 re-export：真理源 shared/securityHeaders.ts（消除与 routes/types.ts 的双副本）
export { SECURITY_HEADERS } from '../shared/securityHeaders.js';

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
    // 注入安全响应头
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  try {
    const content = await readFile(filePath);
    // 根据扩展名获取 MIME 类型，默认 octet-stream
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    // 开发模式：禁用浏览器缓存，确保每次修改代码后刷新即可看到最新版本
    // 注入安全响应头
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(content);
  } catch (error) {
    // 仅返回通用 500 文案，避免将内部异常细节（如文件系统路径/权限错误）
    // 回传给客户端造成信息泄露；原始错误仅记录到服务端日志便于排查
    logger.error({ err: error instanceof Error ? error.message : String(error) }, '[Web Static] 静态文件读取失败');
    // 注入安全响应头
    res.writeHead(500, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
    res.end('500 Internal Server Error');
  }
}
