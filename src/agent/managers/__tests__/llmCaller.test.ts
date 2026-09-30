/**
 * LlmCaller 单测
 *
 * 重点覆盖**无法从 loop 端方便触达**的两处：
 *   1. `determineTaskType` 纯函数（三分类 + 检测窗口）
 *   2. `resolveProvider` 三分支（fixed / router+缓存 / fallback）
 * 端到端行为（重试、降级、abort）已在 `loop.test.ts` 覆盖，此处不重复。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  determineTaskType,
  LlmCaller,
  type LlmCallerDeps,
  type LlmCallResult,
} from '@/agent/managers/llmCaller.js';
import { LoopMetrics } from '@/agent/managers/loopMetrics.js';
import { NOOP_TRACER } from '@/agent/tracer.js';
import type { LlmProvider, Message, ChatOptions } from '@/llm/provider.js';
import type { TaskType } from '@/llm/types.js';
import type { AgentChunk } from '@/agent/types.js';

function makeProvider(name: string): LlmProvider {
  return {
    name,
    async *chat() {
      yield { content: name };
    },
  } as unknown as LlmProvider;
}

function userMsg(content: string): Message {
  return { role: 'user', content };
}

describe('determineTaskType（纯函数）', () => {
  it('含代码块标记 → code', () => {
    expect(determineTaskType([userMsg('看这段 ```ts\nconst a = 1;\n```')])).toBe('code');
  });

  it('长文本（超过阈值）→ reasoning', () => {
    expect(determineTaskType([userMsg('x'.repeat(600))])).toBe('reasoning');
  });

  it('普通短文本 → simple', () => {
    expect(determineTaskType([userMsg('你好')])).toBe('simple');
  });

  it('无 user 消息 → simple（不抛错）', () => {
    expect(determineTaskType([{ role: 'assistant', content: '你好' }])).toBe('simple');
  });

  it('检测窗口覆盖最近 N 条 user：本轮追问短、上一轮含代码 → 仍判 code', () => {
    const messages: Message[] = [
      userMsg('帮我写 ```ts\nconst a = 1;\n```'),
      { role: 'assistant', content: '好的' },
      userMsg('改一下'),
    ];
    expect(determineTaskType(messages)).toBe('code');
  });

  it('窗口外的代码块不影响判定（超过 TASK_TYPE_WINDOW 条 user 消息之外）', () => {
    const messages: Message[] = [userMsg('```py\nprint(1)\n```')];
    // 填满检测窗口（3 条 user）把代码块挤出
    messages.push(userMsg('a'), userMsg('b'), userMsg('c'));
    expect(determineTaskType(messages)).toBe('simple');
  });
});

describe('LlmCaller.resolveProvider', () => {
  function makeDeps(overrides: Partial<LlmCallerDeps> = {}): LlmCallerDeps {
    const defaultProvider = makeProvider('default');
    return {
      metrics: new LoopMetrics(),
      getStrategy: () => ({
        errorHandling: 'retry',
        multiStepReasoning: 'auto',
        providerRouting: 'auto',
      }),
      getProvider: () => defaultProvider,
      getProviderRouter: () => undefined,
      getCachedProvider: () => undefined,
      setCachedProvider: () => {},
      contextManager: { estimateTokens: () => 0 },
      tracer: NOOP_TRACER,
      hasToolExecutedThisTurn: () => false,
      ...overrides,
    };
  }

  it("providerRouting='fixed' → 固定默认 Provider（跳过 router）", () => {
    const router = vi.fn(() => makeProvider('routed'));
    const caller = new LlmCaller(
      makeDeps({
        getStrategy: () => ({
          errorHandling: 'retry',
          multiStepReasoning: 'auto',
          providerRouting: 'fixed',
        }),
        getProviderRouter: () => router,
      }),
    );

    expect(caller.resolveProvider([userMsg('你好')]).name).toBe('default');
    expect(router).not.toHaveBeenCalled();
  });

  it('无 providerRouter → fallback 默认 Provider', () => {
    const caller = new LlmCaller(makeDeps());
    expect(caller.resolveProvider([userMsg('你好')]).name).toBe('default');
  });

  it('有 providerRouter → 按 taskType 路由并写缓存', () => {
    const setCached = vi.fn();
    const router = vi.fn((_: TaskType) => makeProvider('routed'));
    const caller = new LlmCaller(
      makeDeps({ getProviderRouter: () => router, setCachedProvider: setCached }),
    );

    expect(caller.resolveProvider([userMsg('你好')]).name).toBe('routed');
    expect(router).toHaveBeenCalledWith('simple');
    expect(setCached).toHaveBeenCalledWith('simple', expect.anything());
  });

  it('缓存命中 → 不再调用 router', () => {
    const router = vi.fn(() => makeProvider('routed'));
    const cached = makeProvider('cached');
    const caller = new LlmCaller(
      makeDeps({
        getProviderRouter: () => router,
        getCachedProvider: (taskType) => (taskType === 'simple' ? cached : undefined),
      }),
    );

    expect(caller.resolveProvider([userMsg('你好')]).name).toBe('cached');
    expect(router).not.toHaveBeenCalled();
  });

  it('**getter 语义**：getProvider 被逐次调用，运行期换 provider 立即生效（非构造期快照）', () => {
    // 用可变引用模拟 setProvider 热切换
    let current = makeProvider('v1');
    const caller = new LlmCaller(makeDeps({ getProvider: () => current }));

    expect(caller.resolveProvider([userMsg('你好')]).name).toBe('v1');
    current = makeProvider('v2');
    expect(caller.resolveProvider([userMsg('你好')]).name).toBe('v2');
  });
});

// ─── thought 透传（Turn 意图理解与模型思考展示设计，CoT 防护核心断言）──

describe('LlmCaller.callWithRetry · thought 透传', () => {
  /** 构造带 thought 流的 mock Provider（deepseek 时序：思考增量 → 正文 → tool_calls） */
  function makeDepsWithThoughtProvider(): LlmCallerDeps {
    const thoughtProvider: LlmProvider = {
      name: 'thought-model',
      async *chat() {
        yield { thought: '用户问 A/B 方案对比' };
        yield { thought: '，先查资料' };
        yield { content: '我先搜索相关资料' };
        yield {
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } },
          ],
        };
      },
    } as unknown as LlmProvider;
    return {
      metrics: new LoopMetrics(),
      getStrategy: () => ({
        errorHandling: 'retry',
        multiStepReasoning: 'auto',
        providerRouting: 'fixed',
      }),
      getProvider: () => thoughtProvider,
      getProviderRouter: () => undefined,
      getCachedProvider: () => undefined,
      setCachedProvider: () => {},
      contextManager: { estimateTokens: () => 0 },
      tracer: NOOP_TRACER,
      hasToolExecutedThisTurn: () => false,
    };
  }

  it('thought 增量实时透传为 AgentChunk，且永不拼入 fullContent（CoT 防护）', async () => {
    const caller = new LlmCaller(makeDepsWithThoughtProvider());
    const gen = caller.callWithRetry([userMsg('hi')], {} as ChatOptions, undefined, 1);
    // 手动迭代：chunk 从 yield 收，LlmCallResult 从 return 收。
    // IteratorResult<AgentChunk, LlmCallResult> 的 done 非判别联合，value 需按位断言收窄（测试惯用法）。
    const chunks: AgentChunk[] = [];
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value as AgentChunk);
      step = await gen.next();
    }
    const result = step.value as LlmCallResult;

    // 增量透传：每条 chunk 只带新增片段
    const thoughts = chunks
      .filter((c): c is { type: 'thought'; content: string } => c.type === 'thought')
      .map((c) => c.content);
    expect(thoughts).toEqual(['用户问 A/B 方案对比', '，先查资料']);

    // CoT 防护：正文轨 fullContent 只拼 content，不含任何 thought 文本
    expect(result?.fullContent).toBe('我先搜索相关资料');
    expect(result?.fullContent).not.toContain('用户问 A/B');
    // 工具调用正常累积（thought 与 tool_calls 并存不互相干扰）
    expect(result?.toolCalls).toHaveLength(1);
  });
});

// ─── 空响应重试 ───

describe('LlmCaller.callWithRetry · 空响应重试', () => {
  function makeDeps(provider: LlmProvider): LlmCallerDeps {
    return {
      metrics: new LoopMetrics(),
      getStrategy: () => ({
        errorHandling: 'retry',
        multiStepReasoning: 'auto',
        providerRouting: 'fixed',
      }),
      getProvider: () => provider,
      getProviderRouter: () => undefined,
      getCachedProvider: () => undefined,
      setCachedProvider: () => {},
      contextManager: { estimateTokens: () => 0 },
      tracer: NOOP_TRACER,
      hasToolExecutedThisTurn: () => false,
    };
  }

  it('空响应未耗尽重试 → 自动重试并救回内容（不再一次定生死交兜底）', async () => {
    // 第一次 provider 正常结束但不 yield 任何内容（= 200 但 0 token 的瞬态抽风）；第二次才有正文
    let chatCalls = 0;
    const provider: LlmProvider = {
      name: 'empty-then-fill',
      async *chat() {
        chatCalls++;
        if (chatCalls === 1) return;
        yield { content: '第二次有内容' };
      },
    } as unknown as LlmProvider;
    const caller = new LlmCaller(makeDeps(provider));
    const gen = caller.callWithRetry([userMsg('hi')], {} as ChatOptions, undefined, 1);
    const chunks: AgentChunk[] = [];
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value as AgentChunk);
      step = await gen.next();
    }
    const result = step.value as LlmCallResult;

    // 空响应视为失败重试：chat 共调 2 次，最终拿到第二次内容（而非英文兜底）
    expect(chatCalls).toBe(2);
    expect(result?.fullContent).toBe('第二次有内容');
    // 走既有 retry 通道：发射 retry chunk（attempt>=1）
    expect(chunks.some((c) => c.type === 'retry')).toBe(true);
  });

  it('耗尽重试仍空 → 返回空结果交 loop 兜底（不无限重试）', async () => {
    // 模型静默拒绝（始终空）：重试 MAX 次后仍应返回空，交给 loop 的英文兜底文案
    const provider: LlmProvider = {
      name: 'always-empty',
      async *chat() {
        return; // 恒空
      },
    } as unknown as LlmProvider;
    const caller = new LlmCaller(makeDeps(provider));
    // 用假时钟避免真实退避等待：直接 mock safeSetTimeout 不生效，故仅验证耗尽后返回空结果
    const gen = caller.callWithRetry([userMsg('hi')], {} as ChatOptions, undefined, 1);
    const chunks: AgentChunk[] = [];
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value as AgentChunk);
      step = await gen.next();
    }
    const result = step.value as LlmCallResult;

    // 最终仍为空（不把「模型拒绝」当产出），loop 可据此走 emptyResponseFallback
    expect(result?.fullContent ?? '').toBe('');
    expect(result?.toolCalls ?? []).toHaveLength(0);
    // 诊断三字段随结果透出（空响应分型的裁决依据）：恒空 → 无 finishReason、无 thinking、3 次尝试
    expect(result?.finishReason).toBeUndefined();
    expect(result?.thinkingChars).toBe(0);
    expect(result?.attempts).toBe(3);
  });
});

// ─── 截断型换策略重试（T2）───

describe('LlmCaller.callWithRetry · 截断型换策略重试', () => {
  /** 纠正提示识别片段（TRUNCATION_RECOVERY_HINT 的稳定子串） */
  const HINT_FRAGMENT = '因思考耗尽输出预算被截断';

  /** 记录每次 chat 尝试收到的策略面（降思考 + 提示） */
  interface StrategySeen {
    effort: string | undefined;
    hintCount: number;
  }

  function makeDeps(provider: LlmProvider, metrics = new LoopMetrics()): LlmCallerDeps {
    return {
      metrics,
      getStrategy: () => ({
        errorHandling: 'retry',
        multiStepReasoning: 'auto',
        providerRouting: 'fixed',
      }),
      getProvider: () => provider,
      getProviderRouter: () => undefined,
      getCachedProvider: () => undefined,
      setCachedProvider: () => {},
      contextManager: { estimateTokens: () => 0 },
      tracer: NOOP_TRACER,
      hasToolExecutedThisTurn: () => false,
    };
  }

  /** 采集本次调用各次尝试的策略面 + 手动收尾取 LlmCallResult */
  async function runCall(
    caller: LlmCaller,
  ): Promise<{ result: LlmCallResult; chunks: AgentChunk[] }> {
    const gen = caller.callWithRetry([userMsg('hi')], {} as ChatOptions, undefined, 1);
    const chunks: AgentChunk[] = [];
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value as AgentChunk);
      step = await gen.next();
    }
    return { result: step.value as LlmCallResult, chunks };
  }

  it('截断型空响应 → 换策略重试：第 2 次尝试带 reasoning_effort=low + 一次性纠正提示，救回正文', async () => {
    const seen: StrategySeen[] = [];
    let chatCalls = 0;
    // 模型行为与策略面耦合：双轨齐备才「直接给结论」救回正文；否则再次截断空——
    // 变异验证（去策略任一轨）即表现为「重试仍空」，恰红
    const provider: LlmProvider = {
      name: 'trunc-then-fill',
      async *chat(messages: Message[], opts: ChatOptions) {
        chatCalls++;
        const hintCount = messages.filter((m) => String(m.content).includes(HINT_FRAGMENT)).length;
        seen.push({ effort: opts.reasoning_effort, hintCount });
        if (!(opts.reasoning_effort === 'low' && hintCount === 1)) {
          yield { thought: 'x'.repeat(8), finishReason: 'length' };
          return;
        }
        yield { content: '第二次有正文' };
      },
    } as unknown as LlmProvider;
    const metrics = new LoopMetrics();
    const caller = new LlmCaller(makeDeps(provider, metrics));

    const { result } = await runCall(caller);

    expect(result.fullContent).toBe('第二次有正文');
    expect(chatCalls).toBe(2);
    expect(result.attempts).toBe(2);
    // 首试：策略未生效（截断未判，无降思考、无提示）
    expect(seen[0]).toEqual({ effort: undefined, hintCount: 0 });
    // 第 2 次尝试：双轨齐备（reasoning_effort 增强 + 提示保底）
    expect(seen[1]).toEqual({ effort: 'low', hintCount: 1 });
    // 截断救回计数：曾判截断 + 收场非空 = 救回 +1（真机验证 T2 效力的观测面）
    expect(metrics.truncationRecoveryCount).toBe(1);
  });

  it('截断型连空：策略粘性 + 提示一次性——第 3 次尝试仍降思考且提示不堆叠', async () => {
    const seen: StrategySeen[] = [];
    let chatCalls = 0;
    const provider: LlmProvider = {
      name: 'trunc-twice-then-fill',
      async *chat(messages: Message[], opts: ChatOptions) {
        chatCalls++;
        const hintCount = messages.filter((m) => String(m.content).includes(HINT_FRAGMENT)).length;
        seen.push({ effort: opts.reasoning_effort, hintCount });
        if (chatCalls <= 2) {
          yield { thought: 'x'.repeat(8), finishReason: 'length' };
          return;
        }
        yield { content: '第三次救回' };
      },
    } as unknown as LlmProvider;
    const caller = new LlmCaller(makeDeps(provider));

    const { result } = await runCall(caller);

    expect(result.fullContent).toBe('第三次救回');
    expect(result.attempts).toBe(3);
    // 粘性：判截断后后续尝试全程降推理深度
    expect(seen[1]?.effort).toBe('low');
    expect(seen[2]?.effort).toBe('low');
    // 一次性：纠正提示恒 1 条，不随重试堆叠
    expect(seen[2]?.hintCount).toBe(1);
    // 瞬态型不动策略的对照由「空响应重试」describe 既有用例锁定（无 finishReason → 同参重试）
  });

  it('截断救回计数的反面：救回失败（截断连空耗尽）与瞬态型救回均不计数', async () => {
    // ① 截断连空耗尽：每次尝试都截断空 → 最终仍空，救回失败（归 emptyResponseCount 语义，loop 侧计）
    const alwaysTrunc: LlmProvider = {
      name: 'always-trunc',
      async *chat() {
        yield { thought: 'x'.repeat(8), finishReason: 'length' };
      },
    } as unknown as LlmProvider;
    const metricsA = new LoopMetrics();
    const genA = new LlmCaller(makeDeps(alwaysTrunc, metricsA)).callWithRetry(
      [userMsg('hi')],
      {} as ChatOptions,
      undefined,
      1,
    );
    // 生成器游标命名避开 step 族（术语锚点 §4：新标识符不得蹭 step 载体，历史冻结不新增）
    let cursorA = await genA.next();
    while (!cursorA.done) cursorA = await genA.next();
    expect((cursorA.value as LlmCallResult).fullContent).toBe('');
    expect(metricsA.truncationRecoveryCount).toBe(0);

    // ② 瞬态型（无 finishReason）空后救回：同参重试救回属瞬态纠偏，非换策略救回，不计本计数
    let chatCalls = 0;
    const transient: LlmProvider = {
      name: 'transient-then-fill',
      async *chat() {
        chatCalls++;
        if (chatCalls === 1) return;
        yield { content: '瞬态救回' };
      },
    } as unknown as LlmProvider;
    const metricsB = new LoopMetrics();
    const genB = new LlmCaller(makeDeps(transient, metricsB)).callWithRetry(
      [userMsg('hi')],
      {} as ChatOptions,
      undefined,
      1,
    );
    let cursorB = await genB.next();
    while (!cursorB.done) cursorB = await genB.next();
    expect((cursorB.value as LlmCallResult).fullContent).toBe('瞬态救回');
    expect(metricsB.truncationRecoveryCount).toBe(0);

    // ③ 首试即正常产出：无截断史，不计
    const healthy: LlmProvider = {
      name: 'healthy',
      async *chat() {
        yield { content: '正常产出' };
      },
    } as unknown as LlmProvider;
    const metricsC = new LoopMetrics();
    const genC = new LlmCaller(makeDeps(healthy, metricsC)).callWithRetry(
      [userMsg('hi')],
      {} as ChatOptions,
      undefined,
      1,
    );
    let cursorC = await genC.next();
    while (!cursorC.done) cursorC = await genC.next();
    expect(metricsC.truncationRecoveryCount).toBe(0);
  });

  it('截断重试期间用户中止 → 不计救回（中止不是模型产出）', async () => {
    // 背景（真机 round-1790686368607 排雷）：`isEmptyResponse` 判据内含 `!aborted`，中止时恒为
    // false ⇒ 若不在计数判据显式排除 aborted，「用户放弃」会被记成「换策略救回成功」（计数假阳）。
    // 变异方向：把 `truncatedRetry && !aborted && !isEmptyResponse` 退回缺 `!aborted` 的形态 → 本例恰红。
    let chatCalls = 0;
    const ac = new AbortController();
    const abortProvider: LlmProvider = {
      name: 'trunc-then-user-abort',
      async *chat(messages: Message[], opts: ChatOptions) {
        chatCalls++;
        const hintCount = messages.filter((m) => String(m.content).includes(HINT_FRAGMENT)).length;
        // 首试：截断空 → 触发换策略（粘性置位）
        if (!(opts.reasoning_effort === 'low' && hintCount === 1)) {
          yield { thought: 'x'.repeat(8), finishReason: 'length' };
          return;
        }
        // 换策略尝试：吐一段思考后用户点停止 ⇒ 本次尝试未有产出
        yield { thought: 'y'.repeat(8) };
        ac.abort();
        yield { thought: 'z'.repeat(8) };
      },
    } as unknown as LlmProvider;
    const metricsD = new LoopMetrics();
    const genD = new LlmCaller(makeDeps(abortProvider, metricsD)).callWithRetry(
      [userMsg('hi')],
      {} as ChatOptions,
      ac.signal,
      1,
    );
    let cursorD = await genD.next();
    while (!cursorD.done) cursorD = await genD.next();
    const result = cursorD.value as LlmCallResult;

    expect(chatCalls).toBe(2);
    expect(result.aborted).toBe(true);
    expect(result.fullContent).toBe('');
    // 核心：中止 ≠ 救回（真机此形态曾产出 recov=1 的假阳）
    expect(metricsD.truncationRecoveryCount).toBe(0);
  });
});

// ─── 发送边界守卫（TOOLPAIR-2 Step 2）───

describe('LlmCaller.callWithRetry · 发送边界守卫', () => {
  function makeDeps(provider: LlmProvider, metrics: LoopMetrics): LlmCallerDeps {
    return {
      metrics,
      getStrategy: () => ({
        errorHandling: 'retry',
        multiStepReasoning: 'auto',
        providerRouting: 'fixed',
      }),
      getProvider: () => provider,
      getProviderRouter: () => undefined,
      getCachedProvider: () => undefined,
      setCachedProvider: () => {},
      contextManager: { estimateTokens: () => 0 },
      tracer: NOOP_TRACER,
      hasToolExecutedThisTurn: () => false,
    };
  }

  it('畸形批次（assistant.tool_calls 无配对 tool 消息）→ 拒发：provider.chat 不被调用、抛守卫错误、计数 +1', async () => {
    const metrics = new LoopMetrics();
    const chatSpy = vi.fn(function* () {
      yield { content: '不应发出' };
    });
    const caller = new LlmCaller(
      makeDeps({ name: 'p', chat: chatSpy } as unknown as LlmProvider, metrics),
    );
    const malformed = [
      {
        role: 'assistant' as const,
        content: '要读文件',
        toolCalls: [
          { id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } },
        ],
      },
    ] as Message[];

    const gen = caller.callWithRetry(malformed, {} as ChatOptions, undefined, 1);
    // 生成器在首个 .next() 即抛（守卫在重试循环前 fail-fast）
    await expect(gen.next()).rejects.toThrow('发送边界守卫拒绝');
    expect(chatSpy).not.toHaveBeenCalled();
    expect(metrics.llmPairingGuardFires).toBe(1);
  });

  it('健康态（无工具轮）→ 守卫零触发、照常发送', async () => {
    const metrics = new LoopMetrics();
    const chatSpy = vi.fn(function* () {
      yield { content: 'ok' };
    });
    const caller = new LlmCaller(
      makeDeps({ name: 'p', chat: chatSpy } as unknown as LlmProvider, metrics),
    );

    const chunks: AgentChunk[] = [];
    const gen = caller.callWithRetry([userMsg('hi')], {} as ChatOptions, undefined, 1);
    let step = await gen.next();
    while (!step.done) {
      chunks.push(step.value as AgentChunk);
      step = await gen.next();
    }
    const result = step.value as LlmCallResult;

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(metrics.llmPairingGuardFires).toBe(0);
    expect(result?.fullContent).toBe('ok');
  });
});
