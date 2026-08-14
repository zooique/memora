/**
 * 单元测试：记忆治理共享常量
 *
 * 覆盖 governance.ts 导出的全部常量，重点验证：
 *   - GOVERNANCE_SOURCES 列表内容与 SOURCE_LABELS 一致
 *   - 不含配置型 source（persona / rule / skill）
 *   - score 边界常量数值正确（提升量 / 上限 / 下限）
 *   - 衰减常量数值正确（天数阈值 / 衰减量）
 *   - 常量不可变（readonly 约束 + 值锁定）
 *
 * 这些常量是 recall.ts / sqliteStorage.ts / memoryInspector.ts 等多模块的
 * 共享真理源，值漂移会导致跨层行为不一致，需测试锁定契约。
 */
import { describe, expect, it } from 'vitest';
import {
  GOVERNANCE_SOURCES,
  BOOST_INCREMENT,
  SCORE_CEILING,
  DECAY_FLOOR,
  DECAY_AGE_DAYS,
  DECAY_AMOUNT,
} from '@/memory/governance.js';
import { SOURCE_LABELS } from '@/memory/types.js';

describe('memory/governance · 常量契约', () => {
  describe('GOVERNANCE_SOURCES 治理源列表', () => {
    it('应包含 PROFILE / WORK_PROJECTION 两个 source', () => {
      expect(GOVERNANCE_SOURCES).toHaveLength(2);
      expect(GOVERNANCE_SOURCES).toContain(SOURCE_LABELS.PROFILE);
      expect(GOVERNANCE_SOURCES).toContain(SOURCE_LABELS.WORK_PROJECTION);
    });

    it('应与 SOURCE_LABELS 的字符串值对齐', () => {
      // 锁定具体字符串值，防止 SOURCE_LABELS 重命名后治理范围漂移
      expect([...GOVERNANCE_SOURCES]).toEqual(['profile', 'work-projection']);
    });

    it('不应包含配置型 source（persona / rule / skill）', () => {
      // 配置型记忆是启动时加载的永驻记忆，不参与运行时治理
      expect(GOVERNANCE_SOURCES).not.toContain('persona');
      expect(GOVERNANCE_SOURCES).not.toContain('rule');
      expect(GOVERNANCE_SOURCES).not.toContain('skill');
    });

    it('不应包含 guardrail / unknown', () => {
      // guardrail 是护栏规则，unknown 是兜底来源，均不参与 LLM 治理
      expect(GOVERNANCE_SOURCES).not.toContain('guardrail');
      expect(GOVERNANCE_SOURCES).not.toContain('unknown');
    });
  });

  describe('score 边界常量', () => {
    it('BOOST_INCREMENT 应为 0.05（越常用越重要）', () => {
      expect(BOOST_INCREMENT).toBe(0.05);
    });

    it('SCORE_CEILING 应为 1.0（boost 上限）', () => {
      expect(SCORE_CEILING).toBe(1.0);
    });

    it('DECAY_FLOOR 应为 0.1（衰减下限）', () => {
      expect(DECAY_FLOOR).toBe(0.1);
    });

    it('BOOST_INCREMENT 应小于 SCORE_CEILING（提升量不会一步到顶）', () => {
      // 契约约束：单次 boost 不应超过上限，否则 clamp 逻辑无意义
      expect(BOOST_INCREMENT).toBeLessThan(SCORE_CEILING);
    });

    it('DECAY_FLOOR 应小于 SCORE_CEILING（下限低于上限）', () => {
      expect(DECAY_FLOOR).toBeLessThan(SCORE_CEILING);
    });

    it('DECAY_FLOOR 应为正数（score 不会衰减到负数）', () => {
      expect(DECAY_FLOOR).toBeGreaterThan(0);
    });
  });

  describe('衰减常量', () => {
    it('DECAY_AGE_DAYS 应为 7（超过 7 天才开始衰减）', () => {
      expect(DECAY_AGE_DAYS).toBe(7);
    });

    it('DECAY_AMOUNT 应为 0.02（每周期衰减 2%）', () => {
      expect(DECAY_AMOUNT).toBe(0.02);
    });

    it('DECAY_AMOUNT 应小于 DECAY_FLOOR（单次衰减不会击穿下限）', () => {
      // 契约约束：单周期衰减量应小于下限，否则首周期即触底
      expect(DECAY_AMOUNT).toBeLessThan(DECAY_FLOOR);
    });

    it('DECAY_AGE_DAYS 应为正整数（天数语义）', () => {
      expect(DECAY_AGE_DAYS).toBeGreaterThan(0);
      expect(Number.isInteger(DECAY_AGE_DAYS)).toBe(true);
    });
  });
});
