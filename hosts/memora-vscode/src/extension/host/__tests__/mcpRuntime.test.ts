/**
 * MCP 运行时测试 — list_changed 整换 / 并发守卫 / 总量收敛判定
 *
 * 判据来源：方案-MCP工具接入 §7 P2（list_changed 订阅 → 同步）、§10 S5 行
 * （总量收敛提示）、§9 切片 3b。
 * 纯逻辑用注入替身测（不拉起子进程）；通知→回调的真链路见
 * mcpConnectionManager.test.ts 的 list_changed 用例。
 */
import { describe, it, expect } from 'vitest';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolHandler } from '@zooique/memora';
import type { McpConnection } from '../mcp/connectionManager.js';
import {
  MAX_TOTAL_MCP_TOOLS,
  createResyncGuard,
  resyncServerTools,
  shouldWarnToolBudget,
} from '../mcp/runtime.js';
import type { ToolRegistrar } from '../mcp/toolRegistry.js';

/**
 * 造一个假工具（只关心名字与可映射性）
 *
 * @param name 工具名
 */
function stubTool(name: string): McpTool {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}

/** 假连接：refreshTools 返回给定清单（或抛错），callTool 不回吐（本测试不转发） */
function stubConnection(
  tools: McpTool[] | Error,
): Pick<McpConnection, 'refreshTools' | 'callTool'> {
  return {
    refreshTools: async () => {
      if (tools instanceof Error) throw tools;
      return tools;
    },
    callTool: async () => ({}),
  };
}

/**
 * 假注册面（对齐内核 ToolExecutor 的两条真实语义）
 *
 * - `registerTool` 撞名**抛错**（toolExecutor.ts 837-842 行实证：不可覆盖重注册）；
 * - `removeTool` 缺失静默（幂等）。
 */
function fakeRegistrar(): { registrar: ToolRegistrar; names: () => string[] } {
  const defs = new Map<string, ToolDefinition>();
  const registrar: ToolRegistrar = {
    registerTool(definition: ToolDefinition, _handler: ToolHandler) {
      if (defs.has(definition.name)) {
        throw new Error(`工具已注册：${definition.name}`);
      }
      defs.set(definition.name, definition);
    },
    removeTool(name: string) {
      defs.delete(name);
    },
  };
  return { registrar, names: () => [...defs.keys()].sort() };
}

describe('resyncServerTools（list_changed 整换）', () => {
  it('新增工具：重取后进注册集（派生名按新集合整体重派生）', async () => {
    const { registrar, names } = fakeRegistrar();
    const first = await resyncServerTools(
      's',
      stubConnection([stubTool('a')]),
      registrar,
      [],
      new Set(),
    );
    expect(names()).toEqual(['mcp__s__a']);

    const second = await resyncServerTools(
      's',
      stubConnection([stubTool('a'), stubTool('b')]),
      registrar,
      first,
      new Set(),
    );
    expect(names()).toEqual(['mcp__s__a', 'mcp__s__b']);
    expect(second.map((b) => b.originalName)).toEqual(['a', 'b']);
  });

  it('删除工具：旧派生名被注销（不留僵尸工具让模型调）', async () => {
    const { registrar, names } = fakeRegistrar();
    const first = await resyncServerTools(
      's',
      stubConnection([stubTool('a'), stubTool('b')]),
      registrar,
      [],
      new Set(),
    );
    expect(names()).toEqual(['mcp__s__a', 'mcp__s__b']);

    await resyncServerTools('s', stubConnection([stubTool('a')]), registrar, first, new Set());
    expect(names()).toEqual(['mcp__s__a']);
  });

  it('撞名后缀漂移：删掉一个撞名工具后，幸存工具的后缀名被清掉（整换的核心理由）', async () => {
    const { registrar, names } = fakeRegistrar();
    // a-b 与 a.b 清洗后同名 → 后者拿 _2 后缀
    const first = await resyncServerTools(
      's',
      stubConnection([stubTool('a-b'), stubTool('a.b')]),
      registrar,
      [],
      new Set(),
    );
    expect(names()).toEqual(['mcp__s__a_b', 'mcp__s__a_b_2']);

    // 删掉 a-b：按原名增量 diff 只会撤 mcp__s__a_b，把 mcp__s__a_b_2 留给 a.b——
    // 而全新派生下 a.b 就是无后缀名。整换重跑派生，后缀自然消失
    await resyncServerTools('s', stubConnection([stubTool('a.b')]), registrar, first, new Set());
    expect(names()).toEqual(['mcp__s__a_b']);
  });

  it('重取失败：保留原注册集（没拿到新清单就动注册面 = 无据之变）', async () => {
    const { registrar, names } = fakeRegistrar();
    const first = await resyncServerTools(
      's',
      stubConnection([stubTool('a'), stubTool('b')]),
      registrar,
      [],
      new Set(),
    );

    const after = await resyncServerTools(
      's',
      stubConnection(new Error('tools/list 超时')),
      registrar,
      first,
      new Set(),
    );
    expect(names()).toEqual(['mcp__s__a', 'mcp__s__b']);
    expect(after.map((b) => b.originalName)).toEqual(['a', 'b']);
  });

  it('注册撞名（跨 server 派生名冲突）：回滚到原集，注册面不留半吊子状态', async () => {
    const { registrar, names } = fakeRegistrar();
    const first = await resyncServerTools(
      's',
      stubConnection([stubTool('alpha')]),
      registrar,
      [],
      new Set(),
    );

    // 模拟「别处已占用 mcp__s__conflict」：包一层注册面，撞该名即抛
    const blocking: ToolRegistrar = {
      registerTool(definition, handler) {
        if (definition.name === 'mcp__s__conflict') {
          throw new Error('工具已注册：mcp__s__conflict');
        }
        registrar.registerTool(definition, handler);
      },
      removeTool: (name) => registrar.removeTool(name),
    };

    const after = await resyncServerTools(
      's',
      stubConnection([stubTool('alpha'), stubTool('conflict')]),
      blocking,
      first,
      new Set(),
    );
    // 新集注册中途抛 → 撤新集、写回旧集：最终只剩原来的 alpha
    expect(names()).toEqual(['mcp__s__alpha']);
    expect(after.map((b) => b.originalName)).toEqual(['alpha']);
  });
});

describe('shouldWarnToolBudget（总量收敛判定）', () => {
  it('阈值以下与等于阈值不提示（不误伤正常规模）', () => {
    expect(shouldWarnToolBudget(0, false)).toBe(false);
    expect(shouldWarnToolBudget(MAX_TOTAL_MCP_TOOLS, false)).toBe(false);
  });

  it('超过阈值提示一次；已提示过不重复（回落由调用方重置）', () => {
    expect(shouldWarnToolBudget(MAX_TOTAL_MCP_TOOLS + 1, false)).toBe(true);
    expect(shouldWarnToolBudget(MAX_TOTAL_MCP_TOOLS + 1, true)).toBe(false);
  });
});

describe('createResyncGuard（并发通知合并）', () => {
  it('执行中到达的通知只记账不并发；跑完补一轮（不丢最终状态）', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const guard = createResyncGuard(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      runs += 1;
      await gate; // 第一轮挂住，模拟慢重取
      concurrent -= 1;
    });

    guard(); // 第一轮（挂住）
    guard(); // 到达中 → 只记账
    guard(); // 到达中 → 仍只记账（不叠第二轮的排队）
    guard();
    expect(runs).toBe(1);

    release();
    // 等守卫把待办轮跑完
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(maxConcurrent).toBe(1); // 从未并发
    expect(runs).toBe(2); // 第一轮 + 一轮补跑（3 条在途通知合并成 1 个待办位）
  });

  it('一轮内 run 抛错不卡死后续通知（守卫可再次触发）', async () => {
    let runs = 0;
    const guard = createResyncGuard(async () => {
      runs += 1;
      throw new Error('重同步炸了');
    });
    guard();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs).toBe(1);
    guard();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runs).toBe(2);
  });
});
