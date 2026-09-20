/**
 * 单元测试：中文分词器
 *
 * 详见 Intl.Segmenter 中文分词
 */
import { describe, expect, it } from 'vitest';
import { segmentText, segmentLower, extractEnhancedKeywords, calculateWeightedJaccard } from '@/utils/segmenter.js';

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

describe('segmentLower（public API · 大小写不敏感匹配基础）', () => {
  it('输出恒为小写', () => {
    expect(segmentLower('Hello WORLD')).toContain('hello');
    expect(segmentLower('Memora 记忆')).toContain('memora');
  });

  it('空输入返回空数组', () => {
    expect(segmentLower('')).toEqual([]);
  });
});

describe('extractEnhancedKeywords（带权重关键词提取）', () => {
  it('普通词权重为 1.0', () => {
    const kw = extractEnhancedKeywords('理解需求');
    // 中文分词 "理解"（非动作）"需求"
    expect(kw.every((k) => k.weight === 1.0)).toBe(true);
  });

  it('动作/意图词权重为 2.0', () => {
    const kw = extractEnhancedKeywords('创建服务器');
    const create = kw.find((k) => k.word.includes('创建'));
    expect(create?.weight).toBe(2.0);
  });

  it('实体后缀词权重为 1.5', () => {
    // "服务器" 命中实体后缀 "器"（无论 Intl.Segmenter 如何切分，含后缀词之一权重应为 1.5）
    const kw = extractEnhancedKeywords('服务器性能');
    expect(kw.some((k) => k.weight === 1.5)).toBe(true);
  });

  it('停用词与过短词被过滤', () => {
    // "因为" 是双字停用词（长度≥2 不会被长度过滤误拦）→ 应整体过滤
    const kw = extractEnhancedKeywords('因为');
    expect(kw).toEqual([]);
  });
});

describe('calculateWeightedJaccard（加权 Jaccard 相似度）', () => {
  it('双方都为空返回 0', () => {
    expect(calculateWeightedJaccard([], [])).toBe(0);
  });

  it('无交集返回 0', () => {
    expect(calculateWeightedJaccard([{ word: 'a', weight: 1 }], [{ word: 'b', weight: 2 }])).toBe(0);
  });

  it('有交集按较大权重计算', () => {
    const score = calculateWeightedJaccard(
      [{ word: 'a', weight: 1 }, { word: 'b', weight: 2 }],
      [{ word: 'a', weight: 3 }],
    );
    // 交集 weightA=1/weightB=3 → 交集取 3；并集 a(3)+b(2)=5 → 3/5
    expect(score).toBeCloseTo(0.6, 6);
  });

  it('unionWeight 为 0 时返回 0（防御）', () => {
    // 空词组但长度非空（词为 0 权重）→ union 0
    expect(calculateWeightedJaccard([{ word: 'a', weight: 0 }], [{ word: 'a', weight: 0 }])).toBe(0);
  });
});
