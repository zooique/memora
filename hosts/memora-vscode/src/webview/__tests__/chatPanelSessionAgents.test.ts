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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// 临时目录统一入口：建目录 + 模块顶层注册清理（禁止裸 mkdtempSync）
import { makeTempDir } from '../../__tests__/helpers/tmpDir.js';
import { join, relative } from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Agent, BackgroundTask } from '@zooique/memora';
// 默认包判据真源 = 内核导出常量（装配 §4.1 单链实际生效值）；测试不硬编码包名。
// RolePackManager = 真实内核实现（草稿未选包的硬判据夹具直接跑它，不用按假设写的桩）
// formatDateKey = 宿主建会话/分叉 id 的同一真源（fork 用例要按生产 id 形态断言）
import { BUILTIN_FALLBACK_PACK, RolePackManager, formatDateKey } from '@zooique/memora';
// 生产同源读回判据：装配桩按它取「会话 meta → 实际激活名」，保证硬判据不是自造链条
import { readSessionRolePackName } from '../../extension/host/sessionRolePack.js';
import type * as vscode from 'vscode';
// 共享 vscode mock 的运行时引用：默认角色包用例要按用例改写 getConfiguration
import { workspace as mockedWorkspace } from 'vscode';
import { ProviderStore } from '../../extension/providers/providerStore.js';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

/** l10n.t 替身：{0}/{1} 占位符按参替换（vi.hoisted——mock 工厂先于 import 执行，import 绑定不可用） */
const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]): string => {
  let out = msg;
  args.forEach((arg, i) => {
    out = out.replaceAll(`{${i}}`, String(arg));
  });
  return out;
});

vi.mock('vscode', async () => ({
  l10n: { t: tStub },
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

/** 共享 getConfiguration 桩的原始实现（默认角色包用例会按用例改写，结束后恢复防串场） */
const originalGetConfigurationImpl = vi
  .mocked(mockedWorkspace.getConfiguration)
  .getMockImplementation();

afterEach(() => {
  // clearAllMocks 只清调用记录、不清实现；不恢复会让某用例的默认包取值漏到后续用例
  if (originalGetConfigurationImpl) {
    vi.mocked(mockedWorkspace.getConfiguration).mockImplementation(originalGetConfigurationImpl);
  }
});

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

describe('E4 批 3 补 · 会话视图入口 = 新建/分叉同样强制重投影（N1）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 取最后一条后台任务快照的任务 id（空列表 = 常驻条隐藏） */
  function lastTaskIds(posted: PanelHandle['posted']): string[] | undefined {
    const msgs = posted.filter((m) => m.type === 'background_tasks') as unknown as Array<{
      items: Array<{ taskId: string }>;
    }>;
    return msgs.at(-1)?.items.map((i) => i.taskId);
  }

  it('新建会话 ⇒ 常驻条换成新会话自己的任务（不残留旧会话清单）', async () => {
    const oldAgent = sessionAgent('2026-11-06-a', undefined, [
      { taskId: 'bg-1', command: 'npm run build', startedAt: 1, status: 'running' },
    ]);
    // 新会话 = 空注册表：新建后常驻条必须为空（不推则停在旧会话的 bg-1）
    const freshAgent = sessionAgent('2026-11-07-new');
    const { provider, posted, cast } = setupPanel();
    provider.setAgentFactory(async (_projectPath, sessionId) =>
      sessionId === '2026-11-06-a' ? oldAgent : freshAgent,
    );
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = oldAgent;
    // 基线：旧会话的任务已在屏上（等价 ready ⑤ 的 force）
    (provider as unknown as { postBackgroundTasks(mode?: string): void }).postBackgroundTasks(
      'force',
    );
    expect(lastTaskIds(posted)).toEqual(['bg-1']);

    await provider.newSessionFromCommand();
    // 判据：新建入口自己做重投影（缺了 force ⇒ 这里仍是 bg-1）
    expect(lastTaskIds(posted)).toEqual([]);
  });

  it('分叉会话 ⇒ 同样强制重投影（同一实例继续，但视图入口必须自己推）', async () => {
    const agentA = sessionAgent('2026-11-06-a', undefined, [
      { taskId: 'bg-1', command: 'npm run build', startedAt: 1, status: 'running' },
    ]);
    // 分叉 = 内核把同一实例切到新会话（宿主随后改键），实例注册表内容不变；
    // 判据是「入口自己发了一次强制投影」，不是内容变化——故断言消息条数递增。
    (
      agentA as unknown as { forkSession: () => { newSession: string; roundCount: number } }
    ).forkSession = () => ({ newSession: 'child-fork', roundCount: 1 });
    const { provider, posted, cast } = setupPanel();
    provider.setAgentFactory(async () => agentA);
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;
    (provider as unknown as { postBackgroundTasks(mode?: string): void }).postBackgroundTasks(
      'force',
    );
    const taskMsgs = () => posted.filter((m) => m.type === 'background_tasks').length;
    const before = taskMsgs();
    expect(lastTaskIds(posted)).toEqual(['bg-1']);

    await provider.forkCurrentSession('round-1');
    expect(taskMsgs(), '分叉入口没有重投影后台任务条').toBe(before + 1);
    expect(lastTaskIds(posted)).toEqual(['bg-1']);
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

/**
 * 草稿态（「＋ 新建会话」）—— 用户拍板 2026-11-07
 *
 * 行为变更：点「＋」不再立刻落一条空会话记录，先显示干净空白页，
 * **只有第一次真正发送内容时才创建会话**。
 *
 * 红线（任一破坏即本组转红）：
 *  ① 草稿只存在于面板内存：不写 sessionStore、不调 setLastActiveSession、不进历史列表；
 *  ② 不占会话锁（`createSession` 是唯一拿锁点，草稿从未调用它）；
 *  ③ 不装配 Agent（工厂零调用）；
 *  ④ 活跃度快照不含草稿（无 id 可入表；别的会话的待处理仍照常亮，那是「别的会话」不是草稿）；
 *  ⑤ webview 重建（刷新）草稿仍在；切到别的会话即丢弃草稿。
 */
describe('草稿态 · 「＋」不再立刻落空会话（首次发送才建会话）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 取最后一条 `session_title`（标题条推送） */
  function lastTitle(posted: PanelHandle['posted']): { title?: string; draft?: boolean } {
    return posted.filter((m) => m.type === 'session_title').at(-1) as unknown as {
      title?: string;
      draft?: boolean;
    };
  }

  /**
   * 进入草稿后：零落盘 / 零锁 / 零装配
   *
   * 变异靶标（旧行为）：把 `newSessionFromCommand` 改回 `createSession(...)` ⇒
   * 「工厂零调用」「setLastActiveSession 零调用」「标题带 draft」三条同时转红。
   */
  it('「＋」= 空白草稿页：不建会话、不写 lastActive、不装配 Agent，标题带 draft 标记', async () => {
    const agentA = sessionAgent('2026-11-06-a');
    const { provider, posted, cast } = setupPanel({ '2026-11-06-a': agentA }, ['2026-11-06-a']);
    const store = (provider as unknown as { sessionStore: WorkspaceSessionStore }).sessionStore;
    const factory = vi.fn(async () => agentA);
    provider.setAgentFactory(factory);
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;
    const setLastActive = vi.spyOn(store, 'setLastActiveSession');
    const metasBefore = store.listSessionMetas().length;

    await provider.newSessionFromCommand();

    expect(provider.isDraftSession()).toBe(true);
    expect(provider.getCurrentSessionId()).toBe('');
    // ① 零落盘：没有新增会话记录，停留指针不动（历史列表与「上次停留」都不受影响）
    expect(store.listSessionMetas().length).toBe(metasBefore);
    expect(setLastActive).not.toHaveBeenCalled();
    // ③ 零装配（② = 不占锁：拿锁只发生在 createSession，本用例从未走到那里）
    expect(factory).not.toHaveBeenCalled();
    // 草稿标题：draft 标记是 webview 禁用改名笔的唯一判据（标题断言英文源键：单测无 zh bundle）
    expect(lastTitle(posted)).toMatchObject({ title: 'New session', draft: true });
    // 后台任务条按空投影重推（不残留上一个会话的清单）
    const tasks = posted.filter((m) => m.type === 'background_tasks').at(-1) as unknown as {
      items: unknown[];
    };
    expect(tasks.items).toEqual([]);
  });

  it('首次真正发送才建会话：只装配一次，草稿标记消失', async () => {
    const agentA = sessionAgent('2026-11-06-a');
    const freshAgent = sessionAgent('2026-11-07-draft');
    const { provider, posted, cast, fireMessage } = setupPanel({ '2026-11-06-a': agentA }, [
      '2026-11-06-a',
    ]);
    const store = (provider as unknown as { sessionStore: WorkspaceSessionStore }).sessionStore;
    const factory = vi.fn(async (_projectPath: string, sessionId: string) =>
      sessionId === '2026-11-06-a' ? agentA : freshAgent,
    );
    provider.setAgentFactory(factory);
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;

    await provider.newSessionFromCommand();
    expect(provider.isDraftSession()).toBe(true);
    expect(factory).not.toHaveBeenCalled();

    // 空文本发送不建会话（草稿页仍可继续输入）
    fireMessage({ type: 'input', kind: 'send', text: '   ' });
    await new Promise((r) => setTimeout(r, 0));
    expect(provider.isDraftSession()).toBe(true);
    expect(factory).not.toHaveBeenCalled();

    fireMessage({ type: 'input', kind: 'send', text: '帮我看一下仓库结构' });
    await vi.waitFor(() => expect(provider.isDraftSession()).toBe(false), { timeout: 5000 });

    // 会话 id 由时间戳生成，形态与生产一致
    const newId = provider.getCurrentSessionId();
    expect(newId).toMatch(/^\d{4}-\d{2}-\d{2}-s[0-9a-z]+$/);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[1]).toBe(newId);
    // 建会话只切换显示源；**没有空壳记录落盘**（round 尚未写入 ⇒ 文件不存在）
    expect(store.getSessionMeta(newId)).toBeUndefined();
    // 标题不再是草稿态（改名笔恢复可用）
    expect(lastTitle(posted).draft).toBeUndefined();
    expect(lastTitle(posted).title).toMatch(/^新会话 \d{2}:\d{2}$/);
  });

  /**
   * 草稿选包 → 首条发送 → 实际生效角色 = 所选（**硬判据**，不看界面文案）
   *
   * 判据链（三处都必须相等，缺一即「选了没生效」）：
   *   ① 会话文件：`SessionMeta.activeRolePackName` = 所选（唯一写点 = 面板建会话路径里那一次
   *      `updateSessionMeta`，早于装配）；
   *   ② 装配实际值：`rolePackManager.activeName` = 所选（本用例的装配桩按生产同源判据
   *      `readSessionRolePackName(store, sessionId)` 取回——meta 没写就会落兜底包，本条即转红）；
   *   ③ 屏上投影：`chat_role_pack.rolePack` = 所选（投影只是事实的下游，不能自己造值）。
   *
   * 变异靶标：删掉 `createSession` 里的 `updateSessionMeta` ⇒ ①②③ 同时转红；
   * 把它挪到 `agentForSession` 之后 ⇒ 装配读到兜底包，② 转红（写点必须早于装配）。
   */
  it('草稿选包 → 首条发送：meta 落盘 + 装配实际生效包 + 屏上投影 三者都等于所选', async () => {
    const agentA = sessionAgent('2026-11-06-a');
    const { provider, posted, cast, fireMessage } = setupPanel({ '2026-11-06-a': agentA }, [
      '2026-11-06-a',
    ]);
    const store = (provider as unknown as { sessionStore: WorkspaceSessionStore }).sessionStore;
    // 装配桩：activeName 严格取自会话 meta（与生产 assembler 同一判据），不自己编默认值
    const factory = vi.fn(async (_projectPath: string, sessionId: string) => {
      const requested = readSessionRolePackName(store, sessionId);
      return {
        ...sessionAgent(sessionId),
        rolePackManager: {
          activeName: requested ?? BUILTIN_FALLBACK_PACK,
          getActive: () => ({
            strategy: { act: { toolMode: 'allow', temperature: 0.7 }, prepare: {} },
            capabilities: undefined,
            traits: {},
          }),
          listMeta: () => [
            {
              name: requested ?? BUILTIN_FALLBACK_PACK,
              displayName: requested ?? BUILTIN_FALLBACK_PACK,
              description: '',
            },
          ],
          getActiveTeam: () => undefined,
        },
      } as unknown as Agent;
    });
    provider.setAgentFactory(factory);
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;

    await provider.newSessionFromCommand();
    expect(provider.isDraftSession()).toBe(true);
    // 草稿期选择只进草稿内存：此刻**零落盘**（还没有会话可写）
    provider.setDraftRolePack('只读项目顾问');
    expect(provider.getDraftRolePackName()).toBe('只读项目顾问');

    fireMessage({ type: 'input', kind: 'send', text: '梳理一下这个仓库' });
    await vi.waitFor(() => expect(provider.isDraftSession()).toBe(false), { timeout: 5000 });

    const newId = provider.getCurrentSessionId();
    // ① 唯一写点：随建会话那一次写进 meta（不是第二条写入路径）
    expect(store.getSessionMeta(newId)?.activeRolePackName).toBe('只读项目顾问');
    // ② 装配实际生效包（能力面真源）——不是「界面显示对了」就算过
    const assembled = cast._sessionAgents.get(newId) as Agent;
    expect(assembled.rolePackManager?.activeName).toBe('只读项目顾问');
    // ③ 屏上投影与事实同源
    const rolePack = posted.filter((m) => m.type === 'chat_role_pack').at(-1) as unknown as {
      rolePack: string;
    };
    expect(rolePack.rolePack).toBe('只读项目顾问');
  });

  /**
   * 草稿「未选包」→ 首条发送：屏上默认角色 == 装配实际 activeName（**硬判据 2**）
   *
   * 用户判据（2026-11-07 追加）：草稿未选时显示的不能是宿主自造的「列表第一个」。
   * 夹具刻意让**自定义包排在兜底包前面**，且装配侧直接用**真实内核 `RolePackManager`**
   * （不是按「兜底 = 列表首项」假设写的桩）：
   *   - 若草稿取值靠列表首项 ⇒ 屏上值与装配值不等，转红；
   *   - 若内核回落链真的退化成 `items[0]` ⇒ 装配值与屏上常量不等，同样转红。
   *
   * 结论（本用例钉住）：无 meta 时内核 §4.1 单链恒为 `builtinFallbackRole ?? BUILTIN_FALLBACK_PACK`，
   * 而宿主零注入 `builtinFallbackRole` ⇒ 装配 `activeName` 恒等于该常量，与列表顺序无关。
   *
   * 变异靶标：把 `defaultRolePackName` 注入改成列表首项名 ⇒ 第一条断言转红；
   * 把内核 `activateFallback` 改成激活 `items[0]`（需重建内核 dist）⇒ 末条相等断言转红。
   */
  it('草稿未选包 → 首条发送：屏上默认角色 == 装配实际 activeName（兜底包不在列表首位）', async () => {
    // 夹具：两本以上角色包，folder 名决定扫描序 ⇒ 自定义包在前、兜底包不在首位
    const rolePackRoot = makeTempDir('memora-draft-rolepack-');
    const packsDir = join(rolePackRoot, 'role-packs');
    /** 写一本最小角色包（folder 名决定扫描序；manifest.name = 实际包名） */
    async function writePack(folder: string, name: string): Promise<void> {
      const packDir = join(packsDir, folder);
      await mkdir(packDir, { recursive: true });
      await writeFile(
        join(packDir, 'manifest.json'),
        JSON.stringify({ name, formatVersion: '1.0.0' }, null, 2),
        'utf-8',
      );
      await writeFile(join(packDir, 'persona.md'), `你是${name}。`, 'utf-8');
    }
    await writePack('00-只读项目顾问', '只读项目顾问');
    await writePack('01-代码助手', '代码助手');
    await writePack('99-兜底包', BUILTIN_FALLBACK_PACK);

    // 真实内核回落链：无 activePack（= 新会话未选角色）⇒ §4.1 兜底包
    const rpm = new RolePackManager(rolePackRoot);
    expect(await rpm.load()).toBe(3);
    // 前置守卫：兜底包不在首位（否则本用例失去区分力）
    expect(rpm.listMeta()[0]?.name).toBe('只读项目顾问');
    expect(rpm.activeName).toBe(BUILTIN_FALLBACK_PACK);

    const agentA = sessionAgent('2026-11-06-a');
    const { provider, posted, cast, fireMessage } = setupPanel({ '2026-11-06-a': agentA }, [
      '2026-11-06-a',
    ]);
    // 装配桩只做「会话 id → 实例」的替换；角色事实全部来自真实内核 rpm
    const factory = vi.fn(
      async (_projectPath: string, sessionId: string) =>
        ({ ...sessionAgent(sessionId), rolePackManager: rpm }) as unknown as Agent,
    );
    provider.setAgentFactory(factory);
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;

    await provider.newSessionFromCommand();
    // 草稿不选包：记下屏上显示的包名（最后一条 chat_role_pack = 草稿投影）
    const draftRole = posted.filter((m) => m.type === 'chat_role_pack').at(-1) as unknown as {
      rolePack: string;
    };
    expect(draftRole.rolePack).toBe(BUILTIN_FALLBACK_PACK);
    expect(draftRole.rolePack).not.toBe(rpm.listMeta()[0]?.name);

    fireMessage({ type: 'input', kind: 'send', text: '随便问一句' });
    await vi.waitFor(() => expect(provider.isDraftSession()).toBe(false), { timeout: 5000 });

    const newId = provider.getCurrentSessionId();
    const assembled = cast._sessionAgents.get(newId) as Agent;
    // 硬判据：草稿屏上值 == 装配后内核真实生效值（列表首项不参与）
    expect(assembled.rolePackManager?.activeName).toBe(draftRole.rolePack);
    // 选择器数据与同一真源（无 meta 时 activeName 不得退化成 packs[0]）
    const selector = posted.filter((m) => m.type === 'chat_role_packs').at(-1) as unknown as {
      activeName: string;
      packs: { name: string }[];
    };
    expect(selector.activeName).toBe(draftRole.rolePack);
    expect(selector.packs[0]?.name).not.toBe(BUILTIN_FALLBACK_PACK);
  });

  /**
   * 草稿首条发送后，五个会话级投影全部恢复（CRITICAL：防「下次再加投影又漏一项」）
   *
   * 判据 = 草稿页归零的反向面：归零后必须有一处把它们重新点亮。本用例不逐个方法去测，
   * 而是断言「首条发送这一条真实链路上，五类消息都必须到达」——新增会话级投影时若只挂
   * draft 归零、忘了装配后补推，本条转红。
   *
   * 五项与 webview 侧归零用例逐项对应：角色 / 能力徽章 / 占用 / 后台任务 / 看板。
   * 新实例刻意带**非空**数据（角色包 / 任务表 / 后台任务），否则「恢复了」可能只是「碰巧为空」。
   *
   * 变异靶标：删掉 `refreshAfterAssemble` 里的 `postPlanUpdate()` ⇒ 看板项转红；
   * 删掉 `postCapabilityBadge()` / `pushRolePacks()` ⇒ 对应项转红。
   */
  it('草稿首条发送 ⇒ 角色 / 能力徽章 / 占用 / 后台任务 / 看板 五项全部恢复', async () => {
    const agentA = sessionAgent('2026-11-06-a');
    // 流**永不结束**：屏蔽「流收尾时的 plan 快照对齐」（否则尾部那条 plan_update 会掩盖
    // 「装配/回放入口没补推」的缺陷——本用例要钉的正是恢复点本身，不是流收尾的顺带推送）
    const hangingFlow = async function* (): AsyncGenerator<Chunk> {
      await new Promise(() => {});
      yield { type: 'never', roundId: 'never' };
    };
    // 新会话实例：角色包 + 任务表 + 一条后台任务（三项非空才能证明「恢复」）
    const fresh = {
      ...sessionAgent('2026-11-07-draft', hangingFlow, [
        { taskId: 'bg-1', command: 'npm run build', startedAt: 1, status: 'running' },
      ]),
      rolePackManager: {
        activeName: '代码助手',
        getActive: () => ({
          strategy: { act: { toolMode: 'allow', temperature: 0.7 }, prepare: {} },
          capabilities: undefined,
          traits: {},
        }),
        listMeta: () => [{ name: '代码助手', displayName: '代码助手', description: '写代码' }],
        getActiveTeam: () => undefined,
      },
      // 任务看板快照源（checkpoint.plan）：装配后补推读的就是它
      getCheckpoint: () => ({
        plan: [
          { id: 'p1', description: '读仓库结构', status: 'active', order: 1 },
          { id: 'p2', description: '给出结论', status: 'pending', order: 2 },
        ],
        planItemLog: [],
      }),
    } as unknown as Agent;

    const { provider, posted, cast, fireMessage } = setupPanel({ '2026-11-06-a': agentA }, [
      '2026-11-06-a',
    ]);
    provider.setAgentFactory(async (_p, sessionId: string) =>
      sessionId === '2026-11-06-a' ? agentA : fresh,
    );
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;
    // 本文件对 vscode 配置的 mock 恒返回 false ⇒ 真实 ProviderStore.listMasked 抛错，
    // 占用补推被静默吞掉（圆环不更新）。本用例要验「占用恢复」，故给本实例换最小读面
    // （只替 Provider 读三面，不碰共享 setupPanel 桩，避免影响既有断言）。
    // cast 类型面未暴露 _providerStore ⇒ 经窄化断言写入（只本用例生效，不影响共享桩）
    (cast as unknown as { _providerStore: unknown })._providerStore = {
      listMasked: async () => [
        { name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, apiKey: '' },
      ],
      getActiveName: () => 'deepseek',
      getActive: async () => ({
        name: 'deepseek',
        displayName: 'DeepSeek',
        model: 'deepseek-chat',
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test',
      }),
    };

    await provider.newSessionFromCommand();
    // 草稿页基线：五项投影已在 project() 里归零
    expect(provider.isDraftSession()).toBe(true);
    // 取「首条发送」之后的投递窗口（草稿投影消息不参与断言）
    const mark = posted.length;

    fireMessage({ type: 'input', kind: 'send', text: '帮我看一下仓库结构' });

    // 建会话 → 装配 → 装配后补推（占用为异步补推，故整体等齐五项）
    await vi.waitFor(
      () => {
        const tail = posted.slice(mark);
        expect(tail.some((m) => m.type === 'chat_role_pack')).toBe(true);
        expect(tail.some((m) => m.type === 'capability_badge')).toBe(true);
        expect(tail.some((m) => m.type === 'context_occupancy')).toBe(true);
        expect(tail.some((m) => m.type === 'background_tasks')).toBe(true);
        expect(tail.some((m) => m.type === 'plan_update')).toBe(true);
      },
      // 小于用例全局 5s 上限：让失败以「缺了哪条消息」的形式报出，而不是笼统的 timeout
      { timeout: 3000, interval: 50 },
    );
    expect(provider.isDraftSession()).toBe(false);

    // 逐项核对内容：非空、确属新会话（不是「碰巧推了空壳」）
    const tail = posted.slice(mark);
    const lastOf = (type: string) => tail.filter((m) => m.type === type).at(-1);
    const rolePack = lastOf('chat_role_pack') as unknown as { rolePack: string };
    expect(rolePack.rolePack).toBe('代码助手');
    const badge = lastOf('capability_badge') as unknown as { toolMode: string };
    expect(badge.toolMode).toBe('allow');
    const occupancy = lastOf('context_occupancy') as unknown as { occupancy: unknown };
    expect(occupancy.occupancy).toBeTruthy();
    const tasks = lastOf('background_tasks') as unknown as { items: { taskId: string }[] };
    expect(tasks.items.map((t) => t.taskId)).toEqual(['bg-1']);
    const plan = lastOf('plan_update') as unknown as { items: { id: string }[] };
    expect(plan.items.map((i) => i.id)).toEqual(['p1', 'p2']);
  });

  it('活跃度快照不含草稿（无 id 可入表），别的会话的待处理仍照常亮', async () => {
    const agentA = sessionAgent('2026-11-06-a');
    const { provider, posted, cast } = setupPanel({ '2026-11-06-a': agentA }, ['2026-11-06-a']);
    provider.setAgentFactory(async () => agentA);
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;
    // A 在后台等到提问（用户此刻在草稿页）
    cast.askFor('2026-11-06-a').setPending([{ slot: 'q1', question: '继续吗？' }]);

    await provider.newSessionFromCommand();

    const snap = lastActivity(posted);
    // 草稿不是会话：不得出现在运行中/待处理名单里（'' 或任何伪 id 都不许）
    expect(snap.runningIds).not.toContain('');
    expect(snap.pendingIds).not.toContain('');
    // 别的会话的待处理照常亮（那是「别的会话」，不是草稿）
    expect(snap.pendingIds).toEqual(['2026-11-06-a']);
    expect(snap.badgeCount).toBe(1);
    cast.askFor('2026-11-06-a').clearPending();
  });

  it('webview 重建（刷新）后草稿仍在：重建草稿页，不退回任何会话', async () => {
    const agentA = sessionAgent('2026-11-06-a');
    const { provider, posted, cast, reopenView, fireMessage } = setupPanel(
      { '2026-11-06-a': agentA },
      ['2026-11-06-a'],
    );
    provider.setAgentFactory(async () => agentA);
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;
    await provider.newSessionFromCommand();
    expect(provider.isDraftSession()).toBe(true);

    reopenView();
    const beforeReady = posted.length;
    fireMessage({ type: 'ready' });

    await vi.waitFor(
      () => {
        const title = posted
          .slice(beforeReady)
          .filter((m) => m.type === 'session_title')
          .at(-1) as unknown as { draft?: boolean } | undefined;
        expect(title?.draft).toBe(true);
      },
      { timeout: 5000 },
    );
    // 草稿只在面板内存：重建后仍是草稿，没有被「启动归属裁决」退回上一个会话
    expect(provider.isDraftSession()).toBe(true);
    expect(provider.getCurrentSessionId()).toBe('');
  });

  it('切到别的会话 ⇒ 草稿丢弃（草稿不是会话，没有「切回草稿」）', async () => {
    const agentA = sessionAgent('2026-11-06-a');
    const { provider, cast } = setupPanel({ '2026-11-06-a': agentA }, ['2026-11-06-a']);
    provider.setAgentFactory(async () => agentA);
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;
    await provider.newSessionFromCommand();
    expect(provider.isDraftSession()).toBe(true);

    await provider.switchToSession('2026-11-06-a');
    expect(provider.isDraftSession()).toBe(false);
    expect(provider.getCurrentSessionId()).toBe('2026-11-06-a');
    expect(provider.getCurrentAgent()).toBe(agentA);
  });
});

/**
 * 新建会话默认角色包 · 用户级默认 → 会话快照（2026-11-08 用户拍板）
 *
 * 三条不变式：
 *  ① 快照语义：默认值只在**建会话**时读一次并写进 `SessionMeta`，此后改默认不影响已有会话；
 *  ② 单点读取：配置键只在 `rolePackDefault.ts` 被读（见下方守卫组）；
 *  ③ 不追溯：装配链与 fork 路径不得引用全局默认（否则老会话会被「引用语义」改写）。
 */
describe('新建会话默认角色包 · 用户级默认 → 会话快照', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 让 `memora.defaultRolePack` 读到指定值；返回该配置读的 spy（断言「不读默认」用） */
  function stubDefaultRolePack(value: string): { get: ReturnType<typeof vi.fn> } {
    const get = vi.fn((key: string) => (key === 'defaultRolePack' ? value : false));
    vi.mocked(mockedWorkspace.getConfiguration).mockImplementation(
      () => ({ get, update: vi.fn(async () => {}) }) as never,
    );
    return { get };
  }

  /** 取最后一条 `chat_role_pack` 投影（徽章取值） */
  function lastRolePack(posted: PanelHandle['posted']): { rolePack: string } {
    return posted.filter((m) => m.type === 'chat_role_pack').at(-1) as unknown as {
      rolePack: string;
    };
  }

  /**
   * 装配桩：activeName 严格取自会话 meta（与生产 assembler 同一判据）。
   * 注意**不再提供存在性 `get`**：默认包校验的真源已换成角色包目录编目
   * （`setRolePackCatalog`），装配桩若继续充当探针，本组用例就测不出「乐观放行」回潮。
   */
  function makeFactory(store: WorkspaceSessionStore) {
    return vi.fn(async (_projectPath: string, sessionId: string) => {
      const requested = readSessionRolePackName(store, sessionId);
      return {
        ...sessionAgent(sessionId),
        rolePackManager: {
          activeName: requested ?? BUILTIN_FALLBACK_PACK,
          getActive: () => ({
            strategy: { act: { toolMode: 'allow', temperature: 0.7 }, prepare: {} },
            capabilities: undefined,
            traits: {},
          }),
          listMeta: () => [],
          getActiveTeam: () => undefined,
        },
      } as unknown as Agent;
    });
  }

  /**
   * 建面板 + 注入装配桩与角色包目录编目 + 进入草稿（当前停在 seed 会话）
   *
   * @param catalog 目录编目内容（`null` = 目录读不到，校验不可用）
   */
  async function enterDraft(catalog: ReadonlySet<string> | null) {
    const agentA = sessionAgent('2026-11-06-a');
    const ctx = setupPanel({ '2026-11-06-a': agentA }, ['2026-11-06-a']);
    const store = (ctx.provider as unknown as { sessionStore: WorkspaceSessionStore }).sessionStore;
    const factory = makeFactory(store);
    ctx.provider.setAgentFactory(factory);
    // 校验真相源 = 角色包目录（不是已装配实例）：本组用例据此独立控制「包在不在」
    ctx.provider.setRolePackCatalog(async () => catalog);
    ctx.cast._currentSessionId = '2026-11-06-a';
    ctx.cast._agent = await factory('/mock/workspace', '2026-11-06-a');
    // 构造当前源不算「建会话装配」：清掉调用记录，后续断言只统计真实装配
    factory.mockClear();
    await ctx.provider.newSessionFromCommand();
    return { ...ctx, store, factory, agentA };
  }

  /**
   * 冷启动：面板没有任何会话、没有任何已装配实例，直接进草稿（首次发送才建会话）
   *
   * @param catalog 目录编目内容（`null` = 目录读不到）
   */
  async function enterColdDraft(catalog: ReadonlySet<string> | null) {
    const ctx = setupPanel();
    const store = (ctx.provider as unknown as { sessionStore: WorkspaceSessionStore }).sessionStore;
    const factory = makeFactory(store);
    ctx.provider.setAgentFactory(factory);
    ctx.provider.setRolePackCatalog(async () => catalog);
    await ctx.provider.newSessionFromCommand();
    return { ...ctx, store, factory };
  }

  /** 草稿首条发送 → 等建会话完成，返回新会话 id（冷启动/带 seed 两种夹具通用） */
  async function sendFirst(ctx: {
    fireMessage: (msg: unknown) => void;
    provider: MemoraChatViewProvider;
  }): Promise<string> {
    ctx.fireMessage({ type: 'input', kind: 'send', text: '梳理一下这个仓库' });
    await vi.waitFor(() => expect(ctx.provider.isDraftSession()).toBe(false), { timeout: 5000 });
    return ctx.provider.getCurrentSessionId();
  }

  it('未选包 + 全局默认=X ⇒ 建会话写入 meta，装配与投影都等于 X', async () => {
    stubDefaultRolePack('代码助手');
    const ctx = await enterDraft(new Set(['代码助手']));

    const newId = await sendFirst(ctx);

    // ① 唯一写点：随建会话那一次写进 meta
    expect(ctx.store.getSessionMeta(newId)?.activeRolePackName).toBe('代码助手');
    // ② 装配实际生效包（能力面真源）
    const assembled = ctx.cast._sessionAgents.get(newId) as Agent;
    expect(assembled.rolePackManager?.activeName).toBe('代码助手');
    // ③ 屏上投影与事实同源
    expect(lastRolePack(ctx.posted).rolePack).toBe('代码助手');
  });

  it('全局默认未设置（空串）⇒ 走现状：不写 meta，装配落兜底包', async () => {
    stubDefaultRolePack('');
    const ctx = await enterDraft(new Set());

    const newId = await sendFirst(ctx);

    expect(ctx.store.getSessionMeta(newId)).toBeUndefined();
    const assembled = ctx.cast._sessionAgents.get(newId) as Agent;
    expect(assembled.rolePackManager?.activeName).toBe(BUILTIN_FALLBACK_PACK);
    expect(lastRolePack(ctx.posted).rolePack).toBe(BUILTIN_FALLBACK_PACK);
  });

  it('全局默认指向已删包 ⇒ 不写 meta、回落兜底、弹「默认角色包不可用」', async () => {
    stubDefaultRolePack('幽灵角色');
    const ctx = await enterDraft(new Set()); // 目录里没有「幽灵角色」

    const newId = await sendFirst(ctx);

    expect(ctx.store.getSessionMeta(newId)).toBeUndefined();
    const assembled = ctx.cast._sessionAgents.get(newId) as Agent;
    expect(assembled.rolePackManager?.activeName).toBe(BUILTIN_FALLBACK_PACK);
    const defaultNotice = ctx.posted
      .filter((m) => m.type === 'notice' && String(m.message ?? '').includes('Default role pack'))
      .at(-1) as unknown as { level?: string; message?: string } | undefined;
    expect(defaultNotice?.level).toBe('error');
    expect(defaultNotice?.message).toBe(
      `Default role pack "幽灵角色" is unavailable; using the fallback role "${BUILTIN_FALLBACK_PACK}" instead.`,
    );
    // 与既有「原角色包不可用」区分：默认包不是用户在该会话里选过的角色
    expect(defaultNotice?.message).not.toContain('The former role pack');
  });

  it('草稿徽章投影全局默认；草稿期间不装配（默认只在建会话时快照）', async () => {
    stubDefaultRolePack('代码助手');
    const ctx = await enterDraft(new Set(['代码助手']));

    expect(ctx.provider.isDraftSession()).toBe(true);
    expect(lastRolePack(ctx.posted).rolePack).toBe('代码助手');
    expect(ctx.factory).not.toHaveBeenCalled();
  });

  it('fork 保持父会话的角色包：不读全局默认、不把默认写进子会话', async () => {
    const { get } = stubDefaultRolePack('代码助手');
    const parentRole = '只读项目顾问';
    const agentA = sessionAgent('2026-11-06-a');
    const ctx = setupPanel();
    const store = (ctx.provider as unknown as { sessionStore: WorkspaceSessionStore }).sessionStore;
    ctx.cast._currentSessionId = '2026-11-06-a';
    ctx.cast._agent = agentA;
    // 内核 forkSession 的落盘语义：子会话文件继承父会话角色快照
    // （真源在内核 messageHistory，内核侧已有独立用例；此处只模拟这一步落盘）
    (
      agentA as unknown as {
        forkSession: (roundId: string) => { newSession: string; roundCount: number };
      }
    ).forkSession = () => {
      store.updateSessionMeta(`${formatDateKey(new Date())}-fx1`, {
        activeRolePackName: parentRole,
      });
      return { newSession: 'fx1', roundCount: 1 };
    };
    get.mockClear();

    await ctx.provider.forkCurrentSession('round-1');

    const forkedId = ctx.provider.getCurrentSessionId();
    expect(forkedId).toBe(`${formatDateKey(new Date())}-fx1`);
    // 宿主零改写：子会话仍是父包，不得被全局默认覆盖
    expect(store.getSessionMeta(forkedId)?.activeRolePackName).toBe(parentRole);
    // 分叉不是建会话：不得读取全局默认（否则老会话会被追溯改写）
    expect(get.mock.calls.filter(([key]) => key === 'defaultRolePack')).toEqual([]);
  });

  it('冷启动零实例 + 默认包不存在 ⇒ meta 为空，弹「默认角色包不可用」而非「原角色包」', async () => {
    stubDefaultRolePack('幽灵角色');
    const ctx = await enterColdDraft(new Set());

    // 前置：这条用例的全部价值建立在「零已装配实例」上（旧实现正是在此乐观放行）
    expect(ctx.cast._agent).toBeUndefined();
    expect(ctx.cast._sessionAgents.size).toBe(0);

    const newId = await sendFirst(ctx);

    // ① 根因判据：失效默认名不得落进 meta（旧实现会写进去，进而被当成用户真选）
    expect(ctx.store.getSessionMeta(newId)?.activeRolePackName).toBeUndefined();
    const assembled = ctx.cast._sessionAgents.get(newId) as Agent;
    expect(assembled.rolePackManager?.activeName).toBe(BUILTIN_FALLBACK_PACK);
    // ② 文案判据：走「默认角色包不可用」这条，不是给老会话用的「原角色包不可用」
    const notice = ctx.posted
      .filter((m) => m.type === 'notice' && String(m.message ?? '').includes('role pack'))
      .at(-1) as unknown as { level?: string; message?: string } | undefined;
    expect(notice?.message).toBe(
      `Default role pack "幽灵角色" is unavailable; using the fallback role "${BUILTIN_FALLBACK_PACK}" instead.`,
    );
    expect(notice?.message).not.toContain('The former role pack');
  });

  it('角色包目录读不到 ⇒ 不写 meta，弹「无法校验」（与「包不存在」区分）', async () => {
    stubDefaultRolePack('代码助手');
    const ctx = await enterColdDraft(null);

    const newId = await sendFirst(ctx);

    expect(ctx.store.getSessionMeta(newId)?.activeRolePackName).toBeUndefined();
    const assembled = ctx.cast._sessionAgents.get(newId) as Agent;
    expect(assembled.rolePackManager?.activeName).toBe(BUILTIN_FALLBACK_PACK);
    const notice = ctx.posted
      .filter((m) => m.type === 'notice' && String(m.message ?? '').includes('Unable to verify'))
      .at(-1) as unknown as { level?: string; message?: string } | undefined;
    expect(notice?.level).toBe('error');
    expect(notice?.message).toBe(
      `Default role pack "代码助手": Unable to verify the role pack list. Using the fallback role "${BUILTIN_FALLBACK_PACK}" instead.`,
    );
    // 第三出口不得折叠成「包不存在」：否则用户会去改包名，永远修不好目录问题
    expect(notice?.message).not.toContain('is unavailable; using the fallback role');
  });
});

describe('新建会话默认角色包 · 读口单一性守卫（SSOT）', () => {
  /** 宿主 src 根（本文件位于 src/webview/__tests__/） */
  const srcRoot = fileURLToPath(new URL('../..', import.meta.url));

  /** 递归列出 src 下全部生产 .ts 文件绝对路径（测试目录排除：本组守卫只盯生产代码） */
  async function listSourceFiles(dir: string = srcRoot): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'fixtures') continue;
        out.push(...(await listSourceFiles(full)));
      } else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it("配置键读取（get<string>('defaultRolePack')）只出现在 rolePackDefault.ts", async () => {
    const readers: string[] = [];
    for (const file of await listSourceFiles()) {
      const text = await readFile(file, 'utf-8');
      if (/get<string>\(\s*['"]defaultRolePack['"]/.test(text)) {
        readers.push(relative(srcRoot, file).replaceAll('\\', '/'));
      }
    }
    expect(readers).toEqual(['extension/host/rolePackDefault.ts']);
  });

  it('装配链源码零引用全局默认（防止改成「引用语义」追溯改写老会话）', async () => {
    for (const rel of ['extension/extension.ts', 'extension/host/assemble.ts']) {
      const text = await readFile(join(srcRoot, rel), 'utf-8');
      expect(text, `${rel} 不得读取/引用全局默认角色包`).not.toMatch(
        /defaultRolePack|DefaultRolePackSetting|resolveNewSessionRolePackName|decideNewSessionRolePack/,
      );
    }
  });
});

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

/**
 * #13 · 结构写窗口锁的重建回放（折叠 / 展开 = webview HTML 重建）
 *
 * 锁态真源 = 流内 `status` 消息（`done` 才解锁）；新 webview 的锁态初值是「可用」，
 * 不补推就等于把写盘窗口（流在跑 / 会话已挂起）里的截断 / 分叉放开。
 * 变异靶标：删掉 `handleWebviewReady` 里的 `replayStructureWriteLock()` 调用 ⇒ 第一条转红；
 * 把该方法改成「无条件补 status」⇒ 第二条转红（反向锁死）。
 */
describe('#13 · 结构写窗口锁的重建回放（只回放锁、不碰导航）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('流中重建：ready 后补推 status=thinking（结构锁仍为锁）', async () => {
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const roundId = 'round-reopen-lock';
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
    const { cast, posted, reopenView, disposeView, fireMessage } = setupPanel(
      { '2026-11-06-a': agentA },
      ['2026-11-06-a'],
    );
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;

    // 起流（此刻视图在；该会话进入写盘窗口）
    const running = cast.runFlow(() => flow());
    await atGate;

    // 折叠：关视图（生产清理只清视图引用，不清运行态）
    disposeView();
    // 展开：新 webview + ready 握手（流仍在跑 = 写盘窗口未关）
    reopenView();
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;
    const beforeReady = posted.length;
    fireMessage({ type: 'ready' });

    // 新 webview 必须收到锁态补推（旧实现只有流内 status，重建后锁态丢失）
    await vi.waitFor(
      () => {
        const lockMsg = posted
          .slice(beforeReady)
          .find((m) => m.type === 'status' && (m.state === 'thinking' || m.state === 'paused'));
        expect(lockMsg).toBeDefined();
      },
      { timeout: 5000 },
    );

    releaseGate();
    await running;
  });

  it('锁已解除后重建：不再补锁（不反向锁死）', async () => {
    const roundId = 'round-reopen-unlocked';
    const flow = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        yield { type: 'text', content: '收场了', roundId };
        yield { type: 'step_boundary', roundId };
      })();
    };
    const agentA = sessionAgent('2026-11-06-a', flow);
    const { cast, posted, reopenView, disposeView, fireMessage } = setupPanel(
      { '2026-11-06-a': agentA },
      ['2026-11-06-a'],
    );
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;

    await cast.runFlow(() => flow());
    expect(cast.runtimeFor('2026-11-06-a').streaming).toBe(false);

    // 摘要落地（正常事件路径）→ status:done 已投递 = 结构写窗口锁解除
    const onMock = (agentA as unknown as { on: { mock: { calls: unknown[][] } } }).on;
    const summaryCall = onMock.mock.calls.find((c) => c[0] === 'roundSummaryGenerated');
    expect(summaryCall).toBeDefined();
    (summaryCall![1] as (info: { roundId: string; success: boolean }) => void)({
      roundId,
      success: true,
    });
    expect(posted.some((m) => m.type === 'status' && m.state === 'done')).toBe(true);

    // 锁解除之后再折叠 / 展开：回放必须是「可用」，不得反向锁死
    disposeView();
    reopenView();
    cast._currentSessionId = '2026-11-06-a';
    cast._agent = agentA;
    const beforeReady = posted.length;
    fireMessage({ type: 'ready' });
    // 等 ready 链跑完（活跃度快照是 ready 末段的既有补推，可作完成信号）
    await vi.waitFor(
      () => {
        expect(posted.slice(beforeReady).some((m) => m.type === 'session_activity')).toBe(true);
      },
      { timeout: 5000 },
    );
    expect(
      posted
        .slice(beforeReady)
        .filter((m) => m.type === 'status' && (m.state === 'thinking' || m.state === 'paused')),
    ).toHaveLength(0);
  });
});
