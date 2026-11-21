/**
 * 盖章会话卡（DISPATCH-CARD-TURN-1）判据
 *
 * 会话卡 = 第三种信息形态：按 turn 锚点穿插进对话气泡之间（非顶部固定卡区）。
 * 这里测纯 DOM 层：身份 = (sid, roundId)、同会话多轮多卡、锚点插卡 / 失效落尾 / 幂等 /
 * 真名 / 旋转。点击 post 与落点在 chatView 测试里验。
 *
 * 变异靶标：
 *   - 按 sid 去重 ⇒ 同会话两轮多卡用例红；
 *   - 不按锚点插（一律 appendChild）⇒ 锚点用例红；
 *   - 卡片不打 data-dispatch-round ⇒ 点击带轮锚用例红；
 *   - 不写真名 / 不写 is-running ⇒ 名字 / 旋转用例红；撤卡失效 ⇒ 幂等用例红；
 *   - 字号/内距回落旧档 ⇒ 尺寸守卫红。
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  buildDispatchSessionCard,
  DISPATCH_ROUND_ATTR,
  DISPATCH_SESSION_ATTR,
  removeDispatchCards,
  renderDispatchCards,
} from '../dispatchSessionCard.js';

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function flow(): HTMLElement {
  const messages = document.createElement('div');
  messages.id = 'messages';
  for (const rid of ['r1', 'r2', 'r3']) {
    const u = document.createElement('div');
    u.className = 'msg user';
    u.dataset.roundId = rid;
    const a = document.createElement('div');
    a.className = 'msg assistant';
    a.dataset.roundId = rid;
    messages.append(u, a);
  }
  return messages;
}

function cardsOf(messages: HTMLElement, sid: string): HTMLElement[] {
  return Array.from(messages.querySelectorAll<HTMLElement>(`.${'dispatch-session-card'}`)).filter(
    (el) => el.getAttribute(DISPATCH_SESSION_ATTR) === sid,
  );
}

describe('buildDispatchSessionCard 卡片骨架', () => {
  it('带 sid 与轮锚点；未渲染前名字显示 sid（不空着）', () => {
    const card = buildDispatchSessionCard(document, '2026-11-18-abc', 'r7');
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute(DISPATCH_SESSION_ATTR)).toBe('2026-11-18-abc');
    expect(card.getAttribute(DISPATCH_ROUND_ATTR)).toBe('r7');
    expect(card.querySelector('.dispatch-session-card__name')?.textContent).toBe('2026-11-18-abc');
  });

  it('DISPATCH-CARD-SIZE-1：字号/内距走既有令牌升档，作用域只在卡片本体', () => {
    const styles = readFileSync(join(HOST_ROOT, 'src/webview/styles/chatStyles.ts'), 'utf8');
    const start = styles.indexOf('.dispatch-session-card {');
    const rule = styles.slice(start, styles.indexOf('}', start));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(rule).toContain('padding: var(--sp-2, 6px) var(--sp-4, 10px)');
    expect(rule).toContain('font-size: var(--font-md, 12px)');
    expect(rule).not.toContain('font-size: var(--font-xs, 10px)');
  });
});

describe('renderDispatchCards 按 turn 锚点穿插消息流', () => {
  it('有锚点的卡插在触发轮最后一条消息之后（第三种形态：不在 .round-block 内）', () => {
    const messages = flow();
    renderDispatchCards(
      messages,
      [
        { sid: 's1', title: '统计目录文件数', via: 'delegate' },
        { sid: 's2', title: '空白页草稿', via: 'create' },
      ],
      ['s1'],
      [
        { sid: 's1', roundId: 'r1' },
        { sid: 's2', roundId: 'r2' },
      ],
    );
    const c1 = cardsOf(messages, 's1')[0]!;
    const c2 = cardsOf(messages, 's2')[0]!;
    const r1Assistant = messages.querySelector<HTMLElement>('.msg.assistant[data-round-id="r1"]')!;
    expect(r1Assistant.nextElementSibling).toBe(c1);
    const r2Assistant = messages.querySelector<HTMLElement>('.msg.assistant[data-round-id="r2"]')!;
    expect(r2Assistant.nextElementSibling).toBe(c2);
    expect(c1.closest('.round-block')).toBeNull();
    expect(c1.querySelector('.dispatch-session-card__name')?.textContent).toBe('统计目录文件数');
    expect(c1.classList.contains('is-running')).toBe(true);
    expect(c1.dataset.via).toBe('delegate');
    expect(c2.dataset.via).toBe('create');
    expect(c2.classList.contains('is-running')).toBe(false);
  });

  it('同一会话两轮 = 两张同名卡，各自钉在对应轮（不再按 sid 去重）', () => {
    const messages = flow();
    renderDispatchCards(
      messages,
      [{ sid: 's1', title: '同一个会话', via: 'delegate' }],
      [],
      [
        { sid: 's1', roundId: 'r1' },
        { sid: 's1', roundId: 'r2' },
      ],
    );
    const cards = cardsOf(messages, 's1');
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.textContent)).toEqual(['同一个会话', '同一个会话']);
    expect(cards.map((c) => c.getAttribute(DISPATCH_ROUND_ATTR))).toEqual(['r1', 'r2']);
    const r1Assistant = messages.querySelector<HTMLElement>('.msg.assistant[data-round-id="r1"]')!;
    const r2Assistant = messages.querySelector<HTMLElement>('.msg.assistant[data-round-id="r2"]')!;
    expect(r1Assistant.nextElementSibling).toBe(cards[0]);
    expect(r2Assistant.nextElementSibling).toBe(cards[1]);
  });

  it('锚点节点已消失 ⇒ 卡落流尾兜底（仍属对话内容）', () => {
    const messages = flow();
    renderDispatchCards(
      messages,
      [{ sid: 's1', title: '锚已失效', via: 'delegate' }],
      [],
      [{ sid: 's1', roundId: 'r-deleted' }],
    );
    expect(messages.lastElementChild).toBe(cardsOf(messages, 's1')[0]);
  });

  it('幂等：重复渲染撤旧卡再插，不累积（跑完熄旋转但卡常在）', () => {
    const messages = flow();
    const list = [{ sid: 's1', title: 'X', via: 'delegate' as const }];
    const entries = [{ sid: 's1', roundId: 'r1' }];
    renderDispatchCards(messages, list, ['s1'], entries);
    expect(messages.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(1);
    expect(cardsOf(messages, 's1')[0]?.classList.contains('is-running')).toBe(true);

    renderDispatchCards(messages, list, [], entries);
    expect(messages.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(1);
    expect(cardsOf(messages, 's1')[0]?.classList.contains('is-running')).toBe(false);
  });

  it('同一 turn 同一会话重复身份只出一张（身份幂等 ≠ 会话去重）', () => {
    const messages = flow();
    renderDispatchCards(
      messages,
      [{ sid: 's1', title: 'X', via: 'delegate' }],
      [],
      [
        { sid: 's1', roundId: 'r1' },
        { sid: 's1', roundId: 'r1' },
      ],
    );
    expect(cardsOf(messages, 's1')).toHaveLength(1);
  });

  it('空条目撤掉所有旧卡（无派活 turn 不编卡）', () => {
    const messages = flow();
    renderDispatchCards(
      messages,
      [{ sid: 's1', title: 'X', via: 'delegate' }],
      [],
      [{ sid: 's1', roundId: 'r1' }],
    );
    expect(messages.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(1);
    expect(removeDispatchCards(messages)).toBe(1);
    expect(messages.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(0);
  });

  it('真名为空回落 sid，不写空串冒充', () => {
    const messages = flow();
    renderDispatchCards(
      messages,
      [{ sid: 's9', title: '', via: 'delegate' }],
      [],
      [{ sid: 's9', roundId: 'r1' }],
    );
    const card = cardsOf(messages, 's9')[0];
    expect(card?.querySelector('.dispatch-session-card__name')?.textContent).toBe('s9');
    expect(card?.title).toBe('s9');
  });
});
