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
