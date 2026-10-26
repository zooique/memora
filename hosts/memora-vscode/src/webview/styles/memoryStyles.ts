/**
 * 记忆子视图样式（设置面板选项卡内）— 对齐 rolesStyles.ts 的卡片列表 + 搜索 + source 徽章
 *
 * 分层（对齐 ITCSS + tokens.ts 单一真理源）：
 *   - 设计令牌由 tokens.ts 单一真理源提供，经 settingsStyles.ts 统一内嵌，本文件不再内嵌；
 *   - 选择器统一以 `#memory-root` 前缀限定 —— 设置面板合并后三个子视图共存于同一文档，
 *     共享类名（.header / .empty-state 等）靠根容器前缀隔离，避免跨子视图样式串扰；
 *   - 分区：Layout（header / search / list）→ Components（card / source-badge / detail）；
 *   - source 徽章颜色约定：round-summary=accent，work-projection=灰色，
 *     未知 source 回退中性（开放字符串，不应穷举）。
 */
export const memoryStyles = `
  /* ============ Layout：面板骨架 ============ */
  #memory-root .header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px); padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: var(--line-solid); }
  #memory-root .header h2 { font-size: var(--font-lg, 14px); margin: 0; }
  #memory-root .stat-bar { font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6); margin-left: auto; }
  #memory-root #list { padding: var(--sp-3, 8px); }

  /* ============ Components：搜索框 ============ */
  #memory-root .search-wrap { padding: var(--sp-3, 8px); }
  #memory-root .search-input {
    width: 100%;
    box-sizing: border-box;
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    font-size: var(--font-md, 12px);
    color: var(--text-input, #cccccc);
    background: var(--surface-input, #3c3c3c);
    border: var(--line-input);
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
    border: var(--line-solid);
    border-radius: var(--radius, 6px);
    background: var(--surface-sidebar);
    cursor: pointer;
    transition: border-color var(--dur-fastest);
  }
  #memory-root .mem-card:hover { border-color: var(--text-secondary, #9aa0a6); }
  #memory-root .mem-card.expanded { border-color: var(--accent, #0e639c); }

  /* 卡片头部：source 徽章 + 类型徽章 + 操作按钮（name 已撤位，正文预览是卡片主位） */
  #memory-root .mem-card-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    margin-bottom: var(--sp-1, 4px);
  }

  /* source 徽章：已知 3 种预设来源有颜色约定，其余回退中性（开放字符串制动） */
  #memory-root .source-badge {
    display: inline-block;
    padding: 0 var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    flex-shrink: 0;
    background: var(--surface-code, rgba(127, 127, 127, 0.15));
    color: var(--text-secondary, #9aa0a6);
  }
  #memory-root .source-badge-round-summary { background: var(--accent, #0e639c); color: var(--accent-foreground, #ffffff); }
  #memory-root .source-badge-work-projection { background: var(--surface-card, #252526); color: var(--text-secondary, #9aa0a6); }

  /* 类型徽章：round-summary 子类型（SummaryType），与 source 徽章互补 */
  #memory-root .type-badge {
    display: inline-block;
    padding: 0 var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    flex-shrink: 0;
    background: var(--surface-code, rgba(127, 127, 127, 0.15));
    color: var(--text-secondary, #9aa0a6);
    border: 1px solid var(--surface-hover, rgba(128, 128, 128, 0.2));
  }

  /* 取代态 / 编辑态：round-summary 治理语义的视觉提示 */
  #memory-root .mem-card-superseded { border-style: dashed; border-color: var(--text-secondary, #9aa0a6); opacity: var(--op-8); }
  #memory-root .mem-card-modified { border-left: 3px solid var(--warn, #d7ba7d); }

  #memory-root .mem-card-tags { display: flex; gap: var(--sp-1, 4px); margin-top: var(--sp-1, 4px); flex-wrap: wrap; }
  #memory-root .tag {
    display: inline-block;
    padding: 0 var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    border-radius: var(--radius-pill, 999px);
    line-height: var(--lh-normal);
  }
  #memory-root .tag-superseded { background: var(--surface-hover, rgba(128,128,128,.2)); color: var(--text-secondary, #9aa0a6); }
  #memory-root .tag-modified { background: var(--feedback-warn-bg, rgba(196, 160, 0, 0.15)); color: var(--warn, #d7ba7d); }

  /* 内容预览：卡片主位（name 撤位后正文即标题——主色 + 字重 600，单行截断快速扫读） */
  #memory-root .mem-card-preview {
    font-size: var(--font-md, 12px);
    font-weight: 600;
    color: var(--text-primary, #cccccc);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 展开详情：全文 content + 元数据 */
  #memory-root .mem-card-detail {
    margin-top: var(--sp-2, 6px);
    padding-top: var(--sp-2, 6px);
    border-top: var(--line-solid);
    font-size: var(--font-sm, 11px);
    color: var(--text-primary, #cccccc);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: var(--lh-snug);
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

  /* ============ Components：记忆治理区 ============ */
  #memory-root .governance {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    border-top: var(--line-solid);
  }
  /* 统计卡：三列（活跃 / 回收站 / 已被取代） */
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
    border: var(--line-solid);
    border-radius: var(--radius, 6px);
    background: var(--surface-sidebar);
  }
  #memory-root .gov-num { font-size: var(--font-lg, 14px); font-weight: 600; color: var(--text-primary, #cccccc); }
  #memory-root .gov-label { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
  /* 操作按钮：清理过期（不可逆性强调） */
  #memory-root .governance-actions { display: flex; gap: var(--sp-2, 6px); }
  /* 政区按钮撑满等宽（布局性差异不混入通用 .btn 基类） */
  #memory-root .governance-actions .btn { flex: 1; }
  /* 结果提示：默认次要色，失败时错误色 */
  #memory-root .governance-detail {
    margin-top: var(--sp-2, 6px);
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
  }
  #memory-root .governance-detail.gov-error { color: var(--text-error, #f14c4c); }

  /* ============ Components：会话归档模式区 ============ */
  /* 与治理区同构：顶部分隔线 + 内边距；内部复用安全选项卡的 label/select/desc 组件类
     （security-label / security-select / security-desc 定义在 settingsStyles.ts，
      同文档打包进同一 webview，禁在此复制第二份） */
  #memory-root .archive-mode {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    border-top: var(--line-solid);
  }
  #memory-root .archive-mode-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3, 8px);
    margin-bottom: var(--sp-2, 6px);
  }
  #memory-root .archive-mode-item .security-select { flex-shrink: 0; }

  /* ============ Components：单条删除 / 回收站 ============ */
  /* 卡片头部删除按钮：低扰，hover 才显形，避免与展开区抢视觉、不与「清理过期」红色危险按钮撞色 */
  #memory-root .mem-del-btn {
    flex-shrink: 0;
    width: var(--sq-sm, 18px); height: var(--sq-sm, 18px);
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0;
    margin-left: var(--sp-1, 4px);
    border: none;
    border-radius: var(--radius-pill, 999px);
    background: transparent;
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-md, 12px);
    line-height: var(--lh-flat);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--dur-fastest), background var(--dur-fastest), color var(--dur-fastest);
  }
  #memory-root .mem-card:hover .mem-del-btn,
  #memory-root .mem-del-btn:focus-visible { opacity: 1; }
  #memory-root .mem-del-btn:hover { background: var(--btn-danger-bg); color: var(--accent-foreground, #ffffff); }
  #memory-root .mem-del-btn:focus-visible { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 1px; }

  /* 卡片头部编辑按钮：低扰，hover 才显形，与删除按钮同视觉重量（编辑=中性、删除=danger 拉开强度差） */
  #memory-root .mem-edit-btn {
    flex-shrink: 0;
    width: var(--sq-sm, 18px); height: var(--sq-sm, 18px);
    display: inline-flex; align-items: center; justify-content: center;
    padding: 0;
    margin-left: var(--sp-1, 4px);
    border: none;
    border-radius: var(--radius-pill, 999px);
    background: transparent;
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-md, 12px);
    line-height: var(--lh-flat);
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--dur-fastest), background var(--dur-fastest), color var(--dur-fastest);
  }
  #memory-root .mem-card:hover .mem-edit-btn,
  #memory-root .mem-edit-btn:focus-visible { opacity: 1; }
  #memory-root .mem-edit-btn:hover { background: var(--surface-hover, rgba(128,128,128,.2)); color: var(--text-primary, #cccccc); }
  #memory-root .mem-edit-btn:focus-visible { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 1px; }
  /* 卡片头按钮图标（SVG）：
   * 按钮本身已是 inline-flex + center，此处只需消除 svg 的 inline 基线间隙 */
  #memory-root .mem-del-btn svg,
  #memory-root .mem-edit-btn svg { display: block; }

  /* 内联编辑区：textarea + 操作按钮 */
  #memory-root .mem-edit-wrap {
    margin-top: var(--sp-2, 6px);
    padding-top: var(--sp-2, 6px);
    border-top: var(--line-solid);
  }
  #memory-root .mem-edit-area {
    width: 100%;
    box-sizing: border-box;
    min-height: 72px;
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    font-size: var(--font-sm, 11px);
    font-family: inherit;
    line-height: var(--lh-snug);
    color: var(--text-input, #cccccc);
    background: var(--surface-input, #3c3c3c);
    border: var(--line-input);
    border-radius: var(--radius, 6px);
    outline: none;
    resize: vertical;
    white-space: pre-wrap;
    word-break: break-word;
  }
  #memory-root .mem-edit-area:focus { border-color: var(--border-focus, #0e639c); }
  #memory-root .mem-edit-actions { display: flex; gap: var(--sp-2, 6px); margin-top: var(--sp-2, 6px); }
  #memory-root .mem-edit-actions .btn { flex: 0 0 auto; }

  /* 回收站：可折叠分区，与治理区同视觉重量 */
  #memory-root .recycle {
    margin: var(--sp-3, 8px) 0 0;
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    border-top: var(--line-solid);
  }
  #memory-root .recycle > summary {
    cursor: pointer;
    font-size: var(--font-md, 12px);
    color: var(--text-primary, #cccccc);
    user-select: none;
  }
  #memory-root .recycle > summary::-webkit-details-marker { color: var(--text-secondary, #9aa0a6); }
  #memory-root .recycle > summary::marker { color: var(--text-secondary, #9aa0a6); }
  #memory-root #recycleList { padding: var(--sp-2, 6px) 0; }

  /* 回收站条目：复用卡片外观，强调「可恢复」 */
  #memory-root .mem-recycle-card {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    margin-bottom: var(--sp-2, 6px);
    border: var(--line-solid);
    border-radius: var(--radius, 6px);
    background: var(--surface-sidebar);
  }
  #memory-root .mem-recycle-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: var(--sp-1, 4px);
  }
  #memory-root .mem-recycle-meta { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
  #memory-root .mem-restore-btn {
    flex-shrink: 0;
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    border: none;
    border-radius: var(--radius, 6px);
    cursor: pointer;
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-fg);
    font-size: var(--font-sm, 11px);
  }
  /* 回收站条目「永久删除」按钮：危险色，与「恢复」并排、间距对齐 */
  #memory-root .mem-purge-btn {
    flex-shrink: 0;
    margin-left: var(--sp-2, 6px);
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    border: none;
    border-radius: var(--radius, 6px);
    cursor: pointer;
    font-size: var(--font-sm, 11px);
  }
  /* 回收站操作行：清空回收站按钮右对齐，置于条目之上 */
  #memory-root .mem-recycle-tools {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--sp-2, 6px);
  }
  #memory-root .mem-recycle-tools .mem-recycle-clear {
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    border: none;
    border-radius: var(--radius, 6px);
    cursor: pointer;
    font-size: var(--font-sm, 11px);
  }

  /* 删除 / 恢复结果反馈（无状态机，纯占位修饰） */
  #memory-root .mem-hint {
    margin: var(--sp-2, 6px) 0 0;
    padding: var(--sp-2, 6px) var(--sp-5, 12px);
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
  }
  #memory-root .mem-hint.mem-hint-error { color: var(--text-error, #f14c4c); }

  /* 记忆诊断区样式已退役，勿再加：诊断粒度无终端用户场景，内核治理机制自动跑 */
`;
