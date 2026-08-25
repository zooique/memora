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
    padding: var(--sp-3, 8px) var(--sp-4, 12px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius, 6px);
    background: var(--surface-hover, rgba(128,128,128,.1));
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
  .allowed-path-remove {
    flex-shrink: 0; cursor: pointer; border: none; background: transparent;
    color: var(--text-secondary); font-size: var(--font-md, 12px); line-height: 1; padding: 2px 6px; border-radius: 4px;
  }
  .allowed-path-remove:hover { background: var(--surface-hover, rgba(128,128,128,.2)); color: var(--text-error, #f14c4c); }
  .allowed-paths-add { display: flex; gap: var(--sp-2, 6px); margin-top: var(--sp-2, 6px); }
  .allowed-paths-input {
    flex: 1; min-width: 0; padding: var(--sp-1, 4px) var(--sp-2, 6px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4)); border-radius: var(--radius-sm, 4px);
    background: var(--surface-input, rgba(255,255,255,.04)); color: var(--text-primary); font-size: var(--font-sm, 11px);
  }
  .allowed-paths-add-btn {
    flex-shrink: 0; cursor: pointer; padding: var(--sp-1, 4px) var(--sp-3, 10px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4)); border-radius: var(--radius-sm, 4px);
    background: var(--surface-hover, rgba(128,128,128,.12)); color: var(--text-primary); font-size: var(--font-sm, 11px);
  }
  .allowed-paths-add-btn:hover { background: var(--accent, #0e639c); color: #fff; }

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
`;
