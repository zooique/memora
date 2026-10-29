/**
 * 图片附件序列化守卫（方案 §5.3 / §5.4 / §5.5）
 *
 * 覆盖：
 *  - (a) 无附件请求体**字节级一致**：tool / assistant+toolCalls / system / user 路径形状与升级前相同
 *    （断点 R8-4：任何回归都会在此暴露为 body 形状变化）。
 *  - 单图片附件 → 展开为 `[{type:'text'},{type:'image_url'}]` content 块数组；
 *    base64 字节**只在此处**临时物化（data:{mime};base64,{text}）。
 *  - 宿主返回 url（已落盘）路径 → `image_url.url` 直连，内核零外部 IO。
 *  - resolver 二级降级：单图未命中 → 推可见占位文本块（**绝不静默丢该图**）；全未命中 → 退化为纯文本块数组（形状不变）。
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { OpenAICompatibleProvider } from '@/llm/openaiCompatible.js';
import { createProviderFromConfig } from '@/llm/factory.js';
import type { LlmProvider } from '@/llm/provider.js';
import type { ImageRef, ImageResolver, Message } from '@/llm/provider.js';

type CapturedBody = { messages?: unknown[] };
let captured: CapturedBody = {};

const server = setupServer(
  http.post('*/chat/completions', async ({ request }) => {
    captured = (await request.json()) as CapturedBody;
    const stream = new ReadableStream({
      start(controller) {
        const payload = {
          id: 'mock-1',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: 'mock-model',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        };
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new HttpResponse(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  captured = {};
});
afterAll(() => server.close());

function makeProvider(imageResolver?: ImageResolver): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider('test', {
    baseUrl: 'http://localhost:9999',
    apiKey: 'test-key',
    defaultModel: 'test-model',
    imageResolver,
  });
}

// 形参取**抽象基类**：工厂建房返回的是 LlmProvider，本用例既测直连构造也测经工厂建房两条路径
async function drain(provider: LlmProvider, messages: Message[]): Promise<void> {
  // 消费完整流，确保请求体已被发出并被 MSW 捕获
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of provider.chat(messages)) {
    /* noop */
  }
}

const ref: ImageRef = {
  sha256: 'abc',
  mime: 'image/png',
  width: 100,
  height: 100,
  bytes: 1234,
  name: 'pic.png',
};

describe('OpenAICompatibleProvider · 无附件请求体字节级一致（R8-4 快照）', () => {
  it('system/user/assistant+toolCalls/tool 序列形状与升级前一致', async () => {
    const provider = makeProvider();
    const messages: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', content: 'result', toolCallId: 'c1' },
    ];
    await drain(provider, messages);
    expect(captured.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'result' },
    ]);
  });
});

describe('OpenAICompatibleProvider · 图片附件展开（方案 §5.4）', () => {
  it('宿主 url 路径 → image_url.url 直连（内核零外部 IO）', async () => {
    const provider = makeProvider(() => ({ url: 'data:image/png;base64,B' }));
    const messages: Message[] = [{ role: 'user', content: '看这张图', attachments: [ref] }];
    await drain(provider, messages);
    expect(captured.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,B' } },
        ],
      },
    ]);
  });

  it('宿主返回占位文案 {text} → **不透明透传为文本块**，绝不拼进 data URI（§5.4 / §6.13）', async () => {
    // 本条是 2026-10-28 自伤纠正的锁：`{text}` 的语义是「**降级占位文案**」（含路径，生产权归宿主），
    // **不是** base64 载荷。若照旧把它当成载荷拼成 `data:{mime};base64,{文案}`，服务端会收到一段
    // 人类可读的中文字串当图片 ⇒ 请求 400 或模型侧垃圾字节，且本地测试全绿（同保姆-format 两处记账那类伤）。
    const provider = makeProvider(() => ({
      text: '[图片 pic.png, image/png, 412 KB, 存于 .memora/attachments/abc.png]',
    }));
    const messages: Message[] = [{ role: 'user', content: '看这张图', attachments: [ref] }];
    await drain(provider, messages);
    const content = (captured.messages?.[0] as { content: Array<Record<string, unknown>> }).content;
    expect(content).toEqual([
      { type: 'text', text: '看这张图' },
      { type: 'text', text: '[图片 pic.png, image/png, 412 KB, 存于 .memora/attachments/abc.png]' },
    ]);
    // 反面断言：不得出现任何 image_url 块（占位文案落不进图片通道）
    expect(content.some((b) => b.type === 'image_url')).toBe(false);
  });

  it('多图 → 多个 image_url 块（顺序 = 附件顺序）', async () => {
    const provider = makeProvider(() => ({ url: 'data:image/png;base64,B' }));
    const ref2: ImageRef = { ...ref, sha256: 'def', name: 'pic2.png' };
    const messages: Message[] = [{ role: 'user', content: '对比这两张', attachments: [ref, ref2] }];
    await drain(provider, messages);
    const content = (captured.messages?.[0] as { content: unknown[] }).content;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: 'text', text: '对比这两张' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,B' },
    });
    expect(content[2]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,B' },
    });
  });
});

describe('OpenAICompatibleProvider · resolver 二级降级（D7 / §5.4）', () => {
  it('resolver 未命中（null）→ 内核给最短兜底占位，**不静默丢该图**', async () => {
    const provider = makeProvider(() => null);
    const messages: Message[] = [{ role: 'user', content: '看这张图', attachments: [ref] }];
    await drain(provider, messages);
    expect(captured.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这张图' },
          { type: 'text', text: '[图片不可用 abc]' },
        ],
      },
    ]);
  });

  it('未命中兜底文案**不含路径**——内核不知道也不该知道附件在哪（§6.13）', async () => {
    const provider = makeProvider(() => null);
    const messages: Message[] = [{ role: 'user', content: 'x', attachments: [ref] }];
    await drain(provider, messages);
    const content = (captured.messages?.[0] as { content: Array<{ text: string }> }).content;
    const placeholder = content[1]?.text ?? '';
    expect(placeholder).toBe('[图片不可用 abc]');
    // 不伪造任何路径 / 档名 / 体积 ——那三项只有宿主知道
    expect(placeholder).not.toContain('.memora');
    expect(placeholder).not.toContain('KB');
    expect(placeholder).not.toContain('pic.png');
  });

  it('部分命中 → 命中图进 image_url，未命中图进**可见占位**（不跳过、不静默丢）', async () => {
    let calls = 0;
    const provider = makeProvider(() => {
      calls += 1;
      // 第一张命中，第二张未命中
      return calls === 1 ? { url: 'data:image/png;base64,B' } : null;
    });
    const ref2: ImageRef = { ...ref, sha256: 'def' };
    const messages: Message[] = [{ role: 'user', content: '对比这两张', attachments: [ref, ref2] }];
    await drain(provider, messages);
    expect(captured.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '对比这两张' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,B' } },
          { type: 'text', text: '[图片不可用 def]' },
        ],
      },
    ]);
  });

  it('静默丢回归锁：无论命中与否，content 块数恒 = 正文(0/1) + 附件数', async () => {
    // 这条是「把 continue 改回来」的直接拦网：任何一处把降级图从 content 里摘掉，
    // 块数就会比附件数少 ⇒ 立即红。别处的逐条断言可以被绕过，这条算总账绕不过去。
    for (const mode of ['hit-all', 'miss-all', 'miss-some'] as const) {
      let n = 0;
      const provider = makeProvider(() => {
        n += 1;
        if (mode === 'hit-all') return { url: 'data:image/png;base64,B' };
        if (mode === 'miss-all') return null;
        return n % 2 === 1 ? { url: 'data:image/png;base64,B' } : null;
      });
      const refs: ImageRef[] = [ref, { ...ref, sha256: 'd1' }, { ...ref, sha256: 'd2' }];
      const messages: Message[] = [{ role: 'user', content: 'x', attachments: refs }];
      await drain(provider, messages);
      const content = (captured.messages?.[0] as { content: unknown[] }).content;
      expect(content, `${mode} 块数应恒等于 1 + 附件数`).toHaveLength(1 + refs.length);
    }
  });

  it('正文为空且全部降级 → content 为单占位块数组，无空数组形态', async () => {
    // attachments 非空是进入本分支的前提 ⇒ 循环每图必推一块，blocks 恒非空；
    // m.content 为空串 ⇒ 不推正文块，全未命中时 content 只剩占位块（不留空 content 形态）。
    const provider = makeProvider(() => null);
    const messages: Message[] = [{ role: 'user', content: '', attachments: [ref] }];
    await drain(provider, messages);
    const content = (captured.messages?.[0] as { content: Array<{ text: string }> }).content;
    expect(content).toEqual([{ type: 'text', text: '[图片不可用 abc]' }]);
  });
});

/**
 * 建房链路注入守卫（审查 IMG-3 / P0）
 *
 * 上一轮事故的形态是「能力位在 provider 层定义了、却没人把它传进来」：
 * 类型系统全绿、两个 surface guard 全绿，**断链发生在「谁来传值」这条编译器看不见的路径上**。
 * 故此处不以「字段存在」为判据，而以**端到端生效**为判据——
 * 只要 factory 漏透传 imageResolver，下面第三条立刻红（MSW 侧捕获不到 image_url 块）。
 */
describe('createProviderFromConfig · 视觉能力位与解析器建房注入', () => {
  const BASE = { baseUrl: 'https://api.example.com/v1', model: 'vision-model' };

  it('supportsVision 显式 true → 建房后为真（用户勾选可达）', () => {
    const provider = createProviderFromConfig('v', { ...BASE, supportsVision: true });
    expect(provider.supportsVision).toBe(true);
  });

  it('未填 supportsVision → 回落 false（失败必闭：宁可拒收不静默丢图）', () => {
    const provider = createProviderFromConfig('v', BASE);
    expect(provider.supportsVision).toBe(false);
  });

  it('imageResolver 经工厂建房后**真的到达序列化**（断链必红）', async () => {
    const provider = createProviderFromConfig('v', {
      ...BASE,
      supportsVision: true,
      imageResolver: () => ({ url: 'file:///attachments/injected.png' }),
    });
    await drain(provider, [{ role: 'user', content: '看图', attachments: [ref] }]);
    expect(captured.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'file:///attachments/injected.png' } },
        ],
      },
    ]);
  });
});
