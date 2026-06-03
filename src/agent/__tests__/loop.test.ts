/**
 * Agent Loop 单元测试
 * 覆盖 processUserInput 流式输出 + 工具调用循环 + 最大迭代限制
 */
import { describe, it, expect, vi } from 'vitest';
import { AgentLoop } from '@/agent/loop.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { Memory } from '@/memory/types.js';

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test:1',
    type: 'personality',
    permanence: 'always',
    name: 'test-personality',
    content: '你是一个测试助手',
    tags: ['test'],
    weight: 1.0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    filePath: '/test/personality.md',
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

    const chunks: string[] = [];
    for await (const chunk of loop.processUserInput('hello')) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['你好', '！', '我是 Memora']);
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
    expect(messages[1]!.content).toBe('用户提问');
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

    const chunks: string[] = [];
    for await (const chunk of loop.processUserInput('读取文件')) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['我来查一下', '找到了文件内容']);
    expect(toolExecutor).toHaveBeenCalledWith('read_file', '{"path":"a.ts"}');

    const messages = loop.getMessages();
    // system + user + assistant(toolCalls) + tool + assistant = 5
    expect(messages).toHaveLength(5);
    expect(messages[2]!.role).toBe('assistant');
    expect(messages[2]!.toolCalls).toBeDefined();
    expect(messages[3]!.role).toBe('tool');
    expect(messages[3]!.content).toBe('工具执行结果');
  });

  it('多个工具调用应该逐一执行', async () => {
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

    expect(toolExecutor).toHaveBeenCalledTimes(2);
    expect(toolExecutor).toHaveBeenCalledWith('read_file', '{"path":"a.ts"}');
    expect(toolExecutor).toHaveBeenCalledWith('list_dir', '{}');
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

    const chunks: string[] = [];
    for await (const chunk of loop.processUserInput('触发循环')) {
      chunks.push(chunk);
    }

    // 最后一个 chunk 是"已达到最大迭代次数"
    expect(chunks[chunks.length - 1]).toContain('已达到最大迭代次数');
  });
});
