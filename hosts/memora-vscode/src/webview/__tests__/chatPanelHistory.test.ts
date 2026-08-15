/**
 * chatPanel 历史切换集成测试 — 锁定「点击历史能看到日期但无法加载查看」根因
 *
 * 用真实 WorkspaceSessionStore（临时目录落盘）+ mock vscode 驱动
 * MemoraChatViewProvider.switchHistoryFromCommand → handleSwitchDate → loadHistory，
 * 验证：QuickPick 列出的日期必须能被 loadHistory 精确匹配，且重放消息正确 post 到 webview。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
      // 历史命令的 QuickPick：测试内可动态注入选择结果
      showQuickPick: vi.fn(),
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

// 内存中直接写入历史会话（模拟内核 appendUser/appendAssistant 落盘结构）
function seedHistory(store: WorkspaceSessionStore, date: string, msgs: { role: string; content: string; ts: string }[]): void {
  for (const m of msgs) store.appendMessage(date, 'main', m as never);
}

describe('chatPanel 历史切换（点击历史 → 加载查看）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('QuickPick 列出历史日期后，选择某天能加载该天消息', async () => {
    const { store, provider, posted } = setup();
    // 种入 2026-08-14 与 2026-08-15 两天历史
    seedHistory(store, '2026-08-15', [
      { role: 'user', content: '今天的问题', ts: '2026-08-15T10:00:00.000Z' },
      { role: 'assistant', content: '今天的回答', ts: '2026-08-15T10:00:30.000Z' },
    ]);
    seedHistory(store, '2026-08-14', [
      { role: 'user', content: '昨天的问题', ts: '2026-08-14T09:00:00.000Z' },
    ]);

    // 用户选了 2026-08-14
    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: '2026-08-14',
      description: '该天对话',
      date: '2026-08-14',
    } as never);

    await provider.switchHistoryFromCommand();

    // 先 clear_ok 清空，再重放该天消息
    const types = posted.map((m) => (m as { type: string }).type);
    expect(types).toContain('clear_ok');
    expect(types).toContain('user');

    // 只重放 08-14 的消息（1 条 user），不混入 08-15 的 user/assistant
    const userMsgs = posted.filter((m) => (m as { type: string }).type === 'user');
    expect(userMsgs).toHaveLength(1);
    expect((userMsgs[0] as { text: string }).text).toBe('昨天的问题');
    const assistantMsgs = posted.filter((m) => (m as { type: string }).type === 'assistant');
    expect(assistantMsgs).toHaveLength(0);
  });

  it('选择「全部历史」时跨天合并重放全部消息', async () => {
    const { store, provider, posted } = setup();
    seedHistory(store, '2026-08-15', [
      { role: 'user', content: '今天的问题', ts: '2026-08-15T10:00:00.000Z' },
    ]);
    seedHistory(store, '2026-08-14', [
      { role: 'user', content: '昨天的问题', ts: '2026-08-14T09:00:00.000Z' },
    ]);

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue({
      label: '全部历史',
      description: '跨天合并',
      date: '',
    } as never);

    await provider.switchHistoryFromCommand();

    const userMsgs = posted.filter((m) => (m as { type: string }).type === 'user');
    // 跨天合并应包含两条 user 消息
    expect(userMsgs).toHaveLength(2);
  });

  it('QuickPick 中有历史日期（listSessions 非空）', async () => {
    const { store, provider } = setup();
    seedHistory(store, '2026-08-15', [
      { role: 'user', content: 'x', ts: '2026-08-15T10:00:00.000Z' },
    ]);

    vi.mocked(vscode.window.showQuickPick).mockResolvedValue(null as never);
    await provider.switchHistoryFromCommand();

    // QuickPick 应被调用，且 item 包含历史日期
    const items = vi.mocked(vscode.window.showQuickPick).mock.calls[0]?.[0] as unknown[];
    expect(items?.length).toBeGreaterThan(1); // 至少「全部历史」+ 一个日期
    expect(items?.some((i) => (i as { date?: string }).date === '2026-08-15')).toBe(true);
  });
});