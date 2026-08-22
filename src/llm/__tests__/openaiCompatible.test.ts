/**
 * 集成测试：LLM 适配层（Mock LLM via MSW）
 * 验证 OpenAI 兼容 Provider 的流式响应 + 错误处理
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { OpenAICompatibleProvider } from '@/llm/openaiCompatible.js';
import type { LlmChunk } from '@/llm/types.js';
import { toError } from '@/utils/toError.js';

let server: ReturnType<typeof setupServer>;

/**
 * 创建模拟 SSE 流响应
 */
function createSseResponse(content: string): HttpResponse<ReadableStream> {
  const stream = new ReadableStream({
    start(controller) {
      const payload = {
        id: 'mock-1',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'mock-model',
        choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
      };
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

beforeAll(() => {
  server = setupServer(
    http.post('*/chat/completions', async ({ request }) => {
      const body = (await request.json()) as { messages?: Array<{ content: string }> };
      const lastMsg = body.messages?.[body.messages.length - 1];
      const content = `Mock response to: ${lastMsg?.content ?? 'empty'}`;
      return createSseResponse(content);
    }),
  );
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function makeProvider(apiKey = 'test-key'): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider('test', {
    baseUrl: 'http://localhost:9999',
    apiKey,
    defaultModel: 'test-model',
  });
}

describe('OpenAICompatibleProvider · 流式响应', () => {
  it('应该解析 SSE 流并产出文本块', async () => {
    const provider = makeProvider();
    const messages = [{ role: 'user' as const, content: 'hello' }];
    const chunks: string[] = [];

    for await (const chunk of provider.chat(messages)) {
      if (chunk.content) chunks.push(chunk.content);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('Mock response');
  });

  it('应该处理空消息列表', async () => {
    const provider = makeProvider();
    const chunks: string[] = [];
    for await (const chunk of provider.chat([])) {
      if (chunk.content) chunks.push(chunk.content);
    }
    expect(chunks.join('')).toContain('Mock response');
  });

  it('应该传递 finishReason', async () => {
    const provider = makeProvider();
    const messages = [{ role: 'user' as const, content: 'test' }];
    let finishReason: string | undefined;

    for await (const chunk of provider.chat(messages)) {
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }

    expect(finishReason).toBe('stop');
  });
});

describe('OpenAICompatibleProvider · 错误处理', () => {
  it('401 应该抛出 API Key 无效错误', async () => {
    server.use(
      http.post('*/chat/completions', () => {
        return HttpResponse.json({ error: 'invalid key' }, { status: 401 });
      }),
    );

    const provider = makeProvider();
    await expect(async () => {
      for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
        void chunk;
      }
    }).rejects.toThrow('API Key 无效');
  });

  it('429 应该抛出限流错误', async () => {
    server.use(
      http.post('*/chat/completions', () => {
        return HttpResponse.json({ error: 'rate limited' }, { status: 429 });
      }),
    );

    const provider = makeProvider();
    await expect(async () => {
      for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
        void chunk;
      }
    }).rejects.toThrow('限流');
  });

  it('4xx 客户端错误应该抛出请求格式错误', async () => {
    server.use(
      http.post('*/chat/completions', () => {
        return HttpResponse.json({ error: 'bad request' }, { status: 400 });
      }),
    );

    const provider = makeProvider();
    await expect(async () => {
      for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
        void chunk;
      }
    }).rejects.toThrow('请求格式错误');
  });

  it('5xx 服务端错误应该抛出服务端错误', async () => {
    server.use(
      http.post('*/chat/completions', () => {
        return HttpResponse.json({ error: 'internal' }, { status: 500 });
      }),
    );

    const provider = makeProvider();
    await expect(async () => {
      for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
        void chunk;
      }
    }).rejects.toThrow('服务端错误');
  });

  it('apiKey 为空仍可创建并调用（内核不做校验——宿主层职责）', () => {
    // apiKey 为空也可调用——校验是宿主层职责
    const provider = makeProvider('');
    expect(provider.name).toBe('test');
  });

  it('网络错误应该抛出 LLM 服务连接失败', async () => {
    server.use(
      http.post('*/chat/completions', () => {
        return HttpResponse.error();
      }),
    );

    const provider = makeProvider();
    await expect(async () => {
      for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
        void chunk;
      }
    }).rejects.toThrow('LLM 服务连接失败');
  });

  it('403 应该抛出 API Key 无效错误', async () => {
    server.use(
      http.post('*/chat/completions', () => {
        return HttpResponse.json({ error: 'forbidden' }, { status: 403 });
      }),
    );

    const provider = makeProvider();
    await expect(async () => {
      for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
        void chunk;
      }
    }).rejects.toThrow('API Key 无效');
  });

  it('404 应该抛出请求格式错误', async () => {
    server.use(
      http.post('*/chat/completions', () => {
        return HttpResponse.json({ error: 'not found' }, { status: 404 });
      }),
    );

    const provider = makeProvider();
    await expect(async () => {
      for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
        void chunk;
      }
    }).rejects.toThrow('请求格式错误');
  });

  it('502 应该抛出服务端错误', async () => {
    server.use(
      http.post('*/chat/completions', () => {
        return HttpResponse.json({ error: 'bad gateway' }, { status: 502 });
      }),
    );

    const provider = makeProvider();
    await expect(async () => {
      for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
        void chunk;
      }
    }).rejects.toThrow('服务端错误');
  });

  it('错误消息应包含响应体内容', async () => {
    const errorBody = 'detailed error info from server';
    server.use(
      http.post('*/chat/completions', () => {
        return new HttpResponse(errorBody, { status: 500 });
      }),
    );

    const provider = makeProvider();
    try {
      for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
        void chunk;
      }
      expect.unreachable('应该抛出错误');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(toError(err).message).toContain('服务端错误');
      // detail 应包含响应体内容（errorText.slice(0, 200)）
      const memoraErr = err as { detail?: string };
      expect(memoraErr.detail).toContain(errorBody);
    }
  });
});

// ─── response_format 透传（结构化输出能力触达）──

describe('OpenAICompatibleProvider · response_format 透传', () => {
  it('传入 response_format 时应透传到请求 body', async () => {
    // 捕获请求 body 验证透传
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post('*/chat/completions', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return createSseResponse('ok');
      }),
    );

    const provider = makeProvider();
    // 模拟归档摘要场景的结构化输出约束
    const responseFormat = {
      type: 'json_schema' as const,
      json_schema: {
        name: 'summary',
        strict: true,
        schema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
      },
    };

    for await (const chunk of provider.chat(
      [{ role: 'user', content: 'summarize' }],
      { response_format: responseFormat },
    )) {
      void chunk;
    }

    // 验证 response_format 完整透传到请求 body
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.response_format).toEqual(responseFormat);
  });

  it('未传入 response_format 时请求 body 不应包含该字段', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post('*/chat/completions', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return createSseResponse('ok');
      }),
    );

    const provider = makeProvider();
    for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
      void chunk;
    }

    // 未传入时不应透传 undefined，body 不应包含该字段
    expect(capturedBody).toBeDefined();
    expect(capturedBody!).not.toHaveProperty('response_format');
  });
});

// ─── reasoning_effort 透传（multiStepReasoning='manual' 触达 OpenAI 兼容端点）──

describe('OpenAICompatibleProvider · reasoning_effort 透传', () => {
  it('传入 reasoning_effort 时应透传到请求 body（loop 端 multiStepReasoning 依赖此契约）', async () => {
    // 捕获请求 body 验证透传
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post('*/chat/completions', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return createSseResponse('ok');
      }),
    );

    const provider = makeProvider();
    // 模拟 loop 在 multiStepReasoning='manual' 时强制低推理深度的调用
    for await (const chunk of provider.chat(
      [{ role: 'user', content: 'quick' }],
      { reasoning_effort: 'low' },
    )) {
      void chunk;
    }

    // 验证 reasoning_effort 完整透传到请求 body
    expect(capturedBody).toBeDefined();
    expect(capturedBody!.reasoning_effort).toBe('low');
  });

  it('未传入 reasoning_effort 时请求 body 不应包含该字段', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post('*/chat/completions', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return createSseResponse('ok');
      }),
    );

    const provider = makeProvider();
    for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
      void chunk;
    }

    // 未传入时不应透传 undefined，body 不应包含该字段
    expect(capturedBody).toBeDefined();
    expect(capturedBody!).not.toHaveProperty('reasoning_effort');
  });
});

// ─── tool_calls delta 累积（核心 OpenAI 协议解析）──

/**
 * 创建模拟 SSE 流响应（tool_calls delta 分片版）
 *
 * OpenAI 协议：tool_calls 以 delta 形式分片传输，
 * function.name 和 function.arguments 可能跨多个 chunk 到达，
 * 需在接收端按 index 累积，在 finish_reason='tool_calls' 时输出完整 toolCalls。
 *
 * @param deltas delta 序列（每个元素是一个 SSE data 行的 choices[0].delta）
 * @param finalFinishReason 最后一个 chunk 的 finish_reason（'tool_calls' / 'stop' / undefined）
 */
function createToolCallsSseResponse(
  deltas: Array<Record<string, unknown>>,
  finalFinishReason?: string,
): HttpResponse<ReadableStream> {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (let i = 0; i < deltas.length; i++) {
        const isLast = i === deltas.length - 1;
        const payload = {
          id: 'mock-1',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'mock-model',
          choices: [{
            index: 0,
            delta: deltas[i],
            finish_reason: isLast ? finalFinishReason ?? null : null,
          }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new HttpResponse(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

/** 收集 provider.chat() 产出的所有 chunk */
async function collectChunks(provider: OpenAICompatibleProvider): Promise<LlmChunk[]> {
  const chunks: LlmChunk[] = [];
  for await (const chunk of provider.chat([{ role: 'user', content: 'test' }])) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('OpenAICompatibleProvider · tool_calls delta 累积', () => {
  it('单个 tool_call：name 和 arguments 跨多 chunk 累积，finish_reason=tool_calls 时输出完整 toolCalls', async () => {
    // 模拟 OpenAI 协议：tool_call 的 name 和 arguments 分片传输
    server.use(
      http.post('*/chat/completions', () => {
        return createToolCallsSseResponse(
          [
            // 第 1 片：tool_call id + name 开头
            { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'read_', arguments: '' } }] },
            // 第 2 片：name 续片 + arguments 开头
            { tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"pa' } }] },
            // 第 3 片：arguments 续片
            { tool_calls: [{ index: 0, function: { arguments: 'th":"main.ts"}' } }] },
          ],
          'tool_calls',
        );
      }),
    );

    const chunks = await collectChunks(makeProvider());

    // 找到携带 toolCalls 的 chunk（应在 finish_reason='tool_calls' 时输出）
    const toolCallChunk = chunks.find((c) => c.toolCalls && c.toolCalls.length > 0);
    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk!.toolCalls).toHaveLength(1);

    const call = toolCallChunk!.toolCalls![0];
    expect(call).toBeDefined();
    // name 应累积为完整函数名：read_ + file = read_file
    expect(call!.id).toBe('call_abc');
    expect(call!.type).toBe('function');
    expect(call!.function.name).toBe('read_file');
    // arguments 应累积为完整 JSON 字符串
    expect(call!.function.arguments).toBe('{"path":"main.ts"}');
  });

  it('多个 tool_call 并行累积：按 index 分别累积，finish_reason=tool_calls 时全部输出', async () => {
    server.use(
      http.post('*/chat/completions', () => {
        return createToolCallsSseResponse(
          [
            // tool_call 0 开始
            { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
            // tool_call 1 开始（不同 index）
            { tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'write_', arguments: '' } }] },
            // tool_call 1 续片
            { tool_calls: [{ index: 1, function: { name: 'file', arguments: '{"path":"b.ts","content":"x"}' } }] },
          ],
          'tool_calls',
        );
      }),
    );

    const chunks = await collectChunks(makeProvider());
    const toolCallChunk = chunks.find((c) => c.toolCalls && c.toolCalls.length > 0);

    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk!.toolCalls).toHaveLength(2);

    // 按 index 顺序输出（index 0 在前，index 1 在后）
    const [call0, call1] = toolCallChunk!.toolCalls!;
    expect(call0).toBeDefined();
    expect(call1).toBeDefined();
    expect(call0!.id).toBe('call_1');
    expect(call0!.function.name).toBe('read_file');
    expect(call0!.function.arguments).toBe('{"path":"a.ts"}');

    expect(call1!.id).toBe('call_2');
    // name 跨片累积：write_ + file = write_file
    expect(call1!.function.name).toBe('write_file');
    expect(call1!.function.arguments).toBe('{"path":"b.ts","content":"x"}');
  });

  it('流结束 [DONE] 兜底：无 finish_reason=tool_calls 时在 [DONE] 输出累积的 toolCalls', async () => {
    // 某些模型可能不在 chunk 中标 finish_reason='tool_calls'，直接 [DONE] 结束
    // 此时应在 [DONE] 时兜底输出累积的 tool_calls
    server.use(
      http.post('*/chat/completions', () => {
        return createToolCallsSseResponse(
          [
            { tool_calls: [{ index: 0, id: 'call_x', type: 'function', function: { name: 'search', arguments: '{"q":"test"}' } }] },
          ],
          // finalFinishReason 不传（undefined），模拟模型不标 tool_calls 直接结束
          undefined,
        );
      }),
    );

    const chunks = await collectChunks(makeProvider());
    // 应在流结束时兜底输出 toolCalls
    const toolCallChunk = chunks.find((c) => c.toolCalls && c.toolCalls.length > 0);
    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk!.toolCalls).toHaveLength(1);
    expect(toolCallChunk!.toolCalls![0]!.function.name).toBe('search');
  });

  it('finish_reason 非 tool_calls 时清空累积器：防止残留碎片污染下一次调用', async () => {
    // 某些模型在 stop 时可能残留不完整的 tool_calls 碎片
    // 应在 finish_reason='stop' 时清空累积器，不输出 toolCalls
    server.use(
      http.post('*/chat/completions', () => {
        return createToolCallsSseResponse(
          [
            // 残留的不完整 tool_call 碎片（无 arguments）
            { tool_calls: [{ index: 0, id: 'call_frag', type: 'function', function: { name: 'incomplete' } }] },
            // 文本内容
            { content: '正常文本响应' },
          ],
          'stop',
        );
      }),
    );

    const chunks = await collectChunks(makeProvider());

    // finish_reason='stop' 时不应输出 toolCalls（累积器已被清空）
    const toolCallChunks = chunks.filter((c) => c.toolCalls && c.toolCalls.length > 0);
    expect(toolCallChunks).toHaveLength(0);

    // 文本内容应正常输出
    const textContent = chunks.filter((c) => c.content).map((c) => c.content).join('');
    expect(textContent).toContain('正常文本响应');
  });

  it('tool_call id 缺失时兜底为 call_${index}', async () => {
    // 某些模型可能不返回 tool_call id，应兜底为 call_0 / call_1
    server.use(
      http.post('*/chat/completions', () => {
        return createToolCallsSseResponse(
          [
            // 无 id 字段
            { tool_calls: [{ index: 0, type: 'function', function: { name: 'no_id_func', arguments: '{}' } }] },
          ],
          'tool_calls',
        );
      }),
    );

    const chunks = await collectChunks(makeProvider());
    const toolCallChunk = chunks.find((c) => c.toolCalls && c.toolCalls.length > 0);

    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk!.toolCalls![0]!.id).toBe('call_0');
  });

  it('tool_calls 与文本内容混合：文本 chunk 实时输出，tool_calls 累积后输出', async () => {
    // LLM 可能先输出部分文本，再发起 tool_calls
    server.use(
      http.post('*/chat/completions', () => {
        return createToolCallsSseResponse(
          [
            // 先输出文本
            { content: '让我读取文件' },
            // 然后发起 tool_call
            { tool_calls: [{ index: 0, id: 'call_mixed', type: 'function', function: { name: 'read_file', arguments: '{"path":"c.ts"}' } }] },
          ],
          'tool_calls',
        );
      }),
    );

    const chunks = await collectChunks(makeProvider());

    // 文本应实时输出（在 tool_calls 之前）
    const textChunks = chunks.filter((c) => c.content);
    expect(textChunks.length).toBeGreaterThanOrEqual(1);
    expect(textChunks[0]!.content).toBe('让我读取文件');

    // tool_calls 应在 finish_reason='tool_calls' 时输出
    const toolCallChunk = chunks.find((c) => c.toolCalls && c.toolCalls.length > 0);
    expect(toolCallChunk).toBeDefined();
    expect(toolCallChunk!.toolCalls![0]!.function.name).toBe('read_file');
  });
});

// ─── 超时机制（fetch 阶段与 SSE 阶段超时职责分离）──

describe('OpenAICompatibleProvider · 超时机制', () => {
  it('长流式响应（SSE 持续时间 > timeoutMs）不应被总超时中断', async () => {
    // 场景：长文生成，SSE 流持续超过请求级总超时，但 chunk 间间隔远小于 chunk 级超时
    // 预期：fetch 成功后清除总超时，SSE 阶段由 chunk 级超时独立保护
    server.use(
      http.post('*/chat/completions', () => {
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            // 3 个 chunk，每个间隔 30ms，总时长 ~90ms > timeoutMs(50ms)
            for (let i = 0; i < 3; i++) {
              const payload = {
                id: 'mock-1',
                object: 'chat.completion.chunk',
                created: Date.now(),
                model: 'mock-model',
                choices: [{
                  index: 0,
                  delta: { content: `chunk${i}` },
                  finish_reason: i === 2 ? 'stop' : null,
                }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
              // chunk 间 30ms << INTER_CHUNK_TIMEOUT_MS(60s)，不触发 chunk 级超时
              await new Promise((r) => setTimeout(r, 30));
            }
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new HttpResponse(stream, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    const provider = makeProvider();
    const chunks: string[] = [];
    // timeoutMs=50ms < SSE 总时长 90ms，但 fetch 成功后总超时被清除
    for await (const chunk of provider.chat(
      [{ role: 'user', content: 'long-gen' }],
      { timeoutMs: 50 },
    )) {
      if (chunk.content) chunks.push(chunk.content);
    }
    // 应收到全部 3 个 chunk，未被总超时中断
    expect(chunks.join('')).toBe('chunk0chunk1chunk2');
  });

  it('fetch 阶段超时应抛出请求超时错误', async () => {
    // 场景：服务端响应延迟超过 timeoutMs，fetch 阶段被总超时中断
    server.use(
      http.post('*/chat/completions', async () => {
        // delay 200ms > timeoutMs(50ms)，模拟慢响应
        await new Promise((r) => setTimeout(r, 200));
        return createSseResponse('ok');
      }),
    );

    const provider = makeProvider();
    await expect(async () => {
      for await (const chunk of provider.chat(
        [{ role: 'user', content: 'hi' }],
        { timeoutMs: 50 },
      )) {
        void chunk;
      }
    }).rejects.toThrow('LLM 请求超时');
  });
});

describe('OpenAICompatibleProvider · 请求参数边界（maxTokens/timeoutMs 归一化）', () => {
  /** 捕获请求体并返回 mock 流 */
  async function captureBody(
    provider: OpenAICompatibleProvider,
    opts: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> | undefined;
    server.use(
      http.post('*/chat/completions', async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return createSseResponse('ok');
      }),
    );
    for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }], opts)) {
      void chunk;
    }
    expect(captured).toBeDefined();
    return captured!;
  }

  it('maxTokens 合法值（1~65536）应透传 max_tokens', async () => {
    const body = await captureBody(makeProvider(), { maxTokens: 2000 });
    expect(body['max_tokens']).toBe(2000);
  });

  it('maxTokens 越界（>65536 / 负数 / 0 / 非数值）应忽略（不传 max_tokens）', async () => {
    for (const bad of [70000, -5, 0, 'big' as unknown as number]) {
      const body = await captureBody(makeProvider(), { maxTokens: bad });
      expect(body['max_tokens']).toBeUndefined();
    }
  });

  it('timeoutMs 超大值应回退默认（请求仍正常完成，不被大值语义影响）', async () => {
    const body = await captureBody(makeProvider(), { timeoutMs: 999_999_999 });
    expect(body['max_tokens']).toBeUndefined();
    expect(body['stream']).toBe(true);
  });
});
