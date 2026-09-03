# 术语统一：执行闭环 → turn（问答闭环）、迭代 → step、loop = 对 step 的编排

## Context（为什么改）

用户在讨论中厘清了 memora 与主流官方命名（turn/step/loop）的对应关系，发现现有文档/注释存在**认识错位**：

1. **执行闭环 = 问答闭环 = turn**：现有文档把「执行闭环（最小单元）」和「问答闭环（容器）」区分为两层，实际是一次「用户输入 → 最终回答」就是最小单元，两者是同一实体（一个 roundId）。用户确认：**执行闭环就是问答闭环**。
2. **迭代 / 内循环 = step**：`runIterationLoop` 内的每次 LLM 调用 + 可选工具执行，官方叫 **step**（一次 LLM 交互）。
3. **loop = 对 step 的编排（Agent Loop）**：官方概念中 loop（Agent Loop）= 框架在 turn 内部反复执行多个 step（LLM 推理 → 工具 → 结果回填 → 再推理），即 memora 的 `runIterationLoop`。用户原以为「loop 也是执行闭环」——这是认识错位：执行闭环就是问答闭环（turn），loop 是 turn 内部的 step 编排，不是执行闭环本身。
4. **externalTaskLoop = 多 turn 任务编排，不叫 loop**：复杂任务时对多个 turn 的编排（规划 turn → 步 turn 序列 → 收尾 turn）是**任务编排（task orchestration）**，与官方「loop = 对 step 的编排」不同义，不应占用 loop 一词。
5. **气口在 step 之间，不是只有 turn 之间**：气口（提问暂停/插话/暂停续跑）发生在 step 之间；turn 边界（用户重新输入）是**新的问答闭环**，不是气口，不应混为一谈。

**目标**：按官方命名统一 memora 的概念表述，纠正认识错位。**纯文档+注释层面的术语收敛，零代码逻辑变更，不改代码标识符。**

## 术语映射表（统一口径）

| 官方命名 | memora 统一后表述 | 对应代码 | 原表述（历史别名） |
|---------|-----------------|---------|------------------|
| **turn（问答闭环）** | turn / 问答闭环 | `processUserInput`/`continueAfterPause` 一次完整执行（一个 roundId） | 执行闭环、单轮闭环、单轮执行闭环 |
| **step** | step（一次 LLM 调用 + 可选工具执行） | `runIterationLoop` 内每次迭代 | 迭代、iteration、内循环 |
| **loop（Agent Loop）** | loop = 对 step 的编排 | `runIterationLoop`（turn 回答中阶段） | 内循环、迭代循环 |
| **多 turn 任务编排** | 任务编排（对多个 turn 的编排） | `externalTaskLoop`/`completeExternalTask` | Loop 编排、外循环 |
| **气口** | 气口 = step 之间的暂停点 | 迭代边界暂停 | 闭环边界、Handoff 出口（保留 Handoff 代码概念） |

关键校正：
- 「执行闭环 ⊂ Loop ⊂ 目标模式」三层 → **「turn（内部含 step 循环 loop）→ 多 turn 任务编排 → 目标模式」**。
- **loop = 对 step 的编排**（turn 内部 Agent Loop）；**externalTaskLoop = 对多个 turn 的编排**（复杂任务任务编排），两者概念不同义，`externalTaskLoop` 不再称 Loop。
- 气口定位：**step 之间**（提问/插话/暂停续跑）；turn 之间是新的问答闭环，非气口。

## 改动范围

### 一、核心真理源（必改，概念定义处）

**1. `docs/architecture/agent-design-philosophy.md`**
- 附录术语表（约 L1023-1044）：重构为官方命名体系（turn/step/loop），标注历史别名。
- §1.1/1.2「单轮执行闭环」→「turn（问答闭环）」，三阶段结构图保留（turn 内部三阶段）。
- §2.2 Handoff / 气口（约 L125-152）：明确「气口 = step 之间的暂停点」；Handoff 仍是 turn 出口（wait/loop/end 策略），但**气口暂停**与「turn 之间的新问答」区分开。
- §3.1 Loop（约 L158-182）：表述为「对 turn 的编排」。
- §4.4 三层演进模型（约 L245-277）：改为「turn ⊂ 多 turn 任务编排 ⊂ 目标模式」（**loop 是 turn 内部 step 编排，不构成新层**），更新与主流术语对照表（Single Agent Turn ≈ turn、ReAct 内 LLM↔工具循环 = step）。

**2. `docs/architecture/loop-design.md`**
- 头注与状态（L1-8）、映射矩阵（§二，L25-37）：执行闭环→turn、内循环→step。
- §5.1 接口契约（L120-128）：`processUserInput` = turn 最小复用单元；`handleIteration` = step 处理。
- §四 偏差点表（L80-84）：概念命名口径同步。

**3. `docs/architecture/external-task-pause-resume-design.md`**
- §一 目标语义（L8-16）：气口 = 步（step）之间；loop = 对 turn 的编排。

**4. `docs/architecture/task-driven-closed-loop.md`**
- 〇核心命题、决策 A 内/外循环表（L61-70）：执行闭环→turn、内循环→step、外循环→loop 编排。

### 二、代码头注释（必改，仅注释不改逻辑/标识符）

- `src/agent/loop.ts` 头注释（L1-11）：「执行闭环 act 引擎」→「turn（问答闭环）act 引擎」；runIterationLoop 说明为 step 循环。
- `src/agent/seed/orchestrator.ts` 头注释（L1-20）：三层模型表述同步；「档1 执行闭环」→「turn」。
- `src/agent/seed/types.ts` 头注释（L1-13）：「最小执行闭环」→「turn（问答闭环）」。
- `src/agent/seed/difficulty.ts` 头注释（L1-14）：档1 单闭环 → 档1 单 turn。
- `src/agent/agent.ts` L145-150（seedOrchestrator 注释）：「最小执行闭环编排」→「turn 编排」。
- `src/memory/roundStore.ts` L1-13（Round 头注释）：保持「问答闭环（Round）= turn」表述，与术语表一致。
- `src/agent/types.ts` L36（执行闭环归属标记注释）、`src/agent/constants.ts`、`src/agent/budget.ts`、`src/agent/builtinTools.ts` 中「执行闭环」措辞 → 视上下文替换为「turn/问答闭环」或「该轮」。

### 三、引用文档（顺带同步核心定义处）

- `docs/architecture/memory-as-summary.md`、`host-plugin-alignment.md`、`role-pack-spec.md`、`agent-facade-convergence.md`、`module-inventory.md`：仅同步「单轮执行闭环 = 种子」等核心表述处，不逐字穷举替换。
- `docs/白话设计文档.md`：若含核心定义段则同步，否则不动。

## 不做的事

- ❌ 不改任何代码标识符（`runIterationLoop`、`currentIteration`、`iteration`、`externalTaskLoop`、`AgentLoop`、`Round` 等保持原名）。
- ❌ 不做全库逐字替换（会引入大量无意义 diff），只在**概念定义处**统一口径。
- ❌ 不新增 ADR（可逆探索期，先落 docs/ 验证；若被 src/rules 引用固化再补 ADR）。
- ❌ 不膨胀注释（遵守 comment-doc-slimming-rules 三分法）。

## 验证

1. `npx tsc --noEmit` 零错误（确保注释改动未破坏类型）。
2. `npx vitest run src/agent` 全绿（回归安全）。
3. grep 抽查：`rg "执行闭环" docs/architecture` 应只剩历史别名标注或极少数上下文引用；`rg "runIterationLoop"` 应无变化。
4. 概念一致性核对：新术语表（turn/step/loop）与 loop-design、orchestrator 头注释、agent-design-philosophy §4.4 三处口径一致。
