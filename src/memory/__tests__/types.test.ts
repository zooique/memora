/**
 * 单元测试：记忆类型定义
 * 验证类型 schema 的有效性
 */
import { describe, expect, it } from 'vitest';
import { MemorySchema, MemoryType, Permanence } from '@/memory/types.js';

describe('记忆类型定义', () => {
  it('应该暴露 6 种记忆类型', () => {
    expect(Object.keys(MemoryType)).toHaveLength(6);
    expect(MemoryType.PERSONALITY).toBe('personality');
    expect(MemoryType.RULE).toBe('rule');
    expect(MemoryType.SKILL).toBe('skill');
    expect(MemoryType.TOOL).toBe('tool');
    expect(MemoryType.TOPIC).toBe('topic');
    expect(MemoryType.WORK_PROJECTION).toBe('work-projection');
  });

  it('应该暴露 4 个永久性等级', () => {
    expect(Object.keys(Permanence)).toHaveLength(4);
    expect(Permanence.ALWAYS).toBe('always');
    expect(Permanence.DOMAIN).toBe('domain');
    expect(Permanence.TOPIC).toBe('topic');
    expect(Permanence.ON_DEMAND).toBe('on-demand');
  });

  it('应该通过 schema 校验一个有效记忆', () => {
    const memory = {
      id: 'rule:core',
      type: MemoryType.RULE,
      permanence: Permanence.ALWAYS,
      name: 'core',
      content: '核心规则内容',
      tags: ['rule', 'core'],
      weight: 1.0,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    };

    const parsed = MemorySchema.parse(memory);
    expect(parsed.id).toBe('rule:core');
    expect(parsed.tags).toEqual(['rule', 'core']);
  });

  it('应该拒绝无效的 type', () => {
    const invalid = {
      id: 'x',
      type: 'invalid',
      permanence: 'always',
      name: 'x',
      content: 'x',
      tags: [],
      weight: 0.5,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    };
    expect(() => MemorySchema.parse(invalid)).toThrow();
  });

  it('应该拒绝无效的 permanence', () => {
    const invalid = {
      id: 'x',
      type: 'rule',
      permanence: 'invalid',
      name: 'x',
      content: 'x',
      tags: [],
      weight: 0.5,
      createdAt: '2026-06-02T00:00:00.000Z',
      updatedAt: '2026-06-02T00:00:00.000Z',
    };
    expect(() => MemorySchema.parse(invalid)).toThrow();
  });
});
