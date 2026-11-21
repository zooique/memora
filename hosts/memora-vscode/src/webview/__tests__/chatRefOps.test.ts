/**
 * 引用点击定位（`chatRefOps.openRefInEditor`）· 行范围越界守卫（HOST-0.10.0-DEBT-1 ③）
 *
 * 锁定的语义：
 * - 只在**点击那一刻**判越界（复用 `open_ref` 已打开的文档，零额外读盘）；切会话 / 渲染不探测。
 * - 越界 = 引用 end 行超出当前文档行数（文件被改短）⇒ 走既有 `notice` 提示条
 *   （level `error`，带引用区间与现有行数），reveal 末尾但**不设 selection**
 *   （选中末尾会暗示「这段就是该引用」，是另一种误导）。
 * - 不覆盖「行数没变但内容被换」——指针语义，本条不承诺。
 *
 * 变异验证：把 `ref.range.end > doc.lineCount` 改坏（恒 false），本套件第一条用例即转红。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { Mock } from 'vitest';
import type { ChatRef, ExtensionToWebviewMessage } from '../../shared/protocol.js';
import { CONFIRM_FILE_COMMAND, RESTORE_FILE_COMMAND } from '../../extension/host/fileChangeView.js';
import { createChatRefOps } from '../panels/chatRefOps.js';

/** l10n.t 替身：`{0}/{1}` 按参替换（vi.hoisted——mock 工厂先于 import 执行） */
const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]): string => {
  let out = msg;
  args.forEach((arg, i) => {
    out = out.replaceAll(`{${i}}`, String(arg));
  });
  return out;
});

/** vscode 最小替身：只覆盖 openRefInEditor 实际走到的 API */
const vscodeStub = vi.hoisted(() => {
  /* Position / Range / Selection 只承载坐标，断言直接读字段 */
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range {
    public start: Position;
    public end: Position;
    /** 兼容真实 API 的两种重载：(start, end) 与 (startLine, startChar, endLine, endChar) */
    constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
      if (typeof a === 'number') {
        this.start = new Position(a, b as number);
        this.end = new Position(c as number, d as number);
      } else {
        this.start = a;
        this.end = b as Position;
      }
    }
  }
  class Selection {
    constructor(
      public anchor: Position,
      public active: Position,
    ) {}
  }
  return {
    Position,
    Range,
    Selection,
    /** InCenter 的数值只作透传锚点，测试断言同一个数 */
    TextEditorRevealType: { InCenter: 2 },
    workspace: {
      // 根用真实 cwd：path.resolve/relative 走平台实现，引用路径才能规范形往返
      workspaceFolders: [{ uri: { fsPath: process.cwd() } }],
      openTextDocument: vi.fn(),
    },
    window: { showTextDocument: vi.fn() },
    commands: { executeCommand: vi.fn() },
    Uri: { file: (p: string) => ({ fsPath: p }) },
    l10n: { t: tStub },
  };
});

vi.mock('vscode', () => vscodeStub);

/** 构造文本文档替身：只给行数与行尾坐标（代码只用到这两处） */
function makeDoc(lineCount: number): {
  lineCount: number;
  lineAt: (n: number) => { range: { end: { line: number; character: number } } };
} {
  return {
    lineCount,
    lineAt: (n: number) => ({
      range: { end: new vscodeStub.Position(n, 5) },
    }),
  };
}

/** 构造一条文件引用（path 为首根下的规范相对形） */
function makeRef(range: { start: number; end: number }): ChatRef {
  return { path: 'src/a.ts', kind: 'file', range };
}

describe('chatRefOps.openRefInEditor · 行范围越界守卫', () => {
  /** 投递出口 spy：按真实签名定型（宽泛 Mock 顶不上 `(msg) => void` 参数） */
  let post: Mock<(msg: ExtensionToWebviewMessage) => void>;
  /** 被测域实例（每例重建，in-flight 标志不跨例） */
  let ops: ReturnType<typeof createChatRefOps>;

  beforeEach(() => {
    post = vi.fn<(msg: ExtensionToWebviewMessage) => void>();
    vscodeStub.workspace.openTextDocument.mockReset();
    vscodeStub.window.showTextDocument.mockReset();
    ops = createChatRefOps({ post, pushRefs: vi.fn(), hasView: () => true });
  });

  it('越界：发 error 提示（带区间与现有行数），reveal 末尾但不设 selection', async () => {
    // 引用 120-145，但文件只有 90 行 ⇒ 那段已被改短删掉
    const editor = { selection: undefined as unknown, revealRange: vi.fn() };
    vscodeStub.workspace.openTextDocument.mockResolvedValue(makeDoc(90));
    vscodeStub.window.showTextDocument.mockResolvedValue(editor);

    await ops.openRefInEditor(makeRef({ start: 120, end: 145 }));

    // 提示：唯一一条，走既有 notice 通道，level 必须 error（info 会一闪而过）
    expect(post).toHaveBeenCalledTimes(1);
    const msg = post.mock.calls[0][0] as { type: string; level: string; message: string };
    expect(msg.type).toBe('notice');
    expect(msg.level).toBe('error');
    // 文案带确切数字：引用区间 + 文件现有行数
    expect(msg.message).toContain('120-145');
    expect(msg.message).toContain('90');
    // 不选中任何内容（避免「末尾这段就是该引用」的误导）
    expect(editor.selection).toBeUndefined();
    // 视线落在末尾行：0-based lastLine = lineCount - 1
    expect(editor.revealRange).toHaveBeenCalledTimes(1);
    const [range, revealType] = editor.revealRange.mock.calls[0] as [
      { start: { line: number } },
      number,
    ];
    expect(range.start.line).toBe(89);
    expect(revealType).toBe(2);
  });

  it('未越界：不提示，按区间选中并 reveal', async () => {
    // 引用 10-12，文件 90 行 ⇒ 区间仍有效
    const editor = { selection: undefined as unknown, revealRange: vi.fn() };
    vscodeStub.workspace.openTextDocument.mockResolvedValue(makeDoc(90));
    vscodeStub.window.showTextDocument.mockResolvedValue(editor);

    await ops.openRefInEditor(makeRef({ start: 10, end: 12 }));

    expect(post).not.toHaveBeenCalled();
    expect(editor.selection).toBeDefined();
    expect(editor.revealRange).toHaveBeenCalledTimes(1);
    const [range] = editor.revealRange.mock.calls[0] as [
      { start: { line: number }; end: { line: number } },
    ];
    // 1-based → 0-based：10-12 → 9-11
    expect(range.start.line).toBe(9);
    expect(range.end.line).toBe(11);
  });
});

describe('chatRefOps.openChangedFile · 清单对拍（OPEN-CHANGED-FILE-1）', () => {
  let post: Mock<(msg: ExtensionToWebviewMessage) => void>;
  let ops: ReturnType<typeof createChatRefOps>;

  beforeEach(() => {
    post = vi.fn<(msg: ExtensionToWebviewMessage) => void>();
    vscodeStub.workspace.openTextDocument.mockReset();
    vscodeStub.window.showTextDocument.mockReset();
    ops = createChatRefOps({ post, pushRefs: vi.fn(), hasView: () => true });
  });

  it('命中当前改动清单 → 委托 openRefInEditor 打开（无区间、零 notice）', async () => {
    const editor = { selection: undefined as unknown, revealRange: vi.fn() };
    vscodeStub.workspace.openTextDocument.mockResolvedValue(makeDoc(90));
    vscodeStub.window.showTextDocument.mockResolvedValue(editor);

    await ops.openChangedFile('src/a.ts', ['src/a.ts', 'src/b.ts']);

    expect(vscodeStub.workspace.openTextDocument).toHaveBeenCalledTimes(1);
    expect(vscodeStub.window.showTextDocument).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled(); // 无区间引用不提示、不选中
  });

  it('未命中清单（伪造/已确认的路径）→ 发 error notice，零打开', async () => {
    await ops.openChangedFile('/etc/passwd', ['src/a.ts']);

    expect(vscodeStub.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const msg = post.mock.calls[0][0];
    expect(msg.type).toBe('notice');
    expect(msg.type === 'notice' && msg.level).toBe('error');
    expect(JSON.stringify(msg)).toContain('/etc/passwd');
  });

  it('清单为空（改动已被全部确认）→ 同样拒开，不发空通知以外的副作用', async () => {
    await ops.openChangedFile('src/a.ts', []);
    expect(vscodeStub.workspace.openTextDocument).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('chatRefOps.confirmChangedFile · 单文件独立确认（FILE-CHANGES-FLOAT-1）', () => {
  let post: Mock<(msg: ExtensionToWebviewMessage) => void>;
  let ops: ReturnType<typeof createChatRefOps>;

  beforeEach(() => {
    post = vi.fn<(msg: ExtensionToWebviewMessage) => void>();
    vscodeStub.commands.executeCommand.mockReset();
    ops = createChatRefOps({ post, pushRefs: vi.fn(), hasView: () => true });
  });

  it('命中清单 → 走已注册 CONFIRM_FILE_COMMAND，绝对参数（首根解析），零 notice', () => {
    ops.confirmChangedFile('src/a.ts', ['src/a.ts', 'src/b.ts']);

    expect(vscodeStub.commands.executeCommand).toHaveBeenCalledTimes(1);
    const [cmd, arg] = vscodeStub.commands.executeCommand.mock.calls[0];
    expect(cmd).toBe(CONFIRM_FILE_COMMAND);
    expect(arg).toBe(join(process.cwd(), 'src', 'a.ts')); // resolveUnderPrimaryRoot 产出绝对路径（平台分隔符）
    expect(post).not.toHaveBeenCalled();
  });

  it('未命中清单（伪造/已确认）→ 发 error notice，零命令调用（对拍守卫）', () => {
    ops.confirmChangedFile('/etc/passwd', ['src/a.ts']);

    expect(vscodeStub.commands.executeCommand).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const msg = post.mock.calls[0][0];
    expect(msg.type === 'notice' && msg.level).toBe('error');
    expect(JSON.stringify(msg)).toContain('/etc/passwd');
  });

  it('越界路径（.. 逃出首根）→ resolve 抛错被 catch，error notice，零命令调用', () => {
    ops.confirmChangedFile('../../escape.ts', ['../../escape.ts']);

    expect(vscodeStub.commands.executeCommand).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const msg = post.mock.calls[0][0];
    expect(msg.type === 'notice' && msg.level).toBe('error');
  });
});

describe('chatRefOps.restoreChangedFile · 单文件独立回退（FILE-CHANGES-FLOAT-1）', () => {
  let post: Mock<(msg: ExtensionToWebviewMessage) => void>;
  let ops: ReturnType<typeof createChatRefOps>;

  beforeEach(() => {
    post = vi.fn<(msg: ExtensionToWebviewMessage) => void>();
    vscodeStub.commands.executeCommand.mockReset();
    ops = createChatRefOps({ post, pushRefs: vi.fn(), hasView: () => true });
  });

  it('命中清单 → 走 RESTORE_FILE_COMMAND（含 dirty 模态确认），绝对参数，零 notice', () => {
    ops.restoreChangedFile('src/a.ts', ['src/a.ts', 'src/b.ts']);

    expect(vscodeStub.commands.executeCommand).toHaveBeenCalledTimes(1);
    const [cmd, arg] = vscodeStub.commands.executeCommand.mock.calls[0];
    expect(cmd).toBe(RESTORE_FILE_COMMAND);
    expect(arg).toBe(join(process.cwd(), 'src', 'a.ts'));
    expect(post).not.toHaveBeenCalled();
  });

  it('未命中清单（伪造/已回退）→ error notice，零命令调用（对拍守卫，写盘动作尤须守）', () => {
    ops.restoreChangedFile('/etc/passwd', ['src/a.ts']);

    expect(vscodeStub.commands.executeCommand).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const msg = post.mock.calls[0][0];
    expect(msg.type === 'notice' && msg.level).toBe('error');
    expect(JSON.stringify(msg)).toContain('/etc/passwd');
  });

  it('越界路径（.. 逃出首根）→ undefined 被判面，error notice，零命令调用', () => {
    ops.restoreChangedFile('../../escape.ts', ['../../escape.ts']);

    expect(vscodeStub.commands.executeCommand).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
    const msg = post.mock.calls[0][0];
    expect(msg.type === 'notice' && msg.level).toBe('error');
  });
});
