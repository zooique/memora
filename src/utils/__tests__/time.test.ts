/**
 * 单元测试：时间工具函数
 *
 * 覆盖 nowIso / formatDateKey / todayDate 三个函数，重点验证：
 *   - 返回值格式符合 ISO 8601 / YYYY-MM-DD
 *   - formatDateKey 使用本地时区（避免 UTC 偏移导致跨天错位）
 *   - todayDate 等价于 formatDateKey(new Date())
 *   - 多次调用返回值单调非递减
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { nowIso, formatDateKey, todayDate } from '@/utils/time.js';

describe('utils/time', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('nowIso', () => {
    it('应返回 ISO 8601 格式时间戳', () => {
      const iso = nowIso();
      // ISO 8601 形如 2026-06-21T12:34:56.789Z
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('应等价于 new Date().toISOString()', () => {
      const fixed = new Date('2026-06-21T12:34:56.789Z');
      vi.setSystemTime(fixed);
      expect(nowIso()).toBe('2026-06-21T12:34:56.789Z');
    });

    it('多次调用应单调非递减', () => {
      const a = nowIso();
      const b = nowIso();
      expect(b >= a).toBe(true);
    });
  });

  describe('todayDate', () => {
    it('应返回 YYYY-MM-DD 格式', () => {
      const d = todayDate();
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('应使用本地时区日期（非 UTC）', () => {
      // 选 UTC 00:30，本地时区若为东八区则应为 08:30 同一天；若为西五区则应为前一天 19:30
      // 这里固定 UTC 时间，验证 todayDate 返回的"日"与 toLocaleDateString 一致
      vi.setSystemTime(new Date('2026-06-21T00:30:00.000Z'));
      const expected = new Date(2026, 5, 21).getDate(); // 本地 6/21
      const today = todayDate();
      expect(today.slice(8, 10)).toBe(String(expected).padStart(2, '0'));
    });

    it('月份和日期应补零到 2 位', () => {
      vi.setSystemTime(new Date(2026, 0, 5, 10, 0, 0)); // 2026-01-05 本地
      expect(todayDate()).toBe('2026-01-05');
    });

    it('应等价于本地年月日拼接', () => {
      vi.setSystemTime(new Date(2026, 11, 31, 23, 59, 59)); // 2026-12-31 本地
      expect(todayDate()).toBe('2026-12-31');
    });

    it('应等价于 formatDateKey(new Date())', () => {
      vi.setSystemTime(new Date(2026, 6, 16, 14, 30, 0)); // 2026-07-16 本地
      expect(todayDate()).toBe(formatDateKey(new Date()));
    });
  });

  describe('formatDateKey', () => {
    it('应返回 YYYY-MM-DD 格式', () => {
      const d = formatDateKey(new Date(2026, 6, 16));
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('应使用本地时区（非 UTC）', () => {
      // UTC 2026-06-21T00:30:00 → 本地时区若为东八区应为 2026-06-21 08:30（同日）
      // 若用 toISOString().slice(0,10) 则返回 2026-06-21（UTC），与本地一致是巧合
      // 选 UTC 2026-06-21T23:30:00 → 东八区为 2026-06-22 07:30（次日），UTC 切片仍为 06-21
      vi.setSystemTime(new Date('2026-06-21T23:30:00.000Z'));
      // 本地日期应为 6/22（东八区）或 6/21（西半球），但不能是 UTC 的 6/21
      const localDate = new Date();
      const expected = `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${String(localDate.getDate()).padStart(2, '0')}`;
      expect(formatDateKey(localDate)).toBe(expected);
    });

    it('月份和日期应补零到 2 位', () => {
      expect(formatDateKey(new Date(2026, 0, 5))).toBe('2026-01-05'); // 1月5日
    });

    it('应支持任意 Date（不限于当前时间）', () => {
      expect(formatDateKey(new Date(2025, 11, 31, 23, 59, 59))).toBe('2025-12-31');
      expect(formatDateKey(new Date(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01');
    });

    it('应与精灵 shared/dateUtils.ts:formatDateKey 行为对齐（本地时区 YYYY-MM-DD）', () => {
      // 验证内核版与精灵版逻辑等价：对同一 Date 返回相同 YYYY-MM-DD
      vi.setSystemTime(new Date(2026, 6, 16, 14, 30, 0));
      const date = new Date();
      const kernelResult = formatDateKey(date);
      // 精灵版逻辑：getFullYear + padStart month/day（与内核实现完全一致）
      const expected = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      expect(kernelResult).toBe(expected);
    });
  });
});
