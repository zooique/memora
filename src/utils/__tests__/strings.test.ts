/**
 * 单元测试：字符串工具函数（配置名白名单 + 配置 ID 解析）
 */
import { describe, expect, it } from 'vitest';
import { isValidConfigName, parseConfigId, MAX_CONFIG_NAME_LENGTH } from '@/utils/strings.js';

describe('utils/strings · isValidConfigName（T-B2 配置名白名单）', () => {
  it('应接受 ASCII 名', () => {
    expect(isValidConfigName('my-rule')).toBe(true);
    expect(isValidConfigName('project_规范')).toBe(true);
    expect(isValidConfigName('rules123')).toBe(true);
  });

  it('应接受中文 / 日文 / 韩文名（Unicode 字母白名单）', () => {
    expect(isValidConfigName('项目规范')).toBe(true);
    expect(isValidConfigName('コード規約')).toBe(true);
    expect(isValidConfigName('프로젝트규칙')).toBe(true);
  });

  it('应拒绝路径分隔符 / 点号 / 空格 / 空串（路径穿越面）', () => {
    for (const bad of ['../escape', 'a/b', '..\\win', 'name with space', '', '..', 'a.b']) {
      expect(isValidConfigName(bad)).toBe(false);
    }
  });

  it('应拒绝超过 MAX_CONFIG_NAME_LENGTH 的 name（默认 100）', () => {
    expect(isValidConfigName('a'.repeat(MAX_CONFIG_NAME_LENGTH))).toBe(true);
    expect(isValidConfigName('a'.repeat(MAX_CONFIG_NAME_LENGTH + 1))).toBe(false);
  });

  it('maxLength 参数可覆盖默认阈值', () => {
    expect(isValidConfigName('ab', 2)).toBe(true);
    expect(isValidConfigName('ab', 1)).toBe(false);
  });
});

describe('utils/strings · parseConfigId（T-D 配置 ID 解析）', () => {
  it('应解析 rule:NAME 为 {source, name}', () => {
    expect(parseConfigId('rule:my-rule')).toEqual({ source: 'rule', name: 'my-rule' });
  });

  it('应解析 skill:NAME（含中文名）', () => {
    expect(parseConfigId('skill:写作助手')).toEqual({ source: 'skill', name: '写作助手' });
  });

  it('无冒号的 id 应返回 null（宿主放行语义）', () => {
    expect(parseConfigId('no-colon-id')).toBeNull();
  });

  it('非字符串输入应返回 null', () => {
    expect(parseConfigId(null as unknown as string)).toBeNull();
    expect(parseConfigId(undefined as unknown as string)).toBeNull();
  });
});
