# Memora · 接入指南 v2.0

> 帮助宿主项目开发者快速理解 Memora 的设计理念和接入方法。
>
> **v2.0 重大变更**：Agent 不再接收 `Config` 对象，改为接收 `LlmProvider`
> 实例。宿主自行管理 API Key / baseUrl / model 配置，Agent 只关心"用什么 LLM"。

---

## 一、核心理念

**Memora 是一个无法独立运行的智能大脑内核。**
它只有接口，没有"形态"——CLI、WebUI、桌面精灵、小说生成器都是它的"宿主"，宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。

**万物皆是记忆。**
角色、规则、技能、工具定义、对话历史——全部统一为「记忆」，通过 `类型 + 永久性`
两个维度区分。

**单 Agent 模型。**
Memora 被宿主接入后，就是该程序的唯一 Agent。所有对话、所有记忆存在同一个数据库中，**切换子项目不会丢失记忆**。

**配置文件是真理源，SQLite 是运行时索引。** `agent-config/`
下的配置文件由 MemoryLoader 在启动时扫描，加载到 SQLite 中。记忆自动归档（UserProfile、话题摘要、对话快照 →
SQLite）是所有模式共有的基础能力。

**内核零越界。** 核心库不调用 `console.*`、不读 `process.stdin`、不管理 API
Key、不写用户配置文件。所有 UI 和配置管理都是宿主的职责。

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

## 二、Agent 的三个模块

```
Agent = 设定 + 角色 + 技能
```

| 模块     | 目录        | 是什么           | 例子                         |
| -------- | ----------- | ---------------- | ---------------------------- |
| **设定** | `rules/`    | Agent 的行为规范 | 写作规范、安全基线、代码风格 |
| **角色** | `personas/` | 当前扮演的角色   | 作家、编辑、程序员、翻译     |
| **技能** | `skills/`   | 可调用的能力模块 | 章节创作、魔法体系、代码审查 |

角色由话题关键词自动触发（也可手动锁定），技能始终可用。角色通过
`systemPromptPrefix` 注入到系统提示词中，不进入 bootstrap 记忆加载。

## 三、三重数据存续路径

Memora 的数据分为三条路径，宿主任意配置每条路径的位置。

```
                        ┌─ 内核不需要关心"放哪" ─┐
                        │                          │
    AgentOptions.configDir ──→ 系统级配置（可嵌入宿主代码）
    │  personas/    角色定义
    │  rules/       Agent 级规则
    │  skills/      Agent 级技能
    │
    AgentOptions.dataDir ──→ 用户级数据（存储到用户本地）
    │  memora.db    SQLite 记忆索引
    │  topics/      话题文件（人可读的完整对话记录）
    │                  ├── frontmatter: LLM 摘要 + 记忆种子
    │                  └── body: 每条 user/assistant 原文
    │
    projectPath/.memora/ ──→ 项目级配置（跟作品走）
       rules/        该项目独有的规则
       skills/       该项目独有的技能
```

### 3.1 路径设计哲学

Memora 作为内核，**只暴露 `configDir` 和 `dataDir`
两个参数**。具体放哪，宿主自己定：

| 宿主类型          | configDir                                       | dataDir                                                 | 效果                       |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------- | -------------------------- |
| Electron 桌面精灵 | `path.join(__dirname, 'agent-config')` 嵌入程序 | `path.join(app.getPath('userData'), 'memora')` 用户本地 | 配置随程序升级、数据随用户 |
| 小说生成器        | `null`（不需要 personas）                       | `path.join(projectPath, '.memora-data')` 跟作品走       | 每部小说自己有记忆         |
| CLI 工具          | `~/.memora/agent-config` 用户目录               | `~/.memora` 用户目录                                    | 全部放用户目录             |

### 3.2 项目级配置（隐式第三条路径）

除了 `configDir`（Agent 级）和
`dataDir`（用户级），还存在第三条路径：**`<projectPath>/.memora/`**。

这是项目级的 rules 和 skills，随作品一起版本控制。规则加载顺序为：**项目级 →
Agent 级 → 全局规则**。同名规则后加载者覆盖前者。

### 3.3 数据与人可读性

所有对话记录以 Markdown 格式存储在 `dataDir/topics/` 下：

```
dataDir/topics/2026-06-06-chapter-1.md
  ├── frontmatter: date, topic, summary, keywords, seed_snapshots  → 机器索引
  └── body: 每条 user/assistant 原文                                → 人直接读
```

用户用任意文本编辑器打开就能回顾完整对话历史，不需要专用工具。

## 四、三种接入模式

三种模式的本质区别只有一点：**谁负责创建和维护 `agent-config/` 下的配置文件。**

| 模式                   | 配置来源               | 适用场景                       | 状态     |
| ---------------------- | ---------------------- | ------------------------------ | -------- |
| **1 · 程序员预设**     | 宿主程序内置           | 小说生成器、代码助手等固定用途 | 已实现   |
| **2 · 用户自定义**     | 用户手动编辑           | 个人助手、通用聊天机器人       | 设计阶段 |
| **3 · Agent 智能总结** | Agent 从对话中自动提取 | 自主进化的桌宠                 | 设计阶段 |

### 模式 1：程序员预设（开箱即用）

宿主程序在发布时带上 `agent-config/`，用户安装后直接使用。

```
程序目录/
├── agent-config/          ← 随程序发布，用户无需关心
│   ├── personas/
│   ├── rules/
│   └── skills/
└── .memora/               ← 运行时自动生成
    └── memora.db
```

```typescript
import { Agent, createLlmProvider } from 'memora';

// 宿主自行创建 Provider（API Key 由宿主管理，不经过 Agent）
const provider = createLlmProvider({
  provider: 'openai-compatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
});

const agent = new Agent({
  projectPath: '/path/to/project',
  provider, // 注入 Provider 实例
  configDir: '/path/to/host/agent-config', // 程序内置
});
await agent.init();
```

### 模式 2：用户自定义（配置权限交给用户）

配置存放在用户目录下，用户首次使用时通过交互式 CLI 创建自己的 Agent。

```typescript
import { Agent, createLlmProvider, loadConfig } from 'memora';

// 宿主从配置文件加载 LLM 配置（宿主自行决定怎么存 API Key）
const config = await loadConfig(); // 读取 memora.json
const provider = createLlmProvider(config.llm);

const agent = new Agent({
  projectPath: process.cwd(),
  provider,
  configDir: '~/.memora/agent-config', // 用户目录
  dataDir: config.memory.dataDir,
});
await agent.init();
```

### 模式 3：Agent 智能总结（配置权限交给 Agent）

Agent 从日常对话中自动提取用户偏好，生成配置建议，用户确认后写入配置文件。

```
用户对话 → 定期触发 LLM 反思 → 生成配置建议 → 用户确认
    → 写入配置文件（agent-config/rules/、personas/、skills/）
    → 下次启动时 MemoryLoader 扫描 → 加载到 SQLite
```

## 五、最小接入步骤

### 1. 安装

```bash
npm install memora
```

### 2. 创建 Provider + Agent

```typescript
import { Agent, createLlmProvider } from 'memora';

// ─── 宿主职责：创建 LLM Provider ──────────────────────
// Agent 不关心 API Key / baseUrl / model，宿主自行管理
const provider = createLlmProvider({
  provider: 'openai-compatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
});

// 可选：后台 Provider（归档/投影等后台操作，不配时复用前台）
const backgroundProvider = createLlmProvider({
  provider: 'openai-compatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat', // 可用更便宜的模型
});

// ─── 创建 Agent（只传 Provider 实例，不传 Config）──────
const agent = new Agent({
  projectPath: '/path/to/novel-project',
  provider, // 前台 Provider（必须）
  backgroundProvider, // 后台 Provider（可选）
  configDir: '/path/to/agent-config',
  archiveMode: 'insights-only', // 归档模式
  dataDir: '.memora', // 运行时数据目录
  maxContextTokens: 120000, // 上下文窗口上限
  persona: '作家', // 默认角色
  permission: 'owner', // 安全权限
  allowedPaths: ['.'], // 路径白名单
  confirmWrites: false, // 写入确认
});

await agent.init();
```

### 3. 对话

```typescript
// 流式对话（生产推荐）
for await (const chunk of agent.chat('帮我写一段玄幻小说开头')) {
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
  }
}

// 同步对话（测试用）
const reply = await agent.chatSync('你好');
```

### 4. 注册领域工具

```typescript
agent.registerTool(
  {
    name: 'create_chapter',
    description: '创建一个新章节',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '章节标题' },
      },
      required: ['title'],
    },
  },
  async (args) => {
    const chapter = await myNovel.createChapter(args.title);
    return `章节 "${args.title}" 已创建`;
  },
);
```

### 5. 注入项目规则

```typescript
await agent.addRule({
  id: 'rule:worldbuilding',
  type: 'rule',
  permanence: 'always',
  name: '世界观规则',
  content: '这是一个东方玄幻世界，修真等级分为炼气、筑基、金丹……',
  tags: ['世界观'],
  weight: 1.0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});
```

### 6. 切换项目

```typescript
// 切换到另一个子项目（记忆不丢）
const ctx = await agent.switchProject('another-novel');
console.log(`已切换到：${ctx.projectName}`);
```

### 7. 关闭

```typescript
await agent.waitForArchives(10000); // 等待后台归档完成
await agent.close(); // 释放项目锁 + 关闭数据库
```

## 六、作品内容加载

Memora
**不存储作品原始内容**（小说章节、代码文件等），只存一份「投影」——由 LLM 自动生成的结构化概要。

```
用户对话 → Agent 调用工具读取作品 → 返回内容给 LLM
       ↓ 同时（fire-and-forget）
       WorkProjectionManager 检测 hash → 生成投影 → 存入 SQLite
```

| 层           | 内容                             | 存储位置                                      |
| ------------ | -------------------------------- | --------------------------------------------- |
| **原始内容** | 小说章节 8000 字、代码文件       | 宿主程序负责加载，Memora 不碰                 |
| **投影**     | 概要 + 结构 + 关键决策（几百字） | SQLite，`permanence = domain`，启动时自动加载 |

下次对话，投影已在记忆中，不需要重新读文件。只有内容变化（hash 不同）时才重新生成。

宿主通过注册领域工具让 Agent 访问作品内容：

```typescript
agent.registerTool(
  {
    name: 'read_chapter',
    description: '读取指定章节的完整内容',
    parameters: {
      type: 'object',
      properties: {
        chapterNumber: { type: 'number', description: '章节编号' },
      },
      required: ['chapterNumber'],
    },
  },
  async (args) => {
    const content = await myNovel.readChapter(args.chapterNumber);
    return content;
  },
);
```

不同宿主的工具示例：

| 宿主类型   | 工具                                             |
| ---------- | ------------------------------------------------ |
| 小说生成器 | `read_chapter`、`list_characters`、`get_outline` |
| 代码助手   | `read_file`、`list_directory`、`get_git_diff`    |
| 数据库工具 | `query_schema`、`run_sql`、`describe_table`      |

工具实现完全是宿主的自由，Memora 只负责：工具定义 → LLM 调用 → 投影自动生成。

## 七、写入确认与 Diff 对比

**核心场景**：小说生成器中，LLM 修改第 3 章内容时，宿主需要展示 diff 让用户确认。

### 7.1 WriteExtensions 机制

```typescript
import type { WriteExtensions } from 'memora';

// 宿主注入 onBeforeWrite 回调
agent.setWriteExtensions({
  async onBeforeWrite(path, beforeContent, afterContent) {
    // beforeContent = null 表示新文件
    // afterContent = 要写入的新内容

    if (beforeContent === null) {
      // 新文件，直接确认
      return true;
    }

    // 宿主渲染 diff 对比面板，用户确认后返回 true
    const confirmed = await ui.showDiffConfirm(
      path,
      beforeContent,
      afterContent,
    );
    return confirmed;
  },
});
```

### 7.2 内置工具

| 工具名            | 用途               | 参数                                                                  |
| ----------------- | ------------------ | --------------------------------------------------------------------- |
| `read_file`       | 读取项目内文件内容 | `path`（相对路径）                                                    |
| `write_file`      | 写入/创建文件      | `path`, `content`, `mode?`（overwrite/append/insert）, `insert_line?` |
| `list_dir`        | 列出目录内容       | `path?`, `recursive?`, `maxDepth?`                                    |
| `search_memories` | 在记忆索引中搜索   | `query`, `limit?`, `mode?`（match/near）                              |

当 LLM 调用 `write_file` 时，`onBeforeWrite`
回调会被触发，宿主可以展示 diff 面板。

## 八、API 速查

> 完整定义见
> [memora-api-reference-v1.0.md](./memora-api-reference-v1.0.md)。所有方法在未调用
> `init()` 时调用会抛 `configError`。

### 8.1 构造选项 `AgentOptions`

```typescript
interface AgentOptions {
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

### 8.2 生命周期

| 方法              | 说明                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `agent.init()`    | 初始化（创建 DB、加载配置、连接 LLM）。可重复调用，会先 `await close()` 清理旧资源。          |
| `agent.close()`   | 安全关闭（释放锁 + 关闭 Agent 级数据库）。切换项目不需要 `close()`，仅 Agent 整体退出时调用。 |
| `agent.inspect()` | 返回 Agent 当前状态快照（4 层：working / bootstrap / archive / mounted）。未初始化时抛错。    |

### 8.3 对话

| 方法                    | 说明                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `agent.chat(input)`     | 流式对话，返回 `AsyncGenerator<AgentChunk>`。**已加并发锁**，同一时间只能有一个 chat() 在跑。 |
| `agent.chatSync(input)` | 同步对话，内部收集 `chat()` 所有 `text` chunk 后一次性返回。                                  |
| `agent.getMessages()`   | 获取工作记忆的完整消息列表（只读）。未初始化时抛错。                                          |

#### 流式 chunk 类型（`AgentChunk`）

```typescript
type AgentChunk =
  | { type: 'recall'; count: number } // 记忆召回通知
  | { type: 'thinking'; phase: ThinkingPhase } // 进度反馈（recalling / processing / archiving）
  | { type: 'text'; content: string } // 文本片段
  | { type: 'tool_start'; name: string; args?: string } // 工具调用开始
  | { type: 'tool_result'; name: string; ok: boolean; summary?: string } // 工具调用结果
  | { type: 'done' }; // 结束标记
```

**注意**：chunk 字段是 `content` / `count` / `name`，不是 `delta` /
`text`。宿主程序应严格按此类型解构。

### 8.4 归档模式

| 方法                                     | 说明                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `agent.setArchiveMode(mode)`             | 运行时切换归档模式：`'full'` / `'insights-only'` / `'manual'`。                                               |
| `agent.getArchiveMode()`                 | 获取当前归档模式。                                                                                            |
| `agent.archiveApprovedContent(content?)` | 手动归档已审核通过的内容（`insights-only` / `manual` 模式下的入口）。可选传入定稿摘要，会先追加到历史再归档。 |

**三种归档模式**：

| 模式            | 信号检测归档 | 周期性归档 | 中途归档 | 用户画像归档 | 适用场景                       |
| --------------- | ------------ | ---------- | -------- | ------------ | ------------------------------ |
| `full`（默认）  | ✅ 自动      | ✅ 自动    | ✅ 自动  | ✅ 自动      | 日常对话、闲聊                 |
| `insights-only` | ❌ 跳过      | ❌ 跳过    | ❌ 跳过  | ✅ 自动      | 小说写作、代码审查等审核工作流 |
| `manual`        | ❌ 跳过      | ❌ 跳过    | ❌ 跳过  | ✅ 自动      | 宿主完全控制归档时机           |

> **关键**：用户画像归档（`UserProfile`）不受 `archiveMode` 影响，始终自动执行。

**泊文体系小说写作示例**：

```typescript
// 1. 进入草稿模式
agent.setArchiveMode('insights-only');

// 2. 多轮迭代（废稿不会进入记忆）
await agent.chatSync('扩写：主角深夜回到老宅，发现书房的灯亮着');
await agent.chatSync('不对，情绪再压抑一些');
await agent.chatSync('这里改成主角先听到钢琴声再推门');

// 3. 审核通过 → 手动归档定稿
await agent.archiveApprovedContent('主角深夜回到老宅，发现书房的灯亮着...');

// 4. 切换到下一章
await agent.switchTopic('chapter-2');
```

### 8.5 规则与技能

| 方法                                             | 说明                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `agent.addRule(memory)`                          | 注入规则（type=rule, permanence=always/domain）。写入 SQLite + 注入 system prompt。    |
| `agent.addSimpleRule(name, content, keywords?)`  | 便捷方法，自动填充 id/tags/weight。                                                    |
| `agent.addSkill(memory)`                         | 注入技能（type=skill, permanence=domain）。注册到内存 + 写入 SQLite + 重建关键词索引。 |
| `agent.addSimpleSkill(name, content, keywords?)` | 便捷方法。keywords 数组用于 AgentLoop 触发匹配。                                       |

### 8.6 工具

| 方法                                      | 说明                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agent.registerTool(definition, handler)` | 注册自定义工具。`definition.name` 必须符合标识符规范（`/^[a-zA-Z_][a-zA-Z0-9_]*$/`），否则抛错。重复注册同名工具会覆盖。 |
| `agent.executeTool(name, args)`           | 主动执行已注册的工具（一般不直接调用，AgentLoop 会自动触发）。                                                           |
| `agent.getToolDefinitions()`              | 获取所有已注册工具的 OpenAI 兼容 schema。                                                                                |
| `agent.setWriteExtensions(ext)`           | 注入写入扩展回调（diff 对比确认），传 `null` 移除。                                                                      |

### 8.7 角色

| 方法                           | 说明                                                           |
| ------------------------------ | -------------------------------------------------------------- |
| `agent.listPersonas()`         | 列出可用角色（来自 `configDir/personas/`）。                   |
| `agent.switchPersona(name)`    | 手动切换到指定角色（`personaMode` 设为 'manual'）。            |
| `agent.setPersonaMode(mode)`   | 设置角色切换模式：'auto'（关键词触发）/ 'manual'（手动锁定）。 |
| `agent.getPersonaMode()`       | 读取当前角色匹配模式。                                         |
| `agent.getActivePersonaName()` | 读取当前激活的角色名。                                         |

### 8.8 Provider 管理

| 方法                                    | 说明                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| `agent.setProvider(provider)`           | 运行时切换前台 Provider（同步更新 AgentLoop 内部引用）。 |
| `agent.setBackgroundProvider(provider)` | 运行时切换后台 Provider（传 `null` 表示复用前台）。      |
| `agent.provider` (getter)               | 读取当前前台 Provider 实例。                             |

> **重要**：Agent 不再管理 Provider 映射表、活跃 Provider 名。宿主自行管理这些。宿主切换 Provider 时，先创建新实例，再调用
> `agent.setProvider(newProvider)`。

### 8.9 记忆查询

| 方法                                  | 说明                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `agent.searchMemories(query, limit?)` | 关键词搜索记忆（底层走 SQLite FTS5）。`query` 必须非空，`limit` 必须正整数。 |
| `agent.getMountedMemories()`          | 当前话题挂载的所有记忆。                                                     |
| `agent.unmountMemory(name)`           | 踢出指定挂载记忆（会话级抑制）。                                             |
| `agent.getStats()`                    | 记忆库统计（按 type 分组、总数、话题文件数）。                               |
| `agent.listAllTopics()`               | 列出所有话题文件名。                                                         |
| `agent.listProjects()`                | 列出已注册的子项目。                                                         |
| `agent.switchProject(name)`           | 切换到其他子项目（Agent 级记忆不丢）。                                       |
| `agent.switchTopic(name)`             | 切换当前话题（旧话题会自动归档）。                                           |

### 8.10 配置建议（模式 3）

| 方法                                        | 说明                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `agent.onConfigSuggestion(handler)`         | 注册配置建议回调。`AutoConfigRefiner`（自动反思）目前未实现，handler 仅在手动调用时被模拟触发。 |
| `agent.confirmConfigSuggestion(suggestion)` | 写入配置文件（`agent-config/rules/`、`personas/`、`skills/`），下次启动自动加载。               |

### 8.11 异步归档等待

| 方法                                | 说明                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `agent.waitForArchives(timeoutMs?)` | 等待所有 in-flight 归档任务完成（默认 5 秒超时）。`close()` 内部已自动调用此方法，宿主程序一般不需要直接使用。 |

### 8.12 上下文窗口管理

| 配置项                          | 说明                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `AgentOptions.maxContextTokens` | 上下文窗口 token 上限（默认 120000）。超过此阈值时自动裁剪中间段消息，保留 system prompt + 最近 N 条消息。 |

**桌面精灵等长运行场景必备**：Agent 持续运行数天，`messages`
数组无限增长会爆 LLM 上下文窗口。此配置自动截断，确保 LLM 请求不因上下文溢出而失败。

**截断策略**：

- message[0]（system prompt）始终保留
- 从尾部向前取最近消息，直到 token 估算接近上限（留 10% 缓冲）
- 被裁剪的消息替换为一条占位提示，告知 LLM 有历史被裁剪

### 8.13 交互时间戳

| 访问器                    | 类型           | 说明                                                             |
| ------------------------- | -------------- | ---------------------------------------------------------------- |
| `agent.lastInteractionAt` | `Date \| null` | 最近一次 `chat()` 调用的时间戳。`null` 表示尚未调用过 `chat()`。 |

**桌面精灵典型用法**：

```typescript
const now = Date.now();
const lastInteraction = agent.lastInteractionAt;
if (lastInteraction && now - lastInteraction.getTime() > 30 * 60 * 1000) {
  // 超过 30 分钟，主动问候
  await agent.chatSync('【系统】用户已离线 30 分钟，请主动问候');
}
```

### 8.14 只读访问器

| 访问器               | 类型              | 说明                                |
| -------------------- | ----------------- | ----------------------------------- |
| `agent.initialized`  | `boolean`         | Agent 是否已初始化。                |
| `agent.context`      | `object?`         | 当前项目上下文（未初始化为 null）。 |
| `agent.agentLoop`    | `AgentLoop?`      | 内部 AgentLoop 引用（只读）。       |
| `agent.agentHistory` | `MessageHistory?` | 内部消息历史引用（只读）。          |

### 8.15 扩展工具：宿主供能

> **核心理念**：Agent 本身无网络能力，不依赖任何外部服务。所有"超纲"能力——联网搜索、音视频处理、数据库读写、第三方 API——统统由宿主通过
> `registerTool()` 提供。Agent 只负责"决定调用哪个工具"，不负责"工具怎么执行"。

#### 8.15.1 工具 handler 的执行位置

工具 handler 跑在宿主的 Node.js 进程里，**不受 Agent 安全层的路径白名单约束**。网络请求的安全由宿主自行控制——在 handler 里做域名过滤、频率限制、内容校验，都是宿主说了算。

```typescript
// Agent 完全不知道这个 handler 里有网络请求
agent.registerTool(
  {
    name: 'web_search',
    description: '搜索互联网内容，返回结构化结果',
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
    const response = await fetch(
      `https://api.example.com/search?q=${encodeURIComponent(args.query)}&limit=${args.limit ?? 5}`,
    );
    const data = await response.json();
    // 返回给 LLM 的格式由宿主决定，建议包含标题 + 摘要 + URL
    return JSON.stringify(data.results ?? []);
  },
);

// 配套的网页抓取工具（读，不是搜）
agent.registerTool(
  {
    name: 'web_fetch',
    description: '抓取指定 URL 的网页正文内容',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标网址' },
        maxChars: {
          type: 'number',
          description: '最大抓取字符数',
          default: 3000,
        },
      },
      required: ['url'],
    },
  },
  async (args) => {
    const response = await fetch(args.url);
    const text = await response.text();
    return text.slice(0, args.maxChars ?? 3000);
  },
);
```

#### 8.15.2 搜索与抓取的区别

| 工具         | 做什么                          | 典型场景                       |
| ------------ | ------------------------------- | ------------------------------ |
| `web_search` | 搜索引擎查关键词，返回 URL 列表 | "帮我查一下这篇论文的引用情况" |
| `web_fetch`  | 指定 URL 抓正文，返回原始文本   | "把这篇文章的摘要读给我听"     |

两者可以分别注册，也可以组合——先搜到相关页面，再抓正文内容。

#### 8.15.3 接入多个搜索 Provider

宿主的 handler 实现完全自主，不绑死任何搜索服务商。下面是几种常见选择：

```typescript
// 方案一：接腾讯元宝（腾讯系）
async (args) => {
  const res = await fetch('https://api.yundi.com/search', {
    headers: { Authorization: `Bearer ${process.env.YUNDI_API_KEY}` },
    body: JSON.stringify({ query: args.query }),
  });
  return res.json();
};

// 方案二：接 DuckDuckGo（无 API Key）
async (args) => {
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(args.query)}&format=json`,
  );
  return res.json();
};

// 方案三：接本地 Ollama（完全私有，不出网）
async (args) => {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: 'search-reranker',
      prompt: `根据关键词检索相关内容：${args.query}`,
    }),
  });
  return res.json();
};
```

**Agent 零感知**——它只看到自己注册了一个叫 `web_search` 的工具，参数是 `query`
和 `limit`。换哪个 Provider，Agent 不知道，也不需要知道。

#### 8.15.4 搜索结果的记忆归属

联网搜索返回的内容默认**不进 Memora 记忆库**——它是上下文燃料，用于回答当前问题，用完即焚。如果用户希望"记住这次查到的信息"，由宿主决定何时调用
`agent.archiveApprovedContent()`
或 signal-detector 触发归档，Agent 本身不会主动把搜索结果写入 SQLite。

---

> **API 设计原则**：所有公开方法在错误状态下会抛 `configError` / `llmError`
> 等友好错误（带可操作的 `suggestions[]`），宿主程序可在最外层 `try/catch`
> 统一处理。**不会**静默返回 null 或空数组（除文档明确说明的 getter 外）。

## 九、宿主工具函数

Memora 导出一些工具函数，供宿主创建 Provider 和加载配置：

```typescript
import {
  createLlmProvider,
  createProviderFromConfig,
  loadConfig,
} from 'memora';
import type { ProviderConfig, Config } from 'memora';
```

| 函数                                     | 用途                            |
| ---------------------------------------- | ------------------------------- |
| `createLlmProvider(config)`              | 从扁平配置创建 LlmProvider 实例 |
| `createProviderFromConfig(name, config)` | 从命名配置创建 LlmProvider 实例 |
| `loadConfig(path?)`                      | 加载 memora.json 配置文件       |

**注意**：这些是**宿主工具函数**，不是 Agent 内核的一部分。宿主也可以完全不用这些函数，自己实现
`LlmProvider` 接口。

## 十、小说生成器完整接入示例

> 以小说生成器为首个宿主场景，展示完整接入流程。

```typescript
import { Agent, createLlmProvider, MemoryType, Permanence } from 'memora';
import type { AgentChunk, WriteExtensions } from 'memora';

class NovelWriterHost {
  private agent!: Agent;

  async start() {
    // ─── 1. 创建 Provider（宿主管 API Key）─────────────────
    const provider = createLlmProvider({
      provider: 'openai-compatible',
      apiKey: process.env.LLM_API_KEY!,
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });

    const backgroundProvider = createLlmProvider({
      provider: 'openai-compatible',
      apiKey: process.env.LLM_API_KEY!,
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat', // 后台归档可用更便宜的模型
    });

    // ─── 2. 创建 Agent ─────────────────────────────────────
    this.agent = new Agent({
      projectPath: '/path/to/novel-project',
      provider,
      backgroundProvider,
      configDir: '/path/to/novel-writer/agent-config',
      archiveMode: 'insights-only', // 草稿/定稿工作流
      maxContextTokens: 120000,
      persona: '作家',
      permission: 'owner',
      allowedPaths: ['/path/to/novel-project'],
    });

    await this.agent.init();

    // ─── 3. 注入 diff 对比确认回调 ──────────────────────────
    this.agent.setWriteExtensions({
      async onBeforeWrite(path, beforeContent, afterContent) {
        if (beforeContent === null) return true; // 新文件直接确认
        // 宿主渲染 diff 面板，用户确认后返回 true
        return await ui.showDiffConfirm(path, beforeContent, afterContent);
      },
    });

    // ─── 4. 注册领域工具 ────────────────────────────────────
    this.agent.registerTool(
      {
        name: 'read_chapter',
        description: '读取指定章节的完整内容',
        parameters: {
          type: 'object',
          properties: {
            chapterNumber: { type: 'number', description: '章节编号' },
          },
          required: ['chapterNumber'],
        },
      },
      async (args) => {
        return await this.novelService.readChapter(args.chapterNumber);
      },
    );

    this.agent.registerTool(
      {
        name: 'list_characters',
        description: '列出所有角色设定',
        parameters: { type: 'object', properties: {} },
      },
      async () => {
        return await this.novelService.listCharacters();
      },
    );
  }

  // ─── 对话 ─────────────────────────────────────────────
  async chat(userInput: string): Promise<void> {
    for await (const chunk of this.agent.chat(userInput)) {
      switch (chunk.type) {
        case 'text':
          this.ui.appendText(chunk.content);
          break;
        case 'thinking':
          this.ui.showThinking(chunk.phase);
          break;
        case 'tool_start':
          this.ui.showToolStart(chunk.name);
          break;
        case 'tool_result':
          this.ui.showToolResult(chunk.ok, chunk.summary);
          break;
      }
    }
  }

  // ─── 泊文体系：草稿→定稿工作流 ─────────────────────────
  async draftAndApprove(prompt: string): Promise<void> {
    // 草稿模式（insights-only 已在构造时设定）
    await this.chat(prompt);

    // 用户审核通过后，手动归档定稿
    const approvedContent = this.ui.getApprovedContent();
    await this.agent.archiveApprovedContent(approvedContent);
  }

  // ─── 角色管理 ─────────────────────────────────────────
  listPersonas() {
    return this.agent.listPersonas();
  }
  switchPersona(name: string) {
    this.agent.switchPersona(name);
  }
  getActivePersona() {
    return this.agent.getActivePersonaName();
  }

  // ─── 记忆管理 ─────────────────────────────────────────
  getMountedMemories() {
    return this.agent.getMountedMemories();
  }
  unmountMemory(name: string) {
    return this.agent.unmountMemory(name);
  }
  searchMemories(query: string) {
    return this.agent.searchMemories(query);
  }

  // ─── Provider 切换（用户在设置里改 API Key）──────────
  switchProvider(config: any) {
    const newProvider = createLlmProvider(config);
    this.agent.setProvider(newProvider);
  }

  // ─── 优雅关闭 ─────────────────────────────────────────
  async stop() {
    await this.agent.waitForArchives(10000);
    await this.agent.close();
  }
}
```

## 十一、关键约束

1. **`provider` 是必填项** — Agent 无法独立运行，必须由宿主注入 LLM Provider
2. **configDir** 指向 Agent 级配置目录（`personas/` + `rules/` +
   `skills/`），所有子项目共享
3. **项目级 `.memora/`** 只放 `rules/` 和 `skills/`，不放 `memora.db`
4. **角色由关键词自动触发**，用户说「帮我写小说」→ 自动切换到「作家」角色
5. **对话历史跨子项目持久化**，切换子项目不会丢失之前聊过的内容
6. `registerTool()` 和 `addRule()` / `addSkill()` 必须在 `init()` 之后调用
7. **作品原始内容不进 SQLite**，Agent 通过工具按需读取，只存轻量投影
8. **配置文件是真理源**，`agent-config/`
   下的配置由 MemoryLoader 启动时扫描加载到 SQLite；`addRule()`
   是运行时注入，不经配置文件
9. **禁止**为每个子项目创建独立的 memora.db——记忆是 Agent 级的
10. **禁止**项目切换时关闭/重建数据库——记忆跨项目持久化
11. **禁止**将配置直接写入 SQLite 作为持久化存储——配置文件才是真理源
12. **宿主在 `close()` 前调用 `waitForArchives()`** 保证后台归档完成

## 十二、类型导出速查

```typescript
// Agent 与流式事件
export { Agent } from 'memora';
export type {
  AgentOptions,
  AgentChunk,
  ThinkingPhase,
  ArchiveMode,
} from 'memora';

// 工具
export type { ToolDefinition, ToolHandler, WriteExtensions } from 'memora';

// 配置建议
export type { ConfigSuggestion, ConfigSuggestionHandler } from 'memora';

// 记忆
export { MemoryType, Permanence } from 'memora';
export type { Memory, MemoryTypeValue, PermanenceValue } from 'memora';

// 角色
export type { PersonaMode } from 'memora';

// 技能
export type { SkillEntry } from 'memora';

// LLM 宿主用
export { createLlmProvider, createProviderFromConfig } from 'memora';
export type { ProviderConfig, LlmProvider } from 'memora';

// 配置文件加载
export { loadConfig } from 'memora';
export type { Config } from 'memora';
```

---

> 更多细节参见
> [memora-api-reference-v1.0.md](./memora-api-reference-v1.0.md)（完整 API 参考）、[记忆系统设计介绍-v1.0.md](./记忆系统设计介绍-v1.0.md)（概念级介绍）
