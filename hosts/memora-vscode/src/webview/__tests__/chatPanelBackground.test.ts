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
  /** 自然完成（非 kill）：与内核 settle 同语义——改状态、**不发** kernel kill 回调 */
  const settle = (taskId: string): void => {
    const idx = tasks.findIndex((t) => t.taskId === taskId);
    if (idx < 0) return;
    tasks[idx] = { ...tasks[idx]!, status: 'completed' };
  };
  // 真实 Agent 是 TypedEventEmitter（宿主靠 a.on/off 订阅）。桩必须**真的转发**：
  // 用 vi.fn() 空实现会让「事件名错配 / 处理器没绑上」这类缺陷测不出来（测试全绿但零覆盖）。
  const handlers = new Map<string, ((payload: unknown) => void)[]>();
  const onCalls: string[] = [];
  const agent = {
    listBackgroundTasks,
    killBackgroundTask,
    on: (event: string, cb: (payload: unknown) => void) => {
      onCalls.push(event);
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    off: vi.fn((event: string) => handlers.set(event, [])),
  } as unknown as Agent;
  return { agent, listBackgroundTasks, killBackgroundTask, settle, onCalls, handlers };
}

interface BackgroundCast {
  _agent: Agent;
  _view: unknown;
  postBackgroundTasks(mode?: 'dedup' | 'force'): void;
  killBackgroundTask(taskId: string): void;
  dismissBackgroundTask(taskId: string): void;
  bindAgentNoticeEvents(): void;
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

  it('force 绕过去重：紧邻的同签名快照也再推一次（webview 重建后必须重新对齐）', () => {
    const h = setupBackground();
    h.cast._agent = backgroundAgentStub().agent;

    h.cast.postBackgroundTasks(); // dedup 首次：推
    const afterFirst = h.posted.length;
    h.cast.postBackgroundTasks('force');

    // 断言「增量恰为 1」而非「总共 N 条」——后者会被两种不同错误实现同时满足
    // （dedup 退化成不设限、force 也被去重）⇒ 变异时仍绿 = 因错误的原因通过
    expect(h.posted.length).toBe(afterFirst + 1);
  });

  it('ready 补推接线：handleWebviewReady 必走 force（否则面板重开后台条凭空消失）', async () => {
    // 回归守卫：只推事件点、不在 ready 补推 ⇒ 折叠/关闭再打开面板时新 webview 从未收到
    // background_tasks，而后台进程还在跑、用户看不到也砍不掉（同 pushFileChanges 的时间面漏面）。
    const h = setupBackground();
    h.cast._agent = backgroundAgentStub().agent;
    h.cast.postBackgroundTasks(); // 先推一次，把签名写满（模拟事件点已推过）
    const before = h.posted.length;
    const p = h.provider as unknown as {
      ensureAgent(): Promise<void>;
      replaySession(): void;
      handleWebviewReady(): Promise<void>;
    };
    p.ensureAgent = async () => {};
    p.replaySession = () => {}; // 与本断言无关的回放（避免掺入历史轮噪声）
    (h.provider as unknown as { _currentSessionId: string })._currentSessionId = '2026-08-15-s1';

    await p.handleWebviewReady();

    const bgMsgs = h.posted
      .slice(before)
      .filter((m) => (m as { type: string }).type === 'background_tasks');
    expect(bgMsgs).toHaveLength(1);
  });

  it('dismiss 只收起视图：内核条目与输出留着，且过滤后不再下发', () => {
    const h = setupBackground();
    const stub = backgroundAgentStub();
    h.cast._agent = stub.agent;

    h.cast.dismissBackgroundTask('bg-1');

    // ① 不碰内核：既不 kill 也不改任何内核状态
    expect(stub.killBackgroundTask).not.toHaveBeenCalled();
    expect(stub.agent.listBackgroundTasks()).toHaveLength(1);
    // ② 快照里这条被过滤掉（视图收起）
    const last = h.posted[h.posted.length - 1] as { type: string; items: unknown[] };
    expect(last.type).toBe('background_tasks');
    expect(last.items).toHaveLength(0);
  });

  it('dismiss 记在宿主侧：面板重建（webview ready 全量对齐）后该条不会复活', () => {
    const h = setupBackground();
    h.cast._agent = backgroundAgentStub().agent;
    h.cast.dismissBackgroundTask('bg-1');

    // 模拟 webview 重建：ready 时走 force 全量对齐（签名去重会拦掉重复推送，此处验内容）
    h.cast.postBackgroundTasks('force');

    const last = h.posted[h.posted.length - 1] as { type: string; items: unknown[] };
    expect(last.type).toBe('background_tasks');
    // force 也过滤 dismissed —— 「记住了」在宿主，不在 webview
    expect(last.items).toHaveLength(0);
  });

  it('终态事件 → 推一次快照（订阅面必须真收到：桩的 on/off 是真转发）', () => {
    // 桩先转 running → completed，让「事件驱动状态变化」这件事是**真的**发生的，
    // 而不是「事件说 completed、注册表还报 running」的自相矛盾假数据。
    const h = setupBackground();
    const stub = backgroundAgentStub();
    h.cast._agent = stub.agent;
    h.cast.bindAgentNoticeEvents();
    stub.settle('bg-1');

    // 走真实投递面：桩捕获的订阅处理器（`emit` 在真实 Agent 上是 protected，
    // 测试里直接调会绕过「事件名对不对得上」这道真检查）
    const handler = stub.handlers.get('backgroundTaskSettled')?.[0];
    expect(handler).toBeTruthy();
    handler?.({
      taskId: 'bg-1',
      command: 'npm run build',
      status: 'completed',
    });

    const last = h.posted[h.posted.length - 1] as { type: string; items: { status: string }[] };
    expect(last.type).toBe('background_tasks');
    expect(last.items[0]?.status).toBe('completed');
  });

  it('订阅幂等：同一事件只 on 一次（重复订阅 ⇒ 一次终态推两遍快照）', () => {
    const h = setupBackground();
    const stub = backgroundAgentStub();
    h.cast._agent = stub.agent;
    h.cast.bindAgentNoticeEvents();

    // 守卫「off/on 成对且各一次」——本轮踩过：回滚变异时误插成两行 on，
    // 一次终态会推两遍完全相同的快照（签名去重在事件处理器内部拦不住，那是两条独立调用）。
    const ons = stub.onCalls.filter((e) => e === 'backgroundTaskSettled');
    expect(ons).toHaveLength(1);
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
