# styles/ — Memora Sprite 渲染层 CSS 架构

> 最后更新：2026-07-15（CSS-R6 按功能域分组重构 + 浮窗统一管理）

## 1. 目录结构（按功能域分组，8 个子目录）

```
styles/
├── README.md           # 本文件——CSS 架构文档
│
├── foundation/         # 基础层（设计令牌 + 全局重置 + 工具类，三窗口共享）
│   ├── tokens.css      # 设计令牌「单一真理源」（157 变量：颜色/表面/文字/语义色/圆角/阴影/z-index/字号/字重/间距/过渡）
│   ├── base.css        # 全局重置 + 滚动条 + 动画 + focus-visible + 图标系统 + 通用组件基类（icon-btn/empty-state/error-state）
│   └── utilities.css   # 原子布局工具类（flex-center/flex-col/flex-row-center/surface-card/text-muted + 过渡工具类）
│
├── layout/             # 布局层（窗口骨架）
│   └── layout.css      # 顶栏 + 64px 侧栏 + 核心窗口 Grid 布局
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
├── memory/             # 记忆功能域（聚合器 + 7 子模块）
│   ├── memory.css             # 聚合器（纯 @import 7 子模块）
│   ├── memory-list.css        # 面板头 / 搜索 / 记忆列表卡片 / 来源标签
│   ├── memory-detail.css      # 记忆详情弹窗 / 技能列表 / 全局·项目色
│   ├── memory-views.css       # 视图过渡 / 时间线 / Profile 卡片 / 知识缺口 / 成长趋势
│   ├── memory-graph-core.css  # 更多菜单 / 图例 / tooltip / 右键菜单 / 关系编辑
│   ├── memory-graph-search.css # 高级搜索 / 搜索高亮 / 洞察栏
│   ├── memory-graph-detail.css # 关联记忆 / 演化脉络 / 空状态 / 健康度仪表盘
│   └── memory-graph-misc.css  # 增强 1-5 / 时间线 / 回收站
│
├── panels/              # 独立面板样式（每个对应一个 .panel）
│   ├── dashboard.css   # 仪表盘面板（概览+运行指标+记忆源健康+增长趋势）
│   ├── perception.css  # 独立感知面板（从 dashboard.css 迁出，覆盖 chat-perception.css 基础样式）
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
    └── quick-input.css # 快速输入浮窗（引入 foundation 三层 + 本地组件样式）
```

## 2. 加载顺序

### 2.1 主窗口（index.html 中的 `<link>`，顺序即层叠优先级）

```
foundation/tokens.css      ← 设计令牌「单一真理源」（P0 抽出，双主题 + CJK 字体栈）
foundation/base.css        ← 全局重置 / 滚动条 / 动画 / focus-visible / 图标系统 / 通用组件基类
foundation/utilities.css   ← 通用工具类（flex-center / flex-col / flex-row-center / surface-card / text-muted）
layout/layout.css          ← 顶栏 + 64px 侧栏 + 核心窗口 Grid 布局
chat/chat.css              ← 聚合器（@import 7 子模块，见 §3）
memory/memory.css          ← 聚合器（@import 7 子模块，见 §3）
panels/dashboard.css
panels/perception.css
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
windows/float.css          ← 浮动窗口组件样式
（或 windows/quick-input.css）
```

浮窗独立窗口不共享主窗口 SVG sprite，需在 HTML 中内联 `<symbol>` 定义。两窗均**不内联任何令牌**（P0 已回收 `unsafe-inline`，CSP 收紧为 `style-src 'self'`）。

## 3. 令牌所有权（不可破的约定）

- **`foundation/tokens.css` 是唯一令牌定义处**：颜色 / 表面 / 文字 / 语义色 / 圆角 / 阴影 / z-index / 字号 / 字重 / 间距 / 过渡。任何窗口、任何组件 CSS 只消费 `var()`，不得重新定义或内联令牌。
- 修改令牌只能改 `tokens.css`；新增令牌同理。严禁在组件 CSS 或 HTML 内联 `<style>` 中复制令牌块（这正是 P0 修复的漂移问题）。
- 组件 CSS 间距/圆角一律走 `--space-*` / `--radius-*` 令牌（P1 已收口，含 `--space-2-5: 10px`）；盒阴影、字号、width 等含 px 处保持字面量。

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

> 注：2026-07-13 二级拆分后，chat-messages 4 子模块（344/482/635/757 行）、memory-graph 4 子模块（341/218/335/536 行）。二级拆分按内部功能域切分，切点落在规则边界（大括号配平处），@import 顺序与原文件一致，层叠 100% 等价。

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
foundation/utilities.css（原子布局工具类）       ← 已有，5 + 4 个 class
       ↓
各功能域 CSS（chat/ memory/ panels/ overlays/ 等）  ← 按功能域分组
```

### 工具类清单

| 类名 | 属性组合 | 原重复次数 | 语义 |
|------|---------|-----------|------|
| `.flex-center` | display:flex + align-items:center + justify-content:center | 27 | 水平+垂直双向居中 |
| `.flex-col` | display:flex + flex-direction:column | 48 | 纵向 flex 容器 |
| `.flex-row-center` | display:flex + align-items:center | 89 | 横向 flex + 垂直居中 |
| `.surface-card` | background:var(--surface0) + border-radius:var(--radius-sm) + border:1px solid var(--surface2) | 23 | 标准卡片表面 |
| `.text-muted` | color:var(--text-2) + font-size:var(--font-xs) | 20 | 次要文字 |
| `.transition-bg` | transition: background var(--transition-fast) | ~20 | 仅背景过渡 |
| `.transition-bg-color` | transition: background + color | ~12 | 背景+文字过渡 |
| `.transition-bg-border-color` | transition: background + border-color | ~4 | 背景+边框过渡 |
| `.transition-bg-border-color-color` | transition: background + border-color + color | ~4 | 全属性过渡 |

### 使用原则

1. **在 JS createElement 后拼接 className 使用**，项目已大量使用 className（583 次 vs 56 次 inline style）
2. **不替换组件基类**：`.empty-state` / `.icon-btn` 等 BEM 基类保持完整，utility class 用于补充布局属性
3. **按需使用**：不强求所有元素都用 utility class，单次使用的样式留在原 CSS 规则块
4. **提取阈值**（ADR-017 枝叶层 2 次提取）：新增工具类需在 2+ 文件出现 2+ 次相同属性组合

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
| CSS-R6 功能域分组 | 2026-07-15 | styles/ 按 8 个功能域子目录分组，浮窗 CSS 统一迁入 windows/，聚合器 @import 改同目录相对路径 |
