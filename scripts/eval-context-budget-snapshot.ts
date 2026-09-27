/**
 * 上下文预算 · 确定性快照（eval harness · 离线可复现）
 *
 * 定位：
 *   业界 2026 已把 agent 评估量化为「每查询 token 数 + 准确率」双轴（Mem0 LoCoMo: 6,956 tok；
 *   full-context 26,000 tok）。若本仓只有**需要真实 LLM 端点**的一次性脚本
 *   （test-memory-tool-recall-real.ts / -full.ts），无法在离线/CI 中复现 →
 *   「三级空间管理省多少 token」「预算公式实际切出多少轮」这两个核心效率主张
 *   **零自有数字**。本脚本补上这个空洞：不调 LLM、不联网，纯粹测内核**纯函数 + 无状态计算**，
 *   输出**稳定可 diff 的指标快照**。
 *
 * 用法：
 *   npx tsx scripts/eval-context-budget-snapshot.ts            # 打印快照
 *   npx tsx scripts/eval-context-budget-snapshot.ts --json     # 输出 JSON（供 CI 比对）
 *   npx tsx scripts/eval-context-budget-snapshot.ts --check    # 与基准快照比对，漂移则 exit 1
 *
 * 度量维度（对齐业界五维中可离线复现的三维）：
 *   1. token consumption —— 预算公式在给定窗口下切出的「完整对话层」可用 token
 *   2. 轮数派生 —— deriveDialogueRounds 在给定输入下切出多少轮（动态轮数的真值）
 *   3. 截断行为 —— truncateMessages 在压力下的压缩比（保留/丢弃比例）
 *
 * 验收：--check 模式下与 BASELINE 完全一致 → exit 0；漂移 → 打印差异并 exit 1。
 * 说明：快照数值由**当前实现**决定，不是「正确答案」。它锁的是**行为不变性**——
 *       任何触碰预算/截断/轮数派生的改动，都会让快照变化，迫使改动者显式确认
 *       「这是我想要的语义变更，不是手滑」。这与 .trae/rules 的纪律一致。
 */
import { computeContextBudget, deriveDialogueRounds } from '../src/agent/budget.js';
import { ContextManager } from '../src/agent/contextManager.js';
import type { Message } from '../src/llm/provider.js';
import type { LlmProvider } from '../src/llm/provider.js';
import { NOOP_TRACER } from '../src/agent/tracer.js';

// ─── 场景定义（固定输入，保证可复现）──────────────────

interface BudgetScenario {
  name: string;
  windowTokens: number;
  inputTokens: number;
  fixedOverheadTokens: number;
}

const BUDGET_SCENARIOS: readonly BudgetScenario[] = [
  { name: 'win-120K/短输入', windowTokens: 120_000, inputTokens: 200, fixedOverheadTokens: 3_000 },
  {
    name: 'win-120K/中输入',
    windowTokens: 120_000,
    inputTokens: 2_000,
    fixedOverheadTokens: 3_000,
  },
  {
    name: 'win-120K/长输入',
    windowTokens: 120_000,
    inputTokens: 20_000,
    fixedOverheadTokens: 3_000,
  },
  {
    name: 'win-200K/中输入',
    windowTokens: 200_000,
    inputTokens: 2_000,
    fixedOverheadTokens: 5_000,
  },
  {
    name: 'win-1M/中输入',
    windowTokens: 1_000_000,
    inputTokens: 2_000,
    fixedOverheadTokens: 5_000,
  },
];

/** 构造一条消息 */
function msg(role: Message['role'], content: string): Message {
  return { role, content };
}

/**
 * 构造「system + N 轮对话」消息数组（首条必须是 system，truncateMessages 的硬前提）。
 * 每轮 = user + assistant，每条正文约 tokensPerMsg token。
 */
function buildConversation(rounds: number, tokensPerMsg: number): Message[] {
  const filler = 'x'.repeat(Math.max(0, tokensPerMsg * 4 - 12));
  const out: Message[] = [msg('system', 'You are a helper.')];
  for (let i = 0; i < rounds; i++) {
    out.push(msg('user', `第${i}轮提问 ${filler}`));
    out.push(msg('assistant', `第${i}轮回答 ${filler}`));
  }
  return out;
}

/** 构造一个不联网的 provider 桩（truncateMessages 路径不调用它，仅为构造 ContextManager） */
function stubProvider(): LlmProvider {
  return { chat: async () => ({ content: '' }) } as unknown as LlmProvider;
}

// ─── 快照结构 ──────────────────────────────────

interface Snapshot {
  budget: Array<{
    scenario: string;
    availableTokens: number;
    anchorTokens: number;
    remainingTokens: number;
    dialogueBudgetTokens: number;
  }>;
  dialogueRounds: Array<{
    scenario: string;
    roundCosts: number;
    recentRoundCount: number;
    firstRoundIncluded: boolean;
    usedTokens: number;
  }>;
  truncation: Array<{
    scenario: string;
    beforeTokens: number;
    afterTokens: number;
    compressionRatio: string;
    keptMessages: number;
  }>;
}

function buildSnapshot(): Snapshot {
  // 1. 预算切分
  const budget = BUDGET_SCENARIOS.map((s) => {
    const b = computeContextBudget({
      windowTokens: s.windowTokens,
      inputTokens: s.inputTokens,
      fixedOverheadTokens: s.fixedOverheadTokens,
    });
    return {
      scenario: s.name,
      availableTokens: b.availableTokens,
      anchorTokens: b.anchorTokens,
      remainingTokens: b.remainingTokens,
      dialogueBudgetTokens: b.dialogueBudgetTokens,
    };
  });

  // 2. 轮数派生（固定每轮成本，验证「从最近往回塞到预算止」+ 首轮必在场）
  const roundsCases = [
    { name: '预算8000/每轮1000/30轮', roundCosts: 30, perRound: 1_000, budgetTokens: 8_000 },
    { name: '预算8000/每轮1000/5轮', roundCosts: 5, perRound: 1_000, budgetTokens: 8_000 },
    { name: '预算8000/每轮300/30轮', roundCosts: 30, perRound: 300, budgetTokens: 8_000 },
  ];
  const dialogueRounds = roundsCases.map((c) => {
    const costs = Array.from({ length: c.roundCosts }, () => c.perRound);
    const d = deriveDialogueRounds(costs, c.budgetTokens);
    return {
      scenario: c.name,
      roundCosts: c.roundCosts,
      recentRoundCount: d.recentRoundCount,
      firstRoundIncluded: d.firstRoundIncluded,
      usedTokens: d.usedTokens,
    };
  });

  // 3. 截断行为（同一构造的对话在压/不压窗口下的压缩比）
  const mkCM = (window: number): ContextManager =>
    new ContextManager({
      maxContextTokens: window,
      provider: stubProvider(),
      providerRouter: undefined,
      contextTruncatedFn: () => '',
      tracer: NOOP_TRACER,
      onContextTruncated: undefined,
      roundSummaryLoader: undefined,
      minRecentRounds: 0,
    });

  const truncation = [
    { scenario: 'win-8000/50轮(超压)', window: 8_000, rounds: 50, tokensPerMsg: 200 },
    { scenario: 'win-8000/10轮(轻压)', window: 8_000, rounds: 10, tokensPerMsg: 200 },
    { scenario: 'win-120000/50轮(不压)', window: 120_000, rounds: 50, tokensPerMsg: 200 },
  ].map((t) => {
    const cm = mkCM(t.window);
    const messages = buildConversation(t.rounds, t.tokensPerMsg);
    const before = cm.estimateTokens(messages);
    const after = cm.truncateMessages(messages);
    const afterTokens = cm.estimateTokens(after);
    return {
      scenario: t.scenario,
      beforeTokens: before,
      afterTokens,
      compressionRatio: before === 0 ? 'n/a' : (afterTokens / before).toFixed(3),
      keptMessages: after.length,
    };
  });

  return { budget, dialogueRounds, truncation };
}

// ─── 基准快照（--check 用它比对）──────────────────
// 说明：本常量是「行为基线」，不是「目标值」。改动预算/截断/轮数派生后此文件会漂移，
//       改动者需显式确认语义并在提交里更新它（git diff 即审计痕迹）。
const BASELINE: Snapshot = {
  budget: [
    {
      scenario: 'win-120K/短输入',
      availableTokens: 99000,
      anchorTokens: 200,
      remainingTokens: 98800,
      dialogueBudgetTokens: 88920,
    },
    {
      scenario: 'win-120K/中输入',
      availableTokens: 99000,
      anchorTokens: 2000,
      remainingTokens: 97000,
      dialogueBudgetTokens: 87300,
    },
    {
      scenario: 'win-120K/长输入',
      availableTokens: 99000,
      anchorTokens: 20000,
      remainingTokens: 79000,
      dialogueBudgetTokens: 71100,
    },
    {
      scenario: 'win-200K/中输入',
      availableTokens: 165000,
      anchorTokens: 2000,
      remainingTokens: 163000,
      dialogueBudgetTokens: 146700,
    },
    {
      scenario: 'win-1M/中输入',
      availableTokens: 845000,
      anchorTokens: 2000,
      remainingTokens: 843000,
      dialogueBudgetTokens: 758700,
    },
  ],
  dialogueRounds: [
    {
      scenario: '预算8000/每轮1000/30轮',
      roundCosts: 30,
      recentRoundCount: 8,
      firstRoundIncluded: true,
      usedTokens: 8000,
    },
    {
      scenario: '预算8000/每轮1000/5轮',
      roundCosts: 5,
      recentRoundCount: 5,
      firstRoundIncluded: false,
      usedTokens: 5000,
    },
    {
      scenario: '预算8000/每轮300/30轮',
      roundCosts: 30,
      recentRoundCount: 26,
      firstRoundIncluded: true,
      usedTokens: 7800,
    },
  ],
  truncation: [
    {
      scenario: 'win-8000/50轮(超压)',
      beforeTokens: 26633,
      afterTokens: 6931,
      compressionRatio: '0.260',
      keptMessages: 28,
    },
    {
      scenario: 'win-8000/10轮(轻压)',
      beforeTokens: 5326,
      afterTokens: 5326,
      compressionRatio: '1.000',
      keptMessages: 21,
    },
    {
      scenario: 'win-120000/50轮(不压)',
      beforeTokens: 26633,
      afterTokens: 26633,
      compressionRatio: '1.000',
      keptMessages: 101,
    },
  ],
};

// ─── 输出 ──────────────────────────────────────

function printHuman(s: Snapshot): void {
  console.log('\n📊 上下文预算 · 确定性快照\n');
  console.log(
    '── 1. 预算切分（可用 = 窗口×0.85 − 固定开销；锚点 = 本轮输入×1；对话层 = 剩余×0.9）──',
  );
  for (const b of s.budget) {
    console.log(
      `  ${b.scenario.padEnd(20)} 可用=${String(b.availableTokens).padStart(7)}  锚点=${String(b.anchorTokens).padStart(6)}  剩余=${String(b.remainingTokens).padStart(7)}  对话层=${String(b.dialogueBudgetTokens).padStart(7)}`,
    );
  }
  console.log('\n── 2. 动态轮数派生（deriveDialogueRounds：从最近往回塞到预算止 + 首轮必在场）──');
  for (const d of s.dialogueRounds) {
    console.log(
      `  ${d.scenario.padEnd(24)} 总轮=${String(d.roundCosts).padStart(3)}  →  塞入=${String(d.recentRoundCount).padStart(3)} 轮  已用=${String(d.usedTokens).padStart(6)}  首轮补入=${d.firstRoundIncluded}`,
    );
  }
  console.log('\n── 3. 截断压缩比（压力下保留下方、裁中间；窗口内不动）──');
  for (const t of s.truncation) {
    console.log(
      `  ${t.scenario.padEnd(22)} ${String(t.beforeTokens).padStart(7)} → ${String(t.afterTokens).padStart(7)} tok  比=${t.compressionRatio}  保留 ${t.keptMessages} 条`,
    );
  }
  console.log('');
}

function diffSnapshots(a: Snapshot, b: Snapshot): string[] {
  const diffs: string[] = [];
  const cmp = <T extends Record<string, unknown>>(
    label: string,
    x: readonly T[],
    y: readonly T[],
  ): void => {
    if (x.length !== y.length) {
      diffs.push(`${label}: 条目数 ${x.length} → ${y.length}`);
      return;
    }
    for (let i = 0; i < x.length; i++) {
      const xa = JSON.stringify(x[i]);
      const yb = JSON.stringify(y[i]);
      if (xa !== yb) diffs.push(`${label}[${i}]:\n       基准 ${xa}\n       当前 ${yb}`);
    }
  };
  cmp('budget', a.budget, b.budget);
  cmp('dialogueRounds', a.dialogueRounds, b.dialogueRounds);
  cmp('truncation', a.truncation, b.truncation);
  return diffs;
}

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const check = args.includes('--check');
  const snapshot = buildSnapshot();

  if (asJson) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    printHuman(snapshot);
  }

  if (check) {
    const diffs = diffSnapshots(BASELINE, snapshot);
    if (diffs.length === 0) {
      console.log('✅ 快照与基准一致（行为不变，exit 0）');
      process.exitCode = 0;
    } else {
      console.error(
        `\n❌ 快照漂移 ${diffs.length} 处（若为有意的语义变更，请更新本文件 BASELINE）：`,
      );
      for (const d of diffs) console.error(`   - ${d}`);
      process.exitCode = 1;
    }
  }
}

main();
