/**
 * 大模型配置面板样式 — 对齐 memora-sprite 的功能域分组思路
 *
 * 说明：全部使用 --vscode-* 语义变量（带合理降级默认值），亮/暗主题自适应。
 * 含 Provider 卡片列表、表单弹窗、脱敏回显、测试连接内联结果、Toast。
 */
export const configStyles = `
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0; box-sizing: border-box;
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  .header h2 { font-size: 14px; margin: 0; }
  .btn { padding: 6px 12px; border-radius: 6px; border: none; cursor: pointer; background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-size: 12px; }
  .btn-secondary { background: var(--vscode-button-secondaryBackground, #e0e0e0); color: var(--vscode-button-secondaryForeground, #333); }
  .btn-danger { background: var(--vscode-statusBarItem-errorBackground, #b3261e); color: #fff; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #list { padding: 8px; }
  .card { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px; margin-bottom: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-sideBar-background); }
  .card.active { border-color: var(--vscode-button-background); }
  .card-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .card-name { font-weight: 600; }
  .card-detail { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .card-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .hint { text-align: center; color: var(--vscode-descriptionForeground); padding: 16px; font-size: 12px; }
  .modal-mask { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 10; align-items: flex-start; justify-content: center; padding-top: 40px; }
  .modal-mask.visible { display: flex; }
  .modal { width: 90%; max-width: 360px; background: var(--vscode-editor-background); border-radius: 8px; padding: 16px; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
  .modal h3 { margin: 0 0 12px; font-size: 14px; }
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 12px; margin-bottom: 4px; color: var(--vscode-descriptionForeground); }
  .field input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid var(--vscode-input-border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-size: 13px; }
  .field input:disabled { opacity: 0.6; }
  .key-hint { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .test-result { font-size: 12px; padding: 6px 8px; border-radius: 6px; margin-bottom: 10px; word-break: break-all; }
  .test-result.ok { background: var(--vscode-inputValidation-infoBackground, #e3f2fd); color: var(--vscode-inputValidation-infoForeground, #1565c0); }
  .test-result.err { background: var(--vscode-inputValidation-errorBackground, #fdecea); color: var(--vscode-inputValidation-errorForeground, #b3261e); }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  #toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); padding: 8px 14px; border-radius: 6px; font-size: 12px; color: #fff; opacity: 0; transition: opacity 0.2s; z-index: 20; max-width: 80%; }
  #toast.ok { background: var(--vscode-statusBarItem-prominentBackground, #2e7d32); }
  #toast.err { background: var(--vscode-statusBarItem-errorBackground, #b3261e); }
  #toast.visible { opacity: 1; }
`;