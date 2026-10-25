/**
 * MCP 真机验收用本地 server（零网络依赖，见 hosts/memora-vscode/docs/mcp-acceptance.md §1）
 *
 * 为什么放在这个目录：ESM 从**脚本所在目录**逐级向上找 node_modules，与进程 cwd 无关。
 * 本目录的 node_modules 里有 @modelcontextprotocol/sdk；放到解析不到的位置会在拉起时
 * 报 ERR_MODULE_NOT_FOUND，面板只显示 `MCP error -32000: Connection closed`。
 *
 * 覆盖点：分页（5 工具 / 每页 2 ⇒ 3 页）、list_changed（toggle-tool 追加 extra-tool）、
 * isError（fail）、永不响应（hang，验 60s 转发超时）。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** 每页工具数（5 个工具 ⇒ 3 页，验宿主是否循环 nextCursor 拉全） */
const PAGE_SIZE = 2;

/** 初始工具集（派生名 = mcp__acc__<name>） */
const TOOLS = [
  {
    name: 'echo',
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
        mode: { type: 'string', enum: ['fast', 'safe'] },
        limit: { type: 'number', minimum: 1, maximum: 10 },
      },
    },
  },
  {
    name: 'toggle-tool',
    description: '调用后追加一个工具并推 list_changed',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fail',
    description: '永远返回 isError',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'hang',
    description: '永不响应（验 60s 转发超时）',
    inputSchema: { type: 'object', properties: {} },
  },
];

/** toggle-tool 调用后才出现的工具 */
const EXTRA = {
  name: 'extra-tool',
  description: 'toggle-tool 调用后才出现',
  inputSchema: { type: 'object', properties: {} },
};

/** extra-tool 是否已解锁 */
let unlocked = false;

const server = new Server(
  { name: 'acceptance', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const start = req.params?.cursor ? Number(req.params.cursor) : 0;
  const list = unlocked ? [...TOOLS, EXTRA] : TOOLS;
  const page = list.slice(start, start + PAGE_SIZE);
  const next = start + PAGE_SIZE < list.length ? String(start + PAGE_SIZE) : undefined;
  return next ? { tools: page, nextCursor: next } : { tools: page };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'fail') return { content: [{ type: 'text', text: '故意失败' }], isError: true };
  if (name === 'hang') return new Promise(() => {});
  if (name === 'toggle-tool') {
    unlocked = true;
    await server.sendToolListChanged();
    return { content: [{ type: 'text', text: '已追加 extra-tool 并通知' }] };
  }
  return { content: [{ type: 'text', text: `echo:${name}:${JSON.stringify(args ?? {})}` }] };
});

await server.connect(new StdioServerTransport());
