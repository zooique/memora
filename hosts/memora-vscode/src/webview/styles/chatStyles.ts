/**
 * 对话打磨面板样式 — 对齐 Trae AI 对话面板的视觉语言（简洁、克制、主动可见）
 *
 * 分层（对齐 ui-engineering-mindset-rules.md + ITCSS）：
 *   - 设计令牌（间距/圆角/字号/阴影/颜色）由 tokens.ts 单一真理源提供，
 *     本文件只引用令牌，禁止裸值；
 *   - 分区遵循 ITCSS：Base（body）→ Layout（状态区/消息区/输入区）
 *     → Components（消息 / 输入卡片 / 模型选择器 / 发送按钮 / 状态条）；
 *     顶部标题栏已剪枝（视图标题栏 native 承载「对话」标题 + 清空/历史按钮）；
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
  /* 顶部工具栏已剪枝（视图标题栏 native 承载「对话」标题 + 清空/历史按钮），
   * 面板内不再有重复标题栏；body 直接进入状态区 → 消息区 → 输入区。
   * 消息区：全量铺开；z-index 设为 1（底层），输入区 z-index:20（上层承载浮层）——
   * 消除模型下拉菜单展开时「挤压对话区」的错觉：菜单是覆盖而非挤入布局。 */
  #messages {
    flex: 1; overflow-y: auto; padding: var(--sp-5, 12px); box-sizing: border-box;
    display: flex; flex-direction: column; gap: var(--sp-4, 10px);
    position: relative; z-index: 1;
  }

  /* ============ Components：消息 ============ */
  /* 空状态：克制的中性提示，垂直居中 */
  .empty-state {
    margin: auto; max-width: 320px; text-align: center;
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-base, 13px); line-height: 1.7;
    padding: var(--sp-6, 16px);
  }
  .empty-title { font-size: var(--font-lg, 14px); color: var(--text-primary, #cccccc); font-weight: 500; margin-bottom: var(--sp-1, 4px); }
  .empty-hint { margin-bottom: var(--sp-5, 12px); }
  /* 示例提问 chips：点击填入输入框（ui-redesign.md §6.1 空状态引导），主动引导新用户 */
  .empty-suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--sp-2, 6px); }
  .suggestion-chip {
    padding: var(--sp-1, 4px) var(--sp-4, 10px); font-size: var(--font-md, 12px);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    border-radius: var(--radius-pill, 999px);
    background: transparent; color: var(--text-secondary, #9aa0a6); cursor: pointer;
  }
  .suggestion-chip:hover { background: var(--surface-hover, rgba(128,128,128,.2)); color: var(--text-primary, #cccccc); }

  /* ============ Components：日期分隔线（跨天合并分组，ui-redesign.md §7.4） ============ */
  /* 跨天合并视图在日期交界插入弱化分隔：居中灰字 + 两侧细线，aria-hidden 装饰性。 */
  .date-divider {
    display: flex; align-items: center; gap: var(--sp-3, 8px);
    margin: var(--sp-2, 6px) 0;
    color: var(--text-secondary, #9aa0a6); font-size: var(--font-xs, 10px);
    letter-spacing: 0.5px; user-select: none;
  }
  .date-divider::before, .date-divider::after { content: ''; flex: 1; height: 1px; background: var(--border-panel, rgba(128,128,128,.4)); }
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
  /* AI 回答：顶部身份标签 + 正文铺满（对齐主流大厂 AI 对话设计）。
   * 结构：.msg.assistant → 纵向 [.msg-ai-label[角色/模型名]][.msg-content[正文+footer]]。
   * 不再用侧边头像（避免每条回复都挤占一行），改为顶部弱标签标「谁在说」，
   * 正文直接铺满宽度，信息密度更高（ui-redesign 迭代）。 */
  .msg.assistant {
    align-self: stretch;
    flex-direction: column; align-items: stretch; gap: var(--sp-1, 4px);
    background: transparent; color: var(--text-primary, #cccccc);
    padding-top: var(--sp-2, 6px);
  }
  /* AI 身份标签：顶部一行，展示角色显示名（加载角色包时）或默认「AI」；
   * 灰字小字号，弱于正文，仅作「谁在说」的轻量标注（对齐大厂 AI 消息头部）。 */
  .msg-ai-label {
    display: flex; align-items: center; gap: var(--sp-1, 4px);
    font-size: var(--font-sm, 11px); font-weight: 500;
    color: var(--text-secondary, #9aa0a6);
    user-select: none;
  }
  /* AI 正文容器：承接正文 + 底部操作行，铺满宽度 */
  .msg-content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
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
    position: relative; z-index: 20; /* 输入区层级高于消息区：下拉浮层正确覆盖而非挤压 */
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
  /* Composer 键盘提示：footer 左侧弱化提示 Enter 发送 / Shift+Enter 换行。
   * 对齐大厂 composer 的「轻提示」惯例，不喧宾夺主（ui-redesign.md §7.3）。 */
  .composer-hint {
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* Composer 右侧操作组：模型选择器 + 发送按钮，与左侧提示分组（space-between 布局） */
  .composer-actions { display: flex; align-items: center; gap: var(--sp-2, 6px); flex-shrink: 0; }
  /* Composer 联网能力 chip（alignment-iteration.md C1）：当前角色包声明 web:search 时显示，
   * 作为联网能力可见指示。次级按钮风格（复用 --btn-secondary-* 令牌），不喧宾夺主。 */
  .composer-chip {
    display: inline-flex; align-items: center; gap: var(--sp-1, 4px);
    height: var(--control-h, 28px); padding: 0 var(--sp-3, 8px); box-sizing: border-box;
    font-size: var(--font-md, 12px); line-height: 1;
    border-radius: var(--radius, 6px);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    background: transparent; color: var(--accent, #0e639c);
    cursor: default; flex-shrink: 0;
  }
  .composer-chip[hidden] { display: none; }

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
  /* ============ Components：身份条角色选择器（capsule 变体差异定制，alignment-iteration.md A3）
   * 复用模型选择器同款 capsule 变体，但触发器弱化为「角色名 + ▾ 文本」融入身份条一行：
   * 去背景/边框，仅保留文字色与箭头，不喧宾夺主（身份条本就高信息密度）。 */
  .role-picker {
    min-width: 0;
    flex-shrink: 1;
    /* 差异定制变量（capsule 变体读取）：角色名紧凑截断 + 菜单尺寸 */
    --dd-trigger-max-w: 120px;
    --dd-menu-min-w: 160px;
    --dd-menu-max-w: 220px;
  }
  .role-picker[hidden] { display: none; }
  .role-picker .treedd__trigger {
    background: transparent;
    border: none;
    color: var(--text-primary, #cccccc);
    font-weight: 500;
    font-size: var(--font-md, 12px);
    padding: 0;
    height: auto;
    line-height: 1.5;
  }
  .role-picker .treedd__trigger:hover {
    background: transparent;
    border-color: transparent;
    color: var(--accent, #0e639c);
  }
  .role-picker .treedd__trigger::after {
    color: var(--text-secondary, #9aa0a6);
    margin-left: var(--sp-0, 2px);
  }
  .role-picker .treedd__item.is-active {
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
  /* 生成中：按钮切换为「停止」方块（点击 = 停止当前生成，mvp-scope 打断能力）。
   * cursor 保持 pointer（可点击的停止语义），不再用 not-allowed 误导「不可点」 */
  .send-btn.loading { opacity: 0.9; }
  .send-btn .send-icon { display: block; }
  .send-btn .stop-icon { display: none; }
  /* loading 时图标切换：隐藏发送箭头，显示停止方块（语义：生成中此按钮 = 停止） */
  .send-btn.loading .send-icon { display: none; }
  .send-btn.loading .stop-icon { display: block; }

  /* ============ Components：身份条（改造 roleBar，ui-redesign.md §4.1 ①） ============ */
  /* 整合角色 / 模型 / 实时状态为一行，主动可见：用户始终知道当前对话由哪个角色、
   * 哪个模型驱动、是否在生成中。结构：.identity-bar → [.identity-avatar][.role-picker]
   * [.identity-model][.identity-status]（角色名由 role-picker 下拉承载，alignment-iteration.md A3）。
   * 头像 = 角色名首字 + 品牌弱化底；模型名超长省略；状态圆点 idle=灰 / thinking=品牌色呼吸。 */
  .identity-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-5, 12px);
    box-sizing: border-box;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
    font-size: var(--font-md, 12px);
    line-height: 1.5;
  }
  .identity-bar[hidden] { display: none; }
  .identity-avatar {
    width: 20px; height: 20px; border-radius: var(--radius, 6px);
    display: inline-flex; align-items: center; justify-content: center;
    background: var(--surface-ai-avatar, rgba(14,99,156,0.25));
    color: var(--accent-foreground, #ffffff);
    font-size: var(--font-sm, 11px); font-weight: 600;
    flex-shrink: 0; user-select: none;
  }
  
  .identity-model {
    color: var(--text-secondary, #9aa0a6); font-size: var(--font-sm, 11px);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .identity-status {
    margin-left: auto;
    display: inline-flex; align-items: center; gap: var(--sp-1, 4px);
    color: var(--text-secondary, #9aa0a6); font-size: var(--font-sm, 11px);
    flex-shrink: 0;
  }
  .identity-status::before {
    content: ''; width: 6px; height: 6px; border-radius: 50%; /* 状态圆点直径（动画细节，令牌例外） */
    background: var(--text-secondary, #9aa0a6); flex-shrink: 0;
  }
  /* 生成中：状态圆点转品牌色 + 呼吸（复用 selfReviewPulse，遵守 prefers-reduced-motion） */
  .identity-status[data-state="thinking"] { color: var(--accent, #0e639c); }
  .identity-status[data-state="thinking"]::before { background: var(--accent, #0e639c); animation: selfReviewPulse 1.2s ease-in-out infinite; }

  /* ============ Components：活动状态区 · 主状态条（P0 错误 / P1 低扰） ============ */
  /* 会话异常等错误级反馈 + 低扰 info 统一走单一主状态条（#activityBar），不插入消息区，
   * 不污染对话历史（排雷雷-4 修正）。错误显示期间低扰不打断（优先级保护）；被覆盖的
   * 提示进「活动详情」历史回溯（见下方 .activity-detail）。
   * 分级：error 醒目（inputValidation error 色）、info 低扰（同记忆语义）。
   * [hidden] 覆盖：display:flex 会覆盖 HTML hidden 属性，需显式恢复。 */
  .activity-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    font-size: var(--font-md, 12px);
    line-height: 1.5;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
  }
  .activity-bar[hidden] { display: none; }
  .activity-bar.info {
    color: var(--text-secondary, #9aa0a6);
    background: var(--feedback-info-bg);
  }
  .activity-bar.error {
    color: var(--feedback-error-fg);
    background: var(--feedback-error-bg);
  }

  /* ============ Components：思考折叠块（过程透明，ui-redesign.md §7.1） ============ */
  /* 生成中/自审查时展示的轻量折叠块：默认折叠，展开显示思考步骤。
   * 过程性反馈降级：灰字小字号 + 左细边框，与对话主体明显区分。不落库不重放。 */
  .thought-block {
    margin-top: var(--sp-2, 6px);
    font-size: var(--font-sm, 11px); line-height: 1.5;
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-thought, #252526);
    border-left: 2px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: 0 var(--radius, 6px) var(--radius, 6px) 0;
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
  }
  .thought-block summary {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    cursor: pointer; user-select: none; outline: none;
  }
  .thought-block summary:focus-visible { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  .thought-block__dot {
    width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
    background: var(--text-secondary, #9aa0a6);
  }
  /* 思考中：圆点转品牌色 + 呼吸（复用 selfReviewPulse，遵守 prefers-reduced-motion） */
  .thought-block.is-thinking .thought-block__dot { background: var(--accent, #0e639c); animation: selfReviewPulse 1.2s ease-in-out infinite; }
  .thought-block__body { margin-top: var(--sp-1, 4px); white-space: pre-wrap; word-break: break-word; }
  .thought-block[hidden] { display: none; }

  /* ============ Components：活动状态区 · 自审查轮提示（活动透明，交叉审核观察 A） ============ */
  /* Agent 自审查开始时插入的过程性反馈：轻量灰字 + 呼吸圆点，让用户看见
   * 正在复核产出（agent-design-philosophy §13.x 可观察契约）。仅运行时显示。
   * 过程性反馈降级（编排对齐）：无背景色，字号更小更灰，与对话主体明显区分。 */
  .self-review {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    font-size: var(--font-sm, 11px); line-height: 1.5;
    color: var(--text-secondary, #9aa0a6);
    background: transparent;
    border-left: 2px solid var(--border-panel, rgba(128,128,128,.4)); /* 中性细边框，不抢视觉 */
  }
  .self-review__dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--text-secondary, #9aa0a6); /* 灰点替代品牌蓝，降级为次要反馈 */
    flex-shrink: 0;
    animation: selfReviewPulse 1.2s ease-in-out infinite;
  }
  @keyframes selfReviewPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  /* ============ Components：活动状态区 · 详情折叠（历史 + 指标） ============ */
  /* 活动详情折叠区：历史记录（error 标红 / info 灰显，带时间戳）+ 指标块。
   * 被主状态条覆盖的提示不丢失，全部在此回溯（有界 MAX_ACTIVITY_HISTORY 条）。 */
  .activity-detail {
    margin: var(--sp-3, 8px) var(--sp-5, 12px) 0; font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius, 6px);
    flex-shrink: 0;
  }
  .activity-detail summary {
    cursor: pointer; padding: var(--sp-2, 6px) var(--sp-3, 8px); user-select: none;
    outline: none; border-radius: inherit;
  }
  .activity-detail summary:focus-visible { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  .activity-list { padding: 0 var(--sp-3, 8px) var(--sp-2, 6px); }
  .activity-list__row {
    display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3, 8px);
    padding: var(--sp-1, 4px) 0; line-height: 1.6;
  }
  .activity-list__row.error { color: var(--feedback-error-fg); }
  .activity-list__time {
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
    flex-shrink: 0;
  }
  .activity-metrics {
    padding: 0 var(--sp-3, 8px) var(--sp-2, 6px); line-height: 1.7;
    white-space: pre-wrap; word-break: break-all;
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
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
  .suggestion-chip:focus-visible,
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
