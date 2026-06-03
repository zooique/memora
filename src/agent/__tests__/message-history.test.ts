/**
 * 消息历史单元测试（M-203-改：事件驱动归档 + 记忆归档原则 v0.3）
 *
 * 覆盖：
 *   - switchTopic 调用 summarizer（fire-and-forget）
 *   - 消息数 < 2 时跳过总结
 *   - 未注入 summarizer 时跳过
 *   - 已有摘要时幂等跳过
 *   - summarizer 返回 null（低价值对话）→ 跳过归档
 *   - summarizer 返回结构化文本 → 正常归档
 *   - summarizer 抛出时优雅降级
 *   - appendSummary 幂等（topic-store 层）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MessageHistory } from '@/agent/message-history.js';
import { TopicStore } from '@/memory/topic-store.js';
import type { TopicMessage } from '@/memory/types.js';

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
      // fire-and-forget: 等待 summarizeAndArchive 完成（Windows + coverage 下文件 I/O 较慢）
      await new Promise((r) => setTimeout(r, 200));

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

      const mockSummarizer = vi.fn().mockResolvedValue('用户项目使用 better-sqlite3 作为数据库');
      const history4 = new MessageHistory(topicStore, mockSummarizer, initialDate, initialTopic);
      history4.switchTopic('new-topic');
      // fire-and-forget: 等待 summarizeAndArchive 完成（mock 立即 resolve，但仍需等文件写入）
      await new Promise((r) => setTimeout(r, 200));

      expect(mockSummarizer).toHaveBeenCalledTimes(1);
      // 话题文件应包含 summary（fire-and-forget 条件下需确认完整链路）
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

// ─── 2026-06-03 · 自动归档到 SQLite 索引 + Lazy 扫描 ────────────

import { MemoryIndex } from '@/memory/index.js';
import { MemoryType, Permanence } from '@/memory/types.js';

describe('MessageHistory · 自动归档到 SQLite 索引（Lazy + Signal 方案）', () => {
  let tmpDir: string;
  let topicStore: TopicStore;
  let index: MemoryIndex;
  const initialDate = '2026-06-03';
  const initialTopic = 'auto-archive';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'memora-autoarchive-'));
    mkdirSync(join(tmpDir, 'topics'), { recursive: true });
    topicStore = new TopicStore(tmpDir);
    index = new MemoryIndex(join(tmpDir, 'test.db'));
  });

  afterEach(async () => {
    await index.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('archiveCurrentTopic', () => {
    it('写入索引：归档后应在 SQLite 出现 type=topic 记录', async () => {
      const history = new MessageHistory(
        topicStore,
        async () => '用户偏好简洁代码风格',
        initialDate,
        initialTopic,
        index,
      );
      await history.appendUser('我喜欢简洁的代码风格');
      await history.appendAssistant('好的，我记住了');

      await history.archiveCurrentTopic('signal');

      const topicMemories = await index.getByType('topic');
      expect(topicMemories).toHaveLength(1);
      expect(topicMemories[0]?.id).toBe(`topic-${initialDate}-${initialTopic}`);
      expect(topicMemories[0]?.permanence).toBe(Permanence.TOPIC);
      expect(topicMemories[0]?.type).toBe(MemoryType.TOPIC);
      expect(topicMemories[0]?.content).toBe('用户偏好简洁代码风格');
      expect(topicMemories[0]?.weight).toBe(0.7);
    });

    it('幂等：同一 topic 多次归档只产生一条记录（upsert）', async () => {
      const mockSummarizer = vi.fn().mockResolvedValue('摘要 v1');
      const history = new MessageHistory(
        topicStore,
        mockSummarizer,
        initialDate,
        initialTopic,
        index,
      );
      await history.appendUser('hello');
      await history.appendAssistant('hi');

      await history.archiveCurrentTopic('signal');
      await history.archiveCurrentTopic('signal');

      // 同一 topic-2026-06-03-auto-archive ID，多次 upsert 只产生 1 条
      const topicMemories = await index.getByType('topic');
      expect(topicMemories).toHaveLength(1);
    });

    it('switch 触发的归档也应写入索引', async () => {
      // 写入用户消息
      const history = new MessageHistory(
        topicStore,
        async () => 'switch 触发的归档',
        initialDate,
        initialTopic,
        index,
      );
      await history.appendUser('msg');
      await history.appendAssistant('reply');

      // 切话题时 summarizeAndArchive 被 fire-and-forget 调用
      history.switchTopic('new-topic');
      // 等待异步归档完成
      await history.awaitPendingArchives(2000);

      const topicMemories = await index.getByType('topic');
      expect(topicMemories).toHaveLength(1);
      expect(topicMemories[0]?.id).toBe(`topic-${initialDate}-${initialTopic}`);
    });

    it('未注入 index 时不报错（向后兼容）', async () => {
      // 不传 index 构造 → 只写 topic-*.md
      const history = new MessageHistory(
        topicStore,
        async () => 'no index',
        initialDate,
        initialTopic,
      );
      await history.appendUser('msg');
      await history.appendAssistant('reply');

      // 不抛错
      await expect(history.archiveCurrentTopic('signal')).resolves.toBeUndefined();

      // 话题文件应有 summary
      const tf = await topicStore.read(initialDate, initialTopic);
      expect(tf?.summary).toBe('no index');
    });

    it('summarizer 返回 null 时不写入索引', async () => {
      const history = new MessageHistory(
        topicStore,
        async () => null,
        initialDate,
        initialTopic,
        index,
      );
      await history.appendUser('msg');
      await history.appendAssistant('reply');

      await history.archiveCurrentTopic('signal');

      const topicMemories = await index.getByType('topic');
      expect(topicMemories).toHaveLength(0);
    });

    it('消息数 < 2 时跳过（不写索引）', async () => {
      const history = new MessageHistory(
        topicStore,
        async () => '不应被调用',
        initialDate,
        initialTopic,
        index,
      );
      // 只发 1 条 user
      await history.appendUser('only one msg');
      await history.archiveCurrentTopic('signal');

      const topicMemories = await index.getByType('topic');
      expect(topicMemories).toHaveLength(0);
    });

    it('signal 原因可覆盖已有摘要（强信号优先）', async () => {
      // 预写带 summary 的 topic 文件
      const mockSummarizer = vi
        .fn()
        .mockResolvedValueOnce('首次归档摘要')
        .mockResolvedValueOnce('signal 重新归档摘要');
      const history = new MessageHistory(
        topicStore,
        mockSummarizer,
        initialDate,
        initialTopic,
        index,
      );
      await history.appendUser('msg');
      await history.appendAssistant('reply');

      await history.archiveCurrentTopic('switch');
      const after1 = await index.getByType('topic');
      expect(after1[0]?.content).toBe('首次归档摘要');

      await history.archiveCurrentTopic('signal');
      const after2 = await index.getByType('topic');
      expect(after2[0]?.content).toBe('signal 重新归档摘要');
    });
  });

  describe('archiveMissingTopics · 启动 Lazy 扫描', () => {
    it('未注入 index 时直接返回 0（不报错）', async () => {
      const history = new MessageHistory(
        topicStore,
        async () => 'summary',
        initialDate,
        initialTopic,
      );
      const count = await history.archiveMissingTopics();
      expect(count).toBe(0);
    });

    it('未注入 summarizer 时直接返回 0（不报错）', async () => {
      const history = new MessageHistory(topicStore, undefined, initialDate, initialTopic, index);
      const count = await history.archiveMissingTopics();
      expect(count).toBe(0);
    });

    it('topics 目录为空时返回 0', async () => {
      const history = new MessageHistory(
        topicStore,
        async () => 'summary',
        initialDate,
        initialTopic,
        index,
      );
      const count = await history.archiveMissingTopics();
      expect(count).toBe(0);
    });

    it('发现未归档的 topic 文件 → 后台补归档', async () => {
      // 直接往 topics/ 目录写一个历史文件
      writeFileSync(
        topicStore.getFilePath('2026-06-01', 'old-topic'),
        `---
date: 2026-06-01
topic: old-topic
---

# old-topic (2026-06-01)

## [user] 2026-06-01T10:00:00.000Z

我以前聊过 TypeScript 的泛型

## [assistant] 2026-06-01T10:00:05.000Z

好的，泛型是...
`,
        'utf-8',
      );

      const mockSummarizer = vi.fn().mockResolvedValue('历史摘要：聊过 TypeScript 泛型');
      const history = new MessageHistory(
        topicStore,
        mockSummarizer,
        initialDate,
        initialTopic,
        index,
      );

      const count = await history.archiveMissingTopics(500);
      expect(count).toBe(1);

      // 等待异步补归档完成（500ms timeout + summarizer 调用 + 写索引）
      await new Promise((r) => setTimeout(r, 800));

      const topicMemories = await index.getByType('topic');
      expect(topicMemories).toHaveLength(1);
      expect(topicMemories[0]?.id).toBe('topic-2026-06-01-old-topic');
      expect(topicMemories[0]?.content).toBe('历史摘要：聊过 TypeScript 泛型');
      expect(mockSummarizer).toHaveBeenCalledTimes(1);
    });

    it('已归档的 topic 不重复归档', async () => {
      // 写一个历史文件 + 提前把它放进索引（模拟之前已归档）
      writeFileSync(
        topicStore.getFilePath('2026-06-02', 'already-done'),
        `---
date: 2026-06-02
topic: already-done
summary: 之前的摘要
---

## [user] 2026-06-02T10:00:00.000Z

msg
## [assistant] 2026-06-02T10:00:05.000Z

reply
`,
        'utf-8',
      );
      // 预写入索引
      await index.upsert({
        id: 'topic-2026-06-02-already-done',
        type: 'topic',
        permanence: 'topic',
        name: '已归档',
        content: '之前的摘要',
        tags: [],
        weight: 0.7,
        createdAt: '2026-06-02T10:00:00.000Z',
        updatedAt: '2026-06-02T10:00:00.000Z',
      });

      const mockSummarizer = vi.fn();
      const history = new MessageHistory(
        topicStore,
        mockSummarizer,
        initialDate,
        initialTopic,
        index,
      );

      const count = await history.archiveMissingTopics(500);
      expect(count).toBe(0);

      // 等异步
      await new Promise((r) => setTimeout(r, 200));
      expect(mockSummarizer).not.toHaveBeenCalled();
    });
  });
});
