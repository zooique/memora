/**
 * FileChangeView 注册守卫 + 装饰存活守卫（mock vscode · node 环境）
 *
 * 该模块的注册/渲染路径**此前零自动化覆盖**，而已连出两次真机 bug（装饰未移动视口、
 * 「切到别的文件再切回来，高亮全没、只剩按钮」）。后者根因是 **VS Code 的装饰项绑定在
 * 编辑器实例上**——切走再切回不会自动恢复；而 CodeLens 走 provider 模式
 * （`provideCodeLenses` 由 VS Code 主动调用）不受影响 ⇒ 现场表现就是「高亮丢了、按钮还在」。
 *
 * 本用例钉死两条可机检的不变量（都属「遗漏型」缺陷，单测足以防住）：
 *   ① `register()` 必须注册 `onDidChangeVisibleTextEditors` 监听；
 *   ② 该监听触发时，对每个显示着已追踪文件的可见编辑器**重设装饰**（分屏/多编辑器亦须覆盖）。
 *
 * @module __tests__/fileChangeView.test
 */

import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    visible: [] as unknown[],
    listeners: [] as (() => void)[],
    setCalls: [] as number[],
    /** `workspace.textDocuments`（回退前查「未保存编辑」用；元素需含 uri.fsPath / isDirty） */
    documents: [] as unknown[],
    /** 下一次 `showWarningMessage` 的返回值（undefined = 用户取消/关闭） */
    warningChoice: undefined as string | undefined,
    /** 模态调用留痕（断言「弹了几次、是否 modal、明细说了什么」） */
    warningCalls: [] as { message: string; modal: boolean; detail: string }[],
    /** `registerCommand` 捕获的命令处理器（测试经真实命令路径触发回退） */
    commands: new Map<string, (...args: unknown[]) => unknown>(),
    /** `atomicWriteFileSync` 捕获的写盘（断言「回退写了什么」而不真写文件系统） */
    writes: [] as { path: string; content: string }[],
  };
  class MockEventEmitter {
    private listeners: ((value: unknown) => void)[] = [];
    readonly event = (listener: (value: unknown) => void): { dispose(): void } => {
      this.listeners.push(listener);
      return { dispose: (): void => undefined };
    };
    fire(value: unknown): void {
      for (const listener of this.listeners) listener(value);
    }
    dispose(): void {
      this.listeners = [];
    }
  }
  return { state, MockEventEmitter };
});

/** 回退写盘不真碰文件系统：捕获调用参数即可断言语义（写回的内容 = 改动前快照） */
vi.mock('../atomicWriteSync.js', () => ({
  atomicWriteFileSync: (path: string, content: string): void => {
    h.state.writes.push({ path, content });
  },
}));

vi.mock('vscode', () => ({
  EventEmitter: h.MockEventEmitter,
  CodeLens: class {
    constructor(
      readonly range: unknown,
      readonly command: unknown,
    ) {}
  },
  MarkdownString: class {
    appendMarkdown(): void {}
    appendCodeblock(): void {}
  },
  Range: class {
    readonly isEmpty = false;
    constructor(..._args: unknown[]) {}
  },
  ThemeColor: class {
    constructor(readonly id: string) {}
  },
  // `releaseVirtual` 会经 `Uri.from(...).toString()` 构造虚拟文档键，只需可字符串化
  Uri: {
    from: (parts: { scheme: string; path: string }): { toString(): string } => ({
      toString: (): string => `${parts.scheme}:${parts.path}`,
    }),
    file: (p: string): { fsPath: string; toString(): string } => ({
      fsPath: p,
      toString: (): string => `file:${p}`,
    }),
  },
  StatusBarAlignment: { Left: 1 },
  OverviewRulerLane: { Left: 1 },
  TextEditorRevealType: { InCenter: 1 },
  workspace: {
    registerTextDocumentContentProvider: (): { dispose(): void } => ({ dispose: (): void => undefined }),
    get textDocuments(): unknown[] {
      return h.state.documents;
    },
    visibleTextEditors: [] as unknown[],
  },
  languages: {
    registerCodeLensProvider: (): { dispose(): void } => ({ dispose: (): void => undefined }),
  },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown): { dispose(): void } => {
      h.state.commands.set(id, handler);
      return { dispose: (): void => undefined };
    },
    executeCommand: async (): Promise<void> => undefined,
  },
  window: {
    onDidChangeVisibleTextEditors: (callback: () => void): { dispose(): void } => {
      h.state.listeners.push(callback);
      return { dispose: (): void => undefined };
    },
    get visibleTextEditors(): unknown[] {
      return h.state.visible;
    },
    get activeTextEditor(): unknown {
      return h.state.visible[0];
    },
    createTextEditorDecorationType: (): { dispose(): void } => ({ dispose: (): void => undefined }),
    createStatusBarItem: (): Record<string, unknown> => ({
      show: (): void => undefined,
      hide: (): void => undefined,
      dispose: (): void => undefined,
      text: '',
      tooltip: '',
      name: '',
      command: '',
    }),
    showInformationMessage: async (): Promise<undefined> => undefined,
    showWarningMessage: async (
      message: string,
      opts?: { modal?: boolean; detail?: string },
    ): Promise<string | undefined> => {
      h.state.warningCalls.push({ message, modal: opts?.modal ?? false, detail: opts?.detail ?? '' });
      return h.state.warningChoice;
    },
    showErrorMessage: async (): Promise<undefined> => undefined,
  },
}));

import type { ExtensionContext } from 'vscode';
import {
  FileChangeView,
  REVERT_ALL_FILE_CHANGES_COMMAND,
  RESTORE_INLINE_COMMAND,
  type FileChangeSecurityGuard,
  type FileChangeViewDeps,
} from '../fileChangeView.js';
import { FileChangeTracker, type FileChangeIO } from '../fileChangeTracker.js';

const ROOT = resolve('/proj');
const REL = 'a.md';
/**
 * 追踪器的记录键 = `resolve(ROOT, REL)`——**必须用同一套解析**（与 `fileChangeTracker` 同源），
 * 否则 Windows 下会变成 `\proj\a.md` 与手写的 `/proj/a.md` 对不上，guard 变成假绿/假红。
 */
const FILE = resolve(ROOT, REL);
/** 第二个文件的绝对路径（批量回退用例；解析纪律同上） */
const FILE_B = resolve(ROOT, 'b.md');

/** 假文档：`safeLineRange` 只用到 `uri` / `lineCount` / `lineAt().range` / `getText`；`isDirty` 供 W2 守卫判定 */
function makeDoc(text: string, opts: { fsPath?: string; isDirty?: boolean } = {}): Record<string, unknown> {
  const lines = text === '' ? [] : text.split('\n');
  return {
    uri: { scheme: 'file', fsPath: opts.fsPath ?? FILE, toString: (): string => 'file:///proj/a.md' },
    isDirty: opts.isDirty ?? false,
    lineCount: lines.length,
    getText: (): string => text,
    lineAt: (): { range: { isEmpty: boolean } } => ({ range: { isEmpty: false } }),
  };
}

function makeEditor(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    document: doc,
    setDecorations: (_type: unknown, items: unknown[]): void => {
      h.state.setCalls.push(items.length);
    },
    revealRange: (): void => undefined,
  };
}

/** 放行路径校验的安全守卫桩（W2 用例关注「未保存编辑」闸，不关心路径白名单） */
function guardAllowsAll(): FileChangeSecurityGuard {
  return { assertPathAllowed: (): void => undefined };
}

/** 造一个 FileChangeView + 可控磁盘内容（`setDisk` 模拟内核写盘）；守卫默认未就绪 */
function makeView(opts: { getSecurityGuard?: () => FileChangeSecurityGuard | undefined } = {}): {
  view: FileChangeView;
  tracker: FileChangeTracker;
  setDisk: (content: string) => void;
} {
  let disk = '';
  const io: FileChangeIO = { readTextFile: (): string => disk };
  const tracker = new FileChangeTracker(ROOT, { io, now: (): number => 1 });
  const deps: FileChangeViewDeps = {
    getSecurityGuard: opts.getSecurityGuard ?? ((): undefined => undefined),
    isConfirmWrites: (): boolean => false,
    log: (): void => undefined,
  };
  return { view: new FileChangeView(tracker, deps), tracker, setDisk: (content: string): void => void (disk = content) };
}

/** 登记一次「已有文件的写入」：写前 v0 → 写后 v1（`rel` / `callId` 可换，批量用例用第二个文件） */
function recordOneWrite(tracker: FileChangeTracker, setDisk: (content: string) => void, rel = REL, callId = 't1'): void {
  setDisk('v0');
  tracker.noteToolStart({ toolCallId: callId, name: 'write_file', args: JSON.stringify({ path: rel }) });
  setDisk('v1');
  tracker.noteToolResult({ toolCallId: callId, name: 'write_file', ok: true });
}

const makeContext = (): ExtensionContext => ({ subscriptions: [] }) as unknown as ExtensionContext;

beforeEach(() => {
  h.state.visible = [];
  h.state.listeners = [];
  h.state.setCalls = [];
  h.state.documents = [];
  h.state.warningChoice = undefined;
  h.state.warningCalls = [];
  h.state.commands = new Map();
  h.state.writes = [];
});

describe('FileChangeView · 编辑器可见性（真机「切走再切回高亮丢失」守卫）', () => {
  it('register 必须注册「可见编辑器变化」监听（删掉它 = 切回后装饰不再恢复）', () => {
    const { view } = makeView();
    view.register(makeContext());
    expect(h.state.listeners.length).toBe(1);
  });

  it('可见编辑器变化 → 对已追踪文件的每个可见编辑器重设装饰', () => {
    const { view, tracker, setDisk } = makeView();
    recordOneWrite(tracker, setDisk);
    view.register(makeContext());

    const doc = makeDoc('v1');
    h.state.visible = [makeEditor(doc)];
    for (const listener of h.state.listeners) listener();

    expect(h.state.setCalls.length).toBe(1);
    expect(h.state.setCalls[0]).toBeGreaterThan(0);
  });

  it('同一文档在多个编辑器中（分屏）→ 每个编辑器都要设到装饰', () => {
    const { view, tracker, setDisk } = makeView();
    recordOneWrite(tracker, setDisk);
    view.register(makeContext());

    const doc = makeDoc('v1');
    h.state.visible = [makeEditor(doc), makeEditor(doc)];
    for (const listener of h.state.listeners) listener();

    // 装饰项是 per-editor 的，只设一个会让另一个编辑器看不到高亮
    expect(h.state.setCalls.length).toBe(2);
  });

  it('无记录的可见文件不设装饰（不误伤无关文件）', () => {
    const { view } = makeView();
    view.register(makeContext());

    h.state.visible = [makeEditor(makeDoc('unrelated'))];
    for (const listener of h.state.listeners) listener();

    expect(h.state.setCalls.length).toBe(0);
  });
});

/**
 * W2 守卫：回退遇「未保存编辑（dirty）」必须**先经模态确认**，否则静默覆盖 = 吃掉用户劳动。
 *
 * 全部用例都走**真实命令路径**（`registerCommand` 捕获的处理器），不私下调内部方法——
 * 变异验证靠「删掉 fail-closed 闸后这些断言变红」证明守卫真在生产路径上生效。
 */
describe('FileChangeView · 回退的未保存编辑守卫', () => {
  it('干净文档回退：不弹模态、直接写回改动前内容、注销记录', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordOneWrite(tracker, setDisk);
    view.register(makeContext());
    // 文档**已打开但未修改**（isDirty=false）≠ 有未保存编辑，不该弹模态
    h.state.documents = [makeDoc('v1')];

    h.state.commands.get(RESTORE_INLINE_COMMAND)?.(FILE);

    await vi.waitFor(() => {
      expect(h.state.writes).toEqual([{ path: FILE, content: 'v0' }]);
    });
    expect(h.state.warningCalls.length).toBe(0);
    expect(tracker.size()).toBe(0);
  });

  it('有未保存编辑 → 弹模态确认；用户取消 → 不写盘、记录保留', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordOneWrite(tracker, setDisk);
    view.register(makeContext());
    h.state.documents = [makeDoc('用户未保存的编辑', { isDirty: true })];
    h.state.warningChoice = undefined; // 用户取消 / 关闭弹窗

    h.state.commands.get(RESTORE_INLINE_COMMAND)?.(FILE);

    await vi.waitFor(() => {
      expect(h.state.warningCalls.length).toBe(1);
    });
    // 模态 + 明细说清「会丢弃未保存编辑」
    expect(h.state.warningCalls[0].modal).toBe(true);
    expect(h.state.warningCalls[0].detail).toContain('未保存');
    // 静默覆盖的反面：盘没动、记录还在
    expect(h.state.writes.length).toBe(0);
    expect(tracker.size()).toBe(1);
  });

  it('有未保存编辑 + 确认「仍然回退」→ 写回并注销（模态只弹一次）', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordOneWrite(tracker, setDisk);
    view.register(makeContext());
    h.state.documents = [makeDoc('用户未保存的编辑', { isDirty: true })];
    h.state.warningChoice = '仍然回退';

    h.state.commands.get(RESTORE_INLINE_COMMAND)?.(FILE);

    await vi.waitFor(() => {
      expect(h.state.writes).toEqual([{ path: FILE, content: 'v0' }]);
    });
    expect(h.state.warningCalls.length).toBe(1);
    expect(tracker.size()).toBe(0);
  });

  it('批量回退：dirty 文件在同一个模态里一次列出、只弹一次，随后逐个写回', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordOneWrite(tracker, setDisk, REL, 't1');
    recordOneWrite(tracker, setDisk, 'b.md', 't2');
    view.register(makeContext());
    h.state.documents = [
      makeDoc('未保存编辑 A', { isDirty: true }),
      makeDoc('未保存编辑 B', { fsPath: FILE_B, isDirty: true }),
    ];
    h.state.warningChoice = '确认回退';

    h.state.commands.get(REVERT_ALL_FILE_CHANGES_COMMAND)?.();

    await vi.waitFor(() => {
      expect(h.state.writes.length).toBe(2);
    });
    // 只弹一次模态（批量不逐个追问），且明细里列出两个文件与「含未保存的编辑」计数
    expect(h.state.warningCalls.length).toBe(1);
    expect(h.state.warningCalls[0].detail).toContain('含未保存的编辑（会一并丢弃）：2 个');
    expect(h.state.warningCalls[0].detail).toContain(REL);
    expect(h.state.warningCalls[0].detail).toContain('b.md');
    expect(h.state.writes.map((w) => w.path)).toEqual(expect.arrayContaining([FILE, FILE_B]));
    expect(tracker.size()).toBe(0);
  });
});
