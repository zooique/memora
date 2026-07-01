/**
 * Web 路由聚合入口（DWM-01：双模式 Web 调试）
 *
 * 职责：
 *   1. URL 路径分发到各领域路由处理器
 *   2. 404 兜底（未知 API 路径）
 *
 * 路由设计：
 *   - /api/chat/*            → chatStreamRoutes（Phase 2：SSE 流式对话）
 *   - /api/memories/*        → memoryRoutes
 *   - /api/config/*          → configRoutes
 *   - /api/personas/*        → configRoutes（角色管理）
 *   - /api/sessions/*        → sessionRoutes
 *   - /api/dashboard         → systemRoutes
 *   - /api/projects          → systemRoutes
 *   - /api/agent-status      → systemRoutes
 *   - /api/llm-config/*      → systemRoutes
 *
 * 与 electron/ipc/index.ts 的 registerIpcHandlers 平行，
 * 各领域路由文件与 IPC handler 文件一一对应（镜像原则）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostContext } from '../../shared/hostContext.js';
import { sendError } from './types.js';
import { handleMemoryRoute } from './memoryRoutes.js';
import { handleConfigRoute } from './configRoutes.js';
import { handleSessionRoute } from './sessionRoutes.js';
import { handleSystemRoute } from './systemRoutes.js';
import { handleChatStreamRoute } from './chatStreamRoutes.js';

/**
 * 注册所有 HTTP 路由（请求分发器）
 *
 * 根据 URL 前缀分发到各领域路由处理器。
 * 各领域处理器内部根据 method + path 细分到具体路由。
 *
 * @param req HTTP 请求对象
 * @param res HTTP 响应对象
 * @param ctx HostContext 实例
 */
export async function registerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HostContext,
): Promise<void> {
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? url; // 去除 query string

  // 对话流式 SSE：/api/chat/*（Phase 2，需置于其他 /api/* 路由之前避免被吞）
  if (path.startsWith('/api/chat')) {
    await handleChatStreamRoute(req, res, ctx);
    return;
  }

  // 记忆 CRUD：/api/memories/*
  if (path.startsWith('/api/memories')) {
    await handleMemoryRoute(req, res, ctx);
    return;
  }

  // 配置管理：/api/config/*
  if (path.startsWith('/api/config')) {
    await handleConfigRoute(req, res, ctx);
    return;
  }

  // 角色管理：/api/personas/*
  if (path.startsWith('/api/personas')) {
    await handleConfigRoute(req, res, ctx);
    return;
  }

  // 会话管理：/api/sessions/*
  if (path.startsWith('/api/sessions')) {
    await handleSessionRoute(req, res, ctx);
    return;
  }

  // 系统级：/api/dashboard、/api/projects、/api/agent-status、/api/llm-config/*
  if (
    path === '/api/dashboard' ||
    path === '/api/projects' ||
    path === '/api/agent-status' ||
    path.startsWith('/api/llm-config')
  ) {
    await handleSystemRoute(req, res, ctx);
    return;
  }

  // 未知 API 路径
  sendError(res, 404, `未找到 API 路径: ${path}`);
}
