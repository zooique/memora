/**
 * budget.ts 纯函数测试——上下文预算装配（role-pack-spec §C/§D）
 *
 * 覆盖：
 *   1. computeContextBudget：预算公式数值派生（可用/锚点/剩余/对话层/记忆层 cap）
 *   2. 边界：输入超大（剩余预算归零，供装配前判负判定）、记忆百分比极端（0 / 1）
 *   3. deriveDialogueRounds：从最近往回塞 + 第一条必在场（次级锚点）
 */
import { describe, it, expect } from 'vitest';
import {
  computeContextBudget,
  deriveDialogueRounds,
  DEFAULT_OUTPUT_RESERVE_RATIO,
  DEFAULT_DIALOGUE_FILL_RATIO,
} from '@/agent/budget.js';

describe('computeContextBudget · 预算公式数值派生', () => {
  it('默认参数：可用预算 = 窗口 × (1−0.15) − 固定开销', () => {
    const budget = computeContextBudget({
      windowTokens: 120_000,
      fixedOverheadTokens: 5_000,
      inputTokens: 100,
    });
    // 120000 × 0.85 = 102000 − 5000 = 97000
    expect(budget.availableTokens).toBe(97_000);
    // 顶级锚点 = 输入 × 2（输入 + 首个回答预留）
    expect(budget.anchorTokens).toBe(200);
    // 剩余预算 = 97000 − 200
    expect(budget.remainingTokens).toBe(96_800);
    // 完整对话层 = 剩余 × 0.9
    expect(budget.dialogueBudgetTokens).toBe(Math.floor(96_800 * 0.9));
    // 记忆摘要层 cap = 剩余 × 0.4
    expect(budget.memoryLayerCapTokens).toBe(Math.floor(96_800 * 0.4));
  });

  it('自定义比例（输出预留 0.2 / 对话填充 0.8 / 记忆百分比 0.5）', () => {
    const budget = computeContextBudget({
      windowTokens: 10_000,
      fixedOverheadTokens: 2_000,
      inputTokens: 500,
      outputReserveRatio: 0.2,
      dialogueFillRatio: 0.8,
      memoryRecallPercent: 0.5,
    });
    // 10000 × 0.8 = 8000 − 2000 = 6000
    expect(budget.availableTokens).toBe(6_000);
    expect(budget.anchorTokens).toBe(1_000);
    expect(budget.remainingTokens).toBe(5_000);
    expect(budget.dialogueBudgetTokens).toBe(4_000);
    expect(budget.memoryLayerCapTokens).toBe(2_500);
  });

  it('输入超大（锚点划走剩余预算归零）——装配前判负的输入侧判定依据', () => {
    const budget = computeContextBudget({
      windowTokens: 10_000,
      fixedOverheadTokens: 2_000,
      inputTokens: 20_000, // 输入本身已远超可用预算
    });
    expect(budget.remainingTokens).toBe(0);
    expect(budget.dialogueBudgetTokens).toBe(0);
    expect(budget.memoryLayerCapTokens).toBe(0);
  });

  it('窗口过小（固定开销超过预留后窗口）时各级归零', () => {
    const budget = computeContextBudget({
      windowTokens: 1_000,
      fixedOverheadTokens: 1_000, // 固定开销吃掉全部预留后窗口
      inputTokens: 50,
    });
    expect(budget.availableTokens).toBe(0);
    expect(budget.remainingTokens).toBe(0);
    expect(budget.dialogueBudgetTokens).toBe(0);
    expect(budget.memoryLayerCapTokens).toBe(0);
  });

  it('记忆百分比极端：0 → 记忆层 cap 为 0（cap 非 quota，对话层不受影响）', () => {
    const budget = computeContextBudget({
      windowTokens: 10_000,
      fixedOverheadTokens: 2_000,
      inputTokens: 500,
      memoryRecallPercent: 0,
    });
    expect(budget.memoryLayerCapTokens).toBe(0);
    // 对话层不受记忆百分比影响（完整对话层无条件优先）
    // available=6500 − anchor=1000 → remaining=5500 → dialogue=floor(5500×0.9)=4950
    expect(budget.dialogueBudgetTokens).toBe(4_950);
  });

  it('记忆百分比极端：1 → 记忆层 cap = 剩余预算（对话层填满后的全部剩余）', () => {
    const budget = computeContextBudget({
      windowTokens: 10_000,
      fixedOverheadTokens: 2_000,
      inputTokens: 500,
      memoryRecallPercent: 1,
    });
    // available=6500 − anchor=1000 → remaining=5500
    expect(budget.memoryLayerCapTokens).toBe(5_500);
  });

  it('默认常量：输出预留 15%、对话填充 90%', () => {
    expect(DEFAULT_OUTPUT_RESERVE_RATIO).toBe(0.15);
    expect(DEFAULT_DIALOGUE_FILL_RATIO).toBe(0.9);
  });
});

describe('deriveDialogueRounds · 完整对话层轮次派生（动态轮数 + 第一条必在场）', () => {
  it('全部轮次在预算内 → 全部纳入，第一条已在其中，不显式补', () => {
    const result = deriveDialogueRounds([100, 200, 300], 1000);
    expect(result.recentRoundCount).toBe(3);
    expect(result.firstRoundIncluded).toBe(false);
  });

  it('部分轮次在预算内 → 取最近可容纳轮数，第一条不在内则显式补入', () => {
    // 成本 [100, 200, 500, 600]，预算 700 → 最近能塞 600（1 轮），再加 500 超预算
    const result = deriveDialogueRounds([100, 200, 500, 600], 700);
    expect(result.recentRoundCount).toBe(1);
    expect(result.firstRoundIncluded).toBe(true);
  });

  it('预算极小（单轮都放不下）→ 仍保最近一轮（保证最近上下文）+ 显式补第一条（次级锚点）', () => {
    // 最近一轮成本 300 > 预算 50：首轮（recentRoundCount=0）不受预算闸约束必然纳入，
    // 再往前 200 已超预算停止 → recentRoundCount=1；第一条不在最近轮内 → 显式补入
    const result = deriveDialogueRounds([100, 200, 300], 50);
    expect(result.recentRoundCount).toBe(1);
    expect(result.firstRoundIncluded).toBe(true);
  });

  it('空轮次 → 无最近轮、无显式补', () => {
    const result = deriveDialogueRounds([], 1000);
    expect(result.recentRoundCount).toBe(0);
    expect(result.firstRoundIncluded).toBe(false);
  });

  it('单轮超大预算场景下最近轮数正确（首轮被覆盖则不补）', () => {
    // 仅一轮 [800]，预算 1000 → 最近 1 轮，第一条即该轮，不重复补
    const result = deriveDialogueRounds([800], 1000);
    expect(result.recentRoundCount).toBe(1);
    expect(result.firstRoundIncluded).toBe(false);
  });
});
