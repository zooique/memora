/**
 * 会话状态投影单测（`shared/sessionStatus.ts`）
 *
 * 这是工作台与主控 `list_work_sessions` 的**唯一**状态判断实现，故这里要钉住三件事：
 *   ① 主四档 + 边缘事实的分档（等你优先于在跑；未收场不冒充被中止）；
 *   ② 「读不到」= `unreadable`，**绝不**回落成空闲语义（`queued` / `completed`）——
 *      代理据此决定要不要再派活，这里误判会直接造成重复派活、重复花钱；
 *   ③ 归属三档（agent / user / unknown）与覆盖状态（complete / partial / unreadable）。
 */
import { describe, expect, it } from 'vitest';
import type { ProcessEvent, Round, RoundStatus } from '@zooique/memora';
import {
  isAgentDrivenFailClosed,
  isSessionAgentDriven,
  isUserTakingOver,
  isUserTakingOverFailClosed,
  projectCreatedBy,
  projectSessionStatus,
  resolveListCoverage,
  type SessionStatusReadPorts,
} from '../sessionStatus.js';

/** 固定时间戳（避免依赖当前时钟） */
const TS = '2026-11-14T10:00:00.000Z';

/**
 * 构造读口替身
 *
 * @param overrides 覆盖项（默认：无活动、无轮、读不到）
 * @returns 状态读口
 */
function ports(overrides: Partial<SessionStatusReadPorts> = {}): SessionStatusReadPorts {
  return {
    peekActivity: () => ({ running: false, waiting: false }),
    readRoundIds: () => [],
    readRoundStatus: () => undefined,
    readRound: () => undefined,
    ...overrides,
  };
}

/**
 * 造一条最小轮（只填状态与过程事件）
 *
 * @param status 轮状态
 * @param processEvents 过程事件（中断原因来源）
 * @returns 轮对象（其余字段用类型断言省略）
 */
function round(status: RoundStatus, processEvents: ProcessEvent[] = []): Round {
  return { id: 'r1', sessionId: 's1', status, processEvents, startedAt: TS } as unknown as Round;
}

/**
 * 造一条 aborted 事件
 *
 * @param stopReason 结构化停止原因
 * @returns 过程事件
 */
function aborted(stopReason: 'user' | 'timeout' | 'interrupted'): ProcessEvent {
  return { type: 'aborted', seq: 1, ts: TS, payload: { reason: '原始原因', stopReason } };
}

describe('projectSessionStatus — 主四档与边缘事实', () => {
  it('等你优先于在跑（暂停收尾窗口里运行态残留 streaming 也不冒充在跑）', () => {
    const status = projectSessionStatus(
      ports({ peekActivity: () => ({ running: true, waiting: true }) }),
      's1',
    );
    expect(status).toEqual({ kind: 'waiting' });
  });

  it('正在流式生成 → 在跑', () => {
    const status = projectSessionStatus(
      ports({ peekActivity: () => ({ running: true, waiting: false }) }),
      's1',
    );
    expect(status).toEqual({ kind: 'running' });
  });

  it('一轮都没有 → 尚未开始（queued），不冒充在跑 / 完成', () => {
    expect(projectSessionStatus(ports(), 's1')).toEqual({ kind: 'queued' });
  });

  it('最后一轮成功收场 → 完成', () => {
    const status = projectSessionStatus(
      ports({
        readRoundIds: () => ['r1'],
        readRoundStatus: () => 'complete',
        readRound: () => round('complete'),
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'completed' });
  });

  it('最后一轮未收场 → 未正常结束（unsettled），不冒充被中止', () => {
    const status = projectSessionStatus(
      ports({
        readRoundIds: () => ['r1'],
        readRoundStatus: () => 'pending',
        readRound: () => round('pending'),
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'unsettled' });
  });

  it('被中止 → 带已落地的原因（用户停 / 超时 / 异常原文 / 取不到）', () => {
    const interrupted = (events: ProcessEvent[]) =>
      projectSessionStatus(
        ports({
          readRoundIds: () => ['r1'],
          readRoundStatus: () => 'interrupted',
          readRound: () => round('interrupted', events),
        }),
        's1',
      );
    expect(interrupted([aborted('user')])).toEqual({ kind: 'stopped', stop: { kind: 'user' } });
    expect(interrupted([aborted('timeout')])).toEqual({
      kind: 'stopped',
      stop: { kind: 'timeout' },
    });
    expect(
      interrupted([{ type: 'error', seq: 1, ts: TS, payload: { message: 'upstream 502' } }]),
    ).toEqual({ kind: 'stopped', stop: { kind: 'error', message: 'upstream 502' } });
    // 没有可判定原因：如实 unavailable，不回落「用户停止」
    expect(interrupted([])).toEqual({ kind: 'stopped', stop: { kind: 'unavailable' } });
  });
});

describe('projectSessionStatus — 读不到不等于空闲', () => {
  it('索引与整轮都读不到 → unreadable（不是 queued，也不是 completed）', () => {
    const status = projectSessionStatus(
      ports({
        readRoundIds: () => ['r1'],
        readRoundStatus: () => undefined,
        readRound: () => undefined,
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'unreadable' });
    expect(status.kind).not.toBe('queued');
    expect(status.kind).not.toBe('completed');
  });

  it('索引缺失但整轮可读 → 用整轮状态（不因索引缺失误报读不到）', () => {
    const status = projectSessionStatus(
      ports({
        readRoundIds: () => ['r1'],
        readRoundStatus: () => undefined,
        readRound: () => round('complete'),
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'completed' });
  });
});

describe('projectSessionStatus — 托管语义状态优先（readMeta 分支）', () => {
  /**
   * 造一条托管 Worker 元数据
   *
   * @param workStatus 语义状态四态之一
   * @returns meta（origin=hosted 才进托管分支）
   */
  const hostedMeta = (workStatus: 'working' | 'blocked' | 'completed' | 'failed') =>
    ({ sessionId: 's1', origin: 'hosted', workStatus }) as never;

  it('working → 在跑：即使轮次端口给出相反答案（completed），托管分支仍赢', () => {
    // 真机缺陷形状：轮已 complete / 未收场，语义层仍说 working——轮次状态不许参与
    const status = projectSessionStatus(
      ports({
        readMeta: () => hostedMeta('working'),
        readRoundIds: () => ['r1'],
        readRoundStatus: () => 'complete',
        readRound: () => round('complete'),
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'running' });
  });

  it('四态映射：working→running、blocked→waiting、completed→completed、failed→stopped', () => {
    const map = (workStatus: Parameters<typeof hostedMeta>[0]) =>
      projectSessionStatus(ports({ readMeta: () => hostedMeta(workStatus) }), 's1');
    expect(map('working')).toEqual({ kind: 'running' });
    expect(map('blocked')).toEqual({ kind: 'waiting' });
    expect(map('completed')).toEqual({ kind: 'completed' });
    expect(map('failed')).toEqual({ kind: 'stopped', stop: { kind: 'unavailable' } });
  });

  it('非托管来源（origin 非 hosted）即使带 workStatus 也不进托管分支', () => {
    const status = projectSessionStatus(
      ports({
        readMeta: () => ({ sessionId: 's1', workStatus: 'working' }) as never,
        readRoundIds: () => ['r1'],
        readRoundStatus: () => 'complete',
        readRound: () => round('complete'),
      }),
      's1',
    );
    // 走轮次投影：最后一轮成功 → completed（不是 running）
    expect(status).toEqual({ kind: 'completed' });
  });

  it('缺 readMeta 端口（旧装配路径）→ 回落轮次投影，存量行为不变', () => {
    const status = projectSessionStatus(
      ports({
        readRoundIds: () => ['r1'],
        readRoundStatus: () => 'complete',
        readRound: () => round('complete'),
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'completed' });
  });
});

describe('projectSessionStatus — 用户手动打断 hosted Worker（B4）', () => {
  /** 带语义状态的托管 Worker 元数据 */
  const hostedMeta = (workStatus: 'working' | 'blocked') =>
    ({ sessionId: 's1', origin: 'hosted', workStatus, workOrder: '加权限管理' }) as never;
  /** 按轮级来源戳造轮（判据是 Round.origin，不是会话身份） */
  const roundFrom = (status: RoundStatus, origin: 'user' | 'hosted'): Round =>
    ({ ...round(status), origin }) as Round;

  it('用户轮仍在执行 → workOrder 暂停生效，workStatus 不再冒充在跑', () => {
    const status = projectSessionStatus(
      ports({
        readMeta: () => hostedMeta('working'),
        readRoundIds: () => ['r1'],
        readRoundStatus: () => 'pending',
        readRound: () => roundFrom('pending', 'user'),
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'unsettled' });
  });

  it('用户轮仍在跑且等答复 → 投影为等你，不是 workStatus 的 running', () => {
    const status = projectSessionStatus(
      ports({
        readMeta: () => hostedMeta('working'),
        peekActivity: () => ({ running: true, waiting: true }),
        readRoundIds: () => ['r1'],
        readRoundStatus: () => 'pending',
        readRound: () => roundFrom('pending', 'user'),
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'waiting' });
  });

  it('用户轮已收场 → 自动恢复 workStatus 优先，无需复位动作', () => {
    const status = projectSessionStatus(
      ports({
        readMeta: () => hostedMeta('working'),
        readRoundIds: () => ['r1'],
        readRoundStatus: () => 'complete',
        readRound: () => roundFrom('complete', 'user'),
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'running' });
  });

  it('最近一轮带 hosted 戳（代理派发）→ 不触发暂停，workStatus 照常优先', () => {
    const status = projectSessionStatus(
      ports({
        readMeta: () => hostedMeta('working'),
        readRoundIds: () => ['r1'],
        readRoundStatus: () => 'pending',
        readRound: () => roundFrom('pending', 'hosted'),
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'running' });
  });

  it('读不到最近轮 → 不冒充身份失效，workStatus 照常优先', () => {
    const status = projectSessionStatus(
      ports({
        readMeta: () => hostedMeta('working'),
        readRoundIds: () => ['r1'],
        readRoundStatus: () => undefined,
        readRound: () => undefined,
      }),
      's1',
    );
    expect(status).toEqual({ kind: 'running' });
  });
});

describe('projectCreatedBy — 归属三档', () => {
  const completeHistory = { coverage: 'complete' as const, children: [] };
  const hostedMeta = { sessionId: 's1', origin: 'hosted' } as never;

  it('用户来源（origin 缺省 / user）→ user，不依赖历史是否读全', () => {
    expect(
      projectCreatedBy({ sessionId: 's1' } as never, 's1', {
        ledger: [],
        history: { coverage: 'unreadable', children: [] },
      }),
    ).toBe('user');
  });

  it('创建者账本命中 → agent（本进程记录优先）', () => {
    expect(projectCreatedBy(hostedMeta, 's1', { ledger: ['s1'], history: completeHistory })).toBe(
      'agent',
    );
  });

  it('历史重建命中 → agent（重启后账本为空时的补法）', () => {
    expect(
      projectCreatedBy(hostedMeta, 's1', {
        ledger: [],
        history: { coverage: 'partial', children: [{ sessionId: 's1' }] },
      }),
    ).toBe('agent');
  });

  it('托管来源但账本与历史都没记到 → unknown（不猜用户，也不猜代理）', () => {
    expect(projectCreatedBy(hostedMeta, 's1', { ledger: [], history: completeHistory })).toBe(
      'unknown',
    );
  });
});

describe('resolveListCoverage — 空清单与读不到的区分', () => {
  it('座位会话不存在 → unreadable（清单不可信，不能说一条都没有）', () => {
    expect(resolveListCoverage({ history: { coverage: 'complete' }, seatExists: false })).toEqual({
      coverage: 'unreadable',
      reasons: [],
    });
  });

  it('历史读不出 → unreadable', () => {
    expect(resolveListCoverage({ history: { coverage: 'unreadable' }, seatExists: true })).toEqual({
      coverage: 'unreadable',
      reasons: [],
    });
  });

  it('历史读不全 / 有会话找不到 → partial，且理由说清是哪一种', () => {
    // 只给 partial、没给细节：兜成 history-unreadable（不编具体窗口）
    expect(resolveListCoverage({ history: { coverage: 'partial' }, seatExists: true })).toEqual({
      coverage: 'partial',
      reasons: [{ kind: 'history-unreadable' }],
    });
    expect(
      resolveListCoverage({ history: { coverage: 'complete' }, seatExists: true, missingCount: 1 }),
    ).toEqual({ coverage: 'partial', reasons: [{ kind: 'missing-sessions', count: 1 }] });
    // 轮窗口截断：理由带 kind，界面据此说「只读了最近 N 轮」而不是一句无因的 partial
    expect(
      resolveListCoverage({
        history: { coverage: 'partial', totalRounds: 90, scannedRounds: 60 },
        seatExists: true,
      }),
    ).toEqual({ coverage: 'partial', reasons: [{ kind: 'history-window' }] });
  });

  it('反查窗口截断也进同一判据：partial 的理由是 dispatch-window', () => {
    expect(
      resolveListCoverage({
        history: { coverage: 'complete', totalRounds: 3, scannedRounds: 3 },
        seatExists: true,
        dispatchTruncated: 2,
      }),
    ).toEqual({ coverage: 'partial', reasons: [{ kind: 'dispatch-window', count: 2 }] });
  });

  it('四类理由按固定顺序并列（界面与工具拿到同一份）', () => {
    expect(
      resolveListCoverage({
        history: {
          coverage: 'partial',
          totalRounds: 90,
          scannedRounds: 60,
          unreadableRecords: 1,
        },
        seatExists: true,
        missingCount: 1,
        dispatchTruncated: 3,
      }).reasons,
    ).toEqual([
      { kind: 'history-window' },
      { kind: 'history-unreadable' },
      { kind: 'missing-sessions', count: 1 },
      { kind: 'dispatch-window', count: 3 },
    ]);
  });

  it('座位在、历史读全、无缺失 → complete（只有这时空清单才是「一条都没有」）', () => {
    expect(resolveListCoverage({ history: { coverage: 'complete' }, seatExists: true })).toEqual({
      coverage: 'complete',
      reasons: [],
    });
  });
});

/**
 * 造一条带 origin 的轮（驱动权判据按 `Round.origin` 轮戳判定）
 */
function originRound(origin: 'user' | 'hosted' | undefined, status: RoundStatus): Round {
  return {
    id: 'r1',
    sessionId: 's1',
    status,
    processEvents: [],
    startedAt: TS,
    ...(origin ? { origin } : {}),
  } as unknown as Round;
}

/** hosted 出生的会话元数据替身 */
const hostedMeta = { origin: 'hosted' } as never;

describe('isSessionAgentDriven — 会话级驱动权读盘判据', () => {
  it('非 hosted 出生（用户自建 / 读不到 meta）→ false，不因轮记录扶正', () => {
    expect(isSessionAgentDriven(ports({ readMeta: () => undefined }), 's1')).toBe(false);
    expect(
      isSessionAgentDriven(ports({ readMeta: () => ({ origin: 'user' }) as never }), 's1'),
    ).toBe(false);
  });

  it('hosted 出生 + 首轮尚未落盘（轮 id 列表空）→ true，覆盖启动窗口', () => {
    expect(isSessionAgentDriven(ports({ readMeta: () => hostedMeta }), 's1')).toBe(true);
  });

  it('hosted 出生 + 最近轮是 hosted 轮 → true', () => {
    const p = ports({
      readMeta: () => hostedMeta,
      readRoundIds: () => ['r1'],
      readRound: () => originRound('hosted', 'pending'),
    });
    expect(isSessionAgentDriven(p, 's1')).toBe(true);
  });

  it('hosted 出生 + 用户亲手发的轮仍在跑（未收场）→ false，代理此刻不驱动', () => {
    const p = ports({
      readMeta: () => hostedMeta,
      readRoundIds: () => ['r1'],
      readRound: () => originRound('user', 'pending'),
    });
    expect(isSessionAgentDriven(p, 's1')).toBe(false);
  });

  it('hosted 出生 + 用户轮已收场 → true，身份自动恢复（与 B4 投影同口径）', () => {
    const p = ports({
      readMeta: () => hostedMeta,
      readRoundIds: () => ['r1'],
      readRound: () => originRound('user', 'complete'),
    });
    expect(isSessionAgentDriven(p, 's1')).toBe(true);
  });

  it('hosted 出生但最近轮整轮读不到 → undefined，门禁须 fail-closed 拒绝（不得当驱动中）', () => {
    const p = ports({
      readMeta: () => hostedMeta,
      readRoundIds: () => ['r1'],
      readRound: () => undefined,
    });
    expect(isSessionAgentDriven(p, 's1')).toBeUndefined();
  });
});

describe('isAgentDrivenFailClosed — 三态折布尔的门禁适配', () => {
  it('盘读异常（三态 undefined）折成 false——停止 / 暂停 / 通知门禁 fail-closed 拒绝', () => {
    const p = ports({
      readMeta: () => hostedMeta,
      readRoundIds: () => ['r1'],
      readRound: () => undefined, // hosted 出生但整轮读不到 ⇒ 三态 undefined
    });
    expect(isSessionAgentDriven(p, 's1')).toBeUndefined();
    expect(isAgentDrivenFailClosed(p, 's1')).toBe(false);
  });

  it('确定驱动折 true、明确非驱动折 false——不过度拒绝也不放宽', () => {
    expect(isAgentDrivenFailClosed(ports({ readMeta: () => hostedMeta }), 's1')).toBe(true);
    expect(isAgentDrivenFailClosed(ports({ readMeta: () => undefined }), 's1')).toBe(false);
  });
});

/**
 * 带 origin 的轮替身（isUserTakingOver 只看最近轮 origin + 收场态，与会话出生无关）
 */
function roundWithOrigin(status: RoundStatus, origin: 'user' | 'hosted' | undefined): Round {
  return { ...round(status), origin } as Round;
}

describe('isUserTakingOver — 派活目标的接管门禁（DISPATCH-TAKEOVER-GUARD-1）', () => {
  it('用户手发轮未收场（pending）⇒ 接管中 true，拒绝派活', () => {
    const p = ports({
      readRoundIds: () => ['r1'],
      readRound: () => roundWithOrigin('pending', 'user'),
      readRoundStatus: () => 'pending',
    });
    expect(isUserTakingOver(p, 's1')).toBe(true);
    expect(isUserTakingOverFailClosed(p, 's1')).toBe(true);
  });

  it('最近轮是 hosted 派发轮（即便未收场）⇒ 无用户接管 false，放行', () => {
    const p = ports({
      readRoundIds: () => ['r1'],
      readRound: () => roundWithOrigin('pending', 'hosted'),
      readRoundStatus: () => 'pending',
    });
    expect(isUserTakingOver(p, 's1')).toBe(false);
    expect(isUserTakingOverFailClosed(p, 's1')).toBe(false);
  });

  it('用户手发轮已收场（complete）⇒ 放行——自建会话的历史用户轮不误伤', () => {
    const p = ports({
      readRoundIds: () => ['r1'],
      readRound: () => roundWithOrigin('complete', 'user'),
      readRoundStatus: () => 'complete',
    });
    expect(isUserTakingOver(p, 's1')).toBe(false);
  });

  it('一轮都没有（空会话）⇒ 无接管，放行——新建/空会话派活不受影响', () => {
    expect(isUserTakingOver(ports(), 's1')).toBe(false);
    expect(isUserTakingOverFailClosed(ports(), 's1')).toBe(false);
  });

  it('轮 id 在但整轮读不到 ⇒ undefined，门禁折真拒绝（fail-closed，不误当可派）', () => {
    const p = ports({ readRoundIds: () => ['r1'], readRound: () => undefined });
    expect(isUserTakingOver(p, 's1')).toBeUndefined();
    expect(isUserTakingOverFailClosed(p, 's1')).toBe(true);
  });

  it('状态读不到（轮在、索引与轮状态皆缺）⇒ undefined，门禁折真拒绝', () => {
    const p = ports({
      readRoundIds: () => ['r1'],
      readRound: () => ({ ...round('pending'), origin: 'user', status: undefined }) as never,
      readRoundStatus: () => undefined,
    });
    expect(isUserTakingOver(p, 's1')).toBeUndefined();
    expect(isUserTakingOverFailClosed(p, 's1')).toBe(true);
  });
});
