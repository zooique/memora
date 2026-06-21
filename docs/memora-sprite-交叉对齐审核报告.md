# Memora 内核 × Sprite 宿主 交叉对齐审核报告

> **审核日期**：2026-06-21
> **审核范围**：memora 内核 API（`src/`）× memora-sprite 宿主实现（`hosts/memora-sprite/src/`）
> **审核目的**：交叉对比设计与实现的对齐关系，识别对齐缺口，给出后续 sprite 迭代方向
> **审核原则**：真实、客观，基于代码实际状态而非设计意图

---

## 一、对齐状态总览

### 1.1 总体评价

sprite 宿主在**核心对话链路**（Agent.chat → 流式输出 → IPC → 渲染）上与 memora 内核对齐良好，IPC 通道覆盖了 Agent 的主要能力。但在**内核已提供但 sprite 未接入**的能力上存在显著缺口——这些缺口大多属于"内核已建好基础设施，宿主尚未消费"的状态。

### 1.2 对齐矩阵

| 维度 | 内核提供 | sprite 接入 | 对齐度 |
|------|---------|------------|--------|
| 对话流式 | `agent.chat()` AsyncGenerator | `ipcHandlers.ts` 完整消费 7 种 chunk | ✅ 完全对齐 |
| 会话管理 | `switchSession/restoreSession/loadSessionMessages` | IPC 全覆盖 + 分页扩展 | ✅ 完全对齐 |
| 记忆 CRUD | `agent.storage` + `agent.memory` | `MemoryController` 全覆盖 | ✅ 完全对齐 |
| 角色管理 | `agent.persona` | `PersonaController` 全覆盖 | ✅ 完全对齐 |
| 项目管理 | `agent.switchProject/listProjects` | `sprite.ts` + 设置面板 | ✅ 完全对齐 |
| 事件系统 | 8 种 Agent 事件 | sprite 订阅 3 种 | 🟡 部分对齐 |
| LLM 配置 | `createLlmProvider/createProviderFromConfig` | `index.ts` + 设置面板 | ✅ 完全对齐 |
| 向量搜索 | `VectorStore/EmbeddingProvider` | `index.ts` 可选初始化 | ✅ 完全对齐 |
| 配置建议 | `ConfigManager.onConfigSuggestion` | ❌ 未接入 | 🔴 缺口 |
| 自动精炼 | `AutoConfigRefiner` | ❌ 未接入 | 🔴 缺口 |
| 作品投影 | `WorkProjectionManager` | ❌ 未接入 | 🔴 缺口 |
| 用户画像 | `UserProfile` | ❌ 未接入 | 🔴 缺口 |
| 自定义工具 | `ToolExecutor.registerTool` | ❌ 未接入 | 🔴 缺口 |
| 安全写入确认 | `SecurityGuard.onWriteConfirmation` | ❌ 未接入 | 🟡 部分对齐 |
| 审计日志 | `SecurityGuard.onAudit` | ❌ 未接入 | 🔴 缺口 |
| 可观测性 | `ITracer/ISpan` | ❌ 未注入 | 🔴 缺口 |
| 会话分叉 | `agent.forkSession()` | ❌ 未暴露 | 🟡 低优先级 |
| 记忆快照 | `agent.snapshot()` | ❌ 未使用 | 🟡 低优先级 |
| 关联推荐 | `agent.suggestMemories()` | ❌ 未使用 | 🟡 低优先级 |
| Provider 热切换 | `agent.setProvider()` | ❌ 用 reinitAgent 替代 | 🟡 设计差异 |
| 后台 Provider | `agent.setBackgroundProvider()` | ❌ 未使用 | 🔴 缺口 |
| Insight 关键词 | `InsightExtractor.setKeywords()` | ❌ 未设置 | 🔴 缺口 |
| 写入扩展 | `InsightExtractor.setWriteExtensions()` | ❌ 未设置 | 🟡 低优先级 |
| 系统消息注入 | `AgentLoop.injectSystemMessage()` | ❌ 未使用 | 🟡 低优先级 |

---

## 二、已对齐部分（基线确认）

以下能力 sprite 已正确接入，无需改动：

### 2.1 对话链路
- `agent.chat(text, signal)` → `ipcHandlers.ts` 消费 AsyncGenerator → 7 种 chunk 类型通过 IPC 转发到渲染进程
- `agent.chatSync(input)` → `sprite.ts` wakeup() 用于精灵主动提示
- AbortController 中断 → `CHAT_ABORT` IPC 通道 + `wasUserAborted` 标志区分用户/系统中断

### 2.2 会话管理
- `agent.switchSession()` / `agent.restoreSession()` / `agent.restoreMostRecentSession()` → IPC 全覆盖
- `agent.loadSessionMessages()` → 分页加载（UX-FD-07 扩展）
- `ISessionStore` 接口 → `SqliteSessionStore` 实现 + sprite 自行扩展 `deleteSession/renameSession/countMessages/loadMessagesPaginated/getFirstUserMessage`

### 2.3 记忆管理
- `agent.storage`（IMemoryStorage）→ `SqliteStorage` 实现，`MemoryController` 通过 `agent.storage` 直接 CRUD
- `agent.memory`（MemoryInspector）→ `searchHybrid/search/stats/suggest` 全部接入
- `agent.searchMemories()` / `agent.searchMemoriesHybrid()` → IPC `MEMORIES_SEARCH`

### 2.4 角色管理
- `agent.persona`（PersonaManager）→ `PersonaController` 全覆盖 `activeName/list/switchPersona/setMode/currentMode`
- 角色自动匹配 + 手动切换 → 设置面板 + 角色选择器 UI

### 2.5 存储与 LLM
- `IMemoryStorage` 接口 → `SqliteStorage` 实现（含 `decayScores` 衰减）
- `createLlmProvider/createProviderFromConfig` → `index.ts` 初始化 + 设置面板热配置
- `VectorStore/EmbeddingProvider` → 可选初始化，语义搜索双通道召回

### 2.6 事件系统（部分）
- sprite 订阅了 `memoryAdded` / `personaSwitched` / `insightExtracted` 3 种事件
- 通过 `sprite.ts` 转发到 `ProactiveEngine` 驱动主动提示

---

## 三、对齐缺口分析

### 3.1 高价值缺口（内核已就绪，sprite 接入即可获得能力）

#### 缺口 H1：AutoConfigRefiner + ConfigManager 配置建议（模式 3）

**内核状态**：已实现完整链路
- `ConfigManager.onConfigSuggestion(handler)` — 注册回调
- `ConfigManager.confirmConfigSuggestion(suggestion)` — 确认并写入配置文件
- `AutoConfigRefiner.analyze(userInput, assistantContent)` — LLM 分析对话提取配置建议
- `ConfigSuggestion` 类型：`{ type: 'rule'|'persona'|'skill'; name; content; confidence; source? }`

**sprite 状态**：完全未接入。Agent 构造时未传入 `onConfigSuggestion` 回调，AutoConfigRefiner 的分析结果被丢弃。

**影响**：精灵无法从对话中自动学习规则/角色/技能建议，用户必须手动创建。这与"万物皆是记忆"的设计哲学相悖——对话中产生的配置洞察应该能被自动捕获。

**对齐方向**：
1. `index.ts` 的 `initAgentFromConfig()` 中创建 Agent 时传入 `onConfigSuggestion` 回调
2. 回调通过 IPC 将 `ConfigSuggestion` 推送到渲染进程
3. 渲染进程显示建议卡片（接受/拒绝），接受时调用 `agent.config.confirmConfigSuggestion()`

#### 缺口 H2：UserProfile 用户画像

**内核状态**：已实现完整链路
- `UserProfile.load()` — 加载已确认画像
- `UserProfile.archiveFacts(facts)` — 实时归档（高置信度直接确认，低置信度待确认）
- `UserProfile.confirm(id)` / `reject(id)` — 确认/拒绝待确认条目
- `UserProfile.buildSystemPrompt()` — 构建画像 system prompt 段
- `extractUserFacts(input, turnIndex)` — 从用户输入提取结构化事实

**sprite 状态**：完全未接入。Agent 内部可能已初始化 UserProfile（取决于 Agent.init() 流程），但 sprite 没有暴露任何画像管理 UI。

**影响**：用户画像记忆（source='profile'）无法在 UI 中查看/确认/拒绝，用户无法感知精灵对自己的认知。

**对齐方向**：
1. 新增 IPC 通道 `USER_PROFILE_LIST` / `USER_PROFILE_CONFIRM` / `USER_PROFILE_REJECT`
2. 渲染进程新增"用户画像"面板（可复用记忆面板的设计模式）
3. 设置面板中展示待确认画像条目

#### 缺口 H3：WorkProjectionManager 作品投影

**内核状态**：已实现完整链路
- `WorkProjectionManager.ensureProjection(filePath, content)` — 检查并更新投影
- `WorkProjectionManager.getProjection(filePath)` — 获取投影
- `WorkProjectionManager.loadAll()` — 加载所有投影
- `WorkProjectionEntry`：`{ id; sourcePath; fileHash; summary; structure; keyDecisions; updatedAt }`

**sprite 状态**：完全未接入。

**影响**：精灵无法对用户的工作内容（代码文件、文档等）生成投影摘要，FileWatcherTrigger 只感知文件名变化但不读取内容（ADR-SP-004 设计原则），导致工作上下文无法进入记忆系统。

**对齐方向**：
1. 需要先确定"哪些文件值得投影"的策略（宿主策略，非内核机制）
2. 在 FileWatcherTrigger 触发文件变化时，通过 `agent.tools` 的 `read_file` 工具读取内容，再调用 `agent.insight` 或直接调用 `WorkProjectionManager.ensureProjection()`
3. 渲染进程新增"工作投影"面板查看投影列表

#### 缺口 H4：自定义工具注册（registerTool）

**内核状态**：已实现完整链路
- `ToolExecutor.registerTool(definition, handler)` — 注册领域工具
- `ToolContext { guardPath }` — 安全校验入口
- 内置工具：`read_file/write_file/list_dir/search_memories`

**sprite 状态**：完全未注册任何自定义工具。

**影响**：精灵只有 4 个通用文件工具，无法提供领域特有能力（如代码搜索、项目管理、网页搜索等）。当前 sprite 的 `/web` 命令是 CLI 层直接实现，未通过工具系统注册，LLM 无法调用。

**对齐方向**：
1. 将 `/web` 浏览器搜索注册为 `web_search` 工具，让 LLM 可调用
2. 根据实际需求注册其他领域工具（如 `code_search`、`project_info` 等）
3. 工具定义通过 `agent.tools.registerTool()` 注入

#### 缺口 H5：InsightExtractor 关键词设置

**内核状态**：
- `InsightExtractor.setKeywords(keywords: MemoryKeywords)` — 设置宿主记忆关键词
- `MemoryKeywords { domain: string[]; personal: string[] }` — 用于输入分类（Layer 2）
- `InsightExtractor.classify(input)` — 三层分类：通用规则 → 宿主关键词 → 默认 extract

**sprite 状态**：未设置关键词。InsightExtractor 使用默认分类逻辑，所有输入都走 `extract` 路径。

**影响**：无法区分"领域相关"和"个人相关"的输入，所有对话都尝试提取 insight，可能产生噪音记忆。

**对齐方向**：
1. 在 Agent 初始化后调用 `agent.insight.setKeywords({ domain: [...], personal: [...] })`
2. 关键词可从角色配置（persona keywords）和项目配置中推导

#### 缺口 H6：后台 Provider（setBackgroundProvider）

**内核状态**：
- `Agent.setBackgroundProvider(provider)` — 注入后台 LLM Provider
- `AutoConfigRefiner.setBackgroundProvider()` — 同步更新
- `ChatOptions.channel?: 'chat' | 'background'` — 多 Provider 路由
- ConfigSchema 支持 `llm.background` 配置块

**sprite 状态**：未使用。所有 LLM 调用（对话 + insight 提取 + 配置分析）都走前台 Provider。

**影响**：InsightExtractor 和 AutoConfigRefiner 的后台 LLM 调用会阻塞前台对话，用户体验下降（特别是使用慢速 Provider 时）。

**对齐方向**：
1. 设置面板 LLM 配置中新增"后台 Provider"选项（可选，默认使用前台 Provider）
2. `initAgentFromConfig()` 中如果配置了 background，创建独立 Provider 并调用 `agent.setBackgroundProvider()`

### 3.2 中价值缺口（安全与可观测性）

#### 缺口 M1：SecurityGuard 写入确认 UI

**内核状态**：
- `SecurityGuard.onWriteConfirmation(handler)` — 注入写入确认 UI 回调
- `SecurityGuard.requestWriteConfirmation(targetPath, tool, description)` — 触发确认
- `WriteConfirmationInfo { targetPath; tool; description?; permission; needsConfirm }`

**sprite 状态**：Agent 构造时 `confirmWrites` 默认 false，未注入确认 UI 回调。

**影响**：LLM 通过 `write_file` 工具写入文件时无用户确认环节，存在误写风险。

**对齐方向**：
1. 设置面板新增"写入确认"开关
2. 开启后通过 IPC 将确认请求推送到渲染进程，显示确认对话框
3. 回调通过 `security.onWriteConfirmation()` 注入

#### 缺口 M2：SecurityGuard 审计日志

**内核状态**：
- `SecurityGuard.onAudit(listener)` — 订阅审计事件
- `AuditEvent { type; path; tool?; source?; decision?; reason?; timestamp }`
- `SecurityGuard.getRecentAudits(limit)` — 获取最近审计事件

**sprite 状态**：未订阅审计事件。

**影响**：文件操作无审计记录，安全事件不可追溯。

**对齐方向**：
1. 订阅审计事件并写入日志文件或 SQLite
2. 设置面板新增"审计日志"查看面板

#### 缺口 M3：ITracer 可观测性

**内核状态**：
- `ITracer/ISpan` 接口 + `NOOP_TRACER` 默认实现
- 4 个预定义 Span：`RECALL` / `LLM_CALL` / `TOOL_EXEC` / `RESPONSE`
- `AgentOptions.tracer` 可注入

**sprite 状态**：未注入 Tracer，使用默认 NoopTracer（零开销但也零可观测）。

**影响**：无法追踪对话链路各阶段耗时，性能问题难以定位。

**对齐方向**：
1. 实现简单的 `SpriteTracer` 实现 `ITracer` 接口
2. 将 Span 数据写入日志或发送到可观测性平台
3. 通过 `AgentOptions.tracer` 注入

### 3.3 低价值缺口（功能可用但非核心）

#### 缺口 L1：会话分叉（forkSession）

**内核状态**：`agent.forkSession(targetSession?)` 已实现，返回 `AgentForkResult { newSession; messageCount }`

**sprite 状态**：未暴露。sprite 有会话删除/重命名，但没有分叉功能。

**评估**：分叉功能在桌面精灵场景下使用频率低，可延后。

#### 缺口 L2：记忆快照（snapshot）

**内核状态**：`agent.snapshot()` 返回 3 层记忆快照（工作/Bootstrap/归档）

**sprite 状态**：未使用。sprite 用 `agent.memory.stats()` 获取统计信息，用 `agent.storage.getBySource()` 获取列表。

**评估**：snapshot 主要用于调试，当前 `dashboard()` 已满足展示需求。

#### 缺口 L3：关联推荐（suggestMemories）

**内核状态**：`agent.suggestMemories(query?, options?)` 返回 `SuggestHit[]`，纯计算不调 LLM

**sprite 状态**：`MemoryController` 有 `suggest` 方法但未通过 IPC 暴露到 UI。

**评估**：可在记忆面板中增加"相关记忆推荐"区域，但优先级低。

#### 缺口 L4：Provider 热切换（setProvider）

**内核状态**：`agent.setProvider(provider)` 运行时切换前台 Provider

**sprite 状态**：使用 `reinitAgent()` 完全重建 Agent，而非热切换。

**评估**：当前设计更安全（确保所有组件一致），热切换的收益不大。设计差异，非缺陷。

#### 缺口 L5：Agent 事件未订阅的 5 种

**内核状态**：8 种事件 — `memoryAdded` / `personaSwitched` / `decayCompleted` / `memoryRecalled` / `sessionForked` / `insightExtracted` / `projectSwitched` / `skillMatched`

**sprite 状态**：订阅 3 种（`memoryAdded` / `personaSwitched` / `insightExtracted`），未订阅 5 种。

**评估**：
- `decayCompleted` — 可用于 UI 显示衰减通知，低优先级
- `memoryRecalled` — 可用于 UI 显示"正在回忆 X 条记忆"，已有 `recall` chunk 覆盖
- `sessionForked` — 未使用分叉功能，暂不需要
- `projectSwitched` — 可用于 UI 显示项目切换通知，中优先级
- `skillMatched` — 可用于 UI 显示"匹配到技能 X"，中优先级

---

## 四、设计一致性分析

### 4.1 配置体系一致性

| 层面 | memora 内核 | sprite 宿主 | 一致性 |
|------|-----------|------------|--------|
| 配置文件 | `config.json`（ConfigSchema） | `sprite.json`（SpriteConfig） | ✅ 分离设计，合理 |
| 配置加载 | `loadConfig()` 4 级优先级 | `loadSpriteConfig()` 独立加载 | ✅ 各管各的 |
| 配置版本 | 无版本号 | `configVersion` + 迁移链 | ✅ sprite 自管理 |
| LLM 配置 | ConfigSchema.llm | sprite 不管理，委托内核 | ✅ 对齐 |
| 主题 | 不关心 | `sprite.json` theme 字段 | ✅ 对齐（UX-FD-12 修复） |

**结论**：配置体系设计一致，sprite 管理自己的宿主配置，memora 管理内核配置，职责清晰。

### 4.2 存储体系一致性

| 层面 | memora 内核 | sprite 宿主 | 一致性 |
|------|-----------|------------|--------|
| 记忆存储 | `IMemoryStorage` 接口 | `SqliteStorage` 实现 | ✅ 对齐 |
| 会话存储 | `ISessionStore` 接口 | `SqliteSessionStore` 实现 | ✅ 对齐 |
| 向量存储 | `VectorStore` 类 | 直接使用 | ✅ 对齐 |
| 数据库 | 不持有 | 持有 better-sqlite3 | ✅ 对齐（ADR-002） |

**不一致点**：`ISessionStore` 接口缺少 `deleteSession/renameSession/countMessages/loadMessagesPaginated/getFirstUserMessage` 方法，sprite 在 `SqliteSessionStore` 中自行扩展了这些方法。这些方法是否应该提升到内核接口？

**分析**：
- `deleteSession/renameSession` — 会话管理通用操作，建议提升到 `ISessionStore` 接口
- `countMessages/loadMessagesPaginated` — 分页是 UI 层关注点，可保留在宿主
- `getFirstUserMessage` — 预览功能，UI 层关注点，可保留在宿主

### 4.3 安全模型一致性

| 层面 | memora 内核 | sprite 宿主 | 一致性 |
|------|-----------|------------|--------|
| 权限模式 | `owner/guest` | `owner`（默认） | ✅ 对齐 |
| 路径白名单 | `allowedPaths` | 传入 `allowedPaths` | ✅ 对齐 |
| 写入确认 | `confirmWrites` + 回调 | `false`（未启用） | 🟡 缺口 M1 |
| 审计日志 | `onAudit` 订阅 | 未订阅 | 🔴 缺口 M2 |

### 4.4 事件流一致性

sprite 的事件流设计存在一个值得注意的架构特征：

```
Agent 事件 → sprite.ts 订阅 → ProactiveEngine 累积 → IPC 推送 → 渲染进程
```

这个链路是正确的，但 sprite 只订阅了 3 种事件，导致 `projectSwitched` / `skillMatched` 等事件信息丢失。这些事件对用户感知有价值（如"精灵注意到你切换了项目"）。

### 4.5 IPC 通道与内核 API 对齐

sprite 的 IPC 通道设计（33 个渲染→主 + 15 个主→渲染）覆盖了 Agent 的主要能力，但缺少以下通道：

| 缺失 IPC 通道 | 对应内核 API | 价值 |
|--------------|-------------|------|
| `CONFIG_SUGGESTION`（主→渲染推送） | `ConfigManager.onConfigSuggestion` | 高（缺口 H1） |
| `USER_PROFILE_LIST/CONFIRM/REJECT` | `UserProfile` | 高（缺口 H2） |
| `WORK_PROJECTION_LIST/SHOW` | `WorkProjectionManager` | 中（缺口 H3） |
| `WRITE_CONFIRMATION`（主→渲染推送） | `SecurityGuard.onWriteConfirmation` | 中（缺口 M1） |
| `AUDIT_LOG_LIST` | `SecurityGuard.getRecentAudits` | 低（缺口 M2） |
| `SUGGEST_MEMORIES` | `agent.suggestMemories` | 低（缺口 L3） |

---

## 五、后续 Sprite 迭代方向

### 5.1 迭代优先级原则

1. **内核已就绪 + sprite 接入即可** > **需要内核改动**
2. **用户可感知能力** > **内部基础设施**
3. **与设计哲学一致** > **锦上添花**

### 5.2 推荐迭代路线

#### 阶段 A：智能学习闭环（高价值，内核已就绪）

**目标**：让精灵从对话中自动学习，形成"对话 → 洞察 → 配置建议 → 用户确认 → 持久化"的闭环。

| 任务 | 内核 API | sprite 工作量 | 价值 |
|------|---------|-------------|------|
| 接入 AutoConfigRefiner + ConfigManager | `onConfigSuggestion/confirmConfigSuggestion` | 中（IPC + UI 卡片） | 高 |
| 接入 UserProfile | `UserProfile.load/confirm/reject` | 中（IPC + 画像面板） | 高 |
| 设置 InsightExtractor 关键词 | `setKeywords()` | 小（初始化时调用） | 中 |
| 接入后台 Provider | `setBackgroundProvider()` | 小（设置面板 + 初始化） | 中 |

**内核需求**：无，所有 API 已就绪。

#### 阶段 B：工作上下文感知（中价值，需策略设计）

**目标**：让精灵感知用户的工作内容，生成投影摘要，提供工作相关的记忆召回。

| 任务 | 内核 API | sprite 工作量 | 价值 |
|------|---------|-------------|------|
| 接入 WorkProjectionManager | `ensureProjection/getProjection/loadAll` | 大（需策略设计 + IPC + UI） | 中 |
| 注册领域工具 | `registerTool()` | 中（工具定义 + handler） | 中 |
| 订阅 projectSwitched/skillMatched 事件 | `agent.on()` | 小（事件处理 + UI 通知） | 中 |

**内核需求**：无，但 WorkProjectionManager 的使用策略需要宿主定义（哪些文件值得投影、何时触发投影）。

#### 阶段 C：安全与可观测性（中价值，基础设施）

**目标**：补齐安全确认和可观测性短板。

| 任务 | 内核 API | sprite 工作量 | 价值 |
|------|---------|-------------|------|
| 写入确认 UI | `SecurityGuard.onWriteConfirmation` | 中（IPC + 确认对话框） | 中 |
| 审计日志面板 | `SecurityGuard.onAudit/getRecentAudits` | 中（日志存储 + UI） | 低 |
| 注入 Tracer | `ITracer` | 中（实现 SpriteTracer） | 低 |

**内核需求**：无。

#### 阶段 D：ISessionStore 接口提升（低价值，内核优化）

**目标**：将 sprite 扩展的会话管理方法提升到内核接口，提高接口完整性。

| 任务 | 内核 API | sprite 工作量 | 价值 |
|------|---------|-------------|------|
| `deleteSession` 提升到 `ISessionStore` | 接口扩展 | 小（修改接口 + 实现） | 低 |
| `renameSession` 提升到 `ISessionStore` | 接口扩展 | 小 | 低 |

**内核需求**：需要修改 `ISessionStore` 接口，属于内核迭代。

### 5.3 不建议迭代的方向

| 方向 | 原因 |
|------|------|
| 会话分叉 UI（forkSession） | 桌面精灵场景使用频率极低 |
| Provider 热切换（setProvider） | 当前 reinitAgent 设计更安全，热切换收益不大 |
| 记忆快照 UI（snapshot） | dashboard 已满足展示需求 |
| 设计系统/SVG图标/rem改造（UX-FD-02/03/04） | 纯视觉打磨，非功能缺陷，搁置为未来储备 |

---

## 六、对内核迭代的反向需求

基于 sprite 的实际使用情况，以下内核改进需求由 sprite 实践反推：

### 6.1 ISessionStore 接口扩展（由 sprite 实践反推）

**现状**：sprite 在 `SqliteSessionStore` 中自行扩展了 `deleteSession/renameSession/countMessages/loadMessagesPaginated/getFirstUserMessage` 5 个方法。

**需求**：`deleteSession` 和 `renameSession` 是通用会话管理操作，建议提升到 `ISessionStore` 接口。`countMessages/loadMessagesPaginated/getFirstUserMessage` 是 UI 层关注点，可保留在宿主。

**优先级**：低（当前 sprite 自行扩展已满足需求，不影响功能）。

### 6.2 Agent 事件粒度

**现状**：8 种事件中，sprite 只用了 3 种。`projectSwitched` 和 `skillMatched` 对用户感知有价值但未订阅。

**需求**：无需内核改动。内核事件设计已足够，是 sprite 的接入缺口。

### 6.3 无其他内核改动需求

**结论**：当前 memora 内核的 API 设计已能支撑 sprite 的所有实际需求。剩余缺口全部是 sprite 的接入问题，不需要内核迭代。这验证了"内核提供机制，宿主提供策略"的分层设计是成功的。

---

## 七、总结

### 7.1 对齐状态评价

memora 内核与 sprite 宿主在**架构分层**和**核心链路**上对齐良好。内核的"机制"设计完备，sprite 的"策略"实现覆盖了核心场景。主要缺口集中在**内核已建好但 sprite 未消费**的能力上——这些能力大多属于"锦上添花"而非"必需品"，这也是 sprite 迭代优先选择速修而非功能扩展的原因。

### 7.2 后续迭代核心方向

**阶段 A（智能学习闭环）**是最高价值的迭代方向，因为它直接服务于"万物皆是记忆"的设计哲学——让精灵从对话中自动学习，而非依赖手动配置。且所有 API 已就绪，无需内核改动，投入产出比最高。

### 7.3 内核健康度

memora 内核的 API 设计经 sprite 实践验证是成功的：
- 零 native 依赖原则严格执行
- 接口抽象层次恰当（IMemoryStorage/ISessionStore/LlmProvider/ILogger/ITracer）
- 降级策略完备（所有可选能力有 fallback）
- 事件系统覆盖关键生命周期

**无需为 sprite 的当前需求迭代内核**。未来内核迭代应由 sprite 阶段 A/B/C 的实践反推，避免闭门造车。
