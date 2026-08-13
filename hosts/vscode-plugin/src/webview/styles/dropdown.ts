/**
 * 下拉菜单样式 — Trae 风格紧凑下拉（复用 VSCode 原生 menu 语义变量，亮/暗主题自适应）
 *
 * 结构约定（由 components/dropdown.ts 生成）：
 *   .treedd[data-treedd]           下拉容器（相对定位）
 *     .treedd__trigger              触发器按钮（含悬停态）
 *     .treedd__menu                 菜单浮层（绝对定位，默认隐藏）
 *       .treedd__item               菜单项
 *       .treedd__item.is-danger     危险操作项（红色）
 *
 * 激活态：容器加 .is-open 时菜单展开。
 */
export const dropdownStyles = `
  .treedd { position: relative; }
  .treedd__trigger {
    display: inline-flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; padding: 0;
    border: none; border-radius: var(--radius, 6px); cursor: pointer;
    background: transparent; color: var(--text-primary, #1f1f1f);
    font-size: var(--font-lg, 14px); line-height: 1;
  }
  .treedd__trigger:hover { background: var(--surface-hover, rgba(128,128,128,.2)); }
  .treedd__menu {
    position: absolute; right: 0; top: calc(100% + var(--sp-1, 4px));
    min-width: 168px; z-index: 30;
    padding: var(--sp-1, 4px); box-sizing: border-box;
    border: 1px solid var(--vscode-menu-border, #ccc);
    border-radius: var(--radius-lg, 8px);
    background: var(--vscode-menu-background, #ffffff);
    color: var(--vscode-menu-foreground, #1f1f1f);
    box-shadow: var(--shadow-modal, 0 4px 16px rgba(0, 0, 0, 0.3));
    display: none;
    flex-direction: column; gap: var(--sp-0, 2px);
  }
  .treedd.is-open .treedd__menu { display: flex; }
  .treedd__item {
    display: block; width: 100%; padding: var(--sp-2, 6px) var(--sp-4, 10px); box-sizing: border-box;
    border: none; border-radius: var(--radius, 6px); text-align: left;
    background: transparent; cursor: pointer;
    font-size: var(--font-md, 12px); line-height: 1.5;
    color: var(--vscode-menu-foreground, #1f1f1f);
  }
  .treedd__item:hover,
  .treedd__item:focus-visible {
    outline: none;
    background: var(--vscode-menu-selectionBackground, #e0e0e0);
    color: var(--vscode-menu-selectionForeground, #1f1f1f);
  }
  .treedd__item.is-danger { color: var(--vscode-errorForeground, #b3261e); }
  .treedd__item.is-danger:hover { color: var(--vscode-errorForeground, #b3261e); }
`;