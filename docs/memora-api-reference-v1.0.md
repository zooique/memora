# Memora 内核 API 参考手册（v1.0）

> **核心定位**：Memora 是一个**无法独立运行**的智能大脑内核——它只有接口，没有"形态"。CLI、WebUI、桌面精灵、小说生成器都是它的"宿主"，宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。
>
> **本文件用途**：
>
> 1. 列出当前 Agent 对外暴露的**全部公开 API**
> 2. 标注**盲点 API**（已识别但未实现，避免宿主对接时踩坑）
> 3. **越界检查**：证明 Memora 内核不包含任何"宿主级"逻辑

---

## 1. 设计哲学：Memora = 大脑，宿主 = 身体

```
┌────────────────────────────────────────────────────────────┐
│  宿主程序（任意：CLI / 桌面精灵 / 小说生成器 / WebUI）      │
│                                                            │
│  ┌─────────────────┐    ┌──────────────────┐               │
│  │ LLM Provider 实例 │◄───│ API Key / baseUrl │  ← 宿主职责  │
│  └────────┬────────┘    └──────────────────┘               │
│           │ 注入                                            │
│           ▼                                                 │
│  ┌──────────────────────────────────────────┐               │
│  │  Memora 内核（Agent）                    │               │
│  │                                          │               │
│  │  - chat(input) → 流式响应                │               │
│  │  - 记忆搜索 / 归档 / 挂载                │               │
│  │  - 角色匹配 / 技能匹配 / 信号检测         │               │
│  │  - 工具注册 / 工具执行                   │               │
│  │                                          │               │
│  │  ⚠️ 不包含：                            │               │
│  │  - 任何 UI（console/HTML/Electron）       │               │
│  │  - 任何 LLM 配置加载逻辑                │               │
│  │  - 任何"用户配置"模板生成                │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

**设计原则**：

- **零依赖**（除 Node.js 内置模块 + 必要的 LLM SDK）
- **零控制台输出**（核心库不调用 `console.*`，仅 `src/cli/` 和 `src/index.ts`
  CLI 入口使用）
- **零写用户文件**（`personas/rules/skills/tools`
  真理源是宿主管理的配置文件，agent 不直接写）

---

## 2. 构造与生命周期

### 2.1 构造选项 `AgentOptions`

```typescript
import { Agent } from 'memora';

export interface AgentOptions {
  /** 项目路径（必须）— 宿主工程的根目录 */
  projectPath: string;

  /** 前台 LLM Provider（必须）— 宿主负责创建 */
  provider: LlmProvider;

  /** 后台 LLM Provider（可选）— 归档/投影等后台操作，不配时复用前台 */
  backgroundProvider?: LlmProvider;

  /** 归档模式（默认 'full'）：控制 chat() 中自动归档行为 */
  archiveMode?: 'full' | 'insights-only' | 'manual';

  /** 记忆数据目录（默认 ~/.memora）— 存放 memora.db + topics/ */
  dataDir?: string;

  /** 最大上下文 token 数（默认 120000）— 超出会自动截断 */
  maxContextTokens?: number;

  /** 默认角色名（persona 文件名，不含 .md 后缀） */
  persona?: string;

  /** 安全权限（默认 'owner'）— 'guest' 受更多限制 */
  permission?: 'owner' | 'guest';

  /** 允许读写的路径白名单（默认 [] = 全部允许） */
  allowedPaths?: string[];

  /** 写入操作前是否需要确认回调（默认 false） */
  confirmWrites?: boolean;
}
```

**关键变化**（v2.0 架构重构后）：Agent **不再接收** `Config`
对象，不再自己解析 API Key。

### 2.2 生命周期方法

| 方法                                                         | 用途                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `new Agent(opts)`                                            | 构造函数（无副作用，**不连接 LLM**）                                                 |
| `agent.init(projectPathOverride?)` → `Promise<AgentContext>` | 初始化：建立 SQLite、加载 personas/rules/skills、初始化组件                          |
| `agent.close()`                                              | 关闭：释放数据库连接、释放项目锁                                                     |
| `agent.inspect()`                                            | **同步**返回 4 层记忆快照（working / bootstrap / archive / mounted），供宿主 UI 渲染 |

**状态机**：

```
[构造] --init()--> [已初始化] --chat()/其他方法...--> [已初始化]
                              --close()--> [已关闭]
```

未初始化时调用任何 `chat()` / `inspect()` / `addRule()` 等方法**抛
`configError`**。

---

## 3. 对话 API（最核心）

### 3.1 `chat(input, signal?)` — 流式对话

```typescript
async *chat(input: string, signal?: AbortSignal): AsyncGenerator<AgentChunk, void, unknown>
```

**唯一**的对话入口。**流式**返回 `AgentChunk` 事件。可选传入 `signal`（来自
`AbortController.signal`），允许宿主取消正在进行的对话。

```typescript
type AgentChunk =
  | { type: 'thinking'; phase: ThinkingPhase } // 推理阶段
  | { type: 'recall'; count: number } // 话题记忆挂载
  | { type: 'text'; content: string } // LLM 文本片段
  | { type: 'tool_start'; name: string; args?: string }
  | { type: 'tool_result'; name: string; ok: boolean; summary?: string }
  | { type: 'aborted'; reason: string } // 对话被取消
  | { type: 'done' }; // 结束标记
```

**使用示例**（宿主最简接入，含取消支持）：

```typescript
const agent = new Agent({ projectPath, provider });
await agent.init();

const controller = new AbortController();

for await (const chunk of agent.chat('你好', controller.signal)) {
  switch (chunk.type) {
    case 'text':
      ui.appendText(chunk.content);
      break;
    case 'thinking':
      ui.showThinking(chunk.phase);
      break;
    case 'tool_start':
      ui.showToolStart(chunk.name);
      break;
    case 'tool_result':
      ui.showToolResult(chunk.ok);
      break;
    case 'aborted':
      ui.showCancelled(chunk.reason);
      break;
  }
}

// 用户在 UI 点击"取消"按钮
cancelButton.onclick = () => controller.abort();

await agent.close();
```

### 3.2 `chatSync(input, signal?)` — 同步版（测试用）

```typescript
async chatSync(input: string, signal?: AbortSignal): Promise<string>
```

收集所有 `text` 事件拼接成完整字符串返回。**仅供测试用**，生产宿主应使用
`chat()` 流式。

---

## 4. 记忆 API

### 4.1 读记忆

| 方法                              | 用途                                         | 返回                               |
| --------------------------------- | -------------------------------------------- | ---------------------------------- |
| `searchMemories(query, limit=10)` | 模糊关键词搜索                               | `AgentSearchHit[]`                 |
| `getMountedMemories()`            | 当前话题挂载的所有记忆                       | `AgentMountedMemory[]`             |
| `unmountMemory(name)`             | 踢出指定挂载记忆（会话级抑制）               | `{ removed, name?, id?, reason? }` |
| `inspect()`                       | 4 层记忆快照（同步、轻量）                   | `MemorySnapshot`                   |
| `getMessages()`                   | 当前 AgentLoop 的全部消息（工作记忆）        | `readonly Message[]`               |
| `getStats()`                      | 记忆库统计（按 type 分组、总数、话题文件数） | `AgentStats`                       |

### 4.2 写记忆（运行时 / 会话级）

| 方法                                         | 用途                   | 写到哪里                                         |
| -------------------------------------------- | ---------------------- | ------------------------------------------------ |
| `addRule(memory)`                            | 添加一条规则（会话级） | SQLite 索引                                      |
| `addSimpleRule(name, content, keywords=[])`  | 同上，简化版           | SQLite 索引                                      |
| `addSkill(memory)`                           | 添加一个技能（会话级） | SQLite 索引                                      |
| `addSimpleSkill(name, content, keywords=[])` | 同上，简化版           | SQLite 索引                                      |
| `archiveApprovedContent(content?)`           | 手动归档定稿内容       | 触发 `TopicSummarizer`，最终落盘到 `topics/*.md` |

**重要**：

- 这些是**会话级**写入（重启后失效），不是写配置文件
- 真正的"持久化"通过 `confirmConfigSuggestion()` 写宿主配置文件

### 4.3 归档控制

| 方法                              | 用途                                                      |
| --------------------------------- | --------------------------------------------------------- |
| `setArchiveMode(mode)`            | 运行时切换归档模式（'full' / 'insights-only' / 'manual'） |
| `getArchiveMode()`                | 读取当前归档模式                                          |
| `waitForArchives(timeoutMs=5000)` | 等待所有后台归档完成（供宿主优雅关闭）                    |

**归档模式**：

- `'full'`（默认）：所有内容自动归档
- `'insights-only'`：只自动归档用户洞察，话题归档需宿主手动触发（适合"草稿/定稿"工作流）
- `'manual'`：完全不自动归档

---

## 5. 项目 / 话题管理

| 方法                                            | 用途                                                   |
| ----------------------------------------------- | ------------------------------------------------------ |
| `listProjects()`                                | 列出所有已注册项目（`~/.memora/projects.json`）        |
| `switchProject(nameOrPath)`                     | 切换到指定项目（**保留 Agent 级记忆**，不重建 SQLite） |
| `listAllTopics()`                               | 列出当前项目下所有话题文件                             |
| `switchTopic(newName)`                          | 切换到指定话题（触发归档 + 重建 AgentLoop）            |
| `restoreMostRecentTopic(preferredTopic='main')` | 启动时恢复最近一次话题                                 |
| `restoreTopic(date, topic)`                     | 恢复指定日期/话题                                      |

---

## 6. 角色管理（Persona）

| 方法                     | 用途                                                  |
| ------------------------ | ----------------------------------------------------- |
| `listPersonas()`         | 列出所有可用角色                                      |
| `switchPersona(name)`    | 切换到指定角色（手动模式）                            |
| `setPersonaMode(mode)`   | 设置匹配模式（'auto' 关键词匹配 / 'manual' 手动固定） |
| `getPersonaMode()`       | 读取当前匹配模式                                      |
| `getActivePersonaName()` | 读取当前激活的角色名                                  |

**角色匹配自动 vs 手动**：

- `auto`：根据用户输入的关键词自动选择最匹配的角色
- `manual`：使用 `switchPersona()` 设置的固定角色

---

## 7. 工具注册 API（扩展点）

| 方法                                | 用途                              |
| ----------------------------------- | --------------------------------- |
| `registerTool(definition, handler)` | 注册自定义工具（会话级）          |
| `getToolDefinitions()`              | 获取所有工具定义（内置 + 自定义） |
| `executeTool(name, argsJson)`       | 执行工具调用（供宿主内部委托）    |

**关键设计**（见
[方案-工具注册机制与小说示例-v1.0.md](./方案-工具注册机制与小说示例-v1.0.md)）：

- 宿主的"领域工具"（如 `create_chapter`）通过 `registerTool()` 注册
- 领域工具的 handler 可调用 `executeTool('read_file', ...)` /
  `executeTool('write_file', ...)` 复用内置工具的安全层
- **核心库不写任何业务文件**——所有领域操作都委托给宿主注册的工具

### 7.1 内置工具（4 个）

| 工具名            | 用途               | 参数                                                                  |
| ----------------- | ------------------ | --------------------------------------------------------------------- |
| `read_file`       | 读取项目内文件内容 | `path`（相对路径）                                                    |
| `write_file`      | 写入/创建文件      | `path`, `content`, `mode?`（overwrite/append/insert）, `insert_line?` |
| `list_dir`        | 列出目录内容       | `path?`, `recursive?`, `maxDepth?`                                    |
| `search_memories` | 在记忆索引中搜索   | `query`, `limit?`, `mode?`（match/near）                              |

### 7.3 扩展工具：宿主供能（Agent 无网络，宿主供网）

**核心原则**：Agent 本身不持有任何网络能力，不依赖外部服务。所有"超纲"能力——联网搜索、网页抓取、第三方 API 调用——均由宿主在
`init()` 后通过 `registerTool()`
注册。Agent 只决定"调用哪个工具"，工具的实际执行发生在宿主进程内，不受 Agent 安全层的路径白名单约束。

**工具 handler 的执行原理**：

```typescript
// Agent 看到的是一个"名叫 web_search 的工具"，参数是 { query, limit }
// Agent 不知道、也不需要知道 handler 里有没有网络请求
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
    // Node.js 18+ 原生 fetch，无需额外依赖
    const res = await fetch(
      `https://api.example.com/search?q=${encodeURIComponent(args.query)}&limit=${args.limit ?? 5}`,
    );
    const data = await res.json();
    return JSON.stringify(data.results ?? []);
  },
);
```

**搜索与抓取是两类工具**：

| 工具         | 职责                            | 典型场景                       |
| ------------ | ------------------------------- | ------------------------------ |
| `web_search` | 搜索引擎查关键词，返回 URL 列表 | "帮我查一下这篇论文的引用情况" |
| `web_fetch`  | 指定 URL 抓正文，返回原文       | "把这篇文章的摘要读给我听"     |

两者可以独立注册，也可以组合使用（先搜到相关页面，再抓正文内容）。Provider 任意选择——腾讯元宝、DuckDuckGo、本地 Ollama、任意 HTTP
API——Agent 零感知。

**搜索结果的记忆归属**：联网结果默认不进 SQLite，是上下文燃料、用完即焚。如需归档，由宿主显式调用
`archiveApprovedContent()` 或 signal-detector 触发，Agent 不会主动写入。

### 7.4 写入确认与 Diff 对比（WriteExtensions）

**核心机制**：`write_file` 工具支持 `WriteExtensions.onBeforeWrite`
回调，用于**局部修改的 diff 对比确认**。

```typescript
export interface WriteExtensions {
  /**
   * 写入前回调（宿主实现 diff 对比 + 用户确认）
   * @param path 相对路径
   * @param beforeContent 文件旧内容（null 表示新文件）
   * @param afterContent 要写入的新内容
   * @returns true 继续写入，false 拒绝写入
   */
  onBeforeWrite?: (
    path: string,
    beforeContent: string | null,
    afterContent: string,
  ) => Promise<boolean>;
}
```

**小说生成器场景**：

1. LLM 调用 `write_file` 修改第 3 章内容
2. `onBeforeWrite` 回调被触发，收到 `beforeContent`（旧内容）和
   `afterContent`（新内容）
3. 宿主渲染 diff 对比面板，用户确认后返回 `true`
4. Agent 执行写入

**注意**：`WriteExtensions` 当前通过 `ToolExecutor`
构造函数传入，**尚未在 Agent 门面类暴露**。这是盲点 API 之一（见 §10）。

---

## 8. Provider 管理（v2.0 重构后）

| 方法                      | 用途                                          |
| ------------------------- | --------------------------------------------- |
| `setProvider(provider)`   | 运行时切换前台 Provider（同步更新 AgentLoop） |
| `get provider()` (getter) | 读取当前前台 Provider 实例                    |
| `provider` (公开字段)     | 构造时传入的前台 Provider                     |

**重构说明**：Agent 不再管理 Provider 映射表、活跃 Provider 名、Provider 切换。宿主自行管理这些。

---

## 9. 配置建议 API（模式 3 · 智能总结）

| 方法                                  | 用途                                                      |
| ------------------------------------- | --------------------------------------------------------- |
| `onConfigSuggestion(handler)`         | 注册配置建议回调（从对话中提取）                          |
| `confirmConfigSuggestion(suggestion)` | 确认建议，写入配置文件（这是 Agent 唯一写配置文件的地方） |

**双写机制**：

- `addRule()` → 写 SQLite（会话级，临时）
- `confirmConfigSuggestion()` → 写 SQLite + 配置文件（持久化）

**宿主 UI 模式**（[方案-示例生态-v1.0.md](./方案-示例生态-v1.0.md) §3）：

- 桌面精灵：弹气泡让用户确认
- CLI：打印到终端
- WebUI：弹窗

---

## 10. 盲点 API（已识别未实现）

> 这些是接入实际宿主时**可能需要但当前缺失**的 API。按优先级标注。以小说生成器为首个宿主场景验证。

### 小说生成器 10 项需求核对

| #   | 需求                                           | 当前 API                                                           | 状态                       |
| --- | ---------------------------------------------- | ------------------------------------------------------------------ | -------------------------- |
| 1   | 配置大模型 API 接入对话                        | `new Agent({ provider })` + `chat(input)`                          | ✅ 已有                    |
| 2   | 配置大模型 API 对接后台记忆挂载和读取          | `new Agent({ backgroundProvider })` + 自动挂载                     | ✅ 已有                    |
| 3   | 把宿主的 agent 配置文件夹对接                  | `new Agent({ configDir })` → init() 自动加载 personas/rules/skills | ✅ 已有                    |
| 4   | 大模型能读取本地项目的文件级别内容             | 内置工具 `read_file` + `list_dir`                                  | ✅ 已有                    |
| 5   | 大模型能把返回的数据写入到具体文件中           | 内置工具 `write_file`（overwrite/append/insert）                   | ✅ 已有                    |
| 6   | 支持局部修改内容的对比确认                     | `WriteExtensions.onBeforeWrite` 回调                               | ⚠️ **未暴露到 Agent 门面** |
| 7   | 能查看当前所有的角色                           | `listPersonas()`                                                   | ✅ 已有                    |
| 8   | 能手动切换指定角色                             | `switchPersona(name)`                                              | ✅ 已有                    |
| 9   | 能实时查看当前回答问题的角色                   | `getActivePersonaName()`                                           | ✅ 已有                    |
| 10  | 能查看当前的记忆挂载情况，手动剔除不想要的记忆 | `getMountedMemories()` + `unmountMemory(name)`                     | ✅ 已有                    |

**结论**：10 项需求中 9 项已有 API，1 项（#6 局部修改对比确认）需要补。

### P0 · 必须补（小说生成器跑通需要）

| API                               | 用途                                                                             | 当前替代方案                                      |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------- |
| `setWriteExtensions(ext)`         | 暴露 `WriteExtensions.onBeforeWrite` 到 Agent 门面，宿主可注入 diff 对比确认回调 | 无（当前 WriteExtensions 只在 ToolExecutor 内部） |
| `setBackgroundProvider(provider)` | 运行时切换后台 Provider                                                          | 当前只能在构造时定                                |

### P1 · 增强功能

| API                      | 用途                                                        | 当前替代方案                     |
| ------------------------ | ----------------------------------------------------------- | -------------------------------- |
| `queryMemories(filter)`  | 按 `{ type, permanence, name }` 精确过滤                    | 用 `searchMemories()` 模糊搜索   |
| `onEvent(type, handler)` | 通用事件订阅（话题切换/归档完成/画像更新）                  | 无                               |
| `getPersonasDetailed()`  | 返回角色的完整 metadata（不仅是 name/description/keywords） | 内部 PersonaManager 有，但未透出 |

### P2 · 边缘场景

| API                      | 用途                            | 当前替代方案   |
| ------------------------ | ------------------------------- | -------------- |
| `forceArchiveNow()`      | 立即触发归档，跳过所有 throttle | 无             |
| `getMemoryById(id)`      | 按 ID 精确查询                  | 走 SQLite 查询 |
| `setAllowedPaths(paths)` | 运行时更新路径白名单            | 构造时定       |

**决策原则**：P0 在第一个宿主实际接入时补；P1/P2 按需补。

---

## 11. 越界检查（边界确认）

### ✅ 核心库零越界

| 检查项                                             | 结论                                                     |
| -------------------------------------------------- | -------------------------------------------------------- |
| 核心库 `console.*` 调用                            | **0 处**（仅 `src/cli/` 和 `src/index.ts` CLI 入口使用） |
| 核心库 `process.stdin/stdout`                      | **0 处**                                                 |
| 核心库 `readline/picocolors/chalk`                 | **0 处**                                                 |
| 核心库写 `personas/*.md`                           | **0 处**（配置文件是真理源，由宿主/CLI 管理）            |
| 核心库写 `rules/*.md`                              | **0 处**                                                 |
| 核心库写 `skills/*.md`                             | **0 处**                                                 |
| 核心库 `readFileSync/writeFileSync` 写宿主业务文件 | **0 处**                                                 |

### ⚠️ 内部数据写入（不越界）

Agent 内部维护的 `projects.json`（项目注册表）和 `.lock`（项目锁）：

- 路径：`~/.memora/`（Agent 数据目录，**非用户项目**）
- 用途：单 Agent 多项目支持、并发保护
- **非宿主业务文件**，属于 Agent 自己的状态管理

### ✅ 核心库零 LLM 配置加载

| 检查项                           | 结论                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| Agent 引用 `Config` 类型         | **0 处**（仅 `repl.ts`/`index.ts`/`config.ts` CLI 层引用） |
| Agent 引用 `loadConfig()`        | **0 处**                                                   |
| Agent 引用 `createLlmProvider()` | **0 处**                                                   |
| Agent 知道 `apiKey`              | **0 处**（宿主传入 `LlmProvider` 实例，agent 不解析）      |

### ✅ 核心库零"用户配置向导"

`src/cli/commands/init.ts` 的"memora
init"命令是 CLI 层的引导工具，**不属于核心库**：

- 宿主可以跳过这个（直接创建 `agent-config/personas/*.md`）
- 宿主也可以自己写一个等效的"配置向导"

---

## 12. 类型导出

宿主接入需要的核心类型（已从 `memora` 顶层导出）：

```typescript
// Agent 与流式事件
export { Agent } from 'memora';
export type { AgentChunk, ThinkingPhase } from 'memora';

// 工具
export type { ToolDefinition, ToolHandler } from 'memora';

// 配置建议
export type { ConfigSuggestion, ConfigSuggestionHandler } from 'memora';

// 记忆
export { MemoryType, Permanence } from 'memora';
export type { Memory, MemoryTypeValue, PermanenceValue } from 'memora';

// 角色
export type { PersonaMode } from 'memora';

// 技能
export type { SkillEntry } from 'memora';

// LLM 宿主用（创建 Provider 所需）
export { createLlmProvider, createProviderFromConfig } from 'memora';
export type { ProviderConfig, LlmProvider } from 'memora';

// 配置文件加载（CLI/宿主自行管理）
export { loadConfig } from 'memora';
export type { Config } from 'memora';
```

**注意**：

- `createLlmProvider` / `loadConfig` / `Config`
  是给**宿主**用的，不是给 Agent 用的
- 宿主自己管理这些；agent 不依赖它们

---

## 13. 完整 API 一览

按 API 分组（合计 **39 个公开方法 + 1 个公开属性 + 12 个导出类型**）：

### 13.1 生命周期（3）

- `new Agent(opts)`
- `init(projectPathOverride?)`
- `close()`

### 13.2 对话（2）

- `chat(input, signal?)` ← 唯一对话入口
- `chatSync(input, signal?)` ← 测试用

### 13.3 记忆读（6）

- `searchMemories(query, limit)`
- `getMountedMemories()`
- `unmountMemory(name)`
- `inspect()` ← 4 层快照
- `getMessages()`
- `getStats()`

### 13.4 记忆写 / 归档（7）

- `addRule(memory)`
- `addSimpleRule(name, content, keywords)`
- `addSkill(memory)`
- `addSimpleSkill(name, content, keywords)`
- `archiveApprovedContent(content?)`
- `setArchiveMode(mode)` / `getArchiveMode()`
- `waitForArchives(timeoutMs)`

### 13.5 项目 / 话题（6）

- `listProjects()`
- `switchProject(nameOrPath)`
- `listAllTopics()`
- `switchTopic(newName)`
- `restoreMostRecentTopic(preferredTopic)`
- `restoreTopic(date, topic)`

### 13.6 角色（5）

- `listPersonas()`
- `switchPersona(name)`
- `setPersonaMode(mode)` / `getPersonaMode()`
- `getActivePersonaName()`

### 13.7 工具（3）

- `registerTool(definition, handler)`
- `getToolDefinitions()`
- `executeTool(name, argsJson)`

### 13.8 Provider（2）

- `setProvider(provider)`
- `get provider()` (getter)

### 13.9 配置建议（2）

- `onConfigSuggestion(handler)`
- `confirmConfigSuggestion(suggestion)`

### 13.10 只读访问器（5）

- `initialized` (getter)
- `context` (getter)
- `agentLoop` (getter)
- `agentHistory` (getter)
- `lastInteractionAt` (getter)
- `isBusy` (getter) ← 泊文 UI 刚需：禁用输入框 + 加载动画

### 13.11 导出类型（12）

- `AgentChunk`, `ThinkingPhase`
- `ToolDefinition`, `ToolHandler`
- `ConfigSuggestion`, `ConfigSuggestionHandler`
- `Memory`, `MemoryTypeValue`, `PermanenceValue`
- `PersonaMode`
- `SkillEntry`
- `ProviderConfig`
- `LlmProvider`
- `Config`

---

## 14. 完整使用示例（最简宿主）

```typescript
// 宿主程序：桌面精灵
import { Agent, createLlmProvider } from 'memora';
import type { AgentChunk } from 'memora';

class DesktopPetHost {
  private agent: Agent;
  private provider = createLlmProvider({
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKey: process.env.DEEPSEEK_API_KEY!,
    baseUrl: 'https://api.deepseek.com/v1',
  });

  async start() {
    // 1. 构造 Agent（仅 API，不写文件）
    this.agent = new Agent({
      projectPath: this.userProjectPath,
      provider: this.provider,
      persona: '小灰', // agent-config/personas/小灰.md
      archiveMode: 'insights-only', // 草稿/定稿工作流
      maxContextTokens: 80000, // 桌面精灵长运行
    });

    // 2. 初始化（建立 SQLite，加载记忆）
    await this.agent.init();

    // 3. 注册领域工具
    this.agent.registerTool(
      {
        name: 'remember_fact',
        description: '记住用户的事实信息',
        parameters: {
          /* ... */
        },
      },
      async (args) => {
        const { fact } = JSON.parse(args);
        // 通过 agent 写记忆（会话级）
        await this.agent.addSimpleRule(fact, '', ['user-fact']);
        return 'ok';
      },
    );

    // 4. 对话循环
    for await (const chunk of this.agent.chat(this.currentUserInput)) {
      switch (chunk.type) {
        case 'text':
          this.petBubble.appendText(chunk.content);
          break;
        case 'thinking':
          this.petBubble.showThinking();
          break;
        case 'tool_start':
          this.petBubble.showToolStart(chunk.name);
          break;
        case 'tool_result':
          this.petBubble.showToolResult(chunk.ok);
          break;
      }
    }

    // 5. 优雅关闭
    await this.agent.waitForArchives(10000);
    await this.agent.close();
  }

  // 运行时切换 Provider（用户在设置里改 API Key）
  switchTo(newProviderConfig: any) {
    const newProvider = createLlmProvider(newProviderConfig);
    this.agent.setProvider(newProvider);
    this.provider = newProvider;
  }
}
```

**关键观察**：

- 宿主只调用 `createLlmProvider()`（用 memora 导出的工具函数）创建 Provider
- 宿主自己管 `apiKey` / `baseUrl` / `model`（甚至可以不走 `createLlmProvider`
  而自己实现 `LlmProvider` 接口）
- Agent 不直接 import 任何"配置"或"API Key"概念

---

## 15. 内核化检查清单

对任何想把 Memora 接到自己宿主的人：

- [ ] 宿主管 LLM API Key（不传给 Agent 任何 Key 字符串）
- [ ] 宿主管 UI（console/HTML/Electron 都行，核心库不关心）
- [ ] 宿主管用户配置文件（`agent-config/personas/*.md` 等），Agent 只读
- [ ] 宿主管文件系统操作（通过 `executeTool('read_file', ...)`
      委托给 agent 内部的安全层）
- [ ] 宿主在 `close()` 前调用 `waitForArchives()` 保证后台归档完成

满足以上 5 条，Memora 就是"大脑"，宿主就是"身体"，分工清晰。

---

**版本**：v1.0  
**最后更新**：2026-06-06  
**配套文档**：[memora-接入指南-v1.0.md](./memora-接入指南-v1.0.md)（步骤式教程）、[记忆系统设计介绍-v1.0.md](./记忆系统设计介绍-v1.0.md)（概念级介绍）
