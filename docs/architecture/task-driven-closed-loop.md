# 任务驱动的多 turn 任务编排收敛模型

> **⚠️ 2026-09-04 整体废弃**：本文论述的多 turn 任务编排架构（难度分级 `difficulty.ts` + `externalTaskLoop`/`runStepSequence` 跨 turn 串联 + `runReport` 汇报 turn）已全部删除（-1181 行）。**历史设计记录原样保留**——它记录了从"多 turn 串联"架构到"单 turn step 循环驱动"的完整探索过程。收敛后的现状：所有复杂度（任务表、会议多角色、动态进度追踪）在一个 turn 的 step 循环内自然生长，LLM 自主调 `task_table_write` 而非强制前置规划。任务表工具（`task_table_write/update/complete`）+ 会议机制（`tryBuildMeetingPlan` 预置 writePlan）全部保留。
>
> 现状真理源：[agent-design-philosophy.md](./agent-design-philosophy.md)（头部收敛补记已更新）· 代码：[orchestrator.ts](../../src/agent/seed/orchestrator.ts) · [loop.ts](../../src/agent/loop.ts)
>
> **原定位（历史）**：本模型是"turn（问答闭环）= 种子"哲学的**多 turn 任务编排语义化**——它回答一个问题：**复杂的笼统问题，如何从一棵干净的种子长成"有条理、有起点、有终点"的多 turn 执行？**
>
> **原状态（历史）**：已实现（2026-09-03 术语统一更新）。本文论证的目标形态已全部落地于 seed/orchestrator——难度分级 + 多 turn 任务链编排 + 收尾汇报 turn。**2026-09-04 整体废弃删除**（-1181 行），现为历史设计记录。
>
> **哲学真理源**：[agent-design-philosophy.md](./agent-design-philosophy.md)（turn·step·loop·多 turn 任务编排）· [loop-design.md](./loop-design.md)（loop = 对 step 的编排）· [module-inventory.md](./module-inventory.md)（模块现状）

---

## 〇、核心命题

> **触发器分两态：简单问题一问一答（单 turn 闭环）；复杂问题通过"任务驱动的多 turn 编排"收敛（多 turn + 起始与收尾 turn），直到问题收敛完毕。**

turn（问答闭环）是**单一真理源**——无论简单还是复杂，都是同一棵种子。复杂度不改变单元，只改变**如何串联单元**：

| 问题难度 | 行为 | turn 数 |
|---------|------|--------|
| 简单 | 直接回答，一问一答 | 1 轮 |
| 复杂 | 编排任务链 → 逐个 turn 执行 → 收敛汇报 turn | 多轮（多 turn 任务编排） |

---

## 一、完整生命周期（目标形态）

```
外部输入（大问题）
  │
  ├─[LLM 判难度]──────────────┐
  │  简单                     │ 复杂
  ▼                           ▼
 直接回答               【第 1 个 turn】调查 + 编排任务链
   │（一轮 done）            │  task_table_write 建长任务链
   │                         ▼（本轮结束，进入多 turn 任务编排）
   │                  【多 turn 任务链】逐步驱动多轮 turn
   │                    ├─ 每轮解一个任务，task_table_update 标记
   │                    ├─ 过程中可主动提问 / 用户插话 / 暂停续跑（气口在 step 之间）
   │                    └─ 任务链全部 done → 收敛
   │                         ▼
   │                  【汇报 turn】汇总任务结果，产出总结汇报
   ▼                         ▼
  结束                    【摘要提炼】汇报 turn → round-summary（摘要即记忆）
```

---

## 二、五个阶段的落地映射（目标形态 → 实现）

| # | 阶段 | 目标形态 | 实现（实证） | 差距 |
|---|------|---------|------------|------|
| 1 | **难度分级** | LLM 判简单/复杂，简单直接一轮 done | ~~✅ [difficulty.ts](../../src/agent/seed/difficulty.ts)：simple/unknown → 档1 直答~~ **已废弃（2026-09-04，文件已删除）** | 无 |
| 2 | **调查** | 复杂时用 read_file/list_dir 等工具调查实情 | ✅ 内置工具已具备（规划 turn 注入 PLAN_ONLY 引导调查建表） | 无 |
| 3 | **编排任务链** | 规划 turn 只建任务表（task_table_write），不执行步骤 | ~~✅ `externalTaskLoop` 规划 turn~~ **已废弃** | 无 |
| 4 | **多 turn 执行** | 任务链逐步驱动多 turn 到收敛 | ~~✅ `completeExternalTask`/`runStepSequence`~~ **已废弃** | 无 |
| 5 | **汇报 + 摘要** | 独立汇报 turn → 汇总 → 提炼摘要 | ~~✅ `finalizeExternalTask`/`runReport`~~ **已废弃**；现为后台 round-summary | 无 |

---

## 三、两个关键设计决策

### 决策 A：loop（step 编排） × 多 turn 任务编排——双轨配比，正交互补

> **背景**：loop.ts `runIterationLoop`（turn 内对 step 的编排，即"官方 loop"）已存在；本模型引入的"档2 多 turn 任务编排"（跨 turn 的任务链驱动，代码 `externalTaskLoop`）是另一层编排——**两者不在同一个概念层，不是非此即彼的互斥**。

| 任务类型 | 驱动对象 | 语义 | 现有性 |
|---------|---------|------|--------|
| **turn 内 step 编排（官方 loop）** | 单 turn 内 LLM↔工具交替（`runIterationLoop`） | "一个 turn 有多深" | ~~✅ 已实现~~ **已废弃（2026-09-04）** |
| **多 turn 任务编排（档2）** | 跨 turn 串联（规划 turn + 步 turn 序列 + 汇报 turn，`externalTaskLoop`/`runStepSequence`） | "一次任务有多长" | ~~✅ 已实现~~ **已废弃（2026-09-04）** |

**判定**：两者正交互补——turn 内 step 保持深（复杂步骤在单 turn 内连续执行，loop.ts `runIterationLoop`），多 turn 任务编排在 turn 级串联长（清单驱动多 turn，orchestrator 步 turn 序列）。对照哲学 §7.3「loop 深 / 多 turn 任务编排长」配比。注：「externalTaskLoop 里带的 Loop」为历史标识符残留，术语层面已统一为「多 turn 任务编排」（档2）。

### 决策 B：多 turn 任务编排的终止语义化——从"撞上限"到"任务收敛 + 汇报"

> **背景**：撰文时档2 编排只是"重复拉起 turn"的硬循环；本模型将其升级为"任务链驱动 + 收敛汇报 turn"，现已在 orchestrator 落地（决策 A 同批实现）。注意此处的"loop 字样"指「档2 多 turn 任务编排」（历史遗留叫法），非官方 loop = 对 step 的编排。

| 维度 | 撰文时现状 | 当前实现 |
|------|------|------|
| 触发 | 无条件进入编排 | difficulty 判 complex 且 `taskLoopLimit>0` 才进入（[difficulty.ts](../../src/agent/seed/difficulty.ts)） |
| 驱动 | 无任务语义，单纯重复 turn | 任务表 pending 步逐步指导下一步（`getNextPendingStep`，步 turn stepPrompt） |
| 终止 | 撞 maxIterations/stepBudget | 任务链 pending 耗尽收敛；触顶兜底报告进度 + 列未完成（`finalizeExternalTask`） |
| 收尾 | 直接断开 | **独立汇报 turn**（`runReport` 汇总 → 汇报单源摘要，摘要恒 1:1） |

---

## 四、汇报 turn → 摘要记忆（决策 C，高价值纯增量）

> **核心洞察**：任务收敛后的独立汇报 turn，是**摘要记忆的最佳信息源**——它天然是一段自洽的"我做了什么"总结，直接可提炼为 round-summary（摘要即记忆单轨）。
>
> **已实现 → 2026-09-04 废弃**：`runReport` 汇报 turn 机制整体删除。现为后台异步 round-summary（`agent.ts` postProcess 生成，摘要↔外部输入恒 1:1）。

**为什么这是良配**：
- 汇报 turn 的产出 = 结构化总结（目标回顾 + 已完成步骤 + 结果），比零散对话更易提炼
- 符合"摘要即记忆"——汇报本身就是一条高质量摘要候选，无需新机制
- 落地即**纯新增**：在任务链收敛后，再编排一次"汇报" turn，其产出走既有 round-summary 生成管线

---

## 五、turn × loop × 多 turn 编排运行时的既有能力（现状已具备，无需新建）

> 用户记忆中的"编排运行时能做什么"——**全部真实存在于代码**，是 turn 内 step 边界的天然能力，非补丁：

| 能力 | 真实实现 |
|------|---------|
| **主动提问** | `ask_user` 内置工具（2026-09-04 通道收敛替代 `[ASK]` 文本）→ loop 检出挂起 → `question_pending` 事件（气口：step 之间） |
| **用户插话** | `interject()` 排队 `pendingInterjections`，step 边界统一注入 user 消息（申请 → 气口生效，单一模式） |
| **撤回插话** | `removePendingInterject(index)` 从队列中删除（宿主待发送区每条的 × 按钮；与 interject 对称，step 边界消费前可安全删） |
| **申请暂停** | `requestPause()` → step 边界 `yield paused` 挂起（暂停收口统一翻态 + 写 pauseMeta） |
| **取消暂停申请** | `cancelPauseRequest()` 清除在途暂停申请（用户点了暂停后又反悔；UI 立即翻视觉） |
| **判断暂停状态** | `isPausePending()` 区分三态：暂停申请在途 / 已挂起 / 无暂停（宿主 pauseBtn toggle 依据） |
| **放弃暂停（停止）** | `sessionManager.discardCheckpoint()` 停定时器 + 删存储 + 清内存 + resetToRunning（宿主 handleStop paused 态调之；与 pause 创建检查点对称） |
| **继续运行** | `continueAfterPause()` 从 step 边界续跑 |

> **2026-09-05 Phase 4.1 收敛注脚**（Phase 4 原始落地后二次炼化）：
> 1. **clear_pending_queue 已双写**（commit 010d5f65）：宿主「全部清空」按钮之前只清镜像不清内核，现已补全为 `loop.clearPendingInterjections()` 原子方法 + 宿主同步。
> 2. **discardCheckpoint 协同 loop**（commit 010d5f65）：暂停检查点放弃时，`loop.pendingInterjections` 孤儿数据一并清理（暂停上下文 = checkpoint + queue 全清）。
> 3. **宿主 `_pendingQueue` 镜像层移除**（commit 65b54250）：宿主不再维护第三层镜像（`loop.pendingInterjections` 是唯一真理源，宿主通过 `getPendingInterjections()` getter 读当前值渲染），彻底消除双写风险。
> 4. **forkBtn disabled 锚点 bug 修复**（commit 65b54250）：`updateSessionControlsLock` 之前读 `forkBtn.dataset.roundId`（forkBtn 自身从未设 roundId），改为 closest 父块继承，与点击 handler SSOT 一致。

**2026-09-05 已退役测试**：handoff(end/loop) 两个死测试删除（handoff chunk 机制已在 commit 180b5fdc 删除，chatView.ts 无 type: 'handoff' handler）。

**结论**：这些是"turn 内 step 边界天然提供的交互点"，本模型只需在多 turn 执行阶段**正常使用**它们，不新增机制。

### 档2 步 turn 序列记忆策略（2026-09-01 定案：不强制召回，LLM 按需自取）

步 turn 序列（`runStepSequence`）中每个步 turn 的 `recalledMemories` 恒空（orchestrator 传 `[]`）——**显式不强制召回，属设计选择而非缺口**：

- **基座已足**：规划 turn 已做一次语义召回注入（残留上下文供后续步骤复用）；步 turn 间正文经完整对话层累积，任务上下文不缺失。
- **按需自取**：LLM 在步进中需要全局记忆/历史决策时，主动调用 `search_memories`（全局关键词）→ `trace_summary`（回溯原文）自取——与"装配帧内核召回 + 运行帧 LLM 按需"的混合设计一致，不把召回决策权强制交给内核。
- **理由**：强制每步召回需重定义"触发源语义"（步 turn 算外部驱动还是自动续跑，哲学 §12.4）、每步 recall 成本 + exclude 互斥维护；而兜底工具已存在，先例 = search_project P1-1（不改机制、强化工具描述引导）。
- **抓手**：`search_memories` 工具描述已补"多步任务需要历史决策/既有记忆时主动调用"引导（2026-09-01）。真实场景若发现 LLM 大量遗忘调用导致终局质量下降，再评估强制步 turn 召回（届时须先拍板触发源语义）。

### `ask_user` 主动提问（2026-09-04 定案：提问 = 一次普通工具调用）

> **定案**：主动提问收敛为 **`ask_user` 内置工具**（对齐 Claude Code AskUserQuestion 机制）——LLM 调 `ask_user(question, options?, allowCustom?)` 时，loop 检出后**整轮挂起**（step 边界气口），用户答案经 `answerQuestion()` 以 **tool result 回填**（与 assistant.tool_calls 配对，结构恒合法），再 `continueAfterPause` 续跑。
>
> **收敛补记（2026-09-07）——提问轮不推进 step**：挂起型迭代（含将挂起的 `ask_user`）不触发 step 边界自动完成——问答对归当前 active step，回答续跑后由后续完整迭代在边界完成该步。与用户暂停（迭代边界挂起、不推进 step）对称；否则提问迭代会在 `onStepBoundary` 先把当前步 done 再挂起，回答产出被错归下一步（判定经 `willSuspendForAsk` 单收口，与挂起检出共用）。

| 形态 | 行为 |
|------|------|
| LLM 调 `ask_user`（独占工具轮） | assistant.tool_calls 完整入史（不撕工具）→ `question_pending` 事件 + 软暂停 → `answerQuestion` 回填 → 续跑 |
| `ask_user` 与普通工具并存 | **整轮挂起**：提问是决策关口，其余工具不执行（等答案后续跑重新决策） |
| turn 内提问超 `askLimit` | 硬护栏拒绝（回填 `[ASK_LIMIT]`，不挂起，其余工具照常执行） |
| 提问后未回答直接续跑 | `cancelAsk()` 兜底补占位 tool 结果（防 assistant.tool_calls 无配对 → 400） |

**为何替代 `[ASK]` 文本约定**：`[ASK]` 在工具轮与文本提问并存时会把即将执行的工具调用"撕掉"（OpenAI 兼容端要求 tool_calls 必有配对 tool 结果）；工具化后提问本身就是工具轮的一环，冲突从根上消除。

### 已知边界记录（暂不修复）

**续跑时插话时序**：paused 后 `interject()` 的排队消息在续跑时消费，且 resume 输入先于插话 append（`continueAfterPause` 与 `handleIterationResult` 的追加顺序）。场景罕见（暂停后立刻插话）、影响极小，此处仅记录，不承诺修复。

---

## 六、自审查与 turn/多 turn 编排的关系

> **问题**：角色包有自审查开关（`reflect.selfReview` → `selfReviewEnabled`，false=关闭）。进入多 turn 任务编排后，自审查是"每个 turn 各审一遍"还是"整个编排结束才审"？
>
> 注意：自审查键的历史别名（旧名 `loopContinue`，是"续跑继续"的语义——Handoff 决策 `loop` 值，非官方「loop = 对 step 的编排」概念）已随术语收口更名 `selfReview`；该别名键本身亦已于 2026-09-11 整键删除（安装基数 0，无真实兼容对象）。

### 结论：自审查粒度 = "单个 turn"，不是"整个编排汇总"

关键在 `selfReviewDone` 的 reset 边界——它在 `processUserInput` 入口归 false（[loop.ts](../../src/agent/loop.ts) `resetTurnState`），在该 turn `done` 时经 `handleIterationResult` 触发自审后置 true（单次终审，不再计数）。因此 **自审查范围限定在"一个 turn 内部"**，不跨 turn 累计。

| 形态 | 自审查行为 |
|------|-----------|
| **档1 单 turn**（一次 `processUserInput` 内多个 step） | turn 内所有 step 共享一个 `selfReviewDone`，只在**那次输入的最终 done** 审一次，不每 step 一审 |
| **档2 多 turn 任务编排**（`externalTaskLoop` 步 turn 序列） | 每步独立 `processUserInput` → 各自 done 审一次；收尾汇报 turn 自带一次汇总审 |

> **触发门槛（2026-08-28 补充）**：自审查只在 turn 内**实际执行过工具步**（多 step 的 loop）后才接入——一遍过的纯文本问答不触发（无外部校验信号，避免"为审而审"）。审查应答为满意短确认（如"无需修改"）时**立即终止**（满意即停），不再追问下一轮审查。

### 落地后（已实现）

按本模型实施（orchestrator `runStepSequence` 步 turn 序列），多 turn 编排是"多个独立 turn"，自审按任务分解：

```
任务链
 ├─ 任务1 → 独立 turn ① → done → 自审①
 ├─ 任务2 → 独立 turn ② → done → 自审②
 ├─ 任务3 → 独立 turn ③ → done → 自审③
 └─ 汇报 → 汇报 turn → done → （汇报自带一次自审）
```

**不需要为"多 turn 编排自审"写任何特殊逻辑**——只要"每个任务是独立 turn"，各自自审自动成立。

### 一个免费的自洽：汇报 turn 也自带一次自审

汇报 turn 本身也是 turn，其 `done` 后同样走 `selfReviewEnabled`。因此：

- 若接受默认 → **每任务各审 + 汇报自然带一次汇总审**（零额外代码）
- 这是本模型的**免费收益**：汇报的"整体质量审"由 turn 机制天然提供，无需专门的"汇总自审"机制

### 与汇报 turn 的分工

- **任务自审**（每 turn）：管"单个任务干得好不好"，粒度 = 单任务
- **汇报自审**（汇报 turn，免费）：可承担"整个任务汇总"的审查，粒度 = 全任务
- 两者粒度不同、天然分工，正符合本模型的收敛结构

> 落地即目标态行为：每步 turn 独立 roundId（`runStepSequence`），各自的 done 触发各自自审；汇报 turn 自带一次汇总审。无需为"多 turn 编排自审"写任何特殊逻辑——只要"每个任务是独立 turn"，各自自审自动成立。

---

## 七、与哲学的一致性验证

| 哲学论断 | 本模型 |
|---------|--------|
| turn = 最小单元 | ✅ 简单/复杂都用一个种子（turn） |
| loop = 对 step 的编排（turn 内 Act） | ✅ turn 内部 runIterationLoop 驱动多 step |
| 多 turn 任务编排 = 对 turn 的串联（档2） | ✅ 外部任务链 = turn 的语义化串联 |
| 「loop 深 / 任务编排长」配比 | ✅ turn 内 step 深 + 档2 turn 串联长，双轨并存 |
| 摘要即记忆 | ✅ 汇报 turn → round-summary，单轨不破 |
| 没有第二套引擎 | ✅ 任务链只是"turn 用什么顺序被调用"，不造新引擎 |

---

## 八、实施分期建议

| 阶段 | 内容 | 落地情况 |
|------|------|---------|
| **第一版** | 难度分级（简单直接回答）+ 独立汇报 turn + 汇报→摘要提炼 | ~~✅ 已实现~~ **已废弃（2026-09-04）**（[difficulty.ts](../../src/agent/seed/difficulty.ts) + `finalizeExternalTask`：`runReport` → 汇报单源摘要） |
| **阶段 2** | 外部任务驱动的多 turn 编排（task_table 驱动档2 串联 + 终止语义化 + 汇报 turn） | ~~✅ 已实现~~ **已废弃（2026-09-04）**（`externalTaskLoop`/`completeExternalTask`/`runStepSequence`，随 seed 收敛并入 orchestrator） |

> 两阶段均已落地，本文由「实施建议」转为「实现记录」。任务表清场（⑦ 排雷）：收尾/硬中止后 `clearPlan`，防残留 pending 步被下一次输入误续旧链。

---

## 九、关联文档

- [agent-design-philosophy.md](./agent-design-philosophy.md) —— 种子哲学真理源（turn·step·loop·多 turn 任务编排）
- [loop-design.md](./loop-design.md) —— loop = 对 step 的编排，多 turn 任务编排落于 orchestrator
- [memory-as-summary.md](./memory-as-summary.md) —— 摘要即记忆，汇报 turn→摘要的落点
- [module-inventory.md](./module-inventory.md) —— 模块现状清单