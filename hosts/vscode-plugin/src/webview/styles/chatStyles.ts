/**
 * 对话打磨面板样式 — 对齐 memora-sprite 的功能域分组思路
 *
 * 说明：全部使用 --vscode-* 语义变量（带合理降级默认值），亮/暗主题自适应。
 * 下拉菜单样式见 dropdown.ts（scoped 到 .treedd），此处为面板整体布局。
 */
export const chatStyles = `
  :root { color-scheme: light dark; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0;
    display: flex; flex-direction: column;
    height: 100vh; box-sizing: border-box;
    font-size: 13px;
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
  }
  /* 顶部工具栏：标题 + 右侧下拉触发器 */
  #toolbar {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--vscode-panel-border, #ddd);
  }
  #toolbar .title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #messages {
    flex: 1; overflow-y: auto; padding: 12px; box-sizing: border-box;
    display: flex; flex-direction: column; gap: 10px;
  }
  /* 消息基类：默认无气泡（对齐 sprite「AI 铺满」收敛设计） */
  .msg { white-space: pre-wrap; word-break: break-word; line-height: 1.6; position: relative; }
  /* 用户消息：右侧浅灰气泡（轻量身份标记） */
  .msg.user {
    align-self: flex-end; max-width: 85%;
    background: var(--vscode-editor-inactiveSelectionBackground, #f1f3f4);
    color: var(--vscode-foreground, #1f1f1f);
    padding: 8px 12px; border-radius: 10px 10px 2px 10px;
  }
  /* AI 回答：无气泡，内容全量铺开 */
  .msg.assistant {
    align-self: stretch;
    background: transparent; color: var(--vscode-foreground, #1f1f1f);
    padding: 0; border-radius: 0;
    border-top: 1px solid var(--vscode-panel-border, #ddd);
  }
  .msg.error {
    align-self: stretch;
    background: var(--vscode-inputValidation-errorBackground, #fdecea);
    color: var(--vscode-inputValidation-errorForeground, #b3261e);
    padding: 8px 12px; border-radius: 8px;
  }
  .msg-time { font-size: 10px; color: var(--vscode-descriptionForeground, #9aa0a6); margin-top: 4px; text-align: right; }
  .msg-copy {
    position: absolute; top: 4px; right: 4px; display: none; padding: 2px 6px;
    font-size: 11px; border-radius: 4px; border: none;
    background: var(--vscode-button-secondaryBackground, #e0e0e0);
    color: var(--vscode-button-secondaryForeground, #333); cursor: pointer;
  }
  .msg:hover .msg-copy { display: block; }
  #inputBar { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border, #ddd); }
  #input {
    flex: 1; padding: 8px; border-radius: 6px;
    border: 1px solid var(--vscode-input-border, #ccc);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  }
  button { padding: 8px 14px; border-radius: 6px; border: none; background: var(--vscode-button-background, #1a73e8); color: var(--vscode-button-foreground, #fff); cursor: pointer; }
  .memory-bar {
    padding: 4px 12px; font-size: 12px;
    color: var(--vscode-descriptionForeground, #5f6368);
    background: var(--vscode-inputValidation-infoBackground, #e6f4ea);
    border-bottom: 1px solid var(--vscode-panel-border, #ceead6);
  }
  #statusBar {
    display: none; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12px;
    color: var(--vscode-descriptionForeground, #5f6368);
    border-bottom: 1px solid var(--vscode-panel-border, #ddd);
  }
  #statusBar.visible { display: flex; }
  .spinner {
    width: 12px; height: 12px;
    border: 2px solid var(--vscode-panel-border, #ccc);
    border-top-color: var(--vscode-button-background, #1a73e8);
    border-radius: 50%; animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  #clarifyBar {
    display: none; flex-direction: column; gap: 6px; padding: 8px;
    border-top: 1px solid var(--vscode-charts-yellow, #daa520);
    background: var(--vscode-inputValidation-warningBackground, #fff8e1);
  }
  #clarifyBar.visible { display: flex; }
  #clarifyText { font-size: 12px; color: var(--vscode-descriptionForeground, #6d5f00); }
  #clarifyRow { display: flex; gap: 6px; }
  #clarifyInput {
    flex: 1; padding: 8px; border-radius: 6px;
    border: 1px solid var(--vscode-input-border, #ccc);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  }
  #clarifyOptions { display: flex; flex-wrap: wrap; gap: 6px; }
  .opt-btn {
    padding: 4px 10px; font-size: 12px; border-radius: 999px;
    border: 1px solid var(--vscode-charts-yellow, #daa520);
    background: transparent; color: var(--vscode-descriptionForeground, #6d5f00); cursor: pointer;
  }
  .opt-btn:hover { background: var(--vscode-inputValidation-warningBackground, #fff8e1); }
`;