/**
 * ISessionStore 契约测试
 *
 * 验证 MessageHistory 正确使用 ISessionStore 接口
 * 覆盖：
 *   - appendMessage 调用（appendUser/appendAssistant）
 *   - loadMessages 调用（loadTopicMessages）
 *   - listTopics 调用（listAllTopics）
 *   - 未注入 sessionStore 时的降级行为
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHistory } from '@/agent/messageHistory.js';
import type { ISessionStore, SessionMessage } from '@/memory/sessionStore.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';

/**
 * 创建 Mock IMemoryStorage
 */
const createMockStorage = (): IMemoryStorage => ({
  upsert: vi.fn(),
  delete: vi.fn(),
  getById: vi.fn(),
  getBySource: vi.fn(async () => []),
  search: vi.fn(async () => []),
  count: vi.fn(() => 0),
  countBySource: vi.fn(() => 0),
  close: vi.fn(),
}) as unknown as IMemoryStorage;

/**
 * 创建 Mock ISessionStore
 */
const createMockSessionStore = (): ISessionStore => ({
  appendMessage: vi.fn(),
  loadMessages: vi.fn().mockReturnValue([]),
  listTopics: vi.fn().mockReturnValue([]),
});

describe('ISessionStore 契约 · appendMessage', () => {
  let mockStorage: IMemoryStorage;
  let mockSessionStore: ISessionStore;
  let history: MessageHistory;

  beforeEach(() => {
    mockStorage = createMockStorage();
    mockSessionStore = createMockSessionStore();
    history = new MessageHistory(mockStorage, mockSessionStore);
  });

  it('appendUser 应调用 sessionStore.appendMessage', async () => {
    await history.appendUser('测试消息');

    expect(mockSessionStore.appendMessage).toHaveBeenCalledTimes(1);
    expect(mockSessionStore.appendMessage).toHaveBeenCalledWith(
      expect.any(String), // date (YYYY-MM-DD)
      'main', // topic
      expect.objectContaining({
        role: 'user',
        content: '测试消息',
        timestamp: expect.any(String),
      }),
    );
  });

  it('appendAssistant 应调用 sessionStore.appendMessage', async () => {
    await history.appendAssistant('回复消息');

    expect(mockSessionStore.appendMessage).toHaveBeenCalledTimes(1);
    expect(mockSessionStore.appendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'main',
      expect.objectContaining({
        role: 'assistant',
        content: '回复消息',
        timestamp: expect.any(String),
      }),
    );
  });

  it('appendAssistant 空内容不应调用 sessionStore', async () => {
    await history.appendAssistant('');

    expect(mockSessionStore.appendMessage).not.toHaveBeenCalled();
  });

  it('appendAssistant 空白内容不应调用 sessionStore', async () => {
    await history.appendAssistant('   ');

    expect(mockSessionStore.appendMessage).not.toHaveBeenCalled();
  });

  it('切换话题后应使用新话题名', async () => {
    history.switchTopic('new-topic');
    await history.appendUser('新话题消息');

    expect(mockSessionStore.appendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'new-topic',
      expect.objectContaining({ role: 'user', content: '新话题消息' }),
    );
  });

  it('sessionStore.appendMessage 失败不应抛出异常', async () => {
    vi.mocked(mockSessionStore.appendMessage).mockImplementation(() => {
      throw new Error('写入失败');
    });

    // 不应抛出异常
    await expect(history.appendUser('测试')).resolves.toBeUndefined();
  });
});

describe('ISessionStore 契约 · loadMessages', () => {
  let mockStorage: IMemoryStorage;
  let mockSessionStore: ISessionStore;
  let history: MessageHistory;

  beforeEach(() => {
    mockStorage = createMockStorage();
    mockSessionStore = createMockSessionStore();
    history = new MessageHistory(mockStorage, mockSessionStore);
  });

  it('loadTopicMessages 应调用 sessionStore.loadMessages', async () => {
    const mockMessages: SessionMessage[] = [
      { role: 'user', content: '你好', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: '你好！', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    vi.mocked(mockSessionStore.loadMessages).mockReturnValue(mockMessages);

    const result = await history.loadTopicMessages('2026-01-01', 'test-topic');

    expect(mockSessionStore.loadMessages).toHaveBeenCalledWith('2026-01-01', 'test-topic');
    expect(result).toEqual(mockMessages);
  });

  it('loadTopicMessages 应更新当前话题', async () => {
    await history.loadTopicMessages('2026-01-01', 'old-topic');

    expect(history.topic).toBe('old-topic');
    expect(history.currentDateValue).toBe('2026-01-01');
  });

  it('sessionStore 未注入时应返回空数组', async () => {
    const historyWithoutStore = new MessageHistory(mockStorage);

    const result = await historyWithoutStore.loadTopicMessages('2026-01-01', 'test-topic');

    expect(result).toEqual([]);
  });
});

describe('ISessionStore 契约 · listTopics', () => {
  let mockStorage: IMemoryStorage;
  let mockSessionStore: ISessionStore;
  let history: MessageHistory;

  beforeEach(() => {
    mockStorage = createMockStorage();
    mockSessionStore = createMockSessionStore();
    history = new MessageHistory(mockStorage, mockSessionStore);
  });

  it('listAllTopics 应调用 sessionStore.listTopics', async () => {
    const mockTopics = ['2026-01-01-main', '2026-01-02-work'];
    vi.mocked(mockSessionStore.listTopics).mockReturnValue(mockTopics);

    const result = await history.listAllTopics();

    expect(mockSessionStore.listTopics).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockTopics);
  });

  it('sessionStore 未注入时应返回空数组', async () => {
    const historyWithoutStore = new MessageHistory(mockStorage);

    const result = await historyWithoutStore.listAllTopics();

    expect(result).toEqual([]);
  });
});
