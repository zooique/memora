# 记忆纯工具化召回设计（告别自动注入）

> **状态**：阶段1自动注入机制退役 **已实现**（步进A/B/C/D/E 落地，全量回归 2946 通过）；阶段2 6 键族删除 **已实现**（commit 4f318407）+ 工具互斥落地（search_memories 排除已载入正文轮次 + limit 收紧 10→5 + trace_summary 精取引导，commit 89d0ff26）；阶段3 score 退役 **已实现**（2026-09-09：Memory.score 字段物理删除、hybridMerge 排序纯化单 vectorScore、boost→touch 收敛、memoryAdvisor 弃 status 健康判定、宿主 workspaceStorage/protocol/webview 同步；全量回归 2864 通过）。A4 检索召回质量问题与 score 无关（实证见 .trae/documents/a4-fix-or-phase3-sequencing.md），作为独立开放项留待本地小模型对照后裁决。
> **日期**：2026-09-09
> **实测**：`scripts/test-memory-tool-recall.ts`（机制实测脚手架，验证 searchHybrid 结构化溯源字段、superseded 过滤、命中 touch 刷新 accessedAt、memoryRecalled 事件、touchScores 收敛）；A/B 模型行为验收（想起率/命中率）待真实 LLM + 问题集见 §阶段1 出口条件
> **关联**：[memory-recall-recency-design.md](memory-recall-recency-design.md)（本设计**取代**其问题域，见 §0.5）· [memory-as-summary.md](memory-as-summary.md) · [memory-role-pack-boundary.md](memory-role-pack-boundary.md) D7/D6
> **决策链**：score 单调不减窘境（实证）→ accessedAt 近因提案 → 复合键排雷（P0-1 连续浮点失效）→ 主流设计对照（ACT-R / Generative Agents / Mem0 均揉单标量，memora 不揉的理由）→ **范式切换定案：纯工具化**（2026-09-09 萧然拍板）→ **首步记忆检索：确定性触发**（自发工具调用不可靠 → 首轮收窄为只读探查面，同日二轮拍板）→ **记忆职责校正：被想起为主、被找到为兜底**（LLM 收到要求的第一反应是回忆；"用户提点才查到"是最差兜底线，非目标，同日三轮）→ **四轮澄清：想起 = 每轮默认第一反应（判断恒在），"直接干"是判断的合理产物**（"不是每轮都必须" = 结果允许不需要，非降低回忆地位）→ **「最近使用优先」规则落定：accessedAt 字段揭示 + 描述规则归 LLM，代码不预排时间主序**（同日补充拍板，§5.2）

---

## 0. 决策摘要（TL;DR）

1. **召回架构范式切换**：每轮自动注入（proactive，代码替模型猜"此刻需要什么记忆"）→ **LLM 主动回忆**（on-demand：收到要求的第一反应 = 判断"这值得回忆吗"，相关即主动检索；判断归模型）。符合「代码做确定性、模型做不确定性」。
2. **排序难题随之消解**：工具返回 top-N 候选由 LLM 看内容自选，排序从"决定上下文存活权"降级为"候选清单次序"——0.90 vs 0.88 的微差不再重要。recency 设计文档（复合键/accessedAt 次级键/score 退役）**整体降级为候选清单的 P2 次序问题**。
3. **实证半落地**：`search_memories` 工具已存在（builtinTools.ts:407，纯关键词后端 builtinToolHandlers.ts:817），且 `memoryInspector.searchHybrid` 注释自称"记忆搜索工具，不是召回管线"（memoryInspector.ts:230）——**搜索能力已按工具语义设计，缺的是接给 LLM + 语义通道 + 退役自动注入**。
4. **保留层**：对话层管理（loop 最近历史/互斥/压缩）、预算派生与占用快照（上下文指示器真理源）、记忆写入/supersede/compaction。**退役层**：每轮自动语义召回段 + prepare 召回策略键族（6 键，见 §4.2）。
5. **本设计取代 recency 文档的问题域**：recency 文档的复合键/排序/score 退役全部是"自动注入语境"下的问题；纯工具化后该语境消失。recency 文档仅保留一条有效结论，**已在 §5.2 定案（2026-09-09 补充）**：accessedAt 由**工具命中即 touch** 刷新，作为「最近使用优先」规则的事实字段暴露给 LLM（不预排时间主序，不做加权/复合键）。
6. **确定性触发 = 首步记忆检索**（2026-09-09 二轮拍板）：纯自发工具调用不可靠（模型会忘查）→ 有查询意图的轮次，**首个 LLM 调用只暴露只读探查工具面**（结构性收窄，复刻 TS-7 searchDisabled 按轮过滤先例），指令点名 memory_search 优先——"第一个 step 理解意图、第二个 step 搜记忆"由**编排保证**而非模型自律；自发调用保留为任意轮兜底（§3.2）。
7. **记忆职责 = 被想起（默认动作），找到只是兜底**（2026-09-09 三轮拍板/四轮澄清，§1.4）：LLM 收到要求时**第一反应恒为回忆判断**——"这值得回忆吗"，默认动作、判断机会由首轮收窄结构性保证；判断结果允许"不需要 → 直接干"（简单任务，合理产物非失败）；"用户显式提点才查到"（被找到）是**最差兜底线**（亦须 ≈100% 命中），不是设计目标。

### 0.5 与 memory-recall-recency-design.md 的关系

recency 文档为"自动注入语境"的排序修补方案，其 §2.2 复合键经排雷实证（P0-1）在连续浮点语义分上机制失效；主流对照显示修排序只有两条路——揉单标量（引入 memora 明确拒绝的曲线/权重复杂度）或**换掉排序的决策位（自动注入）**。萧然拍板后者。故本设计**取代 recency 文档的实施地位**；其开放点（§6）随本设计裁决一并关闭或降级。

---

## 1. 背景与决策链（沉淀，勿回改）

### 1.1 为什么自动注入的排序难题无解（第一性原理）

自动注入管线的一切复杂度都源于一个前提：**系统必须在 LLM 开口前替它决定上下文里放哪些记忆**。由此派生——分轨分层（谁有资格进）、cap 分配（预算怎么分）、复合键排序（谁先谁后）、特权补入（preference 未命中也要塞）。每个决策都是一套机制 + 一片测试面 + 一个被质疑的开放点。

对排序键做实数推演（2026-09-09 排雷）：语义分是连续浮点（vectorScore×0.6 + score×0.4），两条记忆分完全相等几乎不可能 → 复合键次级键（accessedAt）只在"分相等"时决胜 → **形同虚设**。修法只有：档位化（新 hack）或加权求和（新曲线）——都与"零新曲线、零维护"承诺冲突。

**根因不在排序参数，在排序的决策位**：代码在替模型做"此刻需要什么记忆"的语义判断。判断归模型（工具化）后，排序问题整体消失。

### 1.2 主流对照（2026-09-09 网络吸收，记录依据）

| 来源 | 做法 | 对 memora 的结论 |
|---|---|---|
| ACT-R（Anderson & Schooler） | `B_i = ln(Σ t_j^{-d})`：近因+频率合一标量 | 频率不需要"轨道"——useCount 即可；纯近因定案不推翻 |
| Generative Agents（Park 2023） | recency+importance+relevance 加权和 | 揉标量需曲线/权重调参，memora 单用户项目级规模不摊薄此成本 |
| Mem0 / Letta / Zep | 语义相关 + 近因 + 使用频率 | 三派均为**自动注入**（模拟潜意识触发） |

**分界线 = 记忆类型 + 规模**：自动注入派服务"无意识触发"（用户没说查，记忆已在场）；memora 事件概括为主的摘要 + 单用户项目级 → 按需查询的 function-calling 范式更契合（同 `trace_summary`/`compress_context`/`search_project` 既有追溯型工具）。

### 1.3 纯工具化的代价（对抗式，作为回退预案记录）

工具化依赖**模型知道自己不知道**（漏触发 = 记忆形同虚设）；偏好/规则类需每次记得查（不可靠）。预案：若实测漏触发频繁，回退 = git 回退对应提交（分阶段提交纪律），或启用 §6.3 的最小常驻轨。

### 1.4 记忆职责定位：被想起为主，被找到为兜底（2026-09-09 三轮定案，四轮澄清表述）

**纠正一处表述偏差**（曾把记忆职责说成"被找到"——那是把兜底线当成了目标）：

- **主职责 = 被想起，且想起是每轮默认动作**：LLM 拿到用户要求，**第一反应恒为回忆判断**——"这与过往经验/决策/偏好相关吗？值得查记忆吗？"。这是默认动作，不依赖输入显式提及过往、也不依赖"感觉到相关性"才触发。判断相关 → 主动检索（想起的动作）；判断无关 → 直接干。
- **"直接干" = 判断的合理产物，不是记忆缺席**（萧然四轮澄清）：人办一件简单的事，第一反应同样是"这需要想吗"——只是判断快到像没发生，于是直接就办了。LLM 同理：简单任务判断结果为"不值得回忆"→ 直接干，完全合理、可接受。"不是每轮都必须"指的就是**判断结果允许"不需要"**，而非降低回忆的地位、更非"低频/点名才查"。
- **被找到 = 兜底线**：用户显式提点（"上次那个 X""按之前定的来"）时**必须**查到——这是最差情形也必须保证的底线（验收 ≈100%），但只是底线不是目标。
- **机会与结果的分离**（本设计的分工核心）：判断的**机会**由代码结构性保证（首轮收窄 = 每次收到要求都被置于"要不要回忆"的判断位——判断动作恒在）；判断的**结果**归模型（语义相关性判断 = 不确定性归模型）。对应验收：主验收 = 值得回忆场景的**想起率**（LLM 主动查且命中），兜底验收 = 显式提点的**命中率**（≈100%）。
- **"不是每轮都必须"的正确定义**：不是"每轮都注入/查询"，也不是"用户提点才查询"，而是**每轮都有想起的判断（默认动作），判断结果允许"不需要 → 直接干"**——简单任务直接干是合理产物，需要回忆的场景主动想起。

---

## 2. 现状实证（读码结论，含行号）

### 2.1 自动召回注入调用链

```
SeedPrepare.run（seed/prepare.ts:99，策略解析 memoryRecallMode/contextAssembly）
  → ContextPreparer.recallAndInject（contextPreparer.ts:114）
      ├─ 预算派生 computeContextBudget（:133，记忆层 cap = 剩余 × memoryRecallPercent）
      ├─ 语义召回段（:184-242，contextAssembly≠fixed 时）：recall() → memoryRecalled 事件 → fire-and-forget boost（:229）
      ├─ 对话层注入段（:248-263，hybrid 模式 [Recent conversation]）
      ├─ 占用快照 recordOccupancy（:291，上下文指示器真理源）
      └─ 返回 recalledMemories → loop 注入（供回答中作为 system 消息）
```

`recall()`（recall.ts:103）内部：语义/关键词双通道 → applyTrackPolicy（L2 偏好轨特权补入，:291）→ hybridMerge 融合排序 → reranker → sortByLayer（L1 createdAt / L2 preference createdAt / L2 other 不重排，:340）→ superseded 过滤 → fallback 空查询补足（:228）→ applyCapAllocation（token+条数双约束，:401）。

### 2.2 记忆检索消费点（recall() 全部调用方）

| 调用方 | 场景 | 纯工具化后 |
|---|---|---|
| contextPreparer.ts:196 | **每轮 chat 自动召回** | 退役（本设计主体） |
| checkpointRestoreCoordinator.ts:106（warmRecall） | 检查点恢复时用 mainGoal 召回早期上下文注入 | **保留例外**（见开放点 1）：冷启动无对话上下文，LLM 无从主动查 |

### 2.3 已存在的记忆工具（工具化半落地实证）

| 工具 | 位置 | 能力 | 缺口 |
|---|---|---|---|
| `search_memories` | builtinTools.ts:407 / toolExecutor.ts:694 / builtinToolHandlers.ts:797 | 关键词搜索（memoryIndex.search）+ match/near 模式 | **无语义通道**；命中不 touch；描述声称"回答前仅注入一次召回记忆"（自动注入残留语义，须改写） |
| `trace_summary` | builtinTools.ts:425 | 摘要 → 原始对话追溯 | 闭环已齐 |
| `list_sessions` | builtinTools.ts:440 | 会话路标定位 | 闭环已齐 |
| `searchHybrid` | memoryInspector.ts:235 | 语义+关键词双通道融合排序（注释自称"记忆搜索工具"） | **从未注册给 LLM**；minSimilarity 硬编码 0.3 |

### 2.4 宿主消费面（退役必对齐）

| 宿主点 | 现状 | 纯工具化后 |
|---|---|---|
| chatPanel.ts:975 `memoryRecalled` | "LLM 回答前召回 N 条记忆" info 提示 | 仅工具命中时触发（语义改为"LLM 查询记忆命中 N 条"） |
| chatView.ts:3122 / protocol.ts:543 占用指示器 memoryTokens/memoryCount | 每轮注入记忆占用量 | 恒 0（自动注入消失）→ 指示器"记忆摘要"段语义调整 |
| chatPanelHistory.test.ts:511/522 | memoryCount=0 断言 | 语义保留（快照降级重算路径） |

### 2.5 prepare 召回策略键族（退役必删，checklist 9 类落点）

`prepare.memoryRecall`（full/limited/none）· `memoryRecallPercent` · `minFallback` · `contextAssembly`（fixed/query/hybrid）· `recallConfidence` · `summaryRecall`——消费端：strategyResolver.ts:70-76 默认值 + 解析函数；strategyKeys.ts:131-138 键规则；contextPreparer.ts:137/204/208/222。**均属冻结键清单**（strategyKeys.test.ts:172-177）。另有 `budget.ts` memoryRecallPercent（:162/:180 记忆层 cap）与 `AGENT_CONSTANTS.DEFAULT_RECALL_LIMIT` 等随动常量。

---

## 3. 目标架构：记忆 = 可查询资源

### 3.1 三工具闭环（记忆检索通道）

```
记忆是资源，不是背景。触发时机见 §3.2（首轮收窄编排），通道如下：
  memory_search（升级现 search_memories）跨会话语义+关键词检索
    → trace_summary（命中摘要想追溯原文时）
    → list_sessions（不确定在哪个会话时先定位路标）
```

### 3.2 触发编排：首步记忆检索（确定性，2026-09-09 二轮定案）

**问题**：纯自发工具调用（LLM 在回答中"想起来"才调）不可靠——search_memories 混在十余工具中，模型可能全程不调 = 记忆形同虚设（R1 实证化）。定案原则：**"理解意图 → 搜记忆"须是 turn 的结构性前置，而非模型自律的概率行为**——萧然原话：「如果是工具的话 LLM 不一定会用」。

**正向定位（三轮补充、四轮澄清，§1.4）**：本机制不是"防 LLM 忘查"的防御件，而是**把"主动回忆"变成 LLM 收到要求后的默认第一反应**——首轮被置于"这值得回忆吗"的判断位（结构性机会，判断动作恒在）→ 判断相关即调 memory_search（想起的动作）→ 判断"太简单/与过往无涉"直接作答（合理产物，非记忆缺席）。"用户显式提点才查到"（被找到）由同一工具面兜底，但那不是目标——目标是**内容到达即主动想起（默认第一反应），简单任务直接干也是判断的合理产物**。

**机制三件套**（零新状态机，全复用 loop 既有积木）：

| 件 | 机制 | 实证依据 |
|---|---|---|
| ① 代码预筛 | turn 开始时 `extractKeywords(input)`（recall.ts:150 现成，`hasQueryIntent` 同判据 recall.ts:176）：无查询意图（问候/续句）→ 不收窄、全工具直接答；有意图 → 触发首轮收窄 | 预筛只防"执行型输入被收窄挡路"；成本 = 一次纯函数调用，零 LLM 往返 |
| ② 首轮工具面收窄 | 有意图轮次的首个 LLM 调用（信号 = `!toolExecutedThisTurn`，loop.ts:788 现成），tools 参数 = **只读探查面** `[search_memories, read_file, list_dir, search_project, trace_summary, list_sessions]`；system prompt 同步收窄 + 指令一句（"回答涉及过往决定/历史/偏好/项目背景或不确定时，先调 search_memories"）；双闸同构 TS-7 searchDisabled（loop.ts:2048 与 :1961） | TS-7 按轮过滤先例：不修改 toolDefinitions、仅按轮过滤、随 resetTurnState 恢复 |
| ③ 结果即注入 | 命中结果以 **tool result** 形态回对话流（LLM 自行决定怎么看/怎么用），记忆不再占固定 system 预算；`injectRecallAsSystem`（loop.ts:2012）退役 | 现有 tool_call → tool result 标准流程，零新机制 |

**语义澄清（防误读，五组边界）**：
- **想起 = 每轮第一反应（判断恒在），结果允许跳过**：任何输入都先过"这值得回忆吗"的判断——这是默认动作；简单任务判断结果 = 不值得 → 直接干，完全合理（人办简单事也先想后办，只是判断快到像没发生）。"直接干"是判断的合理产物，非记忆缺席（§1.4）；
- **想起 ≠ 用户提点才查**：相关性由内容触发（"这个报错怎么处理"而此前讨论过同类 → LLM 自己想起去查），不是等用户说"上次"——"被找到"只是兜底线；
- **收窄 ≠ 禁用**：search_memories 仍在全工具面（任意轮可自发调），收窄只是把探查族**提前到首轮 + 指令点名**——"结构性优先 + 概率兜底"双层；
- **执行型输入不收窄**：预筛放行 → 首轮即可写文件，零效率损失（"把 X 改成 Y" 不被挡）；
- **预筛漏判（如"继续上次那个"关键词被停用词滤空）**：落入自发调用兜底层——可靠性从"结构性"降为"概率性"但非零，可接受（仍优于"被找到"底线）。

**生命周期/恢复**：收窄状态位 turn 开始由预筛结果设置；首轮 tool_call 执行后或直接作答后，随 `resetTurnState`（turn 结束）/ `toolExecutedThisTurn` 翻转自然失效——与 searchDisabled 同生命周期，无显式恢复点。

**演进预留（C 路径）**：若实测首轮收窄仍漏触发（LLM 直接作答但实际需记忆），升级为回答前独立"检索意图"LLM 调用（结构化产出 query 集 → 代码执行检索注入）——每轮 +1 往返代价，先不引入（§6 开放点 9）。

### 3.3 memory_search 升级清单（现 search_memories 原地升级，不改名）

| 项 | 改动 | 理由 |
|---|---|---|
| 后端 | 关键词（memoryIndex.search）→ **searchHybrid**（语义+关键词，vectorStore 可用时） | 补语义缺口：用户说"内存泄漏"、记忆写"heap 溢出"时关键词 miss；searchHybrid 注释已自证工具语义（memoryInspector.ts:230） |
| 过滤 | supersededBy 过滤（recall 读路径现行行为 recall.ts:221） | 工具返回被取代摘要会误导 LLM |
| 参数 | 保留 query/limit/mode；新增可选 `source`（round-summary/preference/…）过滤 | 承接 summaryRecall 键语义（§5.1），不引全局键 |
| 命中 touch | 工具命中 → fire-and-forget 刷新 accessedAt（复用 backgroundTask + memoryRecalled 事件模式，contextPreparer.ts:229 同构） | accessedAt 语义"被想起即刷新"在新范式下的唯一触发位——**"被 LLM 使用"以命中为准**（命中 = 被想起 = 记忆强化，同 §3.4 人类隐喻）；规则同步告知 LLM（下行「优先级规则」） |
| 优先级规则（2026-09-09 补充定案） | 命中项显式附 `accessedAt` 结构化字段（与 sessionId/roundId 溯源增强同批）；工具描述明示：「候选默认按语义相关性排序；多个候选贴题度相近时，按上次被使用先后（accessedAt 新者优先）定优先级；命中会刷新该记忆的最近使用时间」 | 「最近使用优先」作为**规则暴露给 LLM 决策、代码不预排时间主序**（§5.2）：判断归模型，时间只提供事实字段 |
| 互斥过滤（审查补 → 2026-09-09 已落地） | **不暴露为工具参数**：装配期注入 `recentRoundIdsProvider`（`getRecentRoundIds(HOT_MEMORY_MAX_ROUNDS)`，与恢复路径 warmRecall 同源同值），search_memories 内部算 `excludeRoundIds` 传给 `searchHybrid`，过滤 roundId∈集合的命中（在 superseded 过滤后、融合排序前剔除；不补位凑满——工具语义返回更聚焦结果即可） | 原 `recall()` 的 excludeRoundIds（recall.ts:85/:188/:252）在工具直连查库路径下**无天然继承者**，不加则 LLM 首轮检索会把已在上下文的最近轮摘要重复搜回（违背"干净"）；**传给调用方（LLM/角色包）则互斥可被关掉而失效**，故固化为内核装配注入（builtinToolHandlers.setRecentRoundIdsProvider），不开放（§5.1 边界同批）；明文溯源行见 §8 |
| 返回 | **结构化溯源字段**：round-summary 命中项显式附 `sessionId`/`roundId`（与 trace_summary 参数直通）。现状溯源参数**隐式埋在 name**（`轮次摘要 {date-session} {roundId}`，roundSummaryGenerator.ts:159——LLM 解析 name 可得，但为未文档化格式契约，name 一变链路即断） | 溯源链去隐式依赖：LLM 零解析直用 trace_summary（§3.5） |
| 描述 | 删除"回答前仅注入一次召回记忆，运行中不自动补充"残留；改写为"记忆不再自动注入；回答涉及过往决定/历史事实/用户偏好/项目背景，或对答案不确定时，先检索记忆再作答" | 行为性描述与实现同批更新（血训 2c6e54b3）；触发词与 §3.2 首轮指令/§5.3 三层缓解一致 |
| 幂等映射 | search_memories: 'read-only'（builtinTools.ts:79）不动 | 只读工具永不跳过，语义天然正确 |

### 3.4 命中即 touch 的语义（承接 recency 文档唯一有效结论）

自动注入退役后，每轮 boost 消失（根除 Phase 8 P1-1 自强化正反馈——常驻话题不再因每轮召回而永远新鲜）。accessedAt 只由**显式查询命中**刷新："被想起" = 模型主动找到它。这与人类记忆隐喻对齐（回忆行为本身强化记忆），且查询低频 → 无自强化问题。

### 3.5 溯源闭环实证（摘要 → 原文，2026-09-09 三轮验证）

**核心闭环（萧然定性）**：上下文满 → 旧轮被替换成摘要 → 被加载/被检索的记忆是摘要 → 经溯源回到原文——须全程可用。逐环实证：

| 环节 | 实证 | 行号 |
|---|---|---|
| 摘要携带溯源字段 | 顶层持久化 `sessionName` + `roundId`；id = `round-summary:{sessionName}:{roundId}`；name = `轮次摘要 {sessionName} {roundId}` | roundSummaryGenerator.ts:153-165 |
| sessionName = 完整会话标识 | `currentSessionName = ${currentDate}-${currentSession}`（"2026-09-09-main"）——摘要/召回/trace 三处同源同值 | messageHistory.ts:56-58 |
| trace_summary 匹配 | `id.startsWith('round-summary:${sessionId}:')` + roundId 精确匹配 | builtinToolHandlers.ts:872-877 |
| 摘要 → 原文 | `loadRawRoundMessages` 从 sessionStore 取原始对话（≤5 条，截断标记）；store 缺失降级回摘要文本并注明"原始对话已删除"（工具恒可用） | :884-897 |
| 第一级替换（上下文满） | 越界轮正文 → **库中已沉淀摘要**替换，roundId 计入互斥排除——替换产物即库中记忆，可搜可溯 | contextPreparer.ts:171 |
| 第二级压缩（compress_context） | 现场压临时摘要、**turn 收尾即弃不进记忆库**（救急空间管理）；turn 正常收尾后正式 round-summary 落库接手续航 | builtinTools.ts:186-190 |

**结论：闭环成立**——同一摘要三层同源（库中可被 memory_search 搜到 / 替换后上下文可见 / 原文在 sessionStore 可被 trace_summary 回溯），记忆的"加载形态 = 摘要、溯源形态 = 原文"契约在数据层完整。

**两个已识别的设计层事项（非断点）**：
1. 溯源参数当前隐式在 name（格式契约未文档化）→ §3.3「返回」行已列结构化增强；
2. compress_context 描述"压缩内容仍可经 trace_summary 回溯"与"临时摘要即弃"措辞张力——指 turn 收尾后正式摘要可溯，建议描述措辞澄清（实施批次）。

---

## 4. 退役面（分阶段实施，每阶段独立提交 + 突变验证）

### 阶段 1：自动注入机制退役（本次提案主体）

| 文件 | 改动 |
|---|---|
| contextPreparer.ts | recallAndInject **语义召回段删除**（:184-242 的 recall/boost/memoryRecalled）；保留预算派生、roundId 互斥、对话层注入（hybrid）、占用快照。方法语义从"召回+注入"退化为"上下文装配"（改名可议） |
| seed/prepare.ts | 删除 memoryRecallMode/contextAssembly 解析与传参（:87-89/:99-103）；recalling thinking 阶段保留；**预筛接入**：extractKeywords(input) 产出 hasQueryIntent → 设置 loop 收窄状态位（归属实施批次定：此处或 loop 首轮前） |
| loop.ts | **首轮工具面收窄（新增，§3.2 件②）**：收窄状态位（turn 开始由预筛结果设置）+ buildChatOptions/buildSystemPrompt 双闸按轮过滤（复刻 searchDisabled 先例 :2048/:1961）+ 收窄指令注入；`injectRecallAsSystem`（:2012）退役（结果以 tool result 形态进入，件③）；状态随 resetTurnState 自然恢复 |
| checkpointRestoreCoordinator.ts | warmRecall **保留**（开放点 1 拍板）——若保留，boost 段（:128）同步收敛为 touch |
| recall.ts | **注入语境函数退役**：applyTrackPolicy / sortByLayer / applyCapAllocation / fallback 通道（消费方只剩 warmRecall 时，可瘦身为纯检索：双通道 + hybridMerge + superseded 过滤）。recall() 公共 API 去留 = 开放点 4（src/index.ts:260 导出面） |
| 宿主 | memoryRecalled 事件语义 + 占用指示器 memory 段文案（§2.4） |

**删除后无孤儿**：判定准则 = 上述函数 grep 消费方归零；boostScores 的每轮触发位删除，仅存工具命中位。

**阶段 1 出口条件（验收，落地前立标尺）**：本方案可靠性建立在模型"想起"行为上（§1.4），**必须 A/B 实测验收、不能靠推理论证闭环**：
- **主验收 A · 想起率**：隐含相关要求（用户未明说"上次/之前"，但内容与库中记忆相关，如"这个报错怎么处理"且此前讨论过）→ LLM **主动调用** memory_search 且命中正确条目的比例。这是"被想起"主职责的度量。
- **兜底验收 B · 命中率**：显式提点（"上次那个 X""按之前定的方案"）→ 查到正确条目 ≈ **100%**。这是"被找到"底线的度量。
- **失败定义（精确）**：值得回忆的场景（内容与过往相关）却未查询**且**答案劣于有记忆时——才是失败。"直接干"（简单任务判断为不值得回忆）且干对 = 想起判断的合理产物，**不算失败**；
- **分模型**：云端大模型 vs 本地小模型分别跑同一问题集（memora 最小公分母是本地 LLM）。
- **达标线（量化，2026-09-09 审查补，防验收事后叙事）**：B 必须 **≈100% 硬门槛**（未过则不视为阶段 1 落地，直接回退或升级）；A 记录基线并与自动注入基线的对照——若本地小模型 A **低于云端 A 的一半**（建议值，实测前冻结：如云端 80% / 本地 <40%）且同问题集复现 ≥3 次 → 触发 C 路径演进（§3.2/§6.9）或最小常驻轨回退预案（§1.3）。**阈值在阶段 1 实施前随验收集冻结**，不得事后按结果调标。
- **具体问题集与判定基准见 [memory-tool-recall-ab-benchmark.md](memory-tool-recall-ab-benchmark.md)**（A/B 分类用例、目标记忆跨会话/旧轮规避组装互斥、判定记录表、装载器扩展建议）——问题集随实测迭代，不嵌正文。

### 阶段 2：prepare 召回策略键族删除（checklist 9 类落点批次）——**已实现**（commit 4f318407，全量回归通过；工具互斥收尾 commit 89d0ff26）

6 键（§2.5）+ `budget.ts` memoryRecallPercent 参数 + `AGENT_CONSTANTS.DEFAULT_RECALL_LIMIT`（若 recall 瘦身）——按键删除 checklist 执行：① strategyKeys.ts 键规则 ② strategyKeys.test 键集数组/CASES ③ docs/策略键消费矩阵.md ④ 接入指南 ⑤ role-pack-spec.md ⑥ authoring-guide.md ⑦ schema.json ⑧ 内建 role-packs manifest + creator 模板 ⑨ SKILL.md 键速查 + 台账观察条目。**与阶段 1 同批 or 紧随**（键无消费端 = 死键，违背 SSOT，勿留空转期）——开放点 2。

### 阶段 3：score 退役批次（承接 recency 文档 P0-2/P0-3，独立决策）

**现状（2026-09-09 实证）**：score 的消费端已收敛为三类——① 排序权重 `hybridMerge` 综合分 `vectorScore×0.6 + score×0.4`（hybridMerge.ts:58-64，recall() 与 searchHybrid() 共享单一真理源）；② 召回副本提升 `boostScore`（recall.ts:491，`+BOOST_INCREMENT`，auto-inject 退役后仅剩 warmRecall 走 recall()）；③ 展示/判定 `(score=...)` 工具返回（builtinToolHandlers.ts:920）与 `memoryAdvisor` avgScore 健康状态判定（`SOURCE_HEALTH_THRESHOLDS`，memoryAdvisor.ts:164-190）。字段本身（`Memory.score` + 宿主存储 + 协议 DTO）破坏面大（recency 文档 P0-2 已列）——**维持推后，字段物理保留作诊断展示**。

**决策矩阵**：

| 消费端 | 处置 | 理由 |
|---|---|---|
| `hybridMerge` score×0.4 | **退役**：排序纯化 = 单语义分 `vectorScore` 降序 | score 单调不减无区分度（P0-1）；`只 touch 不 +score`（§5.2）后 score 不再更新，排序残件。同贴题下的次序交由 LLM 依据暴露的 `accessedAt` 字段决策（§5.2 定案：代码不预排时间主序） |
| `boostScore`（recall.ts 副本提升） | **删除**：收敛为 touch | 唯一排序消费者（hybridMerge score 项）退役后，boost 副作用失效；touchScores `incrementScore(id,0)` 已落地（只刷 accessedAt），是唯一写位 |
| `SCORE_FLOOR` | **保留**作存储 clamp 下限 | touch 仍走 `incrementScore`（clamp 到 floor），是存储不变量、非排序语义；勿随排序批拆除误伤 touch 读路径 |
| `memoryAdvisor` avgScore 健康判定 | **回退判定基准**（本周另议指标，候选=accessedAt 冷度｜弃用 status） | G34 已定性记忆无沉底语义、`listFading` 更名「冷记忆观测」；score 不再更新 → avgScore 冻结失去时效含义，健康判定基础消失 |
| 工具返回 `(score=...)` | **保留**作诊断展示 | 字段物理保留故可展示，只读回溯价值（已实现只读不改） |
| `BOOST_INCREMENT` / `SCORE_CEILING` | 3B 后查孤儿：若 boostScore 删除且无 q 排写提升位，常量失消费 → 另批清理 | 同「预留键 vs 僵尸键」纪律，勿留空转 |

**批次序（渐进重构 + progressive-refactor，每批独立提交 + 全量回归）**：

- **3A 排序纯化**：`hybridMerge` 移除 `memoryScoreWeight` 项与 `HybridWeights` 权重参数 → 变量 `sort 单向量分`；recall() 与 searchHybrid() 同步生效（同一函数，一处改处处生效）。`keyword-only` 回退通道（vectorScore=0）失去 score 打破平局 → 次序依赖 stable-sort 插入序，可接受（兜底后端，语义缺失本就无主序）。
- **3B boost 收敛**：recall.ts 删除 `boostScore`（:491/:271 副本提升段），确认 `touchScores` 为唯一写位（`incrementScore(id,0)`）。
- **3C 判定回退**：`memoryAdvisor` 健康状态改基准（拍板见下表①），`SOURCE_HEALTH_THRESHOLDS` 随速随拆记录在案（2026-09-09 教训：新增后未住即拆，勿留孤儿）。
- **3D 常量清理**：`BOOST_INCREMENT`/`SCORE_CEILING` 去孤儿（3B 后 grep 消费方归零则删，`src/index.ts:139` 导出面同步）。

**退出条件**：排序行为回归（语义分主序、score 不参与且不被 boost 维护）；工具 `(score=...)` 仍正常展示；memoryAdvisor 健康判定有明确基准；全量测试绿。

**决策点（拍板后实施）**：
1. **memoryAdvisor 健康判定基准**：accessedAt 冷度（承接「冷记忆观测」正名） vs **弃用 status**（倾向弃用——记忆健康由 supersede/命中体现，无需榜单级 status）。
2. **hybridMerge 接口**：权重参数删除（倾向，代码纯化） vs 保留归零（兼容未来次级键）。
3. **工具 `(score=...)` 展示**：保留作诊断（倾向） vs 移除（字段已无排序语义）。

---

## 5. 边界与不变量（改完自检）

| 层 | 机制 | 处置 |
|---|---|---|
| 写入 | roundSummaryGenerator / writeUpsert / supersede（写时取代） | **不动** |
| 有效性 | supersededBy 过滤（写时判定，D7） | 读路径保留（工具端补过滤） |
| 对话层 | loop 最近历史注入 / roundId 互斥 / 压缩替换 | **不动**（非记忆召回，是上下文管理） |
| 预算/占用 | computeContextBudget / recordOccupancy（指示器真理源） | **不动**，memory 段恒 0 后语义调整 |
| 冷启动恢复 | warmRecall | 保留例外（开放点 1） |
| 浮现度 | accessedAt + 命中 touch | 迁移到工具命中位（§3.4） |
| 策略 | contextAssembly/memoryRecall 等 6 键 | 删除（阶段 2） |

### 5.1 summaryRecall 语义承接

`summaryRecall='off'`（只召回原始记忆、过滤 round-summary）在工具化下的等价物 = memory_search 的 `source` 过滤参数（不引全局键，查询时自选）。全局键语义消失（用户不能一边说"永不看摘要"一边主动查摘要——矛盾）。

### 5.2 排序语义与「最近使用优先」规则（2026-09-09 补充定案）

**工具返回排序 = searchHybrid 的 hybridMerge 融合序（语义相关主，同 §3.3「后端」行）**——**不引入时间主排序**：若按 accessedAt 主导排序，近的边缘记忆会淹没远的核心记忆（"昨天查过的琐事"压过"三个月前的重要决策"），违背记忆检索"相关性优先"的常识，也与范式切换"排序微差不再重要"的结论相悖。

**「最近使用优先」作为规则暴露给 LLM，不由代码预排**（呼应用户补充：更新调用时间 + 让 LLM 按调用时间定优先级）：
- **事实层**：命中项显式携带 `accessedAt`（工具命中即 touch 刷新，§3.4），LLM 零解析可读——「上次被使用」进入候选清单，作为决策输入；
- **规则层**：工具描述明示「多个候选贴题度相近时，按 accessedAt 新者优先定优先级」＋「命中会刷新该记忆的最近使用时间」——**判断归模型**：语义相当的两条候选该选哪条（最近用过 / 更久远但更权威），由 LLM 结合当前任务定夺；
- **代码层**：**不引入复合键/加权/时间主序**（§1.1 排雷教训：连续浮点语义分上次序决胜器形同虚设），**仅字段揭示定案**（2026-09-09 收敛）——`accessedAt` 只作为事实字段随命中项返回，代码不做任何按时间重排/分档/同档稳定排序；**「后端分档」岔口废弃**：它 = 代码按时间重排，违背本自然段的「时间只提供事实，判断归模型」原则，与 §1.1 排雷同源，不预埋。

>> 与 §6 开放点 5 联动：倾向**只 touch 不 +score**——accessedAt 是「使用轨迹」唯一事实源；若 vote +score，使用越频繁 score 越高，与「最近使用优先」时间规则叠加两轨，反而引回自强化（§3.4 已因自动注入退役根除正反馈，勿重建）。

### 5.3 触发缓解（R1 对策：结构性为主，prompt 为辅）

R1（模型不知道自己不知道）的缓解分三层，按确定性降序：
1. **结构性（主）**：首轮工具面收窄 + 指令点名（§3.2 件②）——想调工具必先面对 memory_search；
2. **指令性（辅）**：search_memories 工具描述强化触发词——涉及**过往决定 / 历史事实 / 用户偏好 / 项目背景 / "之前/上次/以前/当时"** 指向时先查询；
3. **兜底**：预筛漏判的轮次仍可中途自发调用（search_memories 全工具面常驻）。

三层仍漏触发（实测判定）→ 升级 §3.2 演进预留的 C 路径（独立意图前置 LLM 调用）。

---

## 6. 开放点（拍板后实施）

1. **warmRecall 保留 or 删除**（推荐保留）：恢复 = 冷启动，LLM 面对空对话无查询线索，mainGoal 预热是"恢复继续"的硬需求；且低频一次性，非每轮成本。若删，需恢复路径注入 mainGoal/currentGoal 纯文本兜底。
2. **策略键 6 键删除批次时机**：与阶段 1 同批（推荐，无死键空转期）或紧随独立批次。
3. **memory_search 命名**：原地升级 search_memories（推荐，幂等映射/契约测试/角色包 capabilityMap 引用零破坏）vs 新工具并列（双工具职责重叠，违背 SSOT）。
4. **recall() 公共 API 去留**：warmRecall 保留则 recall() 瘦身保留（删除注入语境函数）；warmRecall 删除则 recall() 整体退役，检索核心并入 memoryInspector。src/index.ts:260 导出面随动。
5. **工具命中 touch 是否同时 +score**（承接 recency 文档阶段 2 的 boost→touch 收敛）：倾向只 touch（score 退役方向），与阶段 3 绑定裁决——§5.2 已论证：只 touch 时 accessedAt 是「使用轨迹」唯一事实源；+score 则与「最近使用优先」时间规则叠加两轨，引回自强化。
6. **宿主 memoryRecalled 事件去留 + 占用指示器 DTO 联动（2026-09-09 审查补）**：保留改语义（工具命中通知）or 退役（工具调用对宿主透明）——涉及 chatPanel 提示 UX；`memoryTokens`/`memoryCount` 字段随自动注入退役恒定 0，**与事件同批裁决**（事件退役则指示器 memory 段无数据源：删字段 vs 恒 0 展示二选一，§2.4）。
7. **首轮收窄集合**：最小面 `[search_memories]` vs **探查面 `[search_memories, read_file, list_dir, search_project, trace_summary, list_sessions]`**（§3.2 件②已按探查面写，推荐）——写/执行/网络/任务表工具首轮延后、第二轮恢复。
8. **预筛判据**：`extractKeywords(input)` 非空即收窄（推荐，与 recall hasQueryIntent 同判据）vs 增强判据（历史指向词：上次/之前/当时/我们…）——后者防"继续上次"类漏判但规则工程成本，留实测后定。
9. **C 路径（独立意图前置调用）演进条件**：首轮收窄 + 指令 + 兜底三层仍漏触发（实测判定）才引入——每轮 +1 LLM 往返代价，不预埋。

---

## 7. 测试冲击面（实证盘点，实施批次必跑）

| 层 | 文件 | 影响 |
|---|---|---|
| 内核 | contextPreparer.test.ts（多例 recallAndInject 断言） | 语义召回段删除 → 用例重定义（预算/占用/对话层断言保留） |
| 内核 | recall.test.ts（~50 例） | applyTrackPolicy/sortByLayer/applyCapAllocation/fallback 用例退役或迁 warmRecall 语义 |
| 内核 | seed prepare.test.ts / harness.ts / restoreRecallAssemble.test.ts | 编排骨架变更对齐 |
| 内核 | agent.test.ts:2907-2971（memoryRecallPercent 消费路径 3 例） | 键删除 → 用例删除 |
| 内核 | strategyResolver.test / strategyKeys.test / validator.test / types.test / budget.test | 6 键族用例 + DEFAULT_MEMORY_RECALL_PERCENT/MAX_MIN_FALLBACK 常量 |
| 内核 | builtinTools.test（search_memories 契约）· toolExecutor.test:979-1056 · memoryInspector.test（searchHybrid 8 例）· hybridMerge.test | 工具升级断言 + touch 触发 + **accessedAt 字段揭示与优先级描述（§3.3 新行）** + excludeRoundIds 可选参数兼容 |
| 内核 | loop 相关（首轮收窄状态位/双闸过滤/指令注入/恢复点，含 processUserInput 与 resetTurnState 用例） | 新用例：有意图轮首轮只见探查面、无意图轮全工具、执行型输入首轮可写文件、收窄随 turn 恢复 |
| 宿主 | chatPanelHistory.test（memoryCount=0 快照）· chatView.test:2332 占用用例 · protocol DTO 契约 | 指示器语义 + 事件文案 |
| 契约 | role-packs manifest / schema.json / 文档族（阶段 2 checklist） | 键删除 9 类落点 |

**验证纪律**：每阶段独立提交 + 突变验证（如"加回自动召回段应使新用例转红"）；报全量绿须声明层数（根/宿主）与 skip 口径。

---

## 8. 一句话总结

**把记忆从"每轮喂给模型的背景"改成"LLM 主动回忆的资源"：自动注入管线与 6 个召回策略键退役，search_memories 原地升级为语义检索工具（命中即 touch、返回结构化溯源字段）；有查询意图的轮次首轮收窄为只读探查面——LLM 收到要求的第一反应是判断"这值得回忆吗"，相关即主动检索（想起为主），用户显式提点必中（被找到为兜底）；摘要可溯源原文的闭环已实证成立；恢复预热保留为唯一自动例外——排序难题随注入语境一起消失。** 阶段 1/阶段 2 已落地：**工具互斥固化为内核装配注入**（`setRecentRoundIdsProvider` → `getRecentRoundIds(HOT_MEMORY_MAX_ROUNDS)` 过滤 roundId∈当前会话已载入正文轮次的命中，与恢复路径 warmRecall 同源同值），`limit` 收紧 10→5 + 工具描述引导 `trace_summary` 精取原文——工具检索与装配期正文互斥，`excludeRoundIds` 不开放为工具参数、不开放给角色包（互斥被关掉即失效）。
