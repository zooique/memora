# Memora 内核 API 参考手册（v2.1.0）

> **核心定位**：Memora 是一个**无法独立运行**的智能大脑内核——它只有接口，没有"形态"。CLI、WebUI、桌面精灵、小说生成器都是它的"宿主"，宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。
>
> **本文件用途**：列出当前 Agent 对外暴露的**全部公开 API**。
>
> **版本**：v2.1.0（最后更新：2026-08-14，对应内核 v2.1.0）
>
> **1.0.0 之前：核心能力演进**（原内部里程碑 v3.0–v3.3，于 npm 0.2.0 前后完成）：
> - **Agent God Object 拆分（原 v3.0）**：记忆、配置、Insight、工具、角色等方法从 Agent 面类迁移到专职 Manager，通过 `agent.<manager>.xxx()` 访问。详见各章节。
> - **可观测性与护栏（原 v3.1）**：新增 ITracer/ISpan 可观测性接口、ToolErrorCode 错误码、Guardrails 护栏、Reflection 反思机制。
> - **作品投影与配置建议（原 v3.2）**：新增 WorkProjectionManager 作品投影、AutoConfigRefiner 自进化配置建议。
> - **npm 正式包与基础工具（原 v3.3）**：内核发布 v0.2.0（npm 正式包）。Phase 1-4 全部核心完成。新增 EmbeddingProvider、安全定时器（safeSetTimeout/safeSetInterval）、Frontmatter 工具（parseFrontmatter/serializeFrontmatter）、事件系统（TypedEventEmitter）、审计类型（AuditEvent 等）、评估框架（collectAgentChunks/evaluateResult）。
>
> **v1.0.0 变更**：1.0 正式发布。P0 阻塞修复全量收敛：DEFAULT_CONFIG 由 `config/loader.ts` 常量声明单一真理源（不再维护独立 schema）、IVectorStore 接口提取（JsonVectorStore 为内置实现）、AbortSignal 合并工具（mergeSignals）、Logger 懒初始化（移除模块顶层 pino 副作用，改为首次日志调用时 maybeUpgradeToPino 懒触发）、评估框架结构化信号（AgentChunk.guardrailBlocked 替代中文文案匹配）、文档全量对齐（包名 @zooique/memora、config.example.json 补全 providers/embedding 段）。
>
> **v2.0.0 变更**：版本号提升（维护性质，无破坏性 API 变更）。
>
> **v2.0.1 变更**：文档版本号对齐（v1.0.2 → v2.0.1）。无 API 破坏性变更，仅同步文档与版本戳。
>
> **v2.0.3 变更**：npm 发布配置修复与质量加固。新增 `publishConfig.access = "public"`、`exports` 增加 `default` 回退条件、`keywords` 扩充至 18 个。无 API 破坏性变更。
>
> **v2.1.0 变更**：不中断工作模式 v2.0 与 SSOT 修复版本。新增 `IWebSearchProvider` 接口与 `FetchWebSearchProvider` 默认实现，`web_search` 工具条件性暴露；检查点完整性校验与异步恢复；Composer 非中断模式修复。新增 `AgentOptions.webSearchProvider` 注入字段。无 API 破坏性变更。
>
> **v2.1.x 维护修订**（2026-08-14）：用户画像与记忆关系图谱从内核收敛移除。用户画像收敛为 round-summary 的 type=preference 召回方式；关系冲突改用 supersededBy 机制（参考 ADR-014 已废弃）。对应 API 参考章节与导出同步清理。

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
│  │  │  - .persona / .tools / .skills       ││               │
│  │  │  - .config / .insight / .memory      ││               │
│  │  └──────────┬───────────────────────────┘│               │
│  │             │ 委托                         │               │
│  │  ┌──────────┼───────────────────────────┐│               │
│  │  │ PersonaManager / ToolExecutor        ││               │
│  │  │ SkillManager / ConfigManager         ││               │
│  │  │ InsightExtractor / MemoryInspector   ││               │
│  │  └──────────────────────────────────────┘│               │
│  │  ⚠️ 不包含：UI / LLM 配置 / 用户配置模板 │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

**设计原则**：
- **零运行时依赖**（核心层零 npm 运行时依赖；`pino` 为可选 peer 依赖，通过动态 `import('pino')` 懒加载，加载失败时静默降级为内置 console logger；持久化由宿主通过 `IMemoryStorage` 接口注入）
- **零控制台输出**（核心库不调用 `console.*`）
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
| `configDir` | `string` | ❌ | 配置目录（personas/rules/skills） |
| `dataDir` | `string` | ❌ | 记忆数据目录（默认 ~/.memora） |
| `registryDir` | `string` | ❌ | 项目注册表目录（默认与 dataDir 相同） |
| `maxContextTokens` | `number` | ❌ | 上下文窗口上限（默认 120000） |
| `persona` | `string` | ❌ | 默认角色名 |
| `permission` | `'owner' \| 'guest'` | ❌ | 安全权限（默认 'owner'） |
| `allowedPaths` | `string[]` | ❌ | 路径白名单（默认 [] = 全部允许） |
| `confirmWrites` | `boolean` | ❌ | 写入确认（默认 false） |
| `storage` | `IMemoryStorage` | ❌ | 存储层注入（默认 InMemoryStorage） |
| `vectorStore` | `IVectorStore` | ❌ | 向量存储接口（提供时启用语义搜索召回；内置实现 JsonVectorStore） |
| `recallExcludeSources` | `string[]` | ❌ | 召回时排除的 source 标签（默认 `['persona', 'rule', 'skill']`，设定记忆不参与语义召回，双重防御） |
| `sessionStore` | `ISessionStore` | ❌ | 会话存储注入 |
| `tracer` | `ITracer` | ❌ | 可观测性 Tracer 注入（不传则使用 NoopTracer 静默丢弃所有 span） |
| `messages` | `UIMessages` | ❌ | 宿主可覆盖的 UI 消息文本（默认英文，宿主覆盖为中文等） |
| `enableContextSummary` | `boolean` | ❌ | 上下文超限时是否自动生成摘要（默认 true，开启后首次截断时增加 ~1-2s 延迟） |
| `archiveMode` | `ArchiveMode` | ❌ | 归档模式（ADR-015，默认 `'full'`）。`'full'`：会话内容在会话切换前自动归档；`'manual'`：全部需手动触发（2026-08-14 洞察层移除后三态收敛为二态，原 `'insights-only'` 已移除） |
| `webSearchProvider` | `IWebSearchProvider` | ❌ | 网络搜索提供者注入（提供时自动暴露 `web_search` 工具给 LLM，不传则不暴露） |

> **Logger 注入方式**：v1.0 起 `AgentOptions` 不再含 `logger` 字段。日志通过全局 `setLogger(customLogger)` 注入（详见 §十七 类型导出），pino 升级为懒初始化（首次日志调用时触发，import 零副作用）。

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
| `agent.persona` | `PersonaManager \| null` | 角色管理 |
| `agent.tools` | `ToolExecutor \| null` | 工具注册与执行 |
| `agent.skills` | `SkillManager \| null` | 技能匹配与注入 |
| `agent.config` | `ConfigManager \| null` | 规则/技能注入 + 配置建议 |
| `agent.insight` | `InsightExtractor \| null` | 输入分类 + 记忆提取 |
| `agent.memory` | `MemoryInspector \| null` | 记忆查询 + 写入（`writeXxx` 前缀） |
| `agent.works` | `WorkProjectionManager \| null` | 作品投影（工作内容摘要） |
| `agent.polish` | `TextPolishManager \| null` | 文本润色（LLM 语法修正 + 表达优化） |

> **读写统一入口**：`agent.memory`（MemoryInspector）同时负责记忆的查询与写入——只读方法（snapshot/search/searchHybrid/stats/list/getById/getBySource/listDeleted 等）与写方法（`writeXxx` 前缀：writeUpsert/writeDelete/writeRestore/writePurge/writePurgeExpired/writeBoost）。旧的 `memoryMutator`/`MemoryMutator` 拆分已在后续迭代中合并回 `MemoryInspector`，二者均不再存在。

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
| `dbPath` | `string` | memora.db 路径 |
| `fileStore` | `FileStore` | 文件存储 |
| `index` | `IMemoryStorage` | 记忆存储接口 |
| `security` | `SecurityGuard` | 安全守卫 |
| `bootstrapMemories` | `Memory[]` | 启动时加载的必召记忆 |
| `loadResult` | `LoadResult` | 加载结果（成功数 / 失败数） |

### 2.7 事件订阅（`agent.on()` / `agent.off()` / `agent.once()`）

Agent 继承 `TypedEventEmitter<AgentEventMap>`，向宿主项目广播对话外事件。

```typescript
agent.on<K extends AgentEventName>(event: K, handler: (payload: AgentEventMap[K]) => void): void
agent.off<K extends AgentEventName>(event: K, handler: (payload: AgentEventMap[K]) => void): void
agent.once<K extends AgentEventName>(event: K, handler: (payload: AgentEventMap[K]) => void): void
```

| 事件名 | 载荷 | 触发时机 |
|--------|------|----------|
| `memoryAdded` | `{ id, source, name }` | 记忆被写入存储（insight 提取、rule 注入等） |
| `personaSwitched` | `{ from: string \| null, to }` | 角色被切换（自动匹配或手动指定） |
| `decayCompleted` | `{ decayedCount }` | 记忆衰减完成（init 首次 + 每小时定时） |
| `memoryRecalled` | `{ count, query }` | 记忆被召回（用于 UI 展示） |
| `sessionForked` | `{ from, to, messageCount }` | 会话被分叉（创建新分支） |
| `insightExtracted` | `{ source: string; insight: string }` | 洞察被提取 |
| `projectSwitched` | `{ from: string \| null, to: string, projectName: string }` | 项目切换（宿主 UI 可据此刷新项目相关界面） |
| `skillMatched` | `{ skill: string, score: number }` | 技能被匹配（宿主 UI 可据此展示当前激活技能） |
| `archiveFailed` | `{ stage: 'insight' \| 'content'; message: string }` | 归档操作失败（任一阶段失败，fire-and-forget catch 分支发射，宿主可通知用户） |

```typescript
// 使用示例
agent.on('memoryAdded', (e) => console.log(`新记忆: ${e.source}:${e.name}`));
agent.on('decayCompleted', (e) => console.log(`衰减 ${e.decayedCount} 条记忆`));
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
  | { type: 'recall'; memories: RecalledMemorySummary[] }  // 记忆召回（携带摘要列表）
  | { type: 'thinking'; phase: ThinkingPhase }             // 推理阶段
  | { type: 'text'; content: string; guardrailBlocked?: boolean }  // LLM 文本片段（护栏阻断时 guardrailBlocked=true）
  | { type: 'tool_start'; toolCallId: string; name: string; args?: string }   // 工具调用开始
  | { type: 'tool_result'; toolCallId: string; name: string; ok: boolean; summary?: string }  // 工具调用结果
  | { type: 'aborted'; reason: string }                    // 对话被取消
  | { type: 'error'; message: string }                     // 流式过程中发生错误（LLM 超时/连接断开）
  | { type: 'retry'; attempt: number; maxRetries: number; delayMs: number; error: string }  // 指数退避重试
  | { type: 'done' };                                      // 结束标记
```

`ThinkingPhase` 取值：`'recalling' | 'processing' | 'archiving'`

#### `RecalledMemorySummary` 类型（recall chunk 载荷）

仅暴露 UI 展示所需字段，不包含 `content`（避免向 UI 层泄露完整记忆内容）：

```typescript
interface RecalledMemorySummary {
  id: string;       // 记忆唯一标识（source:name 格式，用于前端精准跳转详情）
  name: string;     // 记忆可读名称（点击跳转记忆详情用）
  score: number;    // 相似度分数（0-1）
  source: string;   // 来源标签（开放字符串，如 'rule'、'insight'、'work-projection'）
}
```

> **guardrailBlocked 结构化信号**：v1.0 起用结构化字段替代中文文案匹配，eval 框架和宿主 UI 可通过 `chunk.guardrailBlocked === true` 判断护栏触发，无需依赖文案子串匹配。

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
| 第 3 层 | `snapshot.archive` | `ArchiveSnapshot` — 归档记忆计数（insight + work-projection）+ 当前会话信息 |

```typescript
interface MemorySnapshot {
  working: WorkingMemorySnapshot;
  bootstrap: BootstrapSnapshot;
  archive: ArchiveSnapshot;
}
```

### 4.2 `search(query, limit?)` — 记忆搜索

```typescript
agent.memory.search(query: string, limit?: number): AgentSearchHit[]
```

```typescript
interface AgentSearchHit {
  id: string;             // 记忆唯一标识（source:name 格式，供 showMemory/deleteMemory 等操作使用）
  name: string;           // 记忆名称
  source: string;         // 来源标签
  score: number;          // 权重（0-1）
  contentPreview: string; // 内容预览（截断到 120 字符）
  similarity?: number;    // 语义相似度（0-1，仅 searchHybrid 返回；纯关键词搜索时无此字段）
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

### 4.5 写入方法（P1-2 合并回 MemoryInspector）

记忆的写入统一收口在 `agent.memory`，写方法以 `writeXxx` 前缀命名（同步返回、不调 LLM、不触发异步 IO）：

```typescript
// ─── 写入（writeXxx 前缀） ───
agent.memory.writeUpsert(memory: Memory): void;                 // 插入或更新记忆
agent.memory.writeBoost(id: string, increment?: number): boolean; // 提升 score（用户采纳反哺，默认 +0.05）
agent.memory.writeDelete(id: string): void;                    // 软删除（写入 deletedAt）
agent.memory.writeRestore(id: string): void;                   // 恢复软删除
agent.memory.writePurge(id: string): void;                     // 物理删除（不可恢复）
agent.memory.writePurgeExpired(before: Date): number;          // 清理过期回收站

// ─── 只读扩展查询 ───
agent.memory.list(limit?: number): Memory[];                   // 列出所有记忆（按 score 降序）
agent.memory.getById(id: string): Memory | null;               // 按 ID 获取活跃记忆
agent.memory.getBySource(source: string): Memory[];            // 按 source 获取
agent.memory.listDeleted(limit?: number): Memory[];            // 回收站（软删除记忆）
agent.memory.getDeletedById(id: string): Memory | null;
agent.memory.searchHybrid(query: string, limit?: number): Promise<AgentSearchHit[]>; // 语义 + 关键词双通道
```

> **注意**：`suggest()` / `sourceHealth()` 已上移至 Agent 层（`agent.suggest()` / `agent.sourceHealth()`），不再挂在 `agent.memory` 下，避免经 MemoryInspector 转发产生多余代理层。

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
  score: number;      // 权重（0-1，召回时用于排序）
  deletedAt?: string; // 软删除时间（ISO 8601，可选；非 undefined 表示已软删除，回收站保留 30 天后自动物理清理）
  metadata?: Record<string, string>; // 配置文件 frontmatter 额外元数据（仅配置文件写入时使用，SQLite 不存储此字段）
}
```

> **8 字段基元**（v2.1 软删除扩展）：7 个基础字段 + 1 个可选 `deletedAt`。所有查询方法（getById/getBySource/search/count/countBySource/decayScores/getAllSources）自动过滤 `deletedAt != undefined` 的记忆。详见 ADR-004 GAP-6 + ADR-002 §IMemoryStorage。

**常用 source 标签（`SOURCE_LABELS` 常量）：**

| 常量 | 值 | 用途 |
|------|----|------|
| `SOURCE_LABELS.PERSONA` | `'persona'` | 角色人格 |
| `SOURCE_LABELS.RULE` | `'rule'` | 创作规则 |
| `SOURCE_LABELS.SKILL` | `'skill'` | 技能定义 |
| `SOURCE_LABELS.INSIGHT` | `'insight'` | 对话洞察 |
| `SOURCE_LABELS.PROFILE` | `'profile'` | 用户画像 |
| `SOURCE_LABELS.WORK_PROJECTION` | `'work-projection'` | 作品投影 |
| `SOURCE_LABELS.GUARDRAIL` | `'guardrail'` | 内容护栏规则 |

> source 是开放字符串，宿主可自定义新标签。`validateSource()` 可检测常见 typo（基于 Levenshtein 距离）。

### 5.2 `IMemoryStorage` 接口

宿主实现此接口注入 Agent，替代默认的 `InMemoryStorage`。共 **15 方法**（含可选 `close`），所有方法同步（与 better-sqlite3 API 对齐，`await` 同步值安全）。所有查询方法自动过滤已软删除的记忆（`deletedAt != undefined`）。

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
  listDeleted(limit?: number): Memory[];        // 列出回收站（按 deletedAt 降序，默认 50）
  getDeletedById(id: string): Memory | null;    // 按 ID 获取单条软删除记忆（restore/purge 前存在性校验）
  purgeExpired(before: Date): number;           // 清理过期回收站（物理删除 deletedAt 早于 before 的，返回清理数量）

  // ─── 统计与维护（2 方法） ───
  decayScores(sources: string[], now: Date): number;  // 批量衰减指定 source 的 score（宿主实现批量 SQL UPDATE）
  getAllSources(): Map<string, number>;               // 获取所有 source 标签及其活跃记忆数量

  // ─── 可选（1 方法） ───
  close?(): void;
}
```

> 宿主实现应使用 `COUNT(*)` / `UPDATE ... WHERE` 等数据库原生操作，避免全量加载数据。`decayScores` 和 `getAllSources` 是性能优化方法，避免逐条遍历。详见 ADR-002 §IMemoryStorage 接口方法。

### 5.3 `ISessionStore` 接口

宿主实现此接口提供会话消息的持久化能力。

```typescript
interface ISessionStore {
  appendMessage(date: string, session: string, message: SessionMessage): void;
  loadMessages(date: string, session: string): SessionMessage[];
  listSessions(): string[];
  copySession?(sourceDate: string, sourceSession: string, targetDate: string, targetSession: string): void;
}
```

**`copySession` 实现要求**：
- 原子操作：要么全部复制成功，要么不产生副作用
- 保留时间戳：消息的 timestamp 不修改
- 幂等：若目标会话已存在，覆盖（而非追加）
- 若源会话不存在，静默返回（不抛出）

---

## 六、项目 / 会话管理

> **方法归属**（v1.0 P1-4 拆分后）：项目相关方法在 `agent.projects`（ProjectManager），会话相关方法在 `agent.sessionManager`（SessionManager），仅 `switchProject` / `rebuildComponents` / `forkSession` 保留在 Agent 面类作为常用入口。

> **switch* 返回值约定**：各 switch 操作返回与其操作语义最匹配的值 ——
> `switchSession` 返回新会话名（string）、`switchProject` 返回完整项目上下文（AgentContext，含 bootstrap 记忆等）、
> `personaManager.switchPersona` 返回 system prompt 文本（string）。这是设计性差异，非 bug。

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
| `sessionManager.restoreMostRecentSession(preferredSession='main')` → `Promise<number>` | 启动时恢复最近一次会话 |
| `sessionManager.restoreSession(date, session)` → `Promise<number>` | 恢复指定日期/会话 |
| `sessionManager.createCheckpoint(mainGoal?)` → `SessionCheckpoint \| null` | 创建当前会话检查点（含热记忆、目标、计划、状态机快照），首次调用返回完整检查点，后续调用合并增量 |
| `sessionManager.restoreFromCheckpoint(checkpoint)` → `Promise<number>` | 从检查点恢复会话（恢复消息历史、状态机状态、截断时注入提示消息） |
| `sessionManager.getCheckpoint()` → `SessionCheckpoint \| null` | 获取当前检查点（只读，不修改状态） |

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

## 七、角色管理（`agent.persona` · PersonaManager）

> Manager 访问路径：`agent.persona.xxx`。`init()` 前返回 `null`。

| 成员 | 类型 | 说明 |
|------|------|------|
| `persona.list` | `Persona[]`（getter） | 所有可用角色列表 |
| `persona.activeName` | `string`（getter） | 当前激活的角色名 |
| `persona.currentMode` | `PersonaMode`（getter） | 当前匹配模式（`'auto'` / `'manual'`） |
| `persona.active` | `Persona \| null`（getter） | 当前激活的完整角色对象 |
| `persona.switchPersona(name)` | 方法 → `string` | 手动切换到指定角色（返回新角色的 system prompt） |
| `persona.setMode(mode)` | 方法 | 设置匹配模式（`'auto'` / `'manual'`） |

```typescript
// 使用示例
const names = agent.persona.list.map(p => p.name);  // 列出角色
agent.persona.switchPersona('作家');                  // 切换角色
agent.persona.setMode('manual');                      // 锁定手动模式
console.log(agent.persona.activeName);                // 当前角色名
console.log(agent.persona.currentMode);               // 当前模式
```

---

## 八、工具注册（`agent.tools` · ToolExecutor + `agent.insight`）

> 工具注册/执行走 `agent.tools.xxx()`，写入扩展/记忆关键词走 `agent.insight.xxx()`。

### 8.1 内置工具（5 个）

| 工具名 | 用途 | 参数 |
|--------|------|------|
| `read_file` | 读取项目内文件内容 | `path` |
| `write_file` | 写入/创建文件（支持 overwrite/append/insert 三种模式） | `path`, `content`, `mode?`, `insert_line?` |
| `list_dir` | 列出目录内容（递归深度 ≤ 3） | `path?`, `recursive?`, `maxDepth?` |
| `search_memories` | 在记忆索引中搜索（支持 match/near 两种模式） | `query`, `limit?`, `mode?` |
| `web_search` | 搜索互联网（条件性暴露，仅在注入 `IWebSearchProvider` 时可用） | `query`, `limit?` |

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
> 内核提供 `FetchWebSearchProvider` 作为基于 DuckDuckGo HTML 的零依赖默认实现。

```typescript
// 搜索结果
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// 搜索选项
interface WebSearchOptions {
  limit?: number;  // 返回结果数量上限（默认 5）
}

// 网络搜索提供者接口
interface IWebSearchProvider {
  search(query: string, options?: WebSearchOptions): Promise<SearchResult[]>;
}

// 注入方式
const agent = new Agent({
  // ... 其他选项
  webSearchProvider: new FetchWebSearchProvider(), // 使用内置默认实现
});
```

### 8.4 `agent.insight` — InsightExtractor（写入扩展 + 关键词）

| 方法 | 用途 |
|------|------|
| `insight.setWriteExtensions(ext)` | 注入写入扩展回调（diff 对比确认） |
| `insight.setKeywords(keywords)` | 设置记忆关键词（domain / personal 两类） |
| `insight.classify(input)` → `'skip' \| 'extract'` | 输入分类（判断是否需要提取记忆） |
| `insight.extract(userInput, assistantContent)` | 异步提取对话 insight（fire-and-forget） |

```typescript
// 写入扩展回调
agent.insight.setWriteExtensions({
  onBeforeWrite: async (path, before, after) => {
    // 展示 diff，返回 true 允许写入 / false 拒绝
    return confirmDialog(`确认写入 ${path}？`);
  },
});

// 记忆关键词（用于输入分类 Layer 2）
agent.insight.setKeywords({
  domain: ['主角', '角色', '情节', '设定'],   // 领域关键词
  personal: ['我', '我的', '记住', '帮我'],    // 用户专属关键词
});
```

---

## 九、规则与技能注入（`agent.config` · ConfigManager）

> Manager 访问路径：`agent.config.xxx()`。`init()` 前返回 `null`。

### 9.1 规则注入

| 方法 | 用途 | 写到哪里 |
|------|------|----------|
| `config.addRule(memory)` | 添加规则（需 `source='rule'`） | SQLite + System Prompt |
| `config.addSimpleRule(name, content)` | 同上，简化版（自动填充字段） | SQLite + System Prompt |

```typescript
// 注入规则
await agent.config.addSimpleRule(
  '世界观规则',
  '这是一个东方玄幻世界，修真等级分为炼气、筑基、金丹……',
);
```

### 9.2 技能注入

| 方法 | 用途 | 写到哪里 |
|------|------|----------|
| `config.addSkill(memory)` | 添加技能（需 `source='skill'`，session-only） | SkillManager |
| `config.addSimpleSkill(name, content, keywords?)` | 同上，简化版（session-only） | SQLite + SkillManager |

```typescript
// 注入技能（session-only，注入 SkillManager 内存缓存，重启后丢失）
await agent.config.addSimpleSkill(
  '大纲生成',
  '当用户说“生成大纲”时，按三幕结构生成章节大纲……',
  ['大纲', '结构', '章节'],  // 可选：触发关键词
);

// 如需跨会话持久化，写入配置文件
await agent.config.confirmConfigSuggestion({
  type: 'skill',
  name: '大纲生成',
  content: '当用户说“生成大纲”时……',
  confidence: 0.9,
});
```

### 9.3 配置建议（模式 3：AutoConfigRefiner 自进化）

Agent 在对话后自动分析用户输入和助手回复，提取潜在的配置建议（规则/角色/技能），通过回调通知宿主。这是"三种接入模式"中的模式 3（Agent 智能总结接口）。

#### `AutoConfigRefinerOptions` 配置

```typescript
interface AutoConfigRefinerOptions {
  minConfidence?: number;   // 最低置信度阈值（0-1），低于此值的建议被丢弃（默认 0.6）
  maxSuggestions?: number;  // 单次对话最大建议数（默认 3）
}
```

#### 工作流程

```
对话结束 → Agent.postProcess 异步调用 autoConfigRefiner.analyze()
  → 有后台 Provider：LLM 分析提取建议
  → 无后台 Provider：启发式规则降级提取
  → 短对话（<20 字）跳过
  → 通过 onConfigSuggestion 回调通知 ConfigManager
  → ConfigManager 转发给宿主注册的 handler
  → 宿主 UI 展示建议卡片
  → 用户确认 → config.confirmConfigSuggestion() 写入配置文件
```

#### `config` 公开方法

| 方法 | 用途 |
|------|------|
| `config.onConfigSuggestion(handler)` | 注册配置建议回调（宿主 UI 展示建议卡片） |
| `config.confirmConfigSuggestion(suggestion)` | 确认建议，写入配置文件（持久化） |

#### `ConfigSuggestion` 类型

```typescript
interface ConfigSuggestion {
  type: 'rule' | 'persona' | 'skill';
  name: string;
  content: string;
  confidence: number;  // 0-1
  source: string;      // 建议来源描述
}
```

**双写机制**：
- `config.addRule()` → 写 SQLite（会话级，临时）
- `config.addSkill()` → 写 SQLite + SkillManager（session-only，运行时注入）
- `config.confirmConfigSuggestion()` → 写配置文件（真理源，重启后自动加载，适用于 rule/persona/skill 三种类型）

> **降级策略**：无后台 Provider 时，AutoConfigRefiner 使用启发式规则提取建议（非 LLM），建议质量较低但仍可用。单条建议回调失败时记日志并继续处理下一条，避免一条失败导致后续全部丢失。

---

## 十、作品投影（`agent.works` · WorkProjectionManager）

作品投影是文件内容的轻量级摘要（50-100 字概要 + 结构 + 关键决策），存储在 SQLite 中供 Agent 快速召回，避免每次对话都读取完整文件。原始文件内容不进 SQLite，Agent 通过工具按需读取。

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
| `agent.works.loadAll()` | 加载所有作品投影（按 source 标签 `'work-projection'` 召回） |

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

## 十一、Provider 管理

| 方法 | 用途 |
|------|------|
| `setProvider(provider)` | 运行时切换前台 Provider |
| `setBackgroundProvider(provider)` | 运行时切换后台 Provider |

Agent 不再管理 Provider 映射表，宿主自行管理。

---

## 十二、内部调试

> v1.0 起已移除 `getBuildCtx()` 和 `inspect()` 方法。宿主项目可通过以下渠道观察内核状态：
>
> - **事件系统**（§2.7）：订阅 `memoryAdded` / `memoryRecalled` / `skillMatched` 等事件获取运行时动态
> - **可观测性 Tracer**（§十四）：注入 `ITracer` 实现获取 AgentLoop 关键 span（RECALL / LLM_CALL / TOOL_EXEC / RESPONSE）
> - **`agent.memory.snapshot()`**（§4.1）：获取 3 层记忆快照（working / bootstrap / archive）
> - **`agent.agentLoop.getMessages()`**（§4.4）：获取工作记忆原始消息列表

---

## 十三、完整 API 一览

### Agent 面类直接方法

| 分组 | 方法 |
|------|------|
| 生命周期 | `init(projectPathOverride?)` / `close()` |
| 对话 | `chat(input, signal?)` / `chatSync(input, signal?)` / `forceReleaseChatLock()` |
| 事件 | `on()` / `off()` / `once()`（继承自 TypedEventEmitter） |
| 项目 / 会话 | `switchProject(nameOrPath)` / `rebuildComponents()` / `forkSession(targetSession?)` |
| Provider | `setProvider(provider)` / `setBackgroundProvider(provider)` |
| 归档模式 | `setArchiveMode(mode)` / `getArchiveMode()` |
| 角色 | `switchPersona(name)` / `getPersonaSwitchLockStatus()` / `injectAffect(affectString)` |
| 手动归档 | `archiveInsight(input, assistantContent, options?)` / `archiveSessionContent(date, session, options?)` |
| 配置热更新 | `reloadConfig(source?)` |
| 记忆治理 | `deduplicateMemories(signal?)` / `evaluateTimeliness(signal?)` / `runMemoryDecayOnce()` / `sourceHealth()` / `suggest(query?, options?)` / `detectConflicts(signal?)` |
| 指标 | `getMetrics()` |

### Agent 面类只读访问器

`initialized` / `context` / `provider` / `isBusy` / `lastInteractionAt` / `agentLoop` / `agentHistory` / `projects` / `security` / `sessionManager` / `persona` / `tools` / `skills` / `config` / `insight` / `memory` / `works` / `polish`

### 各 Manager / 组件公开成员

| 访问器 | 类型 | 公开成员 |
|---------|---------|---------|
| `agent.persona` | `PersonaManager` | `.list` / `.activeName` / `.currentMode` / `.active` / `.switchPersona()` / `.setMode()` |
| `agent.tools` | `ToolExecutor` | `.list` / `.registerTool()` / `.execute()` |
| `agent.skills` | `SkillManager` | `.list` / `.match()` / `.register()` / `.buildSystemPrompt()` |
| `agent.config` | `ConfigManager` | `.addRule()` / `.addSimpleRule()` / `.addSkill()` / `.addSimpleSkill()` / `.onConfigSuggestion()` / `.confirmConfigSuggestion()` |
| `agent.insight` | `InsightExtractor` | `.classify(input)` / `.extract(userInput, assistantContent)` / `.setKeywords(keywords)` / `.setWriteExtensions(ext)` |
| `agent.memory` | `MemoryInspector` | 读：`.snapshot()` / `.search()` / `.searchHybrid()` / `.stats()` / `.list()` / `.getById()` / `.getBySource()` / `.listDeleted()`；写：`.writeUpsert()` / `.writeBoost()` / `.writeDelete()` / `.writeRestore()` / `.writePurge()` / `.writePurgeExpired()` |
| `agent.works` | `WorkProjectionManager` | `.ensureProjection(filePath, content, fileName?)` / `.getProjection(filePath)` / `.loadAll()` |
| `agent.polish` | `TextPolishManager` | `.polish(...)`（文本润色：LLM 语法修正 + 表达优化） |

> **说明**：`suggest()` / `sourceHealth()` 现为 Agent 层方法（`agent.suggest()` / `agent.sourceHealth()`），不再挂在 `agent.memory` 下。旧的 `memoryMutator` 访问器与 `MemoryMutator` 类已合并回 `MemoryInspector`，请勿再使用。

---

## 十四、可观测性（ITracer / ISpan）

Memora 内置轻量 Span/Trace 抽象，宿主注入实现后可观测 AgentLoop 行为。

### 14.1 ITracer 接口

```typescript
interface ITracer {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan;
}
```

### 14.2 ISpan 接口

```typescript
interface ISpan {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
  recordException(error: Error): void;
}
```

### 14.3 NoopTracer（默认实现）

```typescript
import { NOOP_TRACER } from '@zooique/memora';

// 不注入 tracer 时自动使用 NOOP_TRACER，零运行时开销
// NOOP_TRACER.startSpan() 返回共享的 NoopSpan 单例，所有方法为空操作
```

### 14.4 TRACE_SPANS 常量

```typescript
import { TRACE_SPANS } from '@zooique/memora';

TRACE_SPANS.RECALL     // 'recall.recall'    — 记忆召回阶段
TRACE_SPANS.LLM_CALL   // 'llm.call'         — LLM API 调用
TRACE_SPANS.TOOL_EXEC  // 'tool.execute'     — 工具执行
TRACE_SPANS.RESPONSE   // 'response.generate' — 整轮响应
```

---

## 十五、工具错误码（ToolErrorCode）

工具执行失败时，错误结果包含 `[ERR:TOOL:code]` 前缀，供 Reflection 逻辑和宿主项目解析。

### 15.1 错误码枚举

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

### 15.2 isRetryableErrorCode()

```typescript
import { ToolErrorCode, isRetryableErrorCode } from '@zooique/memora';

isRetryableErrorCode(ToolErrorCode.FILE_NOT_FOUND);   // true
isRetryableErrorCode(ToolErrorCode.PATH_NOT_ALLOWED);  // false
```

---

## 十六、内容护栏（Guardrails）

### 16.1 护栏规则格式

护栏规则以 `source: "guardrail"` 记忆形式存储，放在 `configDir/rules/guardrails/` 目录下：

```markdown
---
name: 禁止执行代码
source: guardrail
---

pattern: /执行|运行|eval|exec/
action: block
```

### 16.2 护栏行为

- **输入护栏**：用户输入注入上下文前检查，命中 `block` 时阻断对话
- **输出护栏**：LLM 响应返回用户前检查，命中 `block` 时替换输出
- **降级策略**：护栏自身异常时降级为"放行 + 记日志"，永远不阻断对话

### 16.3 工具错误反思（Reflection）

当工具执行失败且错误码为 retryable 时，AgentLoop 自动注入 `[REFLECTION_HINT]` 系统消息，引导 LLM 修正参数后重试。默认最多重试 2 次（`maxReflectionRetries`）。

---

## 十七、类型导出

> 以下导出与 `src/index.ts` 完全对齐（v2.0.3）。`RecalledMemorySummary` 已在 P1-1 补齐导出。

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
export type { RecalledMemorySummary } from '@zooique/memora';
export type { SessionCheckpoint } from '@zooique/memora';

// 记忆快照与搜索（MemoryInspector）
export type {
  MemorySnapshot,
  WorkingMemorySnapshot,
  BootstrapSnapshot,
  ArchiveSnapshot,
  AgentSearchHit,
  AgentStats,
  SuggestOptions,
  SuggestHit,
  SourceHealthStatus,
  SourceHealthEntry,
  SourceHealthReport,
} from '@zooique/memora';
// 记忆治理 / 健康度（Agent 层方法返回的报告类型）
export type { DedupPair, DedupVerdict, DedupVerdictSummary, DedupReport } from '@zooique/memora';
export type { TimelinessVerdict, TimelinessReport } from '@zooique/memora';
export type { ConflictVerdict, ConflictReport } from '@zooique/memora';
// 记忆治理统一门面
export { MemoryGovernance } from '@zooique/memora';
// 文本润色
export type { PolishResult } from '@zooique/memora';
export { AGENT_CONSTANTS, LOOP_CONSTANTS } from '@zooique/memora';

// 工具
export type { ToolDefinition, ToolHandler, ToolContext, WriteExtensions } from '@zooique/memora';

// 配置建议
export type { ConfigSuggestion, ConfigSuggestionHandler } from '@zooique/memora';

// Insight
export type { MemoryKeywords } from '@zooique/memora';
export type { ConflictInfo } from '@zooique/memora';

// 会话归档
export type { SessionArchiveResult } from '@zooique/memora';
// 作品投影
export type { WorkProjectionEntry } from '@zooique/memora';
// AutoConfigRefiner
export type { AutoConfigRefinerOptions } from '@zooique/memora';

// 记忆
export { SOURCE_LABELS } from '@zooique/memora';
export type { Memory } from '@zooique/memora';
export { inferSource, escapeLike, validateSource } from '@zooique/memora';
export type { SourceValidationSeverity } from '@zooique/memora';
export type { IMemoryStorage } from '@zooique/memora';
export { InMemoryStorage } from '@zooique/memora';
// 治理共享常量（衰减/提升/上限）
export { BOOST_INCREMENT, SCORE_CEILING, DECAY_FLOOR, DECAY_AGE_DAYS, DECAY_AMOUNT } from '@zooique/memora';
export type { ISessionStore, SessionMessage } from '@zooique/memora';
export type { ForkResult } from '@zooique/memora';

// 项目注册表 + 锁文件管理（P1-4 拆分）
export { ProjectRegistry } from '@zooique/memora';
export type { ProjectEntry } from '@zooique/memora';
export { LockManager } from '@zooique/memora';

// 向量存储
export { JsonVectorStore } from '@zooique/memora';
export type { IVectorStore, EmbeddingService } from '@zooique/memora';
export { EmbeddingProvider } from '@zooique/memora';
export type { EmbeddingConfig, EmbeddingResult, EmbeddingOptions } from '@zooique/memora';

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

// 召回
export { recall, extractKeywords } from '@zooique/memora';
export type { RecallOptions } from '@zooique/memora';

// 网络搜索
export type { IWebSearchProvider, SearchResult, WebSearchOptions } from '@zooique/memora';
export { FetchWebSearchProvider } from '@zooique/memora';

// 角色
export type { PersonaMode, Persona } from '@zooique/memora';

// 技能
export type { SkillEntry, SkillMatch } from '@zooique/memora';

// LLM
export { createLlmProvider, createProviderFromConfig } from '@zooique/memora';
export type { ProviderConfig } from '@zooique/memora';
export type { LlmProvider, ChatOptions } from '@zooique/memora';
export type { LlmChunk } from '@zooique/memora';
export { OpenAICompatibleProvider } from '@zooique/memora';
export type { OpenAICompatibleConfig } from '@zooique/memora';

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

// 评估
export type { EvalScenario, EvalExpectation, EvalResult } from '@zooique/memora';
export { collectAgentChunks, evaluateResult } from '@zooique/memora';
export { EVAL_SCENARIOS, EvalRunner } from '@zooique/memora';
export type { EvalRunnerOptions, EvalSummary } from '@zooique/memora';
```

---

## 十八、安全与约束

### 核心库零越界

| 检查项 | 结论 |
|--------|------|
| 核心库 `console.*` 调用 | 0 处 |
| 核心库 `process.stdin/stdout` | 0 处 |
| 核心库写配置文件 | 0 处 |
| 核心库 `readFileSync/writeFileSync` 写宿主业务文件 | 0 处 |

### 内部数据写入（不越界）

Agent 内部维护 `projects.json`（项目注册表）和 `.lock`（项目锁），路径在 `~/.memora/`，属于 Agent 自己的状态管理。

---

**版本**：v2.1.0
**最后更新**：2026-08-14
**配套文档**：[memora-接入指南.md](./memora-接入指南.md)（步骤式教程）
