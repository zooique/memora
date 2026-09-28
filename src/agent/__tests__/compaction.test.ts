/**
 * 上下文压缩策略单元测试
 *
 * 覆盖：
 * - ResultReplacementStrategy: 结果替换（同步）
 * - ReplaceRoundsStrategy: 轮次替换（第一级 LRU）
 *
 * 注：`OffloadCompactionStrategy` 已**整级删除** —— 超大工具结果改为在
 * **入口关**（`AgentLoop.appendToolMessage`）落盘，不再作为压缩链一级。原语与不变量见
 * `src/agent/toolResultOffload.ts` 及其单测；读码论证见 `docs/大文本统一通道-探索方案.md` §6.2。
 */

import { describe, it, expect, vi } from 'vitest';
import type { Message } from '@/llm/provider.js';
import {
  ResultReplacementStrategy,
  ReplaceRoundsStrategy,
  DEFAULT_REPLACE_KEEP_RECENT_ROUNDS,
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
      const originalContents = messages.filter((m) => m.role === 'tool').map((m) => m.content);

      strategy.compact(messages);

      const newContents = messages.filter((m) => m.role === 'tool').map((m) => m.content);
      expect(newContents).toEqual(originalContents);
    });

    it('P1 摘要替代：read_file 有台账摘要 → 替换为摘要（非空占位）', () => {
      const readFileReplacement = vi.fn((path: string) =>
        path === 'docs/a.md' ? '[ALREADY_READ] 摘要…' : undefined,
      );
      const strategy = new ResultReplacementStrategy(1, readFileReplacement);
      // read_file 的 fixture（假路径）+ 结果，另加一个非 read_file 工具，keepRecent=1 → 最早的 read_file 被替换
      const messages: Message[] = [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
        {
          role: 'assistant',
          content: 'a',
          toolCalls: [
            {
              id: 'c1',
              type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"docs/a.md"}' },
            },
          ],
        },
        { role: 'tool', content: 'A正文', toolCallId: 'c1' },
        {
          role: 'assistant',
          content: 'b',
          toolCalls: [
            {
              id: 'c2',
              type: 'function' as const,
              function: { name: 'write_file', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', content: 'B正文', toolCallId: 'c2' },
      ];
      strategy.compact(messages);
      const c1 = messages.find((m) => m.toolCallId === 'c1')!;
      const c2 = messages.find((m) => m.toolCallId === 'c2')!;
      // read_file 被替换为台账摘要，非空占位
      expect(c1.content).toBe('[ALREADY_READ] 摘要…');
      expect(readFileReplacement).toHaveBeenCalledWith('docs/a.md');
      // 最近 1 个（write_file）保留；若日志里它也被替换成 [Previous: used write_file] 说明 keepRecent 语义未破
      expect(c2.content).toBe('B正文');
    });

    it('P1 摘要替代：read_file 无台账摘要（回调返回 undefined）→ 回退空占位', () => {
      const strategy = new ResultReplacementStrategy(1, () => undefined);
      const messages: Message[] = [
        { role: 'system', content: 'S' },
        { role: 'user', content: 'U' },
        {
          role: 'assistant',
          content: 'a',
          toolCalls: [
            {
              id: 'c1',
              type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"docs/x.md"}' },
            },
          ],
        },
        { role: 'tool', content: 'X正文', toolCallId: 'c1' },
        {
          role: 'assistant',
          content: 'b',
          toolCalls: [
            {
              id: 'c2',
              type: 'function' as const,
              function: { name: 'read_file', arguments: '{"path":"docs/y.md"}' },
            },
          ],
        },
        { role: 'tool', content: 'Y正文', toolCallId: 'c2' },
      ];
      strategy.compact(messages);
      expect(messages.find((m) => m.toolCallId === 'c1')!.content).toBe(
        '[Previous: used read_file]',
      );
    });
  });
});

// 注：token 估算统一走 `contextManager.estimateTokensText`（CJK 感知），其正确性由 contextManager.test.ts 守。

describe('ReplaceRoundsStrategy（第一级 · 内核自动 LRU）', () => {
  /** 构造 N 轮问答消息（system + 每轮 user/assistant），每轮 user/assistant 自带 roundId */
  function createRoundMessages(roundCount: number): Message[] {
    const messages: Message[] = [{ role: 'system', content: 'System prompt' }];
    for (let i = 1; i <= roundCount; i++) {
      const rid = `round-${i}`;
      messages.push({ role: 'user', content: `提问${i}`, roundId: rid });
      messages.push({ role: 'assistant', content: `回答${i}`, roundId: rid });
    }
    return messages;
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
    });
    expect(strategy.shouldCompact(createRoundMessages(3))).toBe(true);
  });

  it('shouldCompact：轮次未超出保留数 → false', () => {
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 5,
      getSummary: () => null,
    });
    expect(strategy.shouldCompact(createRoundMessages(3))).toBe(false);
  });

  it('compact：LRU 最早先换，越界轮替换成其已存摘要，保留最近轮正文', () => {
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 2,
      getSummary: (rid) => summaryMap.get(rid) ?? null,
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
    });
    const messages = createRoundMessages(3);
    strategy.compact(messages);

    const contents = messages.map((m) => m.content).join('\n');
    expect(contents).toContain('Round summary · roundId: round-1');
    // round-2 无摘要 → 正文保留
    expect(contents).toContain('提问2');
    expect(contents).toContain('回答2');
  });

  it('compact：roundId 取自消息自身（不依赖任何外部序列），正确映射各轮摘要', () => {
    // 非顺序 roundId，验证替换按每轮 user 消息自带 roundId 取摘要，而非任何外部序列的尾部对齐
    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: '提问A', roundId: 'alpha' },
      { role: 'assistant', content: '回答A', roundId: 'alpha' },
      { role: 'user', content: '提问B', roundId: 'beta' },
      { role: 'assistant', content: '回答B', roundId: 'beta' },
      { role: 'user', content: '提问C', roundId: 'gamma' },
      { role: 'assistant', content: '回答C', roundId: 'gamma' },
    ];
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 1,
      getSummary: (rid) => (rid === 'alpha' ? '摘要A' : null),
    });
    strategy.compact(messages);

    const contents = messages.map((m) => m.content).join('\n');
    // 最旧轮 alpha 有摘要 → 按消息自带 roundId 取「摘要A」替换（非错位取 beta/gamma 的摘要）
    expect(contents).toContain('Round summary · roundId: alpha');
    expect(contents).toContain('摘要A');
    // 最近轮 beta/gamma 正文保留
    expect(contents).toContain('提问B');
    expect(contents).toContain('提问C');
  });

  it('compact：轮次未越界时不修改', () => {
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 5,
      getSummary: (rid) => summaryMap.get(rid) ?? null,
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
      onReplaced: (roundId) => {
        replacedIds.push(roundId);
      },
    });
    const messages = createRoundMessages(4);
    strategy.compact(messages);

    // 越界 2 轮（round-1、round-2）有摘要 → 均上报其消息自带 roundId
    expect(replacedIds).toContain('round-1');
    expect(replacedIds).toContain('round-2');
  });

  it('上下文被截断重排（isContextTruncated=true）→ 替换层跳过（shouldCompact=false、compact no-op）', () => {
    const onReplaced = vi.fn();
    const strategy = new ReplaceRoundsStrategy({
      keepRecentRounds: 1,
      getSummary: (rid) => summaryMap.get(rid) ?? null,
      onReplaced,
      isContextTruncated: () => true,
    });
    const messages = createRoundMessages(4);
    // 截断重排后视图不稳定 → 跳过替换，避免错位替换正文
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
      isContextTruncated: () => false,
    });
    const messages = createRoundMessages(4);
    expect(strategy.shouldCompact(messages)).toBe(true);
    strategy.compact(messages);
    expect(messages.some((m) => m.content.includes('Round summary · roundId: round-1'))).toBe(true);
  });
});
