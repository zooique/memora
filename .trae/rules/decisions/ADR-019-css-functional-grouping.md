---
alwaysApply: false
description: "CSS-R6 功能域分组重构：8 子目录 + 浮窗统一迁入 windows/ + 聚合器相对路径"
---

# ADR-019 · CSS-R6 功能域分组重构

> **状态**：✅ 已接受
> **日期**：2026-07-15
> **来源**：年轮审判（2026-07-15 全自动质量闭环链路）—— CSS-R6 重构后补录架构决策
> **依赖**：[ADR-018](./ADR-018-css-scoping-convention.md)（CSS 作用域三层模型）、[ADR-017](./ADR-017-natural-growth-redefinition.md)（枝叶层 2 次提取原则）、[ADR-008](./ADR-008-directory-structure.md)（目录结构按职责分层）

## 背景

CSS-R6 重构前（2026-07-15 前），`styles/` 目录是扁平结构，30 个 CSS 文件平铺，存在 3 个问题：

1. **无功能域边界**：chat 相关 7 个文件（chat.css / chat-toolbar.css / chat-messages-*.css）与 memory 相关 7 个文件混杂，定位成本高
2. **浮窗 CSS 散落**：quick-input.css 在 `quick-input/` 目录，float.css 在 `float/` 目录，与主窗口 CSS 分离，难以统一管理主题变量
3. **聚合器路径脆弱**：chat.css 用 `@import "./chat-toolbar.css"` 相对路径，但文件分散在不同目录时 `@import` 路径易错

## 决策

**将 styles/ 重组为 8 个功能域子目录，浮窗 CSS 统一迁入 windows/，聚合器用同目录相对路径。**

### 1. 8 功能域子目录划分

| 子目录 | 职责 | 文件数 | 划分理由 |
|--------|------|--------|---------|
| foundation/ | 设计令牌 + 基础重置 + 工具类 | 3（tokens/base/utilities） | L1 全局基础，被所有层依赖，独立隔离 |
| layout/ | 全局布局（#app/#titlebar/#sidebar/.panel） | 1（layout） | L1 布局骨架，与 foundation 同级但职责不同 |
| chat/ | 对话面板聚合器 + 7 子模块 | 8 | 高频迭代域，子模块多，独立成域 |
| memory/ | 记忆面板聚合器 + 7 子模块 | 8 | 与 chat 同级的高频域 |
| panels/ | 仪表盘/感知/设置面板 | 3 | 低频迭代域，每面板单文件 |
| overlays/ | 弹出层组件（modal/toast/command-palette/search-messages） | 4 | L3 组件层，跨面板复用 |
| content/ | 内容渲染（markdown） | 1 | L3 内容渲染，独立关注点 |
| windows/ | 浮窗专属样式（float/quick-input） | 2 | 独立 BrowserWindow，CSP/主题与主窗有差异 |

### 2. 浮窗 CSS 统一迁入 windows/

**float.css 从 `float/` 迁入 `styles/windows/`，quick-input.css 从 `quick-input/` 迁入 `styles/windows/`。**

| 迁移前 | 迁移后 | 理由 |
|--------|--------|------|
| renderer/float/float.css | styles/windows/float.css | 浮窗 CSS 与主窗 CSS 共享 tokens.css 令牌，统一管理避免主题漂移 |
| renderer/quick-input/quick-input.css | styles/windows/quick-input.css | 同上；CSP 差异（浮窗无 font-src/connect-src）在 README §8 文档化 |

### 3. 聚合器同目录相对路径

**chat.css 和 memory.css 作为聚合器，用同目录相对路径 `@import` 子模块。**

```css
/* chat.css 聚合器 */
@import "./chat-toolbar.css";
@import "./chat-datenav.css";
@import "./chat-perception.css";
/* ... */
```

**理由**：聚合器与子模块同目录，`@import` 路径最短（`./xxx.css`），迁移目录时只需改一处路径前缀。

## 理由

| 考虑 | 说明 |
|------|------|
| **与 ADR-008 职责分层对齐** | 目录按功能域分组而非类型分组，与 src/ 的 agent/memory/persona 分层哲学一致 |
| **与 ADR-018 三层模型对齐** | foundation=L1 / layout=L1 / panels+chat+memory=L2 / overlays+content=L3 / windows=独立窗口 |
| **定位成本降低** | "找对话样式" → chat/ 目录；"找弹窗样式" → overlays/ 目录，无需在 30 个平铺文件中搜索 |
| **浮窗统一管理的主题一致性** | 浮窗与主窗共享 tokens.css，迁入 styles/ 后主题变量变更只需改一处 |
| **聚合器路径健壮性** | 同目录相对路径（`./xxx.css`）比跨目录路径（`../chat/xxx.css`）更短且不易错 |

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 保持扁平结构 | 30 文件平铺定位成本高，功能域边界缺失 |
| 按层级分组（L1/L2/L3 目录） | 跨域查找需翻多目录（如 chat 的 L2+L3 分散），不如功能域内聚 |
| 浮窗 CSS 留在各自窗口目录 | 主题变量需跨目录同步，易漂移；CSP 差异难以统一文档化 |
| 聚合器用绝对路径 @import | CSS @import 不支持从根路径开始的绝对路径，只能相对路径 |

## 影响

- **index.html**：CSS 引用路径更新（23 处链接路径更新）
- **float.html / quick-input.html**：CSS 引用路径更新为 `styles/windows/xxx.css`
- **styles/README.md**：新增 10 节完整文档（目录结构/加载顺序/令牌所有权/聚合器模式/base.css 定位/utilities.css/浮窗归属/CSP/贡献约定/重构历史）
- **ADR-018**：CSS 路径引用同步更新（7 处）
- **后续 CSS 新增**：按功能域归属选择子目录，参照 styles/README.md §9 贡献约定

## 何时回顾

- 当功能域子目录 > 12 个时，评估是否引入二级分组（如 panels/ 下再分 dashboard/perception/settings）
- 当某子目录文件数 > 10 时，评估是否拆分聚合器
- 当浮窗数量 > 3 个时，评估 windows/ 是否需要二级分组
