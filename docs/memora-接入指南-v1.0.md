# Memora · 接入指南 v3.2

> 帮助宿主项目开发者快速理解 Memora 的设计理念和接入方法。
>
> **版本**：v3.2（最后更新：2026-06-25）
>
> **v3.2 变更**：新增 ADR-014 记忆关系图谱（IMemoryRelationStore 侧车接口）、UserProfile 用户画像管理、WorkProjectionManager 作品投影、AutoConfigRefiner 自进化配置建议。
>
> **v3.1 变更**：新增可观测性（ITracer）、内容护栏（Guardrails）、工具错误反思（Reflection）、评估体系（Eval）支持。
>
> **v3.0 重大变更**：Agent God Object 拆分。记忆查询、规则注入、工具注册等方法迁移到专职 Manager，通过 `agent.<manager>.xxx()` 访问。详见 [API 参考手册](./memora-api-reference-v1.0.md)。

---

## 目录

- [一、核心理念](#一核心理念)
- [二、三重数据存续路径](#二三重数据存续路径)
- [三、最小接入步骤](#三最小接入步骤)
- [四、会话持久化](#四会话持久化)
- [五、API 速查](#五api-速查)
- [六、宿主工具函数](#六宿主工具函数)
- [七、可观测性接入（ITracer）](#七可观测性接入itracer)
- [八、内容护栏（Guardrails）](#八内容护栏guardrails)
- [九、评估体系（Eval）](#九评估体系eval)
- [十、多步骤编排](#十多步骤编排)
- [十一、关键约束](#十一关键约束)

---

## 一、核心理念

**Memora 是一个无法独立运行的智能大脑内核。** 它只有接口，没有"形态"——宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。

**万物皆是记忆。** 角色、规则、技能、工具定义、对话历史——全部统一为「记忆」，通过 `source` 开放字符串区分。

**单 Agent 模型。** 所有对话、所有记忆存在同一个数据库中，**切换子项目不会丢失记忆**。

**配置文件是真理源，SQLite 是运行时索引。** `agent-config/` 下的配置文件由 MemoryLoader 启动时扫描加载到 SQLite。

**内核零越界。** 核心库不调用 `console.*`、不读 `process.stdin`、不管理 API Key、不写用户配置文件。

**Manager 委托模式（v3.0）。** Agent 面类只做编排，领域操作委托给 8 个专职 Manager：`agent.persona` / `agent.tools` / `agent.skills` / `agent.config` / `agent.insight` / `agent.memory` / `agent.userProfile` / `agent.works`。

```
┌────────────────────────────────────────────────────────────┐
│  宿主程序                                                   │
│  ┌─────────────────┐    ┌──────────────────┐               │
│  │ LLM Provider 实例 │◄───│ API Key / baseUrl │  ← 宿主职责  │
│  └────────┬────────┘    └──────────────────┘               │
│           │ 注入                                            │
│           ▼                                                 │
│  ┌──────────────────────────────────────────┐               │
│  │  Memora 内核（Agent）                    │               │
│  │  - chat(input) → 流式响应                │               │
│  │  - 8 个 Manager getter（委托模式）        │               │
│  │  ⚠️ 不包含：UI / LLM 配置 / 用户配置模板 │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

---

## 二、三重数据存续路径

| 路径 | 用途 | 示例 |
|------|------|------|
| `AgentOptions.configDir` | Agent 级配置（personas/rules/skills） | 嵌入宿主程序 |
| `AgentOptions.dataDir` | 记忆数据（memora.db + sessions/） | 跟作品走 |
| `projectPath/.memora/` | 项目级配置（rules/skills） | 跟作品走 |

**小说生成器推荐布局：**
```
小说项目/
├── .memora/           ← 项目级配置（rules + skills）
└── .memora-data/      ← 项目级记忆（dataDir 指向此处）
    ├── memora.db
    └── sessions/
```

---

## 三、最小接入步骤

### 1. 安装

```bash
npm install memora
```

### 2. 创建 Provider + Agent

```typescript
import { Agent, createLlmProvider, VectorStore } from 'memora';
import type { IMemoryStorage, ILogger, EmbeddingService } from 'memora';

// 宿主职责：创建 LLM Provider（Agent 不关心 API Key）
const provider = createLlmProvider({
  provider: 'openaiCompatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
});

// 可选：后台 Provider（投影等后台操作）
const backgroundProvider = createLlmProvider({
  provider: 'openaiCompatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat', // 可用更便宜的模型
});

// 可选：注入存储层（不传则使用 InMemoryStorage）
const storage: IMemoryStorage = new MySqliteStorage('/path/to/memora.db');

// 可选：注入日志实现（不传则使用默认 pino logger）
const logger: ILogger = myCustomLogger;

// 可选：向量存储（提供后启用语义搜索召回）
const embeddingService: EmbeddingService = myEmbeddingService;
const vectorStore = new VectorStore('/path/to/vectors.json', embeddingService);

// 创建 Agent
const agent = new Agent({
  projectPath: '/path/to/novel-project',
  provider,              // 前台 Provider（必须）
  backgroundProvider,    // 后台 Provider（可选）
  configDir: '/path/to/agent-config',
  dataDir: '.memora',
  maxContextTokens: 120000,
  persona: '作家',
  permission: 'owner',
  allowedPaths: ['.'],
  confirmWrites: false,
  storage,               // 存储层注入（可选）
  vectorStore,           // 向量存储（可选，启用语义搜索）
  logger,                // 日志注入（可选）
  tracer: myOtelTracer,  // 可观测性 Tracer（可选，不传则静默丢弃所有 span）
});

await agent.init();
```

### 3. 对话

```typescript
// 流式对话（生产推荐）
for await (const chunk of agent.chat('帮我写一段玄幻小说开头')) {
  switch (chunk.type) {
    case 'text':       ui.appendText(chunk.content); break;
    case 'thinking':   ui.showThinking(chunk.phase); break;
    case 'tool_start': ui.showToolStart(chunk.name); break;
    case 'tool_result':ui.showToolResult(chunk.ok); break;
    case 'aborted':    ui.showCancelled(chunk.reason); break;
  }
}

// 同步对话（测试用）
const reply = await agent.chatSync('你好');
```

### 3.5 事件订阅（可选）

Agent 向宿主广播对话外事件（记忆变更、角色切换、衰减完成、会话分叉等）。

```typescript
import type { AgentEventMap } from 'memora';

agent.on('memoryAdded', (e) => console.log(`新记忆: ${e.source}:${e.name}`));
agent.on('personaSwitched', (e) => console.log(`角色: ${e.from} → ${e.to}`));
agent.on('decayCompleted', (e) => console.log(`衰减 ${e.decayedCount} 条记忆`));
agent.on('memoryRecalled', (e) => console.log(`想起 ${e.count} 条记忆`));
agent.on('sessionForked', (e) => console.log(`分叉: ${e.from} → ${e.to}，${e.messageCount} 条消息`));

// close() 自动移除所有监听器
```

### 4. 注册领域工具

> v3.0：工具注册走 `agent.tools.xxx()`。

```typescript
agent.tools.registerTool(
  {
    name: 'create_chapter',
    description: '创建一个新章节',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: '章节标题' } },
      required: ['title'],
    },
  },
  async (args) => {
    const chapter = await myNovel.createChapter(args.title);
    return `章节 "${args.title}" 已创建`;
  },
);
```

### 5. 注入写入扩展 + 记忆关键词

> v3.0：写入扩展和关键词走 `agent.insight.xxx()`。

```typescript
// 写入前 diff 确认回调
agent.insight.setWriteExtensions({
  onBeforeWrite: async (path, before, after) => {
    showDiff(path, before, after);
    return await userConfirm(`确认写入 ${path}？`);
  },
});

// 记忆关键词（领域 + 用户专属）
agent.insight.setKeywords({
  domain: ['主角', '角色', '情节', '设定'],
  personal: ['我', '我的', '记住', '帮我'],
});
```

### 6. 注入项目规则

> v3.0：规则注入走 `agent.config.xxx()`。

```typescript
await agent.config.addSimpleRule(
  '世界观规则',
  '这是一个东方玄幻世界，修真等级分为炼气、筑基、金丹……',
);
```

### 7. 查询记忆

> v3.0：记忆查询走 `agent.memory.xxx()`。

```typescript
// 3 层记忆快照
const snap = agent.memory.snapshot();
console.log('工作记忆:', snap.working.total, '条');
console.log('引导记忆:', snap.bootstrap.total, '条');

// 关键词搜索
const hits = agent.memory.search('世界观');
hits.forEach(h => console.log(`${h.source}:${h.name} (${h.score})`));

// 记忆库统计
const stats = agent.memory.stats();
console.log('记忆总数:', stats.total);
```

### 8. 管理角色

> v3.0：角色管理走 `agent.persona.xxx`。

```typescript
// 列出所有角色
const names = agent.persona.list.map(p => p.name);

// 手动切换（返回新角色的 system prompt，可用于 UI 展示）
const personaPrompt = agent.persona.switchPersona('作家');

// 锁定手动模式（禁止自动匹配）
agent.persona.setMode('manual');

// 查询当前状态
console.log(agent.persona.activeName);   // '作家'
console.log(agent.persona.currentMode);  // 'manual'
```

### 9. 切换项目

```typescript
// switchProject() 自动 rebuild，无需手动调用 rebuildComponents()
const ctx = await agent.switchProject('another-novel');
console.log(`已切换到：${ctx.projectName}`);
```

### 10. 关闭

```typescript
await agent.close(); // 释放项目锁 + 关闭数据库
```

---

## 四、会话持久化（ISessionStore）

Memora 通过 `ISessionStore` 接口支持会话消息的持久化。宿主实现此接口，注入到 Agent。

```typescript
import type { ISessionStore, SessionMessage } from 'memora';

// 宿主实现接口
class FileSessionStore implements ISessionStore {
  appendMessage(date: string, session: string, message: SessionMessage): void {
    // 写入文件或数据库
  }
  loadMessages(date: string, session: string): SessionMessage[] {
    // 从文件或数据库读取
    return [];
  }
  listSessions(): string[] {
    // 返回所有会话列表
    return [];
  }
}

// 注入到 Agent
const agent = new Agent({
  // ...其他配置
  sessionStore: new FileSessionStore('./sessions'),
});
```

**会话持久化特性：**
- 日期使用 `todayDate()` 动态获取，确保跨日后消息写入当天目录
- `appendUser()` / `appendAssistant()` 自动调用 `appendMessage()`
- `loadSessionMessages()` 自动调用 `loadMessages()`
- `SessionMessage.role` 支持 `'user' | 'assistant' | 'system'`，宿主直接调用 `appendMessage()` 时可传入任意角色

---

## 四.5、会话分叉（Fork Session）

Memora 支持会话分叉功能，允许用户从当前对话创建独立分支，继承完整消息历史后各自独立发展。

**使用场景**：
- 用户在对话中建立了丰富的上下文后，可以分叉到多个并行任务
- 每个分支继承已建立的共识，避免从零开始
- 分支完全独立，互不干扰

```typescript
// 自动生成分支名（main-b1, main-b2, ...）
const result = agent.forkSession();
console.log(`已分叉到: ${result.newSession}，复制了 ${result.messageCount} 条消息`);

// 自定义分支名
const result2 = agent.forkSession('experiment');
```

**命名规则**：
- 自动生成：`{原始会话名}-b{序号}`（如 `main-b1`、`main-b2`）
- 支持分叉的分叉：`main-b1-b1`
- 自定义名称：直接传入目标名称

**记忆处理策略**：
- 已有记忆：全局共享（记忆是全局知识库，不属于单个会话）
- 分叉后的 Insight：各自独立（不同分支探索不同方向）
- 用户画像：全局共享（UserProfile 是全局的）

**事件监听**：
```typescript
agent.on('sessionForked', (event) => {
  console.log(`从 ${event.from} 分叉到 ${event.to}`);
  console.log(`复制了 ${event.messageCount} 条消息`);
});
```

**边界情况**：
- 当前会话无消息时抛出错误
- `ISessionStore` 未注入时抛出错误
- 对话正在进行中（`chatBusy`）时抛出错误
- 自定义名称已存在时抛出错误

---

## 五、API 速查

> 完整定义见 [memora-api-reference-v1.0.md](./memora-api-reference-v1.0.md)。

### 构造选项 `AgentOptions`

| 选项 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `projectPath` | `string` | ✅ | 项目路径 |
| `provider` | `LlmProvider` | ✅ | 前台 LLM Provider |
| `backgroundProvider` | `LlmProvider` | ❌ | 后台 Provider（投影） |
| `configDir` | `string` | ❌ | 配置目录（personas/rules/skills） |
| `dataDir` | `string` | ❌ | 记忆数据目录（默认 ~/.memora） |
| `registryDir` | `string` | ❌ | 项目注册表目录（默认与 dataDir 相同） |
| `maxContextTokens` | `number` | ❌ | 上下文窗口上限（默认 120000） |
| `persona` | `string` | ❌ | 默认角色名 |
| `permission` | `'owner' \| 'guest'` | ❌ | 安全权限（默认 'owner'） |
| `allowedPaths` | `string[]` | ❌ | 路径白名单（默认 [] = 全部允许） |
| `confirmWrites` | `boolean` | ❌ | 写入确认（默认 false） |
| `storage` | `IMemoryStorage` | ❌ | 存储层注入 |
| `relationStore` | `IMemoryRelationStore` | ❌ | 记忆关系存储（ADR-014 侧车，不传则跳过关系构建） |
| `vectorStore` | `VectorStore` | ❌ | 向量存储（提供时启用语义搜索） |
| `recallExcludeSources` | `string[]` | ❌ | 召回时排除的 source 标签（默认 `['persona', 'rule', 'skill']`） |
| `sessionStore` | `ISessionStore` | ❌ | 会话存储注入 |
| `logger` | `ILogger` | ❌ | 日志注入 |
| `tracer` | `ITracer` | ❌ | 可观测性 Tracer 注入（不传则使用 NoopTracer 静默丢弃所有 span） |
| `messages` | `UIMessages` | ❌ | 宿主可覆盖的 UI 消息文本（默认英文，宿主覆盖为中文等） |
| `enableContextSummary` | `boolean` | ❌ | 上下文超限时是否自动生成摘要（默认 false） |

### Agent 生命周期与状态

| 成员 | 说明 |
|------|------|
| `agent.init()` | 初始化（创建存储、加载配置、组装组件），返回 `AgentContext` |
| `agent.close()` | 安全关闭（释放锁 + 关闭数据库） |
| `agent.initialized` | 只读 getter，`boolean` |
| `agent.isBusy` | 只读 getter，`boolean`（是否正在对话中） |
| `agent.lastInteractionAt` | 只读 getter，`Date \| null`，最近一次对话时间 |
| `agent.context` | 只读 getter，`AgentContext \| null`，当前项目上下文 |

### 对话

| 方法 | 说明 |
|------|------|
| `agent.chat(input, signal?)` | 流式对话，返回 `AsyncGenerator<AgentChunk>` |
| `agent.chatSync(input, signal?)` | 同步对话（测试用） |

### 项目 / 会话

| 方法 | 说明 |
|------|------|
| `agent.listProjects()` | 列出已注册的子项目（@deprecated 请使用 `agent.projects.list`） |
| `agent.switchProject(name)` | 切换到其他子项目 |
| `agent.rebuildComponents()` | 通常不需要手动调用（`switchProject` 已自动执行），仅在强制刷新配置时使用 |
| `agent.switchSession(name)` | 切换当前会话（同步，返回新会话名） |
| `agent.forkSession(name?)` | 分叉当前会话（复制完整消息历史到新分支） |
| `agent.loadSessionMessages(date, session)` | 加载指定日期/会话的消息 |
| `agent.restoreSession(date, session)` | 恢复指定日期/会话 |
| `agent.restoreMostRecentSession()` | 启动时恢复最近一次会话 |
| `agent.agentHistory.listAllSessions()` | 列出所有会话文件名 |

### Manager 速查表

| 路径 | Manager | 主要成员 |
|------|---------|---------|
| `agent.memory.xxx()` | MemoryInspector | `snapshot()` / `search(q, n)` / `stats()` |
| `agent.config.xxx()` | ConfigManager | `addRule(m)` / `addSimpleRule(n, c)` / `addSkill(m)` / `addSimpleSkill(n, c, k?)` / `onSuggestion(h)` / `confirm(s)` |
| `agent.tools.xxx()` | ToolExecutor | `registerTool(d, h)` / `getToolDefinitions()` / `execute(n, a)` / `list` |
| `agent.insight.xxx()` | InsightExtractor | `setWriteExtensions(e)` / `setKeywords(k)` / `classify(i)` |
| `agent.persona.xxx` | PersonaManager | `.list` / `.activeName` / `.currentMode` / `.switchPersona(n)` / `.setMode(m)` |
| `agent.skills.xxx` | SkillManager | `.list` / `.match(i)` / `.register(skill)` / `.buildSystemPrompt()` |
| `agent.userProfile.xxx()` | UserProfile | `load()` / `archiveFacts(f)` / `getConfirmed()` / `getPending()` / `buildSystemPrompt()` / `confirm(id)` / `reject(id)` |
| `agent.works.xxx()` | WorkProjectionManager | `ensureProjection(path, content)` / `getProjection(path)` / `loadAll()` |
| `agent.on()` / `agent.off()` / `agent.once()` | TypedEventEmitter | `memoryAdded` / `personaSwitched` / `decayCompleted` / `memoryRecalled` / `sessionForked` / `insightExtracted` |

### Provider 管理

| 方法 | 说明 |
|------|------|
| `agent.setProvider(provider)` | 运行时切换前台 Provider |
| `agent.setBackgroundProvider(provider)` | 运行时切换后台 Provider |

---

## 六、宿主工具函数

```typescript
import {
  createLlmProvider,
  createProviderFromConfig,
  loadConfig,
  InMemoryStorage,
  VectorStore,
  setLogger,
  logger,
  segmentText,
  recall,
  extractKeywords,
  decayScores,
  SOURCE_LABELS,
  inferSource,
  escapeLike,
  validateSource,
  tokenizeKeywords,
  NOOP_TRACER,
  TRACE_SPANS,
  ToolErrorCode,
  isRetryableErrorCode,
} from 'memora';
import type {
  ProviderConfig,
  Config,
  IMemoryStorage,
  ILogger,
  ISessionStore,
  SessionMessage,
  Memory,
  LlmProvider,
  AgentChunk,
  AgentOptions,
  AgentContext,
  AgentBuildCtx,
  ToolDefinition,
  ToolHandler,
  WriteExtensions,
  MemoryKeywords,
  MemorySnapshot,
  AgentSearchHit,
  AgentStats,
  ConfigSuggestion,
  ConfigSuggestionHandler,
  PersonaMode,
  Persona,
  SkillEntry,
  RecallOptions,
  EmbeddingService,
  AgentEventMap,
  AgentEventName,
  AgentEventHandler,
  ForkResult,
  ITracer,
  ISpan,
  ToolErrorCodeValue,
} from 'memora';
```

| 函数/类型 | 用途 |
|-----------|------|
| `createLlmProvider(config)` | 从扁平配置创建 LlmProvider 实例 |
| `createProviderFromConfig(name, config)` | 从命名配置创建 LlmProvider 实例 |
| `loadConfig(path?)` | 加载 memora.json 配置文件 |
| `InMemoryStorage` | IMemoryStorage 的纯内存实现（测试用） |
| `VectorStore` | 向量存储类（宿主注入 EmbeddingService 后创建，启用语义搜索） |
| `setLogger(logger)` | 替换全局日志实现 |
| `logger` | 全局日志实例 |
| `segmentText(text)` | 中文分词工具 |
| `recall(storage, query, options?)` | 记忆召回（async，双通道：语义 + 关键词） |
| `extractKeywords(text)` | 提取关键词 |
| `decayScores(memories, now?)` | 记忆衰减（>7天未访问 score 降 0.02/周，下限 0.1） |
| `SOURCE_LABELS` | source 标签常量（PERSONA / RULE / SKILL / INSIGHT / PROFILE / WORK_PROJECTION / GUARDRAIL） |
| `inferSource(content)` | 从内容推断 source 标签 |
| `escapeLike(query)` | 转义 SQLite LIKE 通配符 |
| `validateSource(source)` | 校验 source 标签是否为已知标签（返回 warning，不阻止写入） |
| `tokenizeKeywords(text)` | 中英文混合分词（中文字 ≥2 连字 + 英文单词），供宿主 FTS5 使用 |
| `NOOP_TRACER` | ITracer 的空实现（静默丢弃所有 span，零开销） |
| `TRACE_SPANS` | AgentLoop 预定义 Span 名称常量（RECALL / LLM_CALL / TOOL_EXEC / RESPONSE） |
| `ToolErrorCode` | 工具错误码枚举（10 种，含 PATH_NOT_ALLOWED / FILE_NOT_FOUND 等） |
| `isRetryableErrorCode(code)` | 判断错误码是否可重试（5 种 retryable） |

**注意**：`SqliteStorage` 已移出到宿主项目，不再从 memora 导出。宿主需自行实现 `IMemoryStorage` 接口。

`IMemoryStorage` 接口要求实现 `count()` 和 `countBySource(source)` 方法，用于高效统计记忆数量（避免全量加载数据）。详见 [API 参考手册](./memora-api-reference-v1.0.md#52-imemorystorage-接口)。

---

## 七、可观测性接入（ITracer）

Memora 内置了轻量的 Span/Trace 抽象，宿主可注入 OpenTelemetry 等实现来观测 AgentLoop 行为。

### 接口定义

```typescript
interface ITracer {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan;
}

interface ISpan {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
  recordException(error: Error): void;
}
```

### AgentLoop 预定义 Span

| Span 名称 | 常量 | 触发时机 | 关键属性 |
|-----------|------|---------|---------|
| `recall.recall` | `TRACE_SPANS.RECALL` | 记忆召回阶段 | `recallCount` |
| `llm.call` | `TRACE_SPANS.LLM_CALL` | LLM API 调用 | `model`, `messageCount`, `iteration` |
| `tool.execute` | `TRACE_SPANS.TOOL_EXEC` | 工具执行 | `toolName` |
| `response.generate` | `TRACE_SPANS.RESPONSE` | 整轮响应 | `inputLength` |

### 宿主接入示例（OpenTelemetry）

```typescript
import { trace } from '@opentelemetry/api';
import type { ITracer, ISpan } from 'memora';

// 宿主实现 ITracer 接口（桥接 OpenTelemetry）
class OtelTracer implements ITracer {
  private tracer = trace.getTracer('memora-agent');

  startSpan(name: string, attributes?: Record<string, string | number | boolean>): ISpan {
    const otelSpan = this.tracer.startSpan(name, { attributes });
    return {
      setAttribute: (key, value) => otelSpan.setAttribute(key, value),
      end: () => otelSpan.end(),
      recordException: (error) => otelSpan.recordException(error),
    };
  }
}

// 注入到 Agent
const agent = new Agent({
  // ...其他配置
  tracer: new OtelTracer(),
});
```

> **不注入时**：默认使用 `NOOP_TRACER`（静默丢弃所有 span，零运行时开销）。

---

## 八、内容护栏（Guardrails）

Memora 支持基于正则的内容护栏，在对话输入和 LLM 输出阶段分别检查，防止恶意输入和敏感信息泄露。

### 护栏规则格式

护栏规则以 `source: "guardrail"` 记忆形式存储，放在 `configDir/rules/guardrails/` 目录下：

```markdown
---
name: 禁止执行代码
source: guardrail
---

pattern: /执行|运行|eval|exec/
action: block
```

- `pattern`：正则表达式（可选加 `/` 定界符）
- `action`：`block`（阻断对话）或 `warn`（仅警告）

### 护栏行为

| 阶段 | 命中 block | 命中 warn | 规则异常 |
|------|-----------|----------|---------|
| 输入 | 阻断对话，返回阻止消息 | 追加警告文本，继续对话 | 降级放行 + 记日志 |
| 输出 | 阻断输出，返回阻止消息 | 追加警告文本，继续输出 | 降级放行 + 记日志 |

> **降级优先**：护栏自身异常（如正则编译失败）永远不阻断用户对话。

### 工具错误反思（Reflection）

当工具执行失败时，错误结果包含 `[ERR:TOOL:code]` 前缀。如果错误码标记为 retryable（如 `FILE_NOT_FOUND`、`ARGUMENT_ERROR`），AgentLoop 会自动注入 `[REFLECTION_HINT]` 系统消息，引导 LLM 修正参数后重试。

```typescript
import { ToolErrorCode, isRetryableErrorCode } from 'memora';

// 判断错误码是否可重试
isRetryableErrorCode(ToolErrorCode.FILE_NOT_FOUND);  // true
isRetryableErrorCode(ToolErrorCode.PATH_NOT_ALLOWED); // false
```

Reflection 默认最多重试 2 次（`maxReflectionRetries`），防止无限循环。

---

## 九、评估体系（Eval）

Memora 提供了 Mock Eval 框架，用于 Agent 行为回归测试（不发起真实 LLM 调用）。

### 类型定义

```typescript
import type { EvalScenario, EvalExpectation, EvalResult } from 'memora';
// Eval 类型已从 memora 主包导出，宿主项目可直接 import
```

### 评估场景示例

```typescript
const scenario: EvalScenario = {
  name: '只读查询不应调用 write_file',
  description: '用户只查询信息时，Agent 不应写入文件',
  input: '帮我看看第一章写了什么',
  expect: {
    toolsCalled: ['read_file'],       // 期望调用 read_file
    toolsNotCalled: ['write_file'],   // 不应调用 write_file
  },
};
```

### 评估工具函数

```typescript
import { collectAgentChunks, evaluateResult } from 'memora';

// 从 AgentChunk 流中收集行为数据
const collected = await collectAgentChunks(agent.chat('帮我看看第一章'));

// 比对期望
const result = evaluateResult(scenario.name, collected, scenario.expect);
console.log(result.passed ? '✅ 通过' : `❌ 失败: ${result.failures.join('; ')}`);
```

### 两种评估层次

| 层次 | 工具 | LLM 调用 | 用途 |
|------|------|---------|------|
| Mock Eval | `collectAgentChunks` + `evaluateResult` | 不调用（MSW Mock） | 行为回归（工具调用、护栏、召回） |
| 真实 LLM Eval | 宿主自建 | 真实调用 | 回复质量、指令遵循度 |

> Mock Eval 在 CI 中运行，真实 LLM Eval 由宿主项目手动触发。

---

## 十、多步骤编排

Memora 是单 Agent 模型（ADR-011），不内置多 Agent 编排。宿主项目可通过多次调用 `agent.chat()` 实现复杂工作流：

```typescript
// 示例：分析项目 → 生成大纲 → 逐章写作
const analysis = await agent.chatSync('分析这个项目的风格和主题');
const outline = await agent.chatSync('基于分析结果，生成章节大纲');
for (const chapter of chapters) {
  const content = await agent.chatSync(`根据大纲，写第${chapter.num}章：${chapter.title}`);
  // 写入文件...
}
```

**编排要点**：
- 每次 `chat()` 共享同一个 AgentLoop 上下文（记忆、角色、技能）
- 宿主负责流程控制（条件分支、并行、错误处理）
- 如需隔离上下文，使用 `agent.switchSession()` 或 `agent.forkSession()`

---

## 十一、关键约束

1. **`provider` 是必填项** — Agent 无法独立运行
2. **configDir** 指向 Agent 级配置目录，所有子项目共享
3. **项目级 `.memora/`** 只放 `rules/`、`skills/` 和 `guardrails/`
4. **角色由关键词自动触发**
5. **对话历史跨子项目持久化**
6. **Manager 访问器在 `init()` 前返回 `null`** — 所有 `agent.config.xxx()` / `agent.memory.xxx()` 等调用必须在 `init()` 之后
7. **作品原始内容不进 SQLite**，Agent 通过工具按需读取
8. **配置文件是真理源**，`agent-config/` 下的配置由 MemoryLoader 启动时扫描加载
9. **禁止**为每个子项目创建独立的 memora.db
10. **禁止**项目切换时关闭/重建数据库
11. **禁止**将配置直接写入 SQLite 作为持久化存储
12. **项目切换** `switchProject()` 已自动 rebuild，通常无需手动调用 `rebuildComponents()`
13. **护栏规则**以 `source: "guardrail"` 记忆形式存储，不创建独立子系统
14. **Tracer 未注入时**自动降级为 NoopTracer，零运行时开销

---

> 更多细节参见 [memora-api-reference-v1.0.md](./memora-api-reference-v1.0.md)（完整 API 参考）
