/**
 * 角色管理面板样式 — 对齐 configStyles.ts 的卡片列表 + 能力标签 chips
 *
 * 分层（对齐 ITCSS）：
 *   - 设计令牌由 tokens.ts 单一真理源提供，本文件只引用令牌，禁止裸值；
 *   - 分区：Base（body）→ Layout（header / list）→ Components（card / cap-chip / footer-hint）；
 *   - 能力标签 chips 装饰性强但克制：灰底灰字，不抢角色名视觉层级。
 */
import { tokens } from './tokens.js';

export const rolesStyles = `
  ${tokens}

  /* ============ Base：元素级基础 ============ */
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; box-sizing: border-box;
    font-size: var(--font-base, 13px);
    color: var(--text-primary, #cccccc);
    background: var(--surface-page, #1e1e1e);
  }

  /* ============ Layout：面板骨架 ============ */
  .header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px); padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4)); }
  .header h2 { font-size: var(--font-lg, 14px); margin: 0; }
  .stat-bar { font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6); margin-left: auto; }
  #list { padding: var(--sp-3, 8px); }
  .group-title { font-size: var(--font-xs, 10px); letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-secondary, #9aa0a6); margin: var(--sp-3, 8px) 0 var(--sp-1, 4px); }
  .footer-hint {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
    text-align: center;
  }

  /* ============ Components：角色包卡片 ============ */
  .card { display: flex; align-items: flex-start; gap: var(--sp-3, 8px); padding: var(--sp-4, 10px); margin-bottom: var(--sp-3, 8px); border: 1px solid var(--border-panel, rgba(128,128,128,.4)); border-radius: var(--radius-lg, 8px); background: var(--surface-sidebar); }
  .card.active { border-color: var(--accent, #0e639c); }
  /* 卡片图标：首字块（装饰性，aria-hidden） */
  .role-icon { width: 26px; height: 26px; border-radius: var(--radius, 6px); display: inline-flex; align-items: center; justify-content: center; background: var(--surface-ai-avatar); color: var(--accent-foreground, #ffffff); font-size: var(--font-md, 12px); font-weight: 600; flex-shrink: 0; user-select: none; }
  .card-info { display: flex; flex-direction: column; gap: var(--sp-1, 4px); min-width: 0; flex: 1; }
  .card-name { font-weight: 600; }
  .card-detail { font-size: var(--font-md, 12px); color: var(--text-secondary, #9aa0a6); }
  .badge { font-size: var(--font-sm, 11px); padding: 1px var(--sp-2, 6px); border-radius: var(--radius-pill, 999px); background: var(--accent, #0e639c); color: var(--accent-foreground, #ffffff); margin-left: var(--sp-1, 4px); }
  .card-actions { display: flex; gap: var(--sp-1, 4px); flex-shrink: 0; align-self: center; }
  .btn { padding: var(--sp-2, 6px) var(--sp-5, 12px); border-radius: var(--radius, 6px); border: none; cursor: pointer; background: var(--accent, #0e639c); color: var(--accent-foreground, #ffffff); font-size: var(--font-md, 12px); }
  .btn-secondary { background: var(--btn-secondary-bg); color: var(--btn-secondary-fg); }
  .hint { text-align: center; color: var(--text-secondary, #9aa0a6); padding: var(--sp-6, 16px); font-size: var(--font-md, 12px); }
  .empty-state { text-align: center; padding: var(--sp-8, 24px) var(--sp-5, 12px); color: var(--text-secondary, #9aa0a6); }
  .empty-title { font-size: var(--font-lg, 14px); font-weight: 600; color: var(--text-primary, #cccccc); margin-bottom: var(--sp-2, 6px); }
  .empty-hint { font-size: var(--font-md, 12px); }

  /* ============ Components：能力标签 chips ============ */
  .cap-chips { display: flex; flex-wrap: wrap; gap: var(--sp-1, 4px); margin-top: var(--sp-1, 4px); }
  .cap-chip {
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