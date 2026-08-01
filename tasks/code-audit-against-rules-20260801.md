# Memora 全库代码审查报告（对照最新 Cleaned Rules）

> **审查日期**：2026-08-01 | **范围**：`src/` + `hosts/memora-sprite/src/`（排除 node_modules / dist / __tests__ / assets / scripts）
> **规则基线**：`.trae/rules/` 清洗后全部 12 个规则文件（2026-08-01 清洗版）
> **审查方法**：4 个并行子代理自动化扫描 + 人工逐处复核交叉引用


## 一、严重问题（HIGH — 建议尽快修复）

### 1.1 裸 Error 抛出（违反 MemoraError 统一体系）

| # | 文件 | 行号 | 违规代码 | 规则引用 |
|---|------|------|---------|---------|
| H1 | `hosts/memora-sprite/src/electron/ipc/systemHandlers.ts` | 343 | `throw new Error('releases URL failed whitelist check')` | coding-convention §2 / project-rules §7.1：必须使用 `MemoraError` 体系 |

**修复**：改为 `throw securityError('releases URL failed whitelist check')` 或等效的 MemoraError 工厂函数。

---


### 1.2 God Object / 大类（字段数 ≥15 或职责数 ≥5，触发渐进式重构 §1 硬阈值）

| # | 文件（类名） | 字段数 | 方法数 | 行号 | 规则引用 |
|---|------------|--------|--------|------|---------|
| H2 | `hosts/…/renderer/ui.ts`（**UIManager**） | **29** | ~25+（含 mixins） | class L140，constructor L263–426 | progressive-refactor §1（字段≥15/职责≥5） |
| H3 | `src/agent/agent.ts`（**Agent**） | **28** | ~35+ | class L97 | progressive-refactor §1 |
| H4 | `src/agent/loop.ts`（**AgentLoop**） | **18** | **26** | class L104 | progressive-refactor §1（字段/方法双超标） |
| H5 | `hosts/…/renderer/panels/settingsPanelManager.ts`（**SettingsPanelManager**） | **~49** | ~20 | class 声明处 | progressive-refactor §1（跨越 4 个职责域） |
| H6 | `hosts/…/renderer/panels/memoryPanelManager.ts`（**MemoryPanelManager**） | **~50** | ~25 | class 声明处 | progressive-refactor §1（含 28 个回调注册字段） |

**说明**：H2–H4 为已知渐进重构中的 God Object（HEAL-10/HEAL-11/HEAL-16/HEAL-17 已多轮拆分），当前处于"字段数仍超标、职责已通过协调器/委托群改善"的过渡状态。H5/H6 为未经充分拆分的面板管理器。

**修复方向**：
- H2（UIManager）：构造函数已委托 Coordinator，可将子模块字段按功能域再提取纯状态容器（模式 A）
- H3（Agent）：28 个字段中 14 个为 managers/ 子类实例，可提取 `AgentComponents` 容器
- H4（AgentLoop）：6 个 `metric*` 字段可提取为 `LoopMetrics` 容器（模式 A）
- H5（SettingsPanelManager）：按 LLM配置 / 主动提示 / Provider管理拆分为 3 个子管理器
- H6（MemoryPanelManager）：回调字段用类型化的 EventMap 或 EventBus 替代

---


### 1.3 函数行数严重超标

| # | 文件 | 行号范围 | 方法名 | 行数 | 规则引用 |
|---|------|---------|--------|------|---------|
| H7 | `src/agent/loop.ts` | 535–669 | `callLlmWithRetry()` | **135** | coding-convention §6（单函数 ≤60 行） |
| H8 | `hosts/…/renderer/ui.ts` | 263–426 | `constructor()` | **164** | coding-convention §6 |

**修复方向**：H7 可提取 `buildRetryParams()` / `handleStreamError()` 子方法；H8 已知问题，构造逻辑已委托 Coordinator，可进一步用工厂函数或 Builder 模式收敛。


## 二、中等问题（MEDIUM — 应在后续迭代中修复）

### 2.1 函数行数超标

| # | 文件 | 行号范围 | 方法名 | 行数 | 规则引用 |
|---|------|---------|--------|------|---------|
| M1 | `src/agent/loop.ts` | 684–751 | `executeToolCalls()` | 68 | coding-convention §6 |
| M2 | `src/agent/loop.ts` | 272–340 | `handleRecallAndInputGuard()` | 69 | coding-convention §6 |


### 2.2 命名规范违规

| # | 文件 | 问题 | 规则引用 |
|---|------|------|---------|
| M3 | `hosts/…/renderer/components/base/Component.ts` | PascalCase 文件名（应为 `component.ts`） | project-rules §4（TS 文件用 camelCase） |


### 2.3 CSS 硬编码 font-size（应引用 `--font-*` 令牌）

| # | 文件 | 行号 | 代码 | 应改为 |
|---|------|------|------|--------|
| M4 | `styles/panels/perception.css` | 119 | `font-size: 8px;` | `--font-4xs`（需新建）或 `var(--font-3xs)` |
| M5 | `styles/panels/dashboard.css` | 122 | `font-size: 9px;` | `var(--font-3xs)` |
| M6 | `styles/panels/clipboard.css` | 60 | `font-size: 16px;` | `var(--font-lg)` |
| M7 | `styles/panels/clipboard.css` | 144 | `font-size: 10px;` | `var(--font-2xs)` |
| M8 | `styles/layout/sidebar.css` | 188 | `font-size: 10px;` | `var(--font-2xs)` |
| M9 | `styles/memory/completion-stats.css` | 245 | `font-size: 9px;` | `var(--font-3xs)` |
| M10 | `styles/memory/completion-stats.css` | 251 | `font-size: 9px;` | `var(--font-3xs)` |


### 2.4 CSS 非标准间距（margin/padding 不落在 4px 栅格，无注释说明）

| # | 文件 | 行号 | 代码 | 问题 |
|---|------|------|------|------|
| M11 | `styles/content/markdown.css` | 127 | `padding: 1px 5px;` | 1px/5px 不在栅格 |
| M12 | `styles/content/markdown.css` | 139 | `padding-left: 22px;` | 22px 不在栅格（最接近 `--space-5:20px` 或 `--space-6:24px`） |
| M13 | `styles/memory/views.css` | 39 | `padding: 40px var(--space-4);` | 40px 不在栅格 |
| M14 | `styles/memory/graph-detail.css` | 189 | `padding: 40px var(--space-4);` | 同上 |
| M15 | `styles/layout/web-mode.css` | 146 | `padding: 60px var(--space-6);` | 60px 不在栅格 |
| M16 | `styles/foundation/base.css` | 337 | `padding: 48px var(--space-6);` | 48px 不在栅格（有注释"非标"） |
| M17 | `styles/memory/completion-stats.css` | 96 | `padding: 1px var(--space-1-5);` | 1px 不在栅格 |
| M18 | `styles/chat/chat-perception.css` | 71 | `gap: 3px;` | 3px 不在栅格（有注释） |


### 2.5 Persona/Skill 数据写入 SQLite（§1.4 禁止——计划偏差）

| # | 文件 | 行号 | 问题 | 规则引用 |
|---|------|------|------|---------|
| M19 | `src/memory/loader.ts` | 21–24, 63–86 | `STARTUP_SCAN_SOURCES` 含 PERSONA/SKILL/RULE/GUARDRAIL，`loadAllToIndex()` 将文件记忆同步写入 SQLite 索引 | architecture_philosophy §1.4（Persona/Skill 不写入 SQLite） |

**评估**：属于**计划偏差**而非安全缺陷——配置文件为真理源，SQLite 仅作运行时索引；此行为与单 Agent 模型"SQLite 统一索引"设计呼应。架构上需明确：若坚持"Persona/Skill 不入 SQLite"，则索引机制需另辟捷径。

---


## 三、轻微问题（LOW — 可在闲暇时优化）

### 3.1 魔法数字（动画/UI 时限，低影响）

| # | 文件 | 行号 | 代码 |
|---|------|------|------|
| L1 | `hosts/…/electron/ipc/systemHandlers.ts` | 246 | `setTimeout(…, 10_000)` |
| L2 | `hosts/…/renderer/panels/panelRouter.ts` | 212 | `setTimeout(…, 500)`（动画过渡） |
| L3 | `hosts/…/renderer/float/float.ts` | 404 | `setTimeout(…, 600)`（动画过渡） |
| L4 | `hosts/…/renderer/float/float.ts` | 408 | `setTimeout(…, 3000)`（动画过渡） |
| L5 | `hosts/…/renderer/panels/archiveButtonManager.ts` | 229 | `setTimeout(…, 300)`（动画过渡） |


### 3.2 helpers → panels 反向 `import type`

| # | 文件 | 导入自 | 规则引用 |
|---|------|--------|---------|
| L6 | `hosts/…/helpers/providerManagement.ts:38` | `../panels/settingsPanelManager.js` (type-only) | sprite-project §4.1（helpers 不应依赖 panels） |
| L7 | `hosts/…/helpers/messageOperations.ts:17` | `../panels/chatPanelManager.js` (type-only) | 同上 |
| L8 | `hosts/…/helpers/chatPanelEvents.ts:33` | `../panels/chatPanelManager.js` (type-only) | 同上 |
| L9 | `hosts/…/helpers/memoryDetailPanel.ts:30` | `../panels/memoryPanelManager.js` (type-only) | 同上 |
| L10 | `hosts/…/helpers/memoryPanelEvents.ts:28` | `../panels/memoryPanelManager.js` (type-only) | 同上 |

**评估**：均为 `import type`（编译时擦除，零运行时依赖）。`Host` 接口模式是依赖倒置的形式——面板定义 `Host` 契约，helper 消费契约类型。属于结构上的轻微摩擦，可通过"将 Host 接口类型提取到共享 types 文件"消除。


### 3.3 其他轻微项

| # | 文件 | 行号 | 问题 | 规则引用 |
|---|------|------|------|---------|
| L11 | `hosts/…/src/index.ts` | 330 | `db.exec('PRAGMA journal_mode = WAL')` 在存储工厂函数内 | backend_layers §5（业务层不裸写 SQL——边界情况，属 DB 初始化指令） |
| L12 | `styles/layout/app-grid.css` | 60 | `z-index: 0;` 应引用 `var(--z-base)` | ui-engineering §一 |
| L13 | `src/eval/evalRunner.ts` | 187 | `void runPromise.catch(() => {})` 空 catch（有意为之的 Promise.race 超时抑制） | coding-convention §2 |


## 四、统计汇总

| 严重程度 | 数量 | 占比 |
|---------|------|------|
| HIGH | **8** | 23% |
| MEDIUM | **19** | 54% |
| LOW | **13** | 37% |
| **总计** | **40**（含 5 个已知渐进重构中的 God Object） | 100% |

### 按规则类别分布

| 规则类别 | HIGH | MEDIUM | LOW |
|---------|------|--------|-----|
| progressive-refactor §1（大类/God Object） | 6 | — | — |
| coding-convention §6（函数 >60 行） | 2 | 2 | — |
| coding-convention §2（异常处理） | 1 | — | 1 |
| project-rules §4（命名规范） | — | 1 | — |
| ui-engineering §一（CSS 令牌） | — | 15 | 1 |
| architecture_philosophy §1.4（SQLite 索引） | — | 1 | — |
| coding-convention §3（魔法数字/重复逻辑） | — | — | 5 |
| sprite-project §4.1（helpers → panels） | — | — | 5 |
| backend_layers §5（业务层 SQL） | — | — | 1 |

### 合规亮点（生产代码中零违规的领域）

- 🔒 `as any` / `@ts-ignore`：**0 个**
- 🎨 硬编码颜色值（hex/rgb/hsl）在非 tokens.css 文件中：**0 个**（100% 令牌化）
- 📦 内核零原生依赖（better-sqlite3 / electron / commander / express）：**0 个**
- 🔗 依赖方向违规（memory→persona / llm→agent / components→panels）：**0 个**
- 🏷️ HTML 内联 `style=""`（CSP 违规）：**0 个**
- 📄 裸 `console.log/error/warn` 在渲染进程：**0 个**（全部走 ILogger）

---

*报告生成：2026-08-01 09:20 | 规则基线：`.trae/rules/` post-cleanup | 审查范围：内核 + 精灵宿主全量生产代码*
