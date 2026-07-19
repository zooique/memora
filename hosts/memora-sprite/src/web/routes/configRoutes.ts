/**
 * 配置与角色 HTTP 路由
 *
 * 与 electron/ipc/configHandlers.ts 镜像，复用 sprite 核心层。
 *
 * 路由表：
 *   GET    /api/config            → 获取精灵配置
 *   PUT    /api/config            → 更新单个配置项
 *   PUT    /api/config/batch      → 批量更新配置（事务性）
 *   GET    /api/personas          → 列出所有角色
 *   POST   /api/personas/switch   → 切换角色
 *   POST   /api/personas/mode     → 设置角色匹配模式
 *   GET    /api/personas/mode     → 查询当前角色匹配模式
 *
 * 注意：Web 模式不处理静默模式恢复定时器，
 * 该定时器是 Electron 主进程专属（托盘模式兜底）。
 * Web 模式下渲染进程始终运行，由渲染层 setTimeout 处理恢复。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger } from 'memora';
import type { HostContext } from '../../shared/hostContext.js';
import { isValidPersonaName } from '../../shared/inputValidation.js';
import { parseJsonBody, sendJson, sendError, safeRoute, ensureAgentReady } from './types.js';
import { DEFAULT_SPRITE_CONFIG } from '../../sprite/spriteConfig.js';
import type { SpriteConfigKey } from '../../sprite/spriteConfig.js';

/**
 * 校验配置键是否属于 SpriteConfig
 *
 * 与 configHandlers.ts 的 isSpriteConfigKey 对齐，防止非法键传入 updateConfig。
 *
 * @param key 配置键名
 * @returns true 表示是合法的 SpriteConfigKey
 */
function isSpriteConfigKey(key: string): key is SpriteConfigKey {
  return key in DEFAULT_SPRITE_CONFIG;
}

/**
 * 处理配置与角色相关 HTTP 路由
 *
 * @param req HTTP 请求对象
 * @param res HTTP 响应对象
 * @param ctx HostContext 实例
 */
export async function handleConfigRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HostContext,
): Promise<void> {
  // Agent 未就绪时拒绝请求
  if (!ensureAgentReady(res, ctx)) return;

  const method = req.method ?? 'GET';
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? url;

  await safeRoute(res, '配置操作', async () => {
    // ─── 配置管理 ───────────────────────────────────────────

    // GET /api/config — 获取精灵配置
    if (method === 'GET' && (path === '/api/config' || path === '/api/config/')) {
      sendJson(res, 200, { config: ctx.sprite.getConfig() });
      return;
    }

    // PUT /api/config/batch — 批量更新配置（事务性）
    if (method === 'PUT' && path === '/api/config/batch') {
      const body = await parseJsonBody<Record<string, unknown>>(req);
      if (!body || typeof body !== 'object') {
        sendError(res, 400, '请求体必须是配置对象');
        return;
      }
      const result = ctx.sprite.updateConfigBatch(body);
      sendJson(res, 200, result);
      return;
    }

    // PUT /api/config — 更新单个配置项
    if (method === 'PUT' && (path === '/api/config' || path === '/api/config/')) {
      const body = await parseJsonBody<{ key: string; value: unknown }>(req);
      if (!body?.key) {
        sendError(res, 400, '请求体必须包含 key 和 value');
        return;
      }
      if (!isSpriteConfigKey(body.key)) {
        sendError(res, 400, `未知的配置键: ${body.key}`);
        return;
      }
      // Web 模式无托盘/快捷键副作用，直接更新配置
      ctx.sprite.updateConfig(body.key, body.value);
      sendJson(res, 200, { updated: true });
      return;
    }

    // ─── 角色管理 ───────────────────────────────────────────

    // GET /api/personas/mode — 查询当前角色匹配模式
    if (method === 'GET' && path === '/api/personas/mode') {
      sendJson(res, 200, { mode: ctx.sprite.personaMode });
      return;
    }

    // POST /api/personas/mode — 设置角色匹配模式
    if (method === 'POST' && path === '/api/personas/mode') {
      const body = await parseJsonBody<{ mode: 'auto' | 'manual' }>(req);
      if (!body?.mode || (body.mode !== 'auto' && body.mode !== 'manual')) {
        sendError(res, 400, 'mode 必须是 auto 或 manual');
        return;
      }
      const set = ctx.sprite.setPersonaMode(body.mode);
      sendJson(res, 200, { set });
      return;
    }

    // POST /api/personas/switch — 切换角色
    if (method === 'POST' && path === '/api/personas/switch') {
      const body = await parseJsonBody<{ name: string }>(req);
      if (!body?.name) {
        sendError(res, 400, 'name 必填');
        return;
      }
      // 校验角色名，使用 shared/inputValidation 的统一 isValidPersonaName
      // （移除内联正则，避免与 IPC 层行为不一致）
      if (!isValidPersonaName(body.name)) {
        sendError(res, 400, '无效的角色名');
        return;
      }
      const switchedName = ctx.sprite.switchPersona(body.name);
      sendJson(res, 200, { switched: switchedName !== null, name: switchedName });
      return;
    }

    // GET /api/personas — 列出所有角色
    if (method === 'GET' && (path === '/api/personas' || path === '/api/personas/')) {
      const personas = ctx.sprite.listPersonas();
      sendJson(res, 200, { personas });
      return;
    }

    // 未匹配的路由：不回显 path 防止用户输入注入到响应体或泄露路由细节
    logger.info({ method, path }, '[Web Config] 未匹配的配置路由');
    sendError(res, 404, '404 Not Found');
  });
}
