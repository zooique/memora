/**
 * chatPanel 手动归档入口（manual 模式嫁接「移入留存区」· 2026-10-19）
 *
 * 背景：`memora.archiveMode = manual` 承诺「仅手动触发时生成会话摘要」，但宿主原本
 * **零入口**（内核 `Agent.archiveSession` 已就绪、无人调用）。用户拍板嫁接到历史浮层
 * 逐条的「移入留存区」按钮（= 用户「这个会话我处理完了」的既有手势）。
 *
 * 本文件守卫的是该嫁接口的三条定案 + 两条不伤既有行为：
 *   ① 模式门控：仅 manual 触发；full 模式按钮**零动作**（既有文案一字不差）
 *   ② 防重判据不在宿主：传 `{ skipIfUnchanged: true }` 交内核单点判断
 *      ——不自查「summary 是否存在」（那判据更粗，会挡掉「有新内容本该刷新」的归档）
 *   ③ 留存幂等先挡：重复点击在 `sessionStore.archiveSession` 返回 false 时早退，
 *      归档根本不会被触发（防重第一道闸在宿主、第二道闸在内核快照）
 *   ④ 运行时真值推送：Agent 未装配时**不推送**任何值（不编造）
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
// 临时目录统一入口：建目录 + 模块顶层注册清理（禁止裸 mkdtempSync，见 helpers/tmpDir.ts）
import { makeTempDir } from '../../__tests__/helpers/tmpDir.js';
import type { Agent, Round } from '@zooique/memora';
import { WorkspaceSessionStore } from '../../extension/host/sessionStore.js';
import { WorkspaceRoundStore } from '../../extension/host/workspaceRoundStore.js';
import { MemoraChatViewProvider } from '../panels/chatPanel.js';

// mock vscode：仅提供 chatPanel 构造/推送用到的最小 API（同 chatPanelHistory 基线）
/** l10n.t 替身：{0}/{1} 占位符按参替换（vi.hoisted——mock 工厂先于 import 执行，import 绑定不可用） */
const tStub = vi.hoisted(() => (msg: string, ...args: unknown[]): string => {
  let out = msg;
  args.forEach((arg, i) => {
    out = out.replaceAll(`{${i}}`, String(arg));
  });
  return out;
});

vi.mock('vscode', async () => {
  const uri = {
    joinPath: (base: unknown, ...p: string[]) => ({ base, segments: p }),
    fsPath: '/mock/path',
  };
  return {
    l10n: { t: tStub },
    Uri: uri,
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
  };
});

/** 归档模式运行时真值（替身：getArchiveMode 返回值，用例就地设定） */
let stubMode: 'full' | 'manual' = 'full';

/** agent 替身：只补本用例契约内的最小面（getArchiveMode + archiveSession） */
function agentStub(): { agent: Agent; archiveSession: ReturnType<typeof vi.fn> } {
  const archiveSession = vi.fn().mockResolvedValue({
    updatedFields: ['summary'],
    sessionLabel: '2026-08-14-s2',
    messageCount: 2,
  });
  const agent = {
    getArchiveMode: () => stubMode,
    archiveSession,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as Agent;
  return { agent, archiveSession };
}

function setup(): {
  store: WorkspaceSessionStore;
  roundStore: WorkspaceRoundStore;
  provider: MemoraChatViewProvider;
  posted: unknown[];
} {
  const dir = makeTempDir('memora-manual-archive-');
  const roundStore = new WorkspaceRoundStore(dir);
  roundStore.load();
  const store = new WorkspaceSessionStore(dir, roundStore);
  store.load();

  const providerStore = {
    listMasked: async () => [],
    getActiveName: () => undefined,
    getActive: async () => undefined,
  } as never;

  const provider = new MemoraChatViewProvider(
    { fsPath: '/mock/uri' } as never,
    store,
    providerStore,
    '/mock/workspace',
  );
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

  return { store, roundStore, provider, posted };
}

/** 落一条非当前会话（当前会话固定为 2026-08-15-s1，历史列表设计收敛不含它） */
function seedSession(
  store: WorkspaceSessionStore,
  roundStore: WorkspaceRoundStore,
  sessionId: string,
): void {
  const idx = sessionId.lastIndexOf('-');
  const date = sessionId.slice(0, idx);
  const session = sessionId.slice(idx + 1);
  const roundId = `round-${roundStore.size() + 1}`;
  const round: Round = {
    id: roundId,
    userMessage: { id: `${roundId}-user`, role: 'user', content: '问', timestamp: 't1' },
    assistantMessage: {
      id: `${roundId}-assistant`,
      role: 'assistant',
      content: '答',
      timestamp: 't2',
    },
    status: 'complete',
    createdAt: 't1',
    completedAt: 't2',
    refCount: 1,
  };
  roundStore.save(round);
  store.appendRoundId(`${date}-${session}`, roundId);
}

/** 从 posted 中按 type 过滤消息 */
function ofType<T extends { type: string }>(posted: unknown[], type: string): T[] {
  return posted.filter((m) => (m as { type: string }).type === type) as T[];
}

/** 注入 agent 替身（chatPanel 私有字段，测试驱动同 chatPanelAssemblyRetry 基线） */
function injectAgent(provider: MemoraChatViewProvider, agent: Agent | null): void {
  (provider as unknown as { _agent: Agent | null })._agent = agent;
}

/**
 * 驱动「移入留存区」入口（私有方法）
 *
 * 6.0.0 起 `handleArchiveSession` 为 async（一次性写要先拿跨进程短持有锁）：
 * 这里必须 await，否则同步断言会跑在锁获取之前（归档 0 次、notice 尚未推送）。
 */
async function moveToRetention(provider: MemoraChatViewProvider, sessionId: string): Promise<void> {
  await (
    provider as unknown as { handleArchiveSession(id: string): Promise<void> }
  ).handleArchiveSession(sessionId);
}

describe('chatPanel 手动归档入口（manual 模式嫁接留存按钮 · 2026-10-19）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMode = 'full';
  });

  it('manual 模式：移入留存区顺带触发归档，且防重判据交内核（{ skipIfUnchanged: true }）', async () => {
    const { store, roundStore, provider, posted } = setup();
    seedSession(store, roundStore, '2026-08-14-s2');
    const { agent, archiveSession } = agentStub();
    stubMode = 'manual';
    injectAgent(provider, agent);

    await moveToRetention(provider, '2026-08-14-s2');

    // 防重判据不落宿主：形态即契约——传 skipIfUnchanged 让内核单点判断（消息数快照）
    expect(archiveSession).toHaveBeenCalledTimes(1);
    expect(archiveSession).toHaveBeenCalledWith('2026-08-14', 's2', { skipIfUnchanged: true });
    // 文案必须说全两件事（按钮兼做归档触发，只写「移入留存区」= 瞒报一次 LLM 调用）
    const notices = ofType<{ type: string; message: string }>(posted, 'notice');
    expect(notices.at(-1)?.message).toContain('session summary update requested');
  });

  it('full 模式：按钮零归档动作 + 文案与改动前一字不差（不给既有用户加 LLM 成本）', async () => {
    const { store, roundStore, provider, posted } = setup();
    seedSession(store, roundStore, '2026-08-14-s2');
    const { agent, archiveSession } = agentStub();
    stubMode = 'full';
    injectAgent(provider, agent);

    await moveToRetention(provider, '2026-08-14-s2');

    expect(archiveSession).not.toHaveBeenCalled();
    const notices = ofType<{ type: string; message: string }>(posted, 'notice');
    expect(notices.at(-1)?.message).toBe(
      'Moved to retained (content preserved; you can move it back anytime)',
    );
  });

  it('Agent 未就绪：不触发归档、不抛错，留存照常生效且文案不提摘要（不编造承诺）', async () => {
    const { store, roundStore, provider, posted } = setup();
    seedSession(store, roundStore, '2026-08-14-s2');
    injectAgent(provider, null); // 装配未完成

    await expect(moveToRetention(provider, '2026-08-14-s2')).resolves.toBeUndefined();
    expect(store.isArchived('2026-08-14-s2')).toBe(true); // 留存（本地动作）照常生效
    const notices = ofType<{ type: string; message: string }>(posted, 'notice');
    expect(notices.at(-1)?.message).toBe(
      'Moved to retained (content preserved; you can move it back anytime)',
    );
  });

  it('重复点击：留存幂等早退 ⇒ 归档根本不被触发（防重第一道闸在宿主）', async () => {
    const { store, roundStore, provider } = setup();
    seedSession(store, roundStore, '2026-08-14-s2');
    const { agent, archiveSession } = agentStub();
    stubMode = 'manual';
    injectAgent(provider, agent);

    await moveToRetention(provider, '2026-08-14-s2');
    await moveToRetention(provider, '2026-08-14-s2'); // 已在留存区 → archiveSession 返回 false 早退

    expect(archiveSession).toHaveBeenCalledTimes(1);
  });

  it('pushArchiveModeRuntime：有 Agent 推运行时真值；无 Agent 不推（不编造）', () => {
    const { provider, posted } = setup();
    const { agent } = agentStub();
    stubMode = 'manual';
    injectAgent(provider, agent);
    (provider as unknown as { pushArchiveModeRuntime(): void }).pushArchiveModeRuntime();
    expect(ofType<{ type: string; mode: string }>(posted, 'chat_archive_mode').at(-1)?.mode).toBe(
      'manual',
    );

    // Agent 未装配：运行时真值此刻不存在 → 一条都不推（webview 维持初值 'full'）
    injectAgent(provider, null);
    (provider as unknown as { pushArchiveModeRuntime(): void }).pushArchiveModeRuntime();
    expect(ofType<{ type: string; mode: string }>(posted, 'chat_archive_mode')).toHaveLength(1);
  });

  it('onArchiveModeChanged：notice 之后顺带推运行时真值（按钮文案随之切换）', () => {
    const { provider, posted } = setup();
    const { agent } = agentStub();
    stubMode = 'manual';
    injectAgent(provider, agent);

    (
      provider as unknown as {
        _notice: {
          onArchiveModeChanged(info: { from: string; to: string }): void;
        };
      }
    )._notice.onArchiveModeChanged({ from: 'full', to: 'manual' });

    const notices = ofType<{ type: string; message: string }>(posted, 'notice');
    // 宿主默认语言 = 英文（l10n 无译文时 t() 返回源键本身），故断言英文源键
    expect(notices.at(-1)?.message).toBe('Archive mode changed: full → manual');
    expect(ofType<{ type: string; mode: string }>(posted, 'chat_archive_mode').at(-1)?.mode).toBe(
      'manual',
    );
  });
});
