---
alwaysApply: false
description: 通用编码约束规则（TS/JS 适用，兼顾 Electron、Node 本地项目）
version: v0.2
date: 2026-07-13
---

# 通用编码约束规则

> **适用范围**：Memora 内核（`src/`）+ 精灵宿主（`hosts/memora-sprite/src/`）全部 TS/JS 代码
> **与现有规则关系**：与 [backend_layers_rules.md §分层职责](./backend_layers_rules.md) 互补（前者定边界，本文件定写法）；与 [security_rules.md](./security_rules.md) 正交（前者管权限，本文件管健壮性）
> **技术栈前提**：TypeScript 5 strict + ESM + Node.js ≥ 22（精灵宿主 Node.js 24），详见 [ADR-001](./decisions/ADR-001-runtime-stack.md) / [ADR-SP-001](./decisions/ADR-SP-001-runtime.md)

## 1. 契约与入参校验

> **核心原则**：校验只在入口做一次，内部信任契约。

| 类型 | 规则 |
| ---- | ---- |
| DO | 仅在函数入口做完整参数校验，函数内部不再重复判空、判类型 |
| DO | 优先用 TypeScript 类型、接口、泛型约束合法入参，类型无法覆盖的边界再做运行时校验 |
| DO | 通用校验逻辑（空值、ID 格式、数值范围、对象必填字段）统一抽公共工具函数 |
| DO | 可选参数、可选对象字段使用 `??` 兜底展示值 |
| DON'T | 非法参数静默返回默认值——统一抛出带明确提示的业务异常，阻断非法流程 |
| DON'T | 用 `??` 篡改核心业务标识类字段（主键、状态码、来源标记） |
| DON'T | 复制粘贴 `if` 判断——相同校验逻辑出现 2 次即抽工具函数 |

**Memora 适配**：`src/utils/` 下集中存放纯函数工具；记忆模型的 `source` 字段属核心标识，禁止兜底覆盖（详见 [ADR-004 · 记忆统一模型](./decisions/ADR-004-memory-unification.md)）。

**DOM 元素校验决策标准**：
- `instanceof` + `console.error`：用于 `document.getElementById()` 获取的静态 HTML 元素（缺失即 bug，需记录日志便于调试）
- `!` 断言：用于已确认存在的容器内的子元素（如弹窗模板内部元素，`dialog` 已确认存在则子元素必定存在）
- `instanceof` 前置判断：用于 `closest()` / `previousElementSibling` 等动态 DOM 遍历（元素确实可能不存在，合理边界）

## 2. 异常处理

> **核心原则**：区分业务异常与系统异常，不吞异常。

| 类型 | 规则 |
| ---- | ---- |
| DO | 区分两类异常：业务预期异常（参数错、数据不存在）、底层系统 IO 异常（DB/文件/网络/子进程） |
| DO | `try/catch` 仅包裹纯 IO 操作，不整函数包裹 |
| DO | 捕获底层异常后补充上下文日志，包装成业务异常向上抛出 |
| DO | 使用项目统一的 `MemoraError` 体系（含错误码 + 上下文），不用裸 `Error` |
| DON'T | 直接吞异常返回空对象/空数组——问题必须显性抛出 |
| DON'T | 嵌套多层 `try/catch`——单一异常来源只配一层捕获 |

**Memora 适配**：内核通过 `MemoraError` 统一错误体系（详见 [project-rules.md §7.1](./project-rules.md)）；AgentLoop 的 LLM 调用韧性（指数退避重试）是此规则的典型应用。

## 3. 代码简洁与复用

> **核心原则**：一个函数只做一件事，重复逻辑出现 2 次即抽象。

| 类型 | 规则 |
| ---- | ---- |
| DO | 单一职责：校验、查询、格式化、存储拆分独立方法 |
| DO | 消除重复分支逻辑，相同判断、转换、兜底统一抽工具 |
| DO | 控制 `if`/`for` 嵌套不超过 3 层，深层分支提前 `return` 扁平化 |
| DO | 常量、枚举、错误码统一存放公共文件 |
| DON'T | 无差别全量防御——契约约定合法入参后，内部不再冗余校验 |
| DON'T | 魔法数字、魔法字符串散落业务代码 |
| DON'T | 用 `export { x } from '...'` 透传导出后，在当前模块内部使用 `x`——透传导出不创建模块作用域绑定，会触发 `ReferenceError` |

**Memora 适配**：禁止 `@ts-ignore` 或 `as any`（详见 [project-rules.md §7.1](./project-rules.md)）；常量用全大写下划线（如 `BLOCKED_PATTERNS`、`CHAT_LOCK_TIMEOUT_MS`）。

**ES Module re-export 陷阱**：`export { x } from '...'` 是透传导出（re-export），不在当前模块作用域创建 `x` 绑定。若模块内部函数（如 `reportError()`）也使用 `x`，运行时会抛 `ReferenceError: x is not defined`。正确做法：先 `import { x } from '...'` 再 `export { x }`，既在模块作用域创建绑定又保持导出。

## 4. 日志与可观测

> **核心原则**：废弃原生 `console`，统一分级日志。

| 类型 | 规则 |
| ---- | ---- |
| DO | 使用项目统一的 `ILogger` 接口（`info`/`warn`/`error`/`debug`），不直接 `console.log` |
| DO | 正常流程用 `info`，可预期边界用 `warn`，崩溃/IO 故障用 `error` |
| DO | 异常日志携带关键上下文：入参、操作 ID、错误堆栈 |
| DO | 开发环境打印完整详情，线上精简脱敏敏感信息 |
| DON'T | 打印完整数据库实体、API Key、用户隐私内容 |
| DON'T | 用 `info` 记录异常——异常必须 `error` 级别 |

**Memora 适配**：内核 `src/logging/` 提供 `ILogger` 接口 + console fallback（详见 [project-rules.md §3](./project-rules.md)）；可观测性通过 `ITracer`/`ISpan` 接口 + 4 个关键 Span 埋点实现。

## 5. 数据与存储

> **核心原则**：DAO 层隔离 SQL，业务层不裸写数据库操作。
> **适配前提**：`better-sqlite3` 由宿主项目注入，内核零 native 依赖（详见 [ADR-002](./decisions/ADR-002-storage-layer.md)）。

| 类型 | 规则 |
| ---- | ---- |
| DO | DB 操作统一封装 DAO 层，业务层通过 `IMemoryStorage` 接口访问 |
| DO | SQL 全部使用参数预编译，禁止字符串拼接 |
| DO | 查询无数据属于业务边界，主动抛"数据不存在"异常（视场景也可返回空数组） |
| DO | 大批量数据采用分页/流式读取 |
| DO | 数据库模型单独定义 TypeScript 类型，隔离存储结构与业务返回结构 |
| DON'T | 业务层裸写 SQL 或直接操作数据库实例 |
| DON'T | 在 SQLite 中存储原始工作内容（仅存投影/摘要，详见 [project-rules.md §7.3](./project-rules.md)） |
| DON'T | 一次性全量加载大数据集 |

**Memora 适配**：`memora.db` 是 Agent 级共享资源，不随子项目切换重建（详见 [project-rules.md §1.4](./project-rules.md)）；配置文件是真理源，SQLite 是运行时索引（详见 [project-rules.md §1.5](./project-rules.md)）；禁止在 SQLite 中存储原始工作内容（详见 [project-rules.md §7.3](./project-rules.md)）。

## 6. 函数与变量规范

> **核心原则**：小函数、语义命名、按需定义。

| 类型 | 规则 |
| ---- | ---- |
| DO | 函数参数控制在 4 个以内，多参数改用对象入参 |
| DO | 单函数代码行数控制在 60 行以内，超长直接拆分 |
| DO | 变量语义化命名，布尔值统一使用 `is`/`has`/`should` 前缀 |
| DO | 优先使用解构、可选链（`?.`）简化判空 |
| DON'T | 简写、无意义命名（如 `a`、`b`、`tmp`、`data2`、`data`、`info`）——`data`/`info` 携带零语义信息，无法区分用途，应替换为领域名词（如 `memories`、`snapshot`、`config`） |
| DON'T | 提前声明大量无用兜底变量——临时中间变量按需定义 |
| DON'T | 堆砌多层 `if` 判断替代可选链 |

**Memora 适配**：命名规范详见 [project-rules.md §4](./project-rules.md)（文件夹连字符、TS 文件小驼峰、类大驼峰、常量全大写下划线）。

**CSS 命名规范**（详见 [ADR-018 · CSS 作用域规范](./decisions/ADR-018-css-scoping-convention.md)）：

| 类型 | 规则 | 例子 |
|------|------|------|
| L2 面板专属类 | **面板前缀 + BEM 连字符风格** | `.perception-affect-grid`、`.dashboard-overview-item` |
| L3 组件类 | 组件名 + BEM | `.modal-header`、`.toast-content` |
| 状态类 | `.is-` 前缀或 `.hidden` | `.is-active`、`.is-hidden` |
| 禁止 | 无前缀的 BARE 类（chat 主面板例外） | ~~`.affect-label`~~ → `.perception-affect-label` |
| 禁止 | 用 `.active` 作为状态类（与 `.panel.active` 冲突） | 用 `.is-active` 替代 |

**BEM 风格**：`.block-name-element-name--modifier-name`（连字符风格，Block-Element 用单连字符，Modifier 用 `--` 双连字符）

## 7. 分支与兜底取舍

> **核心原则**：能提前 `return` 就不写 `else`，兜底不掩盖问题。

| 类型 | 规则 |
| ---- | ---- |
| DO | 能提前 `return` 就不写 `else`，扁平化代码 |
| DO | 仅展示层、UI 渲染字段允许默认兜底 |
| DO | 逻辑上 100% 不可能出现的边界，不额外增加冗余判断 |
| DON'T | 核心业务主键、状态用兜底默认值覆盖——问题显性抛出 |
| DON'T | 滥用兜底默认值掩盖参数错误、数据缺失 |

**Memora 适配**：`archiveMode` 三态控制（full/insights-only/manual）属核心状态，禁止兜底为 `full`（详见 [ADR-015](./decisions/ADR-015-archive-mode.md)）。

## 8. 工程分层

> **核心原则**：下层不可感知上层，禁止跨层调用。
> **详细分层职责**：详见 [backend_layers_rules.md §分层职责](./backend_layers_rules.md)。

| 类型 | 规则 |
| ---- | ---- |
| DO | 分层隔离：工具层（`utils/`）→ 数据 DAO 层（`memory/`）→ Service 业务层（`agent/`）→ 界面/主进程控制器（宿主） |
| DO | 每层出入参使用独立类型，不直接透传数据库原始实体 |
| DO | 通用能力（校验、日志、错误、文件工具）统一抽全局公共模块 |
| DON'T | 下层感知上层——禁止跨层直接调用 |
| DON'T | 业务代码重复实现通用能力 |

**Memora 适配**：内核与宿主的职责边界详见 [backend_layers_rules.md §核心库 vs 宿主项目职责边界](./backend_layers_rules.md)；精灵宿主的分层详见 [sprite-project-rules.md](./sprite-project-rules.md)。

## 9. 稳定性隐性约束

> **核心原则**：IO 必须有超时，异步必须处理异常。

| 类型 | 规则 |
| ---- | ---- |
| DO | 文件、数据库操作增加超时控制，禁止无限阻塞 |
| DO | 外部依赖、本地文件读写增加最小范围异常捕获 |
| DO | 异步函数统一 `async`/`await`，所有 `Promise` 必须处理异常或向上抛出 |
| DON'T | 裸 `Promise` 不处理 `catch` |
| DON'T | 异步操作忽略返回值 |
| DON'T | `await` 后不捕获异常（除非确定上层有统一兜底） |

**Memora 适配**：`chat()` 并发锁超时保护（`CHAT_LOCK_TIMEOUT_MS = 180_000`，3 分钟自动释放）是此规则的典型应用；LLM 调用韧性通过 AgentLoop 指数退避重试实现（流式输出前可重试）。

---

## 速查表

| 场景 | 正确做法 | 错误做法 |
| ---- | -------- | -------- |
| 函数参数校验 | 入口处一次校验 + 抛业务异常 | 内部每处重复判空 |
| IO 异常 | catch → 补上下文 → 包装业务异常抛出 | catch → 返回空对象 |
| 重复逻辑 | 出现 2 次即抽工具函数 | 复制粘贴 if 判断 |
| 日志 | `ILogger.error()` + 上下文 | `console.log()` |
| SQL | DAO 层 + 参数预编译 | 业务层裸写 + 字符串拼接 |
| 嵌套 | 提前 return，≤3 层 | 深层 if/else 嵌套 |
| 异步 | `async`/`await` + try/catch | 裸 Promise 不 catch |
| 兜底 | 仅展示层字段用 `??` | 核心主键/状态用默认值覆盖 |

---

_规则文件版本：v0.2（2026-07-13）_ _适用项目：Memora_ _强制力：P2（应遵守，违反需在 PR 中说明理由）_
