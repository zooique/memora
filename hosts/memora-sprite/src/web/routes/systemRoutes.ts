/**
 * 系统级 HTTP 路由（DWM-01：双模式 Web 调试）
 *
 * 与 electron/ipc/systemHandlers.ts 镜像，复用 sprite 核心层。
 *
 * 路由表：
 *   GET  /api/dashboard        → 获取完整仪表盘数据
 *   GET  /api/projects         → 列出已注册项目
 *   GET  /api/agent-status     → 查询 Agent 是否就绪
 *   GET  /api/llm-config       → 获取 LLM 配置（脱敏）
 *   POST /api/llm-config       → 保存 LLM 配置（触发 Agent 重新初始化）
 *   POST /api/llm-config/test  → 测试 LLM 连接
 *
 * 注意：Web 模式不处理主动提示（PROACTIVE_ACCEPT/REJECT），
 * 这些是渲染进程与主进程的双向通知，Web 模式下由渲染层直接处理。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { logger, toError } from 'memora';
import type { HostContext } from '../../shared/hostContext.js';
import { parseJsonBody, sendJson, sendError, safeRoute } from './types.js';
import {
  saveLlmConfig,
  isLlmConfigured,
  PROVIDER_PRESETS,
  reinitAgent,
} from '../../index.js';
import { DEFAULT_CONFIG_PATH } from '../../storage/spriteConfigStore.js';
import { loadConfig } from 'memora';

/**
 * 全局状态：Agent 重新初始化的 close 函数
 *
 * 与 Electron 模式的 closeSprite 平行，用于 reinitAgent 时清理旧实例。
 */
let webCloseSprite: (() => Promise<void>) | null = null;

/**
 * 设置 Web 模式的 closeSprite 引用
 *
 * 由 server.ts 在 startSprite 成功后调用，注入 close 函数。
 *
 * @param closeFn close 函数
 */
export function setWebCloseSprite(closeFn: (() => Promise<void>) | null): void {
  webCloseSprite = closeFn;
}

/**
 * 处理系统级 HTTP 路由
 *
 * @param req HTTP 请求对象
 * @param res HTTP 响应对象
 * @param ctx HostContext 实例
 */
export async function handleSystemRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HostContext,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? url;

  await safeRoute(res, '系统操作', async () => {
    // GET /api/agent-status — 查询 Agent 是否就绪（不需要 Agent 就绪，本身用于检查状态）
    if (method === 'GET' && path === '/api/agent-status') {
      sendJson(res, 200, { ready: ctx.isAgentReady(), error: null });
      return;
    }

    // GET /api/llm-config — 获取 LLM 配置（脱敏）
    if (method === 'GET' && (path === '/api/llm-config' || path === '/api/llm-config/')) {
      try {
        const configured = await isLlmConfigured();
        const config = await loadConfig(DEFAULT_CONFIG_PATH);
        sendJson(res, 200, {
          configured,
          config: configured
            ? {
                provider: config.llm.provider,
                model: config.llm.model,
                baseUrl: config.llm.baseUrl,
                apiKey: config.llm.apiKey ? '***' : '', // 脱敏
                temperature: config.llm.temperature,
              }
            : null,
          embedding: config.embedding?.model
            ? {
                model: config.embedding.model,
                baseUrl: config.embedding.baseUrl ?? '',
                apiKey: config.embedding.apiKey ? '***' : '',
              }
            : null,
          presets: PROVIDER_PRESETS,
        });
      } catch {
        // 配置读取失败时返回未配置状态，由前端引导用户进入设置页
        sendJson(res, 200, {
          configured: false,
          config: null,
          embedding: null,
          presets: PROVIDER_PRESETS,
        });
      }
      return;
    }

    // POST /api/llm-config/test — 测试 LLM 连接
    if (method === 'POST' && path === '/api/llm-config/test') {
      const body = await parseJsonBody<{ provider: string; model: string; baseUrl: string; apiKey: string }>(req);
      if (!body?.provider || !body?.model || !body?.baseUrl || !body?.apiKey) {
        sendError(res, 400, 'provider、model、baseUrl、apiKey 必填');
        return;
      }
      try {
        // 复用 memora 的 createLlmProvider 测试连接
        const { createLlmProvider } = await import('memora');
        // LlmProvider 配置必须包含 memory + security.confirmWrites 字段
        const testConfig = {
          llm: { ...body, temperature: 0.7 },
          memory: { dataDir: '~/.memora-sprite', maxContextTokens: 80000 },
          security: { permission: 'owner' as const, confirmWrites: false },
          allowedPaths: [],
        };
        const provider = createLlmProvider(testConfig);
        // 简单测试：发送一个最小请求，迭代 chunks 收集响应
        // provider.chat() 签名：chat(messages: Message[], opts?: ChatOptions): AsyncIterable<LlmChunk>
        let reply = '';
        for await (const chunk of provider.chat(
          [{ role: 'user', content: 'hi' }],
          { temperature: 0, maxTokens: 1 },
        )) {
          if (chunk.content) reply += chunk.content;
          // 遇到非 stop 终止原因立即停止（避免无限迭代）
          if (chunk.finishReason && chunk.finishReason !== 'stop') break;
        }
        sendJson(res, 200, { success: true, error: null, reply });
      } catch (error) {
        sendJson(res, 200, { success: false, error: toError(error).message });
      }
      return;
    }

    // POST /api/llm-config — 保存 LLM 配置（触发 Agent 重新初始化）
    if (method === 'POST' && (path === '/api/llm-config' || path === '/api/llm-config/')) {
      const body = await parseJsonBody<{
        provider: string;
        model: string;
        baseUrl: string;
        apiKey: string;
        temperature?: number;
      }>(req);
      if (!body?.provider || !body?.model || !body?.baseUrl || !body?.apiKey) {
        sendError(res, 400, 'provider、model、baseUrl、apiKey 必填');
        return;
      }
      try {
        // 1. 保存配置到文件
        await saveLlmConfig(body);
        // 2. 重新初始化 Agent（复用 reinitAgent）
        const result = await reinitAgent(webCloseSprite);
        webCloseSprite = result.close;
        // 3. 通知调用方新实例（通过更新全局状态）
        // 注意：这里不直接更新 ctx，因为 ctx 是启动时构造的不可变对象
        // 实际生产中应该通过事件或回调通知 server.ts 更新 ctx
        // Phase 1 简化：保存后提示用户重启服务
        sendJson(res, 200, {
          success: true,
          error: null,
          message: 'LLM 配置已保存，请重启 Web 服务使新配置生效',
        });
      } catch (error) {
        sendJson(res, 200, { success: false, error: toError(error).message });
      }
      return;
    }

    // 以下路由需要 Agent 就绪
    if (!ctx.isAgentReady()) {
      sendError(res, 503, 'Agent 未就绪，请先配置 LLM 提供商和 API Key');
      return;
    }

    // GET /api/projects — 列出已注册项目
    if (method === 'GET' && (path === '/api/projects' || path === '/api/projects/')) {
      const projects = ctx.sprite.listProjects();
      sendJson(res, 200, { projects });
      return;
    }

    // GET /api/dashboard — 获取完整仪表盘数据
    if (method === 'GET' && (path === '/api/dashboard' || path === '/api/dashboard/')) {
      const data = ctx.sprite.dashboard();
      // 记忆源健康诊断（降级为 null）
      let sourceHealth = null;
      try {
        sourceHealth = ctx.sprite.sourceHealth();
      } catch (err) {
        logger.debug({ err: toError(err).message }, 'sourceHealth 获取失败，降级为 null');
      }
      // Agent 运行时指标（降级为 null）
      let metrics = null;
      try {
        metrics = ctx.sprite.getMetrics();
      } catch (err) {
        logger.debug({ err: toError(err).message }, 'metrics 获取失败，降级为 null');
      }
      // 已加载技能列表
      const skills = ctx.agent.skills?.list.map((s) => ({
        name: s.name,
        keywords: s.keywords,
        description: s.description ?? '',
        layer: s.layer,
      })) ?? [];
      sendJson(res, 200, {
        total: data.total,
        bySource: data.bySource,
        suggestions: data.suggestions,
        pendingNotices: ctx.sprite.pendingCount,
        proactiveThreshold: ctx.sprite.proactiveThreshold,
        registeredTriggers: ctx.sprite.registeredTriggers,
        relationCount: data.relationCount,
        conflictCount: data.conflictCount,
        sourceHealth,
        metrics,
        skills,
      });
      return;
    }

    // 未匹配的路由
    sendError(res, 404, `未找到系统路由: ${method} ${path}`);
  });
}
