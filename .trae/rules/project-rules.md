---
alwaysApply: false
description: Memora 项目总则、技术栈清单、目录结构、硬约束与 AI 行为速查
---

# Memora · 项目总则

> **设计哲学**：万物皆是记忆｜**核心矛盾**：无状态推理 ←→ 连续演化任务
> **架构定位**：memora = 通用闭环引擎（插卡机），角色包 = 参数集（卡）。通用性由内核保证，专业性由角色包驱动（[architecture_philosophy_rules.md §11](./architecture_philosophy_rules.md)）
> **基调**：专注模式（应无所住，而生其心）——支持切换，默认专注（[§9](./architecture_philosophy_rules.md)）
> **决策追溯**：决策年轮 `.trae/decisions/`（编号规则、跳号与废弃状态以 [decisions/README](../decisions/README.md) 为单一真源）

## 1. 不可违反的硬约束

1. **ADR 优先于个人偏好**：技术栈变更必须先更新 ADR（`.trae/decisions/`）
2. **跨文档引用规范**：用「文档.§章节号」格式，详见 [cross-document-reference.md](./generic/cross-document-reference.md)
3. **记忆统一模型**：不引入「规则/技能/历史」等独立子系统；统一用 `source` 开放字符串区分（[ADR-004](../decisions/ADR-004-memory-unification.md)）
4. **单 Agent 模型 + 三层架构**：memora.db 是 Agent 级共享资源，不随子项目切换重建（[§10](./architecture_philosophy_rules.md)）
5. **配置文件是真理源**：配置文件持久化，SQLite 仅作运行时索引（[§10](./architecture_philosophy_rules.md)）
6. **内核 Node.js 专属 + 零第三方依赖**：纯逻辑库，只用内置模块（`node:fs`/`node:path`/`node:os`/`node:crypto`），`dependencies` 为空。不引入 native 模块（better-sqlite3/electron）与宿主专属 API（Electron/browser）；**不做任何运行时三方模块解析**（不静态 import / 不动态 `import()` / 不 `require()`），`peerDependencies` 亦不声明。日志经 `setLogger()` 注入 `ILogger`，未注入用内置 console fallback（写 stderr）（[ADR-002](../decisions/ADR-002-storage-layer.md)）
7. **设定记忆 = 纯文件装载**：persona/rules/skills 唯一归角色包 / 技能池，纯文件 + 内存缓存装载（[memory-role-pack-boundary-rules.md](./memory-role-pack-boundary-rules.md) R1/R3/R9），**不写 SQLite / 记忆库**。配置文件是真理源，内核只读；新增 / 修改由宿主落文件 + 扫描装载（skills 目录动态扫描）。历史 `ConfigManager` 两段式契约（`addRule`/`deleteRule`/`updateRule`/`deleteSkill` + `fileConsistencyCheck`）已移除，不再引用
8. **检查点纯内存态**：`SessionCheckpoint` 是同进程内存态快照，**不落盘、无序列化 / 恢复路径**；中止 / 断电走「中断轮补全为完整 turn」，暂停为同 turn 内存续跑。`schemaVersion` 字段 + `AGENT_CONSTANTS.CHECKPOINT_SCHEMA_VERSION` **已彻底删除**（勿再引用）；**无版本迁移分发表**（`normalizeCheckpoint` / `checkpointMigrations` / `CURRENT_SCHEMA_VERSION` 已随恢复链退役）。新增字段只需内存态自洽，无需注册迁移

## 2. 技术栈清单

| 类别 | 选型 | 决策 |
| ---- | ---- | ---- |
| 运行时 | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | [ADR-001](../decisions/ADR-001-runtime-stack.md) |
| 数据层 | IMemoryStorage 接口（宿主注入持久化实现） | [ADR-002](../decisions/ADR-002-storage-layer.md) |
| 冲突消解 | supersededBy 布尔标记（写路径取代检测，读时过滤） | [ADR-021](../decisions/ADR-021-memory-conflict-supersede-write-path.md) |
| 归档模式 | archiveMode 二态（full / manual；insights-only 随洞察层移除） | [ADR-015](../decisions/ADR-015-archive-mode.md) |
| LLM | OpenAI Chat Completions 兼容协议 | [ADR-003](../decisions/ADR-003-llm-adapter.md) |
| 形态 | 纯逻辑库（CLI 由宿主提供） | [ADR-002 v0.8](../decisions/ADR-002-storage-layer.md) |
| 安全 | 两级权限 + 路径白名单 | [ADR-006](../decisions/ADR-006-security-model.md) |
| 测试 | Vitest + MSW Mock LLM + InMemoryStorage | [ADR-007](../decisions/ADR-007-testing-strategy.md) |
| 目录 | 按职责分层 | [ADR-008](../decisions/ADR-008-directory-structure.md) |

## 2.5 同仓库多 Package 结构（Monorepo）

本仓库含 memora **内核**（纯逻辑库）与第一宿主 **VS Code 插件**（`hosts/memora-vscode/`），各有独立 `package.json` / `tsconfig` / 测试 / 构建，共享同一 Git 仓库。桌面精灵宿主（memora-sprite）已独立仓库，不受本仓库规则约束。

```
memora/
├── .gitignore          # 统一管理所有 package（单一真理源）
├── .trae/rules/        # 仓库级规则（本文件所在目录）
├── package.json        # memora 内核（纯逻辑库）
├── src/                # 内核源码（§3 目录结构）
├── tasks/              # 统一任务追踪（内核 + 插件共享，唯一真理源）
└── hosts/memora-vscode/  # 第一宿主：VS Code 插件（当前主战场）
```

| 规则 | 说明 |
|------|------|
| 独立 package | 内核与宿主各自 `npm install` / `npm test` / `npm run build`，互不依赖对方 devDependencies |
| 统一 .gitignore | 根目录 `.gitignore` 是唯一真理源，子目录不得存在独立 `.gitignore` |
| 内核 Node.js 专属 | 只用内置模块，不引入 native 模块与宿主专属 API（[ADR-002 v0.9](../decisions/ADR-002-storage-layer.md)） |
| 宿主依赖内核 | 宿主以独立 package 依赖版本化的 `@zooique/memora`（[ADR-002](../decisions/ADR-002-storage-layer.md) / [ADR-VC-001](../decisions/ADR-VC-001-vscode-plugin-host.md)） |

## 3. 目录结构（不允许修改）

```
src/
├── index.ts        # 库导出入口（类型 + 接口 + 函数 + 类导出，无 CLI）
├── agent/          # Agent 门面 + AgentLoop（seed/ turn 编排）+ 工具执行 + managers/ 子目录（专职 Manager/服务类，完整清单与职责见 backend_layers_rules.md §分层职责）+ 上下文装配
├── code-exec/      # 通用代码执行抽象（ICodeExecutionProvider + 沙箱由宿主提供）
├── config/         # 配置加载
├── llm/            # LLM 适配层
├── logging/        # 日志（ILogger 接口 + console fallback）
├── memory/         # 记忆引擎（IMemoryStorage 接口 + InMemoryStorage 实现 + 召回）
├── role-pack/      # 角色包与行为策略定义（三层结构：L1 内容 + L2 策略 + L3 代码预留）
├── security/       # 安全策略
├── skill/          # 技能管理（configDir/skills/ + 角色包 skills/ 扫描，渐进披露）
├── utils/          # 工具函数（含 eventEmitter.ts 事件系统 / scanner / configResourceManager）
├── web-fetch/      # 网页抓取抽象（IFetchProvider + FetchWebFetchProvider，条件暴露）
└── web-search/     # 网络搜索抽象（IWebSearchProvider + FetchWebSearchProvider，条件暴露）
```

> **唯一真理源声明**：本节是**顶层目录结构的唯一冻结契约**（增删顶层模块必须先走 [new-module-guide.md](./generic/new-module-guide.md) 并经 ADR 记录）。模块**内部**文件命名（index.ts / types.ts / core.ts / helpers.ts）以 [backend_layers_rules.md §模块内文件命名](./backend_layers_rules.md) 为**快照性质**参考，随重构可能漂移、**不构成冻结契约**——两处冲突以本节为准。
> **已移出**：`SqliteStorage` / `cli/` / `commander` / `better-sqlite3`（→ 宿主项目）

## 4. 命名规范（与 .trae/rules/ 一致）

| 类型 | 规则 |
| ---- | ---- |
| 文件夹 | 连字符（`cli-commands/`） |
| TS 文件 | 小驼峰（`openaiCompatible.ts`） |
| 类 | 大驼峰（`OpenAICompatibleProvider`） |
| 变量/函数 | 小驼峰（`loadConfig`） |
| 常量 | 全大写下划线（`BLOCKED_PATTERNS`） |
| 类型/接口 | 大驼峰（`Memory`、`ChatOptions`） |

> **I-prefix 例外**：宿主注入的接口（依赖倒置契约面，如 `ILogger`/`IMemoryStorage`/`ITracer`）允许 `I` 前缀——它承载「由外部实现」的架构意图，不算 Hungarian 违规。非注入接口仍须纯 PascalCase。
> **语义归属**（step / planItem 等指什么）见 [terminology-anchor-rules.md](./terminology-anchor-rules.md)。

## 5. Git 提交规范

类型：`feat` / `fix` / `docs` / `test` / `refactor` / `chore`；格式 `<type>(<scope>): <subject>`

## 6. 规则文件索引

> 列出 `.trae/rules/` 全部规则文件，方便按需加载。**`alwaysApply: true` 随会话自动加载，其余需 AI 主动读取。**

| 类别 | 文件 |
|------|------|
| 总则 / 硬约束 | [project-rules.md](./project-rules.md)（本文件） |
| 架构哲学（12 原则） | [architecture_philosophy_rules.md](./architecture_philosophy_rules.md) |
| 后端分层 / 目录 | [backend_layers_rules.md](./backend_layers_rules.md) |
| 通用编码约束 | [coding-convention-rules.md](./generic/coding-convention-rules.md) |
| 心智模型（Bug/逻辑） | [programmer-mindset-rules.md](./generic/programmer-mindset-rules.md) |
| 单一真理源思维模型 | [single-truth-source-mindset.md](./generic/single-truth-source-mindset.md) |
| **领域术语锚点（常驻）** | [terminology-anchor-rules.md](./terminology-anchor-rules.md)（`alwaysApply: true`；术语唯一定义，命名前必读） |
| 网络为土壤思维模型 | [network-soil-mindset.md](./generic/network-soil-mindset.md) |
| UI 工程化心智 | [ui-engineering-mindset-rules.md](./generic/ui-engineering-mindset-rules.md) |
| 渐进式重构 | [progressive-refactor-rules.md](./generic/progressive-refactor-rules.md) |
| 安全 / 测试 | [security_rules.md](./generic/security_rules.md) / [testing_rules.md](./generic/testing_rules.md) |
| 跨文档引用 / 新增模块 | [cross-document-reference.md](./generic/cross-document-reference.md) / [new-module-guide.md](./generic/new-module-guide.md) |
| 决策记录（26 ADR） | `decisions/`（[README](../decisions/README.md)；技术栈变更先更新 ADR，§1①） |

> 任务追踪统一在根 `tasks/`（唯一真理源）。
> **架构说明书**：[docs/architecture/agent-design-philosophy.md](../../docs/architecture/agent-design-philosophy.md)（设计哲学 + 闭环设计 + 数据模型 + 角色包体系 + 思维模式速查）。
> **架构定论**：不中断工作模型 = 「申请暂停模型」——不中断原则作用于 **turn 内的 step 循环**；暂停 = 等进行中的 turn 结束于 step 边界挂起（可继续 / 注入）；硬停止 `signal.abort` 是唯一霸道中止（推导见架构说明书 §2.3）。

## 7. AI 行为 DO/DON'T 速查表

> §1 是原则级硬约束，本节是实施级补充。

### 7.1 代码质量

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 使用 `@ts-ignore` 或 `as any`（零容忍） |
| DON'T | 在生产文件中保留死代码 |
| DO | 提交前通过 pre-commit lint + typecheck + commitlint |
| DO | 参考 [testing_rules.md §3 覆盖率目标](./generic/testing_rules.md) 与 [coding-convention-rules.md §2 异常处理](./generic/coding-convention-rules.md) |

### 7.2 内核独立性（补充 §1.6）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 `src/` 下 import better-sqlite3 / electron / commander 等 native 或宿主专属模块 |
| DON'T | 在 `src/` 下 import 任何 web 框架（Express / HTML / CSS） |
| DON'T | 工具函数绑定特定第三方依赖（如 pino） |

### 7.3 记忆与存储（补充 §1.3 / §1.4）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 SQLite 中存储原始工作内容（仅存投影 / 摘要） |
| DON'T | 混合技能定义与内存存储（技能通过 `skills/` 文件夹管理） |
| DON'T | 直接修改 config schema（配置文件是真理源，§1） |
| DO | 工作内容通过宿主工具访问，内核仅保留投影 |
| DO | 切换项目用 `close()`，完全终止用 `shutdown()` |

### 7.4 Agent 门面约束

| 类型 | 规则 |
| ---- | ---- |
| DON'T | Agent 管理 LLM API keys 或 provider 配置（宿主负责） |
| DON'T | Agent 含 CLI/REPL 逻辑（CLI 由宿主提供） |
| DON'T | Agent 直接输出到终端（UI 由宿主处理） |
| DON'T | Agent 直接修改用户配置文件（通过宿主回调中介） |
| DO | LlmProvider 通过构造函数注入（`provider` 必填，`backgroundProvider` 可选） |
| DO | 工具注册通过 `registerTool()` 机制 |

### 7.5 功能开发流程

| 类型 | 规则 |
| ---- | ---- |
| DO | 底层问题优先修复（架构 / 基础设施层面，避免积重难返） |
| DO | 代码修复独立可回滚（每次修复独立提交） |
| DO | 自动归档根据 `archiveMode` 执行（full / manual 二态） |
| DO | LLM 工具调用传递 `tools` 参数，SSE 流正确解析 `tool_calls` delta |

### 7.6 代码组织与治理

| 类型 | 规则 |
| ---- | ---- |
| DO | 新增 IPC 通道前确认能否由现有通道组合达成，避免重复注册 |
| DO | IPC 通道总数接近 130 条时启动治理评估（当前 **107** 条，2026-10-04 实测——后台任务出口新增 `background_tasks` / `background_kill` 两条后按守卫同源判据重算；阈值单一真源见 `hosts/memora-vscode/src/shared/__tests__/protocolGuard.test.ts`；⚠️ **该计数每次增删通道即过期，引用前须按守卫同源判据重算**——此前 2026-10-01 记「105」、2026-09-20 记「101」均已实测漂移） |
| DO | 新增模块前先走 [new-module-guide.md](./generic/new-module-guide.md) 评估流程 |
