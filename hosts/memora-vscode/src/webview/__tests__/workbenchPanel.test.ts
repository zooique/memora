/**
 * 工作台面板生命周期测试
 *
 * 钉住「面板对象存活 + webview 不保活」这第三种组合（宿主里没有先例）：
 *   - `ready` 之前不投递；
 *   - 每次 `ready` 都**全量回放**（连发两次仍是两份完整快照，证明不依赖旧 webview 内存）；
 *   - 关闭后重开 = 新面板 + 新 ready 全量回放；
 *   - 隐藏即把就绪位归零，reveal 后必须等新的 ready（不向已销毁的上下文投递）；
 *   - 创建选项里 `retainContextWhenHidden` 不得为 true（否则就不是「不保活」）；
 *   - 「去这个会话」只上报意图，由注入的 openSession 承担切换。
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import type { SessionMeta } from '@zooique/memora';
import { MemoraWorkbenchPanel } from '../panels/workbenchPanel.js';
import type { WorkbenchSnapshotInputs } from '../helpers/workbenchModel.js';
import type { WorkbenchHistoryResult } from '../helpers/workbenchHistory.js';

// vi.mock 工厂被提升到文件顶部：可观测点必须先 hoisted 声明
const mocks = vi.hoisted(() => ({
  createWebviewPanel: vi.fn(),
  showErrorMessage: vi.fn(),
}));

/** l10n.t 替身：{0} 占位符按参替换（与设置面板测试同一手法） */
const tStub = vi.hoisted(
  () =>
    (msg: string, ...args: unknown[]): string =>
      args.reduce<string>((out, arg, i) => out.replaceAll(`{${i}}`, String(arg)), msg),
);

vi.mock('vscode', () => ({
  l10n: { t: tStub },
  Uri: { joinPath: () => ({ path: 'mock://dist/webview', toString: () => 'mock://uri' }) },
  window: {
    createWebviewPanel: mocks.createWebviewPanel,
    showErrorMessage: mocks.showErrorMessage,
  },
  ViewColumn: { Beside: 2 },
  env: { language: 'en' },
}));

/** 投递过的消息（断言用） */
let posted: unknown[] = [];
/** 触发 dispose 回调（关标签） */
let fireDispose: (() => void) | undefined;
/** 触发可见性变化 */
let setPanelVisible: ((visible: boolean) => void) | undefined;
/** 触发 webview 上行消息（ready / 去会话） */
let receiveMsg: ((msg: unknown) => void) | undefined;
/** 当前面板 mock 实例（多面板时取最新） */
let lastPanel: MockPanel | undefined;

/** 最小 WebviewPanel mock（与设置面板测试同型，多记一份 options） */
interface MockPanel {
  reveal: ReturnType<typeof vi.fn>;
  visible: boolean;
  webview: {
    options: unknown;
    html: string;
    cspSource: string;
    asWebviewUri: () => { toString(): string };
    onDidReceiveMessage: (cb: (msg: unknown) => void) => { dispose(): void };
    postMessage: (msg: unknown) => Promise<boolean>;
  };
  onDidDispose: (cb: () => void) => { dispose(): void };
  onDidChangeViewState: (cb: (e: { webviewPanel: { visible: boolean } }) => void) => {
    dispose(): void;
  };
}

/**
 * 构造一个 mock 面板
 *
 * @param options createWebviewPanel 收到的第 4 个参数（断言「不保活」）
 */
function makePanel(options: unknown): MockPanel {
  receiveMsg = undefined;
  setPanelVisible = undefined;
  const panel: MockPanel = {
    reveal: vi.fn(),
    visible: true,
    webview: {
      options,
      html: '',
      cspSource: 'test-csp',
      asWebviewUri: () => ({ toString: () => 'mock://workbenchView.js' }),
      onDidReceiveMessage: (cb) => {
        receiveMsg = cb;
        return { dispose: vi.fn() };
      },
      postMessage: (msg) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
    },
    onDidDispose: (cb) => {
      fireDispose = cb;
      return { dispose: vi.fn() };
    },
    onDidChangeViewState: (cb) => {
      setPanelVisible = (visible) => {
        panel.visible = visible;
        cb({ webviewPanel: { visible } });
      };
      return { dispose: vi.fn() };
    },
  };
  lastPanel = panel;
  return panel;
}

/** 测试用快照读口：一个座位 + 可变的子会话清单 + 空历史 */
function makeInputs(
  children: string[],
  orchestratorId: string,
  history: WorkbenchHistoryResult,
  seatSource: WorkbenchSnapshotInputs['seatSource'] = 'live',
): WorkbenchSnapshotInputs {
  const meta = (sessionId: string): SessionMeta =>
    ({
      sessionId,
      updatedAt: '2026-11-14T00:00:00.000Z',
      createdAt: '2026-11-14T00:00:00.000Z',
      messageCount: 0,
    }) as SessionMeta;
  return {
    orchestratorId,
    seatSource,
    agentName: 'Memora',
    readMeta: (sessionId) => meta(sessionId),
    readRolePackName: () => 'coder',
    readRolePackDisplayName: () => '程序员',
    isManaged: () => true,
    isAgentDriven: () => true,
    childrenOf: () => children,
    history,
    peekActivity: () => ({ running: false, waiting: false }),
    readRoundIds: (sessionId) => (sessionId === 'session-child' ? ['round-1'] : []),
    readRoundStatus: () => 'complete',
    readRound: () => undefined,
    titleOf: (sessionId) => `标题-${sessionId}`,
  };
}

/** 从投递序列里取全部工作台快照 */
function snapshots(): unknown[] {
  return posted.filter(
    (msg): msg is { type: 'workbench_snapshot' } =>
      typeof msg === 'object' &&
      msg !== null &&
      (msg as { type?: string }).type === 'workbench_snapshot',
  );
}

describe('MemoraWorkbenchPanel — 不保活生命周期', () => {
  /** 被测面板 */
  let panel: MemoraWorkbenchPanel;
  /** 「去这个会话」回调 */
  let openSession: Mock<(sessionId: string) => Promise<void>>;
  /** 历史重建回调（断言只在 open 时调用一次） */
  let rebuildHistory: Mock<(sessionId: string) => WorkbenchHistoryResult>;
  /** 当前测试的子会话清单（可变） */
  let children: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    posted = [];
    fireDispose = undefined;
    lastPanel = undefined;
    children = ['session-child'];
    mocks.createWebviewPanel.mockImplementation((_type, _title, _column, options) =>
      makePanel(options),
    );
    openSession = vi.fn(async () => undefined);
    rebuildHistory = vi.fn((): WorkbenchHistoryResult => ({
      children: [],
      coverage: 'complete',
      totalRounds: 0,
      scannedRounds: 0,
      unreadableRecords: 0,
    }));
    panel = new MemoraWorkbenchPanel({
      extensionUri: {} as never,
      dataSource: {
        rebuildHistory,
        buildInputs: (orchestratorId, history, seatSource) =>
          makeInputs(children, orchestratorId, history, seatSource),
      },
      openSession,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('创建选项不含 retainContextWhenHidden（不保活是设计，不是默认值碰巧）', () => {
    panel.open('session-agent');
    const options = mocks.createWebviewPanel.mock.calls[0][3] as Record<string, unknown>;
    expect(options.retainContextWhenHidden).not.toBe(true);
    expect(options.enableScripts).toBe(true);
    // 资源根收窄到 dist/webview（与设置面板同一约束；不放行数据目录）
    expect((options.localResourceRoots as { path: string }[]).map((root) => root.path)).toEqual([
      'mock://dist/webview',
    ]);
  });

  it('ready 之前不投递', () => {
    panel.open('session-agent');
    expect(snapshots()).toHaveLength(0);
  });

  it('ready 后投递一份全量快照（两块都在）', () => {
    panel.open('session-agent');
    receiveMsg?.({ type: 'ready' });
    const all = snapshots() as {
      snapshot: { orchestrator: { sessionId: string; name: string }; jobs: unknown[] };
    }[];
    expect(all).toHaveLength(1);
    expect(all[0].snapshot.orchestrator).toMatchObject({
      sessionId: 'session-agent',
      name: 'Memora',
    });
    expect(all[0].snapshot.jobs).toHaveLength(1);
  });

  it('连发两次 ready → 两次都全量回放（不依赖旧 webview 内存）', () => {
    panel.open('session-agent');
    receiveMsg?.({ type: 'ready' });
    // 两次之间数据变化：第二份必须是新事实（全量，而非增量补丁）
    children = ['session-child', 'session-child-2'];
    receiveMsg?.({ type: 'ready' });
    const all = snapshots() as { snapshot: { jobs: unknown[] } }[];
    expect(all).toHaveLength(2);
    expect(all[1].snapshot.jobs).toHaveLength(2);
  });

  it('关闭后重开 = 新面板 + 新 ready 全量回放', () => {
    panel.open('session-agent');
    receiveMsg?.({ type: 'ready' });
    expect(snapshots()).toHaveLength(1);
    fireDispose?.();
    // 关闭后再打开必须是新面板（不复用已销毁的 webview）
    panel.open('session-agent');
    expect(mocks.createWebviewPanel).toHaveBeenCalledTimes(2);
    expect(snapshots()).toHaveLength(1); // 新面板尚未 ready
    receiveMsg?.({ type: 'ready' });
    expect(snapshots()).toHaveLength(2);
  });

  it('隐藏即归零就绪位：reveal 后必须等新 ready，不向已销毁上下文投递', () => {
    panel.open('session-agent');
    receiveMsg?.({ type: 'ready' });
    const before = snapshots().length;
    // 隐藏：webview 上下文被销毁（不保活）
    setPanelVisible?.(false);
    // 再显示但脚本尚未 ready：不得把快照投给不存在的上下文
    setPanelVisible?.(true);
    expect(snapshots()).toHaveLength(before);
    // 新脚本 ready 后恢复全量回放
    receiveMsg?.({ type: 'ready' });
    expect(snapshots()).toHaveLength(before + 1);
  });

  it('可见期定时刷新只触发既有事实重读（隐藏即停）', () => {
    vi.useFakeTimers();
    panel.open('session-agent');
    receiveMsg?.({ type: 'ready' });
    expect(snapshots()).toHaveLength(1);
    children = ['session-child', 'session-child-2'];
    vi.advanceTimersByTime(3000);
    expect(snapshots()).toHaveLength(2);
    // 隐藏后计时器停止：推进时间不再产生投递
    setPanelVisible?.(false);
    vi.advanceTimersByTime(9000);
    expect(snapshots()).toHaveLength(2);
  });

  it('历史重建只在打开时做一次（刷新与定时器不重读盘）', () => {
    vi.useFakeTimers();
    panel.open('session-agent');
    expect(rebuildHistory).toHaveBeenCalledTimes(1);
    receiveMsg?.({ type: 'ready' });
    vi.advanceTimersByTime(6000);
    // 三次 push（ready + 两次定时）都不再重建
    expect(snapshots()).toHaveLength(3);
    expect(rebuildHistory).toHaveBeenCalledTimes(1);
    // 重新打开（换座位）才再重建一次
    panel.open('session-other');
    expect(rebuildHistory).toHaveBeenCalledTimes(2);
    expect(rebuildHistory).toHaveBeenLastCalledWith('session-other');
  });

  it('「去这个会话」只上报意图，由注入的回调切换会话', () => {
    panel.open('session-agent');
    receiveMsg?.({ type: 'workbench_open_session', sessionId: 'session-child' });
    expect(openSession).toHaveBeenCalledWith('session-child');
  });

  it('重复打开只 reveal 同一面板（改绑座位后现场刷新）', () => {
    panel.open('session-agent');
    receiveMsg?.({ type: 'ready' });
    panel.open('session-other');
    expect(mocks.createWebviewPanel).toHaveBeenCalledTimes(1);
    expect(lastPanel?.reveal).toHaveBeenCalled();
    const all = snapshots() as { snapshot: { orchestrator: { sessionId: string } } }[];
    expect(all.at(-1)?.snapshot.orchestrator.sessionId).toBe('session-other');
  });

  it('座位来源透传给快照：history = 重启后按历史重建（未传时缺省 live）', () => {
    panel.open('session-agent', { seatSource: 'history' });
    receiveMsg?.({ type: 'ready' });
    const all = snapshots() as { snapshot: { seatSource: string } }[];
    expect(all.at(-1)?.snapshot.seatSource).toBe('history');
    // 未显式传来源的既有调用保持实时语义
    panel.open('session-agent');
    expect((snapshots().at(-1) as { snapshot: { seatSource: string } }).snapshot.seatSource).toBe(
      'live',
    );
  });
});
