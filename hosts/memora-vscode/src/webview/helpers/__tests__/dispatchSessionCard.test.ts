/**
 * 盖章会话卡（DISPATCH-CARD-INLINE-1）判据
 *
 * 会话卡 = 第三种信息形态：按触发轮穿插进对话气泡之间（非顶部固定卡区）。
 * 这里测纯 DOM 层：锚点插卡 / 无锚点落尾 / 幂等 / 去重 / 真名 / 旋转 / 跑完常在。
 * 点击 post 与 form 归属在 chatView 测试里验。
 *
 * 变异靶标：
 *   - 不按锚点插（一律 appendChild）⇒ 锚点用例红；
 *   - 无锚点不落流尾 ⇒ 落尾用例红；
 *   - 卡片不打 data-dispatch-session ⇒ 锚点用例红（点击委托也失去目标）；
 *   - 渲染不写真名 ⇒ 名字用例红；不写 is-running ⇒ 旋转用例红；
 *   - sid 不去重 ⇒ 重复卡用例红；撤卡失效 ⇒ 幂等用例红；
 *   - 按钮字号/内距回落旧档 ⇒ 尺寸守卫红。
 */
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  buildDispatchSessionCard,
  DISPATCH_SESSION_ATTR,
  removeDispatchCards,
  renderDispatchCards,
} from '../dispatchSessionCard.js';

const HOST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function flow(): HTMLElement {
  const messages = document.createElement('div');
  messages.id = 'messages';
  // 造三轮消息（每轮 user + assistant 两条带 data-round-id 的节点）
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

function cardOf(messages: HTMLElement, sid: string): HTMLElement | null {
  return messages.querySelector<HTMLElement>(`[${DISPATCH_SESSION_ATTR}="${sid}"]`);
}

describe('buildDispatchSessionCard 卡片骨架', () => {
  it('带 sid 锚点与名字节点；未渲染前名字显示 sid（不空着）', () => {
    const card = buildDispatchSessionCard(document, '2026-11-18-abc');
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute(DISPATCH_SESSION_ATTR)).toBe('2026-11-18-abc');
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

describe('renderDispatchCards 按轮锚点穿插消息流', () => {
  it('有锚点的卡插在触发轮最后一条消息之后（第三种形态：不在 .round-block 内）', () => {
    const messages = flow();
    renderDispatchCards(
      messages,
      [
        { sid: 's1', title: '统计目录文件数', via: 'delegate' },
        { sid: 's2', title: '空白页草稿', via: 'create' },
      ],
      ['s1'],
      new Map([
        ['s1', 'r1'],
        ['s2', 'r2'],
      ]),
    );
    const c1 = cardOf(messages, 's1')!;
    const c2 = cardOf(messages, 's2')!;
    expect(c1).not.toBeNull();
    expect(c2).not.toBeNull();
    // s1 卡紧跟 r1 的 assistant 块；s2 卡紧跟 r2 的 assistant 块
    const r1Assistant = messages.querySelector<HTMLElement>('.msg.assistant[data-round-id="r1"]')!;
    expect(r1Assistant.nextElementSibling).toBe(c1);
    const r2Assistant = messages.querySelector<HTMLElement>('.msg.assistant[data-round-id="r2"]')!;
    expect(r2Assistant.nextElementSibling).toBe(c2);
    // 独立第三形态 + 真名 + 旋转 + via
    expect(c1.closest('.round-block')).toBeNull();
    expect(c1.querySelector('.dispatch-session-card__name')?.textContent).toBe('统计目录文件数');
    expect(c1.classList.contains('is-running')).toBe(true);
    expect(c1.dataset.via).toBe('delegate');
    expect(c2.dataset.via).toBe('create');
    expect(c2.classList.contains('is-running')).toBe(false);
  });

  it('无锚点 / 锚点节点已消失 ⇒ 卡落流尾兜底（仍属对话内容）', () => {
    const messages = flow();
    renderDispatchCards(
      messages,
      [
        { sid: 's1', title: '实时会话', via: 'delegate' },
        { sid: 's2', title: '锚已失效', via: 'delegate' },
      ],
      [],
      new Map([['s2', 'r-deleted']]), // s2 锚点不在流里
    );
    // 无锚点按 sessions 下发顺序 append：s1 先、s2 后 ⇒ 流尾是 s2
    expect(messages.lastElementChild).toBe(cardOf(messages, 's2'));
    expect(messages.children[messages.children.length - 2]).toBe(cardOf(messages, 's1'));
  });

  it('幂等：重复渲染撤旧卡再插，不累积（跑完熄旋转但卡常在）', () => {
    const messages = flow();
    const list = [{ sid: 's1', title: 'X', via: 'delegate' as const }];
    renderDispatchCards(messages, list, ['s1'], new Map([['s1', 'r1']]));
    expect(messages.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(1);
    expect(cardOf(messages, 's1')?.classList.contains('is-running')).toBe(true);

    renderDispatchCards(messages, list, [], new Map([['s1', 'r1']]));
    expect(messages.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(1);
    expect(cardOf(messages, 's1')?.classList.contains('is-running')).toBe(false);
  });

  it('sid 去重：同一会话被派多次活只出一张卡（会话维度）', () => {
    const messages = flow();
    renderDispatchCards(
      messages,
      [
        { sid: 's1', title: '第一次', via: 'delegate' },
        { sid: 's1', title: '第二次', via: 'delegate' },
      ],
      [],
      new Map(),
    );
    expect(messages.querySelectorAll(`[${DISPATCH_SESSION_ATTR}="s1"]`)).toHaveLength(1);
  });

  it('空列表撤掉所有旧卡（无盖章不编卡）', () => {
    const messages = flow();
    renderDispatchCards(messages, [{ sid: 's1', title: 'X', via: 'delegate' }], [], new Map());
    expect(messages.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(1);
    expect(removeDispatchCards(messages)).toBe(1);
    expect(messages.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(0);
  });

  it('真名为空回落 sid，不写空串冒充', () => {
    const messages = flow();
    renderDispatchCards(messages, [{ sid: 's9', title: '', via: 'delegate' }], [], new Map());
    const card = cardOf(messages, 's9');
    expect(card?.querySelector('.dispatch-session-card__name')?.textContent).toBe('s9');
    expect(card?.title).toBe('s9');
  });
});
