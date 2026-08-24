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
  /* 一键到底按钮（吸收养分：对齐 TRAE App「上滚后回到底部」）：
   * 用户上滚离开底部时浮现于消息区右下角，点击回到底部后隐藏。
   * 圆形次级按钮：半透明表面 + 边框，不抢消息主体；z-index 高于消息、低于输入区。 */
  .scroll-to-bottom {
    position: absolute; right: var(--sp-4, 10px); bottom: var(--sp-4, 10px);
    z-index: 5;
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0;
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    border-radius: 50%;
    background: var(--surface-input, #3c3c3c);
    color: var(--text-secondary, #9aa0a6);
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0,0,0,.15));
    cursor: pointer;
  }
  .scroll-to-bottom:hover { color: var(--text-primary, #cccccc); }
  .scroll-to-bottom[hidden] { display: none; }

  /* ============ Components：会话标题条（ADR-024 会话标题层） ============ */
  /* 顶部一条：主动可见展示当前会话标题，让用户始终识别「我在哪个会话」；
   * 灰字小字号 + 左侧细竖线（会话语义，与 memory-tag 同语言），不挤占消息区；
   * flex 非缩放：宽度铺满、高度自适应单行，置于消息区上方。 */
  .session-title-bar {
    display: flex; align-items: center;
    padding: var(--sp-2, 6px) var(--sp-5, 12px);
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
    background: var(--surface-page, #1e1e1e);
    flex: 0 0 auto;
  }
  .session-title-bar__text {
    font-size: var(--font-sm, 11px); font-weight: 500;
    color: var(--text-secondary, #9aa0a6);
    border-left: 2px solid var(--border-panel, rgba(128,128,128,.4));
    padding-left: var(--sp-2, 6px);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    user-select: none;
  }
  /* 会话标题条按钮组（2026-08-17 会话管理重构）：改名笔 + 新建「＋」+ 历史，
   * 会话导航全量收敛到标题条；spacer 把按钮组推向右端（对齐 Trae 右上角历史入口） */
  .session-title-bar__btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; margin-left: var(--sp-1, 4px);
    padding: 0; border: none; border-radius: var(--radius-sm, 2px);
    background: transparent; color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
  }
  .session-title-bar__btn:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
    color: var(--text-primary, #cccccc);
  }
  .session-title-bar__spacer { flex: 1 1 auto; }

  /* ============ Components：历史记录下拉（2026-08-17 会话管理重构 v2） ============ */
  /* 复用 treedd 下拉组件（SSOT 剪枝：替代自造的居中 overlay/modal——原 modal 的
   * display:flex 覆盖 hidden 属性导致「关不掉 + 遮罩常驻」bug，见 v1 教训）。
   * 紧挨标题条历史按钮下方弹出（treedd 绝对定位浮层），无遮罩、轻量；
   * 条目富内容：标题 + 相对时间 + 悬浮垃圾桶（删除 hover 复用 --status-fail 令牌）。 */
  .session-history .treedd__trigger {
    width: 20px; height: 20px; margin-left: var(--sp-1, 4px); /* 对齐标题条按钮组尺寸 */
  }
  .session-history .treedd__menu {
    min-width: 240px; max-width: min(280px, calc(100vw - 24px));
    max-height: 280px; overflow-y: auto;
  }
  .session-history .treedd__item {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
  }
  .session-history__item-title {
    flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .session-history__item-time {
    flex: 0 0 auto; font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
  }
  .session-history__item-del {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; padding: 0; border: none; border-radius: var(--radius-sm, 2px);
    background: transparent; color: var(--text-secondary, #9aa0a6); cursor: pointer;
    opacity: 0; transition: opacity .15s ease; /* 悬浮条目才显示（对齐 Trae 悬浮删除） */
  }
  .session-history .treedd__item:hover .session-history__item-del { opacity: 1; }
  .session-history__item-del:hover { color: var(--status-fail, #b3261e); }
  .session-history__empty {
    padding: var(--sp-4, 10px); text-align: center;
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
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
  /* Follow-up 建议块（T2，2026-08-17 回复后关联推荐）：AI 回复下方「接下来可以探索」，
     chips 与空状态示例共用 .suggestion-chip（左对齐，区别于空状态居中） */
  .followup { padding: var(--sp-1, 4px) var(--sp-2, 6px) var(--sp-5, 12px); }
  .followup__caption { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); margin-bottom: var(--sp-2, 6px); letter-spacing: 0.3px; }
  .followup__chips { display: flex; flex-wrap: wrap; gap: var(--sp-2, 6px); }

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

  /* ============ Components：AI 回复 Markdown 渲染（吸收养分，2026-08-16） ============
   * 大厂对话流（ChatGPT / Claude / Trae）均以 Markdown 渲染 AI 回复，代码块/列表/表格可读。
   * 流式期间纯文本 + 光标 ▋（is-streaming：pre-wrap 保真换行 + 末尾闪烁光标），
   * 流结束后渲染 markdown 用 normal（markdown 自身处理换行）。表格 display:block + 横向
   * 滚动防撑爆气泡（pure CSS 降维，不写复杂正表格补全）。 */
  .msg.assistant .msg-body { white-space: normal; }
  /* 流式期间 body 已按 markdown 增量渲染（非纯文本），white-space 保持 normal 由
   * markdown 自行控制换行；is-streaming 仅承载末尾闪烁光标。 */
  .msg.assistant .msg-body.is-streaming { white-space: normal; }
  /* 流式光标：只在 bubble 末尾显示闪烁块 ▋，指示内容正在生成（Claude 风格，最便宜的"活着"信号） */
  .msg-body.is-streaming::after {
    content: '▋';
    display: inline-block; vertical-align: text-bottom;
    margin-left: 2px; color: var(--accent, #0e639c);
    animation: streamCaret 1s step-end infinite;
  }
  @keyframes streamCaret { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
  .msg.assistant .msg-body p { margin: 0 0 var(--sp-3, 8px); }
  .msg.assistant .msg-body > :last-child { margin-bottom: 0; }
  .msg.assistant .msg-body h1,
  .msg.assistant .msg-body h2,
  .msg.assistant .msg-body h3 { font-weight: 600; line-height: 1.4; margin: var(--sp-4, 10px) 0 var(--sp-2, 6px); }
  .msg.assistant .msg-body h1 { font-size: var(--font-lg, 14px); }
  .msg.assistant .msg-body h2 { font-size: var(--font-base, 13px); }
  .msg.assistant .msg-body h3 { font-size: var(--font-base, 13px); }
  .msg.assistant .msg-body ul,
  .msg.assistant .msg-body ol { padding-left: var(--sp-6, 16px); margin: 0 0 var(--sp-3, 8px); }
  .msg.assistant .msg-body li { margin: var(--sp-1, 4px) 0; }
  .msg.assistant .msg-body a { color: var(--accent, #0e639c); text-decoration: none; }
  .msg.assistant .msg-body a:hover { text-decoration: underline; }
  /* 行内代码 */
  .msg.assistant .msg-body code {
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 0.92em;
    background: var(--surface-code, rgba(0, 0, 0, 0.08));
    padding: 1px 4px; border-radius: var(--radius-sm, 2px);
  }
  /* 代码块：横向滚动防撑爆，独立底色 */
  .msg.assistant .msg-body pre {
    background: var(--surface-code, rgba(0, 0, 0, 0.08));
    border: 1px solid var(--border-panel, rgba(128, 128, 128, .4));
    border-radius: var(--radius, 6px);
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    overflow-x: auto; margin: 0 0 var(--sp-3, 8px);
    white-space: pre;
  }
  .msg.assistant .msg-body pre code { background: transparent; padding: 0; font-size: var(--font-md, 12px); }
  /* 代码块增强（吸收养分：对齐 TraeWork 代码块「语言标签 + 一键复制」）：
   * renderMarkdown 后由 enhanceCodeBlocks 把每个 <pre> 包装为 .code-block，
   * header（语言名 + 复制按钮）置顶，与下方 pre 连成一体圆角容器。 */
  .code-block { margin: 0 0 var(--sp-3, 8px); }
  .code-block__header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
    background: var(--surface-code, rgba(0, 0, 0, 0.08));
    border: 1px solid var(--border-panel, rgba(128, 128, 128, .4));
    border-bottom: none; border-radius: var(--radius, 6px) var(--radius, 6px) 0 0;
    user-select: none;
  }
  .code-block__header + pre { margin: 0; border-radius: 0 0 var(--radius, 6px) var(--radius, 6px); }
  .code-block__lang { font-family: ui-monospace, Consolas, monospace; }
  .code-block__copy {
    padding: var(--sp-0, 2px) var(--sp-2, 6px); font-size: var(--font-sm, 11px);
    border: none; border-radius: var(--radius-sm, 2px);
    background: transparent; color: var(--text-secondary, #9aa0a6); cursor: pointer;
  }
  .code-block__copy:hover { background: var(--surface-hover, rgba(128,128,128,.2)); color: var(--text-primary, #cccccc); }
  /* 表格防爆：display:block + 内部横向滚动，死活不让撑爆气泡 */
  .msg.assistant .msg-body table {
    display: block; width: 100%; overflow-x: auto;
    border-collapse: collapse; margin: 0 0 var(--sp-3, 8px);
  }
  .msg.assistant .msg-body th,
  .msg.assistant .msg-body td {
    border: 1px solid var(--border-panel, rgba(128, 128, 128, .4));
    padding: var(--sp-2, 6px) var(--sp-3, 8px); text-align: left;
  }
  .msg.assistant .msg-body th { font-weight: 600; background: var(--surface-hover, rgba(128, 128, 128, .2)); }
  /* 引用块 */
  .msg.assistant .msg-body blockquote {
    margin: 0 0 var(--sp-3, 8px);
    padding-left: var(--sp-3, 8px);
    border-left: 2px solid var(--border-panel, rgba(128, 128, 128, .4));
    color: var(--text-secondary, #9aa0a6);
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
  /* 润色按钮（H5 文本润色入口，2026-08-23）：用户消息专属，调用内核润色服务。
   * 与复制按钮同尺寸，用强调色区分（--accent），润色中态用 opacity 降提示。
   * 复用现有语义令牌 --accent，不新增冗余 token。 */
  .msg-polish {
    padding: var(--sp-0, 2px) var(--sp-2, 6px); font-size: var(--font-sm, 11px);
    border: none; border-radius: var(--radius, 6px);
    background: transparent; color: var(--accent, #007acc);
    cursor: pointer;
  }
  .msg-polish:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
    color: var(--accent, #007acc);
  }
  .msg.polishing .msg-polish { opacity: .7; pointer-events: none; }
  .msg-polish:focus-visible {
    outline: 2px solid var(--border-focus, #0e639c);
    outline-offset: 2px;
  }
  /* 删除按钮（2026-08-16 对话闭环管理）：危险操作，文字用错误色标识破坏性。
   * 与复制同尺寸，hover 时错误色背景更明显；禁用态灰显（无 timestamp 锚点时不可删）。
   * 复用现有语义令牌 --status-fail（错误前景）+ --feedback-error-bg（错误背景），不新增冗余 token。 */
  .msg-delete {
    padding: var(--sp-0, 2px) var(--sp-2, 6px); font-size: var(--font-sm, 11px);
    border: none; border-radius: var(--radius, 6px);
    background: transparent; color: var(--status-fail, #b3261e);
    cursor: pointer;
  }
  .msg-delete:hover:not(:disabled) {
    background: var(--feedback-error-bg, rgba(180, 40, 30, .14));
    color: var(--status-fail, #b3261e);
  }
  .msg-delete:disabled { color: var(--text-secondary, #9aa0a6); cursor: default; opacity: .5; }
  /* P1（2026-08-15 记忆附着可见）：AI 回复底部「基于 N 条记忆」弱标签。
   * 灰字小字号 + 左侧细竖线（记忆语义），主动可见不打扰；
   * margin-right:auto 使其靠左（信息性标签），复制/时间戳保持靠右（footer 为 flex-end）。 */
  .memory-tag {
    margin-right: auto;
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    border-left: 2px solid var(--border-panel, rgba(128,128,128,.4));
    padding-left: var(--sp-2, 6px);
    user-select: none;
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
    min-height: var(--input-wrap-min-h, 128px);
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
    /* 高度由 JS autoResize() 控制；默认 hidden 避免空内容时显示滚动条轨道，
     * 内容超过 --input-max-h 时 JS 切换为 auto 才显示滚动条（大厂惯例） */
    overflow-y: hidden;
    min-height: var(--input-min-h, 72px);
    max-height: var(--input-max-h, 180px);
    box-sizing: border-box;
    width: 100%;
  }
  #input:focus { outline: none; }
  #input:disabled { opacity: 0.6; }
  /* 工具条（两行布局）：Actions 行（模型+发送）+ Context 行（角色+能力徽章）
   * 对齐 visual-design-philosopher 三层分类法：一级直面 vs 次级收纳物理隔离。 */
  #inputFooter {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1, 4px);
    padding: var(--sp-2, 6px) var(--sp-5, 12px) var(--sp-3, 8px);
    flex-shrink: 0;
    box-sizing: border-box;
  }
  /* Composer Row 基类：两行共享的 padding/spacing 契约 */
  .composer-row {
    display: flex;
    align-items: center;
    width: 100%;
  }
  /* Row 1 · 一级直面：Actions 行 — 右对齐，操作独占整行 */
  .composer-row--actions { justify-content: flex-end; }
  /* Row 2 · 次级收纳：Context 行 — 左对齐，身份信息弱化展示 */
  .composer-row--context { min-height: var(--composer-context-h, 24px); }
  /* Composer Actions：模型选择器 + 发送按钮 */
  .composer-actions { display: flex; align-items: center; gap: var(--sp-2, 6px); flex-shrink: 0; }
  /* Composer Context：角色徽章 + 能力徽章容器（从旧 .composer-left 重命名，保持语义） */
  .composer-context {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    min-width: 0;
  }
  /* Composer 键盘提示（已独立到 composer-row--context 行，保留样式供未来扩展） */
  .composer-hint {
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  /* Composer 当前角色只读徽章：胶囊 + accent 圆点，展示当前角色名让用户感知定位。
   * 只读不承载切换（切换入口在「角色」视图）；textContent 赋值防注入（chatView 更新）。 */
  .role-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1, 4px);
    max-width: 140px;
    padding: 1px var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-code, rgba(128,128,128,.12));
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
  }
  .role-badge::before {
    content: '';
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--accent, #0e639c);
    flex-shrink: 0;
  }
  .role-badge[hidden] { display: none; }
  /* Phase 4 E2：工具权限徽章（与角色徽章并列，展示工具模式与能力列表） */
  .capability-badge {
    display: inline-flex;
    align-items: center;
    max-width: 160px;
    padding: 1px var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    color: var(--accent, #0e639c);
    background: rgba(14, 99, 156, 0.08);
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
  }
  .capability-badge[hidden] { display: none; }

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
  /* A2（2026-08-24）：activityBar 操作按钮（框架就绪，宿主暂未接入可重试错误） */
  .activity-bar__text { flex: 1 1 auto; }
  .activity-bar__action {
    flex-shrink: 0;
    padding: 1px var(--sp-2, 6px);
    font-size: var(--font-sm, 11px);
    color: var(--accent, #0e639c);
    background: transparent;
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius, 6px);
    cursor: pointer;
  }
  .activity-bar__action:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
  }

  /* ============ Components：断点续跑提示条（G3，2026-08-23） ============ */
  /* 检测到持久化暂停检查点时插入消息区顶部的提示条：文本 + 「从断点续跑」按钮 + 关闭。
   * 低扰 info 语义（同活动条），但常驻消息区顶部，用户可选择续跑或关闭。 */
  .checkpoint-banner {
    display: flex;
    align-items: center;
    gap: var(--sp-3, 8px);
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    font-size: var(--font-md, 12px);
    line-height: 1.5;
    color: var(--text-secondary, #9aa0a6);
    background: var(--feedback-info-bg);
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
  }
  .checkpoint-banner-text { flex: 1; }
  .checkpoint-banner-btn {
    flex-shrink: 0;
    padding: var(--sp-1, 4px) var(--sp-4, 10px);
    font-size: var(--font-sm, 11px);
    color: var(--accent-foreground, #ffffff);
    background: var(--accent, #0e639c);
    border: none;
    border-radius: var(--radius, 6px);
    cursor: pointer;
    white-space: nowrap;
  }
  .checkpoint-banner-btn:hover { filter: brightness(1.1); }
  .checkpoint-banner-btn:focus-visible,
  .checkpoint-banner-close:focus-visible { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 2px; }
  .checkpoint-banner-close {
    flex-shrink: 0;
    padding: 0 var(--sp-1, 4px);
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .checkpoint-banner-close:hover { color: var(--text-primary, #cccccc); }

  /* ============ Components：任务看板（H4 任务驱动多步闭环，2026-08-23） ============ */
  /* LLM 调用 task_table_write/update 建表时插入消息区顶部的计划进度看板：标题（N/M 完成）
   * + 步骤列表。只读展示内核 checkpoint.plan，状态色复用 trace-step 约定
   * （done=--status-pass 完成 / active=--accent 进行中 / blocked=--status-fail / pending=次级灰）。
   * P2-A（2026-08-24）：加 accent 左边框，与 thought-block（纯背景）形成视觉区分——
   * 用户一眼区分「任务进度」和「思考过程」，避免过程透明升级为内容主体。 */
  .plan-board {
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    font-size: var(--font-md, 12px);
    line-height: 1.6;
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-card, #252526);
    border-bottom: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-left: 3px solid var(--accent, #0e639c);
  }
  .plan-board-header {
    font-weight: 600;
    color: var(--text-primary, #cccccc);
    margin-bottom: var(--sp-2, 6px);
  }
  .plan-board-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .plan-step { display: flex; align-items: baseline; gap: var(--sp-2, 6px); }
  .plan-step-done { color: var(--status-pass, #4ec9b0); text-decoration: line-through; }
  .plan-step-active { color: var(--accent, #0e639c); font-weight: 500; }
  .plan-step-blocked { color: var(--status-fail, #b3261e); }
  /* pending：默认次级灰（继承 .plan-board 的 text-secondary，无需额外规则） */

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
  /* P2（2026-08-15 执行轨迹）：思考折叠块 body 内的三阶段轨迹（✓ 完成 / ● 进行中 / ○ 待执行）。
   * 完成(--status-pass) / 进行中(--accent 品牌色呼吸) / 待执行(次级灰)。
   * 轻量行式列表，延续思考块的降级视觉（灰字小字号、不抢主体）。 */
  .thought-block__trace {
    margin-top: var(--sp-2, 6px);
    display: flex; flex-direction: column; gap: var(--sp-1, 4px);
  }
  .trace-step {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    font-size: var(--font-sm, 11px); line-height: 1.5;
    color: var(--text-secondary, #9aa0a6);
  }
  .trace-step__mark { display: inline-flex; width: 12px; justify-content: center; flex-shrink: 0; font-size: var(--font-sm, 11px); }
  .trace-step.done { color: var(--status-pass, #4ec9b0); }
  .trace-step.done .trace-step__mark { color: var(--status-pass, #4ec9b0); }
  .trace-step.active { color: var(--text-primary, #cccccc); }
  .trace-step.active .trace-step__mark { color: var(--accent, #0e639c); animation: selfReviewPulse 1.2s ease-in-out infinite; }
  .trace-step.pending { color: var(--text-secondary, #9aa0a6); }

  /* ============ Components：活动状态区 · 自审查轮提示（活动透明，交叉审核观察 A） ============ */
  /* Agent 自审查开始时插入的过程性反馈：轻量灰字 + 呼吸圆点，让用户看见
   * 正在复核产出（agent-design-philosophy §13.x 可观察契约）。仅运行时显示。
   * P2-B（2026-08-24）：加 feedback-info-bg 背景锚点——透明背景让自审查指示在消息流中
   * 几乎不可见，用户错过「AI 正在复核」的信任信号。低对比度 info 背景刚好：
   * 有视觉锚点但不抢对话主体，与错误态/成功态拉开强度差。 */
  .self-review {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    font-size: var(--font-sm, 11px); line-height: 1.5;
    color: var(--text-secondary, #9aa0a6);
    background: var(--feedback-info-bg);
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
  /* Phase 1（2026-08-17 召回可展开）：本次召回明细区（活动详情内，source/score 弱化） */
  .recall-detail {
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    border-top: 1px solid var(--border-panel, rgba(128,128,128,.4));
  }
  .recall-detail__title {
    font-size: var(--font-xs, 10px); letter-spacing: 0.3px; margin-bottom: var(--sp-1, 4px);
  }
  .recall-detail__row {
    display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3, 8px);
    padding: var(--sp-1, 4px) 0; line-height: 1.6;
  }
  .recall-detail__name {
    color: var(--text-primary, #cccccc); word-break: break-all;
  }
  .recall-detail__meta {
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); flex-shrink: 0;
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
  .msg-delete:focus-visible,
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
