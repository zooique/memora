/**
 * ISessionStore 契约测试
 *
 * 验证 MessageHistory 正确使用 ISessionStore 接口
 * 覆盖：
 *   - appendMessage 调用（appendUser/appendAssistant）
 *   - loadMessages 调用（loadSessionMessages）
 *   - listSessions 调用（listAllSessions）
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
  listSessions: vi.fn().mockReturnValue([]),
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
      'main', // session
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

  it('切换会话后应使用新会话名', async () => {
    history.switchSession('new-session');
    await history.appendUser('新会话消息');

    expect(mockSessionStore.appendMessage).toHaveBeenCalledWith(
      expect.any(String),
      'new-session',
      expect.objectContaining({ role: 'user', content: '新会话消息' }),
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

  it('loadSessionMessages 应调用 sessionStore.loadMessages', async () => {
    const mockMessages: SessionMessage[] = [
      { role: 'user', content: '你好', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: '你好！', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    vi.mocked(mockSessionStore.loadMessages).mockReturnValue(mockMessages);

    const result = await history.loadSessionMessages('2026-01-01', 'test-session');

    expect(mockSessionStore.loadMessages).toHaveBeenCalledWith('2026-01-01', 'test-session');
    expect(result).toEqual(mockMessages);
  });

  it('loadSessionMessages 应更新当前会话', async () => {
    await history.loadSessionMessages('2026-01-01', 'old-session');

    expect(history.session).toBe('old-session');
    expect(history.currentDateValue).toBe('2026-01-01');
  });

  it('sessionStore 未注入时应返回空数组', async () => {
    const historyWithoutStore = new MessageHistory(mockStorage);

    const result = await historyWithoutStore.loadSessionMessages('2026-01-01', 'test-session');

    expect(result).toEqual([]);
  });
});

describe('ISessionStore 契约 · listSessions', () => {
  let mockStorage: IMemoryStorage;
  let mockSessionStore: ISessionStore;
  let history: MessageHistory;

  beforeEach(() => {
    mockStorage = createMockStorage();
    mockSessionStore = createMockSessionStore();
    history = new MessageHistory(mockStorage, mockSessionStore);
  });

  it('listAllSessions 应调用 sessionStore.listSessions', async () => {
    const mockSessions = ['2026-01-01-main', '2026-01-02-work'];
    vi.mocked(mockSessionStore.listSessions).mockReturnValue(mockSessions);

    const result = await history.listAllSessions();

    expect(mockSessionStore.listSessions).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockSessions);
  });

  it('sessionStore 未注入时应返回空数组', async () => {
    const historyWithoutStore = new MessageHistory(mockStorage);

    const result = await historyWithoutStore.listAllSessions();

    expect(result).toEqual([]);
  });
});
