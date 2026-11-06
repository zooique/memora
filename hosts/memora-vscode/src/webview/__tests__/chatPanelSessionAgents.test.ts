/**
 * E4 批 2 · 面板侧「按会话取实例 / 流中切换隔离 / 后台投影闸」验收测试
 *
 * 批 2 把「一个面板一台 Agent」改成「每会话一台实例，切换 = 换绑显示源」，本文件钉住五条
 * 机器判据（与台账 BG-SESS-RUN-1 的批 2 判据一一对应）：
 *
 *  ① 切换不关闭旧实例：切走 A 后 A 的 `close()` 零调用，且 A 仍在本地投影表里；
 *  ② 切回取到**同一实例**：第三次进入同一会话不再触发装配（工厂调用次数不增）；
 *  ③ 流中切换隔离：A 在跑流时切到 B（并改动 B 的运行态），A 的
 *     `streaming` / `abortController` / `liveBuffer` 三项引用与值都不变；
 *  ④ 后台投影闸：A 切走后产生的过程/正文投递**零上屏**（`postTurnUpdate` 等整批丢弃），
 *     切回时由 replay 重建（本条只验「不再串台」，重建归既有 replay 用例）；
 *  ⑤ 状态独立：切换后 A 后台仍 `streaming=true`，B 的值为 B 自己的（互不继承）。
 *
 * ⚠ 变异验证靶标（写在本文件是为了「删掉保护后必须转红」）：
 *   · 把 `consumeFlow` 里的 `this._sessionAgents.get(sessionId) ?? this._agent` 改回
 *     `const agent = this._agent`（共享实例）→ 「流失控面」用例转红；
 *   · 把 `isBackgroundFlow()` 恒返回 false → 「后台投影闸」用例转红。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
// 临时目录统一入口：建目录 + 模块顶层注册清理（禁止裸 mkdtempSync）
import { makeTempDir } from '../../__tests__/helpers/tmpDir.js';
import type { Agent, BackgroundTask } from '@zooique/memora';
import type * as vscode from 'vscode';
import { ProviderStore } from '../../extension/providers/providerStore.js';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

vi.mock('vscode', async () => ({
  // 视图重开走真实 render（buildHtmlHead 读 vscode.env.language）
  env: { language: 'zh-cn' },
  Uri: {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    // 视图重开走真实 `resolveWebviewView`：其 localResourceRoots 会调 Uri.file（附件磁盘预览）
    file: (p: string) => ({ fsPath: p, toString: () => p }),
    fsPath: '/mock/path',
  },
  window: {
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    // 交互提醒读窗口聚焦态（真实 adapter 会访问 window.state.focused）
    state: { focused: true },
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
    // 视图重开走真实 resolveWebviewView：活动文件跟踪会重注册这两个订阅
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

/** 过程 chunk 形态（与内核 AgentChunk 的宿主消费面同形；只取本文件用到的字段） */
type Chunk = { type: string; roundId: string; [k: string]: unknown };

/** 会话 Agent 替身的声明面：强制消费字段 + 本文件要断言的三个 spy 面 */
type SessionAgentStub = Agent & {
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
};

/**
 * 会话 Agent 替身（字段按 chatPanel 的强制消费面逐项补齐）
 *
 * @param label 会话标识（用于断言「取回的是同一个对象」）
 * @param flow  该替身的流工厂（未给 = 空流，用于只做切换的用例）
 * @param backgroundTasks 该会话实例后台任务注册表的观察值（切会话重投影用例据此区分两会话）
 */
function sessionAgent(
  label: string,
  flow?: () => AsyncGenerator<Chunk>,
  backgroundTasks: readonly BackgroundTask[] = [],
): SessionAgentStub {
  return {
    label,
    chat: () => flow?.() ?? (async function* () {})(),
    close: vi.fn(async () => {}),
    sessionManager: {
      status: 'running',
      getCurrentSessionInfo: () => {
        const [date, session] = label.split(/-(?=[^ -]+$)/);
        return { date, session };
      },
      switchToSession: async () => 0,
    },
    getMetrics: () => ({
      llm: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        emptyResponseCount: 0,
        truncationRecoveryCount: 0,
      },
      tools: { callCount: 0, failureCount: 0, unparsedToolIntentCount: 0 },
      context: { occupancy: { usedTokens: 0, windowTokens: 0, ratio: 0 } },
    }),
    getCheckpoint: () => null,
    // 视图重开走真实 ready 链路：归档模式运行时时值补推（⑥）会读它
    getArchiveMode: () => 'full',
    isPausePending: () => false,
    getEffectiveMaxTokens: () => undefined,
    getPendingInterjections: () => [],
    clearPendingInterjections: () => [],
    removePendingInterjections: () => [],
    listBackgroundTasks: () => backgroundTasks,
    memory: { softDeleteRoundSummaries: vi.fn() },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as SessionAgentStub;
}

/** 面板句柄：真实 provider + 捕获的投递列表 + 私有面入口 */
interface PanelHandle {
  provider: MemoraChatViewProvider;
  posted: { type: string; message?: string; state?: unknown; text?: string }[];
  /** 触发当前视图的 onDidDispose（等价 VS Code 关闭/折叠侧边栏视图） */
  disposeView: () => void;
  /** 以真实 `resolveWebviewView` 重开视图（新 webview 实例 + 代数自增 + 重新装配订阅） */
  reopenView: () => void;
  /** 以当前视图的消息入口发一条 webview → extension 消息（等价脚本就绪发 ready） */
  fireMessage: (msg: unknown) => void;
  cast: {
    _agent?: Agent;
    _currentSessionId: string;
    _sessionAgents: Map<string, Agent>;
    _asks: Map<string, unknown>;
    runtimeFor(sessionId?: string): {
      streaming: boolean;
      abortController?: AbortController;
      liveBuffer?: { textByRound: Map<string, string> };
    };
    runFlow(
      factory: (signal: AbortSignal) => AsyncGenerator<Chunk>,
      seed?: undefined,
      sessionId?: string,
    ): Promise<void>;
    /** 取某会话的 ask 协调器（生产私有面；测试直驱待处理状态变化） */
    askFor(sessionId?: string): {
      setPending(questions: { slot: string; question: string }[]): void;
      clearPending(): void;
      pendingQuestions(): unknown[];
    };
  };
}

/**
 * 建面板（真实 sessionStore / roundStore / ProviderStore，只替身 webview 与 Agent）
 *
 * @param agents 预登记的会话实例（键 = 会话 id；模拟「此前已装配过」）
 * @param seedSessionIds 预写入会话存储的会话 id（首个置为 lastActive）——
 *        视图 dispose 会清空 `_currentSessionId`，重开时生产按 `getInitialSessionId()`
 *        派生；不落盘就没有「重开回到原会话」的真实路径。
 */
function setupPanel(
  agents: Record<string, Agent> = {},
  seedSessionIds: readonly string[] = [],
): PanelHandle {
  const dir = makeTempDir('memora-e4-b2-');
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  // 会话存储播种（重开路径依赖 getInitialSessionId，见 @param 说明）
  for (const sessionId of seedSessionIds) {
    store.createSession({
      sessionId,
      displayName: sessionId,
      updatedAt: '2026-11-06T10:00:00.000Z',
      messageCount: 0,
    });
  }
  if (seedSessionIds.length > 0) store.setLastActiveSession(seedSessionIds[0]);
  const secrets = {
    get: async () => undefined,
    store: async () => {},
    delete: async () => {},
    onDidChange: () => ({ dispose: () => {} }),
  } as unknown as vscode.SecretStorage;
  const provider = new MemoraChatViewProvider(
    { fsPath: '/mock/uri' } as never,
    store,
    new ProviderStore(secrets) as never,
    '/mock/workspace',
  );
  const posted: PanelHandle['posted'] = [];
  /**
   * 造一个视图替身并捕获其 `onDidDispose` 回调
   *
   * 真实路径要求：`disposeView` 触发的清理与 `reopenView` 走的 `resolveWebviewView`
   * 必须是生产同一份代码（因此视图对象形状按 vscode.WebviewView 的消费面逐项给齐）。
   */
  const makeView = () => {
    let onDispose: (() => void) | undefined;
    /** 生产消息入口回调（resolveWebviewView 注册；测试据此模拟 webview 发 ready） */
    let onMessage: ((msg: unknown) => void) | undefined;
    const view = {
      webview: {
        asWebviewUri: () => ({ toString: () => 'mock://script' }),
        options: {},
        html: '',
        cspSource: 'mock-csp',
        postMessage: (msg: never) => {
          posted.push(msg);
          return Promise.resolve(true);
        },
        // 生产 resolveWebviewView 在 webview 上订阅消息入口（不是视图对象上）
        onDidReceiveMessage: (cb: (msg: unknown) => void) => {
          onMessage = cb;
          return { dispose: () => {} };
        },
      },
      onDidDispose: (cb: () => void) => {
        onDispose = cb;
        return { dispose: () => {} };
      },
    };
    return {
      view,
      dispose: () => onDispose?.(),
      fireMessage: (msg: unknown) => onMessage?.(msg),
    };
  };
  const initial = makeView();
  // 首视图同样走生产 resolveWebviewView（否则 onDidDispose 里那段生产清理根本没有被注册，
  // 「关视图」就是空操作，实测结论不成立）
  provider.resolveWebviewView(
    initial.view as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken,
  );
  (provider as unknown as { _viewLoader: unknown })._viewLoader = () => [];
  // 视图重开：先按真实顺序触发旧视图 dispose，再以新视图走生产 resolveWebviewView
  let current = initial;
  const reopenView = (): void => {
    current.dispose();
    current = makeView();
    provider.resolveWebviewView(
      current.view as unknown as vscode.WebviewView,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken,
    );
  };
  const cast = provider as unknown as PanelHandle['cast'];
  for (const [sessionId, agent] of Object.entries(agents)) {
    cast._sessionAgents.set(sessionId, agent);
  }
  return {
    provider,
    posted,
    disposeView: () => current.dispose(),
    reopenView,
    fireMessage: (msg: unknown) => current.fireMessage(msg),
    cast,
  };
}

describe('E4 批 2 · 切换 = 换绑显示源（不换实例、不关闭旧实例）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('同会话反复进入 = 同一实例；不同会话 = 不同实例；切回不重新装配', async () => {
    const agentA = sessionAgent('2026-11-06-a');
    const agentB = sessionAgent('2026-11-06-b');
    const { provider, cast } = setupPanel();
    // 装配走面板注入的按会话工厂（生产 = agentRegistry.createAgentForSession）
    const factory = vi.fn(async (_projectPath: string, sessionId: string) =>
      sessionId === '2026-11-06-a' ? agentA : agentB,
    );
    provider.setAgentFactory(factory);

    await provider.switchToSession('2026-11-06-a');
    expect(provider.getCurrentAgent()).toBe(agentA);
    await provider.switchToSession('2026-11-06-b');
    expect(provider.getCurrentAgent()).toBe(agentB);
    expect(factory).toHaveBeenCalledTimes(2);
    // 旧实例不关闭：仍在投影表里（批 3 接清理面之前的既定状态）
    expect(agentA.close).not.toHaveBeenCalled();
    expect(cast._sessionAgents.get('2026-11-06-a')).toBe(agentA);

    // 切回 A：取回同一个旧实例，且**不再触发装配**（工厂次数不增）
    await provider.switchToSession('2026-11-06-a');
    expect(provider.getCurrentAgent()).toBe(agentA);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('E4 批 3 · 后台任务条随切换会话重投影（BGTASK-SWITCH-REPUSH-1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('切到另一会话 ⇒ 常驻条改显示该会话的任务，不残留上一个会话的清单', async () => {
    const agentA = sessionAgent('2026-11-06-a', undefined, [
      { taskId: 'bg-1', command: 'npm run build', startedAt: 1, status: 'running' },
    ]);
    const agentB = sessionAgent('2026-11-06-b', undefined, [
      { taskId: 'bg-9', command: 'npm test', startedAt: 2, status: 'running' },
    ]);
    const { provider, posted } = setupPanel();
    provider.setAgentFactory(async (_projectPath, sessionId) =>
      sessionId === '2026-11-06-a' ? agentA : agentB,
    );
    /** 取最后一条后台任务快照的任务 id（空列表 = 常驻条隐藏） */
    const lastTaskIds = () => {
      const msgs = posted.filter((m) => m.type === 'background_tasks') as unknown as Array<{
        items: Array<{ taskId: string }>;
      }>;
      return msgs.at(-1)?.items.map((i) => i.taskId);
    };

    await provider.switchToSession('2026-11-06-a');
    // 起点：把 A 的注册表内容推上屏（等价 ready / step_boundary 这一既有推送时机）
    (provider as unknown as { postBackgroundTasks(): void }).postBackgroundTasks();
    expect(lastTaskIds()).toEqual(['bg-1']);

    await provider.switchToSession('2026-11-06-b');
    // 判据：切换完成即按 B 的注册表重投影（不推则常驻条停留 A 的 bg-1）
    expect(lastTaskIds()).toEqual(['bg-9']);
  });
});

describe('E4 批 2 · 流中切换隔离（A 跑流时切到 B）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('A 的 streaming / abortController / liveBuffer 不被 B 的操作改动，且后台投递零上屏', async () => {
    // 门闩流：yield thinking 后挂起，等用例切到 B 再续（模拟「后台继续跑」）
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const roundId = 'round-A';
    const flow = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        reachedGate();
        await gate;
        yield { type: 'text', content: 'A 的后台正文', roundId };
        yield { type: 'step_boundary', roundId };
      })();
    };
    const agentA = sessionAgent('2026-11-06-a', flow);
    const agentB = sessionAgent('2026-11-06-b');
    const { cast, posted } = setupPanel({ '2026-11-06-a': agentA, '2026-11-06-b': agentB });
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;

    // 起 A 的流（sessionId 缺省 = 当前会话 A）
    const running = cast.runFlow(() => flow());
    await atGate;

    // 切走前记下 A 的三项失控面
    const runtimeA = cast.runtimeFor('2026-11-06-a');
    const abortA = runtimeA.abortController;
    const bufferA = runtimeA.liveBuffer;
    expect(runtimeA.streaming).toBe(true);
    expect(abortA).toBeInstanceOf(AbortController);
    expect(bufferA).toBeDefined();
    const postedBeforeSwitch = posted.length;

    // 「用户切到 B」：换当前会话，并对 B 的运行态做 B 自己的操作（新 controller / 标记生成中）
    cast._currentSessionId = '2026-11-06-b';
    cast._agent = agentB;
    const runtimeB = cast.runtimeFor('2026-11-06-b');
    runtimeB.abortController = new AbortController();
    runtimeB.streaming = true;

    // 机判：A 的三项引用与值一字未动（B 的操作没有借道改到 A）
    expect(runtimeA.abortController).toBe(abortA);
    expect(runtimeA.liveBuffer).toBe(bufferA);
    expect(runtimeA.streaming).toBe(true);
    expect(abortA?.signal.aborted).toBe(false);
    // 状态独立：B 是 B 自己的值
    expect(runtimeB.streaming).toBe(true);

    // 放行 A 的后台续跑 → 后台投递必须零上屏（turn_update / 正文都不许串到 B 的界面）
    releaseGate();
    await running;
    const afterSwitch = posted.slice(postedBeforeSwitch);
    expect(afterSwitch.filter((m) => m.type === 'turn_update')).toEqual([]);
    expect(afterSwitch.filter((m) => m.type === 'chunk')).toEqual([]);

    // 收场后：A 归零（后台流已结束），B 保持 B 自己的值（不被 A 的收场波及）
    expect(runtimeA.streaming).toBe(false);
    expect(runtimeB.streaming).toBe(true);
    // 事件面机判：A 自己 `on` 注册的监听，解绑必须由 **A** 自己 `off`（同参）
    // （若任一侧走 `this._agent`（此时 = B），A 的监听会永久残留 = 流失控面被 B 改动）
    const onPending = agentA.on.mock.calls.find((c) => c[0] === 'questionPending')?.[1];
    const onSummary = agentA.on.mock.calls.find((c) => c[0] === 'roundSummaryGenerated')?.[1];
    expect(onPending).toBeDefined();
    expect(onSummary).toBeDefined();
    expect(agentA.off).toHaveBeenCalledWith('questionPending', onPending);
    // 摘要监听在事件到达（或 5s 兜底）时才解绑——直接触发一次，验「解绑落回 A 自己」
    (onSummary as (info: { roundId: string; success: boolean }) => void)({
      roundId: 'round-A',
      success: true,
    });
    expect(agentA.off).toHaveBeenCalledWith('roundSummaryGenerated', onSummary);
    // B 的事件面零触碰（注册/解绑都不许借道）
    expect(agentB.on).not.toHaveBeenCalled();
    expect(agentB.off).not.toHaveBeenCalled();
  });
});

describe('E4 批 4 · 关视图再重开：会话运行态标识不失真（真实路径实测）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * 实测「起流 → dispose 视图 → 重开 → 读标识」
   *
   * 要证伪的假设：若运行态标识的真源是**视图级**内存（每次 resolve 重建一份），
   * 关视图再重开会把 `streaming` / `_asks` 清空 ⇒ 后台仍在跑的会话被标成「没在跑」。
   * 本用例走生产同一份代码（`resolveWebviewView` + `onDidDispose`），不手工复位任何状态。
   */
  it('视图 dispose 后重开，该会话 streaming 仍为 true，ask 协调器未重建', async () => {
    // 门闩流：yield thinking 后挂起，等视图重开完成再放行（模拟「视图关着时流仍在跑」）
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const roundId = 'round-reopen';
    const flow = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        reachedGate();
        await gate;
        yield { type: 'text', content: '重开后仍在跑', roundId };
        yield { type: 'step_boundary', roundId };
      })();
    };
    const agentA = sessionAgent('2026-11-06-a', flow);
    const { cast, reopenView, disposeView, provider } = setupPanel({ '2026-11-06-a': agentA });
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;

    // ① 起流（此刻视图在）
    const running = cast.runFlow(() => flow());
    await atGate;
    const runtimeA = cast.runtimeFor('2026-11-06-a');
    expect(runtimeA.streaming).toBe(true);
    // 流内已建该会话的 ask 协调器（此后重开必须还是同一个对象）
    const askBefore = cast._asks.get('2026-11-06-a');
    expect(askBefore).toBeDefined();

    // ② 关视图（走生产 onDidDispose 清理：清 _view / 放订阅 / 锁收尾，**不清运行态**）
    disposeView();
    // 视图引用已清（证明 dispose 真的执行了生产清理，而不是空操作）
    expect((provider as unknown as { _view?: unknown })._view).toBeUndefined();

    // ③ 重开（走生产 resolveWebviewView：新 webview + 代数自增 + 重新装配订阅）
    reopenView();
    // 重开后模拟「回到原会话」（生产由 ready 握手按 sessionStore 恢复，此处直接对齐场景）
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;

    // ④ 读标识：运行态与 ask 协调器都还活着（真源不在视图级内存）
    expect(cast.runtimeFor('2026-11-06-a').streaming).toBe(true);
    expect(cast._asks.get('2026-11-06-a')).toBe(askBefore);

    // ⑤ 放行收场 → 归零（标识随真实流结束而消失，不是永久粘住）
    releaseGate();
    await running;
    expect(cast.runtimeFor('2026-11-06-a').streaming).toBe(false);
  });

  /**
   * **关键判据（批 4 第 2 条）**：起流 → 关视图 → 重开 → 该会话仍标「运行中」。
   *
   * 与上一条的差别：上一条读的是内部运行态表（真源层），本条读的是**对外声明**——
   * 新 webview 收到的 `session_activity` 快照里是否仍带该会话。只验真源不验投影，
   * 会出现「运行态还在、但列表不亮」的假通过；投影补推漏了正是这类缺陷的形态。
   */
  it('视图重开后 new webview 收到 session_activity，runningIds 仍含该会话', async () => {
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const roundId = 'round-reopen-activity';
    const flow = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        reachedGate();
        await gate;
        yield { type: 'text', content: '重开后仍在跑', roundId };
        yield { type: 'step_boundary', roundId };
      })();
    };
    const agentA = sessionAgent('2026-11-06-a', flow);
    // 播种会话存储：dispose 会清空 _currentSessionId，重开按 getInitialSessionId 派生回 A
    const { cast, posted, reopenView, disposeView, fireMessage, provider } = setupPanel(
      { '2026-11-06-a': agentA },
      ['2026-11-06-a'],
    );
    cast._agent = agentA;

    const running = cast.runFlow(() => flow());
    await atGate;
    // 起流时前台快照已亮「运行中」
    expect(lastActivity(posted).runningIds).toContain('2026-11-06-a');

    disposeView();
    expect((provider as unknown as { _view?: unknown })._view).toBeUndefined();

    reopenView();
    // 新视图就绪（生产由脚本发 ready）：强制补推快照——这是「重开后列表标识」的唯一数据源
    const beforeReady = posted.length;
    fireMessage({ type: 'ready' });
    await vi.waitFor(
      () => {
        const snap = posted
          .slice(beforeReady)
          .filter((m) => m.type === 'session_activity')
          .pop() as unknown as ActivitySnapshot | undefined;
        expect(snap).toBeDefined();
        expect(snap?.runningIds).toContain('2026-11-06-a');
      },
      { timeout: 5000 },
    );

    // 收场后标识必须熄灭（重开不制造永久「运行中」）
    releaseGate();
    await running;
    await vi.waitFor(
      () => {
        expect(lastActivity(posted).runningIds).not.toContain('2026-11-06-a');
      },
      { timeout: 5000 },
    );
  });
});

/** `session_activity` 快照的测试侧形状（只取本文件断言的字段） */
interface ActivitySnapshot {
  type: 'session_activity';
  runningIds: string[];
  pendingIds: string[];
  badgeCount: number;
}

/** 取最后一条会话活跃度快照（未推送过 = undefined） */
function lastActivity(posted: PanelHandle['posted']): ActivitySnapshot {
  return posted.filter((m) => m.type === 'session_activity').pop() as unknown as ActivitySnapshot;
}

describe('E4 批 4 · 会话活跃度快照（后台待处理 ⇒ 列表标识 + 入口角标）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('后台会话等到 ask：pendingIds 含该会话、角标计 1；回答后两者一起消失', () => {
    const agentA = sessionAgent('2026-11-06-a');
    const agentB = sessionAgent('2026-11-06-b');
    const { cast, posted } = setupPanel({ '2026-11-06-a': agentA, '2026-11-06-b': agentB }, [
      '2026-11-06-a',
    ]);
    // 当前显示 A（前台），B 是后台已装配会话
    cast._agent = agentA;
    // 后台 B 等到提问（生产由 B 的流内 questionPending 事件写入）
    cast.askFor('2026-11-06-b').setPending([{ slot: 'q1', question: '要继续吗？' }]);

    const snap = lastActivity(posted);
    expect(snap.pendingIds).toEqual(['2026-11-06-b']);
    expect(snap.badgeCount).toBe(1);

    // 用户回答（消费提问）⇒ 列表标识与入口角标必须一起熄灭（不得留僵尸）
    cast.askFor('2026-11-06-b').clearPending();
    const after = lastActivity(posted);
    expect(after.pendingIds).toEqual([]);
    expect(after.badgeCount).toBe(0);
  });

  it('当前显示会话的待处理不进角标（屏上已可见），但列表标识仍亮', () => {
    const agentA = sessionAgent('2026-11-06-a');
    const { cast, posted } = setupPanel({ '2026-11-06-a': agentA }, ['2026-11-06-a']);
    cast._agent = agentA;
    cast.askFor('2026-11-06-a').setPending([{ slot: 'q1', question: '继续吗？' }]);

    const snap = lastActivity(posted);
    expect(snap.pendingIds).toEqual(['2026-11-06-a']);
    // 角标只数「别的会话」：当前会话的待处理已在屏上，重复计数是噪音
    expect(snap.badgeCount).toBe(0);
  });

  /**
   * 后台上下文里的 `onPendingChanged` 必须**绕过后台投递闸**。
   *
   * 形态：B 在后台跑流 → 流内提问（`questionPending`）→ 宿主刷新活动快照。
   * 若快照走 `post()`（后台闸对非当前会话一律丢弃），这次刷新就是**静默失效**——
   * 列表不亮、角标不增，而运行态本身是对的（最难发现的一类假通过）。
   * 变异靶标：把 `refreshSessionActivity` 末尾的直发改回 `this.post(snapshot)` ⇒ 本条转红。
   */
  it('后台流内提问：快照不得被后台闸丢弃（列表标识与角标都要亮）', async () => {
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    /** 在**流内**（ALS 后台上下文）触发提问——在流外调用测不到后台闸，是假通过 */
    let emitPending: (() => void) | undefined;
    const roundId = 'round-bg-ask';
    const flowB = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        reachedGate();
        await gate;
        // 恢复点仍在 `_flowGate.run` 的 ALS 上下文里 ⇒ 此处触发的同步投递按后台判定
        emitPending?.();
        yield { type: 'text', content: '后台跑完', roundId };
        yield { type: 'step_boundary', roundId };
      })();
    };
    const agentA = sessionAgent('2026-11-06-a');
    const agentB = sessionAgent('2026-11-06-b', flowB);
    const { cast, posted } = setupPanel({ '2026-11-06-a': agentA, '2026-11-06-b': agentB }, [
      '2026-11-06-a',
    ]);
    cast._agent = agentA; // 当前显示 A ⇒ B 的投递处于后台

    const running = cast.runFlow(() => flowB(), undefined, '2026-11-06-b');
    await atGate;
    // 流内提问（生产由内核事件触发）：从桩捕获的事件处理器，稍后在流内派发
    const onMock = (agentB as unknown as { on: { mock: { calls: unknown[][] } } }).on;
    const pendingCall = onMock.mock.calls.find((c) => c[0] === 'questionPending');
    expect(pendingCall).toBeDefined();
    emitPending = () => {
      (pendingCall![1] as (qs: { slot: string; question: string }[]) => void)([
        { slot: 'q1', question: '后台等你回答' },
      ]);
    };

    releaseGate();
    await running;

    const snap = lastActivity(posted);
    expect(snap.pendingIds).toContain('2026-11-06-b');
    expect(snap.badgeCount).toBe(1);

    // 收尾（清提问，避免残留 ask 超时定时器）
    cast.askFor('2026-11-06-b').clearPending();
  });
});
