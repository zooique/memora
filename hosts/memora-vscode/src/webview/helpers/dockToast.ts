/**
 * dock 浮层放置机制（UI-TOAST-1 · chatView resolveDock 的浮层分支外置）
 *
 * 背景：瞬态提示（活动条）浮层化后，「主位条归位」多出一种形态——主位恰是 activity 且
 * #activityToastSlot 在位时，本条出流、以绝对定位于该零高度槽（CSS 见 chatStyles 的
 * .activity-bar.is-toast），消息区不再被提示条生灭挤兑。本文件收这一域的放置/类同步
 * 机制；**裁决仍归 chatView 的 resolveDock 单点**（显隐与归位 SSOT 不在本文件），
 * 此处只放「判据已定之后的搬移/类操作」机械。
 *
 * 行为钉子：chatView.test.ts 的「UI-TOAST-1」describe 七项（info/error 浮层、confirm
 * 抑制涌现、error 豁免、槽↔收纳器迁移、自动撤除归位、CSS 源码守卫）+ P4 describe 的
 * 免重排行为锁/静态链/结构纪律——重构本文件须以它们为红绿基准。
 */

/** 主位条目最小结构（DockEntry 的结构子集：helper 不依赖 chatView 闭包内的类型） */
interface DockHeadLike {
  el: HTMLElement;
}

/** 浮层化标记类（UI-TOAST-1）：只切形态，不承载显隐（显隐归 resolveDock 的 hidden 单点） */
export const DOCK_TOAST_CLASS = 'is-toast';

/**
 * 浮层主位判据：主位恰是 activity 且 toast 槽在位。
 *
 * confirm 恒主位（pickDockHead 首判）⇒ confirm 在场时 activity 自动非主位 ⇒ 浮层
 * 自动抑制（只进历史 + 未读，与浮层化前被收进收纳器同语义）——抑制规则**不另设**，
 * 由既有优先级机制涌现；另造一套判据 = 第二个真相源。槽缺失（骨架未演进）⇒ 降级流内条。
 */
export function isToastHead(
  head: DockHeadLike | undefined,
  activityEntry: DockHeadLike | undefined,
  toastSlot: HTMLElement | null,
): boolean {
  return head !== undefined && toastSlot !== null && head === activityEntry;
}

/**
 * 归位循环的浮层同步：返回 true ⇒ 调用方 continue（免动）。
 *
 * 浮层主位已在槽内（父即槽且带浮层类）⇒ 免动：回流即掉位，重复搬动还破坏免重排
 * （resolveDock 会被重复触发——重复通知时 active/fixed 未变，见 activityDrawerView
 * showActivity 尾部说明；其余节点同位置重放是同步无帧操作，唯 head 可见）。
 * 其余条目（含非浮层主位）**先去类再搬移**：类在而人不在槽内 = 零高度槽里 absolute
 * 渲染错位 / 收纳器里浮层形态残留（2026-10-24 实踩：showActivity 曾以 className 整体
 * 赋值抹掉本类，被免重排行为锁抓住，见该类函数内注释）。
 */
export function toastLoopSkip(
  el: HTMLElement,
  isHead: boolean,
  asToast: boolean,
  toastSlot: HTMLElement | null,
): boolean {
  if (
    asToast &&
    isHead &&
    toastSlot !== null &&
    el.parentNode === toastSlot &&
    el.classList.contains(DOCK_TOAST_CLASS)
  ) {
    return true;
  }
  el.classList.remove(DOCK_TOAST_CLASS);
  return false;
}

/**
 * 主位归位（含 UI-TOAST-1 浮层分支）：浮层主位搬进 toast 槽 + 打类；其余条插 anchor 前。
 *
 * 插 anchor 前 = 静态 #dockPanel 之后、inputBar 之前，恒紧贴输入框。
 * 免重排守卫（P8 主位条瞬移闪烁血训）：head 已物理紧邻 anchor 就不搬——本函数会被
 * 重复触发，其余节点同位置重放是同步无帧操作，唯 head 可见、重复 insertBefore
 * 真机上 = 整条瞬移。
 *
 * @param headEl 主位条元素
 * @param anchor 流内归位锚（inputBar；流内主位插其前）
 * @param asToast 是否浮层主位（isToastHead 判据）
 * @param toastSlot 浮层槽（asToast 时非空）
 */
export function placeDockHead(
  headEl: HTMLElement,
  anchor: Element,
  asToast: boolean,
  toastSlot: HTMLElement | null,
): void {
  if (asToast && toastSlot) {
    // 浮层主位：定位于 toast 槽（hidden 仍由 resolveDock 单点裁决，禁调用方直写）
    if (headEl.parentNode !== toastSlot) toastSlot.appendChild(headEl);
    headEl.classList.add(DOCK_TOAST_CLASS);
    return;
  }
  headEl.classList.remove(DOCK_TOAST_CLASS);
  if (headEl.nextElementSibling !== anchor) {
    anchor.parentNode?.insertBefore(headEl, anchor);
  }
}
