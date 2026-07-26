/**
 * 系统级 HTTP 路由
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
import { parseJsonBody, sendJson, sendError, safeRoute, parseLimitWithMax } from './types.js';
import { classifyLlmError } from '../../shared/llmErrorClassifier.js';

/** 将原始错误转为安全响应信息（避免泄露技术细节到客户端） */
function sanitizeError(error: unknown, context: string): string {
  const msg = toError(error).message;
  logger.warn({ err: msg, context }, '系统路由异常');
  return '操作失败，请稍后重试';
}

import {
  saveLlmConfig,
  isLlmConfigured,
  reinitAgent,
  getLlmProviders,
  saveLlmProvider,
  deleteLlmProvider,
  setActiveLlmProvider,
} from '../../index.js';
import { DEFAULT_CONFIG_PATH, resolveProviderConfig } from '../../storage/spriteConfigStore.js';
import { loadConfig, createProviderFromConfig } from 'memora';
import type { Config } from 'memora';

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
    // 注：不再返回 presets 字段——UI 改为通用表单让用户手填所有字段（决策见 A4）
    if (method === 'GET' && (path === '/api/llm-config' || path === '/api/llm-config/')) {
      try {
        const configured = await isLlmConfigured();
        const config = await loadConfig(DEFAULT_CONFIG_PATH);
        sendJson(res, 200, {
          configured,
          config: configured
            ? (() => {
                const active = config.llm.active ?? Object.keys(config.llm.providers ?? {})[0] ?? 'default';
                const p = resolveProviderConfig(config, active) ?? resolveProviderConfig(config, 'default');
                return {
                  provider: p?.provider ?? '',
                  model: p?.model ?? '',
                  baseUrl: p?.baseUrl ?? '',
                  apiKey: p?.apiKey ? '***' : '', // 脱敏
                  temperature: p?.temperature ?? 0.7,
                };
              })()
            : null,
          embedding: config.embedding?.model
            ? {
                model: config.embedding.model,
                baseUrl: config.embedding.baseUrl ?? '',
                apiKey: config.embedding.apiKey ? '***' : '',
              }
            : null,
        });
      } catch (error) {
        // 配置读取失败时返回未配置状态，由前端引导用户进入设置页
        logger.warn({ err: toError(error).message }, 'LLM 配置读取失败，返回未配置态');
        sendJson(res, 200, {
          configured: false,
          config: null,
          embedding: null,
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
        // 使用 LLM 错误分类器返回用户友好提示，不暴露原始错误（如 API 地址、内部异常）
        const rawMessage = toError(error).message;
        const friendlyMessage = classifyLlmError(rawMessage);
        sendJson(res, 200, { success: false, error: friendlyMessage });
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
        sendJson(res, 200, { success: false, error: sanitizeError(error, 'saveConfig') });
      }
      return;
    }

    // ─── 多 Provider 管理路由 ─────────────────────────────────

    // GET /api/llm-providers — 获取所有 Provider 列表（脱敏）
    if (method === 'GET' && (path === '/api/llm-providers' || path === '/api/llm-providers/')) {
      try {
        const data = await getLlmProviders();
        sendJson(res, 200, data);
      } catch (error) {
        // 查询失败时记录日志，便于排查；前端引导用户进入设置页配置 Provider
        logger.warn({ err: toError(error).message }, '列出 LLM providers 失败，返回空列表');
        sendJson(res, 200, { active: '', providers: [] });
      }
      return;
    }

    // POST /api/llm-providers — 保存 Provider（新增/更新）
    if (method === 'POST' && (path === '/api/llm-providers' || path === '/api/llm-providers/')) {
      const body = await parseJsonBody<{ key: string; config: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number } }>(req);
      if (!body?.key || !body?.config?.provider || !body?.config?.model) {
        sendError(res, 400, 'key、provider、model 必填');
        return;
      }
      try {
        await saveLlmProvider(body.key, body.config);
        sendJson(res, 200, { success: true, error: null });
      } catch (error) {
        sendJson(res, 200, { success: false, error: sanitizeError(error, 'saveConfig') });
      }
      return;
    }

    // DELETE /api/llm-providers/:key — 删除 Provider
    if (method === 'DELETE' && path.startsWith('/api/llm-providers/')) {
      const key = path.split('/').pop();
      if (!key) {
        sendError(res, 400, 'key 必填');
        return;
      }
      try {
        await deleteLlmProvider(key);
        sendJson(res, 200, { success: true, error: null });
      } catch (error) {
        sendJson(res, 200, { success: false, error: sanitizeError(error, 'saveConfig') });
      }
      return;
    }

    // POST /api/llm-providers/:key/active — 切换激活 Provider（运行时切换，不重新初始化 Agent）
    if (method === 'POST' && path.startsWith('/api/llm-providers/')) {
      const parts = path.split('/');
      const key = parts[3];
      if (parts[4] === 'active' && key) {
        try {
          // 1. 持久化 active 到 config.json
          await setActiveLlmProvider(key);

          // 2. 从配置读取新 Provider 的完整配置（含 apiKey）
          const config: Config = await loadConfig(DEFAULT_CONFIG_PATH);
          const providerConfig = resolveProviderConfig(config, key);

          if (!providerConfig) {
            sendError(res, 404, `Provider "${key}" 不存在`);
            return;
          }

          // 3. 创建新的前台 Provider 实例
          const newProvider = createProviderFromConfig(key, {
            provider: providerConfig.provider,
            model: providerConfig.model,
            baseUrl: providerConfig.baseUrl || undefined,
            apiKey: providerConfig.apiKey || '',
          });

          // 4. 运行时切换 Provider（不重新初始化 Agent）
          // 内核 Agent 已支持 setProvider() 运行时切换，只需替换 API 出口
          // ctx.agent 类型为 Agent（必填字段），无需判空；未就绪时 setProvider 抛异常由 catch 返回错误
          ctx.agent.setProvider(newProvider);

          // 同步切换后台 Provider（如果配置了）
          if (config.llm.background) {
            const bgProvider = createProviderFromConfig('background', config.llm.background);
            ctx.agent.setBackgroundProvider(bgProvider);
          } else {
            ctx.agent.setBackgroundProvider(null);
          }

          sendJson(res, 200, { success: true, error: null, message: 'Provider 已切换，立即生效' });
        } catch (error) {
          sendJson(res, 200, { success: false, error: sanitizeError(error, 'saveConfig') });
        }
        return;
      }
    }

    // ─── 审计日志路由（不依赖 Agent 就绪，auditManager 独立可用） ───
    // 与 Electron IPC 的 AUDIT_LOG_LIST / AUDIT_LOG_CLEAR 平行

    // GET /api/audit-logs — 列出审计日志（支持 ?limit=50 参数）
    if (method === 'GET' && (path === '/api/audit-logs' || path === '/api/audit-logs/')) {
      if (!ctx.auditManager) {
        sendJson(res, 200, []);
        return;
      }
      const queryStr = url.split('?')[1] ?? '';
      const queryParams = new URLSearchParams(queryStr);
      const limit = parseLimitWithMax(queryParams, 'limit', 50, 200);
      const logs = await ctx.auditManager.readRecent(limit);
      sendJson(res, 200, logs);
      return;
    }

    // DELETE /api/audit-logs — 清空审计日志
    if (method === 'DELETE' && (path === '/api/audit-logs' || path === '/api/audit-logs/')) {
      if (ctx.auditManager) {
        await ctx.auditManager.clear();
      }
      sendJson(res, 200, { success: true });
      return;
    }

    // ─── 技能安装路由（不依赖 Agent 就绪，installSkill 是纯函数） ───
    // 与 Electron IPC 的 SKILL_INSTALL 平行

    // POST /api/skill-install — 安装技能文件
    if (method === 'POST' && (path === '/api/skill-install' || path === '/api/skill-install/')) {
      const body = await parseJsonBody<{ fileName: string; content: string }>(req);
      if (!body?.fileName || !body?.content) {
        sendError(res, 400, 'fileName 和 content 必填');
        return;
      }
      if (!ctx.installSkill) {
        sendError(res, 501, '技能安装功能未启用');
        return;
      }
      // 与 Electron IPC 的 SKILL_INSTALL 一致，使用默认 configDir
      // 城堡层默认 configDir 由 index.ts 统一管理，动态导入确保路径一致性
      const { DEFAULT_CONFIG_DIR } = await import('../../index.js');
      const result = await ctx.installSkill(body.content, body.fileName, DEFAULT_CONFIG_DIR);
      // 事件驱动重载：与 Electron IPC 行为一致，安装成功 + Agent 就绪时立即热重载
      // 无 Agent 时跳过热重载（hotReloaded 保持 undefined），用户配置后 reinitAgent 会读取已安装的技能
      if (result.success && ctx.isAgentReady()) {
        try {
          await ctx.agent.reloadConfig('skill');
          // 热重载成功：技能当前会话立即生效
          result.hotReloaded = true;
        } catch (err) {
          // 热重载失败（如对话繁忙 chatBusyError）：文件已写入磁盘，下次重启 Agent 时生效
          // 不阻塞安装结果返回，但需将失败原因透传给 UI，让用户知道当前会话未生效
          const errMsg = toError(err).message;
          result.hotReloaded = false;
          result.hotReloadError = errMsg;
          logger.error({ fileName: body.fileName, err: errMsg }, 'Web 模式技能热重载失败');
        }
      }
      sendJson(res, 200, result);
      return;
    }

    // 以下路由需要 Agent 就绪
    if (!ctx.isAgentReady()) {
      sendError(res, 503, 'Agent 未就绪，请先配置 LLM 提供商和 API Key');
      return;
    }

    // ─── 作品投影路由（依赖 Agent 就绪） ───
    // 与 Electron IPC 的 WORK_PROJECTION_LIST / WORK_PROJECTION_SHOW 平行

    // GET /api/works — 列出所有作品投影
    if (method === 'GET' && (path === '/api/works' || path === '/api/works/')) {
      const works = ctx.agent.works;
      if (!works) {
        sendJson(res, 200, []);
        return;
      }
      const entries = await works.loadAll();
      sendJson(res, 200, entries.map((e) => ({
        id: e.id,
        sourcePath: e.sourcePath,
        fileHash: e.fileHash,
        summary: e.summary,
        structure: e.structure,
        keyDecisions: e.keyDecisions,
        updatedAt: e.updatedAt,
      })));
      return;
    }

    // GET /api/works/detail — 查看单个作品投影详情（query: filePath）
    if (method === 'GET' && path === '/api/works/detail') {
      const queryStr = url.split('?')[1] ?? '';
      const queryParams = new URLSearchParams(queryStr);
      const filePath = queryParams.get('filePath') ?? '';
      if (!filePath || filePath.length > 1000) {
        sendJson(res, 200, null);
        return;
      }
      const works = ctx.agent.works;
      if (!works) {
        sendJson(res, 200, null);
        return;
      }
      const entry = await works.getProjection(filePath);
      if (!entry) {
        sendJson(res, 200, null);
        return;
      }
      sendJson(res, 200, {
        id: entry.id,
        sourcePath: entry.sourcePath,
        fileHash: entry.fileHash,
        summary: entry.summary,
        structure: entry.structure,
        keyDecisions: entry.keyDecisions,
        updatedAt: entry.updatedAt,
      });
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
      let degraded = false;
      try {
        sourceHealth = ctx.sprite.sourceHealth();
      } catch (err) {
        logger.debug({ err: toError(err).message }, 'sourceHealth 获取失败，降级为 null');
        degraded = true;
      }
      // Agent 运行时指标（降级为 null）
      let metrics = null;
      try {
        metrics = ctx.sprite.getMetrics();
      } catch (err) {
        logger.debug({ err: toError(err).message }, 'metrics 获取失败，降级为 null');
        degraded = true;
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
        degraded,
      });
      return;
    }

    // GET /api/perception — 获取感知数据快照（精灵感知面板打开时调用）
    // 实时从记忆推导情感基调/默契度/对话上下文/模式洞察，无副作用
    if (method === 'GET' && (path === '/api/perception' || path === '/api/perception/')) {
      try {
        const snapshot = ctx.sprite.getPerceptionSnapshot();
        sendJson(res, 200, snapshot ?? {});
      } catch (err) {
        logger.debug({ err: toError(err).message }, 'perception 获取失败');
        sendJson(res, 200, {});
      }
      return;
    }

    // 未匹配的路由：不回显 path 防止用户输入注入到响应体或泄露路由细节
    logger.info({ method, path }, '[Web System] 未匹配的系统路由');
    sendError(res, 404, '404 Not Found');
  });
}
