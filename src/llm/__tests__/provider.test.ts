/**
 * LLM Provider 抽象类测试
 *
 * 覆盖范围：
 *   - supportsStructuredOutput 默认值 false
 *   - abstract chat() 方法编译期约束（子类必须实现）
 *   - name 抽象属性编译期约束
 *   - Message / ChatOptions 类型契约（可选字段组合）
 */
import { describe, it, expect } from 'vitest';
import { LlmProvider } from '@/llm/provider.js';
import type { Message, ChatOptions } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';

/**
 * 最小可实例化子类（用于测试抽象类的默认行为）
 *
 * abstract 类无法直接 new，需通过子类验证默认值和契约。
 */
class TestProvider extends LlmProvider {
  readonly name = 'test';

  async *chat(_messages: Message[], _opts?: ChatOptions): AsyncIterable<LlmChunk> {
    // 空实现，仅用于验证抽象方法可被覆盖
    yield { content: 'ok', finishReason: 'stop' };
  }
}

// ─── supportsStructuredOutput 默认值 ──────────────────────

describe('LlmProvider · supportsStructuredOutput 默认值', () => {
  it('未覆盖时默认为 false', () => {
    const provider = new TestProvider();
    expect(provider.supportsStructuredOutput).toBe(false);
  });

  it('子类可覆盖为 true', () => {
    // 验证 supportsStructuredOutput 是可覆盖的实例属性
    class StructuredProvider extends LlmProvider {
      readonly name = 'structured';
      readonly supportsStructuredOutput = true;
      async *chat(): AsyncIterable<LlmChunk> {
        yield { content: 'ok' };
      }
    }
    const provider = new StructuredProvider();
    expect(provider.supportsStructuredOutput).toBe(true);
  });
});

// ─── supportsToolCalling 能力位 ──

describe('LlmProvider · supportsToolCalling 能力位', () => {
  it('未覆盖时默认为 true（保留存量云 LLM 工具行为）', () => {
    const provider = new TestProvider();
    expect(provider.supportsToolCalling).toBe(true);
  });

  it('本地模型可显式覆盖为 false（无原生工具协议）', () => {
    class NoToolProvider extends LlmProvider {
      readonly name = 'no-tool';
      readonly supportsToolCalling = false;
      async *chat(): AsyncIterable<LlmChunk> {
        yield { content: 'ok' };
      }
    }
    const provider = new NoToolProvider();
    expect(provider.supportsToolCalling).toBe(false);
  });
});

// ─── name 抽象属性 ────────────────────────────────────────

describe('LlmProvider · name 抽象属性', () => {
  it('子类必须实现 name 属性', () => {
    const provider = new TestProvider();
    expect(provider.name).toBe('test');
  });
});

// ─── chat() 抽象方法 ──────────────────────────────────────

describe('LlmProvider · chat() 抽象方法', () => {
  it('子类实现的 chat() 应返回 AsyncIterable<LlmChunk>', async () => {
    const provider = new TestProvider();
    const chunks: LlmChunk[] = [];
    for await (const chunk of provider.chat([])) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(1);
    const first = chunks[0];
    expect(first).toBeDefined();
    expect(first!.content).toBe('ok');
    expect(first!.finishReason).toBe('stop');
  });
});

// ─── Message 类型契约 ─────────────────────────────────────

describe('Message · 类型契约', () => {
  it('system 消息只需 role + content', () => {
    const msg: Message = { role: 'system', content: '你是助手' };
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('你是助手');
    expect(msg.toolCalls).toBeUndefined();
    expect(msg.toolCallId).toBeUndefined();
  });

  it('assistant 消息可带 toolCalls', () => {
    const msg: Message = {
      role: 'assistant',
      content: '调用工具',
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"./a.txt"}' },
        },
      ],
    };
    expect(msg.toolCalls).toHaveLength(1);
    const firstCall = msg.toolCalls![0];
    expect(firstCall).toBeDefined();
    expect(firstCall!.function.name).toBe('read_file');
  });

  it('tool 消息可带 toolCallId', () => {
    const msg: Message = {
      role: 'tool',
      content: '文件内容',
      toolCallId: 'call_1',
    };
    expect(msg.toolCallId).toBe('call_1');
  });
});

// ─── ChatOptions 类型契约 ─────────────────────────────────

describe('ChatOptions · 类型契约（可选字段组合）', () => {
  it('空对象合法（所有字段可选）', () => {
    const opts: ChatOptions = {};
    expect(opts.model).toBeUndefined();
    expect(opts.temperature).toBeUndefined();
    expect(opts.tools).toBeUndefined();
    expect(opts.signal).toBeUndefined();
  });

  it('完整字段组合合法', () => {
    const opts: ChatOptions = {
      model: 'deepseek-chat',
      temperature: 0.7,
      maxTokens: 2000,
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: '读取文件',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      signal: new AbortController().signal,
      timeoutMs: 30000,
    };
    expect(opts.model).toBe('deepseek-chat');
    expect(opts.tools).toHaveLength(1);
    expect(opts.timeoutMs).toBe(30000);
  });
});
