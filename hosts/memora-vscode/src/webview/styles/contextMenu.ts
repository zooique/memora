/**
 * 右键语义菜单样式（COPY-2 · Layer B）— 走 tokens 的 --menu-* 语义令牌族
 * （与 dropdownStyles 同族同源：右键菜单与下拉菜单是同语义 UI，不另造令牌），
 * 亮/暗主题自适应；变量回退值同 dropdown 族口径。
 *
 * 结构约定（由 components/contextMenu.ts 生成）：
 *   .ctxmenu                        菜单浮层（fixed 定位，光标坐标 + 视口边界翻转）
 *     .ctxmenu__item                菜单项（button，键盘可达）
 *     .ctxmenu__item.is-danger      危险操作项（红色，形态同 .treedd__item.is-danger）
 *
 * 令牌注入前提（勿自带注入）：本样式不内嵌 `${tokens}`，颜色/间距令牌由挂载面板
 * 统一注入（同 dropdownStyles 前提；当前挂载点 = chatPanel styles 拼接处）。
 * 组件挂载后位置由 JS 写 left/top（视口边界翻转），此处只定 fixed 基准。
 */
export const contextMenuStyles = `
  .ctxmenu {
    position: fixed; z-index: var(--z-menu);
    min-width: min(var(--dim-lg), calc(100vw - var(--sp-6))); max-width: calc(100vw - var(--sp-6));
    padding: var(--sp-1, 4px); box-sizing: border-box;
    border: 1px solid var(--menu-border, rgba(128, 128, 128, 0.4));
    border-radius: var(--radius-lg, 8px);
    background: var(--menu-bg, #252526);
    color: var(--menu-fg, #cccccc);
    box-shadow: var(--shadow-modal, 0 4px 16px rgba(0, 0, 0, 0.3));
    display: flex; flex-direction: column; gap: var(--sp-0, 2px);
    /* 浮层强制独立合成层，隔离布局影响（同 .treedd__menu 先例） */
    transform: translateZ(0);
  }
  .ctxmenu__item {
    display: block; width: 100%; padding: var(--sp-2, 6px) var(--sp-4, 10px); box-sizing: border-box;
    border: none; border-radius: var(--radius, 6px); text-align: left;
    background: transparent; cursor: pointer;
    font-size: var(--font-md, 12px); line-height: var(--lh-snug);
    color: var(--menu-fg, #cccccc);
  }
  .ctxmenu__item:hover,
  .ctxmenu__item:focus-visible {
    outline: none;
    background: var(--menu-selection-bg, rgba(14, 99, 156, 0.06));
    color: var(--menu-selection-fg, #cccccc);
  }
  .ctxmenu__item.is-danger { color: var(--status-fail); }
  .ctxmenu__item.is-danger:hover { color: var(--status-fail); }
`;
