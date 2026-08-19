# Memora · 接入指南 v2.0.4

> 帮助宿主项目开发者快速理解 Memora 的设计理念和接入方法。
>
> **版本**：v2.0.4（最后更新：2026-08-14）
>
> **1.0.0 之前：核心能力演进**（原内部里程碑 v3.0–v3.3，于 npm 0.2.0 前后完成）：
> - **Agent God Object 拆分（原 v3.0）**：记忆查询、规则注入、工具注册等方法迁移到专职 Manager，通过 `agent.<manager>.xxx()` 访问。详见 [API 参考手册](./memora-api-reference.md)。
> - **可观测性与护栏（原 v3.1）**：新增可观测性（ITracer）、内容护栏（Guardrails）、工具错误反思（Reflection）、评估体系（Eval）支持。
> - **关系图谱与画像（原 v3.2）**：新增 WorkProjectionManager 作品投影、AutoConfigRefiner 自进化配置建议。（原 ADR-014 记忆关系图谱 IMemoryRelationStore 与 UserProfile 用户画像已随 v2.0.4 收敛删除，见下方变更。）
> - **npm 正式包与基础工具（原 v3.3）**：内核发布 v0.2.0（npm 正式包），精灵切换至 npm alias 依赖。Phase 1-4 全部核心完成。新增 EmbeddingProvider、安全定时器（safeSetTimeout/safeSetInterval）、Frontmatter 工具、事件系统（TypedEventEmitter）、审计类型（AuditEvent 等）、评估框架（EvalScenario/collectAgentChunks/evaluateResult）。
>
> **v1.0.0 变更**：1.0 正式发布。P0 阻塞修复全量收敛：DEFAULT_CONFIG 由 `config/loader.ts` 常量声明单一真理源（不再维护独立 schema）、IVectorStore 接口提取（JsonVectorStore 内置实现）、AbortSignal 合并工具、Logger 懒初始化（移除模块顶层副作用）、评估框架结构化信号（guardrailBlocked 替代文案匹配）、文档全量对齐（包名 @zooique/memora）。
>
> **v2.0.0 变更**：版本号提升（维护性质，无破坏性 API 变更）。
>
> **v2.0.1 变更**：文档版本号对齐（v1.0.2 → v2.0.1）。无 API 破坏性变更，仅同步文档与版本戳。
>
> **v2.0.2 变更**：万物皆记忆 v2（双轨模型——设定记忆 + 对话记忆）。Persona/Skill 从 SQLite 索引解耦，改为纯文件 + 内存缓存。Skill 匹配改为当轮实时注入。详见 [CHANGELOG](../CHANGELOG.md)。
>
> **v2.0.3 变更**：npm 发布配置修复与质量加固。新增 `publishConfig.access = "public"`、`exports` 增加 `default` 回退条件、`keywords` 扩充至 18 个。无 API 破坏性变更。
>
> **v2.0.4 变更**：移除记忆关系图谱与用户画像层。内核收敛删除 ADR-014 记忆关系图谱（IMemoryRelationStore/InMemoryRelationStore/MemoryRelation 侧车）与用户画像层（UserProfile）。用户画像收敛为 round-summary 的 `type=preference` 召回；关系冲突改用 `supersededBy` 布尔标记（ADR-021）。保留 WorkProjectionManager、AutoConfigRefiner、InsightExtractor、`SOURCELABELS.PROFILE`（存量兼容）。（InsightExtractor 后于 2026-08-14 随洞察层收敛一并移除；AutoConfigRefiner 与 ConfigManager 后随角色包边界收敛移除，角色管理统一走 `agent.rolePack`；`SOURCELABELS.PROFILE` 随画像收敛不再参与运行时治理。）
>
---

## 目录

- [一、核心理念](#一核心理念)
- [二、三重数据存续路径](#二三重数据存续路径)
- [三、最小接入步骤](#三最小接入步骤)
- [四、会话持久化](#四会话持久化)
- [五、API 速查](#五api-速查)
- [六、宿主工具函数](#六宿主工具函数)
- [七、可观测性接入（ITracer）](#七可观测性接入itracer)
- [八、工具错误反思（Reflection）](#八工具错误反思reflection)
- [九、评估体系（Eval）](#九评估体系eval)
- [十、多步骤编排](#十多步骤编排)
- [十一、关键约束](#十一关键约束)

---

## 一、核心理念

**Memora 是一个无法独立运行的智能大脑内核。** 它只有接口，没有"形态"——宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。

**万物皆记忆 v2。** Memora 有两类记忆：**设定记忆**（角色包 persona/rules/skills —— Agent 的骨骼，.md 文件 + 内存缓存，唯一归角色包、确定性注入不经过召回）和**对话记忆**（摘要记忆 round-summary/content —— Agent 的血肉，SQLite + 语义召回，带 `summaryType` 语义标签）。二者边界一刀切：记忆系统不再承载设定、角色包不承载对话（ADR-025）；偏好类信息沉淀为摘要记忆，不设独立"用户画像"记忆层。

**单 Agent 模型。** 所有对话、所有记忆存在同一个数据库中，**切换子项目不会丢失记忆**。

**配置文件是真理源，对话记忆走 SQLite 索引。** 角色包（persona/rules/skills）为纯文件 + 内存缓存，设定记忆唯一归角色包、不进记忆库（ADR-025）；对话记忆（round-summary/content 摘要记忆，带 `summaryType` 标签）走 SQLite + 语义召回。

**内核零越界。** 核心库不调用 `console.*`、不读 `process.stdin`、不管理 API Key、不写用户配置文件。

**Manager 委托模式。** Agent 面类只做编排，领域操作委托给专职 Manager：`agent.rolePack`（角色包）/ `agent.tools`（工具）/ `agent.skills`（技能）/ `agent.memory`（记忆查询+写入）/ `agent.governance`（记忆治理）/ `agent.works`（作品投影）/ `agent.polish`（文本润色）等。

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
│  │  - 8 个 Manager getter（委托模式，含文本润色）      │               │
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
npm install @zooique/memora
```

### 2. 创建 Provider + Agent

```typescript
import { Agent, createLlmProvider, JsonVectorStore, setLogger } from '@zooique/memora';
import type { IMemoryStorage, ILogger, EmbeddingService } from '@zooique/memora';

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

// 可选：全局替换日志实现（不调用则使用内置 console logger；pino 为可选 peer 依赖，动态 import 懒加载）
setLogger(myCustomLogger);

// 可选：向量存储（提供后启用语义搜索召回）
const embeddingService: EmbeddingService = myEmbeddingService;
const vectorStore = new JsonVectorStore('/path/to/vectors.json', embeddingService);

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
import type { AgentEventMap } from '@zooique/memora';

agent.on('memoryAdded', (e) => console.log(`新记忆: ${e.source}:${e.name}`));
agent.on('personaSwitched', (e) => console.log(`角色: ${e.from} → ${e.to}`));
agent.on('decayCompleted', (e) => console.log(`衰减 ${e.decayedCount} 条记忆`));
agent.on('memoryRecalled', (e) => console.log(`想起 ${e.count} 条记忆`));
agent.on('sessionForked', (e) => console.log(`分叉: ${e.from} → ${e.to}，${e.messageCount} 条消息`));

// close() 自动移除所有监听器
```

### 4. 注册领域工具

> 1.0.0：工具注册走 `agent.tools.xxx()`。

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

### 5. 记忆关键词与写入扩展（已移除）

> 写入扩展与记忆关键词（`agent.insight.xxx()`）已于 2026-08-14 随洞察层移除，不再提供。记忆统一以 round-summary 沉淀，经 `agent.memory.writeUpsert()` 等 `writeXxx` 方法写入。

### 6. 查询记忆

> 1.0.0：记忆查询走 `agent.memory.xxx()`。

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

### 7. 管理角色包

> 统一走 `agent.rolePack.xxx`（RolePackManager）。

```typescript
const rp = agent.rolePack;
if (rp) {
  // 列出所有角色包元数据
  const metas = rp.listMeta();

  // 手动切换角色包
  rp.activate('作家');

  // 锁定手动模式（禁止自动匹配）
  rp.setMode('manual');

  // 查询当前状态
  console.log(rp.activeName);    // '作家'
  console.log(rp.currentMode);   // 'manual'
}
```

### 8. 切换项目

```typescript
// switchProject() 自动 rebuild，无需手动调用 rebuildComponents()
const ctx = await agent.switchProject('another-novel');
console.log(`已切换到：${ctx.projectName}`);
```

### 9. 关闭

```typescript
await agent.close(); // 释放项目锁 + 关闭数据库
```

---

## 四、会话持久化（ISessionStore）

Memora 通过 `ISessionStore` 接口支持会话消息的持久化。宿主实现此接口，注入到 Agent。

```typescript
import type { ISessionStore, SessionMessage } from '@zooique/memora';

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
- 分叉后的 round-summary：各自独立（不同分支探索不同方向）

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

## 四.6、会话归档（Archive Session）—— 宿主独立实现

Memora 内核聚焦于“对话与记忆”引擎，不负责管理用户的视觉焦点和会话列表的展示层级。**会话归档（将会话从活跃列表移至历史列表）是一个纯粹的 UI/UX 行为，应由宿主项目独立实现，无需修改 Memora 内核。**

### 设计理念

- **内核职责**：确保对话内容（消息记录、记忆卡片）的持久化和可召回性。会话一旦创建，其内容在生命周期内始终可用。
- **宿主职责**：管理“活跃会话”与“已归档会话”的视图分离，为用户提供整洁的交互界面。

### 实现方案

宿主项目应在自身的数据模型中扩展会话管理功能：

#### 1. 数据库调整

在宿主的会话数据表中增加一个状态字段，例如 `is_archived`（布尔值或枚举），用于区分会话的展示状态。

```sql
-- 示例：宿主数据库表结构
ALTER TABLE sessions ADD COLUMN is_archived BOOLEAN DEFAULT 0;
```

#### 2. 前端交互实现

- **归档按钮**：在会话列表项中提供“归档”操作按钮。点击时，**不调用** Memora Agent 的任何 API，而是调用宿主自身的后端接口（如 `PUT /api/sessions/{id}/archive`）。
- **列表分离**：宿主前端应维护两个视图：
  - **活跃列表**：查询 `is_archived = false` 的会话。
  - **历史列表**：查询 `is_archived = true` 的会话。
- **数据同步**：宿主的后端接口负责更新数据库中的 `is_archived` 字段，并通过 WebSocket 或轮询通知前端刷新列表。

### 流程示例

```typescript
// 宿主前端代码
async function archiveSession(sessionId: string) {
  // 1. 调用宿主后端 API
  const response = await fetch(`/api/sessions/${sessionId}/archive`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' }
  });
  
  if (response.ok) {
    // 2. 从活跃列表移除该会话
    removeSessionFromList(sessionId);
    // 3. 可选：提示用户已归档
    showToast('会话已归档至历史记录');
  }
}

// 宿主后端路由（伪代码）
app.put('/api/sessions/:id/archive', (req, res) => {
  const { id } = req.params;
  // 4. 更新数据库状态
  db.updateSessionStatus(id, { is_archived: true });
  res.json({ success: true });
});
```

### 核心优势

- **解耦**：Memora 内核无需感知“归档”这一视图行为，保持纯粹的业务逻辑。
- **灵活**：宿主可自由扩展“归档”的变体，如“收藏夹”、“置顶”、“多级分类”等，均可在宿主侧独立完成。
- **稳定**：内核代码零风险，记忆召回逻辑完全不受归档行为影响，确保所有对话内容（无论归档与否）都能被准确回忆。

---

## 五、API 速查

> 完整定义见 [memora-api-reference.md](./memora-api-reference.md)。

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
| `vectorStore` | `IVectorStore` | ❌ | 向量存储接口（提供时启用语义搜索；内置实现 `JsonVectorStore`） |
| `recallExcludeSources` | `string[]` | ❌ | 召回时排除的 source 标签（默认 `['persona', 'rule', 'skill']`） |
| `sessionStore` | `ISessionStore` | ❌ | 会话存储注入 |
| `tracer` | `ITracer` | ❌ | 可观测性 Tracer 注入（不传则使用 NoopTracer 静默丢弃所有 span） |
| `messages` | `UIMessages` | ❌ | 宿主可覆盖的 UI 消息文本（默认英文，宿主覆盖为中文等） |
| `enableContextSummary` | `boolean` | ❌ | 上下文超限时是否自动生成摘要（默认 true，开启后首次截断时增加 ~1-2s 延迟） |

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
| `agent.projects.listProjects()` / `agent.projects.list` | 列出已注册的子项目 |
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
| `agent.memory.xxx()` | MemoryInspector | 读：`snapshot()` / `search(q, n)` / `searchHybrid(q, n)` / `stats()` / `list()` / `getById(id)` / `listDeleted()`；写：`writeUpsert()` / `writeDelete()` / `writeRestore()` / `writePurge()` 等（`writeXxx` 前缀）。`suggest()` / `sourceHealth()` 已上移至 `agent.suggest()` / `agent.sourceHealth()` |
| `agent.governance.xxx()` | MemoryGovernance | `deduplicate()` / `evaluateTimeliness()` / `detectConflicts()` / `sourceHealth()` / `suggest()` / `decay()` |
| `agent.tools.xxx()` | ToolExecutor | `registerTool(d, h)` / `getToolDefinitions()` / `execute(n, a)` / `list` |
| `agent.rolePack.xxx` | RolePackManager | `.listMeta()` / `.activeName` / `.currentMode` / `.getActive()` / `.activate(n)` / `.setMode(m)` / `.resetSticky()` |
| `agent.skills.xxx` | SkillManager | `.list` / `.match(i)` / `.register(skill)` / `.buildSystemPrompt()` |
| `agent.works.xxx()` | WorkProjectionManager | `ensureProjection(path, content)` / `getProjection(path)` / `loadAll()` |
| `agent.on()` / `agent.off()` / `agent.once()` | TypedEventEmitter | `memoryAdded` / `personaSwitched` / `decayCompleted` / `memoryRecalled` / `sessionForked` / `conflictDetected` / `projectSwitched` / `skillMatched` / `archiveFailed` |

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
  JsonVectorStore,
  EmbeddingProvider,
  setLogger,
  logger,
  segmentText,
  parseFrontmatter,
  serializeFrontmatter,
  safeSetTimeout,
  safeSetInterval,
  clearSafeTimeout,
  clearSafeInterval,
  recall,
  extractKeywords,
  SOURCE_LABELS,
  inferSource,
  escapeLike,
  validateSource,
  MemoraError,
  toError,
  NOOP_TRACER,
  TRACE_SPANS,
  ToolErrorCode,
  isRetryableErrorCode,
  TypedEventEmitter,
  collectAgentChunks,
  evaluateResult,
} from '@zooique/memora';
import type {
  ProviderConfig,
  Config,
  IMemoryStorage,
  ILogger,
  ISessionStore,
  SessionMessage,
  Memory,
  SourceValidationSeverity,
  LlmProvider,
  LlmChunk,
  ChatOptions,
  AgentChunk,
  ThinkingPhase,
  UIMessages,
  ArchiveMode,
  AgentOptions,
  AgentContext,
  AgentProjectEntry,
  AgentForkResult,
  ToolDefinition,
  ToolHandler,
  ToolContext,
  WriteExtensions,
  MemoryKeywords,
  MemorySnapshot,
  WorkingMemorySnapshot,
  BootstrapSnapshot,
  ArchiveSnapshot,
  AgentSearchHit,
  AgentStats,
  SuggestOptions,
  SuggestHit,
  SourceHealthStatus,
  SourceHealthEntry,
  SourceHealthReport,
  ConfigSuggestion,
  ConfigSuggestionHandler,
  AutoConfigRefinerOptions,
  SessionArchiveResult,
  WorkProjectionEntry,
  PersonaMode,
  Persona,
  SkillEntry,
  SkillMatch,
  RecallOptions,
  EmbeddingService,
  EmbeddingConfig,
  EmbeddingResult,
  AgentEventMap,
  AgentEventName,
  AgentEventHandler,
  ForkResult,
  ITracer,
  ISpan,
  AgentMetrics,
  ToolErrorCodeValue,
  EvalScenario,
  EvalExpectation,
  EvalResult,
  AuditEvent,
  AuditListener,
  Permission,
  WriteDecision,
  WriteConfirmationInfo,
  WriteConfirmationRequest,
  OpenAICompatibleProvider,
  OpenAICompatibleConfig,
} from '@zooique/memora';
```

| 函数/类型 | 用途 |
|-----------|------|
| `createLlmProvider(config)` | 从扁平配置创建 LlmProvider 实例 |
| `createProviderFromConfig(name, config)` | 从命名配置创建 LlmProvider 实例 |
| `loadConfig(path?)` | 加载 memora.json 配置文件 |
| `InMemoryStorage` | IMemoryStorage 的纯内存实现（测试用） |
| `JsonVectorStore` | 向量存储内置实现（实现 IVectorStore 接口，宿主注入 EmbeddingService 后创建，启用语义搜索） |
| `EmbeddingProvider` | OpenAI 兼容 Embedding 端点实现（满足 EmbeddingService 接口） |
| `setLogger(logger)` | 替换全局日志实现 |
| `logger` | 全局日志实例 |
| `segmentText(text)` | 中文分词工具 |
| `parseFrontmatter(text)` | 解析 Markdown frontmatter |
| `serializeFrontmatter(fm, body)` | 序列化 frontmatter + body 为 Markdown |
| `safeSetTimeout(fn, ms)` | 安全定时器（可跟踪清理） |
| `safeSetInterval(fn, ms)` | 安全间隔器（可跟踪清理） |
| `clearSafeTimeout(id)` | 清除安全定时器 |
| `clearSafeInterval(id)` | 清除安全间隔器 |
| `recall(storage, query, options?)` | 记忆召回（async，双通道：语义 + 关键词） |
| `extractKeywords(text)` | 提取关键词 |
| `SOURCE_LABELS` | source 标签常量（PERSONA / RULE / SKILL / PROFILE / WORK_PROJECTION / GUARDRAIL / ROUND_SUMMARY） |
| `inferSource(content)` | 从内容推断 source 标签 |
| `escapeLike(query)` | 转义 SQLite LIKE 通配符 |
| `validateSource(source)` | 校验 source 标签是否为已知标签（返回 warning，不阻止写入） |
| `MemoraError` | 统一错误类型（结构化错误码 + 上下文） |
| `toError(err)` | 将任意值转为 Error（浏览器端安全，不引入 pino） |
| `NOOP_TRACER` | ITracer 的空实现（静默丢弃所有 span，零开销） |
| `TRACE_SPANS` | AgentLoop 预定义 Span 名称常量（RECALL / LLM_CALL / TOOL_EXEC / RESPONSE） |
| `ToolErrorCode` | 工具错误码枚举（10 种，含 PATH_NOT_ALLOWED / FILE_NOT_FOUND 等） |
| `isRetryableErrorCode(code)` | 判断错误码是否可重试（5 种 retryable） |
| `TypedEventEmitter` | 类型安全的事件发射器（Agent 继承此类） |
| `collectAgentChunks(gen)` | 从 AgentChunk 流收集行为数据（Mock Eval 用） |
| `evaluateResult(name, collected, expected)` | 比对期望与结果（Mock Eval 用） |

**注意**：`SqliteStorage` 已移出到宿主项目，不再从 memora 导出。宿主需自行实现 `IMemoryStorage` 接口。

`IMemoryStorage` 接口要求实现 `count()` 和 `countBySource(source)` 方法，用于高效统计记忆数量（避免全量加载数据）。详见 [API 参考手册](./memora-api-reference.md)。

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
import type { ITracer, ISpan } from '@zooique/memora';

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

## 八、工具错误反思（Reflection）

> 注：原「内容护栏（Guardrails）」章节已移除——guardrail 是「零规则、无扫描映射、无消费者」的空转链，已随内核摘除（2026-08-17，见 memory-role-pack-boundary.md §4.4）。

当工具执行失败时，错误结果包含 `[ERR:TOOL:code]` 前缀。如果错误码标记为 retryable（如 `FILE_NOT_FOUND`、`ARGUMENT_ERROR`），AgentLoop 会自动注入 `[REFLECTION_HINT]` 系统消息，引导 LLM 修正参数后重试。

```typescript
import { ToolErrorCode, isRetryableErrorCode } from '@zooique/memora';

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
import type { EvalScenario, EvalExpectation, EvalResult } from '@zooique/memora';
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
import { collectAgentChunks, evaluateResult } from '@zooique/memora';

// 从 AgentChunk 流中收集行为数据
const collected = await collectAgentChunks(agent.chat('帮我看看第一章'));

// 比对期望
const result = evaluateResult(scenario.name, collected, scenario.expect);
console.log(result.passed ? '✅ 通过' : `❌ 失败: ${result.failures.join('; ')}`);
```

### 两种评估层次

| 层次 | 工具 | LLM 调用 | 用途 |
|------|------|---------|------|
| Mock Eval | `collectAgentChunks` + `evaluateResult` | 不调用（MSW Mock） | 行为回归（工具调用、召回） |
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
3. **项目级 `.memora/`** 只放 `rules/`、`skills/`
4. **角色由关键词自动触发**
5. **对话历史跨子项目持久化**
6. **Manager 访问器在 `init()` 前返回 `null`** — 所有 `agent.rolePack.xxx()` / `agent.memory.xxx()` 等调用必须在 `init()` 之后
7. **作品原始内容不进 SQLite**，Agent 通过工具按需读取
8. **配置文件是真理源**，`<configDir>/role-packs/` 下的角色包由 RolePackManager 启动时扫描加载
9. **禁止**为每个子项目创建独立的 memora.db
10. **禁止**项目切换时关闭/重建数据库
11. **禁止**将配置直接写入 SQLite 作为持久化存储
12. **项目切换** `switchProject()` 已自动 rebuild，通常无需手动调用 `rebuildComponents()`
13. **Tracer 未注入时**自动降级为 NoopTracer，零运行时开销

---

> 更多细节参见 [memora-api-reference.md](./memora-api-reference.md)（完整 API 参考）
