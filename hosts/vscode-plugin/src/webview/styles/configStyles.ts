/**
 * 大模型配置面板样式 — 对齐 memora-sprite 的功能域分组思路 + 与对话面板统一的设计刻度
 *
 * 分层（对齐 ui-engineering-mindset-rules.md + ITCSS）：
 *   - 设计令牌由 tokens.ts 单一真理源提供，本文件只引用令牌，禁止裸值；
 *   - 分区：Base（body）→ Layout（header / list）→ Components（card / modal / toast）；
 *   - 含 Provider 卡片列表、表单弹窗、脱敏回显、测试连接内联结果、Toast。
 */
import { tokens } from './tokens.js';

export const configStyles = `
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
  .header { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4)); }
  .header h2 { font-size: var(--font-lg, 14px); margin: 0; }
  .btn { padding: var(--sp-2, 6px) var(--sp-5, 12px); border-radius: var(--radius, 6px); border: none; cursor: pointer; background: var(--accent, #0e639c); color: var(--accent-foreground, #ffffff); font-size: var(--font-md, 12px); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.3)); color: var(--vscode-button-secondaryForeground, #cccccc); }
  .btn-danger { background: var(--vscode-statusBarItem-errorBackground, #b3261e); color: var(--accent-foreground, #ffffff); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  #list { padding: var(--sp-3, 8px); }

  /* ============ Components：Provider 卡片 ============ */
  .card { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3, 8px); padding: var(--sp-4, 10px); margin-bottom: var(--sp-3, 8px); border: 1px solid var(--border-panel, rgba(128,128,128,.4)); border-radius: var(--radius-lg, 8px); background: var(--vscode-sideBar-background, #252526); }
  .card.active { border-color: var(--accent, #0e639c); }
  .card-info { display: flex; flex-direction: column; gap: var(--sp-0, 2px); min-width: 0; }
  .card-name { font-weight: 600; }
  .card-detail { font-size: var(--font-md, 12px); color: var(--text-secondary, #9aa0a6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badge { font-size: var(--font-sm, 11px); padding: 1px var(--sp-2, 6px); border-radius: var(--radius-pill, 999px); background: var(--accent, #0e639c); color: var(--accent-foreground, #ffffff); }
  .card-actions { display: flex; gap: var(--sp-1, 4px); flex-shrink: 0; }
  .hint { text-align: center; color: var(--text-secondary, #9aa0a6); padding: var(--sp-6, 16px); font-size: var(--font-md, 12px); }

  /* ============ Components：表单弹窗 ============ */
  .modal-mask { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 10; align-items: flex-start; justify-content: center; padding-top: 40px; }
  .modal-mask.visible { display: flex; }
  .modal { width: 90%; max-width: 360px; background: var(--surface-page, #1e1e1e); border-radius: var(--radius-lg, 8px); padding: var(--sp-6, 16px); box-shadow: var(--shadow-modal, 0 4px 16px rgba(0,0,0,.3)); overscroll-behavior: contain; }
  .modal h3 { margin: 0 0 var(--sp-5, 12px); font-size: var(--font-lg, 14px); }
  /* 键盘焦点环：按钮与表单输入统一可见反馈（可访问性） */
  .btn:focus-visible,
  .field input:focus-visible {
    outline: 2px solid var(--border-focus, #0e639c);
    outline-offset: 2px;
  }
  .field { margin-bottom: var(--sp-4, 10px); }
  .field label { display: block; font-size: var(--font-md, 12px); margin-bottom: var(--sp-1, 4px); color: var(--text-secondary, #9aa0a6); }
  .field input { width: 100%; box-sizing: border-box; padding: var(--sp-2, 6px) var(--sp-3, 8px); border-radius: var(--radius, 6px); border: 1px solid var(--border-input, rgba(128,128,128,.5)); background: var(--surface-input, #3c3c3c); color: var(--text-input, #cccccc); font-size: var(--font-base, 13px); }
  .field input:disabled { opacity: 0.6; }
  .key-hint { font-size: var(--font-md, 12px); color: var(--text-secondary, #9aa0a6); margin-top: var(--sp-1, 4px); }
  .test-result { font-size: var(--font-md, 12px); padding: var(--sp-2, 6px) var(--sp-3, 8px); border-radius: var(--radius, 6px); margin-bottom: var(--sp-4, 10px); word-break: break-all; }
  .test-result.ok { background: var(--vscode-inputValidation-infoBackground, rgba(21,126,251,.15)); color: var(--vscode-inputValidation-infoForeground, #75beff); }
  .test-result.err { background: var(--vscode-inputValidation-errorBackground, #442726); color: var(--vscode-inputValidation-errorForeground, #f48771); }
  .modal-actions { display: flex; gap: var(--sp-3, 8px); justify-content: flex-end; margin-top: var(--sp-5, 12px); }

  /* ============ Components：Toast ============ */
  #toast { position: fixed; bottom: var(--sp-6, 16px); left: 50%; transform: translateX(-50%); padding: var(--sp-3, 8px) var(--sp-5, 12px); border-radius: var(--radius, 6px); font-size: var(--font-md, 12px); color: var(--accent-foreground, #ffffff); opacity: 0; transition: opacity 0.2s; z-index: 20; max-width: 80%; }
  #toast.ok { background: var(--vscode-statusBarItem-prominentBackground, #2e7d32); }
  #toast.err { background: var(--vscode-statusBarItem-errorBackground, #b3261e); }
  #toast.visible { opacity: 1; }
`;
