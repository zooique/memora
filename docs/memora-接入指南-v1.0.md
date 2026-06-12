# Memora · 接入指南 v3.0

> 帮助宿主项目开发者快速理解 Memora 的设计理念和接入方法。
>
> **版本**：v3.0（最后更新：2026-06-12）
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
- [七、关键约束](#七关键约束)

---

## 一、核心理念

**Memora 是一个无法独立运行的智能大脑内核。** 它只有接口，没有"形态"——宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。

**万物皆是记忆。** 角色、规则、技能、工具定义、对话历史——全部统一为「记忆」，通过 `source` 开放字符串区分。

**单 Agent 模型。** 所有对话、所有记忆存在同一个数据库中，**切换子项目不会丢失记忆**。

**配置文件是真理源，SQLite 是运行时索引。** `agent-config/` 下的配置文件由 MemoryLoader 启动时扫描加载到 SQLite。

**内核零越界。** 核心库不调用 `console.*`、不读 `process.stdin`、不管理 API Key、不写用户配置文件。

**Manager 委托模式（v3.0）。** Agent 面类只做编排，领域操作委托给 6 个专职 Manager：`agent.persona` / `agent.tools` / `agent.skills` / `agent.config` / `agent.insight` / `agent.memory`。

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
│  │  - 6 个 Manager getter（委托模式）        │               │
│  │  ⚠️ 不包含：UI / LLM 配置 / 用户配置模板 │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

---

## 二、三重数据存续路径

| 路径 | 用途 | 示例 |
|------|------|------|
| `AgentOptions.configDir` | Agent 级配置（personas/rules/skills） | 嵌入宿主程序 |
| `AgentOptions.dataDir` | 记忆数据（memora.db + topics/） | 跟作品走 |
| `projectPath/.memora/` | 项目级配置（rules/skills） | 跟作品走 |

**小说生成器推荐布局：**
```
小说项目/
├── .memora/           ← 项目级配置（rules + skills）
└── .memora-data/      ← 项目级记忆（dataDir 指向此处）
    ├── memora.db
    └── topics/
```

---

## 三、最小接入步骤

### 1. 安装

```bash
npm install memora
```

### 2. 创建 Provider + Agent

```typescript
import { Agent, createLlmProvider } from 'memora';
import type { IMemoryStorage, ILogger } from 'memora';

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
  logger,                // 日志注入（可选）
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

// 手动切换
agent.persona.switchPersona('作家');

// 锁定手动模式（禁止自动匹配）
agent.persona.setMode('manual');

// 查询当前状态
console.log(agent.persona.activeName);   // '作家'
console.log(agent.persona.currentMode);  // 'manual'
```

### 9. 切换项目

```typescript
const ctx = await agent.switchProject('another-novel');
// 项目切换后必须调用 rebuildComponents()
await agent.rebuildComponents();
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
  appendMessage(date: string, topic: string, message: SessionMessage): void {
    // 写入文件或数据库
  }
  loadMessages(date: string, topic: string): SessionMessage[] {
    // 从文件或数据库读取
    return [];
  }
  listTopics(): string[] {
    // 返回所有话题列表
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
- `loadTopicMessages()` 自动调用 `loadMessages()`
- `SessionMessage.role` 支持 `'user' | 'assistant' | 'system'`，宿主直接调用 `appendMessage()` 时可传入任意角色

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
| `sessionStore` | `ISessionStore` | ❌ | 会话存储注入 |
| `logger` | `ILogger` | ❌ | 日志注入 |

### Agent 生命周期与状态

| 成员 | 说明 |
|------|------|
| `agent.init()` | 初始化（创建存储、加载配置、组装组件），返回 `AgentContext` |
| `agent.close()` | 安全关闭（释放锁 + 关闭数据库） |
| `agent.initialized` | 只读 getter，`boolean` |
| `agent.isBusy` | 只读 getter，`boolean`（是否正在对话中） |
| `agent.lastInteractionAt` | 只读 getter，`Date \| null`，最近一次对话时间 |
| `agent.context` | 只读 getter，`AgentContext \| null`，当前项目上下文 |
| `agent.getBuildCtx()` | 调试用：暴露 `security` / `index` / `bootstrapMemories` |

### 对话

| 方法 | 说明 |
|------|------|
| `agent.chat(input, signal?)` | 流式对话，返回 `AsyncGenerator<AgentChunk>` |
| `agent.chatSync(input, signal?)` | 同步对话（测试用） |

### 项目 / 话题

| 方法 | 说明 |
|------|------|
| `agent.listProjects()` | 列出已注册的子项目 |
| `agent.switchProject(name)` | 切换到其他子项目 |
| `agent.rebuildComponents()` | **项目切换后必须调用** |
| `agent.switchTopic(name)` | 切换当前话题（自动归档旧话题） |
| `agent.loadTopicMessages(date, topic)` | 加载指定日期/话题的消息 |
| `agent.restoreTopic(date, topic)` | 恢复指定日期/话题 |
| `agent.restoreMostRecentTopic()` | 启动时恢复最近一次话题 |
| `agent.agentHistory.listAllTopics()` | 列出所有话题文件名 |

### Manager 速查表

| 路径 | Manager | 主要成员 |
|------|---------|---------|
| `agent.memory.xxx()` | MemoryInspector | `snapshot()` / `search(q, n)` / `stats()` |
| `agent.config.xxx()` | ConfigManager | `addRule(m)` / `addSimpleRule(n, c)` / `addSkill(m)` / `addSimpleSkill(n, c, k?)` / `onSuggestion(h)` / `confirm(s)` |
| `agent.tools.xxx()` | ToolExecutor | `registerTool(d, h)` / `getToolDefinitions()` / `execute(n, a)` |
| `agent.insight.xxx()` | InsightExtractor | `setWriteExtensions(e)` / `setKeywords(k)` / `classify(i)` |
| `agent.persona.xxx` | PersonaManager | `.list` / `.activeName` / `.currentMode` / `.switchPersona(n)` / `.setMode(m)` |
| `agent.skills.xxx` | SkillManager | `.list` / `.match(i)` / `.register(s)` / `.buildSystemPrompt()` |

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
  setLogger,
  logger,
  segmentText,
  recall,
  extractKeywords,
  SOURCE_LABELS,
  inferSource,
  escapeLike,
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
  SkillEntry,
  RecallOptions,
} from 'memora';
```

| 函数/类型 | 用途 |
|-----------|------|
| `createLlmProvider(config)` | 从扁平配置创建 LlmProvider 实例 |
| `createProviderFromConfig(name, config)` | 从命名配置创建 LlmProvider 实例 |
| `loadConfig(path?)` | 加载 memora.json 配置文件 |
| `InMemoryStorage` | IMemoryStorage 的纯内存实现（测试用） |
| `setLogger(logger)` | 替换全局日志实现 |
| `logger` | 全局日志实例 |
| `segmentText(text)` | 中文分词工具 |
| `recall(index, query, options?)` | 简化关键词搜索 |
| `extractKeywords(text)` | 提取关键词 |
| `SOURCE_LABELS` | source 标签常量（PERSONA / RULE / SKILL / INSIGHT / PROFILE / WORK_PROJECTION） |
| `inferSource(content)` | 从内容推断 source 标签 |
| `escapeLike(query)` | 转义 SQLite LIKE 通配符 |

**注意**：`SqliteStorage` 已移出到宿主项目，不再从 memora 导出。宿主需自行实现 `IMemoryStorage` 接口。

---

## 七、关键约束

1. **`provider` 是必填项** — Agent 无法独立运行
2. **configDir** 指向 Agent 级配置目录，所有子项目共享
3. **项目级 `.memora/`** 只放 `rules/` 和 `skills/`
4. **角色由关键词自动触发**
5. **对话历史跨子项目持久化**
6. **Manager 访问器在 `init()` 前返回 `null`** — 所有 `agent.config.xxx()` / `agent.memory.xxx()` 等调用必须在 `init()` 之后
7. **作品原始内容不进 SQLite**，Agent 通过工具按需读取
8. **配置文件是真理源**，`agent-config/` 下的配置由 MemoryLoader 启动时扫描加载
9. **禁止**为每个子项目创建独立的 memora.db
10. **禁止**项目切换时关闭/重建数据库
11. **禁止**将配置直接写入 SQLite 作为持久化存储
12. **项目切换后必须调用** `rebuildComponents()` 才能使新项目会话生效

---

> 更多细节参见 [memora-api-reference-v1.0.md](./memora-api-reference-v1.0.md)（完整 API 参考）
