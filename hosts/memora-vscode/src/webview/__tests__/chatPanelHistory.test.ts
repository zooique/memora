/**
 * chatPanel 会话管理集成测试（ADR-024 会话标题层）
 *
 * 用真实 WorkspaceSessionStore（临时目录落盘）+ mock vscode 驱动
 * MemoraChatViewProvider 的会话管理入口（switchSessionFromCommand / newSessionFromCommand /
 * renameCurrentSession / switchToSession），验证：
 *   - QuickPick 列出会话（新建/改名/已有会话）
 *   - 切换会话后重放该会话历史 + 推送 session_title
 *   - 新建会话切入空会话并推送占位标题
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
      // 会话管理的 QuickPick / InputBox：测试内可动态注入选择/输入结果
      showQuickPick: vi.fn(),
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

describe('chatPanel 会话列表导航（ADR-024 手动会话模型）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('QuickPick 列出新建/改名动作项与全部会话（含当前会话标记）', async () => {
    const { store, provider } = setup();
    // 种入两个会话 + 元数据
    seedSession(store, '2026-08-15-s1', [{ role: 'user', content: '今天的问题', ts: '2026-08-15T10:00:00.000Z' }]);
    seedSession(store, '2026-08-14-s2', [{ role: 'user', content: '昨天的问题', ts: '2026-08-14T09:00:00.000Z' }]);
    store.setSessionTitle('2026-08-15-s1', '今天会话');
    // 当前会话指向 s1
    (provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(null as never);
    await provider.switchSessionFromCommand();

    const items = vi.mocked(vscode.window.showQuickPick).mock.calls[0]?.[0] as { label: string; id: string }[];
    // 新建 + 改名 + 两个会话
    expect(items?.length).toBe(4);
    const labels = items.map((i) => i.label);
    expect(labels).toContain('＋ 新建会话');
    expect(labels).toContain('✎ 改当前会话名');
    expect(labels).toContain('今天会话');
    // 当前会话语义约束：会话项携带当前标记
    const currentItem = items.find((i) => i.id === '2026-08-15-s1');
    expect(currentItem?.label).toBe('今天会话');
  });

  it('选择会话 → 调内核 switchToSession + 重放该会话历史 + 推送标题', async () => {
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

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: '会话A',
      id: '2026-08-15-s1',
    } as never);
    await provider.switchSessionFromCommand();

    expect(switchToSession).toHaveBeenCalledWith('2026-08-15-s1');
    // 重放：clear_ok + 该会话消息 + session_title
    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).toContain('clear_ok');
    const userMsgs = ofType<{ type: string; text: string }>(posted, 'user');
    expect(userMsgs.map((m) => m.text)).toContain('问题A');
    const title = ofType<{ type: string; title: string }>(posted, 'session_title');
    expect(title[0]?.title).toBe('会话A');
  });

  it('新建会话 → 生成唯一会话名 + 清空重放 + 推送占位标题', async () => {
    const { provider, posted } = setup();
    const { agent, switchToSession } = agentStub();
    provider.setAgent(agent);

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: '＋ 新建会话',
      id: '__new__',
    } as never);
    await provider.switchSessionFromCommand();

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