# 外部任务「气口暂停 → 续跑整链」探索项（探索中 · 未固化）

> **定位**：**探索期文档，非 ADR**（遵循探索期决策沉淀纪律 —— 可逆、未稳定、未固化，先验证后固化）。
> 本页承载「外部任务循环的暂停-续跑」完整语义设计，当前**状态为挂起（探索中），未被任何代码消费，不占 ADR 编号、不改决策 README 索引**。
> 评估通过并被真实场景复现消费后，才固化为 ADR。

---

## 一、目标语义（来自设计意图）

用户在外部任务执行中的"暂停"不是硬停止，而是**申请**：在问答闭环衔接的**气口**（步与步之间、规划后、汇报前）暂停，保留现场；恢复后应**跑完整条剩余任务链**（剩余 pending 步 → 收尾汇报），而非只续当前步。

## 二、当前结构（现状矛盾点）

外部任务循环的串联逻辑目前是**编排器栈上的 `while`**（[orchestrator.ts](../../src/agent/seed/orchestrator.ts) 的 `externalTaskLoop`）：

```
planning 闭环 → for each pending step: 步闭环 → 收敛 → 汇报闭环
```

而软暂停由 [loop.ts](../../src/agent/loop.ts) 内部 `_handleInterrupt` 在**迭代边界**消费 `pauseRequested` 返回 `'paused'`，终止 `runIterationLoop`。

**矛盾**：编排器的 `while` 是栈上逻辑；暂停打断了栈，续跑入口 `runResume → loop.continueAfterPause` 只恢复 **loop 内部迭代**（`this.messages` 保留），**不知道**自己属于外部任务链，续完当前步即结束，不会回到编排器 `while` 继续剩余 pending 步与汇报。这导致「续跑只回当前步、不跑整链」。

## 三、候选方案（待验证）

### 方案 A：可重入编排（完整满足目标，改动较大）
- 把「执行外部任务链」提炼为可重入推进函数，`runChat`（复杂路径）与 `runResume` 续跑共用，杜绝复制。
- loop 增加 `withinExternalTask` 状态标志（规划/步开启、汇报后清除），作为续跑入口判断「是否继续推链」的唯一依据（SSOT）。
- 暂停统一收敛到推进函数顶部的**气口检查**（不再在步内 `act().paused` 分支各自判断），三个分支收敛为一个。
- 代价：跨 loop + orchestrator + 单测 + docs，需引入「外循环进行中」状态与续跑入口语义分支。

### 方案 B：最小修复（保正确性，续跑仍只回当前步）
- 步/规划闭环 `paused → return`（与主路径对齐，保现场待续跑），不新增状态、不改续跑入口。
- 不满足「续跑跑完整条链」——仅是修复"暂停后继续拉下一 pending 步"的越界行为。

## 四、待验证问题

1. **气口暂停的副作用**：若用户在长步中途 requestPause，请求会延迟到步结束后的气口才生效。这是"不打断步"的正确代价，但需和宿主对齐暂停按钮的响应预期。
2. **续跑入口语义分裂风险**：方案 A 让 `runResume` 承担「续单闭环」与「续任务链」双职责，需靠 `withinExternalTask` 分支；是否违背哲学「闭环只认 Trigger 不认来源」，需评审。
3. **状态落点**：`withinExternalTask` 放 loop 是否合适，还是应放编排器/检查点，需按单一真理源裁定。
4. **续跑后收敛汇报的 roundId 归属**：整链续跑后 `setCurrentRoundId(headRoundId)` 的时机是否仍自洽（组合溯源）。

## 五、风险与成本

- 方案 A 工程范围大；方案 B 不满足完整意图。
- 本探索项**当前不产生代码改动**（含已确认的「中断不产摘要」修复，见 D2，已在 orchestrator 落地，此处不涉及）。

## 六、决策状态

- **挂起（探索中）**：待结合真实场景（复杂任务执行中暂停→续跑）验证方案 A 可行性与副作用后，再决定是否固化。
- 未固化为 ADR，未修改决策索引。

---

> **关联文档**：
> - [agent-design-philosophy.md](./agent-design-philosophy.md) —— 最小单元 = 单轮问答闭环
> - [memory-as-summary.md](./memory-as-summary.md) —— 摘要↔外部输入恒 1:1
> - [loop-design.md](./loop-design.md) —— 软暂停/续跑机制
> - [task-driven-closed-loop.md](./task-driven-closed-loop.md) —— 外部任务驱动外循环
> - [pause-ask-resume-design.md](./pause-ask-resume-design.md) —— 暂停/续跑设计
> - 主实现：[orchestrator.ts](../../src/agent/seed/orchestrator.ts)、[loop.ts](../../src/agent/loop.ts)