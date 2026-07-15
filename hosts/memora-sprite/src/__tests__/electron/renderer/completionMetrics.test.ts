/**
 * 补全统计埋点模块测试
 *
 * 覆盖范围：
 * - recordShown / recordAdoption：事件记录
 * - getAggregated：聚合计算（采纳率/Top-1 命中率/平均位置）
 * - LRU 淘汰：超 500 条时从头淘汰
 * - localStorage 持久化：写入 + 读取 + JSON 损坏降级
 * - clear：清空数据
 * - simpleHash：hash 工具基本验证
 *
 * Mock 策略：
 * - localStorage：JSDOM 环境提供真实 localStorage（每个测试 beforeEach 清空）
 * - 单例：每个测试手动 new CompletionMetrics() 避免单例污染（或用 clear 重置）
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { CompletionMetrics } from '../../../electron/renderer/helpers/completionMetrics.js';
import { simpleHash } from '../../../electron/renderer/helpers/hashUtils.js';

describe('补全统计埋点', () => {
  let metrics: CompletionMetrics;

  beforeEach(() => {
    // 清空 localStorage，避免跨测试污染
    localStorage.clear();
    // 每个测试新建实例（绕过单例，直接测试类）
    metrics = new CompletionMetrics();
  });

  // ─── simpleHash 工具 ───────────────────────────────────

  describe('simpleHash', () => {
    it('相同文本应返回相同 hash', () => {
      const hash1 = simpleHash('hello world');
      const hash2 = simpleHash('hello world');
      expect(hash1).toBe(hash2);
    });

    it('不同文本应返回不同 hash', () => {
      const hash1 = simpleHash('hello');
      const hash2 = simpleHash('world');
      expect(hash1).not.toBe(hash2);
    });

    it('应返回 8 字符十六进制字符串', () => {
      const hash = simpleHash('test');
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('空字符串应返回有效 hash（不报错）', () => {
      const hash = simpleHash('');
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });
  });

  // ─── 事件记录 ─────────────────────────────────────────

  describe('recordShown / recordAdoption', () => {
    it('recordShown 应记录展示事件', () => {
      metrics.recordShown('query', 5, 10);
      const events = metrics.getRecentEvents(10);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('shown');
    });

    it('recordAdoption 应记录采纳事件', () => {
      metrics.recordAdoption('query', 'adopted text', 0);
      const events = metrics.getRecentEvents(10);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('adopted');
    });

    it('展示事件应记录 queryLen + queryHash（不记原文）', () => {
      metrics.recordShown('hello', 3, 5);
      const events = metrics.getRecentEvents(10);
      const event = events[0] as { type: string; queryLen: number; queryHash: string };
      expect(event.queryLen).toBe(5);
      expect(event.queryHash).toBe(simpleHash('hello'));
      // 不应包含原文
      expect(JSON.stringify(event)).not.toContain('hello');
    });

    it('采纳事件应记录 adoptedPosition + adoptedTextHash（不记原文）', () => {
      metrics.recordAdoption('query', 'secret text', 2);
      const events = metrics.getRecentEvents(10);
      const event = events[0] as { type: string; adoptedPosition: number; adoptedTextHash: string };
      expect(event.adoptedPosition).toBe(2);
      expect(event.adoptedTextHash).toBe(simpleHash('secret text'));
      // 不应包含原文
      expect(JSON.stringify(event)).not.toContain('secret text');
    });
  });

  // ─── 聚合计算 ─────────────────────────────────────────

  describe('getAggregated', () => {
    it('无事件时应返回零值聚合', () => {
      const agg = metrics.getAggregated();
      expect(agg.totalShown).toBe(0);
      expect(agg.totalAdopted).toBe(0);
      expect(agg.adoptionRate).toBe(0);
      expect(agg.top1HitRate).toBe(0);
      expect(agg.avgAdoptedPosition).toBe(0);
    });

    it('应正确计算采纳率（totalAdopted / totalShown）', () => {
      metrics.recordShown('q1', 5, 5);
      metrics.recordShown('q2', 3, 3);
      metrics.recordAdoption('q1', 'text', 0);
      const agg = metrics.getAggregated();
      expect(agg.totalShown).toBe(2);
      expect(agg.totalAdopted).toBe(1);
      expect(agg.adoptionRate).toBe(0.5);
    });

    it('应正确计算 Top-1 命中率（position=0 的采纳数 / totalAdopted）', () => {
      metrics.recordAdoption('q1', 't1', 0); // Top-1
      metrics.recordAdoption('q2', 't2', 1); // 非 Top-1
      metrics.recordAdoption('q3', 't3', 0); // Top-1
      const agg = metrics.getAggregated();
      expect(agg.totalAdopted).toBe(3);
      expect(agg.top1HitRate).toBeCloseTo(2 / 3, 5);
    });

    it('应正确计算平均采纳位置', () => {
      metrics.recordAdoption('q1', 't1', 0);
      metrics.recordAdoption('q2', 't2', 2);
      metrics.recordAdoption('q3', 't3', 4);
      const agg = metrics.getAggregated();
      // (0 + 2 + 4) / 3 = 2
      expect(agg.avgAdoptedPosition).toBeCloseTo(2, 5);
    });
  });

  // ─── LRU 淘汰 ─────────────────────────────────────────

  describe('LRU 淘汰', () => {
    it('超过 500 条时应从头淘汰最老事件', () => {
      // 写入 502 条事件
      for (let i = 0; i < 502; i++) {
        metrics.recordShown(`query${i}`, 1, 1);
      }
      const events = metrics.getRecentEvents(1000);
      // 应只剩 500 条
      expect(events.length).toBe(500);
      // 最老的 2 条应被淘汰（getRecentEvents 返回倒序，最后一条是最新的）
      // 最近的应是 query501
      const newest = events[0] as { type: string; queryLen: number };
      expect(newest.queryLen).toBe(8); // "query501" 长度 8（query=5 + 501=3）
    });
  });

  // ─── localStorage 持久化 ──────────────────────────────

  describe('localStorage 持久化', () => {
    it('事件应持久化到 localStorage', () => {
      metrics.recordShown('test', 3, 5);
      // localStorage 应包含数据
      const raw = localStorage.getItem('memora-completion-stats');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
    });

    it('新建实例应从 localStorage 加载历史数据', () => {
      metrics.recordShown('persisted', 2, 2);
      metrics.recordAdoption('persisted', 'text', 0);
      // 新建实例（模拟应用重启）
      const newMetrics = new CompletionMetrics();
      const events = newMetrics.getRecentEvents(10);
      expect(events).toHaveLength(2);
    });

    it('JSON 损坏时应降级为空数组', () => {
      localStorage.setItem('memora-completion-stats', '{invalid json');
      const newMetrics = new CompletionMetrics();
      const events = newMetrics.getRecentEvents(10);
      expect(events).toHaveLength(0);
    });

    it('非数组 JSON 应降级为空数组', () => {
      localStorage.setItem('memora-completion-stats', '"not an array"');
      const newMetrics = new CompletionMetrics();
      expect(newMetrics.getRecentEvents(10)).toHaveLength(0);
    });
  });

  // ─── clear ────────────────────────────────────────────

  describe('clear', () => {
    it('应清空所有事件', () => {
      metrics.recordShown('q1', 1, 1);
      metrics.recordAdoption('q1', 't1', 0);
      expect(metrics.getRecentEvents(10)).toHaveLength(2);
      metrics.clear();
      expect(metrics.getRecentEvents(10)).toHaveLength(0);
      expect(metrics.getAggregated().totalShown).toBe(0);
    });

    it('应同步清空 localStorage', () => {
      metrics.recordShown('q1', 1, 1);
      metrics.clear();
      const raw = localStorage.getItem('memora-completion-stats');
      expect(raw).toBe('[]');
    });
  });

  // ─── getRecentEvents ──────────────────────────────────

  describe('getRecentEvents', () => {
    it('应按倒序返回最近 N 条事件', () => {
      metrics.recordShown('first', 1, 1);
      metrics.recordShown('second', 1, 1);
      metrics.recordShown('third', 1, 1);
      const events = metrics.getRecentEvents(2);
      expect(events).toHaveLength(2);
      // 最近的事件在前
      const first = events[0] as { type: string; queryLen: number };
      expect(first.queryLen).toBe(5); // "third" 长度 5
    });

    it('limit 默认 50', () => {
      for (let i = 0; i < 60; i++) {
        metrics.recordShown(`q${i}`, 1, 1);
      }
      const events = metrics.getRecentEvents();
      expect(events).toHaveLength(50);
    });
  });
});
