/**
 * escapeRegExp 工具函数测试
 *
 * 验证 RegExp 特殊字符转义的正确性，确保转义后的字符串可安全嵌入 new RegExp()。
 * 覆盖场景：特殊字符转义、普通字符不变形、空字符串、组合输入、实际 RegExp 构造。
 */

import { describe, it, expect } from 'vitest';
import { escapeRegExp } from '../../shared/escapeRegExp.js';

describe('escapeRegExp · RegExp 特殊字符转义', () => {
  describe('特殊字符转义', () => {
    it('转义点号（.）', () => {
      // 点号在 RegExp 中匹配任意字符，必须转义
      expect(escapeRegExp('.')).toBe('\\.');
    });

    it('转义星号（*）', () => {
      // 星号是量词，必须转义
      expect(escapeRegExp('*')).toBe('\\*');
    });

    it('转义加号（+）', () => {
      // 加号是量词，必须转义
      expect(escapeRegExp('+')).toBe('\\+');
    });

    it('转义问号（?）', () => {
      // 问号是量词，必须转义
      expect(escapeRegExp('?')).toBe('\\?');
    });

    it('转义脱字符（^）', () => {
      // 脱字符是锚点，必须转义
      expect(escapeRegExp('^')).toBe('\\^');
    });

    it('转义美元符（$）', () => {
      // 美元符是锚点，必须转义
      expect(escapeRegExp('$')).toBe('\\$');
    });

    it('转义花括号（{}）', () => {
      // 花括号是量词，必须转义
      expect(escapeRegExp('{')).toBe('\\{');
      expect(escapeRegExp('}')).toBe('\\}');
    });

    it('转义圆括号（()）', () => {
      // 圆括号是分组，必须转义
      expect(escapeRegExp('(')).toBe('\\(');
      expect(escapeRegExp(')')).toBe('\\)');
    });

    it('转义竖线（|）', () => {
      // 竖线是交替，必须转义
      expect(escapeRegExp('|')).toBe('\\|');
    });

    it('转义方括号（[]）', () => {
      // 方括号是字符类，必须转义
      expect(escapeRegExp('[')).toBe('\\[');
      expect(escapeRegExp(']')).toBe('\\]');
    });

    it('转义反斜杠（\\）', () => {
      // 反斜杠本身是转义符，必须转义
      expect(escapeRegExp('\\')).toBe('\\\\');
    });
  });

  describe('普通字符不变形', () => {
    it('字母数字不变', () => {
      // 字母数字不是特殊字符，不应被转义
      expect(escapeRegExp('abc123')).toBe('abc123');
    });

    it('中文字符不变', () => {
      // 中文字符不是 RegExp 特殊字符，不应被转义
      expect(escapeRegExp('记忆搜索')).toBe('记忆搜索');
    });

    it('空字符串返回空', () => {
      // 空字符串无字符可转义
      expect(escapeRegExp('')).toBe('');
    });
  });

  describe('组合输入', () => {
    it('混合特殊字符与普通字符', () => {
      // 混合输入：每个特殊字符独立转义，普通字符不变
      expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c');
    });

    it('文件路径模式（含 . 和 /）', () => {
      // 文件路径常见模式：点号转义，斜杠不变
      expect(escapeRegExp('config.json')).toBe('config\\.json');
    });

    it('正则表达式片段', () => {
      // 完整正则片段：所有特殊字符都应被转义
      expect(escapeRegExp('(.*)+?')).toBe('\\(\\.\\*\\)\\+\\?');
    });
  });

  describe('实际 RegExp 构造安全性', () => {
    it('转义后的字符串可安全用于 new RegExp()', () => {
      // 转义后应能精确匹配原始字符串，而非被解释为正则模式
      const input = 'price: $9.99 (each)';
      const escaped = escapeRegExp(input);
      const regex = new RegExp(escaped);
      expect(regex.test(input)).toBe(true);
      // 不应匹配 "price: X9X99XeachX"（点号被转义后不匹配任意字符）
      expect(regex.test('price: X9X99XeachX')).toBe(false);
    });

    it('转义后的特殊字符不触发 RegExp 语法错误', () => {
      // 未转义的 "(" 会导致 new RegExp 抛 SyntaxError
      const input = 'func(arg)';
      const escaped = escapeRegExp(input);
      expect(() => new RegExp(escaped)).not.toThrow();
    });
  });
});
