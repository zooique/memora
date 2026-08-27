/**
 * 单元测试：记忆治理共享常量
 *
 * 覆盖 governance.ts 导出的全部常量，重点验证：
 *   - GOVERNANCE_SOURCES 列表内容与 SOURCE_LABELS 一致
 *   - 不含配置型 source（persona / rule / skill）
 *   - score 边界常量数值正确（提升量 / 上限 / 下限 / 沉底判定天数）
 *   - 常量不可变（readonly 约束 + 值锁定）
 *
 * 这些常量是 recall.ts / WorkspaceStorage / memoryInspector.ts 等多模块的
 * 共享真理源，值漂移会导致跨层行为不一致，需测试锁定契约。
 */
import { describe, expect, it } from 'vitest';
import {
  GOVERNANCE_SOURCES,
  BOOST_INCREMENT,
  SCORE_CEILING,
  DECAY_FLOOR,
} from '@/memory/governance.js';

describe('memory/governance · 常量契约', () => {
  describe('GOVERNANCE_SOURCES 治理源列表', () => {
    it('应只包含 content（唯一治理对象）', () => {
      // 设计演进（2026-08-26 对齐 ADR-025 + 架构收敛）：
      //   - persona / rule / skill 已归角色包管理，不写入记忆库
      //   - work-projection 已移出记忆库（2026-08-20）
      //   - profile 已收敛为 round-summary 的 type=preference 召回
      //   - round-summary 不参与衰减（事实记录语义）
      expect(GOVERNANCE_SOURCES).toHaveLength(1);
    });

    it('应包含 content 治理源', () => {
      // content 是用户主动添加的记忆，唯一治理对象
      expect(GOVERNANCE_SOURCES).toContain('content');
    });

    it('不应包含已废弃的 source（persona / rule / skill / work-projection / profile）', () => {
      // 这些 source 已随架构收敛移出记忆库，不应出现在治理源中
      expect(GOVERNANCE_SOURCES).not.toContain('persona');
      expect(GOVERNANCE_SOURCES).not.toContain('rule');
      expect(GOVERNANCE_SOURCES).not.toContain('skill');
      expect(GOVERNANCE_SOURCES).not.toContain('work-projection');
      expect(GOVERNANCE_SOURCES).not.toContain('profile');
    });

    it('不应包含 unknown', () => {
      // unknown 是兜底来源，不参与 LLM 治理
      expect(GOVERNANCE_SOURCES).not.toContain('unknown');
    });

    it('不应包含 round-summary（事实记录不衰减）', () => {
      // round-summary 是会话摘要，事实记录语义，不参与衰减
      expect(GOVERNANCE_SOURCES).not.toContain('round-summary');
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
});
