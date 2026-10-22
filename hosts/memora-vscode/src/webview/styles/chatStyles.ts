/**
 * 对话打磨面板样式 — 对齐 Trae AI 对话面板的视觉语言（简洁、克制、主动可见）
 *
 * 分层（ITCSS）：
 *   - 设计令牌（间距/圆角/字号/阴影/颜色）由 tokens.ts 单一真理源提供，
 *     本文件只引用令牌，禁止裸值；
 *   - 分区遵循 ITCSS：Base（body）→ Layout（状态区/消息区/输入区）
 *     → Components（消息 / 输入卡片 / 模型选择器 / 发送按钮 / 状态条）；
 *     顶部标题栏不在此设（视图标题栏 native 承载「对话」标题 + 清空/历史按钮）；
 *   - 操作按钮（复制等）「主动可见」，避免 hover-only；
 *   - 下拉菜单样式见 dropdown.ts（scoped 到 .treedd），过程事件块见本文件 round-block 段。
 */
import { tokens } from './tokens.js';

export const chatStyles = `
  ${tokens}

  /* ============ Base：元素级基础 ============ */
  /* 全局 [hidden] 兜底（[hidden]{display:none!important}）在 tokens.ts：chat/settings
   * 两面板共用注入基，单一真理源。本文件历史上的逐元素 .xxx[hidden] 显式兜底
   * 已全部删除（2026-10-11 死代码清理）：author 层任何非 !important 的 display
   * 声明（含 JS 内联 style）都输给全局 !important 规则，逐元素兜底恒不生效。 */

  body {
    font-family: var(--font-ui, system-ui, -apple-system, sans-serif);
    margin: 0;
    display: flex; flex-direction: column;
    height: 100vh; box-sizing: border-box;
    font-size: var(--font-base, 13px);
    background: var(--surface-page, #1e1e1e);
    color: var(--text-primary, #cccccc);
  }

  /* ============ Layout：面板骨架 ============ */
  /* 面板内不设重复标题栏（视图标题栏 native 承载「对话」标题 + 清空/历史按钮）；
   * body 直接进入状态区 → 消息区 → 输入区。
   * 消息区：全量铺开；z-index 设为 1（底层），输入区 z-index:20（上层承载浮层）——
   * 消除模型下拉菜单展开时「挤压对话区」的错觉：菜单是覆盖而非挤入布局。 */
  #messages {
    flex: 1; overflow-y: auto; padding: var(--sp-5, 12px); box-sizing: border-box;
    /* 滚动链隔离（主流 agent chat 容器惯例）：消息区滚到边界时，
       不把滚轮事件继续泄漏给外层/相邻滚动容器（如输入框），避免"滚不上去"的串扰感 */
    overscroll-behavior: contain;
    display: flex; flex-direction: column; gap: var(--sp-4, 10px);
    position: relative; z-index: var(--z-base);
  }
  /* 一键到底按钮（对齐 TRAE App「上滚后回到底部」）：
   * 用户上滚离开底部时浮现于消息区右下角，点击回到底部后隐藏。
   * 圆形次级按钮：半透明表面 + 边框，不抢消息主体；z-index 高于消息、低于输入区。
   * 定位锚 = #inputBar 顶边（真机反馈 2026-10-01：原挂 #messages 内 absolute 随内容
   * 滚动、「和会话记录一起滚走」——滚动容器的 absolute 子元素必随内容滚，planBar
   * 注释早有警告）。挪进 #inputBar（已 position:relative）后 bottom: calc(100% + sp-4)
   * 恒钉消息区可视框右下角；输入区/活动条/技能 chips 增高时按钮自动跟随，零补偿逻辑。 */
  .scroll-to-bottom {
    position: absolute; right: var(--sp-4, 10px); bottom: calc(100% + var(--sp-4, 10px));
    z-index: var(--z-raise);
    display: inline-flex; align-items: center; justify-content: center;
    width: var(--sq-xl, 28px); height: var(--sq-xl, 28px); padding: 0;
    border: var(--line-input);
    border-radius: 50%;
    background: var(--surface-input, #3c3c3c);
    color: var(--text-secondary, #9aa0a6);
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0,0,0,.15));
    cursor: pointer;
  }
  .scroll-to-bottom:hover { color: var(--text-primary, #cccccc); }

  /* ============ 会话大纲导航条（HOST-NAV-1） ============ */
  /* 右缘按轮锚点：每轮用户输入一根细横条，hover 弹浮层列预览，点击定位（ChatGPT 同款）。
   * 定位锚 = body（absolute，视口等效）——🔴 不挂 #messages 内：滚动容器的 absolute
   * 子元素随内容滚走（planBar / scrollToBottomBtn 两次同款血训）。z-float 层：浮于
   * 消息区与一键到底按钮之上、低于输入区。浮层显形走 :hover/:focus-within（键盘焦点
   * 进入也显形）——🔴 panel 不可挂 hidden 属性：全局 [hidden]{display:none!important}
   * 恒赢，hover 的 display 切不回来（显形只能走 CSS 默认态）。
   *
   * 🔴 **浮层两层结构（2026-10-22 真机反馈后重做，勿合并）**：
   *   ① .round-nav__panel = **命中盒**——紧贴条列（零横向 margin）、不画视觉、不滚动，
   *      只负责一件事：指针从条走到浮层这一路上，始终有元素在 hover 链上；
   *   ② .round-nav__list = **视觉盒 + 滚动容器**——边框/背景/阴影/限宽/限高/滚动都在这里，
   *      它被命中盒的 padding-right 从右缘推开 --sp-2 ⇒ 视觉上仍有呼吸间隙，命中上零缝。
   *   两种错解**别回改**：**(a) 给 panel 加横向 margin 画间隙**——间隙里没有任何元素接住
   *   指针，hover 立即撤销、浮层闪退（本轮修的就是它）；**(b) 加透明过桥伪元素把缝填成
   *   可命中**——桥只能覆盖条列高度，指针斜向跨行去浮层顶部/底部时仍走出桥外；且桥恒存在
   *   ⇒ 消息区右缘多出一条 6px 点击死区。
   *   **也不给 hover 加「延迟消失」定时器**：延迟治标（手慢仍丢、鼠标走后浮层还挡 0.3s
   *   点击），并造出「JS 定时器 × :hover」第二套显隐状态。零缝命中才是根因解。
   *   守卫：helpers/__tests__/roundNav.test.ts「浮层两层结构」（panel 出现横向 margin /
   *   overflow 即红；list 的限高与滚动必须成对）。 */
  .round-nav {
    position: absolute; right: var(--sp-1, 4px); top: 50%; transform: translateY(-50%);
    z-index: var(--z-float);
    display: flex; align-items: center;
    padding: var(--sp-2, 6px) 0; /* 横向内距去零收紧右缘（纵向保留触达） */
    border-radius: var(--radius-sm, 2px);
  }
  .round-nav[hidden] { display: none; } /* 与 flex 声明同 specificity 下兜底（全局 !important 亦覆盖） */
  /* 条列：竖排细横条；触达区（12px 高）大于视觉条（2px），hover 容器时条加长提示可点。
   * 高度上限由 JS（roundNav.applyMetrics）按视口高内联下发 —— CSS 不设 max-height：
   * 上限是单一真理源（防第二套值静默漂移）。overflow 为**极端轮数兜底**：压密到极限仍
   * 超高时条列自身滚动，绝不外溢到输入区（全长条「压密不截断」形态的结构性保证）；
   * 滚动条隐藏（条列仅 12px 宽，滚动条反占宽，且 hover 加长不能被横向裁掉）。
   * 横向 padding（--sp-0）给 hover 的 130% 加长留出免裁余量。 */
  .round-nav__track {
    display: flex; flex-direction: column; gap: var(--sp-2, 6px);
    padding: 0 var(--sp-0, 2px);
    overflow-y: auto; overflow-x: hidden;
    scrollbar-width: none;
  }
  .round-nav__track::-webkit-scrollbar { display: none; }
  .round-nav__bar {
    display: flex; align-items: center; justify-content: center;
    width: var(--sp-5, 12px); height: var(--sp-5, 12px); padding: 0;
    border: none; background: transparent; cursor: pointer;
  }
  /* 视觉条 = ::before（2px 细线）；is-active 加粗提亮（当前轮）。
     2px/3px 厚度 = C 类一次性维度（--dot-* 语义为圆点直径、--sq-* 下界 16px，均不适用） */
  .round-nav__bar::before {
    content: ''; width: 100%; height: 2px; border-radius: 1px;
    background: var(--surface-hover, rgba(128, 128, 128, 0.2));
    transition: width 0.12s ease, background 0.12s ease; /* C 类一次性微交互时长（无时长档） */
  }
  .round-nav__bar.is-active::before {
    height: 3px; background: var(--text-primary, #cccccc);
  }
  .round-nav:hover .round-nav__bar::before { width: 130%; } /* C 类一次性维度（相对加长比例） */
  .round-nav__bar:hover::before { background: var(--text-primary, #cccccc); }
  /* 预览浮层命中盒：常态不显形，hover/键盘焦点进入容器时向左展开；行点击定位。
   * 🔴 禁加 margin / overflow / border / background：前三者任一会重建缝隙或裁掉阴影，
   * 后者会让「视觉间隙」消失（padding-right 就白留了）。视觉全在 .round-nav__list。
   * ⚠️ 块注释续行必须带 * 前缀——否则字符图标守卫把续行当代码扫（实测踩过）。 */
  .round-nav__panel {
    display: none;
    position: absolute; right: 100%; top: 50%; transform: translateY(-50%);
    padding-right: var(--sp-2, 6px); /* 视觉间隙 = 命中盒内留白，视觉盒右缘据此缩进 */
  }
  .round-nav:hover .round-nav__panel,
  .round-nav:focus-within .round-nav__panel { display: block; }
  /* 浮层视觉盒 + 滚动容器（原全在 .round-nav__panel 上，四轮随命中盒拆出）：
   * max-height 与 overflow-y 必须成对——只删限高 ⇒ 被裁内容永不可达（overflow 形同隐藏）。
   * 50vh 为视口比例（无 vh 令牌档），与 JS 侧 NAV_HEIGHT_RATIO 同判 C 类一次性维度，
   * 镜像由 roundNav.test.ts 守卫钉死。 */
  .round-nav__list {
    min-width: var(--dim-lg, 160px); max-width: var(--dim-2xl, 320px); max-height: 50vh;
    overflow-y: auto;
    padding: var(--sp-2, 6px);
    border: var(--line-input);
    border-radius: var(--radius-sm, 2px);
    background: var(--surface-input, #3c3c3c);
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0,0,0,.15));
  }
  .round-nav__item {
    display: block; width: 100%; padding: var(--sp-1, 4px) var(--sp-2, 6px);
    border: none; border-radius: var(--radius-sm, 2px);
    background: transparent; color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-xs, 10px); text-align: left; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .round-nav__item:hover { background: var(--surface-hover, rgba(128, 128, 128, 0.2)); color: var(--text-primary, #cccccc); }
  .round-nav__item.is-active { color: var(--text-primary, #cccccc); font-weight: 600; }

  /* ============ StatusDock：底部状态抽屉（ADR-037 形态宪法） ============ */
  /* 抽屉入口（C1 常驻化）：静态骨架节点，body flex 列中独立成行（stretch 整条可点）。
   * 可达 = 有被收纳条（文案「+N」）或时间段有内容（文案「活动」）；未读只亮 .is-unread
   * 徽章，抽屉从不自动弹（宪法④）。全既有令牌，无新 token。 */
  .status-dock__chip {
    align-self: stretch;
    display: flex; align-items: center; justify-content: center; gap: var(--sp-2, 6px);
    margin: var(--sp-2, 6px) var(--sp-4, 10px) 0;
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    min-height: 20px;
    border: var(--line-solid);
    border-radius: var(--radius-sm, 2px);
    background: var(--surface-inset, rgba(127, 127, 127, 0.15));
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-xs, 10px);
    cursor: pointer;
  }
  /* hover 归 hover：原用 --surface-active（同引 toolbar-hoverBackground，与常态
   * --surface-inset 主路径同色 ⇒ hover 无反馈）；静态面改引 textCodeBlock 后此处
   * 与常态真正分层（UI-TOKEN-LAYER-2）。 */
  .status-dock__chip:hover { color: var(--text-primary, #cccccc); background: var(--surface-hover, rgba(128, 128, 128, 0.2)); }
  /* 未读徽章：警示色文字/描边 + 前导圆点（::before 纯装饰；读屏语义由 JS 的 aria-label 承担，
   * 伪元素内容测试与读屏都拿不到，不承载语义——同旧活动详情折叠 marker 血训）。 */
  .status-dock__chip.is-unread {
    color: var(--feedback-warn-accent, #d7ba7d);
    border-color: var(--feedback-warn-accent, #d7ba7d);
    font-weight: 600;
  }
  .status-dock__chip.is-unread::before {
    content: ''; width: var(--dot-md); height: var(--dot-md); border-radius: 50%;
    background: var(--feedback-warn-accent, #d7ba7d);
  }
  .status-dock__chip:focus-visible { outline: none; box-shadow: 0 0 0 1px var(--border-focus); }
  /* 收起态形态降级（用户诉求 2026-10-07）：常驻保留，但收起时收为输入框上方左侧短 pill，
   * 不再占输入框上方整排；展开态完全保持现状（.is-collapsed 仅由收起态施加）。
   * 与展开态的差异 = align-self: flex-start（全宽 pill 收为内容宽短 pill，靠左）
   * + 两处间距修正（margin-left 对齐对话内容柱 / margin-bottom 与输入卡留隙）；
   * 其余样式（边框/底色/字号/未读黄字+前导黄点）全部继承默认规则 ⇒ 单源、零坐标、
   * 零魔法数字对账。dockChip 静态链本就在 inputBar 之上，位置由布局结构天然保证，
   * 不破坏 resolveDock「主位条/anchor 恒净」纪律（搬运锚 parent.insertBefore(e.el, dockChip)
   * 不受影响）。文案「活动/+N」由 resolveDock 动态赋值，收起态正常显示 ⇒ 无语义孤点。 */
  body.dock-collapsed .status-dock__chip.is-collapsed {
    align-self: flex-start;  /* 全宽 pill 收为内容宽短 pill，靠左；其余与展开态同源 */
    margin-left: var(--sp-5, 12px);   /* 左缘对齐对话内容柱（默认 8px 偏贴边） */
    margin-bottom: var(--sp-2, 6px);  /* 与输入卡留一口气（默认 0 = 物理贴死） */
  }
  /* 抽屉体：纵向两段——#dockControls 控件段（被收纳活跃条）+ #activityDetail 时间段。
   * flex gap 只落在两个非 hidden 段之间（display:none 不生成盒、不占 gap）。 */
  .status-dock__panel {
    display: flex; flex-direction: column; gap: var(--sp-2, 6px);
    margin: var(--sp-2, 6px) var(--sp-4, 10px);
    padding: var(--sp-2, 6px);
    border: var(--line-solid);
    border-radius: var(--radius-sm, 2px);
    background: var(--surface-inset, rgba(127, 127, 127, 0.15));
  }
  /* 展开动画（用户诉求 2026-10-07 续）：点击左侧小气泡后，从左侧自然扩展出去。
   * 纯 CSS、零 JS：animation 只挂在展开态 body:not(.dock-collapsed)，利用
   * 「收起→展开时规则重新匹配才触发一次」的特性——重复 resolveDock 重排（展开态持续）
   * 不会重放闪烁；收起态（dock-collapsed）不带 animation ⇒ 气泡常驻不闪。
   * - pill 用 clip-path 从左向右揭示（文字不被压扁，比 scaleX 自然）；
   * - 抽屉用 translateX 从左滑入，错层 40ms 制造「先长 pill、后滑抽屉」的层次。 */
  @keyframes dockChipOpen {
    from { clip-path: inset(0 100% 0 0); opacity: var(--op-2); }
    to   { clip-path: inset(0 0 0 0);     opacity: 1; }
  }
  @keyframes dockPanelOpen {
    from { transform: translateX(-14px); opacity: 0; }
    to   { transform: translateX(0);      opacity: 1; }
  }
  body:not(.dock-collapsed) .status-dock__chip {
    transform-origin: left center;
    animation: dockChipOpen var(--dur-open) cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  body:not(.dock-collapsed) .status-dock__panel {
    animation: dockPanelOpen var(--dur-open-soft) cubic-bezier(0.2, 0.8, 0.2, 1) var(--dur-open-delay) both;
  }
  @media (prefers-reduced-motion: reduce) {
    body:not(.dock-collapsed) .status-dock__chip,
    body:not(.dock-collapsed) .status-dock__panel { animation: none; }
  }
  /* 控件段：被收纳活跃条的单实例容器（节点由 resolveDock 搬运，事件监听随节点保留）。
   * 条原样式自带外边距，段内统一收紧——子选择器兜底所有未来入段条，免枚举漂移。 */
  .status-dock__controls { display: flex; flex-direction: column; gap: var(--sp-2, 6px); }
  .status-dock__controls > * { margin: 0; }

  /* ============ Components：会话标题条（ADR-024 会话标题层） ============ */
  /* 顶部一条：主动可见展示当前会话标题，让用户始终识别「我在哪个会话」；
   * 灰字小字号 + 左侧细竖线（会话语义），不挤占消息区；
   * flex 非缩放：宽度铺满、高度自适应单行，置于消息区上方。 */
  .session-title-bar {
    display: flex; align-items: center;
    padding: var(--sp-2, 6px) var(--sp-5, 12px);
    border-bottom: var(--line-solid);
    background: var(--surface-page, #1e1e1e);
    flex: 0 0 auto;
  }
  .session-title-bar__text {
    font-size: var(--font-sm, 11px); font-weight: 500;
    color: var(--text-secondary, #9aa0a6);
    border-left: var(--line-solid-thick);
    padding-left: var(--sp-2, 6px);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    user-select: none;
  }
  /* 会话标题条按钮组：改名笔 + 新建「＋」+ 历史，会话导航入口集中在标题条；
   * spacer 把按钮组推向右端（对齐 Trae 右上角历史入口） */
  .session-title-bar__btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: var(--sq-md, 22px); height: var(--sq-md, 22px); margin-left: var(--sp-1, 4px);
    padding: 0; border: none; border-radius: var(--radius-sm, 2px);
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

  /* ============ Components：历史记录下拉 ============ */
  /* 复用 treedd 下拉组件，不自造居中 overlay/modal（其 display:flex 覆盖 hidden 属性，
   * 会「关不掉 + 遮罩常驻」）。
   * 紧挨标题条历史按钮下方弹出（treedd 绝对定位浮层），无遮罩、轻量；
   * 条目富内容：标题 + 相对时间 + 悬浮垃圾桶（删除 hover 复用 --status-fail 令牌）。 */
  .session-history .treedd__trigger {
    display: inline-flex; align-items: center; justify-content: center;
    width: var(--sq-md, 22px); height: var(--sq-md, 22px); margin-left: var(--sp-1, 4px);
    padding: 0; border: none; border-radius: var(--radius-sm, 2px);
    background: transparent; color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
  }
  .session-history .treedd__trigger:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
    color: var(--text-primary, #cccccc);
  }
  .session-history .treedd__trigger .btn-icon svg { display: block; }
  .session-history .treedd__menu {
    min-width: 240px; max-width: min(var(--dim-xl), calc(100vw - 24px));
    max-height: var(--dim-xl);
    /* 🔴 禁在此写 display：treedd 显隐 = 基础态 display:none（dropdown.ts）×
       .is-open 态 display:flex。此处 (0,2,0) 特异性会压过基础态 none ⇒ 浮层常驻
       （2026-10-19 初版实踩，已撤）。布局按需补 non-display 属性即可——基础态
       已自带 display:flex + flex-direction:column，子项 flex 规则仅展开态生效。 */
    /* 滚动职责单点 = 条目容器 #historyMenu（2026-10-19 真机反馈：长列表把 tab/搜索框
       滚出视野）。面板只限高不滚；tab 与搜索框 flex:0 恒置顶，仅条目独立滚动。 */
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
    width: var(--icon-md); height: var(--icon-md); padding: 0; border: none; border-radius: var(--radius-sm, 2px);
    background: transparent; color: var(--text-secondary, #9aa0a6); cursor: pointer;
    opacity: 0; transition: opacity var(--dur-base) ease; /* 悬浮条目才显示（对齐 Trae 悬浮删除） */
  }
  .session-history .treedd__item:hover .session-history__item-del { opacity: 1; }
  .session-history__item-del:hover { color: var(--status-fail, #f14c4c); }
  .session-history__empty {
    padding: var(--sp-4, 10px); text-align: center;
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
  }
  /* 日期分组头（2026-10-17 按日期分组）：纯展示元素，**不可**长成 .treedd__item——
     dropdown 键盘导航取全部 .treedd__item，组头若进 item 集会让方向键跳到不可选中元素。
     日期真源 = sessionId 前缀（内核 buildSessionId 契约派生），零新协议字段。 */
  .session-history__date-group {
    padding: var(--sp-2, 6px) var(--sp-3, 8px) var(--sp-1, 4px);
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
  }
  /* 分组切换器（会话记录 / 留存区）：贴在下拉面板顶部，不随条目重建被清空。
     注意：用普通按钮样式，**不可**长成 .treedd__item（那会让点击委托收起整个菜单）。 */
  .session-tabs {
    display: flex; gap: var(--sp-1, 4px);
    flex: 0 0 auto; /* 恒置顶：不随条目滚动（滚动面 = #historyMenu，见 .treedd__menu 注释） */
    padding: var(--sp-2, 6px) var(--sp-2, 6px) var(--sp-1, 4px);
    border-bottom: var(--line-solid);
  }
  .session-tab {
    display: inline-flex; align-items: center; gap: 3px;
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
    background: transparent; border: none; border-radius: var(--radius-sm, 2px);
    cursor: pointer;
  }
  .session-tab:hover { color: var(--text-primary, #cccccc); }
  /* 选中态 = accent 底 + 反色文字（2026-10-12 真机反馈实锤，勿回改）：LAYER-2 曾迁
   * --surface-checked（list-activeSelectionBackground），但该变量在暗色主题是深蓝
   * #04395E，与深灰底拉不开 ⇒ 用户实测「基本一个色调、看不到紫调」（此前把 fallback
   * 的紫色误当主题实际色描述，失实）。改用 accent（button-background）底 +
   * accent-foreground 文字——VS Code 选中高亮的标准强表达，暗/亮主题都与底面对比充分。 */
  .session-tab.is-active {
    color: var(--accent-foreground, #ffffff); font-weight: 600;
    background: var(--accent, #0e639c);
  }
  .session-tab__count { font-weight: 400; color: var(--text-secondary, #9aa0a6); }
  /* FD-3-A 元数据搜索框：贴在分组 tab 下、条目容器上；独立元素不随条目重建清空 */
  .session-search {
    display: block; box-sizing: border-box;
    flex: 0 0 auto; /* 恒置顶：不随条目滚动（滚动面 = #historyMenu） */
    width: calc(100% - var(--sp-3, 8px) * 2);
    margin: var(--sp-2, 6px) var(--sp-3, 8px) 0;
    padding: var(--sp-1, 4px) var(--sp-2, 6px);
    font-size: var(--font-xs, 10px); color: var(--text-primary, #cccccc);
    background: var(--surface-inset, rgba(127, 127, 127, 0.15));
    border: var(--line-solid);
    border-radius: var(--radius-sm, 2px); outline: none;
  }
  .session-search::placeholder { color: var(--text-secondary, #9aa0a6); }
  .session-search:focus { border-color: var(--accent-hover, #1177bb); }
  /* 条目容器 = 浮层唯一滚动面：flex 子项须 min-height:0 防内容撑破面板限高；
     日期组头随条目滚动（数据在 #historyMenu 内，置顶的只有 tab 与搜索框）。 */
  #historyMenu { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  /* 分组动作（移入留存 / 移回）：与删除同尺寸同位置，视觉弱于删除（非破坏性动作） */
  .session-history__item-keep {
    display: inline-flex; align-items: center; justify-content: center;
    width: var(--icon-md); height: var(--icon-md); padding: 0; border: none; border-radius: var(--radius-sm, 2px);
    background: transparent; color: var(--text-secondary, #9aa0a6); cursor: pointer;
    opacity: 0; transition: opacity var(--dur-base) ease;
  }
  .session-history .treedd__item:hover .session-history__item-keep { opacity: 1; }
  .session-history__item-keep:hover { color: var(--accent, #0e639c); }

  /* ============ Components：消息 ============ */
  /* 空状态：克制的中性提示，垂直居中 */
  .empty-state {
    margin: auto; max-width: var(--dim-2xl); text-align: center;
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-base, 13px); line-height: var(--lh-relaxed);
    padding: var(--sp-6, 16px);
  }
  .empty-title { font-size: var(--font-lg, 14px); color: var(--text-primary, #cccccc); font-weight: 600; margin-bottom: var(--sp-2, 6px); }
  .empty-hint { font-size: var(--font-md, 12px); margin-bottom: var(--sp-5, 12px); }
  /* 示例提问 chips：点击填入输入框，主动引导新用户 */
  .empty-suggestions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--sp-2, 6px); }
  .suggestion-chip {
    padding: var(--sp-1, 4px) var(--sp-4, 10px); font-size: var(--font-md, 12px);
    border: var(--line-input);
    border-radius: var(--radius-pill, 999px);
    background: transparent; color: var(--text-secondary, #9aa0a6); cursor: pointer;
  }
  .suggestion-chip:hover { background: var(--surface-hover, rgba(128,128,128,.2)); color: var(--text-primary, #cccccc); }
  /* onboarding 引导按钮：LLM 未配置时空态「去配置模型」，主按钮强调 */
  .empty-onboard-btn {
    padding: var(--sp-2, 6px) var(--sp-5, 12px); font-size: var(--font-md, 12px);
    border-radius: var(--radius-pill, 999px); cursor: pointer;
    border: 1px solid var(--accent, #0e639c); color: var(--accent, #0e639c);
    background: transparent; margin-top: var(--sp-3, 8px);
  }
  .empty-onboard-btn:hover { background: var(--accent-soft, rgba(128, 128, 128, 0.2)); }
  /* ============ Components：日期分隔线（跨天合并分组） ============ */
  /* 跨天合并视图在日期交界插入弱化分隔：居中灰字 + 两侧细线，aria-hidden 装饰性。 */
  .date-divider {
    display: flex; align-items: center; gap: var(--sp-3, 8px);
    margin: var(--sp-2, 6px) 0;
    color: var(--text-secondary, #9aa0a6); font-size: var(--font-xs, 10px);
    letter-spacing: 0.5px; user-select: none;
  }
  .date-divider::before, .date-divider::after { content: ''; flex: 1; height: 1px; background: var(--border-panel, rgba(128,128,128,.4)); }
  /* 消息基类：默认无气泡（AI 铺满），正文与底部操作行分离 */
  .msg { display: flex; flex-direction: column; white-space: pre-wrap; word-break: break-word; line-height: var(--lh-normal); }
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
    transition: opacity var(--dur-base) ease, transform var(--dur-base) ease;
  }
  .msg-wrapper:hover .msg-user-actions,
  .msg-user-actions:focus-within {
    opacity: 1; transform: translateY(0);
  }
  .msg-user-actions .msg-time { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
  /* 长输入截断：超出阈值折叠（阈值取既有 160px 档，与活动详情面板同值，不新增 token）。
   * 底部渐隐暗示「还有内容」；「展开全文」按钮由 chatView 仅在**真溢出**时插入——
   * 未溢出的短消息既不加 is-clamped 也不留按钮（判定在 JS，此处只负责折叠态外观）。 */
  .msg.user .msg-body.is-clamped {
    max-height: var(--dim-lg);
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
    mask-image: linear-gradient(to bottom, #000 calc(100% - 28px), transparent);
  }
  /* 展开/收起按钮：气泡内底部居中常显（不放 .msg-user-actions——那区 hover 才可见） */
  .msg-user-more {
    align-self: center;
    margin-top: var(--sp-2, 6px);
    padding: var(--sp-1, 4px) var(--sp-4, 10px);
    font-size: var(--font-xs, 10px);
    font-family: inherit;
    color: var(--text-secondary, #9aa0a6);
    background: transparent;
    border: var(--line-solid);
    border-radius: var(--radius-pill);
    cursor: pointer;
  }
  .msg-user-more:hover {
    color: var(--text-primary, #cccccc);
    border-color: var(--border-input, rgba(128, 128, 128, 0.5));
  }
  /* 提问内联选择题：
   * 提问块下方直接出「选项按钮 + 补充输入」，对齐 Claude/TraeWork 消息流内联交互。
   * 浅底容器 + 品牌色选项按钮，不抢正文；补充输入与主输入区同语言（输入框 + 发送按钮）。 */
  .ask-inline {
    margin: var(--sp-2, 6px) 0;
    padding: var(--sp-3, 8px);
    background: var(--surface-hover, rgba(128, 128, 128, 0.2));
    border: var(--line-solid);
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
    padding: var(--sp-0, 2px) var(--sp-3, 8px);
    cursor: pointer;
  }
  .ask-inline__opt:hover { background: var(--accent-soft, rgba(128, 128, 128, 0.2)); }
  .ask-inline__opt:focus-visible { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 1px; }
  .ask-inline__input {
    flex: 1 1 auto; min-width: 0;
    font-size: var(--font-sm, 11px);
    background: var(--surface-input, #3c3c3c);
    color: var(--text-primary, #cccccc);
    border: var(--line-solid);
    border-radius: var(--radius-sm, 2px);
    padding: var(--sp-1, 4px) var(--sp-2, 6px);
  }
  .ask-inline__input::placeholder { color: var(--text-secondary, #9aa0a6); }
  .ask-inline__input:focus-visible { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 0; }
  /* 多 ask 聚合：ask 交互统一「逐题点选/输入 →
   * 全部答完才提交」；is-selected = 该题已作答（实心品牌色，可再点改选）；submit 为底部一次性
   * 提交按钮（single 时「提交回答」/ multi 时「提交全部回答」），全部题目有答案才 enabled。
   * 纯开关无动画。单问=一个问题的多问、同样走 submit，勿再加 input-row / send 分支。 */
  .ask-inline__opt.is-selected {
    color: var(--accent-foreground, #ffffff);
    background: var(--accent, #0e639c);
    border-color: var(--accent, #0e639c);
  }
  .ask-inline__submit {
    align-self: flex-end;
    font-size: var(--font-sm, 11px);
    color: var(--accent-foreground, #ffffff);
    background: var(--accent, #0e639c);
    border: none;
    border-radius: var(--radius-sm, 2px);
    padding: var(--sp-1, 4px) var(--sp-4, 10px);
    cursor: pointer;
  }
  .ask-inline__submit:disabled {
    opacity: var(--op-2);
    cursor: not-allowed;
  }
  .ask-inline__submit:focus-visible { outline: 2px solid var(--border-focus, #0e639c); outline-offset: 1px; }
  /* 写入审批卡：confirmWrites=true 写文件时浮现于消息区底部。
   * 浅底卡片 + 头部（工具/路径）+ 描述 + 可折叠 diff + 确认/拒绝按钮；
   * 确认用语义令牌 --status-pass、拒绝用 --status-fail —— 与工具执行状态色同源，不造新色。 */
  .write-confirm-card {
    margin: var(--sp-3, 8px) 0;
    padding: var(--sp-5, 12px);
    background: var(--surface-card, #252526);
    border: var(--line-solid);
    border-radius: var(--radius-lg, 8px);
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0,0,0,.15));
  }
  .write-confirm-card__body { display: flex; flex-direction: column; gap: var(--sp-2, 6px); min-width: 0; }
  .write-confirm-card__head { display: flex; align-items: center; gap: var(--sp-2, 6px); min-width: 0; }
  .write-confirm-card__tool {
    flex-shrink: 0; font-size: var(--font-sm, 11px); font-weight: 600;
    color: var(--accent, #0e639c);
    border: 1px solid var(--accent, #0e639c);
    border-radius: var(--radius-sm, 2px);
    padding: var(--sp-hair, 1px) var(--sp-2, 6px);
  }
  .write-confirm-card__path {
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: var(--font-md, 12px); color: var(--text-primary, #cccccc);
    unicode-bidi: plaintext;
  }
  .write-confirm-card__desc { font-size: var(--font-md, 12px); color: var(--text-secondary, #9aa0a6); }
  /* 末段倒计时（fail-closed 提示）：仅剩最后一分钟时出现，用失败语义色，不造新色。
     时长真源在宿主（CONFIRM_TIMEOUT_MS 经协议 timeoutMs 透传），此处只管呈现。 */
  .write-confirm-card__countdown {
    font-size: var(--font-sm, 11px);
    color: var(--status-fail, #f14c4c);
  }
  .write-confirm-card__diff { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }
  .write-confirm-card__diff summary { cursor: pointer; font-size: var(--font-xs, 10px); }
  .write-confirm-card__diff pre {
    margin: var(--sp-2, 6px) 0 0;
    padding: var(--sp-3, 8px);
    white-space: pre-wrap; word-break: break-all;
    background: var(--surface-input, #3c3c3c);
    color: var(--text-primary, #cccccc);
    border-radius: var(--radius, 6px);
    max-height: var(--dim-lg); overflow-y: auto;
  }
  .write-confirm-card__actions { display: flex; gap: var(--sp-3, 8px); justify-content: flex-end; }
  .write-confirm-card__btn--ok, .write-confirm-card__btn--reject {
    font-size: var(--font-md, 12px);
    border: none; border-radius: var(--radius-sm, 2px);
    padding: var(--sp-1, 4px) var(--sp-5, 12px); cursor: pointer;
  }
  .write-confirm-card__btn--ok { background: var(--status-pass, #4ec9b0); color: var(--accent-foreground, #fff); }
  .write-confirm-card__btn--reject { background: var(--surface-input, #3c3c3c); color: var(--text-primary, #cccccc); }
  /* 🔴 等待态（2026-10-05 P5 落地A 时新增，消解 F1）
   * 病根：webview 点击后**同步**关卡、宿主**异步**推下一条 ⇒ 中间空档 = 闪烁，
   * 且用户点完若队列无下一条，卡片会带着「已裁决」的旧内容滞留 ⇒ 重复提交窗口。
   * 修法：点击后不关卡，改为等待态——按钮 disabled（防重复提交）+ 卡片整体降透明度
   * （明示「这张已处理完，等下一张」）。透明度用既有 token 拼，不新增色板。
   * [hidden] 兜底：本状态类设 display:flex，历史上须配逐元素 [hidden] 兜底
   * （规则 10 血训）；现由 tokens.ts 全局 [hidden]{display:none!important} 统一兜住。 */
  .write-confirm-card[data-pending='true'] { opacity: var(--op-5); }
  .write-confirm-card__btn[disabled] { cursor: default; opacity: var(--op-5); }
  .write-confirm-card__hint {
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
  }
  /* 运行时输入条目行：question-answer / supplement / timeout 统一形态，
   * 对齐 thought/tool 过程行视觉（左缘 + 圆角 + 弱化字色）；非折叠块——内容恒可见，来源以 tag
   * 区分（「你答 / 你补充 / 未回答」）。 */
  .round-block__input {
    display: block;
    border-left: var(--line-solid);
    border-radius: 0 var(--radius, 6px) var(--radius, 6px) 0;
    margin: var(--sp-1, 4px) 0;
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    user-select: none;
    background: var(--surface-hover, rgba(128, 128, 128, 0.2));
  }
  .round-block__input-tag {
    display: inline-flex; align-items: center;
    flex-shrink: 0;
    font-weight: 600;
    color: var(--accent, #0e639c);
    background: var(--surface-inset, rgba(127, 127, 127, 0.15));
    border-radius: var(--radius-sm, 2px);
    padding: var(--sp-hair, 1px) var(--sp-2, 6px);
  }
  .round-block__input-row {
    display: flex; align-items: baseline; gap: var(--sp-1, 4px); min-width: 0;
    color: var(--text-primary, #cccccc);
  }
  .round-block__input-text {
    flex: 1 1 auto; min-width: 0;
    overflow-wrap: anywhere; /* 全文平铺：长文本自然折行，不截断 */
    color: var(--text-primary, #cccccc);
  }
  /* 提问回顾行：问题 + 候选选项静态文本，还原「问了什么/为何这么选」。
   * flex-wrap 让长问题与选项自然折行，opts 弱化小字不与正文抢视觉 */
  .round-block__input-q {
    display: flex; align-items: baseline; flex-wrap: wrap;
    gap: var(--sp-1, 4px);
    margin: var(--sp-1, 4px) 0;
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
  }
  .round-block__input-q .round-block__input-text { max-width: none; white-space: normal; color: var(--text-secondary, #9aa0a6); }
  .round-block__input-q .round-block__input-tag {
    background: transparent; color: var(--text-secondary, #9aa0a6);
    padding-left: 0;
  }
  .round-block__input-opts {
    flex-basis: 100%;
    color: var(--text-secondary, #9aa0a6);
    white-space: normal;
    padding-left: var(--sp-2, 6px);
  }
  /* 图标按钮通用样式 */
  .msg-icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: var(--sq-md, 22px); height: var(--sq-md, 22px); padding: 0;
    border: none; border-radius: var(--radius, 6px);
    background: transparent; color: var(--text-secondary, #9aa0a6);
    cursor: pointer; transition: all var(--dur-base) ease;
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
    background: var(--feedback-error-bg, #442726);
    color: var(--status-fail, #f14c4c);
  }
  .msg-icon-btn:disabled { color: var(--text-secondary, #9aa0a6); cursor: default; opacity: var(--op-3); }
  /* AI 回答：顶部身份标签 + 任务过程折叠区 + 报告正文 + footer（对齐主流大厂 AI 对话设计）。
   * 结构（任务过程在上 · 报告在下，SSOT 单一折叠区）：
   *   .msg.assistant → 纵向
   *     [.msg-ai-label            角色/模型名]
   *     [.round-block             任务过程折叠区（进行中展开·实时相位+工具追加；完成收起只留摘要）]
   *     [.msg-body                报告正文（单一连续 markdown，不被工具切碎）]
   *     [.msg-footer              复制/分叉/删除 + 时间戳]
   * 顶部弱标签标「谁在说」而非侧边头像（后者每条回复都挤占一行），
   * 正文直接铺满宽度，信息密度更高。 */
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
    width: var(--dot-sm); height: var(--dot-sm);
    border-radius: 50%;
    background: var(--brand, #4a9eff);
  }
  /* 模型名：灰色小字，前面加分隔点 */
  .msg-ai-label__model {
    font-family: var(--font-mono, ui-monospace, Consolas, monospace);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
  }
  .msg-ai-label__model::before {
    content: '·';
    margin-right: var(--sp-1, 4px);
    color: var(--border-panel, rgba(128,128,128,.4));
  }
  /* 续接视觉已整体退役，勿再加 is-continued / 「↻ 续接」chip 样式
  * （断流续跑不存在、无同轮多段历史数据，见 chatView append 注释） */

  /* ============ Components：AI 回复 Markdown 渲染 ============
   * 大厂对话流（ChatGPT / Claude / Trae）均以 Markdown 渲染 AI 回复，代码块/列表/表格可读。
   * 流式期间按 markdown 增量渲染 + 末尾光标（运行态 data-status / 终态 data-terminus）；流结束后终渲染。
   * 表格 display:block + 横向滚动防撑爆气泡（pure CSS 降维，不写复杂正表格补全）。 */
  .msg.assistant .msg-body { white-space: normal; }
  /* 光标双通道（UI-BLOCK-ICON 批次二，方案-过程块视觉辨识-20261001.md §三定案 B；2026-10-19 SSOT 收敛）：
   * 运行/挂起态写 .msg-body[data-status]，终态写 [data-terminus]（异常中断附 data-terminus-detail=原因摘要）
   * ——一属性背两语义 = 双真相源，且终态覆盖运行态令「运行结束」表现为被覆盖而非自然消失；
   * 分属性后各通道单一语义、互不覆盖。文案与样式全部由本 ::after 承载——挂在容器上不受增量
   * markdown 重渲染影响（禁真实 span）。
   * 档位：运行三态呼吸 / 挂起两态静态淡色（基础档即覆盖）/ 终态三档分级可见度。 */
  .msg-body[data-status]::after,
  .msg-body[data-terminus]::after {
    display: inline-block; vertical-align: baseline;
    margin-left: var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
  }
  .msg-body[data-status]::after { content: attr(data-status); }
  .msg-body[data-terminus]::after { content: attr(data-terminus); }
  /* 运行三态：呼吸动画（淡色「活着」信号；复用 selfReviewPulse，与相位行/圆点同源） */
  .msg-body[data-status='思考中']::after,
  .msg-body[data-status='运行工具中']::after,
  .msg-body[data-status='正在回答中']::after {
    animation: selfReviewPulse var(--dur-pulse) ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .msg-body[data-status='思考中']::after,
    .msg-body[data-status='运行工具中']::after,
    .msg-body[data-status='正在回答中']::after {
      animation: none;
    }
  }
  /* 终态「已完成」：**容器内**由底栏承接（2026-10-13 收口底栏——淡勾迁至 round-group
   * 底栏 time 之后的 ::after，见 .round-group__footer 标签规则），正文尾压制。content:none
   * 显式压住终态基础档的 attr(data-terminus) 文字。压制**限定在容器内**：无 roundId 的兜底轮
   * （早期错误/早停，ensureRoundGroup 不建容器）容器缺席，若全局压制则终态无任何展示位
   * 而静默消失（2026-10-19 修复「底栏偶尔不显示」；与「异常中断」正文尾兜底同一相位机制）；
   * 容器外回退终态基础档 attr(data-terminus)「已完成」文字自足承接。 */
  .round-group .msg-body[data-terminus='已完成']::after {
    content: none;
  }
  /* 终态「异常中断」：红字状态词 + 原因摘要（detail 由 JS 截断写入）。状态词必须在场——
   * 流错误案 footer 处于 is-pending 不可见，正文尾是该态唯一展示位，须自足说清「什么结局 + 为什么」 */
  .msg-body[data-terminus='异常中断']::after {
    content: '异常中断 · ' attr(data-terminus-detail);
    color: var(--danger, #f14c4c);
  }
  /* AI 正文段落间距（增加阅读舒适度） */
  .msg.assistant .msg-body p { margin: 0 0 var(--sp-4, 10px); line-height: var(--lh-relaxed); }
  .msg.assistant .msg-body > :last-child { margin-bottom: 0; }
  .msg.assistant .msg-body h1,
  .msg.assistant .msg-body h2,
  .msg.assistant .msg-body h3 { font-weight: 600; line-height: var(--lh-tight); margin: var(--sp-4, 10px) 0 var(--sp-2, 6px); }
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
    font-family: var(--font-mono, ui-monospace, Consolas, monospace);
    font-size: 0.92em;
    background: var(--surface-code, rgba(127, 127, 127, 0.15));
    padding: var(--sp-hair, 1px) var(--sp-1, 4px); border-radius: var(--radius-sm, 2px);
  }
  /* 代码块：横向滚动防撑爆，独立底色 */
  .msg.assistant .msg-body pre {
    background: var(--surface-code, rgba(127, 127, 127, 0.15));
    border: 1px solid var(--border-panel, rgba(128, 128, 128, .4));
    border-radius: var(--radius, 6px);
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    overflow-x: auto; margin: 0 0 var(--sp-3, 8px);
    white-space: pre;
  }
  .msg.assistant .msg-body pre code { background: transparent; padding: 0; font-size: var(--font-md, 12px); }
  /* 代码块增强（对齐 TraeWork 代码块「语言标签 + 一键复制」）：
   * renderMarkdown 后由 enhanceCodeBlocks 把每个 <pre> 包装为 .code-block，
   * header（语言名 + 复制按钮）置顶，与下方 pre 连成一体圆角容器。 */
  .code-block { margin: 0 0 var(--sp-3, 8px); }
  .code-block__header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
    background: var(--surface-code, rgba(127, 127, 127, 0.15));
    border: 1px solid var(--border-panel, rgba(128, 128, 128, .4));
    border-bottom: none; border-radius: var(--radius, 6px) var(--radius, 6px) 0 0;
    user-select: none;
  }
  .code-block__header + pre { margin: 0; border-radius: 0 0 var(--radius, 6px) var(--radius, 6px); }
  .code-block__lang { font-family: var(--font-mono, ui-monospace, Consolas, monospace); }
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
  /* 同 roundId 的 AI 段归组进同一 DOM 容器（问答闭环）。
   * 容器只做「同环归组 + 容器级操作」的结构职责，不做「卡片」视觉：
   * 无边框/无圆角/无背景/无 overflow:hidden，AI 正文全宽平铺铺满消息区
   * （对齐 Trae Work 对话流：回答直接铺满版面，不套框）。
   * 操作整体上移容器级 footer（复制整链/分叉/删除 + 时间戳），user 主提问在容器外
   * （消息流气泡），与 AI 作答链上下衔接——视觉即「同一个问答闭环」的连续体。 */
  .round-group {
    margin: var(--sp-2, 6px) 0;
    /* min-width:0 → flex 子项允许收缩到面板宽，防代码块/长文本把容器撑宽后被
     * 自身宽度裁掉右缘；max-width:100% 保证容器不超出消息区（防「锁在框里」） */
    min-width: 0; max-width: 100%;
    display: flex; flex-direction: column;
  }
  /* 容器直系子块（AI 段/交互子行）全宽平铺——
   * 正文直接贴着消息区左右边距，铺满整个版面 */
  .round-group > .msg.assistant { padding-right: 0; padding-left: 0; }
  /* 容器级 footer：容器级操作的唯一入口——左侧复制整链/分叉/删除，右侧时间戳（闭环起点）。
   * 无背景色，顶部细虚线分隔（与 .interrupt-divider 语言一致），
   * 不突出操作行、不抢正文；承载「整链复制/分叉/删除」闭环能力 */
  .round-group__footer {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--sp-2, 6px);
    margin-top: var(--sp-1, 4px);
    padding: var(--sp-1, 4px) 0 0;
    border-top: var(--line-dashed);
    font-size: var(--font-sm, 11px);
  }
  /* 容器级 footer 的「内容未定稿」隐藏：与段级 .msg-footer.is-pending 同一语义。
   * 提问（turn_update 的 waiting/ask）等待回答期间容器 footer 不显示——底部只留 ask-inline 交互块；
   * 回答 resume 完成（done）后由 finalizeStreaming 移除该状态，与不提问场景底部栏统一。 */
  .round-group__footer.is-pending { display: none; }
  .round-group__actions { display: inline-flex; align-items: center; gap: var(--sp-1, 4px); }
  /* 段级 footer 隐藏：复制/分叉/删除/时间戳统一由容器级承载，段级不设
   * （避免「续接正文底部又有操作按钮」的重复入口） */
  .msg.assistant .msg-footer { display: none; }
  /* 终态标签收口底栏（2026-10-13，布局返修同日）：状态词/淡勾挂底栏 time 之后的
   * ::after，正文尾回归光标纯度。载体泛匹配（契约见 chatView TerminusKind）：有正文轮
   * 挂 .msg-body、中断轮挂宿主块，round-group 内任一带终态 [data-terminus] 即点亮——
   * 运行态（思考中等）不在三档内不触发，流式期 footer.is-pending 隐藏形成第二道屏蔽。
   * 各档文案与下方「容器外」宿主尾兜底同名（「用户中断」/「异常中断」字面量各两处，改须同步）。
   *
   * 两端分布机制（首版 ::before+margin-left:auto 的返修教训：::before 是首子伪元素，
   * 其 auto margin 吸收全部余量会把 actions/time/标签整组挤到右端、左侧全空——实测
   * 「底部单边倒」）：标签用 ::after（DOM 序在 time 之后），auto margin 挂在 .msg-time
   * 上（见 .round-group__footer .msg-time 规则）——time 与标签成组靠右，操作按钮独占
   * 左端。无标签轮 time 独占右端，与 space-between 原效果一致。 */
  .round-group:has([data-terminus='已完成']) .round-group__footer::after,
  .round-group:has([data-terminus='用户中断']) .round-group__footer::after,
  .round-group:has([data-terminus='异常中断']) .round-group__footer::after {
    font-size: var(--font-xs, 10px);
    line-height: 1;
  }
  /* 「已完成」→ 静默 circle-check 淡勾（自正文尾 ::after 迁移；path 与 icons.ts
   * circle-check 同形——伪元素无法走 getIconSvg 注入，以 mask 复刻同款轮廓） */
  .round-group:has([data-terminus='已完成']) .round-group__footer::after {
    content: '';
    width: var(--icon-2xs); height: var(--icon-2xs);
    background: var(--status-pass, #4ec9b0); opacity: var(--op-6);
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='8' cy='8' r='5.5'/%3E%3Cpath d='M5.6 8.3l1.7 1.7 3.3-3.5'/%3E%3C/svg%3E")
      no-repeat center / contain;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23000' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='8' cy='8' r='5.5'/%3E%3Cpath d='M5.6 8.3l1.7 1.7 3.3-3.5'/%3E%3C/svg%3E")
      no-repeat center / contain;
  }
  /* 「用户中断」→ 中性文字标签（主动停止非错误，不抢注意力） */
  .round-group:has([data-terminus='用户中断']) .round-group__footer::after {
    content: '用户中断';
    color: var(--text-secondary, #9aa0a6);
  }
  /* 「异常中断」→ 红字标签（中断轮案：锁超时等异常轮 footer 恒显形，标签在场；
   * 流错误案 footer 隐藏期该规则不可见，正文尾红字自足承接，两相位不重复） */
  .round-group:has([data-terminus='异常中断']) .round-group__footer::after {
    content: '异常中断';
    color: var(--danger, #f14c4c);
  }
  /* 终态标签「容器外」兜底（2026-10-19 修复「底栏偶尔不显示」）：中断轮无正文块，终态写入
   * 宿主块 data-terminus（见 appendInterruptedRow / TerminusKind 载体契约）。无 roundId 的兜底轮
   * （早期错误/早停，ensureRoundGroup 不建容器）容器缺席 ⇒ 上方 :has 底栏规则无处匹配，
   * 终态既无底栏标签、正文尾又无兜底 ⇒ 静默消失。此处由宿主块尾自足承接，保证「轮已收场」
   * 这个事实恒有展示位（与「异常中断」正文尾兜底同一相位机制，统一到三档）。
   * 有容器轮由底栏承接，下方压制宿主块尾避免双显（「单一位点」纪律）。
   * 文案与上方底栏标签同名（字面量两处，改须同步）。 */
  .msg.assistant[data-terminus='用户中断']::after {
    content: '用户中断';
    margin-left: var(--sp-2, 6px);
    font-size: var(--font-xs, 10px); line-height: 1;
    color: var(--text-secondary, #9aa0a6);
  }
  .msg.assistant[data-terminus='异常中断']::after {
    content: '异常中断';
    margin-left: var(--sp-2, 6px);
    font-size: var(--font-xs, 10px); line-height: 1;
    color: var(--danger, #f14c4c);
  }
  .round-group .msg.assistant[data-terminus='用户中断']::after,
  .round-group .msg.assistant[data-terminus='异常中断']::after {
    content: none;
  }
  /* 底栏 time 吸收余量（两端分布的承载点）：auto margin 优先于 justify-content
   * space-between——time（连同其后的终态标签 ::after）成组靠右，操作按钮独占左端；
   * 无标签轮 time 独占右端，与 space-between 原效果一致。限定 footer 作用域：
   * .msg-time 还用于用户消息操作栏（.msg-user-actions），全局 auto margin 会破坏其布局 */
  .round-group__footer .msg-time { margin-left: auto; }
  .msg-time { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); }

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
    position: relative; z-index: var(--z-bar); /* 输入区层级高于消息区：下拉浮层正确覆盖而非挤压 */
  }
  /* thinking 态 interject 队列可视化 —— 挂在 inputBar 前面的灰色条
   * 懒创建（chatView.updatePendingQueueBar），仅 items.length>0 时显示；
   * hidden 属性显隐由 tokens.ts 全局 [hidden]{display:none!important} 统一兜底。
   * 视觉定位：弱化灰色条（--surface-track），比输入卡片更轻，不抢注意力。
   * 布局：flex column（label+count+clear 在顶部一行 + list 在下方多行） */
  /* 文件改动常驻条（DIFF-1）：与 pending-queue-bar 同位置范式（插在输入栏之前）；
     用注意色左条区分「有未确认改动待处理」语义，区别于打断语义的蓝色条。
     数字用 warn 色 + 粗体（不设底色，避免浅/深主题下底字对比度失控）。 */
  .file-changes-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-1, 4px);
    margin: 0 var(--sp-4, 10px) var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    border-left: 3px solid var(--warn, #d7ba7d);
    border-radius: var(--radius-sm, 2px);
    font-size: var(--font-md);
    line-height: var(--lh-tight);
    color: var(--text-secondary, #9aa0a6);
  }
  .file-changes-bar__badge {
    font-weight: 700;
    color: var(--warn, #d7ba7d);
  }
  .file-changes-bar__label {
    color: var(--text-secondary, #9aa0a6);
  }
  /* 占位撑开：把两个按钮推到行尾 */
  .file-changes-bar__spacer {
    flex: 1 1 auto;
  }
  .file-changes-bar__confirm,
  .file-changes-bar__revert {
    flex-shrink: 0;
    padding: var(--sp-0, 2px) var(--sp-3, 8px);
    border: var(--line-solid);
    border-radius: var(--radius-sm, 2px);
    background: transparent;
    color: inherit;
    font-family: inherit;
    font-size: var(--font-sm, 11px);
    cursor: pointer;
  }
  .file-changes-bar__confirm:hover {
    border-color: var(--accent, #0e639c);
    color: var(--accent, #0e639c);
  }
  .file-changes-bar__revert:hover {
    border-color: var(--danger, #f14c4c);
    color: var(--danger, #f14c4c);
  }
  .pending-queue-bar {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1, 4px);
    margin: 0 var(--sp-4, 10px) var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px) var(--sp-2, 6px);
    border-left: 3px solid var(--accent, #0e639c);
    background: transparent;
    border-radius: var(--radius-sm, 2px);
    font-size: var(--font-md);
    line-height: var(--lh-tight);
    color: var(--text-secondary, #9aa0a6);
    /* 左侧色条 + 透明底：轻盈贴近打断语义 */
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
    min-width: var(--sq-xs, 16px);
    height: var(--sq-xs, 16px);
    padding: 0 var(--sp-1, 4px);
    border-radius: var(--radius-pill);
    background: var(--accent, #0e639c);
    color: var(--accent-foreground, #fff);
    font-size: var(--font-xs, 10px);
    font-weight: 700;
    line-height: var(--lh-flat);
  }
  /* 顶部标题行 */
  .pending-queue-bar__label {
    font-weight: 500;
    color: var(--text-secondary, #9aa0a6);
  }
  .pending-queue-bar__hint {
    flex: 1;
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* 列表容器 */
  .pending-queue-bar__list {
    display: flex;
    flex-direction: column;
    gap: var(--sp-0, 2px);
  }
  /* 每条补充的行（hover 轻浮起 + 删除按钮显现） */
  .pending-queue-bar__item {
    display: flex;
    align-items: center;
    gap: var(--sp-1, 4px);
    padding: var(--sp-0, 2px) var(--sp-0, 2px);
    border-radius: var(--radius-sm, 2px);
    transition: background var(--dur-fast);
  }
  .pending-queue-bar__item:hover {
    background: var(--surface-hover, rgba(128, 128, 128, 0.2));
  }
  .pending-queue-bar__num {
    flex-shrink: 0;
    width: var(--sq-xs, 16px);
    font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    text-align: right;
  }
  .pending-queue-bar__text {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--text-input, #cccccc);
    opacity: var(--op-8);
  }
  /* 单条删除按钮：平时透明，hover 行时显现 */
  /* 单条删除按钮内的 close 图标（SVG） */
  .pending-queue-bar__item-del svg { display: block; }
  .pending-queue-bar__item-del {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--sq-xs, 16px);
    height: var(--sq-xs, 16px);
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
    font-size: var(--font-xs, 10px);
    line-height: var(--lh-flat);
    opacity: 0;
    transition: opacity var(--dur-fast), background var(--dur-fast), color var(--dur-fast);
  }
  .pending-queue-bar__item:hover .pending-queue-bar__item-del {
    opacity: 1;
  }
  .pending-queue-bar__item-del:hover {
    background: var(--feedback-error-bg, #442726);
    color: var(--status-fail, #f14c4c);
  }
  /* 全局清空按钮（右上角）：hover 危险色暗示 */
  .pending-queue-bar__clear {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--sq-sm, 18px);
    height: var(--sq-sm, 18px);
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
    font-size: var(--font-sm, 11px);
    line-height: var(--lh-flat);
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .pending-queue-bar__clear:hover {
    background: var(--feedback-error-bg, #442726);
    color: var(--status-fail, #f14c4c);
  }

  /* ============ 后台任务条（CMD-1 阶段 2）：与 pending-queue-bar 同构（左侧色条 + 透明底）；
   * 列表每行 = 命令原文 + 状态标签 + 终止按钮（终态行无按钮）。 ============ */
  .background-tasks-bar {
    display: flex;
    flex-direction: column;
    gap: var(--sp-1, 4px);
    margin: 0 var(--sp-4, 10px) var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px) var(--sp-2, 6px);
    /* 色条复用 --accent（与 pending-queue-bar 同族）：不新造 token ——
       status-running 在 tokens.ts 无定义，写了就恒走 fallback、不跟随主题。
       两条的区分靠标题文案（「后台任务」/「待发送」）与行内容，不靠颜色编码。 */
    border-left: 3px solid var(--accent, #0e639c);
    background: transparent;
    border-radius: var(--radius-sm, 2px);
    font-size: var(--font-md);
    line-height: var(--lh-tight);
    color: var(--text-secondary, #9aa0a6);
  }
  .background-tasks-bar__head {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
  }
  .background-tasks-bar__badge {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--sq-xs, 16px);
    height: var(--sq-xs, 16px);
    padding: 0 var(--sp-1, 4px);
    border-radius: var(--radius-pill);
    background: var(--surface-inset, rgba(127, 127, 127, 0.15));
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-xs, 10px);
  }
  .background-tasks-bar__label { color: var(--text-secondary, #9aa0a6); }
  .background-tasks-bar__item {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    padding: var(--sp-0, 2px);
    border-radius: var(--radius-sm, 2px);
    transition: background var(--dur-fast);
  }
  .background-tasks-bar__item:hover { background: var(--surface-hover, rgba(128, 128, 128, 0.2)); }
  /* 命令原文占满剩余宽度（过长由 JS 截断 + title 悬停看全文，此处只防溢出撑破布局） */
  .background-tasks-bar__text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    /* 等宽字体：经 --font-mono 跟随用户在 VS Code 设置的编辑器字体 */
    font-family: var(--font-mono, ui-monospace, Consolas, monospace);
    color: var(--text-secondary, #9aa0a6);
  }
  .background-tasks-bar__status {
    flex-shrink: 0;
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-xs, 10px);
  }
  .background-tasks-bar__kill {
    flex-shrink: 0;
    padding: 0 var(--sp-2, 6px);
    height: var(--sq-sm, 18px);
    border: var(--line-solid);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-xs, 10px);
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .background-tasks-bar__kill:hover {
    background: var(--feedback-error-bg, #442726);
    color: var(--status-fail, #f14c4c);
  }
  /* 终态行的「收起」：中性灰、不带危险色——它不杀进程（与「终止」视觉上必须可区分，
     否则用户会以为点了会杀东西）。hover 用普通高亮而非危险色。 */
  .background-tasks-bar__dismiss {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--sq-sm, 18px);
    height: var(--sq-sm, 18px);
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-base, 13px);
    line-height: var(--lh-flat);
    cursor: pointer;
    transition: background var(--dur-fast), color var(--dur-fast);
  }
  .background-tasks-bar__dismiss:hover {
    background: var(--surface-hover, rgba(128, 128, 128, 0.2));
    color: var(--text-secondary, #9aa0a6);
  }

  /* 进场动画（P2 2026-10-07 续）：条件条随内容出现，复用 dock 已验证的「从左滑入 + 淡入」
   * 范式（dockPanelOpen），与活动抽屉同源。条件条经 [hidden] 显隐，display:none→flex 时
   * animation 重跑一次 = 仅进场触发；内容增量变化（items 增删）不改 display ⇒ 不重放闪烁。 */
  .file-changes-bar,
  .pending-queue-bar,
  .background-tasks-bar {
    animation: dockPanelOpen var(--dur-open) cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  /* 减弱动效本地守卫：与 dock（line 192 同范式）完全对齐，显式关断进场动画；
   * 文件末 Utilities 全局兜底仍保留（双重保险）。 */
  @media (prefers-reduced-motion: reduce) {
    .file-changes-bar,
    .pending-queue-bar,
    .background-tasks-bar { animation: none; }
  }

  /* 预算可视化：发送按钮旁的上下文占用圆环充能图标（常驻不占行；hover/聚焦**向上**弹窗出分层明细文字，
   * 避免向下展开挤压面板底部出现外部滚动条） */
  .context-ring {
    position: relative; /* 弹窗以本元素为基准向上定位 */
    width: var(--sq-md, 22px);
    height: var(--sq-md, 22px);
    flex-shrink: 0;
    z-index: var(--z-anchor); /* 高于输入卡片层级：弹窗可覆盖输入区而非被裁 */
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
    transition: stroke-dashoffset var(--dur-open) ease;
  }
  .context-ring__percent {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--font-2xs, 8px);
    line-height: var(--lh-flat);
    color: var(--text-secondary, #9aa0a6);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  /* hover/聚焦弹卡片：白底浮层，上为分层明细文字（含条数 · token · 占比 · 角色包比例）、
   * 中为占用构成条（HOST-S3-2，2026-10-18 由状态行常驻移入卡片底部——圆环与构成条同吃
   * context_occupancy，输入条不双渲染同一信号）、最底为本轮注入回执行（HOST-CTX-4 ②，
   * 2026-10-21 由状态行徽记迁入）。
   * 向上弹出（bottom 贴圆环上沿）：底部是输入区/面板边界，向下展开会撑出外部滚动条。
   * 宽度弹性：max-content 由最长一行自然决定（贴合内容不留白），max-width 兜底防极端长数撑太宽 */
  .context-ring__tip {
    display: none;
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    width: max-content;
    max-width: var(--dim-2xl);
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    background: var(--surface-card, #252526);
    border: var(--line-input);
    border-radius: var(--radius-md, 8px);
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0, 0, 0, 0.15));
    font-size: var(--font-sm, 11px);
    line-height: var(--lh-relaxed);
    color: var(--text-input, #cccccc);
    font-variant-numeric: tabular-nums;
    z-index: var(--z-tip);
  }
  /* 明细文字子节点：pre-line 保留 buildOccupancyTipText 的多行 \n
   * （原写在 tip 本件上；2026-10-18 构成条入迁后 tip 含两个子节点，换行职责移入文本节点） */
  .context-ring__tip-text {
    white-space: pre-line;
  }
  .context-ring:hover .context-ring__tip,
  .context-ring:focus-within .context-ring__tip { display: block; }
  @media (prefers-reduced-motion: reduce) {
    .context-ring__fill { transition: none; }
  }
  /* 占用构成条（HOST-S3-2）：圆环 hover 卡片**底部**的分段比例条（2026-10-18 由状态行常驻
   * 移入——与圆环同吃 context_occupancy，输入条只留圆环一个进度信号），五段真实占用 + 剩余
   * 按 token 数 flex-grow（JS 内联）拼满；每段原生 title 出单段明细（与 hover 明细共用
   * SEGMENT_LABELS 单点文案，零新浮层）。
   * 宽度 = 卡片内 100%（原状态行常驻宽 --dim-md 60px 随移入废除；dim- 消费 20→19 经
   * count-token-refs.mjs 机械实测同步 tokensClosure）；上距 --sp-3 与文字明细分层。
   * 高度 4px 为 C 类一次性维度（无对应刻度档，见 tokensClosure 值守卫基线注释登记）。 */
  .context-segments {
    display: flex;
    width: 100%;
    margin-top: var(--sp-3, 8px);
    height: 4px;
    border-radius: var(--radius-pill);
    overflow: hidden; /* 段拼满条形，圆角裁切段边缘 */
    background: var(--surface-track, #2a2a2a); /* free 段透明，剩余由底色承载 */
    flex-shrink: 0;
  }
  .context-segments__seg { min-width: 0; }
  .context-segments__seg--rolepack { background: var(--occ-rolepack); }
  .context-segments__seg--dynamic { background: var(--occ-dynamic); }
  .context-segments__seg--dialogue { background: var(--occ-dialogue); }
  .context-segments__seg--input { background: var(--occ-input); }
  .context-segments__seg--output { background: var(--occ-output); }
  .context-segments__seg--free { background: transparent; }
  /* 本轮注入回执行（HOST-CTX-4 ②，2026-10-21 由状态行徽记迁入卡片底部）：
   * 迁移理由（真机反馈「突然出现在这里有点奇怪」）：状态行是稳定身份徽章（角色 / 能力）
   * 的行，一枚随挂载忽隐忽现的数字 pill 混在其中突兀；而它是预算归因数，与圆环同属
   * 预算域——圆环「常驻一瞥 + hover 精确」，回执归「精确」层，分项明细同屏可见
   * （徽记时代只能进 title）。
   * 形态 = 卡片底部分节：细线分隔 + 次要色（它是瞬态回执，不是卡片常驻主体），无交互。
   * 隐藏时卡片与迁移前完全一致（零视觉增量）；分隔线走 --line-solid（面板边框族，
   * 比卡片自身描边 --line-input 更弱，不与卡片边界争读）。 */
  .context-ring__injection {
    margin-top: var(--sp-3, 8px);
    padding-top: var(--sp-2, 6px);
    border-top: var(--line-solid);
    color: var(--text-secondary, #9aa0a6);
  }
  /* 唯一视觉卡片：边框 + 圆角 + 阴影 + 背景（全部集中在此） */
  /* 🔴 [hidden] 覆盖（2026-10-05 真机实锤）：display:flex 会覆盖 HTML hidden 属性
   * （hidden 的 display:none 来自 UA 样式表，author 层任何 display 声明都赢它）——
   * 漏这条导致 A 类阻断面板激活时 setComposerReplaced(true) 写了hidden=true，
   * 但 composer 视觉仍在（真机表现：确认卡显示在输入框「上方」而非替换之）。
   * 脚本报错也查不到（hidden 属性确实为 true）⇒ 假绿。
   * 【根因防线】此前逐个补 .xxx[hidden] 是打补丁不是治本（18 处已全部删除，2026-10-11）。
   * 根治 = tokens.ts 全局兜底规则 [hidden]{display:none!important}：author 层任何
   * 非 !important 的 display 声明（含 JS 内联）都被它压住，新样式自动被覆盖。 */
  #inputWrap {
    display: flex;
    flex-direction: column;
    min-height: var(--input-wrap-min-h, 128px);
    border: var(--line-input);
    border-radius: var(--radius-xl, 14px);
    background: var(--surface-input, #3c3c3c);
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0, 0, 0, 0.15));
    position: relative; /* 下拉菜单定位以此为基准 */
    transition: border-color var(--dur-base) ease, box-shadow var(--dur-base) ease;
    overflow: visible; /* 禁止裁剪向上弹出的菜单 */
  }
  /* 聚焦态：边框色变品牌色 + 阴影加深 */
  #inputWrap:focus-within {
    border-color: var(--border-focus, #0e639c);
    box-shadow: var(--shadow-card-focus, 0 4px 14px rgba(0, 0, 0, 0.25));
  }
  /* textarea：占主空间，无独立边框，与卡片融合
   * ⚠ 高度纪律：必须 flex: 0 0 auto —— flex:1（flex-basis:0%）会忽略主轴 style.height，
   * 使 autoResize() 的高度上限（--input-max-h）形同虚设，长文本时被压缩成底部一小截且无法滚动。
   * 高度唯一控制权归 JS autoResize()。 */
  #input {
    flex: 0 0 auto;
    padding: var(--sp-6, 16px) var(--sp-6, 16px) var(--sp-3, 8px);
    border: none;
    background: transparent;
    color: var(--text-input, #cccccc);
    font-family: inherit;
    font-size: var(--font-base, 13px);
    line-height: var(--lh-normal);
    resize: none;
    /* 高度由 JS autoResize() 控制；默认 hidden 避免空内容时显示滚动条轨道，
     * 内容超过 --input-max-h 时 JS 切换为 auto 才显示滚动条（大厂惯例） */
    overflow-y: hidden;
    /* 输入框内容滚动限于自身，滚到底/顶部不外泄给外层容器（主流 chat 输入惯例） */
    overscroll-behavior: contain;
    min-height: var(--input-min-h, 72px);
    max-height: var(--input-max-h, 180px);
    box-sizing: border-box;
    width: 100%;
  }
  #input:focus { outline: none; }
  #input:disabled { opacity: var(--op-5); }
  /* 附件行在场时收 textarea 顶距：16px 顶距是**无附件时**文字贴盒顶的呼吸位（与左右
   * 16px 同刻度）；附件行在场时它叠在气泡下方 = 间距堆到约 20px，而盒顶↔气泡仅 6px，
   * 上下不对称即真机复验实锤的违和感。收到 sp-2（6px）与盒顶/附件行同刻度，
   * 视觉 gap ≈ 行距半高 ≈ 10px。空态不命中 :has，观感零变化。 */
  #inputWrap:has(.skill-chip-row:not([hidden])) #input {
    padding-top: var(--sp-2, 6px);
  }
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
    min-height: var(--sq-sm, 18px);
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
   * 生成中并列「暂停」按钮（.pause-btn），容器为 flex 横向排列两钮 */
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
  /* Composer 当前角色徽章：胶囊 + accent 圆点，展示当前角色名让用户感知定位。
   * 可点跳转（2026-10-13，UX 拍板 A 方案）：点击 → open_roles → host 打开设置视图「角色」选项卡；
   * 切换执行仍走角色视图「设为当前」→ roles_set_active → agent.switchRolePack 单路径，
   * 本徽章只导航、不承载切换（零并行切换路径）。
   * 形态纪律：外观与旧只读徽章完全一致——不加箭头、不加边框增量，零常驻视觉负担；
   * 「可点」仅经 hover 反馈 + title 提示传达（不加 ▾：与模型选择器同形会误导预期原地展开）。
   * button 化须知：必须清零浏览器默认 border 与 font-family（否则破坏胶囊观感）；
   * 焦点样式走 tokens.ts 全局 focus-visible，此处不自写；textContent 赋值防注入（chatView 更新）。 */
  .role-badge {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1, 4px);
    max-width: 140px;
    padding: var(--sp-hair, 1px) var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    font-family: inherit;
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-code, rgba(127, 127, 127, 0.15));
    border: 0;
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
    cursor: pointer;
  }
  /* hover 才出反馈（常驻态零增量）：文字提亮 + 底妆加深，暗示可交互 */
  .role-badge:hover {
    color: var(--text-primary, #cccccc);
    background: var(--surface-hover, rgba(128, 128, 128, 0.2));
  }
  .role-badge::before {
    content: '';
    width: var(--dot-md); height: var(--dot-md);
    border-radius: 50%;
    background: var(--accent, #0e639c);
    flex-shrink: 0;
  }
  /** 小组会议启动图标（角色徽章右侧，Trae 风格 team SVG）
   * 复用 msg-icon-btn 基础样式（size/cursor/focus），差异化：
   *   - 更高优先级视觉（accent 色 + hover 背景）
   *   - roleBadge 相邻时的间距
   *   - hidden 状态（无队伍时隐藏，不占 DOM） */
  .team-meeting-icon {
    margin-left: var(--sp-1, 4px);
    width: var(--sq-sm, 18px); height: var(--sq-sm, 18px);
    padding: var(--sp-0, 2px);
    color: var(--accent, #0e639c);
    border-radius: var(--radius-sm, 2px);
    background: transparent;
    transition: background var(--dur-fast) ease;
  }
  .team-meeting-icon:hover {
    background: var(--accent-hover, #1177bb);
  }
  /* 工具权限徽章（与角色徽章并列，展示工具模式与能力列表） */
  .capability-badge {
    display: inline-flex;
    align-items: center;
    max-width: var(--dim-lg);
    padding: var(--sp-hair, 1px) var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    color: var(--accent, #0e639c);
    background: var(--accent-bg-subtle);
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    user-select: none;
  }
  /* 润色按钮（图标化，弱化样式） */
  .polish-btn-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--sq-xl, 28px);
    height: var(--sq-lg, 24px);
    padding: 0;
    background: transparent;
    border: var(--line-solid);
    border-radius: var(--radius-sm, 2px);
    color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
    transition: color var(--dur-base), background var(--dur-base), border-color var(--dur-base);
  }
  .polish-btn-icon:hover {
    color: var(--accent, #0e639c);
    background: var(--accent-bg-hover);
    border-color: var(--accent, #0e639c);
  }
  .polish-btn-icon:active { transform: scale(0.95); }
  .polish-btn-icon.loading {
    opacity: var(--op-5);
    pointer-events: none;
  }
  .polish-btn-icon.loading svg { animation: spin var(--dur-spin) linear infinite; }

  /* Skill 选择器胶囊差异（共用 .treedd--capsule 外壳，见 dropdown.ts）：
   * 单图标（⚡）触发器。胶囊底色/箭头/尺寸全复用 capsule；此处仅：
   * 1) 选中态 accent 边框回显（.active 由 chatView toggle）；2) 菜单左对齐
   * （左起触发器若沿用 capsule 的 right:0 会往左溢出面板边缘）；
   * 3) 菜单内当前项高亮（icon-only 下，这是「我用了哪个 Skill」的唯一常驻入口）；
   * 4) 触发器更窄（单图标不需要 200 兜底，引 tokens.ts 变体令牌，禁裸值）。 */
  .skill-picker { --dd-trigger-max-w: var(--dd-trigger-max-w-narrow); }
  .skill-picker.active .treedd__trigger {
    border-color: var(--accent, #0e639c);
    color: var(--accent, #0e639c);
  }
  .skill-picker.treedd--capsule .treedd__menu { left: 0; right: auto; }
  .skill-picker .treedd__item.is-active {
    color: var(--accent, #0e639c);
    font-weight: 600;
  }
  /* 已禁用技能：弱化主色 + 后缀「已禁用」徽记（.treedd__item-note 定义在 dropdown.ts）。
   * 刻意**不隐藏**条目——与设置页同款语义（禁用的是可见性，不是存在性）；也刻意**不拦截**选择：
   * 真源判定在 host（isSkillDisabled），webview 拒绝会在配置重载后假拒绝。
   * 定义顺序在 .is-active 之后 ⇒ 禁用项即使被选中也保持弱化（选中态靠 font-weight 600 体现）。 */
  .skill-picker .treedd__item.is-disabled { color: var(--text-secondary, #9aa0a6); }

  /* 附件行（选择态行）：在 #inputWrap 盒内、textarea 上方——你亲手选的（skill，将来图片/手动记忆等）
     排在文字上方；盒外留给系统运行时条，来源由物理位置分界。
     横向 padding 对齐 textarea 文字列（sp-6）；空态 hidden 零高度，盒子不预留空行。 */
  .skill-chip-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    /* 单轨（HOST-CTX-10，2026-10-20）：**不折行**——挂 4 个引用就吃掉输入框上方近一半
     * 高度（真机截图实锤），而这里展示的是「附加了什么」，不是正文，占多行不划算。
     * 溢出改横向滚动，滚动条刻意隐藏（侧栏里一根横条比折行更吵）；
     * 「还有内容」的线索交给边缘渐隐（见下方 is-overflow-*），不靠滚动条。
     * ⚠️ 溢出**只能滚动、不能让 chip 缩**（.skill-chip 带 flex:0 0 auto）：缩到 120px 时
     * 三个同目录文件的名字会截断在同一处，恰好把「第2章 / 第7章」这个区分点吃掉。 */
    flex-wrap: nowrap;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    /* 底部留 6px：全局焦点环 outline 2px + offset 2px 会向外扩 4px，而滚动容器在
     * padding box 裁切——不留就会被切掉下半圈（键盘用户可见，鼠标用户永远发现不了）。 */
    padding: var(--sp-2, 6px) var(--sp-6, 16px);
    flex-shrink: 0;
  }
  .skill-chip-row::-webkit-scrollbar {
    display: none;
  }
  /* 边缘渐隐 = 单轨下「这一侧还有 chip」的唯一可见线索。
   * 只渐隐真正被截断的那一侧（JS 按 scrollLeft 切类），静止态不渐隐——
   * 否则单枚 chip 的圆形胶囊会被剜掉一块，看着像渲染 bug。
   * mask 用 alpha 通道，颜色无所谓；不引入新令牌。 */
  .skill-chip-row.is-overflow-start {
    mask-image: linear-gradient(to right, transparent, #000 16px);
  }
  .skill-chip-row.is-overflow-end {
    mask-image: linear-gradient(to right, #000 calc(100% - 16px), transparent);
  }
  .skill-chip-row.is-overflow-start.is-overflow-end {
    mask-image: linear-gradient(
      to right,
      transparent,
      #000 16px,
      #000 calc(100% - 16px),
      transparent
    );
  }
  .skill-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-1, 4px);
    /* 单轨前提：chip 不参与压缩（理由见 .skill-chip-row 注释）——名字保持可辨，
     * 装不下就让行滚动，而不是把三个名字都截成同一个前缀。 */
    flex: 0 0 auto;
    max-width: 220px;
    padding: var(--sp-0, 2px) var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    line-height: var(--lh-snug);
    color: var(--accent, #0e639c);
    background: var(--accent-bg-subtle);
    border: 1px solid var(--accent, #0e639c);
    border-radius: var(--radius-pill, 999px);
    white-space: nowrap;
  }
  /* 常驻锁（pinned）**刻意不在 chip 级做视觉**——钉住与否的表达单点落在 chip 内的 🔒
   * 按钮（形状 lock/lock-open + .is-on 着色，均由 JS 从 pinned 投影）。
   * 不再用 chip 底色的理由（两条，各自独立成立）：
   *   ① 下方 .is-disabled 的 background: transparent 会覆盖它 ⇒ 禁用技能钉住后视觉归零；
   *   ② --accent-bg-subtle 与 --accent-bg-active 是同色系浅底，肉眼几乎不可辨（真机实测）。
   * 状态只留一个表达通道，杜绝两处漂移（SSOT）。钉住者的顺序差异由渲染侧稳定排序
   * 上浮表达，与底色无关。
   * ⚠️ 因此本文件**没有 .is-pinned 选择器**；JS 仍给 chip 挂该 class，其唯一职责是
   * **chip 级状态标记与测试锚点**（无视觉职责），勿据此以为漏写了样式。 */
  /* 已禁用技能 chip：虚线边框 + 次要色，与「已挂载且生效」的实线 accent 形态区分。
   * 语义 = 挂在输入框上但发送时不会注入；用户可据此自行移除或去设置里启用。 */
  .skill-chip.is-disabled {
    color: var(--text-secondary, #9aa0a6);
    background: transparent;
    border: 1px dashed var(--text-secondary, #9aa0a6);
  }
  /* 活动文件 chip（第三种 chip）：基类仍走 .skill-chip，此处只补两件按钮态必需物——
   * ① font-family 继承（关闭态整枚是 <button>，UA 默认字体会与相邻 span chip 不一致）；
   * ② pointer（关闭态可点回开）。不改颜色：attached 用 accent 实线、suppressed 复用
   * 上方 .is-disabled 的虚线次要色——「挂着但不会生效」正是它的语义。 */
  .active-file-chip {
    font-family: inherit;
  }
  .active-file-chip[data-active-file='suppressed'] {
    cursor: pointer;
  }
  /* 注入型上下文 chip（**第四种** chip，HOST-CTX-4）：与引用 chip 并排在同一行，二者差别
   * 是「带不带内容」——引用只挂指针、注入本轮就把内容塞进信封。这个差别必须**看得见**，
   * 故用**形状 + 颜色双通道**表达，任一通道单独失效（色觉差异 / 窄面板只剩图标）仍可辨：
   *   ① 形状：圆角矩形（技能 / 引用 / 活动文件一律胶囊 999px）；
   *   ② 颜色：warn 实线边框 + warn 文字（其余三种走 accent）；
   *   ③ 图标：⚠（其余三种是 file / folder / lock）。
   * ⚠️ 刻意**不用**半透明 / 低对比度：真机证过半透明 chip 看着像没渲染出来（CTX-17 教训）。
   * 底色走 surface-code（中性）而非 accent-bg-subtle：warn 边框已经承担了识别职责，
   * 再叠 accent 底色会与「引用 chip」撞色，反而削弱①以外的通道。 */
  .injection-chip {
    color: var(--warn, #d7ba7d);
    background: var(--surface-code, rgba(127, 127, 127, 0.15));
    border: 1px solid var(--warn, #d7ba7d);
    border-radius: var(--radius-sm, 2px);
  }
  .skill-chip__icon { font-size: var(--font-sm, 11px); line-height: var(--lh-flat); flex-shrink: 0; display: inline-flex; align-items: center; }
  .skill-chip__icon svg { display: block; }
  .skill-chip__name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  /* 引用 chip 行号 span（#L5-L24 / #L7）：与路径 span 对等可点（open_ref 的定位目标），
   * 但**不参与截断**——窄路径下 ellipsis 吃掉路径尾部时，行号必须完整可辨可点。
   * 颜色继承 chip 的 accent；可点性只靠 hover 下划线 + pointer 表达，不引入新令牌。 */
  .skill-chip__range {
    flex-shrink: 0;
    white-space: nowrap;
  }
  /* 引用 chip 的可点域 = 路径 / 行号两个 span，**刻意不是整枚 chip**：🔒 与 ✕ 两个按钮
   * 在 chip 内，整枚可点会把按钮点击也卷进跳转（冒泡冲突，需逐按钮 stopPropagation 兜）。
   * 作用域用 #refChips 限定——技能 chip 同名 class 但不可点，不继承该指针/下划线。 */
  #refChips .skill-chip__name,
  #refChips .skill-chip__range {
    cursor: pointer;
  }
  #refChips .skill-chip__name:hover,
  #refChips .skill-chip__range:hover {
    text-decoration: underline;
  }
  /* chip 后缀徽记：与下拉项 .treedd__item-note 同语义、同观感（各自 BEM 归属） */
  .skill-chip__note {
    flex-shrink: 0;
    font-size: var(--font-xs, 10px);
    opacity: var(--op-8);
  }
  /* 移除按钮内的 close 图标（SVG）；ref-chips__clear（CTX-7 清空全部引用）与单删 ✕
   * 同形同观感——批量出口不另造样式，并列进同一选择器组（一份规则、多锚点） */
  .skill-chip__remove svg,
  .skill-chip__pin svg,
  .ref-chips__clear svg { display: block; }
  .skill-chip__remove,
  .skill-chip__pin,
  .ref-chips__clear {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--icon-sm);
    height: 15px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    font-size: var(--font-base, 13px);
    line-height: var(--lh-flat);
    cursor: pointer;
  }
  /* 常驻锁 🔒 = 状态载体，**常显不藏**：状态必须在不 hover、键盘操作、触屏下都可读。
   * （✕ 同样是常显不藏——见下方注释：隐藏的代价是空洞与抖动，两个按钮都不藏。）
   * 二态双通道：形状（lock 闭合 / lock-open 开口，JS 投影）+ 着色（次要色 / accent）。 */
  /* 弱化**只用降色、不用降透明度**：半透明图标在真机下观感像「没渲染好 / 被禁用」
   * （用户实测反馈），而灰色是完全不透明但依然不抢眼——信号清晰、视觉安静，两者兼得。
   * 二态靠 **形状（开口/闭合）+ 颜色（灰/accent）** 两个明确通道，不依赖透明度。 */
  .skill-chip__pin {
    color: var(--text-secondary);
  }
  /* 已钉住（常驻）：形状闭合 + accent 实色。着色在按钮自身，不被 .is-disabled 影响 */
  .skill-chip__pin.is-on {
    color: var(--accent);
  }
  /* 🔒 的 hover 只改背景、不改颜色——若 hover 把颜色提到 accent，未钉住的锁会在鼠标下
   * 伪装成钉住态（曾与 .is-pinned 撞同一 --accent-bg-active，属同一类混淆源）。 */
  .skill-chip__pin:hover {
    background: var(--accent-bg-subtle);
  }
  /* 移除 ✕ = 动作，**常显 + 降色**（次要色，完全不透明），hover 提亮并转失败色提示破坏性。
   * 与 🔒 未钉态共用同一套「常显 + 降色」语言：同一 chip 内的两个按钮必须是同一种可见性
   * 语言，否则视觉逻辑不自洽（SSOT：一类元素一种处理）。
   * 显隐方案三易其稿，终态理由（单元绿不算数，真机才是判据）：
   *   ① hover 才显形（opacity: 0 + 保留占位）⇒ 真机留常驻 15px 空洞，比一枚淡 ✕ 更突兀；
   *   ② 改 display: none 消空洞 ⇒ hover 时 chip 宽度突变、同行 chip 位移，且鼠标停边缘
   *      会「变宽→移出→变窄→移入」振荡；
   *   ③ 常显但压 opacity 到 0.75 ⇒ 真机观感「淡淡的像没渲染好 / 被禁用」；
   *   ④ 终态 = 常显 + 降色（**降噪走颜色，不走隐藏、也不走透明度**）：同时避开空洞、
   *      抖动与残影观感，可发现性与可点击性不丢，也无需 :focus-visible 兜底（本就可见）。 */
  .skill-chip__remove {
    color: var(--text-secondary);
    transition: color var(--dur-base) ease;
  }
  /* 破坏性动作 hover 用更深的 active 底 + 失败色，与 🔒（状态按钮，hover 只给 subtle 底）
   * 有意区分——不是不一致，是语义不同：确认删除需要更强的视觉重量。
   * ⚠️ 此处是 --accent-bg-active 在样式层**唯一**的消费点，改掉它会让该令牌变僵尸
   * （tokensClosure「无僵尸令牌」守卫当场红）；要改配色须先安排去处。 */
  .skill-chip__remove:hover,
  .ref-chips__clear:hover {
    background: var(--accent-bg-active);
    color: var(--status-fail);
  }

  /* 动画：spin for loading state */
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  /* ============ Components：模型选择器（capsule 变体差异定制） ============
   * 通用胶囊外观统一在 dropdown.ts 的 .treedd--capsule 变体（一次定义，面板复用），
   * 消除面板各自覆写组件默认样式带来的重复 + !important。
   * 本区块只做差异定制：宽度自适应模型名（对齐 Trae）+ 菜单尺寸 + 激活项高亮。
   * 面板通过 extraClass="model-picker treedd--capsule" 启用变体。 */
  .model-picker {
    flex: 1 1 auto; /* 窄窗下与左组其余项一起收缩，交给内部 max-width 省略 */
    min-width: 0;
    /* 差异定制变量（capsule 变体读取）：超长模型名兜底省略 + 菜单尺寸。
     * 触发器兜底沿用 L3 默认（--dd-trigger-max-w: 200）——本面板不需加宽，故不覆写；
     * 菜单加宽经 tokens.ts 变体令牌供值（--dd-menu-min-w-wide / --dim-xl 复用），
     * 覆写只留 var() 引用、禁裸值（A 类债收口，1:1 零视觉变化）。 */
    --dd-menu-min-w: var(--dd-menu-min-w-wide);
    --dd-menu-max-w: var(--dim-xl);
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
   * 文字走 title/aria-label 可访问性兜底（panel 标记 + chatView 事件）。 */
  .send-btn-primary {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--sq-2xl, 32px);
    height: var(--sq-2xl, 32px);
    padding: 0;
    border-radius: var(--radius-md, 6px);
    border: none;
    background: var(--accent, #0e639c);
    color: var(--accent-foreground, #ffffff);
    cursor: pointer;
    transition: background var(--dur-base) ease, filter var(--dur-base) ease, transform var(--dur-fastest) ease;
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
    width: var(--sq-xs, 16px);
    height: var(--sq-xs, 16px);
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
  /* 暂停中：按钮切为「继续」语义（▶ 播放图标）——用户点击恢复执行 */
  .send-btn-primary.paused .send-icon { display: none; }
  .send-btn-primary.paused .stop-icon { display: none; }
  .send-btn-primary.paused .play-icon { display: block; }
  .send-btn-primary:disabled { opacity: var(--op-3); cursor: not-allowed; }

  /* 暂停按钮：生成中与「停止」并列的软暂停入口。
   * 次级控制，视觉弱化（同加载态灰调），与主发送按钮共列于右缘；
   * hidden 由 chatView.setStatus 控制——仅生成中暴露，暂停/空闲态收回。 */
  .pause-btn {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--sq-2xl, 32px);
    height: var(--sq-2xl, 32px);
    padding: 0;
    border-radius: var(--radius-md, 6px);
    border: var(--line-input);
    background: var(--surface-hover, rgba(128,128,128,.2));
    color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
    transition: background var(--dur-base) ease, color var(--dur-base) ease, transform var(--dur-fastest) ease;
  }
  .pause-btn:hover {
    background: var(--surface-code, rgba(127, 127, 127, 0.15));
    color: var(--text-primary, #cccccc);
  }
  .pause-btn:active { transform: scale(0.97); }

  /* ============ Components：活动状态区 · 主状态条 ============ */
  /* 会话异常等错误级反馈 + 低扰 info 统一走单一主状态条（#activityBar），不插入消息区，
   * 不污染对话历史。错误显示期间低扰不打断（优先级保护）；被覆盖的
   * 提示进抽屉「活动」时间段历史回溯（见下方 .status-dock__timeline）。
   * 分级：error 醒目（inputValidation error 色）、info 低扰（同记忆语义）。
   * [hidden] 显隐由 tokens.ts 全局 [hidden]{display:none!important} 统一兜底。 */
  .activity-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    padding: var(--sp-3, 8px) var(--sp-5, 12px);
    font-size: var(--font-md, 12px);
    line-height: var(--lh-snug);
    flex-shrink: 0;
    border-bottom: var(--line-solid);
  }
  .activity-bar.info {
    color: var(--text-secondary, #9aa0a6);
    background: var(--feedback-info-bg);
  }
  .activity-bar.error {
    color: var(--feedback-error-fg);
    background: var(--feedback-error-bg);
  }
  /* activityBar 操作按钮（框架就绪，宿主暂未接入可重试错误） */
  .activity-bar__text { flex: 1 1 auto; }
  .activity-bar__action {
    flex-shrink: 0;
    padding: var(--sp-hair, 1px) var(--sp-2, 6px);
    font-size: var(--font-sm, 11px);
    color: var(--accent, #0e639c);
    background: transparent;
    border: var(--line-solid);
    border-radius: var(--radius, 6px);
    cursor: pointer;
  }
  .activity-bar__action:hover {
    background: var(--surface-hover, rgba(128,128,128,.2));
  }


  /* ============ Components：任务进度常驻条（任务驱动多步闭环，单轨） ============ */
  /* LLM 调用 task_table_write/update 建表时显示的顶部常驻进度条（#planBar）：默认一行
   * N/M + 进度条 + 当前 active 任务项摘要，点击展开锚定浮层看全量任务项 + planItemLog。
   * 单轨设计：与 #messages **同级**的固定插槽（非其子节点——滚动容器内一滚即消失），
   * 运行时不渲染 inline 轨。只读展示内核 checkpoint.plan，状态色约定
   * （done=--status-pass 完成 / active=--accent 进行中 / blocked=--status-fail / pending=次级灰）。
   * 属于 checkpoint 执行态展示，不参与 round-block 过程事件复原。 */
  .plan-bar {
    position: relative; /* 锚定浮层以本插槽为定位基准（top:100% 紧贴其下） */
    flex: 0 0 auto; /* 与 session-title-bar 同级非缩放，不随 #messages 滚动 */
    z-index: var(--z-float); /* 高于消息区（z-index:1），浮层展开时可覆盖对话内容 */
    background: var(--surface-card, #252526);
    border-bottom: var(--line-solid);
  }
  .plan-bar__head {
    display: flex; align-items: center; gap: var(--sp-3, 8px);
    width: 100%; padding: var(--sp-2, 6px) var(--sp-5, 12px);
    background: transparent; border: none; cursor: pointer;
    font: inherit; color: inherit;
  }
  .plan-bar__head:hover { background: var(--surface-hover, rgba(128, 128, 128, 0.2)); }
  .plan-bar__head:focus-visible { box-shadow: inset 0 0 0 1px var(--border-focus); outline: none; }
  .plan-bar__count {
    flex-shrink: 0; font-size: var(--font-xs, 10px); font-weight: 600;
    color: var(--text-primary, #cccccc);
  }
  .plan-bar__progress {
    flex: 1; height: 4px; min-width: var(--dim-md);
    background: var(--border-panel, rgba(128,128,128,.4));
    border-radius: var(--radius-sm, 2px); overflow: hidden;
  }
  .plan-bar__fill {
    display: block; height: 100%;
    background: var(--accent, #0e639c);
    border-radius: var(--radius-sm, 2px);
    transition: width var(--dur-slow) ease-out;
  }
  .plan-bar__current {
    flex-shrink: 0; max-width: 40%;
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .plan-bar__chevron {
    flex-shrink: 0; display: inline-flex; align-items: center;
    color: var(--text-secondary, #9aa0a6);
  }
  /* SVG 指示器尺寸适配 */
  .plan-bar__chevron svg { display: block; width: var(--icon-3xs); height: var(--icon-3xs); }
  /* 锚定浮层：紧贴常驻条下方（top:100%），全量任务项列表 + planItemLog；卡片 + 阴影浮于对话上方。
   * 非 modal（无遮罩）：看进度时需同时看正文。max-height 超限滚动 */
  .plan-bar__panel {
    position: absolute; left: 0; right: 0; top: 100%;
    padding: var(--sp-2, 6px) var(--sp-5, 12px) var(--sp-3, 8px);
    background: var(--surface-card, #252526);
    border-bottom: var(--line-solid);
    box-shadow: var(--shadow-card, 0 2px 8px rgba(0,0,0,.15));
    max-height: var(--dim-2xl); overflow-y: auto;
    font-size: var(--font-md, 12px); line-height: var(--lh-normal);
    color: var(--text-secondary, #9aa0a6);
  }
  .plan-board-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* 任务节点折叠：每个任务项一个 details，summary = 序号+描述+状态徽标，
     展开后展示该任务项关联的任务项推进记录（planItemLog） */
  .plan-item {
    margin: var(--sp-1, 4px) 0;
    padding-left: var(--sp-2, 6px);
  }
  .plan-item summary {
    display: flex; align-items: baseline; gap: var(--sp-2, 6px);
    cursor: pointer; user-select: none; outline: none;
  }
  .plan-item summary:focus-visible { box-shadow: 0 0 0 1px var(--border-focus); }
  .plan-item-title { flex: 1; word-break: break-all; }
  .plan-item-badge {
    flex-shrink: 0; font-size: var(--font-xs, 10px);
    opacity: var(--op-8);
  }
  .plan-item-rounds {
    margin: var(--sp-1, 4px) 0 var(--sp-1, 4px) var(--sp-4, 10px);
    padding-left: var(--sp-2, 6px);
    border-left: var(--line-solid);
  }
  .plan-item-round { font-size: var(--font-xs, 10px); padding: var(--sp-1, 4px) 0; }
  .plan-item-done { color: var(--status-pass, #4ec9b0); }
  .plan-item-done .plan-item-title { text-decoration: line-through; }
  .plan-item-active { color: var(--accent, #0e639c); font-weight: 500; }
  .plan-item-active .plan-item-title { font-weight: 600; }
  .plan-item-blocked { color: var(--status-fail, #f14c4c); }
  /* pending：默认次级灰（继承 .plan-bar__panel 的 text-secondary，无需额外规则） */

  /* plan-board planItemLog 行内相对时间标签 */
  .plan-item-round-time {
    display: inline-block;
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    margin-right: var(--sp-2, 6px);
    padding: var(--sp-hair, 1px) var(--sp-1, 4px);
    background: var(--surface-inset, rgba(127, 127, 127, 0.15));
    border-radius: var(--radius-sm);
  }

  /* ============ Components：round-block 任务过程折叠区（SSOT 单一容器） ============ */
  /* 每轮回答的单一「任务过程」折叠区：summary 默认可见（进行中呼吸点 + 计数/耗时，完成收起），
   * details 展开后按小节呈现实时相位/工具调用/过程轨迹/召回/已沉淀/自审查/执行指标。
   * 运行时的全部过程事件统一折叠于此，报告正文（.msg-body）保持干净不被切碎——
   * 用户阅读时只看到报告，想翻找细节再展开折叠区（对齐 Trae Work「任务过程 + 报告」）。
   * 视觉延续过程性降级：灰字小字号 + 左细边框，不抢报告主体。 */
  .round-block {
    margin: var(--sp-1, 4px) var(--sp-5, 12px) 0;
    font-size: var(--font-sm, 11px); line-height: var(--lh-snug);
    color: var(--text-secondary, #9aa0a6);
    border-left: var(--line-solid-thick);
    border-radius: 0 var(--radius, 6px) var(--radius, 6px) 0;
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
  }
  /* 仅外层折叠区标题 flex（dot + 统计 span 的横排布局）——不得用后代选择器：
   * 嵌套块 summary（tool/thought/narrate/任务项）被后代命中会集体 flex 化，
   * 其 ::after 箭头的 margin 与 flex gap 叠加双倍间距、vertical-align 失效（2026-10-05 实锤）。
   * 嵌套块回归 inline 流，箭头统一走 .round-block summary::after 一套逻辑。 */
  .round-block > summary {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    cursor: pointer; user-select: none; outline: none;
    font-size: var(--font-xs, 10px);
  }
  .round-block summary:focus-visible,
  .process-flow summary:focus-visible { box-shadow: 0 0 0 1px var(--border-focus); }
  /* round-block 任务项标签：active 任务项提示。prepend 到 details 最前（summary 上方） */
  .round-block__plan-tag {
    display: flex; align-items: center; gap: var(--sp-1, 4px);
    font-size: var(--font-xs, 10px);
    color: var(--accent, #0e639c);
    padding: 0 0 var(--sp-1, 4px);
    border-bottom: var(--line-dashed);
    margin-bottom: var(--sp-1, 4px);
  }
  /* target 图标（SVG）：跟随 accent 色，不收缩 */
  .round-block__plan-tag__icon { display: inline-flex; align-items: center; flex-shrink: 0; }
  .round-block__plan-tag__icon svg { display: block; }
  .round-block__dot {
    width: var(--dot-sm); height: var(--dot-sm); border-radius: 50%; flex-shrink: 0;
    background: var(--text-secondary, #9aa0a6);
  }
  /* 流式中：圆点品牌色呼吸（复用 selfReviewPulse，遵守 prefers-reduced-motion） */
  .round-block.is-running .round-block__dot { background: var(--accent, #0e639c); animation: selfReviewPulse var(--dur-pulse) ease-in-out infinite; }
  .round-block__stats { word-break: break-all; }
  /* 回答等待指示器：meta 前 prepare 阶段的可见反馈——
     呼吸圆点 + 相位文案 + 等待秒数；胶囊形态弱化打扰，role=status 尊重 reduced-motion */
  .pending-wait {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    margin: var(--sp-2, 6px) 0;
    border-radius: var(--radius-pill);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-thought, #252526);
  }
  .pending-wait::before {
    content: ''; width: var(--dot-sm); height: var(--dot-sm); border-radius: 50%; flex-shrink: 0;
    background: var(--accent, #0e639c);
    animation: selfReviewPulse var(--dur-pulse) ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .pending-wait::before { animation: none; }
  }
  /* 记忆命中可展开行（HOST-S3-1）：本轮「参考了 N 条记忆」低扰胶囊 + 展开命中标题列表。
   * 与 pending-wait 同族视觉（胶囊弱显），挂正文上方带；默认收起，展开才见明细。 */
  .memory-hits {
    margin: var(--sp-2, 6px) 0;
    border-radius: var(--radius-pill);
    background: var(--surface-thought, #252526);
  }
  .memory-hits > summary {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    padding: var(--sp-2, 6px) var(--sp-3, 8px);
    cursor: pointer; user-select: none; outline: none;
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
  }
  .memory-hits > summary:focus-visible { box-shadow: 0 0 0 1px var(--border-focus); }
  .memory-hits__icon { display: inline-flex; align-items: center; flex-shrink: 0; }
  .memory-hits__icon svg { display: block; }
  /* 展开列表：胶囊内缩进平铺命中项（source 徽章 + 标题） */
  .memory-hits__list {
    display: flex; flex-direction: column; gap: var(--sp-1, 4px);
    padding: 0 var(--sp-3, 8px) var(--sp-2, 6px);
  }
  .memory-hits__item {
    display: flex; align-items: baseline; gap: var(--sp-2, 6px);
    font-size: var(--font-sm, 11px); line-height: var(--lh-normal);
    word-break: break-all;
  }
  .memory-hits__source {
    flex-shrink: 0;
    font-size: var(--font-xs, 10px);
    color: var(--accent, #0e639c);
    border: var(--line-solid);
    border-radius: var(--radius-pill);
    padding: 0 var(--sp-2, 6px);
  }
  .memory-hits__name { color: var(--text-primary, #cccccc); }
  /* 反馈入口（HOST-S3-3）：行尾 ✕，hover 行 / 键盘聚焦才显现（opacity 保 focus 可达）；
   * 点击 = 发 memory_delete（宿主模态确认后软删，回收站可恢复），与 memoryView 卡片 ✕ 同语义 */
  .memory-hits__remove {
    flex-shrink: 0;
    margin-left: auto;
    border: none;
    background: transparent;
    padding: 0 var(--sp-1, 4px);
    font-size: var(--font-xs, 10px);
    line-height: var(--lh-flat);
    color: var(--text-secondary, #9aa0a6);
    cursor: pointer;
    opacity: 0;
  }
  .memory-hits__item:hover .memory-hits__remove,
  .memory-hits__remove:focus-visible { opacity: 1; }
  .memory-hits__remove:hover { color: var(--text-primary, #cccccc); }
  /* 记忆命中明细·工具行内落位（MEM-EVENT-2）：挂在 search_memories 工具折叠体尾部。
   * 刻意不复用 .memory-hits 的胶囊外壳（那是轮次级兜底行的样式，自带 summary 箭头）——
   * 父级工具行已是折叠体，这里只做「标题 + 列表」的内嵌块，避免双层折叠要连点两次。
   * 子项类（__item/__source/__name/__remove）与兜底行**共用同一套样式**，此处只做容器级
   * 微调（列表左内缩进归零，与工具行体对齐）——改子项样式会同时影响两处，勿在此就地覆写。 */
  .round-block__memory-hits {
    margin-top: var(--sp-2, 6px);
    padding-top: var(--sp-2, 6px);
    border-top: var(--line-solid);
  }
  .round-block__memory-hits > .memory-hits__label {
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    margin-bottom: var(--sp-1, 4px);
  }
  .round-block__memory-hits .memory-hits__list { padding: 0; }
  /* 摘要徽章：工具行收起（成功行 open=false）时**唯一可见**的「这次调用看过记忆」信号。
   * 落位迁移不得吃掉原本可见的信息——没有这枚徽章，命中明细会藏进折叠体变成事实性隐没。 */
  .round-block__memory-badge {
    flex-shrink: 0;
    margin-left: var(--sp-2, 6px);
    padding: 0 var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    line-height: var(--lh-flat);
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-thought, #252526);
    border-radius: var(--radius-pill);
  }
  .round-block__details {
    margin-top: var(--sp-1, 4px);
    display: flex; flex-direction: column; gap: var(--sp-2, 6px);
  }
  /* 运行时过程平铺容器：运行时无 round-block 大折叠壳——
     过程（narrate 冒号行 / 工具折叠行 / 思考状态）按任务项时序平铺于此，透明无壳；
     done/interrupted finalize 时移除、内容收进 round-block 折叠块。任务表例外：
     plan_item_boundary 时平铺内容归入 .round-block__plan-item 折叠块（复用折叠视觉）。 */
  .process-flow {
    display: flex; flex-direction: column; gap: var(--sp-1, 4px);
    padding: var(--sp-1, 4px) 0;
  }
  .process-flow__phase {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
  }
  .process-flow__phase.is-tool { color: var(--text-primary, #cccccc); font-weight: 600; }
  .process-flow__phase::before {
    content: ''; width: var(--dot-sm); height: var(--dot-sm); border-radius: 50%; flex-shrink: 0;
    background: var(--accent, #0e639c);
    animation: selfReviewPulse var(--dur-pulse) ease-in-out infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .process-flow__phase::before { animation: none; }
  }
  /* 叙述冒号行：平铺直示（非折叠）——「AI 说什么：」后接工具折叠块 */
  .process-flow__narrate {
    font-size: var(--font-sm, 11px); line-height: var(--lh-normal);
    color: var(--text-primary, #cccccc);
    white-space: pre-wrap; word-break: break-all;
  }
  /* 中断轮平铺收尾行（过程折叠、停止行折叠块外平铺常驻——RT/RP 同构） */
  .round-block__interrupted {
    margin: var(--sp-2, 6px) 0 var(--sp-0, 2px); padding: var(--sp-1, 4px) 0;
    border-top: var(--line-dashed);
    font-size: var(--font-sm, 11px); line-height: var(--lh-normal); font-weight: 600;
    color: var(--danger, #f14c4c);
    word-break: break-all;
  }
  .round-block__section-title {
    font-size: var(--font-xs, 10px); letter-spacing: 0.3px;
    color: var(--text-secondary, #9aa0a6);
    margin-bottom: var(--sp-1, 4px);
  }
  .round-block__row {
    display: flex; align-items: baseline; gap: var(--sp-2, 6px);
    padding: var(--sp-1, 4px) 0; line-height: var(--lh-normal);
    word-break: break-all;
  }
  /* 任务项级折叠容器：active 任务项推进时，后续 narrate/tool
   * 归入对应任务项折叠块（summary 显示「任务项 N · 标题」），实现「边界切组、任务项内平铺」。
   * 无 plan_item_boundary 时不出现（退回整轮扁平）。默认收起——任务项过程属过程明细，报告保持简洁。 */
  .round-block__plan-item {
    /* 层级形态：组标题（summary）顶格显示在最外侧、与叙述/工具行同列——组本身零 padding、无边线
     * （边线与「标题最外侧」结构性冲突：线恒在最左，标题永远差线宽无法顶格；
     *   分组语义由下方组内缩进独立表达，线成冗余，伴生 border-radius 一并清理）。
     * 运行时与重放共用本类（getOrCreatePlanItemGroup 唯一构造点），改样式即两路径同逻辑生效。 */
    margin: var(--sp-2, 6px) 0;
  }
  /* 组内二级缩进：summary 之外的过程行（narrate/tool/thought/输入条目）相对组标题右移一档
   * （--sp-6 = 16px，与正文 markdown 列表缩进同档）。
   * 用 :not(summary) 而非包 wrapper——组内行平铺 details 顶层（无共同容器），包容器会破坏
   * insertPlanItemGroupInOrder 的「root 直接子节点」排序前提，属带伤改法。 */
  .round-block__plan-item > :not(summary) { margin-left: var(--sp-6, 16px); }
  .round-block__plan-item-summary {
    cursor: pointer; user-select: none; outline: none; list-style: none;
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
    font-weight: 600;
  }
  .round-block__plan-item-summary::-webkit-details-marker { display: none; }
  .round-block__plan-item-summary:focus-visible { box-shadow: 0 0 0 1px var(--border-focus); }
  /* 任务项状态图标（applyPlanItemStates 单一写入点的视觉承载，summary 前置）：
   * done = circle-check 完成绿 / active = target 进行中——颜色语义各一处，
   * 复用既有令牌（--status-pass 写确认 ok 按钮在用、--accent 相位行在用），不造新色。 */
  .round-block__plan-item-status {
    display: inline-flex; align-items: center; vertical-align: -2px;
    margin-right: var(--sp-2, 6px);
    color: var(--text-secondary, #9aa0a6);
  }
  .is-plan-done .round-block__plan-item-status { color: var(--status-pass, #4ec9b0); }
  .is-plan-active .round-block__plan-item-status { color: var(--accent, #0e639c); }
  /* 过程叙述行：LLM 一段行动叙述 = 一行纯文本直显（流式 process-flow__narrate 同构形态），
   * 与工具行平级平铺 details 顶层——无折叠（叙述语义即短句，details+双份消费已废） */
  .round-block__narrate {
    padding: var(--sp-1, 4px) 0; line-height: var(--lh-normal);
    font-size: var(--font-xs, 10px);
    color: var(--text-primary, #cccccc);
    word-break: break-all; white-space: pre-wrap;
  }
  /* 思考折叠行/块：模型 thought 流，
   * <details> 折叠；process-flow 运行时与 round-block finalize/重放共用同构形态（按 seq 平铺）。
   * summary = 思考类型标 + 「思考」标签 + 首行预览，展开看全文；
   * 字形双层（批次三）：斜体 + 降饱和（非正文信号——icon 解决认出类型，字形解决「别当正文读」） */
  .process-flow__thought, .round-block__thought { padding: var(--sp-1, 4px) 0; line-height: var(--lh-normal); }
  .process-flow__thought summary, .round-block__thought summary {
    cursor: pointer; font-size: var(--font-xs, 10px);
    font-style: italic;
    color: var(--text-secondary, #9aa0a6);
    word-break: break-all; white-space: pre-wrap;
  }
  .process-flow__thought-body, .round-block__thought-body {
    margin-top: var(--sp-1, 4px); padding: var(--sp-2, 6px);
    border-left: var(--line-solid-thick);
    font-size: var(--font-xs, 10px); line-height: var(--lh-relaxed);
    color: var(--text-secondary, #9aa0a6);
    white-space: pre-wrap; word-break: break-all;
  }
  /* ─── 折叠箭头行内随文（2026-10-05 定案，替代批次三的右缘钉死形态）───
   * 过程块体系全部折叠 summary 隐藏原生 marker（::marker + ::-webkit-details-marker 双写），
   * CSS 自绘 chevron（L 形 border）随 details[open] 旋转——纯 CSS 零 JS。
   * chevron 挂 ::after 行内流式（inline-block），自然衔接标题文字末尾：旧形态绝对定位
   * 钉死容器右缘，短标题与箭头间留大片空白，视觉断裂；折行时箭头随文本流落在末段行尾。
   * ::before 槽位留给工具行运行/待命状态环——环须紧跟工具名让「正在执行」一眼可见，
   * 与行内 chevron 分槽互不干扰（分槽替代原「高特异性覆盖」方案）。
   * 覆盖面 = 两个容器的 summary 后代：.round-block（收尾/重放全量树）+ .process-flow（流式
   * 实时容器）——工具行/工具批/叙述/任务项组的类名不带容器前缀，流式期间挂在 process-flow
   * 下，只按 round-block 选会漏掉它们（原生 marker 裸奔 + 无箭头，与思考行形态分裂，
   * 2026-10-05 真机实锤）。 */
  .round-block summary,
  .process-flow summary {
    list-style: none; /* chevron 行内随文，无需定位基准与右缘留位 */
  }
  .round-block summary::marker,
  .process-flow summary::marker {
    content: none;
  }
  .round-block summary::-webkit-details-marker,
  .process-flow summary::-webkit-details-marker,
  .memory-hits summary::-webkit-details-marker {
    display: none;
  }
  .round-block summary::after,
  .process-flow summary::after,
  .memory-hits summary::after {
    content: '';
    display: inline-block;
    margin-left: var(--sp-2, 6px); /* 与标题文字的衔接间距 */
    vertical-align: middle; /* 箭头居文字行中线 */
    width: var(--dot-sm); height: var(--dot-sm);
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(-45deg); /* 收起态：右向「＞」 */
    transition: transform var(--dur-base) ease;
  }
  /* flex summary（外层折叠区标题 / 工具批标题）：gap 已提供衔接间距，margin 归零防双倍；
     align-self/align-items 替代 vertical-align（flex item 上后者无效） */
  .round-block > summary::after,
  .round-block .round-block__tool-batch-summary::after,
  .process-flow .round-block__tool-batch-summary::after,
  .memory-hits > summary::after {
    margin-left: 0;
    align-self: center;
  }
  /* 展开态：下向「⌄」；状态环在 ::before 槽，不受此规则污染 */
  details[open] > summary::after {
    transform: rotate(45deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .round-block summary::after,
    .process-flow summary::after,
    .memory-hits summary::after {
      transition: none;
    }
  }
  /* 块类型标（批次三）：thought/tool icon 注入容器（getIconSvg 静态 SVG），
   * 基线对齐微调；运行/待命态隐藏（环已承担状态+类型双标识，防「环+icon」双标） */
  .round-block__type-icon {
    display: inline-block;
    vertical-align: -2px;
    margin-right: var(--sp-1, 4px);
  }
  .round-block__tool.is-tool-running .round-block__type-icon,
  .round-block__tool.is-tool-pending .round-block__type-icon {
    display: none;
  }
  .round-block__pre {
    margin: var(--sp-1, 4px) 0; padding: var(--sp-2, 6px);
    background: var(--surface-code, rgba(127, 127, 127, 0.15));
    border-radius: var(--radius, 6px);
    font-size: var(--font-xs, 10px); line-height: var(--lh-snug);
    white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere;
  }
  /* 实时相位行：进行中 details 顶部单条「当前正在做什么」（呼吸点动画，遵守 prefers-reduced-motion） */
  .round-block__phase {
    display: flex; align-items: center; gap: var(--sp-2, 6px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
  }
  .round-block__phase::before {
    content: ''; width: var(--dot-sm); height: var(--dot-sm); border-radius: 50%; flex-shrink: 0;
    background: var(--accent, #0e639c);
    animation: selfReviewPulse var(--dur-pulse) ease-in-out infinite;
  }
  /* 相位行切「工具执行」态——进行中工具优先显示执行叙述，主色强调 + 呼吸点延续 */
  .round-block__phase.is-tool { color: var(--text-primary, #cccccc); font-weight: 600; }
  @media (prefers-reduced-motion: reduce) {
    .round-block__phase::before { animation: none; }
  }
  /* 工具调用折叠行：summary 常显名称(状态)，body（args + result）按需展开；
     与 narrate 平级平铺 details 顶层，各自独立折叠 */
  .round-block__tool {
    border-left: var(--line-solid);
    border-radius: 0 var(--radius, 6px) var(--radius, 6px) 0;
    padding: var(--sp-1, 4px) var(--sp-3, 8px);
    margin: var(--sp-1, 4px) 0;
  }
  .round-block__tool summary {
    cursor: pointer; user-select: none; outline: none;
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
  }
  .round-block__tool summary:focus-visible { box-shadow: 0 0 0 1px var(--border-focus); }
  .round-block__tool-summary { font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6); padding: 0 0 var(--sp-1, 4px); }
  /* web_search 裁决证据块：工具行展开体内的归因三件套（端点/条数/命中标题），与结果摘要同层。
     仅重放路径渲染（证据轮末才落盘，实时无此字段）；逐行紧凑、弱化色，展开行体时随行可见 */
  .round-block__search-evidence {
    margin-top: var(--sp-1, 4px);
    padding-top: var(--sp-1, 4px);
    border-top: var(--line-solid);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    line-height: 1.5;
  }
  /* 工具批块（toolBatch）：前后相邻、中间无打断物的连续工具合并为一块（分组判据见 chatView
     groupToolBatches，方案-工具批折叠合并 §3.1）。块标题 = 工具叙述句（toolSummaryText，与
     轮收尾摘要同源）、不带序号；单工具批不包裹（行即批，视觉等价现状零回归）。 */
  .round-block__tool-batch {
    margin: var(--sp-1, 4px) 0;
    padding-left: var(--sp-3, 8px);
    border-left: var(--line-solid-thick);
    border-radius: 0 var(--radius, 6px) var(--radius, 6px) 0;
  }
  .round-block__tool-batch-summary {
    cursor: pointer; user-select: none; outline: none; list-style: none;
    display: flex; align-items: baseline; gap: var(--sp-2, 6px); flex-wrap: wrap;
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
  }
  .round-block__tool-batch-summary::-webkit-details-marker { display: none; }
  .round-block__tool-batch-summary:focus-visible { box-shadow: 0 0 0 1px var(--border-focus); }
  .round-block__tool-batch-title { font-weight: 600; color: var(--text-primary, #cccccc); }
  .round-block__tool-batch-body { display: flex; flex-direction: column; }
  /* 失败/被拒块级标红（口径②：留段内不拆块，块级提示错误密度） */
  .round-block__tool-batch.is-tool-batch-failed { border-left-color: var(--danger, #f14c4c); }
  .round-block__tool-batch-warn { color: var(--danger, #f14c4c); font-weight: 600; }
  /* 进行中工具行——高亮左缘 + 主色名称 + summary 前置旋转圆环，让「正在执行的工具」一眼可见；
     result 到达即移除（updateToolRowState 切 class），收尾全量渲染天然不带该态。
     运行期间正文光标由八态状态机切「运行工具中」态（无 CSS 隐性联动） */
  .round-block__tool.is-tool-running {
    border-left-color: var(--accent, #0e639c);
    background: var(--surface-thought, #252526);
  }
  .round-block__tool.is-tool-running > summary { color: var(--text-primary, #cccccc); font-weight: 600; }
  .round-block__tool.is-tool-running > summary::before {
    content: ''; display: inline-block; width: var(--dot-lg); height: var(--dot-lg);
    margin-right: var(--sp-2, 6px); vertical-align: -1px;
    border: 1.5px solid transparent; border-top-color: var(--accent, #0e639c);
    border-radius: 50%; box-sizing: border-box;
    animation: toolSpinner var(--dur-spin-soft) linear infinite;
  }
  /* 运行中行恒展开，环即状态即类型——chevron 无交互意义，压掉（防双状态标识） */
  .round-block__tool.is-tool-running > summary::after {
    display: none;
  }
  @keyframes toolSpinner { to { transform: rotate(360deg); } }
  /* 工具准备中态：LLM 流式生成 tool_call 参数期间的「准备中」行——静态浅环
     （与执行中 is-tool-running 的旋转环相区分，语义分层「准备中 / 执行中」）。 */
  .round-block__tool.is-tool-pending {
    border-left-color: var(--border-panel, rgba(128,128,128,.4));
  }
  .round-block__tool.is-tool-pending > summary::before {
    content: ''; display: inline-block; width: var(--dot-lg); height: var(--dot-lg);
    margin-right: var(--sp-2, 6px); vertical-align: -1px;
    border: var(--line-solid-mid);
    border-radius: 50%; box-sizing: border-box;
  }
  /* 工具运行期间的动态指示统一由工具旋转图标承担，正文光标由八态状态机切换为
     「运行工具中」态（chatView syncRunningCursor 推导），无隐性 CSS 联动。
     （批次二删除原 :has(.is-tool-running) 熄灭规则：双闪烁动画打架的前提已消失） */
  @media (prefers-reduced-motion: reduce) {
    .round-block__tool.is-tool-running > summary::before { animation: none; }
  }
  /* 工具等待时长标签（瞬态，仅进行中工具行显示「Ns」） */
  .round-block__elapsed {
    margin-left: var(--sp-2, 6px);
    color: var(--text-secondary, #9aa0a6);
    font-variant-numeric: tabular-nums;
  }
  @keyframes selfReviewPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: var(--op-2); }
  }

  /* ============ Components：活动状态区 · 抽屉时间段（历史 + 指标） ============ */
  /* 时间段（C1）：#dockPanel 的静态第二段，不再是随瞬态条进出的 <details>。
   * 外边框/外边距由抽屉体承担，本段只留排版；与控件段并存时顶部分隔线（gap 已给间距）。
   * 被主状态条覆盖的提示不丢失，全部在历史列表回溯（有界 MAX_ACTIVITY_HISTORY 条）。
   * 限高（2026-10-13 用户实测「攒很多很高」收口）：历史有界=20 条但每行 ~22px 全量铺开
   * 仍可达 ~440px，叠加收纳控件段与指标段后抽屉过长 ⇒ 复用 --dim-lg（160px，兑现其
   * 「活动详情面板高」注释，零新 token）限高 + 纵向滚动，超出隐藏滚动查看。 */
  .status-dock__timeline {
    margin: 0; font-size: var(--font-sm, 11px);
    color: var(--text-secondary, #9aa0a6);
    flex-shrink: 0; min-width: 0;
    max-height: var(--dim-lg); overflow-y: auto;
  }
  .status-dock__controls:not([hidden]) + .status-dock__timeline {
    padding-top: var(--sp-2, 6px);
    border-top: var(--line-solid);
  }
  /* 段头「活动」已删（2026-10-08 SSOT 收口）：抽屉标签唯一真源 = dockChip 文案
   * （resolveDock 单点动态赋值「活动/+N」），展开态 chip 紧邻面板上方，段头为第二份硬编码副本。
   * 消费面三处已同步清：chatPanel 骨架 / chatViewTestEnv 镜像 / 本规则。 */
  .activity-list { padding: 0; }
  .activity-list__row {
    display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3, 8px);
    padding: var(--sp-1, 4px) 0; line-height: var(--lh-normal);
  }
  .activity-list__row.error { color: var(--feedback-error-fg); }
  /* 决策记录行（C2 第三类事件）：左侧竖线与普通活动行区分，复用中性色不引入新 token */
  .activity-list__row.decision {
    border-left: 2px solid var(--text-secondary, #9aa0a6);
    padding-left: var(--sp-2, 6px);
  }
  .activity-list__time {
    font-size: var(--font-xs, 10px); color: var(--text-secondary, #9aa0a6);
    flex-shrink: 0;
  }
  .activity-metrics {
    /* 与历史列表的分隔线；横向/底部留白由抽屉体 padding 承担，不双倍 */
    padding: var(--sp-2, 6px) 0 0; line-height: var(--lh-relaxed);
    white-space: pre-wrap; word-break: break-all;
    border-top: var(--line-solid);
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
    border: var(--line-input);
    background: var(--surface-input, #3c3c3c); color: var(--text-input, #cccccc);
  }
  #clarifyOptions { display: flex; flex-wrap: wrap; gap: var(--sp-2, 6px); }
  .opt-btn {
    padding: var(--sp-1, 4px) var(--sp-4, 10px); font-size: var(--font-md, 12px); border-radius: var(--radius-pill, 999px);
    border: 1px solid var(--feedback-warn-accent);
    background: transparent; color: var(--feedback-warn-fg); cursor: pointer;
  }
  .opt-btn:hover { background: var(--feedback-warn-bg); }

  /* ============ Utilities：减少动效（可访问性） ============ */
  /* 全局通配选择器级 reduce 兜底已提升至 tokens（令牌层）——对话面板与设置面板由此统一
   * 覆盖，不再各管一段。本文件保留下方各处针对 infinite spinner / 常驻条的精确降级：
   * 它们需要 animation: none 断根治疾，而非仅把时长压到 0.01ms。 */
`;
