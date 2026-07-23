# styles/ — Memora Sprite 渲染层 CSS 架构

> 最后更新：2026-07-23（CSS-R9 控件收口 / CSS-R10 输入框收口 / CSS-R11 洞察栏+健康度诊断面板就地优化：新建 insights.css+health.css 单一真理源，从 graph 文件抽离散落样式）

## 1. 目录结构（按功能域分组，8 个子目录）

```
styles/
├── README.md           # 本文件——CSS 架构文档
│
├── foundation/         # 基础层（设计令牌 + 全局重置 + 工具类，三窗口共享）
│   ├── tokens.css      # 设计令牌「单一真理源」（167 变量：颜色/表面/文字/语义色/激活态语义色/圆角/阴影/z-index/字号/字重/间距/动画播放时长/过渡）
│   ├── base.css        # 全局重置 + 滚动条 + 动画 + focus-visible + 图标系统 + 通用组件基类（icon-btn/empty-state/error-state）
│   ├── utilities.css   # 原子布局工具类（flex-center/flex-col/flex-row-center/surface-card/text-muted + 过渡工具类）
│   └── controls.css    # 共享控件层（L1 单一真理源）：按钮(.btn-*)/标签(.tag/.source-tag/.profile-category)/卡片(.card)，跨面板复用
│
├── layout/             # 布局层（窗口骨架 + 内嵌组件，聚合器 + 5 子模块）
│   ├── layout.css      # 聚合器（@import 5 子模块，CSS-R8 拆分）
│   ├── titlebar.css    # 顶部栏 + 命令面板入口 + 窗口控制按钮 + 角色选择器
│   ├── sidebar.css     # 侧边栏容器 + 品牌区 + 导航图标 + 导航角标 + 视觉分隔线
│   ├── app-grid.css    # 窗口骨架（#app Grid + #main-content 悬浮窗口 + .panel + 信息侧栏双栏布局 + 响应式 @media）
│   ├── widgets.css     # 布局内嵌小部件（仪表盘/默契度/里程碑/技能拖入区/通用下拉菜单/最近洞察列表）
│   └── web-mode.css    # Web 模式适配（body.web-mode 渐变底板 + 隐藏窗口控制 + 放大命令面板 + 悬浮窗口优化）
│
├── chat/               # 对话功能域（聚合器 + 7 子模块）
│   ├── chat.css             # 聚合器（纯 @import 7 子模块）
│   ├── chat-toolbar.css     # 对话工具栏 / 状态条 / 在场脉冲浮层
│   ├── chat-perception.css  # 对话内嵌感知紧凑布局（rapport-row/affect-grid 等紧凑组件）
│   ├── chat-datenav.css     # 回到今天 / 日期选择 / 下拉 / 空状态
│   ├── chat-messages-banner.css  # 主动提示横幅 / 里程碑 / 配置建议卡片
│   ├── chat-messages-bubble.css  # 日期分隔符 / 消息分组 / 气泡 / 头像 / 召回
│   ├── chat-messages-input.css   # 输入区 / 补全 / 停止按钮 / 空状态
│   └── chat-messages-misc.css    # 思考指示器 / 工具卡片 / 动画 / 启动摘要 / 右键菜单
│
├── memory/             # 记忆功能域（聚合器 + 7 子模块 + 1 分析子面板）
│   ├── memory.css             # 聚合器（纯 @import 7 子模块 + 1 分析子面板）
│   ├── memory-list.css        # 面板头 / 搜索 / 记忆列表卡片 / 来源标签
│   ├── memory-detail.css      # 记忆详情弹窗 / 技能列表 / 全局·项目色
│   ├── memory-views.css       # 视图过渡 / 时间线 / Profile 卡片 / 知识缺口 / 成长趋势
│   ├── memory-graph-core.css  # 更多菜单 / 图例 / tooltip / 右键菜单 / 关系编辑
│   ├── memory-graph-search.css # 高级搜索 / 搜索高亮 / 洞察栏
│   ├── memory-graph-detail.css # 关联记忆 / 演化脉络 / 空状态 / 健康度仪表盘
│   ├── memory-graph-misc.css  # 增强 1-5 / 时间线 / 回收站
│   └── completion-stats.css   # 补全统计面板（记忆面板第 3 个 analysis panel，与 insights/health 互斥切换）
│
├── panels/              # 独立面板样式（每个对应一个 .panel）
│   ├── dashboard.css   # 仪表盘面板（概览+运行指标+记忆源健康+增长趋势）
│   ├── perception.css  # 独立感知面板（从 dashboard.css 迁出，覆盖 chat-perception.css 基础样式）
│   ├── clipboard.css   # 剪贴板保护面板（待处理列表 + 引导气泡 + 空状态，clipboardPanelManager 使用）
│   └── settings.css    # 设置面板
│
├── overlays/            # 浮层组件（modal / toast / 命令面板 / 搜索弹窗）
│   ├── modal.css           # 模态弹窗
│   ├── toast.css           # Toast 通知
│   ├── command-palette.css # 快捷命令面板（Ctrl+K，类 VS Code 浮层）
│   └── search-messages.css # 对话内容搜索弹窗（Ctrl+Shift+F）
│
├── content/             # 内容渲染样式
│   └── markdown.css    # Markdown 渲染
│
└── windows/             # 独立窗口专属样式（从 float/ 和 quick-input/ 迁入）
    ├── float.css       # 浮动窗口（引入 foundation 三层 + 本地组件样式）
    └── quick-input.css # 快速输入浮窗（引入 foundation 四层 + 本地组件样式）
```

## 2. 加载顺序

### 2.1 主窗口（index.html 中的 `<link>`，顺序即层叠优先级）

```
foundation/tokens.css      ← 设计令牌「单一真理源」（P0 抽出，双主题 + CJK 字体栈）
foundation/base.css        ← 全局重置 / 滚动条 / 动画 / focus-visible / 图标系统 / 通用组件基类
foundation/utilities.css   ← 通用工具类（flex-center / flex-col / flex-row-center / surface-card / text-muted）
foundation/controls.css     ← 共享控件层（L1 单一真理源）：按钮 / 标签 / 卡片，跨面板复用
layout/layout.css          ← 聚合器（@import 5 子模块：titlebar/sidebar/app-grid/widgets/web-mode）
chat/chat.css              ← 聚合器（@import 7 子模块，见 §3）
memory/memory.css          ← 聚合器（@import 7 子模块 + 1 分析子面板，见 §3）
panels/dashboard.css
panels/perception.css
panels/clipboard.css
panels/settings.css
overlays/modal.css
overlays/toast.css
overlays/command-palette.css
overlays/search-messages.css
content/markdown.css
```

### 2.2 浮动窗口 / 快速输入浮窗（独立 BrowserWindow）

```
foundation/tokens.css      ← 设计令牌
foundation/base.css        ← 全局重置 + .hidden + .icon + 滚动条等通用基类
foundation/utilities.css   ← 原子布局工具类
foundation/controls.css     ← 共享控件层（L1 单一真理源）：按钮 / 标签 / 卡片，跨面板复用
windows/float.css          ← 浮动窗口组件样式
（或 windows/quick-input.css）
```

浮窗独立窗口不共享主窗口 SVG sprite，需在 HTML 中内联 `<symbol>` 定义。两窗均**不内联任何令牌**（P0 已回收 `unsafe-inline`，CSP 收紧为 `style-src 'self'`）。

## 3. 令牌所有权（不可破的约定）

- **`foundation/tokens.css` 是唯一令牌定义处**：颜色 / 表面 / 文字 / 语义色 / 激活态语义色 / 圆角 / 阴影 / z-index / 字号 / 字重 / 间距 / 动画播放时长 / 过渡。任何窗口、任何组件 CSS 只消费 `var()`，不得重新定义或内联令牌。
- 修改令牌只能改 `tokens.css`；新增令牌同理。严禁在组件 CSS 或 HTML 内联 `<style>` 中复制令牌块（这正是 P0 修复的漂移问题）。
- 组件 CSS 间距/圆角一律走 `--space-*` / `--radius-*` 令牌（P1 已收口，含 `--space-2-5: 10px`）；盒阴影、字号、width 等含 px 处保持字面量。
- 激活态语义色统一走 `--active-bg` / `--active-bg-strong` / `--active-fg` / `--active-border` 四件套（2026-07-21 引入，统一 `.active` / `.selected` / `.current` 三套语义，禁止直接引用 `--accent-soft` / `--accent` 等底层颜色令牌）。
- 动画播放时长走 `--duration-*` 令牌（`--duration-spin` / `--duration-breathing` / `--duration-float` / `--duration-pulse-slow`），与 `--transition-*` 过渡时长语义区分。
- 信息侧栏宽度走 `--aux-sidebar-width: 280px` 令牌（2.1 引入，浅色+深色双主题，雷达图 100px + 柱状图 224px + padding 计算后的最小可用宽度，主窗口 minWidth=640px = 280 侧栏 + 360 主面板）。

## 4. chat.css / memory.css 聚合器模式（P2 拆分）

原 `chat.css`（~2960 行）、`memory.css`（~2197 行）为单体大文件。2026-07-09 按功能切分为子模块，原文件降级为**纯 `@import` 聚合器**（顺序与原文件一致，层叠 100% 等价，已用「切片拼接 == 原文件」字节级校验 + 每块括号配平验证）。

`@import` 使用同目录相对路径：

```css
/* chat/chat.css */
@import "./chat-toolbar.css";
@import "./chat-perception.css";
@import "./chat-datenav.css";
@import "./chat-messages-banner.css";
@import "./chat-messages-bubble.css";
@import "./chat-messages-input.css";
@import "./chat-messages-misc.css";
```

### chat.css 子模块映射

| 子模块 | 职责 | 原行范围 |
|---|---|---|
| `chat-toolbar.css` | 对话工具栏 / 状态条 / 在场脉冲浮层 | 1–286 |
| `chat-perception.css` | 感知面板：情感基调 / 默契度 / 上下文 / 模式洞察 / 运行指标 / 里程碑 | 287–596 |
| `chat-datenav.css` | 回到今天 / 日期选择 / 下拉 / 空状态 | 597–867 |
| `chat-messages-banner.css` | 主动提示横幅 / 里程碑 / 配置建议卡片 | 868–1211 |
| `chat-messages-bubble.css` | 日期分隔符 / 消息分组 / 气泡 / 头像 / 召回 | 1212–1693 |
| `chat-messages-input.css` | 输入区 / 补全 / 停止按钮 / 空状态 | 1694–2328 |
| `chat-messages-misc.css` | 思考指示器 / 工具卡片 / 动画 / 启动摘要 / 右键菜单 | 2329–末尾 |

### memory.css 子模块映射

| 子模块 | 职责 | 原行范围 |
|---|---|---|
| `memory-list.css` | 面板头 / 搜索 / 记忆列表卡片 / 来源标签 | 1–272 |
| `memory-detail.css` | 记忆详情弹窗 / 技能列表 / 全局·项目色 | 273–375 |
| `memory-views.css` | 视图过渡 / 时间线 / Profile 卡片 / 知识缺口 / 成长趋势 | 376–744 |
| `memory-graph-core.css` | 更多菜单 / 图例 / tooltip / 右键菜单 / 关系编辑 | 745–1085 |
| `memory-graph-search.css` | 高级搜索 / 搜索高亮 / 洞察栏 | 1086–1303 |
| `memory-graph-detail.css` | 关联记忆 / 演化脉络 / 空状态 / 健康度仪表盘 | 1304–1638 |
| `memory-graph-misc.css` | 增强 1-5 / 时间线 / 回收站 | 1639–末尾 |
| `completion-stats.css` | 补全统计面板（记忆面板第 3 个 analysis panel，与 insights/health 互斥切换） | 2026-07-15 新增 |

> 注：2026-07-13 二级拆分后，chat-messages 4 子模块（344/482/635/757 行）、memory-graph 4 子模块（341/218/335/536 行）。二级拆分按内部功能域切分，切点落在规则边界（大括号配平处），@import 顺序与原文件一致，层叠 100% 等价。2026-07-15 追加 `completion-stats.css` 作为记忆面板第 3 个 analysis panel，挂载在 memory.css 聚合器末尾（与 insights/health 互斥切换，不参与原单体行范围切分）。

## 5. foundation/base.css 定位与拆分约定

**base.css = 真正的"基础层"**，只放以下内容：
- 全局重置（`* { box-sizing / margin / padding }` 等）
- 滚动条样式
- 通用工具类（`.hidden` / `.sr-only` / `.svg-sprite`）
- SVG 图标系统（`.icon` / `.icon-xs` / `.icon-sm`）
- prefers-reduced-motion 适配
- 统一交互状态反馈（`:active` 缩放等）
- 通用组件基类（`.icon-btn` / `.empty-state` / `.error-state` / `.panel-loading`）
- UI 初始化失败卡片

**不放在 base.css 的内容**：
- 完整功能模块的样式 → 独立文件，在对应功能域子目录中
  - `overlays/command-palette.css`（快捷命令面板，原 base.css 第 198–364 行）
  - `overlays/search-messages.css`（对话搜索弹窗，原 base.css 第 365–562 行）

判断标准：一个功能模块如果有自己独立的 DOM 根节点（如 `.command-palette`）、独立的打开/关闭逻辑、独立的交互状态 → 应该独立成文件，不要塞进 base.css。

## 6. foundation/utilities.css 工具类层（CSS-R5 P1 试点）

**utilities.css = 原子布局类中间层**，位于 tokens.css / base.css 之上，功能模块 CSS 之下。

### 三层 CSS 架构

```
foundation/tokens.css（设计令牌，变量定义）     ← 已有，157 变量
       ↓
foundation/base.css（全局重置 + 组件基类）       ← 已有，345 行
       ↓
foundation/utilities.css（原子布局工具类）       ← 已有，19 个 class（CSS-R6 扩充 10 个）
       ↓
各功能域 CSS（chat/ memory/ panels/ overlays/ 等）  ← 按功能域分组
```

### 工具类清单

| 类名 | 属性组合 | 原重复次数 | 语义 |
|------|---------|-----------|------|
| `.flex-center` | display:flex + align-items:center + justify-content:center | 27 | 水平+垂直双向居中 |
| `.flex-col` | display:flex + flex-direction:column | 48 | 纵向 flex 容器 |
| `.flex-row-center` | display:flex + align-items:center | 89 | 横向 flex + 垂直居中 |
| `.flex-between` | display:flex + align-items:center + justify-content:space-between | 9 | 两端对齐 flex |
| `.flex-shrink-0` | flex-shrink:0 | 20+ | flex 子项不收缩 |
| `.inline-flex-center` | display:inline-flex + align-items:center | 6+ | inline-flex + 垂直居中 |
| `.surface-card` | background:var(--surface0) + border-radius:var(--radius-sm) + border:1px solid var(--surface2) | 23 | 标准卡片表面 |
| `.text-muted` | color:var(--text-2) + font-size:var(--font-xs) | 20 | 次要文字 |
| `.text-truncate` | overflow:hidden + text-overflow:ellipsis + white-space:nowrap | 15+ | 单行文本截断 |
| `.line-clamp-2` / `.line-clamp-3` / `.line-clamp-4` | display:-webkit-box + -webkit-line-clamp:N + -webkit-box-orient:vertical + overflow:hidden | 8 | 多行文本截断（3 变体） |
| `.section-title-sm` | font-size:var(--font-sm) + font-weight:var(--weight-semibold) | 9+ | 小节标题 |
| `.collapsible-hidden` | max-height:0 + opacity:0 + overflow:hidden | 5 | 折叠隐藏态 |
| `.input-focus-accent` | border-color:var(--accent) + box-shadow:0 0 0 2px var(--accent-20) | 5 | 输入框聚焦高亮 |
| `.transition-bg` | transition: background var(--transition-fast) | ~20 | 仅背景过渡 |
| `.transition-bg-color` | transition: background + color | ~12 | 背景+文字过渡 |
| `.transition-bg-border-color` | transition: background + border-color | ~4 | 背景+边框过渡 |
| `.transition-bg-border-color-color` | transition: background + border-color + color | ~4 | 全属性过渡 |

### 使用原则

1. **在 JS createElement 后拼接 className 使用**，项目已大量使用 className（583 次 vs 56 次 inline style）
2. **不替换组件基类**：`.empty-state` / `.icon-btn` 等 BEM 基类保持完整，utility class 用于补充布局属性
3. **按需使用**：不强求所有元素都用 utility class，单次使用的样式留在原 CSS 规则块
4. **提取阈值**（ADR-017 枝叶层 2 次提取）：新增工具类需在 2+ 文件出现 2+ 次相同属性组合
5. **渐进引用约束**（CSS-R6 经验）：原生 CSS 无 `@apply`，工具类 `.foo`（0,1,0）仅能覆盖单类选择器；嵌套选择器（`.parent .foo`，0,2,0）/ ID 选择器（`#foo`，1,0,0）不可替换，须保留 CSS 内属性。判定流程：扫描选择器类型 → 排除不可替换 → 单类选择器 HTML/TS 追加 className + CSS 删除重复属性

### 渐进引用记录（CSS-R6 自然生长触发）

| 日期 | commit | 工具类 | 文件数 | 净行数 | 备注 |
|------|--------|--------|--------|--------|------|
| 2026-07-15 | 7f3f9f9 | `.icon-btn` 基类复用 + `.text-truncate` 引用 + 死代码清理 | 17 | -56 | 含 9 处关闭按钮 className 追加 |
| 2026-07-15 | 2b0d5ca | `.flex-between` 引用 | 17 | -30 | 14 处可替换（9 完全 + 5 部分保留 gap/flex-shrink） |
| 2026-07-15 | b267c74 | `.flex-shrink-0` 首批 14 处 | 8 | -16 | settings.css 9 + quick-input.css 5 |
| 2026-07-15 | 165b2e4 | `.flex-shrink-0` 第二批 21 处 + 死代码 `.chat-toolbar-title` | 9 | -6 | 含 12 处不可替换（后代 `.icon` + ID 选择器） |
| **合计** | — | — | — | **-108** | 4 个工具类完成渐进引用 |

### 与 base.css 的区别

| 层 | 职责 | 示例 |
|----|------|------|
| base.css | 全局重置 + 通用组件基类（含 BEM 结构） | `.icon-btn` / `.empty-state` / `.error-state` |
| utilities.css | 原子布局属性组合（无 BEM 结构） | `.flex-center` / `.surface-card` / `.text-muted` |

## 7. windows/ 浮窗 CSS 归属（CSS-R6）

浮窗（`float.html` / `quick-input.html`）是独立 BrowserWindow，不共享主窗口 SVG sprite 和 CSS。两窗的 CSS 从原窗口目录（`float/` 和 `quick-input/`）迁入 `windows/`，统一管理。

| 文件 | 来源 | 加载方式 |
|------|------|----------|
| `windows/float.css` | 原 `float/float.css` | `float.html` 中 `<link href="../styles/windows/float.css">` |
| `windows/quick-input.css` | 原 `quick-input/quick-input.css` | `quick-input.html` 中 `<link href="../styles/windows/quick-input.css">` |

两窗均引入 foundation 三层（tokens + base + utilities）+ 本地组件样式，与主窗口保持一致的分层。

## 8. CSP 与字体

- 主窗 CSP：`default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'`。
- 全部 CSS 为本地文件，经 `<link>` / `@import` 加载，无内联样式（图标用 SVG 精灵 `<use>`，规避内联 style 被 CSP 拦截）。
- 字体：系统字体栈（不打包），含 `--font-sprite` 的 CJK 栈（`'Microsoft YaHei'/'PingFang SC'` 等），在 `foundation/tokens.css` 统一定义。跨平台字形差异为已知权衡（报告 P2「字体策略」项，当前标为跳过）。

## 9. 贡献约定（给后续维护者）

1. 令牌改动只动 `foundation/tokens.css`。
2. 新组件样式放进对应功能域子目录；若 `chat/` / `memory/` 需新增子模块，在聚合器 `@import` 列表按层叠顺序追加，并把内容从单体迁出。
3. 间距/圆角用 `--space-*` / `--radius-*`；禁止在布局处裸写 px（P1 lint 精神）。
4. 任何 CSS 改动后，确认选择器顺序未被打乱（层叠依赖顺序）。
5. 完整功能模块（有独立 DOM 根节点 + 独立交互逻辑）不塞进 `base.css`，应独立成文件并在对应功能域子目录中（参见 §5 base.css 定位）。
6. 高频布局模式（flex 居中 / 卡片表面 / 次要文字）优先用 `foundation/utilities.css` 中的工具类；新增工具类需满足枝叶层 2 次提取原则（参见 §6 utilities.css）。
7. 新增独立窗口 → `windows/`（必须引入 foundation/ 三层 + 本地组件样式）。
8. 新增独立面板 → `panels/`；新增浮层组件 → `overlays/`。

## 10. 重构历史

| 阶段 | 日期 | 内容 |
|------|------|------|
| CSS-R1 P0 | 2026-07-09 | 抽出 tokens.css 单一真理源，float.html/quick-input.html 移除内联 `<style>` 变量块，CSP 收紧为 `style-src 'self'` |
| CSS-R2 P2 | 2026-07-09 | chat.css(2960行)→4 子模块，memory.css(2197行)→4 子模块，原文件降级为 @import 聚合器 |
| CSS-R3 二级拆分 | 2026-07-13 | chat-messages.css→4 子模块 + memory-graph.css→4 子模块 |
| CSS-R4 P0 减法 | 2026-07-13 | base.css 拆分出 command-palette.css + search-messages.css，620→345 行 |
| CSS-R5 utilities | 2026-07-13 | 新增 utilities.css 中间层，5 个原子工具类 |
| CSS-R6 功能域分组 + 工具类扩充 | 2026-07-15 | Phase 1：styles/ 按 8 个功能域子目录分组，浮窗 CSS 统一迁入 windows/，聚合器 @import 改同目录相对路径；Phase 2：utilities.css 扩充 10 个工具类（flex-between / flex-shrink-0 / inline-flex-center / text-truncate / line-clamp-2/3/4 / section-title-sm / collapsible-hidden / input-focus-accent），原 CSS 重复块留待后续 HTML/TS 渐进引用 |
| CSS-R6 渐进引用 | 2026-07-15 | 4 commit 完成 4 个工具类渐进引用（.icon-btn / .text-truncate / .flex-between / .flex-shrink-0），净删除 108 行 CSS 重复代码；剩余 23 处 .flex-shrink-0（含 12 不可替换 + 11 可替换）归档待完成任务，按自然生长触发 |
| CSS-R7 规则对齐 + 剪枝 + 审查 | 2026-07-19 | (1) directory-structure.md §1/§2.4.1 + README.md §1/§2/§4 补齐 memory/completion-stats.css（第 3 个 analysis panel）+ panels/clipboard.css（剪贴板保护面板）规则漏登记；(2) index.html 删除 chat-toolbar/datenav/perception 3 处重复 link（聚合器 chat.css 已 @import，违反 §2.4.4）；(3) float.html 补 base.css + utilities.css（违反 §2.4.9 浮窗加载顺序）；(4) clipboard.css 删除死代码 .clipboard-list-hidden（clipboardPanelManager.ts 零引用）；(5) completion-stats.css 11 处裸 px 令牌化（保留 1px/2px 次像素对齐 + max-height） |
| CSS-R8 令牌化第二轮 | 2026-07-21 | (1) 新增 --active-bg/-active-bg-strong/-active-fg/-active-border 4 件套，统一 .active/.selected/.current 三套语义，14 个 .active 选择器 + 5 个 .selected 选择器收口；(2) 新增 --duration-spin/-breathing/-float/-pulse-slow 4 个动画播放时长令牌，14 处硬编码收口（statusPulse 三档保留分级完整性）；(3) 新增 --pad-card-compact 紧凑卡片专用令牌，修复 .audit-item 误用 --input-padding-md；(4) 新增 --red-hover 修复 .btn-danger:hover 用 opacity 而非颜色变化；(5) modal.css 15 处裸 px → --space-* 令牌化；(6) search-messages.css gap 4px → --space-1；(7) B7 异步按钮 loading 补齐 P0 共 8 处（forkBtn/forceRelease/2 Provider 按钮/4 回收站按钮），recycleBin callback 签名 void → Promise<void>（事件委托层包装 loading）；(8) directory-structure.md §2.4.6 扩展为"间距/圆角/动画时长令牌化"，README.md §3 令牌所有权补登激活态语义色 + 动画播放时长约束 |
| CSS-R9 控件收口 | 2026-07-23 | (1) 新增 foundation/controls.css（L1 共享控件层），将跨面板复用的按钮(.btn/.btn-primary/.btn-secondary/.btn-danger/.btn-sm)、标签(.source-tag/.lineage-source-tag/.profile-category 统一为单一基础 + token 驱动颜色修饰 .tag-*)、卡片(.card) 收口为单一真理源；(2) 从 overlays/modal.css 移除按钮定义、memory/memory-list.css 移除 .source-tag 基础+颜色修饰+详情 id 颜色规则、panels/settings.css 移除 .profile-category 基础+颜色修饰，原文件仅留迁移注释（ADR-018 §4）；(3) index.html/float.html/quick-input.html 在 foundation 三层后引入 controls.css；(4) 修复 .source-tag 基础被 .memory-item .meta 过度限定（0,3,0）导致域外标签丢失基础样式的 scope 问题 |
| CSS-R10 输入框收口 | 2026-07-23 | (1) foundation/controls.css 新增 .input 通用文本输入框基类（bg/border/radius/padding/font，:focus 复用 .input-focus-accent 同款聚焦环，[aria-invalid] 红色边框）+ .input-with-action 带操作按钮输入框容器（原定义于 panels/settings.css，被 settings API Key 显隐与 overlays/modal.css 的 aria-invalid 扩展跨文件复用，违反 L3 局部约定，提升至 L1 单一真理源，类名不变、标记零改动）；(2) panels/settings.css 删除 .input-with-action 基础定义，仅保留 settings 专属 .toggle-visibility + 迁移注释；(3) 对抗式审查结论：颜色令牌已 100% 集中（其余 CSS 裸色仅为 base.css 的 var(--x,#兜底) 防御式写法，非残留），故"令牌化 9 hex+3 rgba"前提不成立、无需改动；"37 卡片"被高估（window-bg-2/surface2 边框大量用于气泡/输入框/标题栏），卡片去重需逐类改 TS/HTML 类名，列为增量 backlog |
| CSS-R11 洞察栏+健康度面板就地优化 | 2026-07-23 | (1) 新建 memory/insights.css（记忆洞察栏单一真理源）与 memory/health.css（记忆健康度诊断面板单一真理源），将散落在 memory-graph-search.css / memory-graph-detail.css / memory-graph-misc.css 的 insights/health 规则抽离（修复 filename≠content 结构异味，ADR-018）；(2) 聚合器 memory.css 在 completion-stats.css 之前 @import 两新文件，保证 .panel-close-btn 等共享类层叠不变；(3) 就地优化布局：洞察栏补「统计/来源分布」区块标题、4 统计卡成组为抬升卡片（复用 L1 .card + .insights-stats 覆写）、去 cramped 内部滚动（max-height 由 400/300 抬至 720px 安全网 + flex-shrink:0 让列表吸收剩余空间）；(4) 健康度面板：评分与样本量分离（#health-score 纯分数 + #health-score-sample muted 样本量，healthDashboardRenderer.ts 同步拆分）、详情项改小号 chip（问题项 amber/red 高亮）、6 操作按钮收敛（一键清理 danger 实色常态突出 + 清理重复/过期降为 --ghost 次级 + LLM 治理收为原生 <details>「AI 治理」可折叠次级组，零 JS）；(5) 全部改动保留 #insights-* / #health-* / #health-llm-actions 等 ID 与类名，渲染器逻辑零改动 |
| INFO-ARCH-2.1 双栏布局 | 2026-07-22 | (1) tokens.css 新增 --aux-sidebar-width: 280px（浅色+深色双主题，雷达图 100px + 柱状图 224px + padding 最小可用宽度）；(2) layout.css #main-content 改为 `display: grid`，`.aux-open` 状态下 `grid-template-columns: 1fr 1px var(--aux-sidebar-width)`（主面板区 + 1px 分隔线 + 280px 信息侧栏），新增 .aux-sidebar-divider/.aux-sidebar-header/.aux-tab/.aux-sidebar-content/.sidebar-divider 完整样式块；(3) 侧栏面板可见性独立于主面板：`.aux-sidebar-content .panel` 默认隐藏，`.panel.aux-active` 显示，与主面板 `.active` 互不干扰；(4) toggle 按钮 #btn-toggle-aux 单图标（#icon-panel-right）+ active 态绿色高亮（复用 CSS-R8 --active-bg/--active-fg）；(5) 即时切换无动画（参考 VSCode 标准行为，`transition: width` 触发 reflow 性能差）；(6) 主窗口 minWidth=640px（280 侧栏 + 360 主面板），智能决策移除自动收起逻辑 |
