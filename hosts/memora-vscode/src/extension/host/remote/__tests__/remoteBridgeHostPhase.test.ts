/**
 * 远程桥宿主端口 · confirmPending 接真守卫（2026-11-27）
 *
 * 背景：台账 REMOTE-LAN-1 明确未做⑤——`phaseOf` 第二参长期硬传 `false`，
 * 使得 `remotePhaseOf` 的 `confirm-pending` 分支在生产永不触发（判据表在、喂表的事实是假）。
 * 本文件只钉住这一根线：`createRemoteBridgePorts().phaseOf` 必须把
 * `panel.confirmPendingCount(sid) > 0` 作为第二参接进唯一折算点。
 *
 * 判据独立：期望相位**手写**，不 import `remotePhaseOf` 的返回值当期望
 * （那会让「折算点改坏」与「调用点改坏」互相遮蔽，两处全绿即假绿）。
 */
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import type { TurnState } from '../../../../shared/protocol.js';

const h = vi.hoisted(() => ({
  l10n: { t: (s: string) => s },
}));

vi.mock('vscode', () => ({
  l10n: h.l10n,
  window: { showWarningMessage: vi.fn() },
  workspace: { workspaceFolders: [] },
}));

import { createRemoteBridgePorts } from '../remoteBridgeHost.js';
import type { RemotePanelPort } from '../remoteBridgeHost.js';

const RUNNING: TurnState = { phase: 'running', roundId: 'r1' };
const IDLE: TurnState = { phase: 'idle' };

function makePanel(state: TurnState, pending: number): RemotePanelPort {
  return {
    projectSession: () =>
      ({
        state,
        rounds: [],
        pendingQueue: [],
        // 只取 phaseOf 所需的三键；其余字段本用例不消费
      }) as ReturnType<RemotePanelPort['projectSession']>,
    buildLiveTurnFromBuffer: () => undefined,
    handleInput: async () => undefined,
    getAssistantSessionId: () => undefined,
    confirmPendingCount: () => pending,
    answerConfirm: () => true,
  };
}

function makePorts(state: TurnState, pending: number) {
  return createRemoteBridgePorts({
    panel: makePanel(state, pending),
    store: { listSessions: () => ['s1'] } as never,
    log: () => undefined,
  });
}

describe('remoteBridgeHost · phaseOf 的 confirmPending 接真（REMOTE-LAN-1⑤）', () => {
  it('待裁决时 running 折算为 confirm-pending（不是 running）', () => {
    expect(makePorts(RUNNING, 1).phaseOf('s1')).toBe('confirm-pending');
  });

  it('待裁决时 idle 也折算为 confirm-pending（优先级最高）', () => {
    expect(makePorts(IDLE, 2).phaseOf('s1')).toBe('confirm-pending');
  });

  it('无待裁决时保持原折算：running / idle', () => {
    expect(makePorts(RUNNING, 0).phaseOf('s1')).toBe('running');
    expect(makePorts(IDLE, 0).phaseOf('s1')).toBe('idle');
  });

  it('接真按 sid 取数：只有被问的会话有待裁决才收紧', () => {
    const panel: RemotePanelPort = {
      ...makePanel(RUNNING, 0),
      confirmPendingCount: (sid: string) => (sid === 'busy' ? 1 : 0),
    };
    const ports = createRemoteBridgePorts({
      panel,
      store: { listSessions: () => ['busy', 'free'] } as never,
      log: () => undefined,
    });
    expect(ports.phaseOf('busy')).toBe('confirm-pending');
    expect(ports.phaseOf('free')).toBe('running');
  });
});

describe('remoteBridgeHost · snapshot 带 live 投影（REMOTE-RICH-DELTA-1①）', () => {
  const LIVE = {
    roundId: 'r-live',
    streamingText: '流中正文',
    processEvents: [{ type: 'thinking', seq: 1, ts: 't', payload: { phase: 'thought' } }],
  } as never;

  it('snapshot / phaseOf 都把 buildLiveTurnFromBuffer 的 live 轮传给 projectSession', () => {
    const seen: Array<unknown> = [];
    const panel: RemotePanelPort = {
      ...makePanel(RUNNING, 0),
      projectSession: (_sid, live) => {
        seen.push(live);
        return { state: RUNNING, rounds: [], pendingQueue: [] } as never;
      },
      buildLiveTurnFromBuffer: (sid: string) => (sid === 's1' ? LIVE : undefined),
    };
    const ports = createRemoteBridgePorts({
      panel,
      store: { listSessions: () => ['s1'] } as never,
      log: () => undefined,
    });
    ports.snapshot('s1');
    ports.phaseOf('s1');
    expect(seen).toEqual([LIVE, LIVE]);
  });

  it('无 live（未开流 / 缓冲归属别的会话）时传 undefined，投影零变化', () => {
    const seen: Array<unknown> = [];
    const panel: RemotePanelPort = {
      ...makePanel(IDLE, 0),
      projectSession: (_sid, live) => {
        seen.push(live);
        return { state: IDLE, rounds: [], pendingQueue: [] } as never;
      },
    };
    const ports = createRemoteBridgePorts({
      panel,
      store: { listSessions: () => ['s1'] } as never,
      log: () => undefined,
    });
    ports.snapshot('s1');
    expect(seen).toEqual([undefined]);
  });
});
