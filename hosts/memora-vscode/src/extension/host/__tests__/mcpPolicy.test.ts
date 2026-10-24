/**
 * MCP 审批三档测试 — allowlist 寻址键 / 配置解析 / 档位计算
 *
 * 判据来源：方案-MCP工具接入 §4.3（三档映射）、§9 切片 2（寻址键 = server 原名 +
 * tool 原名；读不到 = fail-closed 落 always）。
 * 纯函数，不碰内核、不拉起子进程。
 */
import { describe, it, expect } from 'vitest';
import {
  allowlistKey,
  parseAllowlist,
  resolveConfirmPolicy,
  serverAllowlistKey,
} from '../mcp/policy.js';

describe('allowlistKey（原名寻址）', () => {
  it('键形为 mcp__<server>__<tool>，按原名拼接', () => {
    expect(allowlistKey('github', 'create_issue')).toBe('mcp__github__create_issue');
  });

  it('原名里的特殊字符不清洗（与派生显示名刻意不同源）', () => {
    // 显示名会被清洗成 mcp__my_server__a_b，但键保留原字符
    expect(allowlistKey('my-server', 'a.b')).toBe('mcp__my-server__a.b');
  });
});

describe('parseAllowlist（fail-closed 解析）', () => {
  it('合法数组 → 去重键集合', () => {
    const keys = parseAllowlist(['mcp__a__x', 'mcp__b__y', 'mcp__a__x']);
    expect([...keys]).toEqual(['mcp__a__x', 'mcp__b__y']);
  });

  it('非数组原值 → 空集（读不到合法值 = 全部逐次确认）', () => {
    for (const raw of [undefined, null, 'mcp__a__x', 42, { 0: 'mcp__a__x' }]) {
      expect([...parseAllowlist(raw)]).toEqual([]);
    }
  });

  it('非字符串项忽略；空串 / 纯空白忽略', () => {
    const keys = parseAllowlist(['mcp__a__x', 42, null, '', '   ', 'mcp__b__y']);
    expect([...keys]).toEqual(['mcp__a__x', 'mcp__b__y']);
  });

  it('条目两侧空白修剪（settings.json 手写常带缩进空格）', () => {
    const keys = parseAllowlist(['  mcp__a__x\t']);
    expect([...keys]).toEqual(['mcp__a__x']);
  });
});

describe('resolveConfirmPolicy（档位计算）', () => {
  it('命中 → audit（过闸自动放行，仍落 write-auto 审计）', () => {
    const allow = new Set([allowlistKey('srv', 'read')]);
    expect(resolveConfirmPolicy('srv', 'read', allow)).toBe('audit');
  });

  it('未命中 → always（默认档：每次调用都弹确认）', () => {
    const allow = new Set([allowlistKey('srv', 'read')]);
    expect(resolveConfirmPolicy('srv', 'write', allow)).toBe('always');
  });

  it('空 allowlist → always（fail-closed）', () => {
    expect(resolveConfirmPolicy('srv', 'read', new Set())).toBe('always');
  });

  it('跨 server 不串门：键含 server 段，别处命中不影响本 server', () => {
    const allow = new Set([allowlistKey('other', 'read')]);
    expect(resolveConfirmPolicy('srv', 'read', allow)).toBe('always');
  });
});

describe('serverAllowlistKey（整台免确认寻址）', () => {
  it('键形为 mcp__<server>__*（工具位通配，与 Claude Code MCP 规则同形）', () => {
    expect(serverAllowlistKey('github')).toBe('mcp__github__*');
  });

  it('只通配工具位：server 位仍是字面量（不提供「一次放行所有 server」的写法）', () => {
    // 反例形态 mcp__* 刻意不生成：新增一台 server 就自动免确认 = 把逐台判断退化成全局开关
    expect(serverAllowlistKey('*')).toBe('mcp__*__*');
    expect(serverAllowlistKey('*')).not.toBe('mcp__*');
  });

  it('server 原名不清洗（与工具级键同纪律）', () => {
    expect(serverAllowlistKey('my-server')).toBe('mcp__my-server__*');
  });
});

describe('resolveConfirmPolicy（server 级命中）', () => {
  it('整台命中 ⇒ 该台全部工具 audit（未单独勾选的也免确认）', () => {
    const allow = new Set([serverAllowlistKey('srv')]);
    expect(resolveConfirmPolicy('srv', 'read', allow)).toBe('audit');
    expect(resolveConfirmPolicy('srv', 'write', allow)).toBe('audit');
    // 后加的工具也覆盖：键是通配段匹配，不依赖注册时的工具清单
    expect(resolveConfirmPolicy('srv', 'brand_new_tool', allow)).toBe('audit');
  });

  it('整台命中不串门：别的 server 仍是 always', () => {
    const allow = new Set([serverAllowlistKey('srv')]);
    expect(resolveConfirmPolicy('other', 'read', allow)).toBe('always');
  });

  it('工具级与 server 级任一条命中即 audit（两级共用同一张 allowlist，无第二档策略）', () => {
    const allow = new Set([allowlistKey('a', 'x'), serverAllowlistKey('b')]);
    expect(resolveConfirmPolicy('a', 'x', allow)).toBe('audit');
    expect(resolveConfirmPolicy('a', 'y', allow)).toBe('always');
    expect(resolveConfirmPolicy('b', 'any', allow)).toBe('audit');
  });

  it('工具原名恰为 * 时与 server 级键同形：语义同为免确认，撞形不越权', () => {
    const allow = new Set([allowlistKey('srv', '*')]);
    expect(allowlistKey('srv', '*')).toBe(serverAllowlistKey('srv'));
    expect(resolveConfirmPolicy('srv', '*', allow)).toBe('audit');
  });
});
