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
  StatusBarAlignment: { Left: 1 },
  OverviewRulerLane: { Left: 1 },
  TextEditorRevealType: { InCenter: 1 },
  workspace: {
    registerTextDocumentContentProvider: (): { dispose(): void } => ({ dispose: (): void => undefined }),
    visibleTextEditors: [] as unknown[],
  },
  languages: {
    registerCodeLensProvider: (): { dispose(): void } => ({ dispose: (): void => undefined }),
  },
  commands: {
    registerCommand: (): { dispose(): void } => ({ dispose: (): void => undefined }),
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
    showWarningMessage: async (): Promise<undefined> => undefined,
    showErrorMessage: async (): Promise<undefined> => undefined,
  },
}));

import type { ExtensionContext } from 'vscode';
import { FileChangeView, type FileChangeViewDeps } from '../fileChangeView.js';
import { FileChangeTracker, type FileChangeIO } from '../fileChangeTracker.js';

const ROOT = resolve('/proj');
const REL = 'a.md';
/**
 * 追踪器的记录键 = `resolve(ROOT, REL)`——**必须用同一套解析**（与 `fileChangeTracker` 同源），
 * 否则 Windows 下会变成 `\proj\a.md` 与手写的 `/proj/a.md` 对不上，guard 变成假绿/假红。
 */
const FILE = resolve(ROOT, REL);

/** 假文档：`safeLineRange` 只用到 `uri` / `lineCount` / `lineAt().range` / `getText` */
function makeDoc(text: string): Record<string, unknown> {
  const lines = text === '' ? [] : text.split('\n');
  return {
    uri: { scheme: 'file', fsPath: FILE, toString: (): string => 'file:///proj/a.md' },
    isDirty: false,
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

/** 造一个 FileChangeView + 可控磁盘内容（`setDisk` 模拟内核写盘） */
function makeView(): { view: FileChangeView; tracker: FileChangeTracker; setDisk: (content: string) => void } {
  let disk = '';
  const io: FileChangeIO = { readTextFile: (): string => disk };
  const tracker = new FileChangeTracker(ROOT, { io, now: (): number => 1 });
  const deps: FileChangeViewDeps = {
    getSecurityGuard: (): undefined => undefined,
    isConfirmWrites: (): boolean => false,
    log: (): void => undefined,
  };
  return { view: new FileChangeView(tracker, deps), tracker, setDisk: (content: string): void => void (disk = content) };
}

/** 登记一次「已有文件的写入」：写前 v0 → 写后 v1 */
function recordOneWrite(tracker: FileChangeTracker, setDisk: (content: string) => void): void {
  setDisk('v0');
  tracker.noteToolStart({ toolCallId: 't1', name: 'write_file', args: JSON.stringify({ path: REL }) });
  setDisk('v1');
  tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });
}

const makeContext = (): ExtensionContext => ({ subscriptions: [] }) as unknown as ExtensionContext;

beforeEach(() => {
  h.state.visible = [];
  h.state.listeners = [];
  h.state.setCalls = [];
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
