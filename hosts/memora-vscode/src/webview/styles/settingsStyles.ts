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
