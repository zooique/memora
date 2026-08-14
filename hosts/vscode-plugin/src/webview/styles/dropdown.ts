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
  .treedd__item.is-danger { color: var(--status-fail); }
  .treedd__item.is-danger:hover { color: var(--status-fail); }

  /* ===== 胶囊变体（.treedd--capsule）=====
   * 模型选择 / 历史切换等「紧凑胶囊触发器」的通用外观，集中定义一次，面板复用。
   * 相比各面板以 !important 覆写组件默认样式（层叠污染的架构反模式），此变体以
   * 更高特异性选择器在组件内自然覆盖默认「⋯」图标按钮，无需 !important
   * （对抗评估 P2-2/P2-4）。
   * 差异通过 CSS 变量定制：--dd-trigger-max-w（触发器最大宽，超长省略兜底）、
   * --dd-menu-min-w / --dd-menu-max-w（菜单尺寸）。 */
  .treedd--capsule .treedd__trigger {
    display: inline-flex; align-items: center; gap: var(--sp-1, 4px);
    height: var(--control-h, 28px); width: auto; /* 宽度随内容自适应 */
    max-width: var(--dd-trigger-max-w, 200px);
    padding: 0 var(--sp-4, 10px); box-sizing: border-box;
    border-radius: var(--radius, 6px); cursor: pointer;
    background: var(--surface-card, #252526);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    color: var(--text-primary, #cccccc);
    font-size: var(--font-md, 12px); line-height: 1; font-weight: 500;
    white-space: nowrap; overflow: visible; /* 由子 span.dd-model-name 负责截断 */
  }
  .treedd--capsule .treedd__trigger::before { content: none; } /* 显式清零，保证只有 1 个箭头 */
  /* 下拉箭头：flex-shrink:0 保证即使名称被截断也永远外露 */
  .treedd--capsule .treedd__trigger::after {
    content: '▾'; display: inline-block; flex-shrink: 0;
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); margin-left: 2px;
  }
  /* 名称文本容器：负责截断（配合触发器 max-width 兜底） */
  .treedd--capsule .treedd__trigger .dd-model-name {
    min-width: 0; flex: 1 1 auto; overflow: hidden;
    white-space: nowrap; text-overflow: ellipsis; line-height: 1;
  }
  .treedd--capsule .treedd__trigger:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
    border-color: var(--border-focus, #0e639c);
  }
  /* 菜单：向上弹出 + 左对齐（避免向右溢出面板右缘，替代面板级 !important 覆写） */
  .treedd--capsule .treedd__menu {
    left: 0; right: auto; top: auto;
    bottom: calc(100% + var(--sp-2, 6px));
    min-width: var(--dd-menu-min-w, 160px);
    max-width: min(var(--dd-menu-max-w, 240px), calc(100vw - 32px));
    max-height: 260px; overflow-y: auto;
  }
`;