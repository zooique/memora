# Memora · 接入指南 v1.0

> 帮助宿主项目开发者快速理解 Memora 的设计理念和接入方法。

---

## 一、核心理念

**万物皆是记忆**。角色、规则、技能、工具定义、对话历史——全部统一为「记忆」，通过
`类型 + 永久性` 两个维度区分。

**单 Agent 模型**。Memora 被宿主接入后，就是该程序的唯一 Agent。所有对话、所有记忆存在同一个数据库中，**切换子项目不会丢失记忆**。

**配置文件是真理源，SQLite 是运行时索引。** `agent-config/`
下的配置文件由 MemoryLoader 在启动时扫描，加载到 SQLite 中。记忆自动归档（UserProfile、话题摘要、对话快照 →
SQLite）是所有模式共有的基础能力。

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

## 三、目录结构

```
宿主程序/
├── agent-config/              ← Agent 级配置（唯一）
│   ├── personas/            ← 角色配置（.md 文件）
│   ├── rules/                 ← Agent 级规则（所有子项目共享）
│   └── skills/                ← Agent 级技能（所有子项目共享）
│
└── .memora/                   ← Agent 级运行时数据（自动生成，勿手动编辑）
    └── memora.db              ← 唯一记忆数据库

被管理的子项目/
└── .memora/                   ← 只放项目级 rules 和 skills
    ├── rules/                 ← 该项目独有的规则
    └── skills/                ← 该项目独有的技能
```

规则加载顺序：**项目级 → Agent 级**。同名规则后加载者覆盖前者。

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
const agent = new Agent({
  configDir: '/path/to/host/agent-config',  // 程序内置
  projectPath: '/path/to/project',
  config: { llm: { ... }, memory: { ... } },
});
```

### 模式 2：用户自定义（配置权限交给用户）

配置存放在用户目录下，用户首次使用时通过交互式 CLI 创建自己的 Agent。

```
用户目录/
└── ~/.memora/
    ├── agent-config/      ← 用户手动创建/编辑
    │   ├── personas/
    │   │   └── 我的程序员.md
    │   ├── rules/
    │   │   └── 代码风格.md
    │   └── skills/
    └── memora.db           ← 运行时自动生成
```

```typescript
const agent = new Agent({
  configDir: '~/.memora/agent-config',  // 用户目录
  projectPath: process.cwd(),
  config: { llm: { ... }, memory: { dataDir: '~/.memora' } },
});
```

需要新增的 CLI 命令：

```bash
memora init
# > 你的 Agent 叫什么名字？
# > 它主要帮你做什么？（编程 / 写作 / 日常对话）
# > 你希望它有什么性格？（严谨 / 幽默 / 简洁）
# → 自动生成 personas/ + rules/
```

### 模式 3：Agent 智能总结（配置权限交给 Agent）

Agent 从日常对话中自动提取用户偏好，生成配置建议，用户确认后写入配置文件。下次启动时 MemoryLoader 自动扫描加载到 SQLite。

```
用户对话 → 定期触发 LLM 反思 → 生成配置建议 → 用户确认
    → 写入配置文件（agent-config/rules/、personas/、skills/）
    → 下次启动时 MemoryLoader 扫描 → 加载到 SQLite
```

```
示例：

用户：「写代码时我喜欢用 TypeScript，不喜欢 any」
  ↓ 多轮对话后，Agent 自动触发反思
Agent 建议：
  「我发现你偏好 TypeScript 严格模式，要我添加这条规则吗？」
  ┌──────────────────────────────────────────┐
  │ 规则名称：TypeScript 偏好                 │
  │ 内容：优先使用 TypeScript strict 模式，   │
  │       禁止 any 类型，使用泛型替代         │
  │ [确认]  [忽略]  [编辑]                   │
  └──────────────────────────────────────────┘
```

与现有机制的关系：

| 机制                            | 产出                              | 存储位置                 | 触发方式           |
| ------------------------------- | --------------------------------- | ------------------------ | ------------------ |
| **UserProfile**（已实现）       | 用户画像                          | SQLite                   | 实时归档，自动确认 |
| **AutoConfigRefiner**（计划中） | 配置文件（rules/personas/skills） | `agent-config/` 文件系统 | 定期反思，用户确认 |
| `addRule()`（已实现）           | 规则记忆                          | SQLite（运行时注入）     | 宿主程序主动调用   |

关键区别：`addRule()`
写入 SQLite（会话级），AutoConfigRefiner 写入配置文件（持久化，重启后依然生效）。

模式 3 的关键约束：

- **必须用户确认**，不能静默写入（配置影响行为，比画像更敏感）
- **冲突检测**，已有规则与新建议相矛盾时，提示用户
- **降噪机制**，避免频繁推送低质量建议

## 五、最小接入步骤

### 1. 安装

```bash
npm install memora
```

### 2. 创建 Agent

```typescript
import { Agent } from 'memora';

const agent = new Agent({
  projectPath: '/path/to/novel-project', // 当前管理的子项目
  configDir: '/path/to/host/agent-config', // Agent 级配置目录
  archiveMode: 'full', // 归档模式：'full'（默认）| 'insights-only' | 'manual'
  config: {
    llm: {
      provider: 'openai-compatible',
      apiKey: process.env.LLM_API_KEY,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    },
    memory: {
      dataDir: '.memora', // 运行时数据目录（memora.db 在这里）
      maxContextTokens: 8000,
    },
    security: {
      permission: 'owner',
      confirmWrites: false,
    },
    allowedPaths: ['.'],
  },
});

await agent.init();
```

### 3. 对话

```typescript
// 流式对话
for await (const chunk of agent.chat('帮我写一段玄幻小说开头')) {
  process.stdout.write(chunk.delta);
}

// 同步对话
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
await agent.close(); // 释放项目锁 + 关闭 Agent 级数据库（shutdown）
```

> 注：`close()` 内部调用
> `ProjectManager.shutdown()`，同时释放项目锁和关闭 Agent 级 memora.db。项目切换时不会关闭数据库，只有 Agent 整体退出时才调用此方法。

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

## 七、自我进化机制

> 对应「模式 3 ·
> Agent 智能总结」——Agent 从白纸开始，通过对话自动进化到与用户契合的形态。
>
> **实现状态**：配置建议 API（`onConfigSuggestion` /
> `confirmConfigSuggestion`）已实现并导出；自动反思触发器（`AutoConfigRefiner`）仍在设计阶段。

### 核心原则：内核管"魂"，宿主管"体"

自我进化的本质是**配置文件的自动积累**。Agent 从对话中提取规则、角色 traits，写入
`agent-config/` 下的配置文件。

```
对话 → AutoConfigRefiner 定期反思 → 生成配置建议
    → 用户确认 → 写入配置文件（agent-config/rules/、personas/、skills/）
    → 下次启动时 MemoryLoader 扫描 → 加载到 SQLite
    → inspect() 暴露当前状态 → 宿主读取 → 决定呈现方式
```

### 内核提供：AutoConfigRefiner

| 职责         | 说明                                                            |
| ------------ | --------------------------------------------------------------- |
| **定期反思** | 每 N 轮对话，调用 LLM 分析对话内容，提取可用的规则和角色 traits |
| **生成建议** | 形成结构化建议（类型 + 名称 + 内容 + 置信度）                   |
| **回调通知** | 通过 `onConfigSuggestion` 回调通知宿主，由宿主决定如何展示      |

```typescript
// 内核暴露的回调接口（计划中）
agent.onConfigSuggestion((suggestion) => {
  // suggestion = {
  //   type: 'rule' | 'persona' | 'skill',
  //   name: '代码风格',
  //   content: '优先使用 TypeScript strict 模式，禁止 any 类型',
  //   confidence: 0.85,
  // }
  // 宿主决定怎么展示：桌宠弹气泡 / CLI 打印 / WebUI 弹窗
});

// 用户确认后，AutoConfigRefiner 写入配置文件
// 例如 agent-config/rules/代码风格.md
// 下次启动时 MemoryLoader 自动扫描加载到 SQLite
```

> 注：`addRule()`
> 是独立的运行时注入接口（宿主主动调用，写入 SQLite，会话级），与 AutoConfigRefiner（写入配置文件，持久化）是不同的机制。

### 内核提供：inspect() 读端口

Agent 当前状态通过 `inspect()` 完全暴露，宿主可随时查询：

```typescript
const snap = agent.inspect();
// snap.bootstrap.total   → 已积累的规则数量
// snap.bootstrap.items   → 具体规则列表
// 宿主据此判断进化阶段：规则数 > 10 → 阶段 2，依此类推
```

### 契合案例：桌宠养成助手

```
┌────────────── 内核（魂）──────────────┐
│  对话 → AutoConfigRefiner              │
│       → 规则：「用户喜欢简洁代码」      │
│       → 角色 trait：「性格：严谨」      │
│       → 写入配置文件（agent-config/）   │
│       → 启动时 MemoryLoader 加载到 SQLite│
│                                        │
│  inspect() 返回：                      │
│    rules: 12 条, personas: 3 个        │
│    traits: ["严谨", "高效", "幽默"]     │
└────────────────┬───────────────────────┘
                 │ 宿主轮询 inspect()
                 ▼
┌────────────── 桌宠宿主（体）──────────┐
│  形态映射引擎：                        │
│    规则 < 5  → 蛋（阶段 0）            │
│    规则 5-10 → 幼崽（阶段 1）          │
│    规则 > 10 + "严谨" → 猫头鹰（阶段 2）│
│                                        │
│  渲染：SVG + 进化动画 + 粒子特效       │
│  互动：点击、拖拽、闲置动效            │
└────────────────────────────────────────┘
```

桌宠宿主需要实现的：

| 层级     | 内容                                                                     |
| -------- | ------------------------------------------------------------------------ |
| 进化触发 | 每次 `chat()` 后检查 `inspect().bootstrap.total`，跨越阈值时触发进化动画 |
| 形态映射 | 规则数量 + 角色 traits → 宠物外观的映射表                                |
| 视觉渲染 | SVG/像素画 + 动画帧 + 粒子特效                                           |
| 桌面挂件 | 系统托盘、窗口置顶、拖拽交互                                             |
| 建议展示 | 收到 `onConfigSuggestion` 回调时，弹出气泡让用户确认                     |

内核不管 Agent 长什么样，只管它正在变成什么。

## 八、API 速查

> 完整定义见 `src/index.ts` 导出。所有方法在未调用 `init()` 时调用会抛
> `configError`。

### 8.1 生命周期

| 方法              | 说明                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `agent.init()`    | 初始化（创建 DB、加载配置、连接 LLM）。可重复调用，会先 `await close()` 清理旧资源。          |
| `agent.close()`   | 安全关闭（释放锁 + 关闭 Agent 级数据库）。切换项目不需要 `close()`，仅 Agent 整体退出时调用。 |
| `agent.inspect()` | 返回 Agent 当前状态快照（4 层：working / bootstrap / archive / mounted）。未初始化时抛错。    |

### 8.2 对话

| 方法                    | 说明                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `agent.chat(input)`     | 流式对话，返回 `AsyncGenerator<AgentChunk>`。**已加并发锁**，同一时间只能有一个 chat() 在跑。 |
| `agent.chatSync(input)` | 同步对话，内部收集 `chat()` 所有 `text` chunk 后一次性返回。                                  |
| `agent.getMessages()`   | 获取工作记忆的完整消息列表（只读）。未初始化时抛错（**不要**误以为空数组=全新对话）。         |

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

**注意**：chunk 字段是 `content` / `count` / `name`，不是文档示例中常见的
`delta` / `text`。宿主程序应严格按此类型解构。

### 8.3 归档模式

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

> **关键**：用户画像归档（`UserProfile`）不受 `archiveMode`
> 影响，始终自动执行。因为用户洞察（"我叫张三"、"我喜欢 TypeScript"）与生成内容（草稿/扩写）性质不同，前者是确定事实，后者是待审核的中间产物。

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

// 5. 恢复自动归档（可选）
agent.setArchiveMode('full');
```

也可在构造时指定：

```typescript
const agent = new Agent({
  projectPath: '/path/to/novel',
  configDir: '/path/to/agent-config',
  archiveMode: 'insights-only', // 构造时指定
  config: { ... },
});
```

### 8.4 规则与技能

| 方法                                              | 说明                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `agent.addRule(memory)`                           | 注入规则（type=rule, permanence=always/domain）。写入 SQLite + 注入 system prompt。    |
| `agent.addSimpleRule(name, content, permanence?)` | 便捷方法，自动填充 id/tags/weight（v0.5+）。                                           |
| `agent.addSkill(memory)`                          | 注入技能（type=skill, permanence=domain）。注册到内存 + 写入 SQLite + 重建关键词索引。 |
| `agent.addSimpleSkill(name, content, keywords?)`  | 便捷方法（v0.5+）。keywords 数组用于 AgentLoop 触发匹配。                              |

### 8.5 工具

| 方法                                      | 说明                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `agent.registerTool(definition, handler)` | 注册自定义工具。`definition.name` 必须符合标识符规范（`/^[a-zA-Z_][a-zA-Z0-9_]*$/`），否则抛错。重复注册同名工具会覆盖。 |
| `agent.executeTool(name, args)`           | 主动执行已注册的工具（一般不直接调用，AgentLoop 会自动触发）。                                                           |
| `agent.getToolDefinitions()`              | 获取所有已注册工具的 OpenAI 兼容 schema（供宿主程序自己接入 LLM 时使用）。                                               |

工具的 `parameters` 字段应符合 OpenAI Function Calling 的 JSON
Schema 格式。`ToolExecutor`
在执行前会自动按 schema 校验 args 并 coerce 类型（string→number 等）。

### 8.6 角色

| 方法                         | 说明                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `agent.listPersonas()`       | 列出可用角色（来自 `configDir/personas/`）。                   |
| `agent.switchPersona(name)`  | 手动切换到指定角色（`personaMode` 设为 'manual'）。            |
| `agent.setPersonaMode(mode)` | 设置角色切换模式：'auto'（关键词触发）/ 'manual'（手动锁定）。 |

### 8.7 Provider 管理

| 方法                              | 说明                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `agent.addProvider(name, config)` | 运行时动态添加 Provider（不写入配置文件，重启后失效）。**不暴露完整 API Key**（只显示前 3 位 + `***`）。 |
| `agent.switchProvider(name)`      | 切换当前激活的 Provider。name 不存在时抛错。                                                             |
| `agent.listProviders()`           | 列出所有已注册 Provider 的别名。                                                                         |
| `agent.getActiveProviderName()`   | 获取当前激活的 Provider 名（无则返回 null）。                                                            |
| `agent.currentProvider` (getter)  | 只读访问当前 Provider 实例（未初始化时返回 null）。                                                      |

> 配置文件中已配置的 Provider 在 `init()` 时自动加载；运行时 `addProvider()`
> 是**额外**的，不影响配置文件的真理源地位。

### 8.8 记忆查询

| 方法                                  | 说明                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `agent.searchMemories(query, limit?)` | 关键词搜索记忆（底层走 SQLite FTS5）。`query` 必须非空，`limit` 必须正整数。 |
| `agent.listAllTopics()`               | 列出所有话题文件名。                                                         |
| `agent.listProjects()`                | 列出已注册的子项目。                                                         |
| `agent.switchProject(name)`           | 切换到其他子项目（Agent 级记忆不丢）。                                       |
| `agent.switchTopic(name)`             | 切换当前话题（旧话题会自动归档）。                                           |

### 8.9 自我进化（部分实现）

| 方法                                        | 状态                           | 说明                                                                                                                         |
| ------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `agent.onConfigSuggestion(handler)`         | **接口已实现**，触发器设计阶段 | 注册配置建议回调。`AutoConfigRefiner`（自动反思）目前未实现，handler 仅在手动调用 `confirmConfigSuggestion()` 时被模拟触发。 |
| `agent.confirmConfigSuggestion(suggestion)` | ✅ 已实现                      | 写入配置文件（`agent-config/rules/`、`personas/`、`skills/`），下次启动自动加载。                                            |

### 8.10 写入二次确认

| 方法                                         | 说明                                                                                                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `securityGuard.onWriteConfirmation(handler)` | 注册自定义写入确认回调（**宿主程序接入关键 API**）。`requestWriteConfirmation()` 走自定义 UI，未注册时回退到 readline+stdin。回调抛错按 fail-closed 处理。 |

`WriteConfirmationInfo` 类型：

```typescript
interface WriteConfirmationInfo {
  targetPath: string; // 目标文件绝对路径
  tool: string; // 工具名（如 'write_file'）
  description?: string; // 人类可读描述
  permission: 'owner' | 'guest';
  needsConfirm: boolean; // owner + confirmWrites=false 时为 false
}
```

### 8.11 异步归档等待

| 方法                                | 说明                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `agent.waitForArchives(timeoutMs?)` | 等待所有 in-flight 归档任务完成（默认 5 秒超时）。`close()` 内部已自动调用此方法，宿主程序一般不需要直接使用。 |

### 8.12 上下文窗口管理

| 配置项                          | 说明                                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `AgentOptions.maxContextTokens` | 上下文窗口 token 上限（默认 8000，约 32K 中文字符）。超过此阈值时自动裁剪中间段消息，保留 system prompt + 最近 N 条消息。 |

**桌面精灵等长运行场景必备**：Agent 持续运行数天，`messages`
数组无限增长会爆 LLM 上下文窗口。此配置自动截断，确保 LLM 请求不因上下文溢出而失败。

```typescript
const agent = new Agent({
  projectPath: '/path/to/project',
  configDir: '/path/to/agent-config',
  maxContextTokens: 16000, // 覆盖默认值，适配大上下文窗口模型
  config: { ... },
});
```

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
// 判断用户离线时长，决定是否主动问候
const now = Date.now();
const lastInteraction = agent.lastInteractionAt;
if (lastInteraction && now - lastInteraction.getTime() > 30 * 60 * 1000) {
  // 超过 30 分钟，主动问候
  await agent.chatSync('【系统】用户已离线 30 分钟，请主动问候');
}
```

---

> **API 设计原则**：所有公开方法在错误状态下会抛 `configError` / `llmError`
> 等友好错误（带可操作的 `suggestions[]`），宿主程序可在最外层 `try/catch`
> 统一处理。**不会**静默返回 null 或空数组（除文档明确说明的 getter 外）。

## 九、Provider 管理

> 文档 9.x 节按"已实现 / 设计阶段"明确区分。详细 API 见 §8.6。

### 9.1 已实现：多 Provider 注册与切换

Agent 支持运行时管理多个 LLM
Provider，每个 Provider 有独立别名（`name`），可随时切换。

```typescript
// 1. 配置文件里配置多个（init 时自动加载）
// agent-config/llm.json:
// {
//   "providers": {
//     "openai": { "provider": "openai-compatible", "apiKey": "sk-...", "model": "gpt-4o" },
//     "deepseek": { "provider": "openai-compatible", "apiKey": "sk-...", "model": "deepseek-chat" }
//   },
//   "active": "openai"
// }

// 2. 运行时动态添加（不写入配置文件，重启后失效）
agent.addProvider('kimi', {
  provider: 'openai-compatible',
  baseUrl: 'https://api.moonshot.cn/v1',
  apiKey: process.env.KIMI_API_KEY!,
  model: 'moonshot-v1-128k',
});

// 3. 切换
agent.switchProvider('deepseek');

// 4. 查询
agent.listProviders(); // ['openai', 'deepseek', 'kimi']
agent.getActiveProviderName(); // 'deepseek'
agent.currentProvider; // LlmProvider 实例
```

**API Key 保护**：`addProvider()` 不暴露完整 API Key（只显示前 3 位 +
`***`），宿主程序打印日志时可放心调用。

### 9.2 设计阶段：前台/后台双通道路由

> **状态**：📋 设计阶段。`LlmProvider` 已支持多实例，但消费者（`TopicSummarizer`
> / `UserProfile` / `WorkProjection` / `AutoConfigRefiner`）目前仍复用 chat
> Provider。

**目标**：不同消费者按质量/成本需求路由到不同 Provider。

| 消费者                | 质量要求 | 成本敏感 | 期望通道     |
| --------------------- | -------- | -------- | ------------ |
| AgentLoop（用户对话） | 高       | 低       | chat（默认） |
| TopicSummarizer       | 中       | 高       | background   |
| UserProfile           | 中       | 高       | background   |
| WorkProjection        | 中       | 高       | background   |
| AutoConfigRefiner     | 中       | 高       | background   |

**预留配置格式**（设计阶段，尚未实现）：

```typescript
const agent = new Agent({
  config: {
    llm: {
      chat: {
        provider: 'openai-compatible',
        model: 'gpt-4o',
        apiKey: 'sk-...',
      },
      background: {
        provider: 'openai-compatible',
        model: 'deepseek-chat',
        apiKey: 'sk-...',
      },
    },
  },
});
```

不配 `background` 时，所有消费者复用 `chat`——零破坏性。

## 十、关键约束

1. **configDir** 指向 Agent 级配置目录（`personas/` + `rules/` +
   `skills/`），所有子项目共享
2. **项目级 `.memora/`** 只放 `rules/` 和 `skills/`，不放 `memora.db`
3. **角色由关键词自动触发**，用户说「帮我写小说」→ 自动切换到「作家」角色
4. **对话历史跨子项目持久化**，切换子项目不会丢失之前聊过的内容
5. `registerTool()` 和 `addRule()` / `addSkill()` 必须在 `init()` 之后调用
6. **作品原始内容不进 SQLite**，Agent 通过工具按需读取，只存轻量投影
7. **配置文件是真理源**，`agent-config/`
   下的配置由 MemoryLoader 启动时扫描加载到 SQLite；`addRule()`
   是运行时注入，不经配置文件
8. **禁止**为每个子项目创建独立的 memora.db——记忆是 Agent 级的
9. **禁止**项目切换时关闭/重建数据库——记忆跨项目持久化
10. **禁止**将配置直接写入 SQLite 作为持久化存储——配置文件才是真理源

---

> 更多细节参见 `docs/基础设计文档/01-主架构-v4.0.md`
