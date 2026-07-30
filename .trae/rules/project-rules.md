---
alwaysApply: false
description: Memora 项目总则、技术栈清单、目录结构
---

# Memora · 项目总则

> **设计哲学**：万物皆是记忆 **核心矛盾**：无状态推理 ←→ 连续演化任务
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
6. **零依赖内核**：memora 是纯逻辑库，不依赖任何第三方包（包括 zod）和 native 模块（包括 better-sqlite3）；所有持久化、CLI、native 能力由宿主项目注入。memora 的 `dependencies` 为空。pino 作为可选 `peerDependencies`（`optional: true`）+ `optionalDependencies` 保留，零配置时宿主开箱即用，宿主也可注入自定义 `ILogger` 覆盖（详见 [ADR-002](../decisions/ADR-002-storage-layer.md) §理由）

## 2. 技术栈清单

| 类别   | 选型                                         | 决策                                                  |
| ------ | -------------------------------------------- | ----------------------------------------------------- |
| 运行时 | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | [ADR-001](../decisions/ADR-001-runtime-stack.md)       |
|        | （精灵宿主要求 Node.js 24 LTS，详见 [ADR-SP-001](../decisions/ADR-SP-001-runtime.md)） | |
| 数据层 | IMemoryStorage 接口（宿主注入持久化实现）    | [ADR-002](../decisions/ADR-002-storage-layer.md)       |
| 记忆关系 | IMemoryRelationStore 侧车接口（宿主注入实现） | [ADR-014](../decisions/ADR-014-memory-relation.md)    |
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
    └── memora-sprite/           # 精灵宿主项目（独立 package）
        ├── .trae/rules/         # 精灵专属规则（仅 directory-structure.md）
        ├── package.json         # 精灵独立 package（name: "memora-sprite"）
        ├── tsconfig.json        # 精灵独立 tsconfig（含 electron 多配置）
        ├── src/                 # 精灵源码（electron + sprite + storage + web）
        ├── assets/              # 精灵静态资源（icon.svg 是真理源，PNG 由脚本生成）
        └── scripts/             # 精灵构建脚本（含 generate-icons.mjs）
```

**关键约束**：

| 规则 | 说明 |
|------|------|
| 独立 package | 两个 package 各自 `npm install`、`npm test`、`npm run build`，互不依赖对方的 devDependencies |
| 统一 .gitignore | 根目录 `.gitignore` 是唯一真理源，不允许子目录存在独立 `.gitignore` |
| 内核零依赖 | memora 内核不依赖任何 native 模块（better-sqlite3、electron 等），所有 native 能力由精灵宿主注入 |
| 精灵依赖内核 | 精灵通过 `sync-memora.mjs` 分发内核：编译内核 `src/` → `dist/`，最小化复制到精灵 `node_modules/memora/`（仅含 dist + 元数据）；源码 import 保持 `from 'memora'`。`file:../..` 已于 2026-07-17 废弃（Junction 会将全量仓库打入 asar，详见 [ADR-SP-005](../decisions/ADR-SP-005-package-management.md)） |
| 规则分层 | 仓库级规则在 `.trae/rules/`，精灵专属规则在 `hosts/memora-sprite/.trae/rules/`，后者仅约束精灵宿主 |
| 任务统一 | 根 `tasks/` 是唯一任务追踪目录（内核 + 精灵共享），`hosts/memora-sprite/tasks/` 已合并归档 |

## 3. 目录结构（不允许修改）

```
src/
├── index.ts        # 库导出入口（类型 + 接口 + 函数 + 类导出，无 CLI）
├── agent/          # Agent 门面 + AgentLoop + 工具执行 + managers/ 子目录（专职 Manager/服务类，完整清单与职责见 backend_layers_rules.md §分层职责）+ 用户事实提取（纯函数）+ 对话快照 + 作品投影 + 关联推荐
├── memory/         # 记忆引擎（IMemoryStorage 接口 + InMemoryStorage 实现 + 召回 + IMemoryRelationStore 侧车接口）
├── persona/        # 角色管理（角色配置，记忆管道最高优先级）
├── skill/          # 技能管理（configDir/skills/ 扫描，记忆管道最高优先级）
├── llm/            # LLM 适配层
├── security/       # 安全策略
├── config/         # 配置加载
├── logging/        # 日志（ILogger 接口 + console fallback）
├── eval/           # 评估框架（EvalScenario 类型 + 工具函数）
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

### 6.1 总则类（alwaysApply: false，按需加载）

| 文件 | 用途 |
|------|------|
| [project-rules.md](./project-rules.md) | 本文件——Memora 项目总则、技术栈、目录结构 |

### 6.2 架构与分层类（按需读取）

| 文件 | 用途 |
|------|------|
| [architecture_philosophy_rules.md](./architecture_philosophy_rules.md) | 架构哲学（专注模式、记忆衰减机制等 10 大原则） |
| [backend_layers_rules.md](./backend_layers_rules.md) | 后端分层规范（src/ 各模块职责边界 + 核心库 vs 宿主项目边界） |
| [coding-convention-rules.md](./coding-convention-rules.md) | 通用编码约束规则（契约校验、异常处理、日志、DAO 分层、稳定性等 9 大约束） |
| [cross-document-reference.md](./cross-document-reference.md) | 跨文档交叉引用规范（"文档.§章节号"格式） |
| [new-module-guide.md](./new-module-guide.md) | 新增模块标准流程（防止随意加模块破坏架构） |

### 6.3 安全与测试类（按需读取）

| 文件 | 用途 |
|------|------|
| [security_rules.md](./security_rules.md) | 安全规范（最小权限、显式允许、审计可追溯） |
| [testing_rules.md](./testing_rules.md) | 测试规范（三层金字塔 + Mock LLM 策略） |

### 6.4 精灵宿主类（按需读取，仅约束 memora-sprite）

| 文件 | 用途 |
|------|------|
| [sprite-project-rules.md](./sprite-project-rules.md) | 精灵宿主项目总则、技术栈、目录结构、与内核关系（含 §9 感知层规范） |

> **宿主实现文档**位于 `hosts/memora-sprite/.trae/rules/`（仅 [directory-structure.md](../../hosts/memora-sprite/.trae/rules/directory-structure.md)，描述 src/ 目录树），跟宿主项目走。任务追踪统一在根 `tasks/`（唯一真理源，精灵历史任务已归档至 `tasks/归档/sprite-*`）。详见 [sprite-project-rules.md §1.1](./sprite-project-rules.md)。

### 6.5 决策记录类（`.trae/decisions/` 目录，按需读取）

> 详见 [decisions/README.md](../decisions/README.md)。共 30 个 ADR：内核 ADR-001~004 + ADR-006~019（18 个，跳过 005）+ 精灵 ADR-SP-001~008 + ADR-SP-015~018（12 个）。技术栈变更必须先更新对应 ADR（§1 硬约束第 1 条）。

### 6.6 心智模型类（按需读取，跨前后端通用）

| 文件 | 用途 |
|------|------|
| [programmer-mindset-rules.md](./programmer-mindset-rules.md) | 资深程序员心智模型（Bug 修复 + 逻辑设计：根因 / 嫁接 / 逻辑先行） |
| [ui-engineering-mindset-rules.md](./ui-engineering-mindset-rules.md) | UI 工程化心智模型（设计令牌 + 组件抽象 + 样式继承，继承自 programmer-mindset-rules.md） |

### 6.7 重构规范类（按需读取，触发式加载）

| 文件 | 用途 |
|------|------|
| [progressive-refactor-rules.md](./progressive-refactor-rules.md) | 渐进式重构规范（领域容器提取 模式 A + 职责拆分 模式 B，触发阈值：字段数 ≥15 / 职责数 ≥5 / 修改成本 ≥10 处无关代码，单轮一个领域 + 炼化归元收尾） |

## 7. AI 行为 DO/DON'T 速查表

> 本节集中列出 AI 在编写/修改 memora 内核代码时的实施级 DO/DON'T 规则。
> §1 硬约束是原则级，本节是实施级补充。sprite 专属规则见 [sprite-project-rules.md](./sprite-project-rules.md)。

### 7.1 代码质量

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 使用 `@ts-ignore` 或 `as any`（零容忍） |
| DON'T | 在生产文件中保留死代码 |
| DON'T | 使用空 catch 块或裸 throw（统一 MemoraError 体系） |
| DO | 核心模块保持 1:1 测试覆盖率（`__tests__/` 镜像 `src/`） |
| DO | 提交前通过 pre-commit lint + typecheck + commitlint |

### 7.2 内核独立性（补充 §1.6）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 `src/` 下 import better-sqlite3 / electron / commander 等 native 模块 |
| DON'T | 在 `src/` 下 import 任何 web 框架（Express / HTML / CSS） |
| DON'T | 工具函数绑定特定环境依赖（如 pino） |

### 7.3 记忆与存储（补充 §1.3/§1.4）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 SQLite 中存储原始工作内容（仅存投影/摘要） |
| DON'T | 混合技能定义与内存存储（技能通过 `skills/` 文件夹管理） |
| DON'T | 直接修改 config schema（配置文件是真理源，§1.5） |
| DON'T | 多 Agent 并发（单 Agent 模型，详见 §1.4） |
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
| DO | 功能开发先进行方案设计，不能直接编写代码 |
| DO | 底层问题优先修复（架构/基础设施层面，避免积重难返） |
| DO | 代码修复独立可回滚（每次修复独立提交） |
| DO | 自动归档根据 `archiveMode` 执行（full / insights-only / manual 三态） |
| DO | LLM 工具调用传递 `tools` 参数，SSE 流正确解析 `tool_calls` delta |
