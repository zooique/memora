/**
 * host_diag 诊断路由宿主出口测试（T1）
 *
 * 覆盖 onDidReceiveMessage 的 host_diag 分支（webview 错误边界的唯一上行出口）：
 *   ① 收到上报 → console.warn 落扩展宿主日志（message + stack 留痕）；
 *   ② **不驱动任何 UI 状态**：零下行 post（卡片由 webview 就地渲染，宿主只管留痕）——
 *      变异「宿主顺手弹 notice」必须被本守卫抓红。
 *
 * 驱动方式：走 onDidReceiveMessage 真实注册回调（与 chatPanelDecision 同范式）。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

vi.mock('vscode', async () => ({
  Uri: {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    file: (p: string) => ({ fsPath: p, toString: () => 'mock://file' }),
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
    // 活动文件 chip 的两条 workspace 侧订阅（同文件被编辑 / 保存翻 isDirty）
    onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  },
}));

/** 装配：provider + postMessage 捕获 + resolveWebviewView 真实注册（路由驱动） */
function setupDiag() {
  const dir = __dirname;
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();
  const provider = new MemoraChatViewProvider(
    { fsPath: '/mock/uri' } as never,
    store,
    {} as never,
    '/mock/workspace',
  );
  // 与本用例无关的三件事桩掉：HTML 渲染 / 编辑器追踪 / Agent 装配
  const p = provider as unknown as {
    render(): void;
    ensureAgent(): Promise<void>;
  };
  p.render = () => {};
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
    receive: (msg: unknown): void => receive?.(msg),
  };
}

describe('host_diag 路由（webview 错误上报 → 宿主留痕）', () => {
  it('收到上报 → console.warn 落日志（含 source/message/stack），零下行 post', () => {
    const h = setupDiag();
    const warnSpy = vi.spyOn(console, 'warn');

    h.receive({
      type: 'host_diag',
      source: 'unhandledrejection',
      message: '异步任务炸了',
      stack: 'Error: 异步任务炸了\n    at foo',
    });

    // ① 留痕：日志含来源、消息、堆栈（排障三要素）
    const diagWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('webview 未处理异常'),
    );
    expect(diagWarns).toHaveLength(1);
    expect(String(diagWarns[0][0])).toContain('[unhandledrejection]');
    expect(String(diagWarns[0][0])).toContain('异步任务炸了');
    expect(String(diagWarns[0][1])).toContain('at foo');
    warnSpy.mockRestore();

    // ② 不驱动 UI：宿主侧零下行 post（卡片归 webview 就地渲染）
    expect(h.posted).toHaveLength(0);
  });

  it('缺 stack 字段的上报同样落日志（不因可选字段缺失而炸）', () => {
    const h = setupDiag();
    const warnSpy = vi.spyOn(console, 'warn');

    h.receive({ type: 'host_diag', source: 'error', message: '无堆栈错误' });

    const diagWarns = warnSpy.mock.calls.filter((args) =>
      String(args[0]).includes('webview 未处理异常'),
    );
    expect(diagWarns).toHaveLength(1);
    warnSpy.mockRestore();
    expect(h.posted).toHaveLength(0);
  });
});
