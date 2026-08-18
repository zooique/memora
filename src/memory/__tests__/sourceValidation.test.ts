/**
 * 单元测试：source 校验工具
 *
 * 覆盖 inferSource / escapeLike / validateSource 三个纯函数。
 * 从 types.test.ts 迁出，与 sourceValidation.ts 1:1 镜像。
 *
 * 设计原则（ADR-004）：source 是开放字符串，校验仅做 typo 检测，
 * 安全边界（路径遍历、null 字节）必须拒绝。
 */
import { describe, expect, it } from 'vitest';
import { inferSource, escapeLike, validateSource } from '@/memory/sourceValidation.js';

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

  it('不应误匹配包含 personas 的非标准路径', () => {
    expect(inferSource('/config/other-personas/file.md')).toBe('unknown');
  });

  it('应支持 Windows 反斜杠路径', () => {
    expect(inferSource('C:\\config\\personas\\bowen.md')).toBe('persona');
    expect(inferSource('C:\\config\\rules\\core.md')).toBe('rule');
  });
});

describe('escapeLike 工具函数', () => {
  it('应该转义 % 和 _ 通配符', () => {
    expect(escapeLike('100%')).toBe('100\\%');
    expect(escapeLike('test_value')).toBe('test\\_value');
    expect(escapeLike('normal text')).toBe('normal text');
  });
});

describe('validateSource 校验函数', () => {
  it('已知 source 应返回 valid: true 且无警告', () => {
    expect(validateSource('rule')).toEqual({ valid: true });
    expect(validateSource('persona')).toEqual({ valid: true });
    expect(validateSource('skill')).toEqual({ valid: true });
    expect(validateSource('round-summary')).toEqual({ valid: true });
    expect(validateSource('work-projection')).toEqual({ valid: true });
  });

  it('自定义 source（非已知标签）应返回 valid: true 且无警告', () => {
    expect(validateSource('custom-source')).toEqual({ valid: true });
    expect(validateSource('my-plugin')).toEqual({ valid: true });
  });

  it('应检测接近已知标签的拼写错误（severity: warn）', () => {
    const result = validateSource('rul'); // 接近 'rule'
    expect(result.valid).toBe(true);
    expect(result.severity).toBe('warn');
    expect(result.warning).toContain('rule');
    expect(result.warning).toContain('拼写错误');
  });

  it('空字符串应返回 valid: false, severity: block', () => {
    const result = validateSource('');
    expect(result.valid).toBe(false);
    expect(result.severity).toBe('block');
    expect(result.warning).toBeDefined();
  });

  it('首尾空格应返回 valid: false, severity: block', () => {
    const result = validateSource(' rule ');
    expect(result.valid).toBe(false);
    expect(result.severity).toBe('block');
    expect(result.warning).toContain('空格');
  });

  it('短距离差异不误报（差异 > 2 的不警告）', () => {
    const result = validateSource('completely-different');
    expect(result.valid).toBe(true);
    expect(result.severity).toBeUndefined();
    expect(result.warning).toBeUndefined();
  });

  it('路径遍历序列应返回 valid: false, severity: block', () => {
    const result = validateSource('skill::../etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.severity).toBe('block');
    expect(result.warning).toContain('路径遍历');
  });

  it('null 字节应返回 valid: false, severity: block', () => {
    const result = validateSource('content\x00malicious');
    expect(result.valid).toBe(false);
    expect(result.severity).toBe('block');
    expect(result.warning).toContain('null 字节');
  });

  it('M5 修复：路径分隔符 / 应返回 valid: false, severity: block', () => {
    // source="rules/secret" 通过校验会落入保留的 rules/ 目录子树，命名空间污染
    const result = validateSource('rules/secret');
    expect(result.valid).toBe(false);
    expect(result.severity).toBe('block');
    expect(result.warning).toContain('路径分隔符');
  });

  it('M5 修复：反斜杠 \\ 应返回 valid: false, severity: block', () => {
    const result = validateSource('rules\\secret');
    expect(result.valid).toBe(false);
    expect(result.severity).toBe('block');
  });
});
