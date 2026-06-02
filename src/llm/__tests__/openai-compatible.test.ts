/**
 * 集成测试：LLM 适配层（Mock LLM via MSW）
 * 验证 OpenAI 兼容 Provider 与 LLM 抽象的协同工作
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { OpenAICompatibleProvider } from '../openai-compatible.js';

let server: ReturnType<typeof setupServer>;

beforeAll(() => {
  server = setupServer(
    http.post('*/chat/completions', async ({ request }) => {
      const body = (await request.json()) as { messages?: Array<{ content: string }> };
      const lastMsg = body.messages?.[body.messages.length - 1];
      const content = `Mock response to: ${lastMsg?.content ?? 'empty'}`;

      // 模拟流式响应（SSE 格式）
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
    }),
  );
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('OpenAICompatibleProvider · 流式响应', () => {
  it('应该解析 SSE 流并产出文本块', async () => {
    const provider = new OpenAICompatibleProvider('test', {
      baseUrl: 'http://localhost:9999',
      apiKey: 'test-key',
      defaultModel: 'test-model',
    });

    const messages = [{ role: 'user' as const, content: 'hello' }];
    const chunks: string[] = [];

    for await (const chunk of provider.chat(messages)) {
      if (chunk.content) chunks.push(chunk.content);
    }

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join('')).toContain('Mock response');
  });

  it('应该处理空消息列表', async () => {
    const provider = new OpenAICompatibleProvider('test', {
      baseUrl: 'http://localhost:9999',
      apiKey: 'test-key',
      defaultModel: 'test-model',
    });

    const chunks: string[] = [];
    for await (const chunk of provider.chat([])) {
      if (chunk.content) chunks.push(chunk.content);
    }

    expect(chunks.join('')).toContain('Mock response');
  });
});
