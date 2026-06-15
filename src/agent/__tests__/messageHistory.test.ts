/**
 * 消息历史单元测试
 *
 * 覆盖：
 *   - switchSession 切换会话
 *   - appendUser / appendAssistant 消息追加
 *   - listAllSessions 返回空数组
 *   - registerPendingArchive / awaitPendingArchives
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageHistory } from '@/agent/messageHistory.js';
import type { IMemoryStorage } from '@/memory/storageInterface.js';

/**
 * 创建 Mock IMemoryStorage
 */
const createMockStorage = (): IMemoryStorage => {
  return {
    upsert: vi.fn(),
    delete: vi.fn(),
    getById: vi.fn(),
    getBySource: vi.fn(() => []),
    search: vi.fn(() => []),
    count: vi.fn(() => 0),
    countBySource: vi.fn(() => 0),
    close: vi.fn(),
  } as unknown as IMemoryStorage;
};

describe('MessageHistory · 基本操作', () => {
  let mockStorage: IMemoryStorage;

  beforeEach(() => {
    mockStorage = createMockStorage();
  });

  it('构造函数应初始化默认日期和会话', () => {
    const history = new MessageHistory(mockStorage);
    expect(history.session).toBe('main');
    expect(history.currentSessionName).toContain('main');
  });

  it('构造函数应接受自定义初始日期和会话', () => {
    const history = new MessageHistory(mockStorage, undefined, 3, '2026-06-01', 'custom-session');
    expect(history.session).toBe('custom-session');
    expect(history.currentSessionName).toBe('2026-06-01-custom-session');
  });

  it('switchSession 应更新当前会话', () => {
    const history = new MessageHistory(mockStorage);
    const newName = history.switchSession('new-session');
    expect(history.session).toBe('new-session');
    expect(newName).toContain('new-session');
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

describe('MessageHistory · listAllSessions', () => {
  it('应返回空数组', async () => {
    const history = new MessageHistory(createMockStorage());
    const sessions = await history.listAllSessions();
    expect(sessions).toEqual([]);
  });
});

describe('MessageHistory · loadSessionMessages', () => {
  it('应返回空数组并更新当前会话', async () => {
    const history = new MessageHistory(createMockStorage());
    const messages = await history.loadSessionMessages('2026-06-01', 'old-session');
    expect(messages).toEqual([]);
    // 应更新当前会话为请求的会话
    expect(history.session).toBe('old-session');
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
