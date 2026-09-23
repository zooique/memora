/**
 * M4 输入收口验收测试（2026-09-23，方案 TURN-SSOT-1 §M4）
 *
 * 验证 `handleInput` 单一入口按 turn 相位路由（R2 单一判据）：
 *   - running 态 send → agent.interject 排队（无缝插话，不发起新 chat）
 *   - waiting(ask) 态 answer → answerQuestion 回填 + resumeExecution('question-answer') 续跑
 *     （R1：提问原文从 `_turnState.waiting.questions` 读，`_pendingQuestions` 整体清空）
 *   - 错位输入（相位不符）→ 静默丢弃（迟到回答不污染进行中的轮，与原各 handler 守卫等义）
 *
 * 替身策略：agent 桩 + cast 注入私有状态（`_streaming` / `_abortController` / `_turnState` /
 * `_pendingQuestions` / `_currentSessionId`），与 chatPanelHistory.test 既有模式一致。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Agent } from '@zooique/memora';
import type { PendingQuestionDto, TurnState } from '../../shared/protocol.js';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

// mock vscode：提供 chatPanel 构造最小 API（与 chatPanelHistory.test 同款）
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

/** agent 桩：覆盖 M4 输入路由 + consumeFlow 尾部依赖的最小面 */
function inputAgentStub() {
  const interject = vi.fn();
  const answerQuestion = vi.fn();
  // 显式参数类型：mock.calls 元组元素可索引（TS2493：无参推导为空 tuple）
  const resumeExecution = vi.fn(async function* (_text?: string, _signal?: AbortSignal, _kind?: string) {
    // 空流：立即结束，测试只验证路由入参，不关心流内容
  });
  const chat = vi.fn(async function* (_input?: string, _signal?: AbortSignal) {});
  const agent = {
    sessionManager: {
      status: 'running',
      switchToSession: vi.fn().mockResolvedValue(0),
      renameSession: vi.fn(),
      getCurrentSessionInfo: vi.fn(() => undefined),
    },
    memory: { softDeleteRoundSummaries: vi.fn().mockReturnValue(0) },
    on: vi.fn(),
    off: vi.fn(),
    // consumeFlow 尾部四依赖（postPlanUpdate / postMetrics / postContextOccupancy / 摘要）
    getMetrics: () => ({
      llm: { totalInputTokens: 0, totalOutputTokens: 0 },
      tools: { unparsedToolIntentCount: 0 },
      context: {},
    }),
    getCheckpoint: () => undefined,
    isPausePending: () => false,
    cancelPauseRequest: vi.fn(),
    interject,
    answerQuestion,
    resumeExecution,
    chat,
  } as unknown as Agent;
  return { agent, interject, answerQuestion, resumeExecution, chat };
}

/** 构造 provider + agent 桩，cast 注入私有状态，返回可驱动句柄 */
function setupInput() {
  const dir = __dirname; // 复用临时目录（store 构造只做落盘路径，不读内容）
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  const provider = new MemoraChatViewProvider({ fsPath: '/mock/uri' } as never, store, {} as never);
  const posted: unknown[] = [];
  const webviewView = {
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
  } as never;
  (provider as unknown as { _view: unknown })._view = webviewView;
  return { provider, store, roundStore, posted, cast: provider as unknown as InputCast };
}

/** 可 cast 注入的私有状态集合 */
interface InputCast {
  _streaming: boolean;
  _abortController?: AbortController;
  _turnState: TurnState;
  _pendingQuestions: PendingQuestionDto[];
  _currentSessionId: string;
  _agent: Agent;
  handleInput(msg: { kind: 'send' | 'answer' | 'resume'; text?: string; answers?: string[]; skillName?: string }): Promise<void>;
}

/** 标准装配：真实 agent 桩 + 有效会话 id（handleInput 的两个前置守卫通过） */
function mount(h: ReturnType<typeof setupInput>, agentStub = inputAgentStub()) {
  h.provider.setAgent(agentStub.agent);
  h.cast._currentSessionId = '2026-09-23-test';
  return agentStub;
}

describe('M4 输入收口：handleInput 相位路由（R2 单一判据）', () => {
  it('running 态 send → interject 排队（无缝插话），不发起新 chat', async () => {
    const h = setupInput();
    const { interject, chat } = mount(h);
    // 相位：running（流在跑 + 非挂起）
    h.cast._streaming = true;
    h.cast._abortController = new AbortController();
    h.cast._turnState = { phase: 'running' };

    await h.cast.handleInput({ kind: 'send', text: '补充要求' });

    // interject 入队 + 即时上屏（supplement 交互行）
    expect(interject).toHaveBeenCalledTimes(1);
    expect(interject).toHaveBeenCalledWith('补充要求');
    expect(h.posted).toContainEqual(
      expect.objectContaining({ type: 'user', kind: 'supplement', text: '补充要求' }),
    );
    // 不中断旧流、不发起新 chat
    expect(chat).not.toHaveBeenCalled();
    expect(h.posted.filter((m) => (m as { type?: string }).type === 'status')).toHaveLength(0);
  });

  it('waiting(ask) 态 send → 带文本续跑（resumeExecution supplement，不开新轮）', async () => {
    const h = setupInput();
    const { resumeExecution, chat } = mount(h);
    // 相位：waiting/ask（提问挂起中，用户发补充）
    // 真实语义：内核 yield paused chunk 后 consumeFlow break → finally 复位 _streaming=false。
    // sendInput 第一分支（流式插话）因此不可命中，补充正确路由到续跑分支。
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._pendingQuestions = [{ slot: 'q1', question: '继续吗？' }];
    h.cast._turnState = { phase: 'waiting', reason: 'ask', questions: [{ slot: 'q1', question: '继续吗？' }] };

    await h.cast.handleInput({ kind: 'send', text: '补充一点' });

    // 续跑注入（supplement 语义），不 chat
    expect(resumeExecution).toHaveBeenCalledTimes(1);
    expect(resumeExecution.mock.calls[0][0]).toBe('补充一点');
    expect(resumeExecution.mock.calls[0][2]).toBe('supplement');
    expect(chat).not.toHaveBeenCalled();
  });

  it('waiting(ask) 态 answer → answerQuestion 回填 + resumeExecution("question-answer")', async () => {
    const h = setupInput();
    const { answerQuestion, resumeExecution } = mount(h);
    const question: PendingQuestionDto = { slot: 'q1', question: '继续吗？', options: ['继续', '停止'] };
    // 相位：waiting/ask（内核 yield paused → 流已收场，_streaming=false）
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._pendingQuestions = [question];
    h.cast._turnState = { phase: 'waiting', reason: 'ask', questions: [question] };

    await h.cast.handleInput({ kind: 'answer', answers: ['继续'] });

    // R1：提问原文从 _turnState.waiting.questions 读 → “你答”行带 question/options（同构重放）
    expect(h.posted).toContainEqual(
      expect.objectContaining({
        type: 'user',
        kind: 'question-answer',
        text: '继续',
        question: '继续吗？',
        options: ['继续', '停止'],
      }),
    );
    // 内核入口：answerQuestion 数组回填 + resumeExecution 以 join 全文注入
    expect(answerQuestion).toHaveBeenCalledTimes(1);
    expect(answerQuestion).toHaveBeenCalledWith(['继续']);
    expect(resumeExecution).toHaveBeenCalledTimes(1);
    expect(resumeExecution.mock.calls[0][0]).toBe('继续');
    expect(resumeExecution.mock.calls[0][2]).toBe('question-answer');
    // _pendingQuestions 整体清空（overwrite 语义，非消费式 splice）
    expect(h.cast._pendingQuestions).toEqual([]);
  });

  it('多 ask 聚合 answer（P2）：answers 与提问按序一对一，逐条透出 + join 续跑', async () => {
    const h = setupInput();
    const { answerQuestion, resumeExecution } = mount(h);
    const qs: PendingQuestionDto[] = [
      { slot: 'q1', question: '语言？' },
      { slot: 'q2', question: '篇幅？' },
    ];
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._pendingQuestions = qs;
    h.cast._turnState = { phase: 'waiting', reason: 'ask', questions: qs };

    await h.cast.handleInput({ kind: 'answer', answers: ['中文', '长篇'] });

    // 透出两行，question 各配其位
    const qaRows = h.posted.filter(
      (m) => (m as { kind?: string }).kind === 'question-answer',
    ) as { text: string; question?: string }[];
    expect(qaRows).toHaveLength(2);
    expect(qaRows[0]).toMatchObject({ text: '中文', question: '语言？' });
    expect(qaRows[1]).toMatchObject({ text: '长篇', question: '篇幅？' });
    expect(answerQuestion).toHaveBeenCalledWith(['中文', '长篇']);
    expect(resumeExecution.mock.calls[0][0]).toBe('中文\n长篇');
  });

  it('错位 answer（waiting(pause) 相位收回答）→ 静默丢弃', async () => {
    const h = setupInput();
    const { answerQuestion, resumeExecution } = mount(h);
    // 相位：waiting/pause（非 ask——迟到/错位回答）
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._pendingQuestions = []; // 无在途提问
    h.cast._turnState = { phase: 'waiting', reason: 'pause' };

    await h.cast.handleInput({ kind: 'answer', answers: ['迟到回答'] });

    // 内核零入口（不 answerQuestion / 不续跑）、无“你答”上屏
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(resumeExecution).not.toHaveBeenCalled();
    expect(h.posted.filter((m) => (m as { kind?: string }).kind === 'question-answer')).toHaveLength(0);
  });

  it('错位 resume（idle 相位收继续）→ 静默丢弃', async () => {
    const h = setupInput();
    const { resumeExecution } = mount(h);
    // 相位：idle（无流、无挂起——resume 无意义）
    h.cast._streaming = false;
    h.cast._turnState = { phase: 'idle' };

    await h.cast.handleInput({ kind: 'resume' });

    expect(resumeExecution).not.toHaveBeenCalled();
  });

  it('waiting(pause) 态 resume → 纯续跑（resumeExecution 无文本身份）', async () => {
    const h = setupInput();
    const { resumeExecution } = mount(h);
    // 相位：waiting/pause（软暂停后流已收场，_streaming=false）
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._pendingQuestions = [];
    h.cast._turnState = { phase: 'waiting', reason: 'pause', pausePending: false };

    await h.cast.handleInput({ kind: 'resume' });

    expect(resumeExecution).toHaveBeenCalledTimes(1);
    expect(resumeExecution.mock.calls[0][0]).toBeUndefined();
    expect(resumeExecution.mock.calls[0][2]).toBeUndefined();
  });

  it('空文本 / 空 answers → 不发任何内核入口', async () => {
    const h = setupInput();
    const { interject, answerQuestion, resumeExecution, chat } = mount(h);
    h.cast._streaming = true;
    h.cast._abortController = new AbortController();
    h.cast._turnState = { phase: 'running' };

    await h.cast.handleInput({ kind: 'send', text: '   ' });
    await h.cast.handleInput({ kind: 'answer', answers: [] });
    await h.cast.handleInput({ kind: 'answer' });

    expect(interject).not.toHaveBeenCalled();
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(resumeExecution).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });
});