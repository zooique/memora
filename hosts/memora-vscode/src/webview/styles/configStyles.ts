/**
 * 大模型子视图样式（设置视图选项卡内）— 对齐 memora-sprite 的功能域分组思路 + 与对话面板统一的设计刻度
 *
 * 分层（对齐 ui-engineering-mindset-rules.md + ITCSS）：
 *   - 设计令牌由 tokens.ts 单一真理源提供，经 settingsStyles.ts 统一内嵌，本文件不再内嵌；
 *   - 选择器统一以 `#config-root` 前缀限定 —— 设置视图合并后三个子视图共存于同一文档，
 *     共享类名（.card / .btn / .empty-state 等）靠根容器前缀隔离，避免跨子视图样式串扰；
 *   - 分区：Layout（header / list）→ Components（card / modal / toast）；
 *   - 含 Provider 卡片列表、表单弹窗、脱敏回显、测试连接内联结果、Toast。
 */
export const configStyles = `
  /* ============ Layout：面板骨架 ============ */
  #config-root .header { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 6px); padding: var(--sp-4, 10px) var(--sp-5, 12px); border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4)); }
  #config-root .header h2 { font-size: var(--font-lg, 14px); margin: 0; }
  /* 顶栏统计：已配置 N 个 API（ui-redesign.md §4.2 ①） */
  #config-root .stat-bar { font-size: var(--font-sm, 11px); color: var(--text-secondary, #9aa0a6); margin-left: auto; }
  #config-root #list { padding: var(--sp-3, 8px); }
  /* 分区标题：「激活 Provider」/「其他 Provider」（ui-redesign.md §4.2 ②③） */
  #config-root .group-title { font-size: var(--font-xs, 10px); letter-spacing: 0.5px; text-transform: uppercase; color: var(--text-secondary, #9aa0a6); margin: var(--sp-3, 8px) 0 var(--sp-1, 4px); }

  /* ============ Components：后台模型通道（G5，2026-08-23） ============ */
  #config-root .cfg-bg {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
  }
  #config-root .cfg-bg-label {
    display: block;
    font-size: var(--font-md, 12px);
    margin-bottom: var(--sp-1, 4px);
    color: var(--text-secondary, #9aa0a6);
  }
  #config-root .cfg-bg-select {
    width: 100%;
    box-sizing: border-box;
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    border-radius: var(--radius, 6px);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    background: var(--surface-input, #3c3c3c);
    color: var(--text-input, #cccccc);
    font-size: var(--font-md, 12px);
  }
  #config-root .cfg-bg-select:focus-visible { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 2px; }
  #config-root .cfg-bg-hint { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); margin: var(--sp-2, 6px) 0 0; }

  /* ============ Components：Provider 卡片 ============ */
  /* Card 基类见 settingsStyles 通用块；此处保留对齐差异（center + space-between） */
  #config-root .card { align-items: center; justify-content: space-between; }
  /* 卡片图标：Provider 首字块（ui-redesign.md §6.2），装饰性元素 aria-hidden */
  #config-root .cfg-icon { width: 26px; height: 26px; border-radius: var(--radius, 6px); display: inline-flex; align-items: center; justify-content: center; background: var(--surface-ai-avatar); color: var(--accent-foreground, #ffffff); font-size: var(--font-md, 12px); font-weight: 600; flex-shrink: 0; user-select: none; }
  #config-root .card-info { display: flex; flex-direction: column; gap: var(--sp-0, 2px); min-width: 0; flex: 1; }
  #config-root .card-name { font-weight: 600; }
  #config-root .card-detail { font-size: var(--font-md, 12px); color: var(--text-secondary, #9aa0a6); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #config-root .card-actions { display: flex; gap: var(--sp-1, 4px); flex-shrink: 0; }

  /* ============ Components：表单弹窗 ============ */
  #config-root .modal-mask { display: none; position: fixed; inset: 0; background: var(--overlay-mask); z-index: 10; align-items: flex-start; justify-content: center; padding-top: 40px; }
  #config-root .modal-mask.visible { display: flex; }
  #config-root .modal { width: 90%; max-width: 360px; background: var(--surface-page, #1e1e1e); border-radius: var(--radius-lg, 8px); padding: var(--sp-6, 16px); box-shadow: var(--shadow-modal, 0 4px 16px rgba(0,0,0,.3)); overscroll-behavior: contain; }
  #config-root .modal h3 { margin: 0 0 var(--sp-5, 12px); font-size: var(--font-lg, 14px); }
  /* 键盘焦点环：按钮与表单输入统一可见反馈（可访问性） */
  #config-root .btn:focus-visible,
  #config-root .field input:focus-visible {
    outline: 2px solid var(--border-focus, #0e639c);
    outline-offset: 2px;
  }
  #config-root .field { margin-bottom: var(--sp-4, 10px); }
  #config-root .field label { display: block; font-size: var(--font-md, 12px); margin-bottom: var(--sp-1, 4px); color: var(--text-secondary, #9aa0a6); }
  #config-root .field input { width: 100%; box-sizing: border-box; padding: var(--sp-2, 6px) var(--sp-3, 8px); border-radius: var(--radius, 6px); border: 1px solid var(--border-input, rgba(128,128,128,.5)); background: var(--surface-input, #3c3c3c); color: var(--text-input, #cccccc); font-size: var(--font-base, 13px); }
  #config-root .field select { width: 100%; box-sizing: border-box; padding: var(--sp-2, 6px) var(--sp-3, 8px); border-radius: var(--radius, 6px); border: 1px solid var(--border-input, rgba(128,128,128,.5)); background: var(--surface-input, #3c3c3c); color: var(--text-input, #cccccc); font-size: var(--font-base, 13px); }
  #config-root .field input:disabled { opacity: 0.6; }
  /* 本地工具能力位复选框：标签与复选框同行走排（阶段1·本地 LLM 能力声明） */
  #config-root .field .checkbox-label { display: flex; align-items: center; gap: var(--sp-2, 6px); color: var(--text-input, #cccccc); font-size: var(--font-base, 13px); cursor: pointer; }
  #config-root .field .checkbox-label input[type="checkbox"] { width: auto; flex-shrink: 0; accent-color: var(--accent, #0e639c); }
  #config-root .key-hint { font-size: var(--font-md, 12px); color: var(--text-secondary, #9aa0a6); margin-top: var(--sp-1, 4px); }
  #config-root .key-hint.err { color: var(--feedback-error-fg); }
  #config-root .test-result { font-size: var(--font-md, 12px); padding: var(--sp-2, 6px) var(--sp-3, 8px); border-radius: var(--radius, 6px); margin-bottom: var(--sp-4, 10px); word-break: break-all; }
  #config-root .test-result.ok { background: var(--feedback-info-bg); color: var(--feedback-info-fg); }
  #config-root .test-result.err { background: var(--feedback-error-bg); color: var(--feedback-error-fg); }
  /* 测试连接结果图标（原 ✅/❌ emoji 的 SVG 替代，2026-09-19 图标语言收口）：
   * 结果块是纯文本容器，图标以 inline-flex 内联，vertical-align 微调与文字基线对齐 */
  #config-root .test-result__icon { display: inline-flex; align-items: center; vertical-align: -2px; margin-right: var(--sp-1, 4px); }
  #config-root .test-result__icon svg { display: block; }
  #config-root .modal-actions { display: flex; gap: var(--sp-3, 8px); justify-content: flex-end; margin-top: var(--sp-5, 12px); }

  /* ============ Components：Toast ============ */
  #config-root #toast { position: fixed; bottom: var(--sp-6, 16px); left: 50%; transform: translateX(-50%); padding: var(--sp-3, 8px) var(--sp-5, 12px); border-radius: var(--radius, 6px); font-size: var(--font-md, 12px); color: var(--accent-foreground, #ffffff); opacity: 0; transition: opacity 0.2s; z-index: 20; max-width: 80%; }
  #config-root #toast.ok { background: var(--toast-ok-bg); }
  #config-root #toast.err { background: var(--btn-danger-bg); }
  #config-root #toast.visible { opacity: 1; }
`;
