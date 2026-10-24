/**
 * MCP 运行时测试 — list_changed 整换 / 并发守卫 / 总量收敛判定 / 配置热更差分
 *
 * 判据来源：方案-MCP工具接入 §7 P2（list_changed 订阅 → 同步）、§10 S5 行
 * （总量收敛提示）与「改配置需重载窗口」登记行（切片 4 落地为即时热更）、
 * §9 切片 3b / 切片 4。
 * 纯逻辑用注入替身测（不拉起子进程）；通知→回调的真链路见
 * mcpConnectionManager.test.ts 的 list_changed 用例。
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { Agent, ILogger, ToolDefinition, ToolHandler } from '@zooique/memora';
import type { McpConnection } from '../mcp/connectionManager.js';
import {
  MAX_TOTAL_MCP_TOOLS,
  applyMcpConfigChange,
  createResyncGuard,
  getMcpServerStatus,
  resyncServerTools,
  restartMcpServer,
  setMcpStatusListener,
  shouldWarnToolBudget,
  startMcpServers,
  stopMcpServers,
  type McpConnectionFactory,
} from '../mcp/runtime.js';
import type { McpServerConfig } from '../mcp/connectionManager.js';
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
function fakeRegistrar(): {
  registrar: ToolRegistrar;
  names: () => string[];
  policyOf: (name: string) => ToolDefinition['confirmPolicy'];
} {
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
  return {
    registrar,
    names: () => [...defs.keys()].sort(),
    policyOf: (name: string) => defs.get(name)?.confirmPolicy,
  };
}

// ─── 配置热更（切片 4）的替身 ───────────────────────────────────────────────

/**
 * 假连接（热更差分用）：记录 connect/close 调用与顺序，支持挂起 refreshTools
 *
 * 与 stubConnection 的分工：那个只服务 resyncServerTools 的两个方法；这个要经
 * startOneServer 全链路（connect / onClosed / onToolsChanged 赋值 / listTools），
 * 故按 McpConnection 的使用面造（测试内转型，生产代码零 as 纪律不适用于测试）。
 */
class FakeConnection {
  onClosed?: () => void;
  onToolsChanged?: () => void;
  connectCount = 0;
  closeCount = 0;
  /** refreshTools 挂起门（测试控制时序用；null = 不挂） */
  refreshGate: Promise<void> | null = null;
  private tools: McpTool[];

  constructor(
    readonly name: string,
    tools: McpTool[],
    private readonly log: string[],
    /** connect 挂起门（热更串行测试用） */
    private readonly connectGate?: Promise<void>,
  ) {
    this.tools = tools;
  }

  /** 换工具清单（模拟 server 侧 tools/list 变化，下次 refreshTools 生效） */
  setTools(tools: McpTool[]): void {
    this.tools = tools;
  }

  async connect(): Promise<McpTool[]> {
    this.connectCount += 1;
    this.log.push(`connect-start:${this.name}`);
    if (this.connectGate) await this.connectGate;
    this.log.push(`connect-done:${this.name}`);
    return this.tools;
  }

  async refreshTools(): Promise<McpTool[]> {
    if (this.refreshGate) await this.refreshGate;
    return this.tools;
  }

  listTools(): readonly McpTool[] {
    return this.tools;
  }

  async callTool(): Promise<unknown> {
    return {};
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.log.push(`close:${this.name}`);
  }
}

/** 热更测试的工厂句柄（拿得到造出的连接，断言其上的回调接线） */
interface FakeFactory {
  factory: McpConnectionFactory;
  /** 按创建顺序排列的连接实例 */
  connections: FakeConnection[];
}

/**
 * 造连接工厂（测试注入；生产缺省 new McpConnection）
 *
 * @param log 调用顺序流水（connect-start/connect-done/close:<name>）
 * @param toolsByName 每个 server 名的初始工具清单
 * @param slowNames connect 需挂起等待 slowGate 的 server 名（串行测试用）
 * @param slowGate 挂起门
 */
function fakeFactory(
  log: string[],
  toolsByName: Record<string, McpTool[]>,
  slowNames?: Set<string>,
  slowGate?: Promise<void>,
): FakeFactory {
  const connections: FakeConnection[] = [];
  const factory: McpConnectionFactory = (config) => {
    const gate = slowNames?.has(config.name) ? slowGate : undefined;
    const conn = new FakeConnection(config.name, toolsByName[config.name] ?? [], log, gate);
    connections.push(conn);
    return conn as unknown as McpConnection;
  };
  return { factory, connections };
}

/** 假 Agent（只暴露 tools 注册面——热更差分只用它） */
function fakeAgent(registrar: ToolRegistrar): Agent {
  return { tools: registrar } as unknown as Agent;
}

/** 收集告警的假日志（断言「跳过非法配置」等承诺有通道） */
function capturingLogger(): { logger: ILogger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: ILogger = {
    debug: () => {},
    info: () => {},
    warn: (objOrMsg: Record<string, unknown> | string) => {
      warnings.push(typeof objOrMsg === 'string' ? objOrMsg : String(objOrMsg));
    },
    error: () => {},
  };
  return { logger, warnings };
}

/** 测试配置（只写 name/command——差分判据恰好覆盖这两字段的变更） */
function cfg(name: string, command = 'node'): McpServerConfig {
  return { name, command };
}

/** 模块级单例卫生：每个用例后停掉全部（同时清 running 与 allowlist 基线） */
afterEach(async () => {
  await stopMcpServers();
});

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

describe('applyMcpConfigChange（配置热更差分 · 切片 4）', () => {
  it('新增 server：热更拉起并注册（首装同语义）', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    const { factory } = fakeFactory(log, { s1: [stubTool('a')] });

    await applyMcpConfigChange(fakeAgent(registrar), [cfg('s1')], {
      allowlist: [],
      connect: factory,
    });

    expect(names()).toEqual(['mcp__s1__a']);
    expect(log).toEqual(['connect-start:s1', 'connect-done:s1']);
  });

  it('配置没变：连接不动（不重连、不打断进行中调用）', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    const { factory, connections } = fakeFactory(log, { s1: [stubTool('a')] });
    const agent = fakeAgent(registrar);
    const options = { allowlist: [] as string[], connect: factory };

    await applyMcpConfigChange(agent, [cfg('s1')], options);
    // 语义相同但对象不同（模拟用户编辑 settings.json 后重新读入）
    await applyMcpConfigChange(agent, [cfg('s1')], options);

    expect(connections).toHaveLength(1);
    expect(connections[0].connectCount).toBe(1);
    expect(connections[0].closeCount).toBe(0);
    expect(names()).toEqual(['mcp__s1__a']);
  });

  it('配置变了：先停后起（旧连接关闭在新连接建立之前，不两套并存）', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    const { factory } = fakeFactory(log, { s1: [stubTool('a')] });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(agent, [cfg('s1', 'node')], { allowlist: [], connect: factory });
    await applyMcpConfigChange(agent, [cfg('s1', 'node2')], { allowlist: [], connect: factory });

    expect(log).toEqual([
      'connect-start:s1',
      'connect-done:s1',
      'close:s1',
      'connect-start:s1',
      'connect-done:s1',
    ]);
    expect(names()).toEqual(['mcp__s1__a']);
  });

  it('删除 server：停并注销其工具', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    const { factory, connections } = fakeFactory(log, {
      s1: [stubTool('a')],
      s2: [stubTool('c')],
    });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(agent, [cfg('s1'), cfg('s2')], { allowlist: [], connect: factory });
    expect(names()).toEqual(['mcp__s1__a', 'mcp__s2__c']);

    await applyMcpConfigChange(agent, [cfg('s1')], { allowlist: [], connect: factory });
    expect(names()).toEqual(['mcp__s1__a']);
    expect(connections).toHaveLength(2);
    expect(connections[1].closeCount).toBe(1);
  });

  it('清空配置：停掉全部旧连接（登记项②的回归守护——漏停 = 僵尸子进程）', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    const { factory, connections } = fakeFactory(log, {
      s1: [stubTool('a')],
      s2: [stubTool('c')],
    });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(agent, [cfg('s1'), cfg('s2')], { allowlist: [], connect: factory });
    await applyMcpConfigChange(agent, [], { allowlist: [], connect: factory });

    expect(names()).toEqual([]);
    expect(log.filter((line) => line.startsWith('close:'))).toEqual(['close:s1', 'close:s2']);
    expect(connections.every((conn) => conn.closeCount === 1)).toBe(true);
  });

  it('startMcpServers 空配置也先停后起（早退不再位于停机之前的直接守护）', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    const { factory, connections } = fakeFactory(log, { s1: [stubTool('a')] });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(agent, [cfg('s1')], { allowlist: [], connect: factory });
    await startMcpServers(agent, [], { allowlist: [], connect: factory });

    expect(names()).toEqual([]);
    expect(connections[0].closeCount).toBe(1);
  });

  it('enabled:false：停用中的 server 被停（与删除同语义）', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    const { factory } = fakeFactory(log, { s1: [stubTool('a')] });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(agent, [cfg('s1')], { allowlist: [], connect: factory });
    await applyMcpConfigChange(agent, [{ ...cfg('s1'), enabled: false }], {
      allowlist: [],
      connect: factory,
    });

    expect(names()).toEqual([]);
    expect(log).toContain('close:s1');
  });

  it('allowlist 变更：只重算档位、连接不动（removeTool + registerTool，不重取清单）', async () => {
    const { registrar, names, policyOf } = fakeRegistrar();
    const log: string[] = [];
    const { factory, connections } = fakeFactory(log, { s1: [stubTool('a'), stubTool('b')] });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(agent, [cfg('s1')], { allowlist: [], connect: factory });
    expect(policyOf('mcp__s1__a')).toBe('always');
    expect(policyOf('mcp__s1__b')).toBe('always');

    await applyMcpConfigChange(agent, [cfg('s1')], {
      allowlist: ['mcp__s1__a'],
      connect: factory,
    });

    expect(policyOf('mcp__s1__a')).toBe('audit'); // 命中：免弹窗仍落审计
    expect(policyOf('mcp__s1__b')).toBe('always'); // 未命中：不变
    expect(names()).toEqual(['mcp__s1__a', 'mcp__s1__b']);
    expect(connections).toHaveLength(1);
    expect(connections[0].connectCount).toBe(1); // 连接没动
    expect(connections[0].closeCount).toBe(0);
  });

  it('server 与 allowlist 同时变：重启的带新档位，保留的补重算（各走各的）', async () => {
    const { registrar, policyOf } = fakeRegistrar();
    const log: string[] = [];
    const { factory } = fakeFactory(log, {
      s1: [stubTool('a')],
      s2: [stubTool('c')],
    });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(agent, [cfg('s1'), cfg('s2')], { allowlist: [], connect: factory });
    // s1 保留（配置没变）+ allowlist 变 ⇒ 重算档位；s2 配置变了 ⇒ 先停后起（天然带新档位）
    await applyMcpConfigChange(agent, [cfg('s1'), cfg('s2', 'node2')], {
      allowlist: ['mcp__s1__a', 'mcp__s2__c'],
      connect: factory,
    });

    expect(policyOf('mcp__s1__a')).toBe('audit');
    expect(policyOf('mcp__s2__c')).toBe('audit');
    expect(log.filter((line) => line === 'close:s2')).toEqual(['close:s2']);
    expect(log.filter((line) => line.startsWith('connect-start:s1'))).toHaveLength(1); // s1 未重连
  });

  it('并发热更串行不交错（第二个的分差看到第一个的结果）', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const { factory } = fakeFactory(log, { s1: [], s2: [] }, new Set(['s1']), gate);
    const agent = fakeAgent(registrar);

    // 快照语义：每次热更都是全量配置。模拟用户先加 s1、再在列表里追加 s2
    const first = applyMcpConfigChange(agent, [cfg('s1')], { allowlist: [], connect: factory });
    const second = applyMcpConfigChange(agent, [cfg('s1'), cfg('s2')], {
      allowlist: [],
      connect: factory,
    });
    // 若热更不串行，s2 的 connect 会在 s1 挂起期间就开始
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log).toEqual(['connect-start:s1']);

    releaseGate();
    await Promise.all([first, second]);

    expect(log).toEqual([
      'connect-start:s1',
      'connect-done:s1',
      'connect-start:s2',
      'connect-done:s2',
    ]);
    expect(names()).toEqual([]); // s1/s2 工具清单为空 ⇒ 注册面空但连接已完成
  });

  it('非法/重名配置：跳过并告警，不影响其余 server（与首装同口径）', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    const { logger, warnings } = capturingLogger();
    const { factory, connections } = fakeFactory(log, { s1: [stubTool('a')] });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(
      agent,
      [{ name: '', command: 'node' }, cfg('s1'), cfg('s1', 'node2')],
      { allowlist: [], connect: factory, logger },
    );

    expect(names()).toEqual(['mcp__s1__a']);
    expect(connections).toHaveLength(1); // 重名后者被跳过，只起了一个
    expect(warnings.some((w) => w.includes('跳过非法配置'))).toBe(true);
    expect(warnings.some((w) => w.includes('server 名重复'))).toBe(true);
  });

  it('注册中途撞名：撤掉已注册的前几个（首装路径不留僵尸工具）', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    const { logger, warnings } = capturingLogger();
    // x-1 与 x.1 清洗后同前缀 x_1 ⇒ 工具 c 跨 server 撞名；后者先注册 d 成功、
    // 再注册 c 抛错 ⇒ 无修复时 d 残留（注册着但连接即将关闭，调用只报「连接不可用」）
    const { factory, connections } = fakeFactory(log, {
      'x-1': [stubTool('c')],
      'x.1': [stubTool('d'), stubTool('c')],
    });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(agent, [cfg('x-1'), cfg('x.1')], {
      allowlist: [],
      connect: factory,
      logger,
    });

    expect(names()).toEqual(['mcp__x_1__c']); // 只有赢家的；d 不残留
    expect(connections).toHaveLength(2);
    expect(connections[1].closeCount).toBe(1); // 输家连接被关（响而不静）
    expect(warnings.some((w) => w.includes('接入失败'))).toBe(true);
  });

  it('allowlist 热更后 list_changed 整换：档位按新 allowlist 重算（运行态 allowKeys 须同步）', async () => {
    const { registrar, names, policyOf } = fakeRegistrar();
    const log: string[] = [];
    const { factory, connections } = fakeFactory(log, { s1: [stubTool('a'), stubTool('b')] });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(agent, [cfg('s1')], { allowlist: [], connect: factory });
    await applyMcpConfigChange(agent, [cfg('s1')], {
      allowlist: ['mcp__s1__a'],
      connect: factory,
    });
    expect(policyOf('mcp__s1__a')).toBe('audit'); // 前置：热更已生效

    // server 推 list_changed（工具集未变）⇒ 整换按运行态 allowKeys 重派生
    connections[0].onToolsChanged?.();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(names()).toEqual(['mcp__s1__a', 'mcp__s1__b']);
    expect(policyOf('mcp__s1__a')).toBe('audit'); // 整换不得把档位退回 always
  });

  it('整换期间断线：新集补注销（onClosed 只注销它当时看到的旧集）', async () => {
    const { registrar, names } = fakeRegistrar();
    const log: string[] = [];
    const { factory, connections } = fakeFactory(log, { s1: [stubTool('a')] });
    const agent = fakeAgent(registrar);

    await applyMcpConfigChange(agent, [cfg('s1')], { allowlist: [], connect: factory });
    const conn = connections[0];
    expect(names()).toEqual(['mcp__s1__a']);

    // server 侧工具集变了（a → a+b），但重取被挂住；挂住期间连接断开
    conn.setTools([stubTool('a'), stubTool('b')]);
    let releaseRefresh: () => void = () => {};
    conn.refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    conn.onToolsChanged?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    conn.onClosed?.(); // 断线：注销旧集（a）并从运行态摘除
    releaseRefresh();

    await new Promise((resolve) => setTimeout(resolve, 50));
    // 整换把新集（a+b）注册了进来，但运行态里已无该 server ⇒ 必须补注销，
    // 否则模型可见两个调用死连接的工具（僵尸工具）
    expect(names()).toEqual([]);
  });
});

describe('getMcpServerStatus（设置面板 MCP 选项卡的数据面）', () => {
  it('未启动 = 空数组（「没有 server 在跑」是合法空态，不是错误）', () => {
    expect(getMcpServerStatus([])).toEqual([]);
  });

  it('状态由运行态派生：服务器名、工具数、每工具的键与免确认态', async () => {
    const { registrar } = fakeRegistrar();
    const { factory } = fakeFactory([], { fs: [stubTool('read-file'), stubTool('write_file')] });

    await startMcpServers(fakeAgent(registrar), [cfg('fs')], {
      allowlist: ['mcp__fs__read-file'],
      connect: factory,
    });

    const status = getMcpServerStatus([cfg('fs')]);
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe('fs');
    expect(status[0].toolCount).toBe(2);
    expect(status[0].tools.map((t) => t.derivedName)).toEqual([
      'mcp__fs__read_file',
      'mcp__fs__write_file',
    ]);
    // 键按**原名**寻址（与显示名不同源）——这正是面板要替用户挡掉的坑
    expect(status[0].tools.map((t) => t.allowKey)).toEqual([
      'mcp__fs__read-file',
      'mcp__fs__write_file',
    ]);
    expect(status[0].tools.map((t) => t.allowlisted)).toEqual([true, false]);
  });

  it('热更 allowlist 后状态跟着变（档位真源是运行态，不是配置副本）', async () => {
    const { registrar } = fakeRegistrar();
    const { factory } = fakeFactory([], { fs: [stubTool('read-file')] });
    const agent = fakeAgent(registrar);

    await startMcpServers(agent, [cfg('fs')], { allowlist: [], connect: factory });
    expect(getMcpServerStatus([cfg('fs')])[0].tools[0].allowlisted).toBe(false);

    await applyMcpConfigChange(agent, [cfg('fs')], {
      allowlist: ['mcp__fs__read-file'],
      connect: factory,
    });
    // 面板读到的必须是**生效后**的档位；若这里还是 false，说明状态面与注册面分家了
    expect(getMcpServerStatus([cfg('fs')])[0].tools[0].allowlisted).toBe(true);
  });
});

// ─── 配置即基线（未装配时的「空态」是谎报）───────────────────────────────────
//
// 反例现场：设置视图先于对话面板打开时 Agent 尚未装配 ⇒ 运行态里什么都没有。若列表只按
// 运行态派生，面板会显示「还没有配置任何服务器」；用户照着 CTA 添加一台、拿到「已添加」
// 回执，卡片**仍然不出现**——与「死按钮」同一类伤害（点完没反应），只是成因在数据面：
// 把「未装配」错报成「没配置」。
//
// 判据：**列表基线 = 配置（该有哪些），状态 = 运行态合并（现在怎么样）**。二者混用会在
// 「配置了但还没跑起来」这个最常见的首次使用路径上双双出错（列表空 + 状态假 failed）。
describe('配置即基线的状态合并', () => {
  it('配置里有一台但从未装配 ⇒ 仍列出，state=pending（不是空列表，也不是 failed）', () => {
    const status = getMcpServerStatus([serverConfig('fs')]);
    expect(status).toHaveLength(1);
    expect(status[0]).toMatchObject({ name: 'fs', state: 'pending', enabled: true, toolCount: 0 });
  });

  it('装配失败 ⇒ failed 带原因；同配置里没被拉起的另一台仍是 pending（不连坐）', async () => {
    const { registrar } = fakeRegistrar();
    const { factory: okFactory } = fakeFactory([], { ok: [stubTool('ping')] });
    const bad = failingFactory('boom');
    const connect: McpConnectionFactory = (config) =>
      config.name === 'bad' ? bad(config) : okFactory(config);

    await startMcpServers(fakeAgent(registrar), [serverConfig('bad')], {
      allowlist: [],
      connect,
    });

    const status = getMcpServerStatus([serverConfig('bad'), serverConfig('other')]);
    expect(status.map((item) => [item.name, item.state])).toEqual([
      ['bad', 'failed'],
      ['other', 'pending'],
    ]);
    expect(status[0].error).toContain('boom');
  });

  it('enabled:false 优先于 pending（停用是用户意图，不是「待接入」）', () => {
    const status = getMcpServerStatus([serverConfig('off', { enabled: false })]);
    expect(status[0].state).toBe('disabled');
  });
});

// ─── 状态面（五态合并 / 失败留痕 / 恢复路径 / 变化通知）─────────────────────────
//
// 判据来源：台账缺口 ⑥（观察面只能看见成功）/ ⑦（无恢复路径）/ ②（断线后面板停旧值）。
// 这三条的共同根因是「运行态只有成功那一半」，所以本组用例全部从**失败面**切入。

/**
 * 造一个「连接必失败」的工厂（connect 抛错，close 正常）
 *
 * @param error 抛出文本（断言原样透出到面板）
 */
function failingFactory(error: string): McpConnectionFactory {
  return () =>
    ({
      connect: async () => {
        throw new Error(error);
      },
      close: async () => undefined,
      listTools: () => [],
      refreshTools: async () => [],
      callTool: async () => ({}),
    }) as unknown as McpConnection;
}

/** 一台最小可启动配置 */
function serverConfig(name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig {
  return { name, command: 'node', ...extra };
}

describe('MCP 状态面（五态合并 / 失败留痕 / 恢复路径）', () => {
  afterEach(async () => {
    setMcpStatusListener(null);
    await stopMcpServers();
  });

  it('失败的 server 仍在列表里（state=failed + 错误原文），而不是从列表里消失', async () => {
    // 断链守护：首版 getMcpServerStatus 只读 running ⇒ 这台会被整条抹掉，
    // 用户看到的「没有服务器在跑」其实是「有一台起不来」——最需要排查时页面是空的
    const { registrar } = fakeRegistrar();
    await startMcpServers(fakeAgent(registrar), [serverConfig('github')], {
      allowlist: [],
      connect: failingFactory('spawn github-mcp ENOENT'),
    });

    const status = getMcpServerStatus([serverConfig('github')]);
    expect(status).toHaveLength(1);
    expect(status[0]?.name).toBe('github');
    expect(status[0]?.state).toBe('failed');
    expect(status[0]?.error).toContain('spawn github-mcp ENOENT');
    expect(status[0]?.toolCount).toBe(0);
  });

  it('停用 / 配置不完整各自成态（不再统一当成「没跑起来」）', async () => {
    const { registrar } = fakeRegistrar();
    const configs = [
      serverConfig('off', { enabled: false }),
      // 缺 command：非法配置，启动侧会跳过并告警；面板要能说清「缺什么」
      { name: 'bad' } as unknown as McpServerConfig,
    ];
    await startMcpServers(fakeAgent(registrar), configs, {
      allowlist: [],
      connect: failingFactory('不该被调用'),
    });

    const status = getMcpServerStatus(configs);
    expect(status.map((item) => item.state)).toEqual(['disabled', 'invalid']);
    expect(status[1]?.problem).toBe('缺少 command');
    // 非法/停用都不带 error（原因不同，不能混成一句「失败」）
    expect(status[0]?.error).toBeUndefined();
    expect(status[1]?.error).toBeUndefined();
  });

  it('断线 → failed（不静默消失：面板要能显示「连接已断开」）', async () => {
    const { registrar } = fakeRegistrar();
    const { factory, connections } = fakeFactory([''], { fs: [stubTool('read_file')] });
    await startMcpServers(fakeAgent(registrar), [serverConfig('fs')], {
      allowlist: [],
      connect: factory,
    });
    expect(getMcpServerStatus([serverConfig('fs')])[0]?.state).toBe('running');

    // 模拟子进程退出 / 传输层关闭
    connections[0]!.onClosed?.();

    const status = getMcpServerStatus([serverConfig('fs')]);
    expect(status[0]?.state).toBe('failed');
    expect(status[0]?.error).toContain('连接已断开');
  });

  it('成功启动会清掉失败记录（失败→重启成功不留红点）', async () => {
    const { registrar } = fakeRegistrar();
    await startMcpServers(fakeAgent(registrar), [serverConfig('fs')], {
      allowlist: [],
      connect: failingFactory('第一次失败'),
    });
    expect(getMcpServerStatus([serverConfig('fs')])[0]?.state).toBe('failed');

    // 换成能连上的工厂重新应用配置（等价于重启成功）
    await startMcpServers(fakeAgent(registrar), [serverConfig('fs')], {
      allowlist: [],
      connect: fakeFactory([''], { fs: [stubTool('read_file')] }).factory,
    });

    const status = getMcpServerStatus([serverConfig('fs')])[0];
    expect(status?.state).toBe('running');
    // 互斥不变量：running 态不得同时携带上一次的错误
    expect(status?.error).toBeUndefined();
  });

  it('restartMcpServer：配置没变也能把失败的 server 拉起来（唯一恢复路径）', async () => {
    const { registrar } = fakeRegistrar();
    const agent = fakeAgent(registrar);
    await startMcpServers(agent, [serverConfig('fs')], {
      allowlist: [],
      connect: failingFactory('冷启动失败'),
    });
    expect(getMcpServerStatus([serverConfig('fs')])[0]?.state).toBe('failed');

    // 同一台 server 换连接实现后重启（生产里是 server 侧修好了 / 网络恢复）
    const { factory, connections } = fakeFactory([''], { fs: [stubTool('read_file')] });
    const result = await restartMcpServer(agent, 'fs', { connect: factory });

    expect(result.ok).toBe(true);
    expect(connections[0]?.connectCount).toBe(1);
    expect(getMcpServerStatus([serverConfig('fs')])[0]?.state).toBe('running');
    expect(getMcpServerStatus([serverConfig('fs')])[0]?.toolCount).toBe(1);
  });

  it('restartMcpServer 对未配置的名字给失败回执（不抛异常，面板按回执提示）', async () => {
    const { registrar } = fakeRegistrar();
    const agent = fakeAgent(registrar);
    // 必须注入假连接：缺省工厂会真 spawn（本用例会挂到握手超时）
    await startMcpServers(agent, [serverConfig('fs')], {
      allowlist: [],
      connect: fakeFactory([''], { fs: [stubTool('read_file')] }).factory,
    });

    const result = await restartMcpServer(agent, 'nope');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未找到');
  });

  it('运行态变化会通知监听器（断线/失败不是配置变更 ⇒ 只能靠这条回调驱动回推）', async () => {
    const { registrar } = fakeRegistrar();
    const calls: string[] = [];
    setMcpStatusListener(() => calls.push('push'));

    await startMcpServers(fakeAgent(registrar), [serverConfig('github')], {
      allowlist: [],
      connect: failingFactory('起不来'),
    });
    // 启动失败必须触发回推（否则面板停在「加载中」，用户永远看不到失败）
    expect(calls.length).toBeGreaterThan(0);

    const before = calls.length;
    await stopMcpServers();
    expect(calls.length).toBeGreaterThan(before);
  });

  it('监听器抛错不影响运行时（面板回推失败不该毒化状态机）', async () => {
    const { registrar } = fakeRegistrar();
    setMcpStatusListener(() => {
      throw new Error('webview 已销毁');
    });
    await expect(
      startMcpServers(fakeAgent(registrar), [serverConfig('fs')], {
        allowlist: [],
        connect: fakeFactory([''], { fs: [stubTool('read_file')] }).factory,
      }),
    ).resolves.toBeUndefined();
    expect(getMcpServerStatus([serverConfig('fs')])[0]?.state).toBe('running');
  });
});

// ──────────────────────────────────────────────────────────────
// name 归一化（2026-10-24 实测缺陷）：运行态表的键与状态面的键必须同源。
// 原先写侧用原名、读侧 trim ⇒ `{name:"fs "}` 连接**真建成了**（connectCount=1），
// 状态面却查不到键、判成 failed，还给出一句与事实无关的原因。用户会去排查一台好服务器。
// ──────────────────────────────────────────────────────────────
describe('MCP server 名归一化（键 = 状态面 = 面板寻址）', () => {
  afterEach(async () => {
    setMcpStatusListener(null);
    await stopMcpServers();
  });

  it('name 带尾随空格 ⇒ 连接建立且状态是 running（不是 failed）', async () => {
    const { registrar, names } = fakeRegistrar();
    const configs = [serverConfig('fs ')];
    const { factory, connections } = fakeFactory([''], { fs: [stubTool('read_file')] });

    await startMcpServers(fakeAgent(registrar), configs, { allowlist: [], connect: factory });

    expect(connections).toHaveLength(1);
    expect(connections[0]!.connectCount).toBe(1);
    const status = getMcpServerStatus(configs);
    expect(status).toHaveLength(1);
    // 展示名归一化（面板看到的是 fs，不是带空格的 fs ）
    expect(status[0]!.name).toBe('fs');
    expect(status[0]!.state).toBe('running');
    // 工具确实注册进去了（键错位时这个断言会先红：注册用的也是同一个名）
    expect(names()).toContain('mcp__fs__read_file');
  });

  it('`fs` 与 `fs ` 归一化后重名 ⇒ 只启动一台（不留看不见的幽灵子进程）', async () => {
    const { registrar } = fakeRegistrar();
    const { logger, warnings } = capturingLogger();
    const configs = [serverConfig('fs'), serverConfig('fs ', { command: 'npx' })];
    const started: string[] = [];
    const connect: McpConnectionFactory = (config) => {
      started.push(config.name);
      return new FakeConnection(
        config.name,
        [stubTool('read_file')],
        [],
        undefined,
      ) as unknown as McpConnection;
    };

    await startMcpServers(fakeAgent(registrar), configs, { allowlist: [], connect, logger });

    expect(started).toEqual(['fs']);
    expect(getMcpServerStatus(configs)).toHaveLength(1);
    expect(warnings.join('\n')).toContain('server 名重复');
  });

  it('restart 收归一化名（面板下发的就是它）⇒ 找得到配置并重启成功，且旧连接被关掉', async () => {
    const { registrar } = fakeRegistrar();
    const configs = [serverConfig('fs ')];
    const { factory, connections } = fakeFactory([''], { fs: [stubTool('read_file')] });
    await startMcpServers(fakeAgent(registrar), configs, { allowlist: [], connect: factory });

    // 重启必须注入连接工厂：不传会走真连接（spawn 真 node 等 20s 握手）
    const result = await restartMcpServer(fakeAgent(registrar), 'fs', { connect: factory });
    expect(result).toEqual({ ok: true });
    expect(getMcpServerStatus(configs)[0]!.state).toBe('running');
    // 旧连接必须被关：键错位时 `state.has('fs')` 为假 ⇒ 起新的、旧的还活着 = 僵尸子进程
    // （只断言 ok/state 会漏掉这条——变异验证时实测过）
    expect(connections).toHaveLength(2);
    expect(connections[0]!.closeCount).toBe(1);
  });
});
