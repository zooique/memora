# 过程事件日志 + 重放重建（规范化设计文档）

> **文档状态**：✅ 正式设计方案（SSOT）
> **版本**：v1.0
> **创建日期**：2026-08-28
> **状态**：已评审（业界对齐：Claude Code JSONL 事件日志模型），待落地

### 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-08-28 | 初始版本：运行时状态与重载状态分叉问题定案，过程事件日志（round 级 per-round 文件）+ 重放重建 |

---

## 设计方案地位声明

本文件是 Memora「运行时展示状态」与「落盘内容」一致性的**唯一真理源（SSOT）**。所有关于过程事件日志存储、UI 状态重建、协议扩展的实现必须遵循本文档的设计。

### 设计原则

1. **SSOT 原则**：运行时展示的一切内容，都是落盘内容的**投影**；不存在「内存态 vs 落盘态」两份状态
2. **分轨原则**：对话正文（RoundStore）与过程事件（EventLog）分轨存储，只以 `roundId` 关联，互不污染
3. **自然生长**：基于现有 round 生命周期扩展，不引入新的存储后端、不破坏 Agent Loop
4. **可重放**：任何时间和状态，都能由落盘日志按序重放重建出与运行时一致的 UI 状态
5. **降级优先**：日志写入 fire-and-forget + catch-only-log，落盘失败绝不影响实时展示

---

## 一、问题背景

### 1.1 现象

Memora 对话过程中，webview 展示大量**运行时状态**：

- 顶部「当前角色」徽章 + LLM 名称
- 召回记忆卡片（`memory recalled` / `recalled_items`）
- 思考阶段卡片（`thinking`：召回记忆中 / 调用模型中 / 处理中 / 归档记忆中）
- 工具执行卡片（`tool_start` / `tool_result`）
- 搜索/沉淀记忆提示条（`memory added`）
- 自审查过程块（`selfReview` + `text(stage='self_review')`）

但**重启 / 切换会话后只恢复干巴巴的正文文本**，以上全部丢失。

### 1.2 根因

这些运行时内容全部来自同一条**有序事件流**（[AgentChunk](../src/agent/types.ts) 的 `recall/thinking/tool_start/tool_result/selfReview/aborted/…`）+ 宿主事件（`memoryRecalled/memoryAdded/rolePackSwitched`），但它们**从未被持久化**——只有正文文本进了 RoundStore。即：

```
运行时 = 事件流（实时投影，不落盘）
重载   = 正文（落盘，但与运行时不一致）
```

### 1.3 本质

这不是"少存了几张卡片"的增量问题，而是**展示层存在两份状态**（内存投影 vs 磁盘正文），违背顶层哲学「配置文件是真理源」的延伸——运行时所见 = 真理源的读视图。

---

## 二、业界对齐

| 产品 | 核心做法 | 对本方案的启示 |
|------|----------|---------------|
| **Claude Code** | 会话存为 append-only JSONL 事件日志（`~/.claude/projects/<项目>/<session-id>.jsonl`），流式中维护「当前回合快照」，UI 只信任已定序快照，`/resume` 按序重放重建消息链与控制状态 | 事件日志 + 重放重建是生产级验证过的模型 |
| **Claude Code** | 回合结束写入持久化的就是快照最终态，与 UI 最后一帧严格相等 | SSOT 的具体表达 |
| **Trae 移动端** | SSE 流式消息 7 态状态机，cancelled 保留半截内容并标记 | interrupted/aborted 必须有持久语义 |
| **byte deer-flow** | issue #3403 / PR #3571：取消时把半截对话补写持久化（官方承认前端保留≠后端持久化的数据一致性 bug） | 中断补写是行业共识方向 |
| **opskat** | 流式期间增量更新消息 + 防抖定时器落盘，避免每次保存磁盘写频 | 落盘需节流 |

**结论**：主流产品不追求「每个 chunk 都写盘」，而是**内存快照为实时真理源 + 结束/节流补写 + 恢复时按序重放**。本方案完全对齐这一模型，并把「过程轨」也纳入落盘范围（比主流更进一步——主流只落正文，我们连卡片一起落）。

---

## 三、核心设计

### 3.1 架构总览

```
┌─ 运行时 ─────────────────────────────────────────────┐
│ 内核 AgentLoop yield AgentChunk 流                     │
│     │ recall / thinking / tool_* / selfReview / text  │
│     ▼                                                  │
│ 宿主 consumeFlow（统一消费点）                          │
│     ├──▶ 实时转发 webview（展示投影，不变）             │
│     └──▶ 旁路追加 EventLog（fire-and-forget 落盘）      │
└──────────────────────────────────────────────────────┘

┌─ 重载时 ─────────────────────────────────────────────┐
│ host loadSession → session.roundIds                  │
│     → 逐 round 读 EventLog（per-round 文件）           │
│     → 按序重放事件 → 重建全部卡片与状态                 │
│     → webview 渲染（与运行时同一渲染函数）              │
└──────────────────────────────────────────────────────┘
```

### 3.2 分轨存储

| 轨 | 存储 | 内容 | 真理源角色 |
|----|------|------|-----------|
| **内容轨** | RoundStore（现状不变） | `userMessage` / `assistantMessage` 正文 | 对话内容物理真相源 |
| **过程轨** | EventLog（新增，per-round 文件） | `thinking/recall/tool_start/tool_result/selfReview/aborted` + 首轮 `meta`（角色 + LLM 名） | UI 状态重建真相源 |

两轨以 `roundId` 关联：正文不塞过程、过程不塞正文。

### 3.3 事件模型（持久化子集）

不落全部 chunk，只落「可重建 UI 的最小信息」：

```
EventLogEntry = {
  seq: number;          // 轮内序号（保证重放顺序）
  ts: string;           // ISO 时间戳
  type: 'meta' | 'thinking' | 'recall' | 'tool_start' | 'tool_result'
      | 'self_review' | 'aborted' | 'text_self_review';
  payload: {...};
}
```

| type | payload | 重建什么 |
|------|---------|----------|
| `meta`（仅首条） | `role`（角色名+trait）+ `llm`（模型名） | 顶部角色徽章 + LLM 名称 |
| `thinking` | `phase`（recalling/llm_calling/processing/archiving） | 思考折叠块 |
| `recall` | 记忆 `id/name/source/score` 摘要 | 召回记忆卡片 |
| `tool_start` | `toolCallId/name/args` | 工具执行卡片 |
| `tool_result` | `toolCallId/ok/summary` | 卡片完成态 |
| `self_review` | `round` + 自审查文本 | 自审查过程块 |
| `aborted` | `reason` | 「已停止」标记 |
| `text_self_review` | 自审查段内容 | 自审查输出分段 |

**取舍**：`tool_args` 截断（超长截断，防膨胀）；`recall` 只存摘要不存记忆全文（与作品投影同构：指针不带内容）。

### 3.4 存储形态：per-round 文件（已评审定案）

- 位置：`<dataDir>/round-events/<roundId>.jsonl`（与 RoundStore 同生命周期）
- 每轮一个 JSONL，append-only 追加写
- **生命周期绑定 Round**：GC 清理 round（refCount=0）时连同事件文件删除——天然复用现有 round 引用/回收站机制，分叉会话共享 roundId 即共享事件文件（指针复制，零拷贝一致）

### 3.5 写入路径（宿主 consumeFlow 旁路）

- 宿主在统一消费点 [consumeFlow](../hosts/memora-vscode/src/webview/panels/chatPanel.ts) `for await` 内，对上述类型事件追加写当前 round 的 EventLog
- fire-and-forget：失败 catch-only-log，不阻塞转发（对齐 P1 消息持久化降级语义）
- 首轮先写 `meta`（当前角色 + 激活 LLM 名，从 host 状态读取）
- 流结束（done/interrupted）时 flush；中断同样落 `aborted` 事件（复用上一轮中断保存修复成果）

### 3.6 重放路径（加载会话）

- `loadSessionMessages(date, session)` 已按 roundIds 展开正文 → 扩展为同时读每轮 EventLog
- 按 `seq` 有序重放 → 产出「状态重建指令」列表 → host 复用现有 `post` 协议推给 webview
- **关键**：webview 重放渲染与运行时渲染走**同一渲染函数**（chatView.ts 的 dispatch 分支），保证"运行时所见 = 重放所见"

### 3.7 协议扩展

新增 host → webview 重放批次消息（复用现有消息类型，仅改变来源）：

```
replay_events: { roundId: string; events: EventLogEntry[] }
```

webview 收到后按当前 `dispatch` 分支逐条渲染（与运行时 chunk 转发同路径），`meta` 事件更新顶部角色/LLM 徽章。

---

## 四、边界与取舍

| 边界 | 决策 |
|------|------|
| 事件日志膨胀 | 只存最小重建信息；`args`/记忆正文截断；GC 随 round 清理 |
| 写盘频率 | 流式期间按防抖节流（复用 opskat 模式），不逐 chunk 写 |
| 兼容旧会话 | EventLog 缺失 → 重放退化为仅正文（现状），不阻断恢复 |
| 宿主迁移 | Sprite 宿主已搁置，不维护兼容（按宿主状态声明） |
| 与 checkpoint 关系 | 检查点继续管 plan/goal 等执行态；EventLog 只管 UI 展示态，职责分离 |

---

## 五、分步实施

| 步骤 | 内容 | 预估影响 |
|------|------|----------|
| **S1** | 内核：EventLog 类型定义 + per-round 存储接口（`IEventLogStore`，宿主注入）+ 测试 | 内核小改，纯加法 |
| **S2** | 宿主：consumeFlow 旁路写入（meta/thinking/recall/tool/aborted）+ `replay_events` 重放 | 宿主中等，覆盖 90% 痛点 |
| **S3** | 宿主：selfReview 分段 + 首轮 meta（角色+LLM）演示 | 宿主小改 |
| **S4** | GC 联动：事件文件随 round 清理 + 全量回归 | 收尾验证 |

## 六、完成定义

1. 对话过程中中断 / 切会话 / 重启插件 → 重新加载后：角色徽章、LLM 名、召回记忆、思考阶段、工具卡片、自审查块、已停止标记全部复原
2. 复原的 UI 与运行时逐一对应（diff 为空）
3. 正文与过程分轨：RoundStore 无新字段，EventLog 无正文全文
4. 写盘失败时对话仍正常展示（降级不降功能）