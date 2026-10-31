/**
 * 缺口①补测（2026-10-21）：**事件 → setPending → postTurnUpdate → turnState 派生** 端到端
 *
 * 为什么必须补：三刀/四刀变异实锤过该面是**假阴性**——单元面各自有覆盖
 * （askCoordinator 域单测、turnProjection 纯函数单测），但把它们串起来的事件链无一例端到端：
 * 断掉投影读取时 43 例全绿。本文件钉住全链五段：
 *   ① 内核 `questionPending` 事件（consumeFlow 注册的监听）
 *   ② → `_ask.setPending(questions)` 写入（overwrite 全量写）
 *   ③ → `postTurnUpdate` 读 `pendingQuestions()` → `deriveTurnState` 派生 →
 *        写回宿主 `_turnState`（提问原文真源，非镜像）+ post `turn_update`
 *   ④ → webview 收 `turn_update.state = waiting/ask + questions`（问答卡渲染真源）
 *   ⑤ 写回的 `_turnState` = `handleInput` 的 ask 相位路由判据；**不是** ask 域超时的读取源
 *      （2026-10-31 去相位化，ADR-044 决策 4：域内 `_pending` 自己就是真源，反向依赖即第二真相）
 *
 * 🔴 **必须用挂起流（gate），否则变异假绿**（首轮实测教训）：空流立即走到流尾，
 * 流尾收尾投影（读同一 pendingQuestions）会替事件投影兜底 ⇒ 删掉事件 `postTurnUpdate()`
 * 测试照样绿。真实危害是「**流还在跑时**问答卡不渲染、webview 停在 running」——
 * 只有挡住流尾（gate 未放行 = 流仍运行中），waiting 投影才必须由事件回调自己产生。
 *
 * 时序贴近真实：`deriveTurnState` 判据①「questions 非空即 ask」压过 streaming——
 * 提问那一刻 sessionStatus≈running（turnProjection L93 注释），投影不延迟一个 chunk 边界。
 *
 * ⚠️ 变异验证靶标（新增断言必做）：
 *   M1 删 `onPendingQuestion` 内的 `postTurnUpdate()` → 三用例全红（流中无 waiting 投影）；
 *   M2 `postTurnUpdate` 的 `pendingQuestions: questions.length > 0 ? questions : undefined`
 *      改恒 `undefined` → 三用例全红（phase 掉回 running）；
 *   M3 `setPending` 写入改空数组 → 同 M2 全红。
 * （M2/M3 正是「断掉读取 43 例全绿」假阴性面的正面钉住；三发均实测）
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Agent } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

// mock vscode：chatPanel 构造最小 API（与 chatPanelPauseProjection.test 同款）
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

/** agent 桩：投影消费 status / isPausePending / getPendingInterjections 三源 +
 * 事件注册面（on 捕获监听器——事件链的入口就在这里） */
function projectionAgentStub(): {
  agent: Agent;
  listeners: Record<string, (...args: unknown[]) => void>;
} {
  const listeners: Record<string, (...args: unknown[]) => void> = {};
  const sessionState = { status: 'running' };
  const agent = {
    sessionManager: sessionState, // 提问那一刻 ≈ running（判据①不依赖 paused）
    isPausePending: () => false,
    getPendingInterjections: () => [],
    // ADR-044 决策 3：停止 = 收场——内核 abandonTurn 收场后状态机 resetToRunning
    currentRoundId: () => 'r-ask', // 在途轮身份：随 interrupted 收场透出（宿主底栏归属用）
    abandonTurn: async () => {
      sessionState.status = 'running';
      return true;
    },
    on: (event: string, fn: (...args: unknown[]) => void) => {
      listeners[event] = fn;
    },
    off: vi.fn(),
    getMetrics: () => ({
      llm: { totalInputTokens: 0, totalOutputTokens: 0 },
      tools: { unparsedToolIntentCount: 0 },
      context: {},
    }),
    getCheckpoint: () => undefined,
  } as unknown as Agent;
  return { agent, listeners };
}

/** 私有面 cast（驱动路径 = consumeFlow 注册的监听 + ask 域随迁字段 `_ask`） */
interface AskProjectionCast {
  consumeFlow(
    gen: AsyncGenerator<unknown, void, unknown>,
    controller: AbortController,
  ): Promise<void>;
  _streaming: boolean;
  _agent: Agent;
  _turnState: { phase: string; reason?: string; questions?: unknown[] };
  _ask: {
    clearAskTimeout(): void;
    setPending(qs: unknown[]): void;
    pendingQuestions(): unknown[];
  };
  handleStop(): Promise<void>;
}

/** 构造 provider + 抓取 post 消息（复刻 chatPanelPauseProjection.test 的 harness） */
function setup() {
  const dir = __dirname; // store 构造只做落盘路径，不读内容
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  const provider = new MemoraChatViewProvider(
    { fsPath: '/mock/uri' } as never,
    store,
    {
      // ProviderStore 桩：流首 meta 取证包消费 getActive（流首 await 点）/ getActiveName（meta llm）
      getActive: async () => undefined,
      getActiveName: () => '',
    } as never,
    '/mock/workspace',
  );
  const posted: unknown[] = [];
  (provider as unknown as { _view: unknown })._view = {
    webview: {
      asWebviewUri: () => ({ toString: () => 'mock://script' }),
      options: {},
      html: '',
      postMessage: (msg: unknown) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
    onDidDispose: () => ({ dispose: () => {} }),
    onDidReceiveMessage: () => ({ dispose: () => {} }),
  };
  const { agent, listeners } = projectionAgentStub();
  const cast = provider as unknown as AskProjectionCast;
  cast._agent = agent;
  cast._streaming = true; // 提问发生于流内（流首投影亦会重置为 true）
  return { provider, posted, listeners, cast };
}

/**
 * 驱动：起挂起流 → 触发 questionPending → 用例在**流仍运行中**断言 → finish 收尾。
 *
 * gate 挡住 `for await` 的首个 next：流尾收尾投影不会先于断言发生（见文件头 🔴）。
 * finish 必须放 finally——断言失败也要放行 gate + 清 30min 超时 timer，防 handle 泄漏。
 */
function driveSuspendedFlow(questions: unknown[]) {
  const ctx = setup();
  let releaseFlow!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFlow = resolve;
  });
  async function* gatedGen(): AsyncGenerator<unknown, void, unknown> {
    await gate; // 挂起点：流停在循环体外，流尾（收尾投影/finally）均未发生
    // 空 yield：放行后循环体不进，直接自然收场
  }
  const flowDone = ctx.cast.consumeFlow(gatedGen(), new AbortController());
  // 事件回调同步执行：setPending → postTurnUpdate（事件投影）→ arm 超时
  ctx.listeners['questionPending'](questions);
  const finish = async () => {
    releaseFlow();
    await flowDone;
    ctx.cast._ask.clearAskTimeout(); // 事件 arm 的 30min 保底计时器，收尾清掉
  };
  return { ...ctx, finish };
}

const QUESTION = {
  slot: 'q1',
  question: '细纲要不要继续推进？',
  options: ['继续', '停一停'],
  allowCustom: false,
};

describe('ask 端到端：questionPending 事件 → setPending → postTurnUpdate → turnState 派生', () => {
  it('流中即刻投影：turn_update.state = waiting/ask + questions（不等流尾、不延迟渲染）', async () => {
    const { posted, cast, finish } = driveSuspendedFlow([QUESTION]);
    try {
      expect(cast._streaming).toBe(true); // 前置：流仍运行中（流尾未发生）
      const update = posted.find((m) => {
        if ((m as { type?: string }).type !== 'turn_update') return false;
        return (m as { state?: { phase?: string } }).state?.phase === 'waiting';
      }) as { state?: { phase?: string; reason?: string; questions?: unknown[] } } | undefined;
      expect(update).toBeDefined(); // 流首投影是 running；waiting 必须由事件回调自己投出
      expect(update!.state!.phase).toBe('waiting');
      expect(update!.state!.reason).toBe('ask');
      expect(update!.state!.questions).toHaveLength(1);
      expect((update!.state!.questions![0] as { question: string }).question).toBe(
        QUESTION.question,
      );
    } finally {
      await finish();
    }
  });

  it('停止（提问在途）⇒ 相位离开 waiting/ask + 逐条「未回答」上屏（ADR-044 决策 3）', async () => {
    // 起点必须是**真实的 waiting/ask 投影**（先走事件链），否则「停止后不再是 waiting」
    // 在起始相位本就是 idle 时恒真 = 空断言（首轮变异实测：删掉重投影仍绿）
    const { cast, posted, finish } = driveSuspendedFlow([QUESTION]);
    try {
      expect(cast._turnState.phase).toBe('waiting'); // 前置：确实停在 ask 等待
      // 提问挂起后流已结束（_streaming=false）、会话处 paused：
      // 旧实现正是在这一格只弃检查点 ⇒ 轮永久 pending + 宿主镜像不清 ⇒ 下一条输入被吞
      cast._streaming = false;
      (cast._agent.sessionManager as unknown as { status: string }).status = 'paused';

      await cast.handleStop();

      // ① 宿主镜像已清 + 相位重投影（不重算 ⇒ `_turnState` 停在 waiting/ask，
      //    handleInput 会把用户的下一句话路由成「回答一个已死的提问」，内核内存消费、不落盘）
      expect(cast._ask.pendingQuestions()).toEqual([]);
      expect(cast._turnState.phase).not.toBe('waiting');
      // ② 未答提问带题面上屏（文案与内核 appendInterrupted 落盘的 unanswered 行同源）
      const rows = posted.filter((m) => (m as { type?: string }).type === 'user') as Array<{
        kind?: string;
        question?: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe('unanswered');
      expect(rows[0]!.question).toBe(QUESTION.question);
    } finally {
      await finish();
    }
  });

  it('写回真源：_turnState.waiting.questions 与事件入参同值（webview 问答卡 + handleInput 相位路由的读取源）', async () => {
    const { cast, finish } = driveSuspendedFlow([QUESTION]);
    try {
      // 链路⑤：写回是 handleInput 的 ask 相位路由判据（webview 问答卡同源）——写回断了，
      // 用户的回答会被当成普通输入另起一轮。
      // 断言必须在流中：流尾收尾投影同样会写回，放行后断言会掩盖事件写回的缺失。
      expect(cast._turnState.phase).toBe('waiting');
      expect(cast._turnState.reason).toBe('ask');
      expect(cast._turnState.questions).toHaveLength(1);
      expect((cast._turnState.questions![0] as { question: string }).question).toBe(
        QUESTION.question,
      );
    } finally {
      await finish();
    }
  });

  it('提问优先于 running：streaming=true 派生 waiting/ask（判据①压过④，提问那一刻≈running）', async () => {
    const { cast, posted, finish } = driveSuspendedFlow([QUESTION]);
    try {
      expect(cast._streaming).toBe(true); // 前置：流在跑
      const waiting = posted.filter((m) => {
        if ((m as { type?: string }).type !== 'turn_update') return false;
        return (m as { state?: { phase?: string } }).state?.phase === 'waiting';
      });
      expect(waiting).toHaveLength(1); // 流中恰好一条 waiting 投影（事件即产生，无重复）
    } finally {
      await finish();
    }
  });
});
