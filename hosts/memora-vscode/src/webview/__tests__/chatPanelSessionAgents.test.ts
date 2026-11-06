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
import type { Agent } from '@zooique/memora';
import type * as vscode from 'vscode';
import { ProviderStore } from '../../extension/providers/providerStore.js';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

vi.mock('vscode', async () => ({
  Uri: {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
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
 */
function sessionAgent(label: string, flow?: () => AsyncGenerator<Chunk>): SessionAgentStub {
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
    isPausePending: () => false,
    getEffectiveMaxTokens: () => undefined,
    getPendingInterjections: () => [],
    clearPendingInterjections: () => [],
    removePendingInterjections: () => [],
    listBackgroundTasks: () => [],
    memory: { softDeleteRoundSummaries: vi.fn() },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as SessionAgentStub;
}

/** 面板句柄：真实 provider + 捕获的投递列表 + 私有面入口 */
interface PanelHandle {
  provider: MemoraChatViewProvider;
  posted: { type: string; message?: string; state?: unknown; text?: string }[];
  cast: {
    _agent?: Agent;
    _currentSessionId: string;
    _sessionAgents: Map<string, Agent>;
    runtimeFor(sessionId?: string): {
      streaming: boolean;
      abortController?: AbortController;
      liveBuffer?: { textByRound: Map<string, string> };
    };
    runFlow(factory: (signal: AbortSignal) => AsyncGenerator<Chunk>): Promise<void>;
  };
}

/**
 * 建面板（真实 sessionStore / roundStore / ProviderStore，只替身 webview 与 Agent）
 *
 * @param agents 预登记的会话实例（键 = 会话 id；模拟「此前已装配过」）
 */
function setupPanel(agents: Record<string, Agent> = {}): PanelHandle {
  const dir = makeTempDir('memora-e4-b2-');
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
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
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      asWebviewUri: () => ({ toString: () => 'mock://script' }),
      options: {},
      html: '',
      postMessage: (msg: never) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => {} }),
    onDidReceiveMessage: () => ({ dispose: () => {} }),
  };
  (provider as unknown as { _viewLoader: unknown })._viewLoader = () => [];
  const cast = provider as unknown as PanelHandle['cast'];
  for (const [sessionId, agent] of Object.entries(agents)) {
    cast._sessionAgents.set(sessionId, agent);
  }
  return { provider, posted, cast };
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
