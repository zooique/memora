/**
 * 单元测试：中文分词器
 *
 * 详见 Intl.Segmenter 中文分词
 */
import { describe, expect, it } from 'vitest';
import { segmentText } from '@/utils/segmenter.js';

describe('中文分词器（Intl.Segmenter）', () => {
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
      // 这是烟测中 LLM 回应的关键短语
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
