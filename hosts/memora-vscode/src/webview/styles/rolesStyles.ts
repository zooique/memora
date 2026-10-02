/**
 * 角色子视图样式 — 紧凑堆叠布局
 *
 * 设计哲学（visual-design-philosopher）：
 *   - 先布局后样式：解决水平空间浪费问题
 *   - 三层分类法：一级直面（标题行）→ 次级信息（描述/标签）→ 专家挖掘（详情折叠）
 *
 * 布局结构：
 *   ┌─────────────────────────────────────────────┐
 *   │ [白] 白话方案设计师 [当前]        [带入对话] │  ← 顶部标题行（一级直面）
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
  #roles-root .strategy-chip.temp-high { background: rgba(156, 39, 176, 0.2); color: #9c27b0; }
  #roles-root .strategy-chip.temp-mid { background: rgba(0, 150, 136, 0.2); color: #009688; }
  #roles-root .strategy-chip.temp-low { background: rgba(33, 150, 243, 0.2); color: #2196f3; }
  #roles-root .strategy-chip.reasoning-auto { background: rgba(76, 175, 80, 0.2); color: #4caf50; }
  #roles-root .strategy-chip.reasoning-manual { background: rgba(255, 152, 0, 0.2); color: #ff9800; }
  #roles-root .strategy-chip.output-limit { background: rgba(158, 158, 158, 0.2); color: #9e9e9e; }
  /* 兜底契约包定位 chip（能力标签区，灰色系） */
  #roles-root .strategy-chip.fallback { background: rgba(96, 125, 139, 0.2); color: #607d8b; }

  /* ============ Components：健康区（manifest 校验问题，镜像技能 health-badge 模式） ============ */
  /* 徽章样式：复制技能侧 #skills-root .health-badge 形态，但用 #roles-root 作用域——避免把技能
     样式类改造成跨场景共享（SSOT：各视图自持作用域类，视觉 token 复用 tokens.ts 的 --skill-health-*） */
  #roles-root .role-health {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-2, 6px);
    margin: var(--sp-2, 6px) 0;
    padding: var(--sp-2, 6px);
    border: 1px solid var(--border, rgba(128,128,128,.25));
    border-radius: var(--radius-md, 6px);
    background: var(--surface, rgba(0,0,0,.06));
  }
  #roles-root .role-health-badge {
    font-size: var(--font-xs, 10px);
    font-weight: 600;
    padding: 2px 6px;
    border-radius: var(--radius-pill, 999px);
    flex-shrink: 0;
  }
  #roles-root .role-health-badge.health-error {
    color: var(--accent-foreground, #ffffff);
    background: var(--skill-health-error);
  }
  #roles-root .role-health-badge.health-warn {
    color: var(--skill-health-warn);
    background: var(--surface-hover, rgba(128,128,128,.2));
  }
  #roles-root .role-problems {
    margin: 0;
    padding-left: 16px;
    list-style: disc;
    font-size: var(--font-xs, 10px);
  }
  #roles-root .role-problems .prob-error { color: var(--skill-health-error); }
  #roles-root .role-problems .prob-warning { color: var(--skill-health-warn); }

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

  /* ============ Components：卡片级组队 ============ */
  /* 小组条：卡片底部队伍阵容 + 创建/编辑队伍入口 */
  #roles-root .team-ribbon {
    display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.2));
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.2));
    padding: var(--sp-2, 6px) 0;
    margin: var(--sp-1, 2px) var(--sp-3, 8px) 0;
  }
  #roles-root .team-ribbon-label {
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
  }
  #roles-root .team-ribbon-btn { padding: 1px var(--sp-2, 6px); font-size: var(--font-xs, 10px); flex-shrink: 0; }
  /* 组员标注（卡片信息区） */
  #roles-root .team-member-role { font-size: var(--font-xs, 10px); color: var(--text-tertiary, #666); }
  /* 组队弹窗：遮罩 + 电话本式多选 + 反馈区 */
  #roles-root .team-modal-overlay {
    position: fixed; inset: 0; z-index: 1000;
    background: var(--overlay-mask);
    display: flex; align-items: center; justify-content: center;
    animation: roles-fade-in 0.15s ease;
  }
  #roles-root .team-modal {
    background: var(--surface-sidebar);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius-lg, 8px);
    box-shadow: var(--shadow-modal, 0 4px 16px rgba(0, 0, 0, 0.3));
    padding: var(--sp-3, 8px);
    width: min(360px, calc(100vw - 48px));
    max-height: 80vh; display: flex; flex-direction: column;
  }
  #roles-root .team-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--sp-2, 6px); }
  #roles-root .team-modal-title { font-weight: 600; font-size: var(--font-md, 12px); }
  #roles-root .team-modal-close { display: inline-flex; align-items: center; justify-content: center; padding: 0 4px; }
  /* 关闭图标（SVG）：按钮为纯图标容器，不设 text 字号定义 */
  #roles-root .team-modal-close svg { display: block; }
  #roles-root .team-modal-list { display: flex; flex-direction: column; gap: var(--sp-1, 3px); overflow-y: auto; min-height: 60px; }
  #roles-root .team-modal-item {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    font-size: var(--font-sm, 11px);
    padding: var(--sp-1, 4px);
    border-radius: var(--radius, 6px);
    cursor: pointer;
  }
  #roles-root .team-modal-item:hover { background: rgba(128,128,128,.08); }
  #roles-root .team-modal-item.checked { background: rgba(156, 39, 176, 0.12); }
  #roles-root .team-modal-hint { font-size: var(--font-xs, 10px); color: var(--text-tertiary, #666); margin: var(--sp-2, 6px) 0; }
  #roles-root .team-modal-actions { display: flex; justify-content: flex-end; gap: var(--sp-2, 6px); }
  #roles-root .team-modal-actions .btn { padding: 2px var(--sp-2, 6px); font-size: var(--font-xs, 10px); }
  #roles-root .team-modal-del { margin-right: auto; }
  @media (prefers-reduced-motion: reduce) {
    #roles-root .team-modal-overlay { animation: none; }
  }
  @keyframes roles-fade-in { from { opacity: 0; } to { opacity: 1; } }

  /* ============ Components：角色配置详情弹窗（RP-EDIT-1） ============ */
  /* 复用 team-modal 遮罩/框架 token，仅扩内容形态：查看行 / 编辑表单行 / 键面宽度 */
  #roles-root .team-modal.role-detail { width: min(480px, calc(100vw - 48px)); }
  #roles-root .role-detail-body { overflow-y: auto; min-height: 60px; font-size: var(--font-sm, 11px); padding: var(--sp-1, 4px) 0; }
  /* 阶段组头（回答前/回答中/回答后/全局） */
  #roles-root .role-detail-stage { font-weight: 600; font-size: var(--font-xs, 10px); color: var(--text-tertiary, #666); margin: var(--sp-2, 6px) 0 var(--sp-1, 3px); }
  /* 查看模式行：标签 + 值（title 悬停含义） */
  #roles-root .role-detail-row { display: flex; gap: var(--sp-2, 6px); padding: var(--sp-1, 4px); border-radius: var(--radius, 6px); }
  #roles-root .role-detail-row:hover { background: rgba(128,128,128,.08); }
  #roles-root .role-detail-label { color: var(--text-tertiary, #666); flex-shrink: 0; min-width: 96px; }
  #roles-root .role-detail-value { word-break: break-all; }
  /* 编辑模式行：标签 + 控件 */
  #roles-root .role-detail-form-row { display: flex; align-items: center; gap: var(--sp-2, 6px); padding: 2px var(--sp-1, 4px); }
  #roles-root .role-detail-form-row > .role-detail-label { align-self: start; padding-top: 3px; }
  #roles-root .role-detail-form-row input[type='number'],
  #roles-root .role-detail-form-row input[type='text'],
  #roles-root .role-detail-form-row select {
    flex: 1; min-width: 0;
    padding: 2px var(--sp-1, 4px);
    font-size: var(--font-sm, 11px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius, 6px);
    background: var(--surface-input, rgba(128,128,128,.1));
    color: inherit;
  }
  /* 数值键实时检测：超出键面 range（input[min]/max，与内核同源）即红框即时反馈。
     纯 CSS 消费既有属性零 JS；留空 = 用默认值（合法语义，:out-of-range 不命中空值）。
     失效前提是键面 range 缺失——由 rolesKeyface 守卫锁死（number 键必须带 range）。 */
  #roles-root .role-detail-form-row input[type='number']:out-of-range {
    border-color: var(--status-fail, #b3261e);
  }
  /* 多选（askOn）：checkbox 组横排换行 */
  #roles-root .role-detail-multi { display: flex; flex-wrap: wrap; gap: var(--sp-1, 3px) var(--sp-2, 6px); flex: 1; min-width: 0; }
  #roles-root .role-detail-check { display: inline-flex; align-items: center; gap: var(--sp-1, 3px); cursor: pointer; }
  /* 内置包只读提示：占位行左对齐（actions 行内 margin-right:auto 推按钮组靠右） */
  #roles-root .role-detail-readonly-hint { margin-right: auto; margin: 0; }
  /* 卡片可点击光标（点卡片空白区打开配置详情） */
  #roles-root .roles-card-clickable { cursor: pointer; }

  /* ============ Components：版本号 ============ */
  #roles-root .card-version {
    font-size: var(--font-xs, 10px);
    color: var(--text-tertiary, #666);
  }
`;
