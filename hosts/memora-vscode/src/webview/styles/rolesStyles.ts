/**
 * 角色子视图样式 — 紧凑堆叠布局
 *
 * 设计哲学（visual-design-philosopher）：
 *   - 先布局后样式：解决水平空间浪费问题
 *   - 三层分类法：一级直面（标题行）→ 次级信息（描述/标签）→ 专家挖掘（详情折叠）
 *
 * 布局结构：
 *   ┌─────────────────────────────────────────────┐
 *   │ [方] 方案设计师 [当前]              [带入对话] │  ← 顶部标题行（一级直面）
 *   ├─────────────────────────────────────────────┤
 *   │ 基于 memora 设计哲学...                       │  ← 描述（次级信息）
 *   │ [完整工具] [自动执行] [平衡]                  │  ← 标签（次级信息）
 *   ├─────────────────────────────────────────────┤
 *   │ ▸ 详情（折叠，默认隐藏）                      │  ← 专家挖掘
 *   └─────────────────────────────────────────────┘
 */
export const rolesStyles = `
  /* ============ Layout：面板骨架 ============ */
  #roles-root .header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px); padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4)); }
  #roles-root .header h2 { font-size: var(--font-lg, 14px); margin: 0; }
  #roles-root .stat-bar { font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6); margin-left: auto; }
  #roles-root #list { padding: var(--sp-3, 8px); }
  #roles-root .group-title { font-size: var(--font-xs, 10px); letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-secondary, #9aa0a6); margin: var(--sp-3, 8px) 0 var(--sp-1, 4px); }

  /* ============ Components：角色包卡片（紧凑堆叠） ============ */
  #roles-root .card {
    flex-direction: column;
    align-items: stretch;
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    gap: var(--sp-2, 6px);
  }

  /* 顶部标题行：图标 + 名称 + 当前标签 + 操作按钮 */
  #roles-root .card-header {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    width: 100%;
  }

  /* 卡片图标：首字块（紧凑尺寸） */
  #roles-root .role-icon {
    width: 24px;
    height: 24px;
    border-radius: var(--radius-sm, 4px);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-ai-avatar);
    color: var(--accent-foreground, #ffffff);
    font-size: var(--font-sm, 11px);
    font-weight: 600;
    flex-shrink: 0;
    user-select: none;
  }

  /* 角色名 */
  #roles-root .card-name {
    font-weight: 600;
    font-size: var(--font-md, 12px);
    flex-shrink: 0;
  }

  /* 激活徽章 */
  #roles-root .badge {
    font-size: var(--font-xs, 10px);
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--accent, #007acc);
    color: var(--accent-foreground, #ffffff);
    font-weight: 500;
    flex-shrink: 0;
  }

  /* 标题行右侧操作区 */
  #roles-root .card-actions {
    display: flex;
    gap: var(--sp-1, 4px);
    margin-left: auto;
    flex-shrink: 0;
  }

  /* ============ Components：卡片内容区 ============ */
  #roles-root .card-info {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1, 4px);
    min-width: 0;
    width: 100%;
  }

  /* 描述文字（单行截断，避免过长） */
  #roles-root .card-detail {
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  /* ============ Components：能力标签 chips（紧凑单行） ============ */
  #roles-root .cap-chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1, 3px);
  }

  /* ============ Components：策略指示器（紧凑单行） ============ */
  #roles-root .role-strategy {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1, 3px);
  }

  /* 策略标签（更小尺寸） */
  #roles-root .strategy-chip {
    font-size: var(--font-xs, 10px);
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--surface-hover, rgba(128,128,128,.1));
    color: var(--text-secondary, #9aa0a6);
    line-height: 1.4;
  }
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
  /* 兜底契约包定位 chip（与 badge-fallback 同灰色系，能力标签区） */
  #roles-root .strategy-chip.fallback { background: rgba(96, 125, 139, 0.2); color: #607d8b; }

  /* ============ Components：折叠详情区（专家挖掘） ============ */
  #roles-root .card-details {
    margin-top: var(--sp-1, 2px);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.15));
    padding-top: var(--sp-2, 6px);
  }
  #roles-root .card-details summary {
    font-size: var(--font-xs, 10px);
    color: var(--text-tertiary, #666);
    cursor: pointer;
    user-select: none;
    padding: 2px 0;
    outline: none;
  }
  #roles-root .card-details summary:hover {
    color: var(--text-secondary, #9aa0a6);
  }
  #roles-root .card-details summary::before {
    content: '▸';
    display: inline-block;
    margin-right: var(--sp-1, 4px);
    transition: transform 0.15s ease;
  }
  #roles-root .card-details[open] summary::before {
    transform: rotate(90deg);
  }
  #roles-root .details-content {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1, 4px);
    padding-top: var(--sp-1, 4px);
  }

  /* ============ Components：性格特征 (Traits) ============ */
  #roles-root .role-traits {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1, 3px);
  }
  #roles-root .trait {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
  }
  #roles-root .trait-label {
    font-size: var(--font-xs, 10px);
    color: var(--text-tertiary, #666);
    min-width: 28px;
  }
  #roles-root .trait-bar {
    flex: 1;
    height: 3px;
    background: var(--border-panel, rgba(128,128,128,.2));
    border-radius: 2px;
    overflow: hidden;
  }
  #roles-root .trait-fill {
    height: 100%;
    background: var(--accent, #007acc);
    border-radius: 2px;
    transition: width 0.3s ease;
  }

  /* ============ Components：小组会议区（v0.13 S7） ============ */
  #roles-root .badge-fallback { background: var(--text-tertiary, #666); }
  #roles-root .team-section {
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius-lg, 8px);
    padding: var(--sp-3, 8px);
    margin-bottom: var(--sp-4, 10px);
    background: var(--surface-sidebar);
  }
  #roles-root .team-header { display: flex; align-items: center; gap: var(--sp-2, 6px); margin-bottom: var(--sp-2, 6px); }
  #roles-root .team-title { font-weight: 600; font-size: var(--font-md, 12px); }
  #roles-root .team-hint { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
  #roles-root .team-empty { font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6); margin-bottom: var(--sp-2, 6px); line-height: 1.5; }
  #roles-root .team-card {
    display: flex; flex-direction: column; gap: var(--sp-1, 4px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.25));
    border-radius: var(--radius, 6px);
    padding: var(--sp-2, 6px);
    margin-bottom: var(--sp-2, 6px);
  }
  #roles-root .team-card-head { display: flex; align-items: center; justify-content: space-between; }
  #roles-root .team-leader { font-size: var(--font-sm, 11px); font-weight: 600; }
  #roles-root .team-del { padding: 1px var(--sp-2, 6px); font-size: var(--font-xs, 10px); }
  #roles-root .team-members { display: flex; flex-wrap: wrap; gap: var(--sp-1, 3px); }
  #roles-root .team-member-tag {
    font-size: var(--font-xs, 10px); padding: 1px 5px;
    background: rgba(156, 39, 176, 0.15); color: #9c27b0;
    border-radius: 3px;
  }
  #roles-root .team-member-role { font-size: var(--font-xs, 10px); color: var(--text-tertiary, #666); }
  #roles-root .team-create { margin-top: var(--sp-1, 2px); }
  #roles-root .team-form { display: flex; flex-direction: column; gap: var(--sp-2, 6px); margin-top: var(--sp-2, 6px); }
  #roles-root .team-form-row { display: flex; align-items: flex-start; gap: var(--sp-2, 6px); font-size: var(--font-sm, 11px); }
  #roles-root .team-select { flex: 1; min-width: 0; }
  #roles-root .team-members-pick { flex-direction: column; }
  #roles-root .team-pick-list { display: flex; flex-wrap: wrap; gap: var(--sp-1, 4px); max-height: 120px; overflow-y: auto; }
  #roles-root .team-pick-item { display: flex; align-items: center; gap: var(--sp-1, 4px); font-size: var(--font-xs, 10px); }
  #roles-root .team-form-actions { display: flex; justify-content: flex-end; }

  /* ============ Components：版本号 ============ */
  #roles-root .card-version {
    font-size: var(--font-xs, 10px);
    color: var(--text-tertiary, #666);
  }
`;
