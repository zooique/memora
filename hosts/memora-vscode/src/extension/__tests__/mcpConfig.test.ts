/**
 * MCP 配置读取点（`readMcpServers` / `readMcpToolAllowlist`）的形态收窄
 *
 * 为什么必须守：这两个函数是**唯一读取点**，消费方有三个（装配、配置热更、设置面板状态
 * 推送）。收窄若放错地方，症状是「装配侧拦住了、面板侧没拦住」——用户把一个合法 JSON
 * 但形状不对的值（把 `mcpServers` 写成对象）存进去，设置页会卡在「加载中…」，且只在
 * 真机表现（2026-10-24 全量跑批两条红即此：`configured is not iterable`）。
 *
 * 断言口径 = 返回值形态，不是实现细节：任何非法输入都必须收敛成空数组/空集，不抛。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** 可编程的配置读面（每例只改 `value`） */
const state: { value: unknown } = { value: undefined };

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      // 模拟 VS Code 的 get(key, fallback)：键未设置时给 fallback，设置了就原样返回
      get: (_key: string, fallback: unknown) =>
        state.value === undefined ? fallback : state.value,
    }),
  },
}));

const { readMcpServers, readMcpToolAllowlist } = await import('../mcpConfig.js');

describe('readMcpServers（配置数组的形态收窄）', () => {
  beforeEach(() => {
    state.value = undefined;
  });

  it('缺省（undefined）⇒ 空数组（本函数不抛）', () => {
    expect(readMcpServers()).toEqual([]);
  });

  it('非数组（用户把对象写成值）⇒ 空数组，不抛', () => {
    state.value = { name: 'fs', command: 'npx' };
    expect(readMcpServers()).toEqual([]);
  });

  it('数组原样返回（含本仓不认识的字段，读取点不做字段裁剪）', () => {
    const value = [{ name: 'fs', command: 'npx', futureField: 1 }];
    state.value = value;
    expect(readMcpServers()).toEqual(value);
  });
});

describe('readMcpToolAllowlist（同一收窄口径）', () => {
  beforeEach(() => {
    state.value = undefined;
  });

  it('缺省 / 非数组 ⇒ 空数组（空集 ⇒ 全部每次确认，fail-closed 方向不变）', () => {
    expect(readMcpToolAllowlist()).toEqual([]);
    state.value = 'mcp__fs__read_file';
    expect(readMcpToolAllowlist()).toEqual([]);
  });

  it('数组原样返回', () => {
    state.value = ['mcp__fs__read_file'];
    expect(readMcpToolAllowlist()).toEqual(['mcp__fs__read_file']);
  });
});
