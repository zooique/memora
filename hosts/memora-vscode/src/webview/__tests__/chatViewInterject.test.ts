/**
 * 插话「吸收时上屏」webview 侧测试（快照 diff 分流：消失条目 = 消费上屏 / 丢弃不上屏）
 *
 * 覆盖四条分流规则：
 *   ① 消费：队列减少且无丢弃信号 → 过程区上屏「你补充」行（appendInteractiveInput 形态）；
 *   ② 丢弃：队列减少且命中 pending_discarded 信号 → 不上屏（孤儿行根因的闭合点）；
 *   ③ 重复内容按出现次数消耗（同文本两条删一条 → 零误上屏）；
 *   ④ 一次消费多条按 prev 顺序逐条上屏（与内核 _consumeInterjects 遍历序一致）。
 *
 * 宿主出口（入队不 post user / 丢弃路径发信号）归 chatPanelInterject.test.ts。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

/** 全部「你补充」过程条目行 */
function supRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.round-block__input')).filter(
    (el) => el.querySelector('.round-block__input-tag')?.textContent === '你补充',
  );
}

/** 推一帧队列快照（turn_update.pendingQueue 是待发送区渲染真源） */
function pushQueue(items: string[]): void {
  dispatch({
    type: 'turn_update',
    rounds: [],
    state: { phase: 'running' },
    pendingQueue: items,
  });
}

describe('插话吸收时上屏 · webview diff 分流（chatView）', () => {
  beforeEach(() => {
    mountChatView();
  });

  it('消费：队列减少（无信号）→ 上屏「你补充」行，文本完整', () => {
    pushQueue(['补充：不要联网搜索']);
    pushQueue([]); // 消费 = 内核 appendUserMessage 已落盘
    const rows = supRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('不要联网搜索');
  });

  it('丢弃：队列减少且命中丢弃信号 → 不上屏（取消排队零孤儿）', () => {
    pushQueue(['想撤回的补充']);
    dispatch({ type: 'pending_discarded', items: ['想撤回的补充'] });
    pushQueue([]); // 删除导致减少
    expect(supRows()).toHaveLength(0);
  });

  it('重复内容按出现次数消耗：两条同文本删一条零误上屏，消费另一条才上屏', () => {
    pushQueue(['相同文本', '相同文本']);
    // 删一条（丢弃信号）→ 快照剩一条
    dispatch({ type: 'pending_discarded', items: ['相同文本'] });
    pushQueue(['相同文本']);
    expect(supRows()).toHaveLength(0); // 消失的那条被缓冲吞掉，不上屏
    // 剩余一条被消费（无信号）→ 上屏恰一条
    pushQueue([]);
    expect(supRows()).toHaveLength(1);
  });

  it('一次消费多条 → 按 prev 顺序逐条上屏（与内核消费序一致）', () => {
    pushQueue(['第一条补充', '第二条补充', '第三条补充']);
    pushQueue([]);
    const rows = supRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('第一条补充');
    expect(rows[1]!.textContent).toContain('第二条补充');
    expect(rows[2]!.textContent).toContain('第三条补充');
  });

  it('视图复位清丢弃缓冲：复位后无残留缓冲误吞新会话的消费条目', () => {
    pushQueue(['旧会话的补充']);
    dispatch({ type: 'pending_discarded', items: ['旧会话的补充'] });
    // 切换会话 → resetChatView 清缓冲与队列投影
    dispatch({
      type: 'turn_update',
      rounds: [],
      state: { phase: 'idle' },
      pendingQueue: [],
      replay: true,
    });
    // 新会话里同名文本的消费必须正常上屏（残留缓冲若未清会把它误吞）
    pushQueue(['旧会话的补充']);
    pushQueue([]);
    expect(supRows()).toHaveLength(1);
  });
});
