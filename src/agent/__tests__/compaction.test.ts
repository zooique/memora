/**
 * 上下文压缩策略单元测试
 *
 * 覆盖：
 * - ResultReplacementStrategy: 结果替换（同步）
 * - OffloadCompactionStrategy: 卸载式压缩（异步）
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@/llm/provider.js';
import {
  ResultReplacementStrategy,
  OffloadCompactionStrategy,
  ReplaceRoundsStrategy,
  DEFAULT_REPLACE_KEEP_RECENT_ROUNDS,
  estimateTokens,
} from '@/agent/compaction.js';

describe('ResultReplacementStrategy', () => {
  /** 生成测试消息数组 */
  function createMessages(toolResultCount: number): Message[] {
    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User question' },
    ];

    // 添加 N 个 assistant 消息和对应的 tool 消息
    for (let i = 0; i < toolResultCount; i++) {
      const toolCallId = `call_${i}`;
      messages.push({
        role: 'assistant',
        content: 'Assistant thinking...',
        toolCalls: [
          {
            id: toolCallId,
            type: 'function' as const,
            function: { name: `test_tool_${i}`, arguments: '{}' },
          },
        ],
      });
      messages.push({
        role: 'tool',
        content: `Result ${i} with some content...`,
        toolCallId,
      });
    }

    return messages;
  }

  describe('shouldCompact', () => {
    it('当工具结果数量 <= keepRecent 时返回 false', () => {
      const strategy = new ResultReplacementStrategy(3);
      const messages = createMessages(3);
      expect(strategy.shouldCompact(messages)).toBe(false);
    });

    it('当工具结果数量 > keepRecent 时返回 true', () => {
      const strategy = new ResultReplacementStrategy(3);
      const messages = createMessages(5);
      expect(strategy.shouldCompact(messages)).toBe(true);
    });

    it('当没有工具结果时返回 false', () => {
      const strategy = new ResultReplacementStrategy(3);
      const messages = createMessages(0);
      expect(strategy.shouldCompact(messages)).toBe(false);
    });
  });

  describe('compact', () => {
    it('将旧结果替换为占位符，保留最近的结果', () => {
      const strategy = new ResultReplacementStrategy(2);
      const messages = createMessages(5);

      strategy.compact(messages);

      // 检查前 3 个 tool 消息被替换
      const toolMessages = messages.filter((m) => m.role === 'tool');
      expect(toolMessages[0]!.content).toBe('[Previous: used test_tool_0]');
      expect(toolMessages[1]!.content).toBe('[Previous: used test_tool_1]');
      expect(toolMessages[2]!.content).toBe('[Previous: used test_tool_2]');

      // 检查后 2 个 tool 消息保留完整内容
      expect(toolMessages[3]!.content).toBe('Result 3 with some content...');
      expect(toolMessages[4]!.content).toBe('Result 4 with some content...');
    });

    it('保留工具名称的语义信息', () => {
      const strategy = new ResultReplacementStrategy(1);
      const messages = createMessages(3);

      strategy.compact(messages);

      const toolMessages = messages.filter((m) => m.role === 'tool');
      // 检查占位符包含工具名
      expect(toolMessages[0]!.content).toContain('test_tool_0');
      expect(toolMessages[1]!.content).toContain('test_tool_1');
    });

    it('当没有需要压缩的结果时不修改', () => {
      const strategy = new ResultReplacementStrategy(5);
      const messages = createMessages(3);
      const originalContents = messages.filter(m => m.role === 'tool').map(m => m.content);

      strategy.compact(messages);

      const newContents = messages.filter(m => m.role === 'tool').map(m => m.content);
      expect(newContents).toEqual(originalContents);
    });
  });
});

describe('OffloadCompactionStrategy', () => {
  /** 生成超大工具结果消息 */
  function createLargeToolMessages(size: number = 100_000): Message[] {
    const largeContent = 'x'.repeat(size); // 创建超大字符串
    return [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'User question' },
      {
        role: 'assistant',
        content: 'Assistant thinking...',
        toolCalls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'large_tool', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: largeContent, toolCallId: 'call_1' },
    ];
  }

  describe('shouldCompact', () => {
    it('当存在超大工具结果时返回 true', () => {
      const strategy = new OffloadCompactionStrategy(undefined, 1000);
      const messages = createLargeToolMessages(5000);
      expect(strategy.shouldCompact(messages)).toBe(true);
    });

    it('当所有工具结果都小于阈值时返回 false', () => {
      const strategy = new OffloadCompactionStrategy(undefined, 20_000);
      const messages = createLargeToolMessages(1000); // 4000 tokens，小于阈值
      expect(strategy.shouldCompact(messages)).toBe(false);
    });
  });

  describe('compact', () => {
    it('将超大结果写入文件系统并替换为占位符', async () => {
      const strategy = new OffloadCompactionStrategy(undefined, 1000);
      const messages = createLargeToolMessages(5000);

      await strategy.compact(messages);

      const toolMsg = messages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      if (toolMsg) {
        // 检查内容被替换（不再是原始超长内容）
        expect(toolMsg.content.length).toBeLessThan(10_000);
        // 检查包含卸载路径信息
        expect(toolMsg.content).toContain('输出已卸载至');
        // 检查包含预览
        expect(toolMsg.content).toContain('预览');
      }
    });

    it('降级处理：当 mkdir 失败时截断而非报错', async () => {
      // 使用注入的 mock 模拟 mkdir 失败
      const mockFsOps = {
        mkdir: vi.fn().mockRejectedValue(new Error('Permission denied')),
        writeFile: vi.fn(), // 不应被调用
      };
      
      const strategy = new OffloadCompactionStrategy(undefined, 1000, 1000, mockFsOps);
      const messages = createLargeToolMessages(5000);

      // 不应抛出异常
      await expect(strategy.compact(messages)).resolves.not.toThrow();

      const toolMsg = messages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      if (toolMsg) {
        // 检查降级为截断（不是卸载）
        expect(toolMsg.content).toContain('输出过大，已截断');
        expect(toolMsg.content.length).toBeLessThan(5000);
      }
      
      // 验证 mkdir 被调用，writeFile 未被调用
      expect(mockFsOps.mkdir).toHaveBeenCalledOnce();
      expect(mockFsOps.writeFile).not.toHaveBeenCalled();
    });

    it('降级处理：当 writeFile 部分失败时，失败项截断成功项卸载', async () => {
      // 模拟 mkdir 成功，但第一个文件写入失败
      const mockFsOps = {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn()
          .mockResolvedValueOnce(undefined) // 第一个成功
          .mockRejectedValueOnce(new Error('Disk full')), // 第二个失败
      };
      
      // 创建两个大结果
      const messages = [
        ...createLargeToolMessages(5000),
        {
          role: 'tool' as const,
          content: 'y'.repeat(6000), // 另一个大内容
          toolCallId: 'call_2',
        },
      ];
      
      const strategy = new OffloadCompactionStrategy(undefined, 1000, 1000, mockFsOps);

      await strategy.compact(messages);

      const toolMessages = messages.filter((m) => m.role === 'tool');
      
      // 第一个消息应该被卸载（成功）
      expect(toolMessages[0]!.content).toContain('输出已卸载至');
      
      // 第二个消息应该被截断（失败）
      expect(toolMessages[1]!.content).toContain('输出过大，已截断');
      expect(toolMessages[1]!.content).not.toContain('输出已卸载至');
    });

    it('保留原始内容的前 N 字符作为预览', async () => {
      const strategy = new OffloadCompactionStrategy(undefined, 1000, 500);
      const messages = createLargeToolMessages(10_000);

      await strategy.compact(messages);

      const toolMsg = messages.find((m) => m.role === 'tool');
      if (toolMsg) {
        // 检查预览包含原始内容的前 500 字符
        expect(toolMsg.content).toContain('x'.repeat(500));
      }
    });
  });
});

describe('estimateTokens', () => {
  it('准确估算中文 Token 数', () => {
    // 中文字符约 1.5-2 token，4 字符/token 保守估算
    const text = '你好世界'; // 4 个汉字 ≈ 6-8 tokens
    expect(estimateTokens(text)).toBe(1); // ceil(4/4) = 1
  });

  it('准确估算英文 Token 数', () => {
    const text = 'Hello World'; // 11 字符 ≈ 2-3 tokens
    expect(estimateTokens(text)).toBe(3); // ceil(11/4) = 3
  });

  it('对空字符串返回 0', () => {
    expect(estimateTokens('')).toBe(0);
  });
});

describe('ReplaceRoundsStrategy（第一级 · 内核自动 LRU）', () => {
  /** 构造 N 轮问答消息（system + 每轮 user/assistant） */
  function createRoundMessages(roundCount: number): Message[] {
    const messages: Message[] = [{ role: 'system', content: 'System prompt' }];
    for (let i = 1; i <= roundCount; i++) {
      messages.push({ role: 'user', content: `提问${i}` });
      messages.push({ role: 'assistant', content: `回答${i}` });
    }
    return messages;
  }

  /** 构造与轮次对齐的 roundId 序列 */
  function makeSeq(roundCount: number): string[] {
    return Array.from({ length: roundCount }, (_, i) => `round-${i + 1}`);
  }

  /** 构造摘要映射：round-1/round-2 有摘要，其余无 */
  const summaryMap = new Map<string, string>([
    ['round-1', '摘要：第一轮内容'],
    ['round-2', '摘要：第二轮内容'],
  ]);

  it('shouldCompact：轮次超出保留数 → true', () => {
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 2,
      getSummary: () => null,
      roundIds: () => makeSeq(3),
    });
    expect(strategy.shouldCompact(createRoundMessages(3))).toBe(true);
  });

  it('shouldCompact：轮次未超出保留数 → false', () => {
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 5,
      getSummary: () => null,
      roundIds: () => makeSeq(3),
    });
    expect(strategy.shouldCompact(createRoundMessages(3))).toBe(false);
  });

  it('compact：LRU 最早先换，越界轮替换成其已存摘要，保留最近轮正文', () => {
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 2,
      getSummary: (rid) => summaryMap.get(rid) ?? null,
      roundIds: () => makeSeq(4),
    });
    const messages = createRoundMessages(4);
    strategy.compact(messages);

    // 越界 2 轮（round-1、round-2）有摘要 → 替换成摘要 system 消息
    const contents = messages.map((m) => m.content).join('\n');
    expect(contents).toContain('Round summary · roundId: round-1');
    expect(contents).toContain('摘要：第一轮内容');
    expect(contents).toContain('Round summary · roundId: round-2');
    // 最近 2 轮正文保留
    expect(contents).toContain('提问3');
    expect(contents).toContain('回答4');
  });

  it('compact：无已存摘要的越界轮不替换（交第二级压缩）', () => {
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 1,
      // 只有 round-1 有摘要，round-2 无
      getSummary: (rid) => (rid === 'round-1' ? '摘要一' : null),
      roundIds: () => makeSeq(3),
    });
    const messages = createRoundMessages(3);
    strategy.compact(messages);

    const contents = messages.map((m) => m.content).join('\n');
    expect(contents).toContain('Round summary · roundId: round-1');
    // round-2 无摘要 → 正文保留
    expect(contents).toContain('提问2');
    expect(contents).toContain('回答2');
  });

  it('compact：序列尾部对齐（截断丢旧轮后，最近轮仍映射正确）', () => {
    // 消息只剩 2 轮（对应 round-2、round-3），但序列保留 3 个 id（round-1 已被截断）
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 1,
      getSummary: (rid) => (rid === 'round-2' ? '摘要二' : null),
      roundIds: () => makeSeq(3),
    });
    const messages = createRoundMessages(2);
    strategy.compact(messages);

    // 越界轮（消息第 0 轮）映射到序列尾部对齐 → round-2（有摘要）被替换；
    // 最近轮（消息第 1 轮 → round-3）正文保留
    const contents = messages.map((m) => m.content).join('\n');
    expect(contents).toContain('Round summary · roundId: round-2');
    expect(contents).toContain('提问2');
  });

  it('compact：轮次未越界时不修改', () => {
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 5,
      getSummary: (rid) => summaryMap.get(rid) ?? null,
      roundIds: () => makeSeq(3),
    });
    const messages = createRoundMessages(3);
    const before = messages.map((m) => m.content).join('|');
    strategy.compact(messages);
    const after = messages.map((m) => m.content).join('|');
    expect(after).toBe(before);
  });

  it('DEFAULT_REPLACE_KEEP_RECENT_ROUNDS 默认保留 5 轮', () => {
    expect(DEFAULT_REPLACE_KEEP_RECENT_ROUNDS).toBe(5);
  });

  it('互斥记账：被替换轮的 roundId 经 onReplaced 上报（装配 exclude 防二次召回）', () => {
    const replacedIds: string[] = [];
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 2,
      getSummary: (rid) => summaryMap.get(rid) ?? null,
      roundIds: () => makeSeq(4),
      onReplaced: (roundId) => {
        replacedIds.push(roundId);
      },
    });
    const messages = createRoundMessages(4);
    strategy.compact(messages);

    // 越界 2 轮（round-1、round-2）有摘要 → 均上报 roundId
    expect(replacedIds).toContain('round-1');
    expect(replacedIds).toContain('round-2');
  });

  it('上下文被截断重排（isContextTruncated=true）→ 替换层跳过（shouldCompact=false、compact no-op）', () => {
    const onReplaced = vi.fn();
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 1,
      getSummary: (rid) => summaryMap.get(rid) ?? null,
      roundIds: () => makeSeq(4),
      onReplaced,
      isContextTruncated: () => true,
    });
    const messages = createRoundMessages(4);
    // 截断重排后 roundId 尾部对齐映射失效 → 跳过替换，避免错位替换正文
    expect(strategy.shouldCompact(messages)).toBe(false);
    strategy.compact(messages);
    expect(onReplaced).not.toHaveBeenCalled();
    // 正文保持原样
    expect(messages.some((m) => m.content.includes('Round summary'))).toBe(false);
  });

  it('上下文未被截断 → 替换正常生效（isContextTruncated=false）', () => {
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 1,
      getSummary: (rid) => summaryMap.get(rid) ?? null,
      roundIds: () => makeSeq(4),
      isContextTruncated: () => false,
    });
    const messages = createRoundMessages(4);
    expect(strategy.shouldCompact(messages)).toBe(true);
    strategy.compact(messages);
    expect(messages.some((m) => m.content.includes('Round summary · roundId: round-1'))).toBe(true);
  });
});
