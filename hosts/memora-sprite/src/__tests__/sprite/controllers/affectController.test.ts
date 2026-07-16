/**
 * AffectController 单元测试
 *
 * 覆盖范围：
 * - describeLevel：低/中/高 三档边界值
 * - buildAffectPrompt：四维格式 + 全高/全低极端值
 * - deriveAffect：空记忆默认值 / profile 温暖度 / 简洁偏好直接度 / 接受率主动度 / persona traits 调皮度 / 四舍五入
 * - updateOptions：部分更新 / 全量更新 / 空更新
 * - 构造函数：默认值传递
 *
 * 测试策略（对齐 proactiveEngine.test.ts 范式）：
 * - 纯业务逻辑测试，无 I/O、无 LLM、无 DOM
 * - 通过 setLogger 注入 mock logger（避免 pino 日志输出污染测试）
 * - 禁止 @ts-ignore / as any
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AffectController } from '../../../sprite/controllers/affectController.js';
import type { AffectState } from '../../../sprite/controllers/affectController.js';
import type { Memory, Persona } from 'memora';
import { setLogger } from 'memora';
import type { ILogger } from 'memora';

// ─── Mock 工厂 ──────────────────────────────────────────

/** 创建 Mock ILogger（静默日志输出） */
function createMockLogger(): ILogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** 创建测试用 Memory 对象 */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:default',
    content: 'test content',
    source: 'test',
    name: 'default',
    createdAt: '2024-01-01T00:00:00.000Z',
    accessedAt: '2024-01-01T00:00:00.000Z',
    score: 0.5,
    ...overrides,
  };
}

/** 创建测试用 Persona 对象 */
function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    name: 'test-persona',
    id: 'persona:test-persona',
    keywords: ['test'],
    content: '测试角色',
    filePath: '/test/persona.md',
    ...overrides,
  };
}

// ─── Setup ──────────────────────────────────────────────

beforeEach(() => {
  // 注入 mock logger 避免 pino 日志输出污染测试
  setLogger(createMockLogger());
});

// ─── describeLevel ──────────────────────────────────────

describe('describeLevel', () => {
  it('value < 0.33 返回"低"', () => {
    expect(AffectController.describeLevel(0)).toBe('低');
    expect(AffectController.describeLevel(0.1)).toBe('低');
    expect(AffectController.describeLevel(0.32)).toBe('低');
  });

  it('0.33 <= value < 0.67 返回"中"', () => {
    expect(AffectController.describeLevel(0.33)).toBe('中');
    expect(AffectController.describeLevel(0.5)).toBe('中');
    expect(AffectController.describeLevel(0.66)).toBe('中');
  });

  it('value >= 0.67 返回"高"', () => {
    expect(AffectController.describeLevel(0.67)).toBe('高');
    expect(AffectController.describeLevel(0.8)).toBe('高');
    expect(AffectController.describeLevel(1)).toBe('高');
  });

  it('value > 1 仍返回"高"（超出范围不崩溃）', () => {
    expect(AffectController.describeLevel(1.5)).toBe('高');
    expect(AffectController.describeLevel(999)).toBe('高');
  });

  it('负值返回"低"（超出范围不崩溃）', () => {
    expect(AffectController.describeLevel(-0.5)).toBe('低');
  });
});

// ─── buildAffectPrompt ──────────────────────────────────

describe('buildAffectPrompt', () => {
  it('生成四维中文格式', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const affect: AffectState = {
      warmth: 0.8,
      playfulness: 0.3,
      directness: 0.5,
      initiative: 0.6,
    };
    const prompt = controller.buildAffectPrompt(affect);
    expect(prompt).toContain('【互动基调指导】');
    expect(prompt).toContain('语气');
    expect(prompt).toContain('温暖亲切');
    expect(prompt).toContain('风格');
    expect(prompt).toContain('平衡表达');
    expect(prompt).toContain('主动');
    expect(prompt).toContain('适度主动');
    expect(prompt).toContain('趣味');
    expect(prompt).toContain('保持严谨');
  });

  it('全低值', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const affect: AffectState = {
      warmth: 0,
      playfulness: 0,
      directness: 0,
      initiative: 0.1,
    };
    const prompt = controller.buildAffectPrompt(affect);
    expect(prompt).toContain('【互动基调指导】');
    expect(prompt).toContain('礼貌克制');
    expect(prompt).toContain('委婉耐心');
    expect(prompt).toContain('等待用户明确指令');
    expect(prompt).toContain('保持严谨');
  });

  it('全高值', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const affect: AffectState = {
      warmth: 1,
      playfulness: 1,
      directness: 1,
      initiative: 1,
    };
    const prompt = controller.buildAffectPrompt(affect);
    expect(prompt).toContain('【互动基调指导】');
    expect(prompt).toContain('温暖亲切');
    expect(prompt).toContain('直奔主题');
    expect(prompt).toContain('主动追问');
    expect(prompt).toContain('适度幽默');
  });
});

// ─── deriveAffect ───────────────────────────────────────

describe('deriveAffect', () => {
  it('空记忆列表返回默认值', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const result = controller.deriveAffect([]);
    expect(result).toEqual({
      warmth: 0.5,
      playfulness: 0.3,
      directness: 0.5,
      initiative: 0.5,
    });
  });

  it('温暖度随 profile 数量线性增长', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    // 10 条 profile → warmth = 10/20 = 0.5
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({ id: `profile:${i}`, source: 'profile' }),
    );
    const result = controller.deriveAffect(memories);
    expect(result.warmth).toBe(0.5);
  });

  it('温暖度上限为 1（20 条 profile）', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const memories = Array.from({ length: 20 }, (_, i) =>
      makeMemory({ id: `profile:${i}`, source: 'profile' }),
    );
    const result = controller.deriveAffect(memories);
    expect(result.warmth).toBe(1);
  });

  it('温暖度不超过 1（超过 20 条 profile）', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const memories = Array.from({ length: 50 }, (_, i) =>
      makeMemory({ id: `profile:${i}`, source: 'profile' }),
    );
    const result = controller.deriveAffect(memories);
    expect(result.warmth).toBe(1);
  });

  it('非 profile 记忆不影响温暖度', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const memories = Array.from({ length: 30 }, (_, i) =>
      makeMemory({ id: `insight:${i}`, source: 'insight' }),
    );
    const result = controller.deriveAffect(memories);
    expect(result.warmth).toBe(0); // 无 profile 记忆
  });

  it('检测到"简洁"偏好 → directness = 0.8', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const memories = [
      makeMemory({ id: 'profile:1', source: 'profile', content: '用户偏好简洁的回复风格' }),
    ];
    const result = controller.deriveAffect(memories);
    expect(result.directness).toBe(0.8);
  });

  it('检测到"直接"偏好 → directness = 0.8', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const memories = [
      makeMemory({ id: 'profile:1', source: 'profile', content: '用户喜欢直接的沟通方式' }),
    ];
    const result = controller.deriveAffect(memories);
    expect(result.directness).toBe(0.8);
  });

  it('检测到"简短"偏好 → directness = 0.8', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const memories = [
      makeMemory({ id: 'profile:1', source: 'profile', content: '用户要求回答简短' }),
    ];
    const result = controller.deriveAffect(memories);
    expect(result.directness).toBe(0.8);
  });

  it('无简洁偏好 → directness = 0.5', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const memories = [
      makeMemory({ id: 'profile:1', source: 'profile', content: '用户喜欢详细的解释' }),
    ];
    const result = controller.deriveAffect(memories);
    expect(result.directness).toBe(0.5);
  });

  it('非 profile 记忆中的"简洁"不触发偏好检测', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const memories = [
      makeMemory({ id: 'insight:1', source: 'insight', content: '简洁是关键' }),
    ];
    const result = controller.deriveAffect(memories);
    expect(result.directness).toBe(0.5); // insight 不计入偏好检测
  });

  it('initiative 来自 options.acceptanceRate', () => {
    const controller = new AffectController({ acceptanceRate: 0.75 });
    const result = controller.deriveAffect([]);
    expect(result.initiative).toBe(0.75);
  });

  it('initiative 默认 0.5', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const result = controller.deriveAffect([]);
    expect(result.initiative).toBe(0.5);
  });

  it('playfulness 来自 persona.traits.playfulness', () => {
    const persona = makePersona({ traits: { playfulness: 0.9 } });
    const controller = new AffectController({
      acceptanceRate: 0.5,
      currentPersona: persona,
    });
    const result = controller.deriveAffect([]);
    expect(result.playfulness).toBe(0.9);
  });

  it('playfulness 默认 0.3（无 persona）', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const result = controller.deriveAffect([]);
    expect(result.playfulness).toBe(0.3);
  });

  it('playfulness 默认 0.3（persona 无 traits）', () => {
    const persona = makePersona({ traits: undefined });
    const controller = new AffectController({
      acceptanceRate: 0.5,
      currentPersona: persona,
    });
    const result = controller.deriveAffect([]);
    expect(result.playfulness).toBe(0.3);
  });

  it('playfulness 默认 0.3（persona.traits 无 playfulness 键）', () => {
    const persona = makePersona({ traits: { warmth: 0.7 } });
    const controller = new AffectController({
      acceptanceRate: 0.5,
      currentPersona: persona,
    });
    const result = controller.deriveAffect([]);
    expect(result.playfulness).toBe(0.3);
  });

  it('四舍五入到 2 位小数', () => {
    const controller = new AffectController({ acceptanceRate: 0.333 });
    const result = controller.deriveAffect([]);
    // 0.333 → Math.round(0.333 * 100) / 100 = 33.3 / 100 = 0.33
    expect(result.initiative).toBe(0.33);
  });
});

// ─── updateOptions ──────────────────────────────────────

describe('updateOptions', () => {
  it('更新 acceptanceRate', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    controller.updateOptions({ acceptanceRate: 0.8 });
    const result = controller.deriveAffect([]);
    expect(result.initiative).toBe(0.8);
  });

  it('更新 currentPersona', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const persona = makePersona({ traits: { playfulness: 0.7 } });
    controller.updateOptions({ currentPersona: persona });
    const result = controller.deriveAffect([]);
    expect(result.playfulness).toBe(0.7);
  });

  it('同时更新 acceptanceRate 和 currentPersona', () => {
    const controller = new AffectController({ acceptanceRate: 0.5 });
    const persona = makePersona({ traits: { playfulness: 0.6 } });
    controller.updateOptions({ acceptanceRate: 0.9, currentPersona: persona });
    const result = controller.deriveAffect([]);
    expect(result.initiative).toBe(0.9);
    expect(result.playfulness).toBe(0.6);
  });

  it('空更新不影响已有值', () => {
    const controller = new AffectController({ acceptanceRate: 0.7 });
    controller.updateOptions({});
    const result = controller.deriveAffect([]);
    expect(result.initiative).toBe(0.7);
  });
});

// ─── 构造函数 ────────────────────────────────────────────

describe('构造函数', () => {
  it('传递 acceptanceRate', () => {
    const controller = new AffectController({ acceptanceRate: 0.6 });
    const result = controller.deriveAffect([]);
    expect(result.initiative).toBe(0.6);
  });

  it('传递 currentPersona', () => {
    const persona = makePersona({ traits: { playfulness: 0.8 } });
    const controller = new AffectController({
      acceptanceRate: 0.5,
      currentPersona: persona,
    });
    const result = controller.deriveAffect([]);
    expect(result.playfulness).toBe(0.8);
  });
});

// ─── blendAffect（EWMA 平滑融合，持续对话用） ────────────────

describe('blendAffect', () => {
  const base: AffectState = {
    warmth: 0.5,
    playfulness: 0.3,
    directness: 0.5,
    initiative: 0.5,
  };

  it('应使用 EWMA 平滑（α=0.2）稀释 delta', () => {
    // warmth: 0.5 * 0.8 + (0.5 + 0.15) * 0.2 = 0.4 + 0.13 = 0.53
    const result = AffectController.blendAffect(base, { warmth: 0.15 });
    expect(result.warmth).toBe(0.53);
  });

  it('delta 为 undefined 时应保持原值不变', () => {
    const result = AffectController.blendAffect(base, {});
    expect(result.warmth).toBe(0.5);
    expect(result.directness).toBe(0.5);
    expect(result.initiative).toBe(0.5);
  });

  it('调皮度应保持不变（由 persona 决定）', () => {
    const result = AffectController.blendAffect(base, { warmth: 0.2 });
    expect(result.playfulness).toBe(0.3);
  });
});

// ─── applyDelta（直接应用 delta，冷启动专用） ────────────────

describe('applyDelta', () => {
  const base: AffectState = {
    warmth: 0.5,
    playfulness: 0.3,
    directness: 0.5,
    initiative: 0.5,
  };

  it('应直接应用 delta（不做平滑稀释）', () => {
    // warmth: 0.5 + 0.15 = 0.65（对比 blendAffect 的 0.53）
    const result = AffectController.applyDelta(base, { warmth: 0.15 });
    expect(result.warmth).toBe(0.65);
  });

  it('delta 为 undefined 时应保持原值不变', () => {
    const result = AffectController.applyDelta(base, {});
    expect(result.warmth).toBe(0.5);
    expect(result.directness).toBe(0.5);
    expect(result.initiative).toBe(0.5);
  });

  it('应 clamp 到 0-1 范围（上界）', () => {
    // warmth: 0.5 + 0.8 = 1.3 → clamp 到 1
    const result = AffectController.applyDelta(base, { warmth: 0.8 });
    expect(result.warmth).toBe(1);
  });

  it('应 clamp 到 0-1 范围（下界）', () => {
    // warmth: 0.5 - 0.8 = -0.3 → clamp 到 0
    const result = AffectController.applyDelta(base, { warmth: -0.8 });
    expect(result.warmth).toBe(0);
  });

  it('调皮度应保持不变（由 persona 决定）', () => {
    const result = AffectController.applyDelta(base, { warmth: 0.2 });
    expect(result.playfulness).toBe(0.3);
  });
});