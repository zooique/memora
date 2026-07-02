/**
 * 对话回顾管理器 — 聚合最近对话的摘要数据
 *
 * 职责：
 *   1. 聚合最近对话的统计数据（消息数、新记忆数、洞察数）
 *   2. 汇总最近 N 条洞察记忆
 *   3. 计算记忆增长趋势（7 天/30 天）
 *   4. 生成回顾面板数据（纯代码计算，不依赖 LLM）
 *
 * 设计原则：
 *   - 纯代码聚合，不调 LLM（B6：代码负责确定性工作）
 *   - 零内核修改，仅消费现有 API
 *   - 数据不持久化，每次请求实时计算
 */

import type { MemoryListItem, DashboardData } from './memoryController.js';
import { MS_PER_DAY } from '../constants.js';

// ─── 类型定义 ────────────────────────────────────────────

/** 单日回顾数据 */
export interface DailyReview {
  /** 日期（ISO 8601 日期部分） */
  date: string;
  /** 当天消息数（估算） */
  messageCount: number;
  /** 当天新增记忆数 */
  newMemories: number;
  /** 当天新增洞察数 */
  newInsights: number;
}

/** 记忆增长趋势 */
export interface GrowthTrend {
  /** 7 天内新增记忆数 */
  last7Days: number;
  /** 30 天内新增记忆数 */
  last30Days: number;
  /** 每日新增记忆列表（最近 7 天） */
  daily: DailyReview[];
  /** 趋势方向 */
  direction: 'growing' | 'stable' | 'declining';
  /** 趋势描述 */
  description: string;
}

/** 洞察摘要 */
export interface InsightSummary {
  /** 洞察总数 */
  total: number;
  /** 最近洞察列表（最多 5 条） */
  recent: Array<{
    name: string;
    contentPreview: string;
    createdAt: string;
  }>;
  /** 洞察来源分布 */
  bySource: Record<string, number>;
}

/** 回顾面板完整数据 */
export interface ReviewData {
  /** 今日回顾 */
  today: DailyReview;
  /** 记忆增长趋势 */
  trend: GrowthTrend;
  /** 洞察摘要 */
  insights: InsightSummary;
  /** 记忆总数 */
  totalMemories: number;
  /** 生成时间（ISO 8601） */
  generatedAt: string;
}

// ─── 工具函数 ────────────────────────────────────────────

/**
 * 判断日期是否在指定天数内
 *
 * @param isoDate ISO 8601 日期字符串
 * @param days 天数
 * @returns 是否在范围内
 */
function isWithinDays(isoDate: string | undefined, days: number): boolean {
  if (!isoDate) return false;
  const date = new Date(isoDate);
  if (isNaN(date.getTime())) return false;
  const cutoff = Date.now() - days * MS_PER_DAY;
  return date.getTime() >= cutoff;
}

/**
 * 获取 ISO 日期部分（YYYY-MM-DD）
 *
 * @param isoDate ISO 8601 日期字符串
 * @returns 日期部分，无效时返回空字符串
 */
function getDatePart(isoDate: string | undefined): string {
  if (!isoDate) return '';
  try {
    return new Date(isoDate).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

/**
 * 按日期分组记忆
 *
 * @param memories 记忆列表
 * @returns 日期 → 记忆数 映射
 */
function groupByDate(memories: MemoryListItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of memories) {
    const date = getDatePart(m.createdAt);
    if (date) {
      map.set(date, (map.get(date) || 0) + 1);
    }
  }
  return map;
}

// ─── 公开 API ────────────────────────────────────────────

/**
 * 构建回顾面板数据
 *
 * 聚合最近对话的摘要、洞察和增长趋势。纯代码计算，不依赖 LLM。
 *
 * @param dashboard 仪表盘数据
 * @param allMemories 全量记忆列表
 * @param dailyMessageCount 每日用户消息计数（缺口 3.4 修复：可选注入，key=YYYY-MM-DD）
 *   - 由 Sprite.incrementDailyMessageCount 累加并持久化到 spriteConfig.dailyMessageCount
 *   - 未注入时 messageCount 字段保持 0（向后兼容）
 * @returns 回顾面板完整数据
 */
export function buildReviewData(
  dashboard: DashboardData,
  allMemories: MemoryListItem[],
  dailyMessageCount?: Record<string, number>,
): ReviewData {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // ─── 今日回顾 ──────────────────────────────────────────
  // 计算今天新增的记忆数
  const todayMemories = allMemories.filter((m) => getDatePart(m.createdAt) === todayStr);

  // 今天新增 insight 数
  const todayInsights = todayMemories.filter((m) => m.source === 'insight');

  const today: DailyReview = {
    date: todayStr,
    // 缺口 3.4：从注入的 dailyMessageCount 读取当日消息数；未注入时为 0
    messageCount: dailyMessageCount?.[todayStr] ?? 0,
    newMemories: todayMemories.length,
    newInsights: todayInsights.length,
  };

  // ─── 记忆增长趋势 ──────────────────────────────────────
  const last7DaysCount = allMemories.filter((m) => isWithinDays(m.createdAt, 7)).length;
  const last30DaysCount = allMemories.filter((m) => isWithinDays(m.createdAt, 30)).length;

  // 每日新增记忆（最近 7 天）
  const dailyMap = groupByDate(allMemories.filter((m) => isWithinDays(m.createdAt, 7)));
  const daily: DailyReview[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    // 当天 insight 数
    const dayInsights = allMemories.filter(
      (m) => getDatePart(m.createdAt) === dateStr && m.source === 'insight',
    ).length;
    daily.push({
      date: dateStr,
      // 缺口 3.4：从注入的 dailyMessageCount 读取当日消息数
      messageCount: dailyMessageCount?.[dateStr] ?? 0,
      newMemories: dailyMap.get(dateStr) || 0,
      newInsights: dayInsights,
    });
  }

  // 趋势方向判断
  const firstHalf = daily.slice(0, 3).reduce((s, d) => s + d.newMemories, 0);
  const secondHalf = daily.slice(4, 7).reduce((s, d) => s + d.newMemories, 0);
  let direction: 'growing' | 'stable' | 'declining' = 'stable';
  let trendDesc = '记忆增长保持稳定';
  if (secondHalf > firstHalf * 1.5) {
    direction = 'growing';
    trendDesc = '记忆增长正在加速';
  } else if (firstHalf > secondHalf * 1.5) {
    direction = 'declining';
    trendDesc = '记忆增长有所放缓';
  }

  const trend: GrowthTrend = {
    last7Days: last7DaysCount,
    last30Days: last30DaysCount,
    daily,
    direction,
    description: trendDesc,
  };

  // ─── 洞察摘要 ──────────────────────────────────────────
  const insightMemories = allMemories.filter((m) => m.source === 'insight');
  // 按创建时间降序排列
  const sortedInsights = [...insightMemories].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });
  const recentInsights = sortedInsights.slice(0, 5).map((m) => ({
    name: m.name,
    contentPreview: m.contentPreview,
    createdAt: m.createdAt || '',
  }));

  // 洞察来源分布（当前统一为 insight，后续可扩展细分来源）
  const bySource: Record<string, number> = {};
  if (insightMemories.length > 0) {
    bySource['insight'] = insightMemories.length;
  }

  const insights: InsightSummary = {
    total: insightMemories.length,
    recent: recentInsights,
    bySource,
  };

  return {
    today,
    trend,
    insights,
    totalMemories: dashboard.total,
    generatedAt: now.toISOString(),
  };
}