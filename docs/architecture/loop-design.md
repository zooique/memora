# Loop 模块设计 —— 对 step 的编排（turn 回答中阶段）

> **2026-09-04 收敛补记（一）**：本文论述的「多 turn 任务编排 = orchestrator 对 turn 的串联」（`externalTaskLoop`/`completeExternalTask`）已整体废弃并删除。**loop.ts 本身未变**——`runIterationLoop`（单 turn step 循环引擎）是唯一剩存的 Loop 概念。收敛后架构简化为：一个 turn 内，step 循环承载全部复杂度（含动态建任务表、会议多角色、暂停续跑），不再跨 turn 串联。
>
> **历史定位（原文保留）**：模块重思（module-rethink）产出。聚焦 [src/agent/loop.ts](../../src/agent/loop.ts)，论证「loop（Agent Loop）= turn 回答中阶段对 step 的编排」与「多 turn 任务编排 = orchestrator 对 turn 的串联」两套概念在现状代码中的落地情况。
>
> **2026-09-05 收敛补记（二）**：本文所述 **Handoff（turn 出口衔接决策）** 同步废弃——turn 结束即 done，`handleIterationResult` 返回 `continue/done/paused/aborted` 是**气口/续跑的内部控制信号**，不再是对外"谁来驱动下一轮"的衔接决策。本文正文描述的 Handoff 机制已成历史。
>
> **哲学真理源**：[agent-design-philosophy.md](./agent-design-philosophy.md)（turn·step·loop·气口相关章节）

---

## 一、模块边界与职责

| 项 | 内容 |
|----|------|
| 文件 | `src/agent/loop.ts` |
| 状态 | 🟢 已打磨 |
| 职责 | 档1 turn（问答闭环）的 Act 引擎（含 loop = 对 step 的编排）；~~档2 多 turn 任务编排在 seed/orchestrator~~ 已废弃（2026-09-04） |
| 上游 | `agent.ts` 经 `seed/orchestrator.ts`（`runChat`/`runResume`）委托调用 `processUserInput` / `continueAfterPause` |
| 下游 | `contextManager.ts`（截断/摘要）、`compaction.ts`（微压缩）、`duplicateInterceptor.ts`（重复拦截）、`role-pack` 策略（L2） |

**核心事实**：loop.ts 承载单个 turn（问答闭环）的 Act 引擎，内部 `runIterationLoop` = **loop（对 step 的编排）**（官方「Agent Loop」本义）。复杂任务在单 turn 的 step 循环内承载（task_table_write + 动态规划），**多 turn 任务编排（档2）已废弃（2026-09-04）**——无第二套引擎，loop.ts 天然是一个"自己内部含 step 循环"的完整单元。

---

## 二、哲学映射矩阵（现状 vs 哲学）

| 哲学概念 | 现状实现（loop.ts） | 对齐度 |
|---------|--------------------|--------|
| turn = Prepare/Act/Reflect 三阶段 | **Prepare**：`_injectRecall`（召回注入）+ 用户消息 push + 状态重置<br>**Act**：`handleIteration`（step：一次 LLM 生成 + 可选工具执行，多 step 由 `runIterationLoop` 驱动即 loop）<br>**Reflect（气口判定点）**：`handleIterationResult` 在 `runIterationLoop` 末端决定 continue/done/paused/aborted（内部控制信号，非对外 Handoff 决策，2026-09-05 收敛）；摘要/归档在 `agent.ts` 后处理 | ✅ 高 |
| loop = 对 step 的编排（Act 内部） | `runIterationLoop` 反复拉起 step：LLM 推理 → 工具执行 → 回填 → 再推理；深度由 `toolStepLimit` 控制 | ✅ 高 |
| loop（step 深度） × turn 预算 | loop 深度：`toolStepLimit`（单 turn 工具步数）；turn 总预算：`stepBudget` / `maxIterations` | ✅ 高 |
| ~~Handoff = turn 出口衔接决策~~ | ~~内部控制信号，非对外衔接~~ | **已废弃（2026-09-05）** |
| 触发源决定召回 | `_shouldSkipRecallInjection`（Token 紧时跳过召回）；`_injectRecall` 仅外部输入触发（loop 内部 step 不触发） | ✅ 高 |
| 策略层 = 参数化配置 | `setStrategy(L2RuntimeStrategy)`：工具权限/步数/预算/自审查/插话 全量参数化 | ✅ 高 |
| 终止条件三类（目标/上限/中断） | 目标达成：`done` 分支；上限：`maxIterations`/`stepBudget`/`toolStepLimit`；中断：`abort`/`pause`/`interject` | ✅ 高 |

**结论**：现状已高度对齐设计哲学——**loop（step 编排）是 turn Act 内部的自然属性，没有独立于 turn 之外的第二套引擎（原档2 多 turn 编排已废弃）**；~~多 turn 任务编排由 orchestrator 在 turn 出口处串联~~（已废弃）。

**层级定位（防误读为四层）**：turn / step / loop / 多 turn 任务编排**不是四个并列的层**——`step`（原子）⊂ `loop`（turn 内 Act 的 step 编排）⊂ `turn`（最小完整单元）；多 turn 任务编排（档2）是 turn 的**外部编排**（宏观，已废弃 2026-09-04）。loop 是 turn 的**内部结构**（微观），二者方向不同，各不构成对方的一层；本文件的 loop.ts 只属「单元层内部」。

---

## 三、关键机制与哲学一致性分析

### 3.1 turn 的复用接口 = `processUserInput` 本身

哲学「模式统一论」要求：对话 / 多 turn 任务编排 / 目标模式共用**一套 turn**，不引入新引擎。

现状验证：
- **对话模式** = `processUserInput` 执行一次 turn 后 return（turn 结束即 done，无对外 Handoff）。
- **复杂任务** = 单 turn 内 step 循环承载（task_table_write + 动态规划）；**多 turn 任务编排（档2）已废弃（2026-09-04）**——`externalTaskLoop`/`runReport` 等历史符号已删除。
- **续跑** = `continueAfterPause` 复用同一套 `handleIteration` + `handleIterationResult`（软暂停后从 step 边界恢复）；seed/orchestrator 的 `runResume` 为续跑 Trigger 入口，与 `runChat` 共享同一 turn 结构。

**设计结论**：turn 的最小复用单元就是 `processUserInput` 这个生成器，**无需也不应新增"独立 turn 类"**。未来目标模式只需在"回答后"插入对齐环节，仍复用同一 turn。

### 3.2 loop（step 编排）是 turn Act 内部的自然属性

哲学：loop 决定"一轮有多深"，多 turn 任务编排决定"一次任务有多长"，两者是**可配比的资源**而非固定结构。

现状验证：
- `handleToolCalls` 内：L2 策略检查（`toolCallsBlocked`）→ 步数限制（`toolStepLimit`）→ 并发执行（`executeToolCalls`）→ 重复检测（`duplicateCallInterceptor`）→ Reflection（`reflectionHint`）→ 回填 `return 'continue'`。
- step 边界（每次 LLM 调用 + 工具之间）= 天然的暂停点 / abort 检查点（`raceToolWithSignal`）。**气口在此发生**（LLM 主动提问、用户插话、暂停续跑）。

**设计结论**：loop 深度由 `toolStepLimit` / `toolCallsBlocked` 控制；turn 总预算由 `stepBudget` / `maxIterations` 控制。角色通过策略选择配比，不改 turn 结构——与哲学完全一致。

### 3.3 Reflect 阶段在 loop 之外承接

哲学：回答后 = **同步 Handoff 决策** + **异步提炼沉淀**。

现状验证：
- loop 只做同步的内部控制（`handleIterationResult` 的 done/continue/paused/aborted 判断），非 Handoff 决策（已废弃）。
- 摘要生成、记忆归档、历史持久化在 `agent.ts` 的后处理（`history.appendAssistant`、`postProcess`）完成。

**设计结论**：loop 不承载提炼沉淀——这是正确的边界。摘要/归档属于"回答后异步"，不应被塞进 loop 的内部控制里。

---

## 四、偏差点与生长点

现状高度对齐；3 个概念/接口级对齐点中 1、2 已随 seed 收敛落地（2026-09-01 实证），3 仍为远期锚点：

| # | 对齐点 | 收敛状态 | 现状（实证） |
|---|--------|---------|------------|
| 1 | 概念命名"step" vs "turn" | **已收敛**（术语表 2026-09-03） | 三者定义见 `.trae/rules/terminology-anchor-rules.md` §5（**唯一定义处**；本表不重复定义，避免两处漂移） |
| 2 | 终止条件分散 | **已语义化**（多 turn 任务编排） | 任务编排终止由任务链收敛承担（orchestrator 按 pending 步驱动、耗尽即收尾汇报）；loop 以 `toolStepLimit` 约束深度；turn 整体以 `stepBudget`/`maxIterations` 兜底。统一表述为「**turn 终止决策的输入集合**」：目标达成 / 资源上限 / 用户中断（对齐哲学"终止条件三分类"） |
| 3 | 目标模式接口形状未预留 | 待实现（远期锚点） | 仍不实现；明确定位：未来目标模式 = 回答后插入对齐环节（差距分析 → 新 Trigger），插入点收敛在 orchestrator（闭环编排容器），仍复用 `processUserInput` 的 turn |

**反模式自查**（对照哲学「递归边界确定性」「模式统一论」）：

- ✅ 未引入第二套循环引擎（Loop 复用闭环）。
- ✅ 未用 flag 掩盖设计问题（策略参数化是"配置"，非"补丁"）。
- ✅ 未在 loop 内做领域特化（工具/记忆/策略全注入）。
- ⚠️ 潜在警示：若未来有人为"目标模式"单独建 `GoalEngine`，即违反模式统一论——文档明令禁止。

### 4.1 上下文口径差异与截断层平面化（T4/T2 实证记录，2026-09-01）

> 探索期事实记录（不占 ADR、不承诺修复）。两处"最近 N 轮"口径与截断层层级语义的现状固化，供未来装配/截断重构时对齐。

**两套「最近 N 轮」口径（语义不同，勿混用）**：

| 口径 | 定义 | 用途 |
|------|------|------|
| 装配 `recentRoundCount` | 动态预算派生（`deriveDialogueRounds`：剩余预算 × 填充比，从最近往回塞） | 决定**完整对话层注入哪些轮** → 生成装配 excludeRoundIds（防正文/摘要双写） |
| 截断 `minRecentRounds` | 固定强制保留轮数（ContextManager 截断时不受 token 上限约束保留的最近 N 轮原始对话） | 截断时保证最近 N 轮原文不摘要化 |

两者**语义不同**：装配侧是"预算能装多少轮"（随窗口/输入浮动），截断侧是"至少保留多少轮"（固定下限）。当前各自独立、无互相引用——同一对话在"装配视图"与"截断视图"下的最近轮边界可以不一致，属既有行为，不在本轮收敛。

**截断层平面化事实（T2 实证固化，见 contextManager.test「T2 实证」）**：运行截断按「最晚优先 + user/tool 加权提炼」统一处理所有消息，**不识别装配预算的系统/记忆/正文/锚点分层**：

- 窗口充足：记忆块与正文原样保留（装配注入 → LLM 链路打通）；
- 窗口收紧：最近注入的记忆块存活（tail 保护）、更早轮记忆块与旧正文同级让位（LRU 性质）；
- 超大单块：整块让位，不部分保留。

**结论**：平面化是事实，但记忆健康由「每轮外部输入重注最新记忆 + tail 保护最近」自然保证，旧块让位是节流非缺陷。**不引入记忆层独立保护机制**（避免过度设计）。前置依赖：上下文管理与引擎的配合全景见 [agent-design-philosophy.md §12](agent-design-philosophy.md)（预算装配 / 替换·压缩两级 / 软上限·装配前判负）。

> **2026-09-10 收敛补记**：上文「装配层 `memoryLayerCapTokens` 已前置限制注入量」的论证前提**已失效**——该字段随记忆自动注入退役（2026-09-09）于 2026-09-10 删除，装配层**不再注入任何记忆**、亦不设记忆 cap。记忆改为纯工具召回（`memory_search`），其内容由 LLM 主动取用、不进 prepare 装配管线。原结论「不引入记忆层独立保护机制」**依然成立**（且理由更充分：装配管线已无记忆层）。

---

## 五、设计方案：保持单一闭环复用，不新增机制

> 设计总纲：**loop（Agent Loop）满足"对 step 编排"的官方口径**，方案以"概念对齐 + 接口形状确认"为主；loop.ts 保持为档1 turn 的 Act 引擎，复杂任务在单 turn step 循环内承载（多 turn 任务编排档2 已废弃，2026-09-04），接口契约由 §5.1 固化。

### 5.1 确认的接口契约（当前已成立，文档固化）

| 契约 | 内容 | 消费方 |
|------|------|--------|
| `processUserInput` = turn 最小复用单元 | 召回注入 → Act（含 loop=step 编排）→ turn 结束即 done | `seed/orchestrator`（runChat）+ `agent.ts`（对话入口） |
| `continueAfterPause` = 软暂停续跑入口 | 从 step 边界恢复，复用同一 turn | `seed/orchestrator`（runResume）+ `agent.ts`（pause/resume） |
| `handleIterationResult` = loop 内部控制信号 | 返回 `continue/done/paused/aborted`（气口/续跑判定，非对外衔接决策） | `loop.ts` 内部（runIterationLoop） |
| `setStrategy(L2RuntimeStrategy)` = 行为配比唯一入口 | loop 深度 + 工具权限 + 错误处理等 L2 全量配比 | `seed/prepare.ts`（prepare 阶段单一聚合注入） |

### 5.2 生长路径（未来可执行，非本期）

1. **目标模式**（哲学「目标模式」，远期）：在 orchestrator 收尾（turn 结束即 done）后插入"对齐检查"环节——对齐未达则生成新 Trigger 继续，达成则 done。**无需新引擎**，只增加编排层一个节奏分支，仍复用 `processUserInput` 的 turn。
2. **子 Agent 套娃**（哲学「子 Agent 递归」）：子 Agent = 另一个 `AgentLoop` 实例，主 turn 通过工具调用它。**无需改造 turn**，工具层新增一个"子 Agent 工具"即可。v1 已于 2026-11-11 定案为「父 turn 内的同步递归」，形态见 §5.3；「另一个 AgentLoop 实例」只指运行时实例，**不是会话实体**。

### 5.3 子 Agent v1 形态：父 turn 内的同步递归（2026-11-11 定案）

> **一句话**：子 agent 是父那一 turn 内的一次同步递归调用，不是会话实体——不落 Round、不进会话列表、内存 messages 用完即弃。
> **分工**：本节是形态与夹紧规则的落地口径；裁决理由见 [评估-子会话与目标模式路线-20261108.md](../评估-子会话与目标模式路线-20261108.md) §0.4 / §7.4，本节不重复论证。

**与既有哲学的关系**：仍是 §14.1「子 Agent 不是新的智能体——它就是本 Agent 自身，是 turn 的递归调用」。v1 只实现它的同步子集：父 step 调工具 → 子递归跑完自己的 loop → 结果作为工具返回值回到父 → 父继续同一 turn。

**装配（复用，不另起一套）**

- system prompt 仍只由 `buildSystemPromptPrefix`（`src/agent/assembler.ts:159-198`）拼；角色包在其中只是第一段字符串参数 `rolePackPrompt`。
- 按名字取角色包 prompt 的唯一入口是 `rolePackManager.buildSystemPrompt(name)`（`src/role-pack/rolePackManager.ts:1038-1077`）：它产出 L1（persona + rules），并把该包的内嵌技能清单追加进 prompt——后者是 v1 要抑制的路径（见「已知限制」）。
- **角色包只取 L1，不取权限**：`capabilities` **不继承**——默认空数组；队长可在 `delegate_task` 显式点名只读档 `web:search` / `web:fetch`（只把这两档映射出的工具放进子会话 `toolWhitelist`），`code:execute` 一律拒绝。**这不是继承**：继承是默认给，这里是队长点名才给，且只开只读档——写盘闸一道没松、deny 轴不变。
- 子会话 `toolWhitelist` 默认为 `[]`（不是 `null`——`null` 等于特权全开，见 `src/agent/agent.ts:1903-1911`）；点名只读档后也只含这两档映射出的工具。强制 `toolReadonly = 'readonly'`、`toolMode = 'allow'`；角色包自身声明 `toolMode = 'block'` 的直接拒绝。
- **空白默认 ≠ 裸模型**：`rolePackPrompt = ''` 时，项目规则、全局技能清单、作品投影、环境、时间戳照旧注入（`buildSystemPromptPrefix` 的其余参数不变）。

**六条夹紧规则**

1. `rolePack` 传了但包不存在 / 未装载 → 工具报错，不许静默退回空白。
2. `toolWhitelist = []` 不是 `null`（空数组 = 仅常驻集；`null` = 全开）。
3. 强制只读，且拒绝 `toolMode='block'` 的角色包（block 会把整个工具面关死，子递归连只读工具都用不了）。
4. `userFollowup='ask'` 注入的「主动提问规则」（`src/role-pack/strategyResolver.ts:457-460`）要能按子会话开关抑制——否则 `ask_user` 被 deny 后，提示词仍引导模型去提问。
5. 子会话不注入 `delegate_task` 端口（深度 1 的结构性保证：孙派发工具根本不存在）；同一步并发由派发端口信号量 `SUBAGENT_MAX_CONCURRENT` 硬限（取值真源 `src/agent/assembler.ts`，本文不复述数字）。
6. `capabilities` 入参必须按白名单校验：只接受 `web:search` / `web:fetch`；传 `code:execute` 或任何未知名字 → **工具直接报错**，不许过滤后静默放行。

**deny 轴（工具面第二根轴）**

- 判据必须放在 `isToolExposed` 第一行、**在 `customTools.has(name)` 之前**（`src/agent/toolExecutor.ts:988-997`，`customTools` 分支在 `:990`），否则 MCP / 自定义工具会先命中「恒暴露」而绕过 deny。
- 按「副作用」枚举，不按工具名直觉：写盘 / 删文件 / 跑命令 / 杀命令 / 跑项目脚本 / 跑技能脚本 / `run_code` / `ask_user`，再加 `remember_intel` / `task_table_write` / `task_table_update` / `register_work`。`run_code` 不是与白名单重复的冗余：`code:execute` 属特权，空白名单只是「今天看不见」而非「结构上看不见」，它是第六条夹紧规则在工具层的兜底。**唯一按职责而非按副作用禁的例外是 `run_team_meeting`**（队长对外的评审端口，子会话单角色调用等于花一个 step 买一次无意义的多人自评，且成本不受派发端口 `SUBAGENT_MAX_CONCURRENT` 信号量约束）——新增工具时按副作用核一遍会漏掉它，必须单独按职责再核一遍。工具名真源 = `DEFAULT_EXPOSED_TOOLS`（`src/agent/toolExecutor.ts:503-537`）。**代价**：子会话不能贡献情报和任务项，由队长汇总——有意选择，不是遗漏。
- deny **不能替代** `toolReadonly` 的理由只有三条（详见评估 §7.4 依据一的重写）：从模型可见面隐藏、`ask_user` 在 loop 层挂起、有副作用但不写盘的常驻工具。

**状态回传（不建假 Round）**

- 结果从递归返回值取，不构造 `RoundStatus`（子递归里不存在轮次状态）。
- 子工具结果首行由内核按**流终态标志**生成确定性头部，**四态**：`[SUBAGENT:completed]` / `[SUBAGENT:incomplete]` / `[SUBAGENT:interrupted]` / `[SUBAGENT:failed]`——不是子模型自己写的，父据此判收口。判据全部来自**结构化标志**（provider 的 `finish_reason` / 丢弃计数、loop 的 `limitReached` 与 `done.incomplete|failed`），**不匹配正文文案、不靠正文长度猜**。
  - `completed`：子会话自己收场，且没撞步数上限、没输出截断、没被兜底；
  - `incomplete`：内容可用但不完整。三个来源：① 撞最大迭代 / 步数预算（`text` chunk 的 `limitReached` 标志）；② 输出预算截断（provider `finish_reason='length'`，经 `done.incomplete` 搬运）；③ 正文工具意图骨架被剔除后为空（模型写了骨架却没走原生协议——空正文不是结论，是没干成）。**它不是失败**——父可据此决定是否拆小任务重派；
  - `interrupted`：父 / 用户中止；
  - `failed`：① 异常、子递归里不应出现的 `paused`，以及其它未归类失败；② 内核自己写的兜底文案（空响应重试耗尽——「AI 服务暂时不可用 / 请调大输出上限」不是子模型的结论）；③ 流提前结束时丢弃了半截 `tool_calls`（provider 在 `finish_reason='length'` 或 EOF 时清空累积器并上报 `droppedToolCalls`——模型本想调用的动作没有交付）。
  - `failed` **优先于** `incomplete`：同一收尾同时具备两个事实时按「不可交付」收口（半截调用被丢弃比「话说了一半」更重）。
  - **EOF 证据与窄修边界**：适配层只在 `[DONE]` 或 `finish_reason='tool_calls'` 时 flush 累积器，`if (done) break` 之后无任何完成性校验；现有测试只覆盖带 `[DONE]` 的流 ⇒ **证明不了**「正常完成必带完成标志」（部分兼容网关本就不发 `[DONE]`）。故只修窄的一种：EOF 时累积器非空 ⇒ `failed`；**静默 EOF 且无半截调用登记为已知风险，不判失败**（一刀切会把正常回答打成失败，比漏判更糟）。
- **上下文压缩 / 截断不判态，只加一行事实说明**：子 loop 真发生过 ContextManager 截断 / 压缩链实际改动 / `compress_context` 成功替换时（粘性事实位 `AgentLoop.hasContextCompaction()`），结果正文末尾追加「（说明：本次子会话中途经历过上下文压缩/截断，结论基于摘要，细节可能缺失）」；**没发生的会话不出现这一行**。不新增状态位，四态语义不变。
- 参数校验失败（角色包不存在 / `toolMode='block'` / 非法 `capabilities`）返回**标准工具错误** `[ERR:TOOL:ARGUMENT_ERROR]`，不存在终态——子会话根本没起来；「首行恒为 `[SUBAGENT:…]`」的契约只覆盖「已经开始执行」之后。
- 派发端口返回**结构化结果**（`{ status, text }`），执行器据此定 `ToolOutcome`：**只有 `completed` 记 ok**，其余三态一律非 ok（否则检查点 / metrics / 宿主「失败」展示会把半截回答记成成功）。
- 正文里**行首**出现的同名标签降级为小写 `[subagent:` 并追加一行说明（只处理行首，不做全局转义，正文里的普通代码内容不动），防父 LLM 与人扫到「第二个终态」。
- `paused` 在子递归里应不可达（无用户应答、无父确认队列）；真出现按 `failed` 收口并记日志，不伪装成完成。
- 父 abort **直接透传同一个 signal**（`loop.processUserInput(task, signal)`，`src/agent/assembler.ts` 的 `startSubagent`），保证父收场后子递归不再继续执行。父侧 `raceToolWithSignal` 只给 1.8s 宽限、先到先赢，所以派发端口在 abort 一到就**立即**用已累积正文返回 `interrupted`，后台子 loop 继续收同一 signal 自己收场（异常在内部吞掉，不会成为 unhandled rejection）；并发名额在端口 promise 返回时释放，不等子 loop settle。**不用 `mergeAbortSignals`**：它的签名强制带超时（`(optsSignal, timeoutMs, name)`），而子会话没有也不该有独立超时策略——硬套等于凭空发明一个 deadline。

**私有约束（子会话不得写父状态）**

- 不复用父 loop 的两个回调：`onToolExecuted`（会写父检查点）、`onPendingQuestion`（会挂起父）。
- 子 loop 用独立的 `ToolExecutor`，不复用父实例——父的 whitelist 是可变状态，共用会让子派发反过来改父的工具面。
- **子执行器不注册宿主 `customTools`**（`createSubagentToolExecutor` 全新实例，`SubagentRuntimeParams` 根本不携带注册表）：MCP / 自定义写工具在结构上进不来，不靠 deny 名单逐个点名（点名必然漏，加不完）。`isToolExposed` 第一行的 deny 顺序保护仍保留作为兜底（`toolExecutor.test.ts` 有变异钉），但不再是这条保证的依赖。

**技能面（v1 定案：只留全局技能）**

- 子会话 prompt 不注入角色包内嵌技能清单：`buildSystemPrompt(name, { includeSkills: false, suppressFollowupAsk: true })`。
- 子执行器（`createSubagentToolExecutor`）的 `readSkill` / `readResource` / `listResources` / `listSkills` 四个回调**全部绕开 `rolePackManager`**，只走全局 `skillManager`。因此同名技能只会读到全局那份，结构上不存在「读成父当前角色包同名技能」的路径（`subagent.test.ts` 用同名冲突样本断言，并钉住 `readSkillContent` 零调用）。
- 代价（如实登记）：子会话以 `rolePack` 派发时，该包自身的内嵌技能在读面上同样不可见——与 prompt 不注入一致，不存在「prompt 里有、读不到」的错位。
- 父会话不受影响：父的 `readSkill` 仍是「激活角色包 → 全局池」两级解析（`assembler.ts` 的装配点）；`rolePackManager.readSkillContent` 的 `packName ?? roundAssemblyRole ?? activePackName` 解析只在父侧生效。

**v1 明确不含**：不落 Round、不进列表、不做会话派发、不继承父角色包（`capabilities` 默认空，只能由队长显式点名只读档 `web:search` / `web:fetch`；`code:execute` 拒绝）、不做异步 / 事件回流 / 进度查询、递归 >1、结果摘要器、第二套 loop。

---

## 六、验证建议（架构无改动，仅验证现状已对齐）

1. **对话模式**：一次提问 = 单个 turn 结束即 done，无多余 step。
2. **复杂任务模式**：task_table_write + 动态规划在单 turn step 循环内承载，step 边界可见 `tool_start`/`tool_result` 回调（step 可观察性）。
3. **策略配比**：设 `toolStepLimit=1` + `stepBudget=3`，验证 loop 浅、turn 总预算短；反之验证 loop 深、turn 预算长。
4. **软暂停续跑**：`requestPause` 后 `continueAfterPause` 从 step 边界恢复，不重复执行已完成的工具。

---

## 七、多 turn 任务编排语义化（已废弃）

> **2026-09-04 收敛**：档2 多 turn 任务编排已整体删除——`externalTaskLoop`/`completeExternalTask`/`runStepSequence`/`runReport` 与 `difficulty.ts` 难度分级均不复存在。复杂问题由"任务链驱动 + 收敛汇报"（最初见 [task-driven-closed-loop.md](./task-driven-closed-loop.md) 的设计愿景）已收敛为**单个 turn** 的 step 循环内承载（task_table_write + 动态规划）。演进关系见 [agent-design-philosophy.md](./agent-design-philosophy.md)。

---

## 八、运行时护栏收敛（GuardRail SSOT，2026-09-16）

> 收敛自 [loop运行时护栏SSOT收敛方案](../../.trae/documents/loop运行时护栏SSOT收敛方案.md)。带伤问题：loop 曾把「联网搜索上限 / 提问上限 / 同路径连写止损 / 读取失败硬闸 / 重复读取拦截」5 种前置拦截型护栏以「内联 if + 独立计数字段 + 各自文案 + 各自阈值」散布主循环，每加一种护栏都改主循环。

**收敛设计（自然生长，非重写）**：判定逻辑、命中文案（衔接提示词 `GUARD_RAIL_PROMPTS`）、阈值（`GUARD_THRESHOLDS`）单一真理源收敛到 [`src/agent/guardRail.ts`](../../src/agent/guardRail.ts)（`createDefaultGuards` 注册 5 闸，判定序 read_failed 先于 read_dedup）。loop 在 `executeToolCalls` 处仅保留最小职责：组 GuardContext → 调 `evaluateBlocked` 取首个硬拦 → search_limit 专属副钩（停搜 + 重建 system prompt，需触达消息层故留 loop）→ 被拦回填文案。运行态计数（读失败 / 写侧连写与失败）**内聚在各 guard 实例闭包**（不在 loop 的计数字段里），经 `notifyExec` 喂数、`reset` 归零；`notifyExec` 为**全量分发**（各护栏在 onExec 内按工具自过滤），不借 `matches` 路由——一个字段两职责会挡掉「读成功复位写侧计数」这类跨工具观测。

> **2026-10-25 判据订正（真机 round-1792904123909）**：`write_loop` 原判据是「同路径连续写 N 次」，把 `mode=replace` 的逐处修订与整文件覆盖混算，第 5 次即硬拦；且被拦后读文件不复位计数，本 turn 内该路径被永久封死（真机 7 次被拦、5 处修订拖到下轮）。现判据改为**无进展信号**：① 仅整文件覆盖（`mode=overwrite`）计入连写；② 增量写（replace / insert / append）不计数；③ 同路径连续**失败写**达 `writeFail` 阈值即拦，读成功 / 写成功即清。`failed` 也不再被当作一次写（原实现会推进 streak）。阈值仍只在 `GUARD_THRESHOLDS` 单点。

> **2026-10-25 同批洞补丁（真机 round-1792919558093）**：同批工具调用**先集中判定、后统一执行**（`executeToolCalls` 内 `for` 里判定并派发、末尾 `Promise.all` 等结果），判定阶段看不到任何执行结果 ⇒ 只靠 `notifyExec`（执行后回喂）的连写计数会被「一条回复内连发 N 次同一文件整文件覆盖」**整批绕过**（实测 6 次 overwrite 全部放行）。补法 = 新增**放行钩子** `onAllow` / `notifyAllow`：loop 在「判定放行、确定派发」处调一次，`write_loop` 在钩子内**预登记整文件覆盖意图**（增量写不登记，批量逐处修订仍零计数）；执行结果回喂时**消费**该预登记（同一次写只计一次），被拦未执行则**撤销**预留。判据真源仍在 `guardRail.ts`，loop 只多一次钩子调用。**未纳入（刻意）**：`write_fail` 不预登记——批内模型看不到失败结果，按未发生的失败预拦会误伤同批中本可成功的写。

**不收敛的异构护栏**（维持各自为政，见 guardRail.ts 收敛边界）：`duplicateToolCallInterceptor` 软警告、maxIterations/stepBudget 循环终止、self_review 后处理、interruptQueue/pause/ask 续跑、文件覆盖度台账替身回显（分支②/③）。

> 收敛取舍记录：曾计划在 system prompt 追加「## 行为护栏」通用声明节，已去掉——常量注入改变每 turn 的 token 预算（撞破极小预算截断测试标定）且让 `[TAG]` 令牌在常驻 system prompt 出现而干扰运行时拒绝消息定位。衔接提示词以运行时即时渲染为准，`buildPromptSection` 保留为宿主可选能力。

## 九、关联文档

- [agent-design-philosophy.md](./agent-design-philosophy.md) —— 设计哲学真理源（turn/step/loop/多 turn 任务编排/Handoff/气口相关章节）
- [task-driven-closed-loop.md](./task-driven-closed-loop.md) —— 多 turn 任务编排语义化：任务驱动的多 turn 收敛模型（已实现的实现记录）
- [module-inventory.md](./module-inventory.md) —— 模块清单（loop.ts）
- `src/agent/loop.ts` —— 实现
- `src/agent/guardRail.ts` —— 运行时护栏 SSOT（衔接提示词/阈值/判定）
- `src/agent/agent.ts` —— 调用边界
