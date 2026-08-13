/**
 * 对话打磨面板样式 — 对齐 Trae AI 对话面板的视觉语言（简洁、克制、主动可见）
 *
 * 说明：
 *   - 全部使用 --vscode-* 语义变量（带合理降级默认值），亮/暗主题自适应，禁止硬编码颜色；
 *   - 引入统一设计刻度（间距 4/6/8/10/12/16、圆角 6/8、字号 10/11/12/13），保证全插件一致；
 *   - 操作按钮（复制等）「主动可见」，避免 hover-only；
 *   - 下拉菜单样式见 dropdown.ts（scoped 到 .treedd），工具卡片见 toolCard.ts，此处为面板整体布局。
 */
export const chatStyles = `
  :root {
    color-scheme: light dark;
    /* 设计刻度：间距 / 圆角 / 字号（全插件统一，与 configStyles.ts 一致） */
    --sp-1: 4px;  --sp-2: 6px;  --sp-3: 8px;
    --sp-4: 10px; --sp-5: 12px; --sp-6: 16px;
    --radius: 6px; --radius-lg: 8px;
    --font-xs: 10px; --font-sm: 11px; --font-md: 12px; --font-base: 13px;
  }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0;
    display: flex; flex-direction: column;
    height: 100vh; box-sizing: border-box;
    font-size: var(--font-base, 13px);
    background: var(--vscode-editor-background, #1e1e1e);
    color: var(--vscode-foreground, #cccccc);
  }
  /* 顶部工具栏：标题 + 右侧紧凑工具（下拉） */
  #toolbar {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-5, 12px);
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
    flex-shrink: 0;
  }
  #toolbar .title { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 消息区：全量铺开 */
  #messages {
    flex: 1; overflow-y: auto; padding: var(--sp-5, 12px); box-sizing: border-box;
    display: flex; flex-direction: column; gap: var(--sp-4, 10px);
  }
  /* 空状态：克制的中性提示，垂直居中 */
  .empty-state {
    margin: auto; max-width: 320px; text-align: center;
    color: var(--vscode-descriptionForeground, #9aa0a6);
    font-size: var(--font-base, 13px); line-height: 1.7;
    padding: var(--sp-6, 16px);
  }
  /* 消息基类：默认无气泡（AI 铺满），正文与底部操作行分离 */
  .msg { display: flex; flex-direction: column; white-space: pre-wrap; word-break: break-word; line-height: 1.6; }
  /* 用户消息：右侧浅灰气泡（轻量身份标记） */
  .msg.user {
    align-self: flex-end; max-width: 85%;
    background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.2));
    color: var(--vscode-foreground, #cccccc);
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    border-radius: var(--radius-lg, 8px) var(--radius-lg, 8px) 2px var(--radius-lg, 8px);
  }
  /* AI 回答：无气泡，内容全量铺开，顶部细线区分 */
  .msg.assistant {
    align-self: stretch;
    background: transparent; color: var(--vscode-foreground, #cccccc);
    padding-top: var(--sp-3, 8px);
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
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
  .msg-time { font-size: var(--font-xs, 10px); color: var(--vscode-descriptionForeground, #9aa0a6); }
  .msg-copy {
    padding: 2px var(--sp-2, 6px); font-size: var(--font-sm, 11px);
    border: none; border-radius: var(--radius, 6px);
    background: transparent; color: var(--vscode-descriptionForeground, #9aa0a6);
    cursor: pointer;
  }
  .msg-copy:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2));
    color: var(--vscode-foreground, #cccccc);
  }
  /* ============================================================
   * 底部输入区：SSOT 单层卡片结构（单一视觉源）
   *
   * 设计原则（SSOT）：
   *   - 只有 #inputWrap 承担视觉（边框+圆角+阴影+背景）
   *   - #inputBar 仅做布局容器（padding + flex-shrink），无任何视觉属性
   *   - 禁止双层嵌套感：视觉属性只能集中在一层
   *
   * 结构：
   *   #inputBar  →  纯布局容器（四边 padding，无视觉）
   *   #inputWrap →  唯一视觉卡片（边框 + 圆角 + 阴影 + 背景）
   *   #input     →  textarea（占主空间）
   *   #inputFooter → 工具条（模型选择 + 发送按钮）
   * ============================================================ */

  /* 布局容器：纯布局，无视觉属性（剪枝掉 shadow/radius 等视觉） */
  #inputBar {
    border-top: none;
    flex-shrink: 0;
    background: transparent;
    padding-bottom: 12px;
  }

  /* 唯一视觉卡片：边框 + 圆角 + 阴影 + 背景（全部集中在此） */
  #inputWrap {
    display: flex;
    flex-direction: column;
    min-height: 96px;
    /* SSOT: 唯一视觉属性 —— 边框 */
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.5));
    /* SSOT: 唯一视觉属性 —— 圆角（14px，四边一致） */
    border-radius: 14px;
    /* SSOT: 唯一视觉属性 —— 背景 */
    background: var(--vscode-input-background, #3c3c3c);
    /* SSOT: 唯一视觉属性 —— 悬浮阴影（暗示浮起） */
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
    position: relative; /* SSOT: 下拉菜单定位以此为基准 */
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
    overflow: visible;
  }
  /* 聚焦态：边框色变品牌色 + 阴影加深 */
  #inputWrap:focus-within {
    border-color: var(--vscode-focusBorder, #0e639c);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25), 0 0 0 2px rgba(14, 99, 156, 0.35);
  }

  /* textarea：占主空间，无独立边框，与卡片融合 */
  #input {
    flex: 1;
    /* SSOT 间距：上16 左右16 下8（与 footer 融合无断层） */
    padding: 16px 16px 8px;
    border: none;
    background: transparent;
    color: var(--vscode-input-foreground, #cccccc);
    font-family: inherit;
    font-size: 13px;
    line-height: 1.6;
    resize: none;
    overflow-y: hidden; /* 禁止原生滚动条占位；由 JS autoResize() 控制高度 */
    /* SSOT: textarea 最小 64px → 占总高 65%，真正的主空间 */
    min-height: 64px;
    max-height: 140px; /* 比之前 120 更宽容，多行场景不憋屈 */
    box-sizing: border-box;
    width: 100%;
  }
  #input:focus { outline: none; }
  #input:disabled { opacity: 0.6; }

  /* footer：紧凑工具条，与 textarea 顶部零间距融合 */
  #inputFooter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    /* SSOT 间距：上0（与textarea融合） 左右12 下10（卡片底边呼吸） */
    padding: 0 12px 10px;
    /* SSOT: 工具条高度 32px → 占总高 33%，紧凑不抢眼 */
    min-height: 32px;
    flex-shrink: 0;
    box-sizing: border-box;
  }

  /* ============================================================
   * 模型选择器：左对齐控件
   * 约束：
   *   - 显式 reset 所有伪元素 → 保证只有 1 个箭头
   *   - 菜单强制 left:0（向右展开），禁止 right:0（向左溢出）
   *   - .model-picker 容器 flex:1 自适应填充 footer 空间
   * ============================================================ */
  /* .model-picker 下拉容器：作为 footer 的 flex 子元素，自适应填充空间 */
  .model-picker {
    flex: 1 1 auto; /* 自适应填充 footer 空间，给模型名最大显示宽度 */
    min-width: 0; /* flex 收缩前提：允许被压缩 */
  }
  /* Step 1: 彻底清零默认组件伪元素，防止双箭头/双圆点 */
  .model-picker .treedd__trigger::before,
  .model-picker .treedd__trigger::after {
    content: none !important;
    display: none !important;
    width: 0 !important;
    height: 0 !important;
  }
  /* Step 2: trigger 本身：实色胶囊，主动可见，基线严格对齐 */
  .model-picker .treedd__trigger {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 28px; /* SSOT: 触发器高度 = 28px（与发送按钮同高，基线对齐） */
    /* SSOT 宽度：自适应填充 .model-picker 容器 */
    width: 100%;
    min-width: 80px;
    padding: 0 10px;
    box-sizing: border-box;
    border-radius: 6px;
    cursor: pointer;
    /* 不用 color-mix（旧Chromium不兼容），用VSCode原生 widget 背景语义变量 */
    background: var(--vscode-editorWidget-background, #252526);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.5));
    color: var(--vscode-foreground, #cccccc);
    font-size: 12px;
    line-height: 1;
    font-weight: 500;
    /* SSOT: overflow 在 trigger 本身关闭！由子 span.dd-model-name 负责截断，
       保证 ::after 箭头永远不被挤掉/裁掉 */
    white-space: nowrap;
    overflow: visible;
  }
  /* 模型名文本容器：负责截断，箭头（::after）不受影响 */
  .model-picker .treedd__trigger .dd-model-name {
    min-width: 0;      /* flex 收缩前提：必须设 min-width:0 才能被压缩 */
    flex: 1 1 auto;    /* 允许撑开，允许收缩 */
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    line-height: 1;
  }
  /* Step 3: 唯一箭头 — 放在 ::after，flex-shrink:0 永远不被裁、不消失 */
  .model-picker .treedd__trigger::after {
    content: '▾' !important;
    display: inline-block !important;
    flex-shrink: 0; /* SSOT: 禁止被裁掉 */
    font-size: 10px;
    color: var(--vscode-descriptionForeground, #9aa0a6);
    margin-left: 2px;
  }
  .model-picker .treedd__trigger:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2));
    border-color: var(--vscode-focusBorder, #0e639c);
  }

  /* ============================================================
   * 模型下拉菜单：向上弹出 + 左对齐（根因修复「戳到外面」）
   * dropdownStyles 默认：right:0（菜单右对齐触发器）
   * 模型选择器在最左侧，右对齐会向左溢出 → 覆盖为 left:0 向右展开
   * ============================================================ */
  .model-picker .treedd__menu {
    /* 定位方向：左对齐触发器，向右展开，不会溢出输入容器左边界 */
    left: 0 !important;
    right: auto !important;
    /* 弹出方向：从触发器顶部向上，避免从输入框底部戳出到输入区下方的面板外 */
    top: auto !important;
    bottom: calc(100% + 6px); /* 与触发器间距 6px */
    /* 宽度：最少 200px，最多 280px 或视口减安全边距，窄屏不戳出去 */
    min-width: 200px;
    max-width: min(280px, calc(100vw - 32px));
    max-height: 260px;
    overflow-y: auto;
  }
  .model-picker .treedd__item.is-active {
    color: var(--vscode-button-background, #0e639c);
    font-weight: 600;
  }
  .treedd__empty {
    padding: 8px 10px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, #9aa0a6);
    text-align: center;
  }

  /* ============================================================
   * 发送按钮：28x28 圆形，右侧锚定
   * ============================================================ */
  .send-btn {
    flex-shrink: 0; /* SSOT: 永远不被压缩 */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px; /* SSOT: 与模型触发器同高，基线对齐 */
    height: 28px;
    border-radius: 50%;
    border: none;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #ffffff);
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
  /* 记忆条（想起/已沉淀） */
  .memory-bar {
    padding: var(--sp-1, 4px) var(--sp-5, 12px); font-size: var(--font-md, 12px);
    color: var(--vscode-descriptionForeground, #9aa0a6);
    background: var(--vscode-inputValidation-infoBackground, rgba(21,126,251,.15));
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4));
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
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.5));
    background: var(--vscode-input-background, #3c3c3c); color: var(--vscode-input-foreground, #cccccc);
  }
  #clarifyOptions { display: flex; flex-wrap: wrap; gap: var(--sp-2, 6px); }
  .opt-btn {
    padding: var(--sp-1, 4px) var(--sp-4, 10px); font-size: var(--font-md, 12px); border-radius: 999px;
    border: 1px solid var(--vscode-charts-yellow, #d7ba7d);
    background: transparent; color: var(--vscode-descriptionForeground, #d7ba7d); cursor: pointer;
  }
  .opt-btn:hover { background: var(--vscode-inputValidation-warningBackground, rgba(196,160,0,.15)); }
`;
