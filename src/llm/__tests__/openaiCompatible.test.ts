/**
 * 集成测试：LLM 适配层（Mock LLM via MSW）
 * 验证 OpenAI 兼容 Provider 的流式响应 + 错误处理
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { OpenAICompatibleProvider } from '@/llm/openaiCompatible.js';
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

  it('缺少 apiKey 应该抛出配置错误', async () => {
    const provider = makeProvider('');
    await expect(async () => {
      for await (const chunk of provider.chat([{ role: 'user', content: 'hi' }])) {
        void chunk;
      }
    }).rejects.toThrow('API Key 未配置');
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
