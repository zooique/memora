# Memora · 接入指南 v1.0

> 帮助宿主项目开发者快速理解 Memora 的设计理念和接入方法。

---

## 一、核心理念

**万物皆是记忆**。身份、规则、技能、工具定义、对话历史——全部统一为「记忆」，通过
`类型 + 永久性` 两个维度区分。

**单 Agent 模型**。Memora 被宿主接入后，就是该程序的唯一 Agent。所有对话、所有记忆存在同一个数据库中，**切换子项目不会丢失记忆**。

**配置文件是真理源，SQLite 是运行时索引。** `agent-config/`
下的配置文件由 MemoryLoader 在启动时扫描，加载到 SQLite 中。记忆自动归档（UserProfile、话题摘要、对话快照 →
SQLite）是所有模式共有的基础能力。

## 二、Agent 的三个模块

```
Agent = 设定 + 身份 + 技能
```

| 模块     | 目录          | 是什么           | 例子                         |
| -------- | ------------- | ---------------- | ---------------------------- |
| **设定** | `rules/`      | Agent 的行为规范 | 写作规范、安全基线、代码风格 |
| **身份** | `identities/` | 当前扮演的角色   | 作家、编辑、程序员、翻译     |
| **技能** | `skills/`     | 可调用的能力模块 | 章节创作、魔法体系、代码审查 |

身份由话题关键词自动触发（也可手动锁定），技能始终可用。身份通过
`systemPromptPrefix` 注入到系统提示词中，不进入 bootstrap 记忆加载。

## 三、目录结构

```
宿主程序/
├── agent-config/              ← Agent 级配置（唯一）
│   ├── identities/            ← 身份配置（.md 文件）
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
│   ├── identities/
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
    │   ├── identities/
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
# → 自动生成 identities/ + rules/
```

### 模式 3：Agent 智能总结（配置权限交给 Agent）

Agent 从日常对话中自动提取用户偏好，生成配置建议，用户确认后写入配置文件。下次启动时 MemoryLoader 自动扫描加载到 SQLite。

```
用户对话 → 定期触发 LLM 反思 → 生成配置建议 → 用户确认
    → 写入配置文件（agent-config/rules/、identities/、skills/）
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

| 机制                            | 产出                                | 存储位置                 | 触发方式           |
| ------------------------------- | ----------------------------------- | ------------------------ | ------------------ |
| **UserProfile**（已实现）       | 用户画像                            | SQLite                   | 实时归档，自动确认 |
| **AutoConfigRefiner**（计划中） | 配置文件（rules/identities/skills） | `agent-config/` 文件系统 | 定期反思，用户确认 |
| `addRule()`（已实现）           | 规则记忆                            | SQLite（运行时注入）     | 宿主程序主动调用   |

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

## 七、自我进化机制（设计阶段）

> 对应「模式 3 ·
> Agent 智能总结」——Agent 从白纸开始，通过对话自动进化到与用户契合的形态。

### 核心原则：内核管"魂"，宿主管"体"

自我进化的本质是**配置文件的自动积累**。Agent 从对话中提取规则、身份 traits，写入
`agent-config/` 下的配置文件。

```
对话 → AutoConfigRefiner 定期反思 → 生成配置建议
    → 用户确认 → 写入配置文件（agent-config/rules/、identities/、skills/）
    → 下次启动时 MemoryLoader 扫描 → 加载到 SQLite
    → inspect() 暴露当前状态 → 宿主读取 → 决定呈现方式
```

### 内核提供：AutoConfigRefiner

| 职责         | 说明                                                            |
| ------------ | --------------------------------------------------------------- |
| **定期反思** | 每 N 轮对话，调用 LLM 分析对话内容，提取可用的规则和身份 traits |
| **生成建议** | 形成结构化建议（类型 + 名称 + 内容 + 置信度）                   |
| **回调通知** | 通过 `onConfigSuggestion` 回调通知宿主，由宿主决定如何展示      |

```typescript
// 内核暴露的回调接口（计划中）
agent.onConfigSuggestion((suggestion) => {
  // suggestion = {
  //   type: 'rule' | 'identity' | 'skill',
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
│       → 身份 trait：「性格：严谨」      │
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
| 形态映射 | 规则数量 + 身份 traits → 宠物外观的映射表                                |
| 视觉渲染 | SVG/像素画 + 动画帧 + 粒子特效                                           |
| 桌面挂件 | 系统托盘、窗口置顶、拖拽交互                                             |
| 建议展示 | 收到 `onConfigSuggestion` 回调时，弹出气泡让用户确认                     |

内核不管 Agent 长什么样，只管它正在变成什么。

## 八、API 速查

| 方法                                     | 说明                                                |
| ---------------------------------------- | --------------------------------------------------- |
| `agent.init()`                           | 初始化（创建 DB、加载配置、连接 LLM）               |
| `agent.chat(input)`                      | 流式对话，返回 AsyncGenerator                       |
| `agent.chatSync(input)`                  | 同步对话，返回完整回复字符串                        |
| `agent.addRule(memory)`                  | 动态注入规则（type=rule, permanence=always/domain） |
| `agent.registerTool(def, handler)`       | 注册自定义工具                                      |
| `agent.switchProject(name)`              | 切换到其他子项目                                    |
| `agent.listProjects()`                   | 列出已注册的子项目                                  |
| `agent.listPersonas()`                   | 列出可用身份                                        |
| `agent.switchPersona(name)`              | 手动切换到指定身份                                  |
| `agent.setPersonaMode('auto'\|'manual')` | 设置身份切换模式                                    |
| `agent.inspect()`                        | 返回 Agent 当前状态快照（规则数、身份列表等）       |
| `agent.onConfigSuggestion(handler)`      | 注册配置建议回调（模式 3）                          |
| `agent.confirmConfigSuggestion(suggest)` | 确认建议并写入配置文件（模式 3）                    |
| `agent.close()`                          | 安全关闭（释放锁 + 关闭 Agent 级数据库）            |

## 九、多 Provider 路由（设计阶段）

> **状态**：📋 设计阶段，未实现。等 2+ 个宿主项目有实际需求时再落地。

### 9.1 问题

Agent 内部有多个 LLM 消费者，质量/成本需求不同：

| 消费者                | 用途         | 质量要求 | 成本敏感 |
| --------------------- | ------------ | -------- | -------- |
| AgentLoop             | 用户对话     | 高       | 低       |
| TopicSummarizer       | 话题归档摘要 | 中       | 高       |
| UserProfile           | 用户画像提取 | 中       | 高       |
| WorkProjectionManager | 作品投影生成 | 中       | 高       |
| AutoConfigRefiner     | 配置建议反思 | 中       | 高       |

目前所有消费者共用一个 Provider，无法按用途路由。

### 9.2 设计：前台/后台双通道

```
前台 API（chat 通道）           后台 API（background 通道）
┌─────────────────┐            ┌─────────────────┐
│ AgentLoop.chat  │            │ TopicSummarizer  │
│ 质量要求：高     │            │ UserProfile      │
│ 模型：GPT-4o    │            │ WorkProjection   │
│ 延迟：低        │            │ AutoConfigRefiner│
│ 成本：高        │            │ 质量要求：中      │
└─────────────────┘            │ 模型：DeepSeek    │
                               │ 延迟：不限        │
                               │ 成本：低          │
                               └─────────────────┘
```

### 9.3 配置格式

```typescript
const agent = new Agent({
  config: {
    llm: {
      // 前台：用户对话（必填）
      chat: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-...' },
      // 后台：归档/投影/画像（可选，不配则复用 chat）
      background: {
        provider: 'deepseek',
        model: 'deepseek-chat',
        apiKey: 'sk-...',
      },
    },
  },
});
```

**向后兼容**：不配 `background` 时，所有消费者复用 `chat`——零破坏性。

### 9.4 内核/宿主边界

| 层级 | 职责               | 说明                                            |
| ---- | ------------------ | ----------------------------------------------- |
| 内核 | LlmRouter 路由机制 | 根据 consumer 类型选择 chat/background Provider |
| 内核 | Provider 注册接口  | 支持注册多个 Provider 实例                      |
| 宿主 | 配置哪些 API       | 决定用哪个 Provider、什么密钥                   |
| 宿主 | 不感知路由细节     | 宿主不知道"归档需要调 LLM"                      |

### 9.5 实现预留

- `src/llm/provider.ts` 的 `LlmProvider` 抽象类已支持多实例
- `ChatOptions` 已有 `model` 字段，可扩展 `channel?: 'chat' | 'background'`
- 配置层 `src/config/` 的 `LlmConfig` 类型预留 `chat` + `background` 双通道

## 十、关键约束

1. **configDir** 指向 Agent 级配置目录（`identities/` + `rules/` +
   `skills/`），所有子项目共享
2. **项目级 `.memora/`** 只放 `rules/` 和 `skills/`，不放 `memora.db`
3. **身份由关键词自动触发**，用户说「帮我写小说」→ 自动切换到「作家」角色
4. **对话历史跨子项目持久化**，切换子项目不会丢失之前聊过的内容
5. `registerTool()` 和 `addRule()` 必须在 `init()` 之后调用
6. **作品原始内容不进 SQLite**，Agent 通过工具按需读取，只存轻量投影
7. **配置文件是真理源**，`agent-config/`
   下的配置由 MemoryLoader 启动时扫描加载到 SQLite；`addRule()`
   是运行时注入，不经配置文件
8. **禁止**为每个子项目创建独立的 memora.db——记忆是 Agent 级的
9. **禁止**项目切换时关闭/重建数据库——记忆跨项目持久化
10. **禁止**将配置直接写入 SQLite 作为持久化存储——配置文件才是真理源

---

> 更多细节参见 `docs/基础设计文档/01-主架构-v4.0.md`
