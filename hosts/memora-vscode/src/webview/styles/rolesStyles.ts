/**
 * 角色子视图样式（设置视图选项卡内）— 对齐 configStyles.ts 的卡片列表 + 能力标签 chips
 *
 * 分层（对齐 ITCSS）：
 *   - 设计令牌由 tokens.ts 单一真理源提供，经 settingsStyles.ts 统一内嵌，本文件不再内嵌；
 *   - 选择器统一以 `#roles-root` 前缀限定 —— 设置视图合并后三个子视图共存于同一文档，
 *     共享类名（.card / .btn / .empty-state 等）靠根容器前缀隔离，避免跨子视图样式串扰；
 *   - 分区：Layout（header / list）→ Components（card / cap-chip / footer-hint）；
 *   - 能力标签 chips 装饰性强但克制：灰底灰字，不抢角色名视觉层级。
 */
export const rolesStyles = `
  /* ============ Layout：面板骨架 ============ */
  #roles-root .header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px); padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4)); }
  #roles-root .header h2 { font-size: var(--font-lg, 14px); margin: 0; }
  #roles-root .stat-bar { font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6); margin-left: auto; }
  #roles-root #list { padding: var(--sp-3, 8px); }
  #roles-root .group-title { font-size: var(--font-xs, 10px); letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-secondary, #9aa0a6); margin: var(--sp-3, 8px) 0 var(--sp-1, 4px); }
  #roles-root .footer-hint {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
    text-align: center;
  }

  /* ============ Components：角色包卡片 ============ */
  #roles-root .card { display: flex; align-items: flex-start; gap: var(--sp-3, 8px); padding: var(--sp-4, 10px); margin-bottom: var(--sp-3, 8px); border: 1px solid var(--border-panel, rgba(128,128,128,.4)); border-radius: var(--radius-lg, 8px); background: var(--surface-sidebar); }
  #roles-root .card.active { border-color: var(--accent, #0e639c); }
  /* 卡片图标：首字块（装饰性，aria-hidden） */
  #roles-root .role-icon { width: 26px; height: 26px; border-radius: var(--radius, 6px); display: inline-flex; align-items: center; justify-content: center; background: var(--surface-ai-avatar); color: var(--accent-foreground, #ffffff); font-size: var(--font-md, 12px); font-weight: 600; flex-shrink: 0; user-select: none; }
  #roles-root .card-info { display: flex; flex-direction: column; gap: var(--sp-1, 4px); min-width: 0; flex: 1; }
  #roles-root .card-name { font-weight: 600; }
  #roles-root .card-detail { font-size: var(--font-md, 12px); color: var(--text-secondary, #9aa0a6); }
  #roles-root .badge { font-size: var(--font-sm, 11px); padding: 1px var(--sp-2, 6px); border-radius: var(--radius-pill, 999px); background: var(--accent, #0e639c); color: var(--accent-foreground, #ffffff); margin-left: var(--sp-1, 4px); }
  #roles-root .card-actions { display: flex; gap: var(--sp-1, 4px); flex-shrink: 0; align-self: center; }
  #roles-root .hint { text-align: center; color: var(--text-secondary, #9aa0a6); padding: var(--sp-6, 16px); font-size: var(--font-md, 12px); }
  #roles-root .empty-state { text-align: center; padding: var(--sp-8, 24px) var(--sp-5, 12px); color: var(--text-secondary, #9aa0a6); }
  #roles-root .empty-title { font-size: var(--font-lg, 14px); font-weight: 600; color: var(--text-primary, #cccccc); margin-bottom: var(--sp-2, 6px); }
  #roles-root .empty-hint { font-size: var(--font-md, 12px); }

  /* ============ Components：能力标签 chips ============ */
  #roles-root .cap-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1, 4px); margin-top: var(--sp-1, 4px); }
  #roles-root .cap-chip {
    display: inline-block;
    padding: 1px var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-code, rgba(128,128,128,.12));
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    user-select: none;
  }
`;
