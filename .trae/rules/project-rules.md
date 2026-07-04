---
alwaysApply: true
description: Memora 项目总则、技术栈清单、目录结构
version: v0.8
date: 2026-07-04
---

# Memora · 项目总则

> **设计哲学**：万物皆是记忆 **核心矛盾**：无状态推理 ←→ 连续演化任务
> **基调**：专注模式（应无所住，而生其心）——支持切换，默认专注详见
> [architecture_philosophy_rules.md §9](./architecture_philosophy_rules.md)
> **决策追溯**：`.trae/rules/decisions/` 下 24 个 ADR（内核 15 + 精灵 9）

## 1. 不可违反的硬约束

1. **ADR 优先于个人偏好**：技术栈变更必须先更新 ADR（`.trae/rules/decisions/`）
2. **跨文档引用规范**：详见
   [cross-document-reference.md](./cross-document-reference.md)——使用"文档.§章节号"格式
3. **记忆统一模型**：不引入"规则/技能/历史"等独立子系统；统一用
   `source` 开放字符串区分（详见 [ADR-004](./decisions/ADR-004-memory-unification.md)）
4. **单 Agent 模型 + 三层架构**：Agent 级配置（configDir）→ 用户记忆（dataDir）→ 项目级配置（projectPath/.memora/）；memora.db 是 Agent 级共享资源，不随子项目切换重建
5. **配置文件是真理源**：configDir
   下的配置文件由 MemoryLoader 启动时扫描加载到 SQLite；SQLite 是运行时索引，不是持久化配置存储
6. **零依赖内核**：memora 是纯逻辑库，不依赖任何 native 模块（包括 better-sqlite3）；所有持久化、CLI、native 能力由宿主项目注入。memora 的 `dependencies` 仅允许纯 JS 工具库

## 2. 技术栈清单

| 类别   | 选型                                         | 决策                                                  |
| ------ | -------------------------------------------- | ----------------------------------------------------- |
| 运行时 | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | [ADR-001](./decisions/ADR-001-runtime-stack.md)       |
|        | （精灵宿主要求 Node.js 24 LTS，详见 [ADR-SP-001](./decisions/ADR-SP-001-runtime.md)） | |
| 数据层 | IMemoryStorage 接口（宿主注入持久化实现）    | [ADR-002](./decisions/ADR-002-storage-layer.md)       |
| 记忆关系 | IMemoryRelationStore 侧车接口（宿主注入实现） | [ADR-014](./decisions/ADR-014-memory-relation.md)    |
| 归档模式 | archiveMode 三态控制（full / insights-only / manual） | [ADR-015](./decisions/ADR-015-archive-mode.md)    |
| LLM    | OpenAI Chat Completions 兼容协议             | [ADR-003](./decisions/ADR-003-llm-adapter.md)         |
| 形态   | 纯逻辑库（CLI 由宿主提供）                   | [ADR-002 v0.7](./decisions/ADR-002-storage-layer.md)  |
| 安全   | 两级权限 + 路径白名单                        | [ADR-006](./decisions/ADR-006-security-model.md)      |
| 测试   | Vitest + MSW Mock LLM + InMemoryStorage      | [ADR-007](./decisions/ADR-007-testing-strategy.md)    |
| 目录   | 按职责分层                                   | [ADR-008](./decisions/ADR-008-directory-structure.md) |

## 3. 目录结构（不允许修改）

```
src/
├── index.ts        # 库导出入口（类型 + 接口 + 函数 + 类导出，无 CLI）
├── agent/          # Agent 门面 + AgentLoop + 工具执行 + managers/ 子目录（8 个专职 Manager）+ 对话快照 + 作品投影 + 关联推荐
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

## 6. 阶段一交付物

- ✅ 项目骨架可编译、可运行
- ✅ 基元驱动记忆模型（source 开放字符串，7 核心字段）
- ✅ IMemoryStorage 接口 + InMemoryStorage 实现（测试用）
- ✅ 路径白名单 6 个测试用例通过
- ✅ LLM Provider Mock 集成测试通过
- ✅ Agent 设定减法（3 模块：设定 + 角色 + 技能）
- ✅ 单 Agent 模型（memora.db Agent 级共享）
- ✅ 三层架构（Agent 级配置 → 用户记忆 → 项目级配置）
- ✅ 角色自动匹配 + 手动切换
- ✅ 项目 rules/skills 接口（config.addRule + tools.registerTool）
- ✅ 三种接入模式（程序员预设 + 用户自定义 --user + Agent 智能总结接口）
- ✅ 多 Provider 管理（providers 映射表 + 运行时切换）
- ✅ 零 native 依赖内核（better-sqlite3 + CLI 移出至宿主项目）
- ✅ 测试 992 全量通过（InMemoryStorage，零 IO）
- ✅ 事件系统（TypedEventEmitter，Agent 暴露 on/off，9 事件类型：memoryAdded / personaSwitched / decayCompleted / memoryRecalled / sessionForked / insightExtracted / conflictDetected / projectSwitched / skillMatched）
- ✅ 语义搜索召回（VectorStore + EmbeddingService 接口注入，recall 双通道）
- ✅ 记忆生命周期（decayScores，init 首次 + 每小时定时衰减）
- ✅ LLM 调用韧性（AgentLoop 指数退避重试，流式输出前可重试）
- ✅ chat() 并发锁超时保护（5 分钟自动释放）
- ✅ 可观测性（ITracer/ISpan 接口 + NoopTracer 默认实现 + 4 个关键 Span 埋点）
- ✅ 结构化输出（ChatOptions.response_format + LlmProvider.supportsStructuredOutput 能力声明）
- ✅ 内容护栏（source:guardrail 记忆 + 输入/输出护栏 + 降级优先）
- ✅ 工具错误反思（ToolErrorCode 10 种错误码 + isRetryableErrorCode + Reflection 循环）
- ✅ 评估框架（EvalScenario 类型 + collectAgentChunks/evaluateResult 工具函数）
- ✅ 精灵主动行为（事件累积 + 上下文感知提示生成 + 冷却保护 + 静默模式）
- ✅ 精灵配置持久化（SpriteConfig + sprite.json + 启动时加载 + 偏好变更自动保存）

## 7. 阶段二规划（v0.3 → v1.0）

| Phase | 目标 | 关键交付物 | 状态 |
|-------|------|-----------|------|
| Phase 1 | 记忆从"列表"进化为"网络" | MemoryRelation 侧车 + IMemoryRelationStore + 冲突检测 + 可观测性 + 拓扑可视化 | ✅ 核心完成（拓扑可视化延后） |
| Phase 2 | 从"工具"到"伙伴" | AffectController + 默契度 + 里程碑（纯宿主层，零内核修改） | ✅ 核心完成（AffectController + RapportController + ContextAwareness + PatternDetector 全链路实现） |
| Phase 3 | 桌面壁垒 | 剪贴板三重保护 + presenceController + 全局快捷键 | ✅ 核心完成（全局快捷键 + 在场状态检测 + 剪贴板三重保护，两项延后） |
| Phase 4 | 生态准备 | 接入文档 + 存储独立包 + 技能拖入安装 | 🚧 进行中（接入文档 v3.2 已更新） |

## 8. 规则文件索引

> 本节列出 `.trae/rules/` 下所有规则文件，方便按需加载。`alwaysApply: true` 的文件随会话自动加载，其余文件需 AI 主动读取。

### 8.1 总则类（alwaysApply: true，自动加载）

| 文件 | 用途 |
|------|------|
| [project-rules.md](./project-rules.md) | 本文件——Memora 项目总则、技术栈、目录结构 |

### 8.2 架构与分层类（按需读取）

| 文件 | 用途 |
|------|------|
| [architecture_philosophy_rules.md](./architecture_philosophy_rules.md) | 架构哲学（专注模式、记忆衰减机制等 9 大原则） |
| [backend_layers_rules.md](./backend_layers_rules.md) | 后端分层规范（src/ 各模块职责边界 + 核心库 vs 宿主项目边界） |
| [cross-document-reference.md](./cross-document-reference.md) | 跨文档交叉引用规范（"文档.§章节号"格式） |
| [new-module-guide.md](./new-module-guide.md) | 新增模块标准流程（防止随意加模块破坏架构） |

### 8.3 安全与测试类（按需读取）

| 文件 | 用途 |
|------|------|
| [security_rules.md](./security_rules.md) | 安全规范（最小权限、显式允许、审计可追溯） |
| [testing_rules.md](./testing_rules.md) | 测试规范（三层金字塔 + Mock LLM 策略） |

### 8.4 精灵宿主类（按需读取，仅约束 memora-sprite）

| 文件 | 用途 |
|------|------|
| [sprite-project-rules.md](./sprite-project-rules.md) | 精灵宿主项目总则、技术栈、目录结构、与内核关系 |
| [sprite-感知层规范.md](./sprite-感知层规范.md) | 精灵感知层规范（上下文感知而非内容感知，唤醒触发器设计约束） |

### 8.5 决策记录类（decisions/ 目录，按需读取）

> 详见 [decisions/README.md](./decisions/README.md)。共 24 个 ADR：内核 ADR-001~015 + 精灵 ADR-SP-001~008 + ADR-SP-015。技术栈变更必须先更新对应 ADR（§1 硬约束第 1 条）。

## 9. AI 行为 DO/DON'T 速查表

> 本节集中列出 AI 在编写/修改 memora 内核代码时的实施级 DO/DON'T 规则。
> §1 硬约束是原则级，本节是实施级补充。sprite 专属规则见 [sprite-project-rules.md](./sprite-project-rules.md)。

### 9.1 代码质量

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 使用 `@ts-ignore` 或 `as any`（零容忍） |
| DON'T | 在生产文件中保留死代码 |
| DON'T | 使用空 catch 块或裸 throw（统一 MemoraError 体系） |
| DO | 核心模块保持 1:1 测试覆盖率（`__tests__/` 镜像 `src/`） |
| DO | 提交前通过 pre-commit lint + typecheck + commitlint |

### 9.2 内核独立性（补充 §1.6）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 `src/` 下 import better-sqlite3 / electron / commander 等 native 模块 |
| DON'T | 在 `src/` 下 import 任何 web 框架（Express / HTML / CSS） |
| DON'T | 工具函数绑定特定环境依赖（如 pino） |
| DO | memora `dependencies` 仅允许纯 JS 工具库（当前仅 zod） |

### 9.3 记忆与存储（补充 §1.3/§1.4）

| 类型 | 规则 |
| ---- | ---- |
| DON'T | 在 SQLite 中存储原始工作内容（仅存投影/摘要） |
| DON'T | 混合技能定义与内存存储（技能通过 `skills/` 文件夹管理） |
| DON'T | 直接修改 config schema（配置文件是真理源，§1.5） |
| DON'T | 多 Agent 并发（单 Agent 模型，`memora.db` 跨项目共享） |
| DO | 工作内容通过宿主工具访问，内核仅保留投影 |
| DO | 切换项目用 `close()`，完全终止用 `shutdown()` |

### 9.4 Agent 门面约束

| 类型 | 规则 |
| ---- | ---- |
| DON'T | Agent 管理 LLM API keys 或 provider 配置（宿主负责） |
| DON'T | Agent 含 CLI/REPL 逻辑（CLI 由宿主提供） |
| DON'T | Agent 直接输出到终端（UI 由宿主处理） |
| DON'T | Agent 直接修改用户配置文件（通过宿主回调中介） |
| DO | LlmProvider 通过构造函数注入（`provider` 必填，`backgroundProvider` 可选） |
| DO | 工具注册通过 `registerTool()` 机制 |

### 9.5 功能开发流程

| 类型 | 规则 |
| ---- | ---- |
| DO | 功能开发先进行方案设计，不能直接编写代码 |
| DO | 底层问题优先修复（架构/基础设施层面，避免积重难返） |
| DO | 代码修复独立可回滚（每次修复独立提交） |
| DO | 自动归档根据 `archiveMode` 执行（full / insights-only / manual 三态） |
| DO | LLM 工具调用传递 `tools` 参数，SSE 流正确解析 `tool_calls` delta |
