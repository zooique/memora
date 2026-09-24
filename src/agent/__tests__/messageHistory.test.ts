/**
 * 消息历史单元测试
 *
 * 覆盖：
 *   - switchSession 切换会话
 *   - appendUser / appendAssistant 消息追加
 *   - listAllSessions 返回空数组
 *   - registerPendingArchive / awaitPendingArchives
 */
import { describe, it, expect, vi } from 'vitest';
import { MessageHistory } from '@/agent/messageHistory.js';
import { LOOP_CONSTANTS } from '@/agent/constants.js';
import { InMemoryRoundStore } from '@/memory/inMemoryRoundStore.js';
import { InMemorySessionStore } from '@/memory/inMemorySessionStore.js';
import { generateRoundId } from '@/memory/roundStore.js';
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

  it('跨天追加不漂移：currentDateValue 保持会话锚定日期（延续会话，不自动新建）', async () => {
    // round-based 单一模型下，append 不写 legacy 扁平列表；会话日期锚点由
    // 构造/loadSessionMessages/forkSession 决定，绝不随输入漂移到"今天"（
    // 剪枝「跨天自动新建」残留：跨天继续对话 = 延续当前会话，用户显式新建才切会话）
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
    // 构造一个"昨天"的初始化日期，模拟跨日后继续同一会话
    const history = new MessageHistory(mockStore, '2000-01-01', 'main');
    expect(history.currentDateValue).toBe('2000-01-01');

    await history.appendUser('跨日后继续对话');
    // 会话日期锚点保持不变：跨天 = 延续「昨天-main」，不漂移到今天自动新建
    expect(history.currentDateValue).toBe('2000-01-01');
    expect(history.currentSessionName).toBe('2000-01-01-main');

    await history.appendAssistant('继续回复');
    expect(history.currentDateValue).toBe('2000-01-01');
    expect(history.currentSessionName).toBe('2000-01-01-main');
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

describe('MessageHistory · appendEvidence（裁决证据挂载）', () => {
  /** 构造带 InMemory 双存储的 history（镜像 roundRefLifecycle 先例） */
  function createRoundBackedHistory(): { history: MessageHistory; roundStore: InMemoryRoundStore } {
    const roundStore = new InMemoryRoundStore();
    const sessionStore = new InMemorySessionStore();
    const history = new MessageHistory(sessionStore, todayDate(), 'main', roundStore);
    sessionStore.createSession({
      sessionId: history.currentSessionName,
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { history, roundStore };
  }

  it('证据挂在在途轮且随收场保留（pendingRounds 同步——漏同步则收场以旧对象覆盖即丢证据）', async () => {
    const { history, roundStore } = createRoundBackedHistory();
    const roundId = generateRoundId();
    await history.appendUser('问题', roundId);
    await history.appendEvidence(roundId, {
      type: 'empty_response',
      ts: new Date().toISOString(),
      meetingRound: true,
      payload: { iteration: 1 },
    });
    await history.appendEvidence(roundId, {
      type: 'ledger_stub_echo',
      ts: new Date().toISOString(),
      meetingRound: false,
      payload: {
        path: 'docs/a.md',
        coverage: { coverStart: 1, coverEnd: 3, totalLines: 10 },
        request: {},
      },
    });
    await history.appendAssistant('回答', roundId);

    // 收场（appendAssistant 以 pendingRounds 对象落盘）后证据仍在 = 挂载与收场同一对象链
    const round = roundStore.getById(roundId);
    expect(round?.evidence?.map((e) => e.type)).toEqual(['empty_response', 'ledger_stub_echo']);
  });

  it('轮缺失时 warn 丢弃、不新建轮（证据缺失不伪造第二轨道补写）', async () => {
    const { history, roundStore } = createRoundBackedHistory();
    await history.appendEvidence('round-not-exist', {
      type: 'empty_response',
      ts: new Date().toISOString(),
      meetingRound: false,
      payload: { iteration: 0 },
    });
    expect(roundStore.size()).toBe(0);
  });
});

describe('MessageHistory · forkSession', () => {
  it('分叉后切换身份不能卡在旧日期：currentDate 锚定今天（与建键一致）', () => {
    // forkSession 走 getSessionMeta / getRoundIds / setRoundIds / updateSessionMeta
    const store = {
      loadMessages: () => [],
      listSessions: () => [],
      getRoundIds: () => ['r1', 'r2'],
      setRoundIds: vi.fn(),
      appendRoundId: () => {},
      appendRoundIds: () => {},
      createSession: () => {},
      deleteSession: () => {},
      getSessionMeta: () => ({
        sessionId: '2000-01-01-main',
        roundIds: ['r1', 'r2'],
        updatedAt: '2000-01-01T00:00:00Z',
        messageCount: 4,
      }),
      updateSessionMeta: vi.fn(),
      listSessionMetas: () => [],
    };
    // "昨天"会话内发起分叉：源会话日期 2000-01-01
    const history = new MessageHistory(store, '2000-01-01', 'main');
    const result = history.forkSession('r2');

    // 分叉键与当前身份同锚今天：写入不会漂到源会话旧日期（输入不自动刷新日期；
    // fork 显式锚定即唯一新建路径）
    expect(result.date).toBe(todayDate());
    expect(history.currentDateValue).toBe(todayDate());
    expect(history.currentSessionName).toBe(`${todayDate()}-${result.newSession}`);
    expect(store.setRoundIds).toHaveBeenCalledWith(
      `${todayDate()}-${result.newSession}`,
      ['r1', 'r2'],
    );
  });
});

describe('MessageHistory · forkSession 错误分支', () => {
  /** 捕获 forkSession 抛出的 MemoraError，返回 detail 用于断言具体原因 */
  function catchForkDetail(fn: () => unknown): string | undefined {
    try {
      fn();
      return undefined;
    } catch (e) {
      const err = e as { detail?: string };
      return err.detail;
    }
  }

  it('未注入 sessionStore 时抛错', () => {
    const history = new MessageHistory(undefined, '2026-01-01', 'main');
    expect(catchForkDetail(() => history.forkSession('r1'))).toContain('ISessionStore 未注入');
  });

  it('当前会话不存在时抛错', () => {
    const store = new InMemorySessionStore(new InMemoryRoundStore());
    const history = new MessageHistory(store, '2026-01-01', 'main');
    expect(catchForkDetail(() => history.forkSession('r1'))).toContain('当前会话不存在');
  });

  it('当前会话无问答闭环时抛错', () => {
    const store = new InMemorySessionStore(new InMemoryRoundStore());
    store.createSession({ sessionId: '2026-01-01-main', updatedAt: 't', messageCount: 0 });
    const history = new MessageHistory(store, '2026-01-01', 'main');
    expect(catchForkDetail(() => history.forkSession('r1'))).toContain('无问答闭环');
  });

  it('分叉点 Round 不存在于会话时抛错', () => {
    const store = new InMemorySessionStore(new InMemoryRoundStore());
    store.createSession({ sessionId: '2026-01-01-main', updatedAt: 't', messageCount: 0 });
    store.setRoundIds('2026-01-01-main', ['r1', 'r2']);
    const history = new MessageHistory(store, '2026-01-01', 'main');
    expect(catchForkDetail(() => history.forkSession('r9'))).toContain('Round 不存在');
  });

  it('目标会话当天已存在时抛错', () => {
    const store = new InMemorySessionStore(new InMemoryRoundStore());
    store.createSession({ sessionId: '2026-01-01-main', updatedAt: 't', messageCount: 0 });
    store.setRoundIds('2026-01-01-main', ['r1']);
    // 预置一个"今天"的同名目标会话
    store.createSession({ sessionId: `${todayDate()}-dup`, updatedAt: 't2', messageCount: 0 });
    const history = new MessageHistory(store, '2026-01-01', 'main');
    expect(catchForkDetail(() => history.forkSession('r1', 'dup'))).toContain('已存在');
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

describe('MessageHistory · appendInterrupted（崩溃残留轮升级为 stop turn，T1）', () => {
  /** 构造「崩溃残局」：真实 Round/Session 存储 + 仅 appendUser 的中断轮（refCount=0、未登记会话） */
  function createCrashScene(): {
    roundStore: InMemoryRoundStore;
    sessionStore: InMemorySessionStore;
  } {
    const roundStore = new InMemoryRoundStore();
    const sessionStore = new InMemorySessionStore(roundStore);
    sessionStore.createSession({
      sessionId: `${todayDate()}-main`,
      messageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // 崩溃重启 = 新建 MessageHistory（共享同一存储单例，无 pendingRounds 缓存）——
    // 与宿主「重启后 Agent 重建、roundStore/sessionStore 为同一工作区单例」等价
    return { roundStore, sessionStore };
  }

  it('中断轮（带恢复文本）升级为 interrupted：写 assistantMessage（含中断标记）+ refCount 0→1 + 入 roundIds', async () => {
    const { roundStore, sessionStore } = createCrashScene();
    const roundId = generateRoundId();
    const first = new MessageHistory(sessionStore, todayDate(), 'main', roundStore);
    // 崩溃前形态：appendUser 后 pending（refCount=0），宿主 step 检查点已落盘 processEvents
    await first.appendUser('帮我梳理架构', roundId);
    roundStore.getById(roundId)!.refCount = 0;

    // 重启后打捞升级：宿主从 narrate 派生文本 → 内核收场
    const restarted = new MessageHistory(sessionStore, todayDate(), 'main', roundStore);
    await restarted.appendInterrupted(roundId, { content: '已整理出一版草稿' });

    const round = roundStore.getById(roundId)!;
    expect(round.status).toBe('interrupted');
    expect(round.completedAt).toBeDefined();
    // 收场文本 = 恢复内容 + 默认中断标记（与运行期中断收场默认文案同源 SSOT）
    expect(round.assistantMessage?.content).toBe(
      '已整理出一版草稿' + LOOP_CONSTANTS.DEFAULT_INTERRUPTED_MARK,
    );
    expect(round.refCount).toBe(1);
    expect(sessionStore.getRoundIds(`${todayDate()}-main`)).toContain(roundId);
  });

  it('无恢复文本的中断轮仍按 stop 语义收场：interrupted 但无 assistantMessage，照样登记会话', async () => {
    const { roundStore, sessionStore } = createCrashScene();
    // 工具阶段崩溃：无任何 narrate 文本，processEvents 仅有 tool 事件
    const roundId = generateRoundId();
    const first = new MessageHistory(sessionStore, todayDate(), 'main', roundStore);
    await first.appendUser('执行任务', roundId);
    const stored = roundStore.getById(roundId)!;
    stored.processEvents = [
      {
        type: 'tool_start',
        seq: 1,
        ts: new Date().toISOString(),
        payload: { toolCallId: 't1', name: 'web_search' },
      },
    ];
    roundStore.save(stored);

    const restarted = new MessageHistory(sessionStore, todayDate(), 'main', roundStore);
    await restarted.appendInterrupted(roundId, { content: '' });

    const round = roundStore.getById(roundId)!;
    expect(round.status).toBe('interrupted');
    expect(round.assistantMessage).toBeUndefined(); // §一·五：无摘要也按 stop 语义收场
    expect(round.refCount).toBe(1);
    expect(sessionStore.getRoundIds(`${todayDate()}-main`)).toContain(roundId);
    // processEvents 原样保留（宿主 step 检查点落盘数据不被升级破坏）
    expect(round.processEvents?.[0]?.type).toBe('tool_start');
  });

  it('轮缺失：防御性降级，不抛错、不登记', async () => {
    const { roundStore, sessionStore } = createCrashScene();
    const restarted = new MessageHistory(sessionStore, todayDate(), 'main', roundStore);
    await expect(
      restarted.appendInterrupted('round-does-not-exist', { content: '任意' }),
    ).resolves.toBeUndefined();
    expect(sessionStore.getRoundIds(`${todayDate()}-main`)).toEqual([]);
    expect(roundStore.size()).toBe(0);
  });

  it('重复升级幂等：不二次登记 roundIds、refCount 不虚增（T3 宿主不双重复放的底座）', async () => {
    const { roundStore, sessionStore } = createCrashScene();
    const roundId = generateRoundId();
    const first = new MessageHistory(sessionStore, todayDate(), 'main', roundStore);
    await first.appendUser('问题', roundId);

    const restarted = new MessageHistory(sessionStore, todayDate(), 'main', roundStore);
    await restarted.appendInterrupted(roundId, { content: '回答' });
    // 宿主 once-guard 异常/双 ready 时的防御重跑：
    await restarted.appendInterrupted(roundId, { content: '回答' });
    await restarted.appendInterrupted(roundId, { content: '回答' });

    const ids = sessionStore.getRoundIds(`${todayDate()}-main`);
    expect(ids.filter((id) => id === roundId)).toHaveLength(1); // 只登记一次
    expect(roundStore.getById(roundId)!.refCount).toBe(1); // refCount 不虚增
  });
});
