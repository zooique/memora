/**
 * 补全统计埋点模块测试
 *
 * 覆盖范围：
 * - recordShown / recordAdoption / recordChatTurn / recordRecallMoment：事件记录
 * - getAggregated：聚合计算（采纳率/Top-1 命中率/平均位置/激活率/召回时刻）
 * - getDailyAggregated：按日聚合（缺失日期补零/跨天分组/归一化基准）
 * - LRU 淘汰：超 500 条时从头淘汰（含混合事件类型）
 * - localStorage 持久化：写入 + 读取 + JSON 损坏降级
 * - clear：清空数据
 * - queryHash / adoptedTextHash 格式验证（FNV-1a 8 字符 hex，不记原文）
 *
 * Mock 策略：
 * - localStorage：JSDOM 环境提供真实 localStorage（每个测试 beforeEach 清空）
 * - 单例：每个测试手动 new CompletionMetrics() 避免单例污染（或用 clear 重置）
 * - 时间：用 vi.useFakeTimers + vi.setSystemTime 固定时间，避免 getDailyAggregated 跨天测试不稳
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CompletionMetrics } from '../../../electron/renderer/helpers/completionMetrics.js';

describe('补全统计埋点', () => {
  let metrics: CompletionMetrics;

  beforeEach(() => {
    // 清空 localStorage，避免跨测试污染
    localStorage.clear();
    // 每个测试新建实例（绕过单例，直接测试类）
    metrics = new CompletionMetrics();
    // 固定时间避免跨天测试不稳定（2026-07-23 12:00 本地时间，月份 0-based：6=7 月）
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 23, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
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
      // queryHash 为 FNV-1a 8 字符十六进制字符串（格式验证，不依赖 simpleHash 实现）
      expect(event.queryHash).toMatch(/^[0-9a-f]{8}$/);
      // 不应包含原文
      expect(JSON.stringify(event)).not.toContain('hello');
    });

    it('采纳事件应记录 adoptedPosition + adoptedTextHash（不记原文）', () => {
      metrics.recordAdoption('query', 'secret text', 2);
      const events = metrics.getRecentEvents(10);
      const event = events[0] as { type: string; adoptedPosition: number; adoptedTextHash: string };
      expect(event.adoptedPosition).toBe(2);
      // adoptedTextHash 为 FNV-1a 8 字符十六进制字符串（格式验证，不依赖 simpleHash 实现）
      expect(event.adoptedTextHash).toMatch(/^[0-9a-f]{8}$/);
      // 不应包含原文
      expect(JSON.stringify(event)).not.toContain('secret text');
    });

    it('相同查询的 queryHash 应一致（FNV-1a 确定性）', () => {
      metrics.recordShown('sameQuery', 3, 5);
      metrics.recordAdoption('sameQuery', 'text', 0);
      const events = metrics.getRecentEvents(10);
      const showEvent = events[1] as { queryHash: string };
      const adoptEvent = events[0] as { queryHash: string };
      expect(showEvent.queryHash).toBe(adoptEvent.queryHash);
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
      // R1 + B2 新增字段零值
      expect(agg.totalChatTurns).toBe(0);
      expect(agg.activationRate).toBe(0);
      expect(agg.recallMoments).toBe(0);
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

  // ─── R1 对话轮次埋点（激活率分母） ──────────────────

  describe('recordChatTurn', () => {
    it('应记录对话轮次事件', () => {
      metrics.recordChatTurn();
      const events = metrics.getRecentEvents(10);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('chat-turn');
    });

    it('事件应只含 type + timestamp（不记消息内容）', () => {
      metrics.recordChatTurn();
      const events = metrics.getRecentEvents(10);
      const event = events[0] as { type: string; timestamp: string };
      expect(event.type).toBe('chat-turn');
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // 不应含任何消息内容字段
      expect(Object.keys(event).sort()).toEqual(['timestamp', 'type']);
    });
  });

  // ─── B2 召回可感知时刻埋点 ──────────────────────────

  describe('recordRecallMoment', () => {
    it('应记录召回时刻事件', () => {
      metrics.recordRecallMoment(3);
      const events = metrics.getRecentEvents(10);
      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('recall-moment');
    });

    it('事件应含 recallCount + timestamp（不记记忆内容）', () => {
      metrics.recordRecallMoment(5);
      const events = metrics.getRecentEvents(10);
      const event = events[0] as { type: string; recallCount: number; timestamp: string };
      expect(event.type).toBe('recall-moment');
      expect(event.recallCount).toBe(5);
      expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // 不应含记忆内容字段
      expect(Object.keys(event).sort()).toEqual(['recallCount', 'timestamp', 'type']);
    });
  });

  // ─── R1 激活率聚合（totalShown / totalChatTurns） ────

  describe('getAggregated 激活率 + 召回时刻', () => {
    it('应正确计算激活率（totalShown / totalChatTurns）', () => {
      // 3 次对话 + 1 次展示 → 激活率 1/3
      metrics.recordChatTurn();
      metrics.recordChatTurn();
      metrics.recordChatTurn();
      metrics.recordShown('q1', 3, 5);
      const agg = metrics.getAggregated();
      expect(agg.totalChatTurns).toBe(3);
      expect(agg.totalShown).toBe(1);
      expect(agg.activationRate).toBeCloseTo(1 / 3, 5);
    });

    it('对话次数为 0 时激活率应为 0（不除零）', () => {
      metrics.recordShown('q1', 3, 5);
      const agg = metrics.getAggregated();
      expect(agg.totalChatTurns).toBe(0);
      expect(agg.activationRate).toBe(0);
    });

    it('应正确累计召回时刻数', () => {
      metrics.recordRecallMoment(2);
      metrics.recordRecallMoment(3);
      metrics.recordRecallMoment(1);
      const agg = metrics.getAggregated();
      expect(agg.recallMoments).toBe(3);
    });

    it('4 种事件混合时聚合应互不干扰', () => {
      // 混合事件流：对话 + 展示 + 采纳 + 召回
      metrics.recordChatTurn();
      metrics.recordShown('q1', 3, 5);
      metrics.recordAdoption('q1', 'text', 0);
      metrics.recordRecallMoment(2);
      metrics.recordChatTurn();
      metrics.recordShown('q2', 2, 3);
      const agg = metrics.getAggregated();
      // 各类型独立计数
      expect(agg.totalChatTurns).toBe(2);
      expect(agg.totalShown).toBe(2);
      expect(agg.totalAdopted).toBe(1);
      expect(agg.recallMoments).toBe(1);
      // 激活率 = 2/2 = 1.0（每次对话都唤起了补全）
      expect(agg.activationRate).toBe(1);
      // 采纳率 = 1/2 = 0.5
      expect(agg.adoptionRate).toBe(0.5);
    });
  });

  // ─── B2 按日聚合（纵向养成曲线） ─────────────────────

  describe('getDailyAggregated', () => {
    it('无事件时应返回 N 天零值数组（缺失日期补零）', () => {
      const daily = metrics.getDailyAggregated(7);
      expect(daily).toHaveLength(7);
      for (const item of daily) {
        expect(item.shown).toBe(0);
        expect(item.adopted).toBe(0);
        expect(item.chatTurns).toBe(0);
        expect(item.activationRate).toBe(0);
        expect(item.recallMoments).toBe(0);
      }
    });

    it('应返回最近 N 天按日期升序的数组', () => {
      metrics.recordChatTurn();
      const daily = metrics.getDailyAggregated(3);
      expect(daily).toHaveLength(3);
      // 升序：最旧在前，最新在后
      // 今天是 2026-07-23，3 天 = 07-21, 07-22, 07-23
      expect(daily[0]!.date).toBe('2026-07-21');
      expect(daily[1]!.date).toBe('2026-07-22');
      expect(daily[2]!.date).toBe('2026-07-23');
      // 今天应有 1 次 chat-turn
      expect(daily[2]!.chatTurns).toBe(1);
      // 前两天应为 0
      expect(daily[0]!.chatTurns).toBe(0);
      expect(daily[1]!.chatTurns).toBe(0);
    });

    it('应正确按日聚合多事件类型', () => {
      // 今天：2 次展示 + 1 次采纳 + 3 次对话 + 1 次召回
      metrics.recordShown('q1', 3, 5);
      metrics.recordShown('q2', 2, 3);
      metrics.recordAdoption('q1', 'text', 0);
      metrics.recordChatTurn();
      metrics.recordChatTurn();
      metrics.recordChatTurn();
      metrics.recordRecallMoment(4);

      const daily = metrics.getDailyAggregated(1);
      expect(daily).toHaveLength(1);
      const today = daily[0]!;
      expect(today.shown).toBe(2);
      expect(today.adopted).toBe(1);
      expect(today.chatTurns).toBe(3);
      expect(today.recallMoments).toBe(1);
      // 激活率 = 2/3
      expect(today.activationRate).toBeCloseTo(2 / 3, 5);
    });

    it('chatTurns=0 的日期 activationRate 应为 0（不除零）', () => {
      metrics.recordShown('q1', 3, 5);
      const daily = metrics.getDailyAggregated(1);
      expect(daily[0]!.chatTurns).toBe(0);
      expect(daily[0]!.activationRate).toBe(0);
    });

    it('跨天事件应按本地时区分组（避免 UTC 错位）', () => {
      // 写入一个昨天的事件（直接操作 localStorage 模拟跨天数据）
      const yesterday = new Date(2026, 6, 22, 23, 30, 0);
      metrics.recordChatTurn();
      // 手动追加昨天的事件（绕过 recordChatTurn 用当前时间）
      const events = [
        { type: 'chat-turn', timestamp: yesterday.toISOString() },
        { type: 'chat-turn', timestamp: new Date().toISOString() },
      ];
      localStorage.setItem('memora-completion-stats', JSON.stringify(events));
      const m2 = new CompletionMetrics();
      const daily = m2.getDailyAggregated(2);
      expect(daily).toHaveLength(2);
      // 07-22 应有 1 次，07-23 应有 1 次
      expect(daily[0]!.date).toBe('2026-07-22');
      expect(daily[0]!.chatTurns).toBe(1);
      expect(daily[1]!.date).toBe('2026-07-23');
      expect(daily[1]!.chatTurns).toBe(1);
    });
  });

  // ─── LRU 淘汰（混合事件类型） ───────────────────────

  describe('LRU 淘汰（混合类型）', () => {
    it('超过 500 条混合事件时应从头淘汰最老事件', () => {
      // 写入 502 条混合事件
      for (let i = 0; i < 502; i++) {
        if (i % 3 === 0) metrics.recordShown(`q${i}`, 1, 1);
        else if (i % 3 === 1) metrics.recordChatTurn();
        else metrics.recordRecallMoment(1);
      }
      const events = metrics.getRecentEvents(1000);
      expect(events).toHaveLength(500);
      // 最老的 2 条应被淘汰（query0 + chat-turn）
      // 最近的事件应是 i=501，501 % 3 = 0 → recordShown
      const newest = events[0]!;
      expect(newest.type).toBe('shown');
    });
  });
});
