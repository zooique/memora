/**
 * 消息历史单元测试
 *
 * 覆盖：
 *   - switchSession 切换会话
 *   - appendUser / appendAssistant 消息追加
 *   - listAllSessions 返回空数组
 *   - registerPendingArchive / awaitPendingArchives
 */
import { describe, it, expect } from 'vitest';
import { MessageHistory } from '@/agent/messageHistory.js';
import type { SessionMessage } from '@/memory/sessionStore.js';
import { todayDate } from '@/utils/time.js';

describe('MessageHistory · 基本操作', () => {
  it('构造函数应初始化默认日期和会话', () => {
    const history = new MessageHistory();
    expect(history.session).toBe('main');
    expect(history.currentSessionName).toContain('main');
  });

  it('构造函数应接受自定义初始日期和会话', () => {
    const history = new MessageHistory(undefined, '2026-06-01', 'custom-session');
    expect(history.session).toBe('custom-session');
    expect(history.currentSessionName).toBe('2026-06-01-custom-session');
  });

  it('switchSession 应更新当前会话', () => {
    const history = new MessageHistory();
    const newName = history.switchSession('new-session');
    expect(history.session).toBe('new-session');
    expect(newName).toContain('new-session');
  });

  it('appendUser 不应抛错', async () => {
    const history = new MessageHistory();
    await expect(history.appendUser('你好')).resolves.toBeUndefined();
  });

  it('appendAssistant 不应抛错', async () => {
    const history = new MessageHistory();
    await expect(history.appendAssistant('你好')).resolves.toBeUndefined();
  });

  it('appendAssistant 空内容应跳过', async () => {
    const history = new MessageHistory();
    await expect(history.appendAssistant('')).resolves.toBeUndefined();
    await expect(history.appendAssistant('   ')).resolves.toBeUndefined();
  });

  it('跨日追加后 currentDateValue 同步为实际写入日期（写入是与读侧锚点一致）', async () => {
    // round-based 单一模型下，appendUser 不再写 legacy 扁平列表，
    // 但会话日期锚点仍须随当天日期同步（摘要/标题/互斥排除锚点不错位）
    const mockStore = {
      loadMessages: () => [],
      listSessions: () => [],
      getRoundIds: () => [],
      setRoundIds: () => {},
      appendRoundId: () => {},
      appendRoundIds: () => {},
      createSession: () => {},
      deleteSession: () => {},
      getSessionMeta: () => undefined,
      updateSessionMeta: () => {},
      listSessionMetas: () => [],
    };
    // 构造一个"昨天"的初始化日期，模拟跨日后第一次追加
    const history = new MessageHistory(mockStore, '2000-01-01', 'main');
    expect(history.currentDateValue).toBe('2000-01-01');

    await history.appendUser('跨日后消息');
    // currentDate 已同步到今天（与写入锚点一致）
    expect(history.currentDateValue).toBe(todayDate());
    // currentSessionName 与写入 date 一致
    expect(history.currentSessionName).toBe(`${todayDate()}-main`);
  });
});

describe('MessageHistory · listAllSessions', () => {
  it('应返回空数组', async () => {
    const history = new MessageHistory();
    const sessions = await history.listAllSessions();
    expect(sessions).toEqual([]);
  });
});

describe('MessageHistory · loadSessionMessages', () => {
  it('应返回空数组并更新当前会话', async () => {
    const history = new MessageHistory();
    const messages = await history.loadSessionMessages('2026-06-01', 'old-session');
    expect(messages).toEqual([]);
    // 应更新当前会话为请求的会话
    expect(history.session).toBe('old-session');
  });
});

describe('MessageHistory · pendingArchives', () => {
  it('registerPendingArchive 应注册并等待完成', async () => {
    const history = new MessageHistory();
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
    const history = new MessageHistory();

    // 注册多个归档
    const p1 = new Promise<void>((resolve) => setTimeout(resolve, 30));
    const p2 = new Promise<void>((resolve) => setTimeout(resolve, 60));
    history.registerPendingArchive(p1);
    history.registerPendingArchive(p2);

    const allDone = await history.awaitPendingArchives(1000);
    expect(allDone).toBe(true);
  });

  it('超时时应返回 false', async () => {
    const history = new MessageHistory();

    // 注册一个永不完成的归档
    const p = new Promise<void>(() => {
      /* never resolves */
    });
    history.registerPendingArchive(p);

    const allDone = await history.awaitPendingArchives(100);
    expect(allDone).toBe(false);
  });
});

describe('MessageHistory · getFirstRoundId（会话起点背景互斥排除）', () => {
  /** 构造带 roundId 的 sessionStore mock */
  function mockStoreWithMessages(
    messages: Array<Pick<SessionMessage, 'role' | 'content' | 'roundId'>>,
  ) {
    return {
      loadMessages: () =>
        messages.map((m) => ({ timestamp: '2026-01-01T00:00:00.000Z', ...m }) as SessionMessage),
      listSessions: () => [],
      getRoundIds: () => [],
      setRoundIds: () => {},
      appendRoundId: () => {},
      appendRoundIds: () => {},
      createSession: () => {},
      deleteSession: () => {},
      getSessionMeta: () => undefined,
      updateSessionMeta: () => {},
      listSessionMetas: () => [],
    };
  }

  it('返回第一条带 roundId 的消息的 roundId', () => {
    const history = new MessageHistory(
      mockStoreWithMessages([
        { role: 'user', content: '第一问', roundId: 'round-1' },
        { role: 'assistant', content: '答', roundId: 'round-1' },
        { role: 'user', content: '第二问', roundId: 'round-2' },
      ]),
      '2026-01-01',
      'main',
    );
    expect(history.getFirstRoundId()).toBe('round-1');
  });

  it('首条无 roundId 时跳过取下一条有 roundId 的', () => {
    const history = new MessageHistory(
      mockStoreWithMessages([
        { role: 'user', content: '旧消息' },
        { role: 'user', content: '新消息', roundId: 'round-9' },
      ]),
      '2026-01-01',
      'main',
    );
    expect(history.getFirstRoundId()).toBe('round-9');
  });

  it('无 sessionStore / 无 roundId 时返回 null', () => {
    const empty = new MessageHistory();
    expect(empty.getFirstRoundId()).toBeNull();

    const noRounds = new MessageHistory(
      mockStoreWithMessages([{ role: 'user', content: '无 roundId' }]),
      '2026-01-01',
      'main',
    );
    expect(noRounds.getFirstRoundId()).toBeNull();
  });
});
