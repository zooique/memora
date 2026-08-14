---
alwaysApply: false
description: Memora 项目总则、技术栈清单、目录结构
---

# Memora · 项目总则

> **设计哲学**：万物皆是记忆 **核心矛盾**：无状态推理 ←→ 连续演化任务
> **架构定位**：memora = 通用闭环引擎（插卡机），角色包 = 参数集（卡）。**通用性由内核保证，专业性由角色包驱动**。详见 [architecture_philosophy_rules.md §11](./architecture_philosophy_rules.md)
> **基调**：专注模式（应无所住，而生其心）——支持切换，默认专注详见
> [architecture_philosophy_rules.md §9](./architecture_philosophy_rules.md)
> **决策追溯**：`.trae/decisions/` 下 30 个 ADR（内核 18 + 精灵 12）

## 1. 不可违反的硬约束

1. **ADR 优先于个人偏好**：技术栈变更必须先更新 ADR（`.trae/decisions/`）
2. **跨文档引用规范**：详见
   [cross-document-reference.md](./cross-document-reference.md)——使用"文档.§章节号"格式
3. **记忆统一模型**：不引入"规则/技能/历史"等独立子系统；统一用
   `source` 开放字符串区分（详见 [ADR-004](../decisions/ADR-004-memory-unification.md)）
4. **单 Agent 模型 + 三层架构**：memora.db 是 Agent 级共享资源，不随子项目切换重建（详见 [architecture_philosophy_rules.md §10](./architecture_philosophy_rules.md)）
5. **配置文件是真理源**：配置文件是持久化真理源，SQLite 仅作运行时索引（详见 [architecture_philosophy_rules.md §10](./architecture_philosophy_rules.md)）
6. **内核 Node.js 专属 + 零第三方依赖**：memora 是 Node.js 专属纯逻辑库，依赖 Node.js 内置模块（`node:fs`/`node:path`/`node:os`/`node:crypto` 等），但 `dependencies` 字段为空（零第三方运行时依赖）。不引入 native 编译模块（better-sqlite3/electron 等）和宿主专属 API（Electron/browser API 等）。pino 作为可选 `peerDependencies`（`optional: true`）+ `optionalDependencies` 保留，零配置时宿主开箱即用，宿主也可注入自定义 `ILogger` 覆盖（详见 [ADR-002 v0.9 定位定论](../decisions/ADR-002-storage-layer.md)）
7. **文件层两段式契约**：ConfigManager 写 API（addRule/deleteRule/updateRule/deleteSkill）只同步 SQLite 索引层，**不操作文件**。文件层写入/删除由宿主 `configFileSyncer` 先完成，再调用 ConfigManager 同步索引。ConfigManager 通过可选 `fileConsistencyCheck` 回调前置断言文件操作状态，防止"重启复活"（详见 [configManager.ts](../../src/agent/managers/configManager.ts) 文件级注释）
8. **检查点版本迁移机制**：`SessionCheckpoint.schemaVersion` 是检查点结构的版本标识，支持向前兼容的迁移。`SessionManager.checkpointMigrations` 静态分发表注册按版本号升序的迁移函数，`normalizeCheckpoint` 在加载时自动应用。新增检查点字段必须：① 递增 `CURRENT_SCHEMA_VERSION`；② 在 `checkpointMigrations` 中注册迁移（详见 [sessionManager.ts](../../src/agent/managers/sessionManager.ts) 及 [constants.ts](../../src/agent/constants.ts) `AGENT_CONSTANTS.CURRENT_SCHEMA_VERSION`）
9. **IPC 通道数量治理**：精灵宿主 IPC 通道总数接近 150 条时应启动治理评估。新增 IPC 通道必须：① 确认是否可通过现有通道组合达成（避免重复注册）；② 在 `ipc/` 目录下统一注册（quick-input 窗口内联注册例外，见 [sprite-project-rules.md §10.2](./sprite-project-rules.md)）；③ 新增通道后更新通道计数（当前计数约 125 条，治理阈值 150 条）

## 2. 技术栈清单

| 类别   | 选型                                         | 决策                                                  |
| ------ | -------------------------------------------- | ----------------------------------------------------- |
| 运行时 | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | [ADR-001](../decisions/ADR-001-runtime-stack.md)       |
|        | （精灵宿主要求 Node.js 24 LTS，详见 [ADR-SP-001](../decisions/ADR-SP-001-runtime.md)） | |
| 数据层 | IMemoryStorage 接口（宿主注入持久化实现）    | [ADR-002](../decisions/ADR-002-storage-layer.md)       |
| 冲突消解 | supersededBy 布尔标记（写路径取代检测，读时过滤） | [ADR-021](../decisions/ADR-021-memory-conflict-supersede-write-path.md) |
| 归档模式 | archiveMode 三态控制（full / insights-only / manual） | [ADR-015](../decisions/ADR-015-archive-mode.md)    |
| LLM    | OpenAI Chat Completions 兼容协议             | [ADR-003](../decisions/ADR-003-llm-adapter.md)         |
| 形态   | 纯逻辑库（CLI 由宿主提供）                   | [ADR-002 v0.8](../decisions/ADR-002-storage-layer.md)  |
| 安全   | 两级权限 + 路径白名单                        | [ADR-006](../decisions/ADR-006-security-model.md)      |
| 测试   | Vitest + MSW Mock LLM + InMemoryStorage      | [ADR-007](../decisions/ADR-007-testing-strategy.md)    |
| 目录   | 按职责分层                                   | [ADR-008](../decisions/ADR-008-directory-structure.md) |

## 2.5 同仓库多 Package 结构（Monorepo）

本仓库包含两个独立的 npm package，共享同一个 Git 仓库但各自有独立的 `package.json`、`tsconfig`、测试和构建流程：

```
memora/                          # Git 仓库根目录
├── .gitignore                   # 统一管理所有 package 的忽略规则（单一真理源）
├── .trae/rules/                 # 仓库级规则（本文件所在目录）
├── package.json                 # memora 内核（纯逻辑库）
├── tsconfig.json
├── src/                         # memora 内核源码（§3 目录结构）
├── tasks/                       # 统一任务追踪（内核 + 精灵共享，唯一真理源）
│
└── hosts/
    ├── vscode-plugin/            # 第一宿主：VS Code 插件（当前主战场，演示 memora 内核能力）
    └── memora-sprite/            # 早期桌面精灵宿主（已搁置，实现保留供参考）
        ├── .trae/rules/         # 精灵专属规则（仅 directory-structure.md）
        ├── package.json         # 精灵独立 package（name: "memora-sprite"）
        ├── tsconfig.json        # 精灵独立 tsconfig（含 electron 多配置）
        ├── src/                 # 展示项目源码（electron + renderer + storage + web）
        ├── assets/              # 精灵静态资源（icon.svg 是真理源，PNG 由脚本生成）
        └── scripts/             # 构建脚本（含 sync-memora.mjs、generate-icons.mjs）
```

**关键约束**：

| 规则 | 说明 |
|------|------|
| 独立 package | 两个 package 各自 `npm install`、`npm test`、`npm run build`，互不依赖对方的 devDependencies |
| 统一 .gitignore | 根目录 `.gitignore` 是唯一真理源，不允许子目录存在独立 `.gitignore` |
| 内核 Node.js 专属 | memora 内核是 Node.js 专属纯逻辑库，依赖 Node.js 内置模块（fs/path/os/crypto），但不引入 native 编译模块（better-sqlite3/electron 等）和宿主专属 API（详见 [ADR-002 v0.9](../decisions/ADR-002-storage-layer.md)） |
| 展示项目依赖内核 | 展示项目通过 `sync-memora.mjs` 分发内核：编译内核 `src/` → `dist/`，最小化复制到展示项目 `node_modules/memora/`（仅含 dist + 元数据）；源码 import 保持 `from 'memora'`。`file:../..` 已于 2026-07-17 废弃（Junction 会将全量仓库打入 asar，详见 [ADR-SP-005](../decisions/ADR-SP-005-package-management.md)） |
| 规则分层 | 仓库级规则在 `.trae/rules/`，展示项目专属规则在 `hosts/memora-sprite/.trae/rules/`，后者仅约束展示项目 |
| 任务统一 | 根 `tasks/` 是唯一任务追踪目录（内核 + 精灵共享），`hosts/memora-sprite/tasks/` 已合并归档 |

## 3. 目录结构（不允许修改）

```
src/
├── index.ts        # 库导出入口（类型 + 接口 + 函数 + 类导出，无 CLI）
├── agent/          # Agent 门面 + AgentLoop + 工具执行 + managers/ 子目录（专职 Manager/服务类，完整清单与职责见 backend_layers_rules.md §分层职责）+ 对话快照 + 作品投影 + 关联推荐
├── memory/         # 记忆引擎（IMemoryStorage 接口 + InMemoryStorage 实现 + 召回）
├── persona/        # 角色管理（角色配置，记忆管道最高优先级）
├── skill/          # 技能管理（configDir/skills/ 扫描，记忆管道最高优先级）
├── role-pack/      # 角色包与行为策略定义（三层结构：L1 内容 + L2 策略 + L3 代码预留）
├── llm/            # LLM 适配层
├── security/       # 安全策略
├── config/         # 配置加载
├── logging/        # 日志（ILogger 接口 + console fallback）
├── eval/           # 评估框架（EvalScenario 类型 + 工具函数）
├── web-search/     # 网络搜索抽象（IWebSearchProvider 接口 + FetchWebSearchProvider 实现）
└── utils/          # 工具函数（含 eventEmitter.ts 事件系统）
```

> **唯一真理源声明**：本节是**顶层目录结构的唯一冻结契约**（增删顶层模块必须先走 [new-module-guide.md](./new-module-guide.md)，并经 ADR 记录）。模块**内部**的命名与拆分约定（index.ts / types.ts / core.ts / helpers.ts 等标准文件）以 [backend_layers_rules.md §模块内文件命名](./backend_layers_rules.md) 为**快照性质**参考，随重构可能漂移、**不构成冻结契约**——若两处描述冲突，以本节为准。

> **已移出**：`SqliteStorage`（→ 宿主项目）、`cli/`（→ 宿主项目）、`commander`（→ 宿主项目）、`better-sqlite3`（→ 宿主项目）

## 4. 命名规范（与 .trae/rules/ 一致）

| 类型      | 规则                                 |
| --------- | ------------------------------------ |
| 文件夹    | 连字符（`cli-commands/`）            |
| TS 文件   | 小驼峰（`openaiCompatible.ts`）     |
| 类        | 大驼峰（`OpenAICompatibleProvider`） |
| 变量/函数 | 小驼峰（`loadConfig`）               |
| 常量      | 全大写下划线（`BLOCKED_PATTERNS`）   |
| 类型/接口 | 大驼峰（`Memory`、`ChatOptions`）    |

> **I-prefix 例外**：由宿主项目注入的接口（依赖倒置契约面，如 `ILogger`/`IMemoryStorage`/`ITracer`）允许使用 `I` 前缀——注入契约在架构语义上不同于普通数据类型/接口，`I` 前缀在此处承载了「由外部实现」的架构意图，不作为 Hungarian notation 违规。非注入接口仍须遵循纯 PascalCase。

## 5. Git 提交规范

```
feat: 新增记忆召回管线
fix: 修复路径白名单越界
docs: 更新架构设计文档
test: 补充 Agent Loop E2E
refactor: 重构 LLM Provider 抽象
chore: 升级 dependencies
```

格式：`<type>(<scope>): <subject>`

## 6. 规则文件索引

> 本节列出 `.trae/rules/` 下所有规则文件，方便按需加载。`alwaysApply: true` 的文件随会话自动加载，其余文件需 AI 主动读取。

### 6.1 规则文件索引（按需加载）

| 类别 | 文件 |
|------|------|
| 总则 / 硬约束 | [project-rules.md](./project-rules.md)（本文件） |
| 架构哲学（10 原则） | [architecture_philosophy_rules.md](./architecture_philosophy_rules.md) |
| 后端分层 / 目录 | [backend_layers_rules.md](./backend_layers_rules.md) |
| 通用编码约束 | [coding-convention-rules.md](./coding-convention-rules.md) |
| 心智模型（Bug/逻辑） | [programmer-mindset-rules.md](./programmer-mindset-rules.md) |
| 单一真理源思维模型 | [single-truth-source-mindset.md](./single-truth-source-mindset.md) |
| UI 工程化心智 | [ui-engineering-mindset-rules.md](./ui-engineering-mindset-rules.md) |
| 渐进式重构 | [progressive-refactor-rules.md](./progressive-refactor-rules.md) |
| 安全 / 测试 | [security_rules.md](./security_rules.md) / [testing_rules.md](./testing_rules.md) |
| 精灵宿主 | [sprite-project-rules.md](./sprite-project-rules.md) |
| 跨文档引用 / 新增模块 | [cross-document-reference.md](./cross-document-reference.md) / [new-module-guide.md](./new-module-guide.md) |
| 决策记录（30 ADR） | `decisions/`（详见 [README](../decisions/README.md)；技术栈变更先更新 ADR，§1 硬约束①） |

> 宿主实现文档位于 `hosts/memora-sprite/.trae/rules/`（仅 directory-structure.md）。任务追踪统一在根 `tasks/`（唯一真理源）。
>
> **架构说明书**：集成设计哲学、闭环设计、数据模型、角色包体系、思维模式速查的完整参考文档，位于 [docs/architecture/agent-design-philosophy.md](../../docs/architecture/agent-design-philosophy.md)。
>
> **架构定论**：不中断工作模型最终答案 = 「申请暂停模型」（不中断原则作用于 **loop 任务内**；memora 在大厂已有 loop 能力之上增加显式「申请暂停 / 继续」按钮——暂停 = 申请暂停，等进行中的问答回合结束于 loop 边界挂起，可继续或注入；硬停止 signal.abort 仍是唯一霸道中止）。完整设计推导见 [docs/architecture/agent-design-philosophy.md](../../docs/architecture/agent-design-philosophy.md) §2.3（输入待定与气口接受）。

## 7. AI 行为 DO/DON'T 速查表

> 本节集中列出 AI 在编写/修改 memora 内核代码时的实施级 DO/DON'T 规则。
> §1 硬约束是原则级，本节是实施级补充。sprite 专属规则见 [sprite-project-rules.md](./sprite-project-rules.md)。

### 7.1 代码质量

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 使用 `@ts-ignore` 或 `as any`（零容忍） |
| DON'T | 在生产文件中保留死代码 |
| DO | 提交前通过 pre-commit lint + typecheck + commitlint |
| DO | 参考 [testing_rules.md §3 覆盖率目标](./testing_rules.md) 与 [coding-convention-rules.md §2 异常处理](./coding-convention-rules.md) |

### 7.2 内核独立性（补充 §1.6）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 `src/` 下 import better-sqlite3 / electron / commander 等 native 或宿主专属模块 |
| DON'T | 在 `src/` 下 import 任何 web 框架（Express / HTML / CSS） |
| DON'T | 工具函数绑定特定第三方依赖（如 pino） |

### 7.3 记忆与存储（补充 §1.3/§1.4）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 SQLite 中存储原始工作内容（仅存投影/摘要） |
| DON'T | 混合技能定义与内存存储（技能通过 `skills/` 文件夹管理） |
| DON'T | 直接修改 config schema（配置文件是真理源，§1.5） |
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
| DO | 底层问题优先修复（架构/基础设施层面，避免积重难返） |
| DO | 代码修复独立可回滚（每次修复独立提交） |
| DO | 自动归档根据 `archiveMode` 执行（full / insights-only / manual 三态） |
| DO | LLM 工具调用传递 `tools` 参数，SSE 流正确解析 `tool_calls` delta |

### 7.6 代码组织与治理

| 类型 | 规则 |
| ---- | ---- |
| DO | 新增 IPC 通道前确认是否可通过现有通道组合达成，避免重复注册 |
| DO | IPC 通道总数接近 150 条时启动治理评估（当前约 125 条） |
| DO | 新增模块前先走 [new-module-guide.md](./new-module-guide.md) 评估流程 |
