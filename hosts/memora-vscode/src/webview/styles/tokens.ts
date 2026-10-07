/**
 * 设计令牌 — 全插件 Webview 样式层的单一真理源（SSOT）
 *
 * 分层（对齐 ui-engineering-mindset-rules.md §一 设计令牌）：
 *   L1 基础令牌（foundation）：间距 / 圆角 / 字号 / 阴影 —— 裸值只允许出现在本文件
 *   L2 语义令牌：将 --vscode-* 主题变量映射为语义含义（surface / border / text / accent）
 *   L3 组件令牌：输入区等具体组件的内部尺寸契约
 *
 * 铁律：
 *   - 裸值只能出现在本文件（令牌定义处）；
 *   - 其余所有样式文件（chatStyles / configStyles / dropdown）
 *     只能引用令牌，禁止裸值；
 *   - 令牌即契约：间距必须落在刻度上，不存在 margin: 17px；
 *   - 例外：动画位移（入场 translateY 等）、边框宽度、SVG 描边等
 *     「非布局间距」值允许内联，不属于本铁律范围。
 */
export const tokens = `
  :root {
    color-scheme: light dark;

    /* === L1 基础令牌：间距刻度 === */
    --sp-0: 2px;  /* 紧凑间距下界（菜单项间距 / 紧凑 padding） */
    --sp-1: 4px;  --sp-2: 6px;  --sp-3: 8px;
    --sp-4: 10px; --sp-5: 12px; --sp-6: 16px;
    --sp-8: 24px; /* 大留白（空态区上下 padding 等） */

    /* === L1 基础令牌：圆角刻度 === */
    --radius-sm: 2px; /* 紧凑圆角下界（用户消息气泡小角） */
    --radius: 6px; --radius-lg: 8px; --radius-xl: 14px;
    --radius-pill: 999px; /* 胶囊/徽章（无限大圆角） */
    /* L1 基础令牌：状态圆点尺寸（呼吸点 / 未读点 / 角标指示） */
    --dot-sm: 5px; --dot-md: 6px; --dot-lg: 8px;

    /* === L1 基础令牌：字号阶梯 === */
    --font-xs: 10px; --font-sm: 11px; --font-md: 12px; --font-base: 13px; --font-lg: 14px;

    /* === L1 基础令牌：阴影层级 === */
    --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.15);
    --shadow-card-focus: 0 4px 14px rgba(0, 0, 0, 0.25), 0 0 0 2px rgba(14, 99, 156, 0.35);
    --shadow-modal: 0 4px 16px rgba(0, 0, 0, 0.3);
    --shadow-toast: 0 2px 8px rgba(0, 0, 0, 0.3); /* 全局通知 toast 浮层阴影 */
    --overlay-mask: rgba(0, 0, 0, 0.4); /* 模态遮罩底（config modal-mask 与 roles team-modal 共用） */

    /* === L2 语义令牌：表面 === */
    --surface-page: var(--vscode-editor-background, #1e1e1e);
    --surface-input: var(--vscode-input-background, #3c3c3c);
    --surface-card: var(--vscode-editorWidget-background, #252526);
    --surface-hover: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));

    /* === L2 语义令牌：边框 === */
    --border-input: var(--vscode-input-border, rgba(128, 128, 128, 0.5));
    --border-panel: var(--vscode-panel-border, rgba(128, 128, 128, 0.4));
    --border-focus: var(--vscode-focusBorder, #0e639c);

    /* === L2 语义令牌：文本 === */
    --text-primary: var(--vscode-foreground, #cccccc);
    --text-secondary: var(--vscode-descriptionForeground, #9aa0a6);
    --text-input: var(--vscode-input-foreground, #cccccc);

    /* === L2 语义令牌：品牌色（accent） ===
   * 跟随 VSCode 主题，自动适配亮/暗/高对比度模式。 */
    --accent: var(--vscode-button-background, #0e639c);
    --accent-foreground: var(--vscode-button-foreground, #ffffff);

    /* === L2 语义令牌：品牌主色（角色标签/强调标识） ===
   * --brand 保留自定义（产品品牌设定，不跟随主题）。 */
    --brand: #4a9eff;

    /* === L2 语义令牌：反馈状态色（校验/信息/错误/警告） ===
     * 供提示条 / 记忆条 / 主动提问条 / 测试结果 / 错误消息使用。
     * 语义令牌集中映射 --vscode-*，样式文件只引用语义令牌 */
    --feedback-info-bg: var(--vscode-inputValidation-infoBackground, rgba(21, 126, 251, 0.15));
    --feedback-info-fg: var(--vscode-inputValidation-infoForeground, #75beff);
    --feedback-error-bg: var(--vscode-inputValidation-errorBackground, #442726);
    --feedback-error-fg: var(--vscode-inputValidation-errorForeground, #f48771);
    --feedback-error-toast-bg: rgba(200, 60, 50, 0.18); /* settings toast 错误态底 */
    --feedback-error-toast-border: rgba(244, 135, 113, 0.4); /* settings toast 错误态边框 */
    --feedback-warn-bg: var(--vscode-inputValidation-warningBackground, rgba(196, 160, 0, 0.15));
    --feedback-warn-fg: var(--vscode-descriptionForeground, #d7ba7d);
    --feedback-warn-accent: var(--vscode-charts-yellow, #d7ba7d);

    /* === L2 语义令牌：状态指示色（工具成功/失败） === */
    --status-pass: var(--vscode-testing-iconPassed, #4ec9b0);
    --status-fail: var(--vscode-errorForeground, #b3261e);

    /* === L2 语义令牌：控件（按钮/Toast/代码块底） ===
   * 设计决策：选择"可靠的 VSCode 变量"而非"可能 transparent 的变量"。
   *
   *   变量选择指南（VSCode 官方 Theme Color API）：
   *   ┌──────────────────────────────────────┬──────────┬────────────────────────────────────┐
   *   │ 变量                                  │ 可靠性   │ 说明                                 │
   *   ├──────────────────────────────────────┼──────────┼────────────────────────────────────┤
   *   │ --vscode-button-background            │ ✅ 始终  │ 主按钮背景，必有颜色                  │
   *   │ --vscode-button-foreground           │ ✅ 始终  │ 主按钮文字，必有颜色                  │
   *   │ --vscode-button-secondaryBackground   │ ⚠️ 可能  │ 次级按钮，某些主题为 transparent     │
   *   │ --vscode-button-secondaryHoverBackground │ ✅ 始终 │ 次级按钮 hover，必有对比度           │
   *   │ --vscode-button-border                │ ✅ 始终  │ 按钮边框，必有颜色                    │
   *   │ --vscode-list-hoverBackground         │ ✅ 始终  │ 列表 hover，必有颜色                  │
   *   └──────────────────────────────────────┴──────────┴────────────────────────────────────┘
   *
   *   策略：次级按钮用 secondaryHoverBackground（设计为可见的交互色），
   *         而不用 secondaryBackground（某些主题下为 transparent）。
   *   所有变量均带 fallback 值，确保极端情况下仍有可用颜色。 */
    --btn-secondary-bg: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.35)));
    --btn-secondary-fg: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground, #ffffff));
    --btn-danger-bg: var(--vscode-statusBarItem-errorBackground, #b3261e);
    --toast-ok-bg: var(--vscode-statusBarItem-prominentBackground, #2e7d32);
    --surface-sidebar: var(--vscode-sideBar-background, #252526);
    --surface-code: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.15));
    --surface-user-bubble: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.2));

    /* === L2 语义令牌：AI 原生 UI（身份条 / 思考块） ===
     * 对齐 ui-redesign.md §5：仅新增真正需要的语义令牌，其余一律复用已有令牌。
     *   --surface-ai-avatar：AI 头像底色（badge 背景，克制弱化的品牌色）
     *   --surface-thought：思考折叠块底色（编辑器控件背景，与消息区分）
     * 工具状态色复用 --status-pass/fail；日期分隔线复用 --text-secondary；
     * composer 附加能力 chip 复用 --btn-secondary-bg —— 均不重复造令牌。 */
    --surface-ai-avatar: var(--vscode-badge-background, rgba(14, 99, 156, 0.25));
    --surface-thought: var(--vscode-editorWidget-background, #252526);

    /* === L2 语义令牌：技能来源（skillsStyles 引用） ===
     * 复用已有语义令牌，不造裸色：内置技能 = accent（品牌/当前），用户技能 = status-pass（个人/通过）。 */
    --skill-agent-accent: var(--accent, #0e639c);
    --skill-user-accent: var(--status-pass, #4ec9b0);
    /* 角色包技能来源：紫色语义区分内置(蓝)/用户(绿)/角色包(紫)，
     * 用 VSCode charts.purple，跟随主题 */
    --skill-rolepack-accent: var(--vscode-charts-purple, #a78bfa);
    /* 技能健康色：error 未生效 / warn 可优化
     * 用 VSCode charts.yellow，跟随主题 */
    --skill-health-error: var(--text-error, #f14c4c);
    --skill-health-warn: var(--vscode-charts-yellow, #d9a22b);
    /* Accent 背景分级（badge/hover/active 三档，chatStyles/dropdown 统一引用）
     * 用 VSCode 语义变量，跟随主题自动适配亮/暗模式：
     *   hover = listHoverBackground（列表悬停态）
     *   subtle = inactiveSelectionBackground（非活跃选区背景）
     *   active = button-secondaryHoverBackground（按钮激活态） */
    --accent-bg-hover: var(--vscode-list-hoverBackground, rgba(14, 99, 156, 0.06));
    --accent-bg-subtle: var(--vscode-editor-inactiveSelectionBackground, rgba(14, 99, 156, 0.08));
    --accent-bg-active: var(--vscode-button-secondaryHoverBackground, rgba(14, 99, 156, 0.1));

    /* === L2 语义令牌：上下文占用充能色（chatStyles 引用） ===
     * 占用指示器为圆环充能形态（单弧随占用率填充），只需一个充能色；令牌命名 dialogue
     * ——占用增长主要来自对话层。若恢复「按数据层分段着色」，按
     * --occ-rolepack / --occ-memory / --occ-input / --occ-output 命名重建。 */
    --occ-dialogue: var(--vscode-charts-blue, #3794ff);

    /* === L2 语义令牌：长尾引用 ===
     * 样式文件以 var(--xxx, 裸值) 引用的令牌须在此统一定义——若本文件未定义、仅靠
     * fallback 兜底，tokens 变更不跟随（坑）。本块定义值与各引用处 fallback 保持一致；
     * 样式文件引用即契约，tokens 修改全局跟随。 */ 
    --border: var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
    --border-subtle: var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
    --focus: var(--vscode-focusBorder, #007fd4);
    --text-tertiary: var(--vscode-descriptionForeground, #6e7681);
    --text-muted: var(--vscode-descriptionForeground, #9a9a9a);
    --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
    --accent-soft: var(--accent-bg-subtle, rgba(14, 99, 156, 0.12));
    --danger: var(--vscode-errorForeground, #f14c4c);
    --surface: var(--surface-page, #252526);
    --surface-normal: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.16));
    --surface-inverse: var(--vscode-foreground, #ffffff);
    --surface-track: var(--vscode-progressBar-background, #2a2a2a);
    --surface-tip: var(--vscode-editorWidget-background, #2d2d2d);
    --surface-inset: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.12));
    --surface-panel: var(--vscode-sideBar-background, #1e1e1e);
    --surface-active: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.24));
    --radius-md: var(--radius, 6px);
    --radius-full: var(--radius-pill, 999px);
    --warn: var(--vscode-charts-yellow, #cca700);
    --text-error: var(--vscode-errorForeground, #f14c4c);

    /* === L3 组件令牌：下拉胶囊尺寸（dropdown.ts 引用） === */
    --dd-trigger-max-w: 200px;   /* 胶囊触发器最大宽（超长省略兜底） */
    --dd-menu-min-w: 160px;      /* 胶囊菜单最小宽 */
    --dd-menu-max-w: 240px;      /* 胶囊菜单最大宽 */

    /* === L1 基础令牌：动画/过渡时长刻度（全库唯一动画时长源，chatStyles 引用） === */
    --dur-fast: 120ms;        /* 快速过渡（hover / 瞬时反馈） */
    --dur-base: 150ms;       /* 常规过渡（颜色 / 边框 / 位移） */
    --dur-slow: 300ms;       /* 慢过渡（宽度收展等） */
    --dur-open: 200ms;       /* 抽屉/面板展开：从左揭示（clip-path） */
    --dur-open-soft: 220ms;  /* 抽屉滑入（translateX），与 --dur-open 错层 */
    --dur-open-delay: 40ms;  /* 展开错层延迟（先 pill 后抽屉） */

    /* === L3 组件令牌：底部输入区内部尺寸契约 === */
    /* Composer 默认双行起步（大厂惯例），内容撑开自动增高，超限才滚
     * Footer 布局：Actions 行(模型+发送) + Context 行(角色+能力徽章) */
    --input-wrap-min-h: 128px; /* 输入卡片最小总高（textarea 72 + footer ~56） */
    --input-min-h: 72px;       /* textarea 默认双行舒适高度（内容区 ~48px = 2.3 行） */
    --input-max-h: 180px;      /* textarea 展开上限（~7 行，超限显示滚动条） */
    /* 注：不设 --input-footer-h（Footer 由 flex column 自适应高度，不用固定 min-height）。
     * 参考值：56px (Actions 28 + Context 24 + gap 4) */
    --control-h: 28px;         /* 输入区控制件统一高度 */
  }
`;
