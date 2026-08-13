/**
 * 工具调用卡片样式 — 对齐 memora-sprite 的视觉语言，用 --vscode-* 语义变量做主题兼容
 *
 * 结构约定（由 components/toolCard.ts 生成）：
 *   .tool-card[data-tool-call-id]          卡片（running/success/failed 三种状态类）
 *     .tool-card__header[id=toolCardHeader]按钮（点击折叠/展开）
 *       .tool-card__chevron   .tool-card__icon   .tool-card__name   .tool-card__spinner   .tool-card__status
 *     .tool-card__args        工具参数（可折叠）
 *     .tool-card__result      工具结果摘要（可折叠）
 * 折叠：卡片加 .is-collapsed 时隐藏 args/result 并旋转箭头。
 */
export const toolCardStyles = `
  .tool-card {
    margin-top: var(--sp-1, 4px); padding: var(--sp-2, 6px) var(--sp-4, 10px);
    font-size: var(--font-md, 12px); line-height: 1.5;
    border-radius: var(--radius, 6px);
    animation: toolCardIn 0.15s ease-out;
  }
  /* 入场微位移：属动画细节，不在间距刻度内（对齐令牌铁律例外） */
  @keyframes toolCardIn { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
  .tool-card.is-running { border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff); background: var(--vscode-inputValidation-infoBackground, rgba(55,148,255,.12)); }
  .tool-card.is-success { border-left: 3px solid var(--vscode-testing-iconPassed, #4ec9b0); background: var(--vscode-inputValidation-infoBackground, rgba(78,201,176,.12)); }
  .tool-card.is-failed { border-left: 3px solid var(--vscode-errorForeground, #b3261e); background: var(--vscode-inputValidation-errorBackground, rgba(179,38,30,.12)); }
  .tool-card__header {
    display: flex; align-items: center; gap: var(--sp-2, 6px); width: 100%;
    background: none; border: none; padding: 0; margin: 0;
    font-family: inherit; font-size: inherit; text-align: left;
    color: inherit; cursor: pointer; user-select: none;
  }
  .tool-card__chevron { display: inline-flex; align-items: center; color: var(--text-secondary, #9aa0a6); transition: transform 0.15s ease; font-size: var(--font-xs, 10px); }
  .tool-card.is-collapsed .tool-card__chevron { transform: rotate(-90deg); }
  .tool-card__name { font-weight: 600; color: var(--text-primary, #1f1f1f); font-family: ui-monospace, Consolas, monospace; font-size: var(--font-sm, 11px); }
  .tool-card__spinner {
    display: inline-block; width: 10px; height: 10px; margin-left: auto;
    border: 1.5px solid var(--border-panel, #ccc);
    border-top-color: var(--vscode-editorInfo-foreground, #3794ff);
    border-radius: 50%; animation: toolSpin 0.8s linear infinite;
  }
  .tool-card.is-success .tool-card__spinner, .tool-card.is-failed .tool-card__spinner { display: none; }
  @keyframes toolSpin { to { transform: rotate(360deg); } }
  .tool-card__status { margin-left: auto; font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6); }
  .tool-card__args, .tool-card__result {
    margin-top: var(--sp-1, 4px); padding: var(--sp-1, 4px) var(--sp-2, 6px); max-height: 120px; overflow: auto;
    background: var(--vscode-widget-shadow, rgba(0,0,0,.08));
    border-radius: var(--radius, 6px);
    font-family: ui-monospace, Consolas, monospace; font-size: var(--font-sm, 11px);
    color: var(--vscode-descriptionForeground, #5f6368);
    white-space: pre-wrap; word-break: break-all;
    transition: max-height 0.15s ease, opacity 0.1s ease, margin 0.15s ease;
  }
  .tool-card__result { border-top: 1px dashed var(--border-panel, #ccc); }
  .tool-card.is-collapsed .tool-card__args,
  .tool-card.is-collapsed .tool-card__result { max-height: 0; opacity: 0; margin-top: 0; padding-top: 0; padding-bottom: 0; overflow: hidden; }
`;