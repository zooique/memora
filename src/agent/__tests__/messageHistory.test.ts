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
    // mock sessionStore 捕获写入的 date
    let capturedDate: string | undefined;
    const mockStore = {
      appendMessage: (date: string) => {
        capturedDate = date;
      },
      loadMessages: () => [],
      listSessions: () => [],
    };
    // 构造一个"昨天"的初始化日期，模拟跨日后第一次追加
    const history = new MessageHistory(mockStore, '2000-01-01', 'main');
    expect(history.currentDateValue).toBe('2000-01-01');

    await history.appendUser('跨日后消息');
    // 写入日期应是今天（todayDate，与 currentDate 同步）
    expect(capturedDate).toBeDefined();
    // currentDate 已同步到写入日期（非昨天的初始化值）
    expect(history.currentDateValue).toBe(capturedDate);
    // currentSessionName 与写入 date 一致（摘要/标题/互斥锚点不错位）
    expect(history.currentSessionName).toBe(`${capturedDate}-main`);
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
