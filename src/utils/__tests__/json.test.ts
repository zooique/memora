/**
 * parseLlmJson 单元测试
 *
 * 覆盖：
 *   - 标准 JSON 解析
 *   - markdown 代码块剥离
 *   - 单引号定界符修复（不误伤字符串内容中的单引号）
 *   - 尾逗号修复
 *   - 正则提取兜底
 *   - 边界情况（空输入、null、非 JSON）
 */
import { describe, it, expect } from 'vitest';
import { parseLlmJson } from '@/utils/json.js';

describe('parseLlmJson · LLM 输出 JSON 解析', () => {
  describe('标准 JSON', () => {
    it('应直接解析合法 JSON', () => {
      expect(parseLlmJson('{"key": "value"}')).toEqual({ key: 'value' });
    });

    it('应解析嵌套对象', () => {
      const input = '{"outer": {"inner": 42}}';
      expect(parseLlmJson(input)).toEqual({ outer: { inner: 42 } });
    });

    it('应解析数组', () => {
      expect(parseLlmJson('[1, 2, 3]')).toEqual([1, 2, 3]);
    });
  });

  describe('边界情况', () => {
    it('空字符串应返回 null', () => {
      expect(parseLlmJson('')).toBeNull();
    });

    it('"null" 字符串应返回 null', () => {
      expect(parseLlmJson('null')).toBeNull();
    });

    it('纯文本应返回 null', () => {
      expect(parseLlmJson('这不是 JSON')).toBeNull();
    });

    it('带前后空白应正常解析', () => {
      expect(parseLlmJson('  {"a": 1}  ')).toEqual({ a: 1 });
    });
  });

  describe('markdown 代码块剥离', () => {
    it('应剥离 ```json 代码块', () => {
      const input = '```json\n{"key": "value"}\n```';
      expect(parseLlmJson(input)).toEqual({ key: 'value' });
    });

    it('应剥离无语言标记的代码块', () => {
      const input = '```\n{"key": "value"}\n```';
      expect(parseLlmJson(input)).toEqual({ key: 'value' });
    });

    it('代码块内非法 JSON 应继续回退', () => {
      const input = '```json\nnot json\n```';
      expect(parseLlmJson(input)).toBeNull();
    });
  });

  describe('单引号定界符修复', () => {
    it('应将 key/value 定界符单引号替换为双引号', () => {
      const input = "{'key': 'value'}";
      expect(parseLlmJson(input)).toEqual({ key: 'value' });
    });

    it('应保留字符串内容中的单引号（如 it\'s）', () => {
      const input = '{"text": "it\'s working"}';
      // 标准 JSON.parse 应直接通过（单引号在双引号字符串内合法）
      expect(parseLlmJson(input)).toEqual({ text: "it's working" });
    });

    it('单引号定界符 + 内容含单引号：应正确区分', () => {
      // LLM 输出：{'name': "it's a test"}
      // 单引号作为 key 定界符被替换，双引号内容中的单引号保留
      const input = "{'name': \"it's a test\"}";
      expect(parseLlmJson(input)).toEqual({ name: "it's a test" });
    });

    it('应处理单引号定界的嵌套结构', () => {
      const input = "{'outer': {'inner': 'val'}}";
      expect(parseLlmJson(input)).toEqual({ outer: { inner: 'val' } });
    });
  });

  describe('尾逗号修复', () => {
    it('应移除对象尾逗号', () => {
      const input = '{"a": 1, "b": 2,}';
      expect(parseLlmJson(input)).toEqual({ a: 1, b: 2 });
    });

    it('应移除数组尾逗号', () => {
      const input = '[1, 2, 3,]';
      expect(parseLlmJson(input)).toEqual([1, 2, 3]);
    });
  });

  describe('正则提取兜底', () => {
    it('应从混合文本中提取 JSON 对象', () => {
      const input = '分析结果如下：{"score": 0.8, "label": "positive"}，请参考。';
      expect(parseLlmJson(input)).toEqual({ score: 0.8, label: 'positive' });
    });
  });

  describe('泛型支持', () => {
    it('应支持泛型类型参数', () => {
      const input = '{"name": "test", "count": 5}';
      const result = parseLlmJson<{ name: string; count: number }>(input);
      expect(result?.name).toBe('test');
      expect(result?.count).toBe(5);
    });
  });
});
