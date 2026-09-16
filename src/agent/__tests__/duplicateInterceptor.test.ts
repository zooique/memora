/**
 * 重复工具调用拦截器单元测试
 *
 * 覆盖：
 *   1. DefaultDuplicateCallInterceptor 的 check() 判定逻辑
 *   2. hash() 静态方法的序列化稳定性
 *   3. 自定义拦截器注入 AgentLoop 的端到端验证
 *   4. 拦截器三态（ok / warn / block）的行为差异
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultDuplicateCallInterceptor } from '@/agent/duplicateInterceptor.js';
import type {
  DuplicateCallInterceptor,
  DuplicateCheckContext,
  DuplicateCheckVerdict,
} from '@/agent/types.js';
import { AgentLoop, type AgentLoopOptions } from '@/agent/loop.js';
import type { Message } from '@/llm/provider.js';

// ─── 辅助：创建 Message 对象（LLM Provider 需完整 Message 结构） ──

/** 创建带 toolCalls 的 assistant Message */
function toolMsg(toolCalls: Array<{ id: string; function: { name: string; arguments: string } }>): Message {
  return {
    role: 'assistant',
    content: '',
    toolCalls: toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: tc.function })),
  };
}

/** 创建纯文本 assistant Message */
function textMsg(content: string): Message {
  return { role: 'assistant', content };
}

// ─── 辅助：创建工具调用列表 ────────────────────────────

function makeToolCalls(calls: { name: string; args: string }[]) {
  return calls.map((c, i) => ({
    id: `call_${i}`,
    type: 'function' as const,
    function: { name: c.name, arguments: c.args },
  }));
}

function makeContext(overrides: Partial<DuplicateCheckContext> = {}): DuplicateCheckContext {
  return {
    iteration: 1,
    duplicateCount: 0,
    lastHash: 'hash_A',
    currentHash: 'hash_A',
    threshold: 3,
    ...overrides,
  };
}

// ─── DefaultDuplicateCallInterceptor 测试 ───────────────

describe('DefaultDuplicateCallInterceptor', () => {
  let interceptor: DefaultDuplicateCallInterceptor;

  beforeEach(() => {
    interceptor = new DefaultDuplicateCallInterceptor(3);
  });

  describe('check() 判定逻辑', () => {
    it('空工具调用列表返回 ok', () => {
      const ctx = makeContext();
      const result = interceptor.check([], ctx);
      expect(result).toBe('ok');
    });

    it('哈希不匹配返回 ok（工具调用已变化）', () => {
      const ctx = makeContext({ lastHash: 'hash_A', currentHash: 'hash_B' });
      const result = interceptor.check(makeToolCalls([{ name: 'read', args: '{}' }]), ctx);
      expect(result).toBe('ok');
    });

    it('当前哈希为空返回 ok', () => {
      const ctx = makeContext({ lastHash: '', currentHash: '' });
      const result = interceptor.check(makeToolCalls([{ name: 'read', args: '{}' }]), ctx);
      expect(result).toBe('ok');
    });

    it('哈希匹配但未达阈值返回 ok', () => {
      const ctx = makeContext({ lastHash: 'hash_A', currentHash: 'hash_A', duplicateCount: 2 });
      const result = interceptor.check(makeToolCalls([{ name: 'read', args: '{}' }]), ctx);
      expect(result).toBe('ok');
    });

    it('哈希匹配且达阈值返回 warn', () => {
      const ctx = makeContext({ lastHash: 'hash_A', currentHash: 'hash_A', duplicateCount: 3 });
      const result = interceptor.check(makeToolCalls([{ name: 'read', args: '{}' }]), ctx);
      expect(result).toBe('warn');
    });

    it('可通过构造参数调整阈值', () => {
      const customInterceptor = new DefaultDuplicateCallInterceptor(5);
      const ctx = makeContext({
        lastHash: 'hash_A',
        currentHash: 'hash_A',
        duplicateCount: 4,
        threshold: 5,
      });
      // count=4 < threshold=5 → ok
      expect(customInterceptor.check(makeToolCalls([{ name: 'read', args: '{}' }]), ctx)).toBe('ok');

      const ctx2 = makeContext({
        lastHash: 'hash_A',
        currentHash: 'hash_A',
        duplicateCount: 5,
        threshold: 5,
      });
      expect(customInterceptor.check(makeToolCalls([{ name: 'read', args: '{}' }]), ctx2)).toBe('warn');
    });

    it('拦截器 name 属性可读', () => {
      expect(interceptor.name).toBe('default-hash-interceptor');
    });
  });

  describe('hash() 静态方法', () => {
    it('相同工具+相同参数产生相同哈希', () => {
      const calls1 = makeToolCalls([{ name: 'read', args: '{"path":"a"}' }]);
      const calls2 = makeToolCalls([{ name: 'read', args: '{"path":"a"}' }]);
      expect(DefaultDuplicateCallInterceptor.hash(calls1)).toBe(
        DefaultDuplicateCallInterceptor.hash(calls2),
      );
    });

    it('不同工具产生不同哈希', () => {
      const calls1 = makeToolCalls([{ name: 'read', args: '{"path":"a"}' }]);
      const calls2 = makeToolCalls([{ name: 'write', args: '{"path":"a"}' }]);
      expect(DefaultDuplicateCallInterceptor.hash(calls1)).not.toBe(
        DefaultDuplicateCallInterceptor.hash(calls2),
      );
    });

    it('不同参数产生不同哈希', () => {
      const calls1 = makeToolCalls([{ name: 'read', args: '{"path":"a"}' }]);
      const calls2 = makeToolCalls([{ name: 'read', args: '{"path":"b"}' }]);
      expect(DefaultDuplicateCallInterceptor.hash(calls1)).not.toBe(
        DefaultDuplicateCallInterceptor.hash(calls2),
      );
    });

    it('参数 JSON 空白差异产生相同哈希（规范化）', () => {
      const calls1 = makeToolCalls([{ name: 'search', args: '{"query":"test"}' }]);
      const calls2 = makeToolCalls([{ name: 'search', args: '{"query":  "test"}' }]);
      expect(DefaultDuplicateCallInterceptor.hash(calls1)).toBe(
        DefaultDuplicateCallInterceptor.hash(calls2),
      );
    });

    it('不同顺序产生相同哈希（排序后序列化）', () => {
      const calls1 = makeToolCalls([
        { name: 'read', args: '{"path":"a"}' },
        { name: 'write', args: '{"path":"b"}' },
      ]);
      const calls2 = makeToolCalls([
        { name: 'write', args: '{"path":"b"}' },
        { name: 'read', args: '{"path":"a"}' },
      ]);
      expect(DefaultDuplicateCallInterceptor.hash(calls1)).toBe(
        DefaultDuplicateCallInterceptor.hash(calls2),
      );
    });

    it('空数组返回空字符串', () => {
      expect(DefaultDuplicateCallInterceptor.hash([])).toBe('');
    });
  });
});

// ─── 自定义拦截器：按工具名差异化策略 ────────────────────

/**
 * 示例：按工具名差异化策略
 *   - search 工具：阈值 5（宽容，search 可能多次）
 *   - delete 工具：直接 block（危险操作不应重复）
 *   - 其他工具：阈值 3
 */
class ToolAwareInterceptor implements DuplicateCallInterceptor {
  readonly name = 'tool-aware-interceptor';

  check(
    toolCalls: readonly { id: string; function: { name: string; arguments: string } }[],
    context: DuplicateCheckContext,
  ): DuplicateCheckVerdict {
    if (toolCalls.length === 0) return 'ok';
    if (context.currentHash === '' || context.currentHash !== context.lastHash) return 'ok';

    const firstName = toolCalls[0]!.function.name;

    // delete 工具：直接 block
    if (firstName.startsWith('delete')) return 'block';

    // search 工具：阈值 5
    if (firstName === 'search') {
      return context.duplicateCount >= 5 ? 'warn' : 'ok';
    }

    // 其他工具：默认阈值 3
    return context.duplicateCount >= 3 ? 'warn' : 'ok';
  }
}

describe('自定义拦截器：ToolAwareInterceptor', () => {
  const interceptor = new ToolAwareInterceptor();

  it('delete 工具直接 block', () => {
    const ctx = makeContext({ duplicateCount: 1 });
    const result = interceptor.check(
      makeToolCalls([{ name: 'delete_file', args: '{"path":"x"}' }]),
      ctx,
    );
    expect(result).toBe('block');
  });

  it('search 工具阈值为 5（count=4 仍 ok）', () => {
    const ctx = makeContext({ duplicateCount: 4 });
    const result = interceptor.check(
      makeToolCalls([{ name: 'search', args: '{"q":"x"}' }]),
      ctx,
    );
    expect(result).toBe('ok');
  });

  it('search 工具 count=5 返回 warn', () => {
    const ctx = makeContext({ duplicateCount: 5 });
    const result = interceptor.check(
      makeToolCalls([{ name: 'search', args: '{"q":"x"}' }]),
      ctx,
    );
    expect(result).toBe('warn');
  });

  it('其他工具 count=3 返回 warn', () => {
    const ctx = makeContext({ duplicateCount: 3 });
    const result = interceptor.check(
      makeToolCalls([{ name: 'read_file', args: '{"p":"x"}' }]),
      ctx,
    );
    expect(result).toBe('warn');
  });
});

// ─── 拦截器注入 AgentLoop 端到端测试 ─────────────────────

/** 简单 Mock Provider（返回固定序列的 LLM 响应） */
function mockMultiTurnProvider(
  responses: Message[][],
): AgentLoopOptions['provider'] {
  let callIndex = 0;
  return {
    name: 'mock',
    supportsStructuredOutput: true,
    async *chat(_messages: Message[], opts?: { model?: string }) {
      const roundIndex = callIndex % responses.length;
      callIndex++;
      const round = responses[roundIndex]!;
      for (const msg of round) {
        yield msg;
      }
      // 流式结束标记
      yield {
        content: '',
        toolCalls: undefined,
        done: true,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        model: opts?.model ?? 'test',
      };
    },
  } as unknown as AgentLoopOptions['provider'];
}

describe('拦截器注入 AgentLoop 端到端', () => {
  it('注入自定义拦截器后，block 判定注入 BLOCKED 消息', async () => {
    // 场景：连续 delete 工具调用被拦截器 block
    const toolExecutor = vi.fn().mockResolvedValue('已删除');
    const customInterceptor = new ToolAwareInterceptor();

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        // 第 1 轮：delete_file（首次，hash=X，count=0 → ok，写入 hash）
        [
          toolMsg([{ id: 'c1', function: { name: 'delete_file', arguments: '{"path":"a"}' } }]),
        ],
        // 第 2 轮：相同 delete_file（hash 仍为 X → count=1，但 delete 直接 block）
        [
          toolMsg([{ id: 'c2', function: { name: 'delete_file', arguments: '{"path":"a"}' } }]),
        ],
        // 第 3 轮：LLM 继续
        [textMsg('完成')],
      ]),
      bootstrapMemories: [],
      toolExecutor,
      duplicateCallInterceptor: customInterceptor,
    });

    for await (const chunk of loop.processUserInput('测试')) {
      void chunk;
    }

    // 应注入 DUPLICATE_TOOL_CALL_BLOCKED 消息（来自 block 拦截）
    const messages = loop.getMessages();
    const blockedMsg = messages.find(
      (m) => m.role === 'system' && m.content.includes('DUPLICATE_TOOL_CALL_BLOCKED'),
    );
    expect(blockedMsg).toBeDefined();
  });

  it('注入自定义拦截器后，warn 判定注入 WARNING 消息', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('相同结果');
    const customInterceptor = new ToolAwareInterceptor();

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        // 第 1-4 轮：相同 read 调用（hash 相同，count 从 0 累加到 3）
        ...Array.from({ length: 4 }, (_, i) => [
          toolMsg([{ id: `c${i}`, function: { name: 'read_file', arguments: '{"path":"x"}' } }]),
        ]),
        [textMsg('完成')],
      ]),
      bootstrapMemories: [],
      toolExecutor,
      duplicateCallInterceptor: customInterceptor,
    });

    for await (const chunk of loop.processUserInput('测试')) {
      void chunk;
    }

    // read_file 触发 warn（默认阈值 3，count 达到 3 时触发）
    const messages = loop.getMessages();
    const warningMsg = messages.find(
      (m) => m.role === 'system' && m.content.includes('DUPLICATE_TOOL_CALL_WARNING'),
    );
    expect(warningMsg).toBeDefined();
  });

  it('默认拦截器（不传自定义实现）保持向后兼容', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('ok');

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        ...Array.from({ length: 4 }, (_, i) => [
          toolMsg([{ id: `c${i}`, function: { name: 'search', arguments: '{"q":"x"}' } }]),
        ]),
        [textMsg('完成')],
      ]),
      bootstrapMemories: [],
      toolExecutor,
      // 不传 duplicateCallInterceptor → 使用默认
    });

    for await (const chunk of loop.processUserInput('测试')) {
      void chunk;
    }

    const messages = loop.getMessages();
    // 默认拦截器应在 count=3 时触发 warn
    const warningMsg = messages.find(
      (m) => m.role === 'system' && m.content.includes('DUPLICATE_TOOL_CALL_WARNING'),
    );
    expect(warningMsg).toBeDefined();
  });

  it('拦截器完全放行（始终返回 ok）不会注入任何消息', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('ok');
    // 放行型拦截器：忽略重复检测
    const passThroughInterceptor: DuplicateCallInterceptor = {
      name: 'pass-through',
      check: () => 'ok',
    };

    const loop = new AgentLoop({
      // 用 write_file（副作用型，不防重）才能穿透 toolResultCache 到 duplicateInterceptor；
      // 路径各不相同（x0..x4），避免触发同路径连写止损护栏（write_loop，WRITE_LOOP_THRESHOLD=5）
      provider: mockMultiTurnProvider([
        ...Array.from({ length: 5 }, (_, i) => [
          toolMsg([{ id: `c${i}`, function: { name: 'write_file', arguments: `{"path":"x${i}","content":"ok"}` } }]),
        ]),
        [textMsg('完成')],
      ]),
      bootstrapMemories: [],
      toolExecutor,
      duplicateCallInterceptor: passThroughInterceptor,
    });

    for await (const chunk of loop.processUserInput('测试')) {
      void chunk;
    }

    const messages = loop.getMessages();
    const hasWarning = messages.some(
      (m) =>
        m.role === 'system' &&
        (m.content.includes('DUPLICATE_TOOL_CALL_WARNING') ||
          m.content.includes('DUPLICATE_TOOL_CALL_BLOCKED')),
    );
    expect(hasWarning).toBe(false);
    // 工具应被调用 5 次（全部放行）
    expect(toolExecutor).toHaveBeenCalledTimes(5);
  });

  it('拦截器通过 context 获得完整运行时信息', async () => {
    const toolExecutor = vi.fn().mockResolvedValue('ok');
    const contextCapture: DuplicateCheckContext[] = [];
    const capturingInterceptor: DuplicateCallInterceptor = {
      name: 'capturing',
      check: (_toolCalls, context) => {
        contextCapture.push({ ...context });
        return 'ok';
      },
    };

    const loop = new AgentLoop({
      provider: mockMultiTurnProvider([
        [
          toolMsg([{ id: 'c1', function: { name: 'read', arguments: '{"p":"a"}' } }]),
        ],
        [
          toolMsg([{ id: 'c2', function: { name: 'read', arguments: '{"p":"a"}' } }]),
        ],
        [
          toolMsg([{ id: 'c3', function: { name: 'write', arguments: '{"p":"b"}' } }]),
        ],
        [textMsg('完成')],
      ]),
      bootstrapMemories: [],
      toolExecutor,
      duplicateCallInterceptor: capturingInterceptor,
    });

    for await (const chunk of loop.processUserInput('测试')) {
      void chunk;
    }

    // 每轮都应调用拦截器
    expect(contextCapture.length).toBeGreaterThanOrEqual(3);
    // 第 1 轮：首次调用，count 应为 0
    expect(contextCapture[0]!.duplicateCount).toBe(0);
    expect(contextCapture[0]!.currentHash).not.toBe('');
    // 第 2 轮：相同调用，count 应为 1
    expect(contextCapture[1]!.duplicateCount).toBe(1);
    // 第 3 轮：工具变化（write ≠ read），count 应重置为 0
    expect(contextCapture[2]!.duplicateCount).toBe(0);
    // 所有 context 应包含 iteration 和 threshold
    for (const ctx of contextCapture) {
      expect(ctx.iteration).toBeGreaterThan(0);
      expect(ctx.threshold).toBe(3);
    }
  });
});