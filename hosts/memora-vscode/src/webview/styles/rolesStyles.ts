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

  /* ============ Components：角色包卡片 ============ */
  /* Card 基类见 settingsStyles 通用块；此处保留对齐差异（flex-start） */
  #roles-root .card { align-items: flex-start; }
  /* 卡片图标：首字块（装饰性，aria-hidden） */
  #roles-root .role-icon { width: 26px; height: 26px; border-radius: var(--radius, 6px); display: inline-flex; align-items: center; justify-content: center; background: var(--surface-ai-avatar); color: var(--accent-foreground, #ffffff); font-size: var(--font-md, 12px); font-weight: 600; flex-shrink: 0; user-select: none; }
  #roles-root .card-info { display: flex; flex-direction: column; gap: var(--sp-1, 4px); min-width: 0; flex: 1; }
  #roles-root .card-name { font-weight: 600; }
  #roles-root .card-detail { font-size: var(--font-md, 12px); color: var(--text-secondary, #9aa0a6); }
  #roles-root .card-actions { display: flex; gap: var(--sp-1, 4px); flex-shrink: 0; align-self: center; }

  /* ============ Components：能力标签 chips ============ */
  #roles-root .cap-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1, 4px); margin-top: var(--sp-1, 4px); }

  /* ============ Components：性格特征 (Traits) ============ */
  #roles-root .role-traits { display: flex; flex-direction: column; gap: var(--sp-1, 4px); margin-top: var(--sp-2, 6px); }
  #roles-root .trait { display: flex; align-items: center; gap: var(--sp-2, 6px); }
  #roles-root .trait-label { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); min-width: 32px; }
  #roles-root .trait-bar { flex: 1; height: 4px; background: var(--border-panel, rgba(128,128,128,.2)); border-radius: 2px; overflow: hidden; }
  #roles-root .trait-fill { height: 100%; background: var(--accent, #007acc); border-radius: 2px; transition: width 0.3s ease; }

  /* ============ Components：互斥关系 (Exclusive) ============ */
  #roles-root .role-exclusive { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-1, 4px); margin-top: var(--sp-2, 6px); }
  #roles-root .exclusive-label { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
  #roles-root .exclusive-tag { font-size: var(--font-xs, 10px); padding: 2px 6px; background: var(--surface-hover, rgba(128,128,128,.15)); border-radius: 3px; color: var(--text-secondary, #9aa0a6); }

  /* ============ Components：策略指示器 (Strategy) ============ */
  #roles-root .role-strategy { display: flex; flex-wrap: wrap; gap: var(--sp-1, 4px); margin-top: var(--sp-2, 6px); }
  #roles-root .strategy-chip { font-size: var(--font-xs, 10px); padding: 2px 8px; border-radius: 3px; background: var(--surface-hover, rgba(128,128,128,.1)); color: var(--text-secondary, #9aa0a6); }
  #roles-root .strategy-chip.readonly { background: rgba(255, 165, 0, 0.2); color: #ffa500; }
  #roles-root .strategy-chip.full { background: rgba(76, 175, 80, 0.2); color: #4caf50; }
  #roles-root .strategy-chip.confirm { background: rgba(244, 67, 54, 0.2); color: #f44336; }
  #roles-root .strategy-chip.auto { background: rgba(33, 150, 243, 0.2); color: #2196f3; }
  #roles-root .strategy-chip.temp-high { background: rgba(156, 39, 176, 0.2); color: #9c27b0; }
  #roles-root .strategy-chip.temp-mid { background: rgba(0, 150, 136, 0.2); color: #009688; }
  #roles-root .strategy-chip.temp-low { background: rgba(33, 150, 243, 0.2); color: #2196f3; }
  #roles-root .strategy-chip.reasoning-auto { background: rgba(76, 175, 80, 0.2); color: #4caf50; }
  #roles-root .strategy-chip.reasoning-manual { background: rgba(255, 152, 0, 0.2); color: #ff9800; }
  #roles-root .strategy-chip.output-limit { background: rgba(158, 158, 158, 0.2); color: #9e9e9e; }

  /* ============ Components：版本号 ============ */
  #roles-root .card-version { font-size: var(--font-xs, 10px); color: var(--text-tertiary, #666); margin-top: var(--sp-1, 4px); }
`;
