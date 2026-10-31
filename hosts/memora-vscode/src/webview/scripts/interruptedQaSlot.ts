/**
 * 中断轮交互行外置槽（用户拍板 2026-10-31）
 *
 * 域职责：为「中断轮」提供一个挂在过程折叠块**之外**的容器，承载用户交互回顾行
 *（问 + 你答 / 未回答）。
 *
 * 为什么需要：`docs/qa-折叠块收敛-设计.md` 把运行时输入收敛为折叠块内的过程条目，
 * 该定案在中断轮失效——中断轮没有正文块，过程整块收进折叠条后，该轮在屏上只剩一个
 * 折叠条，「刚才问了什么 / 我答了什么」全部不可见（真机 2026-10-31 实证：停止后重载，
 * 三条未回答行仍在盘面，屏上却只剩折叠条）。用户交互是对话主干而非过程产物：
 * **过程可以收起，交互必须可见**。
 *
 * **边界**：只建容器、不搬行、不持有状态；行的插入与排序仍由 chatView 的排序单点负责。
 *
 * @module interruptedQaSlot
 */

/**
 * 取得（必要时创建）中断轮的交互行外置槽
 *
 * 幂等：同一轮重复调用复用既有容器（finalize 多次重建不叠槽）。
 * 挂载点 = 折叠块之后（与停止行同侧，均在折叠块外）。
 *
 * @param rb 过程折叠块（`.round-block`，通常是 `details` 元素）
 * @param doc 文档对象（构造唯一 DOM 入口；禁在模块内读全局 document）
 * @returns 外置槽容器
 */
export function ensureInterruptedQaSlot(rb: HTMLElement, doc: Document): HTMLElement {
  const prev = rb.parentElement?.querySelector<HTMLElement>(':scope > .round-block__qa-outside');
  if (prev) return prev;
  const box = doc.createElement('div');
  box.className = 'round-block__qa-outside';
  rb.after(box);
  return box;
}
