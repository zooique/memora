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
// 记录当前 agent 实例使用的 LLM 配置，用于判断是否需要重建
let agentLlmConfig: { apiKey: string; baseUrl: string; model: string } | null = null;

/**
 * 获取或创建 Agent 实例
 *
 * 关键逻辑：当客户端传了新的 API Key 时，需要重建 Agent（从 Mock 切到真实 LLM）
 * 当客户端没传 API Key 时，使用 Mock 模式（不走 Agent 链路，避免回显污染）
 */
async function getAgent(config: ReturnType<typeof loadDemoConfig>): Promise<Agent> {
  // 判断是否需要重建 Agent（配置变化或首次创建）
  const configChanged =
    agentLlmConfig?.apiKey !== config.llm.apiKey ||
    agentLlmConfig?.baseUrl !== config.llm.baseUrl ||
    agentLlmConfig?.model !== config.llm.model;

  if (agentInstance && !configChanged) return agentInstance;

  // 关闭旧 Agent（如果有）
  if (agentInstance) {
    try {
      await agentInstance.close();
    } catch {
      // 关闭失败忽略
    }
    agentInstance = null;
  }

  agentInstance = await createNovelAgent({
    llmApiKey: config.llm.apiKey,
    llmBaseUrl: config.llm.baseUrl,
    llmModel: config.llm.model,
    configDir: CONFIG_DIR,
    projectPath: PROJECT_PATH,
  });
  agentLlmConfig = { ...config.llm };

  // 始终恢复最近的话题对话（topic-*.md 是对话历史的唯一来源）
  // Mock 模式的写入污染已在 /api/chat 路由中通过短路逻辑解决，
  // 这里只读不写，安全恢复。
  try {
    const restoredCount = await agentInstance.restoreMostRecentTopic('main');
    if (restoredCount > 0) {
      console.log(`已恢复 ${restoredCount} 条历史对话消息`);
    }
  } catch (err) {
    console.warn('恢复历史对话失败:', err);
  }

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
    // Mock 模式：直接生成 mock 响应（不走 Agent → 避免 mock 回显污染 topic-*.md 历史）
    if (!config.hasRealLlm) {
      const mockReply = `Mock 响应：${message.trim().slice(0, 200)}`;
      for (const char of mockReply) {
        res.write(`data: ${JSON.stringify({ content: char })}\n\n`);
        await new Promise((r) => setTimeout(r, 5));
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 真实 LLM：走完整 Agent 链路，透传结构化事件给前端
    const agent = await getAgent(config);
    for await (const chunk of agent.chat(message)) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
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
// 详见 src/agent/agent.ts §inspect() 与 [00-记忆归档原则-v1.0.md §2.1 四层记忆模型]
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
    // 实时归档计数：SQLite 里 type='topic' 的记忆数
    // 这是 signal 触发 / lazy 扫描 / 切话题三类归档的累计效果
    let autoArchivedCount = 0;
    try {
      const ctx = agentInstance.getBuildCtx?.();
      if (ctx) {
        const topicMemories = await ctx.index.getByType('topic');
        autoArchivedCount = topicMemories.length;
      }
    } catch {
      // 索引读取失败不影响其他字段
    }
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
        autoArchivedCount, // 自动归档到 SQLite 的条数（信号触发 + lazy + 切话题）
      },
      // 时间戳：便于前端判断快照新鲜度
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ─── API：获取对话历史（页面刷新恢复用）──────────────────
// 返回 AgentLoop 内部 messages 数组，前端据此重新渲染聊天气泡
// 注意：仅覆盖"页面刷新"场景；服务重启后此数组仅含 system prompt
app.get('/api/messages', (_req: Request, res: Response) => {
  try {
    if (!agentInstance) {
      res.json({ messages: [] });
      return;
    }
    // 过滤掉 system 提示（前端不需要渲染内部 system prompt）
    const all = agentInstance.getMessages();
    const visible = all
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content: stripInternalFormat(m.content),
      }));
    res.json({ messages: visible });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * 剥离 Agent 内部上下文格式，只保留用户可见内容
 *
 * loop.ts 的 wrapWithTopicContext() 会在 user 消息前添加：
 *   [系统召回的相关记忆]
 *   - [date] name: content...
 *   [用户输入]
 *   实际用户输入
 *
 * 这些是给 LLM 看的内部格式，不应展示给用户。
 * 此函数提取 [用户输入] 之后的部分作为用户原始输入。
 */
function stripInternalFormat(content: string): string {
  // 匹配 [系统召回的相关记忆]...[用户输入]\n 实际输入
  const userInputMatch = content.match(/\[用户输入\]\n([\s\S]*)/);
  if (userInputMatch) {
    return userInputMatch[1]!.trim();
  }
  return content;
}

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

// ─── API：章节列表（R-508）──────────────────────────────
// 读取 chapters/ 目录下的 .md 文件列表
// 供前端章节管理面板使用
app.get('/api/chapters', async (_req: Request, res: Response) => {
  try {
    if (!agentInstance) {
      res.json({ chapters: [] });
      return;
    }
    // 委托 list_dir 列出 chapters 目录
    const result = await agentInstance.executeTool(
      'list_dir',
      JSON.stringify({ path: 'chapters' }),
    );
    // 解析 list_dir 输出，提取 .md 文件名
    const lines = result.split('\n');
    const chapters = lines
      .filter((l) => l.includes('.md'))
      .map((l) => {
        // 格式：📄 第1章-起源.md
        const match = l.match(/📄\s+(.+)/);
        return match ? match[1].trim() : l.trim();
      });
    res.json({ chapters });
  } catch {
    // chapters 目录可能不存在
    res.json({ chapters: [] });
  }
});

// ─── API：角色列表（R-508）──────────────────────────────
// 读取 characters/ 目录下的 .md 文件列表
// 供前端角色卡片面板使用
app.get('/api/characters', async (_req: Request, res: Response) => {
  try {
    if (!agentInstance) {
      res.json({ characters: [] });
      return;
    }
    // 委托 list_dir 列出 characters 目录
    const result = await agentInstance.executeTool(
      'list_dir',
      JSON.stringify({ path: 'characters' }),
    );
    // 解析 list_dir 输出，提取 .md 文件名
    const lines = result.split('\n');
    const characters = lines
      .filter((l) => l.includes('.md'))
      .map((l) => {
        const match = l.match(/📄\s+(.+)/);
        return match ? match[1].trim() : l.trim();
      });
    res.json({ characters });
  } catch {
    // characters 目录可能不存在
    res.json({ characters: [] });
  }
});

// ─── API：角色列表（P-609）──────────────────────────────
app.get('/api/personas', (_req: Request, res: Response) => {
  try {
    if (!agentInstance) {
      res.json({ personas: [], active: 'default', mode: 'auto' });
      return;
    }
    const personas = agentInstance.listPersonas();
    res.json({
      personas,
      active: personas.length > 0 ? 'auto' : 'default',
      mode: agentInstance.getPersonaMode(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── API：切换角色模式（P-609）──────────────────────────
app.post('/api/personas/mode', express.json(), (req: Request, res: Response) => {
  try {
    if (!agentInstance) {
      res.status(503).json({ error: 'Agent 未就绪' });
      return;
    }
    const { mode } = req.body as { mode?: string };
    if (mode === 'auto' || mode === 'manual') {
      agentInstance.setPersonaMode(mode);
    }
    const { persona } = req.body as { persona?: string };
    if (persona) {
      agentInstance.switchPersona(persona);
    }
    res.json({ mode: agentInstance.getPersonaMode() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

const PORT = process.env.PORT ?? 3000;

// 服务器启动时立即初始化 agent（而不是惰性初始化）
async function initializeAgentOnStartup() {
  try {
    const initialConfig = loadDemoConfig();
    console.log('正在初始化 Agent...');
    await getAgent(initialConfig);
    console.log('Agent 初始化完成');
  } catch (err) {
    console.warn('Agent 预初始化失败（但服务仍会启动）:', err);
  }
}

app.listen(PORT, async () => {
  const initialConfig = loadDemoConfig();
  console.log(`\n\x1b[36m\x1b[1m╔══════════════════════════════════════════╗`);
  console.log(`║   Memora · 小说创作 Demo（Web UI 形态）   ║`);
  console.log(`╚══════════════════════════════════════════╝\x1b[0m`);
  console.log(`\n\x1b[2m访问：http://localhost:${PORT}\x1b[0m`);
  console.log(
    `\x1b[2m模式：${initialConfig.hasRealLlm ? '\x1b[32m真实 LLM' : '\x1b[33mMock（请在页面填写 API Key）'}\x1b[0m\n`,
  );

  // 启动时初始化 agent
  await initializeAgentOnStartup();
});
