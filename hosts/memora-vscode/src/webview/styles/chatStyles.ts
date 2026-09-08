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
 *   - 下拉菜单样式见 dropdown.ts（scoped 到 .treedd），过程事件块见本文件 round-block 段。
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
    width: 22px; height: 22px; margin-left: var(--sp-1, 4px);
    padding: 0; border: none; border-radius: var(--radius-sm, 4px);
    background: transparent; color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
  }
  .session-title-bar__btn:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
    color: var(--text-primary, #cccccc);
  }
  /* 标题栏按钮内的图标容器 */
  .session-title-bar__btn .btn-icon {
    display: inline-flex; align-items: center; justify-content: center;
  }
  .session-title-bar__btn .btn-icon svg { display: block; }
  .session-title-bar__spacer { flex: 1 1 auto; }

  /* ============ Components：历史记录下拉（2026-08-17 会话管理重构 v2） ============ */
  /* 复用 treedd 下拉组件（SSOT 剪枝：替代自造的居中 overlay/modal——原 modal 的
   * display:flex 覆盖 hidden 属性导致「关不掉 + 遮罩常驻」bug，见 v1 教训）。
   * 紧挨标题条历史按钮下方弹出（treedd 绝对定位浮层），无遮罩、轻量；
   * 条目富内容：标题 + 相对时间 + 悬浮垃圾桶（删除 hover 复用 --status-fail 令牌）。 */
  .session-history .treedd__trigger {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; margin-left: var(--sp-1, 4px);
    padding: 0; border: none; border-radius: var(--radius-sm, 4px);
    background: transparent; color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
  }
  .session-history .treedd__trigger:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
    color: var(--text-primary, #cccccc);
  }
  .session-history .treedd__trigger .btn-icon svg { display: block; }
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
  .empty-title { font-size: var(--font-lg, 14px); color: var(--text-primary, #cccccc); font-weight: 600; margin-bottom: var(--sp-2, 6px); }
  .empty-hint { font-size: var(--font-md, 12px); margin-bottom: var(--sp-5, 12px); }
  /* 示例提问 chips：点击填入输入框（ui-redesign.md §6.1 空状态引导），主动引导新用户 */
  .empty-suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--sp-2, 6px); }
  .suggestion-chip {
    padding: var(--sp-1, 4px) var(--sp-4, 10px); font-size: var(--font-md, 12px);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    border-radius: var(--radius-pill, 999px);
    background: transparent; color: var(--text-secondary, #9aa0a6); cursor: pointer;
  }
  .suggestion-chip:hover { background: var(--surface-hover, rgba(128,128,128,.2)); color: var(--text-primary, #cccccc); }
  /* UX-1 onboarding 引导按钮（2026-09-01）：LLM 未配置时空态「去配置模型」，主按钮强调 */
  .empty-onboard-btn {
    padding: var(--sp-2, 6px) var(--sp-5, 12px); font-size: var(--font-md, 12px);
    border-radius: var(--radius-pill, 999px); cursor: pointer;
    border: 1px solid var(--accent, #4fc1ff); color: var(--accent, #4fc1ff);
    background: transparent; margin-top: var(--sp-3, 8px);
  }
  .empty-onboard-btn:hover { background: var(--accent-soft, rgba(79,193,255,.12)); }
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
  /* 用户消息外层包裹：气泡 + hover 操作按钮 */
  .msg-wrapper {
    display: flex; flex-direction: column; align-items: flex-end;
    position: relative;
  }
  /* 用户消息：右侧浅灰气泡（轻量身份标记） */
  .msg.user {
    align-self: flex-end; max-width: 85%;
    background: var(--surface-user-bubble);
    color: var(--text-primary, #cccccc);
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    border-radius: var(--radius-lg, 8px) var(--radius-lg, 8px) var(--radius-sm, 2px) var(--radius-lg, 8px);
  }
  /* 用户消息 hover 操作区：气泡外底部，默认隐藏，hover 显示 */
  .msg-user-actions {
    display: flex; align-items: center; justify-content: flex-end;
    gap: var(--sp-2, 6px); margin-top: var(--sp-1, 4px);
    opacity: 0; transform: translateY(-2px);
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  .msg-wrapper:hover .msg-user-actions,
  .msg-user-actions:focus-within {
    opacity: 1; transform: translateY(0);
  }
  .msg-user-actions .msg-time { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
  /* TS-9 问答闭环内交互输入折叠块（用户提问/用户补充）：轻量折叠条，默认收起 */
  .msg.user.is-interactive {
    background: transparent;
    padding: 0;
    border: 1px solid var(--border, rgba(128, 128, 128, 0.25));
    border-radius: var(--radius, 6px);
    color: var(--text-secondary, #9aa0a6);
  }
  .msg.user.is-interactive[open] { background: var(--surface-hover, rgba(128, 128, 128, 0.12)); }
  .msg.user.is-interactive .msg-interactive-summary {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    cursor: pointer; user-select: none;
    list-style: none;
  }
  .msg.user.is-interactive .msg-interactive-summary::-webkit-details-marker { display: none; }
  .msg.user.is-interactive .msg-interactive-summary::before {
    content: '▸'; flex-shrink: 0; transition: transform 0.15s ease;
  }
  .msg.user.is-interactive[open] .msg-interactive-summary::before { transform: rotate(90deg); }
  .msg.user.is-interactive .msg-interactive-label {
    flex-shrink: 0; font-size: var(--font-xs, 10px);
    color: var(--accent, #0e639c); font-weight: 600;
  }
  .msg.user.is-interactive .msg-interactive-preview {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: var(--font-md, 12px);
  }
  .msg.user.is-interactive .msg-body {
    padding: var(--sp-1, 4px) var(--sp-3, 8px) var(--sp-3, 8px);
    font-size: var(--font-md, 12px);
  }
  /* UX-9 提问内联选择题（2026-09-03，提问形态内联化）：
   * 提问块下方直接出「选项按钮 + 补充输入」，对齐 Claude/TraeWork 消息流内联交互。
   * 浅底容器 + 品牌色选项按钮，不抢正文；补充输入与主输入区同语言（输入框 + 发送按钮）。 */
  .ask-inline {
    margin: var(--sp-2, 6px) 0;
    padding: var(--sp-3, 8px);
    background: var(--surface-hover, rgba(128,128,128,.08));
    border: 1px solid var(--border-panel, rgba(128,128,128,.2));
    border-radius: var(--radius-md, 6px);
    display: flex; flex-direction: column; gap: var(--sp-2, 6px);
    min-width: 0;
  }
  .ask-inline__item { display: flex; flex-direction: column; gap: var(--sp-1, 4px); }
  .ask-inline__q { font-size: var(--font-md, 12px); color: var(--text-primary, #cccccc); }
  .ask-inline__opts { display: flex; flex-wrap: wrap; gap: var(--sp-2, 6px); }
  .ask-inline__opt {
    font-size: var(--font-sm, 11px);
    color: var(--accent, #0e639c);
    background: transparent;
    border: 1px solid var(--accent, #0e639c);
    border-radius: var(--radius-full, 999px);
    padding: 2px var(--sp-3, 8px);
    cursor: pointer;
  }
  .ask-inline__opt:hover { background: var(--accent-soft, rgba(14,99,156,.12)); }
  .ask-inline__opt:focus-visible { outline: 2px solid var(--focus, #007fd4); outline-offset: 1px; }
  .ask-inline__input-row { display: flex; gap: var(--sp-2, 6px); align-items: center; }
  .ask-inline__input {
    flex: 1 1 auto; min-width: 0;
    font-size: var(--font-sm, 11px);
    background: var(--surface-input, rgba(0,0,0,.2));
    color: var(--text-primary, #cccccc);
    border: 1px solid var(--border, rgba(128,128,128,.3));
    border-radius: var(--radius-sm, 3px);
    padding: 4px var(--sp-2, 6px);
  }
  .ask-inline__input::placeholder { color: var(--text-tertiary, #6e7681); }
  .ask-inline__input:focus-visible { outline: 2px solid var(--focus, #007fd4); outline-offset: 0; }
  .ask-inline__send {
    flex-shrink: 0;
    font-size: var(--font-sm, 11px);
    color: #fff;
    background: var(--accent, #0e639c);
    border: none;
    border-radius: var(--radius-sm, 3px);
    padding: 4px var(--sp-3, 8px);
    cursor: pointer;
  }
  .ask-inline__send:hover { background: var(--accent-hover, #1177bb); }
  .ask-inline__send:focus-visible { outline: 2px solid var(--focus, #007fd4); outline-offset: 1px; }
  /* UX-9 回答/补充折叠块（阶段一定案，2026-09-08）：用户交互输入统一收为折叠块——
   * 回答/补充用 details 折叠块（summary 常显「你答/你补充」tag，body 全文按需展开）；
   * 提问则平铺为 msg-qa--ask 文字行（记录在对话流，非折叠）。移除旧 60/120 截断，
   * 长文天然由折叠块收住。样式对齐 round-block__tool 折叠视觉语言（左缘 + 圆角 + 弱化字色）。 */
  .msg-qa {
    display: block;
    border-left: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: 0 var(--radius, 6px) var(--radius, 6px) 0;
    margin: var(--sp-1, 2px) 0;
    padding: var(--sp-1, 2px) var(--sp-3, 8px);
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    user-select: none;
    background: var(--surface-hover, rgba(128,128,128,.04));
  }
  /* 折叠块默认展开：刚答完即时可见，需时可手动收起（进行中展开，符合阅读直觉） */
  .msg-qa[open] { background: var(--surface-hover, rgba(128,128,128,.06)); }
  .msg-qa > summary {
    cursor: pointer; user-select: none; outline: none;
    list-style: none;
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
  }
  .msg-qa > summary::-webkit-details-marker { display: none; }
  .msg-qa > summary:focus-visible { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  .msg-qa__tag {
    display: inline-flex; align-items: center;
    flex-shrink: 0;
    font-weight: 600;
    color: var(--accent, #0e639c);
    background: var(--surface-normal, rgba(128,128,128,.16));
    border-radius: var(--radius-sm, 3px);
    padding: 1px var(--sp-2, 5px);
  }
  .msg-qa__body { display: flex; flex-direction: column; gap: var(--sp-1, 4px); padding-top: var(--sp-1, 4px); }
  .msg-qa__row {
    display: flex; align-items: baseline; gap: var(--sp-1, 4px); min-width: 0;
    color: var(--text-primary, #cccccc);
  }
  .msg-qa__text {
    flex: 1 1 auto; min-width: 0;
    overflow-wrap: anywhere; /* 全文平铺：长文本自然折行，不截断 */
    color: var(--text-primary, #cccccc);
  }
  /* 提问回顾行（平铺文字，非折叠）：问题 + 候选选项静态文本，还原「问了什么/为何这么选」。
   * flex-wrap 让长问题与选项自然折行，opts 弱化小字不与正文抢视觉 */
  .msg-qa--ask {
    display: flex; align-items: baseline; flex-wrap: wrap;
    gap: var(--sp-1, 4px);
    margin: var(--sp-1, 4px) 0;
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    padding-left: var(--sp-5, 12px);
    border-left: none; border-radius: 0; background: none;
  }
  .msg-qa--ask .msg-qa__text { max-width: none; white-space: normal; color: var(--text-secondary, #9aa0a6); }
  .msg-qa--ask .msg-qa__tag {
    background: transparent; color: var(--text-tertiary, #6e7681);
    padding-left: 0;
  }
  .msg-qa__opts {
    flex-basis: 100%;
    color: var(--text-tertiary, #6e7681);
    white-space: normal;
    padding-left: var(--sp-2, 5px);
  }
  /* 图标按钮通用样式 */
  .msg-icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0;
    border: none; border-radius: var(--radius, 6px);
    background: transparent; color: var(--text-secondary, #9aa0a6);
    cursor: pointer; transition: all 0.15s ease;
  }
  .msg-icon-btn:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
    color: var(--text-primary, #cccccc);
  }
  .msg-icon-btn svg { display: block; }

  /* 全局图标容器：通过 data-icon 属性注入 SVG 的 span 容器 */
  .btn-icon {
    display: inline-flex; align-items: center; justify-content: center;
  }
  .btn-icon svg { display: block; }
  /* 删除图标危险态 */
  .msg-delete-icon:hover:not(:disabled) {
    background: var(--feedback-error-bg, rgba(180, 40, 30, .14));
    color: var(--status-fail, #b3261e);
  }
  .msg-icon-btn:disabled { color: var(--text-secondary, #9aa0a6); cursor: default; opacity: .5; }
  /* AI 回答：顶部身份标签 + 任务过程折叠区 + 报告正文 + footer（对齐主流大厂 AI 对话设计）。
   * 结构（2026-09-02 收紧：任务过程在上 · 报告在下，SSOT 单一折叠区）：
   *   .msg.assistant → 纵向
   *     [.msg-ai-label            角色/模型名]
   *     [.round-block             任务过程折叠区（进行中展开·实时相位+工具追加；完成收起只留摘要）]
   *     [.msg-body                报告正文（单一连续 markdown，不被工具切碎）]
   *     [.msg-footer              复制/分叉/删除 + 时间戳]
   * 不再用侧边头像（避免每条回复都挤占一行），改为顶部弱标签标「谁在说」，
   * 正文直接铺满宽度，信息密度更高（ui-redesign 迭代）。 */
  .msg.assistant {
    align-self: stretch;
    flex-direction: column; align-items: stretch; gap: var(--sp-1, 4px);
    background: transparent; color: var(--text-primary, #cccccc);
    padding-top: var(--sp-2, 6px);
  }
  /* AI 身份标签：顶部一行，极简风格
   * 结构：[小圆点]角色名[·]模型名
   * 角色名用品牌色，模型名用灰色小字
   * 参考 Trae Work 设计：无头像、无装饰、纯文本标识 */
  .msg-ai-label {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    font-size: var(--font-sm, 11px);
    user-select: none;
  }
  /* 角色名：品牌色 + 小圆点标识 */
  .msg-ai-label__role {
    display: inline-flex; align-items: center; gap: var(--sp-1, 4px);
    font-weight: 500;
    color: var(--brand, #4a9eff);
  }
  .msg-ai-label__role::before {
    content: '';
    width: 5px; height: 5px;
    border-radius: 50%;
    background: var(--brand, #4a9eff);
  }
  /* 模型名：灰色小字，前面加分隔点 */
  .msg-ai-label__model {
    font-family: ui-monospace, Consolas, monospace;
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
  }
  .msg-ai-label__model::before {
    content: '·';
    margin-right: var(--sp-1, 4px);
    color: var(--border-panel, rgba(128,128,128,.4));
  }
  /* UX-9 B 同环续接：同 roundId 第 2+ 段的 assistant 块（提问→回答→再答 / 半截→补充→续接）。
   * 顶部虚线分隔表达「上一条被打断/提问、本条继续」，身份标签前置「↻ 续接」chip 弱化标识 ——
   * 克制呈现（圆环 + 灰字），不突出大卡片、不抢正文视觉。 */
  .msg.assistant.is-continued {
    border-top: 1px dashed var(--border-panel, rgba(128,128,128,.24));
    margin-top: var(--sp-1, 2px);
    padding-top: var(--sp-1, 4px);
  }
  .msg-ai-label__cont {
    display: inline-flex; align-items: center;
    flex-shrink: 0;
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-hover, rgba(128,128,128,.12));
    border-radius: var(--radius-sm, 3px);
    padding: 1px var(--sp-2, 5px);
    white-space: nowrap;
  }
  /* UX-9 闭环同体感（2026-09-03）：续接块隐藏重复的角色/模型身份标签——
   * 同一问答闭环的续答不再是「独立新消息」，只保留「↻ 续接」chip + 时间戳，
   * 从视觉上让提问→回答→再答 呈现为同一条回答的延续 */
  .msg.assistant.is-continued .msg-ai-label__role,
  .msg.assistant.is-continued .msg-ai-label__model {
    display: none;
  }
  /* UX-9 闭环同体感（2026-09-03）：续接段隐藏 footer（复制/分叉/删除 + 时间戳）——
   * 整条回答的操作归属首段，续接段纯正文延续（无独立消息感，对齐 TraeWork 单消息多段落）。
   * 时间戳同样只留首段带，续接段不再重复出现「第二消息」痕迹 */
  .msg.assistant.is-continued .msg-footer {
    display: none;
  }

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
  /* AI 正文段落间距（增加阅读舒适度） */
  .msg.assistant .msg-body p { margin: 0 0 var(--sp-4, 10px); line-height: 1.75; }
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
  /* 消息底部操作行：图标按钮 + 时间戳 */
  .msg-footer {
    display: flex; align-items: center; justify-content: flex-end;
    gap: var(--sp-1, 4px); margin-top: var(--sp-2, 6px);
  }
  /* 流式回答未完成时隐藏底部操作行（复制/分叉/删除 + 时间戳），回答完毕后才展示。
   * 状态类 is-pending 由 buildAssistantShell（pending 选项）加类、finalizeStreaming 移除。 */
  .msg-footer.is-pending { display: none; }
  /* UX-9 A 容器化·平铺版（2026-09-03）：同 roundId 的 AI 段归组进同一 DOM 容器（问答闭环）。
   * 容器只做「同环归组 + 容器级操作」的结构职责，不做「卡片」视觉：
   * 无边框/无圆角/无背景/无 overflow:hidden，AI 正文全宽平铺铺满消息区
   * （对齐 Trae Work 对话流：回答直接铺满版面，不套框）。
   * 操作整体上移容器级 footer（复制整链/分叉/删除 + 时间戳），user 主提问在容器外
   * （消息流气泡），与 AI 作答链上下衔接——视觉即「同一个问答闭环」的连续体。 */
  .round-group {
    margin: var(--sp-2, 6px) 0;
    /* min-width:0 → flex 子项允许收缩到面板宽，防代码块/长文本把容器撑宽后被
     * 自身宽度裁掉右缘；max-width:100% 保证容器不超出消息区（2026-09-03 防「锁在框里」） */
    min-width: 0; max-width: 100%;
    display: flex; flex-direction: column;
  }
  /* 容器直系子块（AI 段/交互子行）全宽平铺，不再内缩——
   * 正文直接贴着消息区左右边距，铺满整个版面 */
  .round-group > .msg.assistant,
  .round-group > .msg-qa { padding-right: 0; padding-left: 0; }
  /* 容器级 footer：操作上移后的唯一入口——左侧复制整链/分叉/删除，右侧时间戳（闭环起点）。
   * 平铺版轻量化：去背景色，顶部细虚线分隔（与 .interrupt-divider 语言一致），
   * 不突出操作行、不抢正文；操作入口保留今天「整链复制/分叉/删除」的闭环能力 */
  .round-group__footer {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--sp-2, 6px);
    margin-top: var(--sp-1, 4px);
    padding: var(--sp-1, 4px) 0 0;
    border-top: 1px dashed var(--border-panel, rgba(128,128,128,.24));
    font-size: var(--font-sm, 11px);
  }
  /* 容器级 footer 的「内容未定稿」隐藏：与段级 .msg-footer.is-pending 同一语义（SSOT 复用）。
   * 提问（need_clarify）等待回答期间容器 footer 不显示——底部只留 ask-inline 交互块；
   * 回答 resume 完成（done）后由 finalizeStreaming 移除该状态，与不提问场景底部栏统一。 */
  .round-group__footer.is-pending { display: none; }
  .round-group__actions { display: inline-flex; align-items: center; gap: var(--sp-1, 4px); }
  /* 段级 footer 隐藏：容器化后复制/分叉/删除/时间戳统一上移容器级，段级不再出现
   * （避免「续接正文底部又有操作按钮」的重复入口） */
  .msg.assistant .msg-footer { display: none; }
  .msg-time { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
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
  /* Phase 4：thinking 态 interject 队列可视化 —— 挂在 inputBar 前面的灰色条
   * 懒创建（chatView.updatePendingQueueBar），仅 items.length>0 时显示；
   * hidden 属性天然生效（display:block 被显式 [hidden] 覆盖为 none）。
   * 视觉定位：弱化灰色条（--surface-track），比输入卡片更轻，不抢注意力。
   * 布局：flex column（label+count+clear 在顶部一行 + list 在下方多行） */
  .pending-queue-bar {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1, 2px);
    margin: 0 var(--sp-4, 8px) var(--sp-2, 4px);
    padding: var(--sp-2, 4px) var(--sp-3, 8px) var(--sp-2, 4px);
    border-left: 3px solid var(--accent, #0e639c);
    background: transparent;
    border-radius: var(--radius-sm, 3px);
    font-size: 12px;
    line-height: 1.4;
    color: var(--text-muted, #9a9a9a);
    /* 2026-09-07 UI 打磨：去整块灰底虚线卡，改左侧色条 + 透明底，轻盈贴近打断语义 */
  }
  /* 顶部行：徽章 + 标题 + 提示 + 清空按钮（flex 一行） */
  .pending-queue-bar__head {
    display: flex;
    align-items: center;
    gap: var(--sp-1, 4px);
  }
  /* 圆形计数徽章 */
  .pending-queue-bar__badge {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 999px;
    background: var(--accent, #0e639c);
    color: var(--surface-inverse, #fff);
    font-size: 10px;
    font-weight: 700;
    line-height: 1;
  }
  /* 顶部标题行 */
  .pending-queue-bar__label {
    font-weight: 500;
    color: var(--text-secondary, #b0b0b0);
  }
  .pending-queue-bar__hint {
    flex: 1;
    font-size: 11px;
    color: var(--text-muted, #888);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* 列表容器 */
  .pending-queue-bar__list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* 每条补充的行（hover 轻浮起 + 删除按钮显现） */
  .pending-queue-bar__item {
    display: flex;
    align-items: center;
    gap: var(--sp-1, 2px);
    padding: 2px 2px;
    border-radius: var(--radius-sm, 3px);
    transition: background 0.12s;
  }
  .pending-queue-bar__item:hover {
    background: var(--surface-hover, rgba(128,128,128,.10));
  }
  .pending-queue-bar__num {
    flex-shrink: 0;
    width: 16px;
    font-size: 11px;
    color: var(--text-muted, #888);
    text-align: right;
  }
  .pending-queue-bar__text {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text-input, #cccccc);
    opacity: 0.9;
  }
  /* 单条删除按钮：平时透明，hover 行时显现 */
  .pending-queue-bar__item-del {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-muted, #888);
    cursor: pointer;
    font-size: 10px;
    line-height: 1;
    opacity: 0;
    transition: opacity 0.12s, background 0.12s, color 0.12s;
  }
  .pending-queue-bar__item:hover .pending-queue-bar__item-del {
    opacity: 1;
  }
  .pending-queue-bar__item-del:hover {
    background: var(--feedback-error-bg, rgba(180, 40, 30, .14));
    color: var(--status-fail, #b3261e);
  }
  /* 全局清空按钮（右上角）：hover 危险色暗示 */
  .pending-queue-bar__clear {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-muted, #888);
    cursor: pointer;
    font-size: 11px;
    line-height: 1;
    transition: background 0.12s, color 0.12s;
  }
  .pending-queue-bar__clear:hover {
    background: var(--feedback-error-bg, rgba(180, 40, 30, .14));
    color: var(--status-fail, #b3261e);
  }
  .pending-queue-bar[hidden] { display: none; }
  /* ④ 预算可视化：发送按钮旁的上下文占用圆环充能图标（常驻不占行；hover/聚焦**向上**弹窗出分层明细文字，
   * 避免向下展开挤压面板底部出现外部滚动条） */
  .context-ring {
    position: relative; /* 弹窗以本元素为基准向上定位 */
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    z-index: 25; /* 高于输入卡片层级：弹窗可覆盖输入区而非被裁 */
  }
  .context-ring__svg {
    width: 100%;
    height: 100%;
    transform: rotate(-90deg); /* 充能弧从正上方起画，顺时针填充 */
  }
  .context-ring__track {
    fill: none;
    stroke: var(--surface-track, #2a2a2a);
    stroke-width: 3;
  }
  .context-ring__fill {
    fill: none;
    stroke: var(--occ-dialogue, #3794ff); /* 充能色：占用越高弧越满 */
    stroke-width: 3;
    stroke-linecap: round;
    transition: stroke-dashoffset 0.2s ease;
  }
  .context-ring__percent {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 8px;
    line-height: 1;
    color: var(--text-muted, #9a9a9a);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  /* hover/聚焦弹窗：白底浮层多行文字明细（含条数 · token · 占比 · 角色包比例）。
   * 向上弹出（bottom 贴圆环上沿）：底部是输入区/面板边界，向下展开会撑出外部滚动条。
   * 宽度弹性：max-content 由最长一行自然决定（贴合内容不留白），max-width 兜底防极端长数撑太宽 */
  .context-ring__tip {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    width: max-content;
    max-width: 320px;
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    background: var(--surface-tip, #2d2d2d);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    border-radius: var(--radius-md, 8px);
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0, 0, 0, 0.15));
    font-size: 11px;
    line-height: 1.7;
    color: var(--text-input, #cccccc);
    white-space: pre-line; /* 保留 buildOccupancyTipText 的多行 \n */
    font-variant-numeric: tabular-nums;
    z-index: 30;
  }
  .context-ring:hover .context-ring__tip,
  .context-ring:focus-within .context-ring__tip { display: block; }
  @media (prefers-reduced-motion: reduce) {
    .context-ring__fill { transition: none; }
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
  /* 输入区布局：左侧功能群 + 右侧发送按钮 + 状态行
   * 对齐 visual-design-philosopher：发送按钮突出化（最大最亮），其他功能弱化。 */
  #inputFooter {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1, 4px);
    padding: var(--sp-2, 6px) var(--sp-5, 12px) var(--sp-3, 8px);
    flex-shrink: 0;
    box-sizing: border-box;
  }
  /* Composer Row 基类：共享布局契约 */
  .composer-row {
    display: flex;
    align-items: center;
    width: 100%;
  }
  /* Row 1 · 主操作行：左侧功能群 + 右侧发送按钮（两端对齐） */
  .composer-row--main {
    justify-content: space-between;
    align-items: center;
  }
  /* Row 2 · 状态行：弱化显示角色/能力信息；两端分布——左徽章 + 右上下文占用圆环
   * （占用属状态信息归本行，不干扰 Row 1 主操作；圆环在行最右，向上弹出不挤压面板） */
  .composer-row--status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 18px;
  }
  /* 左侧功能群：Skill ⚡ + 模型 + 润色（次级弱化组）。
   * 允许本组收缩（flex-shrink:1 + min-width:0），窄窗下由内部触发器省略号兜底，
   * 仅右侧发送按钮保持不可收缩，保证「主操作」永远不被挤压消失。 */
  .composer-left {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    flex-shrink: 1;
    min-width: 0;
  }
  /* 右侧发送按钮容器：唯一主操作，绝不收缩（视觉焦点恒定）。
   * Gap A：生成中并列「暂停」按钮（.pause-btn），故容器改 flex 横向排列两钮 */
  .composer-right {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
  }
  /* 状态信息容器 */
  .composer-status {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    min-width: 0;
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
  /** 小组会议启动图标（角色徽章右侧，Trae 风格 team SVG）
   * 复用 msg-icon-btn 基础样式（size/cursor/focus），差异化：
   *   - 更高优先级视觉（accent 色 + hover 背景）
   *   - roleBadge 相邻时的间距
   *   - hidden 状态（无队伍时隐藏，不占 DOM） */
  .team-meeting-icon {
    margin-left: var(--sp-1, 4px);
    width: 18px; height: 18px;
    padding: 2px;
    color: var(--accent, #0e639c);
    border-radius: var(--radius-sm, 4px);
    background: transparent;
    transition: background var(--trae-duration-fast, 120ms) ease;
  }
  .team-meeting-icon:hover {
    background: var(--accent-hover, rgba(14, 99, 156, 0.15));
  }
  .team-meeting-icon[hidden] { display: none; }
  /* Phase 4 E2：工具权限徽章（与角色徽章并列，展示工具模式与能力列表） */
  .capability-badge {
    display: inline-flex;
    align-items: center;
    max-width: 160px;
    padding: 1px var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    color: var(--accent, #0e639c);
    background: var(--accent-bg-subtle);
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
  }
  .capability-badge[hidden] { display: none; }

  /* 润色按钮（图标化，弱化样式） */
  .polish-btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: 1px solid var(--border-subtle, rgba(128,128,128,.2));
    border-radius: var(--radius-sm, 4px);
    color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
    transition: color 0.15s, background 0.15s, border-color 0.15s;
  }
  .polish-btn-icon:hover {
    color: var(--accent, #0e639c);
    background: var(--accent-bg-hover);
    border-color: var(--accent, #0e639c);
  }
  .polish-btn-icon:active { transform: scale(0.95); }
  .polish-btn-icon.loading {
    opacity: 0.6;
    pointer-events: none;
  }
  .polish-btn-icon.loading svg { animation: spin 0.8s linear infinite; }

  /* Skill 选择器胶囊差异（共用 .treedd--capsule 外壳，见 dropdown.ts）：
   * 单图标（⚡）触发器。胶囊底色/箭头/尺寸全复用 capsule；此处仅：
   * 1) 选中态 accent 边框回显（.active 由 chatView toggle）；2) 菜单左对齐
   * （左起触发器若沿用 capsule 的 right:0 会往左溢出面板边缘）；
   * 3) 菜单内当前项高亮（icon-only 下，这是「我用了哪个 Skill」的唯一常驻入口）。 */
  .skill-picker { --dd-trigger-max-w: 120px; }
  .skill-picker.active .treedd__trigger {
    border-color: var(--accent, #0e639c);
    color: var(--accent, #0e639c);
  }
  .skill-picker.treedd--capsule .treedd__menu { left: 0; right: auto; }
  .skill-picker .treedd__item.is-active {
    color: var(--accent, #0e639c);
    font-weight: 600;
  }

  /* Grok 式技能 chip 行：选中 Skill 后显示在输入框上方（消息区之下、composer 之上）。
   * 与入口触发器（Row1 ⚡）分离——此处只呈现「已挂载的技能状态」，保证透明 + 可移除。 */
  .skill-chip-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    flex-wrap: wrap;
    padding: 0 var(--sp-3, 8px) var(--sp-2, 6px);
    flex-shrink: 0;
  }
  .skill-chip-row[hidden] { display: none; }
  .skill-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1, 4px);
    max-width: 220px;
    padding: 2px var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    line-height: 1.5;
    color: var(--accent, #0e639c);
    background: var(--accent-bg-subtle);
    border: 1px solid var(--accent, #0e639c);
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
  }
  .skill-chip__icon { font-size: 11px; line-height: 1; flex-shrink: 0; }
  .skill-chip__name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .skill-chip__remove {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    font-size: 13px;
    line-height: 1;
    cursor: pointer;
  }
  .skill-chip__remove:hover {
    background: var(--accent-bg-active);
    color: var(--accent, #0e639c);
  }

  /* 动画：spin for loading state */
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* ============ Components：模型选择器（capsule 变体差异定制） ============
   * 通用胶囊外观已收敛到 dropdown.ts 的 .treedd--capsule 变体（一次定义，面板复用），
   * 消除面板各自覆写组件默认样式带来的重复 + !important（对抗评估 P2-2/P2-4）。
   * 本区块只做差异定制：宽度自适应模型名（对齐 Trae）+ 菜单尺寸 + 激活项高亮。
   * 面板通过 extraClass="model-picker treedd--capsule" 启用变体。 */
  .model-picker {
    flex: 1 1 auto; /* 窄窗下与左组其余项一起收缩，交给内部 max-width 省略 */
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
  /* 模型触发器位于左组（非右缘），菜单左对齐往右展开，避免向右溢出面板裁切 */
  .model-picker.treedd--capsule .treedd__menu { left: 0; right: auto; }
  .treedd__empty {
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    font-size: var(--font-md, 12px);
    color: var(--text-secondary, #9aa0a6);
    text-align: center;
  }

  /* ============ Components：发送按钮（单图标突出化） ============
   * 右侧唯一主操作：固定 32px 方钮，仅图标（发/停两态），视觉焦点恒定、窄窗省空间。
   * 文字已收敛为 title/aria-label 可访问性兜底（panel 标记 + chatView 事件）。 */
  .send-btn-primary {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: var(--radius-md, 6px);
    border: none;
    background: var(--accent, #0e639c);
    color: var(--accent-foreground, #ffffff);
    cursor: pointer;
    transition: background 0.15s ease, filter 0.15s ease, transform 0.1s ease;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
  }
  .send-btn-primary:hover:not(.loading) {
    filter: brightness(1.08);
    background: var(--accent-hover, #1177bb);
  }
  .send-btn-primary:active:not(.loading) { transform: scale(0.97); }
  /* 发送按钮三态图标：通过 data-icon 注入 SVG，用 display 切换显隐 */
  .send-btn-primary .send-icon,
  .send-btn-primary .stop-icon,
  .send-btn-primary .play-icon {
    display: block;
    width: 16px;
    height: 16px;
  }
  .send-btn-primary .send-icon { display: block; }
  .send-btn-primary .stop-icon { display: none; }
  .send-btn-primary .play-icon { display: none; }
  /* 生成中：切换为停止按钮（同尺寸方钮，视觉重心同步，不跳动） */
  .send-btn-primary.loading {
    background: var(--surface-hover, rgba(128,128,128,.2));
    color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
  }
  .send-btn-primary.loading .send-icon { display: none; }
  .send-btn-primary.loading .stop-icon { display: block; }
  /* 暂停中：按钮切为「继续」语义（▶ 播放图标）——用户点击恢复执行（Gap A 暂停/恢复） */
  .send-btn-primary.paused .send-icon { display: none; }
  .send-btn-primary.paused .stop-icon { display: none; }
  .send-btn-primary.paused .play-icon { display: block; }
  .send-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

  /* 暂停按钮（Gap A）：生成中与「停止」并列的软暂停入口。
   * 次级控制，视觉弱化（同加载态灰调），与主发送按钮共列于右缘；
   * hidden 由 chatView.setStatus 控制——仅生成中暴露，暂停/空闲态收回。 */
  .pause-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: var(--radius-md, 6px);
    border: 1px solid var(--border-input, rgba(128,128,128,.5));
    background: var(--surface-hover, rgba(128,128,128,.2));
    color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
  }
  .pause-btn:hover {
    background: var(--surface-code, rgba(0, 0, 0, 0.08));
    color: var(--text-primary, #cccccc);
  }
  .pause-btn:active { transform: scale(0.97); }
  /* display:inline-flex 会覆盖 HTML hidden 属性，需显式恢复隐藏 */
  .pause-btn[hidden] { display: none; }

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
   * + 步骤列表。只读展示内核 checkpoint.plan，状态色约定
   * （done=--status-pass 完成 / active=--accent 进行中 / blocked=--status-fail / pending=次级灰）。
   * 属于 checkpoint 执行态展示，不参与 round-block 过程事件复原（v1.5）。 */
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
    display: flex; align-items: center; gap: var(--sp-3, 8px);
    font-weight: 600;
    color: var(--text-primary, #cccccc);
    margin-bottom: var(--sp-2, 6px);
  }
  .plan-board-progress-wrap {
    flex: 1; height: 4px;
    background: var(--border-panel, rgba(128,128,128,.4));
    border-radius: 2px; overflow: hidden;
  }
  .plan-board-progress {
    height: 100%; background: var(--accent, #0e639c);
    border-radius: 2px;
    transition: width .3s ease-out;
  }
  .plan-board-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* 任务节点折叠：每步一个 details，summary = 序号+描述+状态徽标，
     展开后展示该步骤关联的 step 推进记录（stepLog） */
  .plan-step {
    margin: var(--sp-1, 2px) 0;
    padding-left: var(--sp-2, 6px);
  }
  .plan-step summary {
    display: flex; align-items: baseline; gap: var(--sp-2, 6px);
    cursor: pointer; user-select: none; outline: none;
  }
  .plan-step summary:focus-visible { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  .plan-step-title { flex: 1; word-break: break-all; }
  .plan-step-badge {
    flex-shrink: 0; font-size: var(--font-xs, 10px);
    opacity: 0.85;
  }
  .plan-step-rounds {
    margin: var(--sp-1, 2px) 0 var(--sp-1, 2px) var(--sp-4, 10px);
    padding-left: var(--sp-2, 6px);
    border-left: 1px solid var(--border-panel, rgba(128,128,128,.4));
  }
  .plan-step-round { font-size: var(--font-xs, 10px); padding: var(--sp-1, 2px) 0; }
  .plan-step-done { color: var(--status-pass, #4ec9b0); }
  .plan-step-done .plan-step-title { text-decoration: line-through; }
  .plan-step-active { color: var(--accent, #0e639c); font-weight: 500; }
  .plan-step-active .plan-step-title { font-weight: 600; }
  .plan-step-blocked { color: var(--status-fail, #b3261e); }
  /* pending：默认次级灰（继承 .plan-board 的 text-secondary，无需额外规则） */

  /* ============ Components：plan-inline（对话流内嵌进度条，2026-09-05 Phase 4.1 双轨升级） ============ */
  /* inline 版：一行紧凑头部，挂在 assistant 块内、round-block 上方。随对话自然向下流动，
     不再像顶部独立面板那样反向 prepend 成"导航浮窗"。 */
  .plan-inline {
    margin: var(--sp-2, 6px) var(--sp-5, 12px) var(--sp-1, 2px);
    padding: var(--sp-2, 4px) var(--sp-3, 8px);
    background: var(--surface-card, #252526);
    border: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-left: 3px solid var(--accent, #0e639c);
    border-radius: var(--radius-sm, 4px);
  }
  .plan-inline-wrap {
    display: flex; align-items: center; gap: var(--sp-3, 8px);
  }
  .plan-inline-progress-wrap {
    flex: 1; height: 4px; min-width: 40px;
    background: var(--border-panel, rgba(128,128,128,.4));
    border-radius: 2px; overflow: hidden;
  }
  .plan-inline-progress {
    height: 100%; background: var(--accent, #0e639c);
    border-radius: 2px;
    transition: width .3s ease-out;
  }
  .plan-inline-text {
    flex-shrink: 0;
    font-size: var(--font-xs, 11px);
    color: var(--text-secondary, #9aa0a6);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 260px;
  }
  /* P-3：inline 任务完成后转静态快照（plan-inline-done），视觉弱化：进度条变灰 + 左边框改成功色 */
  .plan-inline.plan-inline-done {
    border-left-color: var(--success, #2ea043);
    opacity: 0.85;
  }
  .plan-inline.plan-inline-done .plan-inline-progress {
    background: var(--success, #2ea043);
  }
  /* P-2：plan-board stepLog 行内相对时间标签 */
  .plan-step-round-time {
    display: inline-block;
    font-size: 10px;
    color: var(--text-muted, #6e7681);
    margin-right: var(--sp-2, 4px);
    padding: 1px 4px;
    background: var(--surface-inset, rgba(128,128,128,.12));
    border-radius: 3px;
  }

  /* ============ Components：round-block 任务过程折叠区（2026-09-02 收紧：SSOT 单一容器） ============ */
  /* 每轮回答的单一「任务过程」折叠区：summary 默认可见（进行中呼吸点 + 计数/耗时，完成收起），
   * details 展开后按小节呈现实时相位/工具调用/过程轨迹/召回/已沉淀/自审查/执行指标。
   * 运行时的全部过程事件统一折叠于此，报告正文（.msg-body）保持干净不被切碎——
   * 用户阅读时只看到报告，想翻找细节再展开折叠区（对齐 Trae Work「任务过程 + 报告」）。
   * 视觉延续过程性降级：灰字小字号 + 左细边框，不抢报告主体。 */
  .round-block {
    margin: var(--sp-1, 4px) var(--sp-5, 12px) 0;
    font-size: var(--font-sm, 11px); line-height: 1.5;
    color: var(--text-secondary, #9aa0a6);
    border-left: 2px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: 0 var(--radius, 6px) var(--radius, 6px) 0;
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
  }
  .round-block summary {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    cursor: pointer; user-select: none; outline: none;
    font-size: var(--font-xs, 10px);
  }
  .round-block summary:focus-visible { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  /* round-block step 标签：active step 提示。prepend 到 details 最前（summary 上方） */
  .round-block__plan-tag {
    font-size: var(--font-xs, 10px);
    color: var(--accent, #0e639c);
    padding: 0 0 var(--sp-1, 2px);
    border-bottom: 1px dashed var(--border-panel, rgba(128,128,128,.3));
    margin-bottom: var(--sp-1, 2px);
  }
  .round-block__dot {
    width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
    background: var(--text-secondary, #9aa0a6);
  }
  /* 流式中：圆点品牌色呼吸（复用 selfReviewPulse，遵守 prefers-reduced-motion） */
  .round-block.is-running .round-block__dot { background: var(--accent, #0e639c); animation: selfReviewPulse 1.2s ease-in-out infinite; }
  .round-block__stats { word-break: break-all; }
  /* 回答等待指示器（③ 等待反馈，2026-08-29）：meta 前 prepare 阶段的可见反馈——
     呼吸圆点 + 相位文案 + 等待秒数；胶囊形态弱化打扰，role=status 尊重 reduced-motion */
  .pending-wait {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-3, 10px);
    margin: var(--sp-2, 4px) 0;
    border-radius: 999px;
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-thought, rgba(128,128,128,.08));
  }
  .pending-wait::before {
    content: ''; width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
    background: var(--accent, #0e639c);
    animation: selfReviewPulse 1.2s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .pending-wait::before { animation: none; }
  }
  .round-block__details {
    margin-top: var(--sp-1, 4px);
    display: flex; flex-direction: column; gap: var(--sp-2, 6px);
  }
  .round-block__section-title {
    font-size: var(--font-xs, 10px); letter-spacing: 0.3px;
    color: var(--text-secondary, #9aa0a6);
    margin-bottom: var(--sp-1, 2px);
  }
  .round-block__row {
    display: flex; align-items: baseline; gap: var(--sp-2, 6px);
    padding: var(--sp-1, 2px) 0; line-height: 1.6;
    word-break: break-all;
  }
  /* 过程叙述行：LLM 一段行动叙述 = 一个可折叠行（summary 摘要 + 全文展开），与工具行平级平铺 details 顶层 */
  .round-block__narrate { padding: var(--sp-1, 2px) 0; line-height: 1.6; }
  .round-block__narrate summary {
    cursor: pointer; font-size: var(--font-xs, 11px);
    color: var(--text-primary, #e0e0e0);
    word-break: break-all; white-space: pre-wrap;
  }
  .round-block__narrate summary::marker { color: var(--text-secondary, #9aa0a6); }
  .round-block__narrate-body {
    margin-top: var(--sp-1, 2px); padding: var(--sp-2, 6px);
    border-left: 2px solid var(--border-panel, rgba(128,128,128,.4));
    font-size: var(--font-xs, 11px); line-height: 1.7;
    color: var(--text-secondary, #9aa0a6);
    white-space: pre-wrap; word-break: break-all;
  }
  .round-block__recall-meta { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); flex-shrink: 0; }
  .round-block__pre {
    margin: var(--sp-1, 2px) 0; padding: var(--sp-2, 6px);
    background: var(--surface-code, rgba(0,0,0,.2));
    border-radius: var(--radius, 6px);
    font-size: var(--font-xs, 10px); line-height: 1.5;
    white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere;
  }
  /* 实时相位行：进行中 details 顶部单条「当前正在做什么」（呼吸点动画，遵守 prefers-reduced-motion） */
  .round-block__phase {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    padding: var(--sp-1, 2px) var(--sp-3, 8px);
  }
  .round-block__phase::before {
    content: ''; width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
    background: var(--accent, #0e639c);
    animation: selfReviewPulse 1.2s ease-in-out infinite;
  }
  /* TS-11a：相位行切「工具执行」态——进行中工具优先显示执行叙述，主色强调 + 呼吸点延续 */
  .round-block__phase.is-tool { color: var(--text-primary, #e6e6e6); font-weight: 600; }
  @media (prefers-reduced-motion: reduce) {
    .round-block__phase::before { animation: none; }
  }
  /* 工具调用折叠行：summary 常显名称(状态)，body（args + result）按需展开；
     与 narrate 平级平铺 details 顶层，各自独立折叠 */
  .round-block__tool {
    border-left: 1px solid var(--border-panel, rgba(128,128,128,.4));
    border-radius: 0 var(--radius, 6px) var(--radius, 6px) 0;
    padding: var(--sp-1, 2px) var(--sp-3, 8px);
    margin: var(--sp-1, 2px) 0;
  }
  .round-block__tool summary {
    cursor: pointer; user-select: none; outline: none;
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
  }
  .round-block__tool summary:focus-visible { box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
  .round-block__tool-summary { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); padding: 0 0 var(--sp-1, 2px); }
  /* TS-11b：进行中工具行——高亮左缘 + 主色名称 + 尾部呼吸点，让「正在执行的工具」一眼可见；
     result 到达即移除（updateToolRowState 切 class），收尾全量渲染天然不带该态 */
  .round-block__tool.is-tool-running {
    border-left-color: var(--accent, #0e639c);
    background: var(--surface-thought, rgba(128,128,128,.05));
  }
  .round-block__tool.is-tool-running > summary { color: var(--text-primary, #e6e6e6); font-weight: 600; }
  .round-block__tool.is-tool-running > summary::after {
    content: ''; display: inline-block; width: 5px; height: 5px; border-radius: 50%;
    margin-left: var(--sp-2, 6px); background: var(--accent, #0e639c);
    animation: selfReviewPulse 1.2s ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .round-block__tool.is-tool-running > summary::after { animation: none; }
  }
  /* TS-11c：工具等待时长标签（瞬态，仅进行中工具行显示「Ns」） */
  .round-block__elapsed {
    margin-left: var(--sp-2, 6px);
    color: var(--text-secondary, #9aa0a6);
    font-variant-numeric: tabular-nums;
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
  .send-btn-primary:focus-visible,
  .msg-icon-btn:focus-visible,
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
