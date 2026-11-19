/**
 * 助手页工作台抽屉的显隐真源与切换（INLINE-WORKBENCH-1 真机订正 2026-11-19）
 *
 * 展开态**唯一真源 = 抽屉 DOM 节点的 `hidden` 属性**，不在 JS 里另存开关状态——
 * 后者会与「收到 workbench_snapshot 即展开」形成双真源。关闭 / 再点折叠都只置这一位，
 * 展开则回上行 `assistant_open_workbench` 由宿主现场重建快照（真源仍 = buildSnapshot）。
 *
 * 纯 DOM helper，无 webview 全局副作用（helpers/ 落点纪律）；document 显式注入便于测试。
 */

/** 抽屉节点 id（骨架在 chatPanelHtml，与 chatView 消息分支共用同一字面锚点） */
const DRAWER_ID = 'assistantWorkbenchDrawer';

/** 关闭抽屉（置 hidden 真源；节点不存在时静默，self 形态无该节点） */
export function hideWorkbenchDrawer(document: Document): void {
  const drawer = document.getElementById(DRAWER_ID);
  if (drawer) drawer.hidden = true;
}

/**
 * 顶部按钮 toggle：已展开 ⇒ 置 hidden 折叠并返回 false（不再请求快照）；
 * 未展开 ⇒ 返回 true 让调用方上行 `assistant_open_workbench` 请求宿主现场构建快照。
 */
export function shouldOpenWorkbench(document: Document): boolean {
  const drawer = document.getElementById(DRAWER_ID);
  if (drawer && !drawer.hidden) {
    drawer.hidden = true;
    return false;
  }
  return true;
}
