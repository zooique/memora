# Loop 模块设计 —— 对 step 的编排（turn 回答中阶段）

> **文档定位**：模块重思（module-rethink）产出。聚焦 [src/agent/loop.ts](../../src/agent/loop.ts)，论证「loop（Agent Loop）= turn 回答中阶段对 step 的编排」与「多 turn 任务编排 = orchestrator 对 turn 的串联」两套概念在现状代码中的落地情况，识别偏差点与生长点，作为后续方案生长的输入。
>
> **状态**：已对齐实现（2026-09-03 术语统一更新）。按官方口径：`loop.ts` 中 `runIterationLoop` = **对 step 的编排（Agent Loop）**；[orchestrator.ts](../../src/agent/seed/orchestrator.ts) 中 `externalTaskLoop`/`completeExternalTask` = **多 turn 任务编排**（规划 turn + 步 turn + 收尾 turn 的串联），不再占用 Loop 一词。
>
> **哲学真理源**：[agent-design-philosophy.md](./agent-design-philosophy.md)（turn·step·loop·多 turn 任务编排·Handoff·气口相关章节）

---

## 一、模块边界与职责

| 项 | 内容 |
|----|------|
| 文件 | `src/agent/loop.ts`（2212 行） |
| 状态 | 🟢 已打磨（76 tests） |
| 职责 | 档1 turn（问答闭环）的 Act 引擎（含 loop = 对 step 的编排）；档2 多 turn 任务编排在 seed/orchestrator |
| 上游 | `agent.ts` 经 `seed/orchestrator.ts`（`runChat`/`runEvent`/`runResume`）委托调用 `processUserInput` / `continueAfterPause` / `processEvent` |
| 下游 | `contextManager.ts`（截断/摘要）、`compaction.ts`（微压缩）、`duplicateInterceptor.ts`（重复拦截）、`role-pack` 策略（L2） |

**核心事实**：loop.ts 承载单个 turn（问答闭环）的 Act 引擎，内部 `runIterationLoop` = **loop（对 step 的编排）**（官方「Agent Loop」本义）；**多 turn 任务编排**（档2，规划 turn + 步 turn + 收尾 turn 的串联）由 seed/orchestrator 承担。哲学「深 vs 长」配比在代码中同构落地：**loop 深度由 `toolStepLimit` 决定（一轮有多深），多 turn 任务编排长度由 Handoff=loop 续跑与 taskLoopLimit 决定（一次任务有多长）**。因此 loop.ts 不需要第二套引擎，也不应该拆成两个模块；它天然是一个"自己内部含 step 循环、外部被 orchestrator 串联"的完整单元。

---

## 二、哲学映射矩阵（现状 vs 哲学）

| 哲学概念 | 现状实现（loop.ts） | 对齐度 |
|---------|--------------------|--------|
| turn = Prepare/Act/Reflect 三阶段 | **Prepare**：`_injectRecall`（召回注入）+ 用户消息 push + 状态重置<br>**Act**：`handleIteration`（step：一次 LLM 生成 + 可选工具执行，多 step 由 `runIterationLoop` 驱动即 loop）<br>**Reflect**：`handleIterationResult`（Handoff 决策）；摘要/归档在 `agent.ts` 后处理 | ✅ 高 |
| loop = 对 step 的编排（Act 内部） | `runIterationLoop` 反复拉起 step：LLM 推理 → 工具执行 → 回填 → 再推理；深度由 `toolStepLimit` 控制 | ✅ 高 |
| loop（step 深度） × 多 turn 任务编排（turn 长度）配比 | loop 深度：`toolStepLimit`（单 turn 工具步数）；任务编排长度：`stepBudget` / `maxIterations` / `taskLoopLimit` | ✅ 高 |
| Handoff = turn 出口衔接决策 | `handleIterationResult` 返回 `continue / done / paused / aborted`，上层据此决定 `wait`/`loop`（自动续跑）/`end` | ✅ 高 |
| 触发源决定召回 | `_shouldSkipRecallInjection`（Token 紧时跳过召回）；`_injectRecall` 仅外部输入触发（loop 内部 step 不触发） | ✅ 高 |
| 策略层 = 参数化配置 | `setStrategy(L2RuntimeStrategy)`：工具权限/步数/预算/自审查/插话 全量参数化 | ✅ 高 |
| 终止条件三类（目标/上限/中断） | 目标达成：`done` 分支；上限：`maxIterations`/`stepBudget`/`tokenBudget`/`toolStepLimit`；中断：`abort`/`pause`/`interject` | ✅ 高 |

**结论**：现状已高度对齐设计哲学——**loop（step 编排）是 turn Act 内部的自然属性，没有独立于 turn 之外的第二套引擎**；多 turn 任务编排由 orchestrator 在 turn 出口处串联。

---

## 三、关键机制与哲学一致性分析

### 3.1 turn 的复用接口 = `processUserInput` 本身

哲学「模式统一论」要求：对话 / 多 turn 任务编排 / 目标模式共用**一套 turn**，不引入新引擎。

现状验证：
- **对话模式** = `processUserInput` 执行一次 turn 后 return（Handoff = `wait` 等待用户）。
- **多 turn 任务编排（档2）** = seed/orchestrator 的 `externalTaskLoop` 编排多个 `processUserInput`（turn）——规划 turn（PLAN_ONLY 只建任务表）→ 步 turn 序列（每步独立 roundId）→ 收尾汇报 turn（`runReport`）。多 turn 串联不在本引擎内重复（本类注释：「真正的多 turn 任务编排由 seed/orchestrator 的 externalTaskLoop 承载，不在本引擎内」）。
- **续跑** = `continueAfterPause` 复用同一套 `handleIteration` + `handleIterationResult`（软暂停后从 step 边界恢复）；多 turn 任务编排上下文中 `runResume` 续完当前 turn 后继续推进剩余步 + 收尾。

**设计结论**：turn 的最小复用单元就是 `processUserInput` 这个生成器，**无需也不应新增"独立 turn 类"**。未来目标模式只需在"回答后"插入对齐环节，仍复用同一 turn。

### 3.2 loop（step 编排）是 turn Act 内部的自然属性

哲学：loop 决定"一轮有多深"，多 turn 任务编排决定"一次任务有多长"，两者是**可配比的资源**而非固定结构。

现状验证：
- `handleToolCalls` 内：L2 策略检查（`toolCallsBlocked`）→ 步数限制（`toolStepLimit`）→ 并发执行（`executeToolCalls`）→ 重复检测（`duplicateCallInterceptor`）→ Reflection（`reflectionHint`）→ 回填 `return 'continue'`。
- step（每次 LLM 调用 + 工具）的迭代边界 = 天然的暂停点 / abort 检查点（`raceToolWithSignal`）。**气口在此发生**（LLM 主动提问、用户插话、暂停续跑）。

**设计结论**：loop 深度由 `toolStepLimit` / `toolCallsBlocked` 控制；多 turn 任务编排长度由 `stepBudget` / `maxIterations` / `taskLoopLimit` 控制。角色通过策略选择配比，不改 turn 结构——与哲学完全一致。

### 3.3 Reflect 阶段在 loop 之外承接

哲学：回答后 = **同步 Handoff 决策** + **异步提炼沉淀**。

现状验证：
- loop 只做同步的 Handoff 决策（`handleIterationResult` 的 done/continue 判断）。
- 摘要生成、记忆归档、历史持久化在 `agent.ts` 的后处理（`history.appendAssistant`、`postProcess`）完成。

**设计结论**：loop 不承载提炼沉淀——这是正确的边界。摘要/归档属于"回答后异步"，不应被塞进 loop 的 Handoff 决策里。

---

## 四、偏差点与生长点

现状高度对齐；3 个概念/接口级对齐点中 1、2 已随 seed 收敛落地（2026-09-01 实证），3 仍为远期锚点：

| # | 对齐点 | 收敛状态 | 现状（实证） |
|---|--------|---------|------------|
| 1 | 概念命名"step" vs "turn" | **已收敛**（术语表 2026-09-03） | step = `runIterationLoop` 内每次 LLM 调用 + 工具；turn = `processUserInput` 一次完整执行（一个 roundId）；loop = 对 step 的编排（`runIterationLoop`） |
| 2 | 终止条件分散 | **已语义化**（多 turn 任务编排） | 任务编排终止由任务链收敛承担（orchestrator 按 pending 步驱动、耗尽即收尾汇报）；loop 以 `toolStepLimit` 约束深度；turn 整体以 `stepBudget`/`tokenBudget`/`maxIterations` 兜底。统一表述为「**Handoff 决策的输入集合**」：目标达成 / 资源上限 / 用户中断（对齐哲学"终止条件三分类"） |
| 3 | 目标模式接口形状未预留 | 待实现（远期锚点） | 仍不实现；明确定位：未来目标模式 = 回答后插入对齐环节（差距分析 → 新 Trigger），插入点收敛在 orchestrator（闭环编排容器），仍复用 `processUserInput` 单轮闭环 |

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

**结论**：平面化是事实，但记忆健康由「每轮外部输入重注最新记忆 + tail 保护最近」自然保证，旧块让位是节流非缺陷；装配层 `memoryLayerCapTokens` 已前置限制注入量。**不引入记忆层独立保护机制**（避免过度设计）。前置依赖：上下文管理与引擎的配合全景见 [agent-design-philosophy.md §12](agent-design-philosophy.md)（预算装配 / 替换·压缩两级 / 软上限·装配前判负）。

---

## 五、设计方案：保持单一闭环复用，不新增机制

> 设计总纲：**loop（Agent Loop）满足"对 step 编排"的官方口径**，方案以"概念对齐 + 接口形状确认"为主；多 turn 任务编排已随 seed 收敛落于 orchestrator（loop.ts 保持为档1 turn 的 Act 引擎），接口契约由 §5.1 固化。

### 5.1 确认的接口契约（当前已成立，文档固化）

| 契约 | 内容 | 消费方 |
|------|------|--------|
| `processUserInput` = turn 最小复用单元 | 召回注入 → Act（含 loop=step 编排） → Handoff | `agent.ts`（对话）+ orchestrator（任务编排规划/步 turn） |
| `continueAfterPause` = 软暂停续跑入口 | 从 step 边界恢复，复用同一 turn | `agent.ts`（pause/resume） |
| `handleIterationResult` = Handoff 决策唯一出口 | 返回 `continue/done/paused/aborted` | 任务编排 + 自审查 |
| `setStrategy(L2RuntimeStrategy)` = 行为配比唯一入口 | loop 深度 + 多 turn 任务编排长度 + 工具权限 | `agent.ts`（角色包策略注入） |
| `externalTaskLoop`/`completeExternalTask`/`runStepSequence` = 档2 多 turn 任务编排 | 规划 turn → 步 turn 序列（每步独立 roundId）→ 收尾汇报 turn + 汇报单源摘要 | seed/orchestrator（runChat 复杂路径 + runResume 续跑） |

### 5.2 生长路径（未来可执行，非本期）

1. **目标模式**（哲学「目标模式」，远期）：在 orchestrator 收尾（`finalizeExternalTask` → handoff）后插入"对齐检查"环节——对齐未达则生成新 Trigger 继续，达成则 done。**无需新引擎**，只增加编排层一个节奏分支，仍复用 `processUserInput` 单轮闭环。
2. **子 Agent 套娃**（哲学「子 Agent 递归」）：子 Agent = 另一个 `AgentLoop` 实例，主 turn 通过工具调用它。**无需改造 turn**，工具层新增一个"子 Agent 工具"即可。

---

## 六、验证建议（架构无改动，仅验证现状已对齐）

1. **对话模式**：一次提问 = 单个 turn 结束即 return，无多余 step。
2. **多 turn 任务编排模式**：多 turn 自动续跑，每 turn 边界可见 `tool_start`/`tool_result`/`roundBoundary` 回调（turn 可观察性）。
3. **策略配比**：设 `toolStepLimit=1` + `stepBudget=3`，验证 loop 浅、任务编排长；反之验证 loop 深、任务编排短。
4. **软暂停续跑**：`requestPause` 后 `continueAfterPause` 从 step 边界恢复，不重复执行已完成的工具。

---

## 七、多 turn 任务编排语义化（已落地）

本文论证的是**现状对齐**（loop = 对 step 的编排、externalTaskLoop = 多 turn 串联）。多 turn 语义化——复杂问题由"任务链驱动 + 收敛汇报"——最初是 [task-driven-closed-loop.md](./task-driven-closed-loop.md) 的设计愿景，现已在 seed/orchestrator 落地：

| 撰文时现状（loop-design） | 当前实现（seed/orchestrator + difficulty） |
|---------------------|--------------------------------|
| 档2 while 无条件串联 turn | 由 `externalTaskLoop` 任务链驱动，有明确起点/终点 |
| 简单/复杂都进串联 | 难度分级（[difficulty.ts](../../src/agent/seed/difficulty.ts)），simple/unknown 直接一轮 turn done |
| 触顶硬终止 | 任务链 pending 耗尽收敛；触顶兜底报告进度 + 列未完成 |
| 无收尾 | 收尾汇报 turn（`runReport`）→ 汇报单源摘要（摘要恒 1:1） |

> 根与枝叶关系不变：本文证明"loop 是 turn Act 内部对 step 的编排"这个根；task-driven 文档在此根上长出"多 turn 任务驱动 + 汇报"的枝叶——其角色已由「目标」转为「实现记录」。演进关系见 [task-driven-closed-loop.md §七](./task-driven-closed-loop.md)。

---

## 八、关联文档

- [agent-design-philosophy.md](./agent-design-philosophy.md) —— 设计哲学真理源（turn/step/loop/多 turn 任务编排/Handoff/气口相关章节）
- [task-driven-closed-loop.md](./task-driven-closed-loop.md) —— 多 turn 任务编排语义化：任务驱动的多 turn 收敛模型（已实现的实现记录）
- [module-inventory.md](./module-inventory.md) —— 模块清单（loop.ts 🟢 76 tests）
- [方案-seed收敛](../../tasks/归档/方案-seed收敛-最小问答闭环真理源-20260820.md) —— 种子收敛方案（含阶段 2 外部任务）
- `src/agent/loop.ts` —— 实现
- `src/agent/agent.ts` —— 调用边界
