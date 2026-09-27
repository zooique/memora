/**
 * TextPolishManager 单元测试
 *
 * 测试范围：
 *   - polish 成功返回润色后文本（流式 chunk 累积）
 *   - LLM 返回与原文本相同 → changed: false
 *   - LLM 返回空字符串 → changed: false（防御逻辑）
 *   - 输入超长截断（> 2000 字符）
 *   - LLM 调用失败 → 抛出异常
 *   - AbortSignal 透传到 provider.chat
 *
 * 参照模板：workProjection.test.ts（同属 LLM 流式累积模式）
 */
import { describe, it, expect, vi } from 'vitest';
import { TextPolishManager } from '@/agent/managers/textPolishManager.js';
import type { LlmProvider, Message } from '@/llm/provider.js';

/**
 * 创建 Mock LLM Provider
 *
 * @param chunks 预设的流式 chunk 内容数组（逐个 yield，验证累积逻辑）
 */
const createMockProvider = (chunks: string[]): LlmProvider =>
  ({
    name: 'mock',
    chat: vi.fn(async function* (_messages: Message[]) {
      for (const chunk of chunks) {
        yield { content: chunk, done: false };
      }
      yield { content: '', done: true };
    }),
  }) as unknown as LlmProvider;

/**
 * 创建可捕获 messages 参数的 Mock LLM Provider
 *
 * @param chunks 预设的流式 chunk 内容数组
 * @param capturedMessages 捕获 chat 调用时的 messages 参数
 */
const createCapturingProvider = (
  chunks: string[],
  capturedMessages: { messages?: Message[] },
): LlmProvider =>
  ({
    name: 'mock',
    chat: vi.fn(async function* (messages: Message[]) {
      capturedMessages.messages = messages;
      for (const chunk of chunks) {
        yield { content: chunk, done: false };
      }
      yield { content: '', done: true };
    }),
  }) as unknown as LlmProvider;

describe('TextPolishManager', () => {
  describe('polish · 成功润色', () => {
    it('应累积流式 chunk 并返回润色后文本（changed: true）', async () => {
      // Given：LLM 分 3 个 chunk 返回润色后文本（验证累积逻辑）
      const provider = createMockProvider(['润色', '后的', '文本']);
      const manager = new TextPolishManager(provider);

      // When
      const result = await manager.polish('原始文本');

      // Then
      expect(result.polished).toBe('润色后的文本');
      expect(result.changed).toBe(true);
    });

    it('LLM 返回与原文本相同时应标记 changed: false', async () => {
      // Given：LLM 返回与输入完全相同
      const provider = createMockProvider(['原始文本']);
      const manager = new TextPolishManager(provider);

      // When
      const result = await manager.polish('原始文本');

      // Then
      expect(result.polished).toBe('原始文本');
      expect(result.changed).toBe(false);
    });

    it('LLM 返回空字符串时应标记 changed: false 并返回原文本', async () => {
      // Given：LLM 返回空 chunk（trim 后为空字符串）
      const provider = createMockProvider(['   ', '']);
      const manager = new TextPolishManager(provider);

      // When
      const result = await manager.polish('原始文本');

      // Then：changed 判定包含 polished.length > 0 防御（见 TextPolishManager.polish 内 changed 判定）
      expect(result.polished).toBe('原始文本');
      expect(result.changed).toBe(false);
    });
  });

  describe('polish · 输入截断', () => {
    it('输入超过 2000 字符时应截断到 POLISH_INPUT_LIMIT', async () => {
      // Given：构造 2500 字符的超长输入
      const longText = 'a'.repeat(2500);
      const captured: { messages?: Message[] } = {};
      const provider = createCapturingProvider(['润色结果'], captured);
      const manager = new TextPolishManager(provider);

      // When
      await manager.polish(longText);

      // Then：传给 LLM 的 user 消息内容应被截断到 2000 字符
      expect(captured.messages).toBeDefined();
      expect(captured.messages!.length).toBe(2);
      expect(captured.messages![1]!.content.length).toBe(2000);
    });
  });

  describe('polish · 异常处理', () => {
    it('LLM 调用失败时应抛出异常', async () => {
      // Given：LLM 抛出异常
      const provider = {
        name: 'mock',
        chat: vi.fn(async function* () {
          throw new Error('LLM 服务不可用');
        }),
      } as unknown as LlmProvider;
      const manager = new TextPolishManager(provider);

      // When / Then：异常应向上传播（TextPolishManager.polish 的 catch 仅 log 不吞异常）
      await expect(manager.polish('原始文本')).rejects.toThrow('LLM 服务不可用');
    });
  });

  describe('polish · AbortSignal 透传', () => {
    it('应将 AbortSignal 透传到 provider.chat 调用', async () => {
      // Given：捕获 provider.chat 的调用参数
      const capturedOpts: { signal?: AbortSignal } = {};
      const provider = {
        name: 'mock',
        chat: vi.fn(async function* (_messages: Message[], opts?: { signal?: AbortSignal }) {
          if (opts) {
            capturedOpts.signal = opts.signal;
          }
          yield { content: '润色结果', done: false };
          yield { content: '', done: true };
        }),
      } as unknown as LlmProvider;
      const manager = new TextPolishManager(provider);
      const controller = new AbortController();

      // When
      await manager.polish('原始文本', controller.signal);

      // Then：signal 应被透传
      expect(capturedOpts.signal).toBe(controller.signal);
    });
  });
});
