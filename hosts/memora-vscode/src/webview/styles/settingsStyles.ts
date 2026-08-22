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
`;
