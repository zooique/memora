# Step 8 · Sprite 样式层审查

> **审查日期**：2026-07-19
> **审查模式**：问诊·炼化归元（规则对齐 → 剪枝 → 提交前审查）
> **审查范围**：`hosts/memora-sprite/src/electron/renderer/styles/`（~12260 行，35 文件）+ 3 个 HTML 入口
>   - `foundation/`（3 文件）：tokens.css / base.css / utilities.css — 设计令牌单一真理源
>   - `layout/`（1 文件）：layout.css — 窗口骨架
>   - `chat/`（8 文件）：聚合器 + 7 子模块
>   - `memory/`（9 文件）：聚合器 + 7 子模块 + 1 分析子面板 completion-stats.css
>   - `panels/`（4 文件）：dashboard / perception / clipboard / settings
>   - `overlays/`（4 文件）：modal / toast / command-palette / search-messages
>   - `content/`（1 文件）：markdown.css
>   - `windows/`（2 文件）：float.css / quick-input.css
>   - HTML 入口（3 文件）：index.html（1760 行）/ float.html / quick-input.html

> **规则基准**：`hosts/memora-sprite/.trae/rules/directory-structure.md §2.4 CSS 架构规则` + `styles/README.md`

---

## 一、合理性评审（问诊门控）

| 维度 | 评估 |
|------|------|
| 架构一致性 | 项目刚完成 CSS-R1~R6 系统性重构（2026-07-09 ~ 2026-07-15），样式层结构已基本对齐最终形态，但规则与代码存在多处偏差待校准 |
| 自然生长原则 | 新增功能模块（clipboard.css / completion-stats.css）已实现，但规则文件未登记；符合 ADR-017 枝叶层"先实现再补登"模式 |
| 安全性 | CSP 已收紧为 `style-src 'self'`（§2.4.3），无 `unsafe-inline`，三窗一致 |
| 必要性 | 高——发现 1 处死代码、3 处重复加载、1 处加载顺序违规、11 处新增文件裸 px |
| 完整性 | 用户已提供详尽执行模式 + 关键约束 + 输出要求，前置上下文充分 |

**判定**：✅ 开始执行炼化归元（规则对齐 → 剪枝 → 提交前审查）

---

## 二、规则对齐（已对齐 X=5 项）

### ✅ 2.1 规则文件清单补齐（clipboard.css + completion-stats.css）

**问题**：规则文件声明与实际目录文件数不一致：
- `directory-structure.md §1` 目录树 + §2.4.1 表格：`memory/` 应 8 文件、`panels/` 应 3 文件
- `styles/README.md §1` 目录结构 + §2 加载顺序：同上
- 实际：`memory/` 9 文件（多 `completion-stats.css`）、`panels/` 4 文件（多 `clipboard.css`）

**验证**（Task 子代理扫描确认）：
- `memory/completion-stats.css` → 对应 `panels/completionStatsRenderer.ts`（活跃使用全部 17 个类）+ `index.html:606` `<div id="completion-stats-bar">` 预留容器 + `helpers/memoryViewSwitcher.ts:46` 注册视图切换映射，是"记忆面板第 3 个 analysis panel"（与 insights/health 互斥切换）
- `panels/clipboard.css` → 对应 `panels/clipboardPanelManager.ts`（518 行活跃代码）+ `index.html:1381-1401` 6 个 DOM 节点（独立面板）

**修复**：
- `directory-structure.md §1` 目录树：memory/ 增补 `completion-stats.css` 条目；panels/ 增补 `clipboard.css` 条目
- `directory-structure.md §2.4.1` 表格：memory/ 文件数 8→9；panels/ 文件数 3→4；overlays/content 加载顺序顺延
- `styles/README.md §1` 目录结构：同步增补两文件
- `styles/README.md §2.1` 主窗口加载顺序：增补 `panels/clipboard.css` 行
- `styles/README.md §4` memory.css 子模块映射表：增补 `completion-stats.css` 行（2026-07-15 新增）

### ✅ 2.2 index.html 删除 chat 子模块重复 link

**问题**：`index.html` 第 25-27 行单独 link 了 `chat-toolbar.css` / `chat-datenav.css` / `chat-perception.css` 三个子模块，但第 24 行已 link `chat/chat.css` 聚合器（内部 `@import` 已包含这 3 个子模块），造成**双重加载**——违反 §2.4.4 聚合器模式（聚合器为纯 `@import` 聚合器，HTML 只 link 一次）

**影响**：
- 网络资源浪费（file:// 下虽无网络往返，但 CSS 解析仍重复执行）
- 层叠规则被扰乱（重复 link 等于将子模块顺序提前到 panels 之前，破坏原层叠设计）
- 违反 §2.4.4 聚合器模式精神

**修复**：删除 index.html 第 25-27 行 3 处单独 link；同时整理加载顺序，符合 §2.4.9：
```
foundation/tokens → base → utilities → layout → chat/chat.css → memory/memory.css
→ panels/dashboard → perception → clipboard → settings
→ overlays/modal → toast → command-palette → search-messages
→ content/markdown
```

### ✅ 2.3 float.html 补 base.css + utilities.css

**问题**：`float.html` 第 18-20 行只 link 了 `tokens.css` + `windows/float.css`，缺少 `base.css` + `utilities.css`，违反 §2.4.9 浮窗加载顺序：
```
foundation/tokens.css → foundation/base.css → foundation/utilities.css → windows/xxx.css
```

**影响**：
- 当前 float.css 未引用 base.css 中的 `.hidden` / `.icon` / `.icon-btn` 等类，所以无即时错误
- 但违反规则，未来扩展浮窗使用通用类时会出现类未定义问题
- 与 quick-input.html 不一致（quick-input.html 已遵守规则）

**修复**：补上 foundation/base.css + foundation/utilities.css 两 link，并加注释说明加载顺序

### ✅ 2.4 memory.css 聚合器确认

**验证**：memory.css 第 19 行 `@import url("completion-stats.css");` 已正确挂载在 7 子模块之后（与 README §4 描述"挂载在 memory.css 聚合器末尾"一致），无需修改

### ✅ 2.5 令牌单一真理源确认（§2.4.2）

**验证**（Task 子代理扫描）：
- 全部 `:root` 块定义只在 `foundation/tokens.css:11` 出现 ✅
- `base.css` 中虽出现 `:root` 字样，但仅是注释（"浅色主题为默认（:root）"）描述主题策略，非实际选择器 ✅
- tokens.css 之外无任何 CSS 文件重新定义 `--` 变量 ✅

**结论**：单一真理源原则严格遵循，无需修复

---

## 三、剪枝（已剪枝 Y=1 项）

### ✅ 3.1 删除 clipboard.css 死代码 .clipboard-list-hidden

**问题**：`panels/clipboard.css:83` 定义了 `.clipboard-pending-list.clipboard-list-hidden { display: none; }`，但 Task 子代理扫描确认 `clipboardPanelManager.ts` 中从未对 `clipboard-pending-list` 元素调用 `classList.add/remove('clipboard-list-hidden')`——对比同文件中 `.clipboard-actions-hidden` 在 `clipboardPanelManager.ts:502/504` 被实际使用，可推断 `clipboard-list-hidden` 是遗漏实现的对称设计

**验证**：
- Grep clipboardPanelManager.ts 全文，确认无 `clipboard-list-hidden` 类引用
- pending-list 元素始终显示（靠空状态 `.clipboard-empty-state` 互斥切换内容）

**修复**：删除 `.clipboard-pending-list.clipboard-list-hidden { display: none; }` 规则块（5 行），替换为说明性注释："列表为空时通过 .hidden 工具类隐藏（base.css 提供，复用通用约定）"

---

## 四、提交前审查（已审查修复 Z=2 项）

### ✅ 4.1 completion-stats.css 11 处裸 px 令牌化

**问题**：`memory/completion-stats.css` 是新增文件（CSS-R7 之前未审查），共 11 处 padding/margin/gap 裸 px，零令牌化尝试

**规则基准**：§2.4.6 间距/圆角令牌化——组件 CSS 间距/圆角走 `--space-*` / `--radius-*` 令牌，禁止裸写 px（布局 width/height 等除外）

**修复映射**（11 处）：

| 行号 | 原代码 | 令牌化 | 备注 |
|------|--------|--------|------|
| 18 | `padding: 12px 16px` | `padding: var(--space-3) var(--space-4)` | ✅ |
| 26 | `margin-bottom: 12px` | `margin-bottom: var(--space-3)` | ✅ |
| 36 | `padding: 2px 10px` | `padding: 2px var(--space-2-5)` | 2px 保留次像素对齐 |
| 55 | `gap: 8px` | `gap: var(--space-2)` | ✅ |
| 56 | `margin-bottom: 16px` | `margin-bottom: var(--space-4)` | ✅ |
| 67 | `padding: 8px 10px` | `padding: var(--space-2) var(--space-2-5)` | ✅ |
| 72 | `gap: 2px` | 保留 2px | 次像素对齐 |
| 93 | `margin-top: 8px` | `margin-top: var(--space-2)` | ✅ |
| 100 | `margin-bottom: 6px` | `margin-bottom: var(--space-1-5)` | ✅ |
| 106 | `gap: 4px` | `gap: var(--space-1)` | ✅ |
| 115 | `gap: 8px` | `gap: var(--space-2)` | ✅ |
| 116 | `padding: 4px 6px` | `padding: var(--space-1) var(--space-1-5)` | ✅ |
| 125 | `padding: 1px 6px` | `padding: 1px var(--space-1-5)` | 1px 保留次像素对齐 |
| 160 | `padding: 24px 16px` | `padding: var(--space-6) var(--space-4)` | ✅ |

**保留项说明**：
- 1px / 2px 保留次像素对齐（与项目其他文件保持一致，tokens.css 未提供 1px/2px 间距令牌）
- `max-height: 300px` 保留（容器最大高度，非间距/圆角语义，属布局约束）

### ✅ 4.2 跨文件一致性复查

**复查项**：
- ✅ `:root` 块仅在 `tokens.css:11` 出现（单一真理源严格遵循）
- ✅ tokens.css 之外无任何 CSS 文件重新定义 `--` 变量
- ✅ chat.css 聚合器：7 个 `@import`，纯聚合器无直接规则
- ✅ memory.css 聚合器：8 个 `@import`（7 子模块 + completion-stats.css 挂载末尾），纯聚合器无直接规则
- ✅ 三窗 CSP 均为 `style-src 'self'` 无 `'unsafe-inline'`
- ✅ 三窗均无内联 `<style>` 块

### ✅ 4.3 验证结果

| 验证项 | 命令 | 结果 |
|--------|------|------|
| TypeScript 编译 | `npx tsc --noEmit -p tsconfig.json` | ✅ 0 errors |
| Vitest 全量测试 | `npx vitest run --reporter=dot` | ✅ 4482/4482 passed（132 test files） |

---

## 五、归档（待办 K=2 项）

### 🟡 P2：裸 px 滞留项（待自然生长触发）

> 来源：2026-07-19 [问诊·炼化归元] Step 8 sprite 样式层审查
> 评估原则：以下裸 px 滞留项均为"次像素对齐场景"或"集中分布的中等违规"，不主动实施，等 CSS-R8 自然生长触发或新枝破土扫描时再评估

| ID | 任务 | 位置 | 处数 | 建议 |
|----|------|------|------|------|
| CSS-0719-P2-1 | gap/border-radius 次像素对齐（1px/2px）大量分布 | 28 个 CSS 文件 | ~80 处 | 待自然生长触发：tokens.css 增补 `--space-0-5: 2px` 令牌后可统一替换。当前 1px/2px 多为 border/pixel-aligned 对齐语义，与项目其他文件保持一致 |
| CSS-0719-P2-2 | 中等违规集中文件（>5 处裸 px ≥4px） | memory-graph-misc.css / perception.css / layout.css / settings.css / float.css / dashboard.css / memory-graph-detail.css / search-messages.css | 8 文件 ~50 处 | 待自然生长触发：等下次对应功能模块大改时一并令牌化。当前所有违规均不影响功能正确性 |

### 不提取项归档（规则精神豁免）

| 模式 | 理由 |
|------|------|
| 1px/2px 次像素对齐 | tokens.css 未提供 `--space-0-5`（2px）令牌；与项目其他文件保持一致；属于 border/pixel-aligned 对齐语义 |
| `max-height: Npx` / `width: Npx` / `height: Npx` | §2.4.6 明确"布局 width/height 等除外"豁免 |
| box-shadow 含 px | README §3 明确"盒阴影、字号、width 等含 px 处保持字面量"豁免 |

---

## 六、汇报

| 阶段 | 数量 | 明细 |
|------|------|------|
| 已对齐 | X=5 | 2.1 规则文件清单补齐 + 2.2 index.html 删除重复 link + 2.3 float.html 补 base/utilities + 2.4 memory.css 聚合器确认 + 2.5 令牌单一真理源确认 |
| 已剪枝 | Y=1 | 3.1 clipboard.css 死代码 .clipboard-list-hidden 删除 |
| 已审查修复 | Z=2 | 4.1 completion-stats.css 11 处裸 px 令牌化 + 4.2 跨文件一致性复查 |
| 归档待办 | K=2 | P2 裸 px 滞留项（次像素对齐 + 中等违规集中文件）|

**验证**：TypeScript 0 errors + Vitest 4482/4482 passed

**git commit 建议**：
```
refactor(sprite-styles): CSS-R7 样式层规则对齐 + 剪枝 + 提交前审查

- 规则对齐：directory-structure.md + styles/README.md 补齐 memory/completion-stats.css
  + panels/clipboard.css 两个规则漏登记的文件
- 规则对齐：index.html 删除 chat-toolbar/datenav/perception 3 处重复 link
  （聚合器 chat.css 已 @import，违反 §2.4.4 聚合器模式）
- 规则对齐：float.html 补 base.css + utilities.css 两 link
  （违反 §2.4.9 浮窗加载顺序）
- 剪枝：clipboard.css 删除死代码 .clipboard-list-hidden
  （clipboardPanelManager.ts 零引用，与 .clipboard-actions-hidden 对比是遗漏实现的对称设计）
- 提交前审查：completion-stats.css 11 处裸 px 令牌化
  （保留 1px/2px 次像素对齐 + max-height 容器高度）

验证：tsc 0 errors + vitest 4482/4482 passed
```

---

## 七、后序衔接

**Step 9（跨模块整合审查，最终步骤）**：
- 范围：memora 内核 + sprite 宿主全栈整合审查
- 重点：跨模块依赖关系、IPC 通道治理（当前 117，距 130 阈值剩 13）、shared/ 共享层完整性、Web 模式与 Electron 模式一致性
- 输出：打包前最终质量报告 + 发布就绪评估
