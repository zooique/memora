/**
 * Web 路由共享类型与工具函数
 *
 * 定义所有 HTTP 路由共用的工具函数：
 *   - parseJsonBody：解析请求体 JSON
 *   - sendJson：统一 JSON 响应封装
 *   - sendError：统一错误响应封装
 *   - safeRoute：路由错误兜底包装（与 IPC 层 safeHandle 对齐）
 *
 * 与 electron/ipc/types.ts 的 safeHandle 平行，保持一致的错误处理风格。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from 'memora';
import { SpriteError, ErrorCode } from '../../sprite/errors.js';
import type { HostContext } from '../../shared/hostContext.js';

// ─── 安全响应头 ──────────────────────────────

/**
 * 通用安全响应头常量
 *
 * 所有 HTTP 响应应携带这些头以降低 XSS 点击劫持/MIME 嗅探/Referer 泄露等常见 Web 风险：
 *   - X-Content-Type-Options: nosniff —— 禁止浏览器 MIME 嗅探（防止 text/plain 被当 HTML 执行）
 *   - X-Frame-Options: DENY       —— 禁止页面被 iframe 嵌套（防点击劫持）
 *   - Referrer-Policy: no-referrer —— 不发送 Referer（防止内部 URL/路径泄露给外部）
 *
 * 在 sendJson 中统一注入，覆盖所有 routes 层 JSON 响应；
 * SSE 响应、静态文件响应、入口层 writeHead 各自展开注入（见 static.ts / chatStreamRoutes.ts / server.ts）。
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

/**
 * 路由处理函数签名
 *
 * @param req HTTP 请求对象
 * @param res HTTP 响应对象
 * @param ctx HostContext 实例
 * @param params URL 路径参数（由路由分发器解析）
 */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HostContext,
  params?: Record<string, string>,
) => Promise<void> | void;

/**
 * 解析请求体 JSON
 *
 * 流式读取请求体，解析为 JSON 对象。
 * 限制最大 body 大小 10MB，防止内存耗尽。
 *
 * @param req HTTP 请求对象
 * @returns 解析后的 JSON 对象，解析失败返回 null
 */
export async function parseJsonBody<T = unknown>(req: IncomingMessage): Promise<T | null> {
  // GET 请求通常无 body，直接返回 null（不读 stream）
  // 注意：DELETE 请求可能带 body（如 DELETE /api/memories/relation 需要传 sourceId/targetId），
  // 因此不跳过 DELETE，让其走正常的 body 解析流程
  const method = req.method ?? 'GET';
  if (method === 'GET') {
    return null;
  }

  // 读取请求体（限制 10MB）
  const chunks: Buffer[] = [];
  let totalSize = 0;
  const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB

  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > MAX_BODY_SIZE) {
      throw new SpriteError(
        ErrorCode.UNKNOWN,
        `请求体超过 10MB 限制（当前: ${(totalSize / 1024 / 1024).toFixed(2)}MB）`,
      );
    }
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return null;

  const bodyStr = Buffer.concat(chunks).toString('utf-8');
  if (!bodyStr.trim()) return null;

  return JSON.parse(bodyStr) as T;
}

/**
 * 发送 JSON 响应
 *
 * @param res HTTP 响应对象
 * @param status HTTP 状态码
 * @param data 响应数据（将被 JSON.stringify）
 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  // 统一注入安全响应头，覆盖所有 routes 层 JSON 响应
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * 发送错误响应
 *
 * @param res HTTP 响应对象
 * @param status HTTP 状态码
 * @param message 错误消息
 */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * 路由错误兜底包装
 *
 * 与 electron/ipc/types.ts 的 safeHandle 平行：
 * 执行业务逻辑，失败时记录日志 + 返回 500 错误响应。
 *
 * @param res HTTP 响应对象
 * @param context 错误上下文描述（人类可读，用于日志）
 * @param fn 业务逻辑
 */
export async function safeRoute(
  res: ServerResponse,
  context: string,
  fn: () => Promise<void> | void,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[Web Route] ${context} 失败: ${message}`);
    if (!res.headersSent) {
      sendError(res, 500, `${context}失败: ${message}`);
    }
  }
}

/**
 * 检查 Agent 是否就绪
 *
 * Agent 未就绪时返回 503 并写入错误信息，调用方应立即 return。
 *
 * @param res HTTP 响应对象
 * @param ctx HostContext 实例
 * @returns true 表示已就绪，false 表示未就绪（已写入 503 响应）
 */
export function ensureAgentReady(res: ServerResponse, ctx: HostContext): boolean {
  if (!ctx.isAgentReady()) {
    sendError(res, 503, 'Agent 未就绪，请先配置 LLM 提供商和 API Key');
    return false;
  }
  return true;
}
