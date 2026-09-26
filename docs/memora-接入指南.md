# Memora · 接入指南 v3.0.0

> 帮助宿主项目开发者快速理解 Memora 的设计理念和接入方法。
>
> **当前稳定版**：v3.0.0。各版完整变更见 [CHANGELOG](../CHANGELOG.md)。
>
> **对接入者有影响的迁移结论**（不含历史流水，细节见 [API 参考手册](./memora-api-reference.md)）：
> - 1.0 为正式发布，API 已稳定；2.0 起设定记忆（persona/rules/skills）解耦为纯文件 + 内存缓存，唯一归角色包、不进记忆库（ADR-025），角色管理统一走 `agent.rolePack`。
> - 已移除：`SqliteStorage`（移出内核，由宿主实现 `IMemoryStorage`）、洞察层（`insight.*`）、AutoConfigRefiner / ConfigManager、记忆关系图谱与用户画像层（偏好收敛为 round-summary，冲突改用 `supersededBy` 布尔标记）。
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
- [九、多步骤编排](#九多步骤编排)
- [十、关键约束](#十关键约束)
- [十一、用户档案实现指南（宿主扩展）](#十一用户档案实现指南宿主扩展)

---

## 一、核心理念

**Memora 是一个无法独立运行的智能大脑内核。** 它只有接口，没有"形态"——宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。

**摘要即记忆（memory-as-summary）。** Memora 的记忆只有单一轨道——**对话记忆**（round-summary 摘要，宿主持久化 + **纯关键词召回**，带 `summaryType` 语义标签）；**设定**（角色包 persona/rules/skills）是 Agent 的骨骼，.md 文件 + 内存缓存，唯一归角色包、确定性注入不经过召回，不属记忆库（ADR-025）。二者边界一刀切：记忆系统只承载对话摘要、角色包承载设定；偏好类信息沉淀为摘要记忆，不设独立"用户画像"记忆层。

**单 Agent 模型。** 一个 Agent 实例的对话与记忆由**同一组存储实例**承载（`storage` / `sessionStore` 均在构造时注入、实例级），**`switchProject()` 切换项目时复用同一实例，不重建、不丢记忆**。要按工作区彼此隔离，就各自 `new Agent`——隔离粒度由宿主决定，内核不规定。

**配置文件是真理源，对话记忆由宿主持久化。** 角色包（persona/rules/skills）为纯文件 + 内存缓存，设定记忆唯一归角色包、不进记忆库（ADR-025）；对话记忆（round-summary 摘要记忆，带 `summaryType` 标签）经宿主注入的 `IMemoryStorage` 持久化——**后端由宿主自选**（SQLite / JSON 文件 / 内存皆可），检索为 **纯关键词召回**（向量语义通道已随 2026-09-18 B0 收编移除，见 [API 参考手册](./memora-api-reference.md) §〇.5 构造参数表）。

**内核零越界。** 核心库模块不直接调用 `console.*`（唯一日志出口为 `logging/` 单例，默认实现写 stderr）、不读 `process.stdin`、不管理 API Key、不写用户配置文件。

**Manager 委托模式。** Agent 面类只做编排，领域操作委托给专职 Manager：`agent.rolePack`（角色包）/ `agent.tools`（工具）/ `agent.skills`（技能）/ `agent.memory`（记忆查询+写入）/ `agent.governance`（记忆治理）/ `agent.works`（作品投影）/ `agent.polish`（文本润色）共 7 个业务 Manager（另有 `projects` / `security` / `sessionManager` 等）。

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
│  │  - 7 个业务 Manager getter（rolePack/tools/skills/memory/governance/works/polish，委托模式）      │               │
│  │  ⚠️ 不包含：UI / LLM 配置 / 用户配置模板 │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

---

## 二、三重数据存续路径

| 路径 | 用途 | 示例 |
|------|------|------|
| `AgentOptions.configDir` | 配置根目录（role-packs / skills） | 嵌入宿主程序 |
| `AgentOptions.dataDir` | 记忆数据目录（**必填**；记忆库形态由宿主的 `storage` 实现决定） | 宿主自定 |
| `projectPath/.memora/` | 项目级配置（rules/skills）+ 项目锁文件 `.lock` | 跟作品走 |

**小说生成器推荐布局：**
```
小说项目/
├── .memora/           ← 项目级配置（rules + skills）+ 内核写入的 .lock
└── .memora-data/      ← dataDir 指向此处（记住：内核只往这里写 projects.json 注册表）
    ├── projects.json  ← 内核写入：项目注册表
    └── <记忆库>        ← 由宿主的 storage 决定形态与文件名
```

---

## 三、最小接入步骤

### 1. 安装

```bash
npm install @zooique/memora
```

### 2. 创建 Provider + Agent

```typescript
import { Agent, createProviderFromConfig, setLogger } from '@zooique/memora';
import type { IMemoryStorage, ILogger } from '@zooique/memora';

// 宿主职责：创建 LLM Provider（Agent 不关心 API Key）
// createProviderFromConfig 是"单个 provider"入口；多 provider + active 随 loadConfig 路由见 api-reference §十 Provider 管理
const provider = createProviderFromConfig('primary', {
  provider: 'openaiCompatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'deepseek-chat',
});

// 可选：后台 Provider（投影等后台操作）
const backgroundProvider = createProviderFromConfig('background', {
  provider: 'openaiCompatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'deepseek-chat', // 可用更便宜的模型
});

// 可选：注入存储层（不传则使用 InMemoryStorage）。后端由宿主自选，二选一即可：
const storage: IMemoryStorage = new MySqliteStorage('/path/to/memora.db'); // SQLite（同步实现天然对齐）
// const storage: IMemoryStorage = new MyJsonStorage('/path/to/memories.json'); // JSON 文件（第一宿主 memora-vscode 的选法）

// 可选：全局替换日志实现（不调用则使用内核内置 console fallback，写 stderr；宿主可注入任意 ILogger 实现）
setLogger(myCustomLogger);

// 创建 Agent
const agent = new Agent({
  projectPath: '/path/to/novel-project',
  provider,              // 前台 Provider（必须）
  backgroundProvider,    // 后台 Provider（可选）
  configDir: '/path/to/agent-config',
  dataDir: '/path/to/novel-project/.memora-data',  // 必填；相对路径会以进程 cwd 为基准，建议传绝对路径
  maxContextTokens: 120000,
  activeRolePack: '作家',
  permission: 'owner',
  allowedPaths: ['.'],
  confirmWrites: false,
  storage,               // 存储层注入（可选）
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

Agent 向宿主广播对话外事件（记忆变更、角色切换、会话分叉等）。

```typescript
import type { AgentEventMap } from '@zooique/memora';

agent.on('memoryAdded', (e) => console.log(`新记忆: ${e.source}:${e.name}`));
agent.on('personaSwitched', (e) => console.log(`角色: ${e.from} → ${e.to}`));
agent.on('memoryRecalled', (e) => console.log(`想起 ${e.count} 条记忆`));
agent.on('sessionForked', (e) => console.log(`分叉: ${e.from} → ${e.to}，${e.roundCount} 个问答闭环`));

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

### 4.5 外部世界工具注入（可选，条件性暴露）

> 三个「连接外部世界」的条件工具——`web_search` / `web_fetch` / `run_code`——**宿主注入对应 provider 才暴露，未注入则不进入 LLM 工具面**，内核保持零运行时依赖。各工具的用途、参数与单工具注入方式见 [API 参考手册](./memora-api-reference.md) §8；此处演示三者**一起**注入的组合写法。

```typescript
import { Agent, FetchWebFetchProvider } from '@zooique/memora';
import type { ICodeExecutionProvider } from '@zooique/memora';

// ① 网页抓取（搜索→抓取闭环：web_search 找链接，web_fetch 读正文）
const fetchProvider = new FetchWebFetchProvider(); // 内置零依赖默认实现

// ② 代码执行（沙箱完全由宿主提供——语言白名单/资源限制/网络隔离）
const codeExecutionProvider: ICodeExecutionProvider = {
  async execute(code, language, options) {
    // 例：经宿主沙箱执行，返回 stdout/stderr/exitCode/timedOut
    return { stdout: '42', stderr: '', exitCode: 0, timedOut: false };
  },
};

const agent = new Agent({
  projectPath: '/path/to/novel-project',
  dataDir: '/path/to/novel-project/.memora-data',  // 必填
  provider,
  // webSearchProvider: new FetchWebSearchProvider(),  // 搜索（web_search，参见参考手册 §8.3）
  fetchProvider,            // 可选：暴露 web_fetch
  codeExecutionProvider,    // 可选：暴露 run_code
});
```

> **注意**：`run_code` 是通用执行能力（源码不进上下文，仅结果返回），执行隔离等级完全由宿主 provider 决定；接入前务必评估沙箱安全边界（参见参考手册 §8.5）。

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
hits.forEach(h => console.log(`${h.source}:${h.name}`));

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

  // 查询当前状态
  console.log(rp.activeName);    // '作家'
  console.log(rp.getActiveTraits());
}
```

### 8. 切换项目

```typescript
// 按路径切换（最稳）：传项目根目录的绝对路径，无需预先注册
const ctx = await agent.switchProject('/path/to/another-novel');
console.log(`已切换到：${ctx.projectName}`);

// 按名切换：依赖项目注册表命中，须先注册
// 注册表缺省落在 dataDir 内 —— 只有多项目共用同一 dataDir（或显式指定共同的 registryDir）时，
// 按名切换才成立；若 dataDir 是项目级目录，注册表会随之落进各项目、只含自身条目，按名切换不成立。
agent.projects.registerProject('/path/to/another-novel', 'another-novel');
const ctx2 = await agent.switchProject('another-novel');
```

> 未命中注册表且传入的又不是绝对路径时，`switchProject` 直接抛错（相对路径会以进程 cwd 为基准，
> 可能静默创建出非预期的项目目录并占用其锁）。

### 9. 关闭

```typescript
await agent.close(); // 释放项目锁 + 关闭注入的存储实例
```

---

## 四、会话持久化（ISessionStore）

Memora 通过 `ISessionStore` 接口支持会话消息的持久化。宿主实现此接口，注入到 Agent。

> **⚠ 现行契约以类型定义为准（导出类型 `ISessionStore`，以随包 `.d.ts` 为准）**：下方示例仅示意最小形态。当前接口为 **round-based 单一模式**（`appendRoundId` / `getRoundIds` / `setRoundIds` / `createSession` / `deleteSession` + 标题元数据 `getSessionMeta` / `updateSessionMeta` / `listSessionMetas`）——消息内容只存 RoundStore，`ISessionStore` 只持 Round 指针。
> **检查点持久化已退役（2026-09-10 减法）**：`saveCheckpoint` / `loadCheckpoint` / `deleteCheckpoint` 已从接口删除；跨重启恢复链整体下线，中止/断电一律把未完成 turn 补全为完整 turn 身份并在下次会话按历史加载，运行时暂停是同 turn 内续跑（内存态）。

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

Memora 支持从任意问答闭环（Round）位置创建会话分叉。分叉后，新会话只包含分叉点及之前的问答闭环，后续的问答闭环在原会话中保持不变。

**使用场景**：
- 用户在对话中决定从某个关键点分叉探索不同方向
- 每个分支只继承到分叉点为止的上下文，避免无关历史干扰
- 分支完全独立，互不干扰

```typescript
// 从指定 Round 位置分叉（唯一分叉方式，roundId 可选）
const result = agent.forkSession(roundId);
console.log(`已分叉到: ${result.newSession}，复制了 ${result.roundCount} 个问答闭环`);

// 不传 roundId → 默认使用最后一个 Round（等效全量分叉）
const fullResult = agent.forkSession();

// 自定义分支名
const result2 = agent.forkSession(roundId, 'experiment');
```

**命名规则**：
- 自动生成：平等普通会话名（与手动创建的会话一致，无 `main-b1` 等分叉标记）
- 自定义名称：直接传入目标名称作为第二参数

**记忆处理策略**：
- 已有记忆：全局共享（记忆是全局知识库，不属于单个会话）
- 分叉后的 round-summary：各自独立（不同分支探索不同方向）

**事件监听**：
```typescript
agent.on('sessionForked', (event) => {
  console.log(`从 ${event.from} 分叉到 ${event.to}`);
  console.log(`复制了 ${event.roundCount} 个问答闭环`);
});
```

**边界情况**：
- 当前会话无问答闭环时抛出错误
- 传入的 `roundId` 不存在于当前会话时抛出错误
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

> 构造选项、生命周期、对话、项目/会话、各 Manager、事件、Provider 管理等**完整条目与类型定义**详见 [memora-api-reference.md](./memora-api-reference.md)。此处只列接入期最常用的几个入口：

| 操作 | 入口 | 详见参考手册 |
|------|------|------|
| 构造 | `new Agent({ projectPath, provider, configDir, dataDir })` | §二 · AgentOptions |
| 对话 | `agent.chat(input)`（流式）/ `agent.chatSync(input)` | §三 |
| 记忆 | `agent.memory.snapshot()/search()/writeXxx()` | §四 |
| 角色包 | `agent.rolePack.listMeta()/activate()` | §七 |
| 工具 | `agent.tools.registerTool()/execute()` | §八 |
| 会话 | `agent.forkSession()` / `agent.sessionManager.*` | §六 |

> 记忆治理（去重/冲突）统一走 `agent.governance` 或 Agent 层方法，见参考手册 §四 与「记忆治理」章节。

---

## 六、宿主工具函数

> 所有可导入工具函数/类型的**完整 import 清单与导出声明**见 [memora-api-reference.md](./memora-api-reference.md) §十六。下表列出常用函数与其用途：

| 函数/类型 | 用途 |
|-----------|------|
| `createLlmProvider(config)` | 从完整 Config（`llm.providers` + `active`）创建激活 Provider（配合 `loadConfig`） |
| `createProviderFromConfig(name, config)` | 从命名配置创建单个 Provider 实例（扁平参数） |
| `loadConfig(path?)` | 加载 `.memora/config.json` 项目级配置文件（或传入显式 configPath） |
| `InMemoryStorage` | IMemoryStorage 的纯内存实现（测试用） |
| `setLogger(logger)` | 替换全局日志实现 |
| `logger` | 全局日志实例 |
| `segmentText(text)` | 中文分词工具 |
| `parseFrontmatter(text)` | 解析 Markdown frontmatter |
| `serializeFrontmatter(fm, body)` | 序列化 frontmatter + body 为 Markdown |
| `safeSetTimeout(fn, ms)` | 安全定时器（可跟踪清理） |
| `safeSetInterval(fn, ms)` | 安全间隔器（可跟踪清理） |
| `clearSafeTimeout(id)` | 清除安全定时器 |
| `clearSafeInterval(id)` | 清除安全间隔器 |
| `extractKeywords(text)` | 提取关键词 |
| `SOURCE_LABELS` | source 标签常量（PERSONA / RULE / SKILL / WORK_PROJECTION / ROUND_SUMMARY / UNKNOWN） |
| `escapeLike(query)` | 转义 SQLite LIKE 通配符（`%` / `_` → `\%` / `\_`）。**SQL 必须写成 `LIKE ? ESCAPE '\'`**——不写 ESCAPE 子句则反斜杠被视为普通字符，转义后的模式匹配不到任何字面值，查询**静默返回空** |
| `escapeLikeSnippet(text, maxLen?)` | 截断至 maxLen（默认 50）后转义 LIKE 通配符——搜索输入防超长解析 + 防通配符被当模式符（SQL 后端检索的配套动作，同样须配 `ESCAPE '\'`） |
| `validateSource(source)` | 校验 source 标签是否为已知标签（返回 warning，不阻止写入） |
| `MemoraError` | 统一错误类型（结构化错误码 + 上下文） |
| `toError(err)` | 将任意值转为 Error（浏览器端安全，不引入 `logging/` 模块） |
| `NOOP_TRACER` | ITracer 的空实现（静默丢弃所有 span，零开销） |
| `TRACE_SPANS` | AgentLoop 预定义 Span 名称常量（RECALL / LLM_CALL / TOOL_EXEC / RESPONSE） |
| `ToolErrorCode` | 工具错误码枚举（10 种，含 PATH_NOT_ALLOWED / FILE_NOT_FOUND 等） |
| `isRetryableErrorCode(code)` | 判断错误码是否可重试（5 种 retryable） |
| `TypedEventEmitter` | 类型安全的事件发射器（Agent 继承此类） |

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
| `llm.call` | `TRACE_SPANS.LLM_CALL` | LLM API 调用（含重试循环） | `model`, `messageCount`, `iteration`，另写 `inputTokens` |
| `tool.execute` | `TRACE_SPANS.TOOL_EXEC` | 工具执行（并发时多个 span 时间重叠） | `toolName`，另写 `args`（被拒时 `denied`） |
| `response.generate` | `TRACE_SPANS.RESPONSE` | 整轮响应 | `inputLength`（任务级指标随流结束统一补写） |
| `context.summary` | `TRACE_SPANS.CONTEXT_SUMMARY` | 消息超 `maxContextTokens` 触发截断、生成"遗忘补偿"摘要 | `messageCount`, `summarizingMessages` |
| `archive.postProcess` | `TRACE_SPANS.POST_PROCESS` | 每轮 `chat()` 后归档（round-summary、角色/技能匹配） | `archiveMode` |
| `round.difficulty` | `TRACE_SPANS.DIFFICULTY` | **预留名，内核当前零 emit 点** | — |
| `round.report` | `TRACE_SPANS.REPORT` | **预留名，内核当前零 emit 点** | — |

> 共 **7** 个常量。`TRACE_SPANS.RECALL` / `TRACE_SPANS.RECALL_ACTUAL`（`recall.recall` / `recall.actual`）已于 **2026-09-11 物理删除**（自动记忆召回退役后无 emit 点）——宿主无需为其编写 span 处理逻辑；记忆检索耗时看 `tool.execute`（`search_memories` 工具）。

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

## 九、多步骤编排

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
- 如需隔离上下文，使用 `agent.sessionManager.switchSession()` 或 `agent.forkSession()`

---

## 十、关键约束

**前提：存储方案由宿主自选，内核只定契约。** 内核只定义 `IMemoryStorage` / `ISessionStore` 接口，**不规定后端**——SQLite（better-sqlite3）、JSON 文件、内存实现一视同仁，任何后端都不得被写进内核逻辑。接口方法为**同步语义**（对齐 better-sqlite3），异步后端需另行扩展接口；JSON 落地实现在同步路径上做全量重写，记忆量增长时由宿主自行评估更优后端（阈值与权衡见 `storageInterface.ts` 头注释）。第一宿主 memora-vscode 当前用 JSON 文件，换成 SQLite **不需要改内核**。

1. **`provider` 是必填项** — Agent 无法独立运行
2. **configDir** 指向 Agent 级配置目录，所有项目共享
3. **项目级 `.memora/`** 放项目级配置（`rules/`、`skills/`）与内核写入的项目锁 `.lock`；`dataDir` 若指向此处（第一宿主 memora-vscode 即如此），记忆库与会话也落在这里
4. **角色包只能手动切换**（`agent.switchRolePack(name)` / `agent.rolePack.activate(name)`）——无输入自动匹配、无粘性锁存、无互斥触发；已激活的角色包在当前会话内保持固定（v0.13 已移除自动匹配全链）
5. **对话历史随 Agent 持久化** — `sessionStore` 是实例级注入的，`switchProject()` 不换存储；未注入则仅内存保存
6. **Manager 访问器在 `init()` 前返回 `null`** — 所有 `agent.rolePack.xxx()` / `agent.memory.xxx()` 等调用必须在 `init()` 之后
7. **作品原始内容不进记忆库**，Agent 通过工具按需读取（大文本走 `read_file` 分段，提炼后只留情报，不全量入库 / 入上下文）
8. **配置文件是真理源**，`<configDir>/role-packs/` 下的角色包由 RolePackManager 启动时扫描加载
9. **一个 Agent = 一份记忆库** — `storage` 与 `dataDir` 都是 **Agent 实例级**的：`switchProject()` 复用同一实例，不按项目 / 子项目分裂。**要按工作区彼此隔离，就各自 `new Agent`**——隔离粒度归宿主决定，内核不规定
10. **项目切换不重建、不关闭存储** — `switchProject()` 复用已注入的实例，只在 `close()` 时关闭（`ProjectManager` 在 Agent 生命周期内缓存）
11. **禁止把配置放进记忆库** — 配置（角色包 / persona / rules / skills）的真理源是文件（`configDir` / 角色包），设定记忆归角色包内容层、不进记忆库（ADR-025 / `memory-role-pack-boundary`）
12. **项目切换** `switchProject()` 已自动 rebuild，通常无需手动调用 `rebuildComponents()`
13. **Tracer 未注入时**自动降级为 NoopTracer，零运行时开销

---

## 十.5、执行前检查决策（preExecutionCheck）⚠️ 安全基线

`preExecutionCheck` 是工具执行前的统一闸门（内核 `ToolExecutor` 单点聚合检查：只读 → 审批 → 执行三态）。宿主经 `AgentOptions.preExecutionCheck` 注入，返回 `allow` / `skip` / `confirm` 三态。

### 单用户桌面场景（可恒放行）

本地运行的单用户宿主（VS Code 插件 / 桌面应用）可注入恒放行：

```ts
preExecutionCheck: () => ({ skip: false }),  // 放行，等价于 allow
```

**理由**（宿主装配注入点见仓库内参考实现 `hosts/memora-vscode/src/extension/host/assemble.ts`，**非随包产物**）：
1. 宿主运行在用户本地，天然信任模型；
2. 工具审计已由 `tool_start` / `tool_result` chunk + `tool.execute` span 承担，不重复记录。

### 多用户 / 服务端部署（必须替换）⚠️

**恒放行仅限单用户本地场景。** 一旦接入多用户或服务端部署，必须替换为真实审批策略，否则任意用户可经工具读写任意文件 / 执行任意命令。最小实现要点：

- **审批在宿主侧实现**：内核 3.0.0 已删内核审批键（`toolApproval`，理由见下 §十.7 补记），多用户场景须由宿主在 `preExecutionCheck` 实现真实审批（返回 `denied` 拒绝），高危操作（写文件 / 执行命令）默认拒绝而非放行；
- **路径守卫**：结合内核 `SecurityGuard` 的 `allowedPaths` 白名单 + 28 类禁止规则做硬性拦截，返回 `skip` 阻断越权调用；
- **只读策略**：角色包 `toolReadonly: 'readonly'` 时，preExecutionCheck 须拒绝一切写操作。

> 本决策同时受 `tasks/待完成任务.md` 设计纪律 **D5** 约束：恒放行属单用户场景可接受，但必须显式标注，未来多用户/服务端再接入真实策略。

---

## 十.6、存储单例约束（sessionStore / roundStore）⚠️ 契约基线

`sessionStore`（会话元数据）与 `roundStore`（问答闭环 / round 落盘）**必须全局唯一单例，且 UI 面板与 Agent 装配共享同一实例**。

### 为什么是硬约束（双实例覆盖写）

会话与 round 落盘的最终载体是同一份磁盘文件（`*.memora/sessions.json` + 各 round 文件）。若 UI 面板与 Agent 各自 `new` 一份 store：

- 两侧各自 `load()` 后内存状态分叉；
- 任一侧 `save()` 都只写自己内存视角，**后写覆盖先写** → 另一侧已追加的会话 / 消息丢失；
- 典型症状：重启后"会话记录加载不全"、跨面板操作互相吞掉对方写入。

这是数据正确性 bug，**不是性能或风格问题**，任何宿主对接都会踩。

### 规范模式（VS Code 宿主实证）

在 `activate()` 中创建一次，注入两侧（见仓库内参考实现 `hosts/memora-vscode/src/extension/extension.ts`，**非随包产物**：`activate()` 内 `new WorkspaceRoundStore(...)` 与 `new WorkspaceSessionStore(workspacePath, roundStore)` 各建一次；面板侧经 `new MemoraChatViewProvider(..., sessionStore, ...)` 与 `settingsProvider.setAgentFactory(...)`，Agent 侧经 `getOrCreateAgent(..., sessionStore, roundStore, ...)` → `assembleAgent(...)`）：

```ts
// 单例：activate 中创建一次
const sessionStore = new WorkspaceSessionStore(workspacePath, roundStore);
sessionStore.load();

// 注入 UI 面板：面板经 setAgentFactory 复用同一 agentPromise → 同一份 store
chatProvider.setAgentFactory((projectPath) =>
  getOrCreateAgent(projectPath, providerStore, sessionStore, roundStore, /* ... */));

// 注入 Agent 装配：assembleAgent 透传同一 sessionStore / roundStore 进内核
```

`sessionStore` 经 `getOrCreateAgent` → `assembleAgent` 透传进内核；UI 面板经 `chatProvider.setAgentFactory` 复用同一 `agentPromise`，从而共用同一份 store。**两侧的 store 引用必须指向同一对象**，禁止各建各的。

### 单例 / 原子写各防什么（边界辨析）

- **单例**防**同进程内**两个代码路径各 `new` 一份 store → 内存分叉 → 互相覆盖写。VS Code 单宿主下，单例已彻底封死这条路。
- **原子写**（`atomicWriteFileSync`：先写 `.tmp` 再 `renameSync`）防**写一半进程崩了**导致文件损坏——落盘要么旧内容、要么完整新内容，不会半截。memora 已实现，且**内核与宿主各有一份**：内核 `src/utils/atomicWrite.ts` 的 `atomicWriteFile`（异步，当前生产消费者为 `WorkProjectionManager`）；宿主 `hosts/memora-vscode/src/extension/host/atomicWriteSync.ts` 的 `atomicWriteFileSync`（同步，供 `WorkspaceSessionStore` / `WorkspaceRoundStore` / `WorkspaceStorage` 等宿主存储消费，**非随包产物**）。
- **两者都不防"跨进程双开"**：同工作区开两个窗口 / 两个宿主进程 = 两个 `sessionStore` 单例 = 两个进程各原子写同一 `*.memora/sessions.json`。原子写保"不损坏"但不保"不丢更新"（后 rename 覆盖先 rename）。此场景须靠**进程锁 / 单实例守卫**兜底（参考 grida 对 `sessions.db` 加进程锁、重复启动直接拒绝）。

### 新宿主接入检查清单

- [ ] `sessionStore` / `roundStore` 在宿主生命周期内只 `new` 一次；
- [ ] UI 面板（对话视图 / 会话树 / 设置）与 Agent 装配引用**同一个** store 实例；
- [ ] 落盘走**原子写**（`tmp` + `rename`），禁止裸 `writeFile` 覆盖（防崩溃损坏）；
- [ ] **跨进程 / 多窗口宿主须加文件锁或单实例守卫**：单例只防同进程双实例，不防同工作区双开各自写同一 `sessions.json`；原子写保证不损坏但不保证不丢更新，须进程锁兜底；
- [ ] 测试覆盖：模拟"面板先写、Agent 后写"或反之，断言最终落盘含两侧写入（防回归双实例覆盖写）。

> 本约束原仅存于宿主实现注释（`extension.ts` 的"杜绝双实例覆盖写"；仓库内参考实现，**非随包产物**），现提升为宿主接入契约基线，避免新宿主对接踩坑。原子写实锤已具备（`atomicWriteFileSync`），单例 + 原子写已对齐主流硬化做法（grida / Chatbox 同款 tmp+rename）；唯一真实残留为跨进程锁，已列入检查清单第 4 项。

## 十.7、策略键消费矩阵（16 键 SSOT 落点）📌 参考

> 逐键矩阵（16 键 × 内核消费位置 × UI 侧消费）为仓库内开发文档（SSOT：`src/role-pack/strategyKeys.ts`），**不随包发布**；宿主对接所需的键语义见 [role-pack-authoring-guide.md](./architecture/role-pack-authoring-guide.md) §三。此处只给新宿主对接必知的结论与边界。

- **16 键全部被内核真实消费、零 `[草案]`**（prepare 1 / act 7 / reflect 3 / global 5）。解析层 `rolePackManager` + `strategyResolver` 84 项测试守护，消费层跨 `contextPreparer` / `loop` / `agent` / `managers/llmCaller` / `toolRunner` / `orchestrator` / `prepare` 多文件覆盖。
- **三类流向，单一收口无镜像**：
  1. act 5 键（`toolMode`/`toolStepLimit`/`providerRouting`/`multiStepReasoning`/`toolReadonly`）+ `selfReview` + global 4 键（`errorHandling`/`contextLimit`/`stepBudget`/`askLimit`），统一经 `resolveL2Strategy()` 聚合注入 `L2RuntimeStrategy`，loop 经 `this.strategy.<field>` 读取；`act.temperature`/`outputLimit` 由 `agent.ts` 直映射 `ChatOptions`（不经聚合）；
  2. prepare 键经 `resolveActiveStrategy()` 单一真理源流入 `contextPreparer` / `roundSummaryGenerator`；
  3. persona 指令类（`userFollowup`/`askOn`/`askLimit`）由 `assembleRolePack()` 单收口注入。
- **⚠️ 边界纠正：`toolReadonly` 内核已执行，非「无宿主执行方」**。`toolRunner.ts` 只剩两层闸：闸①（只读闸 `toolReadonly==='readonly'`）**由内核执行**；闸③（宿主 `preExecutionCheck` 注入点）当前 VS Code 宿主恒放行（`assemble.ts` 恒返回 `() => ({ skip: false })`）只是单用户信任模型下的显式让行（关联 十.5 / 设计纪律 D5），未来多用户/服务端须替换真实审批。原闸② `toolApproval` 审批链已随 3.0.0 删键（2026-09-11，故代码注释 ①/③ 编号保留）：单用户本地无真实审批场景，原"通知宿主 + UI 需审批 chip"是展示性假承诺——整键删除，新宿主切勿再期待 `onToolApproval` 回调或 `toolApproval==='confirm'` 语义，审批须自行在 `preExecutionCheck` 实现。
- **UI 侧 6 键有呈现**：宿主角色列表视图渲染策略 chip 5 键（`toolReadonly` / `summaryFocus` / `outputLimit` / `temperature` / `multiStepReasoning`）+ `toolMode` 经对话视图 capability badge 渲染（'纯 LLM' / '全部工具'）。能力名映射与策略键无关，**勿混淆**。（上述 UI 实现均为仓库内宿主参考实现，**非随包产物**。）

---

## 十一、用户档案实现指南（宿主扩展）

> **为什么内核没有独立的用户档案模块？**

### 设计哲学：偏好涌现 vs 配置驱动

Memora 的记忆系统通过 `round-summary` 的 `type=preference` 类型承载"偏好涌现"的核心需求。用户在对话中的偏好（如"喜欢简洁回答"、"偏好中文沟通"）会自然沉淀为摘要记忆，并在后续对话中随召回注入上下文。

这种"涌现驱动"的设计与传统"配置驱动"的用户档案方案有本质区别：

| 维度 | WorkBuddy 类方案（配置驱动） | Memora 方案（涌现驱动） |
|------|---------------------------|----------------------|
| 更新方式 | 手动编辑档案文档 | 对话自然沉淀 |
| 结构化程度 | 强（schema 约束） | 弱（LLM 理解） |
| 内核侵入性 | 高（需新模块） | 低（复用现有机制） |

**Memora 选择"涌现驱动"的核心理由**：
1. **单一真理源**：偏好从对话中涌现，而非外部注入，避免双写冲突
2. **自然生长**：不预埋用户画像结构，符合"种子决定长势、土壤决定养分"哲学
3. **零新增模块**：复用现有记忆/召回机制

### 宿主实现方案

如果宿主确实需要"预配置用户身份"的场景（如"我叫张三、后端工程师、偏好 Go 语言"），可以通过以下两种方式扩展，**内核零改动**。

#### 方案一：工具注册（LLM 按需查询）

适合场景：用户身份信息在对话中被 LLM 按需查询。

```typescript
// 宿主实现用户档案读取逻辑
async function loadUserProfile(): Promise<Record<string, unknown>> {
  // 从文件、数据库或环境变量读取
  return {
    name: '张三',
    role: '后端工程师',
    preferredLanguage: 'zh-CN',
    codingLanguage: 'Go',
    // ...其他用户信息
  };
}

// 注册为工具，LLM 需要时主动调用
agent.tools.registerTool(
  {
    name: 'read_user_profile',
    description: '读取当前用户的档案信息（姓名、角色、偏好等）',
    parameters: {
      type: 'object',
      properties: {}, // 无参数
    },
  },
  async () => {
    const profile = await loadUserProfile();
    return `用户档案：姓名=${profile.name}，角色=${profile.role}，偏好语言=${profile.preferredLanguage}`;
  },
);
```

#### 方案二：复用 `agent.injectAffect()` 固定注入（设计定案）

适合场景：用户身份 / 基础设定需要**始终在上下文中**，且与角色包解耦（切换角色不丢失）。

内核公开 API `agent.injectAffect(text)`（见 [API 参考手册](./memora-api-reference.md) §十二 完整 API 一览·角色条目）是「宿主可控的 system prompt 固定文本槽」：文本原样插在**角色包 prompt 与 bootstrap 记忆之间**，角色切换不清除、实时重建，传空串清除。名字虽沿用"情感基调"，机制即通用文本注入，正适合承载用户基础设定。

```typescript
// 宿主启动装配、agent.init() 完成后调用一次（内存态——每次启动从宿主自有存储读取后注入）
async function loadUserProfile(): Promise<{
  name: string;
  role?: string;
  background?: string;
  preferences?: string[];
} | null> {
  // 宿主实现：文件 / SQLite / 环境变量均可
}

const profile = await loadUserProfile();
if (profile) {
  agent.injectAffect(
    [
      '【用户基础设定】',
      `姓名：${profile.name}`,
      `角色：${profile.role ?? '未指定'}`,
      `背景：${profile.background ?? '未指定'}`,
      `偏好：${profile.preferences?.join('、') ?? '无'}`,
    ].join('\n'),
  );
}
// 需要清除时：agent.injectAffect('');
```

### 两种方案对比

| 维度 | 方案一：工具注册 | 方案二：injectAffect 固定注入 |
|------|---------------|-------------------|
| 触发方式 | LLM 按需调用 | 装配时注入一次，始终在上下文 |
| Token 效率 | 高（仅需要时消耗） | 低-中（每轮随 system prompt 携带） |
| 实现复杂度 | 低 | 低 |
| 适用场景 | 身份信息偶尔被查询 | 身份信息必须始终可见、且与角色解耦 |

### 用户档案文件格式示例

宿主可以使用任意格式存储用户档案，推荐 JSON 或 Markdown：

**`user-profile.json`**
```json
{
  "name": "张三",
  "role": "后端工程师",
  "background": "5 年 Go 开发经验，熟悉微服务架构",
  "preferences": ["简洁回答", "中文沟通", "代码优先"]
}
```

**`user-profile.md`**
```markdown
# 用户档案

- **姓名**：张三
- **角色**：后端工程师
- **背景**：5 年 Go 开发经验，熟悉微服务架构
- **偏好**：简洁回答、中文沟通、代码优先
```

### 核心约束

1. **用户档案完全由宿主管理**：存储、更新、版本管理
2. **内核零新增**：不新增存储、不新增 API——方案二复用现有公开方法 `agent.injectAffect()`，仅以文本形式注入，内核不感知"档案"语义
3. **不注入时零影响**：未实现用户档案的宿主，Agent 行为不变
4. **偏好记忆仍走涌现路径**：对话中涌现的偏好（如"用户喜欢简洁回答"）仍通过 `preference` 摘要沉淀，用户档案仅承载**静态/半静态身份信息**

---

> 更多细节参见 [memora-api-reference.md](./memora-api-reference.md)（完整 API 参考）
