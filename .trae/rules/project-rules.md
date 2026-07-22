---
alwaysApply: true
description: Memora 项目总则、技术栈清单、目录结构
date: 2026-07-21
---

# Memora · 项目总则

> **设计哲学**：万物皆是记忆 **核心矛盾**：无状态推理 ←→ 连续演化任务
> **基调**：专注模式（应无所住，而生其心）——支持切换，默认专注详见
> [architecture_philosophy_rules.md §9](./architecture_philosophy_rules.md)
> **决策追溯**：`.trae/rules/decisions/` 下 30 个 ADR（内核 18 + 精灵 12）
> **角色定位**：你是一个资深程序员
>
> **当前阶段**：2.1 UI 布局升级（2026-07-21 启动，2026-07-22 收敛）
> **2.1 核心**：信息架构重构——双栏布局（主面板 + 通用侧边栏），感知/仪表盘从"模式切换型面板"升级为"持续可见的侧边栏 tab"，剪贴板保留主面板 nav（主动操作型面板一步可达）
> **2.1 状态**：✅ 已收敛（2026-07-22，通用侧边栏方案全量落地，详见 tasks/归档/）
> **v2 状态**：✅ 已收敛（2026-07-21，五大维度全闭环，详见 tasks/归档/）
> **v1 状态**：✅ 已定版（6037 测试全通过，核心功能跑通）
>
> **规则演进原则**：rules 不绑定版本阶段。v2 收敛后 §7.6 v2 质量打磨原则已移除（阶段约束不再适用），通用规则（§7.1-7.5 + §7.6 资深程序员行为模式）保留并继续生长。

## 1. 不可违反的硬约束

1. **ADR 优先于个人偏好**：技术栈变更必须先更新 ADR（`.trae/rules/decisions/`）
2. **跨文档引用规范**：详见
   [cross-document-reference.md](./cross-document-reference.md)——使用"文档.§章节号"格式
3. **记忆统一模型**：不引入"规则/技能/历史"等独立子系统；统一用
   `source` 开放字符串区分（详见 [ADR-004](./decisions/ADR-004-memory-unification.md)）
4. **单 Agent 模型 + 三层架构**：Agent 级配置（configDir）→ 用户记忆（dataDir）→ 项目级配置（projectPath/.memora/）；memora.db 是 Agent 级共享资源，不随子项目切换重建
5. **配置文件是真理源**：configDir
   下的配置文件由 MemoryLoader 启动时扫描加载到 SQLite；SQLite 是运行时索引，不是持久化配置存储
6. **零依赖内核**：memora 是纯逻辑库，不依赖任何第三方包（包括 zod）和 native 模块（包括 better-sqlite3）；所有持久化、CLI、native 能力由宿主项目注入。memora 的 `dependencies` 为空。pino 作为可选 `peerDependencies`（`optional: true`）+ `optionalDependencies` 保留，零配置时宿主开箱即用，宿主也可注入自定义 `ILogger` 覆盖（详见 [ADR-002](./decisions/ADR-002-storage-layer.md) §理由）

## 2. 技术栈清单

| 类别   | 选型                                         | 决策                                                  |
| ------ | -------------------------------------------- | ----------------------------------------------------- |
| 运行时 | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | [ADR-001](./decisions/ADR-001-runtime-stack.md)       |
|        | （精灵宿主要求 Node.js 24 LTS，详见 [ADR-SP-001](./decisions/ADR-SP-001-runtime.md)） | |
| 数据层 | IMemoryStorage 接口（宿主注入持久化实现）    | [ADR-002](./decisions/ADR-002-storage-layer.md)       |
| 记忆关系 | IMemoryRelationStore 侧车接口（宿主注入实现） | [ADR-014](./decisions/ADR-014-memory-relation.md)    |
| 归档模式 | archiveMode 三态控制（full / insights-only / manual） | [ADR-015](./decisions/ADR-015-archive-mode.md)    |
| LLM    | OpenAI Chat Completions 兼容协议             | [ADR-003](./decisions/ADR-003-llm-adapter.md)         |
| 形态   | 纯逻辑库（CLI 由宿主提供）                   | [ADR-002 v0.8](./decisions/ADR-002-storage-layer.md)  |
| 安全   | 两级权限 + 路径白名单                        | [ADR-006](./decisions/ADR-006-security-model.md)      |
| 测试   | Vitest + MSW Mock LLM + InMemoryStorage      | [ADR-007](./decisions/ADR-007-testing-strategy.md)    |
| 目录   | 按职责分层                                   | [ADR-008](./decisions/ADR-008-directory-structure.md) |

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
| 精灵依赖内核 | 精灵通过 `"memora": "file:../.."` 引用内核（本地 file: 协议，指向仓库根；Junction 模式无需发布 npm） |
| 规则分层 | 仓库级规则在 `.trae/rules/`，精灵专属规则在 `hosts/memora-sprite/.trae/rules/`，后者仅约束精灵宿主 |
| 任务统一 | 根 `tasks/` 是唯一任务追踪目录（内核 + 精灵共享），`hosts/memora-sprite/tasks/` 已合并归档 |

## 3. 目录结构（不允许修改）

```
src/
├── index.ts        # 库导出入口（类型 + 接口 + 函数 + 类导出，无 CLI）
├── agent/          # Agent 门面 + AgentLoop + 工具执行 + managers/ 子目录（13 个专职 Manager/服务类：ArchiveCoordinator/AutoConfigRefiner/ChatLock/Config/Insight/MemoryAdvisor/MemoryDecay/MemoryInspector/RelationBuilder/Session/SessionArchiver/TextPolish/WorkProjection）+ 用户事实提取（纯函数）+ 对话快照 + 作品投影 + 关联推荐
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
docs: 更新 01-主架构-v4.0.md v3.6
test: 补充 Agent Loop E2E
refactor: 重构 LLM Provider 抽象
chore: 升级 dependencies
```

格式：`<type>(<scope>): <subject>`

## 6. 规则文件索引

> 本节列出 `.trae/rules/` 下所有规则文件，方便按需加载。`alwaysApply: true` 的文件随会话自动加载，其余文件需 AI 主动读取。

### 6.1 总则类（alwaysApply: true，自动加载）

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

### 6.5 决策记录类（decisions/ 目录，按需读取）

> 详见 [decisions/README.md](./decisions/README.md)。共 30 个 ADR：内核 ADR-001~004 + ADR-006~019（18 个，跳过 005）+ 精灵 ADR-SP-001~008 + ADR-SP-015~018（12 个）。技术栈变更必须先更新对应 ADR（§1 硬约束第 1 条）。

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
| DO | memora `dependencies` 为空（零依赖内核） |

### 7.3 记忆与存储（补充 §1.3/§1.4）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 SQLite 中存储原始工作内容（仅存投影/摘要） |
| DON'T | 混合技能定义与内存存储（技能通过 `skills/` 文件夹管理） |
| DON'T | 直接修改 config schema（配置文件是真理源，§1.5） |
| DON'T | 多 Agent 并发（单 Agent 模型，`memora.db` 跨项目共享） |
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

### 7.6 资深程序员行为模式：Bug 修复心智模型

> 提炼自项目实战中反复出现的修复模式与反模式（原 §7.6.6，v2 收敛后提升为独立章节）。
> 每次修复前先自问：**我是在消除根因，还是在症状上叠加防御代码？**

#### 诊断阶段

| 类型 | 心智规则 |
| ---- | ---- |
| **DO** | **区分症状与根因**——现象是果，不是因。修复现象是止痛药，修复根因才是手术。永远多问一层：是什么导致了这种现象？ |
| **DO** | **识别不可逆损失点**——某些损坏是不可逆的（信息永久丢失、状态不可恢复）。不要在已损坏的数据上做恢复逻辑，要找到产生损坏的上游环节并切断它 |
| **DO** | **怀疑前提**——当一个机制或依赖反复出问题、需要反复修补时，停下来问：这个机制本身是不是错误的选择？修补能解决这一次，但前提错了，问题会无限回归 |

#### 方案选择阶段

| 类型 | 心智规则 |
| ---- | ---- |
| **DO** | **向源头追溯**——每问一次"能否去掉中间一层"，方案就往根因逼近一步。终极方案的特征是：调用链路最短、参与方最少、无一环多余 |
| **DO** | **绕过而非修补**——当一个外部依赖有不可修复的缺陷时，不要在其输出上叠加检测和 fallback。提取依赖中仍可靠的原始数据，自己完成剩余的步骤。叠加防御是补丁思维，绕过依赖是架构思维 |
| **DO** | **方案复杂度应与问题本质匹配**——如果解决一个问题需要引入比问题本身更复杂的机制，停下来。你很可能在用一个复杂方案绕过另一个复杂方案，而非真正简化 |
| **DON'T** | **不要在不可靠机制上修 bug**——如果某个机制本身不可靠（依赖偶然状态、涉及竞态、跨越不稳定边界），不要试图让它更可靠。替换它 |

#### 执行阶段

| 类型 | 心智规则 |
| ---- | ---- |
| **DO** | **每次只修一个根因**——一次提交修复一个独立问题。叠加修复优于大包大揽：前者每一步可验证、可回滚，后者失败时无法定位 |
| **DO** | **每多一层抽象就多一个故障点**——跨越层级的转换（进程边界、编码转换、序列化/反序列化）天然不稳定。设计时优先消除层级跨越，而非在各层间加校验 |
