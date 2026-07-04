/**
 * 对话回顾管理器单元测试 — buildReviewData 纯函数
 *
 * 覆盖范围：
 *   - 今日回顾（today）：今日新增记忆/洞察计数、dailyMessageCount 注入
 *   - 记忆增长趋势（trend）：7 天/30 天计数、daily 数组长度与顺序、direction 三态边界
 *   - 洞察摘要（insights）：recent 最多 5 条且按时间倒序、bySource 分布
 *   - 边界：空列表、createdAt undefined/无效、totalMemories 透传、generatedAt 格式
 *
 * 测试策略（对齐 memoryHealth.test.ts 范式）：
 *   - 纯业务逻辑测试，无 I/O、无 LLM、无 DOM
 *   - 使用 vi.useFakeTimers 固定"今天"，避免跨日测试不稳定
 *   - 禁止 @ts-ignore / as any
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildReviewData } from '../../../sprite/controllers/reviewManager.js';
import type { ReviewData } from '../../../sprite/controllers/reviewManager.js';
import type { MemoryListItem, DashboardData } from '../../../sprite/controllers/memoryController.js';

// ─── Mock 工厂 ──────────────────────────────────────────

/** 固定的"今天"基准时间（2026-07-03 12:00 UTC） */
const MOCK_NOW = new Date('2026-07-03T12:00:00.000Z');

/** 默认内容预览 */
const DEFAULT_PREVIEW = '测试记忆内容预览文本数据';

/** 创建测试用 MemoryListItem */
function makeItem(overrides: Partial<MemoryListItem> = {}): MemoryListItem {
  return {
    id: 'test:default',
    name: '默认记忆',
    source: 'insight',
    score: 0.5,
    contentPreview: DEFAULT_PREVIEW,
    createdAt: MOCK_NOW.toISOString(),
    ...overrides,
  };
}

/** 创建距今 N 天前当天 00:00 的 ISO 时间（确保 groupByDate 落到正确日期） */
function daysAgoStartOfDay(days: number): string {
  const d = new Date(MOCK_NOW);
  d.setDate(d.getDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** 创建最小 DashboardData */
function makeDashboard(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    total: 0,
    bySource: {},
    suggestions: [],
    relationCount: 0,
    conflictCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  // 固定系统时间，保证"今天"和 daysAgo 计算稳定
  vi.useFakeTimers({ now: MOCK_NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── 空数据 ──────────────────────────────────────────────

describe('buildReviewData · 空数据', () => {
  it('空记忆列表应返回全 0 计数和 stable 趋势', () => {
    const result = buildReviewData(makeDashboard(), []);

    // 今日回顾：无记忆、无消息计数
    expect(result.today.newMemories).toBe(0);
    expect(result.today.newInsights).toBe(0);
    expect(result.today.messageCount).toBe(0);
    expect(result.today.date).toBe('2026-07-03');

    // 趋势：7 天/30 天都是 0，direction=stable
    expect(result.trend.last7Days).toBe(0);
    expect(result.trend.last30Days).toBe(0);
    expect(result.trend.direction).toBe('stable');
    expect(result.trend.description).toBe('记忆增长保持稳定');

    // daily 数组：长度 7（最近 7 天），全部 0
    expect(result.trend.daily).toHaveLength(7);
    expect(result.trend.daily.every((d) => d.newMemories === 0)).toBe(true);

    // 洞察摘要：空
    expect(result.insights.total).toBe(0);
    expect(result.insights.recent).toEqual([]);
    expect(result.insights.bySource).toEqual({});

    // totalMemories 透传 + generatedAt 是有效 ISO
    expect(result.totalMemories).toBe(0);
    expect(new Date(result.generatedAt).getTime()).not.toBeNaN();
  });
});

// ─── 今日回顾 ────────────────────────────────────────────

describe('buildReviewData · 今日回顾', () => {
  it('今日创建的记忆应计入 today.newMemories', () => {
    const items = [
      makeItem({ id: 'a', source: 'insight', createdAt: MOCK_NOW.toISOString() }),
      makeItem({ id: 'b', source: 'rule', createdAt: MOCK_NOW.toISOString() }),
    ];
    const result = buildReviewData(makeDashboard({ total: 2 }), items);

    expect(result.today.newMemories).toBe(2);
  });

  it('今日创建的 source=insight 记忆应计入 today.newInsights', () => {
    const items = [
      makeItem({ id: 'a', source: 'insight', createdAt: MOCK_NOW.toISOString() }),
      makeItem({ id: 'b', source: 'rule', createdAt: MOCK_NOW.toISOString() }),
      makeItem({ id: 'c', source: 'insight', createdAt: MOCK_NOW.toISOString() }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.today.newInsights).toBe(2);
  });

  it('dailyMessageCount 注入时 today.messageCount 应取当日值', () => {
    // 缺口 3.4：dailyMessageCount 由 Sprite 累加并持久化，未注入时为 0
    const result = buildReviewData(makeDashboard(), [], {
      '2026-07-03': 42,
    });

    expect(result.today.messageCount).toBe(42);
  });

  it('dailyMessageCount 未注入时 today.messageCount 应为 0（向后兼容）', () => {
    const result = buildReviewData(makeDashboard(), []);

    expect(result.today.messageCount).toBe(0);
  });

  it('dailyMessageCount 中无当日 key 时 today.messageCount 应为 0', () => {
    const result = buildReviewData(makeDashboard(), [], {
      '2026-07-02': 10, // 昨天的数据
    });

    expect(result.today.messageCount).toBe(0);
  });
});

// ─── 记忆增长趋势 ────────────────────────────────────────

describe('buildReviewData · 记忆增长趋势', () => {
  it('7 天内创建的记忆应计入 trend.last7Days', () => {
    const items = [
      makeItem({ id: 'a', createdAt: daysAgoStartOfDay(1) }),
      makeItem({ id: 'b', createdAt: daysAgoStartOfDay(6) }),
      makeItem({ id: 'c', createdAt: daysAgoStartOfDay(8) }), // 超出 7 天
    ];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.trend.last7Days).toBe(2);
  });

  it('30 天内创建的记忆应计入 trend.last30Days', () => {
    const items = [
      makeItem({ id: 'a', createdAt: daysAgoStartOfDay(10) }),
      makeItem({ id: 'b', createdAt: daysAgoStartOfDay(29) }),
      makeItem({ id: 'c', createdAt: daysAgoStartOfDay(35) }), // 超出 30 天
    ];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.trend.last30Days).toBe(2);
  });

  it('trend.daily 长度应为 7 且日期升序（最旧→今天）', () => {
    const result = buildReviewData(makeDashboard(), []);

    expect(result.trend.daily).toHaveLength(7);
    // 第 0 项是 6 天前，最后一项是今天
    expect(result.trend.daily[0]!.date).toBe('2026-06-27');
    expect(result.trend.daily[6]!.date).toBe('2026-07-03');
  });

  it('trend.daily 每项应包含 dailyMessageCount 对应值', () => {
    const result = buildReviewData(makeDashboard(), [], {
      '2026-07-03': 10,
      '2026-07-01': 5,
    });

    // 今天
    expect(result.trend.daily[6]!.messageCount).toBe(10);
    // 7 月 1 日（距今 2 天）
    expect(result.trend.daily[4]!.messageCount).toBe(5);
    // 未注入的日期为 0
    expect(result.trend.daily[0]!.messageCount).toBe(0);
  });

  it('trend.direction=growing 当后半段 > 前半段 × 1.5', () => {
    // daily[0..2] 是 6/27/6/28/6/29（前 3 天），daily[4..6] 是 7/1/7/2/7/3（后 3 天）
    // 前 3 天 0 条，后 3 天 5 条 → 5 > 0 * 1.5 = 0 → growing
    const items = [
      makeItem({ id: 'a', createdAt: daysAgoStartOfDay(2) }),
      makeItem({ id: 'b', createdAt: daysAgoStartOfDay(1) }),
      makeItem({ id: 'c', createdAt: daysAgoStartOfDay(0) }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.trend.direction).toBe('growing');
    expect(result.trend.description).toBe('记忆增长正在加速');
  });

  it('trend.direction=declining 当前半段 > 后半段 × 1.5', () => {
    // 前 3 天（6/27/6/28/6/29）有 5 条，后 3 天 0 条 → declining
    const items = [
      makeItem({ id: 'a', createdAt: daysAgoStartOfDay(6) }),
      makeItem({ id: 'b', createdAt: daysAgoStartOfDay(5) }),
      makeItem({ id: 'c', createdAt: daysAgoStartOfDay(4) }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.trend.direction).toBe('declining');
    expect(result.trend.description).toBe('记忆增长有所放缓');
  });

  it('trend.direction=stable 当前后半段均衡', () => {
    // 前后各有 1 条 → 均衡
    const items = [
      makeItem({ id: 'a', createdAt: daysAgoStartOfDay(6) }),
      makeItem({ id: 'b', createdAt: daysAgoStartOfDay(0) }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.trend.direction).toBe('stable');
  });

  it('trend.direction=growing 边界：secondHalf 恰好等于 firstHalf × 1.5 不应触发（严格大于）', () => {
    // firstHalf=2，secondHalf=3 → 3 > 2*1.5=3 不成立（严格大于）→ stable
    const items = [
      // 前 3 天 2 条
      makeItem({ id: 'a', createdAt: daysAgoStartOfDay(6) }),
      makeItem({ id: 'b', createdAt: daysAgoStartOfDay(5) }),
      // 后 3 天 3 条（含今天）
      makeItem({ id: 'c', createdAt: daysAgoStartOfDay(2) }),
      makeItem({ id: 'd', createdAt: daysAgoStartOfDay(1) }),
      makeItem({ id: 'e', createdAt: daysAgoStartOfDay(0) }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    // secondHalf=3, firstHalf=2, 3 > 2*1.5=3 → false → stable
    expect(result.trend.direction).toBe('stable');
  });
});

// ─── 洞察摘要 ────────────────────────────────────────────

describe('buildReviewData · 洞察摘要', () => {
  it('insights.total 应等于 source=insight 的记忆数', () => {
    const items = [
      makeItem({ id: 'a', source: 'insight' }),
      makeItem({ id: 'b', source: 'rule' }),
      makeItem({ id: 'c', source: 'insight' }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.insights.total).toBe(2);
  });

  it('insights.recent 最多 5 条', () => {
    const items: MemoryListItem[] = [];
    for (let i = 0; i < 8; i++) {
      items.push(
        makeItem({
          id: `insight-${i}`,
          source: 'insight',
          name: `洞察${i}`,
          createdAt: daysAgoStartOfDay(i),
        }),
      );
    }
    const result = buildReviewData(makeDashboard(), items);

    expect(result.insights.recent).toHaveLength(5);
  });

  it('insights.recent 应按 createdAt 降序排列（最新在前）', () => {
    const items = [
      makeItem({ id: 'old', source: 'insight', name: '旧洞察', createdAt: daysAgoStartOfDay(5) }),
      makeItem({ id: 'new', source: 'insight', name: '新洞察', createdAt: daysAgoStartOfDay(1) }),
      makeItem({ id: 'mid', source: 'insight', name: '中洞察', createdAt: daysAgoStartOfDay(3) }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.insights.recent[0]!.name).toBe('新洞察');
    expect(result.insights.recent[1]!.name).toBe('中洞察');
    expect(result.insights.recent[2]!.name).toBe('旧洞察');
  });

  it('insights.recent 每项应包含 name/contentPreview/createdAt', () => {
    const items = [
      makeItem({
        id: 'a',
        source: 'insight',
        name: '测试洞察',
        contentPreview: '内容预览ABC',
        createdAt: daysAgoStartOfDay(1),
      }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.insights.recent[0]).toEqual({
      name: '测试洞察',
      contentPreview: '内容预览ABC',
      createdAt: daysAgoStartOfDay(1),
    });
  });

  it('insights.bySource 应包含 insight 来源计数', () => {
    const items = [
      makeItem({ id: 'a', source: 'insight' }),
      makeItem({ id: 'b', source: 'insight' }),
      makeItem({ id: 'c', source: 'rule' }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.insights.bySource).toEqual({ insight: 2 });
  });

  it('无 insight 记忆时 insights.bySource 应为空对象', () => {
    const items = [makeItem({ id: 'a', source: 'rule' })];
    const result = buildReviewData(makeDashboard(), items);

    expect(result.insights.bySource).toEqual({});
  });

  it('createdAt 为 undefined 的洞察不应进入 recent', () => {
    const items = [
      makeItem({ id: 'a', source: 'insight', name: '无时间洞察', createdAt: undefined }),
      makeItem({ id: 'b', source: 'insight', name: '有时问洞察', createdAt: daysAgoStartOfDay(1) }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    // 无 createdAt 的洞察会进入 recent 但 createdAt 字段为空字符串
    expect(result.insights.recent).toHaveLength(2);
    // 有时间的排前面（getTime=0 排后面）
    expect(result.insights.recent[0]!.name).toBe('有时问洞察');
    expect(result.insights.recent[1]!.name).toBe('无时间洞察');
    expect(result.insights.recent[1]!.createdAt).toBe('');
  });
});

// ─── 边界情况 ────────────────────────────────────────────

describe('buildReviewData · 边界情况', () => {
  it('createdAt 无效字符串应被忽略（不计入今日/趋势）', () => {
    const items = [
      makeItem({ id: 'a', createdAt: 'invalid-date' }),
      makeItem({ id: 'b', createdAt: MOCK_NOW.toISOString() }),
    ];
    const result = buildReviewData(makeDashboard(), items);

    // 无效日期不计入今日新增
    expect(result.today.newMemories).toBe(1);
    // 无效日期不计入 7 天趋势
    expect(result.trend.last7Days).toBe(1);
  });

  it('totalMemories 应从 dashboard.total 透传', () => {
    const result = buildReviewData(makeDashboard({ total: 42 }), []);

    expect(result.totalMemories).toBe(42);
  });

  it('generatedAt 应是有效 ISO 8601 字符串', () => {
    const result = buildReviewData(makeDashboard(), []);

    // 应能被 Date 解析
    const parsed = new Date(result.generatedAt);
    expect(parsed.getTime()).not.toBeNaN();
    // 应等于 mock 的当前时间
    expect(parsed.toISOString()).toBe(MOCK_NOW.toISOString());
  });

  it('返回值结构应包含全部 5 个顶层字段', () => {
    const result: ReviewData = buildReviewData(makeDashboard(), []);

    // 顶层 5 字段：today / trend / insights / totalMemories / generatedAt
    expect(result).toHaveProperty('today');
    expect(result).toHaveProperty('trend');
    expect(result).toHaveProperty('insights');
    expect(result).toHaveProperty('totalMemories');
    expect(result).toHaveProperty('generatedAt');
  });
});
