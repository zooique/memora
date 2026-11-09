/**
 * 作品和规则子视图样式（按 `#works-root` 前缀隔离，与 rolesStyles / mcpStyles 同型）
 *
 * ⚠️ **绝不给 `#works-root` 本身写 `display`**：tab 面板的显隐由 `hidden` 属性管
 * （settingsView.switchTab 统一切换）。给 root 写 display 会覆盖 hidden ⇒ 隐藏页照样
 * 铺在屏幕上，且单测全绿、只有真机看得到（UI 一致性规则 10）。垂直节奏靠子元素 margin。
 *
 * 🔴 **共享类必须逐页以 root 前缀接管**：`.header` / `.stat-bar` / `.hint` 等在别的 tab
 * 有定义，但没有 `#works-root` 前缀就不命中本页。2026-11-09 真机截图暴露本页首版
 * 七个共享类零规则 ⇒ 标题、计数、刷新按钮竖向堆叠、说明贴边（与 mcpStyles 头注释
 * 记录的 2026-10-24 MCP 首版「样式整层缺失」同类伤）。DOM 测试不查计算样式，
 * 故由 settingsTabWiring.test.ts 的共享类对拍守卫兜住「再加一页又漏」。
 *
 * 颜色 / 间距一律取 tokens.ts 的变量，不写死色值（暗色 / 亮色主题跟随 VS Code）。
 * 图标尺寸由 getIconSvg 的 16px 网格自带 ⇒ 不在此重复写死宽高（既免裸值，也免第二份尺寸真源）。
 */

export const worksStyles = `
  /* ============ works：作品和规则清单 ============ */
  /* 页头：标题 + 计数 + 刷新同一行、底部分隔线满宽（与 roles/mcp/config 同构） */
  #works-root .header {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: var(--line-solid);
  }
  #works-root .header h2 { margin: 0; font-size: var(--font-lg, 14px); }
  /* 计数推到行尾、动作组不收缩：截图里「1 条」与刷新按钮掉到标题下方即因这两条缺失 */
  #works-root .stat-bar {
    margin-left: auto; font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6);
  }
  #works-root .header-actions {
    display: flex; align-items: center; gap: var(--sp-2, 6px); flex-shrink: 0;
  }
  #works-root .btn-icon-solo {
    display: inline-flex; align-items: center; justify-content: center;
    padding: var(--sp-2, 6px);
  }
  #works-root .btn-icon { display: inline-flex; align-items: center; justify-content: center; color: currentColor; }
  #works-root .btn-icon svg { display: block; }

  /* 页级说明 / 页尾脚注：与页头标题同取 12px 左缘；长中文段落用宽松行高 */
  #works-root .hint {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    color: var(--text-secondary, #9aa0a6); font-size: var(--font-sm, 11px);
    line-height: var(--lh-relaxed);
  }
  #works-root .hint strong { color: var(--text-primary, #cccccc); }
  #works-root .hint code {
    background: var(--surface-hover, rgba(128,128,128,.2));
    padding: var(--sp-hair, 1px) var(--sp-1, 4px);
    border-radius: var(--radius-sm, 2px);
  }
  #works-root .footer-hint {
    margin: var(--sp-3, 8px) 0 0;
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    border-top: var(--line-solid);
    color: var(--text-secondary, #9aa0a6); font-size: var(--font-xs, 10px);
    line-height: var(--lh-relaxed);
  }

  #works-root .works-notice {
    margin: 0 var(--sp-5, 12px) var(--sp-3, 8px);
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
    margin: 0 var(--sp-5, 12px);
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
    gap: var(--sp-1, 4px);
  }
  /* 首行：作品名与状态后缀两端对齐。名称可截断，状态后缀恒完整（失效原因不能被省略号吃掉） */
  #works-root .works-row-head {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: var(--sp-2, 6px); min-width: 0;
  }
  #works-root .works-row-name {
    flex: 1 1 auto; min-width: 0;
    font-size: var(--font-base, 13px);
    color: var(--text-primary, #cccccc);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #works-root .works-row-status {
    flex: 0 0 auto; white-space: nowrap;
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
  }
  /* 简介直接落在卡片里（不再只靠 hover tooltip）；长文本可换行，超长词不撑破卡片 */
  #works-root .works-row-description {
    display: block;
    color: var(--text-primary, #cccccc);
    font-size: var(--font-sm, 11px);
    line-height: var(--lh-relaxed);
    overflow-wrap: anywhere;
  }
  #works-root .works-row-source {
    display: block;
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
