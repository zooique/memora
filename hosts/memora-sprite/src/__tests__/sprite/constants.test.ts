/**
 * constants 单元测试
 *
 * 覆盖范围：
 * - 时间常量 MS_PER_* 值正确 + 倍数关系
 * - 路径常量 SPRITE_HOME_DIR_NAME
 * - 业务默认值 DEFAULT_LIST_LIMIT / DEFAULT_MAX_ENTRIES
 * - Toast 时长递增关系
 * - UI 超时常量存在且为正数
 * - getLocalDate() 格式 + 补零 + 与 new Date() 一致
 *
 * 测试策略：
 * - 零 mock，纯值验证
 * - getLocalDate() 使用 vi.useFakeTimers + vi.setSystemTime 验证补零逻辑
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  MS_PER_SECOND,
  MS_PER_MINUTE,
  MS_PER_HOUR,
  MS_PER_DAY,
  MS_PER_WEEK,
  SPRITE_HOME_DIR_NAME,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_ENTRIES,
  TOAST_SHORT_MS,
  TOAST_NORMAL_MS,
  TOAST_LONG_MS,
  CONFIRMATION_TIMEOUT_MS,
  PROACTIVE_TRAY_RESET_MS,
  DASHBOARD_PULSE_MS,
  DASHBOARD_DEBOUNCE_MS,
  getLocalDate,
} from '../../sprite/constants.js';

describe('constants', () => {
  // ─── 常量值验证（6 测试） ──────────────────────────────

  describe('常量值验证', () => {
    it('时间常量 MS_PER_* 值正确', () => {
      expect(MS_PER_SECOND).toBe(1_000);
      expect(MS_PER_MINUTE).toBe(60_000);
      expect(MS_PER_HOUR).toBe(3_600_000);
      expect(MS_PER_DAY).toBe(86_400_000);
      expect(MS_PER_WEEK).toBe(604_800_000);
    });

    it('SPRITE_HOME_DIR_NAME 为 .memora-sprite', () => {
      expect(SPRITE_HOME_DIR_NAME).toBe('.memora-sprite');
    });

    it('DEFAULT_LIST_LIMIT 和 DEFAULT_MAX_ENTRIES 均为 1000', () => {
      expect(DEFAULT_LIST_LIMIT).toBe(1000);
      expect(DEFAULT_MAX_ENTRIES).toBe(1000);
    });

    it('Toast 时长递增：TOAST_SHORT < TOAST_NORMAL < TOAST_LONG', () => {
      expect(TOAST_SHORT_MS).toBeLessThan(TOAST_NORMAL_MS);
      expect(TOAST_NORMAL_MS).toBeLessThan(TOAST_LONG_MS);
    });

    it('UI 超时常量存在且为正数', () => {
      expect(CONFIRMATION_TIMEOUT_MS).toBeGreaterThan(0);
      expect(PROACTIVE_TRAY_RESET_MS).toBeGreaterThan(0);
      expect(DASHBOARD_PULSE_MS).toBeGreaterThan(0);
      expect(DASHBOARD_DEBOUNCE_MS).toBeGreaterThan(0);
    });

    it('时间常量倍数关系正确', () => {
      // 分钟 = 60 秒
      expect(MS_PER_MINUTE).toBe(60 * MS_PER_SECOND);
      // 小时 = 60 分钟
      expect(MS_PER_HOUR).toBe(60 * MS_PER_MINUTE);
      // 天 = 24 小时
      expect(MS_PER_DAY).toBe(24 * MS_PER_HOUR);
      // 周 = 7 天
      expect(MS_PER_WEEK).toBe(7 * MS_PER_DAY);
    });
  });

  // ─── getLocalDate（4 测试） ────────────────────────────

  describe('getLocalDate', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('格式为 YYYY-MM-DD（正则匹配）', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 6, 12)); // 2026-07-12
      expect(getLocalDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('月份补零（1-9 月前导零）', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 2, 15)); // 2026-03-15（3 月）
      expect(getLocalDate()).toBe('2026-03-15');
    });

    it('日期补零（1-9 日前导零）', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 10, 5)); // 2026-11-05（5 日）
      expect(getLocalDate()).toBe('2026-11-05');
    });

    it('返回今天日期（与 new Date() 计算一致）', () => {
      // 使用真实时间验证一致性
      const d = new Date();
      const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      expect(getLocalDate()).toBe(expected);
    });
  });
});
