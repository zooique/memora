/**
 * HOST-CTX-1 @ 提及宿主侧验收：openMentionQuickPick 三契约
 *
 *   ① 选中文件 → addRef(source='mention') 回推（refs = 首根相对路径，kind=file）
 *   ② 首根归属 fail-closed：第二根 / 根外文件**不进列表**（与 addToChat 拒挂同一契约两半，
 *      判据 SSOT = refPath.relativeUnderPrimaryRoot）
 *   ③ 取消（Esc/hide）→ 静默返回，无任何 post（@ 留在正文，webview 不撤）
 *
 * 语义红线（引用模式定案）：@ 只挂引用不注入——断言 post 载荷里只有 path/kind，无内容字段。
 *
 * 替身策略：vscode mock（findFiles / createQuickPick / workspaceFolders），QuickPick 桩以
 * onDidAccept / onDidHide 回调手动触发，selectedItems 由测试预置——与 chatPanelInput.test 同款。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { MemoraChatViewProvider } from '../../../webview/panels/chatPanel.js';
import { WorkspaceSessionStore } from '../sessionStore.js';
import { WorkspaceRoundStore } from '../workspaceRoundStore.js';

// mock vscode：chatPanel 构造最小面（同 chatPanelInput.test）+ mention 所需的 findFiles / QuickPick
vi.mock('vscode', async () => ({
  Uri: {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    fsPath: '/mock/path',
  },
  window: {
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
    activeTextEditor: undefined,
    createQuickPick: vi.fn(),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: 'C:/root' } }],
    getConfiguration: vi.fn(() => ({ get: vi.fn(() => false) })),
    findFiles: vi.fn(),
  },
}));

type QpStub = {
  items: unknown[];
  canSelectMany: boolean;
  matchOnDescription: boolean;
  placeholder: string;
  selectedItems: vscode.QuickPickItem[];
  show: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  onDidAccept: ReturnType<typeof vi.fn>;
  onDidHide: ReturnType<typeof vi.fn>;
};

/** QuickPick 桩：capture 回调，测试按需触发 accept / hide */
function stubQuickPick(selected: vscode.QuickPickItem[]): QpStub {
  const qp: QpStub = {
    items: [],
    canSelectMany: false,
    matchOnDescription: false,
    placeholder: '',
    selectedItems: selected,
    show: vi.fn(),
    dispose: vi.fn(),
    onDidAccept: vi.fn(),
    onDidHide: vi.fn(),
  };
  (vscode.window.createQuickPick as ReturnType<typeof vi.fn>).mockReturnValue(qp);
  return qp;
}

/** 构造 provider + posted 捕获（同 chatPanelInput.test 装配） */
function setup() {
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
  return {
    provider,
    posted,
    cast: provider as unknown as { openMentionQuickPick(): Promise<void> },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('HOST-CTX-1 @ 提及：openMentionQuickPick', () => {
  it('选中文件 → addRef(source=mention) 回推相对路径；第二根文件不进列表（fail-closed）', async () => {
    const h = setup();
    const findFiles = vscode.workspace.findFiles as ReturnType<typeof vi.fn>;
    // 两个首根内文件 + 一个「第二根」文件（根外）——后者必须被首根归属判据拦下
    findFiles.mockResolvedValue([
      { fsPath: 'C:/root/src/a.ts' } as vscode.Uri,
      { fsPath: 'C:/root/docs/b.md' } as vscode.Uri,
      { fsPath: 'C:/other/outside.ts' } as vscode.Uri,
    ]);
    const qp = stubQuickPick([
      { label: 'a.ts', description: 'src/a.ts' },
      { label: 'b.md', description: 'docs/b.md' },
    ]);
    const p = h.cast.openMentionQuickPick();
    // 等回调注册完成（openMentionQuickPick 内部先填充 items 再注册 accept/hide）
    await vi.waitFor(() => expect(qp.onDidAccept).toHaveBeenCalled());
    expect(qp.items).toEqual([
      { label: 'b.md', description: 'docs/b.md', rel: 'docs/b.md' },
      { label: 'a.ts', description: 'src/a.ts', rel: 'src/a.ts' },
    ]);
    expect(qp.canSelectMany).toBe(true);
    // 用户确认（accept 回调 → selectedItems 即上面预置的两项）
    (qp.onDidAccept.mock.calls[0][0] as () => void)();
    await p;
    expect(qp.dispose).toHaveBeenCalled();
    expect(h.posted).toContainEqual({
      type: 'addRef',
      refs: [
        { path: 'src/a.ts', kind: 'file' },
        { path: 'docs/b.md', kind: 'file' },
      ],
      source: 'mention',
    });
  });

  it('取消（hide 回调）→ 静默返回无 post（@ 留在正文，webview 不撤）', async () => {
    const h = setup();
    (vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      { fsPath: 'C:/root/src/a.ts' } as vscode.Uri,
    ]);
    const qp = stubQuickPick([]);
    const p = h.cast.openMentionQuickPick();
    await vi.waitFor(() => expect(qp.onDidHide).toHaveBeenCalled());
    (qp.onDidHide.mock.calls[0][0] as () => void)();
    await p;
    expect(h.posted).toHaveLength(0);
  });
});
