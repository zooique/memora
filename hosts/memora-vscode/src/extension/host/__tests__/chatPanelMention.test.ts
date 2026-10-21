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
 * HOST-CTX-11 补两契约：④ findFiles 命中上限 = 静默截断 ⇒ placeholder 必须明示；⑤ in-flight
 * 守卫（连按 @ 不重开列表）。
 * HOST-CTX-12 补一契约：⑥ 未知消息类型落宿主 warn 而非静默丢弃。
 * HOST-CTX-14 补一契约：⑦ findFiles 必须显式排除内置忽略目录（node_modules 等）——
 * 源码实读：findFiles 只应用 files.exclude、不应用 search.exclude、.gitignore 默认不尊重，
 * 传 undefined 排除时无关文件挤占 MENTION_FILE_LIMIT 上限 ⇒ 用户想引的文件随机缺席。
 * 截断 placeholder 须说明「忽略目录已排除、仍超限」的原因（只说超上限，用户会以为额度
 * 被无关文件占着——那正是 CTX-14 修掉的旧形态）。
 * HOST-CTX-16 补一契约：⑧ QuickPick 收场（确认 / Esc 取消两条路）后必须发 focus_input
 * 把焦点还给输入框——QuickPick 是宿主全局 UI，收场后 VS Code 不自动归还 webview 焦点。
 *
 * 替身策略：vscode mock（findFiles / createQuickPick / workspaceFolders），QuickPick 桩以
 * onDidAccept / onDidHide 回调手动触发，selectedItems 由测试预置——与 chatPanelInput.test 同款。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { MemoraChatViewProvider, MENTION_FILE_LIMIT } from '../../../webview/panels/chatPanel.js';
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
    /**
     * 模拟 webview 发来一条消息。走 `handleWebviewMessage`（HOST-CTX-12 从匿名回调摘出的
     * 分发方法）而非 onDidReceiveMessage——setup() 不跑 resolveWebviewView，回调未注册。
     */
    dispatch: (msg: unknown) =>
      (provider as unknown as { handleWebviewMessage(m: unknown): void }).handleWebviewMessage(msg),
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
    // HOST-CTX-4：关键字项（problems / git-changes）**恒置顶**，不与文件项混排
    // （与 Roo Code / Cursor 同款）；顺序 = MOUNTABLE_INJECTION_META 登记序
    expect(qp.items).toEqual([
      {
        label: '诊断（问题面板）',
        description: '注入当前工作区的错误 / 警告（发送时取最新，占预算）',
        injection: 'problems',
      },
      {
        label: 'git 未提交改动',
        description: '注入 git 未提交改动（只读 status/diff，发送时取最新，占预算）',
        injection: 'git-changes',
      },
      { label: 'b.md', description: 'docs/b.md', rel: 'docs/b.md' },
      { label: 'a.ts', description: 'src/a.ts', rel: 'src/a.ts' },
    ]);
    expect(qp.canSelectMany).toBe(true);
    // 反向守卫（HOST-CTX-11）：未命中上限时 placeholder 不得含截断提示（否则用户永远
    // 以为列表不全，会去徒劳地输关键词缩小范围）
    expect(qp.placeholder).not.toContain('已截断');
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
    // HOST-CTX-16：确认收场同样归还焦点（与 Esc 取消同一条路，一条 post 覆盖两路）
    expect(h.posted).toContainEqual({ type: 'focus_input' });
  });

  it('选中关键字项（problems + git-changes）→ 每源一条 add_injection(via=mention)，不挂引用', async () => {
    const h = setup();
    (vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const qp = stubQuickPick([
      { label: '诊断（问题面板）', injection: 'problems' } as never,
      { label: 'git 未提交改动', injection: 'git-changes' } as never,
    ]);
    const p = h.cast.openMentionQuickPick();
    await vi.waitFor(() => expect(qp.onDidAccept).toHaveBeenCalled());
    (qp.onDidAccept.mock.calls[0][0] as () => void)();
    await p;

    // HOST-CTX-4：挂载流泛化（MOUNTABLE_INJECTION_META 有几源就挂几源——加源零改 accept
    // 循环）。每源一条 add_injection；本条守住「泛化循环真的按源逐发」而非只发第一源。
    expect(h.posted).toContainEqual({ type: 'add_injection', source: 'problems', via: 'mention' });
    expect(h.posted).toContainEqual({
      type: 'add_injection',
      source: 'git-changes',
      via: 'mention',
    });
    // 只选关键字项（无文件项）⇒ 不发 addRef——ChatRef 契约是「只挂指针不携内容」，
    // 注入型上下文与引用型上下文分道，刻意不复用 addRef。
    expect(h.posted).not.toContainEqual(expect.objectContaining({ type: 'addRef' }));
    expect(h.posted).toContainEqual({ type: 'focus_input' });
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
    // HOST-CTX-16：取消收场只发焦点归还**一条**——不发 addRef（不挂引用）、@ 留正文。
    // 「有且仅有一条」是强断言：既防漏发（焦点丢失、用户得点鼠标），也防多发（误挂引用）。
    // （CTX-16 前的旧断言是 toHaveLength(0)——焦点归还是新增的、唯一的合法 post）
    expect(h.posted).toEqual([{ type: 'focus_input' }]);
  });

  it('findFiles 命中上限 → placeholder 明示已截断 + 原因（HOST-CTX-11/14：大仓搜不到目标还以为没有该文件）', async () => {
    const h = setup();
    // 恰好 = 上限即视为「可能截断」（不截断的极小概率也在提示范围内：多一句提示远好过找不到）
    const many = Array.from(
      { length: MENTION_FILE_LIMIT },
      (_, i) => ({ fsPath: `C:/root/src/f${i}.ts` }) as vscode.Uri,
    );
    (vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue(many);
    const qp = stubQuickPick([]);
    const p = h.cast.openMentionQuickPick();
    await vi.waitFor(() => expect(qp.onDidHide).toHaveBeenCalled());
    expect(qp.placeholder).toContain('已截断');
    // HOST-CTX-14：截断须交代原因——「内置忽略目录已排除、仍超限」。只说超上限时，
    // 用户会以为额度被无关文件占着（那正是本项修掉的旧形态），徒劳换关键词。
    expect(qp.placeholder).toContain('忽略目录已排除');
    (qp.onDidHide.mock.calls[0][0] as () => void)();
    await p;
  });

  it('findFiles 显式排除内置忽略目录（HOST-CTX-14：undefined 排除会让 node_modules 挤占上限）', async () => {
    const h = setup();
    (vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const qp = stubQuickPick([]);
    const p = h.cast.openMentionQuickPick();
    await vi.waitFor(() => expect(qp.onDidHide).toHaveBeenCalled());
    (qp.onDidHide.mock.calls[0][0] as () => void)();
    await p;
    const findFiles = vscode.workspace.findFiles as ReturnType<typeof vi.fn>;
    // include / maxResults 字面量照旧；exclude 是被测契约位
    expect(findFiles).toHaveBeenCalledWith('**/*', expect.any(String), MENTION_FILE_LIMIT);
    // 黄金串字面量写死（与内核 IGNORED_DIR_NAMES 逐条对应，不 import 被测常量——镜像断言
    // 两边同错照样绿）。内核新增忽略目录时本例先红，逼一次跨包同步的有意识决策。
    const excludeArg = findFiles.mock.calls[0]![1] as string;
    expect(excludeArg.split(',')).toEqual([
      '**/.git/**',
      '**/node_modules/**',
      '**/.memora/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.next/**',
    ]);
  });

  it('in-flight 中第二次调用静默返回：不重开 QuickPick、无 post（HOST-CTX-11：防连按 @ 覆盖）', async () => {
    const h = setup();
    // findFiles 用一个可手动放行的 Promise 把第一次调用摁在 await 上，制造「列表正开着」
    let releaseFind: (uris: vscode.Uri[]) => void = () => {};
    (vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<vscode.Uri[]>((resolve) => {
        releaseFind = resolve;
      }),
    );
    const qp = stubQuickPick([]);
    const first = h.cast.openMentionQuickPick();
    // 第二次（连按 @ 的第二个 mention_open）：此刻 _mentionQuickPickOpen=true，必须直接返回
    await h.cast.openMentionQuickPick();
    expect(vscode.window.createQuickPick).not.toHaveBeenCalled();
    expect(h.posted).toHaveLength(0);
    // 放行第一次：它应当正常走完（createQuickPick 只被调一次）并经 hide 收场、标志归位
    releaseFind([{ fsPath: 'C:/root/src/a.ts' } as vscode.Uri]);
    await vi.waitFor(() => expect(qp.onDidHide).toHaveBeenCalled());
    (qp.onDidHide.mock.calls[0][0] as () => void)();
    await first;
    expect(vscode.window.createQuickPick).toHaveBeenCalledTimes(1);
    // 标志归位：收场后再来一条可以正常开（守卫不焊死门）
    const second = h.cast.openMentionQuickPick();
    await vi.waitFor(() => expect(vscode.window.createQuickPick).toHaveBeenCalledTimes(2));
    (qp.onDidHide.mock.calls[1][0] as () => void)();
    await second;
  });

  it('未知消息类型 → 落宿主 warn 而非静默丢弃（HOST-CTX-12：webview 新/宿主旧时唯一线索）', () => {
    const h = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 直接经 onDidReceiveMessage 入口派发一个不在协议内的类型——正常不可能到达，
    // 一旦到达即 webview 脚本与扩展宿主不同版本（最常见：重编译了 dist 没重启宿主）
    h.dispatch({ type: 'not_a_real_message_type' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not_a_real_message_type'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('扩展宿主未重启'));
    warn.mockRestore();
  });
});
