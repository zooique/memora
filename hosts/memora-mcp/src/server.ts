/**
 * MCP Server 装配 —— 只读记忆能力 → MCP 协议
 *
 * ## 为什么用 stdio 而不是 HTTP
 * memora 是 **local-first**：记忆落在用户本机 `.memora/` 目录。stdio 传输让服务器作为
 * agent 的**子进程**跑在本机，直接读本地文件——不需要记忆出网、不需要额外端口、
 * 不需要鉴权隧道。代价（见设计文档 §七）：只有**本机 agent**能接入，云端 API 类 agent
 * 触不到。这是刻意的取舍，不是缺口。
 *
 * ## stdout 是协议通道，不可污染
 * MCP stdio 传输用 stdout 传 JSON-RPC。**任何诊断输出必须走 stderr**，
 * 向 stdout 写一个字符都会破坏协议解析。本文件不打印任何东西（诊断在 index.ts）。
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, callTool } from './tools.js';
import type { ReadOnlyFileStore } from './readOnlyFileStore.js';

export const SERVER_NAME = 'memora-mcp';

/**
 * 启动 MCP stdio 服务器（阻塞到 stdin 关闭）。
 *
 * @param store 已 load 的只读记忆库
 * @param version 服务器版本（握手时上报，便于 agent 侧排错）
 */
export async function serve(store: ReadOnlyFileStore, version: string): Promise<void> {
  const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...TOOL_DEFINITIONS],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    return callTool(store, name, args);
  });

  await server.connect(new StdioServerTransport());
}
