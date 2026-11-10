/**
 * 会话锁生命周期测试（审查 B1 + E4 批 3：按会话长持有 / 三类关闭场景）
 *
 * 立此用例的伤：`onDidDispose` 原本只解事件订阅、不放锁，`releaseAllSessionLocks` 生产零调用
 * ⇒ 面板关掉后当前会话的锁一直被本进程占着，另一个窗口永远打不开该会话（静默，无任何提示）。
 *
 * 批 3 口径（②A：空闲也持锁）：面板为**每个进入过的会话**长持有锁，切走不放；
 * 只有「删除实例 close 之后 / 视图销毁 / 停用」三种场景归还。本文件逐条钉住：
 *   ① dispose（无流）→ 放锁 + 重开重取，不注销、不 close 实例；
 *   ② 切会话 → 旧会话锁仍被本窗口持有，旧实例仍在登记表；
 *   ③ 后台流中切换 → 锁不提前释放（旧流还在写盘）；
 *   ④ 删非当前会话 → 注销 + close 后放锁；删当前会话 → 拒绝删除守卫仍在；
 *   ⑤ dispose（有流）→ 只挂起放锁（流收场后才归还），实例零注销零 close；
 *   ⑥ `releaseAllSessionLocks`（deactivate 的收尾入口）一次归还全部；
 *   ⑦ 删除会话 ⇒ 会话级内存僵尸（ask 在途 / 确认队列 / 流运行态）同步清理，
 *     删除后该会话不再出现在活跃度快照（入口角标 / 列表待处理）。
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
/** l10n.t 替身：{0}/{1} 占位符按参替换（vi.hoisted——mock 工厂先于 import 执行，import 绑定不可用） */
const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]): string => {
  let out = msg;
  args.forEach((arg, i) => {
    out = out.replaceAll(`{${i}}`, String(arg));
  });
  return out;
});

vi.mock('vscode', async () => {
  const uri = {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    file: (p: string) => ({ fsPath: p, toString: () => 'mock://file' }),
    fsPath: '/mock/path',
  };
  return {
    l10n: { t: tStub },
    Uri: uri,
    // render() 读 vscode.env.language 决定 HTML lang（缺则报「No env export」）
    env: { language: 'zh-cn' },
    window: {
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      activeTextEditor: undefined,
      // 删除会话的确认框走 confirmModal（唯一入口）：恒返回确认文案 = 用户点了「删除」
      showWarningMessage: vi.fn(async () => 'Delete'),
      // 装配失败出口（正常路径不触发）
      showErrorMessage: vi.fn(async () => undefined),
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

/**
 * agent 桩：只补「面板 ready / 换绑 / 删除联动」会碰到的成员（其余留空，缺则被各调用点兜住）
 *
 * @param sessionId 该实例所属会话（`agentForSession` 装配即调 `bindSession` 注入确认回调，
 *   这里把回调按会话登记，供用例手动触发一条「内核发起、宿主待确认」的请求）
 * @param confirmHandlers 会话 → 已注入确认回调（删除用例据此造出待确认状态）
 */
function agentStub(
  sessionId: string,
  confirmHandlers: Map<string, (info: unknown) => Promise<boolean>>,
): Agent {
  return {
    sessionManager: { switchToSession: vi.fn().mockResolvedValue(0), renameSession: vi.fn() },
    memory: { softDeleteRoundSummaries: vi.fn().mockReturnValue(0) },
    // 确认回调注入口（ConfirmCoordinator.bindSession 消费；捕获后由用例调用）
    security: {
      onWriteConfirmation: (h: (info: unknown) => Promise<boolean>) => {
        confirmHandlers.set(sessionId, h);
      },
      // bindAgent 会同时订阅安全审计（缺则 `guard.onAudit is not a function`）；
      // 返回值必须是「取消订阅函数」本身（生产直接调用 `_securityAuditUnsub()`）
      onAudit: vi.fn(() => vi.fn()),
    },
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

/** 收尾器探针（只读内部持有集；放锁的时序判据要靠它，避免用「能否拿到锁」的异步猜） */
interface FinalizerProbe {
  holds(sessionId: string): boolean;
  onStreamEnd(sessionId: string): void;
}

describe('会话锁生命周期（按会话长持有 + 三类关闭场景）', () => {
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

    // 第二个会话（供「切会话 / 删非当前会话」用例）
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

    // 会话实例登记表替身（真源 = extension 的 AgentRegistry）：按会话各一台，删除即注销 + close
    const agents = new Map<string, Agent>();
    /** 已注销 + close 的会话（顺序 = 关闭发生顺序） */
    const closed: string[] = [];
    /** 会话 → 该实例上被注入的确认回调（删除用例据此造出「内核发起、宿主待确认」状态） */
    const confirmHandlers = new Map<string, (info: unknown) => Promise<boolean>>();
    provider.setAgentFactory(async (_projectPath, sid) => {
      const existing = agents.get(sid);
      if (existing) return existing;
      const agent = agentStub(sid, confirmHandlers);
      agents.set(sid, agent);
      return agent;
    });
    provider.setAgentReleaser(async (sid) => {
      closed.push(sid);
      agents.delete(sid);
    });

    const currentSessionId = () =>
      (provider as unknown as { _currentSessionId: string })._currentSessionId;
    /** 探针：会话流运行态（流中会话销毁时锁应挂起） */
    const runtimeOf = (sid: string): { streaming: boolean } =>
      (provider as unknown as { runtimeFor(id: string): { streaming: boolean } }).runtimeFor(sid);
    /** 探针：锁收尾器（读持有集 / 模拟流收场入口） */
    const finalizer = (provider as unknown as { _lockFinalizer: FinalizerProbe })._lockFinalizer;

    return {
      storeA,
      storeB,
      provider,
      sessionId,
      secondId,
      currentSessionId,
      agents,
      closed,
      runtimeOf,
      finalizer,
      confirmHandlers,
    };
  }

  /** 打开面板并等到 ready 链路完成（history_loaded 是回放末尾的完成信号） */
  async function openReady(provider: MemoraChatViewProvider) {
    const view = makeView();
    provider.resolveWebviewView(view.view as never, {} as never, {} as never);
    view.fireMessage({ type: 'ready' });
    await waitFor(() =>
      view.posted.some((m) => (m as { type?: string })?.type === 'history_loaded'),
    );
    return view;
  }

  it('视图 dispose（无流）：放锁 + 重开重取，且不注销、不 close 任何实例', async () => {
    const { storeB, provider, sessionId, currentSessionId, agents, closed } = await setup();

    // ① 首次打开：resolve + ready ⇒ 面板拿到会话（并持有跨进程锁）
    const view1 = await openReady(provider);
    expect(currentSessionId()).toBe(sessionId);
    // 另一窗口此时拿不到（本面板长持有）——这是「拒绝门」的正向判据
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);

    // ② 面板销毁（折叠/关闭）：必须归还锁 + 清空当前会话标识；实例归登记表所有 ⇒ 零注销零 close
    view1.fireDispose();
    expect(currentSessionId()).toBe('');
    expect(closed).toEqual([]);
    expect(agents.has(sessionId)).toBe(true);
    expect(await storeB.acquireSessionLock(sessionId)).toBe(true);
    // B 用完还回去，避免影响下一步
    storeB.releaseSessionLock(sessionId);

    // ③ 重新展开（VS Code 会重新 resolveWebviewView + 新 webview 再发 ready）：
    //    必须自动回到同一个会话并重新拿到锁（不是落到别的会话/新建空会话）
    await openReady(provider);
    expect(currentSessionId()).toBe(sessionId);
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);
  });

  it('切换会话后：旧会话锁仍被本窗口持有，旧实例仍在登记表', async () => {
    const { storeB, provider, sessionId, secondId, currentSessionId, agents, closed } =
      await setup();

    await openReady(provider);
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);

    // 切到第二个会话（B 为本面板新建/取用一次实例）
    await provider.switchToSession(secondId);
    expect(currentSessionId()).toBe(secondId);
    expect(agents.has(secondId)).toBe(true);

    // ②A：新会话被本面板持有；**旧会话也没放锁**（切走不放，旧实例还在写盘）
    expect(await storeB.acquireSessionLock(secondId)).toBe(false);
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);
    // 旧实例零改动：仍在登记表、未被注销 close
    expect(agents.has(sessionId)).toBe(true);
    expect(closed).toEqual([]);
  });

  it('后台流中切换会话：锁不提前释放（旧流还在写盘）', async () => {
    const { storeB, provider, sessionId, secondId, currentSessionId, runtimeOf } = await setup();

    await openReady(provider);
    // 模拟：旧会话仍在流式写盘（streaming = 流归属会话的运行态真源）
    runtimeOf(sessionId).streaming = true;

    await provider.switchToSession(secondId);
    expect(currentSessionId()).toBe(secondId);
    // 旧流没结束前，旧会话锁必须仍被本窗口持有（否则另一窗口可接管后写冲突）
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);
    expect(await storeB.acquireSessionLock(secondId)).toBe(false);
  });

  it('删除非当前会话：注销 + close 后该会话锁释放；删除当前会话被守卫拒绝', async () => {
    const { storeA, storeB, provider, sessionId, secondId, agents, closed } = await setup();

    await openReady(provider);
    // 进入过 secondId（面板因此长持有它的锁）再切回 sessionId
    await provider.switchToSession(secondId);
    await provider.switchToSession(sessionId);
    expect(agents.has(secondId)).toBe(true);

    // 关闭（删除）非当前会话：确认框 → 删除 → 注销 + close → 放该会话长锁
    const view = makeView();
    provider.resolveWebviewView(view.view as never, {} as never, {} as never);
    view.fireMessage({ type: 'delete_session', sessionId: secondId });
    await waitFor(() => agents.has(secondId) === false);
    expect(closed).toEqual([secondId]);
    // 会话元数据已删除，实例已注销，锁已归还（另一窗口可接管）
    expect(storeA.getSessionMeta(secondId)).toBeUndefined();
    expect(await storeB.acquireSessionLock(secondId)).toBe(true);
    storeB.releaseSessionLock(secondId);
    // 当前会话不受牵连：实例仍在、锁仍被本面板持有
    expect(agents.has(sessionId)).toBe(true);
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);

    // 删除当前会话：拒绝删除守卫仍在（提示 + 元数据保留 + 锁不放）
    view.fireMessage({ type: 'delete_session', sessionId });
    await waitFor(() =>
      view.posted.some(
        (m) =>
          (m as { type?: string; message?: string })?.type === 'notice' &&
          (m as { message?: string })?.message ===
            'The current session is not in history and cannot be deleted',
      ),
    );
    expect(storeA.getSessionMeta(sessionId)).toBeDefined();
    expect(closed).toEqual([secondId]);
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);
  });

  it('删除会话清理会话级内存僵尸：ask 在途 / 确认队列 / 流运行态（E4 批 3）', async () => {
    const { provider, sessionId, secondId, agents, confirmHandlers } = await setup();

    await openReady(provider);
    // 进入过 secondId 再切回：面板为该会话建好实例（装配即 `bindSession` 注入确认回调）
    await provider.switchToSession(secondId);
    await provider.switchToSession(sessionId);

    // 私有面探针（三处清理面都在 chatPanel 实例上按会话持有）
    const cast = provider as unknown as {
      _asks: Map<string, unknown>;
      _runtime: { get(id: string): unknown; peek(id: string): unknown };
      _confirm: { pendingCount(id: string): number };
      askFor(id: string): { setPending(q: unknown[]): void };
    };
    // 造三处僵尸：① ask 在途提问；② 待确认请求；③ 流运行态记录
    cast.askFor(secondId).setPending([{ slot: 's1', question: '继续吗？' }]);
    const handler = confirmHandlers.get(secondId);
    expect(handler).toBeTypeOf('function');
    const confirmed = handler!({
      tool: 'write_file',
      targetPath: '/mock/workspace/second.md',
      description: '写入 second.md',
      permission: 'confirm',
      beforeContent: null,
      afterContent: 'x',
      hasDiff: true,
    });
    cast._runtime.get(secondId);
    // 删除前：三处记录都活着（确认计数亮 + ask 待答）
    expect(cast._confirm.pendingCount(secondId)).toBe(1);
    expect(cast._asks.has(secondId)).toBe(true);
    expect(cast._runtime.peek(secondId)).toBeDefined();

    // 删除该会话（非当前会话 ⇒ 删除守卫放行）
    const view = makeView();
    provider.resolveWebviewView(view.view as never, {} as never, {} as never);
    view.fireMessage({ type: 'delete_session', sessionId: secondId });
    // 等清理面落地（运行态摘除是删除路径最后一步，其后紧接活跃度重推）
    await waitFor(() => cast._runtime.peek(secondId) === undefined);

    // 三处清理面：ask 协调器摘除、确认队列整会话丢弃、运行态摘除
    expect(agents.has(secondId)).toBe(false);
    expect(cast._asks.has(secondId)).toBe(false);
    expect(cast._confirm.pendingCount(secondId)).toBe(0);
    // 未裁决的确认请求按 fail-closed 终结（内核不会永久挂在已删会话上）
    await expect(confirmed).resolves.toBe(false);

    // 可观测判据：删除后该会话不再出现在活跃度快照（入口角标 / 列表待处理）
    const snapshots = view.posted.filter(
      (m) => (m as { type?: string })?.type === 'session_activity',
    ) as Array<{ pendingIds: string[]; runningIds: string[]; badgeCount: number }>;
    const last = snapshots.at(-1);
    expect(last).toBeDefined();
    expect(last!.pendingIds).not.toContain(secondId);
    expect(last!.runningIds).not.toContain(secondId);
    expect(last!.badgeCount).toBe(0);
  });

  it('视图 dispose（有后台流）：只挂起放锁，流收场后才归还；实例零注销零 close', async () => {
    const { storeB, provider, sessionId, secondId, agents, closed, runtimeOf, finalizer } =
      await setup();

    await openReady(provider);
    // 面板先进入过两个会话（各长持一把锁），再停在 secondId 上
    await provider.switchToSession(secondId);
    await provider.switchToSession(sessionId);
    await provider.switchToSession(secondId);

    // 模拟 sessionId 的后台流仍在写盘
    runtimeOf(sessionId).streaming = true;
    const view = await openReady(provider);
    view.fireDispose();

    // 不注销、不 close（实例归登记表所有；视图折叠/重开不得造成 use-after-close）
    expect(closed).toEqual([]);
    expect(agents.has(sessionId)).toBe(true);
    expect(agents.has(secondId)).toBe(true);
    // 非流会话立即归还；流中会话挂起（收尾器持有集仍在）
    expect(finalizer.holds(secondId)).toBe(false);
    expect(await storeB.acquireSessionLock(secondId)).toBe(true);
    storeB.releaseSessionLock(secondId);
    expect(finalizer.holds(sessionId)).toBe(true);
    expect(await storeB.acquireSessionLock(sessionId)).toBe(false);

    // 流收场（consumeFlow 末尾：streaming 先落 false，再调 onStreamEnd）⇒ 此时才归还
    runtimeOf(sessionId).streaming = false;
    finalizer.onStreamEnd(sessionId);
    expect(finalizer.holds(sessionId)).toBe(false);
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
