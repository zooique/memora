/**
 * 盖章会话卡区判据（DISPATCH-CARD-ZONE-1）
 *
 * 会话卡 = 第三种信息形态：「被宝盖章启动的会话」独立站在卡区，不嵌工具行。
 * 这里测纯 DOM 层（锚点 + 全量重建 + 去重 + 旋转），点击 post 在 chatView 测试里验。
 *
 * 变异靶标：
 *   - 卡片不打 data-dispatch-session 锚点 ⇒ 锚点用例红（点击委托也失去目标）；
 *   - 渲染不写真名 ⇒ 名字用例红；
 *   - 不写 is-running ⇒ 旋转用例红；
 *   - 不去重 ⇒ 重复卡用例红；
 *   - 空列表不隐藏卡区 ⇒ 空态用例红；
 *   - 真名为空不回落 sid ⇒ 兜底用例红。
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildDispatchSessionCard,
  DISPATCH_SESSION_ATTR,
  renderDispatchCardZone,
} from '../dispatchSessionCard.js';

describe('buildDispatchSessionCard 卡片骨架', () => {
  it('带 sid 锚点与名字节点；未渲染前名字显示 sid（不空着）', () => {
    const card = buildDispatchSessionCard(document, '2026-11-18-abc');
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute(DISPATCH_SESSION_ATTR)).toBe('2026-11-18-abc');
    expect(card.querySelector('.dispatch-session-card__name')?.textContent).toBe('2026-11-18-abc');
  });
});

describe('renderDispatchCardZone 独立卡区全量重建', () => {
  it('按盖章列表建卡：真名 + running 旋转 + via 标签同源', () => {
    const zone = document.createElement('div');
    renderDispatchCardZone(
      zone,
      [
        { sid: 's1', title: '统计目录文件数', via: 'delegate' },
        { sid: 's2', title: '空白页草稿', via: 'create' },
      ],
      ['s1'],
    );

    const cards = zone.querySelectorAll<HTMLElement>(`[${DISPATCH_SESSION_ATTR}]`);
    expect(cards).toHaveLength(2);
    const [running, idle] = Array.from(cards);
    expect(running?.querySelector('.dispatch-session-card__name')?.textContent).toBe(
      '统计目录文件数',
    );
    expect(running?.classList.contains('is-running')).toBe(true);
    expect(running?.dataset.via).toBe('delegate');
    expect(idle?.querySelector('.dispatch-session-card__name')?.textContent).toBe('空白页草稿');
    expect(idle?.classList.contains('is-running')).toBe(false);
    expect(idle?.dataset.via).toBe('create');
    expect(zone.hidden).toBe(false);
  });

  it('sid 去重：同一会话被派多次活只出一张卡（会话维度）', () => {
    const zone = document.createElement('div');
    renderDispatchCardZone(
      zone,
      [
        { sid: 's1', title: '第一次', via: 'delegate' },
        { sid: 's1', title: '第二次', via: 'delegate' },
      ],
      [],
    );
    expect(zone.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(1);
  });

  it('跑完卡还在：runningIds 变空后卡片保留、只熄灭旋转', () => {
    const zone = document.createElement('div');
    renderDispatchCardZone(zone, [{ sid: 's1', title: 'X', via: 'delegate' }], ['s1']);
    renderDispatchCardZone(zone, [{ sid: 's1', title: 'X', via: 'delegate' }], []);
    const card = zone.querySelector<HTMLElement>(`[${DISPATCH_SESSION_ATTR}]`);
    expect(card).not.toBeNull();
    expect(card?.classList.contains('is-running')).toBe(false);
  });

  it('空列表隐藏卡区，且不残留旧卡（全量重建）', () => {
    const zone = document.createElement('div');
    renderDispatchCardZone(zone, [{ sid: 's1', title: 'X', via: 'delegate' }], []);
    expect(zone.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(1);

    renderDispatchCardZone(zone, [], []);
    expect(zone.querySelectorAll(`[${DISPATCH_SESSION_ATTR}]`)).toHaveLength(0);
    expect(zone.hidden).toBe(true);
  });

  it('真名为空回落 sid，不写空串冒充', () => {
    const zone = document.createElement('div');
    renderDispatchCardZone(zone, [{ sid: 's9', title: '', via: 'delegate' }], []);
    const card = zone.querySelector<HTMLElement>(`[${DISPATCH_SESSION_ATTR}]`);
    expect(card?.querySelector('.dispatch-session-card__name')?.textContent).toBe('s9');
    expect(card?.title).toBe('s9');
  });
});
