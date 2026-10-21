/**
 * ActiveFileTracker 单测（HOST-SPLIT-1 第 1 刀）
 *
 * 覆盖方案 §6.2 七条。关键手法：`activeTextEditor` 用 **getter 计数器**——
 * 「取没取快照」不是靠断言返回值猜，而是直接数宿主读了几次编辑器；
 * `getText` 同理用调用计数，把「每击键全量读文」的效率回退钉成可测事实。
 *
 * 既有同类断言在 `webview/__tests__/chatPanelHistory.test.ts`（经 chatPanel re-export
 * 驱动那 5 个纯函数）；本文件只测**迁出来后新增的类行为**（去重 / 订阅 / 开关），
 * 不重复造纯函数的判据用例——同一事实两处断言即 SSOT 破裂。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const editorSubs: (() => void)[] = [];
  const docSubs: ((e: { document: unknown }) => void)[] = [];
  const saveSubs: (() => void)[] = [];
  const disposers: { dispose: ReturnType<typeof vi.fn> }[] = [];
  // 宿主读活动编辑器的次数（getter 计数）——「连快照都不取」的硬判据
  const state = { activeEditor: undefined as unknown, editorReads: 0 };
  const disposable = () => {
    const d = { dispose: vi.fn() };
    disposers.push(d);
    return d;
  };
  return { editorSubs, docSubs, saveSubs, disposers, state, disposable };
});

vi.mock('vscode', () => ({
  window: {
    // getter 而非固定值：测试可随时改活动编辑器，且每次被读都计数
    get activeTextEditor() {
      h.state.editorReads += 1;
      return h.state.activeEditor;
    },
    onDidChangeActiveTextEditor: (cb: () => void) => {
      h.editorSubs.push(cb);
      return h.disposable();
    },
  },
  workspace: {
    // 忠实模拟官方语义：工作区内返回相对路径，工作区外回退绝对路径
    asRelativePath: (u: { fsPath: string }) =>
      u.fsPath.startsWith('/mock/workspace/')
        ? u.fsPath.slice('/mock/workspace/'.length)
        : u.fsPath,
    onDidChangeTextDocument: (cb: (e: { document: unknown }) => void) => {
      h.docSubs.push(cb);
      return h.disposable();
    },
    onDidSaveTextDocument: (cb: () => void) => {
      h.saveSubs.push(cb);
      return h.disposable();
    },
  },
}));

import { ActiveFileTracker } from '../activeFileTracker.js';
import type { ExtensionToWebviewMessage } from '../../../shared/protocol.js';

/** 计数器型编辑器替身：getText 次数可断言（与 chatPanelHistory.test.ts 同款手法） */
function makeEditor(opts: {
  fsPath: string;
  isDirty?: boolean;
  isUntitled?: boolean;
  text?: string;
}) {
  const reads = { getText: 0 };
  const editor = {
    reads,
    document: {
      fileName: opts.fsPath,
      uri: { fsPath: opts.fsPath },
      isDirty: opts.isDirty ?? false,
      isUntitled: opts.isUntitled ?? false,
      getText: () => {
        reads.getText += 1;
        return opts.text ?? '文档内容A';
      },
    },
  };
  return editor as unknown as { reads: { getText: number }; document: unknown };
}

function setup() {
  const posted: ExtensionToWebviewMessage[] = [];
  const tracker = new ActiveFileTracker({ post: (m) => posted.push(m) });
  return { tracker, posted };
}

describe('ActiveFileTracker', () => {
  beforeEach(() => {
    h.state.activeEditor = undefined;
    h.state.editorReads = 0;
    h.editorSubs.length = 0;
    h.docSubs.length = 0;
    h.saveSubs.length = 0;
    h.disposers.length = 0;
  });

  it('显示路径零 getText：withBody=false 绝不读正文（防每击键全量读文的效率回退）', () => {
    const { tracker } = setup();
    const editor = makeEditor({ fsPath: '/mock/workspace/docs/方案.md', isDirty: true });
    h.state.activeEditor = editor;

    const facts = tracker.resolveActiveFile(false);

    // 判据认它要注入，但正文一个字节都没读
    expect(facts.inject).toBe(true);
    expect(facts.body).toBe('');
    expect(editor.reads.getText).toBe(0);
  });

  it('正文惰性：withBody=true 且判据要求注入时才读一次，且格式是信封契约', () => {
    const { tracker } = setup();
    const editor = makeEditor({ fsPath: '/mock/workspace/docs/方案.md', isDirty: true });
    h.state.activeEditor = editor;

    const facts = tracker.resolveActiveFile(true);

    expect(facts.body).toBe('文件名：方案.md\n文档内容A');
    expect(editor.reads.getText).toBe(1);
  });

  it('干净文件不注入正文：withBody=true 也不读（判据说不必，就不做昂贵读取）', () => {
    const { tracker } = setup();
    const editor = makeEditor({ fsPath: '/mock/workspace/docs/方案.md', isDirty: false });
    h.state.activeEditor = editor;

    const facts = tracker.resolveActiveFile(true);

    expect(facts.inject).toBe(false);
    expect(facts.body).toBe('');
    expect(editor.reads.getText).toBe(0);
  });

  it('投递去重：同投影不重复 post，force 才绕过去重', () => {
    const { tracker, posted } = setup();

    tracker.postActiveFile({ kind: 'none' }, false);
    tracker.postActiveFile({ kind: 'none' }, false);
    tracker.postActiveFile({ kind: 'none' }, true);

    expect(posted).toHaveLength(2);
    expect(posted[0]).toEqual({ type: 'active_file', projection: { kind: 'none' } });
    // force 那次推的仍是同一投影——去重基线被 force 刷新，但值没变
    expect(posted[1]).toEqual({ type: 'active_file', projection: { kind: 'none' } });
  });

  it('订阅幂等：重复 ensure 先释放旧订阅，不累积监听', () => {
    const { tracker } = setup();

    tracker.ensureActiveFileTracking();
    expect(h.disposers).toHaveLength(3);
    const firstBatch = [...h.disposers];

    tracker.ensureActiveFileTracking();

    // 旧三个全部 dispose，新的三个另起一批（而非叠成六个活监听）
    for (const d of firstBatch) expect(d.dispose).toHaveBeenCalledTimes(1);
    expect(h.disposers).toHaveLength(6);
  });

  it('三事件全覆盖：换文件 / 同文件编辑 / 保存各触发一次取数', () => {
    const { tracker } = setup();
    const editor = makeEditor({ fsPath: '/mock/workspace/docs/方案.md' });
    h.state.activeEditor = editor;
    tracker.ensureActiveFileTracking();
    h.state.editorReads = 0;

    h.editorSubs[0]();
    expect(h.state.editorReads).toBe(1);

    // 同文件被编辑：必须命中（这条正是上一版缓存判据撒谎的缺口）。
    // ⚠️ 本路径涨 **2** 次而非 1 次：回调先读一次 activeTextEditor 做「是不是当前文档」
    // 比较，命中后才由 pushActiveFile → resolveActiveFile 读第二次。如实记录当前行为，
    // 勿当 bug 顺手优化（那是「顺便优化」，违反单一改动原则）。
    h.docSubs[0]({ document: editor.document });
    expect(h.state.editorReads).toBe(3);

    // 保存：不改内容 ⇒ 不触发上一条，但 isDirty 会翻 false
    h.saveSubs[0]();
    expect(h.state.editorReads).toBe(4);

    // 无关文档的编辑事件：只读一次做比较、**不** push（避免刷屏）
    const before = h.state.editorReads;
    h.docSubs[0]({ document: { other: true } });
    expect(h.state.editorReads).toBe(before + 1);
  });

  it('开关同态：同值二次调用不重推', () => {
    const { tracker, posted } = setup();

    tracker.setActiveFileAttach(true); // 初值即 true
    expect(posted).toHaveLength(0);

    tracker.setActiveFileAttach(false);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toEqual({ type: 'active_file', projection: { kind: 'suppressed' } });

    tracker.setActiveFileAttach(false);
    expect(posted).toHaveLength(1);
  });

  it('开关关闭 ⇒ 连快照都不取（无「关了还挂指针」中间态）', () => {
    const { tracker } = setup();
    tracker.setActiveFileAttach(false);
    const editor = makeEditor({ fsPath: '/mock/workspace/docs/方案.md', isDirty: true });
    h.state.activeEditor = editor;
    h.state.editorReads = 0;

    const facts = tracker.resolveActiveFile(true);

    // 上游闸门生效：活动编辑器一次都没被读 ⇒ 指针与正文一并消失
    expect(h.state.editorReads).toBe(0);
    expect(facts.snap).toBeUndefined();
    expect(facts.inject).toBe(false);
    expect(facts.body).toBe('');
    expect(facts.projection).toEqual({ kind: 'suppressed' });
  });
});
