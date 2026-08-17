/**
 * 记忆管理面板样式 — 对齐 rolesStyles.ts 的卡片列表 + 搜索 + source 徽章
 *
 * 分层（对齐 ITCSS + tokens.ts 单一真理源）：
 *   - 设计令牌由 tokens.ts 单一真理源提供，本文件只引用令牌，禁止裸值；
 *   - 分区：Base（body）→ Layout（header / search / list）→ Components（card / source-badge / detail）；
 *   - source 徽章颜色约定：round-summary=accent，profile=中性，work-projection=灰色，
 *     未知 source 回退中性（开放字符串，不应穷举）。
 */
import { tokens } from './tokens.js';

export const memoryStyles = `
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
  .hint { text-align: center; color: var(--text-secondary, #9aa0a6); padding: var(--sp-6, 16px); font-size: var(--font-md, 12px); }
  .empty-state { text-align: center; padding: var(--sp-8, 24px) var(--sp-5, 12px); color: var(--text-secondary, #9aa0a6); }
  .empty-title { font-size: var(--font-lg, 14px); font-weight: 600; color: var(--text-primary, #cccccc); margin-bottom: var(--sp-2, 6px); }
  .empty-hint { font-size: var(--font-md, 12px); }
  .footer-hint {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
    text-align: center;
  }

  /* ============ Components：搜索框 ============ */
  .search-wrap { padding: var(--sp-3, 8px); }
  .search-input {
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
  .search-input:focus {
    border-color: var(--border-focus, #0e639c);
  }
  .search-input::placeholder { color: var(--text-secondary, #9aa0a6); }

  /* ============ Components：记忆条目卡片 ============ */
  .mem-card {
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    margin-bottom: var(--sp-2, 6px);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius, 6px);
    background: var(--surface-sidebar);
    cursor: pointer;
    transition: border-color 0.1s;
  }
  .mem-card:hover { border-color: var(--text-secondary, #9aa0a6); }
  .mem-card.expanded { border-color: var(--accent, #0e639c); }

  /* 卡片头部：名称 + source 徽章 + score */
  .mem-card-head {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    margin-bottom: var(--sp-1, 4px);
  }
  .mem-card-name {
    font-weight: 600;
    font-size: var(--font-md, 12px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 1;
  }

  /* source 徽章：已知 3 种预设来源有颜色约定，其余回退中性（开放字符串制动） */
  .source-badge {
    display: inline-block;
    padding: 0 var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    flex-shrink: 0;
    background: var(--surface-code, rgba(128,128,128,.12));
    color: var(--text-secondary, #9aa0a6);
  }
  .source-badge-round-summary { background: var(--accent, #0e639c); color: var(--accent-foreground, #ffffff); }
  .source-badge-profile { background: var(--surface-hover, rgba(128,128,128,.2)); color: var(--text-primary, #cccccc); }
  .source-badge-work-projection { background: var(--surface-card, #252526); color: var(--text-secondary, #9aa0a6); }

  /* score 点：圆点指示记忆权重（越高越实心） */
  .score-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--text-secondary, #9aa0a6);
  }
  .score-dot-high { background: var(--accent, #0e639c); }

  /* 内容预览：单行截断，供快速扫读 */
  .mem-card-preview {
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* 展开详情：全文 content + 元数据 */
  .mem-card-detail {
    margin-top: var(--sp-2, 6px);
    padding-top: var(--sp-2, 6px);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
    font-size: var(--font-sm, 11px);
    color: var(--text-primary, #cccccc);
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.5;
  }
  .mem-card-meta {
    margin-top: var(--sp-1, 4px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
  }

  /* ============ Components：搜索模式特定 ============ */
  .search-summary {
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
  }
`;