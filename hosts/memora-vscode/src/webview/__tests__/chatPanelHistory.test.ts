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
import type { Agent, AgentChunk, Round } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { WorkspaceSessionViewLoader } from '../../extension/host/sessionViewLoader.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

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

  // ─── v1.5 交织重放（processEvents 与正文同源同轮） ───
  it('round-based 交织重放：user → replay_events（含 meta，整批）→ assistant（v1.6 时序）', () => {
    const { store, roundStore, provider, posted } = setup();
    // 生产装配路径：extension 注入同一 viewLoader + roundStore 单例
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';

    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '问题A', ts: 't1' },
      { role: 'assistant', content: '回答A', ts: 't2' },
    ]);
    // 为第一轮补过程事件（meta 首条 + recall + metrics 末条）
    const round = roundStore.getById('round-1')!;
    round.processEvents = [
      { type: 'meta', seq: 1, ts: 't1', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
      { type: 'recall', seq: 2, ts: 't1', payload: { memories: [{ id: 'r:1', name: '记忆', source: 'round-summary', score: 0.8 }] } },
      { type: 'metrics', seq: 3, ts: 't2', payload: { durationMs: 3000, tokenIn: 10, tokenOut: 20, toolFailureCount: 0, recallCount: 1, success: true } },
    ];
    roundStore.save(round);

    (provider as unknown as { replayCurrentSession(): void }).replayCurrentSession();

    // 关键时序（v1.6）：session_title 收尾；user → replay_events（meta 并入整批，不单独发 process_event，
    // 避免 webview 端把 meta 当「运行时新轮」建骨架块导致同一轮出现两条独立消息）→ assistant 正文
    const ordered = posted.map((m) => (m as { type: string }).type);
    const idxReplay = ordered.indexOf('replay_events');
    const idxAssistant = ordered.indexOf('assistant');
    // meta 不再单独走 process_event 通道（进程事件整批归一，SSOT）
    expect(ordered).not.toContain('process_event');
    expect(ordered.indexOf('user')).toBeGreaterThanOrEqual(0);
    expect(idxReplay).toBeGreaterThan(ordered.indexOf('user')); // 整批事件在 user 之后
    expect(idxAssistant).toBeGreaterThan(idxReplay); // 正文在事件之后（块可挂载）
    expect(idxAssistant).toBeLessThan(ordered.indexOf('session_title'));
    // replay_events：roundId 关联正确，且 meta 为整批首条（webview 端自行提取身份，不再单独发）
    const replay = posted[idxReplay] as { roundId: string; events: { type: string }[] };
    expect(replay.roundId).toBe('round-1');
    expect(replay.events.map((e) => e.type)).toEqual(['meta', 'recall', 'metrics']);
    expect((replay.events[0] as unknown as { payload: { role: string; llm: string } }).payload).toEqual({
      role: '文档设计师',
      llm: 'deepseek-chat',
    });
  });

  it('interactiveInputs 重放按时间序归位（UX-9）：qa/supplement 按 ts 交织于前序段后、final 前，且均携带 roundId', () => {
    const { store, roundStore, provider, posted } = setup();
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '任务A', ts: 't1' },
      { role: 'assistant', content: '最终回答', ts: 't5' },
    ]);
    // TS-9 闭环节点数据：前序 assistant 段（含 [ASK] 提问）+ 交互输入（qa 与 supplement 混合）
    const round = roundStore.getById('round-1')!;
    round.assistantLog = [
      { id: 'a0', role: 'assistant', content: '[ASK] 选择哪个方案？', timestamp: 't2' } as NonNullable<Round['assistantMessage']>,
    ];
    round.interactiveInputs = [
      { id: 'i1', role: 'user', content: '选方案A', timestamp: 't3', kind: 'question-answer' } as never,
      { id: 'i2', role: 'user', content: '补充：不要联网搜索', timestamp: 't4', kind: 'supplement' } as never,
    ];
    roundStore.save(round);

    (provider as unknown as { replayCurrentSession(): void }).replayCurrentSession();

    const ordered = posted.map((m) => m as { type: string; kind?: string; text?: string; roundId?: string });
    const idxUser = ordered.findIndex((m) => m.type === 'user' && !m.kind);
    const idxAsk = ordered.findIndex((m) => m.type === 'assistant' && m.text === '[ASK] 选择哪个方案？');
    const idxQa = ordered.findIndex((m) => m.type === 'user' && m.kind === 'question-answer');
    const idxSupp = ordered.findIndex((m) => m.type === 'user' && m.kind === 'supplement');
    const idxMain = ordered.findIndex((m) => m.type === 'assistant' && m.text === '最终回答');
    // UX-9 时序还原：主输入 → [ASK] 段 → 用户回答 → 打断补充（打断点）→ 最终回答（续接）
    expect(idxAsk).toBeGreaterThan(idxUser);
    expect(idxQa).toBeGreaterThan(idxAsk);
    expect(idxSupp).toBeGreaterThan(idxQa);
    expect(idxMain).toBeGreaterThan(idxSupp);
    // 共同底座：所有 user/assistant 消息均携带 roundId（webview 依此判同环续接/挂靠）
    const roundTagged = ordered.filter((m) => ['user', 'assistant'].includes(m.type));
    expect(roundTagged.length).toBeGreaterThan(0);
    for (const m of roundTagged) {
      expect(m.roundId).toBe('round-1');
    }
  });

  it('round-based 纯问答轮（无 processEvents）退化为仅正文，不发 process_event/replay_events', () => {
    const { store, roundStore, provider, posted } = setup();
    provider.setViewLoader(new WorkspaceSessionViewLoader(roundStore, store));
    provider.setRoundStore(roundStore);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '问题A', ts: 't1' },
      { role: 'assistant', content: '回答A', ts: 't2' },
    ]);

    (provider as unknown as { replayCurrentSession(): void }).replayCurrentSession();

    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).not.toContain('process_event');
    expect(types).not.toContain('replay_events');
    expect(types).toContain('user');
    expect(types).toContain('assistant');
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

  // ─── 断点续跑提示判定（G3，2026-08-26 SSOT 收紧：running 进行中任务也可恢复 plan+hotMemory） ───
  function setupCheckpointOffer(checkpoint: unknown): { provider: MemoraChatViewProvider; posted: unknown[] } {
    const agent = agentStub().agent as unknown as { sessionManager: { loadPersistedCheckpoint: () => unknown } };
    // 注入持久化检查点桩：loadPersistedCheckpoint 返回夹具
    (agent.sessionManager as { loadPersistedCheckpoint: ReturnType<typeof vi.fn> }).loadPersistedCheckpoint =
      vi.fn(() => checkpoint);
    const { provider, posted } = setup();
    provider.setAgent(agent as never);
    return { provider, posted };
  }

  it('断点提示·paused 检查点仍可恢复（回归：不破坏原暂停续跑）', () => {
    const { provider, posted } = setupCheckpointOffer({ status: 'paused' });
    (provider as unknown as { maybeOfferCheckpointRestore(): void }).maybeOfferCheckpointRestore();
    expect(ofType(posted, 'checkpoint_available').length).toBe(1);
  });

  it('断点提示·running 且有未完成计划步骤 → 提示恢复 plan+hotMemory（本轮新增）', () => {
    const { provider, posted } = setupCheckpointOffer({
      status: 'running',
      plan: [{ id: 's1', status: 'pending' }, { id: 's2', status: 'active' }],
    });
    (provider as unknown as { maybeOfferCheckpointRestore(): void }).maybeOfferCheckpointRestore();
    expect(ofType(posted, 'checkpoint_available').length).toBe(1);
  });

  it('断点提示·running 且纯单轮问答（空计划）→ 不提示，避免误弹', () => {
    const { provider, posted } = setupCheckpointOffer({ status: 'running', plan: [] });
    (provider as unknown as { maybeOfferCheckpointRestore(): void }).maybeOfferCheckpointRestore();
    expect(ofType(posted, 'checkpoint_available').length).toBe(0);
  });

  // ─── 历史会话占用重算（轻量版方案，2026-08-31）：切会话后圆环展示真实占用而非空态 0% ───
  it('replayCurrentSession 推送历史会话占用：对话层重算 + 角色包当前值 + 记忆层置 0', async () => {
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
      const occs = ofType<{ type: string; occupancy: { dialogueCount: number; rolePackBaseTokens: number; memoryCount: number } }>(
        posted,
        'context_occupancy',
      );
      // setAgent 装配兜底推 1 次 + replayCurrentSession 推 1 次（幂等，取最后一次验证）
      expect(occs.length).toBeGreaterThanOrEqual(1);
      const occ = occs[occs.length - 1]!.occupancy;
      // 对话层 = 1 个问答闭环（1 条 user，assistant 不计入条数，2026-09-01 定案）
      // 角色包 = 当前装配值；记忆层历史会话置 0
      expect(occ.dialogueCount).toBe(1);
      expect(occ.rolePackBaseTokens).toBe(15000);
      expect(occ.memoryCount).toBe(0);
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

  // ─── Phase 4 软暂停入口：生成中暂停走迭口边界挂起 requestPause（与内核迭口软暂停语义一致） ───
  function pauseAgentStub(): {
    agent: Agent;
    requestPause: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
  } {
    const requestPause = vi.fn(() => true);
    const pause = vi.fn(() => true);
    const agent = { requestPause, pause, on: vi.fn(), off: vi.fn() } as unknown as Agent;
    return { agent, requestPause, pause };
  }

  it('handlePause：生成中软暂停走 requestPause（迭口边界挂起），不用立即翻态的 pause', () => {
    const { provider, posted } = setup();
    const { agent, requestPause, pause } = pauseAgentStub();
    provider.setAgent(agent);
    // 生成中（流进行中）暂停按钮才可见 → _streaming=true
    (provider as unknown as { _streaming: boolean })._streaming = true;
    (provider as unknown as { handlePause(): void }).handlePause();
    // 应调迭口边界软暂停入口 requestPause，而非立即翻态的 pause
    expect(requestPause).toHaveBeenCalledWith('user-pause', 'user');
    expect(pause).not.toHaveBeenCalled();
    // 无失败提示
    expect(ofType(posted, 'notice')).toHaveLength(0);
  });

  it('handlePause：requestPause 失败（幂等/异常态）→ 提示暂停失败', () => {
    const { provider, posted } = setup();
    const { agent, requestPause } = pauseAgentStub();
    requestPause.mockReturnValue(false);
    provider.setAgent(agent);
    (provider as unknown as { _streaming: boolean })._streaming = true;
    (provider as unknown as { handlePause(): void }).handlePause();
    const notice = ofType<{ type: string; message: string }>(posted, 'notice');
    expect(notice.some((n) => n.message.includes('暂停失败'))).toBe(true);
  });

  it('handlePause：空闲态（非生成中）→ 提示无可暂停', () => {
    const { provider, posted } = setup();
    const { agent, requestPause } = pauseAgentStub();
    provider.setAgent(agent);
    (provider as unknown as { _streaming: boolean })._streaming = false;
    (provider as unknown as { handlePause(): void }).handlePause();
    expect(requestPause).not.toHaveBeenCalled();
    const notice = ofType<{ type: string; message: string }>(posted, 'notice');
    expect(notice.some((n) => n.message.includes('没有可暂停'))).toBe(true);
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
// consumeFlow 过程事件按执行闭环 roundId 分组落盘（2026-09-02）
// ═══════════════════════════════════════════════════════════
// 修复：宿主原「流末一次落盘到 roundIds 末尾一个 round」在多执行闭环（Loop 编排）下归属错误——
// 全部工具堆一个 round（拥挤）+ 部分 round 无 processEvents（丢失）。现按内核 chunk.roundId
// 分组，每个执行闭环独立落盘到各自 Round（SSOT：归属由内核唯一提供，非 roundIds 末尾推断）。
describe('consumeFlow 过程事件按执行闭环 roundId 分组落盘（2026-09-02）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 构造带 chat()/getMetrics/sessionManager 的 mock agent（consumeFlow 落盘链路用） */
  function chatAgentStub(chatFn: () => AsyncGenerator<AgentChunk, void, unknown>): Agent {
    return {
      chat: chatFn,
      getMetrics: () => ({ llm: { totalInputTokens: 0, totalOutputTokens: 0 } }),
      sessionManager: {
        getCurrentSessionInfo: () => ({ date: '2026-08-15', session: 's1' }),
        switchToSession: async () => 0,
      },
      on: vi.fn(),
      off: vi.fn(),
      memory: { softDeleteRoundSummaries: vi.fn() },
      getCheckpoint: () => null,
    } as unknown as Agent;
  }

  it('一次 chat() 多执行闭环（Loop 编排）：各执行闭环 processEvents 独立落盘，不堆叠不覆盖', async () => {
    const { store, roundStore, provider } = setup();
    provider.setRoundStore(roundStore); // 落盘依赖 _eventLogRoundStore 注入
    // 预造两个执行闭环的 Round（round-1 / round-2）
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '任务', ts: 't0' },
      { role: 'assistant', content: '执行闭环1回答', ts: 't1' },
    ]);
    seedSession(store, roundStore, '2026-08-15-s1', [
      { role: 'user', content: '继续', ts: 't2' },
      { role: 'assistant', content: '执行闭环2回答', ts: 't3' },
    ]);
    // mock chat：一次流内两个执行闭环（round-1 工具 / round-2 思考+工具），各自独立 roundId
    provider.setAgent(
      chatAgentStub(() =>
        (async function* () {
          yield { type: 'tool_start', toolCallId: 't1', name: 'read_file', args: '{}', roundId: 'round-1' };
          yield { type: 'tool_result', toolCallId: 't1', name: 'read_file', ok: true, summary: 'ok', roundId: 'round-1' };
          yield { type: 'text', content: '执行闭环1回答', roundId: 'round-1' };
          yield { type: 'thinking', phase: 'planning', roundId: 'round-2' };
          yield { type: 'tool_start', toolCallId: 't2', name: 'search', args: '{}', roundId: 'round-2' };
          yield { type: 'tool_result', toolCallId: 't2', name: 'search', ok: true, summary: 's', roundId: 'round-2' };
          yield { type: 'text', content: '执行闭环2回答', roundId: 'round-2' };
          yield { type: 'done' };
        })(),
      ),
    );
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';
    await (provider as unknown as { handleSend(p: string): Promise<void> }).handleSend('任务');

    // 每个执行闭环的 processEvents 独立归属到自己的 Round（meta 段首 + 各自工具；metrics 归入收尾执行闭环）
    const r1 = roundStore.getById('round-1')!;
    const r2 = roundStore.getById('round-2')!;
    expect(r1.processEvents?.map((e) => e.type)).toEqual(['meta', 'tool_start', 'tool_result']);
    expect(r2.processEvents?.map((e) => e.type)).toEqual(['meta', 'thinking', 'tool_start', 'tool_result', 'metrics']);
    // 工具归属精确：t1 只在 round-1，t2 只在 round-2（不堆叠、不串位）
    expect(r1.processEvents?.some((e) => e.type === 'tool_start' && e.payload.toolCallId === 't1')).toBe(true);
    expect(r1.processEvents?.some((e) => e.type === 'tool_start' && e.payload.toolCallId === 't2')).toBe(false);
    expect(r2.processEvents?.some((e) => e.type === 'tool_start' && e.payload.toolCallId === 't2')).toBe(true);
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
    await (provider as unknown as { handleSend(p: string): Promise<void> }).handleSend('第一次');
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
    await (provider as unknown as { handleSend(p: string): Promise<void> }).handleSend('第二次');

    // 第一次的 round-1 保留自己的工具记录（不被第二次覆盖）；metrics 归入自己的执行闭环（单执行闭环收尾）
    const r1 = roundStore.getById('round-1')!;
    const r2 = roundStore.getById('round-2')!;
    expect(r1.processEvents?.map((e) => e.type)).toEqual(['meta', 'tool_start', 'tool_result', 'metrics']);
    expect(r1.processEvents?.some((e) => e.type === 'tool_start' && e.payload.toolCallId === 't1')).toBe(true);
    // 第二次独立落盘到 round-2（含 thinking/tool/metrics），不覆盖 round-1 的工具记录
    expect(r2.processEvents?.map((e) => e.type)).toEqual(['meta', 'thinking', 'tool_start', 'tool_result', 'metrics']);
    expect(r2.processEvents?.some((e) => e.type === 'tool_start' && e.payload.toolCallId === 't2')).toBe(true);
  });
});
