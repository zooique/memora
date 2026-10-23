/**
 * MCP 连接管理器测试 — 分页拉全 + 真实 stdio 连接 + 调用转发 + 注销
 *
 * 判据来源：方案-MCP工具接入 §7 P1/P4、§9 切片 1（分页超一页要全注册 / 停用后工具消失）。
 * 纯分页逻辑用注入页函数测；端到端用 fixtures/fakeMcpServer.mjs 子进程测（真握手、真调用）。
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolHandler } from '@zooique/memora';
import { McpConnection, collectAllTools } from '../mcp/connectionManager.js';
import {
  buildToolBindings,
  registerServerTools,
  unregisterServerTools,
} from '../mcp/toolRegistry.js';

/** 测试夹具 server 的绝对路径（子进程以此启动） */
const FIXTURE_SERVER = fileURLToPath(new URL('./fixtures/fakeMcpServer.mjs', import.meta.url));

/**
 * 造一个只有名字的假工具（分页测试不关心 schema）
 *
 * @param name 工具名
 */
function stubTool(name: string): McpTool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}

describe('collectAllTools 分页', () => {
  it('循环 nextCursor 直到缺省（只取第一页 = 静默漏工具）', async () => {
    const pages: Record<string, { tools: McpTool[]; nextCursor?: string }> = {
      '': { tools: [stubTool('a'), stubTool('b')], nextCursor: 'c2' },
      c2: { tools: [stubTool('c')], nextCursor: 'c3' },
      c3: { tools: [stubTool('d')] },
    };
    const all = await collectAllTools(async (cursor) => {
      const page = pages[cursor ?? ''];
      if (!page) throw new Error(`未定义的 cursor：${String(cursor)}`);
      return page;
    });
    expect(all.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('server 返回重复 cursor 时收口，不死循环', async () => {
    let calls = 0;
    const all = await collectAllTools(async () => {
      calls += 1;
      return { tools: [stubTool(`p${calls}`)], nextCursor: 'same' };
    });
    // 第一页后 cursor='same'，第二页再次返回 'same' → 命中去重即停
    expect(calls).toBe(2);
    expect(all).toHaveLength(2);
  });
});

describe('真实 stdio 连接（fixtures/fakeMcpServer.mjs）', () => {
  it('握手 → 分页拉全工具 → 注册可调用 → 注销后消失', async () => {
    const connection = new McpConnection({
      name: 'fake',
      command: process.execPath,
      args: [FIXTURE_SERVER],
    });

    try {
      const tools = await connection.connect();
      // 3 个工具分 2 页，全部拿到才说明分页循环正确
      expect(tools.map((t) => t.name)).toEqual(['echo-text', 'with-enum', 'always-fails']);

      // 三个都可映射（顶层任何不可映射形态由 toolRegistry 单测覆盖）
      const { bindings, skipped } = buildToolBindings('fake', tools);
      expect(bindings.map((b) => b.derivedName)).toEqual([
        'mcp__fake__echo_text',
        'mcp__fake__with_enum',
        'mcp__fake__always_fails',
      ]);
      expect(skipped).toHaveLength(0);

      // 内存注册面：验证注册即写入、handler 走原始名转发、结果文本回落
      const definitions = new Map<string, ToolDefinition>();
      const handlers = new Map<string, ToolHandler>();
      const registrar = {
        registerTool: (definition: ToolDefinition, handler: ToolHandler) => {
          definitions.set(definition.name, definition);
          handlers.set(definition.name, handler);
        },
        removeTool: (name: string) => {
          definitions.delete(name);
          handlers.delete(name);
        },
      };
      registerServerTools(registrar, bindings, (originalName, args) =>
        connection.callTool(originalName, args),
      );
      expect(definitions.size).toBe(3);

      const echo = handlers.get('mcp__fake__echo_text');
      await expect(echo?.({ message: 'hi' }, { guardPath: () => {} })).resolves.toBe(
        'echo:echo-text:{"message":"hi"}',
      );

      // isError 不得当正常文本回填（假成功比失败更糟）
      const failing = handlers.get('mcp__fake__always_fails');
      await expect(failing?.({}, { guardPath: () => {} })).rejects.toThrow('故意失败');

      // 停用语义：注销后工具从注册面消失（内核侧 removeTool 后快照不再含它）
      unregisterServerTools(registrar, bindings);
      expect(definitions.size).toBe(0);
    } finally {
      await connection.close();
    }
  }, 30_000);

  it('关闭后调用抛错（不留可用外壳）且主动关闭不触发断线回调', async () => {
    const connection = new McpConnection({
      name: 'fake',
      command: process.execPath,
      args: [FIXTURE_SERVER],
    });
    let closedNotified = 0;
    await connection.connect();
    connection.onClosed = () => {
      closedNotified += 1;
    };
    await connection.close();
    // 主动关闭：closing 标记应过滤掉底层 onclose 回调
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(closedNotified).toBe(0);
    await expect(connection.callTool('echo-text', {})).rejects.toThrow('连接不可用');
  }, 30_000);
});
