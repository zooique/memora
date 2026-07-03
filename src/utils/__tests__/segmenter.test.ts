/**
 * 单元测试：中文分词器
 *
 * 详见 M-202：Intl.Segmenter 中文分词
 *
 * P3-02：tokenizeKeywords 已降为模块私有，其行为通过 scoreByKeywords 间接验证。
 */
import { describe, expect, it } from 'vitest';
import { segmentText, scoreByKeywords } from '@/utils/segmenter.js';

describe('M-202 · 中文分词器（Intl.Segmenter）', () => {
  describe('segmentText', () => {
    it('应能切出中文词（Intl.Segmenter zh-CN 按 ICU 词典切）', () => {
      // Intl.Segmenter zh-CN：把"我是 Memora"切成"我是"+"Memora"
      // 注意：中文常用搭配会被当成一个词（这是 ICU 词典的设计，不是 bug）
      const tokens = segmentText('我是 Memora');
      expect(tokens.length).toBe(2);
      expect(tokens).toContain('Memora');
      expect(tokens[0]?.length).toBeGreaterThan(0);
    });

    it('应能识别 Memora 哲学关键词', () => {
      // 这是 M-001 烟测中 LLM 回应的关键短语
      const tokens = segmentText('万物皆记忆');
      // Intl.Segmenter 会识别"万物"和"皆"为独立 token
      expect(tokens).toContain('万物');
      expect(tokens.some((t) => t.includes('记忆') || t.includes('记'))).toBe(true);
    });

    it('应能处理纯英文', () => {
      const tokens = segmentText('Hello World');
      expect(tokens).toEqual(['Hello', 'World']);
    });

    it('应能处理数字', () => {
      const tokens = segmentText('Version 24 LTS');
      expect(tokens).toContain('24');
      expect(tokens).toContain('LTS');
    });

    it('应能过滤空字符串', () => {
      expect(segmentText('')).toEqual([]);
      expect(segmentText('   ')).toEqual([]);
      expect(segmentText('，。！？')).toEqual([]);
    });

    it('应能处理中英混合', () => {
      const tokens = segmentText('Node.js 24 是 LTS 版本');
      expect(tokens).toContain('Node.js');
      expect(tokens).toContain('24');
      expect(tokens).toContain('LTS');
    });
  });
});

describe('scoreByKeywords · 关键词匹配评分（间接覆盖 tokenizeKeywords）', () => {
  it('空关键词列表应返回 0', () => {
    expect(scoreByKeywords('任何输入', [])).toBe(0);
  });

  it('完全命中应返回 1', () => {
    expect(scoreByKeywords('我想写玄幻小说', ['玄幻', '小说'])).toBe(1);
  });

  it('部分命中应返回正确比例', () => {
    expect(scoreByKeywords('我想写玄幻小说', ['玄幻', '科幻', '小说'])).toBeCloseTo(2 / 3, 5);
  });

  it('无命中应返回 0', () => {
    expect(scoreByKeywords('今天天气不错', ['玄幻', '小说'])).toBe(0);
  });

  it('大小写不敏感', () => {
    expect(scoreByKeywords('use TypeScript API', ['api', 'typescript'])).toBe(1);
  });

  it('中文子串匹配', () => {
    expect(scoreByKeywords('我想学习编程技巧', ['编程'])).toBe(1);
  });

  it('英文关键词中文输入不命中', () => {
    expect(scoreByKeywords('我想写小说', ['API', 'TypeScript'])).toBe(0);
  });
});
