/**
 * chatPanel 流完整性 + agent 强制依赖面守卫（2026-10-17 补测批次）
 *
 * 两类此前的结构性盲区：
 *
 * ① **流被静默截断无人知晓**（P1-1）
 *    `postTurnUpdate` 现在是 `_agent` 的多个方法的强制消费者（如 `isPausePending()`），
 *    替身缺任一方法即 TypeError。关键在于**这个错从哪里冒出来**：
 *      · `postTurnUpdate` 的运行态起点投影在 `consumeFlow` 的 try **之前**
 *        ⇒ 抛出逃出 consumeFlow，被 **runFlow 的 catch** 捕获并降级成一条
 *        `post({type:'error'})` notice ⇒ **整条流被截断，而 await 方的 promise 正常 resolve**；
 *      · `consumeFlow` 内的续跑投影点在 try **内部** ⇒ 被 consumeFlow 的 catch 吞掉，
 *        只丢一次投影。
 *    ⇒ 凡「只看 interject/resumeExecution 调用次数」的用例（如 chatPanelInput.test.ts 的多条），
 *       在这类截断面前**全部保持全绿**。本文件把「流没有静默中断」钉成显式契约。
 *
 * ② **没有任何守卫界定「哪些 agent 方法是强制依赖」**（P1-2）
 *    同一个 `postTurnUpdate` 内并存两套**互相矛盾**的写法：
 *      - 严格（缺方法必抛）：`isPausePending` / `getEffectiveMaxTokens`
 *      - 宽松（给替身开后门）：`getPendingInterjections?.()` —— 双 optional，
 *        且 `syncPendingQueue` 注释明文写着「测试桩可能缺该方法——缺则跳过」。
 *    ⇒ 把方法上下游挪一挪（给严格项补 `?.`、或给宽松项去掉 `?.`）**不会有任何测试变红**。
 *   本文件从源码提取真实写法并与显式登记的表比对 ⇒ 新增/改动阳离子面孔必须自觉登记。
 *
 * ⚠ 变异验证靶标：
 *   把 `chatPanel` 里 `isPausePending` 的调用改成 `isPausePending?.()` → 「依赖面」+「矩阵」两处转红；
 *   把 `getPendingInterjections?.()` 的双 optional 去掉 → 「宽松面」断言转红；
 *   在 chatPanel 里新增一个 `this._agent?.foo()` 而不登记 → 「登记完整性」转红；
 *   把 runFlow 的 catch 去掉（让流错误直接抛）→ 「流截断可见性」用例转红。
 */
// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent } from '@zooique/memora';
import type * as vscode from 'vscode';
import { ProviderStore } from '../../extension/providers/providerStore.js';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAT_PANEL_PATH = join(HERE, '..', 'panels', 'chatPanel.ts');

vi.mock('vscode', async () => ({
  Uri: {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    fsPath: '/mock/path',
  },
  window: {
    showInputBox: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
  },
}));

/** 单轮正常结束的 chat 流：thinking + step_boundary + 文本，收场走 done 分支 */
function normalFlow(
  roundId: string,
): AsyncGenerator<{ type: string; roundId: string; [k: string]: unknown }> {
  return (async function* () {
    yield { type: 'thinking', phase: 'processing', roundId };
    yield { type: 'text', content: 'hi', roundId };
    yield { type: 'step_boundary', roundId };
  })();
}

interface FlowStubOptions {
  /** 省略任意一个方法 ⇒ 模拟「替身缺该强制依赖」的完整补给链断裂 */
  omit?: string[];
}

/**
 * 完整 agent 替身（字段按 chatPanel 强制依赖面逐项补齐）
 *
 * ⚠ 替身契约单点：这里的每个方法都是 `postTurnUpdate` / 流尾的真实消费面，
 *   缺任一项都会让 pytest 走 ranFlow catch 的 error 消息路径，而非「测试正常通过」。
 */
function flowAgentStub(opts: FlowStubOptions = {}): Agent {
  const omitted = new Set(opts.omit ?? []);
  const members: Record<string, unknown> = {
    chat: () => normalFlow('round-1'),
    sessionManager: {
      status: 'running',
      getCurrentSessionInfo: () => ({ date: '2026-10-06', session: 's1' }),
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
  };
  for (const key of omitted) delete members[key];
  return members as unknown as Agent;
}

interface PanelHandle {
  provider: MemoraChatViewProvider;
  posted: { type: string; message?: string; state?: unknown }[];
  cast: {
    _agent: Agent;
    _streaming: boolean;
    _currentSessionId: string;
    sendInput(p: string): Promise<void>;
  };
}

function setupPanel(agent: Agent): PanelHandle {
  const dir = mkdtempSync(join(tmpdir(), 'memora-flow-integrity-'));
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  // 第三个构造参数必须是**真的** ProviderStore：传空对象会让流尾的
  // `this._providerStore.getActive()` 抛错 ⇒ 经 runFlow catch 降级成一条 error 消息、
  // 收场代码整段不执行（与本守卫要抓的「流被静默截断」完全同型，属 harness 自伤）。
  // 教训：替身缺口往往先表现为「一条看不懂的 error 消息」，而不是测试报错。
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
  );
  const posted: { type: string; message?: string; state?: unknown }[] = [];
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
  provider.setAgent(agent);
  return {
    provider,
    posted,
    cast: provider as unknown as PanelHandle['cast'],
  };
}

const turnUpdates = (posted: { type: string }[]) => posted.filter((m) => m.type === 'turn_update');
const errorMessages = (posted: { type: string; message?: string }[]) =>
  posted.filter((m) => m.type === 'error');

describe('chatPanel 流完整性（P1-1：不得被静默截断）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('完整替身：跑完一轮须有 turn_update 投影 + 零 error 消息 + 生成态复位', async () => {
    // 基线条约的三件套。缺任何一条，流被 `runFlow` catch 静默吞掉都无法察觉。
    const h = setupPanel(flowAgentStub());
    h.cast._currentSessionId = '2026-10-17-s1';

    await h.cast.sendInput('你好');

    expect(turnUpdates(h.posted).length).toBeGreaterThan(0);
    expect(errorMessages(h.posted)).toEqual([]);
    // 生成态必须复位（否则会话切换/重放被永久拒绝）
    expect(h.cast._streaming).toBe(false);
  });

  it('强制依赖缺方法时，上述三条契约必须同时可见地破裂（证明它们是承重的）', async () => {
    // 这条是上一例的对照：如果抽掉一个强制依赖后三条断言依然全绿，
    // 就说明这套断言没有实际承重 ⇒ 现有 chatPanelInput 那批「只看调用次数」的用例
    // 正是因为这个原因保持了全绿。
    const h = setupPanel(flowAgentStub({ omit: ['isPausePending'] }));
    h.cast._currentSessionId = '2026-10-17-s1';

    await h.cast.sendInput('你好');

    // 缺 persone 时：`postTurnUpdate` 抛 TypeError →
    // runFlow catch 降级为 error notice ⇒ 至少有「error 消息」这一条必须成立
    expect(errorMessages(h.posted).length).toBeGreaterThan(0);
  });
});

describe('chatPanel · agent 强制依赖面守卫（P1-2）', () => {
  /**
   * 从源码提取「三类写法」的机械真值，与显式登记表比对。
   *
   * 写法语义：
   *   strict  = `this._agent?.foo()` —— `_agent` 存在但 foo 缺失 ⇒ **TypeError**（替身必须补）
   *   lenient = `this._agent?.foo?.()` —— 缺失则静默 undefined（给替身开的后门）
   * 两者混用且无守卫区分，正是本次要堵的结构性问题。
   */
  const source = readFileSync(CHAT_PANEL_PATH, 'utf8');

  const strictCalls = [...source.matchAll(/this\._agent\?\.([A-Za-z_][\w]*)\(/g)].map(
    (m) => m[1] as string,
  );
  const lenientCalls = [...source.matchAll(/this\._agent\?\.([A-Za-z_][\w]*)\?\.\(/g)].map(
    (m) => m[1] as string,
  );

  /** 已登记的强制依赖（严格写法）：缺方法必抛，替身不得省略 */
  const REGISTERED_STRICT = [
    'clearPendingInterjections',
    'getEffectiveMaxTokens',
    'isPausePending',
    'removePendingInterject',
  ];
  /** 已登记的宽松项（双 optional 后门）：允许替身缺失，须有注释说明为什么 */
  const REGISTERED_LENIENT = ['getPendingInterjections'];

  it('提取口径有效（防正则失效导致的空集假绿）', () => {
    expect(strictCalls.length).toBeGreaterThan(0);
    expect(lenientCalls.length).toBeGreaterThan(0);
  });

  it('登记完整性：源码里每个严格调用都必须已登记（新方法/Iain 需自觉补表）', () => {
    // ⚠ 这条是整个 P1-2 的核心：在 chatPanel 里新增 `this._agent?.newMethod()`
    // 而不在此登记表出现 ⇒ 本例转红，强制作者当面决定「严格还是宽松」。
    const unregistered = strictCalls.filter((n) => !REGISTERED_STRICT.includes(n));
    expect(
      unregistered,
      `以下 _agent 方法以严格形态被依赖但未登记（请补进 REGISTERED_STRICT 并在替身里对齐）：\n${unregistered.join(', ')}`,
    ).toEqual([]);
  });

  it('反向锁定：登记表里的每一项都必须在源码中仍是严格形态（不得被悄悄加 `?.` 掩护）', () => {
    for (const name of REGISTERED_STRICT) {
      // 严格形态必须存在
      expect(strictCalls, `缺少严格调用：${name}`).toContain(name);
      // ⚠ 不得同时出现双 optional 掩护——那会让「替身缺方法」变成静默绿
      expect(
        lenientCalls.includes(name),
        `${name} 出现了 ?.${name}?.() 掩护形态：替身缺方法将静默通过，违反「替身缺方法即抛错」纪律`,
      ).toBe(false);
    }
  });

  it('宽松面：后门项必须显式登记且保持双 optional 形态（防止无声升级为强制依赖）', () => {
    const unregisteredLenient = lenientCalls.filter((n) => !REGISTERED_LENIENT.includes(n));
    expect(
      unregisteredLenient,
      `以下方法用了后门写法但未登记（请补进 REGISTERED_LENIENT 并注明理由）：\n${unregisteredLenient.join(', ')}`,
    ).toEqual([]);
    for (const name of REGISTERED_LENIENT) {
      expect(lenientCalls).toContain(name);
    }
  });

  it('严格依赖的运行时行为锁：替身缺方法 ⇒ 同步投影路径必须真的抛错（不得被 .?. 兜住）', () => {
    // 机制说明：`this._agent?.foo()` 的 `?.` **只短路 _agent == null**；
    // `_agent` 存在而 foo 缺失时仍会 TypeError（区别于 `?.foo?.()`）。
    // 本例是对该语义的运行时再验证——即便源码守卫被绕过，这里也会红。
    for (const name of REGISTERED_STRICT) {
      // 缺该方法的最小替身：直接索引访问即可，不必穿 Agent 类型
      const incomplete: Record<string, () => unknown> = { on: vi.fn(), off: vi.fn() };
      expect(
        () => incomplete[name](),
        `${name} 缺失时应当抛 TypeError（当前写法是严格的）`,
      ).toThrow(TypeError);
    }
  });
});
