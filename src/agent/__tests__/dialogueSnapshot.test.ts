/**
 * DialogueSnapshotExtractor 单元测试
 *
 * 测试范围：
 *   - 3-5 句种子提取
 *   - 空消息 / 无用户发言降级
 *   - LLM 失败降级为空数组
 *   - 长度超限截断
 *   - 最短句过滤（≥ 5 字符）
 */
import { describe, it, expect, vi } from 'vitest';
import { DialogueSnapshotExtractor } from '../dialogueSnapshot.js';
import type { LlmProvider, Message } from '@/llm/provider.js';
import type { TopicMessage } from '@/memory/types.js';

/**
 * 创建 Mock LLM Provider
 *
 * @param response 预设的 LLM 返回文本
 */
const createMockProvider = (response: string): LlmProvider =>
  ({
    name: 'mock',
    chat: vi.fn(async function* (_messages: Message[]) {
      yield { content: response, done: false };
      yield { content: '', done: true };
    }),
  }) as unknown as LlmProvider;

/**
 * 创建测试用话题消息
 */
const createMessages = (userTexts: string[]): TopicMessage[] =>
  userTexts.map((content, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content,
    timestamp: new Date().toISOString(),
  }));

describe('DialogueSnapshotExtractor', () => {
  describe('extract', () => {
    it('应该提取 3-5 句种子', async () => {
      // Given
      const mockResponse = `萧然这个角色，我想让他从一个普通人成长为守护者
我希望他的成长不是靠奇遇，而是靠选择
他在第三章会面临一个关键抉择：救人还是复仇`;

      const provider = createMockProvider(mockResponse);
      const extractor = new DialogueSnapshotExtractor(provider);
      const messages = createMessages([
        '萧然这个角色，我想让他从一个普通人成长为守护者',
        '好的，我理解了你的设计意图。',
        '我希望他的成长不是靠奇遇，而是靠选择',
        '这是一个很好的角色弧线设计。',
        '他在第三章会面临一个关键抉择：救人还是复仇',
      ]);

      // When
      const snapshots = await extractor.extract(messages);

      // Then
      expect(snapshots.length).toBeGreaterThanOrEqual(3);
      expect(snapshots.length).toBeLessThanOrEqual(5);
    });

    it('应该在空消息时返回空数组', async () => {
      // Given
      const provider = createMockProvider('');
      const extractor = new DialogueSnapshotExtractor(provider);

      // When
      const snapshots = await extractor.extract([]);

      // Then
      expect(snapshots).toHaveLength(0);
    });

    it('应该在无用户发言时返回空数组', async () => {
      // Given
      const provider = createMockProvider('');
      const extractor = new DialogueSnapshotExtractor(provider);
      const messages: TopicMessage[] = [
        { role: 'assistant', content: '你好', timestamp: new Date().toISOString() },
      ];

      // When
      const snapshots = await extractor.extract(messages);

      // Then
      expect(snapshots).toHaveLength(0);
    });

    it('应该在 LLM 失败时降级为空数组', async () => {
      // Given
      const provider = {
        name: 'mock-error',
        chat: vi.fn(async function* () {
          throw new Error('LLM 调用失败');
        }),
      } as unknown as LlmProvider;
      const extractor = new DialogueSnapshotExtractor(provider);
      const messages = createMessages(['用户说了一些话']);

      // When
      const snapshots = await extractor.extract(messages);

      // Then
      expect(snapshots).toHaveLength(0);
    });

    it('应该过滤掉太短的句子（< 5 字符）', async () => {
      // Given
      const mockResponse = `萧然这个角色，我想让他从一个普通人成长为守护者
好
他在第三章会面临一个关键抉择：救人还是复仇
嗯
希望他的成长靠选择而非奇遇`;

      const provider = createMockProvider(mockResponse);
      const extractor = new DialogueSnapshotExtractor(provider);
      const messages = createMessages(['测试消息']);

      // When
      const snapshots = await extractor.extract(messages);

      // Then
      for (const s of snapshots) {
        expect(s.length).toBeGreaterThanOrEqual(5);
      }
    });

    it('应该限制最多 5 句', async () => {
      // Given
      const mockResponse = `第一句话：萧然是主角
第二句话：他的成长靠选择
第三句话：第三章有关键抉择
第四句话：救人还是复仇
第五句话：希望他成为守护者
第六句话：这是额外的一句
第七句话：这也应该被截断`;

      const provider = createMockProvider(mockResponse);
      const extractor = new DialogueSnapshotExtractor(provider);
      const messages = createMessages(['测试消息']);

      // When
      const snapshots = await extractor.extract(messages);

      // Then
      expect(snapshots.length).toBeLessThanOrEqual(5);
    });
  });
});
