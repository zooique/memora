// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { dispatch, mountChatView } from './helpers/chatViewTestEnv.js';

/**
 * onMessage 兜底用户可见（观察点③）
 *
 * 旧伤：handleMessage 抛错只 console.error，用户侧零呈现 → 渲染异常时看到「冻住/半成品 UI
 * + 无报错」的可见性黑洞。修复后：catch 内补 showActivity('error') 非阻断红条，与 console.error
 * 互补（根因定位不掩盖）。
 *
 * 强制真错：dispatch 一条 `process_event` 但缺 `event` 字段 → 走到 `const ev = msg.event;
 * ev.type` 抛 TypeError（真实 unguarded 路径，非伪造假错）。断言活动条落入 error 级。
 *
 * 变异点：删 onMessage catch 内 showActivity('error', ...) → 活动条 data-level 断言红。
 */
describe('onMessage 渲染异常用户可见（观察点③）', () => {
  beforeEach(() => {
    mountChatView();
  });

  it('handleMessage 抛错 → 活动条呈 error 级（非静默）', () => {
    dispatch({ type: 'process_event' }); // 缺 event 字段 → ev.type 抛 TypeError，被 onMessage 兜
    const bar = document.querySelector<HTMLElement>('#activityBar');
    expect(bar).not.toBeNull();
    expect(bar!.dataset.level).toBe('error');
    expect(bar!.textContent ?? '').toContain('渲染异常');
  });
});
