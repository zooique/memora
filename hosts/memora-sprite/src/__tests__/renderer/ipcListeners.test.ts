/**
 * IPC 监听器类型守卫纯函数测试
 *
 * 覆盖范围：
 * - isObject：非 null 对象类型守卫（替代 as Record<string, unknown> 断言）
 * - isProactivePromptPayload：主动提示 payload 结构校验
 * - isProjectSwitchedPayload：项目切换 payload 结构校验
 * - isSkillMatchedPayload：技能匹配 payload 结构校验
 * - isMemoryRecalledPayload：记忆召回 payload 结构校验
 * - isDecayCompletedPayload：记忆衰减完成 payload 结构校验
 *
 * 这些类型守卫是 IPC 事件分发的安全边界，确保 unknown payload 字段类型正确，
 * 避免运行时错误。对齐 markdown.ts isSafeUrl 提取模式。
 *
 * 纯逻辑测试，无 JSDOM 依赖。
 */
import { describe, it, expect } from 'vitest';
import {
  isObject,
  isProactivePromptPayload,
  isProjectSwitchedPayload,
  isSkillMatchedPayload,
  isMemoryRecalledPayload,
  isDecayCompletedPayload,
} from '../../electron/renderer/ipcListeners.js';

// ─── isObject ─────────────────────────────────────────────

describe('isObject', () => {
  it('普通对象应返回 true', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
  });

  it('数组应返回 true（typeof [] === "object"）', () => {
    expect(isObject([])).toBe(true);
  });

  it('null 应返回 false（typeof null === "object" 但需显式排除）', () => {
    expect(isObject(null)).toBe(false);
  });

  it('原始类型应返回 false', () => {
    expect(isObject(undefined)).toBe(false);
    expect(isObject('string')).toBe(false);
    expect(isObject(123)).toBe(false);
    expect(isObject(true)).toBe(false);
    expect(isObject(Symbol('s'))).toBe(false);
  });
});

// ─── isProactivePromptPayload ─────────────────────────────

describe('isProactivePromptPayload', () => {
  /** 合法 payload 工厂 */
  const validPayload = () => ({
    prompt: '建议你休息一下',
    triggers: ['长时间工作', '连续编码'],
    silent: false,
  });

  it('合法 payload 应返回 true', () => {
    expect(isProactivePromptPayload(validPayload())).toBe(true);
  });

  it('silent=true 应返回 true（静默模式合法）', () => {
    const payload = { ...validPayload(), silent: true };
    expect(isProactivePromptPayload(payload)).toBe(true);
  });

  it('triggers 空数组应返回 true（无触发原因合法）', () => {
    const payload = { ...validPayload(), triggers: [] };
    expect(isProactivePromptPayload(payload)).toBe(true);
  });

  it('prompt 非字符串应返回 false', () => {
    const payload = { ...validPayload(), prompt: 123 };
    expect(isProactivePromptPayload(payload)).toBe(false);
  });

  it('triggers 非数组应返回 false', () => {
    const payload = { ...validPayload(), triggers: '长时间工作' };
    expect(isProactivePromptPayload(payload)).toBe(false);
  });

  it('triggers 含非字符串元素应返回 false', () => {
    const payload = { ...validPayload(), triggers: ['合法', 123] };
    expect(isProactivePromptPayload(payload)).toBe(false);
  });

  it('silent 非布尔应返回 false', () => {
    const payload = { ...validPayload(), silent: 'yes' };
    expect(isProactivePromptPayload(payload)).toBe(false);
  });

  it('null 应返回 false', () => {
    expect(isProactivePromptPayload(null)).toBe(false);
  });

  it('缺少字段应返回 false', () => {
    expect(isProactivePromptPayload({ prompt: 'hi' })).toBe(false);
  });
});

// ─── isProjectSwitchedPayload ─────────────────────────────

describe('isProjectSwitchedPayload', () => {
  it('合法 payload 应返回 true', () => {
    expect(isProjectSwitchedPayload({ projectName: 'memora' })).toBe(true);
  });

  it('projectName 非字符串应返回 false', () => {
    expect(isProjectSwitchedPayload({ projectName: 123 })).toBe(false);
  });

  it('缺少 projectName 应返回 false', () => {
    expect(isProjectSwitchedPayload({ name: 'memora' })).toBe(false);
  });

  it('null 应返回 false', () => {
    expect(isProjectSwitchedPayload(null)).toBe(false);
  });
});

// ─── isSkillMatchedPayload ────────────────────────────────

describe('isSkillMatchedPayload', () => {
  it('合法 payload 应返回 true', () => {
    expect(isSkillMatchedPayload({ skill: '代码审查', score: 0.95 })).toBe(true);
  });

  it('score 为 0 应返回 true（合法边界）', () => {
    expect(isSkillMatchedPayload({ skill: '测试', score: 0 })).toBe(true);
  });

  it('skill 非字符串应返回 false', () => {
    expect(isSkillMatchedPayload({ skill: 123, score: 0.9 })).toBe(false);
  });

  it('score 非数字应返回 false', () => {
    expect(isSkillMatchedPayload({ skill: '测试', score: '0.9' })).toBe(false);
  });

  it('NaN score 应返回 true（typeof NaN === "number"，运行时由调用方校验）', () => {
    // 类型守卫仅校验类型，不校验值范围；NaN 是 number 类型
    expect(isSkillMatchedPayload({ skill: '测试', score: NaN })).toBe(true);
  });

  it('缺少字段应返回 false', () => {
    expect(isSkillMatchedPayload({ skill: '测试' })).toBe(false);
  });
});

// ─── isMemoryRecalledPayload ──────────────────────────────

describe('isMemoryRecalledPayload', () => {
  it('合法 payload 应返回 true', () => {
    expect(isMemoryRecalledPayload({ count: 5 })).toBe(true);
  });

  it('count 为 0 应返回 true（合法边界）', () => {
    expect(isMemoryRecalledPayload({ count: 0 })).toBe(true);
  });

  it('count 非数字应返回 false', () => {
    expect(isMemoryRecalledPayload({ count: '5' })).toBe(false);
  });

  it('缺少 count 应返回 false', () => {
    expect(isMemoryRecalledPayload({ total: 5 })).toBe(false);
  });
});

// ─── isDecayCompletedPayload ──────────────────────────────

describe('isDecayCompletedPayload', () => {
  it('合法 payload 应返回 true', () => {
    expect(isDecayCompletedPayload({ decayedCount: 10 })).toBe(true);
  });

  it('decayedCount 为 0 应返回 true（无衰减合法）', () => {
    expect(isDecayCompletedPayload({ decayedCount: 0 })).toBe(true);
  });

  it('decayedCount 非数字应返回 false', () => {
    expect(isDecayCompletedPayload({ decayedCount: '10' })).toBe(false);
  });

  it('缺少 decayedCount 应返回 false', () => {
    expect(isDecayCompletedPayload({ count: 10 })).toBe(false);
  });
});
