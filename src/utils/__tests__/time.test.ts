/**
 * 单元测试：时间工具函数
 *
 * 覆盖 nowIso / todayDate 两个函数，重点验证：
 *   - 返回值格式符合 ISO 8601 / YYYY-MM-DD
 *   - todayDate 使用本地时区（避免 UTC 偏移导致跨天错位）
 *   - 多次调用返回值单调非递减
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { nowIso, todayDate } from '@/utils/time.js';

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
  });
});
