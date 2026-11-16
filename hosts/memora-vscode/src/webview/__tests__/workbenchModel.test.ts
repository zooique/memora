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
import type { WorkbenchHistoryResult } from '../helpers/workbenchHistory.js';

/** 空历史（本进程账本不为空时的默认：没有历史可补，但也不算读失败） */
function emptyHistory(overrides: Partial<WorkbenchHistoryResult> = {}): WorkbenchHistoryResult {
  return {
    children: [],
    // 本用例不验派发记录：空数组 = 这段历史里没有（工作台投影不消费它）
    dispatches: [],
    coverage: 'complete',
    totalRounds: 0,
    scannedRounds: 0,
    unreadableRecords: 0,
    // 本用例不验派发反查口径：0 会话 = 没有候选
    dispatchScan: { sessions: 0, truncated: 0, foreign: 0 },
    ...overrides,
  };
}

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
    seatSource: 'live',
    agentName: 'Memora',
    readMeta: (sessionId) => meta(sessionId, '2026-11-14T10:00:00.000Z'),
    readRolePackName: () => undefined,
    readRolePackDisplayName: () => undefined,
    isManaged: () => true,
    isAgentDriven: () => true,
    childrenOf: () => [],
    history: emptyHistory(),
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
    const snapshot = buildWorkbenchSnapshot(baseInputs());
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.coverage).toBe('complete');
    expect(snapshot.missingCount).toBe(0);
  });

  it('重启后账本为空：历史重建出的子会话照样进清单（标题退创建时给的标题）', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        history: emptyHistory({
          children: [{ sessionId: 'session-from-history', title: '整理周报', via: 'create' }],
          totalRounds: 3,
          scannedRounds: 3,
        }),
      }),
    );
    expect(snapshot.jobs.map((job) => job.sessionId)).toEqual(['session-from-history']);
    // 会话元数据没名字 → 用创建时给的标题，而不是时间占位标题
    expect(snapshot.jobs[0].title).toBe('整理周报');
  });

  it('用户收回后：账本 / 历史还记着也不进清单（判据 = 当前驱动权，不是出生记录）', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        childrenOf: () => ['session-revoked'],
        // 出生记录明确是代理开的，但当前已归用户
        isAgentDriven: () => false,
        history: emptyHistory({
          children: [{ sessionId: 'session-revoked', title: '旧任务', via: 'create' }],
          totalRounds: 1,
          scannedRounds: 1,
        }),
      }),
    );
    expect(snapshot.jobs).toEqual([]);
    // 主动收回不是数据缺失，不记 missingCount，也不把 coverage 拉成 partial；
    // 但必须留下「有记录、被驱动权过滤」的事实，界面据此说清而不是说「还没有」
    expect(snapshot.filteredCount).toBe(1);
    expect(snapshot.missingCount).toBe(0);
    expect(snapshot.coverage).toBe('complete');
  });

  it('座位被收回（revoked）：仍按实时驱动权过滤，被收回的记录不计入在管清单', () => {
    // 判据要点：收回发生在本进程里 ⇒ 驱动权是实时事实，不能像 history 那样整批放行
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        seatSource: 'revoked',
        childrenOf: () => ['session-revoked'],
        isAgentDriven: () => false,
        history: emptyHistory({
          children: [{ sessionId: 'session-revoked', title: '旧任务', via: 'create' }],
          totalRounds: 1,
          scannedRounds: 1,
        }),
      }),
    );
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.filteredCount).toBe(1);
    expect(snapshot.seatSource).toBe('revoked');
  });

  it('恢复的座位（restored）：也没有实时驱动事实，历史记录照样进清单（真机：整片消失）', () => {
    // 判据要点：恢复座位的驱动归属不落盘，进程内集合必空——照旧过滤会把「被派过活」的
    // 历史记录全挡掉，真机表现 = 重启后工作台清单为空。判据统一在 filtersByLiveDriver。
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        seatSource: 'restored',
        isAgentDriven: () => false,
        history: emptyHistory({
          children: [{ sessionId: 'session-delegated', title: '被派过活', via: 'delegate' }],
          totalRounds: 2,
          scannedRounds: 2,
        }),
      }),
    );
    expect(snapshot.jobs.map((job) => job.sessionId)).toEqual(['session-delegated']);
    expect(snapshot.jobs[0].via).toBe('delegate');
    expect(snapshot.filteredCount).toBe(0);
    expect(snapshot.seatSource).toBe('restored');
  });

  it('历史重建模式（无实时驱动方）：不按当前驱动权过滤，历史记录照样只读列出', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        seatSource: 'history',
        // 重启后进程内驱动集合为空：照旧过滤会把历史记录全挡掉
        isAgentDriven: () => false,
        history: emptyHistory({
          children: [{ sessionId: 'session-from-history', title: '整理周报', via: 'create' }],
          totalRounds: 1,
          scannedRounds: 1,
        }),
      }),
    );
    expect(snapshot.jobs.map((job) => job.sessionId)).toEqual(['session-from-history']);
    // 座位来源原样透出，界面据此说清「重启后按历史重建」
    expect(snapshot.seatSource).toBe('history');
    // 重建模式没有实时驱动事实 ⇒ 不说「被过滤」
    expect(snapshot.filteredCount).toBe(0);
  });

  it('历史里有 sid 但会话已删除：跳过并计数，清单不静默少一条', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        readMeta: (sessionId) =>
          sessionId === 'session-gone' ? undefined : meta(sessionId, '2026-11-14T10:00:00.000Z'),
        history: emptyHistory({
          children: [{ sessionId: 'session-gone', title: '旧任务', via: 'create' }],
          totalRounds: 1,
          scannedRounds: 1,
        }),
      }),
    );
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.missingCount).toBe(1);
    // 不是 complete：界面不得用「还没有交给助手的活」盖过去
    expect(snapshot.coverage).toBe('partial');
  });

  it('历史读不到 + 账本为空：coverage=unreadable（不是 complete 的空清单）', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({ history: emptyHistory({ coverage: 'unreadable' }) }),
    );
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.coverage).toBe('unreadable');
  });

  it('座位会话本身已不存在：清单一律按读不到处理', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        readMeta: (sessionId) =>
          sessionId === 'session-agent' ? undefined : meta(sessionId, '2026-11-14T10:00:00.000Z'),
      }),
    );
    expect(snapshot.coverage).toBe('unreadable');
  });

  it('超过扫描上限：扫描口径原样透出（界面据此说读不全）', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        history: emptyHistory({ totalRounds: 120, scannedRounds: 60, coverage: 'partial' }),
      }),
    );
    expect(snapshot.scan).toMatchObject({ totalRounds: 120, scannedRounds: 60 });
    expect(snapshot.coverage).toBe('partial');
    // 理由随结论一起透出：界面不再从 scan 自行推断「为什么 partial」
    expect(snapshot.coverageReasons).toEqual([{ kind: 'history-window' }]);
  });

  it('反查窗口截断：partial 的理由是 dispatch-window（与工具同一份判据）', () => {
    const snapshot = buildWorkbenchSnapshot(
      baseInputs({
        history: emptyHistory({ dispatchScan: { sessions: 3, truncated: 2, foreign: 0 } }),
      }),
    );
    expect(snapshot.coverage).toBe('partial');
    expect(snapshot.coverageReasons).toEqual([{ kind: 'dispatch-window', count: 2 }]);
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
    expect(snapshot.missingCount).toBe(1);
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

describe('工作台末轮运行情况摘要（WorkbenchJob.latest）', () => {
  /** 构造可投影的整轮（id / 状态 / 用户输入 / 回答 / 时间） */
  function fullRound(
    id: string,
    status: RoundStatus,
    userText: string,
    answer?: string,
  ): Round {
    return {
      id,
      status,
      userMessage: { id: `msg-${id}`, role: 'user', content: userText, timestamp: '2026-11-16T10:00:00.000Z' },
      ...(answer
        ? { assistantMessage: { id: `msg-a-${id}`, role: 'assistant', content: answer, timestamp: '2026-11-16T10:01:00.000Z' } }
        : {}),
      createdAt: '2026-11-16T10:00:00.000Z',
    } as unknown as Round;
  }

  const withChild = (overrides: Partial<WorkbenchSnapshotInputs>): WorkbenchSnapshotInputs =>
    baseInputs({ childrenOf: () => ['session-child'], ...overrides });

  it('完成轮：摘要带用户输入 + 回答片段 + 轮序号（分母 = 轮 id 列表长度）', () => {
    const snapshot = buildWorkbenchSnapshot(
      withChild({
        readRoundIds: () => ['round-1', 'round-2'],
        readRound: (id) => fullRound(id, 'complete', '调查情报 A', '结论：A 已核实'),
        readRoundStatus: () => 'complete',
      }),
    );
    expect(snapshot.jobs[0]?.latest).toMatchObject({
      roundId: 'round-2',
      request: '调查情报 A',
      response: '结论：A 已核实',
      status: 'complete',
      totalRounds: 2,
      index: 2,
    });
  });

  it('运行中轮：只有用户输入与状态，不伪造回答（Write-once 边界）', () => {
    const snapshot = buildWorkbenchSnapshot(
      withChild({
        readRoundIds: () => ['round-1'],
        // 即便替身里给回答字段，pending 状态也不投影（内核运行中轮本就没有落盘回答）
        readRound: (id) => fullRound(id, 'pending', '正在做的事', '伪造的回答'),
        readRoundStatus: () => 'pending',
      }),
    );
    const latest = snapshot.jobs[0]?.latest;
    expect(latest?.request).toBe('正在做的事');
    expect(latest?.status).toBe('pending');
    expect(latest?.response).toBeUndefined();
  });

  it('无轮 / 末轮读不到：整条不填（界面据此说「无法读取末轮」，不冒充空摘要）', () => {
    const noRounds = buildWorkbenchSnapshot(withChild({ readRoundIds: () => [] }));
    expect(noRounds.jobs[0]?.latest).toBeUndefined();
    const unreadable = buildWorkbenchSnapshot(
      withChild({ readRoundIds: () => ['round-x'], readRound: () => undefined }),
    );
    expect(unreadable.jobs[0]?.latest).toBeUndefined();
  });

  it('超长文本截断（摘要不撑爆窄列），截断后仍保留首段事实', () => {
    const long = '很长用户输入'.repeat(60);
    const snapshot = buildWorkbenchSnapshot(
      withChild({
        readRoundIds: () => ['round-1'],
        readRound: (id) => fullRound(id, 'complete', long),
        readRoundStatus: () => 'complete',
      }),
    );
    const request = snapshot.jobs[0]?.latest?.request ?? '';
    expect(request.length).toBeLessThan(long.length);
    expect(request.endsWith('…')).toBe(true);
    expect(request.startsWith('很长用户输入')).toBe(true);
  });
});
