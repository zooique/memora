/**
 * 流式累积工具单元测试
 *
 * 覆盖 accumulateStream 的核心行为：
 *   1. 单 chunk / 多 chunk 累积拼接
 *   2. 空 content chunk 跳过
 *   3. 空响应（无 chunk）返回空字符串
 *   4. Provider 异常向上传播（不捕获）
 *   5. options 参数正确传递
 */
import { describe, it, expect, vi } from 'vitest';
import { accumulateStream, type AccumulateOptions } from '@/agent/managers/streamAccumulator.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';

// ─── 辅助：创建 Mock Provider ────────────────────

/** 创建返回固定 chunks 的 Mock Provider */
function createMockProvider(chunks: LlmChunk[]): LlmProvider {
  return {
    name: 'mock-stream',
    supportsStructuredOutput: true,
    async *chat(_messages: Message[], _opts?: unknown) {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  } as unknown as LlmProvider;
}

/** 创建 Mock Provider，模拟 LLM 抛出异常 */
function createErrorProvider(error: Error): LlmProvider {
  return {
    name: 'mock-error',
    supportsStructuredOutput: true,
    async *chat(_messages: Message[], _opts?: unknown) {
      throw error;
    },
  } as unknown as LlmProvider;
}

// ─── 基础测试 ────────────────────────────────

describe('accumulateStream — 基础累积', () => {
  const systemMsg: Message = { role: 'system', content: '你是测试助手' };
  const userMsg: Message = { role: 'user', content: 'Hello' };
  const messages: Message[] = [systemMsg, userMsg];

  it('单 chunk 累积', async () => {
    const provider = createMockProvider([{ content: 'Hello World' }]);
    const result = await accumulateStream(provider, messages);

    expect(result).toBe('Hello World');
  });

  it('多 chunk 累积拼接', async () => {
    const provider = createMockProvider([
      { content: 'Hello' },
      { content: ' ' },
      { content: 'World' },
    ]);
    const result = await accumulateStream(provider, messages);

    expect(result).toBe('Hello World');
  });

  it('空 content chunk 被跳过', async () => {
    const provider = createMockProvider([
      { content: 'A' },
      { content: undefined }, // 空 content
      { content: 'B' },
    ]);
    const result = await accumulateStream(provider, messages);

    expect(result).toBe('AB');
  });

  it('空响应（无 chunk）返回空字符串', async () => {
    const provider = createMockProvider([]);
    const result = await accumulateStream(provider, messages);

    expect(result).toBe('');
  });

  it('所有 chunk 均为 undefined content 返回空字符串', async () => {
    const provider = createMockProvider([{ content: undefined }, { content: undefined }]);
    const result = await accumulateStream(provider, messages);

    expect(result).toBe('');
  });

  it('混合内容和空 chunk', async () => {
    const provider = createMockProvider([
      { content: '开始' },
      { content: undefined },
      { content: '中间' },
      { content: undefined },
      { content: '结束' },
    ]);
    const result = await accumulateStream(provider, messages);

    expect(result).toBe('开始中间结束');
  });
});

// ─── 异常传播 ────────────────────────────────

describe('accumulateStream — 异常传播', () => {
  it('Provider 异常向上传播', async () => {
    const provider = createErrorProvider(new Error('LLM 连接超时'));

    await expect(accumulateStream(provider, [{ role: 'user', content: 'test' }])).rejects.toThrow(
      'LLM 连接超时',
    );
  });

  it('AbortError 正确传播', async () => {
    const provider = createErrorProvider(new DOMException('Aborted', 'AbortError'));

    await expect(
      accumulateStream(provider, [{ role: 'user', content: 'test' }]),
    ).rejects.toHaveProperty('name', 'AbortError');
  });
});

// ─── Options 传递 ────────────────────────────

describe('accumulateStream — options 传递', () => {
  it('传递 options 到 provider.chat', async () => {
    const chatSpy = vi.fn(async function* (this: unknown, _messages: Message[], opts?: unknown) {
      yield { content: 'test' };
      // 断言 options 被传递
      expect(opts).toBeDefined();
      expect((opts as AccumulateOptions).maxTokens).toBe(400);
      expect((opts as AccumulateOptions).temperature).toBe(0);
    });

    const provider = {
      name: 'mock',
      supportsStructuredOutput: true,
      chat: chatSpy,
    } as unknown as LlmProvider;

    await accumulateStream(provider, [{ role: 'user', content: 'test' }], {
      maxTokens: 400,
      temperature: 0,
    });

    expect(chatSpy).toHaveBeenCalledOnce();
  });

  it('不传 options 时传递 undefined', async () => {
    let receivedOpts: unknown = 'not-set';
    const provider = {
      name: 'mock',
      supportsStructuredOutput: true,
      async *chat(_messages: Message[], opts?: unknown) {
        receivedOpts = opts;
        yield { content: 'ok' };
      },
    } as unknown as LlmProvider;

    await accumulateStream(provider, [{ role: 'user', content: 'test' }]);

    expect(receivedOpts).toBeUndefined();
  });
});

// ─── 边界场景 ────────────────────────────────

describe('accumulateStream — 边界场景', () => {
  it('处理纯空白内容', async () => {
    const provider = createMockProvider([{ content: '   \n  \t  ' }]);
    const result = await accumulateStream(provider, [{ role: 'user', content: 'test' }]);
    expect(result).toBe('   \n  \t  ');
  });

  it('处理中文内容', async () => {
    const provider = createMockProvider([
      { content: '你好' },
      { content: '，' },
      { content: '世界' },
    ]);
    const result = await accumulateStream(provider, [{ role: 'user', content: 'test' }]);
    expect(result).toBe('你好，世界');
  });

  it('处理 emoji 和特殊字符', async () => {
    const provider = createMockProvider([{ content: 'Hello 🌍 ' }, { content: 'café résumé' }]);
    const result = await accumulateStream(provider, [{ role: 'user', content: 'test' }]);
    expect(result).toBe('Hello 🌍 café résumé');
  });

  it('处理长内容（模拟 LLM 分段输出）', async () => {
    const chunks: LlmChunk[] = [];
    for (let i = 0; i < 100; i++) {
      chunks.push({ content: `chunk_${i}_` });
    }
    const provider = createMockProvider(chunks);
    const result = await accumulateStream(provider, [{ role: 'user', content: 'test' }]);

    expect(result.length).toBeGreaterThan(0);
    // 验证所有 chunk 都被拼接
    expect(result).toContain('chunk_0_');
    expect(result).toContain('chunk_99_');
    // 100 chunks × "chunk_N_" (平均 8 字符) ≈ 800 字符
    expect(result.length).toBeGreaterThanOrEqual(700);
  });

  it('连续多次调用独立工作', async () => {
    const provider = createMockProvider([{ content: 'First' }]);
    const result1 = await accumulateStream(provider, [{ role: 'user', content: 'a' }]);
    const result2 = await accumulateStream(provider, [{ role: 'user', content: 'b' }]);

    expect(result1).toBe('First');
    expect(result2).toBe('First'); // 每次调用都重新迭代
  });
});
