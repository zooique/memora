/**
 * 单元测试：记忆类型定义
 * 验证基元驱动模型的 schema 有效性
 */
import { describe, expect, it } from 'vitest';
import { MemorySchema, SOURCE_LABELS, inferSource, escapeLike, STOPWORDS, validateSource } from '@/memory/types.js';

describe('记忆类型定义', () => {
  it('应该暴露 6 种 source 标签约定', () => {
    // source 是开放字符串，SOURCE_LABELS 仅为当前约定
    expect(Object.keys(SOURCE_LABELS)).toHaveLength(6);
    expect(SOURCE_LABELS.PERSONA).toBe('persona');
    expect(SOURCE_LABELS.RULE).toBe('rule');
    expect(SOURCE_LABELS.SKILL).toBe('skill');
    expect(SOURCE_LABELS.INSIGHT).toBe('insight');
    expect(SOURCE_LABELS.PROFILE).toBe('profile');
    expect(SOURCE_LABELS.WORK_PROJECTION).toBe('work-projection');
  });

  it('应该通过 schema 校验一个有效记忆', () => {
    // 构造符合新 Memory 接口的测试数据
    const memory = {
      id: 'rule:core',
      content: '核心规则内容',
      source: 'rule',
      name: 'core',
      createdAt: '2026-06-02T00:00:00.000Z',
      accessedAt: '2026-06-02T00:00:00.000Z',
      score: 0.8,
    };

    const parsed = MemorySchema.parse(memory);
    expect(parsed.id).toBe('rule:core');
    expect(parsed.source).toBe('rule');
    expect(parsed.score).toBe(0.8);
  });

  it('应该拒绝无效的 score 范围', () => {
    // score 必须在 0-1 之间
    const invalid = {
      id: 'x:test',
      content: '测试内容',
      source: 'rule',
      name: 'test',
      createdAt: '2026-06-02T00:00:00.000Z',
      accessedAt: '2026-06-02T00:00:00.000Z',
      score: 1.5,  // 超出范围
    };
    expect(() => MemorySchema.parse(invalid)).toThrow();
  });

  it('应该接受有效的 source 字符串（开放字符串，非枚举）', () => {
    // source 是开放字符串，任何非空字符串都应有效
    const customSource = {
      id: 'custom:test',
      content: '测试内容',
      source: 'custom-source',  // 自定义 source
      name: 'test',
      createdAt: '2026-06-02T00:00:00.000Z',
      accessedAt: '2026-06-02T00:00:00.000Z',
      score: 0.5,
    };
    expect(() => MemorySchema.parse(customSource)).not.toThrow();
  });
});

describe('inferSource 工具函数', () => {
  it('应该优先使用 frontmatter 中声明的 source', () => {
    expect(inferSource('/path/to/file.md', 'custom')).toBe('custom');
  });

  it('应该从 personas/ 路径推断为 persona', () => {
    expect(inferSource('/config/personas/bowen.md')).toBe('persona');
  });

  it('应该从 /rules/ 路径推断为 rule', () => {
    expect(inferSource('/config/rules/core.md')).toBe('rule');
  });

  it('应该从 /skills/ 路径推断为 skill', () => {
    expect(inferSource('/config/skills/writing.md')).toBe('skill');
  });

  it('应该对未知路径返回 unknown', () => {
    expect(inferSource('/other/path/file.md')).toBe('unknown');
  });
});

describe('escapeLike 工具函数', () => {
  it('应该转义 % 和 _ 通配符', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('test_value')).toBe('test\\_value');
    expect(escapeLike('normal text')).toBe('normal text');
  });
});

describe('STOPWORDS 停用词集合', () => {
  it('应该包含常用中文停用词', () => {
    expect(STOPWORDS.has('的')).toBe(true);
    expect(STOPWORDS.has('了')).toBe(true);
    expect(STOPWORDS.has('是')).toBe(true);
    expect(STOPWORDS.has('在')).toBe(true);
  });

  it('应该不包含有意义的词', () => {
    expect(STOPWORDS.has('记忆')).toBe(false);
    expect(STOPWORDS.has('规则')).toBe(false);
  });
});

describe('validateSource 校验函数', () => {
  it('已知 source 应返回 valid: true 且无警告', () => {
    expect(validateSource('rule')).toEqual({ valid: true });
    expect(validateSource('persona')).toEqual({ valid: true });
    expect(validateSource('skill')).toEqual({ valid: true });
    expect(validateSource('insight')).toEqual({ valid: true });
    expect(validateSource('profile')).toEqual({ valid: true });
    expect(validateSource('work-projection')).toEqual({ valid: true });
  });

  it('自定义 source（非已知标签）应返回 valid: true 且无警告', () => {
    expect(validateSource('custom-source')).toEqual({ valid: true });
    expect(validateSource('my-plugin')).toEqual({ valid: true });
  });

  it('应检测接近已知标签的拼写错误', () => {
    const result = validateSource('rul'); // 接近 'rule'
    expect(result.valid).toBe(true);
    expect(result.warning).toContain('rule');
    expect(result.warning).toContain('拼写错误');
  });

  it('空字符串应返回 valid: false', () => {
    const result = validateSource('');
    expect(result.valid).toBe(false);
    expect(result.warning).toBeDefined();
  });

  it('首尾空格应返回 valid: false', () => {
    const result = validateSource(' rule ');
    expect(result.valid).toBe(false);
    expect(result.warning).toContain('空格');
  });

  it('短距离差异不误报（差异 > 2 的不警告）', () => {
    const result = validateSource('completely-different');
    expect(result.valid).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('路径遍历序列应返回 valid: false', () => {
    const result = validateSource('skill::../etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.warning).toContain('路径遍历');
  });

  it('null 字节应返回 valid: false', () => {
    const result = validateSource('insight\x00malicious');
    expect(result.valid).toBe(false);
    expect(result.warning).toContain('null 字节');
  });
});
