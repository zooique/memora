/**
 * 单元测试：字符串工具函数
 *
 * 覆盖 slugify，重点验证：
 *   - 冒号和空白替换为连字符
 *   - 只保留字母、数字、中文、连字符、下划线
 *   - 多个连续连字符合并为单个
 *   - 头尾连字符去除
 *   - 截断到 40 字符
 */
import { describe, expect, it } from 'vitest';
import { slugify, isValidConfigName, parseConfigId, MAX_CONFIG_NAME_LENGTH } from '@/utils/strings.js';

describe('utils/strings · slugify', () => {
  it('应将冒号和空白替换为连字符', () => {
    expect(slugify('hello world')).toBe('hello-world');
    expect(slugify('title: subtitle')).toBe('title-subtitle');
  });

  it('应保留中文字符', () => {
    expect(slugify('万物皆记忆')).toBe('万物皆记忆');
  });

  it('应保留字母数字和连字符下划线', () => {
    expect(slugify('file_name-001')).toBe('file_name-001');
  });

  it('应过滤特殊字符', () => {
    expect(slugify('hello!@#$%^&*()world')).toBe('helloworld');
  });

  it('应合并多个连续连字符为单个', () => {
    expect(slugify('a---b')).toBe('a-b');
    expect(slugify('a   b')).toBe('a-b'); // 多个空格合并
  });

  it('应去除头尾连字符', () => {
    expect(slugify('-hello-')).toBe('hello');
    expect(slugify('---hello---')).toBe('hello');
  });

  it('应截断到 40 字符', () => {
    const long = 'a'.repeat(50);
    const result = slugify(long);
    expect(result.length).toBe(40);
  });

  it('中文 + 英文混合应正确处理', () => {
    expect(slugify('Hello 世界: test')).toBe('Hello-世界-test');
  });

  it('空字符串应返回空字符串', () => {
    expect(slugify('')).toBe('');
  });

  it('纯特殊字符应返回空字符串', () => {
    expect(slugify('!@#$%^&*()')).toBe('');
  });

  it('纯空白和冒号应返回空字符串', () => {
    expect(slugify('   :::   ')).toBe('');
  });

  it('下划线应保留', () => {
    expect(slugify('hello_world')).toBe('hello_world');
  });

  it('数字应保留', () => {
    expect(slugify('version 2.0')).toBe('version-20');
  });
});

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
