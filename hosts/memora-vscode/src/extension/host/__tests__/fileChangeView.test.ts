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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const state = {
    visible: [] as unknown[],
    listeners: [] as (() => void)[],
    setCalls: [] as number[],
    /** `setDecorations` 收到的**装饰项本体**（断言「装饰里到底挂了什么」） */
    decorationItems: [] as unknown[][],
    /** `createTextEditorDecorationType` 收到的 options（断言红/绿装饰的语义分流） */
    decorationTypes: [] as { options: unknown; dispose: () => void }[],
    /** `setDecorations` 的 (type, items) 配对留痕（断言「哪批 items 挂在哪个颜色上」） */
    decorationCalls: [] as { type: unknown; items: unknown[] }[],
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
    /** `showInformationMessage` 留痕（对比预览的「跳过提示」经它发出） */
    infoCalls: [] as string[],
    /** 下一次 `showInformationMessage` 的返回值（模拟改动通知上的按钮选择） */
    infoChoice: undefined as string | undefined,
    /** `executeCommand` 留痕（断言「是否真的开了 vscode.diff」） */
    executed: [] as string[],
    /** `executeCommand` 的**参数**留痕（断言 vscode.diff 的左右两栏分别是什么） */
    commandArgs: [] as { cmd: string; args: unknown[] }[],
    /** 安全守卫收到的 tool 名（审计口径：删除动作不得记成 write_file） */
    guardCalls: [] as (string | undefined)[],
    /** `registerCodeLensProvider` 捕获的 provider（断言块级按钮的粒度与落点） */
    lensProvider: undefined as unknown,
    /** `onDidChangeActiveTextEditor` 监听（标题栏按钮显隐依赖它） */
    activeListeners: [] as (() => void)[],
    /** `deps.log` 留痕（断言 fail-closed 真的留了痕，不是静默吞） */
    logs: [] as string[],
    /** `setContext` 调用留痕（标题栏按钮显隐的开关） */
    contextCalls: [] as { key: string; value: boolean }[],
    /** `registerTextDocumentContentProvider` 捕获的 provider（读「对照」虚拟文档的正文用） */
    contentProvider: undefined as unknown,
    /** `showTextDocument` 收到的目标（`toString()`：虚拟文档 = `memora-diff:…`） */
    opened: [] as string[],
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
  // 记录起始行：`safeLineRange` 的返回值要能被断言「按钮挂在哪一行」
  Range: class {
    readonly isEmpty = false;
    readonly line: number;
    constructor(startLine: number, ..._args: unknown[]) {
      this.line = startLine;
    }
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
    registerTextDocumentContentProvider: (
      _scheme: string,
      provider: unknown,
    ): { dispose(): void } => {
      h.state.contentProvider = provider;
      return { dispose: (): void => undefined };
    },
    get textDocuments(): unknown[] {
      return h.state.documents;
    },
    visibleTextEditors: [] as unknown[],
  },
  languages: {
    registerCodeLensProvider: (_sel: unknown, provider: unknown): { dispose(): void } => {
      h.state.lensProvider = provider;
      return { dispose: (): void => undefined };
    },
  },
  commands: {
    registerCommand: (
      id: string,
      handler: (...args: unknown[]) => unknown,
    ): { dispose(): void } => {
      h.state.commands.set(id, handler);
      return { dispose: (): void => undefined };
    },
    executeCommand: async (cmd: string, ...args: unknown[]): Promise<void> => {
      h.state.executed.push(cmd);
      h.state.commandArgs.push({ cmd, args });
      if (cmd === 'setContext') {
        h.state.contextCalls.push({ key: String(args[0]), value: args[1] === true });
      }
    },
  },
  window: {
    onDidChangeVisibleTextEditors: (callback: () => void): { dispose(): void } => {
      h.state.listeners.push(callback);
      return { dispose: (): void => undefined };
    },
    onDidChangeActiveTextEditor: (callback: () => void): { dispose(): void } => {
      h.state.activeListeners.push(callback);
      return { dispose: (): void => undefined };
    },
    get visibleTextEditors(): unknown[] {
      return h.state.visible;
    },
    get activeTextEditor(): unknown {
      return h.state.visible[0];
    },
    createTextEditorDecorationType: (options: unknown): { options: unknown; dispose(): void } => {
      const type = { options, dispose: (): void => undefined };
      h.state.decorationTypes.push(type);
      return type;
    },
    createStatusBarItem: (): Record<string, unknown> => ({
      show: (): void => undefined,
      hide: (): void => undefined,
      dispose: (): void => undefined,
      text: '',
      tooltip: '',
      name: '',
      command: '',
    }),
    showInformationMessage: async (message: string): Promise<string | undefined> => {
      h.state.infoCalls.push(message);
      return h.state.infoChoice;
    },
    showWarningMessage: async (
      message: string,
      opts?: { modal?: boolean; detail?: string },
    ): Promise<string | undefined> => {
      h.state.warningCalls.push({
        message,
        modal: opts?.modal ?? false,
        detail: opts?.detail ?? '',
      });
      return h.state.warningChoice;
    },
    showErrorMessage: async (): Promise<undefined> => undefined,
    showTextDocument: async (target: unknown): Promise<undefined> => {
      const label = target as { toString?: () => string } | undefined;
      h.state.opened.push(
        typeof label?.toString === 'function' ? label.toString() : String(target),
      );
      return undefined;
    },
  },
}));

import type { ExtensionContext } from 'vscode';
// 阈值取内核导出面（宿主消费同一常量，不并列副本）
import { MAX_DIFF_CONTENT_LENGTH } from '@zooique/memora';
import {
  FileChangeView,
  CONFIRM_ALL_FILE_CHANGES_COMMAND,
  CONFIRM_FILE_COMMAND,
  CONFIRM_HUNK_COMMAND,
  PENDING_CONTEXT_KEY,
  REJECT_HUNK_COMMAND,
  RESTORE_FILE_COMMAND,
  REVERT_ALL_FILE_CHANGES_COMMAND,
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
function makeDoc(
  text: string,
  opts: { fsPath?: string; isDirty?: boolean } = {},
): Record<string, unknown> {
  const lines = text === '' ? [] : text.split('\n');
  return {
    uri: {
      scheme: 'file',
      fsPath: opts.fsPath ?? FILE,
      toString: (): string => 'file:///proj/a.md',
    },
    isDirty: opts.isDirty ?? false,
    lineCount: lines.length,
    getText: (): string => text,
    lineAt: (line: number): { range: { isEmpty: boolean; line: number } } => ({
      range: { isEmpty: false, line },
    }),
  };
}

function makeEditor(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    document: doc,
    setDecorations: (type: unknown, items: unknown[]): void => {
      h.state.setCalls.push(items.length);
      h.state.decorationItems.push(items);
      h.state.decorationCalls.push({ type, items });
    },
    revealRange: (): void => undefined,
  };
}

/** 放行路径校验的安全守卫桩（W2 用例关注「未保存编辑」闸，不关心路径白名单）；记录 tool 名供审计口径断言 */
function guardAllowsAll(): FileChangeSecurityGuard {
  return {
    assertPathAllowed: (_path: string, tool?: string): void => {
      h.state.guardCalls.push(tool);
    },
  };
}

/** 造一个 FileChangeView + 可控磁盘内容（`setDisk` 模拟内核写盘）；守卫默认未就绪 */
function makeView(opts: { getSecurityGuard?: () => FileChangeSecurityGuard | undefined } = {}): {
  view: FileChangeView;
  tracker: FileChangeTracker;
  /** 模拟磁盘内容；传 null = 文件不存在（delete_file 场景） */
  setDisk: (content: string | null) => void;
} {
  let disk: string | null = '';
  const io: FileChangeIO = { readTextFile: (): string | null => disk };
  const tracker = new FileChangeTracker(ROOT, { io, now: (): number => 1 });
  const deps: FileChangeViewDeps = {
    getSecurityGuard: opts.getSecurityGuard ?? ((): undefined => undefined),
    isConfirmWrites: (): boolean => false,
    log: (message: string): void => void h.state.logs.push(message),
  };
  return {
    view: new FileChangeView(tracker, deps),
    tracker,
    setDisk: (content: string | null): void => void (disk = content),
  };
}

/** 登记一次「已有文件的写入」：写前 v0 → 写后 v1（`rel` / `callId` 可换，批量用例用第二个文件） */
function recordOneWrite(
  tracker: FileChangeTracker,
  setDisk: (content: string) => void,
  rel = REL,
  callId = 't1',
): void {
  setDisk('v0');
  tracker.noteToolStart({
    toolCallId: callId,
    name: 'write_file',
    args: JSON.stringify({ path: rel }),
  });
  setDisk('v1');
  tracker.noteToolResult({ toolCallId: callId, name: 'write_file', ok: true });
}

const makeContext = (): ExtensionContext => ({ subscriptions: [] }) as unknown as ExtensionContext;

beforeEach(() => {
  h.state.visible = [];
  h.state.listeners = [];
  h.state.setCalls = [];
  h.state.decorationItems = [];
  h.state.decorationTypes = [];
  h.state.decorationCalls = [];
  h.state.documents = [];
  h.state.warningChoice = undefined;
  h.state.warningCalls = [];
  h.state.commands = new Map();
  h.state.writes = [];
  h.state.infoCalls = [];
  h.state.infoChoice = undefined;
  h.state.executed = [];
  h.state.commandArgs = [];
  h.state.guardCalls = [];
  h.state.lensProvider = undefined;
  h.state.activeListeners = [];
  h.state.logs = [];
  h.state.contextCalls = [];
  h.state.contentProvider = undefined;
  h.state.opened = [];
});

describe('FileChangeView · 编辑器可见性（真机「切走再切回高亮丢失」守卫）', () => {
  it('register 必须注册「可见编辑器变化」监听（删掉它 = 切回后装饰不再恢复）', () => {
    const { view } = makeView();
    view.register(makeContext());
    expect(h.state.listeners.length).toBe(1);
  });

  it('register 必须注册「活动编辑器变化」监听（删掉它 = 标题栏按钮显隐不跟随）', () => {
    const { view } = makeView();
    view.register(makeContext());
    expect(h.state.activeListeners.length).toBe(1);
  });

  it('register 后立即同步标题栏显隐上下文键（否则首屏按钮不出现）', () => {
    const { view, tracker, setDisk } = makeView();
    recordOneWrite(tracker, setDisk);
    // 活动编辑器 = 被改动的文件 ⇒ 上下文键应为 true
    h.state.visible = [makeEditor(makeDoc('v1'))];
    view.register(makeContext());
    // setContext 走 executeCommand：上下文键与取值都被留痕，可断言
    expect(h.state.contextCalls).toEqual([{ key: PENDING_CONTEXT_KEY, value: true }]);
  });

  it('活动文件没有未确认改动 → 上下文键为 false（标题栏不挂按钮）', () => {
    const { view } = makeView();
    h.state.visible = [makeEditor(makeDoc('unrelated'))];
    view.register(makeContext());
    expect(h.state.contextCalls.at(-1)).toEqual({ key: PENDING_CONTEXT_KEY, value: false });
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
 * 内联装饰 = **只高亮 + 悬停**，不挂行尾常驻旧内容
 *
 * 2026-09-28 真机反馈：行尾那行红色删除线「⟵ 原: …」与 hover 说的是同一件事，却长期占着版面
 * ⇒ 视觉噪音，已删。守卫盯 `renderOptions`（行尾附件的**唯一**载体）：谁把它加回来，本用例即红。
 * 同时钉死 `hoverMessage` **仍在**——它是「改动前原内容」的唯一查看入口，不能跟着一起删。
 */
describe('FileChangeView · 内联装饰不挂行尾旧内容', () => {
  it('装饰项带 hoverMessage，但**不带** renderOptions（行尾预览已删）', () => {
    const { view, tracker, setDisk } = makeView();
    recordOneWrite(tracker, setDisk); // v0 → v1，一处改动
    view.register(makeContext());

    const doc = makeDoc('v1');
    h.state.visible = [makeEditor(doc)];
    for (const listener of h.state.listeners) listener();

    expect(h.state.decorationItems.length).toBe(1);
    const items = h.state.decorationItems[0] as Record<string, unknown>[];
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.renderOptions).toBeUndefined();
    // hover 必须还在：旧内容只在内存里，hover 是用户看它的唯一入口
    expect(items[0]?.hoverMessage).toBeDefined();
  });
});

/**
 * 装饰颜色语义守卫（2026-09-28「选择性吸收 Trae 对照效果」收口）：
 * 纯删除块此前复用绿色装饰 =「删除点被染成新增色」的语义错位——绿底直觉是「这行是新内容」，
 * 但删除锚行本身是**未变的其他内容**。收口为两侧分流：新增/修改走绿，纯删除锚行走红
 * （红竖条主信号 + 极淡红底 + 悬停旧内容）。守卫盯三个不变量：
 * ① 绿/红两侧各建一个装饰类型（变异：删掉 removedHighlightOptions → 用例一红）；
 * ② 空侧不调 setDecorations（空批 = 噪音，「有几批装饰」的断言不该去数空批）；
 * ③ 红侧 hover 仍在（旧内容的唯一查看入口，不能跟着换色一起丢）。
 */
describe('FileChangeView · 装饰颜色语义（新增绿 / 删除红）', () => {
  it('修改/新增块挂在绿色装饰，红色侧为空则不产生调用', () => {
    const { view, tracker, setDisk } = makeView();
    recordOneWrite(tracker, setDisk); // v0 → v1，一处改动（无纯删除）
    view.register(makeContext());
    h.state.visible = [makeEditor(makeDoc('v1'))];
    for (const listener of h.state.listeners) listener();

    const bg = (t: { options: unknown }): string =>
      String((t.options as Record<string, unknown>).backgroundColor);
    const green = h.state.decorationTypes.filter((t) => bg(t).includes('46, 160, 67'));
    const red = h.state.decorationTypes.filter((t) => bg(t).includes('248, 81, 73'));
    expect(green.length).toBe(1);
    expect(red.length).toBe(1);
    expect(h.state.decorationCalls.length).toBe(1);
    expect(h.state.decorationCalls[0].type).toBe(green[0]);
  });

  it('纯删除块挂在红色装饰，且 hover 旧内容仍在', () => {
    const { view, tracker, setDisk } = makeView();
    // v0 三行 → v1 删掉中间一行 = 纯删除块（新文件里不覆盖任何行）
    setDisk('a\nb\nc');
    tracker.noteToolStart({
      toolCallId: 't-del',
      name: 'write_file',
      args: JSON.stringify({ path: REL }),
    });
    setDisk('a\nc');
    tracker.noteToolResult({ toolCallId: 't-del', name: 'write_file', ok: true });
    view.register(makeContext());
    h.state.visible = [makeEditor(makeDoc('a\nc'))];
    for (const listener of h.state.listeners) listener();

    const bg = (t: { options: unknown }): string =>
      String((t.options as Record<string, unknown>).backgroundColor);
    const red = h.state.decorationTypes.find((t) => bg(t).includes('248, 81, 73'));
    expect(red).toBeDefined();
    const redCall = h.state.decorationCalls.find((c) => c.type === red);
    if (!redCall) throw new Error('红侧 setDecorations 未被调用（纯删除块未标记）');
    const items = redCall.items as Record<string, unknown>[];
    expect(items.length).toBe(1); // 恰好一个删除锚行
    expect(items[0].renderOptions).toBeUndefined(); // 行尾预览已删，hover-only 不回潮
    expect(items[0].hoverMessage).toBeDefined(); // 旧内容的唯一查看入口
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

    h.state.commands.get(RESTORE_FILE_COMMAND)?.(FILE);

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

    h.state.commands.get(RESTORE_FILE_COMMAND)?.(FILE);

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

    h.state.commands.get(RESTORE_FILE_COMMAND)?.(FILE);

    await vi.waitFor(() => {
      expect(h.state.writes).toEqual([{ path: FILE, content: 'v0' }]);
    });
    expect(h.state.warningCalls.length).toBe(1);
    expect(tracker.size()).toBe(0);
  });

  it('回退「原为新建」的文件 → 走删除分支，审计 tool 名记为 delete_file', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    view.register(makeContext());
    // 写前不存在 ⇒ beforeContent = null ⇒ 回退语义 = 删掉这个新建的文件
    setDisk(null);
    tracker.noteToolStart({
      toolCallId: 'n1',
      name: 'write_file',
      args: JSON.stringify({ path: REL }),
    });
    setDisk('new content');
    view.noteToolResult({ toolCallId: 'n1', name: 'write_file', ok: true });
    expect(tracker.get(FILE)?.beforeContent).toBeNull();

    h.state.commands.get(RESTORE_FILE_COMMAND)?.(FILE);

    // 删除分支走 `rmSync(force)`：测试路径本就不在磁盘上，不碰真实文件系统
    await vi.waitFor(() => {
      expect(tracker.size()).toBe(0);
    });
    expect(h.state.writes.length).toBe(0); // 不是覆盖写回
    expect(h.state.guardCalls).toContain('delete_file');
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

/**
 * 正文里按钮的**粒度与落点**（2026-09-27 真机反馈：按块独立显示按钮）
 *
 * 三层粒度各归其位：跨文件 = 会话区常驻条 / 状态栏 / 命令面板；单文件 = 编辑器标题栏；
 * 单处 = 正文里的块级 CodeLens。钉死的是「正文里**只有**块级动作」——
 * 在正文里摆文件级 / 跨文件按钮就是 §11.3 已判过的那类粒度混淆真伤。
 */
/** 登记一次「两处改动」的写入：写前 a/b/c/d/e → 写后 a/X/c/Y/e（第 1、3 行被改，0-based） */
function recordTwoHunkWrite(tracker: FileChangeTracker, setDisk: (content: string) => void): void {
  setDisk('a\nb\nc\nd\ne');
  tracker.noteToolStart({
    toolCallId: 't1',
    name: 'write_file',
    args: JSON.stringify({ path: REL }),
  });
  setDisk('a\nX\nc\nY\ne');
  tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });
}

/** CodeLens 的最小形状（断言只用到 command.command / command.title / command.arguments / range.line） */
interface LensLike {
  command: { command: string; title?: string; arguments?: unknown[] };
  range: { line: number };
}

/** 经**真实渲染路径**取按钮（调 provider，不私下调内部方法） */
function renderLenses(doc: Record<string, unknown>): LensLike[] {
  const provider = h.state.lensProvider as { provideCodeLenses(doc: unknown): LensLike[] };
  return provider.provideCodeLenses(doc);
}

/**
 * 取对比**左栏**（旧内容虚拟文档）的真实正文（走 provider = 生产读路径）
 *
 * 从左栏 URI 出发，而**不是**从「打开过的文档」出发：`vscode.diff` 不经 `showTextDocument`，
 * `opened` 里不会有它——按 `opened` 找会恒为空，断言变成假绿。
 */
function compareText(): string {
  const diff = h.state.commandArgs.find((c) => c.cmd === 'vscode.diff');
  if (!diff) return '';
  const provider = h.state.contentProvider as { provideTextDocumentContent(u: unknown): string };
  return provider.provideTextDocumentContent(diff.args[0]);
}

/**
 * 等「对比视图出现了」——**不预设它以什么形态出现**
 *
 * 等待条件一旦绑死某一种形态，形态被改动时 `waitFor` 会先超时，后面的形态断言**根本跑不到**
 * ，守卫形同虚设（2026-09-27 变异验证实踩：等待条件写「虚拟文档已打开」时，改回 vscode.diff
 * 红在 waitFor 而不是红在守卫）。这里只等「出现过」，形态交给调用方显式断言。
 */
async function waitForCompareOpened(): Promise<void> {
  await vi.waitFor(() => {
    const opened = h.state.opened.some((u) => u.startsWith('memora-diff:'));
    const diffed = h.state.executed.includes('vscode.diff');
    expect(opened || diffed).toBe(true);
  });
}

/** 取 `vscode.diff` 的调用实参 `[left, right, title]`（左右两栏 + 标题） */
function diffArgs(): { toString(): string }[] {
  const call = h.state.commandArgs.find((c) => c.cmd === 'vscode.diff');
  return (call?.args ?? []) as { toString(): string }[];
}

/** 取第 `index` 个指定按钮的调用参数 `[absPath, key]`（模拟用户点击所带的实参） */
function hunkButtonArgs(
  doc: Record<string, unknown>,
  command: string,
  index = 0,
): [string, string] {
  const args = renderLenses(doc).filter((lens) => lens.command.command === command)[index]?.command
    .arguments;
  return [String(args?.[0]), String(args?.[1])];
}

describe('FileChangeView · 块级按钮粒度与落点', () => {
  it('每个改动块一组「接受此处 / 拒绝此处」', () => {
    const { view, tracker, setDisk } = makeView();
    recordTwoHunkWrite(tracker, setDisk);
    view.register(makeContext());

    const lenses = renderLenses(makeDoc('a\nX\nc\nY\ne'));
    expect(lenses.length).toBe(4); // 2 块 × 2 颗
    const cmds = lenses.map((lens) => lens.command.command);
    expect(new Set(cmds)).toEqual(new Set([CONFIRM_HUNK_COMMAND, REJECT_HUNK_COMMAND]));
    // 文件级已迁标题栏、跨文件在会话区 ⇒ 正文里不得再出现
    expect(cmds).not.toContain(CONFIRM_FILE_COMMAND);
    expect(cmds).not.toContain(RESTORE_FILE_COMMAND);
    expect(cmds).not.toContain(CONFIRM_ALL_FILE_CHANGES_COMMAND);
    expect(cmds).not.toContain(REVERT_ALL_FILE_CHANGES_COMMAND);
  });

  it('按钮挂在块的**末行之后**（挂首行会被读成「属于上一段」，§11.8 已推翻的形态）', () => {
    const { view, tracker, setDisk } = makeView();
    recordTwoHunkWrite(tracker, setDisk);
    view.register(makeContext());

    // 块 1 = 第 1 行、块 2 = 第 3 行 ⇒ 落点 = 2 / 4（CodeLens 渲染在所在行上方 ⇒ 紧跟块后）
    expect(renderLenses(makeDoc('a\nX\nc\nY\ne')).map((lens) => lens.range.line)).toEqual([
      2, 2, 4, 4,
    ]);
  });

  it('按钮恒带「第 N/M 处」序号（让归属不依赖位置）', () => {
    const { view, tracker, setDisk } = makeView();
    recordTwoHunkWrite(tracker, setDisk);
    view.register(makeContext());

    expect(renderLenses(makeDoc('a\nX\nc\nY\ne')).map((lens) => lens.command.title)).toEqual([
      '$(check) 接受此处（1/2）',
      '$(discard) 拒绝此处（1/2）',
      '$(check) 接受此处（2/2）',
      '$(discard) 拒绝此处（2/2）',
    ]);
  });

  /**
   * BUG 回归守卫（2026-09-27 真机「底部修改的按钮跑到上面去了」）
   *
   * 硬证据：测试文件 `endsWithNewline=false` + 最后一行正是被改的那行 ⇒ 末块 `endLine+1` 越界，
   * 只能 clamp 回块自己的末行，而 CodeLens 渲染在行的**上方** ⇒ 按钮必然落在该块上方。
   * 这是 CodeLens 的固有约束（API 给不出「渲染在行下方」），**位置无解** ⇒ 用序号兜底归属。
   * 本用例把该约束**钉成显式行为**：将来若有人想当然地「修」它，必须先推翻这条断言。
   */
  it('末块贴着文件最后一行 ⇒ 按钮只能落在该行上方（且序号仍标明这是第几处）', () => {
    const { view, tracker, setDisk } = makeView();
    setDisk('a\nb\nc');
    tracker.noteToolStart({
      toolCallId: 't1',
      name: 'write_file',
      args: JSON.stringify({ path: REL }),
    });
    setDisk('a\nb\nZ');
    tracker.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });
    view.register(makeContext());

    const doc = makeDoc('a\nb\nZ'); // 3 行、无尾随空行 ⇒ 末块 endLine = 2 = lineCount-1
    const lenses = renderLenses(doc);
    expect(lenses.map((lens) => lens.range.line)).toEqual([2, 2]); // 被 clamp，落在改动行本身
    expect(lenses.map((lens) => lens.command.title)).toEqual([
      '$(check) 接受此处（1/1）',
      '$(discard) 拒绝此处（1/1）',
    ]);
  });

  it('无未确认改动的文件不挂按钮', () => {
    const { view } = makeView();
    view.register(makeContext());
    expect(renderLenses(makeDoc('unrelated'))).toEqual([]);
  });
});

/**
 * 块级动作（命题 B）：接受 = 并入基线（不动盘）；拒绝 = 区间还原（写盘）
 *
 * 全部走**真实命令路径**，参数取自 provider 渲染出的按钮实参（等价于用户点击）。
 */
describe('FileChangeView · 块级动作（命题 B）', () => {
  it('拒绝一块 → 只回退该块、另一块保留，记录不注销', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordTwoHunkWrite(tracker, setDisk);
    view.register(makeContext());
    // 第 2 个「拒绝此处」= 第 2 块（Y → d）
    const args = hunkButtonArgs(makeDoc('a\nX\nc\nY\ne'), REJECT_HUNK_COMMAND, 1);

    h.state.commands.get(REJECT_HUNK_COMMAND)?.(...args);

    await vi.waitFor(() => {
      expect(h.state.writes).toEqual([{ path: FILE, content: 'a\nX\nc\nd\ne' }]);
    });
    expect(tracker.size()).toBe(1); // 还有一块未处理 ⇒ 记录活着
    expect(tracker.get(FILE)?.afterContent).toBe('a\nX\nc\nd\ne');
  });

  it('接受一块 → 不写盘，基线并入该块，其余块仍可操作', () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordTwoHunkWrite(tracker, setDisk);
    view.register(makeContext());
    const doc = makeDoc('a\nX\nc\nY\ne');
    const args = hunkButtonArgs(doc, CONFIRM_HUNK_COMMAND, 0);

    h.state.commands.get(CONFIRM_HUNK_COMMAND)?.(...args);

    // 接受 = 纯内存改基线，**绝不动盘**
    expect(h.state.writes.length).toBe(0);
    expect(tracker.get(FILE)?.afterContent).toBe('a\nX\nc\nY\ne');
    expect(tracker.get(FILE)?.beforeContent).toBe('a\nX\nc\nd\ne');
    // 剩余 1 块 ⇒ 按钮从 4 颗变 2 颗（被接受的块不再有入口）
    expect(renderLenses(doc).length).toBe(2);
  });

  it('接受最后一块 → 记录注销（与文件级确认同一收口，无需单独通道）', () => {
    const { view, tracker, setDisk } = makeView();
    recordOneWrite(tracker, setDisk);
    view.register(makeContext());
    const args = hunkButtonArgs(makeDoc('v1'), CONFIRM_HUNK_COMMAND, 0);

    h.state.commands.get(CONFIRM_HUNK_COMMAND)?.(...args);

    expect(tracker.size()).toBe(0);
    expect(h.state.writes.length).toBe(0);
  });

  it('拒绝最后一块 → 回退成改动前内容并注销记录', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordOneWrite(tracker, setDisk);
    view.register(makeContext());
    const args = hunkButtonArgs(makeDoc('v1'), REJECT_HUNK_COMMAND, 0);

    h.state.commands.get(REJECT_HUNK_COMMAND)?.(...args);

    await vi.waitFor(() => {
      expect(h.state.writes).toEqual([{ path: FILE, content: 'v0' }]);
    });
    expect(tracker.size()).toBe(0);
  });

  it('块指纹失效 → fail-closed：不动盘、留痕、记录保留（绝不按下标猜块）', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordTwoHunkWrite(tracker, setDisk);
    view.register(makeContext());
    const args = hunkButtonArgs(makeDoc('a\nX\nc\nY\ne'), REJECT_HUNK_COMMAND, 0);

    // 渲染之后内容变了 ⇒ 旧指纹对不上
    h.state.commands.get(REJECT_HUNK_COMMAND)?.(args[0], 'stale:key:zzz');

    await vi.waitFor(() => {
      expect(h.state.logs.length).toBeGreaterThan(0);
    });
    // 硬证据放在**写盘**上：fail-closed 的反面不是「没留痕」，是「猜了个块还写了盘」
    expect(h.state.writes.length).toBe(0);
    expect(h.state.logs.some((m) => m.includes('块指纹已失效'))).toBe(true);
    expect(tracker.size()).toBe(1);
  });

  it('块级命令无指纹（无参调用）→ 忽略并留痕，不动盘', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordTwoHunkWrite(tracker, setDisk);
    view.register(makeContext());

    h.state.commands.get(REJECT_HUNK_COMMAND)?.(FILE);

    await vi.waitFor(() => {
      expect(h.state.logs.some((m) => m.includes('缺少块指纹'))).toBe(true);
    });
    expect(h.state.writes.length).toBe(0);
  });

  it('拒绝一块遇未保存编辑 → 弹模态；取消 → 不写盘、记录保留', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordTwoHunkWrite(tracker, setDisk);
    view.register(makeContext());
    h.state.documents = [makeDoc('用户未保存的编辑', { isDirty: true })];
    h.state.warningChoice = undefined; // 取消
    const args = hunkButtonArgs(makeDoc('a\nX\nc\nY\ne'), REJECT_HUNK_COMMAND, 0);

    h.state.commands.get(REJECT_HUNK_COMMAND)?.(...args);

    await vi.waitFor(() => {
      expect(h.state.warningCalls.length).toBe(1);
    });
    expect(h.state.warningCalls[0].modal).toBe(true);
    expect(h.state.warningCalls[0].detail).toContain('未保存');
    expect(h.state.writes.length).toBe(0);
    expect(tracker.size()).toBe(1);
  });

  it('文件级命令接 Uri（editor/title 入口）也能定位文件', async () => {
    const { view, tracker, setDisk } = makeView({ getSecurityGuard: guardAllowsAll });
    recordOneWrite(tracker, setDisk);
    view.register(makeContext());

    // 标题栏菜单传给命令的是 Uri（不是字符串路径）
    h.state.commands.get(RESTORE_FILE_COMMAND)?.({ fsPath: FILE });

    await vi.waitFor(() => {
      expect(h.state.writes).toEqual([{ path: FILE, content: 'v0' }]);
    });
    expect(tracker.size()).toBe(0);
  });
});

/**
 * 对比预览的体积闸（方案 §4.1：超限跳过对比、只留「回退」入口）
 *
 * 走**真实事件路径**（`noteToolResult` → 本轮首个改动弹通知 → 选「查看对比」→ `openCompare`），
 * 不私调私有方法。盯的是**删除场景**：`afterContent === null`，旧内容却可能是几 MB。
 * 判据若只拿 `afterContent` 做（曾为 `afterContent !== null && …`），删除大文件就会绕过本闸，
 * 把整份旧内容塞进虚拟文档渲染——正是这道闸要防的事。
 */
describe('FileChangeView · 对比预览的体积闸（含删除场景）', () => {
  it('删除大文件 → 跳过对比、不开对照文档', async () => {
    const { view, setDisk } = makeView();
    view.register(makeContext());
    h.state.infoChoice = '查看对比'; // 改动通知上的按钮

    setDisk('x'.repeat(MAX_DIFF_CONTENT_LENGTH + 1));
    view.noteToolStart({
      toolCallId: 'd1',
      name: 'delete_file',
      args: JSON.stringify({ path: REL }),
    });
    setDisk(null); // 文件已不存在 ⇒ afterContent = null
    view.noteToolResult({ toolCallId: 'd1', name: 'delete_file', ok: true });

    await vi.waitFor(() => {
      expect(h.state.infoCalls.some((m) => m.includes('改动过大'))).toBe(true);
    });
    // 闸生效的直接证据：没有真的去开 diff（左栏虚拟文档也没建 ⇒ 读出来是空串）
    expect(h.state.executed).not.toContain('vscode.diff');
    expect(compareText()).toBe('');
  });

  it('反向守卫：小文件删除 → 正常打开对照（闸不误伤）', async () => {
    const { view, setDisk } = makeView();
    view.register(makeContext());
    h.state.infoChoice = '查看对比';

    setDisk('bye');
    view.noteToolStart({
      toolCallId: 'd1',
      name: 'delete_file',
      args: JSON.stringify({ path: REL }),
    });
    setDisk(null);
    view.noteToolResult({ toolCallId: 'd1', name: 'delete_file', ok: true });

    await waitForCompareOpened();
    expect(h.state.infoCalls.some((m) => m.includes('改动过大'))).toBe(false);
    // 形态断言（谁被改坏谁红）
    expect(h.state.executed).toContain('vscode.diff');
    // 删除场景：右栏无真实文件可指 ⇒ 两栏都是虚拟文档（右栏语义 = 空）
    expect(diffArgs()[0]?.toString().startsWith('memora-diff:')).toBe(true);
    expect(diffArgs()[1]?.toString().startsWith('memora-diff:')).toBe(true);
    // 左栏 = 改动前原文（不是 - / + 前缀的对照文本）
    expect(compareText()).toBe('bye');
  });
});

/**
 * 「查看对比」= `vscode.diff` **左右分栏**（2026-09-28 真机反馈回滚）
 *
 * 2026-09-27 曾改为自渲染的「上下统一视图」（当时反馈「左右排列看不清原文」），2026-09-28
 * 真机再测结论相反 ⇒ 回滚到 git 同款。钉死两条：
 *   ① 走 `vscode.diff`；自渲染形态的特征是「用 `showTextDocument` 打开虚拟文档」⇒ 不得出现；
 *   ② 左栏 = 旧内容虚拟文档（`memora-diff:`，不落盘），正文 = 改动前**原文**（不带 -/+ 前缀，
 *      那是被否决的上下视图的格式）。
 */
describe('FileChangeView · 对照视图为 vscode.diff 左右分栏', () => {
  /** 造一条两处改动的记录并触发「查看对比」（走真实事件路径 + 通知按钮） */
  async function openCompareOnTwoHunk(): Promise<void> {
    const { view, tracker, setDisk } = makeView();
    setDisk('a\nb\nc\nd\ne');
    view.register(makeContext());
    h.state.infoChoice = '查看对比';
    view.noteToolStart({
      toolCallId: 't1',
      name: 'write_file',
      args: JSON.stringify({ path: REL }),
    });
    setDisk('a\nX\nc\nY\ne');
    view.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });
    await waitForCompareOpened();
    expect(tracker.size()).toBe(1);
  }

  it('走 vscode.diff（不是自渲染的上下统一视图）', async () => {
    await openCompareOnTwoHunk();
    expect(h.state.executed).toContain('vscode.diff');
    // 自渲染形态的特征 = showTextDocument 打开虚拟文档 ⇒ 回滚后不得出现
    expect(h.state.opened.filter((u) => u.startsWith('memora-diff:'))).toEqual([]);
  });

  it('左栏 = 旧内容虚拟文档，正文是改动前原文（不带 - / + 前缀）', async () => {
    await openCompareOnTwoHunk();
    expect(diffArgs()[0]?.toString().startsWith('memora-diff:')).toBe(true);
    expect(compareText()).toBe('a\nb\nc\nd\ne');
  });

  it('标题带相对路径（多个同名文件时能辨认）', async () => {
    await openCompareOnTwoHunk();
    expect(String(diffArgs()[2] ?? '')).toContain(REL);
  });
});

/**
 * 右栏 = **真实文件**（可编辑），不是第二份虚拟文档
 *
 * 为何另开一个真实临时目录：`openCompare` 用 `existsSync` 判断文件是否还在，而本文件其余用例
 * 的「磁盘」是内存 mock（`setDisk`）⇒ 那里恒为「不存在」，只能走到「右栏 = 空虚拟文档」分支。
 * 要验证「文件还在时右栏指向真实文件」，文件必须真的在磁盘上。
 */
describe('FileChangeView · 右栏指向真实文件（真实 FS）', () => {
  it('文件存在 ⇒ 右栏是 file: URI，左栏仍是旧内容虚拟文档', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memora-fcv-'));
    try {
      const file = join(root, REL);
      writeFileSync(file, 'a\nb\nc', 'utf-8');
      const io: FileChangeIO = {
        readTextFile: (p: string): string | null =>
          existsSync(p) ? readFileSync(p, 'utf-8') : null,
      };
      const tracker = new FileChangeTracker(root, { io, now: (): number => 1 });
      const view = new FileChangeView(tracker, {
        getSecurityGuard: (): undefined => undefined,
        isConfirmWrites: (): boolean => false,
        log: (): void => undefined,
      });
      view.register(makeContext());
      h.state.infoChoice = '查看对比';
      view.noteToolStart({
        toolCallId: 'r1',
        name: 'write_file',
        args: JSON.stringify({ path: file }),
      });
      writeFileSync(file, 'a\nX\nc', 'utf-8');
      view.noteToolResult({ toolCallId: 'r1', name: 'write_file', ok: true });

      await waitForCompareOpened();
      const [left, right] = diffArgs();
      expect(left?.toString().startsWith('memora-diff:')).toBe(true); // 左 = 旧内容虚拟文档
      expect(right?.toString().startsWith('file:')).toBe(true); //      右 = 真实文件
      expect(compareText()).toBe('a\nb\nc'); // 左栏 = 改动前原文
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * 虚拟文档释放（隐私承诺）：确认后**左右两栏**都不留旧内容
 *
 * 回滚为左右分栏后，一条记录**占用两个虚拟 URI**（左 = 旧内容、右 = 删除场景的空文档），
 * 而上下统一视图只占一个 ⇒ `releaseVirtual` 漏清任一都会让旧内容常驻内存。本模块对外宣称
 * 「旧内容零落盘、可释放」（可能含密钥），故这条必须钉死。
 *
 * ⚠️ **观测边界（如实记，不写假绿断言）**：右栏在删除场景是**空串**虚拟文档，而 provider 的读
 * 路径是 `virtualContents.get(...) ?? ''` ⇒ 「已建立但值为空」与「已释放」**返回同形**（都是 `''`）
 * ⇒ **空串那一栏的释放不可观测**。故本组只钉**非空**的左栏（旧内容侧）；空串侧靠 `releaseVirtual`
 * 与左栏同一段代码对称保证，**不为它编一个恒真的断言**（那才是假绿）。
 */
describe('FileChangeView · 虚拟文档释放（左右两栏都不留旧内容）', () => {
  it('确认改动后，左栏虚拟文档内容被清空（provider 读不到）', async () => {
    const { view, tracker, setDisk } = makeView();
    setDisk('v0');
    view.register(makeContext());
    h.state.infoChoice = '查看对比';
    view.noteToolStart({
      toolCallId: 't1',
      name: 'write_file',
      args: JSON.stringify({ path: REL }),
    });
    setDisk('v1');
    view.noteToolResult({ toolCallId: 't1', name: 'write_file', ok: true });

    await waitForCompareOpened();
    expect(compareText()).toBe('v0'); // 建起来了：左栏 = 改动前内容

    h.state.commands.get(CONFIRM_FILE_COMMAND)?.(FILE); // 走真实命令路径确认
    expect(tracker.size()).toBe(0);
    expect(compareText()).toBe(''); // 释放后读不到 ⇒ 旧内容不在内存里驻留
  });
});
