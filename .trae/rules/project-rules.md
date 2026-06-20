---
alwaysApply: true
description: Memora 项目总则、技术栈清单、目录结构
version: v0.5
date: 2026-06-12
---

# Memora · 项目总则

> **设计哲学**：万物皆是记忆 **核心矛盾**：无状态推理 ←→ 连续演化任务
> **基调**：专注模式（应无所住，而生其心）——支持切换，默认专注详见
> [architecture_philosophy_rules.md §9](./architecture_philosophy_rules.md)
> **决策追溯**：`.trae/rules/decisions/` 下 13 个 ADR

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
| 数据层 | IMemoryStorage 接口（宿主注入持久化实现）    | [ADR-002](./decisions/ADR-002-storage-layer.md)       |
| LLM    | OpenAI Chat Completions 兼容协议             | [ADR-003](./decisions/ADR-003-llm-adapter.md)         |
| 形态   | 纯逻辑库（CLI 由宿主提供）                   | [ADR-002 v0.7](./decisions/ADR-002-storage-layer.md)  |
| 安全   | 两级权限 + 路径白名单                        | [ADR-006](./decisions/ADR-006-security-model.md)      |
| 测试   | Vitest + MSW Mock LLM + InMemoryStorage      | [ADR-007](./decisions/ADR-007-testing-strategy.md)    |
| 目录   | 按职责分层                                   | [ADR-008](./decisions/ADR-008-directory-structure.md) |

## 3. 目录结构（不允许修改）

```
src/
├── index.ts        # 库导出入口（纯类型 + 接口导出，无 CLI）
├── agent/          # Agent 门面 + AgentLoop + 工具执行 + managers/ 子目录（7 个专职 Manager）+ 对话快照 + 作品投影 + 关联推荐
├── memory/         # 记忆引擎（IMemoryStorage 接口 + InMemoryStorage 实现 + 召回）
├── persona/        # 角色管理（角色配置，记忆管道最高优先级）
├── skill/          # 技能管理（configDir/skills/ 扫描，记忆管道最高优先级）
├── llm/            # LLM 适配层
├── security/       # 安全策略
├── config/         # 配置加载
├── logging/        # 日志（ILogger 接口 + console fallback）
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
- ✅ 测试 445 全量通过（InMemoryStorage，零 IO）
- ✅ 事件系统（TypedEventEmitter，Agent 暴露 on/off，6 事件类型：memoryAdded / personaSwitched / decayCompleted / memoryRecalled / sessionForked / insightExtracted）
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
