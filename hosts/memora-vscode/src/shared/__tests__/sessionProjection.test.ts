/**
 * sessionProjection 单测（R0-b）
 *
 * 钉住三条不变量：
 *  ① 投影与会话焦点无关——任意会话素材单独喂入，得到的结果只取决于该素材（互不串扰）；
 *  ② 等价性——输出与「手工 mergeLiveRound + deriveTurnState」逐字段一致（同源复用，没抄第二套判据）；
 *  ③ 相位顺序与轮序列规则沿用 turnProjection（ask > pause > pausePending > running > settled > idle；
 *     live 轮按 roundId 原位替换、缺 userMessage 整轮不并入）。
 */
import { describe, it, expect } from 'vitest';
import type { RoundView, TurnState } from '../protocol.js';
import { deriveTurnState, mergeLiveRound } from '../turnProjection.js';
import { deriveSessionProjection, type SessionProjectionInput } from '../sessionProjection.js';

/** 测试用的固定时间戳（ISO 字符串，与协议里的 `timestamp` / `createdAt` 同型） */
const TS = '2026-11-12T00:00:00.000Z';

/** 构造一条最小的落盘轮（只填投影用得到的字段） */
function round(id: string, status: RoundView['status']): RoundView {
  return {
    id,
    status,
    createdAt: TS,
    userMessage: { id: `u-${id}`, role: 'user', content: `问题 ${id}`, timestamp: TS },
  };
}

/** 素材基座：空闲、无 live、无提问 */
function input(overrides: Partial<SessionProjectionInput> = {}): SessionProjectionInput {
  return { history: [], streaming: false, paused: false, ...overrides };
}

describe('deriveSessionProjection — 任意会话独立投影', () => {
  it('两个会话的素材分别投影，结果互不影响（不依赖「当前显示会话」）', () => {
    const a = deriveSessionProjection(
      input({ history: [round('a1', 'complete')], streaming: true }),
    );
    const b = deriveSessionProjection(
      input({ history: [round('b1', 'complete')], streaming: false }),
    );
    expect(a.rounds.map((r) => r.id)).toEqual(['a1']);
    expect(a.state.phase).toBe('running');
    expect(b.rounds.map((r) => r.id)).toEqual(['b1']);
    // 收场轮 + 无流 ⇒ settled
    expect(b.state).toEqual({ phase: 'settled', roundId: 'b1', status: 'complete' });
    // 再投影一次 a，结果不因 b 的调用而改变（无模块级可变状态）
    expect(
      deriveSessionProjection(input({ history: [round('a1', 'complete')], streaming: true })),
    ).toEqual(a);
  });

  it('空素材 → idle + 空轮序列', () => {
    expect(deriveSessionProjection(input())).toEqual({ state: { phase: 'idle' }, rounds: [] });
  });
});

describe('deriveSessionProjection — 与手工两步等价（同源复用）', () => {
  /** 一组覆盖六种相位与 live 三形态的素材 */
  const CASES: ReadonlyArray<{ name: string; input: SessionProjectionInput }> = [
    { name: 'idle', input: input() },
    {
      name: 'running + live 新轮',
      input: input({
        streaming: true,
        live: {
          roundId: 'r2',
          userMessage: { id: 'u-r2', role: 'user', content: '你好', timestamp: TS },
        },
      }),
    },
    {
      name: 'running + live 无 userMessage 且历史无该轮（整轮不并入）',
      input: input({
        history: [round('r1', 'complete')],
        streaming: true,
        live: { roundId: 'r2' },
      }),
    },
    {
      name: 'waiting-ask',
      input: input({
        history: [round('r1', 'complete')],
        paused: true,
        pendingQuestions: [{ slot: 's1', askCallId: 'q1', question: '继续吗？' }],
      }),
    },
    { name: 'waiting-pause', input: input({ history: [round('r1', 'complete')], paused: true }) },
    { name: 'waiting-pause（申请在途）', input: input({ streaming: true, pausePending: true }) },
    { name: 'settled', input: input({ history: [round('r1', 'complete')] }) },
    {
      name: 'settled + live 原位替换历史半残轮',
      input: input({
        history: [round('r1', 'pending'), round('r0', 'complete')],
        live: {
          roundId: 'r1',
          userMessage: { id: 'u-r1', role: 'user', content: '问题 r1', timestamp: TS },
        },
      }),
    },
  ];

  for (const c of CASES) {
    it(`${c.name}：state 与 rounds 均等于手工 mergeLiveRound + deriveTurnState`, () => {
      const expectedRounds = mergeLiveRound([...c.input.history], c.input.live);
      const last = expectedRounds[expectedRounds.length - 1];
      const expectedState: TurnState = deriveTurnState({
        streaming: c.input.streaming,
        paused: c.input.paused,
        pausePending: c.input.pausePending,
        pendingQuestions: c.input.pendingQuestions,
        liveRoundId: c.input.live?.roundId,
        lastRound: last ? { id: last.id, status: last.status } : undefined,
      });
      expect(deriveSessionProjection(c.input)).toEqual({
        state: expectedState,
        rounds: expectedRounds,
      });
    });
  }

  it('live 轮按 roundId 原位替换，不改变轮序（不追加到末尾）', () => {
    const { rounds } = deriveSessionProjection(
      input({
        history: [round('r2', 'complete'), round('r1', 'pending')],
        live: {
          roundId: 'r1',
          streamingText: '流式中',
          userMessage: { id: 'u-r1', role: 'user', content: '问题 r1', timestamp: TS },
        },
      }),
    );
    expect(rounds.map((r) => r.id)).toEqual(['r2', 'r1']);
    expect(rounds[1].live).toBe(true);
    expect(rounds[1].assistantMessage?.content).toBe('流式中');
  });

  it('返回新的轮数组，不原地改写调用方的 history', () => {
    const history = [round('r1', 'complete')];
    const { rounds } = deriveSessionProjection(
      input({
        history,
        live: {
          roundId: 'r2',
          userMessage: { id: 'u-r2', role: 'user', content: '新轮', timestamp: TS },
        },
      }),
    );
    expect(history).toHaveLength(1);
    expect(rounds).toHaveLength(2);
    expect(rounds).not.toBe(history);
  });
});
