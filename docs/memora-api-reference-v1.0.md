# Memora 内核 API 参考手册（v2.0）

> **核心定位**：Memora 是一个**无法独立运行**的智能大脑内核——它只有接口，没有"形态"。CLI、WebUI、桌面精灵、小说生成器都是它的"宿主"，宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。
>
> **本文件用途**：列出当前 Agent 对外暴露的**全部公开 API**。

---

## 1. 设计哲学：Memora = 大脑，宿主 = 身体

```
┌────────────────────────────────────────────────────────────┐
│  宿主程序（任意：CLI / 桌面精灵 / 小说生成器 / WebUI）      │
│  ┌─────────────────┐    ┌──────────────────┐               │
│  │ LLM Provider 实例 │◄───│ API Key / baseUrl │  ← 宿主职责  │
│  └────────┬────────┘    └──────────────────┘               │
│           │ 注入                                            │
│           ▼                                                 │
│  ┌──────────────────────────────────────────┐               │
│  │  Memora 内核（Agent）                    │               │
│  │  - chat(input) → 流式响应                │               │
│  │  - 记忆搜索 / 归档 / 挂载                │               │
│  │  - 角色匹配 / 技能匹配                   │               │
│  │  - 工具注册 / 工具执行                   │               │
│  │  ⚠️ 不包含：UI / LLM 配置 / 用户配置模板 │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

**设计原则**：
- **零 native 依赖**（核心层仅依赖 `zod`；持久化由宿主通过 `IMemoryStorage` 接口注入）
- **零控制台输出**（核心库不调用 `console.*`）
- **零写用户文件**（配置文件是真理源，Agent 只读）

---

## 2. 构造与生命周期

### 2.1 构造选项 `AgentOptions`

```typescript
import { Agent } from 'memora';

export interface AgentOptions {
  projectPath: string;          // 项目路径（必须）
  provider: LlmProvider;        // 前台 LLM Provider（必须）
  backgroundProvider?: LlmProvider; // 后台 Provider（可选，投影等后台操作）
  configDir?: string;           // 配置目录（personas/rules/skills）
  dataDir?: string;             // 记忆数据目录（默认 ~/.memora）
  registryDir?: string;         // 项目注册表目录（默认与 dataDir 相同）
  maxContextTokens?: number;    // 上下文窗口上限（默认 120000）
  persona?: string;             // 默认角色名
  permission?: 'owner' | 'guest'; // 安全权限
  allowedPaths?: string[];      // 路径白名单
  confirmWrites?: boolean;      // 写入确认
  storage?: IMemoryStorage;     // 存储层注入
  sessionStore?: ISessionStore; // 会话存储注入
  logger?: ILogger;             // 日志注入
}
```

### 2.2 生命周期方法

| 方法 | 用途 |
|------|------|
| `new Agent(opts)` | 构造函数（无副作用，不连接 LLM） |
| `agent.init(projectPathOverride?)` → `Promise<ProjectContext>` | 初始化：建立 SQLite、加载配置、连接 LLM |
| `agent.close()` | 关闭：释放数据库连接、释放项目锁 |
| `agent.inspect()` | 同步返回 4 层记忆快照（working / bootstrap / archive / mounted） |

**状态机**：
```
[构造] --init()--> [已初始化] --chat()/其他方法...--> [已初始化]
                              --close()--> [已关闭]
```

未初始化时调用任何方法**抛 `configError`**。

---

## 3. 对话 API（最核心）

### 3.1 `chat(input, signal?)` — 流式对话

```typescript
async *chat(input: string, signal?: AbortSignal): AsyncGenerator<AgentChunk, void, unknown>
```

**唯一**的对话入口。流式返回 `AgentChunk` 事件。可选传入 `signal` 支持取消。

```typescript
type AgentChunk =
  | { type: 'thinking'; phase: ThinkingPhase } // 推理阶段
  | { type: 'recall'; count: number }          // 话题记忆挂载
  | { type: 'text'; content: string }          // LLM 文本片段
  | { type: 'tool_start'; name: string; args?: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary?: string }
  | { type: 'aborted'; reason: string }        // 对话被取消
  | { type: 'done' };                          // 结束标记
```

### 3.2 `chatSync(input, signal?)` — 同步版（测试用）

```typescript
async chatSync(input: string, signal?: AbortSignal): Promise<string>
```

收集所有 `text` 事件拼接成完整字符串返回。**仅供测试用**。

---

## 4. 记忆 API

### 4.1 读记忆

| 方法 | 用途 | 返回 |
|------|------|------|
| `searchMemories(query, limit=10)` | 模糊关键词搜索 | `AgentSearchHit[]` |
| `inspect()` | 4 层记忆快照 | `MemorySnapshot` |
| `getMessages()` | 当前 AgentLoop 的全部消息 | `readonly Message[]` |
| `getStats()` | 记忆库统计 | `AgentStats` |

### 4.2 写记忆（运行时 / 会话级）

| 方法 | 用途 | 写到哪里 |
|------|------|----------|
| `addRule(memory)` | 添加规则 | SQLite 索引 |
| `addSimpleRule(name, content, keywords=[])` | 同上，简化版 | SQLite 索引 |
| `addSkill(memory)` | 添加技能 | SQLite 索引 |
| `addSimpleSkill(name, content, keywords=[])` | 同上，简化版 | SQLite 索引 |

---

## 5. 项目 / 话题管理

| 方法 | 用途 |
|------|------|
| `listProjects()` | 列出所有已注册项目 |
| `switchProject(nameOrPath)` | 切换到指定项目（保留 Agent 级记忆） |
| `listAllTopics()` | 列出当前项目下所有话题 |
| `switchTopic(newName)` | 切换到指定话题 |
| `loadTopicMessages(date, topic)` | 加载指定日期/话题的消息 |
| `restoreMostRecentTopic(preferredTopic='main')` | 启动时恢复最近一次话题 |
| `restoreTopic(date, topic)` | 恢复指定日期/话题 |

---

## 6. 角色管理（Persona）

| 方法 | 用途 |
|------|------|
| `listPersonas()` | 列出所有可用角色 |
| `switchPersona(name)` | 切换到指定角色（手动模式） |
| `setPersonaMode(mode)` | 设置匹配模式（'auto' / 'manual'） |
| `getPersonaMode()` | 读取当前匹配模式 |
| `getActivePersonaName()` | 读取当前激活的角色名 |

---

## 7. 工具注册 API（扩展点）

| 方法 | 用途 |
|------|------|
| `registerTool(definition, handler)` | 注册自定义工具（会话级） |
| `getToolDefinitions()` | 获取所有工具定义（内置 + 自定义） |
| `executeTool(name, argsJson)` | 执行工具调用 |
| `setWriteExtensions(ext)` | 注入写入扩展回调（diff 对比确认） |
| `setMemoryKeywords(keywords)` | 设置记忆关键词 |

### 7.1 内置工具（4 个）

| 工具名 | 用途 | 参数 |
|--------|------|------|
| `read_file` | 读取项目内文件内容 | `path` |
| `write_file` | 写入/创建文件 | `path`, `content`, `mode?`, `insert_line?` |
| `list_dir` | 列出目录内容 | `path?`, `recursive?`, `maxDepth?` |
| `search_memories` | 在记忆索引中搜索 | `query`, `limit?`, `mode?` |

### 7.2 扩展工具：宿主供能

Agent 本身无网络能力，所有"超纲"能力由宿主通过 `registerTool()` 提供。工具 handler 跑在宿主进程里，不受 Agent 安全层约束。

```typescript
// 网络搜索工具示例
agent.registerTool(
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

---

## 8. Provider 管理

| 方法 | 用途 |
|------|------|
| `setProvider(provider)` | 运行时切换前台 Provider |
| `setBackgroundProvider(provider)` | 运行时切换后台 Provider |

Agent 不再管理 Provider 映射表，宿主自行管理。

---

## 9. 配置建议 API

| 方法 | 用途 |
|------|------|
| `onConfigSuggestion(handler)` | 注册配置建议回调 |
| `confirmConfigSuggestion(suggestion)` | 确认建议，写入配置文件 |

**双写机制**：
- `addRule()` → 写 SQLite（会话级，临时）
- `confirmConfigSuggestion()` → 写 SQLite + 配置文件（持久化）

---

## 10. 完整 API 一览

按 API 分组（合计 **30 个公开方法**）：

### 生命周期（3）
- `new Agent(opts)` / `init()` / `close()`

### 对话（2）
- `chat(input, signal?)` / `chatSync(input, signal?)`

### 记忆读（4）
- `searchMemories()` / `inspect()` / `getMessages()` / `getStats()`

### 记忆写（4）
- `addRule()` / `addSimpleRule()` / `addSkill()` / `addSimpleSkill()`

### 项目 / 话题（7）
- `listProjects()` / `switchProject()` / `listAllTopics()` / `switchTopic()` / `loadTopicMessages()` / `restoreMostRecentTopic()` / `restoreTopic()`

### 角色（5）
- `listPersonas()` / `switchPersona()` / `setPersonaMode()` / `getPersonaMode()` / `getActivePersonaName()`

### 工具（5）
- `registerTool()` / `getToolDefinitions()` / `executeTool()` / `setWriteExtensions()` / `setMemoryKeywords()`

### Provider（2）
- `setProvider()` / `setBackgroundProvider()`

### 配置建议（2）
- `onConfigSuggestion()` / `confirmConfigSuggestion()`

---

## 11. 类型导出

```typescript
// Agent 与流式事件
export { Agent } from 'memora';
export type { AgentChunk, ThinkingPhase, AgentOptions, ProjectContext, MemorySnapshot } from 'memora';

// 工具
export type { ToolDefinition, ToolHandler, WriteExtensions } from 'memora';

// 配置建议
export type { ConfigSuggestion, ConfigSuggestionHandler } from 'memora';

// 记忆
export type { Memory, IMemoryStorage, ISessionStore, SessionMessage } from 'memora';
export { InMemoryStorage } from 'memora';

// 日志
export type { ILogger } from 'memora';
export { setLogger, logger } from 'memora';

// 召回
export { recall, extractKeywords } from 'memora';
export type { RecallOptions } from 'memora';

// 角色
export type { PersonaMode } from 'memora';

// 技能
export type { SkillEntry } from 'memora';

// LLM
export { createLlmProvider, createProviderFromConfig } from 'memora';
export type { ProviderConfig, LlmProvider } from 'memora';

// 配置
export { loadConfig } from 'memora';
export type { Config } from 'memora';

// 工具函数
export { segmentText, SOURCE_LABELS, inferSource, escapeLike } from 'memora';
```

---

## 12. 安全与约束

### 核心库零越界

| 检查项 | 结论 |
|--------|------|
| 核心库 `console.*` 调用 | 0 处 |
| 核心库 `process.stdin/stdout` | 0 处 |
| 核心库写配置文件 | 0 处 |
| 核心库 `readFileSync/writeFileSync` 写宿主业务文件 | 0 处 |

### 核心库零 LLM 配置加载

Agent 不知道 `apiKey`，宿主传入 `LlmProvider` 实例。

### 内部数据写入（不越界）

Agent 内部维护 `projects.json`（项目注册表）和 `.lock`（项目锁），路径在 `~/.memora/`，属于 Agent 自己的状态管理。

---

**版本**：v2.0  
**最后更新**：2026-06-12  
**配套文档**：[memora-接入指南-v1.0.md](./memora-接入指南-v1.0.md)（步骤式教程）
