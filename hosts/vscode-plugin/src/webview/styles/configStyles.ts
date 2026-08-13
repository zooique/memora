/**
 * 大模型配置面板样式 — 对齐 memora-sprite 的功能域分组思路 + 与对话面板统一的设计刻度
 *
 * 说明：全部使用 --vscode-* 语义变量（带合理降级默认值），亮/暗主题自适应。
 * 含 Provider 卡片列表、表单弹窗、脱敏回显、测试连接内联结果、Toast。
 * 设计刻度（间距/圆角/字号）与 chatStyles.ts 保持一致，保证全插件统一。
 */
export const configStyles = `
  :root {
    color-scheme: light dark;
    /* 设计刻度：间距 / 圆角 / 字号（与 chatStyles.ts 一致） */
    --sp-1: 4px;  --sp-2: 6px;  --sp-3: 8px;
    --sp-4: 10px; --sp-5: 12px; --sp-6: 16px;
    --radius: 6px; --radius-lg: 8px;
    --font-xs: 10px; --font-sm: 11px; --font-md: 12px; --font-base: 13px;
  }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; box-sizing: border-box;
    font-size: var(--font-base, 13px);
    color: var(--vscode-foreground, #cccccc);
    background: var(--vscode-editor-background, #1e1e1e);
  }
  .header { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); }
  .header h2 { font-size: 14px; margin: 0; }
  .btn { padding: var(--sp-2, 6px) var(--sp-5, 12px); border-radius: var(--radius, 6px); border: none; cursor: pointer; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); font-size: var(--font-md, 12px); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.3)); color: var(--vscode-button-secondaryForeground, #cccccc); }
  .btn-danger { background: var(--vscode-statusBarItem-errorBackground, #b3261e); color: #fff; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #list { padding: var(--sp-3, 8px); }
  .card { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3, 8px); padding: var(--sp-4, 10px); margin-bottom: var(--sp-3, 8px); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); border-radius: var(--radius-lg, 8px); background: var(--vscode-sideBar-background, #252526); }
  .card.active { border-color: var(--vscode-button-background, #0e639c); }
  .card-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .card-name { font-weight: 600; }
  .card-detail { font-size: var(--font-md, 12px); color: var(--vscode-descriptionForeground, #9aa0a6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: var(--font-sm, 11px); padding: 1px var(--sp-2, 6px); border-radius: 999px; background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #ffffff); }
  .card-actions { display: flex; gap: var(--sp-1, 4px); flex-shrink: 0; }
  .hint { text-align: center; color: var(--vscode-descriptionForeground, #9aa0a6); padding: var(--sp-6, 16px); font-size: var(--font-md, 12px); }
  .modal-mask { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 10; align-items: flex-start; justify-content: center; padding-top: 40px; }
  .modal-mask.visible { display: flex; }
  .modal { width: 90%; max-width: 360px; background: var(--vscode-editor-background, #1e1e1e); border-radius: var(--radius-lg, 8px); padding: var(--sp-6, 16px); box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
  .modal h3 { margin: 0 0 var(--sp-5, 12px); font-size: 14px; }
  .field { margin-bottom: var(--sp-4, 10px); }
  .field label { display: block; font-size: var(--font-md, 12px); margin-bottom: var(--sp-1, 4px); color: var(--vscode-descriptionForeground, #9aa0a6); }
  .field input { width: 100%; box-sizing: border-box; padding: var(--sp-2, 6px) var(--sp-3, 8px); border-radius: var(--radius, 6px); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.5)); background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #cccccc); font-size: var(--font-base, 13px); }
  .field input:disabled { opacity: 0.6; }
  .key-hint { font-size: var(--font-md, 12px); color: var(--vscode-descriptionForeground, #9aa0a6); margin-top: var(--sp-1, 4px); }
  .test-result { font-size: var(--font-md, 12px); padding: var(--sp-2, 6px) var(--sp-3, 8px); border-radius: var(--radius, 6px); margin-bottom: var(--sp-4, 10px); word-break: break-all; }
  .test-result.ok { background: var(--vscode-inputValidation-infoBackground, rgba(21,126,251,.15)); color: var(--vscode-inputValidation-infoForeground, #75beff); }
  .test-result.err { background: var(--vscode-inputValidation-errorBackground, #442726); color: var(--vscode-inputValidation-errorForeground, #f48771); }
  .modal-actions { display: flex; gap: var(--sp-3, 8px); justify-content: flex-end; margin-top: var(--sp-5, 12px); }
  #toast { position: fixed; bottom: var(--sp-6, 16px); left: 50%; transform: translateX(-50%); padding: var(--sp-3, 8px) var(--sp-5, 12px); border-radius: var(--radius, 6px); font-size: var(--font-md, 12px); color: #fff; opacity: 0; transition: opacity 0.2s; z-index: 20; max-width: 80%; }
  #toast.ok { background: var(--vscode-statusBarItem-prominentBackground, #2e7d32); }
  #toast.err { background: var(--vscode-statusBarItem-errorBackground, #b3261e); }
  #toast.visible { opacity: 1; }
`;