/**
 * 盖章会话列表判据（DISPATCH-CARD-ZONE-1）
 *
 * 钉住的心智：会话卡 = 第三信息形态，「被助手盖章启动过 turn」就上屏，与驱动权无关。
 *
 * 变异靶标：
 *   - 去掉本进程账本合并 ⇒ 实时补齐用例红（重启前台账独有会话丢失）；
 *   - 用 buildWorkbenchSnapshot 的 isAgentDriven 过滤 ⇒ 用户接管仍出卡用例红；
 *   - 名字用 sid 而非 titleFor ⇒ 真名用例红；
 *   - sid 不去重 ⇒ 反查+账本重叠用例红。
 */
import { describe, expect, it } from 'vitest';
import type { ProcessEvent, Round } from '@zooique/memora';
import {
  collectDispatchedSessions,
  type DispatchedSessionsSources,
} from '../dispatchedSessions.js';

const TITLES: Record<string, string> = {
  'worker-a': '统计目录文件数',
  'worker-b': '空白页草稿',
  'worker-c': '登录链路调查',
};

/** 本轮带 delegated dispatchedBy 的整轮（反查 delegate 来源） */
function roundWithDispatch(roundId: string, from: string, sid: string): Round {
  const events: ProcessEvent[] = [
    {
      type: 'tool_start',
      seq: 0,
      ts: '2026-11-19T09:00:00.000Z',
      payload: {
        toolCallId: 'c1',
        name: 'send_to_session',
        args: JSON.stringify({ sid, text: 'x' }),
      },
    } as unknown as ProcessEvent,
    {
      type: 'tool_result',
      seq: 1,
      ts: '2026-11-19T09:00:01.000Z',
      payload: {
        toolCallId: 'c1',
        name: 'send_to_session',
        ok: true,
        summary: '{\n  "ok": true,\n  "accepted": true\n}',
      },
    } as unknown as ProcessEvent,
  ];
  return {
    id: roundId,
    status: 'complete',
    createdAt: '2026-11-19T08:59:00.000Z',
    processEvents: events,
    dispatchedBy: { from, via: 'delegate' },
  } as Round;
}

function sources(overrides: Partial<DispatchedSessionsSources> = {}): DispatchedSessionsSources {
  return {
    orchestratorId: 'assistant',
    childrenOf: () => [],
    readRoundIds: () => [],
    readRound: () => undefined,
    listSessionIds: () => [],
    titleFor: (sid) => TITLES[sid] ?? sid,
    lastTurnAt: () => '',
    ...overrides,
  };
}

describe('collectDispatchedSessions 盖章列表', () => {
  it('本进程账本实时补会话（反查尚无记录）⇒ 用 titleFor 真名出卡', () => {
    const list = collectDispatchedSessions(sources({ childrenOf: () => ['worker-a'] }));
    expect(list).toEqual([{ sid: 'worker-a', title: '统计目录文件数', via: 'delegate' }]);
  });

  it('重启后账本为空 ⇒ 靠轮次反查补齐 delegate 会话（真名同源）', () => {
    const list = collectDispatchedSessions(
      sources({
        listSessionIds: () => ['worker-b'],
        readRoundIds: (sid) => (sid === 'worker-b' ? ['r1'] : []),
        readRound: (rid) =>
          rid === 'r1' ? roundWithDispatch('r1', 'assistant', 'worker-b') : undefined,
      }),
    );
    expect(list).toEqual([{ sid: 'worker-b', title: '空白页草稿', via: 'delegate' }]);
  });

  it('反查 + 账本重叠同一会话 ⇒ sid 去重，只一张卡', () => {
    const list = collectDispatchedSessions(
      sources({
        childrenOf: () => ['worker-c'],
        listSessionIds: () => ['worker-c'],
        readRoundIds: (sid) => (sid === 'worker-c' ? ['r2'] : []),
        readRound: (rid) =>
          rid === 'r2' ? roundWithDispatch('r2', 'assistant', 'worker-c') : undefined,
      }),
    );
    expect(list.filter((s) => s.sid === 'worker-c')).toHaveLength(1);
    // 反查带准确 via，作基底
    expect(list[0]?.via).toBe('delegate');
  });

  it('别人派出的会话不进本助手列表（from 不匹配）', () => {
    const list = collectDispatchedSessions(
      sources({
        listSessionIds: () => ['worker-a'],
        readRoundIds: () => ['r3'],
        readRound: () => roundWithDispatch('r3', 'other-assistant', 'worker-a'),
      }),
    );
    expect(list).toEqual([]);
  });

  it('空账本 + 空历史 ⇒ 空列表（不上屏）', () => {
    expect(collectDispatchedSessions(sources())).toEqual([]);
  });

  it('按最近 turn 时间降序排（最新在前），读不到时间的沉底、稳定序 · DISPATCH-CARD-SORT-1', () => {
    const times: Record<string, string> = {
      'worker-a': '2026-11-19T08:00:00.000Z',
      'worker-b': '2026-11-19T10:00:00.000Z',
      'worker-c': '2026-11-19T09:00:00.000Z',
    };
    const list = collectDispatchedSessions(
      sources({
        childrenOf: () => ['worker-a', 'worker-b', 'worker-c', 'no-meta'],
        lastTurnAt: (sid) => times[sid] ?? '',
      }),
    );
    expect(list.map((s) => s.sid)).toEqual(['worker-b', 'worker-c', 'worker-a', 'no-meta']);
  });

  it('时间相同时保持发现顺序（稳定排序，不暗中重排）· DISPATCH-CARD-SORT-1', () => {
    const list = collectDispatchedSessions(
      sources({
        childrenOf: () => ['worker-a', 'worker-b', 'worker-c'],
        lastTurnAt: () => '2026-11-19T08:00:00.000Z',
      }),
    );
    expect(list.map((s) => s.sid)).toEqual(['worker-a', 'worker-b', 'worker-c']);
  });
});
