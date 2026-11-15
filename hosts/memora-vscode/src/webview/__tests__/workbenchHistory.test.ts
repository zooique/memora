/**
 * 工作台清单历史重建测试
 *
 * 钉住的判据：
 *   - 新进程账本为空时，能从代理会话历史里恢复 `create_session` 的 sid 与标题；
 *   - 历史读不出来 / 某条记录解析失败 ⇒ 标 `unreadable` / `partial`（不得返回「完整空清单」）；
 *   - 扫描轮数有上限，超了如实标 partial 并给出总数；
 *   - 失败的 create_session、重复 sid 不污染结果；
 *   - 派发记录只认**成功配对**的 send_to_session：目标取自入参、时间取自事件、
 *     每个目标只留最近一次，失败 / 认不出目标一律不算「派过」。
 */
import { describe, expect, it } from 'vitest';
import type { ProcessEvent, Round } from '@zooique/memora';
import {
  rebuildWorkbenchChildren,
  WORKBENCH_DISPATCH_EXCERPT_CHARS,
  WORKBENCH_REBUILD_MAX_ROUNDS,
  type WorkbenchHistorySources,
} from '../helpers/workbenchHistory.js';
// 反查窗口上限的真源在 shared（webview 文案也用这个数）
import { WORKBENCH_DISPATCH_LOOKBACK_ROUNDS } from '../../shared/workbenchDto.js';
// 摘要不手抄：直接用真实产生点产出的文本（格式契约由 workbenchSidContract.test.ts 钉住）
import { serializeCreateSessionResult } from '../../extension/host/workSessionTools.js';

/** 固定的过程事件时间（断言派发时间取自事件，而不是回退值） */
const EVENT_TS = '2026-11-14T09:00:00.000Z';
/** 固定的整轮创建时间（比事件时间早，用来区分「取事件时间」与「回退轮时间」） */
const ROUND_CREATED_AT = '2026-11-14T08:59:00.000Z';

/** 构造 tool_start 事件 */
function start(
  toolCallId: string,
  name: string,
  args: string,
  ts: string = EVENT_TS,
): ProcessEvent {
  return {
    type: 'tool_start',
    seq: 0,
    ts,
    payload: { toolCallId, name, args },
  } as unknown as ProcessEvent;
}

/** 构造 tool_result 事件 */
function result(
  toolCallId: string,
  name: string,
  ok: boolean,
  summary: string,
  ts: string = EVENT_TS,
): ProcessEvent {
  return {
    type: 'tool_result',
    seq: 0,
    ts,
    payload: { toolCallId, name, ok, summary },
  } as unknown as ProcessEvent;
}

/** 构造一轮（只填重建会读的字段） */
function round(id: string, events: ProcessEvent[], createdAt: string = ROUND_CREATED_AT): Round {
  return { id, status: 'complete', createdAt, processEvents: events } as Round;
}

/**
 * 一次 send_to_session 成功调用的标准事件对
 *
 * 回执**不含 sid**（真实形状 `{ ok: true, accepted: true }`），目标只能从入参取；
 * 这里同时模拟内核把 summary 截到 100 字符。
 */
function sendSessionEvents(
  sid: string,
  text: string,
  callId = 'send-1',
  ts: string = EVENT_TS,
): ProcessEvent[] {
  return [
    start(callId, 'send_to_session', JSON.stringify({ sid, text }), ts),
    result(
      callId,
      'send_to_session',
      true,
      JSON.stringify({ ok: true, accepted: true }, null, 2).slice(0, 100),
      ts,
    ),
  ];
}

/** 一次 create_session 成功调用的标准事件对（结果摘要走真实序列化 + 内核 100 字符截断） */
function createSessionEvents(sid: string, title: string, callId = 'call-1'): ProcessEvent[] {
  return [
    start(callId, 'create_session', JSON.stringify({ title })),
    result(
      callId,
      'create_session',
      true,
      serializeCreateSessionResult({ ok: true, sid, title }).slice(0, 100),
    ),
  ];
}

/**
 * 构造读口（默认：一轮、没有其它会话、没有任何派发归属）
 *
 * @param rounds 创建者自己的轮
 * @param roundIds 创建者的轮 id 顺序（缺省 = rounds 顺序）
 * @param extra 反查面：其它会话的轮 id 列表 + 轮 id → 派发归属
 */
function sources(
  rounds: Round[],
  roundIds?: string[],
  extra: {
    sessions?: Record<string, string[]>;
    dispatch?: Record<string, Round['dispatchedBy']>;
  } = {},
): WorkbenchHistorySources {
  const byId = new Map(rounds.map((r) => [r.id, r]));
  return {
    readRoundIds: (sessionId) => extra.sessions?.[sessionId] ?? roundIds ?? rounds.map((r) => r.id),
    readRound: (id) => byId.get(id),
    listSessionIds: () => Object.keys(extra.sessions ?? {}),
    readRoundDispatch: (id) => extra.dispatch?.[id],
  };
}

describe('rebuildWorkbenchChildren', () => {
  it('新进程：从历史恢复 sid 与创建标题', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([round('r1', createSessionEvents('2026-11-14-session-abc', '整理周报'))]),
    );
    expect(rebuilt.children).toEqual([
      { sessionId: '2026-11-14-session-abc', title: '整理周报', via: 'create' },
    ]);
    expect(rebuilt.coverage).toBe('complete');
    expect(rebuilt.totalRounds).toBe(1);
  });

  it('历史读不出来（读轮列表抛错）⇒ unreadable，不返回「完整空清单」', () => {
    const rebuilt = rebuildWorkbenchChildren('session-agent', {
      readRoundIds: () => {
        throw new Error('disk error');
      },
      readRound: () => undefined,
      listSessionIds: () => [],
      readRoundDispatch: () => undefined,
    });
    expect(rebuilt.children).toEqual([]);
    expect(rebuilt.coverage).toBe('unreadable');
  });

  it('成功调用但解析不出 sid ⇒ 计入读不到并标 partial', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', [
          start('call-1', 'create_session', '{"title":"无 sid"}'),
          // 摘要里没有 sid（例如旧版本 / 异常结果）
          result('call-1', 'create_session', true, '{"ok":true}'),
        ]),
      ]),
    );
    expect(rebuilt.children).toEqual([]);
    expect(rebuilt.unreadableRecords).toBe(1);
    expect(rebuilt.coverage).toBe('partial');
  });

  it('轮读不到 ⇒ 计入读不到（不能当成「这一轮没有」）', () => {
    const rebuilt = rebuildWorkbenchChildren('session-agent', {
      readRoundIds: () => ['r1', 'r2'],
      readRound: (id) => (id === 'r1' ? round('r1', []) : undefined),
      listSessionIds: () => [],
      readRoundDispatch: () => undefined,
    });
    expect(rebuilt.unreadableRecords).toBe(1);
    expect(rebuilt.coverage).toBe('partial');
  });

  it('派发反查：目标会话最近一轮带创建者归属 ⇒ 进清单且来源是 delegate', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([], undefined, {
        sessions: { 'session-target': ['t1', 't2'] },
        dispatch: { t2: { from: 'session-agent', via: 'delegate' } },
      }),
    );
    expect(rebuilt.children).toEqual([{ sessionId: 'session-target', via: 'delegate' }]);
    expect(rebuilt.dispatchScan).toEqual({ sessions: 1, truncated: 0 });
  });

  it('派发反查只认这位创建者：别人派的会话不进清单', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([], undefined, {
        sessions: { 'session-target': ['t1'] },
        dispatch: { t1: { from: 'session-other', via: 'delegate' } },
      }),
    );
    expect(rebuilt.children).toEqual([]);
  });

  it('派发反查从末尾往前、超回看上限就停：更早的派发读不到并如实上报 truncated', () => {
    // 21 轮：派发发生在最早那一轮，末尾 20 轮都不是 ⇒ 按设计不认（越近越有路由价值）
    const ids = Array.from({ length: WORKBENCH_DISPATCH_LOOKBACK_ROUNDS + 1 }, (_, i) => `t${i}`);
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([], undefined, {
        sessions: { 'session-old': ids },
        dispatch: { t0: { from: 'session-agent', via: 'delegate' } },
      }),
    );
    expect(rebuilt.children).toEqual([]);
    expect(rebuilt.dispatchScan).toEqual({ sessions: 1, truncated: 1 });
  });

  it('已由 create_session 认定的会话不被后来的派发改档（创造是更早的事实）', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([round('r1', createSessionEvents('session-both', '助手开的'))], undefined, {
        sessions: { 'session-both': ['b1'] },
        dispatch: { b1: { from: 'session-agent', via: 'delegate' } },
      }),
    );
    expect(rebuilt.children).toEqual([
      { sessionId: 'session-both', title: '助手开的', via: 'create' },
    ]);
    // 已被 create 认定的不参与反查
    expect(rebuilt.dispatchScan.sessions).toBe(0);
  });

  it(`超过 ${WORKBENCH_REBUILD_MAX_ROUNDS} 轮 ⇒ 只扫最近 N 轮并如实标 partial`, () => {
    const rounds: Round[] = [];
    // 最早的轮里有一次创建；后面的轮都是空轮（总数超上限）
    rounds.push(round('r0', createSessionEvents('session-old', '旧任务')));
    for (let i = 1; i <= WORKBENCH_REBUILD_MAX_ROUNDS; i += 1) {
      rounds.push(round(`r${i}`, []));
    }
    const rebuilt = rebuildWorkbenchChildren('session-agent', sources(rounds));
    expect(rebuilt.totalRounds).toBe(WORKBENCH_REBUILD_MAX_ROUNDS + 1);
    expect(rebuilt.scannedRounds).toBe(WORKBENCH_REBUILD_MAX_ROUNDS);
    expect(rebuilt.coverage).toBe('partial');
    // 创建记录在未扫描的最早轮里：不得假装「没有」
    expect(rebuilt.children).toEqual([]);
  });

  it('失败的 create_session 不算创建；重复 sid 只保留一条', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', [
          start('call-1', 'create_session', '{"title":"失败"}'),
          result('call-1', 'create_session', false, '{"ok":false}'),
          ...createSessionEvents('session-dup', '第一次', 'call-2'),
          ...createSessionEvents('session-dup', '第二次', 'call-3'),
        ]),
      ]),
    );
    expect(rebuilt.children).toEqual([
      { sessionId: 'session-dup', title: '第一次', via: 'create' },
    ]);
    expect(rebuilt.coverage).toBe('complete');
  });

  it('args 无法解析时仍靠摘要拿到 sid（标题留给元数据兜底）', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', [
          start('call-1', 'create_session', 'not-json'),
          result(
            'call-1',
            'create_session',
            true,
            serializeCreateSessionResult({ ok: true, sid: 'session-x', title: '无入参任务' }).slice(
              0,
              100,
            ),
          ),
        ]),
      ]),
    );
    expect(rebuilt.children).toEqual([{ sessionId: 'session-x', title: undefined, via: 'create' }]);
    expect(rebuilt.coverage).toBe('complete');
  });
});

describe('rebuildWorkbenchChildren · 派发记录（send_to_session）', () => {
  it('从同轮配对取出目标 sid、内容摘录与事件时间', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([round('r1', sendSessionEvents('session-abc', '把周报整理成三段'))]),
    );
    expect(rebuilt.dispatches).toEqual([
      { sessionId: 'session-abc', excerpt: '把周报整理成三段', at: EVENT_TS },
    ]);
    // 事件时间优先于整轮创建时间（不要拿开轮时间冒充派发时刻）
    expect(rebuilt.dispatches[0]?.at).not.toBe(ROUND_CREATED_AT);
  });

  it('同一目标多次派发只保留最近一次（按轮序后到覆盖先到）', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', sendSessionEvents('session-abc', '第一次派发', 'send-1')),
        round('r2', sendSessionEvents('session-abc', '第二次派发', 'send-2')),
      ]),
    );
    expect(rebuilt.dispatches).toEqual([
      { sessionId: 'session-abc', excerpt: '第二次派发', at: EVENT_TS },
    ]);
  });

  it('事件没带时间时回退整轮创建时间', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', [
          start(
            'send-1',
            'send_to_session',
            JSON.stringify({ sid: 'session-abc', text: '无时间' }),
            '',
          ),
          result('send-1', 'send_to_session', true, '{"ok":true,"accepted":true}', ''),
        ]),
      ]),
    );
    expect(rebuilt.dispatches).toEqual([
      { sessionId: 'session-abc', excerpt: '无时间', at: ROUND_CREATED_AT },
    ]);
  });

  it('失败的派发不算派过（E_BUSY / 未完成都不写记录）', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', [
          start('send-1', 'send_to_session', JSON.stringify({ sid: 'session-abc', text: '撞忙' })),
          result('send-1', 'send_to_session', false, '{"ok":false,"code":"E_BUSY"}'),
          // 只有开始、没有结果（轮被中断）：不能确认派成功，也不算
          start('send-2', 'send_to_session', JSON.stringify({ sid: 'session-abc', text: '中断' })),
        ]),
      ]),
    );
    expect(rebuilt.dispatches).toEqual([]);
    // 未确认 ≠ 读不到：不把「没派成」计成解析失败
    expect(rebuilt.unreadableRecords).toBe(0);
    expect(rebuilt.coverage).toBe('complete');
  });

  it('成功但入参认不出目标 ⇒ 计入读不到并标 partial（不伪造目标）', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', [
          start('send-1', 'send_to_session', 'not-json'),
          result('send-1', 'send_to_session', true, '{"ok":true,"accepted":true}'),
        ]),
      ]),
    );
    expect(rebuilt.dispatches).toEqual([]);
    expect(rebuilt.unreadableRecords).toBe(1);
    expect(rebuilt.coverage).toBe('partial');
  });

  it(`超长内容按 ${WORKBENCH_DISPATCH_EXCERPT_CHARS} 字截断并加省略号`, () => {
    /** 超过上限的派发原文（完整内容仍在上限之外） */
    const longText = '任'.repeat(WORKBENCH_DISPATCH_EXCERPT_CHARS + 10);
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([round('r1', sendSessionEvents('session-abc', longText))]),
    );
    expect(rebuilt.dispatches[0]?.excerpt).toBe(
      `${'任'.repeat(WORKBENCH_DISPATCH_EXCERPT_CHARS)}…`,
    );
  });

  it(`窗口外的派发不在结果里（仍以 ${WORKBENCH_REBUILD_MAX_ROUNDS} 轮为上限，如实标 partial）`, () => {
    const rounds: Round[] = [round('r0', sendSessionEvents('session-old', '窗口外的派发'))];
    for (let i = 1; i <= WORKBENCH_REBUILD_MAX_ROUNDS; i += 1) {
      rounds.push(round(`r${i}`, []));
    }
    const rebuilt = rebuildWorkbenchChildren('session-agent', sources(rounds));
    expect(rebuilt.dispatches).toEqual([]);
    expect(rebuilt.coverage).toBe('partial');
    expect(rebuilt.scannedRounds).toBe(WORKBENCH_REBUILD_MAX_ROUNDS);
  });

  it('建会话与派发互不干扰：同一轮两类记录都能取到', () => {
    const rebuilt = rebuildWorkbenchChildren(
      'session-agent',
      sources([
        round('r1', [
          ...createSessionEvents('session-abc', '新活'),
          ...sendSessionEvents('2026-11-13-session-old', '继续上次的活'),
        ]),
      ]),
    );
    expect(rebuilt.children).toEqual([{ sessionId: 'session-abc', title: '新活', via: 'create' }]);
    expect(rebuilt.dispatches).toEqual([
      { sessionId: '2026-11-13-session-old', excerpt: '继续上次的活', at: EVENT_TS },
    ]);
    expect(rebuilt.coverage).toBe('complete');
  });
});
