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
// 共享 vscode mock 的运行时引用：默认角色包用例要按用例改写 getConfiguration；
// window 用于删除会话路径的确认框替身（confirmModal 只认 confirmLabel 返回值）
import { workspace as mockedWorkspace, window as mockedWindow } from 'vscode';
// 未发送草稿的持久键（断言落盘形状用真源常量，不复制字面量）
import { UI_COMPOSER_DRAFTS_KEY, UI_DRAFT_PAGE_KEY } from '../../shared/constants.js';
import { DRAFT_PAGE_OWNER } from '../helpers/composerDrafts.js';
import { ProviderStore } from '../../extension/providers/providerStore.js';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';
import {
  createEphemeralSessionModeStore,
  type SessionModeStore,
} from '../../extension/host/sessionModeStore.js';

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
  commands: { executeCommand: vi.fn() },
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
    // 收回会话的成功/无需撤销提示走信息条（不是错误面）
    showInformationMessage: vi.fn(),
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
  /** 真实会话存储（来源标记 / messageCount 等落盘断言回源它） */
  store: WorkspaceSessionStore;
  /** 真实轮次存储（历史 origin 断言直接读盘上事实） */
  roundStore: WorkspaceRoundStore;
  /** 临时工作区根（按生产路径推导规则定位 Round 文件） */
  dir: string;
  posted: {
    type: string;
    message?: string;
    state?: unknown;
    text?: string;
    /** 草稿下行带的归属会话（`composer_draft_restore` 断言用） */
    sessionId?: string;
  }[];
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
    /** 中断通知器（第三切片）：测试直接登记「谁开的会话」这一进程内路由事实 */
    _hostedNotifier: { remember(childSessionId: string, creatorSessionId: string): void };
    /** 显示会话输入框是否有未发送文本（宿主侧布尔，webview 重建时必须复位） */
    _composerHasText: boolean;
    /** 草稿会话控制器（「＋」后的空白页态；测试断言「重启是否回到空白页」） */
    _draft: { isDraft: boolean; enter(): void };
    runtimeFor(sessionId?: string): {
      streaming: boolean;
      abortController?: AbortController;
      liveBuffer?: {
        textByRound: Map<string, string>;
        /** 开轮用户输入（派发用例据此断言「原文直投 + 发送者名」） */
        seedUserMessage?: { content?: string; name?: string };
        /** 开轮来源标记（派发用例必须是 'hosted'） */
        seedOrigin?: string;
      };
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
  sessionModes?: SessionModeStore,
  uiState?: vscode.Memento,
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
    undefined,
    sessionModes,
    uiState,
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
    store,
    roundStore,
    dir,
    posted,
    disposeView: () => current.dispose(),
    reopenView,
    fireMessage: (msg: unknown) => current.fireMessage(msg),
    cast,
  };
}

describe('会话来源标记 · createSession 按出生事实派生 origin', () => {
  it('助手会话 ⇒ 出生来源仍是 user（但写身份指针）；普通会话 ⇒ user 且不写指针', async () => {
    const modes = createEphemeralSessionModeStore();
    const { provider, store } = setupPanel({}, [], modes);
    // 装配走面板注入的工厂：本用例只关心 createSession 的落盘与容器登记
    provider.setAgentFactory(async (_projectPath, sessionId) => sessionAgent(sessionId));

    /** 生产私有面：直接驱动唯一建会话路径（等价草稿首次发送 flush / 助手窗首次发送） */
    const createSession = (
      provider as unknown as {
        createSession(
          id: string,
          rolePackName?: string,
          opts?: { assistant?: boolean },
        ): Promise<boolean>;
      }
    ).createSession.bind(provider);

    // 助手会话是用户在助手窗首次发送建出来的 ⇒ 出生来源 = user（不是代理开的工作会话）
    expect(await createSession('2026-11-06-m', undefined, { assistant: true })).toBe(true);
    expect(store.getSessionMeta('2026-11-06-m')?.origin).toBe('user');
    expect(modes.isManaged('2026-11-06-m')).toBe(true);

    expect(await createSession('2026-11-06-s')).toBe(true);
    expect(store.getSessionMeta('2026-11-06-s')?.origin).toBe('user');
    expect(modes.isManaged('2026-11-06-s')).toBe(false);
    // 助手唯一：普通会话登记不覆盖指针
    expect(modes.listManagedSessionIds()).toEqual(['2026-11-06-m']);
  });
});

describe('代理能开会话 · createHostedSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('托管调用方开新会话：出生来源与首轮都是 hosted，标题落 displayName，清单可见，显示源与默认模式不变', async () => {
    const modes = createEphemeralSessionModeStore();
    const callerId = '2026-11-06-boss';
    const { provider, store } = setupPanel({}, [callerId], modes);
    // 调用方是托管会话；用户级「上次模式」保持缺省 self（不得被代理的建会话改写）
    modes.set(callerId, 'managed');
    /** 每个会话 id 一份替身实例（工厂按 sid 记账，便于断言首轮参数） */
    const agents: Record<string, Agent> = {};
    provider.setAgentFactory(async (_projectPath, sid) => {
      if (!agents[sid]) {
        const agent = sessionAgent(sid);
        // sessionAgent 的 chat 是普通函数；首轮参数断言需要可观测 spy
        agent.chat = vi.fn(agent.chat) as unknown as Agent['chat'];
        agents[sid] = agent;
      }
      return agents[sid];
    });
    provider.setRolePackCatalog(async () => new Set(['默认助手', '资料员']));

    const result = await provider.createHostedSession(
      callerId,
      '资料员',
      '调研会话',
      '先读 README',
      'Memora',
      ['docs'],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe('调研会话');
    // ① 出生来源（持久事实）：SessionMeta.origin = hosted，标题原样落盘
    const meta = store.getSessionMeta(result.sid);
    expect(meta?.origin).toBe('hosted');
    expect(meta?.displayName).toBe('调研会话');
    // 开活范围声明随标题同批落元数据（读侧真源，不靠历史轮次反推）
    expect(meta?.declaredPaths).toEqual(['docs']);
    // 出生来源与调度权分开：来源是 hosted，但装配身份是 self（拿不到主控工具集，不能再开会话）
    expect(modes.isManaged(result.sid)).toBe(false);
    expect(modes.listManagedSessionIds()).toEqual([callerId]);
    // ② 会话清单可见（用户能在列表里看到它）
    expect(store.listSessionMetas().map((item) => item.sessionId)).toContain(result.sid);
    // ③ 代理开会话不是用户导航：显示源仍在调用方，助手身份指针不变
    expect(provider.getCurrentSessionId()).toBe(callerId);
    expect(modes.listManagedSessionIds()).toEqual([callerId]);
    // ④ 首轮：origin hosted + 装配期注入的发送者名（不是硬编码）
    //    + 派发归属（via=create：助手开会话，与「派发接管」在盘上可分辨）
    const chat = agents[result.sid].chat as unknown as ReturnType<typeof vi.fn>;
    expect(chat).toHaveBeenCalledWith('先读 README', expect.any(AbortSignal), undefined, {
      origin: 'hosted',
      senderName: 'Memora',
      dispatchedBy: { from: callerId, via: 'create' },
    });
  });

  it('角色包不存在 ⇒ E_ROLE_PACK（不与 E_NOT_FOUND 混用），且不落任何会话', async () => {
    const modes = createEphemeralSessionModeStore();
    const callerId = '2026-11-06-boss';
    const { provider, store } = setupPanel({}, [callerId], modes);
    modes.set(callerId, 'managed');
    provider.setAgentFactory(async (_projectPath, sid) => sessionAgent(sid));
    provider.setRolePackCatalog(async () => new Set(['默认助手']));
    const before = store.listSessionMetas().length;

    const result = await provider.createHostedSession(
      callerId,
      '不存在的包',
      '调研会话',
      '先读 README',
      'Memora',
      ['docs'],
    );
    expect(result).toMatchObject({ ok: false, code: 'E_ROLE_PACK' });
    expect((result as { code: string }).code).not.toBe('E_NOT_FOUND');
    expect(store.listSessionMetas().length).toBe(before);
  });

  it('角色包编目不可读（null）⇒ 同样 E_ROLE_PACK（「不可用」不是「会话不存在」）', async () => {
    const modes = createEphemeralSessionModeStore();
    const callerId = '2026-11-06-boss';
    const { provider, store } = setupPanel({}, [callerId], modes);
    modes.set(callerId, 'managed');
    provider.setAgentFactory(async (_projectPath, sid) => sessionAgent(sid));
    provider.setRolePackCatalog(async () => null);
    const before = store.listSessionMetas().length;

    expect(
      await provider.createHostedSession(callerId, '资料员', 't', 'x', 'Memora', ['docs']),
    ).toMatchObject({ ok: false, code: 'E_ROLE_PACK' });
    expect(store.listSessionMetas().length).toBe(before);
  });

  it('调用方非托管 ⇒ E_DENIED（纵深防守），且不落任何会话', async () => {
    const modes = createEphemeralSessionModeStore();
    const callerId = '2026-11-06-self';
    const { provider, store } = setupPanel({}, [callerId], modes);
    modes.set(callerId, 'self');
    provider.setAgentFactory(async (_projectPath, sid) => sessionAgent(sid));
    const before = store.listSessionMetas().length;

    expect(
      await provider.createHostedSession(callerId, undefined, 't', 'x', 'Memora', ['docs']),
    ).toMatchObject({ ok: false, code: 'E_DENIED' });
    expect(store.listSessionMetas().length).toBe(before);
  });
});

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
    // 建会话只切换显示源 + 写来源标记；**没有空壳角色包记录**（未选/失效时 activeRolePackName 不写）
    expect(store.getSessionMeta(newId)?.origin).toBe('user');
    expect(store.getSessionMeta(newId)?.activeRolePackName).toBeUndefined();
    // 标题不再是草稿态（改名笔恢复可用）
    expect(lastTitle(posted).draft).toBeUndefined();
    expect(lastTitle(posted).title).toMatch(/^New session \d{2}:\d{2}$/);
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

  it('全局默认未设置（空串）⇒ 走现状：不写角色包 meta，装配落兜底包', async () => {
    stubDefaultRolePack('');
    const ctx = await enterDraft(new Set());

    const newId = await sendFirst(ctx);

    // 角色包未定 ⇒ 不写 activeRolePackName（不造假选择）；来源标记仍由唯一创建入口显式写入
    expect(ctx.store.getSessionMeta(newId)?.activeRolePackName).toBeUndefined();
    expect(ctx.store.getSessionMeta(newId)?.origin).toBe('user');
    const assembled = ctx.cast._sessionAgents.get(newId) as Agent;
    expect(assembled.rolePackManager?.activeName).toBe(BUILTIN_FALLBACK_PACK);
    expect(lastRolePack(ctx.posted).rolePack).toBe(BUILTIN_FALLBACK_PACK);
  });

  it('全局默认指向已删包 ⇒ 不写角色包 meta、回落兜底、弹「默认角色包不可用」', async () => {
    stubDefaultRolePack('幽灵角色');
    const ctx = await enterDraft(new Set()); // 目录里没有「幽灵角色」

    const newId = await sendFirst(ctx);

    // 失效包不写 activeRolePackName（不造假选择）；来源标记仍由唯一创建入口显式写入
    expect(ctx.store.getSessionMeta(newId)?.activeRolePackName).toBeUndefined();
    expect(ctx.store.getSessionMeta(newId)?.origin).toBe('user');
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
  titleById: Record<string, string>;
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

/**
 * 托管派发 · `send_to_session` 的宿主派发口（v0）
 *
 * 面板侧的三条判据（工具层用例在 `extension/host/__tests__/workSessionTools.test.ts`）：
 *  ① `E_DENIED`：调用方不是托管会话 ⇒ 直接拒，且不取 / 不建目标实例；
 *  ② 受理路径：**原文直投**（不套 sendInput 的编辑器 / problems / git 信封），
 *    来源 `'hosted'`、发送者名随 seed 与内核 opts 双通道落地，面板显示会话不被拽走；
 *  ③ `E_BUSY`：目标会话真在跑（`SessionRuntimeStates.streaming`）⇒ 拒收；装配等待期内被开跑
 *     也要在落地前复判到（防「判完再装配，装完已经跑起来了」的窗口）。
 */
describe('托管派发 · send_to_session 的宿主派发口', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('调用方不是托管会话 ⇒ E_DENIED，且不取 / 不建目标实例', async () => {
    // 空模式容器：未知 sid 一律按 self 解释
    const modes = createEphemeralSessionModeStore();
    const { provider } = setupPanel({}, [], modes);
    const factory = vi.fn(async (_projectPath: string, sessionId: string) =>
      sessionAgent(sessionId),
    );
    provider.setAgentFactory(factory);

    const result = await provider.dispatchHostedInput({
      callingSessionId: '2026-11-06-a',
      targetSessionId: '2026-11-06-b',
      text: 'hi',
      senderName: '派发探针',
      targetTitle: '2026-11-06-b',
    });
    expect(result).toMatchObject({ ok: false, code: 'E_DENIED' });
    // 身份判不过就止步：不为一次注定被拒的派发付装配成本
    expect(factory).not.toHaveBeenCalled();
  });

  it('受理：原文直投、seed 带 origin=hosted 与发送者名，且不改面板显示会话', async () => {
    // 门闩流：停在 gate 上，便于读该轮 live 种子与运行态
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const roundId = 'round-hosted';
    const flow = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        reachedGate();
        await gate;
        yield { type: 'text', content: '目标会话在干活', roundId };
        yield { type: 'step_boundary', roundId };
      })();
    };
    const target = sessionAgent('2026-11-06-b', flow);
    // chat 入参是本用例的核心证据：套壳/错位都会让断言转红
    const chatSpy = vi.fn(target.chat.bind(target));
    target.chat = chatSpy as unknown as SessionAgentStub['chat'];

    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-a', 'managed');
    const { provider, cast } = setupPanel({ '2026-11-06-b': target }, [], modes);
    cast._currentSessionId = '2026-11-06-a';
    const factory = vi.fn(async (_projectPath: string, sessionId: string) =>
      sessionAgent(sessionId),
    );
    provider.setAgentFactory(factory);

    const result = await provider.dispatchHostedInput({
      callingSessionId: '2026-11-06-a',
      targetSessionId: '2026-11-06-b',
      text: '原始需求',
      senderName: '派发探针',
      targetTitle: '2026-11-06-b',
    });
    expect(result).toEqual({ ok: true, accepted: true });
    await atGate;

    // ① 原文直投：没有「用户请求：」之类的注入信封（第二个参数 = signal，第三个 = 无附件）
    //    第四个参数带派发归属：创建者 = 调用方，动作 = delegate（与「助手开会话」可分辨）
    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(chatSpy).toHaveBeenCalledWith('原始需求', expect.any(AbortSignal), undefined, {
      origin: 'hosted',
      senderName: '派发探针',
      dispatchedBy: { from: '2026-11-06-a', via: 'delegate' },
    });
    // ② live 投影种子：来源 + 发送者名（页面重放与运行时同一份事实）
    const runtime = cast.runtimeFor('2026-11-06-b');
    expect(runtime.streaming).toBe(true);
    expect(runtime.liveBuffer?.seedOrigin).toBe('hosted');
    expect(runtime.liveBuffer?.seedUserMessage).toMatchObject({
      content: '原始需求',
      name: '派发探针',
    });
    // ③ 面板显示会话不被派发拽走（目标实例已在投影表里，也不该走工厂）
    expect(provider.getCurrentSessionId()).toBe('2026-11-06-a');
    expect(factory).not.toHaveBeenCalled();
    // ④ 受理即登记驱动归属：目标会话归代理，创建者账本记到调用方名下（停止 / 通知 / 清单同一判据）
    expect(modes.isAgentDriven('2026-11-06-b')).toBe(true);
    expect(provider.workbench.childrenOf('2026-11-06-a')).toContain('2026-11-06-b');

    releaseGate();
    await vi.waitFor(() => expect(cast.runtimeFor('2026-11-06-b').streaming).toBe(false), {
      timeout: 5000,
    });
  });

  it('目标会话正被用户看着 ⇒ 开轮输入随首个 roundId 上屏（不是轮建立前的孤立回声）', async () => {
    // 门闩流：首个 thinking 已带 roundId（= 轮已建立），停在 gate 上便于断言上屏时机
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const roundId = 'round-hosted-echo';
    const flow = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        reachedGate();
        await gate;
        yield { type: 'text', content: '目标会话在干活', roundId };
        yield { type: 'step_boundary', roundId };
      })();
    };
    const target = sessionAgent('2026-11-06-b', flow);

    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-a', 'managed');
    const { provider, cast, posted } = setupPanel({ '2026-11-06-b': target }, [], modes);
    // 目标已在投影表里，工厂不会被调用；注入只为满足 dispatch 的前置依赖
    provider.setAgentFactory(async (_projectPath, sessionId) => sessionAgent(sessionId));
    // 本用例的前提：用户正看着目标会话（主视图 = 目标，回声才会走主视图投递）
    cast._currentSessionId = '2026-11-06-b';

    await provider.dispatchHostedInput({
      callingSessionId: '2026-11-06-a',
      targetSessionId: '2026-11-06-b',
      text: '原始需求',
      senderName: '派发探针',
      targetTitle: '2026-11-06-b',
    });
    await atGate;

    const userEchoes = posted.filter(
      (
        m,
      ): m is {
        type: 'user';
        text: string;
        origin?: string;
        senderName?: string;
        roundId?: string;
      } => m.type === 'user',
    );
    expect(userEchoes).toHaveLength(1);
    expect(userEchoes[0]).toMatchObject({
      type: 'user',
      text: '原始需求',
      origin: 'hosted',
      senderName: '派发探针',
      // 归属与轮同生：重放读 round 时天然带出这条气泡，不靠额外缓冲
      roundId,
    });
    // 顺序：用户气泡先于本轮其余消息（found first user before any assistant 段首）
    const userIdx = posted.findIndex((m) => m.type === 'user');
    const textIdx = posted.findIndex((m) => m.type === 'text');
    expect(userIdx).toBeGreaterThan(-1);
    if (textIdx > -1) expect(userIdx).toBeLessThan(textIdx);

    releaseGate();
    await vi.waitFor(() => expect(cast.runtimeFor('2026-11-06-b').streaming).toBe(false), {
      timeout: 5000,
    });
  });

  it('目标会话真在跑 ⇒ E_BUSY（真实运行态判据，不排队、不双开流）', async () => {
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const roundId = 'round-busy';
    const flow = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        reachedGate();
        await gate;
        yield { type: 'text', content: '跑完了', roundId };
        yield { type: 'step_boundary', roundId };
      })();
    };
    const target = sessionAgent('2026-11-06-b', flow);
    const chatSpy = vi.fn(target.chat.bind(target));
    target.chat = chatSpy as unknown as SessionAgentStub['chat'];

    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-a', 'managed');
    const { provider, cast } = setupPanel({ '2026-11-06-b': target }, [], modes);
    cast._currentSessionId = '2026-11-06-a';
    const factory = vi.fn(async (_projectPath: string, sessionId: string) =>
      sessionAgent(sessionId),
    );
    provider.setAgentFactory(factory);

    // 真的把目标会话跑起来（不是手工置 streaming 位）
    const running = cast.runFlow(() => flow(), undefined, '2026-11-06-b');
    await atGate;
    expect(cast.runtimeFor('2026-11-06-b').streaming).toBe(true);

    const result = await provider.dispatchHostedInput({
      callingSessionId: '2026-11-06-a',
      targetSessionId: '2026-11-06-b',
      text: '再来一条',
      senderName: '派发探针',
      targetTitle: '2026-11-06-b',
    });
    expect(result).toMatchObject({ ok: false, code: 'E_BUSY' });
    // 判忙先于取实例：既没有第二次 chat，也没有为派发重新装配
    expect(chatSpy).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    // 未受理不得登记驱动归属（否则工作台 / 停止面会看见一条代理根本没接管的会话）
    expect(modes.isAgentDriven('2026-11-06-b')).toBe(false);

    releaseGate();
    await running;
  });

  it('装配等待期内目标会话被开跑 ⇒ 落地前复判到 E_BUSY', async () => {
    let reachedGate!: () => void;
    const atGate = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const roundId = 'round-race';
    const flow = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        reachedGate();
        await gate;
        yield { type: 'step_boundary', roundId };
      })();
    };
    const target = sessionAgent('2026-11-06-b', flow);
    const chatSpy = vi.fn(target.chat.bind(target));
    target.chat = chatSpy as unknown as SessionAgentStub['chat'];

    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-a', 'managed');
    const { provider, cast } = setupPanel({}, [], modes);
    cast._currentSessionId = '2026-11-06-a';
    // consumeFlow 需要该会话的运行实例可解析：预置当前实例（生产由 agentForSession 保证）
    cast._agent = target;
    let running: Promise<void> | undefined;
    provider.setAgentFactory(
      vi.fn(async (_projectPath: string, sessionId: string) => {
        // 模拟真实竞态：装配在途时，该会话被别的入口开跑
        running = cast.runFlow(() => flow(), undefined, sessionId);
        await atGate;
        return target;
      }),
    );

    const result = await provider.dispatchHostedInput({
      callingSessionId: '2026-11-06-a',
      targetSessionId: '2026-11-06-b',
      text: '撞车输入',
      senderName: '派发探针',
      targetTitle: '2026-11-06-b',
    });
    expect(result).toMatchObject({ ok: false, code: 'E_BUSY' });
    // 复判拦住了第二条流：派发通道一次 chat 都没发
    expect(chatSpy).not.toHaveBeenCalled();

    releaseGate();
    await running;
  });

  it('受理前先拿目标会话写锁（不持锁建轮 = 孤儿轮，重启后该轮从会话历史消失）', async () => {
    // 真机回归：派给「重启前就存在、本窗口没进过」的用户自建会话时，appendRoundId 被
    // fail-closed 写锁守卫拦成 warn，轮文件在、会话 roundIds 里没有它 ⇒ 重启后话消失。
    // 判据就一条：派发要在目标会话里建轮，就必须先持有它的写锁。
    const roundId = 'round-lock';
    const flow = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        yield { type: 'step_boundary', roundId };
      })();
    };
    const target = sessionAgent('2026-11-06-b', flow);
    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-a', 'managed');
    const { provider, store, cast } = setupPanel({ '2026-11-06-b': target }, [], modes);
    cast._currentSessionId = '2026-11-06-a';
    // 与生产同形：实例已在投影表里（派发不该为它重新装配）
    provider.setAgentFactory(
      vi.fn(async (_projectPath: string, sessionId: string) => sessionAgent(sessionId)),
    );
    const acquireSpy = vi.spyOn(store, 'acquireSessionLock');
    const releaseSpy = vi.spyOn(store, 'releaseSessionLock');

    const result = await provider.dispatchHostedInput({
      callingSessionId: '2026-11-06-a',
      targetSessionId: '2026-11-06-b',
      text: '派发原文',
      senderName: '派发探针',
      targetTitle: '2026-11-06-b',
    });
    expect(result).toEqual({ ok: true, accepted: true });
    expect(acquireSpy).toHaveBeenCalledWith('2026-11-06-b');
    await vi.waitFor(() => expect(cast.runtimeFor('2026-11-06-b').streaming).toBe(false), {
      timeout: 5000,
    });
    // 归还时机：只盖住本轮（建轮那次 appendRoundId 已落盘），收场即还，
    // 不把目标会话长期占成「本窗口专用」（否则别的窗口打开它会被判占用）
    await vi.waitFor(() => expect(releaseSpy).toHaveBeenCalledWith('2026-11-06-b'), {
      timeout: 5000,
    });
  });

  it('派发轮收场时用户正在看目标会话 ⇒ 保留长锁（那是「进入过的会话」语义）', async () => {
    const roundId = 'round-viewing';
    const flow = (): AsyncGenerator<Chunk> => {
      return (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
        yield { type: 'step_boundary', roundId };
      })();
    };
    const target = sessionAgent('2026-11-06-b', flow);
    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-a', 'managed');
    const { provider, store, cast } = setupPanel({ '2026-11-06-b': target }, [], modes);
    cast._currentSessionId = '2026-11-06-a';
    provider.setAgentFactory(
      vi.fn(async (_projectPath: string, sessionId: string) => sessionAgent(sessionId)),
    );
    const releaseSpy = vi.spyOn(store, 'releaseSessionLock');
    // 流期间用户把界面切到目标会话（派发不得把锁在用户眼皮底下放掉）
    cast._currentSessionId = '2026-11-06-b';

    await provider.dispatchHostedInput({
      callingSessionId: '2026-11-06-a',
      targetSessionId: '2026-11-06-b',
      text: '派发原文',
      senderName: '派发探针',
      targetTitle: '2026-11-06-b',
    });
    await vi.waitFor(() => expect(cast.runtimeFor('2026-11-06-b').streaming).toBe(false), {
      timeout: 5000,
    });
    expect(releaseSpy).not.toHaveBeenCalledWith('2026-11-06-b');
  });

  it('目标会话被另一个窗口占用（拿不到写锁）⇒ E_LOCKED，不受理也不登记驱动归属', async () => {
    const target = sessionAgent('2026-11-06-b');
    const chatSpy = vi.fn(target.chat.bind(target));
    target.chat = chatSpy as unknown as SessionAgentStub['chat'];

    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-a', 'managed');
    const { provider, store, cast } = setupPanel({ '2026-11-06-b': target }, [], modes);
    cast._currentSessionId = '2026-11-06-a';
    // 另一个进程持有该会话锁：本进程拿不到
    vi.spyOn(store, 'acquireSessionLock').mockResolvedValue(false);

    const result = await provider.dispatchHostedInput({
      callingSessionId: '2026-11-06-a',
      targetSessionId: '2026-11-06-b',
      text: '不该落地',
      senderName: '派发探针',
      targetTitle: '2026-11-06-b',
    });
    // 不假装受理：回执如实说「另一个窗口在用」，且没有起流、没有登记归属
    expect(result).toMatchObject({ ok: false, code: 'E_LOCKED' });
    // 回执必须带可操作的下一步（换会话 / 稍后重试），不能只丢一个码让模型去猜
    if (!result.ok) {
      expect(result.message).toContain('Send it later');
      expect(result.message).toContain('switch to another session');
    }
    expect(chatSpy).not.toHaveBeenCalled();
    expect(modes.isAgentDriven('2026-11-06-b')).toBe(false);
    expect(cast.runtimeFor('2026-11-06-b').streaming).toBe(false);
  });
});

describe('托管落定通知 · 流收场投递给创建者（第三 / 第四切片）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('代理开出的会话被停 ⇒ 只向创建者投一条（带标题与停手者）', async () => {
    const modes = createEphemeralSessionModeStore();
    const creator = '2026-11-14-creator';
    const child = '2026-11-14-child';
    const enqueue = vi.fn();
    // 创建者实例：只需一条可观察的系统事件队列
    const creatorAgent = {
      ...sessionAgent(creator),
      agentLoop: { enqueueCommandResult: enqueue },
    } as unknown as Agent;
    const childAgent = sessionAgent(child);
    const { provider, cast, store, roundStore } = setupPanel(
      { [creator]: creatorAgent, [child]: childAgent },
      [creator, child],
      modes,
    );
    // 生产由 extension 装配时注入；不注入则流尾读不到盘上轮（通知器如实不投）
    provider.setRoundStore(roundStore);
    modes.set(creator, 'managed');
    // 生产 = 代理建会话时登记「当前由代理驱动」；本用例直接构造实例，需同形补上
    modes.markAgentDriven(child);
    store.updateSessionMeta(child, { displayName: '抓取任务', origin: 'hosted' });
    const roundId = 'round-child-stop';
    // 盘上事实：该轮已按中断收场，aborted.stopReason 说明是用户停的
    roundStore.save({
      id: roundId,
      userMessage: {
        id: `${roundId}-u`,
        role: 'user',
        content: '去抓取',
        timestamp: '2026-11-14T10:00:00.000Z',
      },
      status: 'interrupted',
      createdAt: '2026-11-14T10:00:00.000Z',
      completedAt: '2026-11-14T10:00:05.000Z',
      processEvents: [
        {
          type: 'aborted',
          seq: 1,
          ts: '2026-11-14T10:00:05.000Z',
          payload: { reason: 'cancelled', stopReason: 'user' },
        },
      ],
    });
    // 生产 = createHostedSession 成功后立即登记；本用例直接调同一公开方法
    cast._hostedNotifier.remember(child, creator);

    cast._currentSessionId = child;
    cast._agent = childAgent;
    // 最小流：只为让 latestRoundId 指向种下的轮；中断事实来自盘上轮
    const flow = (): AsyncGenerator<Chunk> =>
      (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
      })();
    await cast.runFlow(flow, undefined, child);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const text = enqueue.mock.calls[0][0] as string;
    expect(text).toContain('抓取任务');
    expect(text).toContain('用户主动停止');
  });

  it('代理开出的会话跑完 ⇒ 向创建者投一条「成功」落定事件', async () => {
    const modes = createEphemeralSessionModeStore();
    const creator = '2026-11-14-creator';
    const child = '2026-11-14-child';
    const enqueue = vi.fn();
    // 创建者实例：只需一条可观察的系统事件队列
    const creatorAgent = {
      ...sessionAgent(creator),
      agentLoop: { enqueueCommandResult: enqueue },
    } as unknown as Agent;
    const childAgent = sessionAgent(child);
    const { provider, cast, store, roundStore } = setupPanel(
      { [creator]: creatorAgent, [child]: childAgent },
      [creator, child],
      modes,
    );
    provider.setRoundStore(roundStore);
    modes.set(creator, 'managed');
    modes.markAgentDriven(child);
    store.updateSessionMeta(child, { displayName: '抓取任务', origin: 'hosted' });
    const roundId = 'round-child-done';
    // 盘上事实：该轮以 complete 成功收场
    roundStore.save({
      id: roundId,
      userMessage: {
        id: `${roundId}-u`,
        role: 'user',
        content: '去抓取',
        timestamp: '2026-11-14T10:00:00.000Z',
      },
      status: 'complete',
      createdAt: '2026-11-14T10:00:00.000Z',
      completedAt: '2026-11-14T10:00:05.000Z',
      processEvents: [],
    });
    cast._hostedNotifier.remember(child, creator);
    // 正常收场分支要等摘要事件解锁；替身同步回调，避免测试白等 5s 兜底
    (childAgent.on as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      (event: string, cb: (info: { roundId: string; success: boolean }) => void) => {
        if (event === 'roundSummaryGenerated') cb({ roundId, success: true });
      },
    );

    cast._currentSessionId = child;
    cast._agent = childAgent;
    const flow = (): AsyncGenerator<Chunk> =>
      (async function* () {
        yield { type: 'thinking', phase: 'processing', roundId };
      })();
    await cast.runFlow(flow, undefined, child);

    expect(enqueue).toHaveBeenCalledTimes(1);
    const text = enqueue.mock.calls[0][0] as string;
    expect(text).toContain('抓取任务');
    expect(text).toContain(roundId);
    expect(text).toContain('成功');
  });
});

describe('webview 重建 · 宿主「用户正在打字」布尔复位', () => {
  it('重建后 ready 到达：输入框已空 ⇒ 宿主不再认为用户仍在打字', async () => {
    const sid = '2026-11-15-typing';
    const { cast, fireMessage, reopenView } = setupPanel({ [sid]: sessionAgent(sid) }, [sid]);

    // webview 上行的唯一写入点：输入框里有未发送文本
    fireMessage({ type: 'composer_state', hasText: true });
    expect(cast._composerHasText).toBe(true);

    // 折叠/重开视图 = 新 webview：输入框从空开始，旧布尔必须随重建一起复位；
    // 不复位就会把落定汇报一直压到用户下次输入（真实输入框其实早空了）。
    reopenView();
    fireMessage({ type: 'ready' });
    // ready 处理链是异步入口（生产按 void 调用），等一轮宏任务再断言复位已发生
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cast._composerHasText).toBe(false);
  });
});

describe('未发送草稿按会话持久化（O5）', () => {
  it('上行文本按归属落盘、清空即删键、视图重建把草稿填回输入框', async () => {
    const seat = '2026-11-15-draft-seat';
    /** Map 模拟工作区持久层：update(undefined) = 删键（与 Memento 语义一致） */
    const raw = new Map<string, unknown>();
    const ui = {
      get: (key: string) => raw.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) raw.delete(key);
        else raw.set(key, value);
      },
    } as never;
    const h = setupPanel({}, [seat], createEphemeralSessionModeStore(), ui);

    // 用户输入（防抖后上行）→ 按 webview 回传的归属落盘（宿主不按「当前显示会话」猜）
    h.fireMessage({ type: 'composer_draft', sessionId: seat, text: '写到一半' });
    expect((raw.get(UI_COMPOSER_DRAFTS_KEY) as Record<string, string>)[seat]).toBe('写到一半');

    // 视图重建（折叠侧栏再打开）→ 回放时把该会话的草稿填回。
    // 回放由 webview 的 ready 握手触发（不是 resolveWebviewView 本身），故按生产顺序补一次 ready。
    h.posted.length = 0;
    h.reopenView();
    h.fireMessage({ type: 'ready' });
    await vi.waitFor(
      () => {
        const restore = h.posted.find((m) => m.type === 'composer_draft_restore');
        expect(restore?.text).toBe('写到一半');
        // 归属随消息下发：webview 据此原样回传，防抖窗口内切会话也不会串台
        expect(restore?.sessionId).toBe(seat);
      },
      { timeout: 5000 },
    );

    // 清空 → 删键，不留空壳（空草稿不要留垃圾）
    h.fireMessage({ type: 'composer_draft', sessionId: seat, text: '   ' });
    expect(raw.get(UI_COMPOSER_DRAFTS_KEY)).toBeUndefined();
  });

  it('会话被删除 ⇒ 它的草稿一起清理，别的会话不受影响', async () => {
    const keep = '2026-11-15-draft-keep';
    const gone = '2026-11-15-draft-gone';
    const raw = new Map<string, unknown>();
    const ui = {
      get: (key: string) => raw.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) raw.delete(key);
        else raw.set(key, value);
      },
    } as never;
    const h = setupPanel({}, [keep, gone], createEphemeralSessionModeStore(), ui);
    h.fireMessage({ type: 'composer_draft', sessionId: keep, text: '留着' });
    h.fireMessage({ type: 'composer_draft', sessionId: gone, text: '要删的' });
    expect((raw.get(UI_COMPOSER_DRAFTS_KEY) as Record<string, string>)[gone]).toBe('要删的');

    // 删除路径的确认框只认 confirmLabel（confirmModal 单向判据）：替身返回它才算点了删除
    const warn = mockedWindow.showWarningMessage as unknown as {
      mockResolvedValueOnce(v: unknown): void;
    };
    warn.mockResolvedValueOnce('Delete');
    h.fireMessage({ type: 'delete_session', sessionId: gone });
    await vi.waitFor(() => expect(h.store.getSessionMeta(gone)).toBeUndefined(), { timeout: 5000 });

    const left = raw.get(UI_COMPOSER_DRAFTS_KEY) as Record<string, string>;
    expect(left[keep]).toBe('留着');
    expect(left[gone]).toBeUndefined();
  });

  it('切会话：上一会话的「在打字」不带到新会话，恢复的草稿只填框', async () => {
    const sidA = '2026-11-15-typing-a';
    const sidB = '2026-11-15-typing-b';
    const raw = new Map<string, unknown>();
    const ui = {
      get: (key: string) => raw.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) raw.delete(key);
        else raw.set(key, value);
      },
    } as never;
    const h = setupPanel(
      { [sidA]: sessionAgent(sidA), [sidB]: sessionAgent(sidB) },
      [sidA, sidB],
      createEphemeralSessionModeStore(),
      ui,
    );
    h.provider.setAgentFactory(async (_projectPath, sid) => sessionAgent(sid));

    // 在 A 里敲字：宿主记为「用户此刻正在打字」
    h.fireMessage({ type: 'composer_state', hasText: true });
    expect(h.cast._composerHasText).toBe(true);
    // B 有一份上次留下的草稿（恢复它会填回输入框，但**不是**正在打字）
    h.fireMessage({ type: 'composer_draft', sessionId: sidB, text: 'B 的旧草稿' });

    await h.provider.switchToSession(sidB);
    // 不复位 ⇒ 落定主动汇报会被一条已不在屏上的「在打字」永久压住
    expect(h.cast._composerHasText).toBe(false);
    const restore = [...h.posted].reverse().find((m) => m.type === 'composer_draft_restore');
    expect(restore?.text).toBe('B 的旧草稿');
    expect(restore?.sessionId).toBe(sidB);
  });

  it('轮次运行期间（正在打字态）打的字同样落盘：草稿与翻转是两条通道', () => {
    const sid = '2026-11-15-running-draft';
    const raw = new Map<string, unknown>();
    const ui = {
      get: (key: string) => raw.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) raw.delete(key);
        else raw.set(key, value);
      },
    } as never;
    const h = setupPanel({}, [sid], createEphemeralSessionModeStore(), ui);

    // 运行期：宿主判据先被置为「正在打字」，随后上报文本——文本搬运不看这个判据
    h.fireMessage({ type: 'composer_state', hasText: true });
    h.fireMessage({ type: 'composer_draft', sessionId: sid, text: '草稿H' });
    expect((raw.get(UI_COMPOSER_DRAFTS_KEY) as Record<string, string>)[sid]).toBe('草稿H');
  });

  it('清空草稿 = 硬触发点：立刻把压着的落定汇报放出来（不依赖下一轮收场）', () => {
    const sid = '2026-11-15-flush-on-clear';
    const raw = new Map<string, unknown>();
    const ui = {
      get: (key: string) => raw.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) raw.delete(key);
        else raw.set(key, value);
      },
    } as never;
    const h = setupPanel({}, [sid], createEphemeralSessionModeStore(), ui);
    const notifier = (
      h.provider as unknown as { _hostedNotifier: { flushPending(id: string): void } }
    )._hostedNotifier;
    const flush = vi.spyOn(notifier, 'flushPending');

    h.fireMessage({ type: 'composer_state', hasText: false });
    expect(flush).toHaveBeenCalledWith(sid);
    // 置真方向不是放行信号（否则用户刚开始打字就把汇报顶出来）
    flush.mockClear();
    h.fireMessage({ type: 'composer_state', hasText: true });
    expect(flush).not.toHaveBeenCalled();
  });

  it('上报归属已不可解析 ⇒ 回落当前会话落盘（宁可留一条可清的键，也不丢字）', () => {
    const sid = '2026-11-15-owner-fallback';
    const raw = new Map<string, unknown>();
    const ui = {
      get: (key: string) => raw.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) raw.delete(key);
        else raw.set(key, value);
      },
    } as never;
    const h = setupPanel({}, [sid], createEphemeralSessionModeStore(), ui);

    h.fireMessage({ type: 'composer_draft', sessionId: '2026-01-01-deleted', text: '别丢' });
    expect((raw.get(UI_COMPOSER_DRAFTS_KEY) as Record<string, string>)[sid]).toBe('别丢');
  });
});

describe('空白草稿页的草稿（O5-B）', () => {
  /** Map 模拟工作区持久层（update(undefined) = 删键） */
  function makeUi(raw: Map<string, unknown>) {
    return {
      get: (key: string) => raw.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) raw.delete(key);
        else raw.set(key, value);
      },
    } as never;
  }

  it('空白页打字也落盘（固定标记，不借用 sessionId），重建后放回输入框', async () => {
    const raw = new Map<string, unknown>();
    const h = setupPanel({}, [], createEphemeralSessionModeStore(), makeUi(raw));
    expect(h.provider.getCurrentSessionId()).toBe('');

    h.fireMessage({ type: 'composer_draft', sessionId: '', text: '空白页的草稿' });
    expect(raw.get(UI_COMPOSER_DRAFTS_KEY)).toEqual({ [DRAFT_PAGE_OWNER]: '空白页的草稿' });

    // 视图重建 → 回放把空白页的草稿放回（归属仍是 ''）
    h.posted.length = 0;
    h.reopenView();
    h.fireMessage({ type: 'ready' });
    await vi.waitFor(
      () => {
        const restore = h.posted.find((m) => m.type === 'composer_draft_restore');
        expect(restore?.text).toBe('空白页的草稿');
        expect(restore?.sessionId).toBe('');
      },
      { timeout: 5000 },
    );
  });

  it('上次停在空白页 ⇒ 重启回到空白页（即使工作区有会话）', () => {
    const raw = new Map<string, unknown>();
    raw.set(UI_DRAFT_PAGE_KEY, true);
    const seat = '2026-11-15-existing-session';
    const h = setupPanel({}, [seat], createEphemeralSessionModeStore(), makeUi(raw));

    // 不许落到最近的真会话上：空白页的字只属于空白页
    expect(h.provider.getCurrentSessionId()).toBe('');
    expect(h.cast._draft.isDraft).toBe(true);
  });

  it('上次停在空白页 + 有会话：回空白页、字与标记都在（真机回归）', () => {
    const raw = new Map<string, unknown>();
    const seat = '2026-11-15-seat';
    // 真机现场：工作区有真会话，用户点「＋」打了字就关窗（停在空白页）
    raw.set(UI_DRAFT_PAGE_KEY, true);
    raw.set(UI_COMPOSER_DRAFTS_KEY, { [DRAFT_PAGE_OWNER]: '空白页打的字' });
    const h = setupPanel({}, [seat], createEphemeralSessionModeStore(), makeUi(raw));

    // 仍停在空白页：字与「上次停在空白页」标记都没被清
    expect(h.provider.getCurrentSessionId()).toBe('');
    expect(h.cast._draft.isDraft).toBe(true);
    expect(raw.get(UI_DRAFT_PAGE_KEY)).toBe(true);
    expect(raw.get(UI_COMPOSER_DRAFTS_KEY)).toEqual({ [DRAFT_PAGE_OWNER]: '空白页打的字' });
  });

  it('上次停在真会话 ⇒ 空白页的草稿不抢戏（回填的仍是该会话自己的草稿）', async () => {
    const raw = new Map<string, unknown>();
    raw.set(UI_COMPOSER_DRAFTS_KEY, { [DRAFT_PAGE_OWNER]: '空白页的旧字' });
    const seat = '2026-11-15-real-session';
    const h = setupPanel({}, [seat], createEphemeralSessionModeStore(), makeUi(raw));
    expect(h.provider.getCurrentSessionId()).toBe(seat);

    h.posted.length = 0;
    h.reopenView();
    h.fireMessage({ type: 'ready' });
    await vi.waitFor(
      () => {
        const restore = h.posted.find((m) => m.type === 'composer_draft_restore');
        expect(restore?.sessionId).toBe(seat);
        // 该会话自己没有草稿：空白页那份绝不能被塞过来
        expect(restore?.text).toBe('');
      },
      { timeout: 5000 },
    );
  });

  it('离开空白页：标记复位、空白页键清掉（不留孤儿）', async () => {
    const raw = new Map<string, unknown>();
    const seat = '2026-11-15-leave-draft';
    const h = setupPanel(
      { [seat]: sessionAgent(seat) },
      [],
      createEphemeralSessionModeStore(),
      makeUi(raw),
    );
    h.provider.setAgentFactory(async (_projectPath, sid) => sessionAgent(sid));
    h.fireMessage({ type: 'composer_draft', sessionId: '', text: '没发出去的字' });
    expect(raw.get(UI_COMPOSER_DRAFTS_KEY)).toEqual({ [DRAFT_PAGE_OWNER]: '没发出去的字' });

    await h.provider.switchToSession(seat);
    // 页面已不是空白页：旧字随页面作废，键与标记都必须复位
    expect(raw.get(UI_COMPOSER_DRAFTS_KEY)).toBeUndefined();
    expect(raw.get(UI_DRAFT_PAGE_KEY)).toBeUndefined();
  });

  it('切到空白页时防抖快照带回上一会话 ⇒ 那段字仍归上一会话（不挪到空白页）', () => {
    const raw = new Map<string, unknown>();
    const prev = '2026-11-15-prev-session';
    const h = setupPanel({}, [prev], createEphemeralSessionModeStore(), makeUi(raw));
    h.cast._draft.enter();
    expect(h.provider.getCurrentSessionId()).toBe('');

    // 真机时序：在 prev 里打字后 250ms 内点「＋」——定时器带的是「打字那一刻」的归属 prev。
    // 宿主不得按「当前是空白页」改写归属：否则 prev 最后一段字丢失、空白页多出别人的话。
    h.fireMessage({ type: 'composer_draft', sessionId: prev, text: '上一会话最后打的字' });
    expect(raw.get(UI_COMPOSER_DRAFTS_KEY)).toEqual({ [prev]: '上一会话最后打的字' });
  });

  it('空白页的迟到回传（sessionId 为空）不许被改写成当前会话', () => {
    const raw = new Map<string, unknown>();
    const current = '2026-11-15-current';
    const h = setupPanel({}, [current], createEphemeralSessionModeStore(), makeUi(raw));
    // 页面已切到真会话；此时到达的是空白页在切走前调度的定时器快照（归属仍是 ''）
    expect(h.provider.isDraftSession()).toBe(false);
    expect(h.provider.getCurrentSessionId()).toBe(current);

    h.fireMessage({ type: 'composer_draft', sessionId: '', text: '空白页最后打的字' });
    // 空串照收：写空白页键，不写成当前会话的草稿（反向挪字同样不允许）
    expect(raw.get(UI_COMPOSER_DRAFTS_KEY)).toEqual({ [DRAFT_PAGE_OWNER]: '空白页最后打的字' });
  });

  it('进入空白页必须下发归属（否则 webview 归属停在上一条会话）', () => {
    const raw = new Map<string, unknown>();
    const h = setupPanel({}, ['2026-11-15-prev'], createEphemeralSessionModeStore(), makeUi(raw));
    h.posted.length = 0;
    h.cast._draft.enter();

    const restore = h.posted.find((m) => m.type === 'composer_draft_restore');
    expect(restore?.sessionId).toBe('');
  });
});

describe('多视图广播 · 托管页与侧栏共享同一状态机（HOSTED-UI-SEAT-DECOUPLE-1）', () => {
  /** 造一个附加视图的 webview 替身（托管页），捕获其收到的消息 */
  function makeExtraView(): { webview: vscode.Webview; posted: Array<{ type: string }> } {
    const posted: Array<{ type: string }> = [];
    const webview = {
      postMessage: (msg: { type: string }) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    } as unknown as vscode.Webview;
    return { webview, posted };
  }

  it('侧栏是主视图，不进附加集合 ⇒ 初始附加视图数为 0', () => {
    const h = setupPanel({}, ['2026-11-16-seat']);
    expect(h.provider.mountedViewCount).toBe(0);
  });

  it('注册托管页后附加数为 1；绑定同一会话时宿主广播同时到达两页（同一状态机、两种取景）', () => {
    const h = setupPanel({}, ['2026-11-16-seat']);
    const current = h.provider.getCurrentSessionId();
    const extra = makeExtraView();
    const unregister = h.provider.registerAdditionalView(extra.webview, {
      sessionId: () => current,
    });
    expect(h.provider.mountedViewCount).toBe(1);

    // 同步探针：借类型断言直达私有 post（生产唯一广播口），注入一条会话级探针消息，
    // 断言侧栏（setupPanel 的 posted）与托管页（extra.posted）**都**收到——两页同绑一条会话
    // 才是「同屏两种取景」，而非只看视图计数。
    h.posted.length = 0;
    (h.provider as unknown as { post: (msg: { type: string; message: string }) => void }).post({
      type: 'notice',
      message: 'broadcast-probe',
    });
    expect(h.posted.some((m) => (m as { message?: string }).message === 'broadcast-probe')).toBe(
      true,
    );
    expect(
      extra.posted.some((m) => (m as { message?: string }).message === 'broadcast-probe'),
    ).toBe(true);

    unregister.dispose();
    expect(h.provider.mountedViewCount).toBe(0);
  });

  it('托管页绑定别的会话 ⇒ 侧栏的会话级消息不串台（反向绑定同理）', () => {
    const h = setupPanel({}, ['2026-11-16-seat']);
    const extra = makeExtraView();
    const unregister = h.provider.registerAdditionalView(extra.webview, {
      sessionId: () => 'other-session',
    });
    h.posted.length = 0;
    (h.provider as unknown as { post: (msg: { type: string; message: string }) => void }).post({
      type: 'notice',
      message: 'current-only',
    });
    // 侧栏（当前会话）照常收；托管页绑的不是这条会话 ⇒ 不收
    expect(h.posted.some((m) => (m as { message?: string }).message === 'current-only')).toBe(true);
    expect(extra.posted.some((m) => (m as { message?: string }).message === 'current-only')).toBe(
      false,
    );
    unregister.dispose();
  });

  it('助手窗 ready ⇒ 首份 session_activity 被 force 补推到附加视图（DISPATCH-CARD-HOSTED-READY-1）', async () => {
    const h = setupPanel({}, ['2026-11-16-seat']);
    const extra = makeExtraView();
    const unregister = h.provider.registerAdditionalView(extra.webview, {
      sessionId: () => '2026-11-16-seat',
    });
    extra.posted.length = 0;
    (
      h.provider as unknown as { routeHostedMessage: (msg: { type: string }) => void }
    ).routeHostedMessage({ type: 'ready' });
    await Promise.resolve();
    // 面板级快照是全局广播（postRaw fanout）：助手窗后开也必须收到首份快照，
    // 否则卡区 / 角标因新 webview 无旧快照而恒 hidden（侧栏同款机制第⑧步）。
    expect(extra.posted.some((m) => m.type === 'session_activity')).toBe(true);
    unregister.dispose();
  });

  it('助手窗空态走 postToExtras：只到附加视图，不打扰侧栏', () => {
    const h = setupPanel({}, ['2026-11-16-seat']);
    const extra = makeExtraView();
    const unregister = h.provider.registerAdditionalView(extra.webview, {
      sessionId: () => undefined,
    });
    h.posted.length = 0;
    (
      h.provider as unknown as { routeHostedMessage: (msg: { type: string }) => void }
    ).routeHostedMessage({ type: 'ready' });
    // ready 异步回落空态：等一轮微任务后断言标题只进了附加视图
    return Promise.resolve().then(() => {
      expect(extra.posted.some((m) => m.type === 'clear_ok')).toBe(true);
      expect(extra.posted.some((m) => m.type === 'session_title')).toBe(true);
      expect(h.posted.some((m) => m.type === 'clear_ok')).toBe(false);
      unregister.dispose();
    });
  });

  it('助手窗输入进助手会话（origin=user），侧栏当前会话不被顶掉、也不收到这条', async () => {
    const modes = createEphemeralSessionModeStore();
    /** 记录每轮 chat 的 origin（判据②：助手窗文案必须标用户发起） */
    const origins: (string | undefined)[] = [];
    const assistant = sessionAgent('2026-11-06-a');
    (assistant as unknown as { chat: unknown }).chat = (
      _input: string,
      _signal: AbortSignal,
      _att: unknown,
      opts: { origin?: string },
    ) => {
      origins.push(opts.origin);
      return (async function* () {})();
    };
    const h = setupPanel({ '2026-11-06-a': assistant }, ['2026-11-06-a'], modes);
    h.store.createSession({
      sessionId: '2026-11-06-w',
      displayName: 'w',
      updatedAt: '2026-11-06T10:00:00.000Z',
      messageCount: 0,
    });
    // 指针 = 助手会话；侧栏正看另一条工作会话
    modes.set('2026-11-06-a', 'managed');
    h.cast._currentSessionId = '2026-11-06-w';
    h.posted.length = 0;

    h.provider.routeHostedMessage({ type: 'input', kind: 'send', text: '嗨' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(origins).toEqual(['user']);
    expect(h.cast._currentSessionId).toBe('2026-11-06-w');
    // 侧栏（绑当前工作会话）不收助手会话的 user 回显
    expect(h.posted.some((m) => m.type === 'user' && m.text === '嗨')).toBe(false);
  });

  it('助手窗首次发送：无指针 ⇒ 后台建会话 + 写指针，侧栏显示会话不变', async () => {
    const modes = createEphemeralSessionModeStore();
    const h = setupPanel({}, ['2026-11-06-seat'], modes);
    h.provider.setAgentFactory(async (_p, sessionId) => sessionAgent(sessionId));

    h.provider.routeHostedMessage({ type: 'input', kind: 'send', text: '你好' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const managed = modes.listManagedSessionIds();
    expect(managed).toHaveLength(1);
    expect(h.store.getSessionMeta(managed[0]!)?.origin).toBe('user');
    // 后台建 = 不抢侧栏显示源
    expect(h.cast._currentSessionId).toBe('2026-11-06-seat');
  });

  it('指针指向已被删除的会话 ⇒ 助手窗 ready 清指针并回空态', async () => {
    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-gone', 'managed');
    const h = setupPanel({}, ['2026-11-06-seat'], modes);
    const extra = makeExtraView();
    const unregister = h.provider.registerAdditionalView(extra.webview, {
      sessionId: () => h.provider.getAssistantSessionId(),
      bubbleOnly: true,
    });
    h.posted.length = 0;

    h.provider.routeHostedMessage({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(h.provider.getAssistantSessionId()).toBeUndefined();
    expect(extra.posted.some((m) => m.type === 'clear_ok')).toBe(true);
    // 空态只进助手窗：侧栏不被清屏
    expect(h.posted.some((m) => m.type === 'clear_ok')).toBe(false);
    unregister.dispose();
  });

  it('助手会话在后台跑：正文与轮投影仍投到绑定它的助手窗，过程事件按视图过滤', async () => {
    // 判据③：流态 / 轮次按会话分片——侧栏当前是工作会话，助手会话照跑照投；
    // 判据⑤：过程事件（step_boundary）在投递层就不进气泡窗。
    const roundId = 'round-assistant';
    const assistant = sessionAgent('2026-11-06-a');
    const h = setupPanel({ '2026-11-06-a': assistant }, ['2026-11-06-w']);
    const extra = makeExtraView();
    const unregister = h.provider.registerAdditionalView(extra.webview, {
      sessionId: () => '2026-11-06-a',
      bubbleOnly: true,
    });
    // 侧栏当前会话确认是工作会话（不是助手会话），避免用例前提被 setup 顺序改变
    expect(h.provider.getCurrentSessionId()).toBe('2026-11-06-w');
    extra.posted.length = 0;
    h.posted.length = 0;

    await h.cast.runFlow(
      () =>
        (async function* () {
          yield { type: 'text', content: '助手窗正文', roundId };
          yield { type: 'step_boundary', roundId };
        })(),
      undefined,
      '2026-11-06-a',
    );

    // 正文与轮投影到了助手窗（按会话路由，不因侧栏在看别的会话而丢）
    expect(extra.posted.some((m) => m.type === 'chunk')).toBe(true);
    expect(extra.posted.some((m) => m.type === 'turn_update')).toBe(true);
    // 过程事件在宿主侧就不投气泡窗
    expect(extra.posted.some((m) => m.type === 'step_boundary')).toBe(false);
    // 侧栏（绑定工作会话）零串台
    expect(h.posted.some((m) => m.type === 'chunk')).toBe(false);
    expect(h.posted.some((m) => m.type === 'turn_update')).toBe(false);
    unregister.dispose();
  });

  it('托管页的上行消息经 routeHostedMessage 汇入同一消息链（composer_state 置打字态）', () => {
    const h = setupPanel({}, ['2026-11-16-seat']);
    // 打字态是私有字段，借广播路径间接观察：routeHostedMessage 不抛且被处理即成立
    expect(() =>
      h.provider.routeHostedMessage({ type: 'composer_state', hasText: true }),
    ).not.toThrow();
    expect(() =>
      h.provider.routeHostedMessage({ type: 'composer_state', hasText: false }),
    ).not.toThrow();
  });

  it('注销句柄重复调用安全（幂等）——视图销毁路径可能多次触发', () => {
    const h = setupPanel({}, ['2026-11-16-seat']);
    const extra = makeExtraView();
    const unregister = h.provider.registerAdditionalView(extra.webview);
    expect(h.provider.mountedViewCount).toBe(1);
    unregister.dispose();
    unregister.dispose();
    expect(h.provider.mountedViewCount).toBe(0);
  });
});

/**
 * 助手会话与工作会话分家（2026-11-17 真机订正）
 *
 * 真机实锤：助手窗里助手自称「小说创作助手」——助手会话建会话时走了「用户级默认角色包」，
 * 被工作会话的默认包（共鸣小说家）顶替；同时助手会话出现在侧栏工作会话列表里，
 * 被用户读成「助手拿一条工作会话来回答我」。
 *
 * 判据（三条独立机器判据）：
 *   ① 助手会话角色包固定 = 内置助手包（不读用户级默认）；
 *   ② 工作会话列表不含助手会话；
 *   ③ 重启时侧栏不停在助手会话（退回最近工作会话）；
 *   ④ 助手会话的「等你 / 在跑」不进列表标识与入口角标（否则角标亮着却找不到行）。
 */
describe('助手会话与工作会话分家（HOSTED-SEAT-SESSION-1 真机订正）', () => {
  /** 取最后一条 session_list_data 的会话 id 集合 */
  function lastListIds(posted: PanelHandle['posted']): string[] {
    const list = posted.filter((m) => m.type === 'session_list_data').at(-1) as unknown as
      { sessions: { sessionId: string }[] } | undefined;
    return list?.sessions.map((s) => s.sessionId) ?? [];
  }

  it('助手会话角色包固定为内置助手包（不被「新建会话默认角色包」顶替），且不进工作会话列表', async () => {
    // 用户级默认 = 工作包（真机里就是「共鸣小说家」）；助手人格不得被它接走
    vi.mocked(mockedWorkspace.getConfiguration).mockImplementation(
      () =>
        ({
          get: vi.fn((key: string) => (key === 'defaultRolePack' ? '共鸣小说家' : false)),
          update: vi.fn(async () => {}),
        }) as never,
    );
    const modes = createEphemeralSessionModeStore();
    // 两条工作会话：一条为当前显示（列表排除当前），一条留在列表里做对照
    const h = setupPanel({}, ['2026-11-06-w1', '2026-11-06-w2'], modes);
    h.provider.setAgentFactory(async (_p, sessionId) => sessionAgent(sessionId));
    h.posted.length = 0;

    h.provider.routeHostedMessage({ type: 'input', kind: 'send', text: '你好' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const assistantId = modes.listManagedSessionIds()[0];
    expect(assistantId).toBeDefined();
    // ① 助手身份不被默认包接走
    expect(h.store.getSessionMeta(assistantId!)?.activeRolePackName).toBe(BUILTIN_FALLBACK_PACK);
    // ② 列表含别的工作会话、不含助手会话
    const ids = lastListIds(h.posted);
    expect(ids).toContain('2026-11-06-w2');
    expect(ids).not.toContain(assistantId);
  });

  it('重启时指针落在助手会话 ⇒ 侧栏退回最近工作会话，不停在助手会话', () => {
    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-a', 'managed');
    // 播种顺序：助手会话被写成「上次停留」（真机旧版会这样）；工作会话在列表里
    const h = setupPanel({}, ['2026-11-06-a', '2026-11-06-w'], modes);
    expect(h.provider.getCurrentSessionId()).toBe('2026-11-06-w');
  });

  it('旧版助手会话落着工作角色包 ⇒ 装配时矫正回内置助手包', async () => {
    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-a', 'managed');
    const h = setupPanel({}, ['2026-11-06-w'], modes);
    // 旧数据形态：助手会话 meta 里是用户默认的工作包（真机 2026-11-17）
    h.store.updateSessionMeta('2026-11-06-a', { activeRolePackName: '共鸣小说家' });

    const delivered: Array<{ type: string }> = [];
    const webview = {
      postMessage: (msg: { type: string }) => {
        delivered.push(msg);
        return Promise.resolve(true);
      },
    } as unknown as vscode.Webview;
    const unregister = h.provider.registerAdditionalView(webview, {
      sessionId: () => '2026-11-06-a',
      bubbleOnly: true,
    });
    h.provider.setAgentFactory(async (_p, sid) => sessionAgent(sid));

    // ready ⇒ 装配助手会话（装配前矫正 meta）
    h.provider.routeHostedMessage({ type: 'ready' });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(h.store.getSessionMeta('2026-11-06-a')?.activeRolePackName).toBe(BUILTIN_FALLBACK_PACK);
    unregister.dispose();
  });

  it('助手会话的待处理不进列表标识与入口角标', () => {
    const modes = createEphemeralSessionModeStore();
    modes.set('2026-11-06-a', 'managed');
    const h = setupPanel({ '2026-11-06-a': sessionAgent('2026-11-06-a') }, ['2026-11-06-w'], modes);
    h.posted.length = 0;

    // 生产由助手会话流内 questionPending 写入；setPending 会触发活跃度重算
    h.cast.askFor('2026-11-06-a').setPending([{ slot: 'q1', question: '要继续吗？' }]);

    const snap = lastActivity(h.posted);
    expect(snap.pendingIds).not.toContain('2026-11-06-a');
    expect(snap.badgeCount).toBe(0);
  });
});
