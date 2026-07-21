/**
 * DOM 工具函数模块测试 — 时间格式化纯函数部分
 *
 * 覆盖范围：
 * - formatTimeAgo：相对时间格式化（刚刚 / X 分钟前 / X 小时前 / X 天前 / MM-DD）
 * - formatTimestamp：时间戳格式化（当天 HH:MM / 非当天 MM-DD HH:MM）
 * - formatClock：时钟格式化（HH:MM）
 *
 * 仅测试纯逻辑函数（format* 系列），DOM 相关函数（getRequiredElement 等）
 * 需 JSDOM 环境，留待后续按需补充。
 *
 * 使用 vi.useFakeTimers + 固定时间锚点，确保格式化结果可断言。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatTimeAgo, formatTimestamp, formatClock, escapeHtml } from '../../../electron/renderer/helpers/domHelpers.js';

/** 锚定时间：2026-06-26 12:00:00（本地时区） */
const ANCHOR_NOW = new Date(2026, 5, 26, 12, 0, 0).getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ANCHOR_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── formatTimeAgo ──────────────────────────────────────────

describe('formatTimeAgo', () => {
  it('30 秒内应返回"刚刚"', () => {
    // 锚点前 30 秒
    const dateStr = new Date(ANCHOR_NOW - 30_000).toISOString();
    expect(formatTimeAgo(dateStr)).toBe('刚刚');
  });

  it('59 秒边界应返回"刚刚"', () => {
    const dateStr = new Date(ANCHOR_NOW - 59_000).toISOString();
    expect(formatTimeAgo(dateStr)).toBe('刚刚');
  });

  it('1-59 分钟内应返回"X 分钟前"', () => {
    const dateStr = new Date(ANCHOR_NOW - 5 * 60_000).toISOString();
    expect(formatTimeAgo(dateStr)).toBe('5 分钟前');
  });

  it('30 分钟应返回"30 分钟前"', () => {
    const dateStr = new Date(ANCHOR_NOW - 30 * 60_000).toISOString();
    expect(formatTimeAgo(dateStr)).toBe('30 分钟前');
  });

  it('1 小时内但超过 60 分钟应返回"1 小时前"', () => {
    // 65 分钟 = 1 小时 5 分，diffMin=65 但 diffHour=1
    const dateStr = new Date(ANCHOR_NOW - 65 * 60_000).toISOString();
    expect(formatTimeAgo(dateStr)).toBe('1 小时前');
  });

  it('23 小时内应返回"X 小时前"', () => {
    const dateStr = new Date(ANCHOR_NOW - 5 * 3_600_000).toISOString();
    expect(formatTimeAgo(dateStr)).toBe('5 小时前');
  });

  it('6 天内应返回"X 天前"', () => {
    const dateStr = new Date(ANCHOR_NOW - 3 * 86_400_000).toISOString();
    expect(formatTimeAgo(dateStr)).toBe('3 天前');
  });

  it('7 天及以上应返回 MM-DD 格式', () => {
    // 10 天前 = 2026-06-16
    const dateStr = new Date(ANCHOR_NOW - 10 * 86_400_000).toISOString();
    expect(formatTimeAgo(dateStr)).toBe('06-16');
  });

  it('跨年应返回正确 MM-DD', () => {
    // 2025-12-25（约 183 天前）
    const dateStr = new Date(2025, 11, 25, 10, 0, 0).toISOString();
    expect(formatTimeAgo(dateStr)).toBe('12-25');
  });

  it('YYYY-MM-DD 格式输入应被正确解析', () => {
    // new Date('2026-06-20') 解析为 UTC 午夜，但相对时间差仍正确
    const dateStr = '2026-06-20';
    const result = formatTimeAgo(dateStr);
    // 6 天前 → "6 天前"（边界可能因时区 ±1 天，断言两种可能）
    expect(['5 天前', '6 天前', '7 天前']).toContain(result);
  });

  // ─── Invalid Date 降级 ──

  it('无效日期字符串应降级返回原始字符串（Invalid Date 检测）', () => {
    // 行为：new Date('not-a-date') 返回 Invalid Date，
    // Number.isNaN(date.getTime()) 为 true，降级返回原始字符串
    const invalid = 'not-a-date';
    expect(formatTimeAgo(invalid)).toBe('not-a-date');
  });

  it('空字符串应降级返回空字符串', () => {
    // new Date('') 返回 Invalid Date（空字符串非有效日期格式）
    expect(formatTimeAgo('')).toBe('');
  });

  it('纯空格字符串应降级返回原始字符串', () => {
    expect(formatTimeAgo('   ')).toBe('   ');
  });
});

// ─── formatTimestamp ────────────────────────────────────────

describe('formatTimestamp', () => {
  it('当天应返回 HH:MM 格式', () => {
    // 当天 09:30
    const dateStr = new Date(2026, 5, 26, 9, 30).toISOString();
    expect(formatTimestamp(dateStr)).toBe('09:30');
  });

  it('当天午夜应返回 00:00', () => {
    const dateStr = new Date(2026, 5, 26, 0, 0).toISOString();
    expect(formatTimestamp(dateStr)).toBe('00:00');
  });

  it('当天 23:59 应返回 23:59', () => {
    const dateStr = new Date(2026, 5, 26, 23, 59).toISOString();
    expect(formatTimestamp(dateStr)).toBe('23:59');
  });

  it('非当天应返回 MM-DD HH:MM 格式', () => {
    // 前天 15:45（避开"昨天"判断，昨天会返回"昨天 HH:MM"）
    const dateStr = new Date(2026, 5, 24, 15, 45).toISOString();
    expect(formatTimestamp(dateStr)).toBe('06-24 15:45');
  });

  it('跨月应返回正确 MM-DD', () => {
    // 2026-05-20 08:15
    const dateStr = new Date(2026, 4, 20, 8, 15).toISOString();
    expect(formatTimestamp(dateStr)).toBe('05-20 08:15');
  });

  it('跨年应返回正确 MM-DD HH:MM', () => {
    // 2025-12-31 23:59
    const dateStr = new Date(2025, 11, 31, 23, 59).toISOString();
    expect(formatTimestamp(dateStr)).toBe('12-31 23:59');
  });

  it('无效日期字符串应降级返回原始字符串（Invalid Date 检测）', () => {
    // Number.isNaN(date.getTime()) 检测 Invalid Date，
    // 降级分支可达，返回原始字符串而非 'NaN-NaN NaN:NaN'
    const invalid = 'not-a-date';
    expect(formatTimestamp(invalid)).toBe('not-a-date');
  });

  it('空字符串应降级返回空字符串', () => {
    expect(formatTimestamp('')).toBe('');
  });

  it('纯空格字符串应降级返回原始字符串', () => {
    expect(formatTimestamp('   ')).toBe('   ');
  });
});

// ─── formatClock ────────────────────────────────────────────

describe('formatClock', () => {
  it('应返回 HH:MM 格式', () => {
    const dateStr = new Date(2026, 5, 26, 14, 5).toISOString();
    expect(formatClock(dateStr)).toBe('14:05');
  });

  it('午夜应返回 00:00', () => {
    const dateStr = new Date(2026, 5, 26, 0, 0).toISOString();
    expect(formatClock(dateStr)).toBe('00:00');
  });

  it('不关心日期，仅提取时间部分', () => {
    // 不同日期，相同时间
    const d1 = new Date(2026, 0, 1, 9, 30).toISOString();
    const d2 = new Date(2025, 11, 31, 9, 30).toISOString();
    expect(formatClock(d1)).toBe('09:30');
    expect(formatClock(d2)).toBe('09:30');
  });

  it('单数字小时分钟应 padStart 到 2 位', () => {
    const dateStr = new Date(2026, 5, 26, 1, 2).toISOString();
    expect(formatClock(dateStr)).toBe('01:02');
  });

  it('无效日期字符串应降级返回原始字符串（Invalid Date 检测）', () => {
    // 降级分支可达，返回原始字符串而非 'NaN:NaN'
    const invalid = 'invalid-time';
    expect(formatClock(invalid)).toBe('invalid-time');
  });

  it('空字符串应降级返回空字符串', () => {
    expect(formatClock('')).toBe('');
  });

  it('纯空格字符串应降级返回原始字符串', () => {
    expect(formatClock('   ')).toBe('   ');
  });
});

// ─── escapeHtml ────────────────────────────────────────────

describe('escapeHtml', () => {
  it('空字符串应返回空字符串', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('无特殊字符的文本应原样返回', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
    expect(escapeHtml('中文文本')).toBe('中文文本');
  });

  it('应转义 & 为 &amp;', () => {
    expect(escapeHtml('a&b')).toBe('a&amp;b');
  });

  it('应转义 < 为 &lt;', () => {
    expect(escapeHtml('a<b')).toBe('a&lt;b');
  });

  it('应转义 > 为 &gt;', () => {
    expect(escapeHtml('a>b')).toBe('a&gt;b');
  });

  it('应转义 " 为 &quot;', () => {
    expect(escapeHtml('a"b')).toBe('a&quot;b');
  });

  it('应转义所有 4 类特殊字符', () => {
    expect(escapeHtml('<script>alert("x&y")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;',
    );
  });

  it('应优先转义 & 避免二次转义', () => {
    // & 必须先转义，否则后续转义产生的 &amp; 中的 & 会被再次转义
    expect(escapeHtml('<&>')).toBe('&lt;&amp;&gt;');
  });

  it('单引号不应被转义', () => {
    expect(escapeHtml("a'b")).toBe("a'b");
  });

  it('应转义 HTML 标签注入载荷', () => {
    // 转义后 < > 变为 &lt; &gt;，浏览器不会解析为标签
    const payload = '<img src=x onerror=alert(1)>';
    expect(escapeHtml(payload)).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('应处理混合特殊字符与普通文本', () => {
    expect(escapeHtml('用户输入：<b>加粗</b> & "引号"')).toBe(
      '用户输入：&lt;b&gt;加粗&lt;/b&gt; &amp; &quot;引号&quot;',
    );
  });
});
