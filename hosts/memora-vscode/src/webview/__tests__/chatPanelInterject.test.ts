/**
 * 插话「吸收时上屏」宿主侧测试（方案：呈现 ⟺ 事实——排队中不上屏，消费/丢弃按事实分流）
 *
 * 覆盖三件事：
 *   ① 入队成功**不再**即时 post type:'user'（旧「发送即上屏」设计已退役——
 *      排队中 ≠ 已说出，超前呈现让「取消排队」留孤儿行）；
 *   ② 三条丢弃路径（删除单条 / 全部清空 / 停止放弃检查点）发 pending_discarded 信号，
 *      载荷 = 被丢条目文本（先读后丢），且信号先于新快照 turn_update（FIFO 时序契约）；
 *   ③ 丢弃信号唯一发点 postPendingDiscarded 的空载荷 no-op。
 *
 * webview 侧 diff 分流（消失条目命中信号 = 丢弃不上屏；未命中 = 消费上屏）归
 * chatViewInterject.test.ts（jsdom），本文件只管宿主出口。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Agent } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

vi.mock('vscode', async () => ({
  Uri: { joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }), fsPath: '/mock' },
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

/** 可变队列桩：interject/remove/clear 真实改数组（宿主「先读后丢」依赖读删间的真实变化） */
function interjectAgentStub(items: string[]): Agent {
  return {
    interject: (text: string) => {
      items.push(text);
      return true;
    },
    getPendingInterjections: () => [...items],
    removePendingInterject: (index: number) => {
      if (index < 0 || index >= items.length) return false;
      items.splice(index, 1);
      return true;
    },
    clearPendingInterjections: () => {
      const n = items.length;
      items.length = 0;
      return n;
    },
    isPausePending: () => false,
    discardCurrentCheckpoint: () => true,
    security: { onWriteConfirmation: () => () => {}, onAudit: () => () => {} },
  } as unknown as Agent;
}

interface HostCast {
  _agent: Agent;
  _view: unknown;
  _streaming: boolean;
  _abortController: AbortController | null;
  sendInput(input: string, skillName?: string): Promise<void>;
}

/** 装配：provider + postMessage 捕获 + resolveWebviewView 真实注册（路由驱动） */
function setup(items: string[]) {
  const dir = __dirname;
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  const provider = new MemoraChatViewProvider({ fsPath: '/mock/uri' } as never, store, {} as never);
  // 与本用例无关的三件事桩掉：HTML 渲染 / 编辑器追踪 / Agent 装配（后者 async 且要真配置）
  const p = provider as unknown as {
    render(): void;
    ensureEditorTracking(): void;
    ensureAgent(): Promise<void>;
  };
  p.render = () => {};
  p.ensureEditorTracking = () => {};
  p.ensureAgent = async () => {};
  const posted: Array<Record<string, unknown>> = [];
  let receive: ((msg: unknown) => void) | undefined;
  const webviewView = {
    webview: {
      asWebviewUri: () => ({ toString: () => 'mock://script' }),
      options: {},
      html: '',
      postMessage: (msg: unknown) => {
        posted.push(msg as Record<string, unknown>);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        receive = cb;
        return { dispose: () => {} };
      },
    },
    onDidDispose: () => ({ dispose: () => {} }),
  } as never;
  (provider as unknown as { _view: unknown })._view = webviewView;
  provider.resolveWebviewView(webviewView, {} as never, {} as never);
  const cast = provider as unknown as HostCast;
  cast._agent = interjectAgentStub(items);
  return {
    posted,
    cast,
    receive: (msg: unknown): void => receive?.(msg),
  };
}

/** 取丢弃信号消息（无则 null） */
function takeDiscarded(posted: Array<Record<string, unknown>>): { items: string[] } | null {
  const d = posted.find((m) => m.type === 'pending_discarded');
  return d ? (d as { items: string[] }) : null;
}

describe('插话吸收时上屏 · 宿主出口（chatPanel）', () => {
  it('interject 入队成功不 post type:user（旧即时上屏已退役——变异加回即本用例红）', async () => {
    const h = setup([]);
    h.cast._streaming = true;
    h.cast._abortController = new AbortController();
    await h.cast.sendInput('排队中的补充');
    expect(h.posted.some((m) => m.type === 'user')).toBe(false);
  });

  it('删除单条 → pending_discarded 携带被删文本，且先于新快照 turn_update（FIFO 时序契约）', async () => {
    const items = ['甲补充', '乙补充'];
    const h = setup(items);
    h.receive({ type: 'remove_pending_item', index: 0 });
    const d = takeDiscarded(h.posted);
    expect(d).not.toBeNull();
    expect(d!.items).toEqual(['甲补充']);
    // 时序契约：信号帧必须先于携带新快照的 turn_update 帧
    const signalIdx = h.posted.findIndex((m) => m.type === 'pending_discarded');
    const snapshotIdx = h.posted.findIndex(
      (m) => m.type === 'turn_update' && m.pendingQueue !== undefined,
    );
    expect(signalIdx).toBeGreaterThanOrEqual(0);
    expect(snapshotIdx).toBeGreaterThan(signalIdx);
  });

  it('全部清空 → pending_discarded 携带全部被丢文本', async () => {
    const items = ['甲补充', '乙补充', '丙补充'];
    const h = setup(items);
    h.receive({ type: 'clear_pending_queue' });
    const d = takeDiscarded(h.posted);
    expect(d).not.toBeNull();
    expect(d!.items).toEqual(['甲补充', '乙补充', '丙补充']);
  });

  it('停止（paused 态放弃检查点）→ 协同清理的排队插话同样发丢弃信号', () => {
    const items = ['暂停前的补充'];
    const h = setup(items);
    // 造 paused 相位：sessionManager.status = 'paused'（handleStop 走 discard 分支的判据）
    (h.cast._agent as unknown as { sessionManager: unknown }).sessionManager = {
      status: 'paused',
    };
    h.receive({ type: 'stop' });
    const d = takeDiscarded(h.posted);
    expect(d).not.toBeNull();
    expect(d!.items).toEqual(['暂停前的补充']);
  });

  it('删除越界（队列未变）→ 零信号零误报', () => {
    const h = setup(['甲补充']);
    h.receive({ type: 'remove_pending_item', index: 5 });
    expect(takeDiscarded(h.posted)).toBeNull();
  });
});
