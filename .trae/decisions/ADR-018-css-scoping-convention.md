---
alwaysApply: false
description: "CSS 作用域规范：面板前缀 + BEM 风格 + 单一真理源，消除 BARE 类跨面板污染"
---

# ADR-018 · CSS 作用域规范：消除 BARE 类跨面板污染

> **状态**：✅ 已接受
> **日期**：2026-07-13
> **来源**：感知模块 UI 污染体验评审——layout.css 与 chat-perception.css 的 BARE 类（`.affect-label`/`.context-label` 等）被感知面板 DOM 继承，perception.css 后加载只能覆盖显式声明的属性，未声明的 `width`/`text-align`/`flex` 被继承导致 label 截断、track 垂直伸展
> **依赖**：[ADR-017](./ADR-017-natural-growth-redefinition.md)（枝叶层 2 次提取原则）、[ADR-SP-015](./ADR-SP-015-panel-manager-composition.md)（PanelManager 组合模式）、[ADR-008](./ADR-008-directory-structure.md)（目录结构）

## 背景

迭代 5 完成感知面板独立化（从仪表盘子分区升级为独立 `#panel-perception`），但 CSS 仍沿用 chat 面板时期的 BARE 类（无前缀通用类）：

- [layout.css](../../hosts/memora-sprite/src/electron/renderer/styles/layout/layout.css) 定义 `.affect-label { width: 40px; text-align: right }`（为 chat 面板横向布局设计）
- 感知面板的 `.affect-item` 是纵向 flex column 布局，HTML 复用了 `.affect-label` 类名
- [perception.css](../../hosts/memora-sprite/src/electron/renderer/styles/panels/perception.css) 后加载，用 `.affect-item .affect-label`（特异性 0,2,0）覆盖了部分属性，但未显式重置的 `width`/`text-align` 仍被继承污染

同类问题还出现在 `.affect-track`（`flex:1` 在 column 布局中垂直伸展成超高矩形）、`.affect-level`、`.context-label`、`.context-value`、`.rapport-bar`、`.perception-pattern-*` 系列，共计 13 类 BARE 类引发跨面板污染。

**根因不是"覆盖不完整"，而是"作用域隔离缺失"**：BARE 类定义在全局作用域，任何面板的 DOM 都会继承，perception.css 的"覆盖"本质是"事后补救"，新增 BARE 类时容易遗漏。

## 决策

**确立 CSS 三层作用域模型 + 面板前缀强制约定，从源头消除 BARE 类跨面板污染。**

### 1. 三层作用域模型

| 层级 | 作用域 | 命名规范 | 文件归属 | 例子 |
|------|--------|----------|----------|------|
| **L1 全局基础** | 跨面板共享的设计令牌与原子类 | `--var-xxx` 变量 / `.btn-primary` 等通用组件类 | [tokens.css](../../hosts/memora-sprite/src/electron/renderer/styles/foundation/tokens.css) + [base.css](../../hosts/memora-sprite/src/electron/renderer/styles/foundation/base.css) + [layout.css](../../hosts/memora-sprite/src/electron/renderer/styles/layout/layout.css) 的 `#app`/`#titlebar`/`#sidebar`/`.panel`/`.nav-btn` 等 |
| **L2 面板专属** | 单个面板内的所有样式 | **面板前缀 + BEM** | `<panel>.css` | `.perception-affect-grid`、`.dashboard-overview-item`、`.settings-tab-content` |
| **L3 组件局部** | 可复用的独立组件（modal/toast/dropdown） | 组件名 + BEM | [modal.css](../../hosts/memora-sprite/src/electron/renderer/styles/overlays/modal.css) / [toast.css](../../hosts/memora-sprite/src/electron/renderer/styles/overlays/toast.css) | `.modal-header`、`.toast-content` |

### 2. 面板前缀强制约定（L2 层核心规则）

**所有面板专属类必须以面板名前缀开头，禁止使用 BARE 类。**

| 面板 | 前缀 | 文件 | 已合规示例 | 历史 BARE 类（需迁移） |
|------|------|------|------------|------------------------|
| 感知 | `perception-` | perception.css | `.perception-affect-grid`、`.perception-pattern-item` | ~~`.affect-label`~~ → `.perception-affect-label`（感知面板内已用 `.affect-item .affect-label` scoped 隔离） |
| 仪表盘 | `dashboard-` | dashboard.css | `.dashboard-overview-grid`、`.dash-item`（`dash-` 是 dashboard 缩写，合规） | 无 |
| 对话 | `chat-` 或无前缀（chat 是主面板） | chat.css + chat-*.css | `.chat-toolbar`、`.message-bubble` | 无（chat 专属类已合规） |
| 记忆 | `memory-` | memory.css | `.memory-list`、`.memory-item` | 无 |
| 设置 | `settings-` | settings.css | `.settings-tab`、`.settings-group` | 无 |

**例外**：chat 面板作为主面板，其专属类可不加 `chat-` 前缀（如 `.message-bubble`、`.message-avatar`），但**不得被其他面板的 DOM 使用**。一旦被复用，必须提升为 L3 组件类或加面板前缀。

### 3. BEM 风格命名规范

L2 / L3 层类名采用 BEM（Block Element Modifier）风格：

```
.block-name__element-name--modifier-name
```

或等价的连字符风格（本项目采用）：

```
.block-name-element-name--modifier-name
.block-name.is-modifier-name  /* 状态类用 .is- 前缀 */
```

**规则**：

- Block：面板前缀 + 主体名（`.perception-affect-grid`）
- Element：Block + 子部件名（`.perception-affect-fill`）
- Modifier：状态/变体（`.perception-pattern-type.repeat`、`.is-active`、`.is-hidden`）
- 状态类统一用 `.is-` 或 `.hidden` 前缀，禁止用 `.active`（与 `.panel.active` 冲突）

### 4. 单一真理源原则

**每个面板的样式必须集中在单一 CSS 文件中，禁止跨文件重复定义同类名。**

| 规则 | 说明 |
|------|------|
| 真理源 | 面板专属类的唯一定义位置是 `<panel>.css`（如 perception.css 是感知面板的真理源） |
| 禁止重复 | 其他 CSS 文件不得定义同类名（chat-perception.css 不得再定义 `.perception-pattern-item`） |
| 迁移留痕 | 从旧文件迁移到新文件时，旧文件保留注释说明迁移去向（如 `/* .affect-label 已迁至 perception.css */`），但**不保留任何样式定义** |
| 复用提升 | 被多个面板使用的类必须提升为 L3 组件类（迁到 modal.css / toast.css 等独立组件文件） |

### 5. CSS 加载顺序约定

[index.html](../../hosts/memora-sprite/src/electron/renderer/index.html) 的 CSS 加载顺序遵循"L1 → L2 → L3"依赖链（真理源：[styles/README.md §2.1](../../hosts/memora-sprite/src/electron/renderer/styles/README.md)）。

> **CSS-R6 重构后（2026-07-15）**：加载顺序由聚合器 `@import` 链实现，index.html 仅引入 `foundation/*` + `layout/*` + `chat.css` + `memory.css` 两个聚合器 + `panels/*` + `overlays/*` + `content/*`。8 子目录结构详见 [ADR-019](./ADR-019-css-functional-grouping.md)。

```
L1 全局基础：foundation/tokens → foundation/base → foundation/utilities → layout/layout
L2 面板：
  chat.css 聚合器（@import chat-toolbar/chat-perception/chat-datenav/chat-messages-*）
  memory.css 聚合器（@import memory-list/memory-detail/memory-views/memory-graph-*/completion-stats）
  panels/ 独立文件：dashboard → perception → clipboard → settings
L3 组件（overlays）：modal → toast → command-palette → search-messages
L3 内容（content）：markdown
```

> 浮窗（float.html / quick-input.html）独立加载 `foundation/*` 三层 + 本地 `windows/` 样式，不进 index.html 主加载链。

**L2 面板之间不得相互依赖**。如果 perception.css 需要覆盖 chat 的样式，说明 DOM 类名复用出了问题，应回到第 2 条"面板前缀强制约定"修复类名，而不是在 perception.css 里做覆盖。

## 理由

| 考虑 | 说明 |
|------|------|
| **源头治理 vs 事后补救** | BARE 类污染的根因是作用域泄漏，perception.css 的 scoped 覆盖是事后补救，新增类时容易遗漏。面板前缀从源头隔离作用域 |
| **与 PanelManager 对齐** | [ADR-SP-015](./ADR-SP-015-panel-manager-composition.md) 已确立 PanelManager 类的命名前缀（`PerceptionPanelManager`、`DashboardPanelManager`），CSS 前缀与 JS 前缀对齐，心智模型一致 |
| **L1/L2/L3 与分层架构对齐** | 对应 [backend_layers_rules.md](../rules/backend_layers_rules.md) 的"内核 → 宿主 → 组件"分层，CSS 也有"全局 → 面板 → 组件"三层 |
| **降低心智负担** | 看到 `.perception-xxx` 一定属于感知面板，看到 `.dashboard-xxx` 一定属于仪表盘，无需翻找多个文件 |
| **不引入 CSS Modules 的理由** | Electron 场景下 PostCSS 构建链增加复杂度，且 CSP 对 style-src 限制严格；BEM + 面板前缀是零成本方案 |
| **保留 chat 主面板例外** | chat 是默认面板，其类被 index.html 直接使用且不跨面板复用，强制加 `chat-` 前缀收益低、改动量大 |

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| **CSS Modules（PostCSS）** | 引入构建工具链，CSP 约束下需额外配置，违反"零依赖内核"精神（虽然宿主可引入，但收益不抵成本） |
| **CSS-in-JS** | Electron 渲染进程性能开销 + CSP 约束，且与现有"CSS 文件分离"心智不符 |
| **Shadow DOM** | Electron 多窗口场景下 Shadow DOM 边界处理复杂，且现有 CSS 变量主题系统需重新适配 |
| **完全 scoped 选择器（`.panel-perception .affect-label`）** | 治标不治本，BARE 类仍存在于 layout.css，新增 BARE 类时还是会泄漏 |
| **保持现状 + 持续覆盖** | 每次新增 BARE 类都要在 perception.css 里补覆盖，维护成本随面板数线性增长 |

## 影响

### 立即影响（已完成的修复）

- [layout.css](../../hosts/memora-sprite/src/electron/renderer/styles/layout/layout.css)：删除 `.affect-bar`/`.affect-label`/`.affect-track`/`.affect-fill`/`.affect-level`/`.context-label`/`.context-value`/`.patterns-list`/`.pattern-item` 共 9 类 BARE 死代码
- [chat-perception.css](../../hosts/memora-sprite/src/electron/renderer/styles/chat/chat-perception.css)：删除与 perception.css 重复的 13 类 BARE 类定义
- [perception.css](../../hosts/memora-sprite/src/electron/renderer/styles/panels/perception.css)：成为感知面板样式的唯一真理源
- [layout.css](../../hosts/memora-sprite/src/electron/renderer/styles/layout/layout.css)：`.panel` / `.panel.active` 添加 `z-index` 创建堆叠上下文，隔离隐藏面板

### 长期影响

- **新增面板**：必须遵循 `perception-xxx.css` 命名 + 面板前缀类名，[new-module-guide.md](../rules/new-module-guide.md) 补充 CSS 检查项
- **新增组件**：可复用组件迁到独立 `xxx.css`（L3 层），类名用组件名前缀
- **代码审查**：[翠幕天罗](../../.trae/skills/big-tree-grower/references/modes-guide.md) 模式新增 CSS 作用域检查项
- **健康度诊断**：[神木回天](../../.trae/skills/big-tree-grower/references/modes-guide.md) 模式可扫描 BARE 类跨面板使用情况

### 对其他规则的影响

- [backend_layers_rules.md](../rules/backend_layers_rules.md)：§前端分层补充 CSS 三层作用域模型引用
- [coding-convention-rules.md](../rules/coding-convention-rules.md)：§命名规范补充 CSS BEM 风格
- [ADR-017](./ADR-017-natural-growth-redefinition.md)：枝叶层 2 次提取原则在 CSS 领域的具体化——同类样式重复 2 次必须提升为 L3 组件类或加面板前缀

## 何时回顾

- 当 L2 面板数 > 8 个，前缀管理成本上升时，评估是否引入 PostCSS Modules
- 当 L3 组件数 > 15 个，组件间样式冲突增多时，评估是否拆分为 `components/` 子目录
- 当 chat 主面板的"无前缀例外"导致 > 3 次跨面板污染时，取消例外，强制加 `chat-` 前缀
- 当 Shadow DOM 在 Electron 中的支持成熟（性能 + CSP 友好）时，重新评估是否用 Shadow DOM 替代面板前缀

## 引用更新

本 ADR 影响以下文件：

- [backend_layers_rules.md](../rules/backend_layers_rules.md) §前端 CSS 三层作用域模型——补充 L1/L2/L3 三层 + 核心约束
- [coding-convention-rules.md](../rules/coding-convention-rules.md) §6 函数与变量规范 · CSS 命名规范——补充 BEM 风格 + 面板前缀约定
- [new-module-guide.md](../rules/new-module-guide.md) §6 新增面板的 CSS 检查项——补充 CSS 文件命名 + 类名前缀检查
