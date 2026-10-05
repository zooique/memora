/**
 * C2 决策记录宿主出口测试（方案 §6.6-C2：确认决议留痕）
 *
 * 覆盖 `_logDecision` 唯一发点的三路径行为：
 *   ① 用户批准 / 拒绝（write_confirm_answer）→ 时间线决策记录（kind:'decision'）；
 *   ② 超时自动拒 → 同构决策记录（level 保留 error 红条警示）；
 *   ③ 载荷纪律反向守卫：**不记载荷全文**（info.description 不得进 message）——
 *      变异「把 description 拼进 message」必须被本守卫抓红。
 *
 * 驱动方式：走 `onDidReceiveMessage` 真实注册回调（非直调私有方法），
 * 与 chatPanelBackground「路由跳」同范式。
 *
 * ⚠️ 未覆盖面（如实登记）：决策记录入 webview 后的渲染形态归 chatViewDecision.test.ts
 * （jsdom 侧 class/文本断言），本文件只管宿主出口。
 */
// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Agent } from '@zooique/memora';
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

/** 载荷特征串：反向守卫用它确认 description（diff 全文）从未进决策记录 */
const CARGO_MARKER = 'CARGO-FULLTEXT-9527';

/** 确认请求载荷（内核 WriteConfirmationRequest 形态；description 含特征串） */
function confirmInfo() {
  return {
    tool: 'write_file',
    targetPath: '/mock/workspace/notes/foo.md',
    description: `${CARGO_MARKER} 这是 diff 全文级载荷`,
    permission: 'confirm',
    beforeContent: null,
    afterContent: 'new content',
    hasDiff: true,
  };
}

/** 安全守卫桩：捕获 onWriteConfirmation 注入的 handler，供测试手动触发内核确认 */
function securityAgentStub() {
  let handler: ((info: ReturnType<typeof confirmInfo>) => Promise<boolean>) | undefined;
  const agent = {
    security: {
      onWriteConfirmation: (h: (info: ReturnType<typeof confirmInfo>) => Promise<boolean>) => {
        handler = h;
      },
      onAudit: vi.fn(() => () => {}),
    },
  } as unknown as Agent;
  return {
    agent,
    trigger: (info: ReturnType<typeof confirmInfo>): Promise<boolean> => {
      if (!handler) throw new Error('onWriteConfirmation 未注入');
      return handler(info);
    },
  };
}

interface DecisionCast {
  _agent: Agent;
  _view: unknown;
  bindWriteConfirmation(): void;
}

/** 装配：provider + postMessage 捕获 + resolveWebviewView 真实注册（路由驱动） */
function setupDecision() {
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
  const posted: unknown[] = [];
  let receive: ((msg: unknown) => void) | undefined;
  const webviewView = {
    webview: {
      asWebviewUri: () => ({ toString: () => 'mock://script' }),
      options: {},
      html: '',
      postMessage: (msg: unknown) => {
        posted.push(msg);
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
  return {
    posted,
    cast: provider as unknown as DecisionCast,
    receive: (msg: unknown): void => receive?.(msg),
  };
}

/** 从已推送消息中取审批卡 requestId */
function takeRequestId(posted: unknown[]): string {
  const req = posted.find(
    (m): m is { type: string; requestId: string } =>
      (m as { type?: string }).type === 'write_confirm_request',
  );
  if (!req) throw new Error('write_confirm_request 未推送');
  return req.requestId;
}

/** 取决策记录消息（kind:'decision' 的 notice） */
function takeDecision(posted: unknown[]): {
  level: string;
  message: string;
  kind?: string;
} {
  const d = posted.find(
    (m): m is { level: string; message: string; kind?: string } =>
      (m as { kind?: string }).kind === 'decision',
  );
  if (!d) throw new Error('决策记录未发出');
  return d;
}

describe('C2 决策记录宿主出口（chatPanel · 方案 §6.6-C2）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('用户批准 → 决策记录（已批准 + 工具面 basename），不含载荷全文（反向守卫）', async () => {
    const h = setupDecision();
    const stub = securityAgentStub();
    h.cast._agent = stub.agent;
    h.cast.bindWriteConfirmation();

    const settled = stub.trigger(confirmInfo());
    h.receive({
      type: 'write_confirm_answer',
      requestId: takeRequestId(h.posted),
      approved: true,
    });
    await expect(settled).resolves.toBe(true);

    const d = takeDecision(h.posted);
    expect(d.message).toContain('已批准');
    expect(d.message).toContain('foo.md');
    // 反向守卫：description（diff 全文）进 message 即变异——必须红
    expect(d.message).not.toContain(CARGO_MARKER);
  });

  it('用户拒绝 → 决策记录（已拒绝 + 工具面），同样不记载荷全文', async () => {
    const h = setupDecision();
    const stub = securityAgentStub();
    h.cast._agent = stub.agent;
    h.cast.bindWriteConfirmation();

    const settled = stub.trigger(confirmInfo());
    h.receive({
      type: 'write_confirm_answer',
      requestId: takeRequestId(h.posted),
      approved: false,
    });
    await expect(settled).resolves.toBe(false);

    const d = takeDecision(h.posted);
    expect(d.message).toContain('已拒绝');
    expect(d.message).toContain('foo.md');
    expect(d.message).not.toContain(CARGO_MARKER);
  });

  it('超时自动拒 → 决策记录（error 红条 + 工具面），fail-closed 结果为 false', async () => {
    vi.useFakeTimers();
    const h = setupDecision();
    const stub = securityAgentStub();
    h.cast._agent = stub.agent;
    h.cast.bindWriteConfirmation();

    const settled = stub.trigger(confirmInfo());
    takeRequestId(h.posted);
    // 30 分钟超时（CONFIRM_TIMEOUT_MS 语义）
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    await expect(settled).resolves.toBe(false);

    const d = takeDecision(h.posted);
    expect(d.level).toBe('error');
    expect(d.message).toContain('已自动拒绝');
    expect(d.message).toContain('foo.md');
    expect(d.message).not.toContain(CARGO_MARKER);
  });

  it('每次裁决恰好一条决策记录（决议不发事件 ⇒ 本用例红；双写 ⇒ 计数断言红）', async () => {
    const h = setupDecision();
    const stub = securityAgentStub();
    h.cast._agent = stub.agent;
    h.cast.bindWriteConfirmation();

    const settled = stub.trigger(confirmInfo());
    h.receive({
      type: 'write_confirm_answer',
      requestId: takeRequestId(h.posted),
      approved: true,
    });
    await settled;

    const decisions = h.posted.filter((m) => (m as { kind?: string }).kind === 'decision');
    expect(decisions).toHaveLength(1);
  });
});
