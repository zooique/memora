/**
 * 消息历史单元测试（M-203-改：事件驱动归档 + 记忆归档原则 v0.2）
 *
 * 覆盖：
 *   - switchTopic 调用 summarizer（fire-and-forget）
 *   - 消息数 < 2 时跳过总结
 *   - 未注入 summarizer 时跳过
 *   - 已有摘要时幂等跳过
 *   - summarizer 返回 null（低价值对话）→ 跳过归档
 *   - summarizer 抛出时优雅降级
 *   - appendSummary 幂等（topic-store 层）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MessageHistory } from '../message-history.js';
import { TopicStore } from '../../memory/topic-store.js';
import type { TopicMessage } from '../../memory/types.js';

describe('M-203-改 · 事件驱动归档', () => {
  let tmpDir: string;
  let topicStore: TopicStore;
  const initialDate = '2026-06-02';
  const initialTopic = 'test-topic';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-history-test-'));
    mkdirSync(join(tmpDir, 'topics'), { recursive: true });
    topicStore = new TopicStore(tmpDir);
  });

  // 清理每个测试的临时文件
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * 辅助：创建一条 topic 消息
   */
  function makeMessage(role: TopicMessage['role'], content: string): TopicMessage {
    return {
      role,
      content,
      timestamp: '2026-06-02T12:00:00.000Z',
    };
  }

  describe('MessageHistory · summarizeAndArchive', () => {
    it('switchTopic 应触发 summarizer', async () => {
      // 先写一条消息到话题文件（让后续 summarize 时有内容）
      const history = new MessageHistory(topicStore, undefined, initialDate, initialTopic);
      await history.appendUser('帮我写一个递归函数');
      await history.appendAssistant('好的，这是斐波那契...');
      // 等待追加完成
      await new Promise((r) => setTimeout(r, 50));

      // 用新实例 + mock summarizer
      const mockSummarizer = vi.fn().mockResolvedValue('用户请求了递归函数实现');
      const history2 = new MessageHistory(topicStore, mockSummarizer, initialDate, initialTopic);
      history2.switchTopic('new-topic');

      // fire-and-forget 需要等一下
      await new Promise((r) => setTimeout(r, 100));

      expect(mockSummarizer).toHaveBeenCalledTimes(1);
      const firstCall = mockSummarizer.mock.calls[0];
      expect(firstCall).toBeDefined();
      const calledMessages = firstCall![0] as TopicMessage[];
      expect(calledMessages.length).toBe(2);
      expect(calledMessages[0]!.role).toBe('user');
      expect(calledMessages[1]!.role).toBe('assistant');
    });

    it('未注入 summarizer 时应跳过（不抛错）', () => {
      const history = new MessageHistory(topicStore, undefined, initialDate, initialTopic);
      // 不应该抛错
      expect(() => history.switchTopic('new-topic')).not.toThrow();
    });

    it('话题文件不存在时应跳过', async () => {
      const mockSummarizer = vi.fn().mockResolvedValue('不会调用');
      // 没有先用 appendUser() 写话题文件 → topicStore.read() 返回 null
      const history = new MessageHistory(
        topicStore,
        mockSummarizer,
        initialDate,
        'non-existent-topic',
      );
      history.switchTopic('new-topic');
      await new Promise((r) => setTimeout(r, 100));
      expect(mockSummarizer).not.toHaveBeenCalled();
    });

    it('消息数 < 2 时应跳过', async () => {
      const history = new MessageHistory(topicStore, undefined, initialDate, initialTopic);
      await history.appendUser('hello');
      await new Promise((r) => setTimeout(r, 50));

      const mockSummarizer = vi.fn().mockResolvedValue('不会调用');
      const history2 = new MessageHistory(topicStore, mockSummarizer, initialDate, initialTopic);
      history2.switchTopic('new-topic');
      await new Promise((r) => setTimeout(r, 100));
      expect(mockSummarizer).not.toHaveBeenCalled();
    });

    it('已有摘要时应幂等跳过', async () => {
      // 先写一条有摘要的话题文件
      writeFileSync(
        topicStore.getFilePath(initialDate, initialTopic),
        `---
date: ${initialDate}
topic: ${initialTopic}
summary: 已存在的摘要
---

# ${initialTopic} (${initialDate})

## [user] 2026-06-02T12:00:00.000Z

hello

## [assistant] 2026-06-02T12:00:01.000Z

hi there
`,
        'utf-8',
      );

      const mockSummarizer = vi.fn().mockResolvedValue('不应调用');
      const history = new MessageHistory(topicStore, mockSummarizer, initialDate, initialTopic);
      history.switchTopic('new-topic');
      await new Promise((r) => setTimeout(r, 100));
      expect(mockSummarizer).not.toHaveBeenCalled();
    });

    it('summarizer 抛出异常时应优雅降级（不抛错、不阻塞切换）', async () => {
      const history = new MessageHistory(topicStore, undefined, initialDate, initialTopic);
      await history.appendUser('hello');
      await history.appendAssistant('hi');
      await new Promise((r) => setTimeout(r, 50));

      const mockSummarizer = vi.fn().mockRejectedValue(new Error('LLM 不可用'));
      const history2 = new MessageHistory(topicStore, mockSummarizer, initialDate, initialTopic);
      // 不应该抛错
      expect(() => history2.switchTopic('new-topic')).not.toThrow();
      await new Promise((r) => setTimeout(r, 100));
      expect(mockSummarizer).toHaveBeenCalledTimes(1);
    });

    it('summarizer 返回 null 时应跳过归档（不写入 summary）', async () => {
      const history = new MessageHistory(topicStore, undefined, initialDate, initialTopic);
      // 模拟低价值对话：通用问答
      await history.appendUser('什么是递归函数');
      await history.appendAssistant('递归函数是一个调用自身的函数...');
      await new Promise((r) => setTimeout(r, 50));

      const mockSummarizer = vi.fn().mockResolvedValue(null); // 低价值 → SKIP
      const history3 = new MessageHistory(topicStore, mockSummarizer, initialDate, initialTopic);
      history3.switchTopic('new-topic');
      await new Promise((r) => setTimeout(r, 100));

      expect(mockSummarizer).toHaveBeenCalledTimes(1);
      // 话题文件不应包含 summary（因为被跳过了）
      const topicFile = await topicStore.read(initialDate, initialTopic);
      expect(topicFile).not.toBeNull();
      expect(topicFile!.summary).toBeUndefined();
    });

    it('summarizer 返回高价值内容时应正常归档', async () => {
      const history = new MessageHistory(topicStore, undefined, initialDate, initialTopic);
      await history.appendUser('我的项目用 better-sqlite3，不要用 mysql');
      await history.appendAssistant('明白了，我会确保所有代码都使用 better-sqlite3');
      await new Promise((r) => setTimeout(r, 50));

      const mockSummarizer = vi.fn().mockResolvedValue('用户项目使用 better-sqlite3 作为数据库');
      const history4 = new MessageHistory(topicStore, mockSummarizer, initialDate, initialTopic);
      history4.switchTopic('new-topic');
      await new Promise((r) => setTimeout(r, 100));

      expect(mockSummarizer).toHaveBeenCalledTimes(1);
      // 话题文件应包含 summary
      const topicFile = await topicStore.read(initialDate, initialTopic);
      expect(topicFile).not.toBeNull();
      expect(topicFile!.summary).toBe('用户项目使用 better-sqlite3 作为数据库');
    });
  });

  describe('TopicStore · appendSummary', () => {
    it('应写入 summary 到 frontmatter', async () => {
      // 先写一条话题文件（不含 summary）
      await topicStore.append(initialDate, initialTopic, makeMessage('user', 'test content'));

      await topicStore.appendSummary(initialDate, initialTopic, '测试摘要');

      const result = await topicStore.read(initialDate, initialTopic);
      expect(result).not.toBeNull();
      expect(result!.summary).toBe('测试摘要');
    });

    it('已有 summary 时应幂等跳过（不覆盖）', async () => {
      // 先写一条带原始摘要的话题文件
      writeFileSync(
        topicStore.getFilePath(initialDate, initialTopic),
        `---
date: ${initialDate}
topic: ${initialTopic}
summary: 原始摘要
---

# ${initialTopic} (${initialDate})

## [user] 2026-06-02T12:00:00.000Z

hello
`,
        'utf-8',
      );

      await topicStore.appendSummary(initialDate, initialTopic, '新摘要');

      const result = await topicStore.read(initialDate, initialTopic);
      expect(result!.summary).toBe('原始摘要'); // 不覆盖
    });

    it('话题文件不存在时应静默跳过', async () => {
      // 不抛错
      await expect(
        topicStore.appendSummary(initialDate, 'ghost-topic', '摘要'),
      ).resolves.toBeUndefined();
    });
  });
});
