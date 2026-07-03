/**
 * Web 模式服务入口（DWM-01：双模式 Web 调试）
 *
 * 职责：
 *   1. 复用 startSprite() 初始化 Agent + Sprite + Storage（与 Electron 模式完全相同）
 *   2. 构造 HostContext 注入到 HTTP 路由层
 *   3. 启动 HTTP 服务（仅监听 127.0.0.1，安全隔离）
 *   4. 提供静态文件服务（复用 renderer/ 目录的 HTML/CSS/JS）
 *   5. 优雅关闭（SIGINT/SIGTERM 触发 closeSprite 清理资源）
 *
 * 设计原则：
 *   - 零新增依赖：使用 Node.js 原生 http 模块，不引入 express/fastify
 *   - 真实数据：读写的是真实的 ~/.memora-sprite/ 和 dataDir/topics/
 *   - 安全隔离：仅监听 127.0.0.1，不暴露公网
 *   - 与 Electron 平行：核心层零改动，仅传输层不同
 *
 * 启动方式：npm run dev:web（或 start:web 生产模式）
 *
 * dev:web 前置条件：
 *   1. npm run build:electron —— 生成 renderer 编译产物（必须，否则启动校验失败）
 *   2. npm rebuild better-sqlite3 —— 为系统 Node.js 重编译 better-sqlite3（可选）
 *      不执行时 Agent 降级为 not ready，仅支持 UI 调试；执行后支持完整对话功能
 *      注意：rebuild better-sqlite3 后若要切回 Electron 模式，需运行 npm run rebuild
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toError, logger } from 'memora';
import type { Agent } from 'memora';
import { startSprite } from '../index.js';
import type { Sprite } from '../sprite/sprite.js';
import type { SqliteSessionStore } from '../storage/sessionStore.js';
import type { HostContext } from '../shared/hostContext.js';
import { registerRoutes } from './routes/index.js';
import { serveStaticFile, SECURITY_HEADERS } from './static.js';
import { buildPreloadScript, adaptHtmlForWeb } from './webContext.js';

// ─── 常量 ──────────────────────────────────────────────────

/** Web 服务监听端口（避开常见端口，减少冲突） */
const WEB_PORT = 3721;

/** Web 服务监听地址（仅本机，安全隔离） */
const WEB_HOST = '127.0.0.1';

/** 当前模块所在目录（用于定位 renderer 静态文件） */
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 渲染进程静态文件根目录（编译产物）
 *
 * Web 模式复用 Electron 的 renderer/ 编译产物（HTML/CSS/JS）。
 * 必须指向 dist-electron/electron/renderer/，因为：
 *   1. HTML 引用 renderer.js（编译后），源码目录只有 renderer.ts
 *   2. renderer 代码通过 esbuild/tsc 编译后才能在浏览器执行
 *
 * 开发模式前提：需先运行 `npm run build:electron` 生成编译产物。
 * 生产模式：build:web 已包含编译步骤。
 *
 * 路径解析：__dirname 在 dev 模式为 src/web/（tsx 运行），
 *           在 prod 模式为 dist-web/web/（node 运行），
 *           两者向上两级再进入 electron/renderer/ 即可到达 dist-electron。
 */
const RENDERER_ROOT = resolve(__dirname, '../../dist-electron/electron/renderer');

/**
 * dist-electron 根目录（用于服务 renderer 的跨目录 import）
 *
 * renderer 代码 import '../../sprite/constants.js' 等跨目录依赖，
 * 浏览器解析后为 /sprite/constants.js 等 URL。
 * 这些文件位于 dist-electron/sprite/，需从 DIST_ROOT 提供服务。
 *
 * 需要覆盖的跨目录路径：
 *   - /sprite/*        → dist-electron/sprite/*（constants/errors/memoryHealth）
 *   - /storage/*       → dist-electron/storage/*（如未来需要）
 */
const DIST_ROOT = resolve(__dirname, '../../dist-electron');

// ─── 全局状态 ──────────────────────────────────────────────

/** Agent 实例（由 startSprite 初始化） */
let agent: Agent | null = null;
/** Sprite 实例（精灵控制 + 配置 + 角色） */
let sprite: Sprite | null = null;
/** 会话存储（历史消息加载） */
let sessionStore: SqliteSessionStore | null = null;
/** 关闭函数（清理 Agent + Sprite 资源） */
let closeSprite: (() => Promise<void>) | null = null;
/** 当前对话的 AbortController（用于中断流式输出） */
let currentAbortController: AbortController | null = null;
/** Agent 是否就绪 */
let agentReady = false;

/** HTTP 服务实例（用于优雅关闭） */
let server: Server | null = null;

// ─── HostContext 装配 ──────────────────────────────────────

/**
 * 构造 HostContext（核心依赖容器）
 *
 * 与 Electron 模式的 createIpcContext 平行，仅注入核心字段，
 * 不包含窗口/托盘/快捷键等 Electron 专属依赖。
 *
 * @param activeAgent 已就绪的 Agent 实例
 * @param activeSprite 已就绪的 Sprite 实例
 * @param activeSessionStore 已就绪的会话存储
 * @returns HostContext 实例
 */
function createHostContext(
  activeAgent: Agent,
  activeSprite: Sprite,
  activeSessionStore: SqliteSessionStore,
): HostContext {
  return {
    agent: activeAgent,
    sprite: activeSprite,
    sessionStore: activeSessionStore,
    getAbortController: () => currentAbortController,
    setAbortController: (ctrl: AbortController | null) => {
      currentAbortController = ctrl;
    },
    isAgentReady: () => agentReady,
  };
}

// ─── 请求分发 ──────────────────────────────────────────────

/**
 * HTTP 请求分发器
 *
 * 职责：
 *   1. /api/* 路径 → 路由层处理（JSON API）
 *   2. 其他路径 → 静态文件服务（renderer/ 目录）
 *
 * @param req HTTP 请求对象
 * @param res HTTP 响应对象
 * @param ctx HostContext 实例
 */
async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HostContext,
  preloadScript: string,
): Promise<void> {
  const url = req.url ?? '/';

  // API 路由：/api/* 前缀
  if (url.startsWith('/api/')) {
    await registerRoutes(req, res, ctx);
    return;
  }

  // Web 版 preload 脚本端点（转译后的浏览器 JS）
  if (url === '/web/preload-web.mjs') {
    // SEC-WEB-04：注入安全响应头
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(preloadScript);
    return;
  }

  // ─── 跨目录 import 分发 ──────────────────────────────────
  // renderer 代码 import '../../sprite/constants.js' 等，
  // 浏览器解析为 /sprite/*、/storage/* 等 URL，需从 DIST_ROOT 提供服务。
  if (url.startsWith('/sprite/') || url.startsWith('/storage/')) {
    const distPath = join(DIST_ROOT, url);
    // 安全：防止路径穿越（.. 访问 dist-electron 目录外）
    const normalizedDistRoot = resolve(DIST_ROOT);
    const normalizedDistPath = resolve(distPath);
    if (!normalizedDistPath.startsWith(normalizedDistRoot)) {
      res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
      return;
    }
    await serveStaticFile(res, normalizedDistPath);
    return;
  }

  // ─── renderer 静态文件分发 ──────────────────────────────
  // 根路径 → index.html（需适配：注入 preload 脚本标签）
  const filePath = url === '/' ? '/index.html' : url;
  const fullPath = join(RENDERER_ROOT, filePath);

  // 安全：防止路径穿越（.. 访问 renderer 目录外）
  const normalizedRoot = resolve(RENDERER_ROOT);
  const normalizedFull = resolve(fullPath);
  if (!normalizedFull.startsWith(normalizedRoot)) {
    res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  // index.html 需要适配：注入 Web 版 preload 脚本标签
  if (filePath === '/index.html') {
    try {
      const html = await readFile(normalizedFull, 'utf-8');
      const adaptedHtml = adaptHtmlForWeb(html);
      // 开发模式：禁用 HTML 缓存，确保每次刷新加载最新版本
      // SEC-WEB-04：注入安全响应头
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(adaptedHtml);
    } catch {
      // SEC-WEB-04：注入安全响应头
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    }
    return;
  }

  // 其他静态文件服务（CSS/JS/SVG 等）
  await serveStaticFile(res, normalizedFull);
}

// ─── 应用启动 ──────────────────────────────────────────────

/**
 * 启动 Web 服务
 *
 * 流程：
 *   1. 调用 startSprite() 初始化核心层（与 Electron 完全相同）
 *   2. 构造 HostContext
 *   3. 启动 HTTP 服务，监听 127.0.0.1:3721
 *   4. 注册优雅关闭钩子
 */
async function startWebServer(): Promise<void> {
  // 阶段 0：校验 renderer 编译产物是否存在（dev:web 前置条件）
  // RENDERER_ROOT 指向 dist-electron/electron/renderer/，
  // 需先运行 `npm run build:electron` 生成编译产物。
  const rendererIndexPath = join(RENDERER_ROOT, 'index.html');
  if (!existsSync(rendererIndexPath)) {
    logger.error(`[Web] renderer 编译产物不存在: ${rendererIndexPath}`);
    logger.error('[Web] 请先运行 `npm run build:electron` 生成编译产物');
    process.exit(1);
  }

  // 阶段 1：初始化 Agent + Sprite（复用 startSprite）
  try {
    const result = await startSprite();
    agent = result.agent;
    sprite = result.sprite;
    sessionStore = result.sessionStore;
    closeSprite = result.close;
    agentReady = true;

    logger.info(`[Web] Agent 初始化成功，dataDir=${result.dataDir}`);
  } catch (error) {
    const errMessage = toError(error).message;
    logger.error(`[Web] Agent 初始化失败: ${errMessage}`);
    agentReady = false;
    // 配置缺失时仍启动 HTTP 服务，提供设置页面（与 Electron 两阶段初始化一致）
  }

  // 阶段 2：构造 HostContext（Agent 未就绪时使用降级值）
  // 注意：agentReady=false 时路由层会拒绝业务请求，但仍提供静态文件服务
  const ctx: HostContext = agent && sprite && sessionStore
    ? createHostContext(agent, sprite, sessionStore)
    : {
        // 降级 HostContext：Agent 未就绪时路由层返回 503
        agent: null as unknown as Agent,
        sprite: null as unknown as Sprite,
        sessionStore: null as unknown as SqliteSessionStore,
        getAbortController: () => null,
        setAbortController: () => {},
        isAgentReady: () => false,
      };

  // 阶段 2.5：转译 preloadWeb.ts 为浏览器 JS（启动时一次，缓存到内存）
  const preloadScript = await buildPreloadScript();

  // 阶段 3：启动 HTTP 服务
  server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, ctx, preloadScript);
    } catch (error) {
      logger.error(`[Web] 请求处理异常: ${toError(error).message}`);
      if (!res.headersSent) {
        // SEC-WEB-04：注入安全响应头
        res.writeHead(500, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    }
  });

  server.listen(WEB_PORT, WEB_HOST, () => {
    logger.info(`[Web] Memora Sprite Web 服务已启动: http://${WEB_HOST}:${WEB_PORT}`);
    logger.info(`[Web] 按 Ctrl+C 停止服务`);
  });

  // 阶段 4：注册优雅关闭钩子
  const gracefulShutdown = async (signal: string) => {
    logger.info(`[Web] 收到 ${signal}，正在关闭...`);

    // 先中断进行中的对话
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
    }

    // 关闭 HTTP 服务（拒绝新请求）
    if (server) {
      server.close();
    }

    // 清理 Agent + Sprite 资源
    if (closeSprite) {
      try {
        await closeSprite();
      } catch (error) {
        logger.warn(`[Web] 资源清理失败: ${toError(error).message}`);
      }
    }

    process.exit(0);
  };

  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
}

// 启动服务
startWebServer().catch((error) => {
  logger.error(`[Web] 启动失败: ${toError(error).message}`);
  process.exit(1);
});
