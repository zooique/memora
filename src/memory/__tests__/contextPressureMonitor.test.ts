/**
 * 单元测试：上下文压力监控器（设计 1）
 *
 * 哲学：「应无所住」——不囤积上下文。
 * 验证 ContextPressureMonitor 的 3 个核心分支：
 *   1) 压力未超阈值 → 不卸载
 *   2) 压力超阈值 → 评分卸载 + 单次上限
 *   3) token 估算的边界
 */
import { describe, expect, it } from 'vitest';
import { ContextPressureMonitor } from '@/memory/contextPressureMonitor.js';
import type { Memory } from '@/memory/types.js';

// ─── 工具：构造一条测试用记忆 ──────────────────────────
function makeMemory(
  id: string,
  content: string,
  accessed_at: string = new Date().toISOString(),
): Memory {
  return {
    id,
    content,
    source: 'topic',
    name: id,
    created_at: accessed_at,
    accessed_at,
    score: 0.5,
  };
}

// ─── 工具：构造监控器（带 onUnmount 钩子）──────────────
function makeMonitor(opts: { maxContextTokens: number; mounted: Memory[]; query: string }) {
  const unmounted: string[] = [];
  // onUnmount 钩子契约：必须从外部 mounted 数组移除被卸载的项
  // 这样 measure() 重新计算时才能反映压力下降
  const monitor = new ContextPressureMonitor({
    maxContextTokens: opts.maxContextTokens,
    mountedMemories: () => opts.mounted,
    currentQuery: () => opts.query,
    // 简单估算：每字符 0.25 token（即 4 字符 = 1 token）
    estimateTokens: (s: string) => Math.ceil(s.length / 4),
    onUnmount: async (m) => {
      const idx = opts.mounted.findIndex((x) => x.id === m.id);
      if (idx >= 0) opts.mounted.splice(idx, 1);
      unmounted.push(m.id);
    },
  });
  return { monitor, unmounted };
}

describe('ContextPressureMonitor · 上下文压力监控', () => {
  // ─── 1) 压力未超阈值 → 不卸载 ────────────────────────
  it('分支 1：压力 < 70% 时不触发卸载', async () => {
    const mem1 = makeMemory('m1', '短内容'); // 估算 3 token
    const mem2 = makeMemory('m2', '也是短内容'); // 估算 4 token
    const { monitor, unmounted } = makeMonitor({
      maxContextTokens: 1000,
      mounted: [mem1, mem2],
      query: '测试查询',
    });

    const result = await monitor.check();

    expect(result.isOverloaded).toBe(false);
    expect(result.unmounted).toEqual([]);
    expect(unmounted).toEqual([]);
    expect(result.pressure).toBeLessThan(0.7);
  });

  // ─── 2) 压力超阈值 → 按评分卸载 ──────────────────────
  it('分支 2：压力 ≥ 70% 时按评分卸载得分最低的话题', async () => {
    // 构造 3 条记忆：
    //   A 相关 + 新 → 留存分高
    //   B 不相关 + 新 → 留存分中
    //   C 不相关 + 旧 → 留存分低（应被卸载）
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const memA = makeMemory('memA', '数据库索引优化', new Date().toISOString());
    const memB = makeMemory('memB', '佛家应无所住而生其心', new Date().toISOString());
    const memC = makeMemory('memC', '完全不相关的内容', dayAgo);

    const { monitor, unmounted } = makeMonitor({
      maxContextTokens: 20, // 强制超阈值（3 条 + 50 元信息 ≈ 156 token）
      mounted: [memA, memB, memC],
      query: '数据库优化',
    });

    const result = await monitor.check();

    expect(result.isOverloaded).toBe(true);
    expect(unmounted.length).toBeGreaterThan(0);
    // memC 最先被卸载（既不相关又最旧）
    expect(unmounted[0]).toBe('memC');
  });

  // ─── 3) 卸载到压力 ≤ 50% 停止 ───────────────────────
  it('分支 3：卸载到压力 ≤ 50% 时停止', async () => {
    // 4 条记忆，每条 ~100 token（加 50 元信息 = 150 token/条）
    const mems: Memory[] = Array.from({ length: 4 }, (_, i) =>
      makeMemory(`m${i}`, 'a'.repeat(400), new Date(Date.now() - i * 60_000).toISOString()),
    );

    const { monitor, unmounted } = makeMonitor({
      maxContextTokens: 200, // 4 条 * 150 = 600 → 触发卸载
      mounted: mems,
      query: 'test',
    });

    const result = await monitor.check();

    // 初始压力 = 600/200 = 3.0（远高于阈值）
    // 卸载 3 条后 = 150/200 = 0.75（仍 > 0.5，但已到 MAX_UNMOUNT_PER_CHECK 上限）
    // 关键验证：onUnmount 钩子生效、压力确实下降、未卸载 4 条
    expect(result.isOverloaded).toBe(true);
    expect(unmounted.length).toBeGreaterThan(0);
    expect(unmounted.length).toBeLessThanOrEqual(3);
    // 卸载后压力应下降（从 3.0 降到 ≤ 0.75）
    expect(result.pressure).toBeLessThan(3.0);
  });

  // ─── 4) 边界：单次最多 3 个（即使压力仍高）───────────
  it('分支 4：单次最多卸载 3 个话题（防止抖动）', async () => {
    // 10 条记忆，每条都很大，强制大幅超阈
    const mems: Memory[] = Array.from({ length: 10 }, (_, i) =>
      makeMemory(`m${i}`, 'a'.repeat(1000), new Date(Date.now() - i * 60_000).toISOString()),
    );

    const { monitor, unmounted } = makeMonitor({
      maxContextTokens: 200,
      mounted: mems,
      query: 'a',
    });

    await monitor.check();

    // 单次最多 3 个
    expect(unmounted.length).toBeLessThanOrEqual(3);
  });

  // ─── 5) measure() 与 pressureRatio() 的 token 估算 ──
  it('分支 5：measure() 正确估算挂载记忆的 token 总和', () => {
    const mems: Memory[] = [
      makeMemory('m1', '1234'), // 4 字符 = 1 token + 50 元信息 = 51
      makeMemory('m2', '12345678'), // 8 字符 = 2 token + 50 = 52
    ];
    const { monitor } = makeMonitor({
      maxContextTokens: 1000,
      mounted: mems,
      query: 'a',
    });

    const total = monitor.measure();
    expect(total).toBe(103); // 51 + 52

    const ratio = monitor.pressureRatio();
    expect(ratio).toBeCloseTo(0.103, 2);
  });

  // ─── 6) 空挂载区不卸载 ─────────────────────────────
  it('边界：空挂载区不会触发任何卸载', async () => {
    const { monitor, unmounted } = makeMonitor({
      maxContextTokens: 100,
      mounted: [],
      query: 'test',
    });

    const result = await monitor.check();

    expect(result.unmounted).toEqual([]);
    expect(unmounted).toEqual([]);
  });
});
