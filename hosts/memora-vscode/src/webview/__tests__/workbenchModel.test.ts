/**
 * 工作台投影（`helpers/workbenchModel`）测试
 *
 * 钉住的判据（全部来自用户交付口径）：
 *   - 状态只从既有事实推：等你 > 在跑 > 终态；
 *   - 被中止必须带已落地的原因（用户 / 超时 / 异常原文 / 取不到）；
 *   - 取不到原因时**不伪造**（不得回落「用户停止」）；
 *   - 未收场 / 无轮 / 读不到状态各自如实标，不用 unknown 兜底；
 *   - 空清单就是空数组（不制造无名行）；已删除会话整条跳过。
 */
import { describe, expect, it } from 'vitest';
import type { ProcessEvent, Round, RoundStatus, SessionMeta } from '@zooique/memora';
import { buildWorkbenchSnapshot, type WorkbenchSnapshotInputs } from '../helpers/workbenchModel.js';

/** 构造一条会话元数据（只填投影会读的字段，其余按类型断言补齐） */
function meta(sessionId: string, updatedAt: string): SessionMeta {
  return { sessionId, updatedAt, createdAt: updatedAt, messageCount: 0 } as SessionMeta;
}

/** 构造一轮（只填投影会读的字段） */
function round(id: string, status: RoundStatus, events?: ProcessEvent[]): Round {
  return { id, status, processEvents: events } as Round;
}

/** 构造「用户停止」事件 */
function aborted(stopReason: string): ProcessEvent {
  return { type: 'aborted', payload: { stopReason } } as unknown as ProcessEvent;
}

/** 构造「异常」事件 */
function errored(message: string): ProcessEvent {
  return { type: 'error', payload: { message } } as unknown as ProcessEvent;
}

/** 默认读口：无子会话、无运行态、无轮 */
function baseInputs(overrides: Partial<WorkbenchSnapshotInputs> = {}): WorkbenchSnapshotInputs {
  return {
    orchestratorId: 'session-agent',
    agentName: 'Memora',
    readMeta: (sessionId) => meta(sessionId, '2026-11-14T10:00:00.000Z'),
    readRolePackName: () => undefined,
    readRolePackDisplayName: () => undefined,
    isManaged: () => true,
    childrenOf: () => [],
    peekActivity: () => ({ running: false, waiting: false }),
    readRoundIds: () => [],
    readRoundStatus: () => undefined,
    readRound: () => undefined,
    titleOf: (sessionId) => sessionId,
    ...overrides,
  };
}

/** 构造一个「单个子会话、已有一轮」的读口集合 */
function oneChild(
  status: RoundStatus,
  extra: Partial<WorkbenchSnapshotInputs> = {},
  events?: ProcessEvent[],
): WorkbenchSnapshotInputs {
  return baseInputs({
    childrenOf: () => ['session-child'],
    readRoundIds: () => ['round-1'],
    readRoundStatus: (roundId) => (roundId === 'round-1' ? status : undefined),
    readRound: (roundId) => (roundId === 'round-1' ? round('round-1', status, events) : undefined),
    ...extra,
  });
}

describe('buildWorkbenchSnapshot — 第一块：代理座位', () => {
  it('只填既有事实：名字 / 座位标题 / 托管态；角色包缺省时不留空字段', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({ titleOf: (_id, m) => (m?.displayName as string | undefined) ?? '会话标题' }),
    );
    expect(snapshot.orchestrator).toEqual({
      name: 'Memora',
      sessionId: 'session-agent',
      title: '会话标题',
      managed: true,
    });
    expect('rolePackName' in snapshot.orchestrator).toBe(false);
  });

  it('角色包有名字时带上名字；能解析展示名才带展示名', () => {
    const withName = buildWorkbenchSnapshot(baseInputs({ readRolePackName: () => 'coder' }));
    expect(withName.orchestrator.rolePackName).toBe('coder');
    expect(withName.orchestrator.rolePackDisplayName).toBeUndefined();

    const withDisplay = buildWorkbenchSnapshot(
      baseInputs({
        readRolePackName: () => 'coder',
        readRolePackDisplayName: () => '程序员',
      }),
    );
    expect(withDisplay.orchestrator.rolePackDisplayName).toBe('程序员');
  });

  it('撤销托管后如实标 managed=false（不把旧身份留在屏上）', () => {
    const snapshot = buildWorkbenchSnapshot(baseInputs({ isManaged: () => false }));
    expect(snapshot.orchestrator.managed).toBe(false);
  });
});

describe('buildWorkbenchSnapshot — 状态投影', () => {
  it('等你优先于在跑（暂停收尾窗口里不能装作还在自己推进）', () => {
    const snapshot = buildWorkbenchSnapshot(
      oneChild('pending', { peekActivity: () => ({ running: true, waiting: true }) }),
    );
    expect(snapshot.jobs[0].status).toEqual({ kind: 'waiting' });
  });

  it('在跑（运行态 streaming=true）', () => {
    const snapshot = buildWorkbenchSnapshot(
      oneChild('pending', { peekActivity: () => ({ running: true, waiting: false }) }),
    );
    expect(snapshot.jobs[0].status).toEqual({ kind: 'running' });
  });

  it('最后一轮成功 = 完成', () => {
    const snapshot = buildWorkbenchSnapshot(oneChild('complete'));
    expect(snapshot.jobs[0].status).toEqual({ kind: 'completed' });
  });

  it('已收场且未成功 + aborted(user) = 被中止（用户停止）', () => {
    const snapshot = buildWorkbenchSnapshot(oneChild('interrupted', {}, [aborted('user')]));
    expect(snapshot.jobs[0].status).toEqual({ kind: 'stopped', stop: { kind: 'user' } });
  });

  it('已收场且未成功 + aborted(timeout) = 被中止（请求超时）', () => {
    const snapshot = buildWorkbenchSnapshot(oneChild('interrupted', {}, [aborted('timeout')]));
    expect(snapshot.jobs[0].status).toEqual({ kind: 'stopped', stop: { kind: 'timeout' } });
  });

  it('已收场且未成功 + error 事件 = 被中止（异常终止，保留原始错误文本）', () => {
    const snapshot = buildWorkbenchSnapshot(oneChild('interrupted', {}, [errored('upstream 502')]));
    expect(snapshot.jobs[0].status).toEqual({
      kind: 'stopped',
      stop: { kind: 'error', message: 'upstream 502' },
    });
  });

  it('已收场且未成功但没有原因事件 → 如实标 unavailable，不伪造「用户停止」', () => {
    const snapshot = buildWorkbenchSnapshot(oneChild('interrupted'));
    expect(snapshot.jobs[0].status).toEqual({ kind: 'stopped', stop: { kind: 'unavailable' } });
  });

  it('最后一轮未收场（pending）= 上次未正常结束，不冒充被中止', () => {
    const snapshot = buildWorkbenchSnapshot(oneChild('pending'));
    expect(snapshot.jobs[0].status).toEqual({ kind: 'unsettled' });
  });

  it('一轮都没有 = 已交给助手还没开始，不冒充在跑/完成', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({ childrenOf: () => ['session-child'], readRoundIds: () => [] }),
    );
    expect(snapshot.jobs[0].status).toEqual({ kind: 'queued' });
  });

  it('轮存在但索引与正文都读不到 = 如实标不可知（不用 unknown 兜底）', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        childrenOf: () => ['session-child'],
        readRoundIds: () => ['round-1'],
        readRoundStatus: () => undefined,
        readRound: () => undefined,
      }),
    );
    expect(snapshot.jobs[0].status).toEqual({ kind: 'unreadable' });
  });

  it('索引缺失时退回整轮状态读取（不因索引未建而误报不可知）', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        childrenOf: () => ['session-child'],
        readRoundIds: () => ['round-1'],
        readRoundStatus: () => undefined,
        readRound: () => round('round-1', 'complete'),
      }),
    );
    expect(snapshot.jobs[0].status).toEqual({ kind: 'completed' });
  });
});

describe('buildWorkbenchSnapshot — 清单口径', () => {
  it('没有子会话 = 空数组（空态由 webview 说清，不摆空表格）', () => {
    expect(buildWorkbenchSnapshot(baseInputs()).jobs).toEqual([]);
  });

  it('已删除会话（读不到元数据）整条跳过，不制造无名行', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        childrenOf: () => ['session-gone', 'session-live'],
        readMeta: (sessionId) =>
          sessionId === 'session-gone' ? undefined : meta(sessionId, '2026-11-14T10:00:00.000Z'),
      }),
    );
    expect(snapshot.jobs.map((job) => job.sessionId)).toEqual(['session-live']);
  });

  it('按 updatedAt 降序（最近在办的排最前）', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        childrenOf: () => ['session-old', 'session-new'],
        readMeta: (sessionId) =>
          meta(
            sessionId,
            sessionId === 'session-old' ? '2026-11-13T00:00:00.000Z' : '2026-11-14T00:00:00.000Z',
          ),
      }),
    );
    expect(snapshot.jobs.map((job) => job.sessionId)).toEqual(['session-new', 'session-old']);
  });
});
