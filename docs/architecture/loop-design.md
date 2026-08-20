# Loop 模块设计 —— 单一闭环的编排

> **文档定位**：模块重思（module-rethink）产出。聚焦 [src/agent/loop.ts](../../src/agent/loop.ts)，论证「Loop 是对单一闭环的编排，基于单一闭环自然生长」在现状代码中的落地情况，识别偏差点与生长点，作为后续方案生长的输入。
>
> **状态**：探索中（可逆决策，未固化 ADR）。本文不新增机制、不承诺接口，仅论证设计与现状。
>
> **哲学真理源**：[agent-design-philosophy.md](./agent-design-philosophy.md)（闭环·Loop·内循环·回答后 Handoff 相关章节）

---

## 一、模块边界与职责

| 项 | 内容 |
|----|------|
| 文件 | `src/agent/loop.ts`（1493 行） |
| 状态 | 🟢 已打磨（76 tests） |
| 职责 | 单轮问答闭环的执行 + Loop（外循环）编排 |
| 上游 | `agent.ts` 调用 `processUserInput` / `continueAfterPause` / `processEvent` |
| 下游 | `contextManager.ts`（截断/摘要）、`compaction.ts`（微压缩）、`duplicateInterceptor.ts`（重复拦截）、`role-pack` 策略（L2） |

**核心事实**：loop.ts 是「单轮闭环」与「循环编排」的**合体**——这正是哲学所要求的形态。哲学指出：**Loop 的每一轮都是一次完整的单轮闭环，Loop 只是在 Handoff 处选择"继续"**。因此 loop.ts 不需要第二套引擎，也不应该拆成两个模块；它天然是一个"能重复自己的闭环"。

---

## 二、哲学映射矩阵（现状 vs 哲学）

| 哲学概念 | 现状实现（loop.ts） | 对齐度 |
|---------|--------------------|--------|
| 闭环 = Prepare/Act/Reflect 三阶段 | **Prepare**：`_injectRecall`（召回注入）+ 用户消息 push + 状态重置<br>**Act**：`handleIteration`（LLM 生成 + 工具内循环）<br>**Reflect**：`handleIterationResult`（Handoff 决策）；摘要/归档在 `agent.ts` 后处理 | ✅ 高 |
| Loop = 闭环的重复（外循环） | `processUserInput` 的 `while (iteration < maxIterations)` + `continueAfterPause` 续跑 | ✅ 高 |
| 内循环 vs 外循环配比 | 内循环深度：`toolStepLimit`（单轮工具步数）；外循环长度：`stepBudget` / `maxIterations` | ✅ 高 |
| Handoff = 回答后衔接决策 | `handleIterationResult` 返回 `continue / done / paused / aborted`，决定"是否有下一轮、以什么姿态触发" | ✅ 高 |
| 触发源决定召回 | `_shouldSkipRecallInjection`（Token 紧时跳过召回）；`_injectRecall` 仅外部输入触发 | ✅ 高 |
| 策略层 = 参数化配置 | `setStrategy(L2RuntimeStrategy)`：工具权限/步数/预算/自审查/插话 全量参数化 | ✅ 高 |
| 终止条件三类（目标/上限/中断） | 目标达成：`done` 分支；上限：`maxIterations`/`stepBudget`/`tokenBudget`；中断：`abort`/`pause`/`interject` | ✅ 高 |

**结论**：现状已高度对齐设计哲学——**loop 就是"气口永远选择自动续跑"的单一闭环**，没有独立于闭环之外的循环引擎。

---

## 三、关键机制与哲学一致性分析

### 3.1 单轮闭环的复用接口 = `processUserInput` 本身

哲学「模式统一论」要求：对话 / Loop / 目标模式共用**一套闭环**，不引入新引擎。

现状验证：
- **对话模式** = `processUserInput` 执行一次闭环后 return（Handoff=等待用户）。
- **Loop 模式** = `processUserInput` 委托 `runIterationLoop` 重复闭环（Handoff=自动续跑）。
- **续跑** = `continueAfterPause` 复用同一套 `handleIteration` + `handleIterationResult`（软暂停后从迭代边界恢复）。

**设计结论**：单轮闭环的最小复用单元就是 `processUserInput` 这个生成器，**无需也不应新增"独立闭环类"**。未来目标模式只需在"回答后"插入对齐环节，仍复用同一闭环。

### 3.2 内循环（工具循环）是闭环内部的自然属性

哲学：内循环决定"一轮有多深"，外循环决定"一次任务有多长"，两者是**可配比的资源**而非固定结构。

现状验证：
- `handleToolCalls` 内：L2 策略检查（`toolCallsBlocked`）→ 步数限制（`toolStepLimit`）→ 并发执行（`executeToolCalls`）→ 重复检测（`duplicateCallInterceptor`）→ Reflection（`reflectionHint`）→ 回填 `return 'continue'`。
- 工具循环的每一轮迭代边界 = 天然的暂停点 / abort 检查点（`raceToolWithSignal`）。

**设计结论**：内循环完全由策略参数控制深度（`toolStepLimit` / `toolCallsBlocked`），外循环由策略参数控制长度（`stepBudget` / `maxIterations`）。角色通过策略选择配比，不改闭环结构——与哲学完全一致。

### 3.3 Reflect 阶段在 loop 之外承接

哲学：回答后 = **同步 Handoff 决策** + **异步提炼沉淀**。

现状验证：
- loop 只做同步的 Handoff 决策（`handleIterationResult` 的 done/continue 判断）。
- 摘要生成、记忆归档、历史持久化在 `agent.ts` 的后处理（`history.appendAssistant`、`postProcess`）完成。

**设计结论**：loop 不承载提炼沉淀——这是正确的边界。摘要/归档属于"回答后异步"，不应被塞进 loop 的 Handoff 决策里。

---

## 四、偏差点与生长点

现状高度对齐，但存在 **3 个可生长的概念/接口级对齐点**（非缺陷，不阻塞运行）：

| # | 偏差点 | 现状 | 生长方向 | 优先级 |
|---|--------|------|---------|--------|
| 1 | 概念命名"迭代" vs "闭环" | `handleIteration` 命名暗示"循环的一部分"，但它实为**单轮闭环的 Act 阶段核心** | 文档/注释显式映射「iteration = 单轮闭环实例」，防止未来读者误判为循环内部件 | 低（文档级） |
| 2 | 终止条件分散 | 终止分散在 4 处：循环内 `stepBudget`、`handleIteration` 内 `tokenBudget`、循环外 `maxIterations` 兜底、`handleIterationResult` 的 done 判断 | 文档统一表述为「**Handoff 决策的输入集合**」（目标达成 / 资源上限 / 用户中断，对齐哲学"终止条件三分类"），**不做代码重构**（现状可工作，避免过度设计） | 低（概念收敛） |
| 3 | 目标模式接口形状未预留 | loop 的 Reflect 只有 Handoff 决策，无对齐环节插入点 | **不实现**；仅在文档明确「未来目标模式 = 回答后插入对齐环节（差距分析 → 新 Trigger），仍复用 `processUserInput` 单轮闭环」 | 中（仅约束接口形状） |

**反模式自查**（对照哲学「递归边界确定性」「模式统一论」）：

- ✅ 未引入第二套循环引擎（Loop 复用闭环）。
- ✅ 未用 flag 掩盖设计问题（策略参数化是"配置"，非"补丁"）。
- ✅ 未在 loop 内做领域特化（工具/记忆/策略全注入）。
- ⚠️ 潜在警示：若未来有人为"目标模式"单独建 `GoalEngine`，即违反模式统一论——文档明令禁止。

---

## 五、设计方案：保持单一闭环复用，不新增机制

> 设计总纲：**loop 现状已满足"单一闭环编排"哲学，方案以"概念对齐 + 接口形状确认"为主，零代码重构。**

### 5.1 确认的接口契约（当前已成立，文档固化）

| 契约 | 内容 | 消费方 |
|------|------|--------|
| `processUserInput` = 单轮闭环最小复用单元 | 召回注入 → Act 循环 → Handoff | `agent.ts`（对话）+ 自身（Loop 外循环） |
| `continueAfterPause` = 软暂停续跑入口 | 从迭代边界恢复，复用同一闭环 | `agent.ts`（pause/resume） |
| `handleIterationResult` = Handoff 决策唯一出口 | 返回 `continue/done/paused/aborted` | 循环编排 + 自审查 |
| `setStrategy(L2RuntimeStrategy)` = 行为配比唯一入口 | 内循环深度 + 外循环长度 + 工具权限 | `agent.ts`（角色包策略注入） |

### 5.2 生长路径（未来可执行，非本期）

1. **目标模式**（哲学「目标模式」）：在 `handleIterationResult` 的 done 分支**之前**插入"对齐检查"回调——对齐未达则生成新 Trigger 继续，达成则 done。**无需新引擎**，只增加一个 Handoff 策略分支。
2. **子 Agent 套娃**（哲学「子 Agent 递归」）：子 Agent = 另一个 `AgentLoop` 实例，主 loop 通过工具调用它。**无需改造闭环**，工具层新增一个"子 Agent 工具"即可。

---

## 六、验证建议（架构无改动，仅验证现状已对齐）

1. **对话模式**：一次提问 = 单轮闭环结束即 return，无多余迭代。
2. **Loop 模式**：多轮自动续跑，每轮边界可见 `tool_start`/`tool_result`/`roundBoundary` 回调（闭环可观察性）。
3. **策略配比**：设 `toolStepLimit=1` + `stepBudget=3`，验证内循环浅、外循环长；反之验证内循环深、外循环短。
4. **软暂停续跑**：`requestPause` 后 `continueAfterPause` 从迭代边界恢复，不重复执行已完成的工具。

---

## 七、外循环语义化（生长方向）

本文论证的是**现状对齐**（Loop = 闭环的重复在代码中的落地）。更高的目标是让外循环**有语义**——复杂问题不再是无条件重复，而是"任务链驱动 + 收敛汇报"。这属于 [task-driven-closed-loop.md](./task-driven-closed-loop.md)（任务驱动的多轮闭环收敛模型）的设计愿景，本文不复述。

| 现状（loop-design） | 目标（task-driven-closed-loop） |
|---------------------|--------------------------------|
| loop = while 无条件重复 | loop = 任务链驱动，有明确起点/终点 |
| 简单/复杂都进同一循环 | LLM 判难度，简单直接一轮 done |
| 撞上限终止 | 任务链 done 终止 |
| 无收尾 | 独立汇报闭环 → 提炼摘要 |

> 两者不冲突：本文证明"loop 复用闭环"这个根；task-driven 文档在此根上长出"任务驱动 + 汇报"的枝叶。演进关系见 [task-driven-closed-loop.md §七](./task-driven-closed-loop.md)。

---

## 八、关联文档

- [agent-design-philosophy.md](./agent-design-philosophy.md) —— 设计哲学真理源（闭环·Loop·内循环·回答后 Handoff 相关章节）
- [task-driven-closed-loop.md](./task-driven-closed-loop.md) —— 外循环语义化：任务驱动的多轮闭环收敛模型（生长方向）
- [module-inventory.md](./module-inventory.md) —— 模块清单（loop.ts 🟢 76 tests）
- [方案-seed收敛](../tasks/方案-seed收敛-最小问答闭环真理源-20260820.md) —— 种子收敛方案（含阶段 2 外部任务）
- `src/agent/loop.ts` —— 实现
- `src/agent/agent.ts` —— 调用边界
