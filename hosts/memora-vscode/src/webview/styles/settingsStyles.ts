/**
 * 设置视图样式 — 聚合 角色 / 大模型 / 记忆 / 技能 四个子视图 + 选项卡栏（2026-08-22 新增技能选项卡）
 *
 * 设计（对齐 ITCSS + tokens.ts 单一真理源）：
 *   - 设计令牌由 tokens.ts 单一真理源提供，本文件内嵌一次，四个子视图样式不再各自内嵌；
 *   - 共享的 body 基础规则在本文件定义（四个子视图原有的 body 规则收敛于此，消除重复）；
 *   - 子视图样式（rolesStyles / configStyles / memoryStyles / skillsStyles）各自以 #roles-root / #config-root /
 *     #memory-root / #skills-root 前缀限定，与选项卡栏共享类名（.header 等）靠根容器前缀隔离，避免串扰；
 *   - 选项卡栏：等宽按钮 + 激活态 accent 高亮，低扰不抢内容层级。
 */
import { tokens } from './tokens.js';
import { rolesStyles } from './rolesStyles.js';
import { configStyles } from './configStyles.js';
import { memoryStyles } from './memoryStyles.js';
import { skillsStyles } from './skillsStyles.js';

export const settingsStyles = `
  ${tokens}

  /* ============ Base：元素级基础（四个子视图原 body 规则收敛于此） ============ */
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; box-sizing: border-box;
    font-size: var(--font-base, 13px);
    color: var(--text-primary, #cccccc);
    background: var(--surface-page, #1e1e1e);
  }

  /* ============ Components：选项卡栏 ============ */
  .tabs {
    display: flex;
    gap: var(--sp-1, 4px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
    background: var(--surface-sidebar);
  }
  .tab-btn {
    flex: 1;
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    font-size: var(--font-md, 12px);
    color: var(--text-secondary, #9aa0a6);
    background: transparent;
    border: none;
    border-radius: var(--radius, 6px);
    cursor: pointer;
    white-space: nowrap;
  }
  .tab-btn:hover { background: var(--surface-hover, rgba(128,128,128,.2)); }
  .tab-btn.active {
    color: var(--accent-foreground, #ffffff);
    background: var(--accent, #0e639c);
  }
  .tab-btn:focus-visible { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 2px; }

  /* ============ Components：通用按钮变体（SSOT 收敛，2026-08-25） ============
   * 设置面板按钮形态单一真理源：primary / secondary / danger / ghost 四种变体。
   * 取代原 roles/config/memory 三处重复的 .btn 基类（不一致即 SSOT 违规），并补齐 skills/security 缺失。
   * ITCSS 分层：变体=class 层；布局性差异（如 memory 政区按钮 flex:1）由具体子视图覆盖，不混入基类。 */
  #roles-root .btn, #config-root .btn, #memory-root .btn, #skills-root .btn, #security-root .btn {
    padding: var(--sp-2, 6px) var(--sp-5, 12px);
    border-radius: var(--radius, 6px);
    border: none;
    cursor: pointer;
    background: var(--accent, #0e639c);
    color: var(--accent-foreground, #ffffff);
    font-size: var(--font-md, 12px);
  }
  #roles-root .btn-secondary, #config-root .btn-secondary, #memory-root .btn-secondary, #skills-root .btn-secondary, #security-root .btn-secondary {
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-fg);
  }
  #roles-root .btn-danger, #config-root .btn-danger, #memory-root .btn-danger, #skills-root .btn-danger, #security-root .btn-danger {
    background: var(--btn-danger-bg);
    color: var(--accent-foreground, #ffffff);
  }
  #roles-root .btn:disabled, #config-root .btn:disabled, #memory-root .btn:disabled, #skills-root .btn:disabled, #security-root .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  #roles-root .btn:focus-visible, #config-root .btn:focus-visible, #memory-root .btn:focus-visible, #skills-root .btn:focus-visible,
  #security-root .btn:focus-visible {
    outline: 2px solid var(--border-focus, #0e639c);
    outline-offset: 2px;
  }
  #roles-root .btn-ghost, #config-root .btn-ghost, #memory-root .btn-ghost, #skills-root .btn-ghost, #security-root .btn-ghost {
    background: var(--btn-secondary-bg);
    color: var(--btn-secondary-fg);
    padding: var(--sp-2, 6px) var(--sp-5, 12px);
    font-size: var(--font-md, 12px);
  }
  #roles-root .btn-ghost:hover, #config-root .btn-ghost:hover, #memory-root .btn-ghost:hover, #skills-root .btn-ghost:hover, #security-root .btn-ghost:hover {
    background: var(--vscode-list-hoverBackground, rgba(128,128,128,.3));
    color: var(--text-primary, #cccccc);
  }

  /* ============ Components：通用卡片/徽章/空态/chip（SSOT 收敛，2026-08-25） ============
   * 收敛 roles/config/memory/skills 重复定义（与按钮同理上提为单一真理源）。
   * 布局/对齐差异由各子视图 context 覆盖，不混入基类。 */
  #roles-root .card, #config-root .card, #memory-root .card, #skills-root .card, #security-root .card {
    display: flex;
    gap: var(--sp-3, 8px);
    padding: var(--sp-4, 10px);
    margin-bottom: var(--sp-3, 8px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius-lg, 8px);
    background: var(--surface-sidebar);
  }
  #roles-root .card.active, #config-root .card.active, #memory-root .card.active, #skills-root .card.active, #security-root .card.active {
    border-color: var(--accent, #0e639c);
  }
  #roles-root .badge, #config-root .badge {
    font-size: var(--font-sm, 11px);
    padding: 1px var(--sp-2, 6px);
    border-radius: var(--radius-pill, 999px);
    background: var(--accent, #0e639c);
    color: var(--accent-foreground, #ffffff);
    margin-left: var(--sp-1, 4px);
  }
  /* 用户角色包来源徽章（2026-08-30）：区别于激活「当前」徽章（accent 蓝），用户来源用中性格调 */
  #roles-root .badge.badge-source-user {
    background: var(--vscode-tag-background, rgba(90, 93, 94, 0.31));
    color: var(--vscode-tag-foreground, #cccccc);
  }
  /* 角色区头部操作组（「打开目录」按钮，2026-08-30 对齐技能区 header-actions） */
  #roles-root .header-actions {
    display: flex;
    gap: var(--sp-2, 6px);
  }
  #roles-root .btn-icon-text {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1, 4px);
  }
  #roles-root .btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: currentColor;
  }
  #roles-root .empty-state, #memory-root .empty-state, #config-root .empty-state {
    text-align: center;
    padding: var(--sp-8, 24px) var(--sp-5, 12px);
    color: var(--text-secondary, #9aa0a6);
  }
  #roles-root .empty-title, #memory-root .empty-title, #config-root .empty-title {
    font-size: var(--font-lg, 14px);
    font-weight: 600;
    color: var(--text-primary, #cccccc);
    margin-bottom: var(--sp-2, 6px);
  }
  #roles-root .empty-hint, #memory-root .empty-hint, #config-root .empty-hint {
    font-size: var(--font-md, 12px);
  }
  /* Chip：小胶囊标签（cap-chip 形态；技能 keyword-chip 已随关键词命中系统移除） */
  #roles-root .cap-chip {
    display: inline-block;
    padding: 1px var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-hover, rgba(128,128,128,.2));
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    user-select: none;
  }
  /* Hint：居中占位提示（roles/memory/config 收敛；skills 为带 code 的说明文字、语义不同故保留） */
  #roles-root .hint, #memory-root .hint, #config-root .hint {
    text-align: center;
    color: var(--text-secondary, #9aa0a6);
    padding: var(--sp-6, 16px);
    font-size: var(--font-md, 12px);
  }
  /* FooterHint：列表底部说明脚注（roles/memory 收敛） */
  #roles-root .footer-hint, #memory-root .footer-hint {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
    text-align: center;
  }

  /* ============ Utilities：加载态指示器（P1，2026-08-24 状态四态补齐） ============ */
  /* 与空态 .hint 区分：带旋转 spinner 图标 + 左侧细边框，让用户一眼识别「在加载」而非「无数据」 */
  .loading-hint {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    border-left: 2px solid var(--accent, #0e639c);
    background: var(--feedback-info-bg);
    border-radius: 0 var(--radius, 6px) var(--radius, 6px) 0;
    margin: 0;
  }
  .loading-hint::before {
    content: '';
    display: inline-block;
    width: 12px; height: 12px;
    border: 1.5px solid var(--border-panel, rgba(128,128,128,.4));
    border-top-color: var(--accent, #0e639c);
    border-radius: 50%;
    animation: loadingSpin 0.8s linear infinite;
    flex-shrink: 0;
  }
  @keyframes loadingSpin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .loading-hint::before { animation: none; }
  }

  ${rolesStyles}
  ${configStyles}
  ${memoryStyles}
  ${skillsStyles}

  /* ============ Security：安全子视图（H0 写入审批） ============ */
  #security-root { padding: var(--sp-3, 8px); }
  .security-section { margin-top: var(--sp-3, 8px); }
  .security-item {
    /* A 类卡片外壳语言对齐（SSOT）：与记忆/技能/角色卡一致——surface-sidebar + border .4 +
       margin-bottom 间距（skillsStyles:66 曾统一此壳，security 沿用半旧 surface-hover 漏同步，2026-09-08 收敛） */
    padding: var(--sp-3, 8px) var(--sp-4, 12px);
    margin-bottom: var(--sp-2, 6px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius, 6px);
    background: var(--surface-sidebar);
  }
  .security-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--sp-2, 6px);
  }
  .security-label { font-size: var(--font-md, 12px); font-weight: 600; color: var(--text-primary); }
  .security-desc { font-size: var(--font-sm, 11px); color: var(--text-secondary); margin: 0; line-height: 1.5; }
  .security-status { margin-top: var(--sp-2, 6px); font-size: var(--font-sm, 11px); color: var(--text-secondary); }

  /* 白名单额外路径（G8） */
  .allowed-paths-list { list-style: none; margin: var(--sp-2, 6px) 0 0; padding: 0; }
  .allowed-path-row {
    display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px);
    padding: var(--sp-1, 4px) var(--sp-2, 6px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.3));
    border-radius: var(--radius-sm, 4px);
    margin-bottom: var(--sp-1, 4px);
    background: var(--surface-sidebar, rgba(128,128,128,.06));
  }
  .allowed-path-base { color: var(--text-secondary); font-style: italic; }
  .allowed-path-text { font-size: var(--font-sm, 11px); color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .allowed-path-tag { font-size: var(--font-xs, 10px); color: var(--text-secondary); flex-shrink: 0; margin-left: var(--sp-2, 6px); }
  /* 移除按钮：行内图标操作复用 .btn-ghost 基类；hover 保留危险红（语义差异 context 覆盖，SSOT 收敛 2026-08-25） */
  .allowed-path-remove { flex-shrink: 0; }
  .allowed-path-remove:hover { color: var(--text-error, #f14c4c); border-color: var(--text-error, #f14c4c); }
  .allowed-paths-add { display: flex; gap: var(--sp-2, 6px); margin-top: var(--sp-2, 6px); }
  .allowed-paths-input {
    flex: 1; min-width: 0; padding: var(--sp-1, 4px) var(--sp-2, 6px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4)); border-radius: var(--radius-sm, 4px);
    background: var(--surface-input, rgba(255,255,255,.04)); color: var(--text-primary); font-size: var(--font-sm, 11px);
  }
  /* 网页搜索引擎下拉（方案 A 2026-09-02）：与路径输入同视觉语言 */
  .security-select {
    margin-top: var(--sp-2, 6px); padding: var(--sp-1, 4px) var(--sp-2, 6px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4)); border-radius: var(--radius-sm, 4px);
    background: var(--surface-input, rgba(255,255,255,.04)); color: var(--text-primary); font-size: var(--font-sm, 11px);
    max-width: 280px;
  }
  .security-select option { background: var(--surface-panel, #1e1e1e); }

  /* Toggle Switch（写入二次确认开关） */
  .toggle-switch { position: relative; display: inline-block; width: 40px; height: 22px; }
  .toggle-switch input { opacity: 0; width: 0; height: 0; }
  .toggle-slider {
    position: absolute; cursor: pointer; inset: 0;
    background-color: var(--border-panel, rgba(128,128,128,.4));
    transition: .2s; border-radius: 22px;
  }
  .toggle-slider:before {
    position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px;
    background-color: white; transition: .2s; border-radius: 50%;
  }
  .toggle-switch input:checked + .toggle-slider { background-color: var(--accent, #0e639c); }
  .toggle-switch input:checked + .toggle-slider:before { transform: translateX(18px); }
  .toggle-switch input:focus-visible + .toggle-slider { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 2px; }

  /* ============ Pager：通用分页条（2026-09-08，记忆/技能/角色包三子视图共用） ============
     组件自含 DOM + 单页自动隐藏（小数据量不暴露无意义分页 UI）；按钮禁用态灰化。 */
  .pager-bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-3, 8px);
    margin: var(--sp-3, 8px) 0;
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
  }
  .pager-btn {
    font-size: var(--font-sm, 11px);
    padding: var(--sp-1, 3px) var(--sp-3, 8px);
    border-radius: var(--radius-sm, 4px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    background: var(--surface-hover, rgba(128,128,128,.12));
    color: var(--text-primary, #cccccc);
    cursor: pointer;
  }
  .pager-btn:hover:not(:disabled) { background: var(--surface-active, rgba(128,128,128,.24)); }
  .pager-btn:disabled { opacity: .4; cursor: default; }
  .pager-btn:focus-visible { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 1px; }
  .pager-info { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
`;
