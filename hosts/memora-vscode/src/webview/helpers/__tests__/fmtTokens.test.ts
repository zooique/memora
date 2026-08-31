/**
 * fmtTokens 单元测试 — token 数量人类可读格式化（K/M 缩写与千分位）
 *
 * 该 helper 是 webview「token 数量展示/换算」主题的单一真理源：精确展示 fmtTokens、
 * 紧凑近似 fmtCompactTokens、换算常量 TOKENS_PER_K（配置表单 K 输入消费）/ TOKENS_PER_M（仅展示缩写），
 * 三者须保持与显示/解析一致的单向确定性。
 */
import { describe, it, expect } from 'vitest';
import { fmtTokens, fmtCompactTokens, TOKENS_PER_K, TOKENS_PER_M } from '../fmtTokens.js';

describe('fmtTokens 换算常量（K 供表单输入与展示共用，M 仅展示缩写，唯一倍数源）', () => {
  it('K=×1000、M=×1,000,000（LLM 生态口径，非二进制倍数）', () => {
    expect(TOKENS_PER_K).toBe(1000);
    expect(TOKENS_PER_M).toBe(1_000_000);
  });
});

describe('fmtCompactTokens（紧凑近似展示，预算可视化行）', () => {
  it('≥1000 四舍五入为 k 缩写（小写，保留既有预算行展示）', () => {
    expect(fmtCompactTokens(97_000)).toBe('97k');
    expect(fmtCompactTokens(87_120)).toBe('87k');
    expect(fmtCompactTokens(38_720)).toBe('39k');
  });

  it('<1000 原样返回', () => {
    expect(fmtCompactTokens(999)).toBe('999');
  });

  it('零值与非正数原样返回', () => {
    expect(fmtCompactTokens(0)).toBe('0');
    expect(fmtCompactTokens(-5)).toBe('-5');
  });
});

describe('fmtTokens', () => {
  it('整百万 → M 简写', () => {
    expect(fmtTokens(1_000_000)).toBe('1M');
    expect(fmtTokens(10_000_000)).toBe('10M');
  });

  it('整千（非 M）→ K 简写', () => {
    expect(fmtTokens(128_000)).toBe('128K');
    expect(fmtTokens(200_000)).toBe('200K');
    expect(fmtTokens(120_000)).toBe('120K');
  });

  it('非整千 → 千分位分隔', () => {
    expect(fmtTokens(65_536)).toBe('65,536');
    expect(fmtTokens(43_200)).toBe('43,200');
  });

  it('1024K（1,024,000）非 M 整倍数 → 仍按 K 简写', () => {
    // K 恒为 ×1000：用户输入 1024K 得到 1,024,000，显示层按整千缩写为 1024K（不近似成 1M）
    expect(fmtTokens(1_024_000)).toBe('1024K');
  });

  it('小值零值非法输入 → 兜底', () => {
    expect(fmtTokens(0)).toBe('0');
    expect(fmtTokens(-5)).toBe('0');
    expect(fmtTokens(Number.NaN)).toBe('0');
    expect(fmtTokens(Number.POSITIVE_INFINITY)).toBe('0');
    expect(fmtTokens(999)).toBe('999');
  });
});