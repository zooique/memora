/**
 * 暂停/恢复：真源翻转事件必须刷新骨架投影（用户实测 Bug 回归）
 *
 * 现象（宿主真机）：暂停 → 点「继续」→ 提示已恢复，但按钮图标不变（仍「继续 ▶」）且续跑
 * 全程不切；续跑结束后再点「继续」无反应。
 *
 * 根因：状态机翻转（sessionPaused / sessionResumed）是投影的**唯一正确刷新时机**，但两个
 * 监听只发 notice 不重投影 → `_turnState` 停留在翻转前的值。尤其 sessionResumed 原走
 * syncPendingQueue——该函数有长度守卫，纯续跑（无 interject 排队）时队列长度恒 0 → 永不触发。
 *
 * 修复：两个监听各补一次 postTurnUpdate()（只读真源 + 幂等，不新造状态）。
 *
 * ⚠ 变异验证靶标（新增断言必做）：撤掉任一分支的 `this.postTurnUpdate()` → 对应用例
 * `turnUpdates(posted)` 长度为 0 → 用例转红。已实证。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Agent } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

// mock vscode：chatPanel 构造最小 API（与 chatPanelInput.test 同款）
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

/** agent 桩：投影只消费 status / isPausePending / getPendingInterjections 三源 */
function projectionAgentStub(status: 'running' | 'paused'): Agent {
  return {
    sessionManager: { status },
    isPausePending: () => false,
    getPendingInterjections: () => [],
    on: vi.fn(),
    off: vi.fn(),
    getMetrics: () => ({
      llm: { totalInputTokens: 0, totalOutputTokens: 0 },
      tools: { unparsedToolIntentCount: 0 },
      context: {},
    }),
    getCheckpoint: () => undefined,
  } as unknown as Agent;
}

/** 构造 provider + 抓取 post 消息（复刻 chatPanelInput.test 的 harness） */
function setup() {
  const dir = __dirname; // store 构造只做落盘路径，不读内容
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  const provider = new MemoraChatViewProvider({ fsPath: '/mock/uri' } as never, store, {} as never);
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
  return { provider, posted };
}

/** 事件监听为私有箭头字段：cast 直呼（它们就是实例属性，非原型方法） */
interface ProjectionCast {
  onSessionPaused(info: { reason: string; source: string; sessionId?: string }): void;
  onSessionResumed(info: { sessionId?: string }): void;
  _streaming: boolean;
  _pendingQuestions: unknown[];
  _agent: Agent;
}

const turnUpdates = (posted: unknown[]) =>
  posted.filter((m) => (m as { type?: string }).type === 'turn_update');

describe('暂停/恢复：真源翻转事件必须刷新骨架投影', () => {
  it('sessionResumed → 投影 running（续跑后按钮切「暂停」，不停留「继续」）', () => {
    const { provider, posted } = setup();
    const cast = provider as unknown as ProjectionCast;
    cast._agent = projectionAgentStub('running');
    cast._streaming = true; // 续跑流已启动
    cast._pendingQuestions = [];

    cast.onSessionResumed({ sessionId: 's1' });

    const updates = turnUpdates(posted);
    expect(updates).toHaveLength(1);
    expect((updates[0] as { state: { phase: string } }).state.phase).toBe('running');
  });

  it('sessionPaused → 投影 waiting(pause)（按钮切「继续」）', () => {
    const { provider, posted } = setup();
    const cast = provider as unknown as ProjectionCast;
    cast._agent = projectionAgentStub('paused');
    cast._streaming = true;
    cast._pendingQuestions = [];

    cast.onSessionPaused({ reason: 'user-pause', source: 'user' });

    const updates = turnUpdates(posted);
    expect(updates).toHaveLength(1);
    expect((updates[0] as { state: { phase: string } }).state.phase).toBe('waiting');
    expect((updates[0] as { state: { reason?: string } }).state.reason).toBe('pause');
  });
});
