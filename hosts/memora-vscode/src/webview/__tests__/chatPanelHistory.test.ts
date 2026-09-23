/**
 * chatPanel 会话管理集成测试（ADR-024 会话标题层 + 2026-08-17 会话管理重构）
 *
 * 用真实 WorkspaceSessionStore（临时目录落盘）+ mock vscode 驱动
 * MemoraChatViewProvider 的会话管理入口（pushSessionList / handleDeleteSession /
 * newSessionFromCommand / switchToSession / renameCurrentSession），验证：
 *   - 历史列表只返回非当前会话、按 updatedAt 降序（当前会话不进历史记录，设计收敛）
 *   - 删除会话记录：确认后删除（消息 + meta），取消不删，目标为当前会话时拒绝
 *   - 新建会话切入空会话并推送占位标题
 *   - 切换会话后重放该会话历史 + 推送 session_title
 *   - 改名写入元数据并推送新标题
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, AgentChunk, ProcessEvent, Round } from '@zooique/memora';
import type { RoundView, TurnState } from '../../shared/protocol.js';
import { todayDate } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { WorkspaceSessionViewLoader } from '../../extension/host/sessionViewLoader.js';
import { MemoraChatViewProvider, MAX_THOUGHT_PAYLOAD_LENGTH } from '../panels/chatPanel.js';

// mock vscode：仅提供 chatPanel / ProviderStore 用到的最小 API
vi.mock('vscode', async () => {
  const uri = {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    fsPath: '/mock/path',
  };
  return {
    Uri: uri,
    window: {
      // 会话管理的 InputBox / 危险操作确认 modal（QuickPick 已移除，2026-08-17）
      showInputBox: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      // 文档上下文跟随（2026-08-17 A 层）：provider 构造时注册监听 + 读初始 activeTextEditor
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      activeTextEditor: undefined,
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
    },
  };
});

import * as vscode from 'vscode';

/** agent 桩：仅提供会话管理相关方法（switchToSession / renameSession）+ 记忆联动（⑥） */
function agentStub(): {
  agent: Agent;
  switchToSession: ReturnType<typeof vi.fn>;
  renameSession: ReturnType<typeof vi.fn>;
  softDeleteRoundSummaries: ReturnType<typeof vi.fn>;
} {
  const switchToSession = vi.fn().mockResolvedValue(0);
  const renameSession = vi.fn();
  const softDeleteRoundSummaries = vi.fn().mockReturnValue(0);
  // 最小 agent：仅暴露会话管理子对象 + 记忆联动 + 事件订阅空实现（bindAgentNoticeEvents 需要），其余方法留空
  const agent = {
    sessionManager: { switchToSession, renameSession },
    memory: { softDeleteRoundSummaries },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Agent;
  return { agent, switchToSession, renameSession, softDeleteRoundSummaries };
}

/** 构造一个 sessionStore + provider 的最小桩，返回可驱动的 provider 实例 */
function setup(): {
  store: WorkspaceSessionStore;
  roundStore: WorkspaceRoundStore;
  provider: MemoraChatViewProvider;
  posted: unknown[];
  resolveWebview: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'memora-chatpanel-'));
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();

  // providerStore 桩：仅需 listMasked / getActiveName（pushProviders 用）
  const providerStore = {
    listMasked: async () => [],
    getActiveName: () => undefined,
  } as never;

  const provider = new MemoraChatViewProvider(
    { fsPath: '/mock/uri' } as never,
    store,
    providerStore,
  );
  const posted: unknown[] = [];

  // 注入一个最小 webviewView，拦截 postMessage 记录
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

  return {
    store,
    roundStore,
    provider,
    posted,
    resolveWebview: () => {},
  };
}

/** 内存中直接写入会话消息（round-based：user/assistant 成对写入 RoundStore 并登记 roundId） */
function seedSession(
  store: WorkspaceSessionStore,
  roundStore: WorkspaceRoundStore,
  sessionId: string,
  msgs: { role: string; content: string; ts: string }[],
): void {
  const idx = sessionId.lastIndexOf('-');
  const date = sessionId.slice(0, idx);
  const session = sessionId.slice(idx + 1);
  // user/assistant 成对聚为问答闭环（奇数组末条为 pending user 轮）
  for (let i = 0; i < msgs.length; i += 2) {
    const u = msgs[i]!;
    const a = msgs[i + 1];
    const roundId = `round-${roundStore.size() + 1}`;
    const round: Round = {
      id: roundId,
      userMessage: { id: `${roundId}-user`, role: 'user', content: u.content, timestamp: u.ts },
      ...(a
        ? { assistantMessage: { id: `${roundId}-assistant`, role: 'assistant', content: a.content, timestamp: a.ts } }
        : {}),
      status: a ? 'complete' : 'pending',
      createdAt: u.ts,
      ...(a ? { completedAt: a.ts } : {}),
      refCount: 1,
    };
    roundStore.save(round);
    store.appendRoundId(`${date}-${session}`, roundId);
  }
}

/** 从 posted 中按 type 过滤消息 */
function ofType<T extends { type: string }>(posted: unknown[], type: string): T[] {
  return posted.filter((m) => (m as { type: string }).type === type) as T[];
}

/**
 * 从 posted 提取最后一条 turn_update（M5b-3 重放单通道：rounds 承载全量轮）。
 *
 * 仅作 host 转发层断言锚点——重放后 webview 不再收 user/replay_events/assistant 消息风暴，
 * 而收单条 turn_update(replay:true)，rounds[0] 即整批重建所需的目标轮快照。
 */
function lastTurnUpdate(posted: unknown[]): {
  replay?: boolean;
  rounds: RoundView[];
  state: TurnState;
} {
  const all = ofType<{ type: string } & { replay?: boolean; rounds: RoundView[]; state: TurnState }>(
    posted,
    'turn_update',
  );
  return all[all.length - 1]!;
}

/**
 * 构造带 chat()/getMetrics/sessionManager 的 mock agent（consumeFlow 链路用）
 *
 * 文件级提取（M3b-2a）：落盘时机用例与 turn 投影用例都要驱动 `consumeFlow`，
 * 各持一份 stub 就是两套替身契约——漏补一个方法即「假故障」（M3b-1 已踩过：替身缺
 * `isPausePending` → postTurnUpdate 抛错中断整个 consumeFlow，表现为 processEvents 未落盘）。
 */
function chatAgentStub(chatFn: () => AsyncGenerator<AgentChunk, void, unknown>): Agent {
  return {
    chat: chatFn,
    getMetrics: () => ({
      llm: { totalInputTokens: 0, totalOutputTokens: 0 },
      // 对齐 AgentMetrics 契约：流尾 emitEvent 读取 tools.unparsedToolIntentCount（2026-09-14）
      tools: { callCount: 0, failureCount: 0, unparsedToolIntentCount: 0 },
    }),
    sessionManager: {
      getCurrentSessionInfo: () => ({ date: '2026-08-15', session: 's1' }),
      switchToSession: async () => 0,
    },
    on: vi.fn(),
    off: vi.fn(),
    memory: { softDeleteRoundSummaries: vi.fn() },
    getCheckpoint: () => null,
    // 暂停在途判据（M3b-1：postTurnUpdate 折叠 TurnState 时读取，真实 handlePause 同 API）
    isPausePending: () => false,
  } as unknown as Agent;
}

describe('chatPanel 会话管理（2026-08-17 重构：标题条按钮 + 历史模态浮层）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pushSessionList：只返回非当前会话，按 updatedAt 降序', () => {
    const { store, roundStore, provider, posted } = setup();
    seedSession(store, roundStore, '2026-08-15-s1', [{ role: 'user', content: 'x', ts: 't1' }]);
    seedSession(store, roundStore, '2026-08-14-s2', [{ role: 'user', content: 'y', ts: 't2' }]);
    store.setSessionTitle('2026-08-15-s1', '今天会话');
    store.setSessionTitle('2026-08-14-s2', '昨天会话');
    // 当前会话 = s1 → s1 不进历史（设计收敛），只剩 s2
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    (provider as unknown as { pushSessionList(): void }).pushSessionList();
    const data = ofType<{ type: string; sessions: { sessionId: string; title: string }[] }>(
      posted,
      'session_list_data',
    );
    expect(data).toHaveLength(1);
    expect(data[0]?.sessions.map((s) => s.sessionId)).toEqual(['2026-08-14-s2']);
    expect(data[0]?.sessions[0]?.title).toBe('昨天会话');
  });

  it('pushSessionList：无历史时返回空数组（webview 显示空态）', () => {
    const { provider, posted } = setup();
    (provider as unknown as { pushSessionList(): void }).pushSessionList();
    const data = ofType<{ type: string; sessions: unknown[] }>(posted, 'session_list_data');
    expect(data[0]?.sessions).toEqual([]);
  });

  it('handleDeleteSession：确认后删除会话记录（消息 + meta）+ 联动软删记忆摘要（⑥）+ 重推列表', async () => {
    const { store, roundStore, provider, posted } = setup();
    const { agent, softDeleteRoundSummaries } = agentStub();
    provider.setAgent(agent);
    seedSession(store, roundStore, '2026-08-14-s2', [{ role: 'user', content: 'y', ts: 't2' }]);
    store.setSessionTitle('2026-08-14-s2', '昨天会话');
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('删除' as never);
    await (provider as unknown as { handleDeleteSession(s: string): Promise<void> }).handleDeleteSession(
      '2026-08-14-s2',
    );
    // 会话记录已删除：meta + 消息均消失（会话级路标存于 meta，随之一并删除，无需额外联动）
    expect(store.getSessionMeta('2026-08-14-s2')).toBeUndefined();
    expect(store.listSessions()).not.toContain('2026-08-14-s2');
    // ⑥ 联动：被回收轮（round-1）的轮次摘要软删进回收站
    expect(softDeleteRoundSummaries).toHaveBeenCalledWith(['round-1']);
    // 删除后重推列表（此时空）
    const data = ofType<{ type: string; sessions: unknown[] }>(posted, 'session_list_data');
    expect(data[0]?.sessions).toEqual([]);
  });

  it('handleDeleteSession：确认取消则不删除', async () => {
    const { store, roundStore, provider } = setup();
    seedSession(store, roundStore, '2026-08-14-s2', [{ role: 'user', content: 'y', ts: 't2' }]);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    await (provider as unknown as { handleDeleteSession(s: string): Promise<void> }).handleDeleteSession(
      '2026-08-14-s2',
    );
    expect(store.getSessionMeta('2026-08-14-s2')).toBeDefined();
  });

  it('handleDeleteSession：目标为当前会话时拒绝（防御保护，防未来 UI 变动误删）', async () => {
    const { store, roundStore, provider, posted } = setup();
    seedSession(store, roundStore, '2026-08-15-s1', [{ role: 'user', content: 'x', ts: 't1' }]);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('删除' as never);
    await (provider as unknown as { handleDeleteSession(s: string): Promise<void> }).handleDeleteSession(
      '2026-08-15-s1',
    );
    expect(store.getSessionMeta('2026-08-15-s1')).toBeDefined(); // 未删
    const notice = ofType<{ type: string; message: string }>(posted, 'notice');
    expect(notice[0]?.message).toContain('当前会话不在历史记录');
  });

  it('新建会话 → 生成唯一会话名 + 清空重放 + 推送占位标题', async () => {
    const { provider, posted } = setup();
    const { agent, switchToSession } = agentStub();
    provider.setAgent(agent);

    await provider.newSessionFromCommand();

    // 内核 switchToSession 被调用，且会话名以 s 开头（唯一前缀）
    expect(switchToSession).toHaveBeenCalledTimes(1);
    const calledId = switchToSession.mock.calls[0]?.[0] as string;
    expect(calledId).toMatch(/^\d{4}-\d{2}-\d{2}-s/);
    // 重放：clear_ok + 占位标题（无消息）
    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).toContain('clear_ok');
    const title = ofType<{ type: string; title: string }>(posted, 'session_title');
    expect(title[0]?.title).toMatch(/^新会话 \d{2}:\d{2}$/);
  });

  it('切换会话 → 调内核 switchToSession + 重放该会话历史 + 推送标题', async () => {
    const { store, roundStore, provider, posted } = setup();
    const { agent, switchToSession } = agentStub();
    provider.setAgent(agent);
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '问题A', ts: '2026-08-15T10:00:00.000Z' },
      { role: 'assistant', content: '回答A', ts: '2026-08-15T10:00:30.000Z' },
    ]);
    store.setSessionTitle('2026-08-15-s1', '会话A');
    // 当前会话切到另一个，验证切换动作触发
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-14-other';

    await provider.switchToSession('2026-08-15-s1');

    expect(switchToSession).toHaveBeenCalledWith('2026-08-15-s1');
    // 重放：clear_ok + 该会话消息 + session_title
    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).toContain('clear_ok');
    const userMsgs = ofType<{ type: string; text: string }>(posted, 'user');
    expect(userMsgs.map((m) => m.text)).toContain('问题A');
    const title = ofType<{ type: string; title: string }>(posted, 'session_title');
    expect(title[0]?.title).toBe('会话A');
  });

  it('改名当前会话 → 写入元数据 + 推送新标题', async () => {
    const { store, roundStore, provider, posted } = setup();
    const { agent, renameSession } = agentStub();
    provider.setAgent(agent);
    seedSession(store, roundStore, '2026-08-14-other', [{ role: 'user', content: 'x', ts: '2026-08-14T09:00:00.000Z' }]);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-14-other';

    vi.mocked(vscode.window.showInputBox).mockResolvedValue('我的新标题');
    await provider.renameCurrentSession();

    expect(renameSession).toHaveBeenCalledWith('2026-08-14-other', '我的新标题');
    const title = ofType<{ type: string; title: string }>(posted, 'session_title');
    expect(title[0]?.title).toBe('我的新标题');
  });

  // ─── M5b-3 重放转正（user/replay_events/assistant 消息风暴 → 单条 turn_update.rounds） ───
  it('round-based 重放：单条 turn_update(replay=true) 承载全量 rounds（v1.6 · M5b-3）', () => {
    const { store, roundStore, provider, posted } = setup();
    // 生产装配路径：extension 注入同一 viewLoader + roundStore 单例
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';

    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '问题A', ts: 't1' },
      { role: 'assistant', content: '回答A', ts: 't2' },
    ]);
    // 为第一轮补过程事件（meta 首条 + memory_added + metrics 末条）
    const round = roundStore.getById('round-1')!;
    round.processEvents = [
      { type: 'meta', seq: 1, ts: 't1', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
      { type: 'memory_added', seq: 2, ts: 't1', payload: { id: 'r:1', name: '记忆', source: 'round-summary' } },
      { type: 'metrics', seq: 3, ts: 't2', payload: { durationMs: 3000, tokenIn: 10, tokenOut: 20, toolFailureCount: 0, success: true } },
    ];
    roundStore.save(round);

    (provider as unknown as { replayCurrentSession(): void }).replayCurrentSession();

    // 重放 = clear_ok → 单条 turn_update（replay:true）→ session_title；不再有 process_event /
    // replay_events / assistant 重放消息风暴（M5b-3 双端收敛，协议类型已删）
    const ordered = posted.map((m) => (m as { type: string }).type);
    const idxTurn = ordered.indexOf('turn_update');
    expect(ordered).not.toContain('process_event');
    expect(ordered).not.toContain('replay_events');
    expect(ordered).not.toContain('assistant');
    expect(ordered.indexOf('clear_ok')).toBeLessThan(idxTurn); // 先清空再整批重建
    expect(idxTurn).toBeGreaterThanOrEqual(0);
    expect(ordered.indexOf('session_title')).toBeGreaterThan(idxTurn);

    const tu = lastTurnUpdate(posted);
    expect(tu.replay).toBe(true);
    const rounds = tu.rounds;
    expect(rounds).toHaveLength(1);
    const r = rounds[0];
    // rounds 承载真实轮：用户输入 / 过程事件（meta 为整批首条）/ 最终回答
    expect(r.id).toBe('round-1');
    expect(r.userMessage?.content).toBe('问题A');
    expect(r.processEvents?.map((e: { type: string }) => e.type)).toEqual(['meta', 'memory_added', 'metrics']);
    expect((r.processEvents?.[0] as { payload: { role: string; llm: string } }).payload).toEqual({
      role: '文档设计师',
      llm: 'deepseek-chat',
    });
    expect(r.assistantMessage?.content).toBe('回答A');
    expect(r.status).toBe('complete');
  });

  it('interactiveInputs 重放由 rounds 完整承载：qa/supplement 按 ts 升序、与提问段/final 时序数据齐备（UX-9 · M5b-3）', () => {
    const { store, roundStore, provider, posted } = setup();
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '任务A', ts: 't1' },
      { role: 'assistant', content: '最终回答', ts: 't5' },
    ]);
    // TS-9 闭环节点数据：前序 assistant 段（含提问）+ 交互输入（qa 与 supplement 混合）
    const round = roundStore.getById('round-1')!;
    round.assistantLog = [
      { id: 'a0', role: 'assistant', content: '需要先确认哪个方案？', timestamp: 't2' } as NonNullable<Round['assistantMessage']>,
    ];
    round.interactiveInputs = [
      { id: 'i1', role: 'user', content: '选方案A', timestamp: 't3', kind: 'question-answer' } as never,
      { id: 'i2', role: 'user', content: '补充：不要联网搜索', timestamp: 't4', kind: 'supplement' } as never,
    ];
    roundStore.save(round);

    (provider as unknown as { replayCurrentSession(): void }).replayCurrentSession();

    // M5b-3：host 只投递单条 turn_update，interactiveInputs 随 rounds[0] 完整透传（时序归位在 webview renderReplayRound 端）
    const tu = lastTurnUpdate(posted);
    expect(tu.replay).toBe(true);
    const r = tu.rounds[0]!;
    expect(r.id).toBe('round-1');
    // 三块数据完整承载：前序提问段 / 交互输入（qa+supplement）/ 最终回答
    expect(r.userMessage?.content).toBe('任务A');
    expect(r.assistantMessage?.content).toBe('最终回答');
    expect(r.assistantLog?.[0]?.content).toBe('需要先确认哪个方案？');
    const inputs = r.interactiveInputs ?? [];
    expect(inputs).toHaveLength(2);
    // UX-9 时序数据齐备（webview 端据此按 ts 交织渲染）：提问段(t2) < qa(t3) < supplement(t4) < final(t5)
    expect(r.assistantLog?.[0]?.timestamp).toBe('t2');
    expect(inputs.map((i) => i.timestamp)).toEqual(['t3', 't4']);
    expect(inputs.map((i) => (i as { kind?: string }).kind)).toEqual(['question-answer', 'supplement']);
  });

  it('timeout 交互记录重放随 rounds 透传：kind=timeout 携带 question/options（2026-09-08 超时保底 · M5b-3）', () => {
    const { store, roundStore, provider, posted } = setup();
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '帮我读文件', ts: 't1' },
      { role: 'assistant', content: '好的，按默认继续。', ts: 't5' },
    ]);
    const round = roundStore.getById('round-1')!;
    round.assistantLog = [
      { id: 'a0', role: 'assistant', content: '在读取前需要确认：', timestamp: 't2' } as NonNullable<Round['assistantMessage']>,
    ];
    // 内核超时保底落盘形态：kind='timeout' + 超时通知正文 + G26 question/options
    round.interactiveInputs = [
      {
        id: 'i1',
        role: 'user',
        content: '用户未在时限内回答，已自动继续',
        timestamp: 't3',
        kind: 'timeout',
        question: '你想读哪个文件？',
        options: ['probe.txt', 'config.json'],
      } as never,
    ];
    roundStore.save(round);

    (provider as unknown as { replayCurrentSession(): void }).replayCurrentSession();

    // M5b-3：timeout 行随 rounds[0].interactiveInputs 完整透传（含超时保底 question/options）
    const r = lastTurnUpdate(posted).rounds[0]!;
    expect(r.id).toBe('round-1');
    expect(r.userMessage?.content).toBe('帮我读文件');
    expect(r.assistantMessage?.content).toBe('好的，按默认继续。');
    expect(r.assistantLog?.[0]?.content).toBe('在读取前需要确认：');
    const inputs = r.interactiveInputs ?? [];
    expect(inputs).toHaveLength(1);
    // 时序数据齐备（webview 端据此归位）：提问段(t2) < timeout(t3) < final(t5)
    expect(r.assistantLog?.[0]?.timestamp).toBe('t2');
    expect(inputs[0]).toMatchObject({
      kind: 'timeout',
      content: '用户未在时限内回答，已自动继续',
      timestamp: 't3',
      question: '你想读哪个文件？',
      options: ['probe.txt', 'config.json'],
    });
  });

  it('round-based 纯问答轮（无 processEvents）由 rounds 承载仅正文（M5b-3）', () => {
    const { store, roundStore, provider, posted } = setup();
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '问题A', ts: 't1' },
      { role: 'assistant', content: '回答A', ts: 't2' },
    ]);

    (provider as unknown as { replayCurrentSession(): void }).replayCurrentSession();

    // M5b-3：不发 process_event/replay_events 重放消息风暴；纯问答轮 processEvents 为空数组，
    // 但 user 输入 + 最终回答仍由 round 承载（webview 端 renderReplayRound 退化为仅正文渲染）
    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).not.toContain('process_event');
    expect(types).not.toContain('replay_events');
    expect(types).not.toContain('assistant');
    const r = lastTurnUpdate(posted).rounds[0]!;
    expect(r.processEvents).toEqual([]);
    expect(r.userMessage?.content).toBe('问题A');
    expect(r.assistantMessage?.content).toBe('回答A');
  });

  it('跟随活动编辑器：编辑器变化实时更新文档上下文（A 层，2026-08-17）', () => {
    const { provider } = setup();
    // 捕获 provider 构造时注册的 onDidChangeActiveTextEditor 回调
    const cb = vi.mocked(vscode.window.onDidChangeActiveTextEditor).mock.calls[0]?.[0];
    expect(cb).toBeTypeOf('function');
    // 切换到某文档编辑器 → docContext 含文件名 + 内容（超长截断兜底）
    const editor = {
      document: { fileName: '/workspace/docs/方案.md', getText: () => '文档内容A' },
    } as never;
    cb?.(editor);
    const docContext = (provider as unknown as { _docContext: string | undefined })._docContext;
    expect(docContext).toContain('文件名：方案.md');
    expect(docContext).toContain('文档内容A');
    // 无活动编辑器 → 清空（退化为普通对话）
    cb?.(undefined);
    expect((provider as unknown as { _docContext: string | undefined })._docContext).toBeUndefined();
  });

  // ─── 历史会话占用重算（轻量版方案，2026-08-31）：切会话后圆环展示真实占用而非空态 0% ───
  it('replayCurrentSession 推送历史会话占用：对话层重算 + 角色包当前值', async () => {
    const { store, roundStore, provider, posted } = setup();
    // viewLoader + roundStore：round-based 消息路径
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '问题A', ts: 't1' },
      { role: 'assistant', content: '回答A', ts: 't2' },
    ]);
    // agent stub：getMetrics 返回含 rolePackBaseTokens 的 occupancy（角色包全局跨会话一致）
    const agent = {
      on: vi.fn(),
      off: vi.fn(),
      getMetrics: () => ({
        context: { occupancy: { rolePackBaseTokens: 15000 } },
      }),
    } as unknown as Agent;
    provider.setAgent(agent);
    // providerStore 桩：listMasked 返回 [] + getActiveName undefined → totalTokens 回落内核默认 120K
    (provider as unknown as { replayCurrentSession(): void }).replayCurrentSession();
    // 等待 fire-and-forget 的 postHistoryOccupancy（async）落定
    await vi.waitFor(() => {
      const occs = ofType<{ type: string; occupancy: { dialogueCount: number; rolePackBaseTokens: number } }>(
        posted,
        'context_occupancy',
      );
      // setAgent 装配兜底推 1 次 + replayCurrentSession 推 1 次（幂等，取最后一次验证）
      expect(occs.length).toBeGreaterThanOrEqual(1);
      const occ = occs[occs.length - 1]!.occupancy;
      // 对话层 = 1 个问答闭环（1 条 user，assistant 不计入条数，2026-09-01 定案）
      // 角色包 = 当前装配值
      expect(occ.dialogueCount).toBe(1);
      expect(occ.rolePackBaseTokens).toBe(15000);
    });
  });

  it('无 agent（未装配）→ 历史会话占用不推送（静默跳过，非关键路径）', () => {
    const { provider, posted } = setup();
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    (provider as unknown as { replayCurrentSession(): void }).replayCurrentSession();
    // _agent 为 undefined → postHistoryOccupancy 直接 return，不推 context_occupancy
    expect(ofType(posted, 'context_occupancy').length).toBe(0);
  });

  it('懒装配路径（ensureAgent）装配完成后推送历史会话占用（两条装配入口共用收口点）', async () => {
    const { store, roundStore, provider, posted } = setup();
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '问题A', ts: 't1' },
      { role: 'assistant', content: '回答A', ts: 't2' },
    ]);
    const agent = {
      on: vi.fn(),
      off: vi.fn(),
      getMetrics: () => ({
        context: { occupancy: { rolePackBaseTokens: 15000 } },
      }),
    } as unknown as Agent;
    // 懒装配入口：只注入工厂、不调 setAgent（点侧栏图标 / 重启恢复面板走此路径）
    provider.setAgentFactory(async () => agent);
    await (provider as unknown as { ensureAgent(): Promise<void> }).ensureAgent();
    await vi.waitFor(() => {
      const occs = ofType<{ type: string; occupancy: { dialogueCount: number; rolePackBaseTokens: number } }>(
        posted,
        'context_occupancy',
      );
      expect(occs.length).toBeGreaterThanOrEqual(1);
      expect(occs[occs.length - 1]!.occupancy.dialogueCount).toBe(1); // 1 个问答闭环（user 计数，2026-09-01 定案）
      expect(occs[occs.length - 1]!.occupancy.rolePackBaseTokens).toBe(15000);
    });
  });

  // ─── 角色包切换实时刷新占用（2026-09-01）：onRolePackSwitched 末尾补推 context_occupancy ───
  it('切换角色包（rolePackSwitched）→ 实时补推 context_occupancy（含最新 rolePackBaseTokens）', async () => {
    const { provider, posted } = setup();
    // agent stub：on 捕获 rolePackSwitched 处理器，getMetrics 返回当前角色包底盘占用
    let rolePackHandler: ((info: { from: string | null; to: string }) => void) | undefined;
    const agent = {
      on: vi.fn((event: string, cb: (info: { from: string | null; to: string }) => void) => {
        if (event === 'rolePackSwitched') rolePackHandler = cb;
      }),
      off: vi.fn(),
      getMetrics: () => ({
        context: {
          // 角色包切换后的底盘占用（内核已在切换时 setRolePackBaseTokens 重算）
          occupancy: { rolePackBaseTokens: 9000 } as never,
          rolePackBaseTokens: 9000,
        },
      }),
    } as unknown as Agent;
    provider.setAgent(agent);
    expect(rolePackHandler).toBeDefined();
    // 内核 emit 角色包切换（手动 activate / 检查点恢复激活）
    rolePackHandler!({ from: 'packA', to: 'packB' });
    // postContextOccupancy 同步推送；断言圆环即时反映最新角色包占用（无需等下一轮 prepare）
    const occs = ofType<{ type: string; occupancy: { rolePackBaseTokens: number } }>(posted, 'context_occupancy');
    expect(occs.length).toBeGreaterThanOrEqual(1);
    // 取最后一次推送：角色包切换补推的那一条必须带最新 rolePackBaseTokens
    expect(occs[occs.length - 1]!.occupancy.rolePackBaseTokens).toBe(9000);
  });

  it('冷启动无 prepare：rolePackBaseTokens 由装配时确定并随切换覆盖（postContextOccupancy 覆盖旧快照）', async () => {
    const { provider, posted } = setup();
    // 装配后内核已确定 rolePackBaseTokens，但首轮 prepare 前 occupancy 快照的该字段可能仍为 0（诚实降级）
    let rolePackHandler: ((info: { from: string | null; to: string }) => void) | undefined;
    const agent = {
      on: vi.fn((event: string, cb: (info: { from: string | null; to: string }) => void) => {
        if (event === 'rolePackSwitched') rolePackHandler = cb;
      }),
      off: vi.fn(),
      getMetrics: () => ({
        context: {
          occupancy: { rolePackBaseTokens: 0 } as never, // 快照降级值
          rolePackBaseTokens: 7000, // 真实最新值（切换时重算）
        },
      }),
    } as unknown as Agent;
    provider.setAgent(agent);
    expect(rolePackHandler).toBeDefined();
    rolePackHandler!({ from: null, to: 'packB' });
    const occs = ofType<{ type: string; occupancy: { rolePackBaseTokens: number } }>(posted, 'context_occupancy');
    expect(occs.length).toBeGreaterThanOrEqual(1);
    // postContextOccupancy 用 ctx.rolePackBaseTokens 覆盖快照的 0，圆环展示真实 7000
    expect(occs[occs.length - 1]!.occupancy.rolePackBaseTokens).toBe(7000);
  });

  // ─── Phase 4 软暂停入口：生成中暂停走 step 边界挂起 requestPause（与内核 step 边界软暂停语义一致）
  // Phase 4 升级：handlePause 从"只调 requestPause"变成"先读 isPausePending toggle 再调 requestPause/cancelPauseRequest"
  // （chatPanel.ts L2026），mock 必须同步新增 isPausePending + cancelPauseRequest，否则 TypeError。 ───
  function pauseAgentStub(): {
    agent: Agent;
    requestPause: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    isPausePending: ReturnType<typeof vi.fn>;
    cancelPauseRequest: ReturnType<typeof vi.fn>;
  } {
    const requestPause = vi.fn(() => true);
    const pause = vi.fn(() => true);
    // Phase 4 toggle 依赖：默认无在途暂停申请（走 requestPause 路径，非 cancel）
    const isPausePending = vi.fn(() => false);
    const cancelPauseRequest = vi.fn();
    const agent = { requestPause, pause, isPausePending, cancelPauseRequest, on: vi.fn(), off: vi.fn() } as unknown as Agent;
    return { agent, requestPause, pause, isPausePending, cancelPauseRequest };
  }

  it('handlePause：生成中软暂停走 requestPause（step 边界挂起），不用立即翻态的 pause', () => {
    const { provider, posted } = setup();
    const { agent, requestPause, pause } = pauseAgentStub();
    provider.setAgent(agent);
    // 生成中（流进行中）暂停按钮才可见 → _streaming=true
    (provider as unknown as { _streaming: boolean })._streaming = true;
    (provider as unknown as { handlePause(): void }).handlePause();
    // 应调 step 边界软暂停入口 requestPause，而非立即翻态的 pause
    expect(requestPause).toHaveBeenCalledWith('user-pause', 'user');
    expect(pause).not.toHaveBeenCalled();
    // 点击即反馈（2026-09-07）：申请已发送要明确告知
    const notices = ofType(posted, 'notice');
    expect(notices).toHaveLength(1);
    expect((notices[0] as { message?: string }).message).toContain('暂停申请已发送');
  });

  it('handlePause：requestPause 返回 false → 明确告知申请未生效（作废路径）', () => {
    const { provider, posted } = setup();
    const { agent, requestPause } = pauseAgentStub();
    requestPause.mockReturnValue(false);
    provider.setAgent(agent);
    // handlePause 不再检查 _streaming
    (provider as unknown as { _streaming: boolean })._streaming = true;
    (provider as unknown as { handlePause(): void }).handlePause();
    // 反馈申请未生效（空闲守卫作废 / 幂等 / paused、error 态）——不再保持沉默
    const notices = ofType(posted, 'notice');
    expect(notices).toHaveLength(1);
    expect((notices[0] as { message?: string }).message).toContain('未生效');
  });

  it('handlePause：空闲态也可 toggle（不再检查 _streaming），点击即反馈', () => {
    const { provider, posted } = setup();
    const { agent, requestPause } = pauseAgentStub();
    provider.setAgent(agent);
    // _streaming=false 时 UI 本来就隐藏暂停按钮（syncButtonSemantics 控制）；
    // 但如果 handlePause 被调（边缘场景），应该正常调 requestPause 不被拦截
    (provider as unknown as { _streaming: boolean })._streaming = false;
    (provider as unknown as { handlePause(): void }).handlePause();
    expect(requestPause).toHaveBeenCalledWith('user-pause', 'user');
    // 申请已发送（requestPause 默认 true）反馈
    expect(ofType(posted, 'notice')).toHaveLength(1);
  });

  // ─── 首次启动自动创建首会话（2026-08-31 体验改进：无记录时免手动点「＋」） ───
  it('无历史会话：ensureInitialSession 自动创建首个会话（用户可直接输入）', async () => {
    const { provider, posted } = setup();
    const { agent, switchToSession } = agentStub();
    provider.setAgent(agent);
    // 首次启动：无任何会话记录 → _currentSessionId 为空
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '';
    await (provider as unknown as { ensureInitialSession(): Promise<void> }).ensureInitialSession();
    // 自动创建：switchToSession 被调用，会话 id 为 date-sxxx 格式，_currentSessionId 已更新
    expect(switchToSession).toHaveBeenCalledTimes(1);
    const createdId = (provider as unknown as { _currentSessionId: string })._currentSessionId;
    expect(createdId).toMatch(/^\d{4}-\d{2}-\d{2}-s[0-9a-z]+$/);
    // UI 推送新会话标题
    expect(ofType(posted, 'session_title').length).toBeGreaterThanOrEqual(1);
  });

  it('已有会话（历史恢复）：ensureInitialSession 不自动创建', async () => {
    const { provider } = setup();
    const { agent, switchToSession } = agentStub();
    provider.setAgent(agent);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-31-s1';
    await (provider as unknown as { ensureInitialSession(): Promise<void> }).ensureInitialSession();
    expect(switchToSession).not.toHaveBeenCalled();
  });

  it('新建会话：clear_ok 之后不应重放旧会话历史（防顶部残留空白块）', async () => {
    const { store, roundStore, provider, posted } = setup();
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    // seed 会话 A：2 轮有内容的历史
    seedSession(store, roundStore, '2026-08-31-a', [
      { role: 'user', content: '问题1', ts: 't1' },
      { role: 'assistant', content: '回答1', ts: 't2' },
      { role: 'user', content: '问题2', ts: 't3' },
      { role: 'assistant', content: '回答2', ts: 't4' },
    ]);
    const { agent } = agentStub();
    provider.setAgent(agent);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-31-a';
    // 新建会话 B（空）→ 触发 clear_ok + replay(B 空) + session_title
    await (provider as unknown as { newSessionFromCommand(): Promise<void> }).newSessionFromCommand();
    // B 切入后 _currentSessionId 应更新为新的 date-sxxx
    const newId = (provider as unknown as { _currentSessionId: string })._currentSessionId;
    expect(newId).toMatch(/^\d{4}-\d{2}-\d{2}-s[0-9a-z]+$/);
    // clear_ok 之后的 post 中不应有消息类事件（B 是空会话，replay 不重放 A 的历史）
    const clearIdx = posted.findIndex((m) => (m as { type: string }).type === 'clear_ok');
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    const afterClear = posted.slice(clearIdx);
    const msgTypes = ['user', 'assistant', 'process_event', 'replay_events', 'chunk', 'tool_start', 'tool_result'];
    const leaked = afterClear.filter((m) => msgTypes.includes((m as { type: string }).type));
    expect(leaked).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// consumeFlow 过程事件按 turn roundId 分组落盘（2026-09-02）
// ═══════════════════════════════════════════════════════════
// 修复：宿主原「流末一次落盘到 roundIds 末尾一个 round」在多 turn 任务编排下归属错误——
// 全部工具堆一个 round（拥挤）+ 部分 round 无 processEvents（丢失）。现按内核 chunk.roundId
// 分组，每个 turn 独立落盘到各自 Round（SSOT：归属由内核唯一提供，非 roundIds 末尾推断）。
describe('consumeFlow 过程事件按 turn roundId 分组落盘（2026-09-02）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * 包装 roundStore.save，记录**每次落盘时** processEvents 的事件类型快照。
   *
   * 观测法刻意不碰私有实现：只看「什么时刻写进去了什么」——落盘时机是行为，不是实现细节。
   * 判据「含 metrics」= 流尾那次终局落盘（metrics 是流尾才 emit 的终态事件）。
   */
  function spySaves(roundStore: WorkspaceRoundStore): string[][] {
    const calls: string[][] = [];
    const orig = roundStore.save.bind(roundStore);
    roundStore.save = (round: Round): void => {
      calls.push((round.processEvents ?? []).map((e) => e.type));
      orig(round);
    };
    return calls;
  }

  // ── 档3 落盘时机（2026-09-23）：step_boundary = 唯一点 ──────────────────────
  // 档2 把增量落盘挂在 plan_item_boundary（任务项推进）上 → 无任务表的长工具循环零增量落盘，
  // 崩溃即全丢。现改挂 step_boundary（迭代完成），与有无任务表无关。

  it('step_boundary = 增量落盘点：每次迭代落一次（无任务表也落）', async () => {
    const { store, roundStore, provider } = setup();
    provider.setRoundStore(roundStore); // 落盘依赖 _eventLogRoundStore 注入
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '任务', ts: 't0' },
      { role: 'assistant', content: '上一轮回答', ts: 't1' },
    ]);
    const saves = spySaves(roundStore);
    // 全程无 plan_item_boundary（无任务表）：若落盘仍挂它，这一轮全程零增量落盘
    provider.setAgent(
      chatAgentStub(() =>
        (async function* () {
          yield { type: 'thinking', phase: 'processing', roundId: 'round-1' };
          yield { type: 'step_boundary', roundId: 'round-1' };
          yield { type: 'tool_start', toolCallId: 't1', name: 'read_file', args: '{}', roundId: 'round-1' };
          yield { type: 'tool_result', toolCallId: 't1', name: 'read_file', ok: true, summary: 'ok', roundId: 'round-1' };
          yield { type: 'step_boundary', roundId: 'round-1' };
          yield { type: 'done' };
        })(),
      ),
    );
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('任务');

    // 两次迭代边界 → 两次增量落盘；流尾终局再落一次 = 3
    expect(saves).toHaveLength(3);
    // 第一次落盘时第二迭代的工具还没发生 —— 崩溃只丢未落盘的那一段，这正是落盘的意义
    expect(saves[0]).not.toContain('tool_start');
    // 第二次落盘把第二迭代的工具增量补上
    expect(saves[1]).toContain('tool_start');
    // 末次是流尾终局（metrics 为流尾专有事件）
    expect(saves[2]).toContain('metrics');
  });

  it('plan_item_boundary 不再是落盘点（时机单一）：它到场时不写库，全程仅流尾一次', async () => {
    const { store, roundStore, provider } = setup();
    provider.setRoundStore(roundStore);
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '任务', ts: 't0' },
      { role: 'assistant', content: '上一轮回答', ts: 't1' },
    ]);
    const saves = spySaves(roundStore);
    provider.setAgent(
      chatAgentStub(() =>
        (async function* () {
          yield { type: 'thinking', phase: 'processing', roundId: 'round-1' };
          yield { type: 'plan_item_boundary', planItemId: 'plan-item-1', title: '第一步', roundId: 'round-1' };
          yield { type: 'done' };
        })(),
      ),
    );
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('任务');

    // 唯一落盘 = 流尾（含 metrics）；plan_item_boundary 到场时无独立写库 —— 两个落盘点会各写一次，
    // 且崩溃前最后一次写的快照完整性不同（时机单一 = 落盘语义可推理）
    expect(saves).toHaveLength(1);
    expect(saves[0]).toContain('plan_item_boundary');
    expect(saves[0]).toContain('metrics');
  });

  it('一次 chat() 多turn（多 turn 任务编排）：各turn processEvents 独立落盘，不堆叠不覆盖', async () => {
    const { store, roundStore, provider } = setup();
    provider.setRoundStore(roundStore); // 落盘依赖 _eventLogRoundStore 注入
    // 预造两个turn的 Round（round-1 / round-2）
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '任务', ts: 't0' },
      { role: 'assistant', content: 'turn1回答', ts: 't1' },
    ]);
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '继续', ts: 't2' },
      { role: 'assistant', content: 'turn2回答', ts: 't3' },
    ]);
    // mock chat：一次流内两个turn（round-1 工具 / round-2 思考+工具），各自独立 roundId
    provider.setAgent(
      chatAgentStub(() =>
        (async function* () {
          yield { type: 'tool_start', toolCallId: 't1', name: 'read_file', args: '{}', roundId: 'round-1' };
          yield { type: 'tool_result', toolCallId: 't1', name: 'read_file', ok: true, summary: 'ok', roundId: 'round-1' };
          yield { type: 'text', content: 'turn1回答', roundId: 'round-1' };
          yield { type: 'thinking', phase: 'processing', roundId: 'round-2' };
          yield { type: 'tool_start', toolCallId: 't2', name: 'search', args: '{}', roundId: 'round-2' };
          yield { type: 'tool_result', toolCallId: 't2', name: 'search', ok: true, summary: 's', roundId: 'round-2' };
          yield { type: 'text', content: 'turn2回答', roundId: 'round-2' };
          yield { type: 'done' };
        })(),
      ),
    );
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('任务');

    // 每个 turn 的 processEvents 独立归属到自己的 Round（meta 段首 + 各自工具；metrics 归入收尾 turn）
    const r1 = roundStore.getById('round-1')!;
    const r2 = roundStore.getById('round-2')!;
    expect(r1.processEvents?.map((e) => e.type)).toEqual(['meta', 'tool_start', 'tool_result']);
    expect(r2.processEvents?.map((e) => e.type)).toEqual(['meta', 'thinking', 'tool_start', 'tool_result', 'metrics']);
    // 工具归属精确：t1 只在 round-1，t2 只在 round-2（不堆叠、不串位）
    expect(r1.processEvents?.some((e) => e.type === 'tool_start' && e.payload.toolCallId === 't1')).toBe(true);
    expect(r1.processEvents?.some((e) => e.type === 'tool_start' && e.payload.toolCallId === 't2')).toBe(false);
    expect(r2.processEvents?.some((e) => e.type === 'tool_start' && e.payload.toolCallId === 't2')).toBe(true);
  });

  it('流首 chunk 补推 plan_update：prepare 预置骨架（不经 task_table 工具事件）顶部条开局即可见', async () => {
    const { store, roundStore, provider, posted } = setup();
    provider.setRoundStore(roundStore); // 落盘依赖 _eventLogRoundStore 注入
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '小组会议', ts: 't0' },
      { role: 'assistant', content: '开场', ts: 't1' },
    ]);
    // mock agent：checkpoint 已带 prepare 期预置的会议骨架（3 步）；chat 流首 chunk 前无
    // task_table_* 工具事件（骨架预置走 writePlan 不经工具）——顶部条唯一可见机会 = 首 chunk 补推
    provider.setAgent({
      chat: async function* () {
        yield { type: 'thinking', phase: 'processing', roundId: 'round-1' };
        yield { type: 'text', content: '会议开场', roundId: 'round-1' };
        yield { type: 'done' };
      },
      getMetrics: () => ({
        llm: { totalInputTokens: 0, totalOutputTokens: 0 },
        tools: { callCount: 0, failureCount: 0, unparsedToolIntentCount: 0 },
      }),
      sessionManager: {
        getCurrentSessionInfo: () => ({ date: '2026-08-15', session: 's1' }),
        switchToSession: async () => 0,
      },
      on: vi.fn(),
      off: vi.fn(),
      memory: { softDeleteRoundSummaries: vi.fn() },
      getCheckpoint: () => ({
        plan: [
          { id: 's1', description: '主持人开场', status: 'active', order: 0 },
          { id: 's2', description: '成员一发言', status: 'pending', order: 1 },
          { id: 's3', description: '汇总观点', status: 'pending', order: 2 },
        ],
      }),
      // M3b-1：postTurnUpdate 折叠 TurnState 时读取（真实 handlePause 同 API）
      isPausePending: () => false,
    } as unknown as Agent);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('小组会议');

    // 首个 plan_update 即携带骨架（3 步）——顶部条开局可见，不再等首次 task_table_update
    const planMsgs = posted.filter((m) => (m as { type: string }).type === 'plan_update') as { items: unknown[] }[];
    expect(planMsgs.length).toBeGreaterThanOrEqual(1);
    expect(planMsgs[0]!.items).toHaveLength(3);
  });

  it('thought 思考流落盘为 processEvents（超长截断），重启重放可重建（2026-09-13）', async () => {
    const { store, roundStore, provider } = setup();
    provider.setRoundStore(roundStore); // 落盘依赖 _eventLogRoundStore 注入
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '对比方案', ts: 't0' },
      { role: 'assistant', content: '结论', ts: 't1' },
    ]);
    const longReasoning = 'x'.repeat(MAX_THOUGHT_PAYLOAD_LENGTH + 100);
    // mock chat：思考 → 工具 → 超长思考 → 正文（thought 与 tool 并存）
    provider.setAgent(
      chatAgentStub(() =>
        (async function* () {
          yield { type: 'thought', content: '思考：先查 A/B 资料', roundId: 'round-1' };
          yield { type: 'tool_start', toolCallId: 't1', name: 'web_search', args: '{}', roundId: 'round-1' };
          yield { type: 'tool_result', toolCallId: 't1', name: 'web_search', ok: true, summary: 's', roundId: 'round-1' };
          yield { type: 'thought', content: longReasoning, roundId: 'round-1' };
          yield { type: 'text', content: '结论', roundId: 'round-1' };
          yield { type: 'done' };
        })(),
      ),
    );
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('对比方案');

    const r1 = roundStore.getById('round-1')!;
    const thoughts =
      r1.processEvents?.filter((e): e is Extract<ProcessEvent, { type: 'thought' }> => e.type === 'thought') ?? [];
    expect(thoughts).toHaveLength(2);
    // 短思考原文落盘
    expect(thoughts[0].payload.content).toBe('思考：先查 A/B 资料');
    // 超长思考落盘截断（SSOT 常量，不超上限；省略标记 …）
    expect(thoughts[1].payload.content.length).toBeLessThanOrEqual(MAX_THOUGHT_PAYLOAD_LENGTH);
    // 与 tool 并存且按 seq 顺序（思考先于工具）
    const types = r1.processEvents?.map((e) => e.type) ?? [];
    expect(types.indexOf('thought')).toBeLessThan(types.indexOf('tool_start'));
    expect(types.indexOf('tool_start')).toBeLessThan(types.lastIndexOf('thought'));
  });

  it('连续两次 chat()（第二次问答）：第二次 processEvents 独立落盘到新 Round，不覆盖第一次', async () => {
    const { store, roundStore, provider } = setup();
    provider.setRoundStore(roundStore); // 落盘依赖 _eventLogRoundStore 注入
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '第一次', ts: 't0' },
      { role: 'assistant', content: '第一次回答', ts: 't1' },
    ]);
    // 第一次 chat：round-1 工具（search）
    provider.setAgent(
      chatAgentStub(() =>
        (async function* () {
          yield { type: 'tool_start', toolCallId: 't1', name: 'search', args: '{}', roundId: 'round-1' };
          yield { type: 'tool_result', toolCallId: 't1', name: 'search', ok: true, summary: 'a', roundId: 'round-1' };
          yield { type: 'text', content: '第一次回答', roundId: 'round-1' };
          yield { type: 'done' };
        })(),
      ),
    );
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('第一次');
    // 第二次 chat 前追加 round-2
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '第二次', ts: 't2' },
      { role: 'assistant', content: '第二次回答', ts: 't3' },
    ]);
    // 第二次 chat：round-2 工具（read_file）
    provider.setAgent(
      chatAgentStub(() =>
        (async function* () {
          yield { type: 'thinking', phase: 'processing', roundId: 'round-2' };
          yield { type: 'tool_start', toolCallId: 't2', name: 'read_file', args: '{}', roundId: 'round-2' };
          yield { type: 'tool_result', toolCallId: 't2', name: 'read_file', ok: true, summary: 'b', roundId: 'round-2' };
          yield { type: 'text', content: '第二次回答', roundId: 'round-2' };
          yield { type: 'done' };
        })(),
      ),
    );
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('第二次');

    // 第一次的 round-1 保留自己的工具记录（不被第二次覆盖）；metrics 归入自己的turn（单turn收尾）
    const r1 = roundStore.getById('round-1')!;
    const r2 = roundStore.getById('round-2')!;
    expect(r1.processEvents?.map((e) => e.type)).toEqual(['meta', 'tool_start', 'tool_result', 'metrics']);
    expect(r1.processEvents?.some((e) => e.type === 'tool_start' && e.payload.toolCallId === 't1')).toBe(true);
    // 第二次独立落盘到 round-2（含 thinking/tool/metrics），不覆盖 round-1 的工具记录
    expect(r2.processEvents?.map((e) => e.type)).toEqual(['meta', 'thinking', 'tool_start', 'tool_result', 'metrics']);
    expect(r2.processEvents?.some((e) => e.type === 'tool_start' && e.payload.toolCallId === 't2')).toBe(true);
  });
});

describe('chatPanel · 崩溃残留轮打捞升级为正常 stop turn（T1，2026-09-09）', () => {
  /** 种子「崩溃残局」轮：pending + refCount=0 + 宿主已落盘的 processEvents */
  function seedInterruptedRound(
    roundStore: WorkspaceRoundStore,
    id: string,
    createdAt: string,
    processEvents: ProcessEvent[],
  ): void {
    roundStore.save({
      id,
      userMessage: { id: `msg-${id}-user`, role: 'user', content: '帮我梳理架构', timestamp: createdAt },
      status: 'pending',
      createdAt,
      refCount: 0,
      processEvents,
    } as Round);
  }

  /** 构造打捞升级环境：真实 Workspace 存储 + 注入带 agentHistory 的 Agent 桩 */
  function setupSalvage(options?: { seedSession?: boolean }): {
    store: WorkspaceSessionStore;
    roundStore: WorkspaceRoundStore;
    provider: MemoraChatViewProvider;
    appendInterrupted: ReturnType<typeof vi.fn>;
    sessionId: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'memora-salvage-'));
    const roundStore = new WorkspaceRoundStore(dir);
    roundStore.load();
    const store = new WorkspaceSessionStore(dir, roundStore);
    store.load();
    const sessionId = `${todayDate()}-restored`;
    // 制造「最近活跃会话」（崩溃前正使用的会话）：meta 的 updatedAt 为最新 → listSessionMetas[0]
    if (options?.seedSession !== false) {
      store.updateSessionMeta(sessionId, { autoName: '崩溃恢复测试会话', displayName: '崩溃恢复测试会话' });
    }

    const providerStore = { listMasked: async () => [], getActiveName: () => undefined } as never;
    const provider = new MemoraChatViewProvider({ fsPath: '/mock/uri' } as never, store, providerStore);
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    const webviewView = {
      webview: {
        asWebviewUri: () => ({ toString: () => 'mock://script' }),
        options: {},
        html: '',
        postMessage: () => Promise.resolve(true),
      },
      onDidDispose: () => ({ dispose: () => {} }),
      onDidReceiveMessage: () => ({ dispose: () => {} }),
    } as never;
    (provider as unknown as { _view: unknown })._view = webviewView;

    // 注入带 agentHistory 的 Agent 桩（升级登记走内核 appendInterrupted，宿主只负责打捞与派生文本）
    const appendInterrupted = vi.fn().mockResolvedValue(undefined);
    const agent = {
      agentHistory: { appendInterrupted },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Agent;
    (provider as unknown as { _agent: Agent })._agent = agent;

    return { store, roundStore, provider, appendInterrupted, sessionId };
  }

  /** 反射调私有打捞方法 */
  function upgrade(provider: MemoraChatViewProvider): Promise<void> {
    return (provider as unknown as { upgradeInterruptedRounds(): Promise<void> }).upgradeInterruptedRounds();
  }

  it('打捞当前会话日期内中断轮 → 按 createdAt 升序升级：narrate 文本拼接传给内核收场', async () => {
    const { roundStore, provider, appendInterrupted } = setupSalvage();
    const tBase = `${todayDate()}T10:00:00.000Z`;
    // 两个中断轮（不同 createdAt，processEvents 含多段 narrate）
    seedInterruptedRound(roundStore, 'round-a', `${todayDate()}T11:00:00.000Z`, [
      { type: 'narrate', seq: 1, ts: tBase, payload: { content: '第一段' } },
      { type: 'narrate', seq: 2, ts: tBase, payload: { content: '第二段' } },
    ]);
    seedInterruptedRound(roundStore, 'round-b', `${todayDate()}T12:00:00.000Z`, [
      { type: 'narrate', seq: 1, ts: tBase, payload: { content: 'B段' } },
    ]);

    await upgrade(provider);

    // createdAt 升序登记（round-a 先于 round-b），content = narrate 按 seq 拼接
    expect(appendInterrupted).toHaveBeenCalledTimes(2);
    expect(appendInterrupted.mock.calls[0]?.[0]).toBe('round-a');
    expect(appendInterrupted.mock.calls[0]?.[1]).toEqual({ content: '第一段第二段' });
    expect(appendInterrupted.mock.calls[1]?.[0]).toBe('round-b');
    expect(appendInterrupted.mock.calls[1]?.[1]).toEqual({ content: 'B段' });
  });

  it('工具阶段崩溃（无 narrate）→ content 传空串，交由内核按 stop 语义收场（§一·五）', async () => {
    const { roundStore, provider, appendInterrupted } = setupSalvage();
    seedInterruptedRound(roundStore, 'round-tool', `${todayDate()}T11:00:00.000Z`, [
      {
        type: 'tool_start',
        seq: 1,
        ts: `${todayDate()}T11:00:01.000Z`,
        payload: { toolCallId: 't1', name: 'web_search' },
      },
    ]);

    await upgrade(provider);

    expect(appendInterrupted).toHaveBeenCalledTimes(1);
    expect(appendInterrupted.mock.calls[0]?.[1]).toEqual({ content: '' });
  });

  it('once-guard：第二次调用不再重复升级（T3 不双重复放底座）', async () => {
    const { roundStore, provider, appendInterrupted } = setupSalvage();
    seedInterruptedRound(roundStore, 'round-a', `${todayDate()}T11:00:00.000Z`, [
      { type: 'narrate', seq: 1, ts: `${todayDate()}T10:00:00.000Z`, payload: { content: 'A' } },
    ]);

    await upgrade(provider);
    await upgrade(provider); // 重复触发（双 ready / 折叠重建）

    expect(appendInterrupted).toHaveBeenCalledTimes(1);
    expect((provider as unknown as { _salvageUpgraded: boolean })._salvageUpgraded).toBe(true);
  });

  it('无中断轮 → 不调内核收场，但 guard 置位（之后不再空扫）', async () => {
    const { provider, appendInterrupted } = setupSalvage();
    await upgrade(provider);
    expect(appendInterrupted).not.toHaveBeenCalled();
    expect((provider as unknown as { _salvageUpgraded: boolean })._salvageUpgraded).toBe(true);
  });

  it('无当前会话 → 跳过且不置 guard（Agent/会话就绪后等待下次触发再试）', async () => {
    const { provider, appendInterrupted } = setupSalvage({ seedSession: false });
    await upgrade(provider);
    expect(appendInterrupted).not.toHaveBeenCalled();
    expect((provider as unknown as { _salvageUpgraded: boolean })._salvageUpgraded).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// 技能启停 · 用户通道「响亮失败」（SKILL-S2，2026-09-22）
// ═══════════════════════════════════════════════════════════
// 缺陷：composer 选中已禁用技能后发送 → `skillPromptFor` 按既有契约返回空串
// （= 技能不存在，**不影响正常发送**），于是消息照常发出、技能未注入、界面零提示。
// 契约不改（返回空串是对的），补的是调用方的**响亮失败**。三种落空必须分流：
//   ① 已禁用  → 报（用户配置所致，可自行修复）
//   ② 不存在  → 不报（属另一类缺陷，未在本次范围，勿混报）
//   ③ 未带名  → 不报（普通发送）
describe('技能启停：按名指定已禁用技能 → 响亮失败（SKILL-S2）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** agent 桩：技能两源（全局池 + 空角色包）+ chat 空流（只走 sendInput 前置链路） */
  function skillAgentStub(disabledSkills: string[]): Agent {
    const globalSkills = [
      { name: '启用技能', content: '启用正文', description: 'd' },
      { name: '禁用技能', content: '禁用正文', description: 'd' },
    ];
    return {
      chat: async function* () {
        yield { type: 'done' };
      },
      getMetrics: () => ({
        llm: { totalInputTokens: 0, totalOutputTokens: 0 },
        tools: { callCount: 0, failureCount: 0, unparsedToolIntentCount: 0 },
      }),
      sessionManager: {
        getCurrentSessionInfo: () => ({ date: '2026-08-15', session: 's1' }),
        switchToSession: async () => 0,
      },
      on: vi.fn(),
      off: vi.fn(),
      memory: { softDeleteRoundSummaries: vi.fn() },
      getCheckpoint: () => null,
      skills: {
        list: globalSkills,
        // 与真实 SkillManager.get 同构：禁用名短路 null（桩若漏此判据，「注入落空」前提即假绿）
        get: (n: string) =>
          disabledSkills.includes(n) ? null : (globalSkills.find((s) => s.name === n) ?? null),
        buildSystemPrompt: (n: string) => `【当前技能】${n}`,
        disabledSkillNames: disabledSkills,
      },
      // setAgent → refreshAfterAssemble 会读 listMeta（推角色包清单）；listSkills/readSkillContent
      // 供 listVisibleSkills / resolveSkill 走通。三者缺一即桩不全（与本用例断言无关的前置链路）。
      rolePackManager: {
        listMeta: () => [],
        listSkills: () => [],
        readSkillContent: async () => null,
        getActive: () => null,
      },
    } as unknown as Agent;
  }

  /** 驱动一次带技能名的发送，返回 provider post 出的全部消息 */
  async function sendWithSkill(skillName: string): Promise<unknown[]> {
    const { store, roundStore, provider, posted } = setup();
    provider.setRoundStore(roundStore);
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '你好', ts: 't0' },
      { role: 'assistant', content: '回复', ts: 't1' },
    ]);
    provider.setAgent(skillAgentStub(['禁用技能']));
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    await (provider as unknown as { sendInput(p: string, s?: string): Promise<void> }).sendInput(
      '你好',
      skillName,
    );
    return posted;
  }

  it('禁用技能：发 error notice 指名技能与「未注入」，且消息仍照常发送（不拒绝）', async () => {
    const posted = await sendWithSkill('禁用技能');
    const notices = posted.filter((m) => (m as { type: string }).type === 'notice') as {
      level: string;
      message: string;
    }[];
    expect(notices).toHaveLength(1);
    expect(notices[0]!.level).toBe('error');
    expect(notices[0]!.message).toContain('禁用技能');
    expect(notices[0]!.message).toContain('未注入');
    // 不拒绝（变异锁）：修「静默」不得改成「禁止发送」——用户消息仍上屏
    expect(posted.some((m) => (m as { type: string }).type === 'user')).toBe(true);
  });

  it('启用技能：无 notice（反向守卫，防「无条件报错」）', async () => {
    const posted = await sendWithSkill('启用技能');
    expect(posted.filter((m) => (m as { type: string }).type === 'notice')).toHaveLength(0);
  });

  it('技能不存在：无 notice（「不存在」≠「已禁用」，两类落空语义分流）', async () => {
    const posted = await sendWithSkill('根本没有的技能');
    expect(posted.filter((m) => (m as { type: string }).type === 'notice')).toHaveLength(0);
  });

  it('未带技能名：无 notice（普通发送不受影响）', async () => {
    const posted = await sendWithSkill('');
    expect(posted.filter((m) => (m as { type: string }).type === 'notice')).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SKILL-S3b（2026-09-22）：配置变更 / 手动重载后重推技能清单
//
// 背景：`memora.disabledSkills` 变更此前**不刷新**对话区下拉 ⇒ 改完设置界面零变化
//（「配置形态启停」承诺改完即生效，实际停在旧快照）。修复 = extension 侧监听配置变更
//（及手动重载命令）后调本入口重推。
//
// 本组锁住的是**入口语义**：重推必须读内核**实时**快照（非装配期缓存），且未就绪时不抛。
// ⚠️ 「监听是否注册」发生在 extension.ts（零测试覆盖区，无 vscode mock 基建），
// 本组覆盖不到 —— 该段由 tsc/eslint + 编译产物实读兜底，勿把本组当作闭环证明。
describe('技能启停：重推清单入口（SKILL-S3b）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * agent 桩：禁用集**可变**——模拟内核 `disabledNames` 被 extension 监听重设后的状态。
   * `disabledSkillNames` 必须用 getter 实时读：若桩快照成常量数组，本组第一条用例
   * 会因「读不到变化」而变成测不到的假绿。
   */
  function mutableSkillStub(state: { disabled: string[] }): Agent {
    const globalSkills = [
      { name: '启用技能', content: 'a', description: 'd' },
      { name: '禁用技能', content: 'b', description: 'd' },
    ];
    return {
      skills: {
        list: globalSkills,
        get: (n: string) => globalSkills.find((s) => s.name === n) ?? null,
        buildSystemPrompt: (n: string) => `【当前技能】${n}`,
        get disabledSkillNames(): string[] {
          return state.disabled;
        },
      },
      rolePackManager: {
        listMeta: () => [],
        listSkills: () => [],
        readSkillContent: async () => null,
        getActive: () => null,
      },
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as Agent;
  }

  /** 取最后一次 skills_loaded 携带的技能项（重推即取最新一条） */
  function lastSkills(posted: unknown[]): { name: string; disabled?: boolean }[] {
    const lists = ofType<{ type: string; skills: { name: string; disabled?: boolean }[] }>(
      posted,
      'skills_loaded',
    );
    return lists.at(-1)?.skills ?? [];
  }

  it('重推读到内核**最新**禁用集（非装配期缓存）', () => {
    const { provider, posted } = setup();
    provider.setSkillDirs('/mock/conf', '/mock/user');
    const state = { disabled: [] as string[] };
    provider.setAgent(mutableSkillStub(state));

    // 基线显式走一次重推（不依赖 setAgent 内部补推时序）：此刻未禁用
    provider.refreshSkillList();
    expect(lastSkills(posted).find((s) => s.name === '禁用技能')?.disabled).toBeUndefined();

    // 模拟 extension 监听把新禁用集喂给内核（真源变更），随后重推
    state.disabled = ['禁用技能'];
    provider.refreshSkillList();

    expect(lastSkills(posted).find((s) => s.name === '禁用技能')?.disabled).toBe(true);
    // 同名未禁用技能不得被连坐（防「整表打标」式实现）
    expect(lastSkills(posted).find((s) => s.name === '启用技能')?.disabled).toBeUndefined();
  });

  it('未装配 agent：不推送且不抛（反向守卫）', () => {
    const { provider, posted } = setup();
    provider.setSkillDirs('/mock/conf', '/mock/user');
    expect(() => provider.refreshSkillList()).not.toThrow();
    expect(ofType(posted, 'skills_loaded')).toHaveLength(0);
  });

  it('面板未打开（_view 为空）：静默不抛', () => {
    const { provider, posted } = setup();
    provider.setSkillDirs('/mock/conf', '/mock/user');
    provider.setAgent(mutableSkillStub({ disabled: [] }));
    const before = ofType(posted, 'skills_loaded').length;
    (provider as unknown as { _view: unknown })._view = undefined;
    expect(() => provider.refreshSkillList()).not.toThrow();
    expect(ofType(posted, 'skills_loaded')).toHaveLength(before);
  });
});

// ═══════════════════════════════════════════════════════════
// turn 投影含运行时 live 轮（M3b-2a，2026-09-23）
// ═══════════════════════════════════════════════════════════
// M3b-1 只并行发送 turn_update，且 rounds 恒取落盘历史 —— 运行时当前轮**不入列**（当时刻意为之：
// 宿主尚无「当前轮运行时对象」）。本期补上：live 轮由 consumeFlow 流内局部数据投影
// （正文按 roundId 分桶累积 + 过程事件分桶 + seed 的开轮输入），经 mergeLiveRound 并入。
//
// **变异验证锚点**：
//  - 把 `postTurnUpdate(liveTurn)` 的实参去掉 → 「live 轮入列」转红（rounds 无 live:true 轮）
//  - 去掉 textByRound 累积 → 「正文投影为 assistantMessage」转红
//  - mergeLiveRound 改成追加式合并 → 「同一 id 只出现一次」转红
describe('turn_update 含运行时 live 轮（M3b-2a）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 驱动一轮 chat 流，返回**流尾**那条 turn_update（投影终态） */
  async function driveAndGetLastUpdate(
    chunks: AgentChunk[],
    seedMsgs: { role: string; content: string; ts: string }[],
  ): Promise<{ rounds: RoundView[]; state: TurnState }> {
    const { store, roundStore, provider, posted } = setup();
    provider.setRoundStore(roundStore);
    // 投影的 rounds 走 loadRoundBasedHistory（依赖 _viewLoader）：不装配则恒为空数组，
    // 断言会「假通过」——历史轮压根没进过列表，测不出「并入」还是「替换」。
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    seedSession(store, roundStore, '2026-08-15-s1', seedMsgs);
    provider.setAgent(
      chatAgentStub(() =>
        (async function* () {
          for (const c of chunks) yield c;
        })(),
      ),
    );
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    await (provider as unknown as { sendInput(p: string): Promise<void> }).sendInput('新问题');
    const updates = ofType<{ type: string; rounds: RoundView[]; state: TurnState }>(posted, 'turn_update');
    // 起始（无 live）+ 流尾（带 live）各一次
    expect(updates.length).toBeGreaterThanOrEqual(2);
    return updates[updates.length - 1]!;
  }

  const historyPair = [
    { role: 'user', content: '历史问题', ts: 't0' },
    { role: 'assistant', content: '历史回答', ts: 't1' },
  ];

  it('流尾：运行时当前轮并入 rounds（live:true），id 与 chunk.roundId 同源', async () => {
    const last = await driveAndGetLastUpdate(
      [
        { type: 'thinking', phase: 'processing', roundId: 'round-9' },
        { type: 'text', content: '正在回答', roundId: 'round-9' },
        { type: 'done' },
      ],
      historyPair,
    );
    const live = last.rounds[last.rounds.length - 1]!;
    expect(live.id).toBe('round-9');
    expect(live.live).toBe(true);
    // live 是「并入」而非「替换整个列表」：历史轮仍在列
    expect(last.rounds.map((r) => r.id)).toContain('round-1');
  });

  it('流式正文投影为末段 assistantMessage（运行时与重放同形状）', async () => {
    const last = await driveAndGetLastUpdate(
      [
        { type: 'text', content: '第一段', roundId: 'round-9' },
        { type: 'text', content: '第二段', roundId: 'round-9' },
        { type: 'done' },
      ],
      historyPair,
    );
    const live = last.rounds[last.rounds.length - 1]!;
    expect(live.assistantMessage?.content).toBe('第一段第二段');
    expect(live.assistantMessage?.role).toBe('assistant');
  });

  it('同一 id 在 rounds 中只出现一次（live 原位替换历史，不产生重复条目）', async () => {
    const last = await driveAndGetLastUpdate(
      [
        { type: 'text', content: '回答', roundId: 'round-9' },
        { type: 'done' },
      ],
      historyPair,
    );
    const ids = last.rounds.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('过程事件随 live 轮入列（与 eventsByRound 同源，供 UI 重建过程轨）', async () => {
    const last = await driveAndGetLastUpdate(
      [{ type: 'tool_start', toolCallId: 't1', name: 'read_file', args: '{}', roundId: 'round-9' }, { type: 'done' }],
      historyPair,
    );
    const live = last.rounds[last.rounds.length - 1]!;
    expect(live.processEvents?.some((e) => e.type === 'tool_start')).toBe(true);
  });

  it('软暂停：live 轮仍入列（该轮正在生长、未收场）', async () => {
    const last = await driveAndGetLastUpdate(
      [
        { type: 'text', content: '半截', roundId: 'round-9' },
        { type: 'paused' },
      ],
      historyPair,
    );
    const live = last.rounds[last.rounds.length - 1]!;
    expect(live.live).toBe(true);
    expect(live.status).toBe('pending');
  });
});
