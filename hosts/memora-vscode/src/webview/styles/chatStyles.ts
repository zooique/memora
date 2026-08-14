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
    background: var(--surface-user-bubble);
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
    background: var(--feedback-error-bg);
    color: var(--feedback-error-fg);
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
    /* 高度由 JS autoResize() 控制；内容超过 --input-max-h 时内部滚动查看，
     * 避免 overflow hidden 把超限内容裁掉导致长输入不可见（对抗评估 P0-1） */
    overflow-y: auto;
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

  /* ============ Components：模型选择器（capsule 变体差异定制） ============
   * 通用胶囊外观已收敛到 dropdown.ts 的 .treedd--capsule 变体（一次定义，面板复用），
   * 消除面板各自覆写组件默认样式带来的重复 + !important（对抗评估 P2-2/P2-4）。
   * 本区块只做差异定制：宽度自适应模型名（对齐 Trae）+ 菜单尺寸 + 激活项高亮。
   * 面板通过 extraClass="model-picker treedd--capsule" 启用变体。 */
  .model-picker {
    flex: 0 0 auto; /* 宽度由内容决定，不撑满 footer */
    min-width: 0;
    /* 差异定制变量（capsule 变体读取）：超长模型名兜底省略 + 菜单尺寸 */
    --dd-trigger-max-w: 200px;
    --dd-menu-min-w: 200px;
    --dd-menu-max-w: 280px;
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

  /* ============ Components：历史会话选择器（toolbar，capsule 变体差异定制） ============
   * 精灵「按天归档 + 日期导航回溯」机制的插件版：与模型选择器同一胶囊视觉语言。
   * 通用外观在 dropdown.ts 的 .treedd--capsule 变体；此处仅定制胶囊圆角 + 次要
   * 文本色 + 菜单尺寸（对抗评估 P2-2/P2-4）。 */
  .history-picker {
    flex: 0 0 auto;
    min-width: 0;
    /* 差异定制变量（capsule 变体读取）：历史日期胶囊更紧凑 + 菜单尺寸 */
    --dd-trigger-max-w: 120px;
    --dd-menu-min-w: 160px;
    --dd-menu-max-w: 240px;
  }
  /* 历史胶囊圆角更圆（pill）+ 次要文本色（工具栏工具属性）。
   * 用 .history-picker.treedd--capsule 提高特异性，确保在 dropdown.ts 变体之后
   * 仍能覆盖（不依赖样式拼接顺序，也不用 !important） */
  .history-picker.treedd--capsule .treedd__trigger {
    border-radius: var(--radius-pill, 999px);
    color: var(--text-secondary, #9aa0a6);
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
  /* 生成中：按钮切换为「停止」方块（点击 = 停止当前生成，mvp-scope 打断能力）。
   * cursor 保持 pointer（可点击的停止语义），不再用 not-allowed 误导「不可点」 */
  .send-btn.loading { opacity: 0.9; }
  .send-btn .send-icon { display: block; }
  .send-btn .stop-icon { display: none; }
  /* loading 时图标切换：隐藏发送箭头，显示停止方块（语义：生成中此按钮 = 停止） */
  .send-btn.loading .send-icon { display: none; }
  .send-btn.loading .stop-icon { display: block; }

  /* ============ Components：角色徽章 / 提示条 ============ */
  /* 角色徽章（toolbar）：标题旁静态展示当前装配的角色包（doc-review），
   * 主动可见——用户始终知道当前对话由哪个角色驱动（功能→UI 对齐排雷 P1 第一波）。
   * 圆点 =「角色已激活」指示，用 accent 品牌色（与发送按钮同一身份标记）。
   * [hidden] 覆盖：display:inline-flex 会覆盖 HTML hidden 属性，需显式恢复。 */
  .role-pack-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1, 4px);
    height: var(--control-h, 28px);
    padding: 0 var(--sp-3, 8px);
    box-sizing: border-box;
    border-radius: var(--radius-pill, 999px);
    background: var(--surface-card, #252526);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-md, 12px);
    line-height: 1;
    white-space: nowrap;
  }
  .role-pack-badge::before {
    content: '';
    width: 6px; height: 6px; /* 装饰性圆点直径（非布局间距，铁律例外） */
    border-radius: 50%;
    background: var(--accent, #0e639c);
    flex-shrink: 0;
  }
  .role-pack-badge[hidden] { display: none; }

  /* 提示条（notice）：会话异常等错误级反馈独立于此条展示，不插入消息区，
   * 不污染对话历史（排雷雷-4 修正：错误级与 memoryBar 低扰语义分离）。
   * 分级：error 醒目（inputValidation error 色）、info 低扰（同 memoryBar 语义）。
   * [hidden] 覆盖：display:flex 会覆盖 HTML hidden 属性，需显式恢复。 */
  .notice-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    font-size: var(--font-md, 12px);
    line-height: 1.5;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
  }
  .notice-bar[hidden] { display: none; }
  .notice-bar.info {
    color: var(--text-secondary, #9aa0a6);
    background: var(--feedback-info-bg);
  }
  .notice-bar.error {
    color: var(--feedback-error-fg);
    background: var(--feedback-error-bg);
  }

  /* ============ Components：自审查轮提示（活动透明，交叉审核观察 A） ============ */
  /* Agent 自审查开始时插入的过程性反馈：轻量浅色条 + 呼吸圆点，让用户看见
   * 正在复核产出（agent-design-philosophy §13.x 可观察契约）。仅运行时显示。 */
  .self-review {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    font-size: var(--font-md, 12px); line-height: 1.5;
    color: var(--text-secondary, #9aa0a6);
    background: var(--feedback-info-bg);
    border-radius: var(--radius, 6px);
  }
  .self-review__dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--status-info, #3794ff);
    flex-shrink: 0;
    animation: selfReviewPulse 1.2s ease-in-out infinite;
  }
  @keyframes selfReviewPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  /* ============ Components：记忆条 / 主动提问条 ============ */
  /* 记忆条（想起/已沉淀） */
  .memory-bar {
    padding: var(--sp-1, 4px) var(--sp-5, 12px); font-size: var(--font-md, 12px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--feedback-info-bg);
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
    flex-shrink: 0;
  }
  /* 活动指标折叠区（P2：§13.x 透明面板 + §5.2.1 指纹可见） */
  .metrics-box {
    margin: var(--sp-3, 8px) var(--sp-5, 12px) 0; font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius, 6px);
    flex-shrink: 0;
  }
  .metrics-box summary {
    cursor: pointer; padding: var(--sp-2, 6px) var(--sp-3, 8px); user-select: none;
    outline: none; border-radius: inherit;
  }
  .metrics-box summary:focus-visible { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  .metrics-content {
    padding: 0 var(--sp-3, 8px) var(--sp-2, 6px); line-height: 1.7;
    white-space: pre-wrap; word-break: break-all;
  }

  /* 主动提问条 */
  #clarifyBar {
    display: none; flex-direction: column; gap: var(--sp-2, 6px); padding: var(--sp-3, 8px);
    border-top: 1px solid var(--feedback-warn-accent);
    background: var(--feedback-warn-bg);
    flex-shrink: 0;
  }
  #clarifyBar.visible { display: flex; }
  #clarifyText { font-size: var(--font-md, 12px); color: var(--feedback-warn-fg); }
  #clarifyRow { display: flex; gap: var(--sp-2, 6px); }
  #clarifyInput {
    flex: 1; padding: var(--sp-3, 8px); border-radius: var(--radius, 6px);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    background: var(--surface-input, #3c3c3c); color: var(--text-input, #cccccc);
  }
  #clarifyOptions { display: flex; flex-wrap: wrap; gap: var(--sp-2, 6px); }
  .opt-btn {
    padding: var(--sp-1, 4px) var(--sp-4, 10px); font-size: var(--font-md, 12px); border-radius: var(--radius-pill, 999px);
    border: 1px solid var(--feedback-warn-accent);
    background: transparent; color: var(--feedback-warn-fg); cursor: pointer;
  }
  .opt-btn:hover { background: var(--feedback-warn-bg); }

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
