# styles/ — Memora Sprite 渲染层 CSS 架构

> 最后更新：2026-07-09（P2 拆分 + P0 令牌统一后）

## 1. 加载顺序（index.html 中的 `<link>`，顺序即层叠优先级）

```
styles/tokens.css      ← 设计令牌「单一真理源」（P0 抽出，双主题 + CJK 字体栈）
styles/base.css        ← 全局重置 / 滚动条 / 动画 / focus-visible / 通用组件骨架
styles/layout.css      ← 顶栏 + 64px 侧栏 + 核心窗口 Grid 布局
styles/chat.css        ← 聚合器（@import 4 个子模块，见 §3）
styles/memory.css      ← 聚合器（@import 4 个子模块，见 §3）
styles/settings.css
styles/modal.css
styles/toast.css
styles/markdown.css
styles/dashboard.css
```

浮窗 `float/float.html`、快捷输入 `quick-input/quick-input.html` 各自 `<link>` 引用 `../styles/tokens.css` + 本地 `float.css` / `quick-input.css`，**不内联任何令牌**（P0 已回收 `unsafe-inline`，CSP 收紧为 `style-src 'self'`）。

## 2. 令牌所有权（不可破的约定）

- **`tokens.css` 是唯一令牌定义处**：颜色 / 表面 / 文字 / 语义色 / 圆角 / 阴影 / z-index / 字号 / 字重 / 间距 / 过渡。任何窗口、任何组件 CSS 只消费 `var()`，不得重新定义或内联令牌。
- 修改令牌只能改 `tokens.css`；新增令牌同理。严禁在组件 CSS 或 HTML 内联 `<style>` 中复制令牌块（这正是 P0 修复的漂移问题）。
- 组件 CSS 间距/圆角一律走 `--space-*` / `--radius-*` 令牌（P1 已收口，含 `--space-2-5: 10px`）；盒阴影、字号、width 等含 px 处保持字面量。

## 3. chat.css / memory.css 聚合器模式（P2 拆分）

原 `chat.css`（~2960 行）、`memory.css`（~2197 行）为单体大文件。2026-07-09 按功能切分为子模块，原文件降级为**纯 `@import` 聚合器**（顺序与原文件一致，层叠 100% 等价，已用「切片拼接 == 原文件」字节级校验 + 每块括号配平验证）。

### chat.css →
| 子模块 | 职责 | 原行范围 |
|---|---|---|
| `chat-toolbar.css` | 对话工具栏 / 状态条 / 在场脉冲浮层 | 1–286 |
| `chat-perception.css` | 感知面板：情感基调 / 默契度 / 上下文 / 模式洞察 / 运行指标 / 里程碑 | 287–596 |
| `chat-datenav.css` | 回到今天 / 日期选择 / 下拉 / 空状态 | 597–867 |
| `chat-messages.css` | 消息气泡 / 输入框 / 打字指示 / 工具调用卡片 | 868–末尾 |

### memory.css →
| 子模块 | 职责 | 原行范围 |
|---|---|---|
| `memory-list.css` | 面板头 / 搜索 / 记忆列表卡片 / 来源标签 | 1–272 |
| `memory-detail.css` | 记忆详情弹窗 / 技能列表 / 全局·项目色 | 273–375 |
| `memory-views.css` | 视图过渡 / 时间线 / Profile 卡片 / 知识缺口 / 成长趋势 | 376–744 |
| `memory-graph.css` | 更多菜单 / 关系图谱 Canvas / 图例 / tooltip | 745–末尾 |

> 注：`chat-messages.css`（~2093 行）、`memory-graph.css`（~1453 行）仍是单功能域内最大块。若后续密度反馈要求，可继续按内部功能（如消息气泡 vs 工具调用）二次拆分——**切点必须落在规则边界（大括号配平处）**，否则破坏层叠。

## 4. CSP 与字体

- 主窗 CSP：`default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'`。
- 全部 CSS 为本地文件，经 `<link>` / `@import` 加载，无内联样式（图标用 SVG 精灵 `<use>`，规避内联 style 被 CSP 拦截）。
- 字体：系统字体栈（不打包），含 `--font-sprite` 的 CJK 栈（`'Microsoft YaHei'/'PingFang SC'` 等），在 `tokens.css` 统一定义。跨平台字形差异为已知权衡（报告 P2「字体策略」项，当前标为跳过）。

## 5. 贡献约定（给后续维护者）

1. 令牌改动只动 `tokens.css`。
2. 新组件样式放进对应功能 CSS；若 `chat.css` / `memory.css` 需新增子模块，在聚合器 `@import` 列表按层叠顺序追加，并把内容从单体迁出。
3. 间距/圆角用 `--space-*` / `--radius-*`；禁止在布局处裸写 px（P1 lint 精神）。
4. 任何 CSS 改动后，确认选择器顺序未被打乱（层叠依赖顺序）。
