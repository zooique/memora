---
alwaysApply: false
description: 会话标题层——会话身份（date-session）与展示标题解耦，首轮问答闭环自动命名 + 占位降级 + 手动改名透传，支撑宿主从"按天自动归档"改造为"手动创建会话 + 历史导航"的大厂设计
---

# ADR-024 · 会话标题层：身份与展示标题解耦

> **状态**：✅ 已接受
> **日期**：2026-08-15
> **来源**：宿主改造需求（从"按天自动归档"→"手动创建会话 + 自动命名/改名 + 历史列表导航"）+ 网络土壤（Trae 历史面板 / WorkBuddy 任务制会话设计）
> **依赖**：[ADR-013](./ADR-013-archive-pipeline.md)（记忆归档管道）、[agent-design-philosophy.md §8.1](../../docs/architecture/agent-design-philosophy.md)（回答后沉淀）

## 背景

宿主希望将当前"**按天自动归档对话记录**"的交互，改造成常规大厂的会话设计：

- 用户**手动创建会话**；
- **第一次问答闭环**自动总结会话名称；
- 支持用户**手动改名**；
- 历史记录可**重新加载到对话框继续问答**。

核实现状：memora 的会话模型是 **`日期-技术标识` 二元组**（`YYYY-MM-DD-session`，session 默认 `main`）。它天然支持"恢复继续问答"（`restoreSession`/`loadSessionMessages`）与"手动新建"（`switchSession` 切到不存在的会话名即新建），但**没有一个用户可读的"会话标题"**——会话名是技术标识，不是标题。这是本次改造唯一的真实缺口。

## 决策

### 核心决策：会话身份与展示标题解耦（单一真理源对齐）

**会话主键仍是 `date-session`（身份），标题是独立存在的展示元数据，不污染主键。** 标题不是会话身份的一部分，而是"回答后沉淀"的会话级产物。

### 1. 存储层 —— `ISessionStore` 扩展（可选方法，向后兼容）

```ts
export interface SessionMeta {
  title: string;        // 用户可读标题
  updatedAt: string;    // 最近活跃时间 → 历史列表排序
  messageCount: number; // 供命名信号与列表展示
}
// 追加到 ISessionStore（全部可选，与 saveCheckpoint 同模式，不破坏宿主）
getSessionMeta?(sessionId: string): SessionMeta | undefined;
setSessionTitle?(sessionId: string, title: string): void;
listSessionMetas?(): SessionMeta[];
```

### 2. 内核命名管线 —— 新增 `SessionNamer`

- 构造注入 `provider + sessionStore`，与 `SessionArchiver` 同形态；
- 复用公共 `accumulateStream + parseLlmJson` 管线，生成一句话标题（10 字内），不新造轮子；
- **占位降级**：LLM 不可用/失败/无价值 → `新会话 HH:MM`（借鉴 WorkBuddy 占位式），best-effort 不阻塞闭环。

### 3. 触发条件 —— 仅"会话无标题"时，在首轮问答闭环触发

- **触发钩子**：首轮问答闭环的 `appendUser` 之后 fire-and-forget 触发 `ensureSessionTitle(date, session, firstUserContent)`，用首条用户消息生成标题（标题语义贴合用户意图）；
- **判定**：`getSessionMeta(sessionId)?.title` 为空才命名。因为**新建会话首轮问答前必然无标题**，手动改名后 title 非空 → 不再覆盖。**天然满足"只在第一次触发"，无需粘性锁定**。

### 4. 手动改名透传 —— `SessionManager` 有界方法

```ts
getSessionMeta(date: string, session: string): SessionMeta | undefined;
renameSession(date: string, session: string, title: string): void;
```

### 5. 与既有能力的关系（不推翻）

- 按天自动归档（每天 `main` 会话 + `content` 记忆归档）、`forkSession`、`restoreSession`、`switchSession` **全部原样保留**，标题层对两种会话（自动归档 / 手动会话）都生效；
- 手动会话只是把 `session` 换成唯一 id，二者并存不冲突。

## 理由

1. **单一真理源**：会话身份（身份主键）与展示标题（展示元数据）本就是两个正交维度，解耦后标题不污染主键，不违背"万物皆是记忆"的统一模型。
2. **回答后沉淀的自然延伸**：标题生成与轮次摘要同属"回答后（Reflect）"阶段的沉淀产物，复用同一 LLM 管线，不引入独立后台系统。
3. **最小改动 + 向后兼容**：`ISessionStore` 方法全部可选，宿主不实现也可运行；复用现有 `restoreSession`/`switchSession`，无需另造会话引擎。
4. **触发条件简洁**：以"会话无标题"替代"消息计数"，天然覆盖 `switchSession`/`fork` 两种新建路径，且手动改名永不被覆盖。

## 替代方案

| 方案 | 放弃原因 |
| ---- | -------- |
| 宿主侧自建 `Map<sessionId, title>` 维护标题 | 零内核改动，但命名管线无法复用内核 LLM 能力，宿主重复造轮子（违背单一真理源） |
| 会话标题并入会话身份（`date-session-title` 作主键） | 污染主键，标题变更需重建会话，破坏 identity/title 正交 |
| 标题作为必填方法（非可选） | 强制宿主实现，破坏向后兼容，违背"可选扩展"契约 |

## 影响

- `ISessionStore` 接口扩展（可选方法，[sessionStore.ts](../../src/memory/sessionStore.ts)）；
- 新增 `SessionNamer`（[sessionNamer.ts](../../src/agent/managers/sessionNamer.ts)）；
- `Agent` 闭环 `appendUser` 后加 fire-and-forget 触发（[agent.ts](../../src/agent/agent.ts)）；
- `SessionManager` 新增 `getSessionMeta`/`renameSession`（[sessionManager.ts](../../src/agent/managers/sessionManager.ts)）；
- 历史列表导航、手动新建、改名 UI 由宿主基于 `restoreSession`/`switchSession`/`renameSession` 实现，内核不承担 UI。

## 何时回顾

- 当宿主需要"会话标题搜索/筛选"或"会话级标签"等进阶能力时，需评估 `SessionMeta` 是否扩展；
- 当要求"重命名后跨会话统一"或"标题本地化"时，需重新评估 title 的归属与存储。

## 演进备注（2026-08-29 · 会话管理纯度定案）

> **收敛**：§5「按天自动归档全部原样保留」语义作废。会话创建收敛为**唯一手动入口**（宿主标题条「＋」）：
>
> - `restoreMostRecentSession()` 去除 `preferredSession='main'` 与「今天-main 优先」按天归档残留——最近活跃的唯一时间序真理源 = `listSessionMetas[0]`（`updatedAt` 降序），方法只恢复、绝不隐式创建；
> - `MessageHistory.appendUser/appendAssistant` 不再把 `currentDate` 刷新为当天——跨天续聊沿用会话锚定日期，杜绝输入触发「跨天自动新建会话」；
> - 宿主初始化移除「今天-main」兜底：无历史会话时不自动创建，首次发送引导手动新建。
>
> 与 §1/§5 的张力说明：ADR 主体保留 2026-08-15 定案（标题层与身份解耦、手动会话可行）不变，仅"按天自动归档并存"的过渡语义在本轮剪除。