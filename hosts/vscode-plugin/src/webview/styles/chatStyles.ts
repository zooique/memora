/**
 * 对话打磨面板样式 — 对齐 Trae AI 对话面板的视觉语言（简洁、克制、主动可见）
 *
 * 分层（对齐 ui-engineering-mindset-rules.md + ITCSS）：
 *   - 设计令牌（间距/圆角/字号/阴影/颜色）由 tokens.ts 单一真理源提供，
 *     本文件只引用令牌，禁止裸值；
 *   - 分区遵循 ITCSS：Base（body）→ Layout（toolbar/messages/inputBar）
 *     → Components（消息 / 输入卡片 / 模型选择器 / 发送按钮 / 提示条）；
 *   - 操作按钮（复制等）「主动可见」，避免 hover-only；
 *   - 下拉菜单样式见 dropdown.ts（scoped 到 .treedd），工具卡片见 toolCard.ts。
 */
import { tokens } from './tokens.js';

export const chatStyles = `
  ${tokens}

  /* ============ Base：元素级基础 ============ */
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0;
    display: flex; flex-direction: column;
    height: 100vh; box-sizing: border-box;
    font-size: var(--font-base, 13px);
    background: var(--surface-page, #1e1e1e);
    color: var(--text-primary, #cccccc);
  }

  /* ============ Layout：面板骨架 ============ */
  /* 顶部工具栏：标题 + 右侧紧凑工具（下拉） */
  #toolbar {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-5, 12px);
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
    flex-shrink: 0;
  }
  #toolbar .title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 消息区：全量铺开 */
  #messages {
    flex: 1; overflow-y: auto; padding: var(--sp-5, 12px); box-sizing: border-box;
    display: flex; flex-direction: column; gap: var(--sp-4, 10px);
  }

  /* ============ Components：消息 ============ */
  /* 空状态：克制的中性提示，垂直居中 */
  .empty-state {
    margin: auto; max-width: 320px; text-align: center;
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-base, 13px); line-height: 1.7;
    padding: var(--sp-6, 16px);
  }
  /* 消息基类：默认无气泡（AI 铺满），正文与底部操作行分离 */
  .msg { display: flex; flex-direction: column; white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
  /* 用户消息：右侧浅灰气泡（轻量身份标记） */
  .msg.user {
    align-self: flex-end; max-width: 85%;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.2));
    color: var(--text-primary, #cccccc);
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    border-radius: var(--radius-lg, 8px) var(--radius-lg, 8px) var(--radius-sm, 2px) var(--radius-lg, 8px);
  }
  /* AI 回答：无气泡，内容全量铺开，顶部细线区分 */
  .msg.assistant {
    align-self: stretch;
    background: transparent; color: var(--text-primary, #cccccc);
    padding-top: var(--sp-3, 8px);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
  }
  .msg.error {
    align-self: stretch;
    background: var(--vscode-inputValidation-errorBackground, #442726);
    color: var(--vscode-inputValidation-errorForeground, #f48771);
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    border-radius: var(--radius-lg, 8px);
  }
  /* 消息底部操作行：复制（主动可见）+ 时间戳 */
  .msg-footer {
    display: flex; align-items: center; justify-content: flex-end;
    gap: var(--sp-2, 6px); margin-top: var(--sp-2, 6px);
  }
  .msg-time { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
  .msg-copy {
    padding: var(--sp-0, 2px) var(--sp-2, 6px); font-size: var(--font-sm, 11px);
    border: none; border-radius: var(--radius, 6px);
    background: transparent; color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
  }
  .msg-copy:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
    color: var(--text-primary, #cccccc);
  }

  /* ============ Components：底部输入卡片 ============
   * 结构（SSOT 单层视觉源）：
   *   #inputBar → 纯布局容器（padding，无视觉）
   *   #inputWrap → 唯一视觉卡片（边框 + 圆角 + 阴影 + 背景）
   *   #input → textarea（占主空间）；#inputFooter → 工具条（模型选择 + 发送）
   * 尺寸契约见 tokens.ts L3 组件令牌（--input-* / --control-h）
   * ================================================= */
  #inputBar {
    /* 仅底部留白，与上方消息区自然衔接 */
    padding-bottom: var(--sp-5, 12px);
    border-top: none;
    flex-shrink: 0;
    background: transparent;
  }
  /* 唯一视觉卡片：边框 + 圆角 + 阴影 + 背景（全部集中在此） */
  #inputWrap {
    display: flex;
    flex-direction: column;
    min-height: var(--input-wrap-min-h, 96px);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    border-radius: var(--radius-xl, 14px);
    background: var(--surface-input, #3c3c3c);
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0, 0, 0, 0.15));
    position: relative; /* 下拉菜单定位以此为基准 */
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    overflow: visible; /* 禁止裁剪向上弹出的菜单 */
  }
  /* 聚焦态：边框色变品牌色 + 阴影加深 */
  #inputWrap:focus-within {
    border-color: var(--border-focus, #0e639c);
    box-shadow: var(--shadow-card-focus, 0 4px 14px rgba(0, 0, 0, 0.25));
  }
  /* textarea：占主空间，无独立边框，与卡片融合 */
  #input {
    flex: 1;
    padding: var(--sp-6, 16px) var(--sp-6, 16px) var(--sp-3, 8px);
    border: none;
    background: transparent;
    color: var(--text-input, #cccccc);
    font-family: inherit;
    font-size: var(--font-base, 13px);
    line-height: 1.6;
    resize: none;
    overflow-y: hidden; /* 由 JS autoResize() 控制高度 */
    min-height: var(--input-min-h, 64px);
    max-height: var(--input-max-h, 140px);
    box-sizing: border-box;
    width: 100%;
  }
  #input:focus { outline: none; }
  #input:disabled { opacity: 0.6; }
  /* 工具条：模型选择 + 发送按钮 */
  #inputFooter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3, 8px);
    padding: 0 var(--sp-5, 12px) var(--sp-4, 10px);
    min-height: var(--input-footer-h, 32px);
    flex-shrink: 0;
    box-sizing: border-box;
  }

  /* ============ Components：模型选择器 ============
   * 约束：
   *   - 本组件以 L3 组件身份覆写 L2 面板（dropdown.ts）默认样式，
   *     用 !important 表达「高层级覆盖低层级」的架构意图（对齐令牌铁律例外）
   *   - 显式接管所有伪元素 → 保证只有 1 个箭头
   *   - 菜单强制 left:0（向右展开），禁止 right:0（向左溢出）
   *   - .model-picker 容器 flex:1 自适应填充 footer 空间
   * ================================================= */
  .model-picker {
    flex: 1 1 auto; /* 自适应填充 footer 空间 */
    min-width: 0;
  }
  /* 接管默认伪元素（清零），防止继承 dropdown 组件可能引入的箭头/圆点 */
  .model-picker .treedd__trigger::before,
  .model-picker .treedd__trigger::after {
    content: none !important;
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
  /* 触发按钮：实色胶囊，主动可见，基线严格对齐（L3 覆写 dropdown 默认图标按钮） */
  .model-picker .treedd__trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1, 4px);
    height: var(--control-h, 28px);
    width: 100%;
    min-width: 80px;
    padding: 0 var(--sp-4, 10px);
    box-sizing: border-box;
    border-radius: var(--radius, 6px);
    cursor: pointer;
    background: var(--surface-card, #252526);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    color: var(--text-primary, #cccccc);
    font-size: var(--font-md, 12px);
    line-height: 1;
    font-weight: 500;
    white-space: nowrap;
    overflow: visible; /* 由子 span.dd-model-name 负责截断 */
  }
  /* 模型名文本容器：负责截断，箭头（::after）不受影响 */
  .model-picker .treedd__trigger .dd-model-name {
    min-width: 0;      /* flex 收缩前提 */
    flex: 1 1 auto;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    line-height: 1;
  }
  /* 下拉箭头：flex-shrink:0 保证即使名称被截断也永远外露 */
  .model-picker .treedd__trigger::after {
    content: '▾' !important;
    display: inline-block !important;
    flex-shrink: 0;
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    margin-left: 2px;
  }
  .model-picker .treedd__trigger:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
    border-color: var(--border-focus, #0e639c);
  }
  /* 模型下拉菜单：向上弹出 + 左对齐（覆盖 dropdown 默认右对齐，
   * 避免菜单向右溢出面板右缘；!important 为 L3 覆写 L2 的架构意图） */
  .model-picker .treedd__menu {
    left: 0 !important;
    right: auto !important;
    top: auto !important;
    bottom: calc(100% + var(--sp-2, 6px));
    min-width: 200px;
    max-width: min(280px, calc(100vw - 32px));
    max-height: 260px;
    overflow-y: auto;
  }
  .model-picker .treedd__item.is-active {
    color: var(--accent, #0e639c);
    font-weight: 600;
  }
  .treedd__empty {
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    font-size: var(--font-md, 12px);
    color: var(--text-secondary, #9aa0a6);
    text-align: center;
  }

  /* ============ Components：发送按钮 ============ */
  .send-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--control-h, 28px); /* 与模型触发器同高，基线对齐 */
    height: var(--control-h, 28px);
    border-radius: 50%;
    border: none;
    background: var(--accent, #0e639c);
    color: var(--accent-foreground, #ffffff);
    cursor: pointer;
    transition: opacity 0.15s ease, filter 0.15s ease, transform 0.1s ease;
  }
  .send-btn:hover:not(.loading) { opacity: 0.92; filter: brightness(1.08); }
  .send-btn:active:not(.loading) { transform: scale(0.95); }
  .send-btn.loading { cursor: not-allowed; opacity: 0.85; }
  .send-btn .send-icon { display: block; }
  .send-btn.loading .send-icon { display: none; }
  .send-btn .send-spinner {
    display: none;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255,255,255,.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: sendSpin 0.7s linear infinite;
  }
  .send-btn.loading .send-spinner { display: block; }
  @keyframes sendSpin { to { transform: rotate(360deg); } }

  /* ============ Components：记忆条 / 主动提问条 ============ */
  /* 记忆条（想起/已沉淀） */
  .memory-bar {
    padding: var(--sp-1, 4px) var(--sp-5, 12px); font-size: var(--font-md, 12px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--vscode-inputValidation-infoBackground, rgba(21,126,251,.15));
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
    flex-shrink: 0;
  }
  /* 主动提问条 */
  #clarifyBar {
    display: none; flex-direction: column; gap: var(--sp-2, 6px); padding: var(--sp-3, 8px);
    border-top: 1px solid var(--vscode-charts-yellow, #d7ba7d);
    background: var(--vscode-inputValidation-warningBackground, rgba(196,160,0,.15));
    flex-shrink: 0;
  }
  #clarifyBar.visible { display: flex; }
  #clarifyText { font-size: var(--font-md, 12px); color: var(--vscode-descriptionForeground, #d7ba7d); }
  #clarifyRow { display: flex; gap: var(--sp-2, 6px); }
  #clarifyInput {
    flex: 1; padding: var(--sp-3, 8px); border-radius: var(--radius, 6px);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    background: var(--surface-input, #3c3c3c); color: var(--text-input, #cccccc);
  }
  #clarifyOptions { display: flex; flex-wrap: wrap; gap: var(--sp-2, 6px); }
  .opt-btn {
    padding: var(--sp-1, 4px) var(--sp-4, 10px); font-size: var(--font-md, 12px); border-radius: var(--radius-pill, 999px);
    border: 1px solid var(--vscode-charts-yellow, #d7ba7d);
    background: transparent; color: var(--vscode-descriptionForeground, #d7ba7d); cursor: pointer;
  }
  .opt-btn:hover { background: var(--vscode-inputValidation-warningBackground, rgba(196,160,0,.15)); }

  /* ============ Utilities：键盘焦点环（可访问性） ============ */
  /* 所有可交互控件：键盘 Tab 聚焦时显示品牌色外环。
   * 仅对 :focus-visible 生效（鼠标点击不显示，避免干扰）。
   * 下拉菜单项已在 dropdown.ts 用背景色替换 outline，不在此重复。 */
  .send-btn:focus-visible,
  .msg-copy:focus-visible,
  .opt-btn:focus-visible,
  .treedd__trigger:focus-visible,
  .model-picker .treedd__trigger:focus-visible,
  #clarifyInput:focus-visible {
    outline: 2px solid var(--border-focus, #0e639c);
    outline-offset: 2px;
  }

  /* ============ Utilities：减少动效（可访问性） ============ */
  /* 系统开启「减弱动态效果」时，关闭所有动画/过渡，避免眩晕 */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }
`;
