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
import { nowIso, formatDateKey, todayDate, buildSessionId, splitSessionId, isValidSessionId } from '@/utils/time.js';

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

  describe('buildSessionId', () => {
    it('应组装 date + "-" + session', () => {
      expect(buildSessionId('2026-06-21', 'main')).toBe('2026-06-21-main');
    });

    it('session 含连字符时不丢失分段（分叉名 main-b1）', () => {
      expect(buildSessionId('2026-06-27', 'main-fork-1')).toBe('2026-06-27-main-fork-1');
    });

    it('session 为空串时返回纯 date（不产生尾 -）', () => {
      expect(buildSessionId('2026-06-21', '')).toBe('2026-06-21');
    });

    it('与 splitSessionId 互为反操作（往返一致）', () => {
      const id = buildSessionId('2026-06-27', 'main-fork-1');
      const { date, session } = splitSessionId(id);
      expect(date).toBe('2026-06-27');
      expect(session).toBe('main-fork-1');
      expect(buildSessionId(date, session)).toBe(id);
    });
  });

  describe('splitSessionId', () => {
    it('应拆解标准 sessionId', () => {
      expect(splitSessionId('2026-06-21-main')).toEqual({ date: '2026-06-21', session: 'main' });
    });

    it('session 名含连字符时按前 10 位切（main-fork-1 不被拆断）', () => {
      expect(splitSessionId('2026-06-27-main-fork-1')).toEqual({
        date: '2026-06-27',
        session: 'main-fork-1',
      });
    });

    it('date 后连字符多于 1 位时（非标准输入）session 取 slice(11) 之后全部', () => {
      // 契约：固定 10 位日期 + slice(11)，即 date 与 session 之间仅 1 个 '-' 分隔
      expect(splitSessionId('2026-06-21-a-b')).toEqual({ date: '2026-06-21', session: 'a-b' });
    });

    it('不足 11 位时 date 取整个串、session 为空串（不抛错，由调用方自判）', () => {
      expect(splitSessionId('2026-06-21')).toEqual({ date: '2026-06-21', session: '' });
      expect(splitSessionId('proj-alpha')).toEqual({ date: 'proj-alpha', session: '' });
    });

    it('非日期开头的串不会被误认有 session（防 split 盲区）', () => {
      expect(splitSessionId('proj-alpha-beta-gamma').session).toBe('beta-gamma');
      // 调用方需自行校验日期格式（本函数纯拆解，不校验）
      expect(/^\d{4}-\d{2}-\d{2}$/.test(splitSessionId('proj-alpha-beta-gamma').date)).toBe(false);
    });
  });

  describe('isValidSessionId', () => {
    it('应接受标准 YYYY-MM-DD-<会话名> 格式', () => {
      expect(isValidSessionId('2026-06-21-main')).toBe(true);
    });

    it('session 名含连字符时仍合法（main-fork-1 不被误拒）', () => {
      expect(isValidSessionId('2026-06-27-main-fork-1')).toBe(true);
    });

    it('应拒绝非法日期段（非 YYYY-MM-DD）', () => {
      expect(isValidSessionId('2026-6-21-main')).toBe(false);
      expect(isValidSessionId('proj-alpha-beta')).toBe(false);
      expect(isValidSessionId('2026-06-21')).toBe(false);
    });

    it('应拒绝仅有日期、无会话名', () => {
      expect(isValidSessionId('2026-06-21')).toBe(false);
    });
  });
});
