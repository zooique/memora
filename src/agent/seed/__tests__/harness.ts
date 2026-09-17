/**
 * seed 三阶段单元测试共享装备
 *
 * 以 vi.fn() 桩替代全部协作对象（AgentLoop / MessageHistory / SessionManager /
 * RolePackManager / ContextPreparer / SessionNamer / RoundSummaryGenerator / Tracer），
 * 返回可控的 SeedDeps，供 prepare / act / reflect / orchestrator 独立测试复用。
 *
 * 设计：
 *   - getParts() 经闭包返回桩对象，测试可经 mocks.* 直接覆写行为
 *   - consumeExecutionStream 桩：转发 produce 流的 chunk 后，返回可注入的 consumeResult
 *     （content / aborted / failed 由测试指定，逼近真门面流收口语义）
 *   - rolePackManager.getActive 默认返回 null → 策略解析回退 DEFAULT_BEHAVIOR_STRATEGY
 */

import { vi } from 'vitest';
import type { AgentLoop } from '@/agent/loop.js';
import type { MessageHistory } from '@/agent/messageHistory.js';
import type { SessionManager } from '@/agent/managers/sessionManager.js';
import type { RolePackManager } from '@/role-pack/rolePackManager.js';
import type { ContextPreparer } from '@/agent/contextPreparer.js';
import type { RoundSummaryGenerator } from '@/agent/managers/roundSummaryGenerator.js';
import type { SessionNamer } from '@/agent/managers/sessionNamer.js';
import { DEFAULT_BEHAVIOR_STRATEGY } from '@/role-pack/strategyResolver.js';
import type { BehaviorStrategy } from '@/role-pack/types.js';
import type { AgentChunk } from '@/agent/types.js';
import type { LlmProvider, Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';
import type { ITracer } from '@/agent/tracer.js';
import type { StreamConsumeResult, SeedDeps, SeedParts } from '@/agent/seed/types.js';

/** 可注入的流消费结果（默认正常完成） */
export interface ConsumeControl {
  result: StreamConsumeResult;
}

/** seed 桩集合（测试经 mocks 覆写行为） */
export interface SeedMocks {
  loop: {
    cleanTemporarySystemMessages: ReturnType<typeof vi.fn>;
    setStrategy: ReturnType<typeof vi.fn>;
    setCurrentRoundId: ReturnType<typeof vi.fn>;
    allocRoundId: ReturnType<typeof vi.fn>;
    getCurrentRoundId: ReturnType<typeof vi.fn>;
    processUserInput: ReturnType<typeof vi.fn>;
    continueAfterPause: ReturnType<typeof vi.fn>;
    injectSystemMessage: ReturnType<typeof vi.fn>;
  };
  history: {
    appendUser: ReturnType<typeof vi.fn>;
    appendAssistant: ReturnType<typeof vi.fn>;
    // 非正常收场统一收口（2026-09-15）：orchestrator.act 对 aborted/failed 共用本原语
    appendInterrupted: ReturnType<typeof vi.fn>;
    registerPendingArchive: ReturnType<typeof vi.fn>;
  };
  sessionManager: {
    getCheckpoint: ReturnType<typeof vi.fn>;
    // 会议机制（S5 确定性触发）：prepare 预置任务表写点（默认为空，测试可注入）
    writePlan: ReturnType<typeof vi.fn>;
    // 任务链收尾/硬中止清场（⑦ 排雷 2026-08-29）：防残留 plan 影响下一次输入
    clearPlan: ReturnType<typeof vi.fn>;
    // 在途计划谓词（SSOT = SessionManager.hasInflightPlan）：会议骨架预置守卫消费
    hasInflightPlan: ReturnType<typeof vi.fn>;
    // 形态② 兜底收尾（PLAN-SYNC-1 ①）：act 正常收尾分支触发，测试可断言调用/不调用
    concludeActiveStepIfPlanFullyReached: ReturnType<typeof vi.fn>;
  };
  rolePackManager: {
    getActive: ReturnType<typeof vi.fn>;
    // 会议机制（S5）：范围校验 / 本轮装配视角 / 组上下文块
    resolveRoundAssemblyRole: ReturnType<typeof vi.fn>;
    setRoundAssemblyRole: ReturnType<typeof vi.fn>;
    buildTeamContextBlock: ReturnType<typeof vi.fn>;
    // 会议机制骨架预置（2026-09-07 回归）：确定性骨架单入口（默认 null 不触发）
    tryBuildMeetingPlan: ReturnType<typeof vi.fn>;
  };
  contextPreparer: {
    assembleContext: ReturnType<typeof vi.fn>;
  };
  sessionNamer: { ensureSessionTitle: ReturnType<typeof vi.fn> };
  roundSummaryGenerator: { generate: ReturnType<typeof vi.fn> };
  tracer: { startSpan: ReturnType<typeof vi.fn> };
  span: { end: ReturnType<typeof vi.fn> };
  applyRolePackToolExposure: ReturnType<typeof vi.fn>;
  /** 会议机制（S5）：按本轮装配视角刷新 loop 前缀（prepare 每轮调用；缺省 no-op 测试不断言） */
  refreshRolePackPrefixForRound: ReturnType<typeof vi.fn>;
  /** 流收口桩（AsyncGenerator，forward 后返回注入的 consumeResult） */
  consumeExecutionStream: ReturnType<typeof vi.fn>;
}

/**
 * 构建可覆写策略（默认为 DEFAULT_BEHAVIOR_STRATEGY 派生）
 *
 * 用对象字面量展开 + 整体 cast 规避 BehaviorStrategy 字段 readonly，避免对只读属性赋值。
 */
export function makeStrategy(
  p: {
    summary?: 'on' | 'off';
    summaryFocus?: string;
  } = {},
): BehaviorStrategy {
  return {
    ...DEFAULT_BEHAVIOR_STRATEGY,
    prepare: {
      ...DEFAULT_BEHAVIOR_STRATEGY.prepare,
      ...(p.summaryFocus !== undefined ? { summaryFocus: p.summaryFocus } : {}),
    },
    act: { ...DEFAULT_BEHAVIOR_STRATEGY.act },
    reflect: {
      ...DEFAULT_BEHAVIOR_STRATEGY.reflect,
      ...(p.summary !== undefined ? { summary: p.summary } : {}),
    },
    global: {
      ...DEFAULT_BEHAVIOR_STRATEGY.global,
    },
  } as BehaviorStrategy;
}

/** 让角色包桩返回指定激活策略 list */
export function useStrategy(mocks: SeedMocks, strategyValue: BehaviorStrategy): void {
  mocks.rolePackManager.getActive.mockReturnValue({ strategy: strategyValue });
}

/**
 * 由桩集构建组件快照（SeedParts）
 * @param mocks 桩集合
 * @returns 组件快照（含 history 只读 getter）
 */
export function buildParts(mocks: SeedMocks): SeedParts {
  return {
    loop: mocks.loop as unknown as AgentLoop,
    history: {
      ...mocks.history,
      get currentDateValue() {
        return '2026-08-20';
      },
      get currentSessionValue() {
        return 'main';
      },
      get currentSessionName() {
        return '2026-08-20-main';
      },
    } as unknown as MessageHistory,
    sessionManager: mocks.sessionManager as unknown as SessionManager,
    rolePackManager: mocks.rolePackManager as unknown as RolePackManager,
    contextPreparer: mocks.contextPreparer as unknown as ContextPreparer,
    sessionNamer: mocks.sessionNamer as unknown as SessionNamer,
    roundSummaryGenerator: mocks.roundSummaryGenerator as unknown as RoundSummaryGenerator,
  };
}

/**
 * 构建 seed 测试装备
 * @param overrides 覆盖 SeedDeps 的字段（如注入真流收口）
 * @returns { mocks, consumeControl, deps }
 */
export function createHarness(overrides: Partial<SeedDeps> = {}) {
  // 可变的当前轮 ID（测试借 setCurrentRoundId 状态推进；getCurrentRoundId 读同一状态）
  const consumeControl: ConsumeControl = {
    result: { content: 'assistant-答', aborted: false, paused: false, failed: false },
  };
  // loop roundId 的原子状态：供 setCurrentRoundId/getCurrentRoundId 共享，模拟真实 loop 的轮次推进
  let currentRoundId = 'round-1';
  // allocRoundId 自增计数：每次分配返回不重复的 round id
  let allocCounter = 0;

  const mocks: SeedMocks = {
    loop: {
      cleanTemporarySystemMessages: vi.fn(),
      setStrategy: vi.fn(),
      // setCurrentRoundId/getCurrentRoundId 共享同一可变状态，还原 loop"单轮内同 id"的语义
      setCurrentRoundId: vi.fn((id: string) => {
        currentRoundId = id;
      }),
      allocRoundId: vi.fn(() => `round-alloc-${++allocCounter}`),
      getCurrentRoundId: vi.fn(() => currentRoundId),
      processUserInput: vi.fn(),
      continueAfterPause: vi.fn(),
      injectSystemMessage: vi.fn(),
    },
    history: {
      appendUser: vi.fn(async () => {}),
      appendAssistant: vi.fn(async () => {}),
      appendInterrupted: vi.fn(async () => {}),
      registerPendingArchive: vi.fn(),
    },
    sessionManager: {
      getCheckpoint: vi.fn(() => null),
      writePlan: vi.fn(() => []),
      clearPlan: vi.fn(),
      // 默认「无在途计划」；需在途语义的用例显式 mockReturnValue(true)
      hasInflightPlan: vi.fn(() => false),
      concludeActiveStepIfPlanFullyReached: vi.fn(),
    },
    rolePackManager: {
      getActive: vi.fn(() => null),
      resolveRoundAssemblyRole: vi.fn(() => null),
      setRoundAssemblyRole: vi.fn(),
      buildTeamContextBlock: vi.fn(() => ''),
      tryBuildMeetingPlan: vi.fn(() => null),
    },
    contextPreparer: {
      assembleContext: vi.fn(async () => {}),
    },
    sessionNamer: { ensureSessionTitle: vi.fn(async () => {}) },
    roundSummaryGenerator: { generate: vi.fn(async () => {}) },
    tracer: { startSpan: vi.fn() },
    span: { end: vi.fn() },
    applyRolePackToolExposure: vi.fn(),
    refreshRolePackPrefixForRound: vi.fn(),
    consumeExecutionStream: vi.fn(async function* (
      source: AsyncGenerator<AgentChunk, void, unknown>,
      _signal?: AbortSignal,
    ) {
      for await (const chunk of source) yield chunk;
      return consumeControl.result;
    }),
  };
  mocks.tracer.startSpan.mockReturnValue(mocks.span);

  const deps: SeedDeps = {
    getParts: () => buildParts(mocks),
    tracer: mocks.tracer as unknown as ITracer,
    archiveMode: 'full',
    messages: undefined,
    applyRolePackToolExposure: mocks.applyRolePackToolExposure as unknown as SeedDeps['applyRolePackToolExposure'],
    // 会议机制（S5）：按本轮装配视角刷新 loop 前缀（prepare 每轮调用）
    refreshRolePackPrefixForRound: mocks.refreshRolePackPrefixForRound as unknown as SeedDeps['refreshRolePackPrefixForRound'],
    consumeExecutionStream: mocks.consumeExecutionStream as unknown as SeedDeps['consumeExecutionStream'],
    // 难度分级后台 Provider（默认 NULL → 判定 unknown，不影响既有测试主回答摘要）
    getBackgroundProvider: () => null,
    ...overrides,
  };

  return { mocks, consumeControl, deps };
}

/** 转发一个文本 chunk 流（helper，供 orche/act 测试构造 produce 用） */
export function textStream(resultContent: string): AsyncGenerator<AgentChunk, void, unknown> {
  return (async function* () {
    yield { type: 'text', content: resultContent };
  })();
}

/**
 * 构造一个按既定判词/文本响应的 mock LlmProvider（测试后台 Provider、难度分级、汇报用）
 * @param respond 每次 chat 输出该文本（可传函数，第二次起返回 ''）
 */
export function mockProvider(respond: string | (() => string)): LlmProvider {
  const get = typeof respond === 'function' ? respond : () => respond;
  return {
    name: 'mock-bg',
    supportedModels: [],
    async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
      yield { content: get() };
      yield { finishReason: 'stop' };
    },
  } as unknown as LlmProvider;
}

/**
 * 驱动一个 async generator 至完成，收集其 yield 的 chunk 与完成值
 *
 * for-await 拿不到 generator 的 return 值，故用 next() 逐次推进。
 * @param g ASEED 阶段的 AsyncGenerator
 * @returns yield 的 chunk 列表 + 完成值（若有）
 */
export async function collectGen<T>(
  g: AsyncGenerator<AgentChunk, T, unknown>,
): Promise<{ chunks: AgentChunk[]; result?: T }> {
  const chunks: AgentChunk[] = [];
  let result: T | undefined;
  for (;;) {
    const next = await g.next();
    if (next.done) {
      result = next.value;
      break;
    }
    chunks.push(next.value);
  }
  return { chunks, result };
}