/**
 * 测试用 MCP server（stdio）— 只为验证宿主客户端的四条行为
 *
 * 刻意构造的边界：
 *   - 工具清单**分页**（每页 2 个，共 4 个）：验证宿主循环 nextCursor 拉全（否则只注册第一页 = 静默漏工具）；
 *   - 一个工具带枚举/范围约束：验证约束降级为描述文字（宿主侧断言）；
 *   - 一个工具**必错**（isError）：验证宿主不当正常文本回填（假成功）；
 *   - 一个工具**永不响应**：验证宿主调用转发有超时兜底（server 卡死不得挂死 agent turn）。
 *
 * ⚠️ 夹具不出顶层 `anyOf` 工具：SDK 自身按 `inputSchema.type === 'object'` 校验出站结果，
 * 造不出这种形态（真实场景来自非 SDK 实现的 server），该分支由 toolRegistry 单测覆盖。
 *
 * 由 mcpConnectionManager.test.ts 以子进程方式拉起；不被 tsc/eslint 收录（测试夹具）。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** 每页工具数（小于总数即必然产生第二页） */
const PAGE_SIZE = 2;

/** 全部工具声明（3 个 = 2 页） */
const TOOLS = [
  {
    name: 'echo-text',
    description: '回显文本',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: '要回显的文本' } },
      required: ['message'],
    },
  },
  {
    name: 'with-enum',
    description: '带枚举与范围约束',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['fast', 'safe'], description: '模式' },
        limit: { type: 'number', minimum: 1, maximum: 10 },
      },
    },
  },
  {
    name: 'always-fails',
    description: '永远返回 isError',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'never-responds',
    description: '永不响应（测调用超时）',
    inputSchema: { type: 'object', properties: {} },
  },
];

const server = new Server({ name: 'fake-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

// 分页：cursor = 起始下标（空 cursor = 第一页）
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const rawCursor = request.params?.cursor;
  const start = rawCursor ? Number(rawCursor) : 0;
  const page = TOOLS.slice(start, start + PAGE_SIZE);
  const next = start + PAGE_SIZE < TOOLS.length ? String(start + PAGE_SIZE) : undefined;
  return next ? { tools: page, nextCursor: next } : { tools: page };
});

// 调用：回显原始工具名与参数；always-fails 走 isError 分支；never-responds 永不 resolve
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name === 'always-fails') {
    return { content: [{ type: 'text', text: '故意失败' }], isError: true };
  }
  if (name === 'never-responds') {
    // 永不 settle 的 Promise：宿主必须靠超时收口，不得无限等待
    return new Promise(() => {});
  }
  return {
    content: [{ type: 'text', text: `echo:${name}:${JSON.stringify(args ?? {})}` }],
  };
});

await server.connect(new StdioServerTransport());
