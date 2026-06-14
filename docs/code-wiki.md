# Memora Code Wiki

> 本文档是 Memora 项目的结构化技术文档，涵盖项目架构、模块职责、关键类与函数、依赖关系及运行方式。

## 目录

- [1. 项目概览](#1-项目概览)
- [2. 技术栈](#2-技术栈)
- [3. 项目架构](#3-项目架构)
  - [3.1 核心设计哲学](#31-核心设计哲学)
  - [3.2 三层架构](#32-三层架构)
  - [3.3 目录结构](#33-目录结构)
- [4. 核心模块详解](#4-核心模块详解)
  - [4.1 Agent 模块](#41-agent-模块)
  - [4.2 Memory 模块](#42-memory-模块)
  - [4.3 LLM 模块](#43-llm-模块)
  - [4.4 Security 模块](#44-security-模块)
  - [4.5 Config 模块](#45-config-模块)
  - [4.6 Persona 模块](#46-persona-模块)
  - [4.7 Skill 模块](#47-skill-模块)
  - [4.8 Utils 模块](#48-utils-模块)
- [5. 关键类与接口](#5-关键类与接口)
- [6. 数据流与依赖关系](#6-数据流与依赖关系)
- [7. 运行方式](#7-运行方式)
- [8. 测试策略](#8-测试策略)

---

## 1. 项目概览

**Memora** 是一个通用 Agent 架构的纯逻辑库，设计哲学为"万物皆是记忆"。

- **定位**：本地、私有、领域无关的 AI Agent 内核
- **特点**：零 native 依赖，纯 JS/TS 实现
- **用途**：作为宿主项目（如 CLI、Web 应用）的底层 Agent 引擎

### 核心价值

| 特性 | 说明 |
|------|------|
| 纯逻辑库 | 不依赖 native 模块，宿主项目注入持久化实现 |
| 记忆驱动 | 统一记忆模型，所有配置/知识/对话皆为记忆 |
| 单 Agent 模型 | Agent 级 DB 全局共享，项目切换不重建 |
| 流式对话 | AsyncGenerator 实现流式输出，支持中断 |
| 安全优先 | 两级权限 + 路径白名单 + 写入确认 |

---

## 2. 技术栈

| 类别 | 选型 | 说明 |
|------|------|------|
| 运行时 | Node.js ≥ 22 LTS | 支持 ESM、Intl.Segmenter 等现代特性 |
| 语言 | TypeScript 5 strict | 严格模式，全量类型检查 |
| 模块系统 | ESM | import/export |
| 数据层 | IMemoryStorage 接口 | 宿主注入持久化实现 |
| LLM 协议 | OpenAI Chat Completions 兼容 | 支持多种 Provider |
| 测试 | Vitest | 快速、现代的测试框架 |
| 数据校验 | Zod | 运行时类型校验 |
| 日志 | Pino（可选） | 高性能结构化日志 |

### 依赖清单

```json
{
  "dependencies": {
    "zod": "^3.25.76"  // 唯一运行时依赖
  },
  "peerDependencies": {
    "pino": ">=9.0.0"  // 可选日志
  }
}
```

---

## 3. 项目架构

### 3.1 核心设计哲学

**"万物皆是记忆"** — 所有配置、知识、对话历史都统一为 `Memory` 类型，通过 `source` 开放字符串区分来源：

```typescript
interface Memory {
  id: string;          // 唯一标识（source:name）
  content: string;     // 记忆内容（Markdown）
  source: string;      // 来源标签（开放字符串）
  name: string;        // 可读名称
  createdAt: string;   // 创建时间
  accessedAt: string;  // 最后访问时间
  score: number;       // 权重（0-1）
}
```

**Source 标签约定**：

| 标签 | 说明 |
|------|------|
| `persona` | 角色人格（configDir/personas/*.md） |
| `rule` | 创作规则（configDir/rules/*.md） |
| `skill` | 技能定义（configDir/skills/*.md） |
| `insight` | 对话洞察（运行时 LLM 提取） |
| `profile` | 用户画像（运行时 LLM 提取） |
| `work-projection` | 作品投影（读取文件时生成） |

### 3.2 三层架构

```
┌─────────────────────────────────────────────────────────┐
│                    Agent 级配置                          │
│  configDir/ (personas, rules, skills)                   │
│  memora.db (Agent 级共享数据库)                          │
├─────────────────────────────────────────────────────────┤
│                    用户记忆层                            │
│  ~/.memora/ (用户级配置 + 项目注册表)                    │
├─────────────────────────────────────────────────────────┤
│                    项目级配置                            │
│  projectPath/.memora/ (项目 rules, skills)              │
└─────────────────────────────────────────────────────────┘
```

### 3.3 目录结构

```
src/
├── index.ts              # 库导出入口（纯类型 + 接口导出）
├── agent/                # Agent 门面 + 核心循环
│   ├── agent.ts          # Agent 门面类（宿主接入入口）
│   ├── loop.ts           # AgentLoop（核心执行引擎）
│   ├── toolExecutor.ts   # 工具执行器（内置 + 自定义工具）
│   ├── insightExtractor.ts # Insight 提取器
│   ├── configManager.ts  # 配置管理器
│   ├── memoryInspector.ts # 记忆查看器
│   ├── messageHistory.ts # 消息历史管理（含会话分叉）
│   ├── workProjection.ts # 作品投影管理器
│   └── types.ts          # Agent 类型定义
├── memory/               # 记忆引擎
│   ├── types.ts          # Memory 类型 + source 标签
│   ├── storageInterface.ts # IMemoryStorage 接口
│   ├── inMemoryStorage.ts # 内存存储实现（测试用）
│   ├── vectorStore.ts    # 向量存储（语义搜索）
│   ├── recall.ts         # 记忆召回（双通道）
│   ├── loader.ts         # 记忆加载器
│   ├── projectManager.ts # 项目管理器
│   ├── segmenter.ts      # 分词器
│   ├── frontmatter.ts    # Frontmatter 解析
│   ├── sessionStore.ts   # 会话存储抽象
│   ├── userProfile.ts    # 用户画像
│   └── store.ts          # FileStore
├── llm/                  # LLM 适配层
│   ├── provider.ts       # LlmProvider 抽象类
│   ├── types.ts          # LLM 类型定义
│   ├── openaiCompatible.ts # OpenAI 兼容实现
│   ├── embedding.ts      # 嵌入服务
│   └── factory.ts        # Provider 工厂
├── persona/              # 角色管理
│   └── personaManager.ts # PersonaManager
├── skill/                # 技能管理
│   └── skillManager.ts   # SkillManager
├── security/             # 安全策略
│   └── pathGuard.ts      # 路径白名单 + 审计日志 + 写入确认
├── config/               # 配置加载
│   └── loader.ts         # 配置加载器
├── logging/              # 日志抽象
│   ├── logger.ts         # Logger 实现
│   └── loggerInterface.ts # ILogger 接口
└── utils/                # 工具函数
    ├── errors.ts         # 错误类型
    ├── eventEmitter.ts   # 事件系统
    ├── math.ts           # 数学工具
    └── strings.ts        # 字符串工具（slugify）
```

---

## 4. 核心模块详解

### 4.1 Agent 模块

Agent 模块是项目的核心，负责组件组装和对话编排。

#### Agent 类（[agent.ts](src/agent/agent.ts)）

**职责**：宿主项目接入入口，一行代码接入 Memora。

```typescript
// 最简使用
const agent = new Agent({ projectPath: './my-project', provider: myProvider });
await agent.init();
for await (const chunk of agent.chat('你好')) {
  if (chunk.type === 'text') process.stdout.write(chunk.content);
}
await agent.close();
```

**核心方法**：

| 方法 | 说明 |
|------|------|
| `init()` | 初始化 Agent：加载索引、组装组件 |
| `chat()` | 流式对话（核心 API） |
| `chatSync()` | 非流式返回完整回复 |
| `switchProject()` | 切换项目 |
| `switchSession()` | 切换会话 |
| `forkSession()` | 分叉会话 |
| `close()` | 关闭 Agent，释放资源 |

**内部组件**：

```typescript
class Agent {
  private history: MessageHistory;      // 消息历史
  private loop: AgentLoop;              // 核心循环
  private toolExec: ToolExecutor;       // 工具执行器
  private personaManager: PersonaManager; // 角色管理
  private skillManager: SkillManager;   // 技能管理
  private insightExtractor: InsightExtractor; // Insight 提取
  private configManager: ConfigManager; // 配置管理
  private memoryInspector: MemoryInspector; // 记忆查看
  private workProjection: WorkProjectionManager; // 作品投影
}
```

#### AgentLoop 类（[loop.ts](src/agent/loop.ts)）

**职责**：Agent 的核心执行引擎，模型自主决定何时推理、何时调用工具。

**核心流程**：

```
用户输入 → 注入记忆召回 → LLM 推理 → 工具调用? → 继续循环 / 输出文本
```

**关键特性**：

- **上下文窗口管理**：自动截断超长消息，保留 system prompt + 最近对话
- **LLM 重试机制**：指数退避重试（流式输出前）
- **工具调用循环**：支持多轮工具调用
- **中断支持**：通过 AbortSignal 支持对话中断

#### ToolExecutor 类（[toolExecutor.ts](src/agent/toolExecutor.ts)）

**职责**：执行 LLM 发起的工具调用。

**内置工具**：

| 工具 | 说明 |
|------|------|
| `read_file` | 读取文件内容 |
| `write_file` | 写入文件（支持 overwrite/append/insert） |
| `list_dir` | 列出目录内容 |
| `search_memories` | 搜索记忆索引 |

**自定义工具注册**：

```typescript
agent.tools.registerTool({
  name: 'create_chapter',
  description: '创建小说章节',
  parameters: { ... }
}, async (args) => {
  // 实现逻辑
  return '章节创建成功';
});
```

#### InsightExtractor 类（[insightExtractor.ts](src/agent/insightExtractor.ts)）

**职责**：从对话中提取有价值的洞察，存入记忆。

**三层输入分类**：

1. **Layer 1 - 通用规则**：短输入、问候、确认 → skip
2. **Layer 2 - 宿主关键词**：领域关键词匹配 → extract
3. **Layer 3 - 默认提取**：宁可多提，不可漏提

**提取流程**：

```
对话内容 → LLM 提取 → 去重检查（Jaccard 相似度）→ 写入存储
```

---

### 4.2 Memory 模块

Memory 模块是记忆系统的核心，负责记忆的存储、检索和管理。

#### IMemoryStorage 接口（[storageInterface.ts](src/memory/storageInterface.ts)）

**职责**：定义记忆存储的抽象接口，解耦内核与具体数据库。

```typescript
interface IMemoryStorage {
  upsert(memory: Memory): void;
  delete(id: string): void;
  getById(id: string): Memory | null;
  getBySource(source: string): Memory[];
  search(query: string, limit?: number): Memory[];
  count(): number;
  countBySource(source: string): number;
  close?(): void;
}
```

**设计原则**：

- 所有方法同步（与 better-sqlite3 API 对齐）
- 宿主项目注入持久化实现（如 SqliteStorage）
- 测试环境使用 InMemoryStorage

#### InMemoryStorage 类（[inMemoryStorage.ts](src/memory/inMemoryStorage.ts)）

**职责**：IMemoryStorage 的纯 JS 内存实现。

**特点**：

- 零依赖、零 IO
- 不持久化，进程退出后数据丢失
- 使用 Map 存储，O(n) 搜索复杂度
- 适用于测试和开发环境

#### recall 函数（[recall.ts](src/memory/recall.ts)）

**职责**：从记忆存储中搜索相关记忆，实现双通道召回。

**召回策略**：

```
用户输入
  ├─ 通道 1：语义搜索（VectorStore）→ 向量余弦相似度
  └─ 通道 2：关键词搜索（IMemoryStorage）→ LIKE 匹配
      ↓
  合并去重 → 综合排序（vectorScore * 0.6 + memory.score * 0.4）
      ↓
  返回 Top N
```

**Score 衰减机制**：

- **召回提升**：每次被召回 score + 0.05（上限 1.0）
- **定期衰减**：超过 7 天未访问，每 7 天 score - 0.02（下限 0.1）

#### VectorStore 类（[vectorStore.ts](src/memory/vectorStore.ts)）

**职责**：向量存储，支持语义搜索。

**特点**：

- 纯 JS 实现，不引入外部向量库
- 内存 + JSON 持久化
- 支持余弦相似度搜索
- 适用于单用户本地场景（5k 条记录以内）

#### ProjectManager 类（[projectManager.ts](src/memory/projectManager.ts)）

**职责**：管理多项目的生命周期。

**核心功能**：

- **项目注册表**：管理已注册项目列表
- **锁文件机制**：防止同项目并发写入
- **两层记忆加载**：项目级 → Agent 级
- **项目切换**：只更新配置，不重建数据库

**锁文件策略**：

```typescript
interface LockInfo {
  pid: number;        // 持有锁的进程 PID
  acquiredAt: string; // 获取锁的时间
  hostname: string;   // 主机名
}
```

---

### 4.3 LLM 模块

LLM 模块负责与大语言模型的交互。

#### LlmProvider 抽象类（[provider.ts](src/llm/provider.ts)）

**职责**：定义 LLM Provider 的抽象接口。

```typescript
abstract class LlmProvider {
  abstract readonly name: string;
  abstract chat(messages: Message[], opts?: ChatOptions): AsyncIterable<LlmChunk>;
}
```

**Message 类型**：

```typescript
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  toolCallId?: string;
}
```

#### OpenAICompatibleProvider（[openaiCompatible.ts](src/llm/openaiCompatible.ts)）

**职责**：OpenAI Chat Completions 兼容协议实现。

**支持的 Provider**：

- DeepSeek
- 豆包
- OpenAI
- 自定义 Provider（需配置 baseUrl）

#### createLlmProvider 工厂（[factory.ts](src/llm/factory.ts)）

**职责**：根据配置创建 LLM Provider 实例。

```typescript
function createLlmProvider(config: ProviderConfig): LlmProvider;
function createProviderFromConfig(config: Config): LlmProvider;
```

---

### 4.4 Security 模块

Security 模块负责安全策略的实现。

#### SecurityGuard 类（[pathGuard.ts](src/security/pathGuard.ts)）

**职责**：路径白名单校验 + 审计日志。

**4 类允许路径**：

1. 项目目录（projectPath）
2. 数据目录（~/.memora）
3. 用户显式声明（allowedPaths）
4. 临时目录

**6 类禁止路径**：

```typescript
const BLOCKED_PATTERNS = [
  /(^|[\\/])\.ssh([\\/]|$)/i,      // SSH 密钥
  /(^|[\\/])\.aws([\\/]|$)/i,      // AWS 凭证
  /(^|[\\/])\.env$|(^|[\\/])\.env\.[^\\/.]+$/i, // 环境变量文件
  /[\\/]system32([\\/]|$)/i,       // Windows 系统目录
  /[\\/]Windows[\\/]System/i,      // Windows 系统目录
  /[\\/]etc[\\/]passwd/i,          // Linux 密码文件
];
```

**写入确认机制**：

```typescript
// guest 模式：始终要求确认
// owner + confirmWrites=true：要求确认
// owner + confirmWrites=false：自动批准

// 支持自定义确认回调（WebUI/桌宠场景）
securityGuard.onWriteConfirmation(async (info) => {
  return await showConfirmDialog(info.targetPath);
});
```

**审计日志**：

```typescript
interface AuditEvent {
  type: 'path-allow' | 'path-deny' | 'write-confirm' | 'write-decline' | 'write-auto';
  path: string;
  tool?: string;
  decision?: WriteDecision;
  reason?: string;
  timestamp: string;
}
```

---

### 4.5 Config 模块

Config 模块负责配置的加载和管理。

#### loadConfig 函数（[loader.ts](src/config/loader.ts)）

**职责**：加载配置文件，支持多 Provider 管理。

**配置优先级**：

1. `--config` 命令行参数
2. 项目级 `.memora/config.json`
3. 用户级 `~/.memora/config.json`
4. 内置默认值

**配置结构**：

```typescript
interface Config {
  llm: {
    provider: string;        // 默认 'mock'
    model: string;           // 默认 'deepseek-chat'
    baseUrl?: string;
    apiKey?: string;
    temperature: number;     // 默认 0.7
    providers?: Record<string, ProviderConfig>; // 多 Provider 映射表
    active?: string;         // 当前激活的 Provider
    background?: ProviderConfig; // 后台通道配置
  };
  memory: {
    dataDir: string;         // 默认 '~/.memora'
    maxContextTokens: number; // 默认 120000
  };
  security: {
    permission: 'owner' | 'guest'; // 默认 'owner'
    confirmWrites: boolean;        // 默认 false
  };
  allowedPaths: string[];
  persona?: string;          // 默认角色名
}
```

**环境变量展开**：

```json
{
  "llm": {
    "apiKey": "${MEMORA_LLM_API_KEY}"
  }
}
```

---

### 4.6 Persona 模块

Persona 模块负责角色管理。

#### PersonaManager 类（[personaManager.ts](src/persona/personaManager.ts)）

**职责**：加载和管理角色配置。

**功能**：

- 从 configDir/personas/*.md 加载角色
- 角色自动匹配（基于输入内容）
- 角色手动切换
- 构建角色 system prompt

---

### 4.7 Skill 模块

Skill 模块负责技能管理。

#### SkillManager 类（[skillManager.ts](src/skill/skillManager.ts)）

**职责**：加载和管理技能配置。

**功能**：

- 从 configDir/skills/*.md 加载技能
- 技能关键词匹配
- 技能 system prompt 注入

---

### 4.8 Utils 模块

Utils 模块提供通用工具函数。

#### TypedEventEmitter（[eventEmitter.ts](src/utils/eventEmitter.ts)）

**职责**：类型安全的事件发射器。

**支持的事件**：

```typescript
interface AgentEventMap {
  memoryAdded: { id: string; source: string; name: string };
  personaSwitched: { from: string | null; to: string };
  decayCompleted: { decayedCount: number };
  memoryRecalled: { count: number; query: string };
  sessionForked: { from: string; to: string; messageCount: number };
}
```

**使用方式**：

```typescript
agent.on('memoryAdded', (e) => console.log(e.source, e.name));
agent.on('personaSwitched', (e) => console.log(e.from, e.to));
agent.off('memoryAdded', handler);
```

#### 错误类型（[errors.ts](src/utils/errors.ts)）

```typescript
class MemoraError extends Error {
  title: string;
  detail?: string;
  suggestions?: string[];
}
```

---

## 5. 关键类与接口

### 核心接口

| 接口 | 文件 | 说明 |
|------|------|------|
| `Memory` | memory/types.ts | 记忆基元，7 个核心字段 |
| `IMemoryStorage` | memory/storageInterface.ts | 记忆存储抽象接口 |
| `LlmProvider` | llm/provider.ts | LLM Provider 抽象类 |
| `ISessionStore` | memory/sessionStore.ts | 会话存储抽象接口 |
| `EmbeddingService` | memory/vectorStore.ts | 嵌入服务接口 |
| `ILogger` | logging/loggerInterface.ts | 日志抽象接口 |
| `ToolDefinition` | agent/toolExecutor.ts | 工具定义接口 |
| `AgentEventMap` | utils/eventEmitter.ts | 事件映射表 |

### 核心类

| 类 | 文件 | 说明 |
|------|------|------|
| `Agent` | agent/agent.ts | Agent 门面类，宿主接入入口 |
| `AgentLoop` | agent/loop.ts | 核心执行引擎 |
| `ToolExecutor` | agent/toolExecutor.ts | 工具执行器 |
| `InsightExtractor` | agent/insightExtractor.ts | Insight 提取器 |
| `MessageHistory` | agent/messageHistory.ts | 消息历史管理 |
| `ProjectManager` | memory/projectManager.ts | 项目管理器 |
| `InMemoryStorage` | memory/inMemoryStorage.ts | 内存存储实现 |
| `VectorStore` | memory/vectorStore.ts | 向量存储 |
| `SecurityGuard` | security/pathGuard.ts | 安全守卫 |
| `PersonaManager` | persona/personaManager.ts | 角色管理器 |
| `SkillManager` | skill/skillManager.ts | 技能管理器 |
| `ConfigManager` | agent/configManager.ts | 配置管理器 |
| `MemoryInspector` | agent/memoryInspector.ts | 记忆查看器 |

### 工具函数

| 函数 | 文件 | 说明 |
|------|------|------|
| `recall` | memory/recall.ts | 记忆召回（双通道） |
| `extractKeywords` | memory/recall.ts | 关键词提取 |
| `decayScores` | memory/recall.ts | Score 衰减 |
| `loadConfig` | config/loader.ts | 配置加载 |
| `createLlmProvider` | llm/factory.ts | Provider 工厂 |
| `segmentText` | memory/segmenter.ts | 文本分词 |
| `tokenizeKeywords` | memory/segmenter.ts | 关键词分词 |

---

## 6. 数据流与依赖关系

### 初始化流程

```
宿主项目
  │
  ├─ new Agent({ projectPath, provider, configDir })
  │
  ├─ await agent.init()
  │     │
  │     ├─ ProjectManager.initProject()
  │     │     ├─ 加锁（.memora/.lock）
  │     │     ├─ 确保 Agent 级资源（IMemoryStorage）
  │     │     ├─ 两层记忆加载
  │     │     │     ├─ 项目级：.memora/rules/ + skills/
  │     │     │     └─ Agent 级：configDir/
  │     │     └─ 创建 SecurityGuard
  │     │
  │     ├─ _assembleComponents()
  │     │     ├─ MessageHistory
  │     │     ├─ WorkProjectionManager
  │     │     ├─ InsightExtractor
  │     │     ├─ ToolExecutor
  │     │     ├─ PersonaManager.load()
  │     │     ├─ UserProfile.load()
  │     │     ├─ SkillManager.load()
  │     │     ├─ ConfigManager
  │     │     ├─ AgentLoop
  │     │     └─ MemoryInspector
  │     │
  │     └─ 启动记忆衰减定时器
  │
  └─ agent 就绪
```

### 对话流程

```
用户输入
  │
  ├─ chat(input)
  │     │
  │     ├─ 并发锁检查（5 分钟超时）
  │     │
  │     ├─ 记忆召回（recall）
  │     │     ├─ 语义搜索（VectorStore）
  │     │     └─ 关键词搜索（IMemoryStorage）
  │     │
  │     ├─ 注入最近对话历史
  │     │
  │     ├─ 注入技能 prompt（如有）
  │     │
  │     ├─ AgentLoop.processUserInput()
  │     │     ├─ 包裹记忆召回结果
  │     │     ├─ LLM 推理（带重试）
  │     │     ├─ 工具调用循环
  │     │     └─ 输出文本
  │     │
  │     ├─ 后处理
  │     │     ├─ 用户画像归档
  │     │     ├─ 角色自动匹配
  │     │     ├─ 技能关键词匹配
  │     │     └─ Insight 提取
  │     │
  │     └─ 释放并发锁
  │
  └─ 返回 AsyncGenerator<AgentChunk>
```

### 组件依赖图

```
                    ┌─────────────┐
                    │   Agent     │
                    └──────┬──────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ AgentLoop     │  │ MessageHistory│  │ ToolExecutor  │
└───────┬───────┘  └───────┬───────┘  └───────┬───────┘
        │                  │                  │
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ LlmProvider   │  │IMemoryStorage │  │SecurityGuard  │
└───────────────┘  └───────────────┘  └───────────────┘
        │                  │
        ▼                  ▼
┌───────────────┐  ┌───────────────┐
│  VectorStore  │  │ MemoryLoader  │
└───────────────┘  └───────────────┘
```

---

## 7. 运行方式

### 环境要求

- Node.js ≥ 22.0.0
- npm ≥ 10.0.0

### 安装

```bash
npm install
```

### 构建

```bash
npm run build
```

### 测试

```bash
# 运行所有测试
npm test

# 监听模式
npm run test:watch

# 带覆盖率
npm run test:cov
```

### 代码检查

```bash
# ESLint
npm run lint

# 自动修复
npm run lint:fix

# Prettier
npm run format

# TypeScript 类型检查
npm run typecheck
```

### 宿主项目接入

```typescript
import { Agent, createLlmProvider, loadConfig } from '@memora/core';

// 1. 加载配置
const config = await loadConfig();

// 2. 创建 Provider
const provider = createLlmProvider(config.llm);

// 3. 创建 Agent
const agent = new Agent({
  projectPath: './my-project',
  provider,
  configDir: './agent-config',
  storage: mySqliteStorage, // 宿主注入
});

// 4. 初始化
await agent.init();

// 5. 流式对话
for await (const chunk of agent.chat('你好')) {
  if (chunk.type === 'text') process.stdout.write(chunk.content);
}

// 6. 关闭
await agent.close();
```

### 配置文件示例

```json
{
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "${DEEPSEEK_API_KEY}",
    "temperature": 0.7,
    "providers": {
      "deepseek": {
        "provider": "deepseek",
        "model": "deepseek-chat",
        "baseUrl": "https://api.deepseek.com",
        "apiKey": "${DEEPSEEK_API_KEY}"
      },
      "openai": {
        "provider": "openai",
        "model": "gpt-4o",
        "apiKey": "${OPENAI_API_KEY}"
      }
    },
    "active": "deepseek"
  },
  "memory": {
    "dataDir": "~/.memora",
    "maxContextTokens": 120000
  },
  "security": {
    "permission": "owner",
    "confirmWrites": false
  },
  "allowedPaths": [],
  "persona": "default"
}
```

---

## 8. 测试策略

### 测试金字塔

```
        /\
       /  \        E2E 测试（少量）
      /    \
     /------\      集成测试（中量）
    /        \
   /----------\    单元测试（大量）
```

### 测试工具

- **Vitest**：测试框架
- **MSW**：Mock LLM 请求
- **InMemoryStorage**：测试用存储实现

### 测试文件位置

```
src/
├── agent/__tests__/
│   ├── agent.test.ts
│   ├── loop.test.ts
│   ├── toolExecutor.test.ts
│   └── ...
├── memory/__tests__/
│   ├── recall.test.ts
│   ├── store.test.ts
│   └── ...
├── llm/__tests__/
│   ├── openaiCompatible.test.ts
│   └── ...
└── ...
```

### 运行测试

```bash
# 运行所有测试
npm test

# 运行特定测试文件
npm test -- agent.test.ts

# 运行带关键词的测试
npm test -- -t "recall"
```

---

## 附录

### A. 错误处理

Memora 使用自定义错误类型 `MemoraError`：

```typescript
throw configError(
  'Agent 未初始化',           // title
  '请先调用 init()',          // detail
  ['在 chat() 前调用 await agent.init()'] // suggestions
);
```

### B. 事件系统

Agent 暴露 5 种事件：

| 事件 | 载荷 | 说明 |
|------|------|------|
| `memoryAdded` | `{ id, source, name }` | 记忆被写入 |
| `personaSwitched` | `{ from, to }` | 角色被切换 |
| `decayCompleted` | `{ decayedCount }` | 衰减完成 |
| `memoryRecalled` | `{ count, query }` | 记忆被召回 |
| `sessionForked` | `{ from, to, messageCount }` | 会话被分叉 |

### C. AgentChunk 类型

流式对话输出的事件类型：

```typescript
type AgentChunk =
  | { type: 'recall'; count: number }
  | { type: 'thinking'; phase: 'recalling' | 'processing' | 'archiving' }
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string; args?: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary?: string }
  | { type: 'aborted'; reason: string }
  | { type: 'done' };
```

### D. 相关文档

- [ADR-001 运行时栈](.trae/rules/decisions/ADR-001-runtime-stack.md)
- [ADR-002 存储层](.trae/rules/decisions/ADR-002-storage-layer.md)
- [ADR-003 LLM 适配层](.trae/rules/decisions/ADR-003-llm-adapter.md)
- [ADR-004 记忆统一](.trae/rules/decisions/ADR-004-memory-unification.md)
- [ADR-006 安全模型](.trae/rules/decisions/ADR-006-security-model.md)
- [ADR-008 目录结构](.trae/rules/decisions/ADR-008-directory-structure.md)

---

*文档生成时间：2026-06-14*
*项目版本：0.1.0*
