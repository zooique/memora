/**
 * LlmCaller 单测
 *
 * 重点覆盖**无法从 loop 端方便触达**的两处：
 *   1. `determineTaskType` 纯函数（三分类 + 检测窗口）
 *   2. `resolveProvider` 三分支（fixed / router+缓存 / fallback）
 * 端到端行为（重试、降级、abort）已在 `loop.test.ts` 覆盖，此处不重复。
 */

import { describe, it, expect, vi } from 'vitest';
import { determineTaskType, LlmCaller, type LlmCallerDeps, type LlmCallResult } from '@/agent/managers/llmCaller.js';
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
          toolCalls: [{ id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
        };
      },
    } as unknown as LlmProvider;
    return {
      metrics: new LoopMetrics(),
      getStrategy: () => ({ errorHandling: 'retry', multiStepReasoning: 'auto', providerRouting: 'fixed' }),
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
      getStrategy: () => ({ errorHandling: 'retry', multiStepReasoning: 'auto', providerRouting: 'fixed' }),
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
  });
});

// ─── 发送边界守卫（TOOLPAIR-2 Step 2）───

describe('LlmCaller.callWithRetry · 发送边界守卫', () => {
  function makeDeps(provider: LlmProvider, metrics: LoopMetrics): LlmCallerDeps {
    return {
      metrics,
      getStrategy: () => ({ errorHandling: 'retry', multiStepReasoning: 'auto', providerRouting: 'fixed' }),
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
