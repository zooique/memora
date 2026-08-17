# 记忆即摘要：溯源式记忆架构设计

> **定位**：设计文档，描述"记忆即摘要"架构——以单轮摘要为唯一记忆单元，通过溯源标识实现记忆与对话记录的松耦合关联。
>
> **关联**：[agent-design-philosophy.md](agent-design-philosophy.md)（单轮问答闭环公理）· [mvp-scope.md](mvp-scope.md)（MVP 边界）

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
记忆系统 = 摘要 + 标签（summaryType）+ 粒度（轮次级/会话级）+ 溯源（roundId/sessionId）
```

**设计定论（2026-08-17）**：记忆系统**不是**"只剩 round-summary"的妥协产物，而是**设计本体**——记忆系统就是摘要记忆。摘要生成时自动打标签（`summaryType`），标签**平替**掉旧记忆系统的分类体系（insight/profile/work-projection 多类并存 → 一种摘要 + 五类标签）。标签是**纯语义分类**，不携带时效性（见 §3.2）。

### 2.2 设计推导

从 SSOT 公理出发——单轮问答闭环是最小单元：

```
一轮问答闭环 = 用户输入 + LLM 回复 + 轮次摘要
                  ↑                         ↑
              Trigger（外部输入）         Reflect（后处理）
```

每一轮闭环完成后，Reflect 阶段自然生成轮次摘要（1-2 句话）。这个摘要就是该轮产生的**唯一记忆**。没有独立的提炼层——记忆不是"从摘要中提炼出来的"，而是**摘要本身就是记忆**。

**两级粒度（摘要模型的完整形态）**：

```
记忆系统 = 摘要记忆
│
├─ round-summary  轮次级摘要（每一轮对话一条）
│    ├─ sessionName   会话 id（YYYY-MM-DD-会话名）
│    ├─ roundId       问答闭环 id（本轮唯一）
│    ├─ summaryType   标签（preference/decision/fact/intent/general）
│    └─ 溯源：roundId + sessionId → 回溯本轮原始对话
│
└─ content  会话级摘要（整段会话提炼一条）
     ├─ sessionName   会话 id（溯源到整段会话）
     ├─ summaryType   标签（会话级综合多为 decision）
     └─ 溯源：sessionName → 回溯整段会话
```

round-summary 与 content **同属摘要模型、粒度不同**（轮次级 vs 会话级），不是两套系统。`traceSummary` 双标识溯源（`builtinToolHandlers.ts`）让每条摘要可回溯到原始对话。

### 2.3 架构

```
重构前：对话记录 → 轮次摘要 → 长期记忆（三层）
重构后：对话记录（窗口级，仅展示） + 轮次摘要（全局，即唯一记忆）
```

> **实现状态（如实声明）**：上图为**目标态**。用户画像层（`UserProfile` + `userFactExtractor` + `archiveProfileFacts`）**已于 2026-08-14 收敛移除**——画像收敛为 `round-summary` 的 `type=preference` 标签（§3.2）；洞察层（`InsightExtractor` + `archiveInsight`）亦于 **2026-08-14 移除**——其能力被 round-summary 吸收，记忆收敛为**单轨**（唯一记忆单元 = round-summary，见 §七）。当前系统即此目标态。`traceSummary` 溯源已接对话记录（§四/§4.5 已实现），对话记录作为溯源兜底的运行依赖（§5.2）。
>
> **content 融入（2026-08-17）**：`SessionArchiver` 写入的会话级摘要（`source='content'`）本就是摘要模型的一部分——它是**会话 id 对应的摘要记忆**（粒度=会话级，无 roundId，仅 sessionName 溯源）。已补 `summaryType` 标签与 `sessionName` 结构化字段、`isTraceable`，与 round-summary 同为「摘要 + 标签 + 粒度」统一模型。详见 [memory-role-pack-boundary.md](memory-role-pack-boundary.md) 与 [ADR-025](../.trae/decisions/ADR-025-memory-role-pack-boundary.md)。

> 注：`archiveCoordinator` 中的 `archiveRoundSummary` 已不存在（round-summary 改由 RoundSummaryGenerator 在 postProcess 直接生成），§七 该项实际已达成。

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
│  isTraceable: boolean       // 可溯源标记        │
│  isModified:  boolean       // 手动修改标记      │
└──────────────────────────────────────────────────┘
```

写入 `IMemoryStorage`，`source='round-summary'`。这是系统**轮次级**的记忆产生层——洞察层/画像层已于 2026-08-14 收敛移除，当前即此目标态。**写入型 source 共两类**：`round-summary`（轮次摘要，本层）+ `content`（会话归档，[sessionArchiver.ts](../../src/agent/managers/sessionArchiver.ts) 写入，承载会话级综合提炼，见 §7）；`PROFILE` 仅保留为存量数据治理，不再有新写入。

### 3.2 摘要类型（SummaryType）— 语义标签

摘要携带类型标签，它是**纯语义分类**——描述"这条摘要是什么"，平替旧记忆系统的分类体系。类型由 LLM 在摘要生成时自动判断。

| 类型 | 用户语义 | 说明 |
|------|---------|------|
| `preference` | "我是谁"（用户偏好） | 长期有效的用户身份 |
| `decision` | "我决定了什么" | 决策锚点 |
| `intent` | "我计划什么" | 用户意图/计划 |
| `fact` | 客观事实 | 事实陈述 |
| `general` | 一般对话（默认） | 兜底分类 |

**设计要点（2026-08-17 定论）**：
- **type 不携带时效性**。记忆是否有效由「语义状态」判定（superseded 写时取代 + score 衰减自然沉底），不由时间流逝判定——用户久未使用不构成记忆过期的理由。
- 类型继承自原有洞察系统的分类思路，复用既有分类体系，不引入新机制。
- **排序由「会话窗口 + 时间」两个正交维度构成**（§4.4），类型不参与排序。
- 类型隐含价值层级——`preference`/`decision` 天然比 `general` 更有记忆价值，价值通过召回时的相关性排序自然体现，无需独立的 quality 评分字段（避免与 type 信息冗余）。

### 3.3 溯源链接

每个摘要通过 `sessionName + roundId` 链接回原始对话记录：

```
摘要 → 对话记录
  │         │
  │    sessionName 定位到窗口
  │    roundId     定位到具体轮次
  │
  └── 可溯源：isTraceable = true，完整对话可回溯
  └── 不可溯源：isTraceable = false，原对话已删除
```

溯源是**软链接**——对话记录删除时，摘要保留，仅标记 `isTraceable = false`。

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

## 四、召回机制

### 4.1 召回流程

```
外部输入（Trigger）
    ↓
1. 语义召回：关键词 + 语义双通道召回，取相关性 top-N
   （hybridMerge：向量相似度 0.6 + 记忆 score 0.4，type 不参与过滤）
    ↓
2. 互斥排除：排除该轮正文已在上下文中的摘要
   （当前会话最近 N 轮，正文已作为对话历史完整加载）
    ↓
3. 排序：同会话窗口优先 → 跨会话；组内按 createdAt 升序
   同窗口优先保证上下文连续性；时间升序让 LLM 自然识别"最近偏好"
```

**核心设计（用户方案，2026-08-14 定案）**：
- 排序由「会话窗口 + 时间」两个正交维度构成（见 §4.4）；type **不参与过滤、不参与排序**，是纯语义标签（§3.2）
- 三个步骤中，步骤 2 是过滤（决定召回哪些），步骤 3 是排序（决定呈现顺序）
- 自然遗忘（2026-08-17 定论）：记忆是否有效由**语义状态**判定——superseded 写时取代（ADR-021）+ score 衰减自然沉底，**不用时间窗硬过滤**（见 §4.2）

### 4.2 差异化召回（按 type）— 已移除

> **2026-08-17 定论**：type 时间窗口差异化召回**已废弃**。原设计为 `intent`/`general` 设 7 天窗口，理由是「计划过期避免干扰」「低价值降噪音」——但这是**用时间代理语义状态**的读时猜测，违反 ADR-021「写时定、不读时猜」纪律，且误伤「用户久未使用但记忆仍有价值」的场景。
>
> **替代机制（自然遗忘，哲学§8）**：
> - **superseded 写时取代**（ADR-021）：计划完成/被覆盖 → 旧摘要被标记取代 → 不再作为当前事实注入；
> - **score 衰减**（decayScheduler）：久不访问的记忆分数沉底 → 相关性排序自然排不到前面；
> - **相关性排序**（hybridMerge）：低相关/低分记忆本就进不了 top-N 召回预算。
>
> 三者共同保证「低价值记忆自然退出召回面」，无需 type 时间窗。type 回归纯语义标签（§3.2）。

### 4.2.1 角色包召回开关 × type 标签（两层协作）

角色包召回开关与 type 标签是**两层不同职责**，不冲突：

- **角色包开关（角色级约束，作用于召回前）**：`prepare.memoryRecall`（full/limited/none）决定"是否召回、召回多少"；`prepare.summaryRecall`（on/off）决定"是否召回摘要"。二者是**总开关**。
- **type 标签（召回内呈现，作用于召回后）**：在开关放行后，标签用于摘要的组织/展示（§3.2），不驱动过滤与排序。

协作语义：

- 角色包设 `summaryRecall: off` 时，该角色**关闭摘要注入**（不把历史摘要拼进上下文），但 `traceSummary` 溯源工具与全局记忆存储不受影响——这是**角色级约束**，仅影响该角色的召回，不污染全局记忆。
- 角色包设 `memoryRecall: none` 时，该角色的记忆召回整体关闭，摘要注入因无召回输入而自然不执行。
- **未配置时用内核默认**（默认 `full` / `on`）——角色包后置期间由内核默认值驱动，记忆模块行为不依赖角色包是否接入。

### 4.3 摘要与正文的互斥

**问题**：同一轮对话的正文和摘要不应同时进入上下文。若正文已作为对话历史全量加载，再注入该轮摘要就是重复信息，浪费 token 且干扰 LLM 判断。

**判定标准（确定性，非运行时状态）**：摘要的 `sessionName + roundId` 若属于**当前会话的最近 N 轮窗口**，则放弃搜索该摘要。

- **N 的定义**：N ≡ 上下文固定加载的完整对话轮数。正文完整加载多少轮，互斥窗口就是多少轮——两者严格相等，保证"该轮摘要被排除 ⟺ 该轮正文确实在上下文中"。
- **N 的来源与默认值**：N 由**内核上下文装配配置提供默认值**（内核默认 N），保证记忆模块独立自洽、不依赖外部未定型键即可运行；角色包可通过 L2 策略层"最近轮次数"（`prepare.recentRounds`）**覆盖**该值（见 agent-design-philosophy.md §14.3），互斥窗口复用同一来源，不新增独立参数。**未配置角色包覆盖时，使用内核默认 N**——角色包覆盖能力随角色包后置交付，不阻塞记忆模块先行落地。
- 其他会话的摘要，或当前会话超出最近窗口的摘要，正文未加载 → 保留召回。

**为什么不用"正文是否已注入"作为判定**：那会引入召回与正文注入的时序耦合（谁先执行说不清），且依赖运行时状态，违反单一真理源。最近 N 轮窗口是纯确定性判定，只依赖摘要自身的 `sessionName + roundId`，与注入时机解耦。

**互斥发生在"回答前 - 拉取记忆"阶段的 recall() 内部**：调用方（agent 层）先构造"已加载正文集合"（当前会话最近 N 轮的 roundId），作为 `excludeRoundIds` 传入 recall()；recall() 在 `hybridMerge` 排序取 limit **前**过滤命中该集合的摘要。

**为什么过滤在 recall() 内取 limit 前（而非召回后）**：若在召回结果之后过滤，被排除的当前会话最近 N 轮摘要会**挤占 top-limit 预算**——单会话聚焦时它们最相关、排最前，跨会话记忆被挤到 limit 之外、永远取不到，导致跨会话召回失效。前置到取 limit 前过滤，剩余候选自然补位，跨会话记忆能进入 top-limit。`excludeRoundIds` 作为可选过滤条件由调用方传入，recall 保持纯检索、不查询会话状态（与 `excludeSources` 同语义），缺省为空集合时行为与纯检索完全一致。

### 4.4 排序：同会话窗口优先 + 时间

召回结果呈现顺序由**两个正交维度**构成，任何维度都不被类型覆盖：

**维度一：会话窗口优先（上下文连续性）**
- 当前会话（`sessionName` 匹配）的摘要排在最前，其次是跨会话的全局记忆
- 同窗口优先体现"当前对话的上下文连续性"——正在聊的话题相关记忆优先呈现
- 这一步在互斥排除（§4.3）之后执行：当前会话最近 N 轮的摘要已被排除，这里"同窗口"指**超出 N 轮的当前会话历史摘要**，不会与正文重复

**维度二：时间（组内 createdAt 升序）**
- 在同一会话窗口组内，按 `createdAt` 升序排列，LLM 自然识别"最近偏好"
- 时间排序在会话窗口组内生效：同窗口内时间近的在前；跨窗口（跨会话）记忆不因 type 被挤掉——type 是纯语义标签，不参与过滤与排序（§3.2）

**为什么不按"类型价值"排序**：若让 `decision`/`preference` 因价值高而强制排在前面，就会让类型重新参与排序，破坏上述两个正交维度，并导致"远古高价值"压过"近期低价值"的呈现失真。类型价值通过相关性召回（hybridMerge）与 superseded/衰减（自然遗忘）自然表达，不参与呈现顺序。

### 4.5 LLM 溯源工具

向 LLM 暴露 `traceSummary(sessionId, roundId)` 工具，让 LLM 在需要时回溯到原始对话：

```
LLM 持有摘要：用户偏好简洁UI（from session-abc, round-5）
    ↓ 需要更多上下文
LLM 调用 traceSummary('session-abc', 'round-5')
    ↓ 返回原始对话记录
LLM 获得完整上下文
```

工具暴露但不强制使用——上下文组装时自动注入最相关的摘要，LLM 决定是否进一步溯源。

### 4.6 traceSummary 返回格式与规模控制

```
{
  "sessionId": "session-abc",
  "roundId": "round-5",
  "summary": "该轮对话的摘要内容",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." },
  ],
  "isTruncated": true,
  "isTraceable": true
}
```

**限制**：最多 5 条消息，单条 2000 字符。

**降级**：无 roundId 时返回整个会话摘要；对话已删除时返回"不可追溯"。

### 4.7 检索侧工程（rerank / 召回深度 / 格式）

召回质量不只由"存了什么"决定——**检索侧（召回后处理）优化收益常高于摄取侧**（2026 行业实证：检索深度 +4.2%、上下文格式化 +2.0%、query bias 修正 +1.4%，均高于摄取侧 chunking +0.8%）。当前召回已具备：

- **rerank（重排序）**：召回结果在最终排序前先经相关性重排，剔除低相关噪声（已实现）。
- **同会话窗口优先**：`sessionName` 匹配当前会话的摘要优先，跨会话记忆次之（§4.4 维度一，已实现，见实现清单）。

**远期候选（非承诺，不预埋）**：
- **query 改写**：把用户输入改写为更适合检索的查询。
- **召回深度（top-k）调优**：按场景调整召回条数上限。
- **召回格式微调**：调整摘要注入上下文的呈现格式。
- **上下文检索（contextual retrieval，2026-08-15 排雷吸收）**：召回命中某摘要后，若其**相邻轮次**（同 `sessionName`、`roundId` 前后 ±N 条）存在高相关摘要，在预算内一并召回，缓解"孤立摘要导致上下文断裂"。边界约束：① 不新增存储层（复用 round-summary 按 roundId 邻接查询）；② 扩展条数设上限（±2 条）；③ 总召回仍受增量召回 token 预算约束（≤10% 上下文窗口）；④ 与互斥排除（§4.3）兼容——相邻但正文已加载的轮次仍排除。
- **superseded 摘要物理清理（2026-08-15 审查发现）**：被取代的摘要（`supersededBy` 标记）当前只被 recall 过滤（§5.4）、可经 `traceSummary` 回溯，**无物理清理**——长期会话会累积被覆盖的历史摘要。若未来需要回收存储，设计方向：按 superseded 时长（如 30 天）周期性软删除 → 回收站保留期 → 物理清理；边界约束：① 保留 `traceSummary` 回溯能力至清理前；② 清理不影响活跃摘要的取代链；③ 复用现有 `purgeExpired` 回收站机制，不新增清理管线。当前不实现（存储累积非瓶颈，属"软删除 + 可回溯"的既有设计权衡）。
- **召回保底（recall fallback，2026-08-15 评估采纳）**：当语义召回结果过少（低于 `minFallback`）时，用最近记忆补足，保证 LLM 每轮至少获得阈值数量的记忆，避免"零召回/极少召回"导致完全无记忆可依。**定位是不可删除的**下限保障，非"项目延续"特化。设计要点：① **条件触发**——仅 `recall()` 结果不足 `minFallback` 才补，语义召回充足时不动作（豆包类话题切换场景因补足量小且排语义命中之后，噪音受控可接受）；② **数据源复用现有空查询通道**——`storage.search('', shortfall)` 按 score 降序取最近记忆（score 已含 boost + 衰减，天然=最近常用），零新增存储接口；③ **补足项排语义命中之后**，不抢占相关性结果；④ 参数 `prepare.minFallback`（默认 2），宿主可设 0 彻底关闭；⑤ 与互斥排除（§4.3）兼容——补足项同样去 `superseded`。区别于"无条件固定注入最近会话摘要"（已放弃）：后者绕过相关性过滤必然污染，本机制是**召回不足才兜底**，符合单一真理源。

写作等轻量场景当前用默认即可，待检索质量成为实测瓶颈再评估。

---

## 五、生命周期

### 5.1 删除规则

| 操作 | 对摘要的影响 | 说明 |
|------|------------|------|
| 对话记录删除 | `isTraceable = false` | 摘要保留，但标记不可溯源 |
| 摘要手动修改 | `isModified = true` | 标记已修改，`isTraceable` 保持不变 |
| 摘要删除 | 该轮记忆从召回视野消失 | 语义即"删记忆"。源对话记录仅作为展示保留，供用户回溯，不再参与运行召回 |

### 5.2 设计理由

- **对话记录是"展示层 + 溯源兜底的运行依赖"**：给用户翻看历史用；同时被 `traceSummary` 工具读取用于回溯原始对话（溯源保真）。**召回/聚合不依赖它**（摘要即记忆），但溯源工具依赖它——两者不冲突。
- **摘要是"记忆层"**：是系统召回/聚合的核心依赖。因此**删除摘要 = 删除记忆**，源对话记录仅作为展示 + 溯源保留供用户回溯，其信息价值低于摘要，不再参与运行召回。
- **打标而非硬删**：保留数据完整性，防止误删可通过恢复标记找回。
- **`isModified` 与 `isTraceable` 独立**：修改摘要不代表原始对话不存在，两者不应耦合。

#### 5.2.1 可追溯性边界（2026-08-14 融合 · 2026-08-15 建议B落地）

> **设计说明**：明确 memora 可追溯性的**边界**——它服务于"对话内容"的可回溯，不承诺"模型每次看到的完整上下文"的可重建。这是从 DeepSeek Harness"模型可见即已记录"（append-only 事件溯源）汲取思想后收敛的结论：**抄思想（可追溯性目标），不抄机制（事件溯源存储）**。

**当前追溯范围（已实现）**：

- **说了什么（对话内容）**：`trace_summary` 工具经 `loadRawRoundMessages` 回溯原始对话（§4.5/§4.6）。
- **记忆来源（摘要溯源）**：round-summary 通过 `sessionName + roundId` 软链接回原始对话（§3.3）。

**明确不追溯（边界声明）**：

- **"模型看到了什么"（每次请求的完整上下文：系统提示、召回摘要、装配结果）** 不进入追溯范围。它是**可观测性诉求**，而非记忆诉求——由 **ITracer span** 承载（已落地：`llm.call` span 记录 `systemPromptHash`，`recall.recall` span 记录 `attachedMemoryCount` + `attachedMemoryFingerprint`），**不入 sessionStore**。理由：
  1. **哲学一致**：架构哲学 §8"自然遗忘优于完美记忆"——记录"模型看到了什么"的全量快照会导致存储无界膨胀，与 memora 轻量定位冲突。
  2. **职责分离**：对话记录是"展示 + 溯源"（记忆系统职责），上下文快照是"调试/评估"（可观测性职责，ITracer），两者不混层。
  3. **投入产出**：memora 已有关键链路（摘要 → 原始对话 → trace_summary）覆盖可追溯的绝大部分价值；"模型看到了什么"仅在调试/评估场景需要，走 ITracer 即有界、可选。

**建议B落地说明（2026-08-15）**：上述 ITracer 承载已实现，机制/策略分离——
- **系统提示指纹**：`llm.call` span 的 `systemPromptHash` = 最终发给模型的全部 system 消息内容（persona + 规则 + 技能 + 召回注入）的 SHA-256 指纹，由 [utils/hash.ts](../../src/utils/hash.ts) 的 `sha256Fingerprint` 纯函数生成（同时复用于 [workProjection.ts](../../src/agent/managers/workProjection.ts) 的文件 hash，消除重复实现）。
- **附着记忆指纹**：`recall.recall` span 的 `attachedMemoryCount` / `attachedMemoryFingerprint` = 附着进上下文的记忆条数 + 记忆 ID 集合指纹（[loop.ts](../../src/agent/loop.ts) 注入点埋点）。
- **边界保持**：只记录 hash、不记录内容；宿主未注入 Tracer（NOOP）时不计算指纹（零开销边界）；span 属性由宿主自行采集/落盘/展示，内核不新增任何存储。

**与 §5.1 删除规则的衔接**：`isTraceable = false` 语义保持——对话记录删除时，摘要仅标记不可溯源，不因"可追溯性目标"而承诺永不删除。**memora 的追溯是软追溯（允许失效降级），不是 Harness 式的强事件溯源（永不删除）**——这是有意取舍，非缺陷。

### 5.3 溯源标记不可逆

`isTraceable = false` 后不恢复，保证数据一致性。

### 5.4 记忆维护（写路径取代检测）

**问题**："摘要即记忆"是 append-only——每轮一条摘要。长期运行会出现三类"记忆腐烂"：同一事实重复表达、旧决策被新决策覆盖、过时事实仍被召回。**时间排序解决"呈现顺序"，解决不了"哪个决策覆盖哪个"**（覆盖是结构信息，不是时序信息）——若全靠 LLM 在召回时按时间序猜，冲突消解依赖运行时判断，违反"确定性优先"。

**设计决策（2026-08-13 定案）：写路径取代检测**——把冲突消解从"读时猜"移到"写时定"，落在**闭环后处理（Reflect）**层面：

- 每轮闭环完成后，生成摘要的同时，**检测新摘要与近期同类摘要是否疑似覆盖**；若覆盖，给旧摘要打确定性 `superseded` 标记并指向新摘要（**非删除**，保留可回溯）。
- 读时（召回）按确定性过滤：`superseded` 摘要不再作为当前事实注入；需要历史时经 `traceSummary` 回溯。
- **判断触发条件**：仅当新摘要与同会话旧摘要"主题相关"（关键词 Jaccard 重叠率 ≥ 阈值）时才触发取代，非每轮必做。

> **实现状态（如实声明）**：设计意图是"type 相同且主题相关"，但**实现未按 type 判定**——`supersedeSimilar` 只做"主题相关"（关键词 Jaccard 重叠率的确定性判定，见 roundSummaryGenerator.ts），type 不参与。原因：宿主持久化层不持久化 `metadata`，`getBySource` 读回的摘要无 `metadata.summaryType`，type 无法作为**持久化**判定条件（仅 id 是持久化字段）。此为实现简化，非缺陷；若未来宿主持久化 metadata，可升级为"type 相同"前置过滤。

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
| 召回（语义 + 互斥过滤） | `recall()` | 相关摘要列表（双通道召回，排除正文已加载轮次） | 是 |
| 注入上下文 | `prepareChatContext` | 组装后的 system prompt | 是 |
| 溯源 | `trace_summary` 工具 | 原始对话记录 | 是（LLM 可选调用） |

> **实现状态（如实声明）**：上表所列**均已落地**。"双通道召回"（[recall.ts](../../src/memory/recall.ts) hybridMerge）、"互斥过滤（排除正文已加载轮次）"（[agent.ts](../../src/agent/agent.ts) `recallAndInject`）、"溯源返回原始对话记录"（[builtinToolHandlers.ts](../../src/agent/builtinToolHandlers.ts) `loadRawRoundMessages`）均已实现。仅"互斥窗口 N 的角色包 `recentRounds` 覆盖"随角色包后置接入。

**闭环验证**：每个环节的产出是下一个环节的输入，不存在断裂或外部依赖。

### 6.2 最小性验证

**能否删除某个组件而不破坏系统？**

| 组件 | 删除后果 | 结论 |
|------|---------|------|
| `RoundSummaryGenerator` | 无记忆产生，系统失去跨窗口回忆能力 | ❌ 不可删除 |
| `recall()` | 上下文注入无记忆，系统每轮都是"全新对话" | ❌ 不可删除 |
| `trace_summary` 工具 | LLM 无法追溯摘要来源，但核心循环不受影响 | ✅ 可删除（体验降级，非功能断裂） |
| 互斥排除 | 正文与摘要可能重复进入上下文，浪费 token | ✅ 可删除（体验降级，非功能断裂） |
| `isTraceable`/`isModified` | 摘要失去溯源/修改标记，但与核心召回无关 | ✅ 可删除（信息降级，非功能断裂） |

**核心依赖链**：`RoundSummaryGenerator → IMemoryStorage → recall() → prepareChatContext`

这条链路上只有 3 个组件，不存在冗余。

### 6.3 单一真理源验证

问三个问题：

1. **这套逻辑是否只在某个场景下生效？** — 否。`RoundSummaryGenerator` 在所有场景（对话、Loop、Agent 间通信）中一致工作。
2. **去掉某个场景的特殊处理，核心逻辑是否依然完整？** — 是。没有场景特化分支。
3. **这个功能的实现，是否需要在最小单元之外引入新机制？** — 否。所有功能都在单轮闭环框架内实现。

三个问题答案均为"否"，设计未偏离单一真理源。

### 6.4 循环依赖验证

系统中有两个潜在循环依赖：

**A. 理解输入 vs 角色包匹配**（已解决，见角色包粘性匹配设计）
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
3. **排序由「会话窗口 + 时间」构成**——同会话窗口优先，组内按 `createdAt` 升序；type 是纯语义标签，不参与过滤与排序（§3.2）。
4. **溯源标记不可逆**——`isTraceable = false` 后不恢复。
5. **`traceSummary` 工具可选调用**——上下文组装时自动注入最相关摘要，不强制 LLM 使用。
6. **`traceSummary` 返回内容受规模控制**——最多 5 条消息，单条 2000 字符。
7. **召回上限有界**——保证 token 有界，无需聚合机制。
8. **互斥窗口 N ≡ 上下文固定加载轮数**——由内核上下文装配提供默认值，角色包 L2 `recentRounds` 可覆盖，正文与摘要不重复进上下文（§4.3）。
9. **配额分层**：记忆与摘要分别有 token 配额，避免一方挤占另一方。`prepare.memoryRecallQuota`（角色包 L2）冻结；摘要配额键为草案，MVP 阶段摘要复用同配额或由内核默认上限约束，角色包后置时再以独立键定型。

---

## 七、实现清单

### 已完成

| 组件 | 文件 | 说明 |
|------|------|------|
| RoundSummaryGenerator | `src/agent/managers/roundSummaryGenerator.ts` | 每轮生成 `source='round-summary'` 记忆，含 type |
| roundId 追踪 | `src/agent/loop.ts` | `processUserInput` 入口分配 roundId |
| SessionMessage.roundId | `src/agent/types.ts` | 可选字段 |
| `trace_summary` 工具 | `src/agent/builtinTools.ts` + `builtinToolHandlers.ts` | LLM 可回溯原始对话 |
| 双通道召回（关键词 + 语义） | `src/memory/recall.ts` | 按相关性召回摘要（hybridMerge，type 不参与过滤） |
| 时间戳排序 | `src/agent/agent.ts` | `recallAndInject` 返回结果按 `createdAt` 升序（唯一排序键） |
| 装配 | `src/agent/assembler.ts` | RoundSummaryGenerator 注入到 Agent |

### 计划移除

| 组件 | 文件 | 理由 |
|------|------|------|
| InsightExtractor | `src/agent/managers/insightExtractor.ts` | 洞察层（每轮自动抽取长期记忆）已被 round-summary 的 type 分类吸收（preference/fact/decision），冗余移除 |
| insightExtracted 事件 | `src/utils/eventEmitter.ts` | 洞察移除后无发射方，事件一并移除 |
| archiveCoordinator 中的 archiveRoundSummary | `src/agent/managers/archiveCoordinator.ts` | 冗余，round-summary 直接在 postProcess 生成 |
| 设定记忆（persona/rule/skill）写入记忆库 | `src/memory/loader.ts` `STARTUP_SCAN_SOURCES` + `src/agent/managers/configManager.ts` CRUD | 设定记忆唯一归角色包内容层（L1），记忆库 = 摘要记忆本体——见 [memory-role-pack-boundary.md](memory-role-pack-boundary.md) §四（待迁出，非本模块已完成项） |

> **最终形态（2026-08-14 定案 + 2026-08-17 定论）**：聚焦 memora 内核，洞察层（InsightExtractor）**完整移除**，记忆收敛为**摘要单轨**：
> - **摘要即记忆本体**：写入（RoundSummaryGenerator + type 标签）→ 召回（双通道相关性 + 会话窗口/时间排序）→ 治理（superseded 取代）闭环成立，无需独立洞察提炼层。
> - **type = 纯语义标签**（2026-08-17）：不设时间窗口，自然遗忘由 superseded + score 衰减承担。
> - **memoryAdded 事件由 round-summary 发射**——替代洞察的"已沉淀"通知出口，保持内核"新记忆产生必通知"契约。
> - **SessionArchiver（content 会话级摘要）保留**——它是**会话 id 对应的摘要记忆**（2026-08-17 融入统一模型）：承载会话级综合提炼（关键决策/未解决问题/plan 快照），粒度（会话级）与 round-summary（轮次级）不同，非冗余；已补 `summaryType` 标签 + `sessionName` 结构化溯源 + `isTraceable`。
> - **代码已移除（2026-08-14）**：InsightExtractor 及其装配/自动抽取/手动 `archiveInsight`/`insight` getter/`insightExtracted` 事件从内核清除；`SOURCE_LABELS.INSIGHT` 标签与 role-pack `reflect.insightExtraction` 键 / `llm:insight` 能力一并移除，memora 不残留任何洞察层痕迹。

### 七·一 承诺 vs 实现状态对照（如实声明）

> 本节集中标注本文档各承诺的**真实落地状态**，避免"设计文档 = 已实现"的误读。`✅`=已实现，`⏳`=已决策/设计待实现（关联 ADR 待办）。

| 承诺 | 文档出处 | 实现状态 | 说明 |
|------|---------|---------|------|
| RoundSummaryGenerator（round-summary + type） | §3/§7 | ✅ | [roundSummaryGenerator.ts](../../src/agent/managers/roundSummaryGenerator.ts) |
| roundId 入口分配 + SessionMessage.roundId | §2.4/§3.4 | ✅ | [loop.ts](../../src/agent/loop.ts) |
| createdAt 升序（唯一排序键） | §4.4 | ✅ | [agent.ts](../../src/agent/agent.ts) `recallAndInject` |
| 同会话窗口优先（sessionName 优先 + 组内 createdAt 升序） | §4.4/§4.7 | ✅ | [recall.ts](../../src/memory/recall.ts) |
| 双通道召回（关键词 + 语义，type 不参与过滤） | §4.1/§4.2 | ✅ | [recall.ts](../../src/memory/recall.ts) hybridMerge |
| 互斥排除（正文已加载轮次不召回） | §4.3 | ✅ | [recall.ts](../../src/memory/recall.ts) `RecallOptions.excludeRoundIds` 过滤（N = 角色包 `prepare.recentRounds` 覆盖，未配置回退内核默认 `DEFAULT_RECENT_HISTORY_ROUNDS`=3） |
| traceSummary 返回原始对话（≤5 条/2000 字） | §4.5/§4.6 | ✅ | [builtinToolHandlers.ts](../../src/agent/builtinToolHandlers.ts) `loadRawRoundMessages`；未注入 sessionStore 时降级为摘要文本 |
| 写路径取代检测 superseded | §5.4 | ✅ | [roundSummaryGenerator.ts](../../src/agent/managers/roundSummaryGenerator.ts) `supersedeSimilar` + [recall.ts](../../src/memory/recall.ts) 过滤 `supersededBy` |
| 工具结果隔离 `<tool_result>` + 参数校验 + 返回净化 | （关联 ADR-023） | ✅ | [loop.ts](../../src/agent/loop.ts) `<tool_result>` 包裹 + 指令前缀；[toolExecutor.ts](../../src/agent/toolExecutor.ts) `sanitizeExternalText` 净化 |
| 截断优先用 round-summary | （关联 ADR-023） | ✅ | [contextManager.ts](../../src/agent/contextManager.ts) `roundSummaryLoader` 优先复用已存 round-summary，无已存才走 LLM |
| 洞察层移除（摘要即记忆单轨） | §2.3/§7 | ✅ | 洞察层（InsightExtractor）已移除（2026-08-14），round-summary 单轨；SessionArchiver 会话归档保留（非洞察） |

---

> **关联资源**：
> - [agent-design-philosophy.md](agent-design-philosophy.md) —— 单轮问答闭环公理
> - [mvp-scope.md](mvp-scope.md) —— MVP 能力边界
> - [role-pack-spec.md](role-pack-spec.md) —— 角色包标准（L2 召回键作为**后置覆盖**，不阻塞本模块）
> - [memory-role-pack-boundary.md](memory-role-pack-boundary.md) —— 记忆系统 × 角色包边界收敛（设定记忆归角色包，记忆库 = 摘要记忆本体）
> - [ADR-021](../.trae/decisions/ADR-021-memory-conflict-supersede-write-path.md) —— 记忆冲突消解（写路径取代检测，§5.4）
> - [ADR-023](../.trae/decisions/ADR-023-context-cost-injection-defense-loop-convergence.md) —— 摘要成本重构（截断优先用 round-summary）+ 即时注入防御
> - `src/agent/managers/roundSummaryGenerator.ts` —— RoundSummaryGenerator 实现
> - `tasks/归档/记忆即摘要升级方案-20260813.md` —— 实施计划与评审结论（已完结，归档）
>
> **模块边界（2026-08-13）**：本模块（摘要即记忆）是**内核基础，独立于角色包**——召回策略、互斥窗口 N、配额均由内核默认值驱动，可脱离角色包单独运行与测试。角色包 L2 召回键（`memoryRecall`/`summaryRecall`/`recentRounds` 等）是对本模块的**可选覆盖**，随角色包后置交付，不构成前置依赖（§4.2.1 / §4.3）。