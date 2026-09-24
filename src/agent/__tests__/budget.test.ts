/**
 * budget.ts 纯函数测试——上下文预算装配（role-pack-spec §C/§D）
 *
 * 覆盖：
 *   1. computeContextBudget：预算公式数值派生（可用/锚点/剩余/对话层）
 *      （记忆层 cap 已随记忆维度整体退役，见 budget.ts 头注释）
 *   2. 边界：输入超大（剩余预算归零，供装配前判负判定）、窗口过小（各级归零）
 *   3. deriveDialogueRounds：从最近往回塞 + 第一条必在场（次级锚点）
 */
import { describe, it, expect } from 'vitest';
import {
  computeContextBudget,
  deriveDialogueRounds,
  isInputTooLarge,
  resolveContextWindow,
  estimateOccupancy,
  MIN_RUNNABLE_DIALOGUE_TOKENS,
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
    // 顶级锚点 = 输入 × 1（仅当前用户输入，首个回答预留已退役）
    expect(budget.anchorTokens).toBe(100);
    // 剩余预算 = 97000 − 100
    expect(budget.remainingTokens).toBe(96_900);
    // 完整对话层 = 剩余 × 0.9
    expect(budget.dialogueBudgetTokens).toBe(Math.floor(96_900 * 0.9));
  });

  it('自定义比例（输出预留 0.2 / 对话填充 0.8）', () => {
    const budget = computeContextBudget({
      windowTokens: 10_000,
      fixedOverheadTokens: 2_000,
      inputTokens: 500,
      outputReserveRatio: 0.2,
      dialogueFillRatio: 0.8,
    });
    // 10000 × 0.8 = 8000 − 2000 = 6000
    expect(budget.availableTokens).toBe(6_000);
    expect(budget.anchorTokens).toBe(500);
    expect(budget.remainingTokens).toBe(5_500);
    expect(budget.dialogueBudgetTokens).toBe(4_400);
  });

  it('输入超大（锚点划走剩余预算归零）——装配前判负的输入侧判定依据', () => {
    const budget = computeContextBudget({
      windowTokens: 10_000,
      fixedOverheadTokens: 2_000,
      inputTokens: 20_000, // 输入本身已远超可用预算
    });
    expect(budget.remainingTokens).toBe(0);
    expect(budget.dialogueBudgetTokens).toBe(0);
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

describe('isInputTooLarge · 装配前判负（洞 3 独立路径）', () => {
  it('剩余预算低于最小可运行阈值 → 输入过大', () => {
    // 超大输入：锚点划走剩余预算归零
    const budget = computeContextBudget({
      windowTokens: 10_000,
      fixedOverheadTokens: 2_000,
      inputTokens: 20_000,
    });
    expect(budget.remainingTokens).toBe(0);
    expect(isInputTooLarge(budget)).toBe(true);
  });

  it('剩余预算充足 → 判定非输入过大（正常装配路径）', () => {
    const budget = computeContextBudget({
      windowTokens: 120_000,
      fixedOverheadTokens: 5_000,
      inputTokens: 100,
    });
    expect(budget.remainingTokens).toBeGreaterThan(MIN_RUNNABLE_DIALOGUE_TOKENS);
    expect(isInputTooLarge(budget)).toBe(false);
  });
});

describe('resolveContextWindow · 上下文窗口解析（SSOT 单源公式，宿主构造 Agent 前调用）', () => {
  it('未配置（undefined）→ 回退内核默认 120K', () => {
    expect(resolveContextWindow(undefined)).toBe(120_000);
  });

  it('配置 per-LLM 窗口 → 直接采用（唯一真理源，不封顶）', () => {
    expect(resolveContextWindow(64_000)).toBe(64_000);
    // 超过默认 120K 也照用，绝不被静默砍到默认（用户对自己填写的参数负责）
    expect(resolveContextWindow(200_000)).toBe(200_000);
  });
});

describe('estimateOccupancy · 上下文占用快照组装（SSOT 单点，运行时与宿主历史会话重算共用）', () => {
  it('默认输出预留 15%：各段互斥拼满窗口，free 正确收敛', () => {
    const occ = estimateOccupancy({
      totalTokens: 120_000,
      rolePackBaseTokens: 3_000,
      dialogueTokens: 12_000,
      dialogueCount: 3,
      inputAnchorTokens: 800,
    });
    expect(occ.outputReserveTokens).toBe(18_000); // 120000 × 0.15
    // free = total − (rolepack + dialogue + input + reserve)
    expect(occ.freeTokens).toBe(120_000 - (3_000 + 12_000 + 800 + 18_000));
    // 条数透传
    expect(occ.dialogueCount).toBe(3);
  });

  it('自定义输出预留比例生效', () => {
    const occ = estimateOccupancy({
      totalTokens: 10_000,
      rolePackBaseTokens: 1_000,
      dialogueTokens: 2_000,
      dialogueCount: 1,
      inputAnchorTokens: 0,
      outputReserveRatio: 0.2,
    });
    expect(occ.outputReserveTokens).toBe(2_000); // 10000 × 0.2
    expect(occ.freeTokens).toBe(10_000 - (1_000 + 2_000 + 2_000));
  });

  it('各段超窗口 → free 非负收敛为 0（窗口过小/输入过大时各段归零）', () => {
    const occ = estimateOccupancy({
      totalTokens: 5_000,
      rolePackBaseTokens: 3_000,
      dialogueTokens: 3_000,
      dialogueCount: 2,
      inputAnchorTokens: 500,
    });
    // used = 3000+3000+500+750 = 7250 > 5000 → free 收敛为 0（不出现负值）
    expect(occ.freeTokens).toBe(0);
  });

  it('历史会话重算语义：inputAnchor=0 时仅算对话 + 角色包 + 预留', () => {
    const occ = estimateOccupancy({
      totalTokens: 64_000,
      rolePackBaseTokens: 15_000,
      dialogueTokens: 10_000,
      dialogueCount: 4,
      inputAnchorTokens: 0,
    });
    expect(occ.inputAnchorTokens).toBe(0);
    // free = 64000 − (15000 + 10000 + 0 + 9600)
    expect(occ.freeTokens).toBe(64_000 - (15_000 + 10_000 + 9_600));
  });
});
