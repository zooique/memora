/**
 * 盖章会话卡投影状态（DISPATCH-CARD-INLINE-1）单测
 *
 * 钉住 4 个接线的语义：快照只更新存在性/旋转、replay 逐轮登记触发轮锚点、reset 清锚点、
 * project 仅助手形态投影（self 不出卡）。DOM 插卡位置由 dispatchSessionCard.test.ts 覆盖。
 *
 * 变异靶标：
 *   - setSnapshot 不更新 ⇒ 投影用的还是旧快照；
 *   - noteRound 用后到覆盖（去掉 !has）⇒ 触发轮定位到最后盖章轮；
 *   - reset 不清 ⇒ 跨会话锚点残留；
 *   - project 去 form 门 ⇒ self 形态也出卡。
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import type { ProcessEvent } from '@zooique/memora';
import { createDispatchCardProjection } from '../dispatchCardProjection.js';

function messages(): HTMLElement {
  const m = document.createElement('div');
  m.id = 'messages';
  const g = document.createElement('div');
  g.className = 'round-group';
  g.dataset.roundId = 'r1';
  const a = document.createElement('div');
  a.className = 'msg assistant';
  a.dataset.roundId = 'r1';
  g.append(a);
  m.append(g);
  return m;
}

const sendEvents = (sid: string): ProcessEvent[] => [
  {
    type: 'tool_start',
    seq: 0,
    ts: '2026-11-19T09:00:00.000Z',
    payload: {
      toolCallId: 'c1',
      name: 'send_to_session',
      args: JSON.stringify({ sid, text: '继续' }),
    },
  } as unknown as ProcessEvent,
  {
    type: 'tool_result',
    seq: 1,
    ts: '2026-11-19T09:00:01.000Z',
    payload: { toolCallId: 'c1', name: 'send_to_session', ok: true, summary: '{}' },
  } as unknown as ProcessEvent,
];

describe('createDispatchCardProjection 盖章卡投影状态', () => {
  it('快照到达后 project 出卡（存在性来自快照）', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], ['s1']);
    p.project(m);
    const card = m.querySelector<HTMLElement>('.dispatch-session-card');
    expect(card).not.toBeNull();
    expect(card!.classList.contains('is-running')).toBe(true);
  });

  it('noteRound 登记首次盖章轮为锚点，卡插在该轮之后', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    p.noteRound('r1', sendEvents('s1'));
    p.project(m);
    const group = m.querySelector<HTMLElement>('.round-group[data-round-id="r1"]')!;
    expect(group.nextElementSibling?.getAttribute('data-dispatch-session')).toBe('s1');
  });

  it('首次盖章 = 触发轮：后到的同 sid 轮不覆盖锚点', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    const later = document.createElement('div');
    later.className = 'round-group';
    later.dataset.roundId = 'r2';
    m.append(later);
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    p.noteRound('r1', sendEvents('s1')); // 首次盖章在 r1
    p.noteRound('r2', sendEvents('s1')); // 后到同 sid（如续派）不覆盖
    p.project(m);
    const group = m.querySelector<HTMLElement>('.round-group[data-round-id="r1"]')!;
    expect(group.nextElementSibling?.getAttribute('data-dispatch-session')).toBe('s1');
  });

  it('reset 清锚点：复位后卡落流尾（跨会话不残留旧锚点）', () => {
    const p = createDispatchCardProjection(() => true);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    p.noteRound('r1', sendEvents('s1'));
    p.reset();
    p.project(m);
    expect(m.lastElementChild?.getAttribute('data-dispatch-session')).toBe('s1');
  });

  it('project 仅助手形态投影：isAssistantForm=false 时无卡', () => {
    const p = createDispatchCardProjection(() => false);
    const m = messages();
    p.setSnapshot([{ sid: 's1', title: '会话一', via: 'delegate' }], []);
    p.project(m);
    expect(m.querySelector('.dispatch-session-card')).toBeNull();
  });
});
