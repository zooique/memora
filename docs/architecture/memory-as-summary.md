# 记忆即摘要：溯源式记忆架构设计

> **定位**：设计文档，描述记忆系统的重构方案——以"摘要即记忆"为核心理念，取消独立的记忆提炼层，通过溯源标识实现记忆与对话记录的松耦合关联。
>
> **关联**：[agent-design-philosophy.md](agent-design-philosophy.md)（单轮问答闭环公理）· [mvp-scope.md](mvp-scope.md)（MVP 边界）

---

## 一、现状与问题

### 1.1 当前三层架构

```
对话记录（窗口级）
    ↓ 每轮摘要
轮次摘要（窗口级）
    ↓ LLM 提炼
长期记忆（全局级）
```

三层各有独立存储和独立生命周期，但存在本质冗余：

- **记忆 = 摘要的聚合**：长期记忆的"用户偏好"本质上是多条摘要的共同特征，没有独立的信息增量。
- **记忆不可溯源**：提炼后丢失了"这条记忆来自哪段对话"的链接，无法验证、无法修正。
- **维护成本高**：三个存储层需要三套查询、三套生命周期管理、三套 GC 策略。

### 1.2 核心矛盾

**为什么需要记忆系统？** 因为引入"多窗口"后，窗口级摘要无法跨窗口共享。

但如果我们深入追问：**跨窗口共享的本质是什么？** 是"按需聚合"而非"预先提炼"。LLM 需要的不是一条预先提炼好的"用户偏好"，而是**一组相关的摘要**，LLM 自行从中推理出偏好。

---

## 二、设计理念：记忆即摘要

### 2.1 核心公理

```
摘要就是最小记忆单元。
一切"记忆"都是摘要的按需聚合，而非独立的提炼层。
```

### 2.2 设计推导

从 SSOT 公理出发——单轮问答闭环是最小单元：

```
一轮问答闭环 = 用户输入 + LLM 回复 + 轮次摘要
                  ↑                         ↑
              Trigger（外部输入）         Reflect（后处理）
```

每一轮闭环完成后，Reflect 阶段自然生成轮次摘要（1-2 句话）。这个摘要就是该轮产生的**唯一记忆**。没有独立的提炼层——记忆不是"从摘要中提炼出来的"，而是**摘要本身就是记忆**。

### 2.3 三层 → 两层

```
重构前：对话记录 → 轮次摘要 → 长期记忆（三层）
重构后：对话记录（窗口级，仅展示） + 轮次摘要（全局，即记忆）
```

### 2.4 Round 边界定义

**关键定义**：一个 Round = 一次 `processUserInput` 调用，而非一次 `handleIteration`。

```
用户输入： "帮我写一个排序函数，然后用测试用例验证"
    ↓
processUserInput 入口 → 分配 roundId = "round-5"
    ↓
  iteration 1: LLM 输出 tool_call(writeFile)    ← 共享 round-5
  iteration 2: 工具结果注入，LLM 输出 tool_call(runTest) ← 共享 round-5
  iteration 3: LLM 输出最终回复                  ← 共享 round-5
    ↓
postProcess → 使用 round-5 生成摘要
```

**理由**：一次用户输入内部可能有多轮 iteration（工具调用、反思、自审查），但语义上属于同一轮对话。若每 iteration 都生成摘要，会产生冗余（例如一次用户输入产生 6 条摘要）。

**实现机制**：
- `loop.ts` 新增 `currentRoundId` 字段，在 `processUserInput` 入口分配一次
- 所有 iteration 共享该 roundId
- `postProcess` 读取 `currentRoundId` 传递给 RoundSummaryGenerator

---

## 三、存储模型

### 3.1 轮次摘要表（唯一记忆存储）

```
┌─────────────────────────────────────────────────────────┐
│  轮次摘要（RoundSummary）                                │
├─────────────────────────────────────────────────────────┤
│  id:          string        // 唯一标识（全局唯一）     │
│  sessionId:   string        // 所属对话窗口 ID          │
│  roundId:     string        // 所属对话轮次 ID          │
│  content:     string        // 1-2 句话摘要内容         │
│  type:        SummaryType   // 摘要类型                 │
│  timestamp:   number        // 生成时间戳               │
│  isTraceable: boolean       // 可溯源标记               │
│  isModified:  boolean       // 手动修改标记             │
│  createdAt:   string        // 创建时间                 │
└─────────────────────────────────────────────────────────┘
```

**RoundSummary 与现有 Memory 的关系**：
- RoundSummary 写入 `IMemoryStorage`，`source='round-summary'`
- 与现有 `source='insight'`（InsightExtractor）和 `source='content'`（SessionArchiver）共存
- 三者职责不同，不以对方为前提

### 3.2 三种摘要来源的职责分工

| 来源 | 触发条件 | 内容特征 | 示例 |
|------|---------|---------|------|
| `round-summary`（RoundSummaryGenerator） | 每轮必生成 | 客观过程记录，无价值判断 | "用户请求编写排序函数，AI 提供了快速排序实现并运行测试通过" |
| `insight`（InsightExtractor） | 仅"有价值"内容 | 价值提炼，有质量评分 | "用户偏好 TypeScript 和快速排序算法"（score=0.8） |
| `content`（SessionArchiver） | 会话切换/手动 | 整会话综合摘要 | "本次会话完成了代码重构和测试覆盖" |

**RoundSummaryGenerator 的 prompt 约束**："只记录本轮发生了什么，不做价值判断"。避免与 InsightExtractor 产生内容重叠。

### 3.3 摘要类型（SummaryType）

摘要携带类型标签，让 LLM 在召回时能快速理解摘要的性质：

| 类型 | 语义 | 示例 |
|------|------|------|
| `preference` | 用户偏好 | 用户偏好简洁UI、喜欢 Python |
| `fact` | 事实信息 | 用户正在开发一个写作助手 |
| `decision` | 决策记录 | 用户选择了方案A，使用DeepSeek |
| `intent` | 意图记录 | 用户计划在下周发布v2.0 |
| `general` | 一般摘要 | 讨论了代码重构方案（默认） |

类型标签在摘要生成时由 LLM 自动判断，不给 LLM 增加额外负担——只需在摘要 prompt 中加一句"请判断此轮摘要的类型"。

### 3.4 溯源链接

每个摘要通过 `sessionId + roundId` 链接回原始对话记录：

```
摘要 → 对话记录
  │         │
  │    sessionId 定位到窗口
  │    roundId   定位到具体轮次
  │
  └── 可溯源：isTraceable = true，完整对话可回溯
  └── 不可溯源：isTraceable = false，原对话已删除
```

溯源是**软链接**——对话记录删除时，摘要保留，仅标记 `isTraceable = false`。

### 3.5 对话记录的 roundId 扩展

`ISessionStore` 接口需要扩展以支持 roundId 追踪：

```typescript
export interface SessionMessage {
  role: MessageRole;
  content: string;
  timestamp: string;
  roundId?: string;  // 新增：可选，为空时不影响现有行为
}
```

`appendMessage` 新增可选 `roundId` 参数。**向后兼容**——现有宿主不传 `roundId` 时行为不变。

---

## 四、召回机制

### 4.1 召回优先级

```
外部输入（Trigger）
    ↓
1. 同窗口优先：按 sessionId 召回当前窗口的摘要
   （同一对话框的上下文连续性最强）
    ↓
2. 跨窗口召回：按语义相似度召回其他窗口的摘要
   （跨 session 知识迁移，按时间戳排序）
    ↓
3. 注入上下文：将召回结果按时间排序注入 system prompt
```

**存量 insight 的处理**：`isTraceable = false` 的 insight 仍参与语义召回，仅 LLM 知道"不可追溯原始对话"。

### 4.2 时间戳排序

跨窗口摘要召回后，按 `timestamp` 升序排列，LLM 自然识别"最近偏好"——无需独立解决冲突的机制。

### 4.3 LLM 溯源工具

向 LLM 暴露一个工具 `traceSummary(sessionId, roundId)`，让 LLM 在需要时自行回溯到原始对话记录：

```
LLM 持有摘要：用户偏好简洁UI（from session-abc, round-5）
    ↓ 需要更多上下文
LLM 调用 traceSummary('session-abc', 'round-5')
    ↓ 返回原始对话记录（受规模控制）
LLM 获得完整上下文
```

工具暴露给 LLM 但不强制使用——上下文组装时自动注入最相关的摘要，LLM 决定是否进一步溯源。

### 4.4 traceSummary 返回格式与规模控制

```
返回格式：
{
  "sessionId": "session-abc",
  "roundId": "round-5",
  "summary": "该轮对话的摘要内容（来自 round-summary 记忆）",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." },
    // 最多返回 5 条消息，超长截断到 2000 字符/条
  ],
  "isTruncated": true,   // 消息是否被截断
  "isTraceable": true
}
```

**限制策略**：
- 最多返回该轮次相关的 5 条消息（用户输入 + 主要回复 + 关键工具调用）
- 单条消息最多 2000 字符
- 超长时返回 `isTruncated: true`，让 LLM 知道内容不完整

**降级策略**：
- 有 `roundId`：精确返回该轮次的消息（前后各 +1 轮做上下文）
- 无 `roundId`：返回整个会话的消息摘要（不如精确回溯，但至少可用）
- 对话已删除：返回"该摘要已不可追溯"

---

## 五、生命周期与删除语义

### 5.1 删除规则

| 操作 | 对摘要的影响 | 说明 |
|------|------------|------|
| 对话记录删除 | `isTraceable = false` | 摘要保留，但标记不可溯源 |
| 摘要手动修改 | `isModified = true` | 标记已修改，`isTraceable` 保持不变（原始对话仍存在） |
| 摘要删除 | 无影响 | 对话记录仍保留，但摘要不再被召回 |

### 5.2 设计理由

- **对话记录是"展示层"**：给用户翻看历史用，不是系统运行的必要依赖。
- **摘要是"记忆层"**：是系统运行的核心依赖，不应因展示层的删除而丢失。
- **打标而非硬删**：保留数据完整性，防止误删可通过恢复标记找回。
- **`isModified` 与 `isTraceable` 独立**：修改摘要不代表原始对话不存在，`isModified` 标记"内容可信度"问题，`isTraceable` 标记"原始数据是否存在"问题，两者不应耦合。LLM 调用 `traceSummary` 回溯时，发现摘要与原始对话不一致可自行裁决。

### 5.3 溯源标记不可逆

`isTraceable = false` 后不恢复，保证数据一致性。对话记录被删除后，即使恢复备份，由于 roundId 无法保证唯一性，也不应回溯标记。

---

## 六、聚合效率优化

### 6.1 问题

随时间推移，摘要数量线性增长，每次上下文组装时召回 N 条摘要的成本增加（token 消耗 + LLM 推理开销）。

### 6.2 方案：全局时间窗口聚合

采用**全局时间窗口聚合**，而非按会话聚合：

```
聚合条件（同时满足）：
  - 累计摘要数 ≥ N（默认 50 条，跨会话累计）
  - 时间窗口 ≤ 7 天（防止跨长时间段的摘要被错误聚合）
  - 最后一条摘要距当前 > 1 分钟（避免频繁聚合）

聚合结果：
  原始摘要 1-50 条 → 聚合摘要 A（1-2 句话概括）
  原始摘要 51-100 条 → 聚合摘要 B
```

**为什么不用按会话聚合**：短会话（如 10 轮）永远不会触发 N=50 的聚合阈值，导致聚合机制对短会话完全失效。

### 6.3 聚合摘要的存储

聚合摘要与原始摘要同表存储：

| 字段 | 值 |
|------|-----|
| `source` | `'round-summary'` |
| `type` | `'aggregated'` |
| `isTraceable` | `false`（聚合后丧失对单轮对话的溯源能力） |
| `metadata` | `{ aggregatedRange: { startSessionId, endSessionId, startRoundId, endRoundId, count: 50 } }` |

### 6.4 召回策略

- 聚合摘要优先于原始摘要（信息密度更高）
- 如需精确溯源，LLM 可调用 `traceSummary` 定位到具体轮次
- 聚合范围标记让 LLM 知道"这段摘要覆盖了哪些轮次"
- 原始摘要保留不删除，仅召回优先级降低

### 6.5 触发时机

聚合在 `postProcess` 中检查——每次新摘要生成后，查询 `source='round-summary'` 且 `type != 'aggregated'` 的活跃摘要数，达到阈值后触发聚合（异步执行，不阻塞主流程）。

---

## 七、存量数据迁移策略

### 7.1 迁移范围

| 数据 | 迁移方式 | 成本 |
|------|---------|------|
| 现有 `source='insight'` 记忆 | **不迁移**，批量标记 `isTraceable=false` | 零 |
| 现有 `source='content'` 记忆 | 保留不动，不参与 round-summary 召回 | 零 |
| 现有对话记录 | 不修改（无 roundId 标记，`traceSummary` 降级使用） | 零 |

### 7.2 迁移脚本

```sql
-- 只需一条 SQL，零 LLM 调用
UPDATE memories SET is_traceable = 0
WHERE source = 'insight' AND is_traceable IS NULL;
```

### 7.3 迁移后的行为

```
升级后 behavior：
  - 存量 insight：isTraceable = false（清晰声明不可溯源）
  - 新产生的 round-summary：isTraceable = true（可溯源）

召回时：
  - 存量 insight 仍可被关键词/语义召回（内容不变）
  - 只是 LLM 知道"这条记忆不可追溯原始对话"
  - 这是合理的——以前的对话确实没有溯源能力
```

---

## 八、与现有设计的对比

| 维度 | 现有设计（三层） | 新设计（溯源式） |
|------|---------------|----------------|
| 存储层 | 对话记录 + 摘要 + 记忆 | 对话记录 + 摘要（摘要即记忆） |
| 跨窗口共享 | 记忆层 | 摘要全局召回 + 时间戳排序 |
| 可追溯性 | 无（记忆不可溯源） | 完全可溯源（`sessionId + roundId`） |
| 删除语义 | 硬删或复杂 GC | 打标制，清晰可审计 |
| 系统复杂度 | 中（三层维护） | 低（两层维护） |
| 信息冗余 | 高（记忆 = 摘要提炼） | 低（摘要即记忆，无冗余） |
| 检索效率 | 高（记忆层已聚合） | 需按需聚合（N 轮聚合补偿） |
| LLM token 消耗 | 低（直接取用聚合记忆） | 中（LLM 自推理或 N 轮聚合） |

---

## 九、发展潜力

### 9.1 短期（Phase 1-3）

- 实现 RoundSummaryGenerator（新增 `source='round-summary'` 写入）
- 实现 loop.ts 中的 roundId 追踪
- 实现 `traceSummary` 工具（含规模控制）
- 扩展 `ISessionStore.appendMessage` 接收可选 `roundId`
- 实现全局时间窗口聚合（Phase 2）
- 存量数据迁移脚本（Phase 3）

### 9.2 中期（Phase 4-5）

- 移除现有 `source='content'` 的 SessionArchiver 代码（由 round-summary + 聚合替代）
- 长期观察 InsightExtractor 的使用率，若 round-summary 已覆盖足够信息，考虑移除
- 摘要修正/反馈回路（用户可修改摘要，系统标记 `isModified`）

### 9.3 远期（Phase 6）

- 摘要冲突检测（跨窗口矛盾摘要的 LLM 裁决）
- 摘要权限/可见性控制（多用户场景）
- 基于摘要的 LLM 行为分析（智能体自我反思）

---

## 十、设计约束

1. **摘要生成必须在 Reflect 阶段完成**——不阻塞主流程，异步写入。
2. **摘要类型标签由 LLM 自动判断**——不引入独立分类器。
3. **溯源标记不可逆**——`isTraceable = false` 后不恢复，保证数据一致性。
4. **聚合摘要不替代原始摘要**——聚合后原始摘要仍保留，仅召回优先级降低。
5. **`traceSummary` 工具仅暴露给 LLM，不强制使用**——上下文组装时自动注入最相关摘要。
6. **RoundSummary 与 InsightExtractor 职责分离**——前者只做客观过程记录，后者做价值提炼。
7. **`traceSummary` 返回内容受规模控制**——最多 5 条消息，单条 2000 字符。
8. **存量数据零成本迁移**——不回溯，不调用 LLM，仅批量打标。

---

> **关联资源**：
> - [agent-design-philosophy.md](agent-design-philosophy.md) —— 单轮问答闭环公理，本文的 SSOT 根基
> - [mvp-scope.md](mvp-scope.md) —— MVP 能力边界，本文是 MVP 之后的下一个迭代
> - `src/agent/managers/insightExtractor.ts` —— 现有 InsightExtractor（保留，与 RoundSummaryGenerator 并行）
> - `src/agent/managers/sessionArchiver.ts` —— 现有 SessionArchiver（待降级）
> - `tasks/记忆即摘要升级方案-20260813.md` —— 实施计划与阶段划分