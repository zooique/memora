# 记忆即摘要：溯源式记忆架构（现行形态）

> **定位**：内核记忆模块 SSOT 架构文档。描述"记忆即摘要"架构——以摘要为唯一记忆单元，通过溯源标识实现记忆与对话记录的松耦合关联。
>
> **关联**：[agent-design-philosophy.md](agent-design-philosophy.md)（turn 公理）· [role-pack-spec.md](role-pack-spec.md)（记忆键 SSOT）· [ADR-021](../../.trae/decisions/ADR-021-memory-conflict-supersede-write-path.md)（写路径取代）· [ADR-023](../../.trae/decisions/ADR-023-context-cost-injection-defense-loop-convergence.md)（摘要成本重构）· `src/agent/managers/roundSummaryGenerator.ts` · `src/agent/managers/memoryInspector.ts` · `src/memory/gcService.ts` · `src/memory/supersedeResolve.ts`

---

## 现状速览（先读这一段）

- **记忆单元 = round-summary**：一次外部输入 → 一个 turn → 一条摘要（`source='round-summary'`，`sessionName + roundId` 溯源）。无独立的洞察提炼层、无用户画像层。会话级摘要归 `SessionMeta`（随会话删除），不进记忆库。
- **现行召回 = `search_memories` 工具**（`memoryInspector.searchByKeyword`）：**纯关键词**、无向量/语义通道、无 `score`、无分层分轨排序。命中经 `supersededBy` 过滤（被取代的不返回）+ `excludeRoundIds` 互斥（正文已在眼前的轮次不重复返回）+ 截断 `limit`（默认 10）；`accessedAt` 仅作事实字段（命中刷新），不作主排序键。
- **治理 = 写路径取代（supersede）+ 悬空取代指针判定（消费侧）**：旧摘要被同 session 新摘要以加权 Jaccard ≥ 0.5 判定覆盖时，打 `supersededBy = 新摘要.id`（**非删除**，可回溯）。被取代摘要的替代物被移除（GC purge、宿主软删/物理删/过期清理、去重降级，任一路径）后指针悬空——**所有消费 supersededBy 的位置统一经 `supersedeResolve.hasActiveSuperseder` 判定**（目标不存在/非活跃即视为未取代），旧摘要**回退为当前版本**而非静默不可召回；判据与移除路径解耦，无需在移除点补收敛。
- **已退役（请勿按现行解读）**：`recall()` 编排函数、向量/语义通道（`vectorStore`/`embedding`）、`score` 字段、`minSemanticShare`/`memoryRecallPercent` 等记忆层 cap/召回键、`content` 源的记忆库写入、分层分轨召回（L1/L2 + cap 内分配 + 语义轨道保底）。这些于 2026-09-04 ~ 2026-09-18 经多轮"减法"整体删除（见附录 A）。旧档经 `parseMemory` 白名单构造自动剥离退役字段，无迁移脚本。

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

在有界召回（limit 10 + 关键词命中 + `accessedAt` 事实项）下，单次聚合成本可控，因此"少一个存储层"的收益大于"每次召回多一次推理"的成本。但**跨会话"用户是谁"的完整画像场景会退化**——这是有意为之的取舍，不是无代价的最优。

---

## 二、设计

### 2.1 核心公理

```
摘要就是记忆本体。
一切"记忆"都是摘要，而非独立的提炼层。
记忆系统 = 摘要 + 标签（summaryType）+ 粒度（轮次级）+ 溯源（roundId/sessionName）
```

**设计定论**：记忆系统**不是**"只剩 round-summary"的妥协产物，而是**设计本体**——记忆系统就是摘要记忆。摘要生成时自动打标签（`summaryType`），标签**平替**掉旧记忆系统的分类体系（insight/profile/work-projection 多类并存 → 一种摘要 + 五类标签）。标签是**纯语义分类**，不携带时效性（见 §3.2）。

### 2.2 设计推导

从 SSOT 公理出发——turn（问答闭环）是最小单元：

```
一次外部输入（问答闭环）= 用户输入 + LLM 回复 + 轮次摘要
                  ↑                         ↑
              Trigger（外部输入）         Reflect（后处理）
```

每次外部输入完成后，Reflect 阶段自然生成轮次摘要（1-3 句话）。这个摘要就是该次输入产生的**唯一记忆**。没有独立的提炼层——记忆不是"从摘要中提炼出来的"，而是**摘要本身就是记忆**。

**两级粒度**：**对话记忆仅 round-summary 一个自动轨**（轮次级）。会话级摘要不进记忆库——归会话记录存储 `SessionMeta`（summary/keyTopics），随 `deleteSession` 删除。

### 2.3 架构（当前形态）

```
对话记录（窗口级，仅展示 + 溯源兜底）
round-summary（轮次级，唯一记忆单元）
会话级摘要（SessionMeta.summary/keyTopics，随会话删除）
```

> **会话级摘要不进记忆库**：`SessionArchiver` 只更新会话记录存储 `SessionMeta`（summary/keyTopics/autoName），**不写任何记忆库 source**。`content` 为历史残留 source——无生产写入路径（`memoryInspector.writeUpsert` 仅治理页编辑已有记忆时复用，无新增入口），已从 `GOVERNANCE_SOURCES` 清空（2026-09-09 剪枝）。详见 [memory-role-pack-boundary.md](memory-role-pack-boundary.md) 与 [ADR-025](../../.trae/decisions/ADR-025-memory-role-pack-boundary.md)。

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

### 2.5 摘要触发 · 来源 · 粒度（定案）

> **恒定规则**：**「摘要 ↔ 外部输入 恒 1:1」——一次外部输入恰好产出一条 round-summary。**
>
> **构成**：loop 内部的 tool/反思 step 不是 turn（见 §2.4），不单独摘要；多 turn 任务编排已废弃，复杂任务收敛为**单 turn 内 step 循环**（task_table 动态规划）——无内部子 turn，摘要数量恒等于外部输入数。

- **来源**：一次外部输入 → 一个 turn → 答完即提炼该轮答案。
- **触发时刻**：turn「答完/收尾」即触发（非 tool step、非暂停边界）。对话 `wait` 态（答完等用户）同样答完即摘要——"结束指令"非此处触发条件。
- **硬中止（abort / 用户取消）**：不打完 → **不摘要**（残缺半成品不入记忆）；但已产出内容以 `[已中断]` 标记写进对话历史（保真留存，供 `traceSummary` 回溯）。历史保细节、记忆不收纳残缺，两者分离。
- **软暂停（requestPause，可续跑）**：暂停时**不立即摘要**；若后续续跑并真正答完 → 该轮**仍会**摘要。

> 该定案已由 `seed/orchestrator.ts` 落地：`runChat`/`runResume` 收尾经 `reflect(input, assistantContent)` 生成 round-summary；`reflect.summary='off'` 或生成器不存在 → 不摘要。

> **两级摘要防混淆（补充澄清）**：系统有**两轨摘要**，职责不同、互不顶替——
> - **round-summary（记忆轨）**：跨会话沉淀，即本 §2.5 规则对象。一次外部输入恒 1:1，**决策点唯一**。
> - **context summary（运行时轨）**：loop 内部 `_prepareContext`/compact 把溢出窗口的旧轮压成骨架注入，保证多轮内部一致性。**旧轮压缩的"摘要欲"归这一轨**，不产 round-summary、不入记忆库。
> - **单一决策点**：「恒1:1」不违背「turn 一摘要」——一次外部输入即一个 turn（Trigger=输入；Act=step 循环；Reflect=答完内容），Reflect 即该 turn 的摘要决策点。
> - **上下文注入自洽**：loop 多轮时，被挤出窗口的历史靠 context summary 骨架保留，**不依赖也不应依赖** round-summary 兜底（否则职责错位）。
> - **无实质收尾仍恒 1:1**：turn 答完即摘要；仅 `reflect.summary='off'` 或生成器缺失时跳过——跳过属显式关闭/降级，不产生额外摘要源。

---

## 三、存储模型

### 3.1 摘要表（轮次级记忆存储，对齐 `Memory` 接口）

写入 `IMemoryStorage`，`source='round-summary'`。这是系统**唯一**的记忆产生层（轮次级自动轨）；会话级归档只更新 `SessionMeta`（不写记忆库，见 §2.3）。字段集与 `src/memory/types.ts` 的 `Memory` 接口**逐字同源**：

```
┌──────────────────────────────────────────────────┐
│  Memory（round-summary 即此结构，source='round-summary'）│
├──────────────────────────────────────────────────┤
│  id:          string        // 全局唯一，格式 round-summary:{sessionName}:{roundId} │
│  content:     string        // 1-3 句话摘要                                  │
│  source:      string        // 开放字符串，round-summary 为记忆库唯一自动写入源  │
│  name:        string        // 可读名称（默认取 roundId）                     │
│  createdAt:   string        // 创建时间（ISO 8601）                          │
│  accessedAt:  string        // 最后访问时间（命中刷新，事实字段，非排序键）    │
│  deletedAt?:  string        // 软删除时间；非 undefined = 回收站中，召回过滤   │
│  summaryType?:SummaryType   // preference/fact/decision/intent/general（仅 round-summary）│
│  sessionName?:string        // 归属会话（YYYY-MM-DD-sessionName，仅 round-summary）│
│  roundId?:    string        // 归属轮次（仅 round-summary）                   │
│  isModified?: boolean       // 人工修改标记（仅 round-summary）                │
│  supersededBy?:string       // 写路径取代标记：指向取代它的新摘要 id（仅 round-summary）│
│  materialFingerprint?:string// 摘要原料指纹，写入前精确去重（仅 round-summary，存量缺省）│
│  metadata?:   Record<string,string> // 预留透传字段，内核无生产写入方，不在存储契约保证范围 │
└──────────────────────────────────────────────────┘
```

> **字段边界纪律（SSOT）**：`summaryType` / `sessionName` / `roundId` / `isModified` / `supersededBy` / `materialFingerprint` 的**溯源/分类/治理语义**一律走顶层持久化字段，**不塞 `metadata`**——因为宿主存储契约不保证持久化 `metadata`，而这些字段须跨会话可靠读取（取代/分轨/互斥召回都依赖）。`metadata` 仅作为"可选透传字段"保留（预留键，非僵尸键）：当前内核侧零生产写入方，旧档可能携带，读时经 `parseMemory` 白名单保留、但记忆库各消费面不从 `metadata` 取上述语义。

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
- **排序由关键词命中 + `accessedAt` 事实项构成**（见 §四），类型不参与排序。
- 类型隐含价值层级——`preference`/`decision` 天然比 `general` 更有记忆价值，价值通过召回时的相关性/使用轨迹自然体现，无需独立的 quality 评分字段（避免与 type 信息冗余）。

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

## 四、现行召回（search_memories 工具）

### 4.1 入口与形态

现行记忆检索**唯一入口** = LLM 工具 `search_memories`，内核落点为 `memoryInspector.searchByKeyword(query, limit, excludeRoundIds?)`：

```
LLM 主动调用 search_memories(query)
    ↓
searchByKeyword：纯关键词单通道检索（无向量、无语义融合、无 score）
    ↓
① 前置 superseded 过滤：被 supersededBy 取代的摘要不作为当前事实返回（仍保留，trace_summary 可回溯）
② excludeRoundIds 互斥：正文/摘要已在视图内的轮次不重复返回（工具语义：不补位凑满）
    ↓
③ 截断到 limit（默认 10）：不引入 accessedAt 时间主序——accessedAt 只作事实字段揭示（命中 touch 刷新），优先级由 LLM 结合任务定夺
    ↓
返回命中项（附 sessionId/roundId 结构化溯源，与 trace_summary 参数直通）
```

**核心原则**：
- **纯关键词，无语义通道**：分词用 `Intl.Segmenter`/`segmentText`（宿主 SQL 后端走 `LIKE ? ESCAPE '\'`），任一 token 命中 `content/name` 即入选。向量/embedding 写端从未接通，语义通道生产从未生效，已随 B0 收编整体移除（`vectorStore`/`embedding` 配置段全删），工具描述亦已明文否认。
- **召回是 LLM 主动行为（被动工具）**：内核不在 `assembleContext` 自动注入任何记忆；记忆能不能被想起来，全看 LLM 这轮有没有主动搜、且关键词字面要重叠。这是"砍掉语义向量、把检索推给模型"的固有取舍（见 §4.2）。
- **superseded 过滤是确定性判据**：`!hasActiveSuperseder` 过滤在 `search` 取回 top-limit 之后执行（被取代者不补位）——**已知边界**：被取代条目占用候选槽位时，返回条数可能少于 limit。

### 4.2 为什么纯关键词（诚实边界声明）

业界 2026 主流 agent（Anthropic Memory tool / Claude Code / Librarian Pattern）已实证「LLM 消费者 + 小语料」下纯关键词足用：LLM 会自主改述重试（工具描述已提示）。语义检索的 cache-recompute 形态作为**预留补回位**保留——等真实「关键词搜不到」复现再按缓存重算形态补回，补回前恒为纯关键词。

**成立边界（诚实声明）**：本选择依赖 LLM 在检索时**真的会**选准关键词。若未来出现「记忆写了但关键词检索系统性漏召回、且真实影响回答质量」的用户反馈，则应触发复评——届时优先在 `searchByKeyword` 内补回缓存重算形态，而非引入系统级语义索引剪枝。

### 4.3 互斥排除（excludeRoundIds）

**问题**：同一轮对话的正文和摘要不应同时进入上下文。若正文已作为对话历史全量加载，再返回该轮摘要就是重复信息，浪费 token 且干扰 LLM 判断。

**判定来源（确定性，非运行时状态）**：`excludeRoundIds` 由调用方按 `loop.getExclusionRoundIds()` 精确派生 = 视图内 ∪ 被替换 ∪ 在途轮次（天然不含当轮），传入 `searchByKeyword` 在截断前过滤命中该集合的摘要。**不依赖运行时注入时序**——纯确定性判定，只依赖调用方传入的集合，缺省为空（行为等同纯检索）。

### 4.4 排序：关键词命中 + accessedAt 事实项

现行排序 = **关键词命中序**（FTS/分词命中）+ `accessedAt` 作为事实字段（命中刷新，揭示使用轨迹），**无分层分轨、无 cap 内分配、无 score 主序**。limit 截断是唯一的"上限有界"保证。

> 历史说明（已退役）：v3 时代确实存在「分层分轨（L1 会话内 / L2 会话外）+ 语义相关性 + cap 内分配」的召回编排（`recall()` 函数），连同 `score` 字段、`minSemanticShare`/`memoryRecallPercent` 等记忆层 cap/召回键，已于 2026-09-04 ~ 2026-09-18 经多轮"减法"整体删除（见附录 A）。**现行不再有 `recall()` 函数、不再有分层分轨召回、不再有任何记忆层 token cap**——记忆不进 prepare 装配管线，检索唯一入口 = `search_memories` 工具，由 LLM 主动取用、按需拉取 token（非常驻预算）。

### 4.5 LLM 溯源工具

向 LLM 暴露 `trace_summary(sessionId, roundId)` 工具，让 LLM 在需要时回溯到原始对话：

```
LLM 持有摘要：用户偏好简洁UI（from session-abc, round-5）
    ↓ 需要更多上下文
LLM 调用 trace_summary('session-abc', 'round-5')
    ↓ 返回原始对话记录
LLM 获得完整上下文
```

工具暴露但不强制使用——`search_memories` 命中摘要后，LLM 决定是否进一步溯源。

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
  "isTruncated": true
}
```

**限制**：最多 5 条消息，单条 2000 字符。

**降级**：无 roundId 时返回整个会话摘要；原始对话已删时返回摘要并标注"（原始对话已删除，仅剩摘要）"。

---

## 五、生命周期

### 5.1 删除规则

**定案（2026-08-28，年轮收敛）**：Round 是会话存储的物理唯一真理源，round-summary 是它的派生记录——**删 Round 即删其派生摘要**。早期草案"删对话保留摘要转 `isTraceable=false`"被否决（理由见 §5.2）。

| 操作 | 对摘要的影响 | 说明 |
|------|------------|------|
| 删除问答闭环（Round） | **摘要随 Round 连坐清理** | 孤儿 Round（引用归零）→ GC 物理 purge 其 round-summary（不进回收站，系统治理决定）；宿主删会话/扫描 → `softDeleteRoundSummaries` 软删 + 脱钩溯源（清 sessionName/roundId，恢复后即为独立记忆）。长期知识沉淀由用户显式沉淀（作品投影/文档）承担，不由 round-summary 滞留承担 |
| 摘要手动修改 | `isModified = true` | 标记已修改，不影响溯源精确性 |
| 摘要删除 | 该轮记忆从召回视野消失 | 语义即"删记忆"。源对话记录仅作为展示保留，供用户回溯，不再参与运行召回 |

**摘要生成竞态窗口（已知，风险登记 2026-10-16）**：摘要是 fire-and-forget 后台任务（`eventEmitter.ts` 已注明「摘要还在生成就删了源」的孤儿窗口）——用户在 `roundSummaryGenerated` 事件到达前删会话时，联动选择集可能漏掉尚未写入的摘要，遗留孤儿摘要由 GC 下一轮（`minAgeMs` 默认 24h）兜底 purge。现有兜底 = ① 宿主 UI 锁（等 `roundSummaryGenerated` 才解锁删除按钮）+ ② GC 超龄清理；两层均为软兜底、非事务保证，若孤儿摘要在兜底前被召回，`trace_summary` 将按「原始对话已删除，仅剩摘要」降级（§5.2 读时事实判据，本就不设 `isTraceable` 字段）。**处置口径**：接受现状（窗口窄、降级路径完备），闭环条件 = 联动裁决单源化后补「生成中删除」对拍用例。

**悬空取代指针判据（消费侧，见 §5.3）**：摘要的替代物（被 `supersededBy` 指向者）被移除（GC purge、宿主软删/物理删/过期清理、去重降级，任一路径）后，若旧摘要因仍被其他会话引用而保持活跃，其 `supersededBy` 指针即悬空——若召回侧只按 `!supersededBy` 过滤，旧摘要会被藏掉、又无当前版本可取 → **有效记忆静默不可召回**。**修法收口为消费侧单一判据 `supersedeResolve.hasActiveSuperseder`**（判据：`supersededBy` 指向现存且活跃的记忆才算真取代）：指针悬空即视为未取代，旧摘要**回退为当前版本**（其替代物已消失，它即仅存版本，理应对召回可见）。该判据在**所有消费 supersededBy 的位置**统一使用——内核召回过滤（`searchByKeyword`）、取代候选（`getSessionCandidates`）、宿主治理展示（记忆条目 DTO 序列化 / 「已被取代」统计）。**与「谁、用哪条路径移除了替代物」完全解耦**：任一移除入口（含未来的新入口）都自动覆盖，无需在每个移除点补收敛逻辑（避免「漏接一处即漏一类」的半修复）。判据只读、不写存储，不动正常取代链、不改 `supersededBy` 写入语义。

### 5.2 设计理由

- **对话记录是"展示层 + 溯源兜底的运行依赖"**：给用户翻看历史用；同时被 `trace_summary` 工具读取用于回溯原始对话（溯源保真）。**召回/聚合不依赖它**（摘要即记忆），但溯源工具依赖它——两者不冲突。
- **摘要是"记忆层"**：是系统召回/聚合的核心依赖。因此**删除摘要 = 删除记忆**，源对话记录仅作为展示 + 溯源保留供用户回溯，不再参与运行召回。
- **连坐删除的正当性**：Round 是物理唯一真理源，摘要只是它的"浓缩影子"。**本源消融则影子消融**——不产生悬空溯源（roundId 指向不存在的 Round）、无孤儿状态、全链路零特化分支。若删 Round 却留摘要，会引入"无主记忆"状态：读路径都要为"Round 没了摘要还在"加兜底。
- **跨会话价值不靠滞留兜底**：轮次流水速记（fact/general）随轮消融，符合"流水记录低独立价值"的定位；需要长期沉淀的知识走**用户显式沉淀**（作品投影/文档）。被动滞留是弱设计，显式沉淀才符合"种子自然生长"哲学。
- **打标而非硬删**：保留数据完整性，防止误删可通过恢复标记找回（软删除 30 天回收期）。
- **只留必要标记**：`isModified`（人工修改过，提示与原文可能不一致）是唯一保留的摘要标记。溯源可行与否**不设字段**——`trace_summary` 读时按 `sessionName + roundId` 查找，找到即原文、找不到即"（原始对话已删除，仅剩摘要）"，以事实为准（`isTraceable` 字段已删，2026-08-28：写死 true 无行为消费者，删后读侧无分支变化 + 修掉"可溯源却无原文"的展示瑕疵）。

#### 5.2.1 可追溯性边界

> **设计说明**：明确 memora 可追溯性的**边界**——它服务于"对话内容"的可回溯，不承诺"模型每次看到的完整上下文"的可重建。

**追溯范围**：
- **说了什么（对话内容）**：`trace_summary` 工具经 `loadRawRoundMessages` 回溯原始对话（§4.5/§4.6）。
- **记忆来源（摘要溯源）**：round-summary 通过 `sessionName + roundId` 软链接回原始对话（§3.3）。

**明确不追溯（边界声明）**：
- **"模型看到了什么"（每次请求的完整上下文：系统提示、召回摘要、装配结果）** 不进入追溯范围。它由 **ITracer span** 承载（`llm.call` span 记录 `systemPromptHash`，记忆附着计数经对应 span 记录 `attachedMemoryCount` + `attachedMemoryFingerprint`），**不入 sessionStore**。

**与 §5.1 删除规则的衔接**：Round 物理删时摘要连坐清理，正常无"Round 没了摘要还在"的常态；即便异常路径（摘要尚在、原文已删），`trace_summary` 也按读时查找结果渲染"（原始对话已删除，仅剩摘要）"，不依赖任何字段标记。**memora 的追溯是软追溯（允许失效降级），不是强事件溯源（永不删除）**——这是有意取舍，非缺陷。

### 5.3 记忆维护（写路径取代检测）

**问题**："摘要即记忆"是 append-only——每轮一条摘要。长期运行会出现三类"记忆腐烂"：同一事实重复表达、旧决策被新决策覆盖、过时事实仍被召回。**时间排序解决"呈现顺序"，解决不了"哪个决策覆盖哪个"**（覆盖是结构信息，不是时序信息）——若全靠 LLM 在召回时按时间序猜，冲突消解依赖运行时判断，违反"确定性优先"。

**设计决策：写路径取代检测**——把冲突消解从"读时猜"移到"写时定"，落在**闭环后处理（Reflect）**层面：
- 每轮闭环完成后，生成摘要的同时，**检测新摘要与同 session 近期同类摘要是否疑似覆盖**（加权 Jaccard ≥ 阈值）；若覆盖，给旧摘要打确定性 `supersededBy = 新摘要.id` 标记（**非删除**，保留可回溯）。
- 读时（召回）按确定性过滤：`supersededBy` 摘要不再作为当前事实注入；需要历史时经 `trace_summary` 回溯。
- **判断触发条件**：仅当新摘要与同 session 旧摘要"主题相关"时才触发取代，非每轮必做。**取代语义收敛到同 session**（候选经 `getSessionCandidates` 的 `sessionPrefix` 过滤，跨 session 长期历史不参与取代判定，无跨 session 覆盖语义）。

#### 5.4 加权 Jaccard 取代检测算法

**核心**：采用加权 Jaccard 相似度替代标准 Jaccard，提升「多轮逐步细化」场景下的主题延续识别准确度。

```
WeightedJaccard(A, B) = Σ(交集关键词权重) / Σ(并集关键词权重)
```

**关键词权重策略**：
- **动作/意图词**（「创建」、「删除」、「优化」）：权重 **2.0**
- **实体/对象词**（以「器/表/函数/模块」等后缀结尾）：权重 **1.5**
- **其他词汇**：权重 **1.0**

**阈值**：`SUPERSEDE_OVERLAP_THRESHOLD = 0.5`（硬编码，确定性承诺）。

**设计理由（SSOT 合规）**：
- **不引入动态阈值**：阈值保持硬编码，保证写时判定结果的确定性
- **算法本身智能化**：通过权重设计让核心动作词和实体词在相似度计算中贡献更大，而非叠加外部判断规则
- **下沉到工具层**：关键词提取和相似度计算统一在 `segmenter.ts` 工具层实现，避免业务逻辑层重复实现

**SSOT 自检**：此设计**不新增存储层**、**不新增后台系统**、**不新增记忆关系图**（仅一个标记 + 指针）。它是**效率挪移**——冲突消解从读路径（高频、每次召回都猜）移到写路径（低频、每轮一次判断），写一次定、读时确定性过滤，比"读时靠 LLM 聚合猜"更符合"确定性优先"。

**保真声明**：摘要是**有损线索**，不承诺捕捉全部原始信息；保真由 `trace_summary` 回溯原始对话兜底。当记忆可靠性成为实测瓶颈，再评估"摘要 + 原始对话"双轨召回。当前阶段摘要保真度足够，此为**有意声明**，非缺陷。

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
| 召回（`search_memories` 工具，纯关键词） | `memoryInspector.searchByKeyword` | 相关摘要列表（superseded 过滤 + excludeRoundIds 互斥） | 是（LLM 主动取用） |
| 溯源 | `trace_summary` 工具 | 原始对话记录 | 是（LLM 可选调用） |

**闭环验证**：每个环节的产出是下一个环节的输入，不存在断裂或外部依赖。

### 6.2 最小性验证

**能否删除某个组件而不破坏系统？**

| 组件 | 删除后果 | 结论 |
|------|---------|------|
| `RoundSummaryGenerator` | 无记忆产生，系统失去跨窗口回忆能力 | ❌ 不可删除 |
| `search_memories` 工具（原 `recall()` 入口） | 上下文注入无记忆，系统每轮都是"全新对话" | ❌ 不可删除 |
| `trace_summary` 工具 | LLM 无法追溯摘要来源，但核心循环不受影响 | ✅ 可删除（体验降级，非功能断裂） |
| 互斥排除（excludeRoundIds） | 正文与摘要可能重复进入上下文，浪费 token | ✅ 可删除（体验降级，非功能断裂） |
| `isModified` | 人工修改标记无法提示"与原文可能不一致"，仅体验降级 | ✅ 理论上可删（当前保留，成本低） |
| `isTraceable` | ~~溯源/不可溯源标记~~（2026-08-28 已删除：写死 `true` 无行为消费者） | ✅ 已删除 |

**核心依赖链**：`RoundSummaryGenerator → IMemoryStorage → search_memories 工具 → LLM 取用`

这条链路上只有 3 个组件，不存在冗余。

### 6.3 单一真理源验证

问三个问题：

1. **这套逻辑是否只在某个场景下生效？** — 否。`RoundSummaryGenerator` 在所有场景（对话、Loop、Agent 间通信）中一致工作。
2. **去掉某个场景的特殊处理，核心逻辑是否依然完整？** — 是。没有场景特化分支。
3. **这个功能的实现，是否需要在最小单元之外引入新机制？** — 否。所有功能都在 turn 框架内实现。

三个问题答案均为"否"，设计未偏离单一真理源。

### 6.4 循环依赖验证

系统中有两个潜在循环依赖：

**A. 理解输入 vs 角色包切换**（解决路径）：
- 第一阶段：原始理解（不依赖角色包），提取触发词
- 确定性匹配：触发词 → 角色包（正则匹配，不依赖语义）
- 第二阶段：在角色包视角下深度理解

**B. 摘要生成 vs 上下文组装**（不存在循环依赖）：
- 摘要生成在 `postProcess` 阶段，是上一轮闭环的产物
- 上下文组装在 `assembleContext`/LLM 取用阶段，消费已有的摘要
- 两者时间解耦，中间隔了 IMemoryStorage

### 6.5 设计约束总结

1. **摘要生成在 Reflect 阶段完成**——不阻塞主流程，异步写入。
2. **摘要类型由 LLM 在生成时自动判断**——不引入独立分类器，不增加额外 LLM 调用。
3. **纯关键词召回**——`search_memories` 工具单通道（无向量/语义/score），命中经 superseded 过滤 + excludeRoundIds 互斥 + limit 截断；`accessedAt` 仅作事实字段（命中刷新），不作主排序键。
4. **`trace_summary` 工具可选调用**——`search_memories` 命中摘要后，LLM 决定是否进一步溯源。
5. **`trace_summary` 返回内容受规模控制**——最多 5 条消息，单条 2000 字符。
6. **召回上限有界**——limit 截断保证 token 有界，无需聚合机制。
7. **互斥窗口由 excludeRoundIds 派生**——正文与摘要不重复进上下文（§4.3），集合由 `loop.getExclusionRoundIds()` 确定性派生（视图内 ∪ 被替换 ∪ 在途），不含当轮。
8. **治理简化**——去掉 L0-L3 四层治理，只保留 supersede（写时取代）+ 悬空取代指针判据（消费侧 `hasActiveSuperseder`，防止悬空指针致有效记忆不可召回）。

---

## 七、最终形态（总结）

**一句话**：摘要单轨，纯关键词召回，写时取代 + 悬空指针消费侧判据治理。

| 维度 | 设计 |
|------|------|
| **记忆模型** | 摘要单轨（round-summary，唯一自动轨；会话级摘要归 SessionMeta） |
| **召回方式** | 单一召回入口（`search_memories` 工具，纯关键词，LLM 主动取用） |
| **过滤** | superseded 过滤（`!hasActiveSuperseder`，悬空指针视为未取代）+ excludeRoundIds 互斥（正文/摘要已在眼前不重复返回） |
| **排序** | 关键词命中序 + `accessedAt` 事实字段（命中刷新），无分层分轨、无 cap 内分配、无 score 主序 |
| **治理** | supersede（写时取代，同 session 加权 Jaccard ≥ 0.5）+ 悬空取代指针消费侧判据（替代物移除后旧摘要回退活跃） |

**详细说明**：

- **摘要即记忆本体**：写入（RoundSummaryGenerator + type 标签）→ 召回（search_memories 纯关键词 + superseded 过滤 + 互斥排除）→ 治理（superseded 取代 + 悬空指针消费侧判据）闭环成立，无独立洞察提炼层。
- **纯关键词召回**：砍掉向量/语义通道与 `recall()` 编排，检索完全交给 LLM 主动调用 `search_memories`；LLM 消费者 + 小语料下纯关键词足用，语义检索的 cache-recompute 形态仅作预留补回位。
- **type = 语义标签**：type 参与语义分类，但不参与过滤与排序（过滤/排序由 superseded 判据 + excludeRoundIds + 关键词命中 + accessedAt 事实项承载）。
- **治理收敛**：写时取代（supersededBy 标记）+ 悬空取代指针判据（`hasActiveSuperseder`，消费侧判定、与移除路径解耦），无 L0-L3 多层治理、无 score 时间衰减。
- **memoryAdded 事件由 round-summary 发射**——作为"新记忆产生必通知"的出口契约。
- **会话级摘要归会话记录存储**：SessionArchiver 只更新 `SessionMeta`（summary/keyTopics/autoName），不写 `source='content'` 记忆；`content` 为**历史残留 source**——无自动生产路径，已清出 `GOVERNANCE_SOURCES`（见 §2.3）。

---

## 附录 A：已退役设计（历史演进参考，非现行）

> **性质**：以下设计曾落地，已于 2026-09-04 ~ 2026-09-18 经多轮"减法"整体删除。**请勿按现行机制解读**，仅保留演进脉络与"为何删"的论证，供将来复评参考。

- **`recall()` 召回编排函数**（含 `applyTrackPolicy` / `sortByLayer` / `applyCapAllocation` / `hybridMerge`）：分层分轨召回（L1 会话内 / L2 会话外）+ cap 内分配 + 语义轨道保底。删除理由：记忆纯工具化召回后 prepare 无自动注入消费端，6 键与解析函数/常量一并移除；现行召回 = `search_memories` 工具。
- **向量/语义通道**（`vectorStore`/`embedding`/`AgentSearchHit.similarity`）：B0 收编整体移除，无现行载体；纯关键词召回下 `similarity` 恒 0。
- **`score` 字段与 score 时间衰减**：阶段3 从 `Memory` 接口物理删除——score 单调不减导致区分度趋零，且"只 touch 不 +score"后无写位；现行排序 = 关键词命中 + `accessedAt` 事实项。
- **记忆层 cap / 召回键**（`memoryRecallPercent` / `memoryRecall` / `summaryRecall` / `minSemanticShare` / `DEFAULT_MEMORY_CAP_RATIO` / `ContextOccupancy.memoryTokens`）：随召回自动注入退役整体删除——现行预算/占用模型**无任何记忆维度**，记忆不进 prepare 装配管线。
- **用户画像层 / 洞察层**（`UserProfile` / `userFactExtractor` / `archiveProfileFacts` / `InsightExtractor` / `archiveInsight`）：不独立存在，其能力并入 round-summary 的 `summaryType` 标签分类。
- **`isTraceable` 字段**：2026-08-28 删除（写死 `true` 无行为消费者）。
- **多 turn 编排摘要策略**（`head id` 组合溯源、子 turn 单产摘要、report 单源摘要）：随多 turn 编排层废弃，收敛为"一次外部输入 → 一个 turn → 一条 round-summary"。

> **关联资源**：
> - [agent-design-philosophy.md](agent-design-philosophy.md) —— turn 公理
> - [role-pack-spec.md](role-pack-spec.md) —— 角色包标准（记忆相关键 SSOT）
> - [memory-role-pack-boundary.md](memory-role-pack-boundary.md) —— 记忆系统 × 角色包边界收敛
> - [ADR-021](../../.trae/decisions/ADR-021-memory-conflict-supersede-write-path.md) —— 记忆冲突消解（写路径取代检测）
> - [ADR-023](../../.trae/decisions/ADR-023-context-cost-injection-defense-loop-convergence.md) —— 摘要成本重构
> - [ADR-025](../../.trae/decisions/ADR-025-memory-role-pack-boundary.md) —— 记忆归角色包边界
> - `src/agent/managers/roundSummaryGenerator.ts` —— RoundSummaryGenerator 实现
> - `src/agent/managers/memoryInspector.ts` —— searchByKeyword / softDeleteRoundSummaries 实现
> - `src/memory/gcService.ts` —— 孤儿 Round 回收 + 摘要物理清理
> - `src/memory/supersedeResolve.ts` —— 悬空取代指针判据（`hasActiveSuperseder`，消费侧）
>
> **模块边界**：本模块（摘要即记忆）是**内核基础，独立于角色包**——召回策略、互斥集合、limit 均由内核默认值驱动，可脱离角色包单独运行与测试。角色包 L2 召回键（memoryRecall/summaryRecall 等）随召回自动注入退役已整体移除，不再构成前置依赖。
