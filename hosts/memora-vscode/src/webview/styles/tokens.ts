/**
 * 设计令牌 — 全插件 Webview 样式层的单一真理源（SSOT）
 *
 * 分层（ITCSS 设计令牌层）：
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
    --sp-hair: 1px; /* 极紧凑微调（chip 内 padding 等），刻度最细一档，非布局级间距 */
    --sp-0: 2px;  /* 紧凑间距下界（菜单项间距 / 紧凑 padding） */
    --sp-1: 4px;  --sp-2: 6px;  --sp-3: 8px;
    --sp-4: 10px; --sp-5: 12px; --sp-6: 16px;
    --sp-8: 24px; /* 大留白（空态区上下 padding 等） */

    /* === L1 基础令牌：圆角刻度 === */
    --radius-sm: 2px; /* 紧凑圆角下界（用户消息气泡小角） */
    --radius: 6px; --radius-lg: 8px; --radius-xl: 14px;
    --radius-pill: 999px; /* 胶囊/徽章（无限大圆角） */
    /* L1 基础令牌：状态圆点尺寸（呼吸点 / 未读点 / 角标指示）
     * --dot-lg 曾删（2026-10-08，旧消费者为已删的收起态气泡 ::after 圆点，被僵尸守卫拦截）；
     * 2026-10-12 回归：过程流 / 工具行的 10px 圆点有真实消费者 2 处（非僵尸），
     * 且此前以裸值散落 ⇒ 归入本刻度。删前先查消费者是铁律，回归同理。 */
    --dot-sm: 5px; --dot-md: 6px; --dot-lg: 10px;

    /* === L1 基础令牌：方形控件尺寸（图标 / 头像 / 方形按钮） ===
     * 本库同构模式：width 与 height 取同值成对出现。此前以裸值散落 46 处，
     * 抽刻度后改尺寸只需动一处。语义命名取中性（sq = square）——既承载图标，
     * 也承载头像与方形按钮，不绑死在某个组件名上。 */
    --sq-xs: 16px; --sq-sm: 18px; --sq-md: 22px;
    --sq-lg: 24px; --sq-xl: 28px; --sq-2xl: 32px;

    /* === L1 基础令牌：内联图标尺寸刻度（UI-TOKEN-AXIS-1 · 2026-10-12） ===
     * 与 --sq-* 的分工：--sq-* 承载**控件方块**（图标按钮 / 头像 / 方形按钮，下界 16px），
     * --icon-* 承载**内联小图标与装饰图形**（11~26px）——此前这一档全部裸写（11/12/13/15/
     * 20/26px 共 7 处），既绕开刻度，也挤不进 --sq-*（下界过高会导致「26px 归到 24 还是 28」
     * 的二选一改尺寸）。本组 **1:1 沿用现状值** ⇒ 零视觉变化，只把裸值换成契约。 */
    --icon-3xs: 11px; /* 折叠箭头等最小内联图形 */
    --icon-2xs: 12px; /* 行内状态小图标 */
    --icon-xs: 13px;  /* 提示行警告图标 */
    --icon-sm: 15px;  /* 稍大内联图形（仅约束宽度时） */
    --icon-md: 20px;  /* 悬浮操作按钮（删除 / 收起） */
    --icon-lg: 26px;  /* 配置图标底 / 下拉触发器 */

    /* === L1 基础令牌：大尺寸维度刻度（UI-TOKEN-RAW-2 · 2026-10-12） ===
     * 跨 width/height/max-width/max-height/min-width/min-height 复用的「大尺寸」档位，
     * 此前以裸值散落 17 处（280/320/160/60/40/360px）。语义取中性（dim = dimension），
     * 不绑死在某个组件上；本组 **1:1 沿用现状值** ⇒ 零视觉变化，只把裸值换成契约。
     * ⚠️ 48px 无独立裸值消费者（仅出现在 calc(100vw - 48px) 减法项），故不入刻度，
     * 避免造出无消费者的僵尸令牌（与「删前先查消费者」铁律一致）。 */
    --dim-sm: 40px;   /* 紧凑控件宽（开关 / 装饰块） */
    --dim-md: 60px;   /* 进度条最小宽 / 列表最小高 */
    --dim-lg: 160px;  /* 长输入折叠阈值 / 活动详情面板高 */
    --dim-xl: 280px;  /* 会话历史菜单 / 设置面板最大宽 */
    --dim-2xl: 320px; /* 空态 / 提示卡 / 工具详情最大宽高 */
    --dim-3xl: 360px; /* 配置弹窗 / 团队弹窗最大宽 */

    /* === L1 基础令牌：字号阶梯 === */
    --font-2xs: 8px;  /* 极紧凑档：刻度下界，唯一消费者 .context-ring__percent（圆环内百分比数字） */
    --font-xs: 10px; --font-sm: 11px; --font-md: 12px; --font-base: 13px; --font-lg: 14px;

    /* === L1 基础令牌：行高层级刻度（UI-TOKEN-AXIS-1 · 2026-10-12） ===
     * 行高此前以裸值散落 46 处、6 个值（1 / 1.4 / 1.5 / 1.6 / 1.7 / 1.75），排版这一
     * 核心维度完全没有刻度 ⇒ 相邻区域的视觉节奏靠「谁记得住上一次写的是 1.6 还是 1.7」
     * 维系。本组按排版惯例语义命名；2026-10-12 二次收口合并伪精度后 **5 档**：
     *   --lh-loose(1.75 并入) → --lh-relaxed(1.7)，仅差 0.05（约 3%）肉眼不可辨，
     *   取多数值 1.7（4 处 : 1 处）。⚠️ 微视觉变化（1 处），随本批真机验收。 */
    --lh-flat: 1;     /* 单行紧凑：徽章 / 计数 / 图标行（不做多行折行） */
    --lh-tight: 1.4;  /* 紧凑正文：chip / 标签 / 列表项 */
    --lh-snug: 1.5;   /* 偏紧多行：卡片说明文字 */
    --lh-normal: 1.6; /* 常规正文：消息体默认 */
    --lh-relaxed: 1.7; /* 宽松正文：空态 / 提示 / 长段落 / 占用提示 */

    /* === L1 基础令牌：阴影层级 === */
    --shadow-card: 0 2px 8px rgba(0, 0, 0, 0.15);
    --shadow-card-focus: 0 4px 14px rgba(0, 0, 0, 0.25), 0 0 0 2px rgba(14, 99, 156, 0.35);
    --shadow-modal: 0 4px 16px rgba(0, 0, 0, 0.3);
    --shadow-toast: 0 2px 8px rgba(0, 0, 0, 0.3); /* 全局通知 toast 浮层阴影 */
    --overlay-mask: rgba(0, 0, 0, 0.4); /* 模态遮罩底（config modal-mask 与 roles team-modal 共用） */

    /* === L1 基础令牌：层级刻度（z-index） ===
     * 此前 z-index 以裸值散落 14 处、9 个层级（含 100 / 200 / 1000 魔法大数）：既违反
     * 「裸值只在定义处」铁律，也让「谁能盖住谁」无从一眼看清（UI-TOKEN-AXIS-1）。
     * 本组按**用途语义**命名，数值 1:1 沿用现状 ⇒ **零层级变化**（不改任何覆盖关系），
     * 只把魔法数换成可读契约；日后要调整层序，在此单点改即可。
     * 语义梯度：base（同层基准）< raise（浮于同层内容）< float（浮层锚定）
     *   < bar（输入区 / toast）< anchor（弹窗锚点）< tip（悬浮提示）
     *   < menu（下拉菜单）< menuTop（模型选择器）< overlay（全屏遮罩）。 */
    --z-base: 1;       /* 同层基准：消息区 / 菜单 sticky 表头 */
    --z-raise: 5;      /* 浮于同层内容：一键到底按钮 */
    --z-float: 10;     /* 浮层锚定层：plan-bar / 模态遮罩 / 下拉触发器 */
    --z-bar: 20;       /* 输入区与 toast：承载浮层、盖住消息区 */
    --z-anchor: 25;    /* 弹窗锚点（占用环）：弹窗向上展开不被输入卡片裁切 */
    --z-tip: 30;       /* 悬浮提示（占用环 tip）：盖住输入区 */
    --z-menu: 100;     /* 下拉菜单浮层 */
    --z-menu-top: 200; /* 模型选择器菜单：浮于所有内容之上 */
    --z-overlay: 1000; /* 全屏模态遮罩 */

    /* === L1 基础令牌：不透明度刻度（UI-TOKEN-AXIS-1 · 2026-10-12） ===
     * 透明度此前以裸值散落 41 处、11 个值，且「.5」与「0.5」两种写法并存。
     * **豁免口径（与 px 零值同构）**：「opacity: 0 / 1」是结构性常量（完全隐藏 / 完全显示），
     * 不是「刻度取值」，不纳入本组、保持裸写（业界通行，且令牌化反而降低可读性）。
     * 本组收**中间态**，合并伪精度后 **5 档**（2026-10-12 二次收口）：
     *   --op-1(.35 并入) → --op-2(.4)；--op-4(.55 并入) → --op-5(.6)；--op-7(.85 并入) → --op-8(.9)。
     *   三对各差 0.05 肉眼不可辨，合并方向取**较高值**（避免降低不透明度损可读性）。
     *   ⚠️ 微视觉变化（6 处），随本批真机验收。
     * **豁免口径（与 px 零值同构）**：「opacity: 0 / 1」是结构性常量（完全隐藏 / 完全显示），
     * 不是「刻度取值」，不纳入本组、保持裸写（业界通行，且令牌化反而降低可读性）。 */
    --op-2: 0.4;  /* 弱：未读点 / 弱化装饰 / 禁用态控件底 */
    --op-3: 0.5;  /* 半透：禁用按钮 */
    --op-5: 0.6;  /* 次级：提示文字 / 图标 / 次要信息 */
    --op-6: 0.75; /* 三级强调 */
    --op-8: 0.9;  /* 接近全显 */

    /* === L2 语义令牌：表面 === */
    --surface-page: var(--vscode-editor-background, #1e1e1e);
    --surface-input: var(--vscode-input-background, #3c3c3c);
    --surface-card: var(--vscode-editorWidget-background, #252526);
    --surface-hover: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
    --surface-checked: var(--vscode-list-activeSelectionBackground, rgba(156, 39, 176, 0.12)); /* 列表项选中底 */

    /* === L2 语义令牌：边框 === */
    --border-input: var(--vscode-input-border, rgba(128, 128, 128, 0.5));
    --border-panel: var(--vscode-panel-border, rgba(128, 128, 128, 0.4));
    --border-focus: var(--vscode-focusBorder, #0e639c);

    /* === L2 语义令牌：文本 === */
    --text-primary: var(--vscode-foreground, #cccccc);
    --text-secondary: var(--vscode-descriptionForeground, #9aa0a6);
    --text-input: var(--vscode-input-foreground, #cccccc);

    /* === L2 语义令牌：字体族（VS Code 原生契约） ===
     * 此前 UI 字体栈与代码块等宽栈均以裸值散落各处（且等宽栈分裂为两套变体），
     * 绕开 VS Code 主题变量，用户在设置里指定的编辑器字体对插件完全无效。
     * 本组令牌是 webview 字体的唯一出口——样式文件不得再写字体栈裸值。
     * ⚠️ 字号阶梯刻意**不**跟随 --vscode-font-size：本 UI 为高信息密度紧凑布局，
     *    跟随用户的编辑器字号会撑破徽章 / 标签 / 圆环等固定尺寸控件。 */
    --font-ui: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
    --font-mono: var(--vscode-editor-font-family, ui-monospace, Consolas, monospace);

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
    /* ⚠️ 变量选错已修（UI-TOKEN-WARN-1，2026-10-12）：原引 --vscode-descriptionForeground
     * （次要灰）⇒ 主路径把「警告文字」渲染成灰色，与回退的警告黄 #d7ba7d 语义自相矛盾。
     * 改引 inputValidation-warningForeground，与 --feedback-warn-bg 同族配套（真机验收）。 */
    --feedback-warn-fg: var(--vscode-inputValidation-warningForeground, #d7ba7d);
    --feedback-warn-accent: var(--vscode-charts-yellow, #d7ba7d);

    /* === L2 语义令牌：状态指示色（工具成功/失败） === */
    --status-pass: var(--vscode-testing-iconPassed, #4ec9b0);
    --status-fail: var(--vscode-errorForeground, #f14c4c);

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
     * 仅新增真正需要的语义令牌，其余一律复用已有令牌。
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
    --skill-health-warn: var(--vscode-charts-yellow, #d7ba7d);
    /* Accent 背景分级（badge/hover/active 三档，chatStyles/dropdown 统一引用）
     * 用 VSCode 语义变量，跟随主题自动适配亮/暗模式：
     *   hover = listHoverBackground（列表悬停态）
     *   subtle = inactiveSelectionBackground（非活跃选区背景）
     *   active = button-secondaryHoverBackground（按钮激活态） */
    --accent-bg-hover: var(--vscode-list-hoverBackground, rgba(14, 99, 156, 0.06));
    /* --accent-bg-subtle / --accent-bg-active 回退按同引同值对齐（2026-10-12）：
     *   它们与 --surface-user-bubble / --btn-secondary-bg 同引同一 --vscode-* 变量，
     *   回退曾各走蓝灰两套色系 ⇒ 脱钩路径会分裂。统一为中性灰（主路径零变化），
     *   accent 蓝调语义由主题变量本身承载（注释留档，勿据回退色判断语义）。 */
    --accent-bg-subtle: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.2));
    --accent-bg-active: var(--vscode-button-secondaryHoverBackground, rgba(128, 128, 128, 0.35));

    /* === L2 语义令牌：上下文占用充能色（chatStyles 引用） ===
     * 占用指示器为圆环充能形态（单弧随占用率填充），只需一个充能色；令牌命名 dialogue
     * ——占用增长主要来自对话层。若恢复「按数据层分段着色」，按
     * --occ-rolepack / --occ-memory / --occ-input / --occ-output 命名重建。 */
    --occ-dialogue: var(--vscode-charts-blue, #3794ff);

    /* === L2 语义令牌：菜单（dropdown.ts 引用） ===
     * ⚠️ 变量选错已修（2026-10-12 真机截图实锤，勿回改）：--vscode-menu-background /
     * foreground / selectionBackground / selectionForeground **在 VS Code 主题色表里
     * 不存在**（menu.* 仅 menu.border 与 menu.separatorBackground 存在）⇒ 主路径恒失效、
     * 永远走亮色 fallback #ffffff ⇒ 暗色主题下浮层白底黑字（会话记录 / 技能搜索两个
     * 下拉均中招）。此前 SEM-1 只是把这组不存在的变量从消费层搬进语义层——**搬家不是
     * 修复**；SSOT-1 排雷时据 dropdown 头注判「复用原生 menu 变量 = 刻意设计意图」
     * 亦系误判（设计意图建立在不存在的前提上）。教训：判「变量存在」要以 VS Code 官方
     * 主题色表为准，不能以「有人这么写过」为准。改引**真实存在**的 dropdown.* 与
     * list.hover* 族：亮色主题 dropdown-background = #ffffff ⇒ 亮色观感不变；
     * 暗色主题浮层随主题转暗（本次视觉变化，真机已反馈白色问题，待复验）。 */
    --menu-bg: var(--vscode-dropdown-background, #252526);
    --menu-fg: var(--vscode-dropdown-foreground, #cccccc);
    --menu-border: var(--vscode-dropdown-border, rgba(128, 128, 128, 0.4));
    --menu-selection-bg: var(--vscode-list-hoverBackground, rgba(14, 99, 156, 0.06));
    --menu-selection-fg: var(--vscode-list-hoverForeground, #cccccc);

    /* === L2 语义令牌：图表/策略色（rolesStyles 策略 chip 引用） ===
     *  策略 chip 直引 --vscode-charts-* 散落 7 处（SSOT 泄漏）。收进语义层；
     *  purple/blue 回退与既有 --skill-rolepack-accent / --occ-dialogue 对齐
     *  （同引同值，无第二套值）。命名对齐 VSCode charts.* 源 + 既有 --chart-* 使用点。 */
    --chart-orange: var(--vscode-charts-orange, #ffa500);
    --chart-green: var(--vscode-charts-green, #4caf50);
    --chart-purple: var(--vscode-charts-purple, #a78bfa);
    --chart-cyan: var(--vscode-charts-cyan, #009688);
    --chart-blue: var(--vscode-charts-blue, #3794ff);

    /* === L2 语义令牌：来源标签（settingsStyles 引用） ===
     *  角色包「用户来源」徽章直引 --vscode-tag-*（中性灰调，区别于 accent 蓝的「当前」徽章）。
     *  收进语义层，裸值回退与直引一致 ⇒ 视觉零变化。 */
    --tag-bg: var(--vscode-tag-background, rgba(90, 93, 94, 0.31));
    --tag-fg: var(--vscode-tag-foreground, #cccccc);

    /* === L2 语义令牌：长尾引用 ===
     * 样式文件以 var(--xxx, 裸值) 引用的令牌须在此统一定义——若本文件未定义、仅靠
     * fallback 兜底，tokens 变更不跟随（坑）。本块定义值与各引用处 fallback 保持一致；
     * 样式文件引用即契约，tokens 修改全局跟随。 */ 
    /* --border / --border-subtle 已折叠进 --border-panel（2026-10-12，勿回改）：
     *   三者同引 --vscode-panel-border ⇒ 主路径恒为同一颜色，「面板 / 常规 / 弱化」
     *   三档区分只在脱钩路径存在。其全部容器描边消费已收进 --line-* 值令牌族，
     *   颜色引用统一 --border-panel（同引同值）。VS Code 无更弱的边框主题变量，
     *   三档真分层需 color-mix 类技术，另行评估。 */
    /* --focus 已折叠进 --border-focus（消费者直引 --border-focus，SSOT 收敛 2026-10-11） */
    /* --text-tertiary / --text-muted 已折叠进 --text-secondary（2026-10-12）：
     *   三者同引 --vscode-descriptionForeground ⇒ 主路径恒为同一颜色，分级只在脱钩路径
     *   存在 = 名字承诺层次而实现不分层次。消费者已迁 --text-secondary。 */
    --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
    --accent-soft: var(--accent-bg-subtle, rgba(14, 99, 156, 0.12));
    --danger: var(--vscode-errorForeground, #f14c4c);
    /* --surface 已折叠进 --surface-page（消费者直引 --surface-page，SSOT 收敛 2026-10-11） */
    /* --surface-normal 已折叠进 --surface-inset（同引 toolbar-hoverBackground、同为静态表面）；
     * --surface-inverse 已折叠进 --accent-foreground（2026-10-12）：它引 --vscode-foreground，
     * 与 --text-primary 同变量同语义＝实质别名；用在 accent 底色上时亮色主题对比度掉到
     * 约 2.98:1，故改配 --accent-foreground（与 accent 底同源配对，约 4.43:1）。 */
    --surface-track: var(--vscode-progressBar-background, #2a2a2a);
    /* --surface-tip 已折叠进 --surface-card（同引 editorWidget-background，2026-10-12） */
    /* --surface-inset（静态内嵌面）：UI-TOKEN-LAYER-2（2026-10-12 真机验收）——原引
     * toolbar-hoverBackground，与 --surface-hover 同变量 ⇒ 静态表面与 hover 主路径同色
     * （.status-dock__chip 常态与 :hover 无差别）。改引 textCodeBlock-background 与 hover
     * **不同源** ⇒ 静态面与交互态真分层；回退与 --surface-code 对齐（同引同值）。 */
    --surface-inset: var(--vscode-textCodeBlock-background, rgba(127, 127, 127, 0.15));
    /* --surface-panel 已折叠进 --surface-sidebar（同引 sideBar-background，2026-10-12） */
    /* --surface-active 已退役（2026-10-12）：它同引 toolbar-hoverBackground，与 --surface-hover
     * 主路径恒同值 = 同义令牌。消费者按**语义**分流（不是一刀切改名）——hover 用途迁
     * --surface-hover、选中用途（会话标签 .is-active）迁 --surface-checked、静态徽章迁
     * --surface-inset ⇒ 选中态由此真正区别于 hover。 */
    --radius-md: var(--radius, 6px);
    --radius-full: var(--radius-pill, 999px);
    --warn: var(--vscode-charts-yellow, #d7ba7d);
    --text-error: var(--vscode-errorForeground, #f14c4c);

    /* === L3 组件令牌：线的形态（分隔线 + 容器描边统一族 · 2026-10-12） ===
     * 演进：U5 先收「分隔线」13 处为 --divider-solid/dashed；真机批次发现容器描边
     * 48 处与分隔线**值完全相同**（1px solid + 面板边框色）⇒ 按 SSOT「并列 = 腐化」
     * 升级为中性 --line-* 族（不绑用途：线与描边同源），divider 系改名并入，另收
     * 2px / 1.5px 变体与输入框描边。全族 1:1 沿用现状值 ⇒ 零视觉变化。
     *
     * ⚠️ 为何不用「全局 .divider-top 工具类」（U5 原提案）——实测否决，勿回改：
     *   chatStyles 的「.status-dock__controls:not([hidden]) + .status-dock__timeline」
     *   是**条件性相邻兄弟选择器**（仅控制段可见时才画线）；工具类靠加 class 生效，
     *   一加就退化成无条件常驻画线 ⇒ 行为变化（带伤）。值令牌是纯值替换，选择器与
     *   特异性原样保留，条件不丢。 */
    --line-solid: 1px solid var(--border-panel, rgba(128, 128, 128, 0.4));
    --line-dashed: 1px dashed var(--border-panel, rgba(128, 128, 128, 0.4));
    --line-solid-mid: 1.5px solid var(--border-panel, rgba(128, 128, 128, 0.4)); /* 强调描边（1.5px 渲染偏糊，待真机定去留） */
    --line-solid-thick: 2px solid var(--border-panel, rgba(128, 128, 128, 0.4)); /* 左侧竖条强调 */
    --line-input: 1px solid var(--border-input, rgba(128, 128, 128, 0.5)); /* 输入框描边（色域独立于面板边框） */

    /* === L3 组件令牌：下拉胶囊尺寸（dropdown.ts 引用） === */
    --dd-trigger-max-w: 200px;   /* 胶囊触发器最大宽（超长省略兜底） */
    --dd-menu-min-w: 160px;      /* 胶囊菜单最小宽 */
    --dd-menu-max-w: 240px;      /* 胶囊菜单最大宽 */

    /* === L1 基础令牌：动画/过渡时长刻度（全库唯一动画时长源，chatStyles 引用） === */
    --dur-fast: 120ms;        /* 快速过渡（hover / 瞬时反馈） */
    --dur-base: 150ms;       /* 常规过渡（颜色 / 边框 / 位移） */
    --dur-slow: 300ms;       /* 慢过渡（宽度收展等） */
    --dur-open: 200ms;       /* 中速 200ms：抽屉/面板展开（clip-path）+ 通用中速过渡（进度环/Toast/设置/卡片） */
    --dur-open-soft: 220ms;  /* 抽屉滑入（translateX），与 --dur-open 错层 */
    --dur-open-delay: 40ms;  /* 展开错层延迟（先 pill 后抽屉） */
    --dur-fastest: 100ms;    /* 最快过渡（transform 微动 / 列表项瞬态） */
    --dur-med: 180ms;        /* 中速过渡（设置面板显隐） */
    --dur-spin: 800ms;       /* 加载旋转（spin / loadingSpin） */
    --dur-spin-soft: 700ms;  /* 工具结果旋转（toolSpinner，略快） */
    --dur-pulse: 1200ms;     /* 呼吸脉冲（selfReviewPulse） */

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

  /* === Utilities：减少动效（无障碍） ===
   * 系统开启「减弱动态效果」时压掉全部动画与过渡，避免前庭功能障碍用户眩晕。
   * 置于令牌层＝全局兜底：各样式文件（含未来新增）自动覆盖，无需逐个打补丁
   * ——原先这条兜底只挂在 chatStyles 内，导致设置面板侧四套样式完全无降级。
   * ⚠️ animation-iteration-count: 1 不可省：仅压 duration 时 infinite 动画会退化为
   *    极高频重绘（loadingSpin / selfReviewPulse 等 spinner 反而更糟）。 */
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
    }
  }

  /* === Utilities：键盘焦点环（跨视图统一契约） ===
   * 焦点环是 WCAG 2.4.7 的硬性要求，本应跨所有视图完全一致。实测此前 37 条 focus 规则中
   * 有 **15 条是同一条声明的重复拷贝**，且焦点色分散取自 --border-focus / --focus /
   * --vscode-focusBorder 三个来源，outline-offset 还有 2px / 1px / 0 三种取值。
   *
   * 用 :where() 承载 ⇒ **特异性为 0**：各视图既有的自定义焦点样式（如 summary 用
   * box-shadow、chip 用内阴影）都能原样覆盖它、不会打架；未来新增的可聚焦元素也自动获得
   * 焦点环，堵住「新增元素忘了写 focus 样式」这个持续泄漏的口子。
   * 「tabindex=-1」是编程聚焦目标（焦点陷阱/焦点恢复），不属 Tab 序，显示焦点环属视觉
   * 噪音——但裸 [tabindex] 会连它一起匹配，故用 :not() 排除；:where() 内嵌 :not() 特异性仍为 0。
   * 渐进增强：老环境不认 :where() 时整条规则被丢弃，退化为现状，无回归风险。 */
  :where(button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])):focus-visible {
    outline: 2px solid var(--border-focus, #0e639c);
    outline-offset: 2px;
  }

  /* === Utilities：强制色彩模式（Windows 高对比度主题） ===
   * 进入 forced-colors 后系统接管调色板，本仓自定义投影会被整体丢弃——与其让部分元素
   * 保留投影、部分丢失造成层次不一致，不如统一压平，层级改由 border 承载。
   * 焦点环交回系统 Highlight 色，保证键盘焦点在任意高对比度配色下始终可见。 */
  @media (forced-colors: active) {
    *, *::before, *::after {
      box-shadow: none !important;
      text-shadow: none !important;
    }
    :root { --border-focus: Highlight; }
  }

  /* === Utilities：全局 [hidden] 兜底（治本而非打补丁，单一真理源） ===
   * HTML hidden 属性的 display:none 来自 UA 样式表，author 层任何 display 声明都赢它；
   * 本仓所有显隐均经 el.hidden 属性（无 removeAttribute/setAttribute 旁路），故全局
   * !important 兜底无误伤面。任一面板（chat/settings）新增「声明 display 且会被 JS 切
   * hidden」的元素，无需逐条补 .xxx[hidden]，此条自动兜住。
   * 原仅 chatStyles 内嵌 ⇒ settings 面板缺位（依赖 UA 默认属脆弱）；现提至本文件
   * （chat/settings 两面板共用注入基），一处定义、两处生效。 */
  [hidden] { display: none !important; }
`;
