/**
 * 宿主自定义工具注册（H4：领域工具化）
 *
 * 背景：
 *   内核 ToolExecutor 提供了 registerTool() 机制，但 sprite 之前未注册任何
 *   自定义工具——LLM 只能调用 4 个内置工具（read_file/write_file/list_dir/search_memories），
 *   无法主动打开浏览器或检索精灵记忆。
 *
 *   本文件把 `/web` CLI 命令的浏览器打开逻辑提取为 webSearchTool，
 *   包装 searchMemories 为 memorySearchTool，让 LLM 在对话中自然调用。
 *
 * 设计原则：
 *   - 工具定义 + handler 同文件聚合，便于一次性注册
 *   - handler 复用 `index.ts` 现有的 execFile 跨平台逻辑
 *   - memorySearchTool 委托内核 searchMemories，避免重复实现
 *   - 节流/审计交给工具系统自然触发（每次调用走 SecurityGuard 审计日志）
 */
import { execFile } from 'node:child_process';
import { logger, toError } from 'memora';
import type { ToolDefinition, ToolHandler, ToolContext } from 'memora';

/**
 * 构建跨平台"打开浏览器搜索"命令
 *
 * 提取自 index.ts 原 /web 命令实现：使用 execFile 而非 exec，
 * 直接调用可执行文件，不经过 shell，消除命令注入风险。
 */
function buildBrowserOpenCommand(url: string): { cmd: string; args: string[] } {
  const platform = process.platform;
  if (platform === 'win32') {
    return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: [url] };
  }
  return { cmd: 'xdg-open', args: [url] };
}

/** web_search 工具定义（供 LLM 工具调用发现） */
export const WEB_SEARCH_TOOL: ToolDefinition = {
  name: 'web_search',
  description: '使用系统默认浏览器打开 Google 搜索关键词。当用户询问实时信息、'
    + '技术文档、新闻或任何需要联网的知识时调用。返回用户已打开浏览器的提示。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词，例如 "React 19 新特性"、"上海天气"',
      },
    },
    required: ['query'],
  },
};

/**
 * 执行浏览器搜索（纯函数，CLI 与工具共享）
 *
 * 提取自 index.ts 原 `/web` 命令：同一 execFile 逻辑供"用户敲 /web"和
 * "LLM 调用 web_search 工具"两个入口复用，避免两处实现漂移。
 */
export function webSearch(query: string): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) {
    return Promise.resolve('错误：搜索关键词不能为空');
  }
  const url = `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  const { cmd, args: cmdArgs } = buildBrowserOpenCommand(url);

  return new Promise<string>((resolve) => {
    execFile(cmd, cmdArgs, (err) => {
      if (err) {
        resolve(`错误：无法打开浏览器（${err.message}）。请用户手动访问：${url}`);
        return;
      }
      resolve(`已在系统默认浏览器中搜索："${trimmed}"。请用户查看浏览器窗口。`);
    });
  });
}

/** web_search 工具处理器 */
export const webSearchHandler: ToolHandler = async (args: Record<string, unknown>, _ctx: ToolContext) => {
  return webSearch(String(args.query ?? ''));
};

/** memory_search 工具定义 */
export const MEMORY_SEARCH_TOOL: ToolDefinition = {
  name: 'memory_search',
  description: '在精灵记忆库中搜索关键词，返回最相关的若干条记忆及其来源。'
    + '当用户询问"我之前说过什么"、"我们之前讨论过 XXX 吗"或需要历史上下文时调用。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '搜索关键词或自然语言查询',
      },
      limit: {
        type: 'string',
        description: '返回结果数量上限（1-10），默认 5',
      },
    },
    required: ['query'],
  },
};

/** memory_search 工具处理器 */
export const memorySearchHandler: ToolHandler = async (args: Record<string, unknown>, _ctx: ToolContext) => {
  const query = String(args.query ?? '').trim();
  if (!query) {
    return '错误：query 参数不能为空';
  }
  // limit 参数容错：解析失败时回退到默认 5
  const limitRaw = Number(args.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 10) : 5;

  // 委托给注册时绑定的 searcher，避免循环依赖
  const searcher = getMemorySearcher();
  if (!searcher) {
    return '错误：记忆搜索器未初始化';
  }

  try {
    const hits = await searcher(query, limit);
    if (hits.length === 0) {
      return `未找到与 "${query}" 相关的记忆`;
    }
    const lines = hits.map((h) => `- [${h.name}] ${h.contentPreview} (score: ${h.score.toFixed(2)})`);
    return `找到 ${hits.length} 条相关记忆：\n${lines.join('\n')}`;
  } catch (err) {
    // 记忆搜索失败时返回错误信息给 LLM，同时记录警告便于排查
    logger.warn({ err: toError(err).message, query }, '记忆搜索失败');
    return `错误：记忆搜索失败：${err instanceof Error ? err.message : String(err)}`;
  }
};

/** 记忆搜索器引用（由 index.ts 在 initAgentFromConfig 中注入） */
type MemorySearcher = (query: string, limit: number) => Promise<Array<{ name: string; contentPreview: string; score: number }>>;
let memorySearcher: MemorySearcher | null = null;

/** 注入记忆搜索器（在 Agent 初始化完成后调用） */
export function setMemorySearcher(searcher: MemorySearcher): void {
  memorySearcher = searcher;
}

/** 获取当前搜索器引用（handler 调用时使用） */
function getMemorySearcher(): MemorySearcher | null {
  return memorySearcher;
}
