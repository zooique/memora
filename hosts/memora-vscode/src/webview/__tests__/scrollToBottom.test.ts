// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { followIfPinned, trackScroll } from '../helpers/scrollToBottom.js';

/**
 * followIfPinned 单测（jsdom 无布局，用 Object.defineProperty 注入几何做可控单测）
 *
 * 覆盖：吸底变更后 rAF 吸底 + 返回意图；非吸底不滚、返回 false（不打断上滚阅读）。
 *
 * 变异点（改回旧行为 → 本组断言转红，证明测试锁真）：
 *   - 删 followIfPinned 内 `if (sticky)` 分支（不滚）→ 用例① scrollTop 断言红；
 *   - 删 `return sticky` 改为恒返回 true/void → 用例② 返回值断言红。
 */
describe('scrollToBottom.followIfPinned', () => {
  let container: HTMLElement;
  let scrollTop = 0;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    scrollTop = 0;
    Object.defineProperty(container, 'scrollTop', {
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v;
      },
      configurable: true,
    });
    Object.defineProperty(container, 'scrollHeight', { get: () => 1000, configurable: true });
    Object.defineProperty(container, 'clientHeight', { get: () => 400, configurable: true });
  });

  it('吸底时：rAF 滚到底 + 返回 true（高度变更后保持吸底）', async () => {
    // 用户已在底部附近：scrollTop 推到 600 → 1000 - 600 - 400 = 0 ≤ 48 → trackScroll 记录 pinned
    scrollTop = 600;
    expect(trackScroll(container)).toBe(true);
    const pinned = followIfPinned(container);
    expect(pinned).toBe(true);
    await new Promise<void>((r) => setTimeout(r, 50));
    expect(scrollTop).toBe(1000); // 高度变更后回到底部（只读既有吸底意图，不重算几何）
  });

  it('非吸底时：不滚 + 返回 false（不打断上滚阅读）', () => {
    // 用户上滚翻历史：scrollTop=0 → 距底 600 > 48 → not pinned
    expect(trackScroll(container)).toBe(false);
    const pinned = followIfPinned(container);
    expect(pinned).toBe(false);
    expect(scrollTop).toBe(0); // 不动位置，避免被拽走
  });
});
