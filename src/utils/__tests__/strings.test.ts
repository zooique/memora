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
import { slugify } from '@/utils/strings.js';

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
