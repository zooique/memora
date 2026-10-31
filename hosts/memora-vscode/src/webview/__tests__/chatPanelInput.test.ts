/**
 * 输入收口验收测试
 *
 * 验证 `handleInput` 单一入口按 turn 相位路由（单一判据）：
 *   - running 态 send → agent.interject 排队（无缝插话，不发起新 chat）
 *   - waiting(ask) 态 answer → answerQuestion 回填 + resumeExecution('question-answer') 续跑
 *     （提问原文从 `_turnState.waiting.questions` 读，ask 域在途提问整体清空）
 *   - waiting(ask) 态 send（底部输入框回车）→ **整条拒收**：既不走 answer、也不退化成
 *     supplement。走 answer 会让内核按序一对一配对，单条文本只能配第 1 题、其余题落
 *     `[ASK_ABORTED]`——多题批次下用户「随便打一句回车」就静默把第 2..N 题判成「未回答」；
 *     走 supplement 则让在途提问被兜底成「用户未回答」且原文不落盘。
 *     答题唯一入口 = 内联提问卡（逐题承载 `askCallId`，走 kind:'answer'）
 *   - 错位输入（相位不符）→ 丢弃并落 console.warn 留痕（T2 观测：对用户仍静默、
 *     不改变路由裁决，但「答了没反应」的排障线索必须在扩展宿主日志可查）
 *
 * 替身策略：agent 桩 + cast 注入私有状态（`_streaming` / `_abortController` / `_turnState` /
 * `_ask`（ask 域协调器）/ `_currentSessionId`），与 chatPanelHistory.test 既有模式一致。
 *
 * ⚠️ HOST-SPLIT-1 第 4 刀：ask 域迁至 `_ask`，**闸门字段随迁**——驱动经 `setPending` /
 * `clearPending`，断言经 `pendingQuestions()`。
 * 🔴 不改成直接改 tracker 内部字段会**静默失效**（给不存在的字段赋值不报错、运行时不抛），
 * 而本文件多数用例先 `setPending` 再经宿主读同一状态 ⇒ 自洽仍绿，但生产逻辑已不经该字段。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import type { Agent, ImageRef } from '@zooique/memora';
import { MAX_PENDING_INTERJECTIONS } from '../../shared/constants.js';
import type { PendingQuestionDto, TurnState } from '../../shared/protocol.js';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

// mock vscode：提供 chatPanel 构造最小 API（与 chatPanelHistory.test 同款）
vi.mock('vscode', async () => ({
  Uri: {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    fsPath: '/mock/path',
    // 附件预览 URL 走 asWebviewUri(Uri.file(...))：不提供 file 会在派生处直接抛
    file: (p: string) => ({ fsPath: p }),
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
    textDocuments: [],
  },
  // HOST-CTX-4：@problems 在**发送时刻**经本 API 取数（挂载只记通道标记，不取数）
  languages: { getDiagnostics: vi.fn(() => []) },
}));

/** agent 桩：覆盖输入路由 + consumeFlow 尾部依赖的最小面 */
function inputAgentStub() {
  // 默认受理（内核未满员常态）：宿主上屏以返回值为判，undefined 会被当拒收
  const interject = vi.fn((): boolean => true);
  const answerQuestion = vi.fn();
  const getPendingInterjections = vi.fn((): string[] => []);
  // 显式参数类型：mock.calls 元组元素可索引（TS2493：无参推导为空 tuple）
  const resumeExecution = vi.fn(async function* (
    _text?: string,
    _signal?: AbortSignal,
    _kind?: string,
  ) {
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
    getPendingInterjections,
    resumeExecution,
    chat,
  } as unknown as Agent;
  return { agent, interject, answerQuestion, getPendingInterjections, resumeExecution, chat };
}

/** 构造 provider + agent 桩，cast 注入私有状态，返回可驱动句柄 */
function setupInput() {
  const dir = __dirname; // 复用临时目录（store 构造只做落盘路径，不读内容）
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  const provider = new MemoraChatViewProvider(
    { fsPath: '/mock/uri' } as never,
    store,
    // IMG-8 兜底会经 providerStore 取窗口真源：给最小 stub（未配置 ⇒ getActive 返回 undefined）
    {
      getActive: vi.fn(async () => undefined),
      getActiveName: () => undefined,
      listMasked: vi.fn(async () => []),
    } as never,
    '/mock/workspace',
  );
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
  _ask: {
    setPending(q: PendingQuestionDto[]): void;
    clearPending(): void;
    pendingQuestions(): PendingQuestionDto[];
  };
  _currentSessionId: string;
  _agent: Agent;
  /** IMG-8 兜底取窗口用；个别用例覆写 getActive 返回值（默认 undefined = 未配置） */
  _providerStore: { getActive(): Promise<{ contextWindow?: number } | undefined> };
  handleInput(msg: {
    kind: 'send' | 'answer' | 'resume';
    text?: string;
    answers?: string[];
    skillName?: string;
    injections?: 'problems'[];
    attachments?: readonly ImageRef[];
  }): Promise<void>;
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

    // interject 入队成功；**不再即时上屏**（吸收时上屏：排队中 ≠ 已说出，
    // 上屏改由 webview 在队列快照减少（消费）时 diff 触发——见 chatViewInterject.test.ts）
    expect(interject).toHaveBeenCalledTimes(1);
    expect(interject).toHaveBeenCalledWith('补充要求');
    expect(h.posted.some((m) => (m as { type?: string }).type === 'user')).toBe(false);
    // 不中断旧流、不发起新 chat
    expect(chat).not.toHaveBeenCalled();
    expect(h.posted.filter((m) => (m as { type?: string }).type === 'status')).toHaveLength(0);
  });

  it('waiting(ask) 态 send（composer）→ 整条拒收：不 answerQuestion、不上屏、不续跑', async () => {
    const h = setupInput();
    const { answerQuestion, resumeExecution, chat } = mount(h);
    const question: PendingQuestionDto = {
      slot: 'q1',
      question: '继续吗？',
      options: ['继续', '停止'],
    };
    // 相位：waiting/ask（提问挂起中，用户在**底部输入框**打字回车）
    // 真实语义：内核 yield paused chunk 后 consumeFlow break → finally 复位 _streaming=false。
    // sendInput 第一分支（流式插话）因此不可命中。
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._ask.setPending([question]);
    h.cast._turnState = { phase: 'waiting', reason: 'ask', questions: [question] };

    await h.cast.handleInput({ kind: 'send', text: '继续' });

    // ask 期 send 不是合法答题载荷：内核 answerQuestion 按序一对一回填，单条文本只能覆盖
    // 第 1 题、其余题落 [ASK_ABORTED]（用户「随便打一句回车」⇒ 第 2..N 题被静默判未答）；
    // 单题时又与内联卡完全重复。故拒收——答题唯一入口 = 内联提问卡（kind:'answer'）。
    // 变异锚：删掉 sendInput 的 ask 守卫（回退成 answerInput([input])）⇒ 本例四个断言全红。
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(resumeExecution).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
    // 不上屏 user 行：拒收不得伪造「已答」痕迹（旧实现会 post question-answer 行）
    expect(h.posted.filter((m) => (m as { type?: string }).type === 'user')).toHaveLength(0);
    // 拒收必须可见（静默拒收 = 背刺，用户不知道该怎么办）
    const { window } = await import('vscode');
    expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('提问卡'));
  });

  it('waiting(ask) 态 answer → answerQuestion 回填 + resumeExecution("question-answer")', async () => {
    const h = setupInput();
    const { answerQuestion, resumeExecution } = mount(h);
    const question: PendingQuestionDto = {
      slot: 'q1',
      question: '继续吗？',
      options: ['继续', '停止'],
    };
    // 相位：waiting/ask（内核 yield paused → 流已收场，_streaming=false）
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._ask.setPending([question]);
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
    // ask 域在途提问整体清空（overwrite 语义，非消费式 splice）
    expect(h.cast._ask.pendingQuestions()).toEqual([]);
  });

  it('多 ask 聚合 answer（P2）：answers 与提问按序一对一，逐条透出 + join 续跑', async () => {
    const h = setupInput();
    const { answerQuestion, resumeExecution } = mount(h);
    const qs: PendingQuestionDto[] = [
      // ADR-043：题身份随行（内核 ask_user 工具调用 id）——运行时行与盘面/重放行同 id ⇒ 跨面可配对
      { slot: 'q1', askCallId: 'call-lang', question: '语言？' },
      { slot: 'q2', askCallId: 'call-len', question: '篇幅？' },
    ];
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._ask.setPending(qs);
    h.cast._turnState = { phase: 'waiting', reason: 'ask', questions: qs };

    await h.cast.handleInput({ kind: 'answer', answers: ['中文', '长篇'] });

    // 透出两行，question 各配其位
    const qaRows = h.posted.filter((m) => (m as { kind?: string }).kind === 'question-answer') as {
      text: string;
      question?: string;
      inputId?: string;
    }[];
    expect(qaRows).toHaveLength(2);
    expect(qaRows[0]).toMatchObject({ text: '中文', question: '语言？', inputId: 'call-lang' });
    expect(qaRows[1]).toMatchObject({ text: '长篇', question: '篇幅？', inputId: 'call-len' });
    expect(answerQuestion).toHaveBeenCalledWith(['中文', '长篇']);
    expect(resumeExecution.mock.calls[0][0]).toBe('中文\n长篇');
  });

  it('ADR-043 回退面：内核未给题身份 ⇒ 批内仍逐条唯一（不退回「同批共享 ts 互相吃掉」）', async () => {
    const h = setupInput();
    mount(h);
    // 旧 dist / 身份缺失形态：askCallId 缺省，回退批内序号。
    // 判据不是「值等于什么」（回退值本就无跨面配对语义），而是「同批 N 条互不相同且非空」——
    // 否则去重键退化成 ts，同批共享 ms 级 ts ⇒ 只活第 1 条（ASK-MULTI-Q-1 真机实锤的返场伤）。
    const qs: PendingQuestionDto[] = [
      { slot: 'q1', question: '语言？' },
      { slot: 'q2', question: '篇幅？' },
    ];
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._ask.setPending(qs);
    h.cast._turnState = { phase: 'waiting', reason: 'ask', questions: qs };

    await h.cast.handleInput({ kind: 'answer', answers: ['中文', '长篇'] });

    const qaRows = h.posted.filter((m) => (m as { kind?: string }).kind === 'question-answer') as {
      inputId?: string;
    }[];
    expect(qaRows).toHaveLength(2);
    expect(qaRows[0]!.inputId).toBeTruthy();
    expect(qaRows[1]!.inputId).toBeTruthy();
    expect(qaRows[0]!.inputId).not.toBe(qaRows[1]!.inputId);
  });

  it('错位 answer（waiting(pause) 相位收回答）→ 丢弃 + console.warn 留痕', async () => {
    const h = setupInput();
    const { answerQuestion, resumeExecution } = mount(h);
    const warnSpy = vi.spyOn(console, 'warn');
    // 相位：waiting/pause（非 ask——迟到/错位回答）
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._ask.clearPending(); // 无在途提问
    h.cast._turnState = { phase: 'waiting', reason: 'pause' };

    await h.cast.handleInput({ kind: 'answer', answers: ['迟到回答'] });

    // 内核零入口（不 answerQuestion / 不续跑）、无“你答”上屏
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(resumeExecution).not.toHaveBeenCalled();
    expect(
      h.posted.filter((m) => (m as { kind?: string }).kind === 'question-answer'),
    ).toHaveLength(0);
    // T2 留痕：丢弃事实必须落日志（带相位上下文），排障时可查「为什么答了没反应」
    const discardWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('错位回答已丢弃'),
    );
    expect(discardWarns).toHaveLength(1);
    expect(String(discardWarns[0][0])).toContain('waiting/pause');
    warnSpy.mockRestore();
  });

  it('错位 resume（idle 相位收继续）→ 丢弃 + console.warn 留痕', async () => {
    const h = setupInput();
    const { resumeExecution } = mount(h);
    const warnSpy = vi.spyOn(console, 'warn');
    // 相位：idle（无流、无挂起——resume 无意义）
    h.cast._streaming = false;
    h.cast._turnState = { phase: 'idle' };

    await h.cast.handleInput({ kind: 'resume' });

    expect(resumeExecution).not.toHaveBeenCalled();
    // T2 留痕：错位续跑同样必须落日志
    const discardWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('错位续跑已丢弃'),
    );
    expect(discardWarns).toHaveLength(1);
    expect(String(discardWarns[0][0])).toContain('idle');
    warnSpy.mockRestore();
  });

  it('waiting(pause) 态 resume → 纯续跑（resumeExecution 无文本身份）', async () => {
    const h = setupInput();
    const { resumeExecution } = mount(h);
    // 相位：waiting/pause（软暂停后流已收场，_streaming=false）
    h.cast._streaming = false;
    h.cast._abortController = undefined;
    h.cast._ask.clearPending();
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

  it('INPUT-LIMIT-1：插话队列达上限 → 整条拒收，不排队不上屏，警告提示', async () => {
    const h = setupInput();
    const { interject, chat } = mount(h);
    // 上限裁决单一真源在内核：agent.interject() 达上限返回 false（零入队零落盘），
    // 宿主只消费返回值——桩模拟内核满员拒收
    interject.mockReturnValue(false);
    h.cast._streaming = true;
    h.cast._abortController = new AbortController();
    h.cast._turnState = { phase: 'running' };

    await h.cast.handleInput({ kind: 'send', text: '第 6 条' });

    // 整条拒收：不上屏（user 气泡 = 已入队的视觉镜像，判定后置）、不续跑
    expect(h.posted.filter((m) => (m as { type?: string }).type === 'user')).toHaveLength(0);
    expect(chat).not.toHaveBeenCalled();
    // 拒收必须提示（走既有 showWarningMessage 通道，零新增协议）
    const { window } = await import('vscode');
    expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('上限'));
  });

  it('INPUT-LIMIT-1：插话未达上限 → 正常入队、不即时上屏（吸收时上屏）', async () => {
    const h = setupInput();
    const { interject } = mount(h);
    // 内核受理（未满员）→ 宿主不 post user 气泡（呈现时机 = 消费时刻）
    interject.mockReturnValue(true);
    h.cast._streaming = true;
    h.cast._abortController = new AbortController();
    h.cast._turnState = { phase: 'running' };

    await h.cast.handleInput({ kind: 'send', text: '第 5 条' });

    expect(interject).toHaveBeenCalledTimes(1);
    expect(h.posted.filter((m) => (m as { type?: string }).type === 'user')).toHaveLength(0);
  });

  it('INPUT-LIMIT-1：webview 镜像常量与内核真源同值（跨包数值漂移守卫）', async () => {
    // shared/constants.ts 的 MAX_PENDING_INTERJECTIONS 是内核真源的 webview 镜像
    // （webview 无法 import 内核包）——两处声明靠本守卫锁同值，任一侧改值漂移即红
    const { LOOP_CONSTANTS } = await import('@zooique/memora');
    expect(MAX_PENDING_INTERJECTIONS).toBe(LOOP_CONSTANTS.MAX_PENDING_INTERJECTIONS);
  });
});

// ═══════════════════════════════════════════════════════════
// HOST-CTX-4 注入型上下文：`@problems` 发送时刻采集 + 按源归因
//
// 守两条（对应四问的 ② 与 ④）：
//   ④ 采集时机 —— 上行只带**通道标记**，宿主在发送时刻才 getDiagnostics()；
//      挂载即取数 / 缓存快照都会让模型看到过期的一份（CTX-3 缓存撒谎同款病根）。
//   ② 承载位 —— 本轮注入量按源分项回推，合计 = 分项之和（webview 不得再算一遍）。
// ═══════════════════════════════════════════════════════════
describe('HOST-CTX-4 注入型上下文（@problems）', () => {
  /** 造一个落在首根 `/mock/workspace` 下的诊断分组（getDiagnostics 的返回形） */
  function diagGroup(rel: string, message: string, severity = 0) {
    const fsPath = join('/mock/workspace', ...rel.split('/'));
    return [
      { toString: () => `file://${fsPath}`, fsPath },
      [{ message, severity, range: { start: { line: 0, character: 0 } } }],
    ];
  }

  it('挂载 @problems → 发送时刻取数并注入信封（上行只带通道标记，不带任何内容）', async () => {
    const h = setupInput();
    const { chat } = mount(h);
    const vscodeMock = await import('vscode');
    (vscodeMock.languages.getDiagnostics as ReturnType<typeof vi.fn>).mockReturnValue([
      diagGroup('src/a.ts', 'boom'),
    ]);

    await h.cast.handleInput({ kind: 'send', text: '帮我修', injections: ['problems'] });

    const sent = chat.mock.calls[0][0] as string;
    expect(sent).toContain('[工作区诊断]');
    expect(sent).toContain('src/a.ts');
    expect(sent).toContain('boom');
    // 用户请求仍在信封末尾（剥离契约：回放可还原）
    expect(sent).toContain('帮我修');
  });

  it('未挂载 → 信封不含诊断块（反向守卫：不悄悄塞内容）', async () => {
    const h = setupInput();
    const { chat } = mount(h);
    const vscodeMock = await import('vscode');
    (vscodeMock.languages.getDiagnostics as ReturnType<typeof vi.fn>).mockReturnValue([
      diagGroup('src/a.ts', 'boom'),
    ]);

    await h.cast.handleInput({ kind: 'send', text: '普通提问' });

    expect(chat.mock.calls[0][0]).not.toContain('[工作区诊断]');
    expect(chat.mock.calls[0][0]).not.toContain('boom');
  });

  it('零诊断仍注入“事实行”（用户挂了标签却什么都没送出去 = 静默失败）', async () => {
    const h = setupInput();
    const { chat } = mount(h);
    const vscodeMock = await import('vscode');
    (vscodeMock.languages.getDiagnostics as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await h.cast.handleInput({ kind: 'send', text: '有错吗', injections: ['problems'] });

    const sent = chat.mock.calls[0][0] as string;
    expect(sent).toContain('[工作区诊断]');
    expect(sent).toContain('没有错误或警告诊断');
  });

  it('回推 injection_summary：按源分项，合计 = 分项之和（唯一真源，webview 不再算）', async () => {
    const h = setupInput();
    mount(h);
    const vscodeMock = await import('vscode');
    (vscodeMock.languages.getDiagnostics as ReturnType<typeof vi.fn>).mockReturnValue([
      diagGroup('src/a.ts', 'boom'),
    ]);

    await h.cast.handleInput({ kind: 'send', text: '帮我修', injections: ['problems'] });

    const summary = h.posted.find((m) => (m as { type?: string }).type === 'injection_summary') as {
      summary: {
        segments: { source: string; injected: boolean; tokens?: number }[];
        total: number;
      };
    };
    expect(summary).toBeTruthy();
    // 活动文件也降为一个分项（本例无活动编辑器 ⇒ injected=false、无 tokens）
    const af = summary.summary.segments.find((s) => s.source === 'active-file');
    const pb = summary.summary.segments.find((s) => s.source === 'problems');
    expect(af?.injected).toBe(false);
    expect(pb?.injected).toBe(true);
    expect(typeof pb?.tokens).toBe('number');
    expect(summary.summary.total).toBe(
      summary.summary.segments.reduce((n, s) => n + (s.tokens ?? 0), 0),
    );
  });

  it('汇总先于活动文件投影回推（同批发、顺序在先：否则 chip 借不到本轮数字）', async () => {
    const h = setupInput();
    mount(h);
    const vscodeMock = await import('vscode');
    (vscodeMock.languages.getDiagnostics as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await h.cast.handleInput({ kind: 'send', text: '走一轮', injections: ['problems'] });

    const types = h.posted.map((m) => (m as { type?: string }).type);
    const iSummary = types.indexOf('injection_summary');
    const iActive = types.lastIndexOf('active_file');
    expect(iSummary).toBeGreaterThanOrEqual(0);
    expect(iActive).toBeGreaterThanOrEqual(0);
    expect(iSummary).toBeLessThan(iActive);
  });

  it('取数失败不得让整条发送挂掉（信封里留一句事实，而非静默空块）', async () => {
    const h = setupInput();
    const { chat } = mount(h);
    const vscodeMock = await import('vscode');
    // getDiagnostics 抛错（现实中极少，但若发生：没有兜底 = 用户点发送后毫无反应，
    // 正是本项目已踩过四次的「静默失败」族）
    (vscodeMock.languages.getDiagnostics as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('diagnostics blew up');
    });

    await h.cast.handleInput({ kind: 'send', text: '帮我修', injections: ['problems'] });

    // ① 消息照常发出（不挂）
    expect(chat).toHaveBeenCalledTimes(1);
    const sent = chat.mock.calls[0][0] as string;
    // ② 信封里有**事实**：挂了但没拿到 ⇒ 模型知道，而不是收到空块后凭空编诊断
    expect(sent).toContain('[工作区诊断]');
    expect(sent).toContain('采集失败');
    expect(sent).toContain('帮我修');
  });

  it('带图 send：回声消息带 attachments + attachmentUris（运行时这条路不经 rounds 投影）', async () => {
    const h = setupInput();
    const { chat } = mount(h);
    const image: ImageRef = {
      sha256: 'a1b2c3d4e5f6',
      mime: 'image/png',
      width: 8,
      height: 8,
      bytes: 64,
      name: '截图.png',
    };

    await h.cast.handleInput({ kind: 'send', text: '看图', attachments: [image] });

    // 内核侧拿到同一份真值（chat 第三参）；上屏回声必须带同一份，否则「刚发出的图」
    // 要等重放才有缩略图——那是半修（渲染层无法自造 URL）
    expect((chat.mock.calls[0] as unknown[])[2]).toEqual([image]);
    const echo = h.posted.find((m) => (m as { type?: string }).type === 'user') as {
      attachments?: readonly ImageRef[];
      attachmentUris?: Record<string, string>;
    };
    expect(echo.attachments).toEqual([image]);
    // 替身 asWebviewUri 恒定返回 mock://script ⇒ 键必须是 sha256（不是下标、不是文件名）
    expect(echo.attachmentUris).toEqual({ a1b2c3d4e5f6: 'mock://script' });
  });

  it('无图 send：回声消息不多出任何附件字段（形状与升级前逐字一致）', async () => {
    const h = setupInput();
    mount(h);

    await h.cast.handleInput({ kind: 'send', text: '纯文字' });

    const echo = h.posted.find((m) => (m as { type?: string }).type === 'user') as Record<
      string,
      unknown
    >;
    expect('attachments' in echo).toBe(false);
    expect('attachmentUris' in echo).toBe(false);
  });
});

describe('IMG-8 · 宿主兜底：三维聚合限额（与 webview 预检同判据，拒收走可见通知）', () => {
  function makeImage(i: number, over: Partial<ImageRef> = {}): ImageRef {
    return {
      sha256: `img-${i}`,
      mime: 'image/png',
      width: 8,
      height: 8,
      bytes: 64,
      name: `img-${i}.png`,
      ...over,
    };
  }

  it('张数超限（6 张）⇒ showWarningMessage 拒收 + 不进内核 chat（窗口真源 = providerStore）', async () => {
    const h = setupInput();
    const { chat } = mount(h);
    (
      h.cast as unknown as { _providerStore: { getActive: () => Promise<unknown> } }
    )._providerStore.getActive = async () => ({ contextWindow: 8000 });
    const { window } = await import('vscode');

    await h.cast.handleInput({
      kind: 'send',
      text: '看图',
      attachments: Array.from({ length: 6 }, (_, i) => makeImage(i)),
    });

    expect(chat).not.toHaveBeenCalled();
    expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('上限'));
    // 拒收也**不回声**：图没发出去，屏上不能出现「已发送」假象
    expect(h.posted.find((m) => (m as { type?: string }).type === 'user')).toBeUndefined();
  });

  it('token 维超限（单张图 vs 极小窗口）⇒ 同判据拦下（宿主按内核 imageTokens 累计）', async () => {
    const h = setupInput();
    const { chat } = mount(h);
    (
      h.cast as unknown as { _providerStore: { getActive: () => Promise<unknown> } }
    )._providerStore.getActive = async () => ({ contextWindow: 2000 });
    const { window } = await import('vscode');

    await h.cast.handleInput({
      kind: 'send',
      text: '看大图',
      // 单张封顶 1568 token（内核 IMAGE_TOKEN_UPPER_BOUND）⇒ 单张触发须窗口 × 25% < 1568
      attachments: [makeImage(0, { width: 10000, height: 10000 })],
    });

    expect(chat).not.toHaveBeenCalled();
    expect(window.showWarningMessage).toHaveBeenCalledWith(expect.stringContaining('token'));
  });

  it('反例：窗口未配置（getActive 返回 undefined）⇒ token 维跳过，小图照常发送', async () => {
    const h = setupInput();
    const { chat } = mount(h);
    (
      h.cast as unknown as { _providerStore: { getActive: () => Promise<unknown> } }
    )._providerStore.getActive = async () => undefined;

    await h.cast.handleInput({ kind: 'send', text: '看图', attachments: [makeImage(0)] });

    expect(chat).toHaveBeenCalledTimes(1);
  });
});
