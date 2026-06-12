/**
 * 消息历史单元测试
 *
 * 覆盖：
 *   - switchTopic 切换话题
 *   - appendUser / appendAssistant 消息追加
 *   - listAllTopics 返回空数组
 *   - archiveCurrentTopic 返回 null
 *   - registerPendingArchive / awaitPendingArchives
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHistory } from '@/agent/message-history.js';
import type { IMemoryStorage } from '@/memory/storage-interface.js';

/**
 * 创建 Mock IMemoryStorage
 */
const createMockStorage = (): IMemoryStorage => {
  return {
    upsert: vi.fn(),
    delete: vi.fn(),
    getById: vi.fn(),
    getBySource: vi.fn(async () => []),
    search: vi.fn(async () => []),
    close: vi.fn(),
  } as unknown as IMemoryStorage;
};

describe('MessageHistory · 基本操作', () => {
  let mockStorage: IMemoryStorage;

  beforeEach(() => {
    mockStorage = createMockStorage();
  });

  it('构造函数应初始化默认日期和话题', () => {
    const history = new MessageHistory(mockStorage);
    expect(history.topic).toBe('main');
    expect(history.currentTopicName).toContain('main');
  });

  it('构造函数应接受自定义初始日期和话题', () => {
    const history = new MessageHistory(mockStorage, undefined, 3, '2026-06-01', 'custom-topic');
    expect(history.topic).toBe('custom-topic');
    expect(history.currentTopicName).toBe('2026-06-01-custom-topic');
  });

  it('switchTopic 应更新当前话题', () => {
    const history = new MessageHistory(mockStorage);
    const newName = history.switchTopic('new-topic');
    expect(history.topic).toBe('new-topic');
    expect(newName).toContain('new-topic');
  });

  it('appendUser 不应抛错', async () => {
    const history = new MessageHistory(mockStorage);
    await expect(history.appendUser('你好')).resolves.toBeUndefined();
  });

  it('appendAssistant 不应抛错', async () => {
    const history = new MessageHistory(mockStorage);
    await expect(history.appendAssistant('你好')).resolves.toBeUndefined();
  });

  it('appendAssistant 空内容应跳过', async () => {
    const history = new MessageHistory(mockStorage);
    await expect(history.appendAssistant('')).resolves.toBeUndefined();
    await expect(history.appendAssistant('   ')).resolves.toBeUndefined();
  });
});

describe('MessageHistory · listAllTopics', () => {
  it('应返回空数组', async () => {
    const history = new MessageHistory(createMockStorage());
    const topics = await history.listAllTopics();
    expect(topics).toEqual([]);
  });
});

describe('MessageHistory · loadTopicMessages', () => {
  it('应返回空数组并更新当前话题', async () => {
    const history = new MessageHistory(createMockStorage());
    const messages = await history.loadTopicMessages('2026-06-01', 'old-topic');
    expect(messages).toEqual([]);
    // 应更新当前话题为请求的话题
    expect(history.topic).toBe('old-topic');
  });
});

describe('MessageHistory · loadMostRecentTopic', () => {
  it('应返回空数组', async () => {
    const history = new MessageHistory(createMockStorage());
    const messages = await history.loadMostRecentTopic('main');
    expect(messages).toEqual([]);
  });
});

describe('MessageHistory · archiveCurrentTopic', () => {
  it('应返回 null', async () => {
    const history = new MessageHistory(createMockStorage());
    const result = await history.archiveCurrentTopic('signal');
    expect(result).toBeNull();
  });

  it('不同 reason 都应返回 null', async () => {
    const history = new MessageHistory(createMockStorage());
    expect(await history.archiveCurrentTopic('switch')).toBeNull();
    expect(await history.archiveCurrentTopic('signal')).toBeNull();
    expect(await history.archiveCurrentTopic('lazy')).toBeNull();
    expect(await history.archiveCurrentTopic('midway')).toBeNull();
  });
});

describe('MessageHistory · archiveMissingTopics', () => {
  it('应返回 0', async () => {
    const history = new MessageHistory(createMockStorage());
    const count = await history.archiveMissingTopics(500);
    expect(count).toBe(0);
  });
});

describe('MessageHistory · pendingArchives', () => {
  it('registerPendingArchive 应注册并等待完成', async () => {
    const history = new MessageHistory(createMockStorage());
    let resolved = false;
    const p = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 50);
    });

    history.registerPendingArchive(p);
    const allDone = await history.awaitPendingArchives(1000);
    expect(allDone).toBe(true);
    expect(resolved).toBe(true);
  });

  it('awaitPendingArchives 应等待所有挂起的归档', async () => {
    const history = new MessageHistory(createMockStorage());

    // 注册多个归档
    const p1 = new Promise<void>((resolve) => setTimeout(resolve, 30));
    const p2 = new Promise<void>((resolve) => setTimeout(resolve, 60));
    history.registerPendingArchive(p1);
    history.registerPendingArchive(p2);

    const allDone = await history.awaitPendingArchives(1000);
    expect(allDone).toBe(true);
  });

  it('超时时应返回 false', async () => {
    const history = new MessageHistory(createMockStorage());

    // 注册一个永不完成的归档
    const p = new Promise<void>(() => { /* never resolves */ });
    history.registerPendingArchive(p);

    const allDone = await history.awaitPendingArchives(100);
    expect(allDone).toBe(false);
  });
});

describe('MessageHistory · getCurrentTopicMessages', () => {
  it('应返回空数组', async () => {
    const history = new MessageHistory(createMockStorage());
    const messages = await history.getCurrentTopicMessages();
    expect(messages).toEqual([]);
  });
});

describe('MessageHistory · setCurrentTopicSeedSnapshots', () => {
  it('空快照应跳过', async () => {
    const history = new MessageHistory(createMockStorage());
    await expect(history.setCurrentTopicSeedSnapshots([])).resolves.toBeUndefined();
  });

  it('非空快照不应抛错', async () => {
    const history = new MessageHistory(createMockStorage());
    await expect(history.setCurrentTopicSeedSnapshots(['快照1', '快照2'])).resolves.toBeUndefined();
  });
});
