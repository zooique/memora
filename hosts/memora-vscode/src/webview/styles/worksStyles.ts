/**
 * 作品子视图样式（按 `#works-root` 前缀隔离，与 rolesStyles / mcpStyles 同型）
 *
 * ⚠️ **绝不给 `#works-root` 本身写 `display`**：tab 面板的显隐由 `hidden` 属性管
 * （settingsView.switchTab 统一切换）。给 root 写 display 会覆盖 hidden ⇒ 隐藏页照样
 * 铺在屏幕上，且单测全绿、只有真机看得到（UI 一致性规则 10）。
 *
 * 颜色 / 间距一律取 tokens.ts 的变量，不写死色值（暗色 / 亮色主题跟随 VS Code）。
 * 图标尺寸由 getIconSvg 的 16px 网格自带 ⇒ 不在此重复写死宽高（既免裸值，也免第二份尺寸真源）。
 */

export const worksStyles = `
  /* ============ works：作品投影清单 ============ */
  #works-root .works-notice {
    margin: 0 0 var(--sp-3, 8px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    border: var(--line-solid);
    border-radius: var(--radius, 6px);
    background: var(--surface-card, #252526);
    color: var(--text-primary, #cccccc);
    font-size: var(--font-sm, 11px);
    line-height: var(--lh-relaxed);
  }
  #works-root .works-notice.is-warning {
    border-color: var(--warn, #d7ba7d);
  }
  #works-root .works-list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2, 6px);
  }
  #works-root .works-empty {
    margin: var(--sp-3, 8px) 0;
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-sm, 11px);
    line-height: var(--lh-relaxed);
  }
  #works-root .works-empty.is-warning {
    color: var(--warn, #d7ba7d);
  }
  #works-root .works-row {
    display: flex;
    align-items: center;
    gap: var(--sp-3, 8px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    border: var(--line-solid);
    border-radius: var(--radius, 6px);
    background: var(--surface-card, #252526);
    cursor: pointer;
  }
  #works-root .works-row:hover,
  #works-root .works-row:focus-visible {
    border-color: var(--accent, #0e639c);
    outline: none;
  }
  #works-root .works-row.is-failure {
    border-color: var(--warn, #d7ba7d);
  }
  #works-root .works-row-icon {
    flex: 0 0 auto;
    display: inline-flex;
    color: var(--text-secondary, #9aa0a6);
  }
  #works-root .works-row.is-failure .works-row-icon {
    color: var(--warn, #d7ba7d);
  }
  #works-root .works-row-body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-0);
  }
  #works-root .works-row-name {
    font-size: var(--font-base, 13px);
    color: var(--text-primary, #cccccc);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #works-root .works-row-source {
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #works-root .works-row-status {
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
  }
  #works-root .works-row-actions {
    flex: 0 0 auto;
    display: flex;
    gap: var(--sp-2, 6px);
  }
  #works-root .works-row-btn {
    white-space: nowrap;
  }
`;
