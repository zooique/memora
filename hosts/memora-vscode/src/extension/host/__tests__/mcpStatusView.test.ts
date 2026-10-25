/**
 * MCP 状态派生测试 — 免确认两级（工具级 / server 级）的可观测面
 *
 * 判据来源：`mcp/statusView.ts` 的 `deriveMcpServerStatus`（配置 + 运行态 → 面板 DTO）。
 * 本文件钉的是**派生关系**，不是注册表行为：allowlist 怎么被解析是 policy 的事，
 * 这里只保证「面板看到的勾选态」=「实际会不会弹窗」这一条不漂移。
 *
 * 纯函数，不碰内核、不拉起子进程。
 */
import { describe, it, expect } from 'vitest';
import type { ToolDefinition } from '@zooique/memora';
import { deriveMcpServerStatus, type McpStatusContext } from '../mcp/statusView.js';
import { allowlistKey, serverAllowlistKey } from '../mcp/policy.js';

/** 一条工具绑定（派生只消费两个名字，definition 与本文件无关，给最小合法值） */
function binding(name: string) {
  return {
    derivedName: name,
    originalName: name,
    definition: {} as ToolDefinition,
  };
}

/** 构造运行态上下文：只有 running / applied / failureOf 三件事 */
function ctx(entries: Record<string, { tools: string[]; allow: string[] }>): McpStatusContext {
  const running = new Map(
    Object.entries(entries).map(([name, v]) => [
      name,
      { bindings: v.tools.map(binding), allowKeys: new Set(v.allow) },
    ]),
  );
  return {
    running,
    applied: Object.keys(entries).map((name) => ({ name, command: 'node' })),
    failureOf: () => undefined,
  };
}

describe('派生：serverAllowKey 由 policy 现算下发', () => {
  it('键形 = mcp__<server>__*（面板不得自行拼串）', () => {
    const snap = deriveMcpServerStatus(
      [{ name: 'fs', command: 'node' }],
      ctx({ fs: { tools: [], allow: [] } }),
    );
    expect(snap.servers[0]?.serverAllowKey).toBe('mcp__fs__*');
    expect(snap.servers[0]?.serverAllowKey).toBe(serverAllowlistKey('fs'));
  });
});

describe('派生：工具级命中', () => {
  it('只勾单个工具 ⇒ 该工具 true、serverAllowlisted false', () => {
    const snap = deriveMcpServerStatus(
      [{ name: 'fs', command: 'node' }],
      ctx({ fs: { tools: ['read', 'write'], allow: [allowlistKey('fs', 'read')] } }),
    );
    const server = snap.servers[0]!;
    expect(server.serverAllowlisted).toBe(false);
    expect(server.tools.map((t) => t.allowlisted)).toEqual([true, false]);
  });
});

describe('派生：server 级命中（整台免确认）', () => {
  it('整台命中 ⇒ 全部工具生效态 true（含未单独勾选的）+ serverAllowlisted true', () => {
    const snap = deriveMcpServerStatus(
      [{ name: 'fs', command: 'node' }],
      ctx({ fs: { tools: ['read', 'write'], allow: [serverAllowlistKey('fs')] } }),
    );
    const server = snap.servers[0]!;
    expect(server.serverAllowlisted).toBe(true);
    // 关键：未单独勾选的 write 也是 true——面板显示"未勾"却实际不弹窗 = UI 说谎
    expect(server.tools.map((t) => t.allowlisted)).toEqual([true, true]);
  });

  it('整台命中不串门：别的 server 仍是 false', () => {
    const snap = deriveMcpServerStatus(
      [
        { name: 'fs', command: 'node' },
        { name: 'gh', command: 'node' },
      ],
      ctx({
        fs: { tools: ['read'], allow: [serverAllowlistKey('fs')] },
        gh: { tools: ['read'], allow: [] },
      }),
    );
    expect(snap.servers[0]?.serverAllowlisted).toBe(true);
    expect(snap.servers[1]?.serverAllowlisted).toBe(false);
    expect(snap.servers[1]?.tools[0]?.allowlisted).toBe(false);
  });
});

describe('派生：非 running 态', () => {
  it('无运行态 ⇒ 工具明细为空、serverAllowlisted false，但键仍下发', () => {
    const snap = deriveMcpServerStatus([{ name: 'fs', command: 'node' }], {
      running: null,
      applied: [],
      failureOf: () => undefined,
    });
    const server = snap.servers[0]!;
    expect(server.state).toBe('pending');
    expect(server.tools).toEqual([]);
    expect(server.serverAllowlisted).toBe(false);
    expect(server.serverAllowKey).toBe('mcp__fs__*');
  });
});

/**
 * 远程形态的下发面（S1）
 *
 * 判据来源：`docs/方案-MCP远程HTTP接入-20261025.md` §5.1.1 / §6 R6。
 * 两条不变量：① 远程卡片必须拿到 `transport` + `url` 才画得出「远程」标记与副标题；
 * ② **headers 绝不进 DTO**——它是用户手填的凭据面，推进 webview 等于把明文令牌塞进消息通道。
 * 显式挑字段（而不是展开 config）就是为了让新增字段默认不泄露，这里钉住该默认。
 */
describe('派生：远程形态下发面（transport / url 下发，headers 不下发）', () => {
  it('http 配置 ⇒ 下发 transport + url，不下发 headers，也没有 command', () => {
    const snap = deriveMcpServerStatus(
      [
        {
          name: 'remote',
          transport: 'http',
          url: 'https://x/mcp',
          headers: { Authorization: 'Bearer secret' },
        },
      ],
      { running: null, applied: [], failureOf: () => undefined },
    );
    const server = snap.servers[0]!;
    expect(server.transport).toBe('http');
    expect(server.url).toBe('https://x/mcp');
    expect(server.command).toBeUndefined();
    // 凭据面不得进消息通道（明文令牌）
    expect('headers' in server).toBe(false);
  });

  it('stdio 配置 ⇒ 不下发 transport / url（缺省形态不打扰既有渲染）', () => {
    const snap = deriveMcpServerStatus([{ name: 'fs', command: 'node' }], {
      running: null,
      applied: [],
      failureOf: () => undefined,
    });
    const server = snap.servers[0]!;
    expect(server.transport).toBeUndefined();
    expect(server.url).toBeUndefined();
    expect(server.command).toBe('node');
  });

  it('易错形态（stdio 却填了 url）仍按 configProblem 判 invalid 并给原因', () => {
    const snap = deriveMcpServerStatus([{ name: 'bad', command: 'node', url: 'https://x/mcp' }], {
      running: null,
      applied: [],
      failureOf: () => undefined,
    });
    const server = snap.servers[0]!;
    expect(server.state).toBe('invalid');
    expect(server.problem).toContain('stdio 配置不能填写 url');
  });
});
