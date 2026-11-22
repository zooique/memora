/**
 * 盖章会话卡投影状态（DISPATCH-CARD-TURN-1）单测
 *
 * 钉住：快照只给存在性/名字；turn 身份 = (sid, roundId)；同会话多轮多卡且互不顶替；
 * reset 清 turn 表；project 仅助手形态投影（self 不出卡）。DOM 插卡位置由
 * dispatchSessionCard.test.ts 覆盖。
 *
 * 变异靶标：
 *   - noteRound 改回 sid 单键后到覆盖 ⇒ 「同会话两轮两卡」用例红；
 *   - noteRound 按 sid 全局去重 ⇒ 同一会话第二轮卡丢失，红；
 *   - 不在跑也无轮锚却仍造卡 ⇒ 「不凭存在性编卡」红；
 *   - running 会话无轮锚时不造卡 ⇒ 「turn 起流即出卡」与「回执到位重排」两条红；
 *   - reset 不清 ⇒ 跨会话残留红；project 去 form 门 ⇒ self 出卡红。
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { ProcessEvent } from '@zooique/memora';
import { createDispatchCardProjection } from '../dispatchCardProjection.js';

function messages(): HTMLElement {
  const m = document.createElement('div');
  m.id = 'messages';
  for (const rid of ['r1', 'r2', 'r3']) {
    const g = document.createElement('div');
    g.className = 'round-group';
    g.dataset.roundId = rid;
    const a = document.createElement('div');
    a.className = 'msg assistant';
    a.dataset.roundId = rid;
    g.append(a);
    m.append(g);
  }
  return m;
}

const sendEvents = (sid: string, n = 0): ProcessEvent[] => {
  const callId = `c${n}-${sid}`;
  return [
    {
      type: 'tool_start',
      seq: n * 2,
      ts: '2026-11-19T09:00:00.000Z',
      payload: {
        toolCallId: callId,
        name: 'send_to_session',
        args: JSON.stringify({ sid, text: '继续' }),
      },
    } as unknown as ProcessEvent,
    {
      type: 'tool_result',
      seq: n * 2 + 1,
      ts: '2026-11-19T09:00:01.000Z',
      payload: {
        toolCallId: callId,
        name: 'send_to_session',
        ok: true,
        summary: '{\n  "ok": true,\n  "accepted": true\n}',
      },
    } as unknown as ProcessEvent,
  ];
};

function cardsOf(m: HTMLElement, sid: string): HTMLElement[] {
  return Array.from(m.querySelectorAll<HTMLElement>('.dispatch-session-card')).filter(
    (el) => el.getAttribute('data-dispatch-session') === sid,
  );
}

describe('createDispatchCardProjection 盖章卡投影状态', () => {
  it('只有快照、又不在跑 ⇒ 不出卡：不凭存在性编卡（旧边界保留）', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    p.project(m);
    expect(m.querySelector('.dispatch-session-card')).toBeNull();
  });

  it('DISPATCH-CARD-LIVE-1：快照 + 正在跑 + 无轮锚 ⇒ 先出无锚卡，不等 tool_result', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'create' }], ['s1']);
    p.project(m);
    const cards = cardsOf(m, 's1');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-dispatch-round')).toBeNull();
    expect(cards[0].classList.contains('is-running')).toBe(true);
  });

  it('DISPATCH-CARD-LIVE-1：回执到位后按轮重排，不留下第二张卡', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'create' }], ['s1']);
    p.project(m);
    expect(cardsOf(m, 's1')).toHaveLength(1);
    expect(p.noteRound('r2', sendEvents('s1'))).toBe(true);
    p.project(m);
    const cards = cardsOf(m, 's1');
    expect(cards).toHaveLength(1);
    expect(cards[0].getAttribute('data-dispatch-round')).toBe('r2');
    const r2Group = m.querySelector<HTMLElement>('.round-group[data-round-id="r2"]')!;
    expect(r2Group.nextElementSibling).toBe(cards[0]);
  });

  it('noteRound 登记一次派活 ⇒ 卡插在该轮之后', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    expect(p.noteRound('r1', sendEvents('s1'))).toBe(true);
    p.project(m);
    const group = m.querySelector<HTMLElement>('.round-group[data-round-id="r1"]')!;
    expect(group.nextElementSibling?.getAttribute('data-dispatch-session')).toBe('s1');
    expect(group.nextElementSibling?.getAttribute('data-dispatch-round')).toBe('r1');
  });

  it('实时逐条事件：tool_start 与 tool_result 分批到达也能配对出卡', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    const events = sendEvents('s1');
    expect(p.noteRound('r1', [events[0]!])).toBe(false);
    expect(p.noteRound('r1', [events[1]!])).toBe(true);
    p.project(m);
    expect(cardsOf(m, 's1')).toHaveLength(1);
    expect(cardsOf(m, 's1')[0]?.getAttribute('data-dispatch-round')).toBe('r1');
  });

  it('同一会话两轮派活出两张卡，旧卡钉在原轮不被新 turn 顶走', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    p.noteRound('r1', sendEvents('s1'));
    p.noteRound('r2', sendEvents('s1'));
    p.noteRound('r3', []); // 直接回答、不派活：不得让任何卡移动
    p.project(m);

    const cards = cardsOf(m, 's1');
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.getAttribute('data-dispatch-round'))).toEqual(['r1', 'r2']);
    const r1Group = m.querySelector<HTMLElement>('.round-group[data-round-id="r1"]')!;
    const r2Group = m.querySelector<HTMLElement>('.round-group[data-round-id="r2"]')!;
    expect(r1Group.nextElementSibling).toBe(cards[0]);
    expect(r2Group.nextElementSibling).toBe(cards[1]);
  });

  it('同一轮同一会话重复登记幂等；不同会话同轮各出一张', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot(
      [
        { sid: 's1', title: '会话一', via: 'delegate' },
        { sid: 's2', title: '会话二', via: 'create' },
      ],
      [],
    );
    expect(p.noteRound('r1', sendEvents('s1'))).toBe(true);
    expect(p.noteRound('r1', sendEvents('s1'))).toBe(false);
    expect(p.noteRound('r1', sendEvents('s2', 1))).toBe(true);
    p.project(m);
    expect(m.querySelectorAll('.dispatch-session-card')).toHaveLength(2);
    expect(
      Array.from(m.querySelectorAll<HTMLElement>('.dispatch-session-card')).map((c) =>
        c.getAttribute('data-dispatch-session'),
      ),
    ).toEqual(['s1', 's2']);
  });

  it('会话从快照移除 ⇒ 其 turn 卡一并撤掉（存在性仍以快照为真源）', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    p.noteRound('r1', sendEvents('s1'));
    p.setSnapshot([], []);
    p.project(m);
    expect(cardsOf(m, 's1')).toHaveLength(0);
  });

  it('reset 清 turn 身份表：复位后不残留跨会话卡', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    p.noteRound('r1', sendEvents('s1'));
    p.reset();
    p.project(m);
    expect(m.querySelector('.dispatch-session-card')).toBeNull();
  });

  it('project 仅助手形态投影：isAssistantForm=false 时无卡', () => {
    const p = createDispatchCardProjection(() => false);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    p.noteRound('r1', sendEvents('s1'));
    p.project(m);
    expect(m.querySelector('.dispatch-session-card')).toBeNull();
  });
});
