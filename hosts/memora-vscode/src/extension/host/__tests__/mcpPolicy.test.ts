/**
 * MCP 审批三档测试 — allowlist 寻址键 / 配置解析 / 档位计算
 *
 * 判据来源：方案-MCP工具接入 §4.3（三档映射）、§9 切片 2（寻址键 = server 原名 +
 * tool 原名；读不到 = fail-closed 落 always）。
 * 纯函数，不碰内核、不拉起子进程。
 */
import { describe, it, expect } from 'vitest';
import { allowlistKey, parseAllowlist, resolveConfirmPolicy } from '../mcp/policy.js';

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
