/**
 * ContextManager 单元测试 — 上下文窗口管理器
 *
 * 覆盖范围：
 *   - estimateTokens()：token 估算（content + toolCalls JSON 字符数 / CHARS_PER_TOKEN）
 *   - shouldTruncate()：截断判定（token 超阈值 + 消息数 > 3）
 *   - truncateMessages()：截断策略（保下裁中 + 关键消息提取 + summary 注入 + 占位消息 + truncationCount 统计）
 *   - getOrCreateSummary()：摘要缓存（首次生成 + 缓存命中 + 过期重生成 + LLM 失败降级 + 无可摘要消息）
 *
 * 测试范式：mock LlmProvider.chat 返回 AsyncIterable + 真实 ContextManager 实例。
 * 私有方法 extractKeyMessages/messageImportance/generateContextSummary 通过公开 API 间接覆盖。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ContextManager } from '@/agent/contextManager.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { TRACE_SPANS, type ITracer, type ISpan } from '@/agent/tracer.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { LlmChunk } from '@/llm/types.js';

// ─── 测试夹具 ─────────────────────────────────────────────

/** CHARS_PER_TOKEN 常量本地引用（与 LOOP_CONSTANTS.CHARS_PER_TOKEN=3 一致） */
const CHARS_PER_TOKEN = LOOP_CONSTANTS.CHARS_PER_TOKEN;

/** CJK_CHARS_PER_TOKEN 常量本地引用（CJK 字符 token 估算密度） */
const CJK_CHARS_PER_TOKEN = LOOP_CONSTANTS.CJK_CHARS_PER_TOKEN;

/**
 * 构造 Message（默认 role=user）
 * @param content - 消息内容
 * @param overrides - 字段覆写
 * @returns 完整 Message 对象
 */
function createMessage(content: string, overrides: Partial<Message> = {}): Message {
  return { role: 'user', content, ...overrides };
}

/**
 * 构造 mock LlmProvider（chat 方法返回 AsyncIterable）
 * @param chunks - 模拟 LLM 返回的 chunk 序列
 * @param shouldThrow - chat 方法是否抛出异常（测试降级）
 * @returns mock LlmProvider 实例
 */
function createMockProvider(
  chunks: LlmChunk[] = [{ content: '摘要内容' }],
  shouldThrow = false,
): LlmProvider {
  const chatMock = vi.fn().mockImplementation(() => {
    if (shouldThrow) {
      // 返回一个 async iterator，迭代时抛出异常
      return (async function* () {
        throw new Error('LLM 调用失败');
      })();
    }
    return (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })();
  });
  return {
    name: 'mock-provider',
    chat: chatMock,
  } as unknown as LlmProvider;
}

/**
 * 构造 ContextManager 实例
 * @param maxContextTokens - 上下文窗口 token 上限
 * @param provider - LlmProvider 实例（默认 mock）
 * @returns ContextManager 实例
 */
function createContextManager(
  maxContextTokens: number,
  provider: LlmProvider = createMockProvider(),
): ContextManager {
  return new ContextManager({
    maxContextTokens,
    provider,
    contextTruncatedFn: (skipped, kept) => `[截断] 跳过 ${skipped} 条，保留 ${kept} 条`,
  });
}

/**
 * 构造超长消息数组（用于触发截断）
 * @param count - 消息总数
 * @param contentLen - 每条消息内容长度
 * @returns Message 数组（第一条为 system）
 */
function createLongMessages(count: number, contentLen: number): Message[] {
  const messages: Message[] = [{ role: 'system', content: 'S'.repeat(contentLen) }];
  for (let i = 1; i < count; i++) {
    messages.push({ role: i % 2 === 0 ? 'assistant' : 'user', content: 'M'.repeat(contentLen) });
  }
  return messages;
}

/** mock LlmProvider（每个 it 重建，便于断言调用次数） */
let provider: LlmProvider;
/** ContextManager 实例（每个 it 重建） */
let manager: ContextManager;

beforeEach(() => {
  provider = createMockProvider();
  manager = createContextManager(1000, provider);
});

// ─── constructor + truncationCount ───────────────────────

describe('ContextManager 构造与 truncationCount', () => {
  it('初始 truncationCount=0', () => {
    expect(manager.truncationCount).toBe(0);
  });

  it('truncationCount 是只读 getter（返回 number 类型）', () => {
    // getter 存在且返回 number
    expect(typeof manager.truncationCount).toBe('number');
    expect(manager.truncationCount).toBe(0);
  });
});

// ─── estimateTokens() ────────────────────────────────────

describe('ContextManager.estimateTokens()', () => {
  it('空数组：返回 0', () => {
    expect(manager.estimateTokens([])).toBe(0);
  });

  it('单条消息：Math.ceil(content.length / CHARS_PER_TOKEN)', () => {
    const content = 'abcde'; // 5 字符 / 3 = 1.67 → ceil = 2
    const messages = [createMessage(content)];
    expect(manager.estimateTokens(messages)).toBe(Math.ceil(content.length / CHARS_PER_TOKEN));
  });

  it('多条消息：累加 token', () => {
    const messages = [
      createMessage('abc'), // 1 token
      createMessage('defgh'), // 2 token
      createMessage('ij'), // 1 token
    ];
    // 总字符 10 / 3 = 3.33 → ceil = 4
    expect(manager.estimateTokens(messages)).toBe(Math.ceil(10 / CHARS_PER_TOKEN));
  });

  it('toolCalls 计入：JSON.stringify 长度加入字符总数', () => {
    const toolCalls = [
      { id: 'call_1', type: 'function' as const, function: { name: 'test', arguments: '{}' } },
    ];
    const messages: Message[] = [{ role: 'assistant', content: 'x', toolCalls }];
    const expectedChars = 1 + JSON.stringify(toolCalls).length;
    expect(manager.estimateTokens(messages)).toBe(Math.ceil(expectedChars / CHARS_PER_TOKEN));
  });

  it('取整向上（ceil）', () => {
    // 4 字符 / 3 = 1.33 → ceil = 2
    expect(manager.estimateTokens([createMessage('abcd')])).toBe(2);
  });
});

// ─── shouldTruncate() ────────────────────────────────────

describe('ContextManager.shouldTruncate()', () => {
  it('未超阈值 + 消息数 > 3：返回 false', () => {
    const messages = [
      createMessage('a', { role: 'system' }),
      createMessage('b'),
      createMessage('c'),
      createMessage('d'),
    ];
    expect(manager.shouldTruncate(messages)).toBe(false);
  });

  it('超阈值 + 消息数 > 3：返回 true', () => {
    // 每条 100 字符 = 34 token，4 条共 134 token > 50（局部小窗口 manager）
    const smallManager = createContextManager(50);
    const messages = createLongMessages(4, 100);
    expect(smallManager.shouldTruncate(messages)).toBe(true);
  });

  it('超阈值 + 消息数 ≤ 3：返回 false', () => {
    // 3 条消息但 token 超阈值
    const messages = [
      createMessage('S'.repeat(200), { role: 'system' }),
      createMessage('M'.repeat(200)),
      createMessage('M'.repeat(200)),
    ];
    expect(manager.shouldTruncate(messages)).toBe(false);
  });

  it('setMaxContextTokens 放大窗口后：超阈判定随新窗口同步（模型热切换）', () => {
    const smallManager = createContextManager(50);
    const messages = createLongMessages(4, 100); // 每条 ~34 token，4 条 > 50
    // 小窗口：触发截断
    expect(smallManager.shouldTruncate(messages)).toBe(true);
    // 热切换到 200K 大窗口：同一批消息不再触发截断（setMaxContextTokens 立即生效）
    smallManager.setMaxContextTokens(200_000);
    expect(smallManager.shouldTruncate(messages)).toBe(false);
  });
});

// ─── truncateMessages() ──────────────────────────────────

describe('ContextManager.truncateMessages()', () => {
  describe('不触发截断的场景', () => {
    it('未超阈值：返回原数组引用', () => {
      const messages = [
        createMessage('a', { role: 'system' }),
        createMessage('b'),
        createMessage('c'),
      ];
      const result = manager.truncateMessages(messages);
      expect(result).toBe(messages); // 同一引用
      expect(manager.truncationCount).toBe(0);
    });

    it('消息数 ≤ 3：返回原数组引用（即使超阈值）', () => {
      const messages = [
        createMessage('S'.repeat(200), { role: 'system' }),
        createMessage('M'.repeat(200)),
        createMessage('M'.repeat(200)),
      ];
      const result = manager.truncateMessages(messages);
      expect(result).toBe(messages);
      expect(manager.truncationCount).toBe(0);
    });

    it('无 system prompt（messages[0] 非 system）：返回原数组', () => {
      const messages = [createMessage('user-first'), ...createLongMessages(5, 100).slice(1)];
      const result = manager.truncateMessages(messages);
      expect(result).toBe(messages);
      expect(manager.truncationCount).toBe(0);
    });

    it('system prompt 自身超限：返回原数组 + 不截断', () => {
      // maxContextTokens=100，system prompt 内容 400 字符 = 134 token > 100
      const messages = [
        createMessage('S'.repeat(400), { role: 'system' }),
        createMessage('M'.repeat(100)),
        createMessage('M'.repeat(100)),
        createMessage('M'.repeat(100)),
      ];
      const result = manager.truncateMessages(messages);
      expect(result).toBe(messages);
      expect(manager.truncationCount).toBe(0);
    });
  });

  describe('正常截断', () => {
    it('保留 system + 截断中间 + 保留尾部', () => {
      // 局部小窗口 manager：maxContextTokens=80
      // 每条 80 字符 = 27 token，6 条 = 162 token > 80
      const smallManager = createContextManager(80);
      const messages = [
        createMessage('S'.repeat(80), { role: 'system' }),
        createMessage('U1-' + 'x'.repeat(76)), // user
        createMessage('A1-' + 'x'.repeat(76), { role: 'assistant' }),
        createMessage('U2-' + 'x'.repeat(76)),
        createMessage('A2-' + 'x'.repeat(76), { role: 'assistant' }),
        createMessage('U3-' + 'x'.repeat(76)),
      ];
      const result = smallManager.truncateMessages(messages);
      expect(result).not.toBe(messages); // 不同引用
      expect(smallManager.truncationCount).toBe(1);
      // 第一条必须是原 system
      expect(result[0]).toBe(messages[0]);
      // 最后一条必须是原最后一条
      expect(result[result.length - 1]).toBe(messages[messages.length - 1]);
      // 结果长度应小于原数组
      expect(result.length).toBeLessThan(messages.length);
    });

    it('截断后包含 placeholder 占位消息', () => {
      // 10 条 × 80 字符 = 800 字符 / 3 = 267 token > 100
      const smallManager = createContextManager(100);
      const messages = createLongMessages(10, 80);
      const result = smallManager.truncateMessages(messages);
      // 查找 placeholder（content 包含"截断"）
      const placeholder = result.find((m) => m.role === 'system' && m.content.includes('截断'));
      expect(placeholder).toBeDefined();
      // placeholder 文案包含 skipped 和 kept 数量
      expect(placeholder?.content).toMatch(/跳过 \d+ 条/);
      expect(placeholder?.content).toMatch(/保留 \d+ 条/);
    });

    it('truncationCount 累加（多次截断）', () => {
      const smallManager = createContextManager(100);
      const messages = createLongMessages(10, 80);
      smallManager.truncateMessages(messages);
      smallManager.truncateMessages(messages);
      smallManager.truncateMessages(messages);
      expect(smallManager.truncationCount).toBe(3);
    });

    it('未触发截断时 truncationCount 不增加', () => {
      const shortMessages = [
        createMessage('a', { role: 'system' }),
        createMessage('b'),
        createMessage('c'),
      ];
      manager.truncateMessages(shortMessages);
      expect(manager.truncationCount).toBe(0);
    });
  });

  describe('summary 注入', () => {
    it('有 summary 时：插入到 system 和 placeholder 之间', () => {
      const smallManager = createContextManager(100);
      const messages = createLongMessages(10, 80);
      const summary = '这是上下文摘要';
      const result = smallManager.truncateMessages(messages, summary);
      // result[0] 是 system prompt
      expect(result[0]).toBe(messages[0]);
      // result[1] 应该是 summary（role=system, content=summary）
      expect(result[1]).toEqual({ role: 'system', content: summary });
    });

    it('无 summary 时：不插入额外消息', () => {
      const smallManager1 = createContextManager(100);
      const smallManager2 = createContextManager(100);
      const messages = createLongMessages(10, 80);
      const resultWithSummary = smallManager1.truncateMessages(messages, 'summary');
      const resultWithoutSummary = smallManager2.truncateMessages(messages);
      // 有 summary 的结果应比无 summary 多 1 条
      expect(resultWithSummary.length).toBe(resultWithoutSummary.length + 1);
    });
  });

  describe('关键消息提取（权重 user > tool > assistant）', () => {
    it('user 消息优先于 assistant 消息被保留', () => {
      // 构造：system(短) + 短 user(cut 区域) + 长 assistant(cut 区域) + 长 tail
      // tail 占满预算，关键消息预算仅够放短 user（1 token），长 assistant（10 token）放不下
      const managerSmall = createContextManager(15);
      const messages = [
        createMessage('S', { role: 'system' }), // 1 token
        createMessage('U', { role: 'user' }), // 1 token（短 user，应被关键消息提取选中）
        createMessage('A'.repeat(30), { role: 'assistant' }), // 10 token（长 assistant，放不下）
        createMessage('T'.repeat(30), { role: 'user' }), // 10 token（长 tail）
      ];
      const result = managerSmall.truncateMessages(messages);
      expect(managerSmall.truncationCount).toBe(1);
      // user 'U' 应被保留为关键消息
      const hasUser = result.some((m) => m.role === 'user' && m.content === 'U');
      expect(hasUser).toBe(true);
      // 长 assistant 不应出现在结果中（被裁剪且未被关键消息提取）
      const hasLongAssistant = result.some(
        (m) => m.role === 'assistant' && m.content === 'A'.repeat(30),
      );
      expect(hasLongAssistant).toBe(false);
    });

    it('权重排序：user(3) > tool(2) > assistant(1)，短消息优先于长消息被保留', () => {
      // 构造：system + 短 user(cut) + 短 tool(cut) + 长 assistant(cut) + 长 tail
      // 关键消息预算够放短 user + 短 tool，但放不下长 assistant
      const managerTiny = createContextManager(15);
      const messages = [
        createMessage('S', { role: 'system' }), // 1 token
        createMessage('U', { role: 'user' }), // 1 token（cut，权重 3）
        createMessage('t', { role: 'tool' }), // 1 token（cut，权重 2）
        createMessage('A'.repeat(30), { role: 'assistant' }), // 10 token（cut，权重 1，放不下）
        createMessage('X'.repeat(30), { role: 'user' }), // 10 token（tail）
      ];
      const result = managerTiny.truncateMessages(messages);
      expect(managerTiny.truncationCount).toBe(1);
      // user 和 tool 应被保留为关键消息
      const hasUser = result.some((m) => m.role === 'user' && m.content === 'U');
      const hasTool = result.some((m) => m.role === 'tool' && m.content === 't');
      expect(hasUser).toBe(true);
      expect(hasTool).toBe(true);
      // 长 assistant 不应被保留
      const hasLongAssistant = result.some(
        (m) => m.role === 'assistant' && m.content === 'A'.repeat(30),
      );
      expect(hasLongAssistant).toBe(false);
    });

    it('extractKeyMessages 恢复原始顺序：贪心选取后按原始时间线顺序返回', () => {
      // 构造：system + tool(cut, 权重2, 原始第1) + user(cut, 权重3, 原始第2) + 大filler(cut, assistant, 放不下) + 短 tail
      // 贪心选取顺序：user(权重3) → tool(权重2)，大filler(权重1, 20token) 放不下触发 break
      // 返回时应恢复为原始时间线顺序：tool → user（非贪心顺序 user → tool）
      // maxContextTokens=6 → availableTokens=floor(6*0.9)-1=4, tail=1 token, keyMessages 预算=3
      // tool + user 各 1 token = 2 token ≤ 预算 3，均被选中；大 filler 20 token 触发 break
      const managerTiny = createContextManager(6);
      const messages = [
        createMessage('S', { role: 'system' }), // 1 token
        createMessage('t', { role: 'tool' }), // 1 token（cut，权重 2，原始第 1）
        createMessage('U', { role: 'user' }), // 1 token（cut，权重 3，原始第 2）
        createMessage('F'.repeat(60), { role: 'assistant' }), // 20 token（cut，权重 1，大 filler，放不下 break）
        createMessage('T', { role: 'user' }), // 1 token（tail）
      ];
      const result = managerTiny.truncateMessages(messages);
      expect(managerTiny.truncationCount).toBe(1);

      // 提取关键消息区域（placeholder 之前、system 之后）
      // 结构：[system, keyMessages..., placeholder, tail]
      const placeholderIdx = result.findIndex(
        (m) => m.role === 'system' && m.content.includes('截断'),
      );
      expect(placeholderIdx).toBeGreaterThan(0);

      // keyMessages 在 system 之后、placeholder 之前
      const keyMessages = result.slice(1, placeholderIdx);
      // 应包含 tool 和 user（预算 3 token，2 条 × 1 token = 2 token ≤ 3）
      expect(keyMessages.length).toBe(2);
      // 顺序应恢复为原始时间线：tool → user（非贪心顺序 user → tool）
      expect(keyMessages[0]!.role).toBe('tool');
      expect(keyMessages[1]!.role).toBe('user');
    });

    it('同权重消息按内容长度降序选取：长消息优先于短消息', () => {
      // 构造：system + 短 user + 长 user + 大 filler + 短 tail
      // maxContextTokens=6 → availableTokens=4, tail=1, keyMessages 预算=3
      // 同权重 user(3) 按内容长度降序：长 user(3 token) 排在短 user(1 token) 前
      // 长 user 3 token = 预算 3，刚好放下；短 user 1 token，3+1=4 > 3，放不下
      const managerTiny = createContextManager(6);
      const messages = [
        createMessage('S', { role: 'system' }), // 1 token
        createMessage('ab', { role: 'user' }), // 1 token（短 user，cut，权重 3）
        createMessage('abcdefghi', { role: 'user' }), // 3 token（长 user，cut，权重 3）
        createMessage('F'.repeat(60), { role: 'assistant' }), // 20 token（大 filler，cut，权重 1）
        createMessage('T', { role: 'user' }), // 1 token（tail）
      ];
      const result = managerTiny.truncateMessages(messages);
      expect(managerTiny.truncationCount).toBe(1);

      const placeholderIdx = result.findIndex(
        (m) => m.role === 'system' && m.content.includes('截断'),
      );
      expect(placeholderIdx).toBeGreaterThan(0);
      const keyMessages = result.slice(1, placeholderIdx);

      // 同权重时长消息优先选取，预算仅够放长 user（3 token = 预算 3）
      expect(keyMessages.length).toBe(1);
      expect(keyMessages[0]!.content).toBe('abcdefghi');
    });
  });

  describe('截断后消息结构顺序', () => {
    it('结构应为 system → summary → keyMessages → placeholder → tail', () => {
      // 构造多层截断场景：system + U1(cut) + A1(cut) + big_filler(cut, 放不进 tail) + TU(tail) + TA(tail)
      // maxContextTokens=10 → availableTokens=floor(10*0.9)-1=8
      // tail: TA(2) + TU(2) = 4 token, cutIndex=4（big 放不进 tail）
      // cutMessages = [U1, A1, big], keyMessages 预算 = 8-4 = 4
      // U1(权重3, 2 token) 选中, A1(权重1, 2 token) 选中, big(权重1, 20 token) 跳过
      const managerSmall = createContextManager(10);
      const messages = [
        createMessage('SYS', { role: 'system' }), // 1 token
        createMessage('U1-c', { role: 'user' }), // 2 token（cut，权重 3，关键消息）
        createMessage('A1-c', { role: 'assistant' }), // 2 token（cut，权重 1，关键消息）
        createMessage('F'.repeat(60), { role: 'assistant' }), // 20 token（大 filler，cut，放不进 tail/关键消息）
        createMessage('TU', { role: 'user' }), // 2 token（tail）
        createMessage('TA', { role: 'assistant' }), // 2 token（tail）
      ];
      const summary = '上下文摘要内容';
      const result = managerSmall.truncateMessages(messages, summary);

      // 结构验证：[0]=system, [1]=summary, [2..n]=keyMessages, placeholder, tail
      expect(result[0]).toBe(messages[0]); // system
      expect(result[1]).toEqual({ role: 'system', content: summary }); // summary

      // 找到 placeholder 位置
      const placeholderIdx = result.findIndex(
        (m) => m.role === 'system' && m.content.includes('截断'),
      );
      expect(placeholderIdx).toBeGreaterThan(1); // 在 summary 之后

      // placeholder 之后应为 tail 消息
      const tailPart = result.slice(placeholderIdx + 1);
      expect(tailPart.length).toBeGreaterThan(0);
      // tail 最后两条应是原数组的最后两条
      expect(tailPart[tailPart.length - 1]).toBe(messages[messages.length - 1]);
      expect(tailPart[tailPart.length - 2]).toBe(messages[messages.length - 2]);
    });
  });

  describe('截断边界', () => {
    it('全部保留（cutIndex 回到 1）：不截断', () => {
      // tail 容量足够容纳所有非 system 消息
      const messages = [
        createMessage('SYS', { role: 'system' }),
        createMessage('a'),
        createMessage('b'),
        createMessage('c'),
      ];
      // 4 条短消息，token 远小于 1000
      const result = manager.truncateMessages(messages);
      expect(result).toBe(messages);
      expect(manager.truncationCount).toBe(0);
    });

    it('截断后结果估算 token 不超过 maxContextTokens（含 10% 缓冲）', () => {
      // 20 × 80 = 1600 字符 / 3 = 534 token > 100
      const smallManager = createContextManager(100);
      const messages = createLongMessages(20, 80);
      const result = smallManager.truncateMessages(messages);
      const newTokens = smallManager.estimateTokens(result);
      // 截断后应明显小于原 token 数
      const originalTokens = smallManager.estimateTokens(messages);
      expect(newTokens).toBeLessThan(originalTokens);
      // 应不超过 maxContextTokens * 1.1（10% 缓冲 + 估算误差）
      expect(newTokens).toBeLessThanOrEqual(100 * 1.1);
    });
  });
});

// ─── getOrCreateSummary() ────────────────────────────────

describe('ContextManager.getOrCreateSummary()', () => {
  it('首次调用：调用 provider.chat 生成摘要', async () => {
    const messages = [
      createMessage('SYS', { role: 'system' }),
      createMessage('用户问题 1'),
      createMessage('助手回复 1', { role: 'assistant' }),
    ];
    const summary = await manager.getOrCreateSummary(messages);
    // 应调用 provider.chat
    expect(provider.chat).toHaveBeenCalledTimes(1);
    // 摘要应包含 LLM 返回的内容
    expect(summary).toContain('摘要内容');
    // 摘要格式：[Context summary of earlier conversation]\n${summary}
    expect(summary.startsWith('[Context summary of earlier conversation]')).toBe(true);
  });

  it('缓存命中：不调用 provider.chat', async () => {
    const messages = [createMessage('SYS', { role: 'system' }), createMessage('用户问题')];
    // 首次调用
    await manager.getOrCreateSummary(messages);
    expect(provider.chat).toHaveBeenCalledTimes(1);
    // 第二次调用（消息数未增长超过 SUMMARY_CACHE_TTL_MSGS=10）
    await manager.getOrCreateSummary(messages);
    expect(provider.chat).toHaveBeenCalledTimes(1); // 仍为 1
  });

  it('缓存过期（消息数增长超过 SUMMARY_CACHE_TTL_MSGS=10）：重新生成', async () => {
    const initialMessages = [createMessage('SYS', { role: 'system' }), createMessage('问题 1')];
    await manager.getOrCreateSummary(initialMessages);
    expect(provider.chat).toHaveBeenCalledTimes(1);

    // 消息数增长超过 10 条
    const grownMessages: Message[] = [createMessage('SYS', { role: 'system' })];
    for (let i = 0; i < 12; i++) {
      grownMessages.push(createMessage(`消息 ${i}`));
    }
    await manager.getOrCreateSummary(grownMessages);
    expect(provider.chat).toHaveBeenCalledTimes(2); // 重新生成
  });

  it('resetSummary 作废缓存后重新生成（即使消息集合变短）', async () => {
    // 首次生成
    const longMessages = [createMessage('SYS', { role: 'system' })];
    for (let i = 0; i < 12; i++) {
      longMessages.push(createMessage(`消息 ${i}`));
    }
    await manager.getOrCreateSummary(longMessages);
    expect(provider.chat).toHaveBeenCalledTimes(1);

    // reset 后换成更短的消息集合：长度差为负，若无 reset 会误判"未过期"复用陈旧摘要
    // （restoreHistory 整体替换历史即此场景）；reset 显式作废 → 必须重新生成
    manager.resetSummary();
    const shortMessages = [createMessage('SYS', { role: 'system' }), createMessage('新会话消息')];
    await manager.getOrCreateSummary(shortMessages);
    expect(provider.chat).toHaveBeenCalledTimes(2); // 作废后重建，非复用陈旧缓存
  });

  it('LLM 失败降级：返回空字符串', async () => {
    const failingProvider = createMockProvider([], true);
    const failingManager = createContextManager(1000, failingProvider);
    const messages = [createMessage('SYS', { role: 'system' }), createMessage('用户问题')];
    const summary = await failingManager.getOrCreateSummary(messages);
    expect(summary).toBe('');
  });

  it('无可摘要消息（仅 system）：返回空字符串', async () => {
    const messages = [createMessage('SYS', { role: 'system' })];
    const summary = await manager.getOrCreateSummary(messages);
    expect(summary).toBe('');
    // 不应调用 LLM
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('仅 tool 消息（无 user/assistant）：返回空字符串', async () => {
    // generateContextSummary 过滤 user 和 content 为 string 的 assistant
    const messages = [
      createMessage('SYS', { role: 'system' }),
      createMessage('tool result', { role: 'tool' }),
    ];
    const summary = await manager.getOrCreateSummary(messages);
    expect(summary).toBe('');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('摘要拼接多 chunk（流式累加）', async () => {
    const multiChunkProvider = createMockProvider([
      { content: '第一部分' },
      { content: '第二部分' },
      { content: '第三部分' },
    ]);
    const multiChunkManager = createContextManager(1000, multiChunkProvider);
    const messages = [createMessage('SYS', { role: 'system' }), createMessage('用户问题')];
    const summary = await multiChunkManager.getOrCreateSummary(messages);
    // 应拼接所有 chunk 的 content
    expect(summary).toContain('第一部分');
    expect(summary).toContain('第二部分');
    expect(summary).toContain('第三部分');
  });

  it('摘要内容包含 [Context summary of earlier conversation] 前缀', async () => {
    const messages = [createMessage('SYS', { role: 'system' }), createMessage('用户问题')];
    const summary = await manager.getOrCreateSummary(messages);
    expect(summary).toMatch(/^\[Context summary of earlier conversation\]\n/);
  });

  it('缓存命中返回相同摘要', async () => {
    const messages = [createMessage('SYS', { role: 'system' }), createMessage('用户问题')];
    const first = await manager.getOrCreateSummary(messages);
    const second = await manager.getOrCreateSummary(messages);
    expect(second).toBe(first);
  });

  // ─── signal 参数（中断/降级）────────────────────────────

  it('signal 已 abort 时直接返回空字符串，不调用 LLM', async () => {
    const messages = [createMessage('SYS', { role: 'system' }), createMessage('用户问题')];
    const ac = new AbortController();
    ac.abort();

    const summary = await manager.getOrCreateSummary(messages, ac.signal);
    expect(summary).toBe('');
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it('AbortError 降级为空字符串（不当作错误）', async () => {
    // provider.chat 抛 AbortError
    const abortProvider: LlmProvider = {
      name: 'mock-abort',
      chat: vi.fn().mockImplementation(() => {
        return (async function* () {
          throw new DOMException('aborted', 'AbortError');
        })();
      }),
    } as unknown as LlmProvider;
    const abortManager = createContextManager(1000, abortProvider);

    const messages = [createMessage('SYS', { role: 'system' }), createMessage('用户问题')];
    const summary = await abortManager.getOrCreateSummary(messages);
    expect(summary).toBe('');
  });

  it('signal 在流读取中 abort 时返回空字符串', async () => {
    // provider 返回多个 chunk，第二个 chunk 前 abort
    const slowProvider: LlmProvider = {
      name: 'mock-slow',
      chat: vi.fn().mockImplementation((_msgs: unknown, _opts: unknown) => {
        return (async function* () {
          yield { content: '第一部分' };
          // 模拟流读取延迟，让外部有机会 abort
          await new Promise((r) => setTimeout(r, 10));
          yield { content: '第二部分' };
        })();
      }),
    } as unknown as LlmProvider;
    const slowManager = createContextManager(1000, slowProvider);

    const messages = [createMessage('SYS', { role: 'system' }), createMessage('用户问题')];
    const ac = new AbortController();
    // 5ms 后 abort（在第一个 chunk 之后，第二个 chunk 之前）
    setTimeout(() => ac.abort(), 5);

    const summary = await slowManager.getOrCreateSummary(messages, ac.signal);
    // 被 abort 后应返回空字符串（降级为无摘要）
    expect(summary).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════
// 测试：estimateTokens() · CJK 中文适配
// ═══════════════════════════════════════════════════════════════

describe('ContextManager.estimateTokens() · CJK 中文适配', () => {
  /**
   * 辅助：构造带 tracer 注入的 ContextManager
   *
   * 测试需要注入 mock tracer 观察 span 调用，
   * 此工厂避免每个测试重复构造逻辑。
   */
  function createContextManagerWithTracer(tracer: ITracer): ContextManager {
    return new ContextManager({
      maxContextTokens: 1000,
      provider: createMockProvider(),
      contextTruncatedFn: (skipped, kept) => `[截断] 跳过 ${skipped}，保留 ${kept}`,
      tracer,
    });
  }

  it('纯 CJK 字符：按 CJK_CHARS_PER_TOKEN 估算（1.5 字符/token）', () => {
    const content = '你好世界测试'; // 6 个中文字符
    const messages = [createMessage(content)];
    // 6 / 1.5 = 4 tokens
    expect(manager.estimateTokens(messages)).toBe(Math.ceil(6 / CJK_CHARS_PER_TOKEN));
  });

  it('纯 ASCII 字符：按 CHARS_PER_TOKEN 估算（3 字符/token）', () => {
    const content = 'abcdef'; // 6 个 ASCII 字符
    const messages = [createMessage(content)];
    // 6 / 3 = 2 tokens（向后兼容）
    expect(manager.estimateTokens(messages)).toBe(Math.ceil(6 / CHARS_PER_TOKEN));
  });

  it('混合 CJK + ASCII：分别按各自密度估算后求和', () => {
    // 4 个中文 + 6 个 ASCII
    const content = '你好世界abcdef';
    const messages = [createMessage(content)];
    // 4 / 1.5 + 6 / 3 = 2.67 + 2 = 4.67 → ceil = 5
    const expected = Math.ceil(4 / CJK_CHARS_PER_TOKEN + 6 / CHARS_PER_TOKEN);
    expect(manager.estimateTokens(messages)).toBe(expected);
  });

  it('CJK 估算应充分（避免上下文溢出）', () => {
    // 6 个中文字符
    const content = '你好世界测试';
    const messages = [createMessage(content)];
    const actual = manager.estimateTokens(messages);
    // 6 / 1.5 = 4 tokens（接近真实值）
    expect(actual).toBeGreaterThan(Math.ceil(6 / CHARS_PER_TOKEN));
    expect(actual).toBe(4);
  });

  it('日文/韩文字符同样按 CJK 密度估算', () => {
    // 日文平假名 + 韩文音节
    const content = 'こんにちは안녕하세요'; // 5 日文 + 5 韩文 = 10 CJK 字符
    const messages = [createMessage(content)];
    // 10 / 1.5 = 6.67 → ceil = 7
    expect(manager.estimateTokens(messages)).toBe(Math.ceil(10 / CJK_CHARS_PER_TOKEN));
  });

  it('emoji 不算 CJK 字符（按非 CJK 密度估算）', () => {
    // emoji 🎉 是代理对，codePointAt 返回 U+1F389，不在 CJK 范围
    const content = '🎉🎉🎉'; // 3 个 emoji
    const messages = [createMessage(content)];
    // for...of 遍历代理对，3 个字符，全非 CJK
    // 3 / 3 = 1 token
    expect(manager.estimateTokens(messages)).toBe(Math.ceil(3 / CHARS_PER_TOKEN));
  });

  it('toolCalls 含 CJK 字符：JSON 序列化后同样区分 CJK/非 CJK', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'test', arguments: '{"path":"文件.txt"}' },
      },
    ];
    const messages: Message[] = [
      { role: 'assistant', content: '你好', toolCalls }, // 2 CJK + toolCalls JSON
    ];
    // 手动计算期望值
    const contentCounts = { cjk: 2, other: 0 }; // '你好' = 2 CJK
    const toolCallsJson = JSON.stringify(toolCalls);
    let toolCallsCjk = 0;
    let toolCallsOther = 0;
    for (const ch of toolCallsJson) {
      const code = ch.codePointAt(0)!;
      const isCjk =
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x3040 && code <= 0x30ff) ||
        (code >= 0xac00 && code <= 0xd7af);
      if (isCjk) toolCallsCjk++;
      else toolCallsOther++;
    }
    const expected = Math.ceil(
      (contentCounts.cjk + toolCallsCjk) / CJK_CHARS_PER_TOKEN +
        (contentCounts.other + toolCallsOther) / CHARS_PER_TOKEN,
    );
    expect(manager.estimateTokens(messages)).toBe(expected);
  });

  // ─── generateContextSummary tracer span 测试 ─────

  it('generateContextSummary 应启动 CONTEXT_SUMMARY span 并在成功时 end', async () => {
    /** 记录 span 调用的 mock tracer */
    const spanCalls: {
      name: string;
      ended: boolean;
      exceptions: Error[];
      attributes: Record<string, string | number | boolean>;
    }[] = [];
    const mockTracer: ITracer = {
      startSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan {
        const record = {
          name,
          ended: false,
          exceptions: [] as Error[],
          attributes: { ...attributes },
        };
        spanCalls.push(record);
        return {
          setAttribute(key: string, value: string | number | boolean): void {
            record.attributes[key] = value;
          },
          end(): void {
            record.ended = true;
          },
          recordException(error: Error): void {
            record.exceptions.push(error);
          },
        };
      },
    };

    const cm = createContextManagerWithTracer(mockTracer);
    // 构造超长消息触发截断 + 摘要生成（显式声明 Message[] 避免 role 推断为 string）
    const messages: Message[] = [
      { role: 'system', content: 'S'.repeat(100) },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `消息${i}`.repeat(30),
      })),
    ];

    await cm.getOrCreateSummary(messages);

    // 应启动 CONTEXT_SUMMARY span
    expect(spanCalls.length).toBeGreaterThan(0);
    const summarySpan = spanCalls.find((s) => s.name === TRACE_SPANS.CONTEXT_SUMMARY);
    expect(summarySpan).toBeDefined();
    expect(summarySpan!.ended).toBe(true);
    expect(summarySpan!.exceptions).toHaveLength(0);
    // 应记录 summaryLength 属性
    expect(summarySpan!.attributes.summaryLength).toBeDefined();
  });

  it('generateContextSummary 失败时应 recordException 并 end span', async () => {
    const spanCalls: {
      name: string;
      ended: boolean;
      exceptions: Error[];
      attributes: Record<string, string | number | boolean>;
    }[] = [];
    const mockTracer: ITracer = {
      startSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan {
        const record = {
          name,
          ended: false,
          exceptions: [] as Error[],
          attributes: { ...attributes },
        };
        spanCalls.push(record);
        return {
          setAttribute(key: string, value: string | number | boolean): void {
            record.attributes[key] = value;
          },
          end(): void {
            record.ended = true;
          },
          recordException(error: Error): void {
            record.exceptions.push(error);
          },
        };
      },
    };

    // provider 抛错的 ContextManager
    const failingProvider = createMockProvider([], true);
    const cm = new ContextManager({
      maxContextTokens: 1000,
      provider: failingProvider,
      contextTruncatedFn: (skipped, kept) => `[截断] 跳过 ${skipped}，保留 ${kept}`,
      tracer: mockTracer,
    });

    const messages: Message[] = [
      { role: 'system', content: 'S'.repeat(100) },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `消息${i}`.repeat(30),
      })),
    ];

    const summary = await cm.getOrCreateSummary(messages);

    // 失败时应返回空字符串
    expect(summary).toBe('');
    // span 应记录异常并 end
    const summarySpan = spanCalls.find((s) => s.name === TRACE_SPANS.CONTEXT_SUMMARY);
    expect(summarySpan).toBeDefined();
    expect(summarySpan!.exceptions.length).toBeGreaterThan(0);
    expect(summarySpan!.ended).toBe(true);
  });
});

// ─── 装配注入的记忆 system 消息在截断中的存留与位置（预算分层平面化量化） ───
// 来源：上下文管理体系审查缝隙。量化「装配预算分层的系统/记忆/正文/锚点，
// 在运行截断层是否被平面化」的真实严重度——结论由本测试固化，据结论立项与否。
describe('T2 实证 · 记忆 system 消息在截断中的存留（平面化量化）', () => {
  it('T2-1 窗口充足（对照基线）：记忆块与正文原样保留，截断不触发', () => {
    const wide = createContextManager(1000);
    const messages: Message[] = [
      createMessage('S'.repeat(30), { role: 'system' }),
      createMessage('U1', { roundId: 'r1' }),
      createMessage('A1', { role: 'assistant' }),
      createMessage('[MEM] 记忆一'),
      createMessage('U2', { roundId: 'r2' }),
    ];
    const result = wide.truncateMessages(messages);
    expect(result).toBe(messages); // 未超阈值 → 原引用
    expect(result.some((m) => m.content.includes('[MEM]'))).toBe(true);
  });

  it('T2-2 窗口收紧：记忆块与正文按「最晚优先」平面竞争——最近记忆存活、更早轮记忆让位（LRU 性质）', () => {
    // 40 字符 = 13~14 token；窗口 60 → available ≈ 60*0.9 − system(10) ≈ 44 → tail 只收最近两条
    const narrow = createContextManager(60);
    const messages: Message[] = [
      createMessage('S'.repeat(30), { role: 'system' }), // ~10t
      createMessage('M'.repeat(60), { roundId: 'r1' }), // 轮1 输入 ~20t
      createMessage('M'.repeat(60), { role: 'assistant' }), // 轮1 答
      createMessage('[MEM] ' + 'M'.repeat(60)), // 更早轮注入的记忆块（已随对话推进到中间）
      createMessage('N'.repeat(60), { roundId: 'r2' }), // 轮2 输入
      createMessage('M'.repeat(60), { role: 'assistant' }), // 轮2 答
      createMessage('[MEM2] ' + 'M'.repeat(60)), // 本轮新注入的记忆块（紧贴当前输入前）
      createMessage('P'.repeat(60), { roundId: 'r3' }), // 当前输入
    ];
    const result = narrow.truncateMessages(messages);
    expect(result).not.toBe(messages); // 触发截断
    const flat = result.map((m) => m.content).join('|');
    // 最近注入的记忆块存活（紧贴当前输入前，被 tail 收住）
    expect(flat).toContain('[MEM2]');
    // 更早轮注入的记忆块让位（与旧正文同级竞争，无「记忆层优先」保护）
    expect(flat).not.toContain('[MEM]');
    // 当前输入必然存活
    expect(flat).toContain('P'.repeat(60));
    // 记忆块的注入顺序（紧贴输入前）被保持
    expect(flat.indexOf('[MEM2]')).toBeLessThan(flat.indexOf('P'.repeat(60)));
  });

  it('T2-3 单块过大：记忆块整块让位（单条消息不部分保留）——窗口紧张时 LLM 拿到零记忆', () => {
    // 超大记忆块 600 字符 ≈ 200t >> available ≈ 44 → 当前输入收住后，整块被裁
    const narrow = createContextManager(60);
    const messages: Message[] = [
      createMessage('S'.repeat(30), { role: 'system' }),
      createMessage('M'.repeat(60), { roundId: 'r1' }),
      createMessage('M'.repeat(60), { role: 'assistant' }),
      createMessage('[BIG] ' + 'M'.repeat(600)), // 超大记忆块
      createMessage('P'.repeat(60), { roundId: 'r2' }), // 当前输入
    ];
    const result = narrow.truncateMessages(messages);
    const flat = result.map((m) => m.content).join('|');
    // 超大记忆块整块让位（无部分保留）
    expect(flat).not.toContain('[BIG]');
    // 当前输入 + 截断占位仍在（兜底不破坏正常运行）
    expect(flat).toContain('P'.repeat(60));
    expect(flat).toContain('截断');
  });
});

// ─── 上下文压力预警判定（软上限的前一级） ───
describe('ContextManager.shouldInjectContextPressureHint（T3 预算预警前一级）', () => {
  it('容量未到警戒线：false', () => {
    const m = createContextManager(1000);
    const messages = [createMessage('S'.repeat(30), { role: 'system' }), createMessage('短消息')];
    expect(m.shouldInjectContextPressureHint(messages)).toBe(false);
  });

  it('容量到线（≥90%）但摘要层未饱和：true（软上限前一级预警）', () => {
    const small = createContextManager(100);
    // 330 latin 字符 ≈ 110t + system 10t → 总 120 ≥ 90 警戒线；无摘要标记 → 摘要层 0 < 30%
    const messages = [
      createMessage('S'.repeat(30), { role: 'system' }),
      createMessage('M'.repeat(330)),
    ];
    expect(small.shouldInjectContextPressureHint(messages)).toBe(true);
    // 互补：软上限此刻不触发（摘要层未饱和）
    expect(small.shouldInjectSoftLimitWrapup(messages)).toBe(false);
  });

  it('容量到线且摘要层饱和：false（归软上限收尾，不重复预警）', () => {
    const small = createContextManager(100);
    // 摘要标记消息（Round summary marker）≈ 100t → 摘要层 ≥ 30% → 收尾路径
    const messages = [
      createMessage('S'.repeat(30), { role: 'system' }),
      createMessage('[Round summary · roundId: r1] ' + 'M'.repeat(300)),
    ];
    expect(small.shouldInjectContextPressureHint(messages)).toBe(false);
    expect(small.shouldInjectSoftLimitWrapup(messages)).toBe(true);
  });
});
