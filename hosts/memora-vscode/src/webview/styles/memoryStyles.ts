/**
 * 记忆子视图样式（设置视图选项卡内）— 对齐 rolesStyles.ts 的卡片列表 + 搜索 + source 徽章
 *
 * 分层（对齐 ITCSS + tokens.ts 单一真理源）：
 *   - 设计令牌由 tokens.ts 单一真理源提供，经 settingsStyles.ts 统一内嵌，本文件不再内嵌；
 *   - 选择器统一以 `#memory-root` 前缀限定 —— 设置视图合并后三个子视图共存于同一文档，
 *     共享类名（.header / .empty-state 等）靠根容器前缀隔离，避免跨子视图样式串扰；
 *   - 分区：Layout（header / search / list）→ Components（card / source-badge / detail）；
 *   - source 徽章颜色约定：round-summary=accent，profile=中性，work-projection=灰色，
 *     未知 source 回退中性（开放字符串，不应穷举）。
 */
export const memoryStyles = `
  /* ============ Layout：面板骨架 ============ */
  #memory-root .header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px); padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4)); }
  #memory-root .header h2 { font-size: var(--font-lg, 14px); margin: 0; }
  #memory-root .stat-bar { font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6); margin-left: auto; }
  #memory-root #list { padding: var(--sp-3, 8px); }
  #memory-root .hint { text-align: center; color: var(--text-secondary, #9aa0a6); padding: var(--sp-6, 16px); font-size: var(--font-md, 12px); }
  #memory-root .empty-state { text-align: center; padding: var(--sp-8, 24px) var(--sp-5, 12px); color: var(--text-secondary, #9aa0a6); }
  #memory-root .empty-title { font-size: var(--font-lg, 14px); font-weight: 600; color: var(--text-primary, #cccccc); margin-bottom: var(--sp-2, 6px); }
  #memory-root .empty-hint { font-size: var(--font-md, 12px); }
  #memory-root .footer-hint {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
    text-align: center;
  }

  /* ============ Components：搜索框 ============ */
  #memory-root .search-wrap { padding: var(--sp-3, 8px); }
  #memory-root .search-input {
    width: 100%;
    box-sizing: border-box;
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    font-size: var(--font-md, 12px);
    color: var(--text-input, #cccccc);
    background: var(--surface-input, #3c3c3c);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    border-radius: var(--radius, 6px);
    outline: none;
  }
  #memory-root .search-input:focus {
    border-color: var(--border-focus, #0e639c);
  }
  #memory-root .search-input::placeholder { color: var(--text-secondary, #9aa0a6); }

  /* ============ Components：记忆条目卡片 ============ */
  #memory-root .mem-card {
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    margin-bottom: var(--sp-2, 6px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius, 6px);
    background: var(--surface-sidebar);
    cursor: pointer;
    transition: border-color 0.1s;
  }
  #memory-root .mem-card:hover { border-color: var(--text-secondary, #9aa0a6); }
  #memory-root .mem-card.expanded { border-color: var(--accent, #0e639c); }

  /* 卡片头部：名称 + source 徽章 + score */
  #memory-root .mem-card-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    margin-bottom: var(--sp-1, 4px);
  }
  #memory-root .mem-card-name {
    font-weight: 600;
    font-size: var(--font-md, 12px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1;
  }

  /* source 徽章：已知 3 种预设来源有颜色约定，其余回退中性（开放字符串制动） */
  #memory-root .source-badge {
    display: inline-block;
    padding: 0 var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    flex-shrink: 0;
    background: var(--surface-code, rgba(128,128,128,.12));
    color: var(--text-secondary, #9aa0a6);
  }
  #memory-root .source-badge-round-summary { background: var(--accent, #0e639c); color: var(--accent-foreground, #ffffff); }
  #memory-root .source-badge-profile { background: var(--surface-hover, rgba(128,128,128,.2)); color: var(--text-primary, #cccccc); }
  #memory-root .source-badge-work-projection { background: var(--surface-card, #252526); color: var(--text-secondary, #9aa0a6); }

  /* score 点：圆点指示记忆权重（越高越实心） */
  #memory-root .score-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-secondary, #9aa0a6);
  }
  #memory-root .score-dot-high { background: var(--accent, #0e639c); }

  /* 内容预览：单行截断，供快速扫读 */
  #memory-root .mem-card-preview {
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 展开详情：全文 content + 元数据 */
  #memory-root .mem-card-detail {
    margin-top: var(--sp-2, 6px);
    padding-top: var(--sp-2, 6px);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
    font-size: var(--font-sm, 11px);
    color: var(--text-primary, #cccccc);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }
  #memory-root .mem-card-meta {
    margin-top: var(--sp-1, 4px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
  }

  /* ============ Components：搜索模式特定 ============ */
  #memory-root .search-summary {
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
  }

  /* ============ Components：记忆治理区（G4，2026-08-23） ============ */
  #memory-root .governance {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
  }
  /* 统计卡：三列（活跃 / 回收站 / 衰减次数） */
  #memory-root .governance-stats {
    display: flex;
    gap: var(--sp-3, 8px);
    margin-bottom: var(--sp-3, 8px);
  }
  #memory-root .governance-stat {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-1, 4px);
    padding: var(--sp-3, 8px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius, 6px);
    background: var(--surface-sidebar);
  }
  #memory-root .gov-num { font-size: var(--font-lg, 14px); font-weight: 600; color: var(--text-primary, #cccccc); }
  #memory-root .gov-label { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
  /* 操作按钮：衰减（低扰次按钮）+ 清理（强调不可逆性） */
  #memory-root .governance-actions { display: flex; gap: var(--sp-2, 6px); }
  #memory-root .btn {
    flex: 1;
    padding: var(--sp-2, 6px) var(--sp-5, 12px);
    border-radius: var(--radius, 6px);
    border: none;
    cursor: pointer;
    background: var(--accent, #0e639c);
    color: var(--accent-foreground, #ffffff);
    font-size: var(--font-md, 12px);
  }
  #memory-root .btn-secondary { background: var(--btn-secondary-bg); color: var(--btn-secondary-fg); }
  #memory-root .btn:focus-visible { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 2px; }
  /* 结果提示：默认次要色，失败时错误色 */
  #memory-root .governance-detail {
    margin-top: var(--sp-2, 6px);
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
  }
  #memory-root .governance-detail.gov-error { color: var(--vscode-errorForeground, #f48771); }
`;
