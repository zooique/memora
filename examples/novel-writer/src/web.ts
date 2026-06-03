/**
 * B3: Web UI demo
 *
 * 产品经理 / 终端用户视角：
 * - 启动后访问 http://localhost:3000
 * - 第一屏：LLM 配置表单（API Key / Base URL / Model）
 * - 配置后：聊天界面（SSE 流式输出）
 * - 配置存 localStorage，下次自动加载
 * - 4 层记忆面板：实时显示工作记忆 / Bootstrap / 归档 / 挂载
 */
import express, { type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createNovelAgent } from './agentBridge.js';
import { loadDemoConfig } from './config.js';
// 引用核心的类型，确保 demo 与 @memora/core 同步演进
import type { Agent, MemorySnapshot } from 'memora';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, '..', 'agent-config');
const PROJECT_PATH = resolve(__dirname, '..', '.novel-data');
const PUBLIC_DIR = resolve(__dirname, '..', 'public');

// 单例 agent（演示用，生产环境应该每次请求一个会话）
let agentInstance: Agent | null = null;

async function getAgent(config: ReturnType<typeof loadDemoConfig>): Promise<Agent> {
  if (agentInstance) return agentInstance;
  agentInstance = await createNovelAgent({
    llmApiKey: config.llm.apiKey,
    llmBaseUrl: config.llm.baseUrl,
    llmModel: config.llm.model,
    configDir: CONFIG_DIR,
    projectPath: PROJECT_PATH,
  });
  return agentInstance;
}

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ─── API：健康检查 ─────────────────────────────────────
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// ─── API：流式聊天（SSE）──────────────────────────────
app.post('/api/chat', async (req: Request, res: Response) => {
  const { message, config: clientConfig } = req.body as {
    message: string;
    config?: { apiKey: string; baseUrl: string; model: string };
  };

  if (!message?.trim()) {
    res.status(400).json({ error: '消息不能为空' });
    return;
  }

  // 客户端配置优先（来自表单）
  const config = clientConfig?.apiKey ? { llm: clientConfig, hasRealLlm: true } : loadDemoConfig();

  // SSE 头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    if (!config.hasRealLlm) {
      // Mock 模式
      const mockResponse = `[Mock 模式] 收到：「${message}」— 真实模式下，墨羽会基于 personality + rules + skills 上下文生成回复。\n\n请在配置表单中填入 mimo API Key 以启用真实对话。`;
      res.write(`data: ${JSON.stringify({ content: mockResponse })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const agent = await getAgent(config);
    for await (const chunk of agent.chat(message)) {
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
    res.end();
  }
});

// ─── API：4 层记忆快照 ──────────────────────────────────
// 调用 agent.inspect() + listAllTopics() 组合返回 4 层记忆的完整视图
// 详见 src/agent/agent.ts §inspect() 与 [记忆系统全景图.md §二]
app.get('/api/inspect', async (_req: Request, res: Response) => {
  try {
    if (!agentInstance) {
      res.json({ ready: false, reason: 'Agent 未启动（先发条消息激活）' });
      return;
    }
    // 同步快照：working / bootstrap / mounted（轻量、即时）
    const snapshot: MemorySnapshot = agentInstance.inspect();
    // 异步补全：归档文件清单（IO 操作）
    const topicFiles = await agentInstance.listAllTopics();
    res.json({
      ready: true,
      // 同步层：直接透传
      working: snapshot.working,
      bootstrap: snapshot.bootstrap,
      mounted: snapshot.mounted,
      // 异步层：合并到 archive
      archive: {
        ...snapshot.archive,
        topicFilesCount: topicFiles.length,
        topicFiles,
      },
      // 时间戳：便于前端判断快照新鲜度
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── API：保留旧的 /api/memories 兼容端点（仅 mounted） ─────
// 新 UI 优先用 /api/inspect，老客户端暂不删
app.get('/api/memories', (_req: Request, res: Response) => {
  try {
    if (!agentInstance) {
      res.json({ mounted: [], message: 'Agent 未启动' });
      return;
    }
    // 直接用 inspect() 的 mounted 子集，避免绕过 inspect 接口
    const snapshot = agentInstance.inspect();
    res.json({
      mounted: snapshot.mounted.items.map((m) => ({
        id: m.id,
        name: m.name,
        weight: m.weight,
        preview: m.contentPreview,
      })),
      total: snapshot.mounted.total,
      isMounted: snapshot.mounted.isMounted,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  const initialConfig = loadDemoConfig();
  console.log(`\n\x1b[36m\x1b[1m╔══════════════════════════════════════════╗`);
  console.log(`║   Memora · 小说创作 Demo（Web UI 形态）   ║`);
  console.log(`╚══════════════════════════════════════════╝\x1b[0m`);
  console.log(`\n\x1b[2m访问：http://localhost:${PORT}\x1b[0m`);
  console.log(
    `\x1b[2m模式：${initialConfig.hasRealLlm ? '\x1b[32m真实 LLM' : '\x1b[33mMock（请在页面填写 API Key）'}\x1b[0m\n`,
  );
});
