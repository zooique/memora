/**
 * 会话锁生命周期测试（审查 B1：面板销毁必须归还长持有的跨进程会话锁，重开必须能重新拿回）
 *
 * 立此用例的伤：`onDidDispose` 原本只解事件订阅、不放锁，`releaseAllSessionLocks` 生产零调用
 * ⇒ 面板关掉后当前会话的锁一直被本进程占着，另一个窗口永远打不开该会话（静默，无任何提示）。
 *
 * 判据实现：两个**独立** `WorkspaceSessionStore` 实例各持一条跨进程命名管道来模拟两个窗口——
 * 第二个实例 `acquireSessionLock` 能拿到 = 第一个实例已经真正放锁。同进程两实例与真实两窗口
 * 判据一致（`sessionLock.ts` 的持有者是**实例**，不是进程）。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Agent, Round } from '@zooique/memora';
import { makeTempDir } from '../../__tests__/helpers/tmpDir.js';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

// mock vscode：仅提供 chatPanel 在本用例触发路径上用到的最小 API
vi.mock('vscode', async () => {
  const uri = {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    file: (p: string) => ({ fsPath: p, toString: () => 'mock://file' }),
    fsPath: '/mock/path',
  };
  return {
    Uri: uri,
    // render() 读 vscode.env.language 决定 HTML lang（缺则报「No env export」）
    env: { language: 'zh-cn' },
    window: {
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
      onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      asRelativePath: (u: { fsPath: string }) => u.fsPath,
    },
  };
});

/** agent 桩：只补「面板 ready 路径」会碰到的成员（其余留空，缺则被 handleWebviewReady 的 catch 兜住） */
function agentStub(): Agent {
  return {
    sessionManager: { switchToSession: vi.fn().mockResolvedValue(0), renameSession: vi.fn() },
    memory: { softDeleteRoundSummaries: vi.fn().mockReturnValue(0) },
    on: vi.fn(),
    off: vi.fn(),
    isPausePending: () => false,
    getEffectiveMaxTokens: () => undefined,
    // ready 回放尾部 postPlanUpdate 会读 checkpoint（缺则未捕获异常污染用例）
    getCheckpoint: () => undefined,
    // ready 尾部的后台任务条补推（⑤）以注册表为真源
    listBackgroundTasks: () => [],
    // ⑥ 归档模式补推读 agent.config（缺则同样抛出）
    config: { archiveMode: 'full' },
    // ⑦ 归档模式运行时补推（ready 链路第 2272 行）
    getArchiveMode: () => 'full',
  } as unknown as Agent;
}

/** 可驱动的 webviewView 桩：记录 dispose 回调与消息回调，供用例手动触发 */
function makeView(): {
  view: unknown;
  fireDispose: () => void;
  fireMessage: (msg: unknown) => void;
  posted: unknown[];
} {
  let disposeCb: (() => void) | undefined;
  let messageCb: ((msg: unknown) => void) | undefined;
  const posted: unknown[] = [];
  const view = {
    webview: {
      asWebviewUri: () => ({ toString: () => 'mock://script' }),
      cspSource: 'mock://csp',
      options: {},
      html: '',
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        messageCb = cb;
        return { dispose: () => {} };
      },
    },
    onDidDispose: (cb: () => void) => {
      disposeCb = cb;
      return { dispose: () => {} };
    },
    onDidReceiveMessage: (cb: (msg: unknown) => void) => {
      messageCb = cb;
      return { dispose: () => {} };
    },
  };
  return {
    view,
    fireDispose: () => disposeCb?.(),
    fireMessage: (msg) => messageCb?.(msg),
    posted,
  };
}

/** 轮询等待条件成立（ready 链路是异步的：ensureAgent → claim → 回放） */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待超时：条件未成立');
}

describe('会话锁生命周期（面板销毁归还 / 重开重取）', () => {
  /** 一套「两窗口」环境：A = 面板所在 store，B = 另一个窗口的 store */
  async function setup() {
    const dir = makeTempDir('memora-lock-lifecycle-');
    const roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    // A：面板所在进程；启用跨进程锁（生产装配同款）
    const storeA = new WorkspaceSessionStore(dir, roundStore);
    storeA.load();
    storeA.enableCrossProcessLock();
    // B：另一个窗口（独立实例 ⇒ 独立命名管道）
    const storeB = new WorkspaceSessionStore(dir, roundStore);
    storeB.load();
    storeB.enableCrossProcessLock();

    // 种一个会话（含一轮问答），并让「上次停留」指向它
    const sessionId = '2026-11-06-lockcase';
    const round: Round = {
      id: 'round-lock-1',
      userMessage: {
        id: 'round-lock-1-user',
        role: 'user',
        content: '你好',
        timestamp: '2026-11-06T01:00:00.000Z',
      },
      assistantMessage: {
        id: 'round-lock-1-assistant',
        role: 'assistant',
        content: '你好，我在',
        timestamp: '2026-11-06T01:00:01.000Z',
      },
      status: 'complete',
      createdAt: '2026-11-06T01:00:00.000Z',
      completedAt: '2026-11-06T01:00:01.000Z',
      refCount: 1,
    };
    roundStore.save(round);
    storeA.createSession({
      sessionId,
      displayName: 'lockcase',
      updatedAt: '2026-11-06T01:00:01.000Z',
      messageCount: 0,
    });
    storeA.appendRoundId(sessionId, round.id);
    storeA.setLastActiveSession(sessionId);

    // 第二个会话（供「切会话后旧锁必须归还」用例）
    const secondId = '2026-11-06-lockcase-2';
    storeA.createSession({
      sessionId: secondId,
      displayName: 'lockcase-2',
      updatedAt: '2026-11-06T01:30:00.000Z',
      messageCount: 0,
    });

    const provider = new MemoraChatViewProvider(
      { fsPath: '/mock/uri' } as never,
      storeA,
      {
        listMasked: async () => [],
        getActiveName: () => undefined,
        getActive: async () => undefined,
      } as never,
      '/mock/workspace',
      undefined,
    );
    provider.setAgentFactory(async () => agentStub());
    const currentSessionId = () =>
      (provider as unknown as { _currentSessionId: string })._currentSessionId;

    return { storeA, storeB, provider, sessionId, secondId, currentSessionId };
  }

  it('面板销毁后释放锁，重开面板（再次 resolve + ready）重新拿回同一会话的锁', async () => {
    const { storeB, provider, sessionId, currentSessionId } = await setup();

    // ① 首次打开：resolve + ready ⇒ 面板拿到会话（并持有跨进程锁）
    const view1 = makeView();
    provider.resolveWebviewView(view1.view as never, {} as never, {} as never);
    view1.fireMessage({ type: 'ready' });
    // ready 链路是异步的（ensureAgent → claimInitialSessionOwnership → 回放），
    // `history_loaded` 是回放末尾的消息 ⇒ 以它为「claim 已完成」的完成信号
    await waitFor(() =>
      view1.posted.some((m) => (m as { type?: string })?.type === 'history_loaded'),
    );
    expect(currentSessionId()).toBe(sessionId);
    // 另一窗口此时拿不到（本面板长持有）——这是「拒绝门」的正向判据
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);

    // ② 面板销毁（折叠/关闭）：必须归还锁 + 清空当前会话标识
    view1.fireDispose();
    expect(currentSessionId()).toBe('');
    expect(await storeB.acquireSessionLock(sessionId)).toBe(true);
    // B 用完还回去，避免影响下一步
    storeB.releaseSessionLock(sessionId);

    // ③ 重新展开（VS Code 会重新 resolveWebviewView + 新 webview 再发 ready）：
    //    必须自动回到同一个会话并重新拿到锁（不是落到别的会话/新建空会话）
    const view2 = makeView();
    provider.resolveWebviewView(view2.view as never, {} as never, {} as never);
    view2.fireMessage({ type: 'ready' });
    await waitFor(() =>
      view2.posted.some((m) => (m as { type?: string })?.type === 'history_loaded'),
    );
    expect(currentSessionId()).toBe(sessionId);
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);
  });

  it('切会话 = 先拿新锁、成功后才放旧锁（旧会话对其他窗口立即可用）', async () => {
    const { storeB, provider, sessionId, secondId, currentSessionId } = await setup();

    // 打开面板并停在 sessionId 上（长持有其锁）
    const view = makeView();
    provider.resolveWebviewView(view.view as never, {} as never, {} as never);
    view.fireMessage({ type: 'ready' });
    await waitFor(() =>
      view.posted.some((m) => (m as { type?: string })?.type === 'history_loaded'),
    );
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);

    // 切到第二个会话
    await provider.switchToSession(secondId);
    expect(currentSessionId()).toBe(secondId);

    // 新会话被本面板持有 ⇒ 另一窗口拿不到；旧会话已归还 ⇒ 拿得到
    expect(await storeB.acquireSessionLock(secondId)).toBe(false);
    expect(await storeB.acquireSessionLock(sessionId)).toBe(true);
  });

  it('releaseAllSessionLocks（deactivate 的收尾入口）一次归还全部持有的锁', async () => {
    const { storeA, storeB, sessionId, secondId } = await setup();
    // 面板外也要能持有多把（长持有 + 一次性短锁同族）
    expect(await storeA.acquireSessionLock(sessionId)).toBe(true);
    expect(await storeA.acquireSessionLock(secondId)).toBe(true);
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);
    expect(await storeB.acquireSessionLock(secondId)).toBe(false);

    storeA.releaseAllSessionLocks();

    expect(await storeB.acquireSessionLock(sessionId)).toBe(true);
    expect(await storeB.acquireSessionLock(secondId)).toBe(true);
  });
});
