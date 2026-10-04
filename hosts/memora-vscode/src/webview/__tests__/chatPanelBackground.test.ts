/**
 * 后台任务宿主出口验收测试（CMD-1 阶段 2 · 内核侧刀 1 的宿主消费面）
 *
 * 覆盖 `chatPanel.postBackgroundTasks` / `killBackgroundTask` 两个新增私有方法的行为：
 *   ① 快照只下发 3 个投影键 + statusLabel（**不含 `result`**——命令输出体量大，UI 不呈现）；
 *   ② agent 未装配时**不推**（不静默推空：否则 UI 会把「未就绪」读成「没有后台任务」）；
 *   ③ kill 后**回推一次**快照（浮层立刻转终态，不等下一个推送时机）；
 *   ④ 签名去重：快照未变不推，kill 导致的「条数不变而状态变」必须推得出去。
 *
 * 替身策略：agent 桩 + cast 注入私有状态，与 chatPanelInput.test 既有模式一致。
 *
 * ⚠️ 未覆盖面（如实登记）：`onDidReceiveMessage` 里 `msg.type === 'background_kill'`
 * → `killBackgroundTask()` 这一跳由下方「路由跳」用例驱动（走 `resolveWebviewView`
 * 真实注册回调，非直接调私有方法）。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { Agent, BackgroundTask } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

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

/** 一条带 result 的后台任务（内核投影形态：result 存在，但 UI 不该收到） */
function taskWithResult(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    taskId: 'bg-1',
    command: 'npm run build',
    startedAt: 1_700_000_000_000,
    status: 'running',
    result: { stdout: '很长的构建输出', stderr: '', exitCode: 0, timedOut: false },
    ...overrides,
  };
}

function backgroundAgentStub(initial: BackgroundTask[] = [taskWithResult()]) {
  // 内部可变表：与内核同构——kill 会改写条目状态，后续 list 读到的是终态
  const tasks: BackgroundTask[] = initial.map((t) => ({ ...t }));
  const listBackgroundTasks = vi.fn((): readonly BackgroundTask[] => tasks.map((t) => ({ ...t })));
  const killBackgroundTask = vi.fn((taskId: string): BackgroundTask | null => {
    const idx = tasks.findIndex((t) => t.taskId === taskId);
    if (idx < 0) return null;
    tasks[idx] = { ...tasks[idx]!, status: 'killed' };
    return { ...tasks[idx]! };
  });
  const agent = {
    listBackgroundTasks,
    killBackgroundTask,
  } as unknown as Agent;
  return { agent, listBackgroundTasks, killBackgroundTask };
}

interface BackgroundCast {
  _agent: Agent;
  _view: unknown;
  postBackgroundTasks(): void;
  killBackgroundTask(taskId: string): void;
}

function setupBackground() {
  const dir = __dirname;
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
  return { provider, posted, cast: provider as unknown as BackgroundCast };
}

describe('后台任务宿主出口（chatPanel · 方案 §2.1/§2.2）', () => {
  it('快照只下发 3 个投影键 + statusLabel（不含 result——输出归模型消费，UI 不呈现）', () => {
    const h = setupBackground();
    h.cast._agent = backgroundAgentStub().agent;

    h.cast.postBackgroundTasks();

    expect(h.posted).toHaveLength(1);
    const msg = h.posted[0] as { type: string; items: unknown[] };
    expect(msg.type).toBe('background_tasks');
    expect(msg.items).toHaveLength(1);
    // 多一个 result 字段 = 把 KB~MB 级命令输出搬进 UI 通道
    expect(Object.keys(msg.items[0] as object).sort()).toEqual([
      'command',
      'status',
      'statusLabel',
      'taskId',
    ]);
  });

  it('agent 未装配 → 不推（不静默推空：未就绪 ≠ 没有后台任务）', () => {
    const h = setupBackground();
    // 不注入 _agent（未装配态）
    (h.cast as { _agent?: Agent })._agent = undefined;

    h.cast.postBackgroundTasks();

    expect(h.posted).toHaveLength(0);
  });

  it('kill 后强制回推一次快照（浮层立刻转终态，不等下一推送时机）', () => {
    const h = setupBackground();
    const stub = backgroundAgentStub();
    h.cast._agent = stub.agent;

    h.cast.killBackgroundTask('bg-1');

    // ① 调了内核门面
    expect(stub.killBackgroundTask).toHaveBeenCalledWith('bg-1');
    // ② 回推的快照是 kill 之后的终态（running → killed），浮层据此立刻刷新
    const last = h.posted[h.posted.length - 1] as { type: string; items: { status: string }[] };
    expect(last.type).toBe('background_tasks');
    expect(last.items[0]?.status).toBe('killed');
  });

  it('签名去重：快照未变不重复推（step_boundary 是周期到达点，无任务时零噪音）', () => {
    const h = setupBackground();
    h.cast._agent = backgroundAgentStub().agent;

    h.cast.postBackgroundTasks();
    h.cast.postBackgroundTasks(); // 同一快照：不推
    expect(h.posted).toHaveLength(1);
  });

  it('签名去重不得吞掉 kill：条数不变而状态变，仍须推出去', () => {
    const h = setupBackground();
    h.cast._agent = backgroundAgentStub().agent;

    h.cast.postBackgroundTasks(); // running（第 1 推）
    h.cast.killBackgroundTask('bg-1'); // running → killed，条数恒为 1

    const bgMsgs = h.posted.filter((m) => (m as { type: string }).type === 'background_tasks');
    // 长度守卫会把这次判成 no-op（1→1）⇒ 用签名而非长度，本用例即该判据的变异守卫
    expect(bgMsgs).toHaveLength(2);
    const last = bgMsgs[1] as { items: { status: string }[] };
    expect(last.items[0]?.status).toBe('killed');
  });

  it('路由跳：webview 的 background_kill 消息真能走到 killBackgroundTask（经 resolveWebviewView 注册的回调）', () => {
    // 走**真实注册路径**：resolveWebviewView 内 onDidReceiveMessage 捕获回调后驱动，
    // 避免「直接调私有方法」把中间那一跳（消息类型判据）测没了。
    const h = setupBackground();
    const stub = backgroundAgentStub();
    h.cast._agent = stub.agent;
    // 与本用例无关的三件事桩掉：HTML 渲染 / 编辑器追踪 / Agent 装配（后者是 async 且要真配置）
    const p = h.provider as unknown as {
      render(): void;
      ensureEditorTracking(): void;
      ensureAgent(): Promise<void>;
    };
    p.render = () => {};
    p.ensureEditorTracking = () => {};
    p.ensureAgent = async () => {};

    let handler: ((msg: unknown) => void) | undefined;
    const view = {
      webview: {
        asWebviewUri: () => ({ toString: () => 'mock://script' }),
        options: {},
        html: '',
        postMessage: () => Promise.resolve(true),
        // 真实 API 形状：onDidReceiveMessage 挂在 webview 上（不是 view 上）
        onDidReceiveMessage: (cb: (msg: unknown) => void) => {
          handler = cb;
          return { dispose: () => {} };
        },
      },
      onDidDispose: () => ({ dispose: () => {} }),
    } as never;
    h.provider.resolveWebviewView(view, {} as never, {} as never);
    expect(handler).toBeTruthy();

    handler!({ type: 'background_kill', taskId: 'bg-1' });

    expect(stub.killBackgroundTask).toHaveBeenCalledWith('bg-1');
  });
});
