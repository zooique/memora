# Memora 内核 API 参考手册（v3.0）

> **核心定位**：Memora 是一个**无法独立运行**的智能大脑内核——它只有接口，没有"形态"。CLI、WebUI、桌面精灵、小说生成器都是它的"宿主"，宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。
>
> **本文件用途**：列出当前 Agent 对外暴露的**全部公开 API**。
>
> **版本**：v3.0（最后更新：2026-06-12）
>
> **v3.0 重大变更**：Agent God Object 拆分。记忆、配置、Insight、工具、角色等方法从 Agent 面类迁移到专职 Manager，通过 `agent.<manager>.xxx()` 访问。详见各章节。

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
- **零 native 依赖**（核心层仅依赖 `zod`；持久化由宿主通过 `IMemoryStorage` 接口注入）
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
| `vectorStore` | `VectorStore` | ❌ | 向量存储（提供时启用语义搜索召回） |
| `recallExcludeSources` | `string[]` | ❌ | 召回时排除的 source 标签（默认 `['persona', 'rule', 'skill']`，引导记忆不被召回） |
| `sessionStore` | `ISessionStore` | ❌ | 会话存储注入 |
| `logger` | `ILogger` | ❌ | 日志注入 |

### 2.2 生命周期方法

| 方法 | 用途 |
|------|------|
| `new Agent(opts)` | 构造函数（无副作用，不连接 LLM） |
| `init(projectPathOverride?)` → `Promise<ProjectContext>` | 初始化：建立存储、加载配置、组装组件 |
| `close()` | 关闭：释放项目锁、关闭数据库 |

### 2.3 Agent 只读访问器

| 访问器 | 类型 | 说明 |
|--------|------|------|
| `agent.initialized` | `boolean` | 是否已初始化 |
| `agent.context` | `AgentContext \| null` | 当前项目上下文 |
| `agent.provider` | `LlmProvider` | 当前前台 Provider |
| `agent.isBusy` | `boolean` | 是否正在对话中 |
| `agent.lastInteractionAt` | `Date \| null` | 最近一次 `chat()` 调用时间 |

### 2.4 Manager 访问器（委托模式）

v3.0 起，Agent 通过 6 个 getter 暴露专职 Manager。详见后续章节。

| 访问器 | 类型 | 职责 |
|--------|------|------|
| `agent.persona` | `PersonaManager \| null` | 角色管理 |
| `agent.tools` | `ToolExecutor \| null` | 工具注册与执行 |
| `agent.skills` | `SkillManager \| null` | 技能匹配与注入 |
| `agent.config` | `ConfigManager \| null` | 规则/技能注入 + 配置建议 |
| `agent.insight` | `InsightExtractor \| null` | 输入分类 + 记忆提取 |
| `agent.memory` | `MemoryInspector \| null` | 记忆快照 + 搜索 + 统计 |

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

### 2.7 事件订阅（`agent.on()` / `agent.off()`）

Agent 继承 `TypedEventEmitter<AgentEventMap>`，向宿主项目广播对话外事件。

```typescript
agent.on<K extends AgentEventName>(event: K, handler: (payload: AgentEventMap[K]) => void): void
agent.off<K extends AgentEventName>(event: K, handler: (payload: AgentEventMap[K]) => void): void
```

| 事件名 | 载荷 | 触发时机 |
|--------|------|----------|
| `memoryAdded` | `{ id, source, name }` | 记忆被写入存储（insight 提取、rule 注入等） |
| `personaSwitched` | `{ from: string \| null, to }` | 角色被切换（自动匹配或手动指定） |
| `decayCompleted` | `{ decayedCount }` | 记忆衰减完成（init 首次 + 每小时定时） |
| `memoryRecalled` | `{ count, query }` | 记忆被召回（用于 UI 展示） |
| `sessionForked` | `{ from, to, messageCount }` | 会话被分叉（创建新分支） |

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
  | { type: 'thinking'; phase: ThinkingPhase } // 推理阶段
  | { type: 'recall'; count: number }           // 记忆召回
  | { type: 'text'; content: string }           // LLM 文本片段
  | { type: 'tool_start'; name: string; args?: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary?: string }
  | { type: 'aborted'; reason: string }         // 对话被取消
  | { type: 'done' };                           // 结束标记
```

`ThinkingPhase` 取值：`'recalling' | 'processing' | 'archiving'`

### 3.2 `chatSync(input, signal?)` — 同步版（仅供测试用）

```typescript
async chatSync(input: string, signal?: AbortSignal): Promise<string>
```

收集所有 `text` 事件拼接成完整字符串返回。

---

## 四、记忆查询（`agent.memory` · MemoryInspector）

> Manager 访问路径：`agent.memory.xxx()`。`init()` 前返回 `null`。

### 4.1 `snapshot()` — 3 层记忆快照

```typescript
agent.memory.snapshot(): MemorySnapshot
```

同步返回当前 3 层记忆快照（纯只读、无副作用）：

| 层 | 键 | 内容 |
|----|-----|------|
| 第 1 层 | `snapshot.working` | `WorkingMemorySnapshot` — 当前 AgentLoop 消息（最近 5 条预览 + 总数） |
| 第 2 层 | `snapshot.bootstrap` | `BootstrapSnapshot` — 规则 / 角色 / 技能记忆（名称 + 来源 + 权重） |
| 第 3 层 | `snapshot.archive` | `ArchiveSnapshot` — 归档记忆计数（insight + profile + work-projection）+ 当前会话信息 |

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
  name: string;           // 记忆名称
  source: string;         // 来源标签
  score: number;          // 权重（0-1）
  contentPreview: string; // 内容预览（截断到 120 字符）
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
}
```

**常用 source 标签（`SOURCE_LABELS` 常量）：**

| 常量 | 值 | 用途 |
|------|----|------|
| `SOURCE_LABELS.PERSONA` | `'persona'` | 角色人格 |
| `SOURCE_LABELS.RULE` | `'rule'` | 创作规则 |
| `SOURCE_LABELS.SKILL` | `'skill'` | 技能定义 |
| `SOURCE_LABELS.INSIGHT` | `'insight'` | 对话洞察 |
| `SOURCE_LABELS.PROFILE` | `'profile'` | 用户画像 |
| `SOURCE_LABELS.WORK_PROJECTION` | `'work-projection'` | 作品投影 |

> source 是开放字符串，宿主可自定义新标签。`validateSource()` 可检测常见 typo（基于 Levenshtein 距离）。

### 5.2 `IMemoryStorage` 接口

宿主实现此接口注入 Agent，替代默认的 `InMemoryStorage`。

```typescript
interface IMemoryStorage {
  upsert(memory: Memory): void;
  delete(id: string): void;
  getById(id: string): Memory | null;
  getBySource(source: string): Memory[];
  search(query: string, limit?: number): Memory[];
  count(): number;                    // 记忆总数（数据库原生计数）
  countBySource(source: string): number; // 按来源标签计数
  close?(): void;
}
```

> 宿主实现应使用 `COUNT(*)` 等数据库原生计数，避免全量加载数据。

### 5.3 `ISessionStore` 接口

宿主实现此接口提供会话消息的持久化能力。

```typescript
interface ISessionStore {
  appendMessage(date: string, session: string, message: SessionMessage): void;
  loadMessages(date: string, session: string): SessionMessage[];
  listSessions(): string[];
  copySession(sourceDate: string, sourceSession: string, targetDate: string, targetSession: string): void;
}
```

**`copySession` 实现要求**：
- 原子操作：要么全部复制成功，要么不产生副作用
- 保留时间戳：消息的 timestamp 不修改
- 幂等：若目标会话已存在，覆盖（而非追加）
- 若源会话不存在，静默返回（不抛出）

---

## 六、项目 / 会话管理

以下方法直接挂在 Agent 上：

| 方法 | 用途 |
|------|------|
| `listProjects()` → `AgentProjectEntry[]` | 列出所有已注册项目 |
| `switchProject(nameOrPath)` → `Promise<AgentContext>` | 切换到指定项目（保留 Agent 级记忆，自动 rebuild） |
| `rebuildComponents()` → `Promise<void>` | 重建 history / loop（通常不需要手动调用，switchProject 已自动执行） |
| `switchSession(newName)` → `Promise<string>` | 切换到指定会话（自动归档旧会话） |
| `forkSession(targetSession?)` → `Promise<ForkResult>` | 分叉当前会话（复制完整消息历史到新分支） |
| `loadSessionMessages(date, session)` → `Promise<SessionRecord[]>` | 加载指定日期/会话的消息（含时间戳） |
| `restoreMostRecentSession(preferredSession='main')` → `Promise<number>` | 启动时恢复最近一次会话 |
| `restoreSession(date, session)` → `Promise<number>` | 恢复指定日期/会话 |

```typescript
// listAllSessions 通过 agentHistory 访问
const sessions = await agent.agentHistory?.listAllSessions();

// 会话分叉示例
const forkResult = await agent.forkSession();
console.log(`分叉到 ${forkResult.newSession}，复制了 ${forkResult.messageCount} 条消息`);

// 自定义分支名
const customFork = await agent.forkSession('experiment');
```

### `ForkResult` 类型

```typescript
// Agent.forkSession() 返回值
{ newSession: string; messageCount: number }

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

### 8.1 内置工具（4 个）

| 工具名 | 用途 | 参数 |
|--------|------|------|
| `read_file` | 读取项目内文件内容 | `path` |
| `write_file` | 写入/创建文件（支持 overwrite/append/insert 三种模式） | `path`, `content`, `mode?`, `insert_line?` |
| `list_dir` | 列出目录内容（递归深度 ≤ 3） | `path?`, `recursive?`, `maxDepth?` |
| `search_memories` | 在记忆索引中搜索（支持 match/near 两种模式） | `query`, `limit?`, `mode?` |

### 8.2 `agent.tools` — ToolExecutor

| 方法 | 用途 |
|------|------|
| `tools.registerTool(definition, handler)` | 注册自定义工具（会话级） |
| `tools.getToolDefinitions()` → `ToolDefinition[]` | 获取所有工具定义（内置 + 自定义） |
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

### 8.3 `agent.insight` — InsightExtractor（写入扩展 + 关键词）

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
| `config.addSimpleSkill(name, content, keywords?)` | 同上，简化版（session-only） | SkillManager |

```typescript
// 注入技能（session-only，重启后丢失）
await agent.config.addSimpleSkill(
  '大纲生成',
  '当用户说“生成大纲”时，按三幕结构生成章节大纲……',
  ['大纲', '结构', '章节'],  // 可选：触发关键词
);

// 如需跨会话持久化，写入配置文件
await agent.config.confirm({
  type: 'skill',
  name: '大纲生成',
  content: '当用户说“生成大纲”时……',
  confidence: 0.9,
});
```

### 9.3 配置建议（模式 3）

| 方法 | 用途 |
|------|------|
| `config.onSuggestion(handler)` | 注册配置建议回调 |
| `config.confirm(suggestion)` | 确认建议，写入配置文件（持久化） |

**双写机制**：
- `config.addRule()` → 写 SQLite（会话级，临时）
- `config.addSkill()` → 只写 SkillManager（session-only，不写 SQLite）
- `config.confirm()` → 写配置文件（真理源，重启后自动加载，适用于 rule/persona/skill 三种类型）

---

## 十、Provider 管理

| 方法 | 用途 |
|------|------|
| `setProvider(provider)` | 运行时切换前台 Provider |
| `setBackgroundProvider(provider)` | 运行时切换后台 Provider |

Agent 不再管理 Provider 映射表，宿主自行管理。

---

## 十一、内部调试

| 方法 | 用途 |
|------|------|
| `getBuildCtx()` → `AgentBuildCtx \| null` | 暴露内部核心组件（`security` / `index` / `bootstrapMemories`），供宿主调试或高级集成使用。正常接入**不需要**调用此方法 |

---

## 十二、完整 API 一览

### Agent 面类直接方法（18 个）

| 分组 | 方法 |
|------|------|
| 生命周期 | `init()` / `close()` |
| 对话 | `chat()` / `chatSync()` |
| 事件 | `on()` / `off()` |
| 项目/会话 | `listProjects()` / `switchProject()` / `rebuildComponents()` / `switchSession()` / `forkSession()` / `loadSessionMessages()` / `restoreMostRecentSession()` / `restoreSession()` |
| Provider | `setProvider()` / `setBackgroundProvider()` |
| 调试 | `getBuildCtx()` |

### Agent 面类只读访问器（7 个）

`initialized` / `context` / `provider` / `isBusy` / `lastInteractionAt` / `agentLoop` / `agentHistory`

### Manager 访问器（6 个）

`persona` / `tools` / `skills` / `config` / `insight` / `memory`

### 各 Manager 公开成员

| Manager | 公开成员 |
|---------|---------|
| `agent.persona` | `.list` / `.activeName` / `.currentMode` / `.active` / `.switchPersona()` / `.setMode()` |
| `agent.tools` | `.registerTool()` / `.getToolDefinitions()` / `.execute()` |
| `agent.skills` | `.list` / `.match()` / `.register()` / `.buildSystemPrompt()` |
| `agent.config` | `.addRule()` / `.addSimpleRule()` / `.addSkill()` / `.addSimpleSkill()` / `.onSuggestion()` / `.confirm()` |
| `agent.insight` | `.classify(input)` / `.extract(userInput, assistantContent)` / `.setKeywords(keywords)` / `.setWriteExtensions(ext)` |
| `agent.memory` | `.snapshot()` / `.search()` / `.stats()` |

---

## 十三、类型导出

```typescript
// Agent 与流式事件
export { Agent } from 'memora';
export type {
  AgentChunk,
  ThinkingPhase,
  AgentOptions,
  AgentContext,           // = ProjectContext 的别名
  AgentBuildCtx,          // getBuildCtx() 返回值
} from 'memora';

// 记忆快照与搜索
export type {
  MemorySnapshot,
  WorkingMemorySnapshot,
  BootstrapSnapshot,
  ArchiveSnapshot,
  AgentSearchHit,
  AgentStats,
} from 'memora';

// 工具
export type { ToolDefinition, ToolHandler, WriteExtensions } from 'memora';

// 配置建议
export type { ConfigSuggestion, ConfigSuggestionHandler } from 'memora';

// Insight
export type { MemoryKeywords } from 'memora';

// 记忆
export type { Memory } from 'memora';
export type { IMemoryStorage, ISessionStore, SessionMessage } from 'memora';
export { InMemoryStorage } from 'memora';
// 向量存储
export { VectorStore } from 'memora';
export type { EmbeddingService } from 'memora';
// 事件系统
export type { AgentEventMap, AgentEventName, AgentEventHandler } from 'memora';

// 日志
export type { ILogger } from 'memora';
export { setLogger, logger } from 'memora';

// 召回
export { recall, extractKeywords, decayScores } from 'memora';
export type { RecallOptions } from 'memora';

// 角色
export type { PersonaMode } from 'memora';

// 消息历史
export type { SessionRecord, ForkResult } from 'memora';

// 技能
export type { SkillEntry } from 'memora';

// LLM
export { createLlmProvider, createProviderFromConfig } from 'memora';
export type { ProviderConfig, LlmProvider } from 'memora';

// 配置
export { loadConfig } from 'memora';
export type { Config } from 'memora';

// 工具函数
export { segmentText, tokenizeKeywords, SOURCE_LABELS, inferSource, escapeLike, validateSource } from 'memora';
```

---

## 十四、安全与约束

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

**版本**：v3.0  
**最后更新**：2026-06-12  
**配套文档**：[memora-接入指南-v1.0.md](./memora-接入指南-v1.0.md)（步骤式教程）
