/**
 * LLM Judge 高阶辅助函数单元测试
 *
 * 覆盖 judgeWithLlm 的三件套模式：
 *   1. 流式累积 → parseLlmJson → 判 null → 抛 configError
 *   2. 成功路径：有效 JSON 解析
 *   3. 失败路径：无效 JSON 抛 configError
 *   4. 空响应（空字符串）抛 configError
 *   5. Provider 异常向上传播
 *   6. options 参数正确传递
 */
import { describe, it, expect } from 'vitest';
import { judgeWithLlm, type LlmJudgeOptions } from '@/agent/managers/llmJudgeHelper.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import { MemoraError } from '@/utils/errors.js';

// ─── 辅助：创建 Mock Provider ────────────────────

/** 创建返回固定内容的 Mock Provider */
function createMockProvider(content: string): LlmProvider {
  return {
    name: 'mock-judge',
    supportsStructuredOutput: true,
    async *chat(_messages: Message[], _opts?: unknown) {
      // 模拟 LLM 分段输出
      const chunks = content.match(/.{1,5}/g) ?? [content];
      for (const chunk of chunks) {
        yield { content: chunk };
      }
    },
  } as unknown as LlmProvider;
}

/** 创建返回空响应的 Mock Provider */
function createEmptyProvider(): LlmProvider {
  return {
    name: 'mock-empty',
    supportsStructuredOutput: true,
    async *chat(_messages: Message[], _opts?: unknown) {
      // 不 yield 任何 chunk
    },
  } as unknown as LlmProvider;
}

/** 创建抛出异常的 Mock Provider */
function createErrorProvider(error: Error): LlmProvider {
  return {
    name: 'mock-error',
    supportsStructuredOutput: true,
    async *chat(_messages: Message[], _opts?: unknown) {
      throw error;
    },
  } as unknown as LlmProvider;
}

// ─── 辅助：创建默认选项 ────────────────────────

const defaultOptions: LlmJudgeOptions = {
  maxTokens: 400,
  timeoutMs: 30000,
};

const testMessages: Message[] = [
  { role: 'system', content: '你是 JSON 输出专家' },
  { role: 'user', content: '输出 {"valid": true}' },
];

// ════════════════════════════════════════════════════════
// 1. 成功路径
// ════════════════════════════════════════════════════════

describe('judgeWithLlm — 成功路径', () => {
  it('解析有效 JSON 对象', async () => {
    const provider = createMockProvider('{"status":"ok","score":0.9}');
    const result = await judgeWithLlm<{ status: string; score: number }>(
      provider,
      testMessages,
      defaultOptions,
      '测试解析',
    );

    expect(result).toEqual({ status: 'ok', score: 0.9 });
  });

  it('解析嵌套 JSON', async () => {
    const provider = createMockProvider('{"data":{"items":[1,2,3],"meta":{"count":3}}}');
    const result = await judgeWithLlm<{ data: { items: number[]; meta: { count: number } } }>(
      provider,
      testMessages,
      defaultOptions,
      '嵌套 JSON 解析',
    );

    expect(result.data.items).toEqual([1, 2, 3]);
    expect(result.data.meta.count).toBe(3);
  });

  it('解析数组 JSON', async () => {
    const provider = createMockProvider('[1,2,3]');
    const result = await judgeWithLlm<number[]>(provider, testMessages, defaultOptions, '数组解析');

    expect(result).toEqual([1, 2, 3]);
  });

  it('解析带代码块包裹的 JSON', async () => {
    // parseLlmJson 支持剥离 ```json``` 代码块
    const provider = createMockProvider('```json\n{"key":"value"}\n```');
    const result = await judgeWithLlm<{ key: string }>(
      provider,
      testMessages,
      defaultOptions,
      '代码块解析',
    );

    expect(result).toEqual({ key: 'value' });
  });

  it('解析带前后空白的 JSON（trim 处理）', async () => {
    const provider = createMockProvider('  \n  {"key":"value"}  \n  ');
    const result = await judgeWithLlm<{ key: string }>(
      provider,
      testMessages,
      defaultOptions,
      '空白处理',
    );

    expect(result).toEqual({ key: 'value' });
  });
});

// ════════════════════════════════════════════════════════
// 2. 失败路径：无效 JSON
// ════════════════════════════════════════════════════════

describe('judgeWithLlm — 失败路径：无效 JSON', () => {
  it('无效 JSON 抛 configError', async () => {
    const provider = createMockProvider('not valid json');

    try {
      await judgeWithLlm(provider, testMessages, defaultOptions, '测试错误标题');
      expect.fail('应该抛出异常');
    } catch (e) {
      expect(e).toBeInstanceOf(MemoraError);
      const err = e as MemoraError;
      // MemoraError.message = title（由 super(title) 设置）
      expect(err.message).toBe('测试错误标题');
      // detail 包含具体原因
      expect(err.detail).toContain('不是有效的 JSON');
      // category 为 config
      expect(err.category).toBe('config');
    }
  });

  it('空响应抛 configError', async () => {
    const provider = createEmptyProvider();

    try {
      await judgeWithLlm(provider, testMessages, defaultOptions, '空响应测试');
      expect.fail('应该抛出异常');
    } catch (e) {
      expect(e).toBeInstanceOf(MemoraError);
      const err = e as MemoraError;
      expect(err.message).toContain('空响应测试');
    }
  });

  it('空字符串内容抛 configError', async () => {
    const provider = createMockProvider('   '); // 纯空白

    try {
      await judgeWithLlm(provider, testMessages, defaultOptions, '空白内容测试');
      expect.fail('应该抛出异常');
    } catch (e) {
      expect(e).toBeInstanceOf(MemoraError);
    }
  });

  it('错误信息包含排查建议', async () => {
    const provider = createMockProvider('invalid');

    try {
      await judgeWithLlm(provider, testMessages, defaultOptions, '建议测试');
      expect.fail('应该抛出异常');
    } catch (e) {
      const err = e as MemoraError;
      // configError 生成的错误应包含 suggestions
      expect(err).toBeDefined();
    }
  });
});

// ════════════════════════════════════════════════════════
// 3. 异常传播
// ════════════════════════════════════════════════════════

describe('judgeWithLlm — 异常传播', () => {
  it('Provider 异常向上传播', async () => {
    const provider = createErrorProvider(new Error('Provider 连接失败'));

    await expect(judgeWithLlm(provider, testMessages, defaultOptions, '异常传播')).rejects.toThrow(
      'Provider 连接失败',
    );
  });

  it('AbortError 正确传播', async () => {
    const provider = createErrorProvider(new DOMException('Aborted', 'AbortError'));

    await expect(
      judgeWithLlm(provider, testMessages, defaultOptions, 'AbortError'),
    ).rejects.toHaveProperty('name', 'AbortError');
  });

  it('超时异常正确传播', async () => {
    const provider = createErrorProvider(new Error('LLM 请求超时'));

    await expect(judgeWithLlm(provider, testMessages, defaultOptions, '超时测试')).rejects.toThrow(
      'LLM 请求超时',
    );
  });
});

// ════════════════════════════════════════════════════════
// 4. Options 参数传递
// ════════════════════════════════════════════════════════

describe('judgeWithLlm — options 传递', () => {
  it('maxTokens 和 timeoutMs 正确传递到 accumulateStream', async () => {
    let receivedOpts: Record<string, unknown> | undefined;
    const provider = {
      name: 'mock-opts',
      supportsStructuredOutput: true,
      async *chat(_messages: Message[], opts?: Record<string, unknown>) {
        receivedOpts = opts;
        yield { content: '{"ok":true}' };
      },
    } as unknown as LlmProvider;

    await judgeWithLlm(
      provider,
      testMessages,
      {
        maxTokens: 800,
        timeoutMs: 60000,
      },
      'options 测试',
    );

    expect(receivedOpts).toBeDefined();
    expect(receivedOpts!.maxTokens).toBe(800);
    expect(receivedOpts!.timeoutMs).toBe(60000);
    // temperature 固定为 0（judgeWithLlm 内部设置）
    expect(receivedOpts!.temperature).toBe(0);
  });

  it('signal 正确传递', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const provider = {
      name: 'mock-signal',
      supportsStructuredOutput: true,
      async *chat(_messages: Message[], opts?: Record<string, unknown>) {
        receivedSignal = opts?.signal as AbortSignal;
        yield { content: '{"ok":true}' };
      },
    } as unknown as LlmProvider;

    await judgeWithLlm(
      provider,
      testMessages,
      {
        maxTokens: 100,
        timeoutMs: 5000,
        signal: controller.signal,
      },
      'signal 测试',
    );

    expect(receivedSignal).toBe(controller.signal);
  });
});

// ════════════════════════════════════════════════════════
// 5. 边界场景
// ════════════════════════════════════════════════════════

describe('judgeWithLlm — 边界场景', () => {
  it('极小 JSON（如数字）', async () => {
    const provider = createMockProvider('{"value":42}');
    const result = await judgeWithLlm<{ value: number }>(
      provider,
      testMessages,
      defaultOptions,
      '数字解析',
    );
    expect(result.value).toBe(42);
  });

  it('布尔值 JSON', async () => {
    const provider = createMockProvider('{"value":true}');
    const result = await judgeWithLlm<{ value: boolean }>(
      provider,
      testMessages,
      defaultOptions,
      '布尔解析',
    );
    expect(result.value).toBe(true);
  });

  it('null JSON 值', async () => {
    const provider = createMockProvider('null');
    // parseLlmJson('null') 返回 null，judgeWithLlm 会抛 configError
    await expect(
      judgeWithLlm(provider, testMessages, defaultOptions, 'null 测试'),
    ).rejects.toBeInstanceOf(MemoraError);
  });

  it('多次调用独立工作', async () => {
    const provider = createMockProvider('{"count":1}');
    const result1 = await judgeWithLlm<{ count: number }>(
      provider,
      testMessages,
      defaultOptions,
      '第一次',
    );
    const result2 = await judgeWithLlm<{ count: number }>(
      provider,
      testMessages,
      defaultOptions,
      '第二次',
    );
    expect(result1.count).toBe(1);
    expect(result2.count).toBe(1);
  });
});
