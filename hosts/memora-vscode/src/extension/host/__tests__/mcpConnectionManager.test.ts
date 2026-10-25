/**
 * MCP 连接管理器测试 — 分页拉全 + 真实 stdio 连接 + 调用转发（含超时）+ 注销
 *
 * 判据来源：方案-MCP工具接入 §7 P1/P4、§9 切片 1（分页超一页要全注册 / 停用后工具消失）、
 * §9 切片 3a（调用转发超时 / 分页收口可观测）。
 * 纯分页逻辑用注入页函数测；端到端用 fixtures/fakeMcpServer.mjs 子进程测（真握手、真调用）。
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolDefinition, ToolHandler } from '@zooique/memora';
import type { McpTransport } from '../../../shared/protocol.js';
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
    const collected = await collectAllTools(async (cursor) => {
      const page = pages[cursor ?? ''];
      if (!page) throw new Error(`未定义的 cursor：${String(cursor)}`);
      return page;
    });
    expect(collected.tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(collected.stopped).toBeNull();
  });

  it('server 返回重复 cursor 时收口并报告原因，不死循环', async () => {
    let calls = 0;
    const collected = await collectAllTools(async () => {
      calls += 1;
      return { tools: [stubTool(`p${calls}`)], nextCursor: 'same' };
    });
    // 第一页后 cursor='same'，第二页再次返回 'same' → 命中去重即停
    expect(calls).toBe(2);
    expect(collected.tools).toHaveLength(2);
    expect(collected.stopped).toEqual({ reason: 'duplicate-cursor', pages: 2 });
  });

  it('撞页数上限时收口并报告原因（无限分页不得死循环）', async () => {
    let calls = 0;
    const collected = await collectAllTools(async () => {
      calls += 1;
      return { tools: [stubTool(`p${calls}`)], nextCursor: `c${calls}` };
    });
    expect(calls).toBe(50);
    expect(collected.tools).toHaveLength(50);
    expect(collected.stopped).toEqual({ reason: 'page-limit', pages: 50 });
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
      // 4 个工具分 2 页，全部拿到才说明分页循环正确
      expect(tools.map((t) => t.name)).toEqual([
        'echo-text',
        'with-enum',
        'always-fails',
        'never-responds',
      ]);

      // 四个都可映射（顶层任何不可映射形态由 toolRegistry 单测覆盖）；
      // allowlist 传空集 = 全部逐次确认（本测试不关心审批档位）
      const { bindings, skipped } = buildToolBindings('fake', tools, new Set<string>());
      expect(bindings.map((b) => b.derivedName)).toEqual([
        'mcp__fake__echo_text',
        'mcp__fake__with_enum',
        'mcp__fake__always_fails',
        'mcp__fake__never_responds',
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
      expect(definitions.size).toBe(4);

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

  it('调用转发有超时兜底且不断连接：server 永不响应不得挂死 agent turn，超时后其余工具照常可调', async () => {
    const connection = new McpConnection({
      name: 'fake',
      command: process.execPath,
      args: [FIXTURE_SERVER],
    });

    try {
      await connection.connect();
      // 第三参仅测试传小值（生产走缺省 60s，见 connectionManager.TOOL_CALL_TIMEOUT_MS）；
      // 内核 custom 分支无超时包裹，这一层是唯一兜底
      await expect(connection.callTool('never-responds', {}, 80)).rejects.toThrow(/超时/);
      // 超时只失败本次调用：server 卡一个请求不应顺带杀掉连接（否则一次卡死 = 整台
      // server 的工具全废）。JSON-RPC over stdio 按 id 匹配，挂起请求不阻塞后续请求。
      // 注意断言口径：callTool 回的是**原始 MCP 结果对象**（归一化是 toolRegistry
      // handler 的事，见 registerServerTools → normalizeToolResult）
      const after = await connection.callTool('echo-text', { message: 'after-timeout' });
      expect(after).toEqual({
        content: [{ type: 'text', text: 'echo:echo-text:{"message":"after-timeout"}' }],
      });
    } finally {
      await connection.close();
    }
  }, 30_000);

  it('list_changed 通知触发 onToolsChanged，refreshTools 拿到新清单（P2 整换同步的地基）', async () => {
    const connection = new McpConnection({
      name: 'fake',
      command: process.execPath,
      args: [FIXTURE_SERVER],
    });

    try {
      await connection.connect();
      let notified = 0;
      connection.onToolsChanged = () => {
        notified += 1;
      };
      // 调 unlock-extra：server 翻转工具集并推 notifications/tools/list_changed
      await connection.callTool('unlock-extra', {});
      // 通知经子进程 → stdio → 宿主是异步的，轮询等它到达（有界，防挂死）
      const deadline = Date.now() + 5_000;
      while (notified === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(notified).toBeGreaterThan(0);

      // 重取：新工具进清单（且分页从 2 页变 3 页，拉全链路重跑）
      const fresh = await connection.refreshTools();
      expect(fresh.map((t) => t.name)).toEqual([
        'echo-text',
        'with-enum',
        'always-fails',
        'never-responds',
        'extra-tool',
      ]);
      // 缓存同步：listTools() 与重取结果一致（调用方不耦合内部字段）
      expect(connection.listTools().map((t) => t.name)).toEqual(fresh.map((t) => t.name));
    } finally {
      await connection.close();
    }
  }, 30_000);

  it('未声明 listChanged 能力的 server 不订阅（协议上不会发，订了空转）', async () => {
    const connection = new McpConnection({
      name: 'fake',
      command: process.execPath,
      args: [FIXTURE_SERVER],
      env: { FAKE_MCP_NO_LIST_CHANGED: '1' },
    });

    try {
      await connection.connect();
      let notified = 0;
      connection.onToolsChanged = () => {
        notified += 1;
      };
      await connection.callTool('unlock-extra', {});
      // 给通知留出到达时间（上面的用例已证明能到）；不到即证明确实没订阅
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(notified).toBe(0);
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

// ──────────────────────────────────────────────────────────────
// 拉起前预检 + 失败原因可读（2026-10-24）
//
// 现场问题：命令/路径写错时 SDK 只抛 `MCP error -32000: Connection closed`，
// 真原因只在子进程 stderr（中文 Windows 下还是 GBK）⇒ 面板上等于没有原因。
// 这组用例钉住两件事：① 静态能判的不必等 SDK 压成 -32000；② 必须等运行时的失败，
// 也要把 stderr 尾部带到用户面前。
// ──────────────────────────────────────────────────────────────
describe('拉起前预检与失败原因可读', () => {
  it('命令路径不存在 ⇒ 抛人话（不 spawn、不落到 -32000）', async () => {
    const connection = new McpConnection({
      name: 'ghost',
      command: join(tmpdir(), 'memora-no-such-binary-xyz'),
    });
    await expect(connection.connect()).rejects.toThrow('配置无法启动');
    await expect(connection.connect()).rejects.toThrow('找不到可执行文件');
  }, 30_000);

  it('脚本文件被当成命令 ⇒ 提示改填 node（最高频的配错形态）', async () => {
    const connection = new McpConnection({ name: 'as-command', command: FIXTURE_SERVER });
    await expect(connection.connect()).rejects.toThrow('脚本文件');
  }, 30_000);

  it('server 启动即崩 ⇒ 失败原因里带上它的 stderr 原文（而不是只有 Connection closed）', async () => {
    const boomDir = mkdtempSync(join(tmpdir(), 'memora-boom-'));
    const boom = join(boomDir, 'boom.mjs');
    writeFileSync(boom, "console.error('boom-from-server-stderr');\nprocess.exit(3);\n", 'utf8');
    const connection = new McpConnection({
      name: 'boom',
      command: process.execPath,
      args: [boom],
    });
    // then 双分支显式收窄：connect 成功时返回工具数组，失败时拿到 Error
    const error = await connection.connect().then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error, '应拒绝连接').not.toBeNull();
    expect(error?.message).toContain('boom-from-server-stderr');
    rmSync(boomDir, { recursive: true, force: true });
  }, 30_000);
});

// ──────────────────────────────────────────────────────────────
// 传输分派（S1，假 transport 工厂）
//
// 判据来源：`docs/方案-MCP远程HTTP接入-20261025.md` §5.2 / §6 R6。
// 为什么必须测分派而不是真连远端：① 单测里没有可用的远程服务器；② 真网络会把超时、
// DNS、证书噪声带进断言。假工厂只回答一个问题——`transport` 字段最终选中的是哪条物理通道，
// 握手之后的链路（能力断言 / 分页 / 订阅）两形态共用，故不重复测。
// ──────────────────────────────────────────────────────────────
describe('传输分派（假 transport 工厂）', () => {
  /**
   * 造一个「一开始就失败」的假传输
   *
   * `Protocol.connect` 只做一件事：`await transport.start()`，因此 start 拒绝即可模拟
   * 连接失败，且不必伪造 JSON-RPC 帧。断言目标只有「分派到哪个形态」与「失败文案」。
   *
   * @param error start 时抛出的错误（401 场景传带 code 的对象）
   */
  function failingTransport(error: unknown): Transport {
    return {
      start: async () => {
        throw error;
      },
      send: async () => {},
      close: async () => {},
    } as unknown as Transport;
  }

  /** 记录工厂收到的形态（用于断言判据走向） */
  function modesRecorder(seen: McpTransport[]) {
    return (mode: McpTransport): Transport => {
      seen.push(mode);
      return failingTransport(new Error(`假装 ${mode} 连接失败`));
    };
  }

  it('transport: http ⇒ 工厂收到 http（不再走 stdio 分支）', async () => {
    const seen: McpTransport[] = [];
    const connection = new McpConnection(
      { name: 'r', transport: 'http', url: 'https://x/mcp' },
      undefined,
      '0.0.0',
      undefined,
      modesRecorder(seen),
    );
    await expect(connection.connect()).rejects.toThrow('假装 http 连接失败');
    expect(seen).toEqual(['http']);
  });

  it('缺省 transport ⇒ stdio（老配置零迁移）', async () => {
    const seen: McpTransport[] = [];
    const connection = new McpConnection(
      { name: 's', command: process.execPath },
      undefined,
      '0.0.0',
      undefined,
      modesRecorder(seen),
    );
    await expect(connection.connect()).rejects.toThrow('假装 stdio 连接失败');
    expect(seen).toEqual(['stdio']);
  });

  it('HTTP 401 ⇒ 文案归「服务器要求授权」，不退化成通用 HTTP 报错', async () => {
    const connection = new McpConnection(
      { name: 'auth', transport: 'http', url: 'https://x/mcp' },
      undefined,
      '0.0.0',
      undefined,
      () => failingTransport(Object.assign(new Error('POSTing to endpoint failed'), { code: 401 })),
    );
    await expect(connection.connect()).rejects.toThrow('服务器要求授权');
    await expect(connection.connect()).rejects.toThrow('OAuth');
  });

  it('HTTP 其它失败 ⇒ 原因原样透出，且**不**拼子进程 stderr 后缀（远程没有子进程）', async () => {
    const connection = new McpConnection(
      { name: 'down', transport: 'http', url: 'https://x/mcp' },
      undefined,
      '0.0.0',
      undefined,
      () => failingTransport(new Error('ECONNREFUSED')),
    );
    const error = await connection.connect().then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error?.message).toBe('ECONNREFUSED');
    expect(error?.message).not.toContain('子进程输出');
  });

  it('未知 transport ⇒ 直接拒连并点名（不可达状态也要有话说）', async () => {
    const seen: McpTransport[] = [];
    const connection = new McpConnection(
      { name: 'weird', command: 'node', transport: 'sse' as never },
      undefined,
      '0.0.0',
      undefined,
      modesRecorder(seen),
    );
    await expect(connection.connect()).rejects.toThrow('未知的 transport 值');
    // 判据在创建传输之前，工厂不应被调用（否则会按缺省形态误连）
    expect(seen).toEqual([]);
  });
});
