# 记忆即摘要：溯源式记忆架构设计

> **2026-09-04 收敛补记**：本文论述的多 turn 编排摘要策略（"复杂收敛 → 收尾汇报 turn → 提炼汇报单源摘要""子 turn 不单产摘要""head id 组合溯源"）已随多 turn 编排层废弃。收敛后语义简化为：**一次外部输入 → 一个 turn → 一条 round-summary**，无中间 turn、无 head id 概念、无 report 单源摘要。全文其余架构（溯源标识、摘要为唯一记忆单元等）未变。
>
> **2026-09-09 收敛补记（memory-tool-recall-design 阶段2）**：本文件正文中作为「角色包 L2 召回键」论述的 `memoryRecallPercent` / `memoryRecall` / `summaryRecall` / `recallConfidence` / `minFallback` / `contextAssembly` 已随召回策略键族**整体退役**——记忆纯工具化召回后，prepare 无自动注入消费端，6 键与解析函数/常量一并移除；召回改由 `search_memories` 工具触发。
>
> **2026-09-10 补记（减法 P2-2 · `ea76435d`）**：上述补记随后提到的「记忆层 cap 由内核常数 `DEFAULT_MEMORY_CAP_RATIO=0.4` 承载」**亦已失效**——该常数连同 `ContextOccupancy.memoryTokens` / `memoryCount` 已整体删除。**现行预算与占用模型无任何记忆维度**：记忆不进 prepare 装配管线，检索唯一入口 = `search_memories` 工具，由 LLM 主动取用、按需拉取 token（非常驻预算），故**不存在「记忆层 cap」这一概念**（保留 `DEFAULT_MEMORY_CAP_RATIO` 之名即为结构性幻觉）。下文相关引用均为退役前设计语义，不再代表当前 schema。
>
> **2026-09-10 收敛补记（G39 P2-2 收口）**：上述替代物 `DEFAULT_MEMORY_CAP_RATIO` **亦已删除**——记忆自动注入退役后该 cap 无任何约束消费者（`recalledMemories` 恒空），属「为不存在的量算上限」。连带清理 `budget` 的 `memoryLayerCapTokens` 与占用快照的 `memoryTokens`/`memoryCount`。**现行预算/占用模型均无记忆维度**。
>
> **2026-09-09 收敛补记（阶段3 score 物理退役）**：本文件正文中作为记忆权重论述的 `score` 字段（§3 字段表、`hybridMerge` 的 `vectorScore*0.6 + score*0.4` 融合、召回保底「按 score 降序」、boost 加分 `m.score + 0.05` 等）**已随阶段3 从 `Memory` 接口物理删除**——score 单调不减导致区分度趋零，且「只 touch 不 +score」后无写位。现状：排序 = 单语义分 `vectorScore` 降序，使用轨迹唯一事实源为 `accessedAt`，命中即刷新 `accessedAt`（不再加分）；读档经 `parseMemory` 白名单构造，旧档 score 自动剥离。注意与上一类补记区分：**「语义相似度分」不是记忆权重，仍然健在**——但承载它的 `RecalledMemorySummary`（recall chunk 载荷）已随自动召回展示链于 2026-09-10 物理删除，现行载体为搜索命中返回值 `AgentSearchHit.similarity`。下文 score 相关表述除明确指相似度者外，均为退役前设计语义。
>
> **2026-09-10 收敛补记（recall() 物理删除）**：**§四 全章（4.0-4.8 分层分轨召回）、§6 影响中的依赖链、§7 形态表、附录参照，所描述的 `recall()` 召回编排函数已物理删除**（同批「减法」，文件 `src/memory/recall.ts` 现仅存 `extractKeywords` / `touchScores` 两个工具函数，2026-09-18 更名为 `keywordsTouch.ts` 对齐职责）——`applyTrackPolicy` / `sortByLayer` / `applyCapAllocation` 三函数与 `recall()` 签名一体消失，L1/L2 分层、分轨进池、cap 内分配、minFallback 保底等**均为退役前设计语义，不再有现行实现**。**现行召回 = `search_memories` 工具**（`searchHybrid` 双通道融合，LLM 主动取用），prepare 不注入任何记忆、预算无记忆维度。下文凡提及 `recall()` 者请勿按现行机制解读。
>
> **定位**：设计文档，描述"记忆即摘要"架构——以摘要为唯一记忆单元，通过溯源标识实现记忆与对话记录的松耦合关联。
>
> **关联**：[agent-design-philosophy.md](agent-design-philosophy.md)（turn 公理）· role-pack-spec.md（记忆键 SSOT）

---

## 一、问题

### 1.1 三层架构的本质冗余

经典记忆系统采用三层架构：

```
对话记录（窗口级）
    ↓ 每轮摘要
轮次摘要（窗口级）
    ↓ LLM 提炼
长期记忆（全局级）
```

每层独立存储、独立生命周期，但存在本质冗余：

- **记忆 = 摘要的聚合**：长期记忆的"用户偏好"本质上是多条摘要的共同特征，没有独立的信息增量。
- **记忆不可溯源**：提炼后丢失了"这条记忆来自哪段对话"的链接，无法验证、无法修正。
- **维护成本高**：三个存储层需要三套查询、三套生命周期管理、三套 GC 策略。

### 1.2 核心矛盾

**为什么需要记忆系统？** 因为引入"多窗口"后，窗口级摘要无法跨窗口共享。

但深入追问会发现：**跨窗口共享的本质是按需聚合，而非预先提炼。** LLM 需要的不是一条预先提炼好的"用户偏好"，而是一组相关的摘要，LLM 自行从中推理出偏好。

### 1.3 与"预提炼"模型的权衡（诚实声明）

本架构砍掉了独立的洞察提炼层（InsightExtractor），这并非纯粹的简化，而是一次**效率挪移**：

| 维度 | 预提炼模型（insight） | 本架构（按需聚合） |
|------|---------------------|-------------------|
| "用户是谁"的归纳 | 预先沉淀一次，多次复用 | 每次召回时 LLM 当场聚合 |
| 跨会话完整画像 | 直接读取洞察 | 需从多条摘要推理 |
| 存储层 | 多一层（insight） | 单层（round-summary） |
| 召回成本 | 低（直接取用） | 中（每次聚合推理） |

在有界召回（limit 5 + 时间唯一排序）下，单次聚合成本可控，因此"少一个存储层"的收益大于"每次召回多一次推理"的成本。但**跨会话"用户是谁"的完整画像场景会退化**——这是有意为之的取舍，不是无代价的最优。

---

## 二、设计

### 2.1 核心公理

```
摘要就是记忆本体。
一切"记忆"都是摘要，而非独立的提炼层。
记忆系统 = 摘要 + 标签（summaryType）+ 粒度（轮次级）+ 溯源（roundId/sessionId）
```

**设计定论**：记忆系统**不是**"只剩 round-summary"的妥协产物，而是**设计本体**——记忆系统就是摘要记忆。摘要生成时自动打标签（`summaryType`），标签**平替**掉旧记忆系统的分类体系（insight/profile/work-projection 多类并存 → 一种摘要 + 五类标签）。标签是**纯语义分类**，不携带时效性（见 §3.2）。

### 2.2 设计推导

从 SSOT 公理出发——turn（问答闭环）是最小单元：

```
一次外部输入（问答闭环）= 用户输入 + LLM 回复 + 轮次摘要
                  ↑                         ↑
              Trigger（外部输入）         Reflect（后处理）
```

每次外部输入完成后，Reflect 阶段自然生成轮次摘要（1-2 句话）。这个摘要就是该次输入产生的**唯一记忆**。没有独立的提炼层——记忆不是"从摘要中提炼出来的"，而是**摘要本身就是记忆**。

**两级粒度**：**对话记忆仅 round-summary 一个自动轨**（轮次级）。会话级摘要不进记忆库——归会话记录存储 `SessionMeta`（summary/keyTopics），随 `deleteSession` 删除。

```
记忆系统 = 摘要记忆
│
└─ round-summary  轮次级摘要（每一轮对话一条，唯一自动轨）
     ├─ sessionName   会话 id（YYYY-MM-DD-会话名）
     ├─ roundId       turn id（本轮唯一）
     ├─ summaryType   标签（preference/decision/fact/intent/general）
     └─ 溯源：roundId + sessionId → 回溯本轮原始对话

会话级摘要（SessionMeta.summary/keyTopics）→ 会话记录存储，不参与记忆召回
```

### 2.3 架构（当前形态）

```
对话记录（窗口级，仅展示 + 溯源兜底）
round-summary（轮次级，唯一记忆单元）
会话级摘要（SessionMeta.summary/keyTopics，随会话删除）
```

> **当前形态**：记忆收敛为**摘要单轨**——唯一记忆单元是 round-summary（轮次级），无独立的用户画像层与洞察提炼层。用户画像（UserProfile / userFactExtractor / archiveProfileFacts）与洞察层（InsightExtractor / archiveInsight）不独立存在，其能力并入 round-summary 的 `summaryType` 标签分类（§3.2）。`traceSummary` 溯源接对话记录（§4/§4.5），对话记录作为展示层 + 溯源兜底的运行依赖（§5.2）。

> **会话级摘要不进记忆库**：`SessionArchiver` 只更新会话记录存储 `SessionMeta`（summary/keyTopics/autoName，见 [sessionArchiver.ts](../../src/agent/managers/sessionArchiver.ts)），**不写任何记忆库 source**。`content` 为历史残留 source——无生产写入路径（`memoryInspector.writeUpsert` 仅治理页编辑已有记忆时复用，无新增入口），已从 `GOVERNANCE_SOURCES` 清空（2026-09-09 剪枝）。详见 [memory-role-pack-boundary.md](memory-role-pack-boundary.md) 与 [ADR-025](../../.trae/decisions/ADR-025-memory-role-pack-boundary.md)。

### 2.4 Round 边界

**一个 Round = 一次 `processUserInput` 调用，而非一次 `handleIteration`。**

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

**理由**：一次用户输入内部可能有多轮 iteration（工具调用、反思），但语义上属于同一轮对话。若每 iteration 都生成摘要，会产生冗余（例如一次用户输入产生 6 条摘要）。

### 2.5 摘要触发 · 来源 · 粒度（阶段 2+3 定案 · 探索期记录，未固化为 ADR）

> **恒定规则**：**「摘要 ↔ 外部输入 恒 1:1」——一次外部输入恰好产出一条 round-summary。**
>
> **构成**：loop 内部的 tool/反思 step 不是 turn（见 §2.4），不单独摘要；多 turn 任务编排的内部子 turn（规划/步）虽各占 `roundId`（用于消息溯源/互斥排除），**同样不单独摘要**——内部子 turn 是否拆分为独立 roundId 只影响溯源粒度，不影响摘要数量。

- **来源**（「简单直接」与「多 turn 任务编排收尾汇报」是同一规则的两种取值，都指向"答完/收尾那轮"）：
  - 直接回答（简单）= 答完那轮即答案 → 提炼该答案；
  - 多 turn 任务编排·复杂收敛 = 收尾汇报 turn → 提炼汇报（阶段 2+3 `reflect.runReported` 以汇报文本为单源）。
- **触发时刻**：turn「答完/收尾」即触发（非 tool step、非暂停边界）。对话 `wait` 态（答完等用户）同样答完即摘要——"结束指令"非此处触发条件。
- **硬中止（abort / 用户取消）**：不打完 → **不摘要**（残缺半成品不入记忆）；但已产出内容以 `[已中断]` 标记写进对话历史（保真留存，供 `traceSummary` 回溯）。历史保细节、记忆不收纳残缺，两者分离。
- **软暂停（requestPause，可续跑）**：暂停时**不立即摘要**；若后续续跑并真正答完 → 该轮**仍会**摘要。

> 该定案已由 `seed/orchestrator.ts` 落地：普通回答 → `reflect.run(input, 答完内容)`；复杂且收敛的多 turn 任务编排 → 收尾 `reflect.runReported(汇报单源)`（规划/步子 turn 不单产摘要）；复杂但未收敛 → 以规划 turn 产出走普通单条摘要；`act` 返回 aborted → 不摘要。三者均保证一次外部输入恰产一条 round-summary（摘要 ↔ 外部输入 1:1）。

> **两级摘要防混淆（补充澄清）**：系统有**两轨摘要**，职责不同、互不顶替——
> - **round-summary（记忆轨）**：跨会话沉淀，即本 §2.5 规则对象。一次外部输入恒 1:1，**决策点唯一**。
> - **context summary（运行时轨）**：loop 内部 `_prepareContext`/compact 把溢出窗口的旧轮压成骨架注入，保证多轮内部一致性。**内部子 turn 的"摘要欲"归这一轨**，不产 round-summary、不入记忆库。
> - **单一决策点**：「恒1:1」不违背「turn 一摘要」——把"外部输入"视为**最外层 turn**（Trigger=输入；Act=规划+步序列；Reflect=收尾汇报），收尾汇报 turn 即该最外层 turn 的 Reflect。故**摘要决策点唯一（最外层收尾）**，内部子 turn 复用 turn 机制但不设 round-summary 决策点。
> - **上下文注入自洽**：loop 多轮时，被挤出窗口的历史靠 context summary 骨架保留，**不依赖也不应依赖** round-summary 兜底（否则职责错位）；骨架对 code/diff/table 的保真由角色包 `summaryFocus` 承担。
> - **无实质收尾仍恒 1:1**：收敛但汇报为空/仅 token 预算占位（无真实收尾）→ 回退以该外部输入的主答（阶段 2）/规划产出（阶段 3）走普通单条（`runReportAndReflect`，[orchestrator.ts](../../src/agent/seed/orchestrator.ts)），**不是 0 条**。
> - **组合溯源（head id，已落地）**：多 turn 任务编排的 round-summary 挂在**组合 head id**（= `prepare` 分配、`appendUser` 的 roundId，即"这次外部输入"），而非最后一步——`externalTaskLoop` 收尾时把 roundId 回指 head，使汇报文本与 round-summary 与用户消息同 roundId（组合内溯源自洽）。步 turn 仍用独立 sub roundId（消息溯源/互斥排除），但收尾摘要锚定 head。

---

## 三、存储模型

### 3.1 摘要表（轮次级记忆存储）

```
┌──────────────────────────────────────────────────┐
│  轮次摘要（RoundSummary）—— 系统轮次级记忆存储    │
├──────────────────────────────────────────────────┤
│  id:          string        // 全局唯一标识      │
│  sessionName: string        // 所属对话窗口名称  │
│  roundId:     string        // 所属对话轮次 ID   │
│  content:     string        // 1-3 句话摘要      │
│  type:        SummaryType   // 摘要类型（驱动差异召回）│
│  createdAt:   string        // 创建时间（组内排序键）│
│  accessedAt:  string        // 最后访问时间       │
│  score:       number        // 权重（0-1）       │
│  isModified:  boolean       // 手动修改标记      │
└──────────────────────────────────────────────────┘
```

写入 `IMemoryStorage`，`source='round-summary'`。这是系统**唯一**的记忆产生层（轮次级自动轨）；会话级归档只更新 `SessionMeta`（不写记忆库，见 §2.3）；`content` 为历史残留 source（无生产写入路径，已清出治理源，2026-09-09 剪枝）。

### 3.2 摘要类型（SummaryType）— 语义标签

摘要携带类型标签，它是**纯语义分类**——描述"这条摘要是什么"，平替旧记忆系统的分类体系。类型由 LLM 在摘要生成时自动判断。

| 类型 | 用户语义 | 说明 |
|------|---------|------|
| `preference` | "我是谁"（用户偏好） | 长期有效的用户身份 |
| `decision` | "我决定了什么" | 决策锚点 |
| `intent` | "我计划什么" | 用户意图/计划 |
| `fact` | 客观事实 | 事实陈述 |
| `general` | 一般对话（默认） | 兜底分类 |

**设计要点**：
- **type 不携带时效性**。记忆是否有效由「语义状态」判定（superseded 写时取代），不由时间流逝判定——用户久未使用不构成记忆过期的理由。
- 类型继承自原有洞察系统的分类思路，复用既有分类体系，不引入新机制。
- **排序由「分层分轨（L1 优先 L2）+ 组内时间 + 语义相关性」构成**（§4.1-§4.3/§4.8），类型不参与排序。
- 类型隐含价值层级——`preference`/`decision` 天然比 `general` 更有记忆价值，价值通过召回时的相关性排序自然体现，无需独立的 quality 评分字段（避免与 type 信息冗余）。

### 3.3 溯源链接

每个摘要通过 `sessionName + roundId` 链接回原始对话记录：

```
摘要 → 对话记录
  │         │
  │    sessionName 定位到窗口
  │    roundId     定位到具体轮次
```

溯源是**软链接**——`trace_summary` 工具按 `sessionName + roundId` 查原始对话；查得到就输出原文，查不到（摘要尚在但原文已删等异常路径）则**按本次查找结果降级渲染**"（原始对话已删除，仅剩摘要）"。溯源是否可达成由**读时事实**判定，不依赖字段标记（`isTraceable` 字段已删除，2026-08-28：无行为消费者）。

### 3.4 对话记录的 roundId 扩展

```typescript
export interface SessionMessage {
  role: MessageRole;
  content: string;
  timestamp: string;
  roundId?: string;  // 可选，为空时不影响现有行为
}
```

---

## 四、召回机制（分层分轨）

### 4.0 设计演进概述

> **⚠️ 本章整体已失效（2026-09-10）**：v3「分层分轨召回」的 `recall()` 编排已物理删除，记忆召回现行形态 = `search_memories` 工具（见头部收敛补记）。本节及 4.1-4.8 保留为**历史设计演进参考**，不再反映现行实现。

记忆召回经历了三代设计：

| 代 | 排序策略 | 治理机制 | 问题 |
|---|---------|---------|------|
| v1 | score 排序 | L0-L3 四层治理 | 摘要已压缩，衰减收益低 |
| v2 | hybridMerge → 会话优先 → 时间覆盖 | supersede + 衰减（已移除） | 双重排序覆盖融合分数，治理空转 |
| **v3（当前）** | **分层分轨召回** | **supersede + boost** | 设计清晰，每轨有独立策略 |

### 4.1 分层分轨召回流程

```
外部输入（Trigger）
    ↓
1. 分层：按 sessionName 分为会话内（L1）和会话外（L2）
    ↓
2. 分轨：每层内按 summaryType 分为独立轨道
    ↓
3. 各轨独立进候选池：
   - L1 会话内：全部轨道走语义召回，结果按 createdAt 升序
   - L2 会话外：preference 进池（有查询意图时）；intent 不进池；其余按语义召回进池
    ↓
4. cap 内分配：各轨道在 memoryRecallPercent 兜底下，靠排序自然形成份额
   （preference 时间升序、语义轨道按相关性；可选 minSemanticSharePercent 防挤占）
    ↓
5. 合并：L1 全部 + L2 选拔，L1 排在 L2 前面
    ↓
6. 互斥排除：排除正文已加载的轮次摘要
    ↓
7. 截断：取前 limit 条返回
```

**核心原则**：
- **分层**：会话内（L1）和会话外（L2）是两个独立的召回层
- **分轨**：每个 summaryType 是独立轨道，决定"是否进候选池"（召回策略开关），不决定"占多少配额"
- **分配靠排序**：cap 内的份额由时间/相关性排序自然形成，不手工切百分比（§4.3.1）
- **会话优先**：L1 全部排在 L2 前面（不是全量注入，是召回后优先排序）
- **语义相关性**：L1 和 L2 都走召回路线（用户输入可能漂移，不全量注入）

### 4.2 分层策略

| 层 | 选择条件 | 召回策略 | 排序规则 | 设计意图 |
|---|---------|---------|---------|---------|
| **L1 会话内** | `sessionName === 当前sessionId`（顶层持久化字段，A1 提升） | 语义召回（走 hybridMerge） | `createdAt` 升序 | 用户搁置后回来，先看到那个会话的上下文 |
| **L2 会话外** | 其余所有记忆 | 按轨道独立召回（见 §4.3） | 语义相关性降序 | 跨会话的全局知识 |

**层间关系**：L1 召回结果全部排在 L2 前面，然后合并截断。

**为什么 L1 也走召回（不全量注入）**：用户输入可能漂移。比如用户在一个"代码重构"会话中突然问"我喜欢什么语言"，全量注入会话内所有摘要会浪费 token 且干扰 LLM。走召回能筛选出会话内真正相关的摘要。

### 4.3 分轨策略（summaryType）

每种 summaryType 决定**是否进候选池**（召回策略开关），而非分配配额：

| 轨道 | 类型 | L1 会话内进池 | L2 会话外进池 | 设计理由 |
|------|------|-------------|-------------|---------|
| **偏好轨** | `preference` | 语义召回进池 | **进池**（不经检索，有查询意图时） | 偏好长期有效应被召回；无查询意图（空/噪声输入）不注入 |
| **事实轨** | `fact` | 语义召回进池 | 语义召回进池 | 事实可能过时，需要相关性筛选 |
| **决策轨** | `decision` | 语义召回进池 | 语义召回进池 | 决策可能被推翻，需要相关性筛选 |
| **意图轨** | `intent` | 语义召回进池 | **不进池** | 意图是临时的，跨会话无意义 |
| **通用轨** | `general` | 语义召回进池 | 语义召回进池 | 兜底，什么都能装 |

**关键设计**：
- **进池 ≠ 全量注入**：`preference` 进池（不经检索），但进池后仍受 `memoryRecallPercent` 总 cap 约束，且组内按 `createdAt` 升序——只取 cap 内最近的偏好，旧的偏好自然排在 cap 外，不会无限膨胀上下文（§4.3.1）
- **查询意图 gate**：L2 preference **仅在有查询意图（关键词非空）时补入**候选池，无查询意图（空/噪声输入）不注入——防御偏好强塞无关查询（代码 `applyTrackPolicy` 的 `hasQueryIntent` 判定，与文档一致）
- **L1 会话内**：所有轨道都走语义召回（不全量注入）
- **L2 会话外**：preference 进池（不经检索，仅在有查询意图时补入），intent 不进池（跨会话无意义），其余按语义匹配进池

#### 4.3.1 cap 内分配规则

**原则**：总上限（`memoryRecallPercent`）管"总量封顶"，cap 内的份额由**排序自然形成**，不引入每轨百分比键。（避免 5 个配额参数的机制膨胀，违背简洁哲学。）

**分配逻辑**：
1. **总量封顶**：召回的摘要总 token 受 `memoryRecallPercent`（角色包 L2，cap 百分比）约束。
2. **偏好轨**：组内按 `createdAt` 升序（最近偏好优先），塞满即止。
3. **语义轨**（fact/decision/general）：按 `hybridMerge` 语义相关性排序。
4. **合并**：偏好 + 语义按各自排序填充 cap，L1 优先于 L2。

**竞争兜底（可选，默认关闭）**：当 `preference` 挤满 cap 时，语义轨道可能被完全挤出。如需避免，提供单个软参数 `minSemanticSharePercent`（默认 `0`），保证语义轨道至少占 cap 的该比例：

```
minSemanticSharePercent（0.0~1.0，默认 0）
→ 语义轨道（fact/decision/general）保证至少拿 cap 的该比例，
  preference 最多占 (1 - minSemanticSharePercent)。
  设 0 = 关闭（最简形态：分轨只是开关，分配全靠排序）。
```

> **命名对齐（2026-08-27）**：当前内核实现参数名为 `minSemanticShare`（`RecallOptions` 字段，`recall()` 传参），默认 `0`；`minSemanticSharePercent` 是"若未来升格为角色包 `prepare` 键"时的潜在键名——**当前未开放**（见下方开放边界）。文档讨论统一用潜在键名指代同一机制，实现侧以 `minSemanticShare` 为准。

**为何不设每轨百分比**：每轨一个键（preferenceShare/factShare/...）会让配置面随类型数线性膨胀，且参数耦合难维护。`minSemanticSharePercent` 只在竞争成为实测瓶颈时开——符合"不预埋接口、验证后再固化"的哲学。

**开放边界（是否进角色包）**：`minSemanticSharePercent` **作为内核默认值，暂不开放为角色包 `prepare` 键**。判断标准：开放 = 角色"想要什么"（意图），不开放 = 召回"内部怎么做"（机制）。

| 键 | 表达的是 | 开放？ |
|----|---------|--------|
| `memoryRecallPercent` | 角色想要摘要占多少上下文 | ✅ 角色包层（意图） |
| `memoryRecall` / `summaryRecall` / `recallConfidence` | 角色想不想召回、多严格 | ✅ 角色包层（意图） |
| `minSemanticSharePercent` | 为避免偏好挤占、语义轨道保底多少 | ❌ 内核（机制） |

理由：
1. **防挤占是技术手段，非角色意图**——角色关心"召回哪些/多少/多严"，不关心 cap 内语义轨道的保底坑位；暴露成角色键会向用户传导实现细节。
2. **默认 0 关闭，属备用参数**——进角色包需过 `strategyKeys.ts` 四件套（校验/解析/合并/文档/测试），为一个默认 0 的键不值。
3. **分层不冲突**——`memoryRecallPercent` 管总量 cap（角色包层），`minSemanticSharePercent` 管 cap 内语义保底（内核召回实现层），不越界。

若未来确凿出现"客服角色应多给事实、轻偏好"这类真实诉求，再将其升为角色包 `prepare` 键，与 `memoryRecallPercent` 同区间（0~1）同默认值（0）。在那之前留内核、不进 schema。

### 4.4 召回算法（伪代码）

```typescript
async function recall(storage, query, options: RecallOptions): Promise<Memory[]> {
  const { limit, sessionId, excludeSources, excludeRoundIds, capTokens, minSemanticShare = 0 } = options;

  // 0. 双通道收集候选（语义 vectorStore + 关键词 storage.search）
  const merged = new Map(); // id → { memory, vectorScore }

  // 1. 分轨进池策略（applyTrackPolicy）——仅具备 sessionId 分层上下文时生效
  //    1a. L2 intent 排除：跨会话（sessionName !== sessionId）的 intent 移出候选池
  //    1b. L2 preference 进池：getBySource('round-summary') 枚举，仅补跨会话 preference（仅在有查询意图时补入）
  applyTrackPolicy(merged, storage, { sessionId, excludeSources, hasQueryIntent });

  // 2. 互斥排除：excludeRoundIds（正文已加载轮次）在融合排序前过滤
  // 3. 综合排序：hybridMerge 融合排序（vectorScore*0.6 + score*0.4）选拔候选，可选 reranker 二次精排
  //    候选超集裁剪（2026-08-27 修复）：hybridMerge / reranker 用 limit × RECALL_LIMIT_MULTIPLIER 保留候选超集，
  //    不在 cap 分配前裁到最终 limit——否则排序靠前的 L2 preference 独占 top-limit、语义轨被挤出，
  //    minSemanticShare 兜底失效；最终条数由 applyCapAllocation 的 limit 槽位预算兜底（无 cap 时退化 slice 同旧行为）
  const sorted = hybridMerge(candidates, limit * RECALL_LIMIT_MULTIPLIER, weights);
  // 4. 分层排序（sortByLayer）：L1 会话内 createdAt 升序 → L2 preference createdAt 升序 → L2 其余保持相关性序
  let active = sortByLayer(sorted, sessionId).filter(m => !m.supersededBy);
  // 5. 召回保底：active < minFallback 时用空查询补最近记忆（排语义命中后、同过滤）
  // 6. cap 内分配（applyCapAllocation）：
  //    capTokens 缺省/≤0 → 纯 limit 条数截断（退化旧形态）
  //    semanticFloor = min(capTokens, ⌊capTokens × minSemanticShare⌋)（默认 0 = 关闭）
  //    L1 全量注入 → L2 preference 最多占 (capTokens - semanticFloor)（createdAt 升序）
  //    → L2 语义轨保底 semanticFloor（相关性序，preference 未用满的余量让给语义轨）
  const allocated = applyCapAllocation(active, sessionId, { capTokens, minSemanticShare, limit });
  // 7. Boost（读路径副本，不改存储；持久化由调用方 fire-and-forget 调 boostScores）
  return allocated.map(m => ({ ...m, score: Math.min(1.0, m.score + 0.05) }));
}
```

> **历史说明（落地状态已被撤回，2026-09-10）**：本节伪代码对应的 `recall()` 及其三函数（`applyTrackPolicy` / `sortByLayer` / `applyCapAllocation`）**已随召回编排物理删除**（见头部收敛补记）——「已由 `src/memory/recall.ts` 落地」不成立，`recall.ts` 现仅存 `extractKeywords` / `touchScores`。`metadata?.summaryType / sessionName / roundId` 提升为顶层持久化字段与 §4.4 候选超集裁剪修复**仍现行**（与召回编排无关）；本节其余"落地状态"表述均属退役前语义。

### 4.5 hybridMerge 融合排序（保留）

语义召回内部仍使用 `hybridMerge`（`vectorScore*0.6 + memory.score*0.4`）选拔候选，但**不再做第二次排序覆盖**。`hybridMerge` 的结果直接返回，由外层按分层分轨规则合并排序。

**与 v2 的区别**：v2 中 `hybridMerge` 的排序被"会话优先 + 时间"完全覆盖（双重排序问题）。v3 中 `hybridMerge` 只负责"选拔候选"，排序由分层分轨规则统一处理。

> **边界标注（D2，2026-08-27）**：`memoryInspector.searchHybrid()` 与 `recall()` **共享** `hybridMerge` 融合排序，但 searchHybrid 是「记忆搜索工具」**不是召回管线**——保持融合排序**不分层分轨**（不应用 L1/L2 分层、不进池策略、不做 cap 内分配）。搜索工具暴露纯融合相关性结果，供宿主/上层按需自取。两者不互调用，边界清晰（见 `memoryInspector.ts` searchHybrid 注释）。**（2026-09-10 修订：`recall()` 已随召回编排物理删除，"分层分轨仅属 recall() 召回编排（contextPreparer 调用）"半句失效——现行唯一记忆检索入口 = `searchHybrid`；本条意图「searchHybrid 不分层分轨、暴露纯融合结果」仍现行）**。

### 4.6 差异化召回（按 type）的历史与演进

> **定论**：type 时间窗口差异化召回**并非设计形态**。原方案曾为 `intent`/`general` 设 7 天窗口，理由是「计划过期避免干扰」「低价值降噪音」——但这是**用时间代理语义状态**的读时猜测，违反 ADR-021「写时定、不读时猜」纪律，且误伤「用户久未使用但记忆仍有价值」的场景。故 type 时间窗被否决，改用自然遗忘：
> - **superseded 写时取代**（ADR-021）：计划完成/被覆盖 → 旧摘要被标记取代 → 不再作为当前事实注入；
> - **相关性排序**（hybridMerge）：低相关/低分记忆本就进不了 top-N 召回预算。
>
> 二者共同保证「低价值记忆自然退出召回面」，无需 type 时间窗，也**不依赖 score 时间衰减**（§10 治理已收敛为 supersede + boost，衰减收益低、机制已移除）。type 回归纯语义标签（§3.2）。
>
> **当前形态诚实声明（2026-08-27 收敛）**：记忆库收敛为摘要单轨后，摘要是事实记录（"聊过什么"），无"过时"语义；其 score 由召回 boost 驱动（越常用越重要），记忆有效性由 superseded 写时取代判定。score 时间衰减机制已移除（见 §10 治理简化），自然遗忘仅由 superseded + 相关性排序承载。

#### 4.6.2 隐式过期（implicit expiry）的显式边界声明（2026-09-10 补）

业界 2026 将 **memory staleness** 列为记忆系统三大未解难题之一，主流对策是 TTL / temporal validity（让记忆随时间自然失效）。memora **不采用**该机制，这不是缺失而是**有界的设计选择**，须显式论证以免被误读为「忘了做」：

- **supersede 处理的是「显式矛盾」**：新事实推翻旧事实（计划 A 改计划 B），写时即可确定取代关系（ADR-021）。
- **TTL 处理的是「隐式过期」**：无任何新事实，但旧事实自然失效（如「我下周要去上海」过了那一周）。
- **memora 的处理**：隐式过期**不在写入/存储层剪枝，交由检索时的 LLM 判读**——`round-summary` 天然携带 `createdAt` / `roundId` / `sessionName`，`search_memories` 命中后正文含时间信息，LLM 可据此自行判断时效。
- **为何不引入 TTL**：① TTL 是**用时间代理语义状态**的读时猜测，与 §4.6 否决 type 时间窗同属一类错误（违反 ADR-021「写时定、不读时猜」）；② 「久未使用 ≠ 过期」，固定 TTL 会误杀仍有效的长期偏好；③ 引入独立过期机制即新增一条与 supersede 并列的失效路径，违反单一真理源。
- **成立的边界（诚实声明）**：本选择依赖 LLM 在读取时**真的会**看时间戳做时效判断。若未来出现「LLM 把过期的时间性事实当作当前事实使用」的真实用户反馈，则应触发复评——届时优先考虑**在摘要正文内显式标注时效**（LLM 可读的结构化提示），而非引入系统级 TTL 剪枝。

### 4.6.1 角色包召回开关 × type 标签（两层协作）

> **⚠️ 2026-09-10 失效标注**：本节所述 `prepare.memoryRecall` / `prepare.summaryRecall` **两键已随召回策略键族整体退役**（见文首 2026-09-09 补记）——记忆纯工具化召回后 prepare 无自动注入消费端，**「召回开关」概念不再存在于当前 schema**。本节保留为退役前设计语义（角色级约束的思路仍可作为未来「工具暴露面差异」的参考），不代表现行实现。

角色包召回开关与 type 标签是**两层不同职责**，不冲突：

- **角色包开关（角色级约束，作用于召回前）**：`prepare.memoryRecall`（full/limited/none）决定"是否召回、召回多少"；`prepare.summaryRecall`（on/off）决定"是否召回摘要"。二者是**总开关**。
- **type 标签（召回内呈现，作用于召回后）**：在开关放行后，标签用于摘要的组织/展示（§3.2），不驱动过滤与排序。

协作语义：

- 角色包设 `summaryRecall: off` 时，该角色**关闭摘要注入**（不把历史摘要拼进上下文），但 `traceSummary` 溯源工具与全局记忆存储不受影响——这是**角色级约束**，仅影响该角色的召回，不污染全局记忆。
- 角色包设 `memoryRecall: none` 时，该角色的记忆召回整体关闭，摘要注入因无召回输入而自然不执行。
- **未配置时用内核默认**（默认 `full` / `on`）——角色包后置期间由内核默认值驱动，记忆模块行为不依赖角色包是否接入。

### 4.7 摘要与正文的互斥

**问题**：同一轮对话的正文和摘要不应同时进入上下文。若正文已作为对话历史全量加载，再注入该轮摘要就是重复信息，浪费 token 且干扰 LLM 判断。

**判定标准（确定性，非运行时状态）**：摘要的 `sessionName + roundId` 若属于**当前会话的最近 N 轮窗口**，则放弃搜索该摘要。

- **N 的定义**：N ≡ 上下文加载的完整对话轮数。正文完整加载多少轮，互斥窗口就是多少轮——两者严格相等，保证"该轮摘要被排除 ⟺ 该轮正文确实在上下文中"。
- **N 的来源**：目标态为「动态轮数」——N 由内核按上下文预算**派生**（派生值），不由角色包 `recentRounds` 覆盖（该键已删除，见 role-pack-spec §上下文预算装配）。
- 其他会话的摘要，或当前会话超出最近窗口的摘要，正文未加载 → 保留召回。

**为什么不用"正文是否已注入"作为判定**：那会引入召回与正文注入的时序耦合（谁先执行说不清），且依赖运行时状态，违反单一真理源。最近 N 轮窗口是纯确定性判定，只依赖摘要自身的 `sessionName + roundId`，与注入时机解耦。

**互斥发生在"回答前 - 拉取记忆"阶段的 recall() 内部**：调用方（agent 层）先构造"已加载正文集合"（当前会话最近 N 轮的 roundId），作为 `excludeRoundIds` 传入 recall()；recall() 在 `hybridMerge` 排序取 limit **前**过滤命中该集合的摘要。

**为什么过滤在 recall() 内取 limit 前（而非召回后）**：若在召回结果之后过滤，被排除的当前会话最近 N 轮摘要会**挤占 top-limit 预算**——单会话聚焦时它们最相关、排最前，跨会话记忆被挤到 limit 之外、永远取不到，导致跨会话召回失效。前置到取 limit 前过滤，剩余候选自然补位，跨会话记忆能进入 top-limit。`excludeRoundIds` 作为可选过滤条件由调用方传入，recall 保持纯检索、不查询会话状态（与 `excludeSources` 同语义），缺省为空集合时行为与纯检索完全一致。

### 4.8 排序：分层分轨 + 时间

> **历史说明**：本节描述的是 v2 时代的排序策略（"会话窗口优先 + 时间"两个正交维度）。v3 的排序策略已由 §4.1-§4.3 的分层分轨规则统一处理，本节保留作为设计演进参考。**现行排序 = 分层分轨（§4.1-§4.3）+ 组内 created-at 升序 + 语义相关性，见 §7 最终形态表，勿按本节单读成"按时间召回"。**

v2 排序由**两个正交维度**构成，任何维度都不被类型覆盖：

**维度一：会话窗口优先（上下文连续性）**
- 当前会话（`sessionName` 匹配）的摘要排在最前，其次是跨会话的全局记忆
- 同窗口优先体现"当前对话的上下文连续性"——正在聊的话题相关记忆优先呈现
- 这一步在互斥排除（§4.7）之后执行：当前会话最近 N 轮的摘要已被排除，这里"同窗口"指**超出 N 轮的当前会话历史摘要**，不会与正文重复

**维度二：时间（组内 createdAt 升序）**
- 在同一会话窗口组内，按 `createdAt` 升序排列，LLM 自然识别"最近偏好"
- 时间排序在会话窗口组内生效：同窗口内时间近的在前；跨窗口（跨会话）记忆不因 type 被挤掉——type 是纯语义标签，不参与过滤与排序（§3.2）

**为什么不按"类型价值"排序**：若让 `decision`/`preference` 因价值高而强制排在前面，就会让类型重新参与排序，破坏上述两个正交维度，并导致"远古高价值"压过"近期低价值"的呈现失真。类型价值通过相关性召回（hybridMerge）与 superseded（自然遗忘）自然表达，不参与呈现顺序。

**v3 的改进**：分层分轨设计中，类型**参与**召回策略（preference 进池（有查询意图时）、intent 不进池），但**不参与**排序。排序由分层规则（L1 优先于 L2）、组内时间（createdAt 升序）与语义相关性（cap 内分配）共同决定。

### 4.9 LLM 溯源工具

向 LLM 暴露 `traceSummary(sessionId, roundId)` 工具，让 LLM 在需要时回溯到原始对话：

```
LLM 持有摘要：用户偏好简洁UI（from session-abc, round-5）
    ↓ 需要更多上下文
LLM 调用 traceSummary('session-abc', 'round-5')
    ↓ 返回原始对话记录
LLM 获得完整上下文
```

工具暴露但不强制使用——上下文组装时自动注入最相关的摘要，LLM 决定是否进一步溯源。

### 4.10 traceSummary 返回格式与规模控制

```
{
  "sessionId": "session-abc",
  "roundId": "round-5",
  "summary": "该轮对话的摘要内容",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." },
  ],
  "isTruncated": true
}
```

**限制**：最多 5 条消息，单条 2000 字符。

**降级**：无 roundId 时返回整个会话摘要；原始对话已删时返回摘要并标注"（原始对话已删除，仅剩摘要）"。

### 4.11 检索侧工程（rerank / 召回深度 / 格式）

召回质量不只由"存了什么"决定——**检索侧（召回后处理）优化收益常高于摄取侧**（2026 行业实证：检索深度 +4.2%、上下文格式化 +2.0%、query bias 修正 +1.4%，均高于摄取侧 chunking +0.8%）。当前召回已具备：

- **rerank（重排序）**：召回结果在最终排序前先经相关性重排，剔除低相关噪声。
- **同会话窗口优先**：`sessionName` 匹配当前会话的摘要优先，跨会话记忆次之（§4.2 维度一）。

**远期候选（非承诺，不预埋）**：
- **query 改写**：把用户输入改写为更适合检索的查询。
- **召回深度（top-k）调优**：按场景调整召回条数上限。
- **召回格式微调**：调整摘要注入上下文的呈现格式。
- **上下文检索（contextual retrieval）**：召回命中某摘要后，若其**相邻轮次**（同 `sessionName`、`roundId` 前后 ±N 条）存在高相关摘要，在预算内一并召回，缓解"孤立摘要导致上下文断裂"。边界约束：① 不新增存储层（复用 round-summary 按 roundId 邻接查询）；② 扩展条数设上限（±2 条）；③ 总召回仍受增量召回 token 预算约束（≤10% 上下文窗口）；④ 与互斥排除（§4.7）兼容——相邻但正文已加载的轮次仍排除。
- **superseded 摘要物理清理**：被取代的摘要（`supersededBy` 标记）当前只被 recall 过滤（§5.3）、可经 `traceSummary` 回溯，**无物理清理**——长期会话会累积被覆盖的历史摘要。若未来需要回收存储，设计方向：按 superseded 时长（如 30 天）周期性软删除 → 回收站保留期 → 物理清理；边界约束：① 保留 `traceSummary` 回溯能力至清理前；② 清理不影响活跃摘要的取代链；③ 复用现有 `purgeExpired` 回收站机制，不新增清理管线。当前不实现（存储累积非瓶颈，属"软删除 + 可回溯"的既有设计权衡）。
- **召回保底（recall fallback）**：当语义召回结果过少（低于 `minFallback`）时，用最近记忆补足，保证 LLM 每轮至少获得阈值数量的记忆，避免"零召回/极少召回"导致完全无记忆可依。**定位是不可删除的**下限保障，非"项目延续"特化。设计要点：① **条件触发**——仅 `recall()` 结果不足 `minFallback` 才补，语义召回充足时不动作；② **数据源复用现有空查询通道**——`storage.search('', shortfall)` 按 score 降序取最近记忆（score 已含 boost（无时间衰减），天然=最近常用），零新增存储接口；③ **补足项排语义命中之后**，不抢占相关性结果；④ 参数 `prepare.minFallback`（默认 2），宿主可设 0 彻底关闭；⑤ 与互斥排除（§4.7）兼容——补足项同样去 `superseded`。**语义边界锁定**：本键只作用于**外部输入触发的运行前装配**召回保底，不管辖 loop 自循环阶段的压缩摘要上限（后者由内核预算检测 + 软上限决定，不经过 minFallback）。区别于"无条件固定注入最近会话摘要"（该方案绕过相关性过滤必然污染，已否决），本机制是**召回不足才兜底**，符合单一真理源。

写作等轻量场景当前用默认即可，待检索质量成为实测瓶颈再评估。

---

## 五、生命周期

### 5.1 删除规则

**定案（2026-08-28，年轮收敛）**：Round 是会话存储的物理唯一真理源（[round-independent-storage-design.md](./round-independent-storage-design.md) §2.2），round-summary 是它的派生记录——**删 Round 即删其派生摘要，连坐、彻底**。早期草案"删对话保留摘要转 `isTraceable=false`"被否决（理由见 §5.2 与 round-independent-storage §5.2）。

| 操作 | 对摘要的影响 | 说明 |
|------|------------|------|
| 删除问答闭环（Round） | **摘要随 Round 连坐 purge** | 引用归零 → GC 物理删 Round + 同步 purge 其 round-summary（不进回收站，系统治理决定）。长期知识沉淀由用户显式沉淀（作品投影/文档）承担，不由 round-summary 滞留承担 |
| 摘要手动修改 | `isModified = true` | 标记已修改，不影响溯源精确性 |
| 摘要删除 | 该轮记忆从召回视野消失 | 语义即"删记忆"。源对话记录仅作为展示保留，供用户回溯，不再参与运行召回 |

### 5.2 设计理由

- **对话记录是"展示层 + 溯源兜底的运行依赖"**：给用户翻看历史用；同时被 `traceSummary` 工具读取用于回溯原始对话（溯源保真）。**召回/聚合不依赖它**（摘要即记忆），但溯源工具依赖它——两者不冲突。
- **摘要是"记忆层"**：是系统召回/聚合的核心依赖。因此**删除摘要 = 删除记忆**，源对话记录仅作为展示 + 溯源保留供用户回溯，不再参与运行召回。
- **连坐删除的正当性（α）**：Round 是物理唯一真理源，摘要只是它的"浓缩影子"。**本源消融则影子消融**——不产生悬空溯源（roundId 指向不存在的 Round）、无孤儿状态、全链路零特化分支，这是状态最小的根本原因。若删 Round 却留摘要，会引入"无主记忆"状态：读路径（召回/roundSummaryLoader/trace_summary）都要为"Round 没了摘要还在"加兜底，且**删除的纠错语义失效**——用户删掉一段错误/隐私讨论，其结论仍以摘要形态影响未来回答。
- **跨会话价值不靠滞留兜底**：轮次流水速记（fact/general）随轮消融，符合"流水记录低独立价值"的定位；需要长期沉淀的知识走**用户显式沉淀**（作品投影/文档）。被动滞留是弱设计，显式沉淀才符合"种子自然生长"哲学。
- **打标而非硬删**：保留数据完整性，防止误删可通过恢复标记找回（软删除 30 天回收期）。
- **只留必要标记**：`isModified`（人工修改过，提示与原文可能不一致）是唯一保留的摘要标记。溯源可行与否**不设字段**——`trace_summary` 读时按 `sessionName + roundId` 查找，找到即原文、找不到即"（原始对话已删除，仅剩摘要）"，以事实为准（`isTraceable` 字段已删，2026-08-28：写死 true 无行为消费者，删后读侧无分支变化 + 修掉"可溯源却无原文"的展示瑕疵）。

#### 5.2.1 可追溯性边界

> **设计说明**：明确 memora 可追溯性的**边界**——它服务于"对话内容"的可回溯，不承诺"模型每次看到的完整上下文"的可重建。这是从 DeepSeek Harness"模型可见即已记录"（append-only 事件溯源）汲取思想后收敛的结论：**抄思想（可追溯性目标），不抄机制（事件溯源存储）**。

**追溯范围**：

- **说了什么（对话内容）**：`trace_summary` 工具经 `loadRawRoundMessages` 回溯原始对话（§4.9/§4.10）。
- **记忆来源（摘要溯源）**：round-summary 通过 `sessionName + roundId` 软链接回原始对话（§3.3）。

**明确不追溯（边界声明）**：

- **"模型看到了什么"（每次请求的完整上下文：系统提示、召回摘要、装配结果）** 不进入追溯范围。它是**可观测性诉求**，而非记忆诉求——由 **ITracer span** 承载（`llm.call` span 记录 `systemPromptHash`，`recall.recall` span 记录 `attachedMemoryCount` + `attachedMemoryFingerprint`），**不入 sessionStore**。理由：
  1. **哲学一致**：架构哲学 §8"自然遗忘优于完美记忆"——记录"模型看到了什么"的全量快照会导致存储无界膨胀，与 memora 轻量定位冲突。
  2. **职责分离**：对话记录是"展示 + 溯源"（记忆系统职责），上下文快照是"调试/评估"（可观测性职责，ITracer），两者不混层。
  3. **投入产出**：memora 已有关键链路（摘要 → 原始对话 → trace_summary）覆盖可追溯的绝大部分价值；"模型看到了什么"仅在调试/评估场景需要，走 ITracer 即有界、可选。

**ITracer 承载机制**（机制/策略分离）——
- **系统提示指纹**：`llm.call` span 的 `systemPromptHash` = 最终发给模型的全部 system 消息内容（persona + 规则 + 技能 + 召回注入）的 SHA-256 指纹，由 [utils/hash.ts](../../src/utils/hash.ts) 的 `sha256Fingerprint` 纯函数生成（同时复用于 [workProjection.ts](../../src/agent/managers/workProjection.ts) 的文件 hash，消除重复实现）。
- **附着记忆指纹**：`recall.recall` span 的 `attachedMemoryCount` / `attachedMemoryFingerprint` = 附着进上下文的记忆条数 + 记忆 ID 集合指纹（[loop.ts](../../src/agent/loop.ts) 注入点埋点）。
- **边界保持**：只记录 hash、不记录内容；宿主未注入 Tracer（NOOP）时不计算指纹（零开销边界）；span 属性由宿主自行采集/落盘/展示，内核不新增任何存储。

**与 §5.1 删除规则的衔接**：Round 物理删时摘要连坐 purge（§5.1），正常无"Round 没了摘要还在"的常态；即便异常路径（摘要尚在、原文已删），`trace_summary` 也按读时查找结果渲染"（原始对话已删除，仅剩摘要）"，不依赖任何字段标记。**memora 的追溯是软追溯（允许失效降级），不是 Harness 式的强事件溯源（永不删除）**——这是有意取舍，非缺陷。

### 5.3 记忆维护（写路径取代检测）

**问题**："摘要即记忆"是 append-only——每轮一条摘要。长期运行会出现三类"记忆腐烂"：同一事实重复表达、旧决策被新决策覆盖、过时事实仍被召回。**时间排序解决"呈现顺序"，解决不了"哪个决策覆盖哪个"**（覆盖是结构信息，不是时序信息）——若全靠 LLM 在召回时按时间序猜，冲突消解依赖运行时判断，违反"确定性优先"。

**设计决策：写路径取代检测**——把冲突消解从"读时猜"移到"写时定"，落在**闭环后处理（Reflect）**层面：

- 每轮闭环完成后，生成摘要的同时，**检测新摘要与近期同类摘要是否疑似覆盖**；若覆盖，给旧摘要打确定性 `superseded` 标记并指向新摘要（**非删除**，保留可回溯）。
- 读时（召回）按确定性过滤：`superseded` 摘要不再作为当前事实注入；需要历史时经 `traceSummary` 回溯。
- **判断触发条件**：仅当新摘要与同会话旧摘要"主题相关"时才触发取代，非每轮必做。

#### 5.4.1 加权 Jaccard 取代检测算法

**核心改进**：采用加权 Jaccard 相似度替代标准 Jaccard，提升「多轮逐步细化」场景下的主题延续识别准确度。

**标准 Jaccard**：
```
Jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

**加权 Jaccard**：
```
WeightedJaccard(A, B) = Σ(交集关键词权重) / Σ(并集关键词权重)
```

**关键词权重策略**：
- **动作/意图词**（如「创建」、「删除」、「优化」）：权重 **2.0**
- **实体/对象词**（以「器/表/函数/模块」等后缀结尾）：权重 **1.5**
- **其他词汇**：权重 **1.0**

**实现函数**：
- `extractEnhancedKeywords(text)`：提取带权重的关键词列表（`src/utils/segmenter.ts`）
- `calculateWeightedJaccard(keywordsA, keywordsB)`：计算加权 Jaccard 相似度（`src/utils/segmenter.ts`）

**阈值**：`SUPERSEDE_OVERLAP_THRESHOLD = 0.5`（硬编码，确定性承诺）

**设计理由（SSOT 合规）**：
- **不引入动态阈值**：阈值保持硬编码，保证写时判定结果的确定性
- **算法本身智能化**：通过权重设计让核心动作词和实体词在相似度计算中贡献更大，而非叠加外部判断规则
- **下沉到工具层**：关键词提取和相似度计算统一在 `segmenter.ts` 工具层实现，避免业务逻辑层重复实现

> **说明（设计约束，2026-08-27 随 A1 更新）**：取代检测的意图是"type 相同且主题相关"，但实际按**主题相关**（加权 Jaccard 重叠率的确定性判定）执行，type 不参与。早期原因是宿主持久化层不持久化 `metadata`，type 无法作为**持久化**判定条件；A1 已把 `summaryType` 提升为**顶层持久化字段**（宿主 SQLite 已加 `summary_type` 列），type 现可读——但**取代检测仍保持主题相关判定**，因为"type 相同 ≠ 主题相关"：同一主题不同类（如 preference 覆盖 decision）是否算取代需语义定夺，当前"主题相关"是已知取舍（跨类型可能被取代）。升级条件：若实测出现"跨类型误取代"困扰，再加"type 相同"前置过滤——当前不预埋（符合验证后固化纪律，与 `roundSummaryGenerator.ts` 旁路注释一致）。

**SSOT 自检**：此设计**不新增存储层**（仍复用 round-summary）、**不新增后台系统**（是 Reflect 的一步，与"生成摘要"同构，fire-and-forget）、**不新增记忆关系图**（仅一个布尔标记 + 指针）。它是**效率挪移**——冲突消解从读路径（高频、每次召回都猜）移到写路径（低频、每轮一次判断），写一次定、读时确定性过滤，比"读时靠 LLM 聚合猜"更符合"确定性优先"。

**附带收益**：写时取代压缩同类摘要后，读路径聚合量更少，**缓解高频召回场景的重复聚合成本**（"每次召回当场聚合"在高频场景有重复成本，本设计从源头减少待聚合条目）。

**保真声明**：摘要是**有损线索**，不承诺捕捉全部原始信息；保真由 `traceSummary` 回溯原始对话兜底。当记忆可靠性成为实测瓶颈，再评估"摘要 + 原始对话"双轨召回。当前阶段（写作等轻量场景）摘要保真度足够，此为**有意声明**，非缺陷。

---

## 六、闭环验证

### 6.1 逻辑完整性

```
输入 → 处理 → 输出 → 持久化 → 召回 → 注入上下文
 │                                          │
 └────────── 下一轮闭环 ────────────────────┘
```

| 步骤 | 谁负责 | 产出 | 是否必需 |
|------|-------|------|---------|
| 用户输入 | Loop | `roundId` 分配 | 是 |
| LLM 处理 | Agent | 回复 + 调用 | 是 |
| 生成摘要 | RoundSummaryGenerator | `source='round-summary'` 记忆 | 是 |
| 持久化 | IMemoryStorage | 存储摘要 | 是 |
| 召回（分层分轨 + 互斥过滤） | `recall()` | 相关摘要列表（分层分轨召回，排除正文已加载轮次） | 是 |
| 注入上下文 | `prepareChatContext` | 组装后的 system prompt | 是 |
| 溯源 | `trace_summary` 工具 | 原始对话记录 | 是（LLM 可选调用） |

**闭环验证**：每个环节的产出是下一个环节的输入，不存在断裂或外部依赖。

### 6.2 最小性验证

**能否删除某个组件而不破坏系统？**

| 组件 | 删除后果 | 结论 |
|------|---------|------|
| `RoundSummaryGenerator` | 无记忆产生，系统失去跨窗口回忆能力 | ❌ 不可删除 |
| `recall()` | 上下文注入无记忆，系统每轮都是"全新对话" | ❌ 不可删除 |
| `trace_summary` 工具 | LLM 无法追溯摘要来源，但核心循环不受影响 | ✅ 可删除（体验降级，非功能断裂） |
| 互斥排除 | 正文与摘要可能重复进入上下文，浪费 token | ✅ 可删除（体验降级，非功能断裂） |
| `isModified` | 人工修改标记无法提示"与原文可能不一致"，仅体验降级 | ✅ 理论上可删（当前保留，成本低） |
| `isTraceable` | ~~溯源/不可溯源标记~~（2026-08-28 已删除：写死 `true` 无行为消费者） | ✅ 已删除 |

**核心依赖链**：`RoundSummaryGenerator → IMemoryStorage → recall() → prepareChatContext`

这条链路上只有 3 个组件，不存在冗余。

### 6.3 单一真理源验证

问三个问题：

1. **这套逻辑是否只在某个场景下生效？** — 否。`RoundSummaryGenerator` 在所有场景（对话、Loop、Agent 间通信）中一致工作。
2. **去掉某个场景的特殊处理，核心逻辑是否依然完整？** — 是。没有场景特化分支。
3. **这个功能的实现，是否需要在最小单元之外引入新机制？** — 否。所有功能都在 turn 框架内实现。

三个问题答案均为"否"，设计未偏离单一真理源。

### 6.4 循环依赖验证

系统中有两个潜在循环依赖：

**A. 理解输入 vs 角色包切换**（解决路径，见角色包体系方案 v0.13 手动切换设计）
- 第一阶段：原始理解（不依赖角色包），提取触发词
- 确定性匹配：触发词 → 角色包（正则匹配，不依赖语义）
- 第二阶段：在角色包视角下深度理解

**B. 摘要生成 vs 上下文组装**（不存在循环依赖）
- 摘要生成在 `postProcess` 阶段，是上一轮闭环的产物
- 上下文组装在 `prepareChatContext` 阶段，消费已有的摘要
- 两者时间解耦，中间隔了 IMemoryStorage

### 6.5 设计约束总结

1. **摘要生成在 Reflect 阶段完成**——不阻塞主流程，异步写入。
2. **摘要类型由 LLM 在生成时自动判断**——不引入独立分类器，不增加额外 LLM 调用。
3. **分层分轨召回**——会话内（L1）和会话外（L2）分层，每个 summaryType 独立轨道（§4.1-§4.3）。type 参与召回策略，但不参与排序。
4. **`traceSummary` 工具可选调用**——上下文组装时自动注入最相关摘要，不强制 LLM 使用。
5. **`traceSummary` 返回内容受规模控制**——最多 5 条消息，单条 2000 字符。
6. **召回上限有界**——保证 token 有界，无需聚合机制。
7. **互斥窗口 N ≡ 上下文加载轮数**——正文与摘要不重复进上下文（§4.7）。当前以 `recentRounds` 固定 N 轮落地；目标态「动态轮数」（轮数按上下文预算派生、互斥窗口跟随实际注入轮数），`recentRounds` 键**直接删除**——见 [role-pack-spec.md §上下文预算装配](role-pack-spec.md)。
8. **配额分层**：记忆与摘要分别有 token 配额，避免一方挤占另一方。`prepare.memoryRecallQuota`（绝对 token 配额）**直接移除**，由 `memoryRecallPercent`（角色包 L2，cap 百分比）取代——见 [role-pack-spec.md §上下文预算装配](role-pack-spec.md)。摘要配额键为草案，MVP 阶段摘要复用同配额或由内核默认上限约束，角色包后置时再以独立键定型。
9. **治理简化**——去掉 L0-L3 四层治理，只保留 supersede（写时取代）+ boost（召回+0.05）。摘要已压缩，衰减收益低。

---

## 七、最终形态（总结）

**一句话**：摘要单轨，分层分轨，组内时间 + 相关性排序，supersede 治理。

| 维度 | 设计 |
|------|------|
| **记忆模型** | 摘要单轨（round-summary，唯一自动轨；会话级摘要归 SessionMeta） |
| **召回方式** | 单一召回入口（recall 函数） |
| **分层** | L1 会话内优先于 L2 会话外 |
| **分轨** | preference 进池（不经检索，有查询意图时）、intent 不进池、其余语义召回进池；cap 内靠排序分配，`minSemanticShare` 可选防挤占（默认 0） |
| **排序** | 分层分轨（L1 会话内优先 L2）+ 组内时间（createdAt 升序）+ 语义相关性（cap 内分配） |
| **治理** | supersede（写时取代）+ boost（召回+0.05） |

**详细说明**：

- **摘要即记忆本体**：写入（RoundSummaryGenerator + type 标签）→ 召回（分层分轨 + 互斥过滤）→ 治理（superseded 取代）闭环成立，无独立洞察提炼层。
- **分层分轨召回**：会话内（L1）和会话外（L2）分层，每个 summaryType 独立轨道（preference 进池（不经检索，有查询意图时）、intent 不进池、其余语义召回进池），L1 全部优先于 L2；cap 内分配靠排序，`minSemanticShare` 可选防挤占（默认 0，未开放为角色包键，见 §4.3.1）。
- **type = 语义标签 + 召回策略**：type 参与召回策略（决定哪些轨道进池/不进池），但不参与排序。排序由分层规则（L1 优先于 L2）、组内时间（createdAt 升序）与语义相关性（cap 内分配）决定。
- **治理简化**：去掉 L0-L3 四层治理，只保留 supersede（写时取代）+ boost（召回+0.05）。摘要已压缩，衰减收益低。
- **memoryAdded 事件由 round-summary 发射**——作为"新记忆产生必通知"的出口契约。
- **会话级摘要归会话记录存储**：SessionArchiver 只更新 `SessionMeta`（summary/keyTopics/autoName），不写 `source='content'` 记忆；`content` 为**历史残留 source**——无自动生产路径，`memoryInspector.writeUpsert` 仅能编辑已有记忆（无新建入口），已清出 `GOVERNANCE_SOURCES`（见 §2.3，2026-09-09 剪枝定性）。

---

> **关联资源**：
> - [agent-design-philosophy.md](agent-design-philosophy.md) —— turn 公理
> - role-pack-spec.md —— 角色包标准（记忆相关键 SSOT）
> - [role-pack-spec.md](role-pack-spec.md) —— 角色包标准（L2 召回键作为**后置覆盖**，不阻塞本模块）
> - [memory-role-pack-boundary.md](memory-role-pack-boundary.md) —— 记忆系统 × 角色包边界收敛（设定记忆归角色包，记忆库 = 摘要记忆本体）
> - [ADR-021](../../.trae/decisions/ADR-021-memory-conflict-supersede-write-path.md) —— 记忆冲突消解（写路径取代检测，§5.3）
> - [ADR-023](../../.trae/decisions/ADR-023-context-cost-injection-defense-loop-convergence.md) —— 摘要成本重构（截断优先用 round-summary）+ 即时注入防御
> - `src/agent/managers/roundSummaryGenerator.ts` —— RoundSummaryGenerator 实现
>
> **模块边界**：本模块（摘要即记忆）是**内核基础，独立于角色包**——召回策略、互斥窗口 N、配额均由内核默认值驱动，可脱离角色包单独运行与测试。角色包 L2 召回键（`memoryRecall`/`summaryRecall` 等）是对本模块的**可选覆盖**，随角色包后置交付，不构成前置依赖（§4.6.1 / §4.7）。