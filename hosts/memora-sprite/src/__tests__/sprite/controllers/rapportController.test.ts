/**
 * RapportController 单元测试 — 默契度推导全分支覆盖
 *
 * 测试覆盖：
 *   - deriveRapport 所有等级分支
 *   - calculateTrust 边界值
 *   - calculateFamiliarity 三信号加权
 *   - determineLevel 组合判定
 *   - buildRapportPrompt 格式
 *   - describeLevel 边界值
 *   - updateOptions 部分/全量/空更新
 *   - 构造函数默认值
 *
 * 设计原则：
 *   - 测试文件使用 import type 分离类型导入
 *   - 禁止 @ts-ignore / as any
 */
import { describe, it, expect } from 'vitest';
import { RapportController } from '../../../sprite/controllers/rapportController.js';
import type { RapportControllerOptions, RapportState } from '../../../sprite/controllers/rapportController.js';

// ─── Mock 工厂 ──────────────────────────────────────────

/** 创建测试用 Memory 对象 */
function makeMemory(overrides: Partial<{ source: string; content: string; name: string }> = {}): Parameters<RapportController['deriveRapport']>[0][number] {
  return {
    id: `mem-${Math.random().toString(36).slice(2, 8)}`,
    source: overrides.source ?? 'profile',
    content: overrides.content ?? '测试内容',
    name: overrides.name ?? '测试记忆',
    score: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    decayScore: 0,
  } as Parameters<RapportController['deriveRapport']>[0][number];
}

/** 创建默认构造选项 */
function makeOptions(overrides: Partial<RapportControllerOptions> = {}): RapportControllerOptions {
  return {
    acceptanceRate: 0.5,
    interactionDays: 0,
    totalMessages: 0,
    sourceDiversity: 0,
    ...overrides,
  };
}

// ─── 测试套件 ────────────────────────────────────────────

describe('RapportController', () => {
  // ─── 1. deriveRapport ──────────────────────────────────

  describe('deriveRapport', () => {
    it('零交互数据时应返回 stranger 等级', () => {
      const controller = new RapportController(makeOptions());
      const result = controller.deriveRapport([]);

      expect(result.level).toBe('stranger');
      expect(result.trust).toBeCloseTo(0.63, 1); // 0.5 / 0.8 = 0.625
      expect(result.familiarity).toBe(0);
    });

    it('高接受率 + 丰富交互历史应返回 close 等级', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.9,
        interactionDays: 30,
        totalMessages: 500,
        sourceDiversity: 5,
      }));
      const memories = [
        makeMemory({ source: 'profile' }),
        makeMemory({ source: 'insight' }),
        makeMemory({ source: 'guardrail' }),
        makeMemory({ source: 'skill' }),
        makeMemory({ source: 'rule' }),
      ];
      const result = controller.deriveRapport(memories);

      expect(result.level).toBe('close');
      expect(result.trust).toBeCloseTo(1, 0); // 0.9 / 0.8 = 1.125 → 1
      expect(result.familiarity).toBeCloseTo(1, 0);
    });

    it('中接受率 + 中交互历史应返回 familiar 等级', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.5,
        interactionDays: 15,
        totalMessages: 200,
        sourceDiversity: 3,
      }));
      const result = controller.deriveRapport([]);

      expect(result.level).toBe('familiar');
    });

    it('低接受率 + 低交互历史应返回 acquaintance 等级', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.3,
        interactionDays: 3,
        totalMessages: 30,
        sourceDiversity: 1,
      }));
      const result = controller.deriveRapport([]);

      expect(result.level).toBe('acquaintance');
    });

    it('trust < 0.2 时应返回 stranger（即使 familiarity 较高）', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.1, // trust = 0.1/0.8 = 0.125 < 0.2
        interactionDays: 15,
        totalMessages: 200,
        sourceDiversity: 3,
      }));
      const result = controller.deriveRapport([]);

      expect(result.level).toBe('stranger');
    });

    it('familiarity < 0.1 时应返回 stranger（即使 trust 较高）', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.9,
        interactionDays: 0,
        totalMessages: 0,
        sourceDiversity: 0,
      }));
      const result = controller.deriveRapport([]);

      expect(result.level).toBe('stranger');
    });

    it('记忆中 source 多样性应补充 sourceDiversity 选项', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.5,
        interactionDays: 10,
        totalMessages: 100,
        sourceDiversity: 1, // 选项只有 1
      }));
      // 记忆中有 3 种不同 source
      const memories = [
        makeMemory({ source: 'profile' }),
        makeMemory({ source: 'insight' }),
        makeMemory({ source: 'guardrail' }),
      ];
      const result = controller.deriveRapport(memories);

      // effectiveDiversity = max(1, 3) = 3，sourceRatio = 3/5 = 0.6
      // familiarity = 0.3 * 10/30 + 0.3 * 100/500 + 0.4 * 0.6 = 0.1 + 0.06 + 0.24 = 0.4
      expect(result.familiarity).toBeCloseTo(0.4, 1);
    });

    it('返回的 trust 和 familiarity 应四舍五入到两位小数', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.555, // trust = 0.555/0.8 = 0.69375
        interactionDays: 7,
        totalMessages: 123,
        sourceDiversity: 2,
      }));
      const result = controller.deriveRapport([]);

      expect(result.trust).toBe(0.69); // Math.round(0.69375 * 100) / 100
      // 验证是 number 且没有多余小数位
      expect(result.trust.toString()).not.toContain('000000');
    });
  });

  // ─── 2. calculateTrust ─────────────────────────────────

  describe('calculateTrust（通过 deriveRapport 间接测试）', () => {
    it('acceptanceRate = 0 时 trust = 0', () => {
      const controller = new RapportController(makeOptions({ acceptanceRate: 0 }));
      const result = controller.deriveRapport([]);
      expect(result.trust).toBe(0);
    });

    it('acceptanceRate = 0.8 时 trust = 1', () => {
      const controller = new RapportController(makeOptions({ acceptanceRate: 0.8 }));
      const result = controller.deriveRapport([]);
      expect(result.trust).toBe(1);
    });

    it('acceptanceRate = 1 时 trust = 1（上限保护）', () => {
      const controller = new RapportController(makeOptions({ acceptanceRate: 1 }));
      const result = controller.deriveRapport([]);
      expect(result.trust).toBe(1);
    });
  });

  // ─── 3. calculateFamiliarity ────────────────────────────

  describe('calculateFamiliarity（通过 deriveRapport 间接测试）', () => {
    it('全部信号为 0 时 familiarity = 0', () => {
      const controller = new RapportController(makeOptions());
      const result = controller.deriveRapport([]);
      expect(result.familiarity).toBe(0);
    });

    it('仅交互天数满时 familiarity = 0.3', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.5,
        interactionDays: 30,
        totalMessages: 0,
        sourceDiversity: 0,
      }));
      const result = controller.deriveRapport([]);
      expect(result.familiarity).toBeCloseTo(0.3, 1);
    });

    it('仅消息数满时 familiarity = 0.3', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.5,
        interactionDays: 0,
        totalMessages: 500,
        sourceDiversity: 0,
      }));
      const result = controller.deriveRapport([]);
      expect(result.familiarity).toBeCloseTo(0.3, 1);
    });

    it('仅 source 多样性满时 familiarity = 0.4', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.5,
        interactionDays: 0,
        totalMessages: 0,
        sourceDiversity: 5,
      }));
      const result = controller.deriveRapport([]);
      expect(result.familiarity).toBeCloseTo(0.4, 1);
    });
  });

  // ─── 4. determineLevel ──────────────────────────────────

  describe('determineLevel（通过 deriveRapport 间接测试）', () => {
    it('trust < 0.2 → stranger', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.1,
        interactionDays: 15,
        totalMessages: 200,
        sourceDiversity: 3,
      }));
      expect(controller.deriveRapport([]).level).toBe('stranger');
    });

    it('familiarity < 0.1 → stranger', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.9,
        interactionDays: 0,
        totalMessages: 0,
        sourceDiversity: 0,
      }));
      expect(controller.deriveRapport([]).level).toBe('stranger');
    });

    it('familiarity < 0.3 → acquaintance', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.5,
        interactionDays: 5,
        totalMessages: 50,
        sourceDiversity: 1,
      }));
      expect(controller.deriveRapport([]).level).toBe('acquaintance');
    });

    it('familiarity < 0.6 → familiar', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.5,
        interactionDays: 10,
        totalMessages: 150,
        sourceDiversity: 2,
      }));
      expect(controller.deriveRapport([]).level).toBe('familiar');
    });

    it('trust < 0.5 → familiar（即使 familiarity 高）', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.35, // trust = 0.35/0.8 = 0.4375 < 0.5
        interactionDays: 30,
        totalMessages: 500,
        sourceDiversity: 5,
      }));
      expect(controller.deriveRapport([]).level).toBe('familiar');
    });

    it('trust ≥ 0.5 且 familiarity ≥ 0.6 → close', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.7,
        interactionDays: 30,
        totalMessages: 500,
        sourceDiversity: 5,
      }));
      expect(controller.deriveRapport([]).level).toBe('close');
    });
  });

  // ─── 5. buildRapportPrompt ──────────────────────────────

  describe('buildRapportPrompt', () => {
    it('应生成包含等级、信任度、熟悉度的提示文本', () => {
      const controller = new RapportController(makeOptions());
      const rapport: RapportState = {
        trust: 0.8,
        familiarity: 0.7,
        level: 'close',
        description: '亲密阶段',
      };
      const prompt = controller.buildRapportPrompt(rapport);

      expect(prompt).toContain('【关系边界指导】');
      expect(prompt).toContain('亲密');
      expect(prompt).toContain('像老朋友一样交流');
      expect(prompt).toContain('预判我的需求');
      expect(prompt).toContain('主动发起话题');
    });

    it('stranger 等级应显示"初识"', () => {
      const controller = new RapportController(makeOptions());
      const rapport: RapportState = {
        trust: 0.1,
        familiarity: 0,
        level: 'stranger',
        description: '初识阶段',
      };
      const prompt = controller.buildRapportPrompt(rapport);

      expect(prompt).toContain('初识');
      expect(prompt).toContain('礼貌用语');
      expect(prompt).toContain('保持克制');
    });

    it('acquaintance 等级应显示"相识"', () => {
      const controller = new RapportController(makeOptions());
      const rapport: RapportState = {
        trust: 0.4,
        familiarity: 0.2,
        level: 'acquaintance',
        description: '相识阶段',
      };
      const prompt = controller.buildRapportPrompt(rapport);

      expect(prompt).toContain('相识');
      expect(prompt).toContain('自然交流');
      expect(prompt).toContain('合理推断');
    });

    it('familiar 等级应显示"熟悉"', () => {
      const controller = new RapportController(makeOptions());
      const rapport: RapportState = {
        trust: 0.6,
        familiarity: 0.5,
        level: 'familiar',
        description: '熟悉阶段',
      };
      const prompt = controller.buildRapportPrompt(rapport);

      expect(prompt).toContain('熟悉');
      expect(prompt).toContain('轻松自然');
      expect(prompt).toContain('直接利用已知偏好');
    });
  });

  // ─── 6. describeLevel ───────────────────────────────────

  describe('describeLevel', () => {
    it('value < 0.33 → 低', () => {
      expect(RapportController.describeLevel(0)).toBe('低');
      expect(RapportController.describeLevel(0.32)).toBe('低');
    });

    it('0.33 ≤ value < 0.67 → 中', () => {
      expect(RapportController.describeLevel(0.33)).toBe('中');
      expect(RapportController.describeLevel(0.5)).toBe('中');
      expect(RapportController.describeLevel(0.66)).toBe('中');
    });

    it('value ≥ 0.67 → 高', () => {
      expect(RapportController.describeLevel(0.67)).toBe('高');
      expect(RapportController.describeLevel(1)).toBe('高');
    });
  });

  // ─── 7. updateOptions ───────────────────────────────────

  describe('updateOptions', () => {
    it('部分更新应只修改指定字段', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.5,
        interactionDays: 10,
      }));

      controller.updateOptions({ acceptanceRate: 0.8 });

      // 验证通过 deriveRapport 间接确认 acceptanceRate 已更新
      const result = controller.deriveRapport([]);
      expect(result.trust).toBe(1); // 0.8 / 0.8 = 1
    });

    it('全量更新应覆盖所有字段', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.3,
        interactionDays: 5,
        totalMessages: 50,
        sourceDiversity: 1,
      }));

      controller.updateOptions({
        acceptanceRate: 0.9,
        interactionDays: 30,
        totalMessages: 500,
        sourceDiversity: 5,
      });

      const result = controller.deriveRapport([]);
      expect(result.level).toBe('close');
    });

    it('空更新应不影响现有状态', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.5,
        interactionDays: 10,
      }));

      const before = controller.deriveRapport([]);
      controller.updateOptions({});
      const after = controller.deriveRapport([]);

      expect(after.trust).toBe(before.trust);
      expect(after.familiarity).toBe(before.familiarity);
    });
  });

  // ─── 8. 构造函数 ────────────────────────────────────────

  describe('构造函数', () => {
    it('应使用传入的选项初始化', () => {
      const controller = new RapportController(makeOptions({
        acceptanceRate: 0.7,
        interactionDays: 20,
        totalMessages: 300,
        sourceDiversity: 4,
      }));

      const result = controller.deriveRapport([]);
      // trust = 0.7/0.8 = 0.875, familiarity = 0.3*20/30 + 0.3*300/500 + 0.4*4/5 = 0.7
      // trust ≥ 0.5 且 familiarity ≥ 0.6 → close
      expect(result.level).toBe('close');
    });
  });
});