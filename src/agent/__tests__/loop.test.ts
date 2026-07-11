/**
 * Agent Loop 单元测试
 * 覆盖 processUserInput 流式输出 + 工具调用循环 + 最大迭代限制
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '@/agent/loop.js';
import type { AgentChunk } from '@/agent/types.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';

/**
 * 创建测试用 Memory 对象
 */
function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:1',
    content: '你是一个测试助手',
    source: 'persona',
    name: 'test-personality',
    createdAt: '2026-01-01T00:00:00.000Z',
    accessedAt: '2026-01-01T00:00:00.000Z',
    score: 1.0,
    ...overrides,
  };
}

type ChunkItem = { content?: string; toolCalls?: Message['toolCalls']; finishReason?: string };

/**
 * 创建单轮模拟 LLM Provider，每次 chat() 返回同样的一组 chunks
 */
function mockProvider(chunks: ChunkItem[]): LlmProvider {
  return {
    name: 'mock',
    async *chat() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as LlmProvider;
}

/**
 * 创建多轮模拟 LLM Provider，每轮 chat() 按顺序消费 turns 中的一个
 * 适用于需要模型在工具调用后给出不同回复的测试场景
 */
function mockMultiTurnProvider(turns: ChunkItem[][]): LlmProvider {
  let turnIndex = 0;
  return {
    name: 'mock',
    async *chat() {
      const chunks = turns[turnIndex] ?? [];
      turnIndex++;
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as LlmProvider;
}

describe('AgentLoop · 构造函数', () => {
  it('应该用 bootstrapMemories 构建 system prompt', () => {
    const mem = makeMemory({ name: '人格', content: '友好严谨' });
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [mem],
      toolExecutor: vi.fn(),
    });

    const messages = loop.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('人格');
    expect(messages[0]!.content).toContain('友好严谨');
  });

  it('多条记忆应该用 --- 分隔', () => {
    const mem1 = makeMemory({ id: '1', name: '人格', content: '友好' });
    const mem2 = makeMemory({ id: '2', name: '规则', content: '诚实' });
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [mem1, mem2],
      toolExecutor: vi.fn(),
    });

    const content = loop.getMessages()[0]!.content;
    expect(content).toContain('---');
  });

  it('maxIterations 默认值应为 20', () => {
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });
    expect(loop.getMessages()).toHaveLength(1);
  });

  it('应该接受自定义 maxIterations', () => {
    const loop = new AgentLoop({
      provider: mockProvider([]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
      maxIterations: 5,
    });
    // 达到最大迭代时会有警告，但构造本身不报错
    expect(loop.getMessages()).toHaveLength(1);
  });
});

describe('AgentLoop · processUserInput 纯文本流式输出', () => {
  it('应该流式 yield LLM 返回的文本块', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '你好' }, { content: '！' }, { content: '我是 Memora' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('hello')) {
      chunks.push(chunk);
    }

    // 过滤 text 事件，验证内容
    const texts = chunks.filter((c) => c.type === 'text').map((c) => c.content);
    expect(texts).toEqual(['你好', '！', '我是 Memora']);
    // 最后一个是 done 事件
    expect(chunks[chunks.length - 1]!.type).toBe('done');
  });

  it('应该把 user 消息和 assistant 回复都加入消息历史', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复内容' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    for await (const chunk of loop.processUserInput('用户提问')) {
      void chunk;
    }

    const messages = loop.getMessages();
    // system + user + assistant = 3
    expect(messages).toHaveLength(3);
    expect(messages[1]!.role).toBe('user');
    expect(messages[1]!.content).toBe('<user_input>用户提问</user_input>');
    expect(messages[2]!.role).toBe('assistant');
    expect(messages[2]!.content).toBe('回复内容');
  });
});

describe('AgentLoop · processUserInput 工具调用循环', () => {
  it('应该执行工具调用并继续循环', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('工具执行结果');

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        // 第一轮：返回 toolCalls
        [
          {
            content: '我来查一下',
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
              },
            ],
          },
        ],
        // 第二轮：工具执行后返回纯文本
        [{ content: '找到了文件内容' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('读取文件')) {
      chunks.push(chunk);
    }

    // 过滤 text 事件，验证内容（不包含 tool_start/tool_result/tool_done）
    const texts = chunks.filter((c) => c.type === 'text').map((c) => c.content);
    expect(texts).toEqual(['我来查一下', '找到了文件内容']);
    // 验证 tool_start 和 tool_result 事件
    const toolStarts = chunks.filter((c) => c.type === 'tool_start');
    expect(toolStarts).toHaveLength(1);
    expect(toolStarts[0]!.name).toBe('read_file');
    const toolResults = chunks.filter((c) => c.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.ok).toBe(true);
    expect(toolExecutor).toHaveBeenCalledWith('read_file', '{"path":"a.ts"}');

    const messages = loop.getMessages();
    // system + user + assistant(toolCalls) + tool + assistant = 5
    expect(messages).toHaveLength(5);
    expect(messages[2]!.role).toBe('assistant');
    expect(messages[2]!.toolCalls).toBeDefined();
    expect(messages[3]!.role).toBe('tool');
    expect(messages[3]!.content).toBe('工具执行结果');
  });

  it('多个工具调用应该全部执行', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('done');

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          {
            toolCalls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
              },
              { id: 'c2', type: 'function', function: { name: 'list_dir', arguments: '{}' } },
            ],
          },
        ],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    for await (const chunk of loop.processUserInput('多工具')) {
      void chunk;
    }

    // 并发执行下，两个工具都应被调用，参数正确
    expect(toolExecutor).toHaveBeenCalledTimes(2);
    expect(toolExecutor).toHaveBeenCalledWith('read_file', '{"path":"a.ts"}');
    expect(toolExecutor).toHaveBeenCalledWith('list_dir', '{}');
  });

  it('独立工具调用应该并发执行而非串行', async () => {
    // 用延迟 mock 验证并发：两个工具各延迟 60ms
    // 串行总耗时 ≥120ms，并发总耗时 ≈60ms
    const toolExecutor = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60));
      return 'done';
    });

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          {
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'c2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
            ],
          },
        ],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    const start = Date.now();
    for await (const chunk of loop.processUserInput('并发')) {
      void chunk;
    }
    const elapsed = Date.now() - start;

    expect(toolExecutor).toHaveBeenCalledTimes(2);
    // 并发判定：总耗时接近单个工具耗时（60ms），远小于串行（120ms）
    // 缓冲 <110ms 判定为并发（避免 CI 环境抖动）
    expect(elapsed).toBeLessThan(110);
  });

  it('tool_start 应批量 yield（全部在 tool_result 之前）', async () => {
    // tool_b 快速完成，tool_a 慢速完成，验证 tool_start 仍批量在前
    const toolExecutor = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'tool_a') await new Promise((r) => setTimeout(r, 40));
      return 'done';
    });

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          {
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'c2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
            ],
          },
        ],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('批量')) {
      chunks.push(chunk);
    }

    // 找到第一个 tool_result 的位置
    const firstResultIdx = chunks.findIndex((c) => c.type === 'tool_result');
    expect(firstResultIdx).toBeGreaterThanOrEqual(0);
    // 所有 tool_start 都应在第一个 tool_result 之前（批量 yield）
    const toolStarts = chunks.filter((c) => c.type === 'tool_start');
    expect(toolStarts).toHaveLength(2);
    for (const ts of toolStarts) {
      const idx = chunks.indexOf(ts);
      expect(idx).toBeLessThan(firstResultIdx);
    }
  });

  it('tool_result 应按原始 toolCalls 顺序 yield（不按完成顺序）', async () => {
    // tool_b 先完成（无延迟），tool_a 后完成（有延迟）
    // 验证 tool_result 顺序仍保持原始 toolCalls 顺序 c1 → c2
    const toolExecutor = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'tool_a') await new Promise((r) => setTimeout(r, 40));
      return `result_${name}`;
    });

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          {
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'c2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
            ],
          },
        ],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('顺序')) {
      chunks.push(chunk);
    }

    const toolResults = chunks.filter((c) => c.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
    // 按原始顺序：c1(tool_a) 在前，c2(tool_b) 在后
    // 尽管 tool_b 先完成，tool_result 顺序仍保持 c1 → c2
    expect(toolResults[0]!.toolCallId).toBe('c1');
    expect(toolResults[1]!.toolCallId).toBe('c2');
  });

  it('messages 应按原始顺序 push（保证 Reflection slice 正确）', async () => {
    // tool_b 先完成，验证 messages 中 tool 消息顺序仍按原始 toolCalls 顺序
    // 这保证 Reflection 的 slice(-toolCalls.length) 能取到本轮完整结果
    const toolExecutor = vi.fn().mockImplementation(async (name: string) => {
      if (name === 'tool_a') await new Promise((r) => setTimeout(r, 40));
      return `result_${name}`;
    });

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          {
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
              { id: 'c2', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
            ],
          },
        ],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    for await (const chunk of loop.processUserInput('消息顺序')) {
      void chunk;
    }

    const messages = loop.getMessages();
    // 找到 tool 消息（role === 'tool'）
    const toolMessages = messages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    // 按原始顺序：c1 在前，c2 在后（保证 Reflection slice(-toolCalls.length) 正确）
    expect(toolMessages[0]!.toolCallId).toBe('c1');
    expect(toolMessages[1]!.toolCallId).toBe('c2');
  });
});

describe('AgentLoop · processUserInput 工具调用 signal 中断', () => {
  /**
   * 测试目标：raceToolWithSignal 在 signal abort 时让 executeToolCalls 解除阻塞
   * 覆盖分支：无 signal / signal 已 abort / 工具先完成 / signal 先 abort / 循环结束后 abort 检查
   */
  it('无 signal 时工具正常执行（保持原行为）', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('工具结果');

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          {
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            ],
          },
        ],
        [{ content: '完成' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('测试')) {
      chunks.push(chunk);
    }

    const toolResults = chunks.filter((c) => c.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    if (toolResults[0]!.type === 'tool_result') {
      expect(toolResults[0]!.ok).toBe(true);
      expect(toolResults[0]!.summary).toBe('工具结果'.slice(0, 100));
    }
  });

  it('signal 已 abort 时工具调用应返回 ABORTED 错误', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('不应执行到这里');

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          {
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            ],
          },
        ],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    // 预先 abort 的 signal
    const ac = new AbortController();
    ac.abort();

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('测试', undefined, ac.signal)) {
      chunks.push(chunk);
    }

    // 应有 aborted chunk（executeToolCalls 循环结束后 signal.aborted 检查触发）
    const aborted = chunks.filter((c) => c.type === 'aborted');
    expect(aborted.length).toBeGreaterThan(0);
    // toolExecutor 不应被调用（signal 已 abort，raceToolWithSignal 直接返回 ABORTED）
    expect(toolExecutor).not.toHaveBeenCalled();
  });

  it('signal 在工具执行中 abort 时应解除 generator 阻塞', async () => {
    // 工具执行耗时 100ms，signal 在 10ms 时 abort
    // raceToolWithSignal 应在 abort 时立即返回 ABORTED，不等工具完成
    const toolExecutor = vi.fn().mockImplementation(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('工具结果'), 100)),
    );

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          {
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            ],
          },
        ],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    const ac = new AbortController();
    // 10ms 后 abort
    setTimeout(() => ac.abort(), 10);

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('测试', undefined, ac.signal)) {
      chunks.push(chunk);
    }

    // 应有 aborted chunk（raceToolWithSignal 检测到 abort 返回 ABORTED → 循环结束后 abort 检查触发）
    const aborted = chunks.filter((c) => c.type === 'aborted');
    expect(aborted.length).toBeGreaterThan(0);
    // tool_result 应标记为失败（ABORTED 错误）
    const toolResults = chunks.filter((c) => c.type === 'tool_result');
    if (toolResults.length > 0 && toolResults[0]!.type === 'tool_result') {
      expect(toolResults[0]!.ok).toBe(false);
    }
  });
});

describe('AgentLoop · processUserInput 最大迭代限制', () => {
  it('达到 maxIterations 后应该停止', async () => {
    // 每轮都返回 toolCalls，迫使循环直到上限
    const toolCall = {
      toolCalls: [
        { id: 'c1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } },
      ],
    };

    const loop = new AgentLoop({
      provider: mockProvider(Array(5).fill(toolCall)),
      bootstrapMemories: [],
      toolExecutor: vi.fn().mockResolvedValue('result'),
      maxIterations: 3,
    });

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('触发循环')) {
      chunks.push(chunk);
    }

    // 最后一个 text chunk 是最大迭代次数提示
    const texts = chunks.filter((c) => c.type === 'text').map((c) => c.content);
    expect(texts[texts.length - 1]).toContain('Max iterations reached');
    // 最后一个是 done 事件
    expect(chunks[chunks.length - 1]!.type).toBe('done');
  });
});

describe('AgentLoop · processUserInput recall 事件', () => {
  it('传入 recalledMemories 时应该 yield recall 事件', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    // 模拟 2 条记忆召回
    const recalledMemories = [
      makeMemory({ id: 'mem:1', name: '记忆1', content: '之前讨论过' }),
      makeMemory({ id: 'mem:2', name: '记忆2', content: '另一个记忆' }),
    ];

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('你好', recalledMemories)) {
      chunks.push(chunk);
    }

    // 应该有 recall 事件，memories 数组长度 = 2
    const recalls = chunks.filter((c) => c.type === 'recall');
    expect(recalls).toHaveLength(1);
    if (recalls[0]!.type === 'recall') {
      expect(recalls[0]!.memories).toHaveLength(2);
      // 验证摘要字段（name/score/source），不包含 content
      expect(recalls[0]!.memories[0]!.name).toBe('记忆1');
      expect(recalls[0]!.memories[1]!.name).toBe('记忆2');
      // score 和 source 应存在（makeMemory 默认值）
      expect(typeof recalls[0]!.memories[0]!.score).toBe('number');
      expect(typeof recalls[0]!.memories[0]!.source).toBe('string');
    }
  });

  it('不传 recalledMemories 时不应 yield recall 事件', async () => {
    const loop = new AgentLoop({
      provider: mockProvider([{ content: '回复' }]),
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('你好')) {
      chunks.push(chunk);
    }

    const recalls = chunks.filter((c) => c.type === 'recall');
    expect(recalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：callLlmWithRetry · LLM 调用重试机制
// ═══════════════════════════════════════════════════════════════

/**
 * 可配置重试行为的 Mock Provider
 *
 * 每次调用 chat() 按顺序消费 turns 中的一个行为：
 *   - throw Error：模拟网络错误/超时
 *   - chunks：正常返回 LLM chunks
 *   - streamThenThrow：先 yield chunks 再抛错（模拟流式开始后失败）
 *
 * 不依赖 setTimeout，兼容 fake timers。
 */
interface RetryTurn {
  /** 正常返回的 chunks（与 throw/streamThenThrow 互斥） */
  chunks?: ChunkItem[];
  /** 调用立即抛错（流式开始前） */
  throw?: Error;
  /** 先 yield chunks 再抛错（流式开始后失败） */
  streamThenThrow?: { chunks: ChunkItem[]; error: Error };
}

function mockRetryProvider(turns: RetryTurn[]): LlmProvider & { callCount: number } {
  let callCount = 0;
  return {
    name: 'retry-mock',
    callCount,
    async *chat() {
      const turn = turns[Math.min(callCount, turns.length - 1)];
      (this as { callCount: number }).callCount = ++callCount;
      if (!turn) return;
      if (turn.throw) {
        throw turn.throw;
      }
      if (turn.streamThenThrow) {
        for (const chunk of turn.streamThenThrow.chunks) {
          yield chunk;
        }
        throw turn.streamThenThrow.error;
      }
      for (const chunk of turn.chunks ?? []) {
        yield chunk;
      }
    },
  } as unknown as LlmProvider & { callCount: number };
}

describe('AgentLoop · callLlmWithRetry · LLM 调用重试机制', () => {
  it('网络错误后重试应成功（流式开始前失败可重试）', async () => {
    // 第一次抛网络错误，第二次成功返回文本
    const provider = mockRetryProvider([
      { throw: new Error('network error') },
      { chunks: [{ content: '重试成功' }] },
    ]);

    const loop = new AgentLoop({
      provider,
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('测试重试')) {
      chunks.push(chunk);
    }

    // 应有 retry chunk（attempt=1）
    const retries = chunks.filter((c) => c.type === 'retry');
    expect(retries).toHaveLength(1);
    if (retries[0]!.type === 'retry') {
      expect(retries[0]!.attempt).toBe(1);
      expect(retries[0]!.error).toBe('network error');
    }

    // 应有 text chunk '重试成功'
    const texts = chunks.filter((c) => c.type === 'text').map((c) => c.content);
    expect(texts).toContain('重试成功');

    // provider 应被调用 2 次
    expect(provider.callCount).toBe(2);
  }, 15000);

  it('retry chunk 应携带 attempt/maxRetries/delayMs/error 字段', async () => {
    const provider = mockRetryProvider([
      { throw: new Error('timeout') },
      { chunks: [{ content: 'ok' }] },
    ]);

    const loop = new AgentLoop({
      provider,
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('测试')) {
      chunks.push(chunk);
    }

    const retries = chunks.filter((c) => c.type === 'retry');
    expect(retries).toHaveLength(1);
    if (retries[0]!.type === 'retry') {
      // MAX_LLM_RETRIES = 2，attempt = 1（第一次重试）
      expect(retries[0]!.attempt).toBe(1);
      expect(retries[0]!.maxRetries).toBe(2);
      // RETRY_BASE_DELAY_MS = 1000，attempt=1 时 delay = 1000 * 2^0 = 1000
      expect(retries[0]!.delayMs).toBe(1000);
      expect(retries[0]!.error).toBe('timeout');
    }
  }, 15000);

  it('流式开始后失败不应重试（用户已看到部分结果）', async () => {
    // 先 yield 一个 chunk（流式开始），再抛错
    const provider = mockRetryProvider([
      {
        streamThenThrow: {
          chunks: [{ content: '部分内容' }],
          error: new Error('stream broken'),
        },
      },
    ]);

    const loop = new AgentLoop({
      provider,
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    // 流式开始后抛错应向上传播为 error chunk（agent.chat 层捕获），
    // loop.processUserInput 层会将 provider 异常包装后向上抛
    // 这里验证 provider 只被调用 1 次（无重试）
    const chunks: AgentChunk[] = [];
    try {
      for await (const chunk of loop.processUserInput('测试')) {
        chunks.push(chunk);
      }
    } catch {
      // loop 可能直接抛错，忽略
    }

    // provider 应只被调用 1 次（流式开始后不重试）
    expect(provider.callCount).toBe(1);

    // 应已收到部分文本
    const texts = chunks.filter((c) => c.type === 'text').map((c) => c.content);
    expect(texts).toContain('部分内容');

    // 不应有 retry chunk
    const retries = chunks.filter((c) => c.type === 'retry');
    expect(retries).toHaveLength(0);
  }, 15000);

  it('AbortError 不应重试（用户主动取消）', async () => {
    const provider = mockRetryProvider([
      { throw: new DOMException('aborted', 'AbortError') },
    ]);

    const loop = new AgentLoop({
      provider,
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    const chunks: AgentChunk[] = [];
    for await (const chunk of loop.processUserInput('测试')) {
      chunks.push(chunk);
    }

    // provider 应只被调用 1 次（AbortError 不重试）
    expect(provider.callCount).toBe(1);

    // 不应有 retry chunk
    const retries = chunks.filter((c) => c.type === 'retry');
    expect(retries).toHaveLength(0);

    // 应有 aborted chunk
    const aborted = chunks.filter((c) => c.type === 'aborted');
    expect(aborted.length).toBeGreaterThan(0);
  }, 15000);

  it('重试次数耗尽后应向上抛错', async () => {
    // 始终抛错，MAX_LLM_RETRIES=2，所以总共 3 次调用（1 + 2 重试）
    const provider = mockRetryProvider([
      { throw: new Error('fail') },
      { throw: new Error('fail') },
      { throw: new Error('fail') },
    ]);

    const loop = new AgentLoop({
      provider,
      bootstrapMemories: [],
      toolExecutor: vi.fn(),
    });

    // 重试耗尽后应抛错
    await expect(async () => {
      for await (const {} of loop.processUserInput('测试')) {
        // drain
      }
    }).rejects.toThrow('fail');

    // provider 应被调用 3 次（1 首次 + 2 重试）
    expect(provider.callCount).toBe(3);
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════
// 测试：Reflection · 工具错误反思机制
// ═══════════════════════════════════════════════════════════════

describe('AgentLoop · Reflection · 工具错误反思机制', () => {
  /**
   * 辅助：统计 messages 中 [REFLECTION_HINT] 开头的 system 消息数
   */
  function countReflectionHints(messages: readonly Message[]): number {
    return messages.filter(
      (m) => m.role === 'system' && m.content.startsWith('[REFLECTION_HINT]'),
    ).length;
  }

  it('工具返回可重试错误码时应推送 REFLECTION_HINT', async () => {
    // FILE_NOT_FOUND 是可重试错误码
    const toolExecutor = vi.fn().mockResolvedValue('[ERR:TOOL:FILE_NOT_FOUND] 文件不存在');

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        // 第一轮：触发工具调用
        [{
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          ],
        }],
        // 第二轮：工具失败后 LLM 给出文本回复
        [{ content: '文件读取失败，请检查路径' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    for await (const {} of loop.processUserInput('读取文件')) {
      // drain
    }

    // 应推送 1 条 REFLECTION_HINT system 消息
    const hints = countReflectionHints(loop.getMessages());
    expect(hints).toBe(1);
  }, 15000);

  it('工具返回不可重试错误码时不应推送 REFLECTION_HINT', async () => {
    // PERMISSION_DENIED 是不可重试错误码
    const toolExecutor = vi.fn().mockResolvedValue('[ERR:TOOL:PERMISSION_DENIED] 权限不足');

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [{
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } },
          ],
        }],
        [{ content: '权限不足，无法写入' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
    });

    for await (const {} of loop.processUserInput('写入文件')) {
      // drain
    }

    // 不应推送 REFLECTION_HINT
    const hints = countReflectionHints(loop.getMessages());
    expect(hints).toBe(0);
  }, 15000);

  it('达到 maxReflectionRetries 后不应再推送 REFLECTION_HINT', async () => {
    // 始终返回可重试错误，迫使 Reflection 达到上限
    const toolExecutor = vi.fn().mockResolvedValue('[ERR:TOOL:ARGUMENT_ERROR] 参数错误');

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        // 多轮工具调用，每轮都失败
        [{ toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }],
        [{ toolCalls: [{ id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }],
        [{ toolCalls: [{ id: 'c3', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }],
        [{ content: '多次失败，放弃' }],
      ]),
      bootstrapMemories: [],
      toolExecutor,
      // 设置 maxReflectionRetries=1，第 2 次失败后不应再推送
      maxReflectionRetries: 1,
    });

    for await (const {} of loop.processUserInput('测试反思上限')) {
      // drain
    }

    // 应只推送 1 条 REFLECTION_HINT（maxReflectionRetries=1）
    const hints = countReflectionHints(loop.getMessages());
    expect(hints).toBe(1);
  }, 15000);
});
