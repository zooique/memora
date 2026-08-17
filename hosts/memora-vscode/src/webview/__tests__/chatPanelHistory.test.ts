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
import type { Agent } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
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
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
      getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
    },
  };
});

import * as vscode from 'vscode';

/** agent 桩：仅提供会话管理相关方法（switchToSession / renameSession） */
function agentStub(): { agent: Agent; switchToSession: ReturnType<typeof vi.fn>; renameSession: ReturnType<typeof vi.fn> } {
  const switchToSession = vi.fn().mockResolvedValue(0);
  const renameSession = vi.fn();
  // 最小 agent：仅暴露会话管理子对象 + 事件订阅空实现（bindAgentNoticeEvents 需要），其余方法留空
  const agent = {
    sessionManager: { switchToSession, renameSession },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Agent;
  return { agent, switchToSession, renameSession };
}

/** 构造一个 sessionStore + provider 的最小桩，返回可驱动的 provider 实例 */
function setup(): {
  store: WorkspaceSessionStore;
  provider: MemoraChatViewProvider;
  posted: unknown[];
  resolveWebview: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'memora-chatpanel-'));
  const store = new WorkspaceSessionStore(dir);
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
    provider,
    posted,
    resolveWebview: () => {},
  };
}

/** 内存中直接写入会话消息（模拟内核 appendUser/appendAssistant 落盘结构） */
function seedSession(store: WorkspaceSessionStore, sessionId: string, msgs: { role: string; content: string; ts: string }[]): void {
  const idx = sessionId.lastIndexOf('-');
  const date = sessionId.slice(0, idx);
  const session = sessionId.slice(idx + 1);
  for (const m of msgs) store.appendMessage(date, session, m as never);
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
    const { store, provider, posted } = setup();
    seedSession(store, '2026-08-15-s1', [{ role: 'user', content: 'x', ts: 't1' }]);
    seedSession(store, '2026-08-14-s2', [{ role: 'user', content: 'y', ts: 't2' }]);
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

  it('handleDeleteSession：确认后删除会话记录（消息 + meta）+ 重推列表', async () => {
    const { store, provider, posted } = setup();
    seedSession(store, '2026-08-14-s2', [{ role: 'user', content: 'y', ts: 't2' }]);
    store.setSessionTitle('2026-08-14-s2', '昨天会话');
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('删除' as never);
    await (provider as unknown as { handleDeleteSession(s: string): Promise<void> }).handleDeleteSession(
      '2026-08-14-s2',
    );
    // 会话记录已删除：meta + 消息均消失
    expect(store.getSessionMeta('2026-08-14-s2')).toBeUndefined();
    expect(store.listSessions()).not.toContain('2026-08-14-s2');
    // 删除后重推列表（此时空）
    const data = ofType<{ type: string; sessions: unknown[] }>(posted, 'session_list_data');
    expect(data[0]?.sessions).toEqual([]);
  });

  it('handleDeleteSession：确认取消则不删除', async () => {
    const { store, provider } = setup();
    seedSession(store, '2026-08-14-s2', [{ role: 'user', content: 'y', ts: 't2' }]);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValue(undefined as never);
    await (provider as unknown as { handleDeleteSession(s: string): Promise<void> }).handleDeleteSession(
      '2026-08-14-s2',
    );
    expect(store.getSessionMeta('2026-08-14-s2')).toBeDefined();
  });

  it('handleDeleteSession：目标为当前会话时拒绝（防御保护，防未来 UI 变动误删）', async () => {
    const { store, provider, posted } = setup();
    seedSession(store, '2026-08-15-s1', [{ role: 'user', content: 'x', ts: 't1' }]);
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
    const { store, provider, posted } = setup();
    const { agent, switchToSession } = agentStub();
    provider.setAgent(agent);
    seedSession(store, '2026-08-15-s1', [
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
    const { store, provider, posted } = setup();
    const { agent, renameSession } = agentStub();
    provider.setAgent(agent);
    seedSession(store, '2026-08-14-other', [{ role: 'user', content: 'x', ts: '2026-08-14T09:00:00.000Z' }]);
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-14-other';

    vi.mocked(vscode.window.showInputBox).mockResolvedValue('我的新标题');
    await provider.renameCurrentSession();

    expect(renameSession).toHaveBeenCalledWith('2026-08-14-other', '我的新标题');
    const title = ofType<{ type: string; title: string }>(posted, 'session_title');
    expect(title[0]?.title).toBe('我的新标题');
  });
});
