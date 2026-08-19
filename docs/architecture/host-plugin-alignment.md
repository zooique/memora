# 宿主插件对齐方案

> **定位**：memora 是一个"无法独立运行的智能大脑内核"，宿主（Trae/IDE/CLI）负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。本文档定义宿主与 memora 内核的完整对齐方案。
>
> **设计哲学**：
> - **内核零越界**：memora 不调用 `console.*`、不写用户文件、不管理 API Key、不读 `process.stdin`
> - **接口契约**：宿主通过实现标准接口注入能力，内核只依赖接口不依赖宿主
> - **单一真理源**：配置文件是真理源，对话走 SQLite 索引，角色包是设定的唯一注入源
>
> **版本**：v1.0 · 2026-08-18

---

## 一、架构全景图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          宿主（Host / Trae）                             │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │  UI 渲染层    │  │  项目管理层    │  │  配置管理    │  │  日志/追踪   │ │
│  │  - 对话面板   │  │  - 打开项目   │  │  - config.json│  │  - 结构化日志│ │
│  │  - 角色选择   │  │  - 工作区     │  │  - 角色包管理 │  │  - 性能追踪   │ │
│  │  - 文件树     │  │  - Git 集成   │  │  - 技能注册   │  │  - 错误上报   │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘ │
│         │                 │                 │                  │       │
│  ┌──────┴─────────────────┴─────────────────┴──────────────────┴──────┐ │
│  │                        宿主适配层（Adapter Layer）                  │ │
│  │                                                                    │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │ │
│  │  │ IMemoryStorage   │  │ ISessionStore   │  │  IWebSearchProvider│  │ │
│  │  │ (SQLite 实现)    │  │ (文件系统实现)   │  │  (宿主搜索 API)   │  │ │
│  │  └─────────────────┘  └─────────────────┘  └──────────────────┘  │ │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐  │ │
│  │  │  ITracer         │  │ IRolePackSource │  │  UI Message Bridge│  │ │
│  │  │ (OpenTelemetry)  │  │ (角色包目录)    │  │  (事件 → UI 渲染)  │  │ │
│  │  └─────────────────┘  └─────────────────┘  └──────────────────┘  │ │
│  │                                                                    │ │
│  │  ┌─────────────────────────────────────────────────────────────┐  │ │
│  │  │  Tool Registry（宿主工具注册）                               │  │ │
│  │  │  - IDE 操作：open_file / search_code / refactor              │  │ │
│  │  │  - 项目操作：create_file / delete_file / run_command         │  │ │
│  │  │  - 宿主特有：get_errors / get_tests / preview_url            │  │ │
│  │  └─────────────────────────────────────────────────────────────┘  │ │
│  └────────────────────────────────┬───────────────────────────────────┘ │
│                                   │ 初始化注入                           │
└───────────────────────────────────┼─────────────────────────────────────┘
                                    │
                    new Agent(AgentOptions)
                                    │
┌───────────────────────────────────┼─────────────────────────────────────┐
│                           Memora 内核                                     │
│                                                                         │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                         Agent 面类（编排层）                        │ │
│  │  init / close · chat · switchProject · on/off · tools.registerTool│ │
│  └────┬───────────┬───────────┬───────────┬───────────┬──────────────┘ │
│       │           │           │           │           │                │
│  ┌────┴────┐ ┌────┴────┐ ┌────┴────┐ ┌────┴────┐ ┌────┴────────────┐ │
│  │AgentLoop│ │MemoryIn-│ │RolePack-│ │SkillMgr │ │ ConfigMgr       │ │
│  │核心引擎 │ │spector  │ │Manager  │ │         │ │ (默认值/解析)    │ │
│  └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬────────────┘ │
│       │           │           │           │           │                │
│  ┌────┴───────────┴───────────┴───────────┴───────────┴────────────┐ │
│  │                     记忆/配置存储抽象层                            │ │
│  │         IMemoryStorage ← 宿主实现 · ISessionStore ← 宿主实现     │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│  设计真理源：                                                            │
│  · 角色包 = 设定（persona/rules/skills/capabilities），文件驱动         │
│  · 记忆系统 = 摘要记忆（round-summary），SQLite + 向量召回              │
│  · Agent Loop = 最小问答闭环，Loop/召回/摘要都是闭环的自然生长         │
│  · 配置 = 单一真理源（config.json + 角色包 manifest.json）             │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 二、宿主需实现的接口清单

### 2.1 必选接口（7 个）

| # | 接口 | 用途 | 实现难度 | 说明 |
|---|------|------|---------|------|
| 1 | `ImemoryStorage` | 记忆持久化 | 🔴 中高 | 15 方法，推荐 SQLite + better-sqlite3 |
| 2 | `ISessionStore` | 会话消息持久化 | 🟡 中 | 3 必需 + 6 可选方法 |
| 3 | `LlmProvider` | LLM API 调用 | 🟡 中 | 流式对话接口 |
| 4 | `ITracer` | 可观测性追踪 | 🟢 低 | 不传用 NoopTracer |
| 5 | `IWebSearchProvider` | 网络搜索 | 🟢 低 | 可选注入 |
| 6 | `IRolePackSource` | 角色包加载 | 🟢 低 | 目录读取抽象 |
| 7 | 工具注册 | IDE 操作能力 | 🟡 中 | `agent.tools.registerTool()` |

### 2.2 `ImemoryStorage` 接口（15 方法）

```typescript
// 宿主必须实现此接口注入 Agent
interface IMemoryStorage {
  // ── 写入（4 方法）──
  upsert(memory: Memory): void;
  delete(id: string, deletedAt?: number): void;
  restore(id: string): void;
  purge(id: string): void;          // 物理删除

  // ── 查询（7 方法）──
  getById(id: string): Memory | undefined;
  getByName(name: string): Memory | undefined;
  list(options?: ListOptions): Memory[];
  search(keyword: string, limit?: number): Memory[];
  getBySource(source: string): Memory[];
  listDeleted(): Memory[];
  getAllSources(): string[];

  // ── 治理（3 方法）──
  decayScores(decayRate: number): void;
  purgeExpired(maxAgeMs: number): void;
  close?(): void;
}
```

### 2.3 `ISessionStore` 接口（3 必需 + 6 可选）

```typescript
interface ISessionStore {
  // ── 必需（3 方法）──
  appendMessage(date: string, session: string, message: SessionMessage): void;
  loadMessages(date: string, session: string): SessionMessage[];
  listSessions(): string[];

  // ── 可选（宿主按需实现）──
  copySession?(sourceDate: string, sourceSession: string, targetDate: string, targetSession: string): void;
  saveCheckpoint?(sessionId: string, checkpoint: string): void;
  loadCheckpoint?(sessionId: string): string | null;
  deleteCheckpoint?(sessionId: string): void;
  getSessionMeta?(sessionId: string): SessionMeta | undefined;
  setSessionTitle?(sessionId: string, title: string): void;
  listSessionMetas?(): SessionMeta[];
}
```

### 2.4 `LlmProvider` 接口

```typescript
interface LlmProvider {
  // 流式对话（核心方法）
  stream(messages: Message[], options?: ChatOptions): AsyncIterable<LlmChunk>;
  // 文本补全
  complete?(prompt: string, options?: ChatOptions): AsyncIterable<LlmChunk>;
}
```

---

## 三、角色包对齐方案

### 3.1 角色包文件结构

```
宿主 configDir/
├── role-packs/                        ← 角色包目录
│   ├── 工程师/                        ← 角色包名 = 目录名
│   │   ├── manifest.json              ← 核心控制文件（唯一权威）
│   │   ├── persona.md                 ← 身份设定（约定文件名）
│   │   ├── rules.md                   ← 确定性规则（约定文件名）
│   │   └── skills/                    ← 角色包绑定技能（动态扫描）
│   │       └── code-review.md
│   ├── 产品经理/
│   │   ├── manifest.json
│   │   ├── persona.md
│   │   └── skills/
│   │       └── requirement-analysis.md
│   └── ...（更多角色包）
│
├── skills/                            ← 全局技能池（所有角色共享）
│   ├── web-search.md
│   ├── file-operations.md
│   └── terminal-commands.md
│
└── personas/                          ← 旧格式兼容层（可空）
    └── （迁移到 role-packs/）
```

### 3.2 manifest.json 结构

```json
{
  "name": "工程师",
  "formatVersion": "1.0.0",
  "keywords": ["代码", "bug", "功能", "重构", "测试"],
  "exclusiveWith": ["翻译助手"],
  "strategy": {
    "prepare": {
      "memoryRecall": "full",
      "memoryRecallQuota": 2000,
      "recentRounds": 3
    },
    "act": {
      "toolMode": "allow",
      "streaming": true
    },
    "reflect": {
      "handoff": "wait",
      "loopContinue": 0
    }
  },
  "capabilities": [
    { "capability": "code:read", "description": "读取代码文件" },
    { "capability": "code:write", "description": "写入/修改代码" },
    { "capability": "debug:diagnose", "description": "调试诊断" }
  ]
}
```

### 3.3 宿主角色包管理 API

```typescript
// 1. 角色包目录注入
const agent = new Agent({
  configDir: '/path/to/role-packs',  // 宿主管理的配置目录
  // ... 其他选项
});

// 2. 运行时角色包操作
agent.persona.list                    // 列出所有角色包
agent.persona.activeName              // 当前激活的角色包
agent.persona.switchPersona('工程师')  // 手动切换角色
agent.persona.setMode('manual')       // 锁定手动模式
agent.switchRolePack('产品经理')      // 切换角色包

// 3. 重新加载角色包配置
agent.reloadConfig('role-pack-changed');
```

### 3.4 角色包粘性匹配纪律

```
用户输入 → 触发词/语义匹配 → 角色包匹配
  │                            │
  ├─ 首次输入 → 全量匹配 → 锁定角色包
  ├─ 后续输入 → 不重匹配 → 沿用已锁定角色包
  ├─ 显式切换 → 替换 → 新角色包锁定
  └─ 互斥触发 → 命中 → 自动切换（如工程师 → 翻译助手）
```

**宿主 UI 应展示当前激活角色**：通过 `agent.persona.activeName` 获取，在对话面板顶部显示角色徽章。

---

## 四、技能系统对齐方案

### 4.1 两级技能架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     技能体系（两级同构）                          │
│                                                                 │
│  L1 全局技能池                      L2 角色包绑定技能             │
│  configDir/skills/*.md             configDir/role-packs/<名>/   │
│  │                                  skills/*.md                 │
│  │  动态扫描注册                     │                           │
│  │  渐进披露：                      │  渐进披露：                 │
│  │  L1 = 元数据清单常驻 system prompt│  L1 = 元数据清单常驻        │
│  │  L2 = read_skill 按需加载正文    │  L2 = read_skill 按需加载   │
│  │  L3 = read_resource / run_skill  │  L3 = 同上                 │
│  │     _script 按需调用             │                           │
│  ▼                                  ▼                           │
│  全局激活（所有角色可见）            角色激活才激活（装载时注册）  │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 技能文件格式

```markdown
---
name: 代码审查
description: 对代码进行安全与质量审查
keywords: ['审查', 'code review', '安全']
trigger: /审查|review|code.*check/i
---

## 技能说明
对代码文件进行自动化审查，检查：
1. 安全性漏洞（SQL 注入、XSS、密钥泄露）
2. 代码质量（命名规范、复杂度、重复代码）
3. 最佳实践（错误处理、类型安全）

## 使用方法
当用户请求代码审查时，按以下步骤执行...
```

### 4.3 宿主技能操作 API

```typescript
// 查看技能列表
agent.skills.list                       // SkillEntry[]
agent.skills.match('帮我审查代码')      // SkillMatch[] 按得分排序

// 运行时注册全局技能
agent.skills.register({
  name: 'deploy',
  description: '部署应用到生产环境',
  keywords: ['部署', 'deploy', '上线'],
  content: '## 部署流程\n1. ...\n2. ...',
  filePath: '/path/to/deploy.md',
  layer: 'agent',
});

// 技能触发事件
agent.on('skillMatched', (match) => {
  // 宿主可在 UI 中提示"检测到技能：{match.skill.name}"
});
```

### 4.4 能力声明与工具暴露

```
角色包 capabilities 声明 → 决定工具暴露面
  │
  ├─ 声明了 code:read → 暴露 read_file 工具
  ├─ 声明了 code:write → 暴露 write_file 工具
  ├─ 声明了 code:debug → 暴露 search_memories 工具
  └─ 未声明 → 默认暴露所有工具（向后兼容）

宿主自定义能力扩展：
  agent.tools.registerTool({ name: 'deploy', ... }, handler)
  → 角色包声明 { capability: 'code:deploy' }
  → Agent 根据 capabilities 自动过滤工具列表
```

---

## 五、记忆系统对齐方案

### 5.1 记忆分类（唯一类型：round-summary）

```
┌──────────────────────────────────────────────────────────────┐
│                     记忆系统（万物皆记忆 v2）                   │
│                                                              │
│  设定记忆（进角色包，不进记忆库）                              │
│  ├── persona.md → 身份设定                                    │
│  ├── rules.md → 确定性规则                                    │
│  └── skills/*.md → 技能内容                                   │
│                                                              │
│  对话记忆（进 SQLite，只有摘要）                              │
│  ├── round-summary（轮次级）：type 分类标签                  │
│  │   ├── preference（用户偏好）                               │
│  │   ├── decision（决策记录）                                 │
│  │   ├── fact（项目事实）                                     │
│  │   ├── intent（未来意图）                                   │
│  │   └── general（通用记录）                                  │
│  └── content（会话级）：会话归档摘要                          │
│                                                              │
│  存储层：                                                    │
│  ├── SQLite（better-sqlite3） ← IMemoryStorage 实现          │
│  ├── 向量索引（JsonVectorStore） ← IVectorStore 实现         │
│  └── 会话文件（sessions/*.json） ← ISessionStore 实现        │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 宿主记忆管理 API

```typescript
// ── 查询 ──
agent.memory.snapshot()              // 3 层快照：working/bootstrap/archive
agent.memory.search('偏好')          // 关键词搜索
agent.memory.searchHybrid('部署')    // 混合搜索（向量 + 关键词）
agent.memory.stats()                 // 统计信息
agent.memory.list()                  // 全部记忆
agent.memory.getById('mem:xxx')      // 单条记忆

// ── 写入 ──
agent.memory.writeUpsert(memory)     // 写入/更新
agent.memory.writeDelete('mem:xxx')  // 软删除
agent.memory.writeRestore('mem:xxx') // 恢复
agent.memory.writePurge('mem:xxx')   // 物理删除
agent.memory.writeBoost('mem:xxx')   // 提升分数

// ── 治理 ──
agent.deduplicateMemories()          // 去重
agent.evaluateTimeliness()           // 时效性评估
agent.runMemoryDecayOnce()           // 分数衰减
agent.sourceHealth()                 // 来源健康度
agent.suggest('新项目')              // 配置建议
agent.detectConflicts()              // 冲突检测
```

### 5.3 宿主记忆事件订阅

```typescript
agent.on('memoryAdded', (memory) => {
  // 新记忆创建 → UI 更新
});

agent.on('memoryRecalled', (memories) => {
  // 记忆被召回 → UI 展示召回透明度
  // memories: RecalledMemorySummary[]（含 name/score/source）
});

agent.on('conflictDetected', (conflict) => {
  // 检测到记忆冲突 → UI 提示用户
});

agent.on('decayCompleted', (info) => {
  // 分数衰减完成 → 日志记录
});
```

### 5.4 宿主记忆存储实现要点

```typescript
// 推荐实现：SQLite + better-sqlite3
class SqliteMemoryStorage implements IMemoryStorage {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT,
        score REAL DEFAULT 1.0,
        superseded INTEGER DEFAULT 0,
        createdAt INTEGER,
        updatedAt INTEGER,
        deletedAt INTEGER
      );
      CREATE INDEX idx_memories_source ON memories(source);
      CREATE INDEX idx_memories_score ON memories(score);
    `);
  }

  upsert(memory: Memory): void { /* INSERT OR REPLACE */ }
  search(keyword: string, limit?: number): Memory[] { /* LIKE 查询 */ }
  // ... 其余 13 个方法
}
```

---

## 六、Agent Loop 对齐方案

### 6.1 Loop 事件流（宿主 UI 渲染依据）

```
用户输入 "帮我审查这段代码"
  │
  ▼
Agent.chat(input) → AsyncIterable<AgentChunk>
  │
  ├─ { type: 'thinking', phase: 'recalling' }    → UI: "正在召回相关记忆..."
  ├─ { type: 'recall', memories: [...] }          → UI: 展示召回的记忆条目
  ├─ { type: 'thinking', phase: 'processing' }   → UI: "正在匹配技能..."
  ├─ { type: 'text', content: '根据代码审查规范...'} → UI: 流式渲染文本
  ├─ { type: 'tool_start', name: 'read_file' }    → UI: "读取文件..."
  ├─ { type: 'tool_result', ok: true }             → UI: 隐藏工具结果
  ├─ { type: 'text', content: '发现 3 个问题...' } → UI: 继续渲染
  ├─ { type: 'handoff', decision: 'wait' }        → UI: 等待用户下一轮输入
  └─ { type: 'done' }                             → UI: 本轮完成
```

### 6.2 宿主 Loop 事件处理

```typescript
async function handleUserInput(input: string) {
  const chunks: AgentChunk[] = [];

  for await (const chunk of agent.chat(input)) {
    switch (chunk.type) {
      case 'thinking':
        ui.setStatus(THINKING_PHASES[chunk.phase]);
        break;

      case 'recall':
        ui.showRecalledMemories(chunk.memories);
        break;

      case 'text':
        ui.appendAssistantText(chunk.content);
        break;

      case 'tool_start':
        ui.showToolIndicator(chunk.name);
        break;

      case 'tool_result':
        ui.hideToolIndicator(chunk.name);
        break;

      case 'question_pending':
        ui.renderQuestionDialog(chunk.questions);
        // 用户回答后：agent.resumeExecution(answer)
        break;

      case 'handoff':
        handleHandoffDecision(chunk.decision);
        break;

      case 'error':
        ui.showError(chunk.message);
        break;

      case 'aborted':
        ui.showAbortNotice(chunk.reason);
        break;
    }
  }
}
```

### 6.3 Handoff 决策（宿主控制循环）

```typescript
function handleHandoffDecision(decision: HandoffDecision) {
  switch (decision) {
    case 'wait':
      // 默认行为：等待用户输入
      ui.enableInput();
      break;

    case 'loop':
      // 自动续跑：宿主自动触发下一轮
      // 场景：批量任务（"修复所有 lint 错误"）
      setTimeout(() => agent.chat('继续'), 100);
      break;

    case 'end':
      // 终止会话
      ui.showEndOfSession();
      break;
  }
}
```

### 6.4 Loop 核心事件类型

| 事件类型 | 触发时机 | 宿主处理 |
|---------|---------|---------|
| `thinking:recalling` | 记忆召回阶段 | 显示加载指示 |
| `thinking:processing` | 角色/技能匹配阶段 | 显示处理中 |
| `thinking:archiving` | 摘要归档阶段 | 后台静默 |
| `recall` | 记忆召回完成 | 展示召回条目（透明度） |
| `text` | LLM 流式输出文本 | 渲染气泡 |
| `tool_start` | 工具调用开始 | 显示工具执行指示器 |
| `tool_result` | 工具调用完成 | 隐藏指示器 |
| `question_pending` | LLM 主动提问 | 渲染提问 UI |
| `handoff` | 回合衔接决策 | 决定是否自动续跑 |
| `error` | 执行出错 | 错误提示 |
| `aborted` | 被用户中止 | 中止提示 |
| `retry` | LLM 调用重试 | 重试计数展示 |
| `paused` | Loop 挂起 | 进入等待状态 |

---

## 七、工具注册方案

### 7.1 宿主工具分类

```
┌─────────────────────────────────────────────────────────────┐
│                    工具注册体系                              │
│                                                             │
│  ① 内置工具（memora 提供）                                  │
│     - read_file / write_file / list_dir                    │
│     - search_memories / web_search                         │
│                                                             │
│  ② 宿主工具（IDE 特有）                                     │
│     - open_file: 在编辑器中打开文件                         │
│     - search_code: 全文代码搜索                             │
│     - get_errors: 获取诊断错误                              │
│     - run_command: 执行终端命令                             │
│     - refactor: 重构代码                                    │
│     - preview_url: 预览 URL                                │
│     - get_tests: 获取测试列表                               │
│                                                             │
│  ③ 角色包工具（角色绑定）                                   │
│     - 代码审查：security_scan / lint_check                  │
│     - 产品经理：generate_spec / analyze_requirements        │
│                                                             │
│  ④ 技能工具（skills 绑定）                                  │
│     - deploy: run_deployment                               │
│     - documentation: update_docs                          │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 宿主工具注册示例

```typescript
// IDE 文件操作工具
agent.tools.registerTool(
  {
    name: 'open_file',
    description: '在 IDE 编辑器中打开指定文件',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件的绝对路径' },
        line: { type: 'number', description: '可选，跳转到指定行' },
      },
      required: ['path'],
    },
  },
  async (args) => {
    const file = await host.editor.openFile(args.path, { line: args.line });
    return JSON.stringify({ success: true, file: file.name });
  },
);

// 代码诊断工具
agent.tools.registerTool(
  {
    name: 'get_diagnostics',
    description: '获取当前项目的 TypeScript/ESLint 诊断错误',
    parameters: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          description: '过滤级别：error | warning | info',
          default: 'error',
        },
      },
      required: [],
    },
  },
  async (args) => {
    const diags = await host.languageServer.getDiagnostics({
      severity: args.severity,
    });
    return JSON.stringify(diags, null, 2);
  },
);

// 终端命令执行工具
agent.tools.registerTool(
  {
    name: 'run_terminal',
    description: '在集成终端中执行命令',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（可选）' },
        timeout: { type: 'number', description: '超时时间（秒，默认 30）' },
      },
      required: ['command'],
    },
  },
  async (args) => {
    const result = await host.terminal.execute(args.command, {
      cwd: args.cwd,
      timeout: args.timeout ?? 30,
    });
    return JSON.stringify({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  },
);
```

### 7.3 工具执行权限控制

```
角色包策略 act.toolMode 控制工具可见性：
  ├── 'allow'    → 允许所有工具（默认）
  ├── 'block'    → 禁止所有工具（纯对话模式）
  └── 'readonly' → 只允许只读工具

宿主 UI 应展示当前模式：
  agent.getActiveStrategy().act?.toolMode → UI 徽章
```

---

## 八、事件桥接方案

### 8.1 Agent 事件 → UI 渲染

```typescript
class AgentEventBridge {
  constructor(private agent: Agent, private ui: UIRenderer) {
    this.setupEventListeners();
  }

  private setupEventListeners() {
    // ── 角色/技能事件 ──
    this.agent.on('personaSwitched', (name) => {
      this.ui.updateRoleBadge(name);
    });
    this.agent.on('skillMatched', (match) => {
      this.ui.showSkillIndicator(match.skill.name);
    });

    // ── 记忆事件 ──
    this.agent.on('memoryAdded', (memory) => {
      this.ui.flashMemoryIndicator();
    });
    this.agent.on('memoryRecalled', (memories) => {
      this.ui.showRecalledMemories(memories);
    });

    // ── 项目/会话事件 ──
    this.agent.on('projectSwitched', (name) => {
      this.ui.updateProjectHeader(name);
    });
    this.agent.on('sessionForked', (info) => {
      this.ui.showForkNotification(info);
    });

    // ── 安全事件 ──
    this.agent.on('conflictDetected', (conflict) => {
      this.ui.showConflictWarning(conflict);
    });
    this.agent.on('archiveFailed', (err) => {
      this.ui.showErrorNotification('归档失败', err);
    });

    // ── 会话生命周期 ──
    this.agent.on('archiveCompleted', (result) => {
      this.ui.showArchiveResult(result);
    });
  }
}
```

### 8.2 AgentEventMap 参考

| 事件名 | 触发时机 | 载荷类型 |
|--------|---------|---------|
| `personaSwitched` | 角色切换成功 | `string`（角色名） |
| `skillMatched` | 技能匹配成功 | `SkillMatch` |
| `memoryAdded` | 新记忆创建 | `Memory` |
| `memoryRecalled` | 记忆被召回 | `RecalledMemorySummary[]` |
| `decayCompleted` | 分数衰减完成 | `{ count: number }` |
| `sessionForked` | 会话分叉 | `AgentForkResult` |
| `projectSwitched` | 项目切换 | `AgentContext` |
| `conflictDetected` | 记忆冲突检测 | `ConflictInfo` |
| `archiveFailed` | 归档失败 | `Error` |
| `archiveCompleted` | 归档完成 | `SessionArchiveResult` |

---

## 九、初始化完整流程

```typescript
async function initMemoraHost(): Promise<{ agent: Agent; bridge: AgentEventBridge }> {
  // ── 1. 准备存储层 ──
  const storage = new SqliteMemoryStorage('/path/to/memora.db');
  const sessionStore = new FileSessionStore('/path/to/sessions/');

  // ── 2. 准备 LLM Provider ──
  const provider = createLlmProvider({
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: 'https://api.deepseek.com/v1',
  });

  // ── 3. 创建 Agent ──
  const agent = new Agent({
    projectPath: '/path/to/workspace',
    provider,
    configDir: '/path/to/config',        // 含 role-packs/ + skills/
    dataDir: '/path/to/memory',           // 记忆数据目录
    storage,                              // IMemoryStorage 实现
    sessionStore,                         // ISessionStore 实现
    maxContextTokens: 120_000,
    permission: 'owner',
    allowedPaths: ['/path/to/workspace'],
    tracer: new HostTracer(),             // OpenTelemetry 实现
  });

  // ── 4. 初始化 ──
  const context = await agent.init();

  // ── 5. 注册宿主工具 ──
  registerHostTools(agent);

  // ── 6. 启动事件桥接 ──
  const bridge = new AgentEventBridge(agent, ui);

  // ── 7. 恢复最近会话 ──
  const restored = await agent.sessionManager.restoreMostRecentSession();
  if (restored > 0) {
    ui.showRestoredSession(restored);
  }

  return { agent, bridge };
}
```

---

## 十、宿主配置目录布局

```
宿主配置根目录/
├── config.json                  ← memora 配置（API key、模型等）
├── role-packs/                  ← 角色包（按目录组织）
│   ├── engineer/
│   │   ├── manifest.json
│   │   ├── persona.md
│   │   ├── rules.md
│   │   └── skills/
│   ├── product-manager/
│   │   └── ...
│   └── custom/
│       └── ...
├── skills/                      ← 全局技能池
│   ├── web-search.md
│   ├── terminal-commands.md
│   └── file-operations.md
└── resources/                   ← 知识引用
    ├── api-spec.md
    └── templates/
```

---

## 十.5、宿主独立实现：视图管理与扩展

Memora 内核是纯粹的“对话与记忆”引擎，不负责管理用户的视觉焦点和交互偏好。**所有涉及“视图展示层级”和“用户交互状态”的功能，均应由宿主独立实现，无需修改 Memora 内核的接口或数据结构。**

### 核心设计原则

- **内核职责**：确保对话内容（消息记录、记忆卡片）的持久化、完整性和可召回性。会话一旦创建，其内容在生命周期内始终可用。
- **宿主职责**：管理“会话列表的展示规则”和“用户交互的状态流转”，为用户提供定制化的、整洁的交互界面。

### 典型应用场景

以下功能在本质上都是“视图管理”问题，宿主应在自身的数据模型和前端框架中独立实现：

#### 1. 会话归档（Archive Session）
- **需求**：将已结束或暂时不活跃的会话从“活跃列表”移至“历史列表”，保持主界面整洁。
- **实现方案**：
    - **宿主数据库**：在会话数据表中增加状态字段（如 `is_archived`），用于区分会话的展示状态。
    - **宿主前端**：实现归档按钮，点击时调用宿主自身的后端 API 更新 `is_archived` 状态，并根据该字段过滤和渲染不同的会话列表视图。
    - **核心点**：**不调用** Memora Agent 的任何 API，不修改 `SessionMeta`。

#### 2. 会话置顶（Pin Session）
- **需求**：将重要会话固定在列表顶部，不受创建时间或更新时间影响。
- **实现方案**：
    - **宿主数据库**：增加 `is_pinned` 字段或 `pin_timestamp` 字段。
    - **宿主前端**：在列表渲染逻辑中，优先将 `is_pinned = true` 的会话展示在顶部。

#### 3. 会话标签/分类（Tags/Categories）
- **需求**：为会话添加自定义标签（如“工作”、“个人”、“重要”），实现多维分类管理。
- **实现方案**：
    - **宿主数据库**：建立会话与标签的关联表（多对多关系）。
    - **宿主前端**：提供标签管理 UI，并在侧边栏或过滤器中支持按标签筛选会话。

#### 4. 会话收藏夹（Favorites）
- **需求**：保存一个特定的会话集合，方便快速访问。
- **实现方案**：
    - **宿主数据库**：宿主自定义一张 `favorites` 表，存储用户收藏的 `session_id` 列表。
    - **宿主前端**：提供“收藏”按钮和独立的“收藏夹”视图。

### 优势与收益

- **架构解耦**：Memora 内核无需感知“归档”、“置顶”等视觉和交互概念，保持纯粹的业务逻辑。
- **高度灵活**：宿主可根据自身产品的特点，自由组合实现上述功能，甚至扩展出“多级归档”、“团队共享会话”等内核不提供的高级特性。
- **内核稳定**：内核代码零风险，记忆召回逻辑完全不受这些视图变更的影响，确保所有对话内容都能被准确回忆。

---

## 十一、分阶段实施路线

### Phase 1：最小接入（1-2 天）

| 任务 | 产出 | 依赖 |
|------|------|------|
| 实现 `ImemoryStorage` SQLite 版 | `SqliteMemoryStorage` | better-sqlite3 |
| 实现 `ISessionStore` 文件版 | `FileSessionStore` | fs-extra |
| 实现 `LlmProvider` | `createLlmProvider` | OpenAI 兼容 API |
| 实现 `ITracer` | `HostTracer` | OpenTelemetry |
| 创建宿主角色包目录 | 2-3 个角色包 | — |
| 注册 IDE 工具 | 3-5 个核心工具 | — |

**验收标准**：`agent.init()` 成功，`agent.chat('你好')` 返回流式响应。

### Phase 2：深度对齐（3-5 天）

| 任务 | 产出 | 依赖 |
|------|------|------|
| 实现事件桥接 | `AgentEventBridge` | Phase 1 |
| 实现工具权限控制 | UI 徽章 + 过滤 | 角色包 capabilities |
| 实现角色包自动匹配 | 粘性切换逻辑 | UI 角色选择器 |
| 实现记忆管理 UI | 记忆查看/编辑面板 | Phase 1 storage |
| 实现会话持久化 UI | 会话列表/恢复/分叉 | Phase 2 storage |
| 注入 `IWebSearchProvider` | 网络搜索能力 | — |

**验收标准**：完整对话流程（输入 → 角色匹配 → 召回 → 执行 → 输出 → 归档 → UI 渲染）。

### Phase 3：生态完善（5-7 天）

| 任务 | 产出 | 依赖 |
|------|------|------|
| 角色包市场 | 下载/分享/导入 | Phase 2 |
| 技能编辑器 | 创建/编辑技能文件 | Phase 2 |
| 记忆治理工具 | 去重/衰减/健康度 UI | Phase 2 |
| 多 Provider 路由 | taskRouter 配置 UI | Phase 1 provider |
| 后台通道 | 归档/投影独立 Provider | backgroundProvider |
| 可观测性面板 | 性能指标/错误追踪 | Phase 1 tracer |

**验收标准**：宿主完整覆盖 memora 所有公开 API。

---

## 十二、约束与纪律

### 12.1 宿主 → 内核：禁止反向依赖

| 规则 | 说明 |
|------|------|
| 内核不调用 `console.*` | 宿主通过 `logger` 接口注入日志实现 |
| 内核不读 `process.stdin/stdout` | 宿主通过 `Agent.chat()` 流式 API 获取输出 |
| 内核不管理 API Key | 宿主创建 `LlmProvider` 实例注入 |
| 内核不写用户配置文件 | 配置是真理源，Agent 只读 |
| 内核零运行时依赖 | 仅 `pino` 为可选 peer 依赖 |

### 12.2 宿主 → 内核：注入时机

```
允许注入的接口：
  ✅ 构造函数（AgentOptions）→ Provider/Storage/Tracer/SessionStore
  ✅ init() 后 → 工具注册、事件订阅
  ✅ 运行时 → setProvider / setBackgroundProvider / reloadConfig

禁止的操作：
  ❌ 直接修改内核内部状态
  ❌ 绕过接口直接操作数据库
  ❌ 在 chat() 执行期间修改 Provider
```

### 12.3 角色包开发纪律

| 规则 | 说明 |
|------|------|
| manifest.json 是唯一权威 | persona/rules 路径约定俗成，不声明 |
| 不硬编码厂商/模型 | 内核只提供机制，宿主/用户配置策略 |
| capabilities 独立顶层 | 能力声明在 `manifest.capabilities`，不嵌入技能文件 |
| 两级技能渐进披露 | L1 清单常驻，L2/L3 按需加载 |
| 设定记忆不进记忆库 | persona/rules/skills 一律进角色包，不走 `writeUpsert` |

---

## 附录 A：快速接入代码模板

```typescript
// 1. 创建配置
const agent = new Agent({
  projectPath: workspacePath,
  provider: createLlmProvider({
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKey: env.LLM_API_KEY,
  }),
  configDir: path.join(__dirname, 'config'),
  storage: new SqliteMemoryStorage(path.join(dataDir, 'memora.db')),
  sessionStore: new FileSessionStore(path.join(dataDir, 'sessions')),
});

// 2. 初始化
await agent.init();

// 3. 注册工具
agent.tools.registerTool({
  name: 'run_command',
  description: '执行终端命令',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}, async (args) => {
  const { stdout } = await exec(args.command);
  return stdout;
});

// 4. 对话
const chunks = [];
for await (const chunk of agent.chat('你好')) {
  chunks.push(chunk);
  if (chunk.type === 'text') {
    console.log(chunk.content);
  }
}

// 5. 关闭
await agent.close();
```

## 附录 B：宿主包结构推荐

```
host-package/
├── src/
│   ├── memora/
│   │   ├── index.ts              ← Agent 初始化入口
│   │   ├── storage/
│   │   │   ├── SqliteMemoryStorage.ts
│   │   │   └── FileSessionStore.ts
│   │   ├── providers/
│   │   │   └── HostLlmProvider.ts
│   │   ├── tools/
│   │   │   ├── fileTools.ts
│   │   │   ├── terminalTools.ts
│   │   │   └── codeTools.ts
│   │   ├── roles/
│   │   │   └── (目录：role-packs/ 直接嵌入)
│   │   └── bridge/
│   │       └── AgentEventBridge.ts
│   ├── extension.ts              ← VSCode/Trae 扩展入口
│   └── ui/
│       ├── ChatPanel.tsx
│       └── MemoryPanel.tsx
└── package.json
```
