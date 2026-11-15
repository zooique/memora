/**
 * 「打开工作台」座位解析测试
 *
 * 钉住的判据：
 *   - 本进程有托管座位（唯一 / 多条 QuickPick）⇒ 按 `live` 打开；
 *   - 本进程托管表为空（重启后）但历史里有托管来源会话 ⇒ 按 `history` 只读打开，
 *     **不再**用「当前没有代理」把入口关掉；
 *   - 实时与历史都没有托管记录 ⇒ 如实提示、不打开空面板；
 *   - 当前显示会话恰是历史候选时优先沿用它（少一次选择）。
 *
 * 测试形态：mock `vscode`（只实现本命令用到的 window / l10n），依赖用结构替身注入。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionMeta } from '@zooique/memora';

/** 测试替身：命令用到的 vscode 面（hoisted 便于在 vi.mock 工厂里引用） */
const mocks = vi.hoisted(() => ({
  showInformationMessage: vi.fn(),
  showQuickPick: vi.fn(),
}));

vi.mock('vscode', () => ({
  l10n: { t: (message: string) => message },
  window: {
    showInformationMessage: mocks.showInformationMessage,
    showQuickPick: mocks.showQuickPick,
  },
  commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
}));

import { openWorkbench, type OpenWorkbenchDeps } from '../openWorkbench.js';

/** 构造会话元数据（只填座位解析会读的字段） */
function meta(
  sessionId: string,
  origin: 'hosted' | 'user' | undefined,
  updatedAt: string,
): SessionMeta {
  return { sessionId, origin, updatedAt, messageCount: 0 } as SessionMeta;
}

/** 依赖替身的可调项 */
interface DepsOptions {
  /** 当前显示会话 */
  current?: string;
  /** 本进程托管座位表 */
  managed?: string[];
  /** 持久历史里的会话元数据 */
  metas?: SessionMeta[];
}

/** 构造依赖替身（默认：无当前会话、无托管、无历史记录） */
function makeDeps(options: DepsOptions = {}): {
  deps: OpenWorkbenchDeps;
  open: ReturnType<typeof vi.fn>;
} {
  const open = vi.fn();
  return {
    open,
    deps: {
      chatProvider: {
        getCurrentSessionId: () => options.current,
      } as never,
      workbench: { open } as never,
      sessionModes: {
        isManaged: (sessionId: string) => (options.managed ?? []).includes(sessionId),
        listManagedSessionIds: () => options.managed ?? [],
      } as never,
      sessionStore: {
        getSessionMeta: (sessionId: string) =>
          (options.metas ?? []).find((item) => item.sessionId === sessionId),
        listSessionMetas: () => options.metas ?? [],
      } as never,
    },
  };
}

describe('openWorkbench — 座位解析', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('本进程唯一托管会话：直接按 live 打开', async () => {
    const h = makeDeps({ managed: ['session-seat'] });
    await openWorkbench(h.deps);
    expect(h.open).toHaveBeenCalledWith('session-seat', { seatSource: 'live' });
  });

  it('本进程多条托管会话：QuickPick 选中后按 live 打开', async () => {
    mocks.showQuickPick.mockResolvedValue({ sessionId: 'session-b' });
    const h = makeDeps({ managed: ['session-a', 'session-b'] });
    await openWorkbench(h.deps);
    expect(h.open).toHaveBeenCalledWith('session-b', { seatSource: 'live' });
  });

  it('重启后托管表为空：从历史托管来源会话按 history 只读打开（不再拒绝）', async () => {
    const h = makeDeps({
      metas: [
        meta('session-old', 'hosted', '2026-11-13T00:00:00.000Z'),
        meta('session-new', 'hosted', '2026-11-14T00:00:00.000Z'),
      ],
    });
    // 多条历史候选 ⇒ QuickPick（标题取会话元数据，id 作描述）
    mocks.showQuickPick.mockResolvedValue({ sessionId: 'session-new' });
    await openWorkbench(h.deps);
    expect(mocks.showQuickPick).toHaveBeenCalledTimes(1);
    expect(h.open).toHaveBeenCalledWith('session-new', { seatSource: 'history' });
    expect(mocks.showInformationMessage).not.toHaveBeenCalled();
  });

  it('当前显示会话恰是历史托管会话：优先沿用它，不弹选择', async () => {
    const h = makeDeps({
      current: 'session-current',
      metas: [meta('session-current', 'hosted', '2026-11-14T00:00:00.000Z')],
    });
    await openWorkbench(h.deps);
    expect(mocks.showQuickPick).not.toHaveBeenCalled();
    expect(h.open).toHaveBeenCalledWith('session-current', { seatSource: 'history' });
  });

  it('实时与历史都没有托管记录：如实提示，不打开空面板', async () => {
    const h = makeDeps({
      metas: [meta('session-self', 'user', '2026-11-14T00:00:00.000Z')],
    });
    await openWorkbench(h.deps);
    expect(h.open).not.toHaveBeenCalled();
    expect(mocks.showInformationMessage).toHaveBeenCalledWith(
      'No hosted session was found in the history',
    );
  });
});
