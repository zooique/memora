/**
 * dispatchSessionCard 派活会话卡判据（DISPATCH-SESSION-CARD-1）
 *
 * 卡片 = 派活工具行里的「打开目标会话」按钮：sid 锚点来自工具 args，标题/旋转由
 * session_activity 快照刷新。这里测纯 DOM 层（锚点 + 刷新），点击 post 在 chatView 测试里验。
 *
 * 变异靶标：
 *   - 卡片不打 data-dispatch-session 锚点 ⇒ 锚点用例红（点击委托也失去目标）；
 *   - refresh 不写 titleById ⇒ 标题用例红；
 *   - refresh 不切 is-running ⇒ 旋转用例红；
 *   - 标题缺失时写空串而非保留 sid ⇒ 兜底用例红。
 */
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildDispatchSessionCard,
  DISPATCH_SESSION_ATTR,
  refreshDispatchSessionCards,
} from '../dispatchSessionCard.js';

describe('buildDispatchSessionCard 卡片骨架', () => {
  it('带 sid 锚点与名字节点；未刷新前名字显示 sid（不空着）', () => {
    const card = buildDispatchSessionCard(document, '2026-11-18-abc');
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute(DISPATCH_SESSION_ATTR)).toBe('2026-11-18-abc');
    expect(card.querySelector('.dispatch-session-card__name')?.textContent).toBe('2026-11-18-abc');
  });
});

describe('refreshDispatchSessionCards 快照刷新', () => {
  it('按 titleById 写展示名，按 runningIds 切 is-running', () => {
    const running = buildDispatchSessionCard(document, 's1');
    const idle = buildDispatchSessionCard(document, 's2');
    const root = document.createElement('div');
    root.append(running, idle);

    refreshDispatchSessionCards(root, { s1: '统计目录文件数', s2: '空白页草稿' }, ['s1']);

    expect(running.querySelector('.dispatch-session-card__name')?.textContent).toBe(
      '统计目录文件数',
    );
    expect(running.classList.contains('is-running')).toBe(true);
    expect(running.title).toBe('统计目录文件数');
    expect(idle.querySelector('.dispatch-session-card__name')?.textContent).toBe('空白页草稿');
    expect(idle.classList.contains('is-running')).toBe(false);
  });

  it('标题未命中时保留 sid，不写空串冒充', () => {
    const card = buildDispatchSessionCard(document, 's9');
    const root = document.createElement('div');
    root.append(card);

    refreshDispatchSessionCards(root, {}, []);

    expect(card.querySelector('.dispatch-session-card__name')?.textContent).toBe('s9');
    expect(card.title).toBe('s9');
  });

  it('运行态可反转：先前 running 的会话本次不在集合 ⇒ 熄灭旋转', () => {
    const card = buildDispatchSessionCard(document, 's1');
    card.classList.add('is-running');
    const root = document.createElement('div');
    root.append(card);

    refreshDispatchSessionCards(root, { s1: 'X' }, []);

    expect(card.classList.contains('is-running')).toBe(false);
  });
});
