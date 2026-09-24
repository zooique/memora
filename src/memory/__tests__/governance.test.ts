/**
 * 单元测试：记忆治理共享常量
 *
 * 覆盖 governance.ts 导出的全部常量，重点验证：
 *   - GOVERNANCE_SOURCES 治理源为空（记忆库唯一自动轨 round-summary 不入治理源，
 *     其治理由 superseded 写时取代承担；content 历史残留 source 已清空）
 *   - 不含配置型 source（persona / rule / skill）
 *   - 常量不可变（readonly 约束 + 值锁定）
 *
 * 注：无 score 边界常量（BOOST_INCREMENT / SCORE_CEILING / SCORE_FLOOR 均不存在——
 * score 不参与排序），本文件不承载对应契约。
 */
import { describe, expect, it } from 'vitest';
import { GOVERNANCE_SOURCES } from '@/memory/governance.js';

describe('memory/governance · 常量契约', () => {
  describe('GOVERNANCE_SOURCES 治理源列表', () => {
    it('应为空（记忆库无独立治理源）', () => {
      // 各 source 的归属：
      //   - persona / rule / skill 归角色包管理，不写入记忆库
      //   - work-projection 不入记忆库
      //   - profile 由 round-summary 的 type=preference 召回承载
      //   - round-summary 不参与治理（事实记录语义，superseded 写时取代承载）
      //   - content 无生产写入路径（历史残留 source）
      expect(GOVERNANCE_SOURCES).toHaveLength(0);
    });

    it('不应包含停用 source（content / persona / rule / skill / work-projection / profile）', () => {
      // 这些 source 不在治理范围，不应出现在治理源中
      expect(GOVERNANCE_SOURCES).not.toContain('content');
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

    it('不应包含 round-summary（事实记录语义，治理由 superseded 取代承担）', () => {
      expect(GOVERNANCE_SOURCES).not.toContain('round-summary');
    });
  });
});