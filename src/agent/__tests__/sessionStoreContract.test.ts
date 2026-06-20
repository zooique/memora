/**
 * ISessionStore 契约测试（集成测试）
 *
 * 验证 MessageHistory（agent/）正确使用 ISessionStore（memory/）接口。
 * 此文件位于 agent/__tests__/ 因为测试主体是 MessageHistory，
 * 依赖方向为 agent/ → memory/，符合分层规范。
 *
 * 覆盖：
 *   - appendMessage 调用（appendUser/appendAssistant）
 *   - loadMessages 调用（loadSessionMessages）
 *   - listSessions 调用（listAllSessions）
 *   - 未注入 sessionStore 时的降级行为
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHistory } from '@/agent/messageHistory.js';
import type { ISessionStore, SessionMessage } from '@/memory/sessionStore.js';

/**
 * 创建 Mock ISessionStore
 */
const createMockSessionStore = (): ISessionStore => ({
  appendMessage: vi.fn(),
  loadMessages: vi.fn().mockReturnValue([]),
  listSessions: vi.fn().mockReturnValue([]),
  copySession: vi.fn(),
});

describe('ISessionStore 契约 · appendMessage', () => {
  let mockSessionStore: ISessionStore;
  let history: MessageHistory;

  beforeEach(() => {
    mockSessionStore = createMockSessionStore();
    history = new MessageHistory(mockSessionStore);
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
  let mockSessionStore: ISessionStore;
  let history: MessageHistory;

  beforeEach(() => {
    mockSessionStore = createMockSessionStore();
    history = new MessageHistory(mockSessionStore);
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
    const historyWithoutStore = new MessageHistory();

    const result = await historyWithoutStore.loadSessionMessages('2026-01-01', 'test-session');

    expect(result).toEqual([]);
  });
});

describe('ISessionStore 契约 · listSessions', () => {
  let mockSessionStore: ISessionStore;
  let history: MessageHistory;

  beforeEach(() => {
    mockSessionStore = createMockSessionStore();
    history = new MessageHistory(mockSessionStore);
  });

  it('listAllSessions 应调用 sessionStore.listSessions', async () => {
    const mockSessions = ['2026-01-01-main', '2026-01-02-work'];
    vi.mocked(mockSessionStore.listSessions).mockReturnValue(mockSessions);

    const result = await history.listAllSessions();

    expect(mockSessionStore.listSessions).toHaveBeenCalledTimes(1);
    expect(result).toEqual(mockSessions);
  });

  it('sessionStore 未注入时应返回空数组', async () => {
    const historyWithoutStore = new MessageHistory();

    const result = await historyWithoutStore.listAllSessions();

    expect(result).toEqual([]);
  });
});

describe('ISessionStore 契约 · copySession', () => {
  let mockSessionStore: ISessionStore;
  let history: MessageHistory;

  beforeEach(() => {
    mockSessionStore = createMockSessionStore();
    history = new MessageHistory(mockSessionStore);
  });

  it('forkSession 应调用 sessionStore.copySession', async () => {
    const mockMessages: SessionMessage[] = [
      { role: 'user', content: '你好', timestamp: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: '你好！', timestamp: '2026-01-01T00:00:01.000Z' },
    ];
    vi.mocked(mockSessionStore.loadMessages).mockReturnValue(mockMessages);
    vi.mocked(mockSessionStore.listSessions).mockReturnValue([]);

    await history.forkSession();

    expect(mockSessionStore.copySession).toHaveBeenCalledTimes(1);
    expect(mockSessionStore.copySession).toHaveBeenCalledWith(
      expect.any(String), // sourceDate
      'main', // sourceSession
      expect.any(String), // targetDate
      'main-b1', // targetSession
    );
  });

  it('forkSession 应正确递增分支序号', async () => {
    const mockMessages: SessionMessage[] = [
      { role: 'user', content: '你好', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    vi.mocked(mockSessionStore.loadMessages).mockReturnValue(mockMessages);
    vi.mocked(mockSessionStore.listSessions).mockReturnValue([
      '2026-01-01-main-b1',
      '2026-01-01-main-b2',
    ]);

    await history.forkSession();

    expect(mockSessionStore.copySession).toHaveBeenCalledWith(
      expect.any(String),
      'main',
      expect.any(String),
      'main-b3',
    );
  });

  it('forkSession 应支持自定义目标会话名', async () => {
    const mockMessages: SessionMessage[] = [
      { role: 'user', content: '你好', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    vi.mocked(mockSessionStore.loadMessages).mockReturnValue(mockMessages);
    vi.mocked(mockSessionStore.listSessions).mockReturnValue([]);

    await history.forkSession('experiment');

    expect(mockSessionStore.copySession).toHaveBeenCalledWith(
      expect.any(String),
      'main',
      expect.any(String),
      'experiment',
    );
  });

  it('forkSession 应切换到新会话', () => {
    const mockMessages: SessionMessage[] = [
      { role: 'user', content: '你好', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    vi.mocked(mockSessionStore.loadMessages).mockReturnValue(mockMessages);
    vi.mocked(mockSessionStore.listSessions).mockReturnValue([]);

    const result = history.forkSession();

    expect(history.session).toBe('main-b1');
    expect(result.newSession).toBe('main-b1');
  });

  it('forkSession 当前会话无消息时应抛出错误', () => {
    vi.mocked(mockSessionStore.loadMessages).mockReturnValue([]);

    expect(() => history.forkSession()).toThrow('无法分叉会话');
  });

  it('forkSession sessionStore 未注入时应抛出错误', () => {
    const historyWithoutStore = new MessageHistory();

    expect(() => historyWithoutStore.forkSession()).toThrow('无法分叉会话');
  });

  it('forkSession 自定义名称已存在时应抛出错误', () => {
    const mockMessages: SessionMessage[] = [
      { role: 'user', content: '你好', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    vi.mocked(mockSessionStore.loadMessages).mockReturnValue(mockMessages);
    // 使用今天的日期，这样才会匹配
    const today = new Date().toISOString().slice(0, 10);
    vi.mocked(mockSessionStore.listSessions).mockReturnValue([`${today}-experiment`]);

    expect(() => history.forkSession('experiment')).toThrow('无法分叉会话');
  });
});
