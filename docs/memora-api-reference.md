# Memora 内核 API 参考手册（v3.0.0）

> **核心定位**：Memora 是一个**无法独立运行**的智能大脑内核——它只有接口，没有"形态"。CLI、WebUI、桌面精灵、小说生成器都是它的"宿主"，宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。
>
> **本文件用途**：列出内核对外暴露的**全部公开接口**——从最基础的接入接口（〇），到 Agent 面类、对话、记忆、角色包、工具、各 Manager，再到类型导出与安全约束。
>
> **版本**：v3.0.0（对齐当前稳定版，纯净接口文档，不含历史变更流水）

---

## 〇、接入基础接口

> **定位**：一个新宿主接入 memora 的**最小接入面**。其余各章是 `Agent` 初始化后暴露的运行时能力；本章回答"接入前必须提供什么"。
>
> **一句话总结**：必做三件事——① 实现 `IMemoryStorage` + `ISessionStore` + `LlmProvider`；② 准备 `configDir`（含 `config.json` 模型表 + `role-packs/` + `skills/`）；③ 传 `projectPath` / `dataDir` / `configDir` 构造 `Agent`。其余接口按需注入，缺省都有降级兜底。

### 〇.1 宿主实现的接口（注入）

| 接口 | 必选 | 声明位置 | 用途 |
|------|------|---------|------|
| `LlmProvider` | ✅ 必选 | `src/llm/provider.ts` | 前台 LLM 流式对话（`stream()`），宿主创建 |
| `IMemoryStorage` | ✅ 必选* | `src/memory/storageInterface.ts` | 记忆持久化，15 方法，同步语义（对齐 better-sqlite3）；**后端由宿主自选** |
| `ISessionStore` | ✅ 必选* | `src/memory/sessionStore.ts` | 会话消息持久化，3 必需 + 6 可选方法 |
| `ITracer` | 可选 | `src/agent/tracer.ts` | 可观测性，不传用 `NoopTracer` |
| `IWebSearchProvider` | 可选 | `src/web-search/types.ts` | 网络搜索，不注入则不启用 |
| `IFetchProvider` | 可选 | `src/web-fetch/types.ts` | 网页抓取（搜索→抓取闭环第二段），不注入则不启用 |
| `ICodeExecutionProvider` | 可选 | `src/code-exec/types.ts` | 通用代码执行（沙箱由宿主提供），不注入则不启用 |
| `IProjectSearchProvider` | 可选 | `src/project-search/types.ts` | 项目内搜索（等价 IDE 全局搜索），不注入则不暴露 `search_project`（见 §8.6） |
| `ILogger` | 可选 | `src/logging/loggerInterface.ts` | 日志，默认内置 |
| `backgroundProvider` (`LlmProvider`) | 可选 | AgentOptions | 后台通道（归档/投影），不配复用前台 |

\* 不传则内核自动用 `InMemoryStorage` / 内存会话（仅内存不落盘）；做产品必须实现。

### 〇.2 宿主提供的配置资源（`configDir` 下）

`configDir` 是唯一的配置目录入口（含角色包 / 全局技能 / 配置文件）：

```
configDir/
├── config.json              ← ★ LLM 配置真理源：providers + active + background + taskRouter
├── role-packs/              ← 角色包目录（每个包一个文件夹，含 manifest.json）
│   └── 工程师/
│       ├── manifest.json    ← 必填：元数据 + strategy + capabilities
│       ├── persona.md       ← 约定名，可省（身份设定）
│       ├── rules.md         ← 约定名，可省（安全契约）
│       └── skills/          ← 角色包内嵌技能（目录动态扫描，可选）
│           └── ...          ← 形式与全局技能池一致（见下）
├── skills/                  ← 全局技能池（所有角色共享，可选）
│   ├── search.md            ← 单文件形式
│   └── code-review/         ← 文件夹形式（统一大众公认的 Agent Skills 格式）
│       ├── SKILL.md         ← 技能正文（frontmatter 声明 name/description）
│       ├── resources/       ← L3 参考资源（参考材料/规范）
│       ├── scripts/         ← L3 可执行脚本（运行时按需执行）
│       ├── references/      ← 技能内参考资料
│       └── assets/          ← 技能内资源（模板/图片/示例）
```

> **skills 两种形式（两级技能共用统一格式）**：全局技能池（`configDir/skills/`）与角色包内嵌技能（`role-packs/<名>/skills/`）采用**同一套**技能格式，仅激活条件不同（全局始终激活，角色包技能随角色激活）。每个技能为单文件 `*.md` **或** 文件夹 `SKILL.md` 两种形式之一；`references/` / `assets/` 属于**技能内部**的资源目录（文件夹形式的组成部分），非 configDir 或角色包顶层目录。渐进披露：L1 元数据常驻 / L2 `read_skill` 按需读正文 / L3 `read_resource` + `run_skill_script`。
```

**config.json 大模型列表**（不是独立目录，是配置文件中的映射表）：

```jsonc
{
  "llm": {
    "providers": { "deepseek": { "baseUrl": "...", "model": "...", "apiKey": "" },
                   "openai":   { "baseUrl": "...", "model": "...", "apiKey": "" } },
    "active": "deepseek",        // 激活别名，不配取第一个 key
    "background": { ... },       // 可选后台通道，节省成本
    "taskRouter": { "simple": "deepseek", "reasoning": "openai" }
  }
}
```

- API Key **不写文件**，从环境变量读取。
- memora 内核仅内置 `mock` Provider（无 API Key 的测试/降级），其余厂商需宿主在 config.json 显式配置。

### 〇.3 `dataDir` vs `storage` 的区别

两个易混淆的参数：**`storage` 管"如何存取"（接口实例），`dataDir` 管"存到哪个目录"（路径字符串）**。

| | `storage`（IMemoryStorage） | `dataDir` |
|---|---|---|
| 本质 | 接口实例（宿主写的类） | 文件系统目录路径（字符串） |
| 内核怎么用它 | 调方法：`upsert` / `getById` / `search` / `getAllSources`… | 用它定位项目注册表（`projects.json`）；记忆库落哪、叫什么名，由宿主自定，内核不参与 |
| 管什么 | "怎么存取记忆"（逻辑），内核不关心内部是 SQLite 还是内存 | "记忆库与项目注册表放哪个目录"（物理位置） |
| 谁实现 | 宿主实现（如 SqliteMemoryStorage） | 宿主传路径 |
| 关系 | `dataDir` 指向目录；宿主按自己的持久化形态构造 storage（JSON 文件 / SQLite 皆可） | 内核用 `dataDir` 推导注册表路径；**项目锁文件不由 `dataDir` 推导**，它固定落 `<projectPath>/.memora/.lock` |
| 缺省 | 不传 → `InMemoryStorage`（仅内存） | **必填，无默认值**（目录位置与层级语义是宿主的产品决策，内核不假设） |

一句话：`storage` 是宿主**怎么**存取的实现，`dataDir` 是存取内容**落在哪个目录**的配置——一个管"如何"，一个管"何处"。

> **`config.json` 里的 `memory.dataDir` 内核不读**：它只是「宿主约定的载体」——宿主可自行从配置取出后传给
> `new Agent({ dataDir })`。内核不消费它，也没有任何默认值；`config.example.json` 里写 `~/.memora` 只是一个示例值，
> 不等于内核的缺省行为。

### 〇.4 多来源双路径编排（内置 + 用户）

内核**刻意保持"单 `configDir` 输入"**——`SkillManager`/`RolePackManager` 只扫 `<configDir>/skills/`、`<configDir>/role-packs/`，无"多来源"概念。宿主若想开放"内置（随插件打包）+ 用户自定义"双路径，由宿主在传入内核**之前**自行编排归一，两种形态：

| 形态 | 做法 | 适用 |
|------|------|------|
| **A. 宿主文件层汇总（推荐，零内核改动）** | 宿主在文件系统层把"内置目录 + 用户目录"合并/软链到**一个 `configDir`** 再传内核 | 角色包、全局技能均可；内容本质同构、希望同池匹配 |
| **B. 宿主多 Manager 实例聚合** | 宿主建多个 `RolePackManager(configDirA/B)` 各管一个来源，聚合 `listMeta()` 在 UI 层分组展示，激活仍逐个调用 | 来源语义需要区分（UI 分组、只读标记） |

选择依据：内容**不必区分来源**走 A（合并到同一 configDir）；**必须区分来源**（只读/可编辑、分组）走 B（多实例聚合展示）。内核两种都支持。

### 〇.5 构造 `Agent` 的参数

```ts
new Agent({
  projectPath,            // ✅ 必选：工作区
  provider,               // ✅ 必选：前台 LLM
  // 常用可选项
  configDir,              // 配置根目录（role-packs / skills；缺省用内置默认）
  dataDir,                // ✅ 必选：记忆数据落地目录（内核不提供默认值）
  backgroundProvider,     // 后台 LLM
  storage,                // IMemoryStorage 实现（缺省 InMemoryStorage）
  sessionStore,           // ISessionStore 实现（缺省仅内存保存）
  webSearchProvider,      // 网络搜索
  tracer,                 // 可观测
  maxContextTokens,       // 默认 120000
  permission, allowedPaths, confirmWrites,   // 安全
  activeRolePack,         // 启动激活的角色包
})
```

---

## 一、设计哲学

```
┌────────────────────────────────────────────────────────────┐
│  宿主程序（CLI / 桌面精灵 / 小说生成器 / WebUI）           │
│  ┌─────────────────┐    ┌──────────────────┐               │
│  │ LLM Provider 实例 │◄───│ API Key / baseUrl │  ← 宿主职责  │
│  └────────┬────────┘    └──────────────────┘               │
│           │ 注入                                            │
│           ▼                                                 │
│  ┌──────────────────────────────────────────┐               │
│  │  Memora 内核（Agent）                    │               │
│  │  ┌──────────────────────────────────────┐│               │
│  │  │  Agent 面类（编排层）                 ││               │
│  │  │  - init/close · chat · switchProject ││               │
│  │  │  - .rolePack / .tools / .skills      ││               │
│  │  │  - .governance / .memory             ││               │
│  │  └──────────┬───────────────────────────┘│               │
│  │             │ 委托                         │               │
│  │  ┌──────────┼───────────────────────────┐│               │
│  │  │ RolePackManager / SkillManager       ││               │
│  │  │ ToolExecutor / MemoryInspector       ││               │
│  │  │ MemoryGovernance                     ││               │
│  │  └──────────────────────────────────────┘│               │
│  │  ⚠️ 不包含：UI / LLM 配置 / 用户配置模板 │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

**设计原则**：
- **零运行时依赖**（核心层零 npm 运行时依赖、**零运行时模块解析**；日志默认内置 console fallback，宿主经 `setLogger()` 注入自定义实现；持久化由宿主通过 `IMemoryStorage` 接口注入）
- **内核模块不直接调用 `console.*`**（唯一日志出口是 `logging/` 单例 `logger`；默认实现为内置 console fallback，写 stderr）
- **零写用户文件**（配置文件是真理源，Agent 只读）
- **零 LLM 配置加载**（Agent 不知道 `apiKey`，宿主传入 `LlmProvider` 实例）
- **Manager 委托模式**：Agent 面类只做编排，领域操作委托给专职 Manager

---

## 二、构造与生命周期

### 2.1 构造选项 `AgentOptions`

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `projectPath` | `string` | ✅ | 项目路径（必须） |
| `provider` | `LlmProvider` | ✅ | 前台 LLM Provider（必须） |
| `backgroundProvider` | `LlmProvider` | ❌ | 后台 Provider（投影等后台操作） |
| `providerRouter` | `ProviderRouter` | ❌ | 按任务类型返回 Provider 的路由器（不配时全部使用同一 Provider，向后兼容） |
| `configDir` | `string` | ❌ | 配置目录（role-packs / skills，设定记忆唯一归角色包） |
| `dataDir` | `string` | ✅ | 记忆数据目录（必填，内核不提供默认值；传项目级还是用户级目录由宿主决定） |
| `registryDir` | `string` | ❌ | 项目注册表目录（缺省与 dataDir 相同）。注册表用于**跨项目按名解析**，仅当多项目共用一份时才成立 |
| `maxContextTokens` | `number` | ❌ | 上下文窗口上限（默认 120000） |
| `activeRolePack` | `string` | ❌ | 启动激活的角色包名（缺失/不存在回退默认激活首个） |
| `permission` | `'owner' \| 'guest'` | ❌ | 安全权限（默认 'owner'） |
| `allowedPaths` | `string[]` | ❌ | 路径白名单（默认 [] = 全部允许） |
| `confirmWrites` | `boolean` | ❌ | 写入确认（默认 false） |
| `storage` | `IMemoryStorage` | ❌ | 存储层注入（默认 InMemoryStorage） |
| ~~`vectorStore`~~ | ~~`IVectorStore`~~ | — | **已删除（2026-09-18 B0 收编）**：向量语义召回通道此前**写端缺失、从未在生产生效**（`upsert` 零调用 → 库恒空 → 语义分支永不触发 = 僵尸能力）。经主流 agent 调研（Anthropic Memory/Claude Code/Librarian Pattern 实证「LLM 消费者 + 小语料」纯关键词足用）拍板收编：`IVectorStore` 接口、`JsonVectorStore`、`EmbeddingProvider` 及 `config.embedding` 段全链删除；`search_memories` 走纯关键词，未命中提示 LLM 换词重试 |
| ~~`recallExcludeSources`~~ | ~~`string[]`~~ | — | **已删除（2026-09-11）**：该配置随召回编排 `recall()` 退役后成为零消费者死配置，全链（AgentOptions → AgentConfig → AssembleInput → ContextPreparerDeps）物理删除。关联推荐的实际排除走 `Agent.governance.suggest(query, { excludeSources })` 显式参数 |
| `sessionStore` | `ISessionStore` | ❌ | 会话存储注入 |
| `tracer` | `ITracer` | ❌ | 可观测性 Tracer 注入（不传则使用 NoopTracer 静默丢弃所有 span） |
| `messages` | `UIMessages` | ❌ | 宿主可覆盖的 UI 消息文本（默认英文，宿主覆盖为中文等） |
| `enableContextSummary` | `boolean` | ❌ | 上下文超限时是否自动生成摘要（默认 true，开启后首次截断时增加 ~1-2s 延迟） |
| `archiveMode` | `ArchiveMode` | ❌ | 归档模式（ADR-015，默认 `'full'`）。`'full'`：会话内容在会话切换前自动归档；`'manual'`：全部需手动触发（2026-08-14 洞察层移除后三态收敛为二态，原 `'insights-only'` 已移除） |
| `webSearchProvider` | `IWebSearchProvider` | ❌ | 网络搜索提供者注入（提供时自动暴露 `web_search` 工具给 LLM，不传则不暴露） |
| `fetchProvider` | `IFetchProvider` | ❌ | 网页抓取提供者注入（提供时自动暴露 `web_fetch` 工具给 LLM，与 `webSearchProvider` 成对构成「搜索→抓取」闭环，不传则不暴露） |
| `codeExecutionProvider` | `ICodeExecutionProvider` | ❌ | 代码执行提供者注入（提供时自动暴露 `run_code` 工具给 LLM，沙箱执行能力完全由宿主 provider 决定，内核零运行时依赖，不传则不暴露） |
| `fileConsistencyCheck` | `FileConsistencyCheck` | ❌ | 文件层前置条件断言回调（可选，未注入则完全降级为现状） |
| `preExecutionCheck` | `(name, args) => PreExecutionResult` | ❌ | 工具执行前检查回调（宿主审批/审计/参数改写通道；装配时与内部幂等检查组合为单点入口） |

> **Logger 注入方式**：v1.0 起 `AgentOptions` 不再含 `logger` 字段。日志通过全局 `setLogger(customLogger)` 注入（详见 §十七 类型导出）；未注入时使用内核内置 console fallback（写 stderr，级别由 `MEMORA_LOG_LEVEL` 控制），内核不做任何运行时模块解析。注入即内核唯一日志出口，对**所有内核模块（含 utils 层）**生效。

### 2.2 生命周期方法

| 方法 | 用途 |
|------|------|
| `new Agent(opts)` | 构造函数（无副作用，不连接 LLM） |
| `init(projectPathOverride?)` → `Promise<ProjectContext>` | 初始化：建立存储、加载配置、组装组件 |
| `close()` → `Promise<void>` | 关闭：释放项目锁、关闭数据库 |

### 2.3 Agent 只读访问器

| 访问器 | 类型 | 说明 |
|--------|------|------|
| `agent.initialized` | `boolean` | 是否已初始化 |
| `agent.context` | `AgentContext \| null` | 当前项目上下文 |
| `agent.provider` | `LlmProvider` | 当前前台 Provider |
| `agent.isBusy` | `boolean` | 是否正在对话中 |
| `agent.lastInteractionAt` | `Date \| null` | 最近一次 `chat()` 调用时间 |

### 2.4 Manager 访问器（委托模式）

Agent 通过一组 getter 暴露专职 Manager 与组件。详见后续章节。

| 访问器 | 类型 | 职责 |
|--------|------|------|
| `agent.rolePack` | `RolePackManager \| null` | 角色包管理 |
| `agent.tools` | `ToolExecutor \| null` | 工具注册与执行 |
| `agent.skills` | `SkillManager \| null` | 技能匹配与注入 |
| `agent.governance` | `MemoryGovernance \| null` | 记忆治理（去重/冲突检测/建议） |
| `agent.memory` | `MemoryInspector \| null` | 记忆查询 + 写入（`writeXxx` 前缀） |
| `agent.works` | `WorkProjectionManager \| null` | 作品投影（工作内容摘要） |
| `agent.polish` | `TextPolishManager \| null` | 文本润色（LLM 语法修正 + 表达优化） |

> **读写统一入口**：`agent.memory`（MemoryInspector）同时负责记忆的查询与写入——只读方法（snapshot/search/searchByKeyword/stats/list/getById/getBySource/listDeleted 等）与写方法（`writeXxx` 前缀：writeUpsert/writeDelete/writeRestore/writePurge/writePurgeExpired。`writeBoost` 已随 score 字段退役删除，2026-09-09）。旧的 `memoryMutator`/`MemoryMutator` 拆分已在后续迭代中合并回 `MemoryInspector`，二者均不再存在。

### 2.5 内部组件访问器（高级）

| 访问器 | 类型 | 说明 |
|--------|------|------|
| `agent.agentLoop` | `AgentLoop \| null` | Agent 循环体（`getMessages()` / `getRecentHistory()`） |
| `agent.agentHistory` | `MessageHistory \| null` | 消息历史（`listAllSessions()` 等） |

### 2.6 `ProjectContext` 字段（`init()` 返回值）

| 字段 | 类型 | 说明 |
|------|------|------|
| `projectPath` | `string` | 项目根目录的绝对路径 |
| `projectName` | `string` | 项目名称（从注册表读取，或取目录名） |
| `memoraDir` | `string` | `.memora/` 目录的绝对路径 |
| `index` | `IMemoryStorage` | 记忆存储接口 |
| `security` | `SecurityGuard` | 安全守卫 |
| `bootstrapMemories` | `Memory[]` | 启动时加载的必召记忆 |

### 2.7 事件订阅（`agent.on()` / `agent.off()` / `agent.once()`）

Agent 继承 `TypedEventEmitter<AgentEventMap>`，向宿主项目广播对话外事件。

```typescript
agent.on<K extends AgentEventName>(event: K, handler: (payload: AgentEventMap[K]) => void): void
agent.off<K extends AgentEventName>(event: K, handler: (payload: AgentEventMap[K]) => void): void
agent.once<K extends AgentEventName>(event: K, handler: (payload: AgentEventMap[K]) => void): void
```

| 事件名 | 载荷 | 触发时机 |
|--------|------|----------|
| `memoryAdded` | `{ id, source, name }` | 记忆被写入存储（round-summary 沉淀等） |
| `personaSwitched` | `{ from: string \| null, to }` | 角色被切换（手动指定） |
| `memoryRecalled` | `{ count, query }` | 记忆被召回（用于 UI 展示） |
| `sessionForked` | `{ from, to, messageCount }` | 会话被分叉（创建新分支） |
| `projectSwitched` | `{ from: string \| null, to: string, projectName: string }` | 项目切换（宿主 UI 可据此刷新项目相关界面） |
| `skillMatched` | `{ skill: string, score: number }` | 技能被匹配（宿主 UI 可据此展示当前激活技能） |
| `archiveFailed` | `{ stage: 'content'; message: string }` | 归档操作失败（仅 content 阶段，fire-and-forget catch 分支发射，宿主可通知用户） |

```typescript
// 使用示例
agent.on('memoryAdded', (e) => console.log(`新记忆: ${e.source}:${e.name}`));
```

> `close()` 自动移除所有事件监听器。

**状态机**：
```
[构造] --init()--> [已初始化] --chat()/其他方法...--> [已初始化]
                              --close()--> [已关闭]
```

未初始化时调用任何方法**抛 `configError`**。Manager 访问器在 `init()` 前返回 `null`。

---

## 三、对话 API

### 3.1 `chat(input, signal?)` — 流式对话（唯一入口）

```typescript
async *chat(input: string, signal?: AbortSignal): AsyncGenerator<AgentChunk, void, unknown>
```

流式返回 `AgentChunk` 事件，可选传入 `signal` 支持取消。

```typescript
type AgentChunk =
  | { type: 'thinking'; phase: ThinkingPhase }             // 推理阶段
  | { type: 'text'; content: string }  // LLM 文本片段（流式输出内容）
  | { type: 'thought'; content: string; stepIndex?: number }  // 模型思考增量（不进正文/记忆）；stepIndex = 所属 step 轮内序号（loop 打标）
  | { type: 'tool_start'; toolCallId: string; name: string; args?: string; stepIndex?: number }   // 工具调用开始（stepIndex 同 thought；tool_result 经 toolCallId 归属，不重复携带）
  | { type: 'tool_result'; toolCallId: string; name: string; ok: boolean; summary?: string }  // 工具调用结果
  | { type: 'aborted'; reason: string }                    // 对话被取消
  | { type: 'error'; message: string }                     // 流式过程中发生错误（LLM 超时/连接断开）
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string }  // 指数退避重试
  | { type: 'done' };                                      // 结束标记
```

> 上表为核心事件子集（含边界/提问等更多成员的 `AgentChunk` 全集以 [types.ts](../src/agent/types.ts) 为唯一真理源）。

> **记忆召回展示链已退役（2026-09-10）**：`recall` chunk 分支与 `RecalledMemorySummary` 类型已随自动注入退役**物理删除**。记忆纯工具化后，「召回了什么」由 `search_memories` 工具的 `tool_start` / `tool_result` 过程事件天然展示；检索命中含 `accessedAt` / 溯源字段（`sessionId`/`roundId`）。

`ThinkingPhase` 取值：`'recalling' | 'processing' | 'archiving'`

### 3.2 `chatSync(input, signal?)` — 同步版（仅供测试用）

```typescript
async chatSync(input: string, signal?: AbortSignal): Promise<string>
```

收集所有 `text` 事件拼接成完整字符串返回。

---

## 四、记忆查询与写入（`agent.memory` · MemoryInspector）

> Manager 访问路径：`agent.memory.xxx()`。`init()` 前返回 `null`。

### 4.1 `snapshot()` — 3 层记忆快照

```typescript
agent.memory.snapshot(): MemorySnapshot
```

同步返回当前 3 层记忆快照（纯只读、无副作用）：

| 层 | 键 | 内容 |
|----|-----|------|
| 第 1 层 | `snapshot.working` | `WorkingMemorySnapshot` — 当前 AgentLoop 消息（最近 5 条预览 + 总数） |
| 第 2 层 | `snapshot.bootstrap` | `BootstrapSnapshot` — 规则记忆（名称 + 来源 + 权重，Persona/Skill 已解耦为设定记忆，不进 bootstrap） |
| 第 3 层 | `snapshot.archive` | `ArchiveSnapshot` — 归档记忆计数（round-summary）+ 当前会话信息 |

```typescript
interface MemorySnapshot {
  working: WorkingMemorySnapshot;
  bootstrap: BootstrapSnapshot;
  archive: ArchiveSnapshot;
}
```

### 4.2 `search(query, limit?)` — 记忆搜索

```typescript
// ⚠️ @deprecated 同步通道已退役（2026-09-20），改用 searchByKeyword()。实证无生产/宿主消费方。
agent.memory.search(query: string, limit?: number): AgentSearchHit[]
```

```typescript
interface AgentSearchHit {
  id: string;             // 记忆唯一标识（source:name 格式，供 showMemory/deleteMemory 等操作使用）
  name: string;           // 记忆名称
  source: string;         // 来源标签
  contentPreview: string; // 内容预览（截断到 120 字符）
  createdAt?: string;     // 创建时间（ISO 8601，供 UI 层时间筛选/排序使用）
}
```

### 4.3 `stats()` — 记忆库统计

```typescript
agent.memory.stats(): AgentStats
```

```typescript
interface AgentStats {
  bySource: Record<string, number>; // 按来源标签分组的记忆数量
  total: number;                    // 记忆总数
}
```

### 4.4 `agent.agentLoop.getMessages()` — 工作记忆原始消息

```typescript
agent.agentLoop.getMessages(): readonly Message[]
```

### 4.5 写入方法

记忆的写入统一收口在 `agent.memory`，写方法以 `writeXxx` 前缀命名（同步返回、不调 LLM、不触发异步 IO）：

```typescript
// ─── 写入（writeXxx 前缀） ───
agent.memory.writeUpsert(memory: Memory): void;                 // 插入或更新记忆
agent.memory.writeDelete(id: string): void;                    // 软删除（写入 deletedAt）
agent.memory.writeRestore(id: string): void;                   // 恢复软删除
agent.memory.writePurge(id: string): void;                     // 物理删除（不可恢复）
agent.memory.writePurgeExpired(before: Date): number;          // 清理过期回收站

// ─── 只读扩展查询 ───
agent.memory.list(limit?: number): Memory[];                   // 列出所有记忆（按 accessedAt 降序；score 已随 2026-09-09 退役）
agent.memory.getById(id: string): Memory | null;               // 按 ID 获取活跃记忆
agent.memory.getBySource(source: string): Memory[];            // 按 source 获取
agent.memory.listDeleted(limit?: number): Memory[];            // 回收站（软删除记忆）
agent.memory.getDeletedById(id: string): Memory | null;
agent.memory.searchByKeyword(query: string, limit?: number): Promise<AgentSearchHit[]>; // 纯关键词通道
```

> **注意**：`suggest()` / `sourceHealth()` 经 `agent.governance` 暴露（`.suggest()` / `.sourceHealth()`），不挂在 `agent.memory` 下，避免经 MemoryInspector 转发产生多余代理层。

---

## 五、Memory 模型（基元驱动）

```typescript
interface Memory {
  id: string;         // 唯一标识（source:name 格式，如 'rule:core'）
  content: string;    // 记忆内容（Markdown 文本）
  source: string;     // 来源标签（开放字符串，非枚举）
  name: string;       // 可读名称
  createdAt: string;  // 创建时间（ISO 8601）
  accessedAt: string; // 最后访问时间（每次召回时刷新）
  deletedAt?: string; // 软删除时间（ISO 8601，可选；非 undefined 表示已软删除。回收站**无自动清理**：保留期清理由宿主入口显式触发，见 writePurgeExpired）
  metadata?: Record<string, string>; // 配置文件 frontmatter 额外元数据（仅配置文件写入路径使用，不进记忆库）
  summaryType?: SummaryType; // round-summary 摘要类型（preference/fact/decision/intent/general；顶层持久化字段）
  sessionName?: string;  // round-summary 归属会话标识（顶层持久化字段，仅 round-summary 有意义）
  roundId?: string;      // round-summary 归属轮次标识（顶层持久化字段，仅 round-summary 有意义）
  isModified?: boolean;  // 摘要是否已被人工修改（仅 round-summary 有意义）
  supersededBy?: string; // 写路径取代标记：非 undefined 表示已被更新的摘要覆盖，召回时确定性过滤
}
```

> **字段基线**（score 已退役）：`score` 字段已随 2026-09-09 阶段3 物理删除（无持久化排序分字段，使用轨迹唯一事实源为 `accessedAt`）；向量语义通道已随 2026-09-18 B0 收编（检索为纯关键词单通道）。round-summary 溯源/分类字段（summaryType/sessionName/roundId）已提升为顶层持久化字段（metadata 不进记忆库）。所有查询方法（getById/getBySource/search/count/countBySource/getAllSources）自动过滤 `deletedAt != undefined` 的记忆。详见 ADR-004 GAP-6 + ADR-002 §IMemoryStorage。

**常用 source 标签（`SOURCE_LABELS` 常量）：**

| 常量 | 值 | 用途 |
|------|----|------|
| `SOURCE_LABELS.PERSONA` | `'persona'` | 角色人格（残留兼容标签，已随 ADR-025 归角色包、不进记忆库） |
| `SOURCE_LABELS.RULE` | `'rule'` | 创作规则（残留兼容标签，已随 ADR-025 归角色包、不进记忆库） |
| `SOURCE_LABELS.SKILL` | `'skill'` | 技能定义（残留兼容标签，已随 ADR-025 归角色包、不进记忆库） |
| `SOURCE_LABELS.WORK_PROJECTION` | `'work-projection'` | 作品投影（已移出记忆库，2026-08-20 落项目目录 projections/） |
| `SOURCE_LABELS.ROUND_SUMMARY` | `'round-summary'` | 轮次摘要（当前实际写入记忆库的主要 source） |
| `SOURCE_LABELS.UNKNOWN` | `'unknown'` | 未知来源（未被已知标签覆盖时的兜底值） |

> source 是开放字符串，宿主可自定义新标签。`validateSource()` 可检测常见 typo（基于 Levenshtein 距离）。PERSONA/RULE/SKILL/WORK_PROJECTION 四标签**仅作历史兼容与 typo 检测**保留，已不进入治理范围（`GOVERNANCE_SOURCES`）——当前写入记忆库的主要 source 为 `round-summary`。

### 5.2 `IMemoryStorage` 接口

宿主实现此接口注入 Agent，替代默认的 `InMemoryStorage`。共 **15 方法**（14 必需 + 可选 `close`），所有方法同步（与 better-sqlite3 API 对齐，`await` 同步值安全）。所有查询方法自动过滤已软删除的记忆（`deletedAt != undefined`）。

```typescript
interface IMemoryStorage {
  // ─── 基础 CRUD（6 方法） ───
  upsert(memory: Memory): void;
  getById(id: string): Memory | null;
  getBySource(source: string): Memory[];
  search(query: string, limit?: number): Memory[];
  count(): number;
  countBySource(source: string): number;

  // ─── 软删除 / 回收站（6 方法，ADR-004 GAP-6 扩展） ───
  delete(id: string): void;           // 软删除（写入 deletedAt，不物理移除；对已软删除的 no-op）
  restore(id: string): void;          // 恢复软删除记忆（清除 deletedAt；对活跃记忆 no-op）
  purge(id: string): void;            // 物理删除（不可恢复，用于回收站"彻底删除"）
  listDeleted(limit?: number): Memory[];        // 列出回收站（按 deletedAt 降序；limit 缺省/≤0 = 全部，正整数 = 最近 N 条）
  getDeletedById(id: string): Memory | null;    // 按 ID 获取单条软删除记忆（restore/purge 前存在性校验）
  purgeExpired(before: Date): number;           // 清理过期回收站（物理删除 deletedAt 早于 before 的，返回清理数量）

  // ─── 统计与维护（2 方法） ───
  touch(id: string, now: string): boolean;  // 刷新 accessedAt（score 退役后唯一写位；不写 score、无 clamp 语义）
  getAllSources(): Map<string, number>;     // 获取所有 source 标签及其活跃记忆数量

  // ─── 可选（1 方法） ───
  close?(): void;
}
```

> 宿主实现应使用 `COUNT(*)` / `UPDATE ... WHERE` 等数据库原生操作，避免全量加载数据。`getAllSources` 是性能优化方法，避免逐条遍历。详见 ADR-002 §IMemoryStorage 接口方法。

### 5.3 `ISessionStore` 接口

宿主实现此接口提供会话消息的持久化能力。

```typescript
interface ISessionStore {
  appendMessage(date: string, session: string, message: SessionMessage): void;
  loadMessages(date: string, session: string): SessionMessage[];
  listSessions(): string[];
}
```

---

## 六、项目 / 会话管理

> **方法归属**：项目相关方法在 `agent.projects`（ProjectManager），会话相关方法在 `agent.sessionManager`（SessionManager），仅 `switchProject` / `rebuildComponents` / `forkSession` 保留在 Agent 面类作为常用入口。

> **switch* 返回值约定**：各 switch 操作返回与其操作语义最匹配的值 ——
> `switchSession` 返回新会话名（string）、`switchProject` 返回完整项目上下文（AgentContext，含 bootstrap 记忆等）、
> `agent.switchRolePack` 返回布尔值（是否切换成功）。这是设计性差异，非 bug。

### 6.1 Agent 面类方法（项目/会话入口）

| 方法 | 用途 |
|------|------|
| `switchProject(nameOrPath)` → `Promise<AgentContext>` | 切换到指定项目（保留 Agent 级记忆，自动 rebuild） |
| `rebuildComponents()` → `Promise<void>` | 重建 history / loop（通常不需要手动调用，switchProject 已自动执行） |
| `forkSession(targetSession?)` → `AgentForkResult` | 分叉当前会话（同步，复制完整消息历史到新分支） |

### 6.2 `agent.projects` — ProjectManager

| 方法 | 用途 |
|------|------|
| `projects.list` | 所有已注册项目（getter） |
| `projects.listProjects()` → `ProjectEntry[]` | 列出所有已注册项目 |

### 6.3 `agent.sessionManager` — SessionManager

| 方法 | 用途 |
|------|------|
| `sessionManager.switchSession(newName)` → `string` | 切换到指定会话（chatBusy 时抛 configError） |
| `sessionManager.forkSession(targetSession?)` → `AgentForkResult` | 分叉当前会话 |
| `sessionManager.loadSessionMessages(date, session)` → `Promise<SessionMessage[]>` | 加载指定日期/会话的消息（含时间戳） |
| `sessionManager.restoreMostRecentSession()` → `Promise<number>` | 恢复最近活跃会话（SSOT：listSessionMetas[0]，updatedAt 降序；绝不隐式创建——新建会话唯一入口为宿主手动按钮） |
| `sessionManager.restoreSession(date, session)` → `Promise<number>` | 恢复指定日期/会话 |
| `sessionManager.createCheckpoint(mainGoal?)` → `SessionCheckpoint \| null` | 创建当前会话检查点（含热记忆、目标、计划、状态机快照），首次调用返回完整检查点，后续调用合并增量。**同进程内存态**（2026-09-10 减法后不落盘） |
| `sessionManager.getCheckpoint()` → `SessionCheckpoint \| null` | 获取当前检查点（只读，不修改状态） |
| `sessionManager.discardCheckpoint()` → `boolean` | **Phase 4 新增**：放弃当前暂停检查点（对称 pause 创建，宿主 handleStop paused 态调之；停定时器 + 清内存 + resetToRunning；无检查点返回 false） |

```typescript
// 项目列表
const projects = agent.projects.list;

// 会话分叉示例（Agent 面类入口，等价于 agent.sessionManager.forkSession()）
const forkResult = agent.forkSession();
console.log(`分叉到 ${forkResult.newSession}，复制了 ${forkResult.messageCount} 条消息`);

// 自定义分支名
const customFork = agent.forkSession('experiment');

// listAllSessions 通过 agentHistory 访问
const sessions = await agent.agentHistory?.listAllSessions();
```

### `AgentForkResult` / `ForkResult` 类型

```typescript
// Agent.forkSession() / sessionManager.forkSession() 返回值
interface AgentForkResult {
  newSession: string;
  messageCount: number;
}

// MessageHistory.forkSession() 内部类型（从 memora 导出）
export interface ForkResult {
  date: string;
  newSession: string;
  messages: SessionMessage[];
}
```

---

## 七、角色包管理（`agent.rolePack` · RolePackManager）

> Manager 访问路径：`agent.rolePack`（RolePackManager，`init()` 前返回 `null`）。角色包是「设定记忆唯一载体」（persona/rules/skills 归属角色包，见 memory-role-pack-boundary 纪律）。

| 成员 | 类型 | 说明 |
|------|------|------|
| `rolePack.listMeta()` | `RolePackMeta[]` | 所有角色包元数据（name / displayName / description / version / ...） |
| `rolePack.activeName` | `string \| null`（getter） | 当前激活的角色包名（null = 未激活） |
| `rolePack.getActive()` | `RolePackAssembly \| null` | 当前激活的完整角色包对象（含合并后策略） |
| `rolePack.getActiveRules()` | `string[]` | 当前激活角色包的规则列表 |
| `rolePack.getActiveTraits()` | `Record<string, number> \| undefined` | 当前激活角色包的 traits（clamp 0-1） |
| `rolePack.activate(name)` | 方法 → `boolean` | 手动切换到指定角色包（30s 内超 5 次切换后锁 2 分钟防抖） |
| `rolePack.getSwitchLockStatus()` | 方法 → `{ locked, unlockAt }` | 切换防抖锁定状态 |
| `rolePack.onRolePackActivated(handler)` | 方法 | 注册激活变更回调（`(from, to)`） |

```typescript
// 使用示例
const rp = agent.rolePack;
if (!rp) throw new Error('rolePack 未就绪');
const metas = rp.listMeta();           // 列出所有角色包
rp.activate('作家');                    // 切换角色包
console.log(rp.activeName);            // 当前角色包名
const lock = rp.getSwitchLockStatus(); // 切换防抖状态
```

---

## 八、工具注册（`agent.tools` · ToolExecutor）

> 工具注册/执行走 `agent.tools.xxx()`。

### 8.1 内置工具（核心摘要：默认常驻 + 条件暴露，非全集）

| 工具名 | 用途 | 参数 | 暴露条件 |
|--------|------|------|------|
| `read_file` | 读取项目内文件内容（**按行分段返回**：单次输出 token 数 ≤ `LOOP_CONSTANTS.SINGLE_TOOL_RESULT_MAX_TOKENS`＝6000；未读到末尾时附「[read_file 分段]」脚注，给出已显示行号区间、总行数与续读 offset） | `path`, `offset?`, `limit?` | 默认常驻 |
| `write_file` | 写入/创建文件（支持 overwrite/append/insert 三种模式） | `path`, `content`, `mode?`, `insert_line?` | 默认常驻 |
| `list_dir` | 列出目录内容（递归深度 ≤ 3） | `path?`, `recursive?`, `maxDepth?` | 默认常驻 |
| `search_memories` | 在记忆索引中搜索（支持 match/near 两种模式） | `query`, `limit?`, `mode?` | 默认常驻 |
| `run_project_script` | 运行**项目内既有**脚本（内核子进程，cwd=项目根；路径白名单越界拒绝；扩展名推断 node/python/shell；超时 30s 上限 120s） | `script_path`, `args?` | 默认常驻（零注入） |
| `run_skill_script` | 执行技能目录下的脚本（渐进披露 L3） | `skill_name`, `script_path`, `args?` | 默认常驻（来源=技能作者） |
| `web_search` | 搜索互联网 | `query`, `limit?` | 条件暴露（注入 `IWebSearchProvider`） |
| `web_fetch` | 抓取网页正文（与 `web_search` 成对闭环） | `url`, `limit?` | 条件暴露（注入 `IFetchProvider`） |
| `run_code` | LLM 现写代码执行（特权：`code:execute` 声明 + 宿主沙箱注入） | `language`, `code` 或 `script_path` | 条件暴露（注入 `ICodeExecutionProvider` 且角色包声明特权） |

### 8.2 `agent.tools` — ToolExecutor

| 方法 | 用途 |
|------|------|
| `tools.registerTool(definition, handler)` | 注册自定义工具（会话级） |
| `tools.list` | 所有工具定义（getter，`ToolDefinition[]`） |
| `tools.execute(name, argsJson, extensions?)` → `Promise<string>` | 执行工具调用 |

```typescript
// 工具定义
interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];        // 必填参数列表（不可省略）
  };
}

// 宿主注册领域工具示例
agent.tools.registerTool(
  {
    name: 'web_search',
    description: '搜索互联网，返回结构化结果',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'number', description: '最大返回条数', default: 5 },
      },
      required: ['query'],
    },
  },
  async (args) => {
    const res = await fetch(`https://api.example.com/search?q=${encodeURIComponent(args.query)}`);
    return await res.json();
  },
);
```

### 8.3 `IWebSearchProvider` — 网络搜索注入接口

> 宿主实现此接口并注入 `AgentOptions.webSearchProvider`，即可让 Agent 拥有网络搜索能力。
> 未注入时，Agent 不会暴露 `web_search` 工具给 LLM，LLM 被告知搜索不可用。
> 内核提供 `FetchWebSearchProvider` 作为零依赖默认实现（`buildSearchEndpoints` 构建内置 Bing/DuckDuckGo 等预设降级链）。
> **主推宿主自建 `SearchEndpoint` 注入**（自带 URL+解析），内核预设仅作零配置保底。

```typescript
// 搜索结果
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  endpoint?: string;  // 实际后端名（降级打标用，自定义实现可省略）
}

// 搜索选项
interface WebSearchOptions {
  limit?: number;  // 返回结果数量上限（默认 5）
}

// 搜索端点契约：宿主可自建（自带 URL+解析）覆盖内核预设
interface SearchEndpoint {
  name: string;                       // 端点名（降级打标 / 结果透出）
  buildUrl(query: string): string;    // 由查询构造请求 URL
  parse(html: string, limit: number): SearchResult[];  // 解析结果页
}

// 网络搜索提供者接口
interface IWebSearchProvider {
  search(query: string, options?: WebSearchOptions): Promise<SearchResult[]>;
}

// 注入方式
const agent = new Agent({
  // ... 其他选项
  // 方案 1（保底）：内置默认实现（Bing→DuckDuckGo 零配置开箱即用）
  webSearchProvider: new FetchWebSearchProvider(),
  // 方案 2（主推）：宿主自建端点注入，URL/解析完全由宿主掌控
  // webSearchProvider: new FetchWebSearchProvider([
  //   { name: 'MyEngine', buildUrl: (q) => `https://my.engine/s?q=${q}`, parse: myParse },
  // ]),
});

// buildSearchEndpoints：预设名与自定义端点混排，内核预设仅作保底
// buildSearchEndpoints(['bing', myEndpoint])  // 自定义端点优先，未知名忽略
```

### 8.4 `IFetchProvider` — 网页抓取注入接口（搜索→抓取闭环第二段）

> 宿主实现此接口并注入 `AgentOptions.fetchProvider`，即可让 Agent 读取 `web_search` 找到的候选链接正文。
> 未注入时，Agent 不会暴露 `web_fetch` 工具给 LLM。
> 内核提供 `FetchWebFetchProvider` 作为基于内置 `fetch` + 正则清洗 HTML 的零依赖默认实现；`safeFetch` 为带 30s 超时保护的包装（抓取失败/超时降级返回友好提示，不中断主流程）。

```typescript
// 抓取结果
interface FetchedPage {
  url: string;
  title: string;
  content: string;
  contentType?: string;
}

// 抓取选项
interface FetchOptions {
  maxChars?: number;  // 正文截断字符数上限
}

// 网页抓取提供者接口
interface IFetchProvider {
  fetch(url: string, options?: FetchOptions): Promise<FetchedPage>;
}

// 注入方式
const agent = new Agent({
  // ... 其他选项
  fetchProvider: new FetchWebFetchProvider(), // 使用内置默认实现
});
```

### 8.5 `ICodeExecutionProvider` — 代码执行注入接口

> 宿主实现此接口并注入 `AgentOptions.codeExecutionProvider`，即可让 Agent 拥有通用代码执行能力（计算 / 数据处理 / 验证）。
> 未注入时，Agent 不会暴露 `run_code` 工具给 LLM。
> **内核零运行时依赖**：沙箱执行（语言白名单 / 资源限制 / 网络隔离）完全由宿主 provider 决定；`safeExecuteCode` 为带 120s 超时保护的包装（执行失败/超时降级返回错误结果，不中断主流程）。

```typescript
// 执行结果
interface CodeExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

// 执行选项
interface CodeExecutionOptions {
  timeoutMs?: number;  // 单次执行超时上限
}

// 代码执行提供者接口
interface ICodeExecutionProvider {
  execute(code: string, language: string, options?: CodeExecutionOptions): Promise<CodeExecutionResult>;
}

// 注入方式（沙箱实现由宿主提供）
const agent = new Agent({
  // ... 其他选项
  codeExecutionProvider: mySandboxProvider,
});
```

### 8.6 `IProjectSearchProvider` — 项目内搜索注入接口

> 宿主实现此接口并注入 `AgentOptions.projectSearchProvider`，即可让 Agent 具备「在当前项目（工作区）中搜索」能力（等价 IDE 全局搜索 `Ctrl+Shift+F`）。
> 未注入时，Agent 不会暴露 `search_project` 工具给 LLM。
> **内核零依赖**：目录遍历 / 忽略规则 / 扫描与结果上限全由宿主决定；内核提供 `safeSearchProjectFiles` / `safeSearchProjectText` 两个带 30s 超时保护的包装，并内置由分词 SSOT 产出的**放宽词表**（`buildSearchTerms`）。

```typescript
// 文件名命中
interface ProjectFileMatch {
  path: string;            // 相对项目根的 posix 路径
}

// 内容命中
interface ProjectTextMatch {
  path: string;
  line?: number;           // 命中行号（1 起）
  preview?: string;        // 命中行预览（去控制字符 + 限长，防上下文注入）
}

// 内容搜索的**结果对象**（含本次检索的元信息）
interface ProjectTextSearchResult {
  matches: ProjectTextMatch[];
  truncated: boolean;                        // 检索被截断（零命中时也须如实回报）
  truncatedBy?: 'results' | 'files';         // 截断主因：结果达上限 / 扫描达文件上限
  scannedFiles?: number;                     // 实际参与匹配的文件数（宿主上报的数据）
  partialReadFiles?: number;                 // 只检索了前一部分（过大）的文件数（**参与了**检索，非跳过）
  unreadableSkipped?: number;                // 读取失败（权限/被删/悬空链接）完全未参与检索的文件数
  perFileCapped?: boolean;                   // 有文件的命中被单文件上限截断
  failed?: boolean;                          // 检索自身失败（超时/抛错）≠ 真零命中
  relaxed?: boolean;                         // 已放宽为分词匹配 → 结果**非精确**命中
  termsUsed?: string[];                      // 放宽时实际使用的词（文案的唯一取值来源）
}

interface ProjectTextSearchOptions extends ProjectFileSearchOptions {
  pattern: string;         // 内容关键词（**字面量**语义，宿主自行转义，内核不假定正则）
  terms?: string[];        // 内核下发的放宽词表；宿主**仅在整串零命中时**才启用
}

interface IProjectSearchProvider {
  searchFiles(options?: ProjectFileSearchOptions): Promise<ProjectFileMatch[]>;
  searchText(options: ProjectTextSearchOptions): Promise<ProjectTextSearchResult>;
}
```

**实现约定（宿主侧，三条都是契约而非建议）**：

1. **精确优先 + 零命中回退**：先按 `pattern` 整串字面量匹配；整串零命中**且** `terms` 非空时，才用 `terms` 做一次 OR 放宽，并置 `relaxed` + 回填 `termsUsed`（多词无需拆开传，**任一分词命中即算**，不是"全部包含"）。整串已命中时不得放宽——否则精确命中会退化成"可能不是精确命中"。
2. **三态必须可区分**：`failed`（没搜完/搜坏了）/ `truncated`（没搜全）/ 真零命中，三者不得再压成同一个空数组——`[]` 承载不了任何元信息，会把"没搜到"与"没搜完"变成逐字同形。失败**不要**返回工具错误（"no results is not an error"），如实回报 `failed` 即可，由内核分流文案。
3. **预算量以数据上报，不提升为内核常量**：`scannedFiles` / `partialReadFiles` / `unreadableSkipped` / `perFileCapped` 是宿主内部预算（扫描文件数 / 单文件字节 / 单文件命中数）与**读取结果**的事实；内核从不扫描，因此不持有这些常量，只把它们写进给 LLM 的文案。同理，`truncatedBy` 由宿主判定（只有宿主知道自己是因何停下）。
   ⚠️ `partialReadFiles`（看了但没看全）与 `unreadableSkipped`（根本没看上）**必须分开上报**：两者都是「零命中 ≠ 不存在」的依据，但补救动作不同——前者换更具体的关键词或 `read_file` 精读，后者可重试。

**放宽词表（内核侧）**：`buildSearchTerms(query)` 采用「显式片段优先」——空白分隔的片段是一等公民，不含 CJK 的片段原样保留（`Next.js` 不会被切成 `next` + `js`），含 CJK 的片段交给分词 SSOT。调用方（内核 `ToolExecutor`）会剔除与整串等价的词，因此单段查询通常不会触发放宽轮。

> 参考实现：VS Code 宿主 `hosts/memora-vscode/src/extension/host/projectSearchProvider.ts`（`mode=name` 走 `workspace.findFiles`；`mode=content` 走受限 fs 递归扫描，忽略 `IGNORED_DIR_NAMES`）。

---

## 九、作品投影（`agent.works` · WorkProjectionManager）

作品投影是文件内容的轻量级摘要（50-100 字概要 + 结构 + 关键决策），存储在**项目级目录** `<memoraDir>/projections/<slug>.json`（不进入记忆库）。原始文件内容不进投影，Agent 通过工具按需读取。

> **与记忆系统的边界**：作品投影是"作品感知"而非"对话记忆"（对话记忆唯一为 round-summary，沉淀在记忆库）。它**不参与记忆召回、不参与记忆治理**（去重/冲突检测不覆盖），随项目隔离——换项目即消失。宿主如需让模型感知投影，可显式经 `agent.works.loadAll()` 注入。

### 类型定义

```typescript
interface WorkProjectionEntry {
  id: string;            // 唯一 ID（work-proj-<slug>）
  sourcePath: string;    // 文件路径
  fileHash: string;      // 文件 hash（SHA-256，用于变更检测）
  summary: string;       // 概要（50-100 字）
  structure: string[];   // 结构（章节/模块列表，2-8 个）
  keyDecisions: string[];// 关键决策（1-3 个）
  updatedAt: string;     // 最后更新时间
}
```

### `agent.works` 公开方法

| 方法 | 用途 |
|------|------|
| `agent.works.ensureProjection(filePath, content, fileName?)` | 检查并更新作品投影（核心方法）。计算 hash → 查询已有投影 → 无则生成 / hash 变则重新生成 / hash 同则跳过。同文件并发调用时复用 in-flight Promise，避免重复 LLM 调用 |
| `agent.works.getProjection(filePath)` | 获取已有的作品投影（不触发生成） |
| `agent.works.loadAll()` | 加载所有作品投影（扫描项目目录 `<memoraDir>/projections/`，非记忆召回） |

> **注意**：`agent.works` 在 `init()` 前返回 `null`。`ensureProjection` 依赖后台 LLM Provider 生成摘要，未注入 `backgroundProvider` 时使用前台 Provider。

### 宿主接入示例

```typescript
// 宿主工具读取文件后，调用 ensureProjection 生成/更新投影
agent.tools.registerTool(
  {
    name: 'read_file',
    description: '读取文件内容',
    parameters: { /* ... */ },
  },
  async (args) => {
    const content = await fs.readFile(args.path, 'utf-8');
    // 异步生成投影（fire-and-forget，不阻塞工具返回）
    void agent.works?.ensureProjection(args.path, content);
    return content;
  },
);
```

---

## 十、Provider 管理

| 方法 | 用途 |
|------|------|
| `setProvider(provider)` | 运行时切换前台 Provider |
| `setBackgroundProvider(provider)` | 运行时切换后台 Provider |

Agent 不再管理 Provider 映射表，宿主自行管理。

---

## 十一、内部调试

> v1.0 起已移除 `getBuildCtx()` 和 `inspect()` 方法。宿主项目可通过以下渠道观察内核状态：
>
> - **事件系统**（§2.7）：订阅 `memoryAdded` / `memoryRecalled` / `skillMatched` 等事件获取运行时动态
> - **可观测性 Tracer**（§十四）：注入 `ITracer` 实现获取 AgentLoop 关键 span（RECALL / LLM_CALL / TOOL_EXEC / RESPONSE）
> - **`agent.memory.snapshot()`**（§4.1）：获取 3 层记忆快照（working / bootstrap / archive）
> - **`agent.agentLoop.getMessages()`**（§4.4）：获取工作记忆原始消息列表

---

## 十二、完整 API 一览

### Agent 面类直接方法

| 分组 | 方法 |
|------|------|
| 生命周期 | `init(projectPathOverride?)` / `close()` |
| 对话 | `chat(input, signal?)` / `chatSync(input, signal?)` / `processEvent(event)` / `resumeExecution()` / `forceReleaseChatLock()` |
| 事件 | `on()` / `off()` / `once()`（继承自 TypedEventEmitter） |
| 暂停/继续 | `pause(reason, source?, lowRisk?)` / `resume()` / `requestPause(reason, source?)` / `cancelPauseRequest()` / `isPausePending()` / `interject(content)` / `removePendingInterject(index)` / `clearPendingInterjections()` / `getPendingInterjections()` / `discardCurrentCheckpoint()` / `canContinueWithoutInput()` |
| 项目 / 会话 | `switchProject(nameOrPath)` / `rebuildComponents()` / `forkSession(targetSession?)` / `createCheckpoint(mainGoal?, role?, standard?)` / `getCheckpoint()` |
| Provider | `setProvider(provider)` / `setBackgroundProvider(provider)` |
| 归档模式 | `setArchiveMode(mode)` / `getArchiveMode()` |
| 角色 | `switchRolePack(name)` / `getRolePackSwitchLockStatus()` / `getActiveTraits()` / `injectAffect(affectString)` |
| 手动归档 | `archiveSession(...)` |
| 配置热更新 | `reloadConfig(source?)` |
| 记忆治理 | 经 `agent.governance` 暴露（`.deduplicate()` / `.detectConflicts()` / `.sourceHealth()` / `.suggest()`，见下方 Manager 成员） |
| 指标 | `getMetrics()` |

### Agent 面类只读访问器

`initialized` / `context` / `provider` / `isBusy` / `lastInteractionAt` / `agentLoop` / `agentHistory` / `projects` / `security` / `sessionManager` / `rolePack` / `tools` / `skills` / `governance` / `memory` / `works` / `polish`

### 各 Manager / 组件公开成员

| 访问器 | 类型 | 公开成员 |
|---------|---------|---------|
| `agent.rolePack` | `RolePackManager` | `.listMeta()` / `.activeName` / `.getActive()` / `.getActiveRules()` / `.activate()` / `.getSwitchLockStatus()` / `.getActiveTraits()` |
| `agent.tools` | `ToolExecutor` | `.list` / `.registerTool()` / `.execute()` |
| `agent.skills` | `SkillManager` | `.list` / `.match()` / `.register()` / `.buildSystemPrompt()` |
| `agent.governance` | `MemoryGovernance` | `.deduplicate()` / `.detectConflicts()` / `.sourceHealth()` / `.suggest()` |
| `agent.memory` | `MemoryInspector` | 读：`.snapshot()` / `.search()` / `.searchByKeyword()` / `.stats()` / `.list()` / `.getById()` / `.getBySource()` / `.listDeleted()`；写：`.writeUpsert()` / `.writeDelete()` / `.writeRestore()` / `.writePurge()` / `.writePurgeExpired()` |
| `agent.works` | `WorkProjectionManager` | `.ensureProjection(filePath, content, fileName?)` / `.getProjection(filePath)` / `.loadAll()` |
| `agent.polish` | `TextPolishManager` | `.polish(...)`（文本润色：LLM 语法修正 + 表达优化） |

> **说明**：`suggest()` / `sourceHealth()` 经 `agent.governance` 暴露，不挂在 `agent.memory` 下。旧的 `memoryMutator` 访问器与 `MemoryMutator` 类已合并回 `MemoryInspector`，请勿再使用。

---

## 十三、可观测性（ITracer / ISpan）

Memora 内置轻量 Span/Trace 抽象，宿主注入实现后可观测 AgentLoop 行为。

### 13.1 ITracer 接口

```typescript
interface ITracer {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan;
}
```

### 13.2 ISpan 接口

```typescript
interface ISpan {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
  recordException(error: Error): void;
}
```

### 13.3 NoopTracer（默认实现）

```typescript
import { NOOP_TRACER } from '@zooique/memora';

// 不注入 tracer 时自动使用 NOOP_TRACER，零运行时开销
// NOOP_TRACER.startSpan() 返回共享的 NoopSpan 单例，所有方法为空操作
```

### 13.4 TRACE_SPANS 常量

```typescript
import { TRACE_SPANS } from '@zooique/memora';

TRACE_SPANS.LLM_CALL         // 'llm.call'           — LLM API 调用
TRACE_SPANS.TOOL_EXEC        // 'tool.execute'       — 工具执行
TRACE_SPANS.RESPONSE         // 'response.generate'  — 整轮响应
TRACE_SPANS.CONTEXT_SUMMARY  // 'context.summary'    — 上下文摘要生成（消息超窗触发截断时）
TRACE_SPANS.POST_PROCESS     // 'archive.postProcess' — 每轮 chat() 后的归档处理
TRACE_SPANS.DIFFICULTY       // 'round.difficulty'   — 难度分级（预留名）
TRACE_SPANS.REPORT           // 'round.report'       — 汇报闭环（预留名）
```

> 共 **7** 个常量（数量由 `src/agent/__tests__/tracer.test.ts` 锁定）。
>
> **预留名**：`DIFFICULTY` / `REPORT` 内核当前**零 emit 点**——宿主按名建监控面板暂时收不到这两个 span 的数据，不要据此判定链路异常。
>
> **已删除**：`TRACE_SPANS.RECALL`（`'recall.recall'`）与 `TRACE_SPANS.RECALL_ACTUAL`（`'recall.actual'`）已于 **2026-09-11 物理删除**（自动记忆召回退役后无 emit 点，不留幽灵契约）；现行记忆检索耗时看 `TOOL_EXEC`（`search_memories` 工具）。

---

## 十四、工具错误码（ToolErrorCode）

工具执行失败时，错误结果包含 `[ERR:TOOL:code]` 前缀，供 Reflection 逻辑和宿主项目解析。

### 14.1 错误码枚举

| 错误码 | 可重试 | 说明 |
|--------|--------|------|
| `PATH_NOT_ALLOWED` | ❌ | 路径不在白名单内 |
| `FILE_NOT_FOUND` | ✅ | 文件不存在（LLM 可能用错路径） |
| `PERMISSION_DENIED` | ❌ | 权限不足 |
| `ARGUMENT_ERROR` | ✅ | 工具参数错误（LLM 可修正参数格式） |
| `TOOL_TIMEOUT` | ✅ | 工具执行超时 |
| `WRITE_REJECTED` | ❌ | 用户拒绝写入 |
| `DIR_NOT_FOUND` | ✅ | 目录不存在 |
| `UNKNOWN_TOOL` | ❌ | 未知工具 |
| `CUSTOM_TOOL_FAILED` | ✅ | 自定义工具执行失败 |
| `UNKNOWN` | ❌ | 通用错误 |

### 14.2 isRetryableErrorCode()

```typescript
import { ToolErrorCode, isRetryableErrorCode } from '@zooique/memora';

isRetryableErrorCode(ToolErrorCode.FILE_NOT_FOUND);   // true
isRetryableErrorCode(ToolErrorCode.PATH_NOT_ALLOWED);  // false
```

---

## 十五、工具错误反思（Reflection）

> 注：原「内容护栏（Guardrails）」章节已移除——guardrail 是「零规则、无扫描映射、无消费者」的空转链，已随内核摘除（2026-08-17，见 memory-role-pack-boundary.md §4.4）。本章仅保留原 15.3 的有效内容。

当工具执行失败且错误码为 retryable 时，AgentLoop 自动注入 `[REFLECTION_HINT]` 系统消息，引导 LLM 修正参数后重试。默认最多重试 2 次（`maxReflectionRetries`）。

---

## 十六、类型导出

> 以下**精选子集**为宿主最常用的公开导出，全部经 `@zooique/memora` 再导出（无幻影）；未在清单中的其他导出（如 `DuplicateCallInterceptor` / `SessionManager` / `ProviderRouter` / `SummaryType` 等）以 `src/index.ts` 为准。治理报告类型（`DedupReport` / `SourceHealthReport` 等）经方法返回推断，不列为显式导出。

```typescript
// Agent 与流式事件
export { Agent } from '@zooique/memora';
export type {
  AgentChunk,
  ThinkingPhase,
  UIMessages,
  ArchiveMode,
} from '@zooique/memora';
export type {
  AgentOptions,
  AgentContext,
  AgentProjectEntry,
} from '@zooique/memora';
export { type AgentForkResult } from '@zooique/memora';
export type { SessionCheckpoint } from '@zooique/memora';

// 记忆快照与搜索（MemoryInspector）
export type {
  MemorySnapshot,
  WorkingMemorySnapshot,
  BootstrapSnapshot,
  ArchiveSnapshot,
  AgentSearchHit,
  AgentStats,
} from '@zooique/memora';
// 记忆治理统一门面（治理 / 健康度报告类型经方法返回推断，未列为公开显式导出）
export { MemoryGovernance } from '@zooique/memora';
// 文本润色
export type { PolishResult } from '@zooique/memora';
export { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@zooique/memora';

// 工具
export type { ToolDefinition, ToolHandler, ToolContext, WriteExtensions } from '@zooique/memora';
// 网页抓取（搜索→抓取闭环第二段）
export type { IFetchProvider, FetchedPage, FetchOptions } from '@zooique/memora';
export { FetchWebFetchProvider, safeFetch } from '@zooique/memora';
// 代码执行（通用计算底座）
export type { ICodeExecutionProvider, CodeExecutionResult, CodeExecutionOptions } from '@zooique/memora';
export { safeExecuteCode } from '@zooique/memora';

// 作品投影
export type { WorkProjectionEntry } from '@zooique/memora';

// 记忆
export { SOURCE_LABELS } from '@zooique/memora';
export type { Memory } from '@zooique/memora';
export { escapeLike, escapeLikeSnippet, validateSource } from '@zooique/memora';
export type { SourceValidationSeverity } from '@zooique/memora';
export type { IMemoryStorage } from '@zooique/memora';
export { InMemoryStorage } from '@zooique/memora';
// 治理共享常量（提升/上限/下限）
export { BOOST_INCREMENT, SCORE_CEILING, SCORE_FLOOR } from '@zooique/memora';
export type { ISessionStore, SessionMessage } from '@zooique/memora';
export type { ForkResult } from '@zooique/memora';

// 项目注册表 + 锁文件管理
export { ProjectRegistry } from '@zooique/memora';
export type { ProjectEntry } from '@zooique/memora';
export { LockManager } from '@zooique/memora';

// 事件系统
export { TypedEventEmitter } from '@zooique/memora';
export type { AgentEventMap, AgentEventName, AgentEventHandler } from '@zooique/memora';

// 可观测性
export type { ITracer, ISpan, AgentMetrics } from '@zooique/memora';
export { NOOP_TRACER, TRACE_SPANS } from '@zooique/memora';

// 错误码
export { MemoraError, ToolErrorCode, isRetryableErrorCode } from '@zooique/memora';
export { toError } from '@zooique/memora';
export type { ToolErrorCodeValue } from '@zooique/memora';

// 日志
export type { ILogger } from '@zooique/memora';
export { setLogger, logger } from '@zooique/memora';

// 召回（2026-09-10 减法：`recall()` 召回编排 + `RecallOptions` 已退役——
// 唯一消费者是跨重启恢复链的 warmRecall，随之整体下线；记忆检索走 `search_memories` 工具 → `searchByKeyword`）
export { extractKeywords } from '@zooique/memora';

// 网络搜索
export type { IWebSearchProvider, SearchResult, WebSearchOptions, SearchEndpoint } from '@zooique/memora';
export { FetchWebSearchProvider } from '@zooique/memora';

// 角色包
export type { RolePackMeta } from '@zooique/memora';

// 技能
export type { SkillEntry, SkillMatch } from '@zooique/memora';

// LLM
export { createLlmProvider, createProviderFromConfig } from '@zooique/memora';
export type { ProviderConfig } from '@zooique/memora';
export type { LlmProvider, ChatOptions } from '@zooique/memora';
export type { LlmChunk } from '@zooique/memora';

// 配置
export { loadConfig } from '@zooique/memora';
export type { Config } from '@zooique/memora';

// 工具函数
export { segmentText, segmentLower } from '@zooique/memora';
export { parseFrontmatter, serializeFrontmatter } from '@zooique/memora';
export { safeSetTimeout, safeSetInterval, clearSafeTimeout, clearSafeInterval } from '@zooique/memora';
export { isPlainObject } from '@zooique/memora';
export { truncate } from '@zooique/memora';
export { formatDateKey, todayDate } from '@zooique/memora';

// 安全
export type {
  AuditEvent,
  AuditListener,
  Permission,
  WriteDecision,
  WriteConfirmationInfo,
  WriteConfirmationRequest,
} from '@zooique/memora';
```

---

## 十七、安全与约束

### 核心库零越界

| 检查项 | 结论 |
|--------|------|
| 核心库 `console.*` 调用 | 0 处 |
| 核心库 `process.stdin/stdout` | 0 处 |
| 核心库写配置文件 | 0 处 |
| 核心库 `readFileSync/writeFileSync` 写宿主业务文件 | 0 处 |

### 内部数据写入（不越界）

Agent 内部只维护两个状态文件，路径全部由宿主传入的路径推导，内核不假设 `~/.memora/` 一类的用户级默认位置：

- `projects.json`（项目注册表）——落 `dataDir` 内；若显式传了 `registryDir` 则落那里
- `.lock`（项目锁）——固定落 `<projectPath>/.memora/.lock`，**不由 `dataDir` 推导**

---

**版本**：v3.0.0
**配套文档**：[memora-接入指南.md](./memora-接入指南.md)（步骤式教程）
