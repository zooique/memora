/**
 * 设置面板「常规」子视图样式
 *
 * 设计（对齐 ITCSS + tokens.ts 单一真理源，同 mcpStyles / worksStyles 范式）：
 *   - 一律以 `#general-root` 前缀限定；`.header` / `.hint` 等共享类必须在本文件写一份，
 *     否则真机排版塌陷而 DOM 测试全绿（见 settingsTabWiring.test.ts 零豁免守卫）；
 *   - 复用 tokens.ts 设计令牌，不自带注入，由 settingsStyles 聚合。
 */
export const generalStyles = `
  /* ============ 常规：语言与交互偏好（#general-root） ============ */
  #general-root {
    display: flex; flex-direction: column; gap: var(--sp-3, 8px);
    padding-bottom: var(--sp-5, 12px);
  }

  #general-root .header {
    display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px);
    padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: var(--line-solid);
  }
  #general-root .header h2 { font-size: var(--font-lg, 14px); margin: 0; }

  #general-root .general-section {
    display: flex; flex-direction: column; gap: var(--sp-4, 10px);
  }
  #general-root .general-item {
    display: flex; flex-direction: column;
    padding: var(--sp-4, 10px) var(--sp-5, 12px);
    border-bottom: var(--line-solid);
  }
  #general-root .general-item-header {
    display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3, 8px);
  }
  #general-root .general-label { font-size: var(--font-base, 13px); font-weight: 600; }

  #general-root .general-desc,
  #general-root .hint {
    font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6);
    line-height: var(--lh-relaxed); margin: var(--sp-2, 6px) 0 0;
  }

  #general-root .general-mode-row {
    display: flex; align-items: center; gap: var(--sp-5, 12px);
    margin-top: var(--sp-3, 8px);
  }
  #general-root .general-mode {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    font-size: var(--font-base, 13px); cursor: pointer;
  }
  #general-root .general-input {
    width: 100%; max-width: 360px; margin-top: var(--sp-3, 8px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    background: var(--surface-sidebar, transparent); color: var(--text-primary, inherit);
    border: var(--line-solid); border-radius: 3px;
    font-family: var(--font-ui, inherit); font-size: var(--font-base, 13px);
    box-sizing: border-box;
  }
  #general-root .general-input:disabled { opacity: 0.5; }
  #general-root .general-actions {
    display: flex; align-items: center; gap: var(--sp-3, 8px);
    margin-top: var(--sp-3, 8px);
  }
  #general-root .general-status {
    font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6);
  }
`;
