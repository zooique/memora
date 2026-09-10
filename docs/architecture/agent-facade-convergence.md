# Agent 门面收敛 · 设计记录（已落地）

> 状态：**已落地 · 三步骤已实施完成（行为等价回归通过）**
>
> 目标：让 `agent.ts` 从「5 个协议的中枢」收敛为「编排 + 生命周期 + 守卫」的真门面。
> 本文档为门面收敛的**落地记录**（探索期草稿已按 S2 固化）；下方行数为收敛完成时的时点快照，后续迭代会导致变化。
>
> **现状（已落地）**：三个横向切面已下沉为专职模块——
>
> * **Step 1 装配回填** → `assembler.ts` 新增 `AgentHooks`，Agent.assembleComponents 退化为一行委托
>
> * **Step 2 输入增强** → `contextPreparer.ts`（recallAndInject，v0.13 起角色仅手动切换、无自动匹配），Agent 留编排调用点
>
> * **Step 3 检查点恢复** → `checkpointRestoreCoordinator.ts`（warmRecall / reinject / restore / shouldGenerateTaskTable），Agent.restoreFromCheckpoint 委托
>
> **体量（2026-08-29 收敛完成时快照）**：agent.ts 2255 → 1721 行（-534）；新增 assembler 694 / contextPreparer 298 / checkpointRestoreCoordinator 246。注：截至 2026-08-31 `agent.ts` 已增至 **1927 行**（后续功能叠加），数字为时点值，非长期保证。
>
> **最小切片**：P0 审查建议"capability 聚合"经评估——宿主 getter（memory/works/polish/sessionManager 等）是公共契约不可动、字段聚合不减少方法数、项目文档已声明"守卫/字段区移动收益低"。收敛为**仅聚合纯内部组件**：12 个无宿主 getter 契约的专职组件（dedupManager/memoryAdvisor/sessionArchiver/sessionNamer/roundSummaryGenerator/contextPreparer/checkpointRestoreCoordinator/composer/chatLockManager/memoryDecayScheduler/archiveCoordinator/seedOrchestrator）收进 `Agent.internals` 聚合对象，扁平 private 字段 51 → 40，nullify 生命周期样板收敛；宿主 getter 契约字段保持独立（零 breaking change）。
>
> **2026-09-10 剪枝补记**：上述 **Step 3 检查点恢复** 已整体退役——`checkpointRestoreCoordinator.ts` 整文件删除（`warmRecall` / `reinject` / `restore` / `shouldGenerateTaskTable` 随之消失），`Agent.restoreFromCheckpoint` 公开 API 与 `Agent.internals` 中该字段一并删除。原因见 [白话设计文档](../../docs/白话设计文档.md) 第六步「暂停与中断」：中止/断电一律把未完成 turn 补全为完整 turn 身份并由下次会话按历史加载，运行时暂停是同 turn 内续跑（内存态），**不存在与主路径并列的第二套恢复机制**。故本文「装配层三切面」现为**两切面**（装配回填 + 输入增强）。

***

## 一、问题背景

`agent/agent.ts` 共 **2255 行**，为全库最大文件（次大 `agent/loop.ts` 1415 行）。
经方法级统计（超 30 行方法合计约 1470 行），体量不是单块逻辑，而是 **5 套职责的叠加**。

关键观察：子模块均已拆到 `managers/`（17 个专职 Manager，单文件平均 100-200 行），
唯独**编排层未同等收敛**。同一套复杂度在拆干净处很薄，说明这两个文件「厚」，
缺的不是复杂度，而是**编排层自己的收敛**——这与上一轮评审结论一致。

## 二、职责定性（5 协议）

| # | 协议                                                                   | 体量(估)   | 归属判断    |
| - | -------------------------------------------------------------------- | ------- | ------- |
| 1 | 对话编排（chat / processEvent / resumeExecution / consumeExecutionStream） | \~700 行 | 门面应有    |
| 2 | 输入增强管线（recallAndInject / 技能匹配 / 角色匹配）                                | \~180 行 | **可下沉** |
| 3 | 检查点恢复协议（warmRecall / reinject / restore / 任务表预判）                     | \~300 行 | **可下沉** |
| 4 | 组件装配（assembleComponents 回调 + createSessionManager）                   | \~270 行 | **可下沉** |
| 5 | 生命周期 + 守卫 + 字段区（init / close / reload / require\*）                   | \~800 行 | 门面应有    |

门面本该只有 1 + 5。2、3、4 是「职责完整、生命周期独立、接口清晰」的横向切面，却全部内联在 Agent 类里——这是它「大」的设计成因。

## 三、设计原则（从现有哲学推导）

* **P1 不拆垂直流程**：chat / processEvent / consumeExecutionStream 是编排本身，留在 Agent。拆了就是给门面加间接层，违反单一真理源。

* **P2 只拆横向切面**：三条件同时满足才下沉——职责完整、生命周期独立（只在特定时机激活）、与其余部分靠接口协作。

* **P3 下沉不造新轮子**：能回填进已有真理源就不新建。装配的真理源本就在 `assembler.ts`，Agent 私有方法只是「再接线」。

* **P4 先验证后固化**：可逆重构，按 S1 先落地验证，稳定后再考虑 ADR，不预写。

## 四、三个切面

### 切面 1：装配回填 → assembler.ts（Step 1 · 最低风险）

**现状**：[assembleComponents](../../src/agent/agent.ts) 的 178 行里，「组装」只有开头一段，主体是 8 个接线回调
（preExecutionCheck / onToolExecuted / planManager 写计划·改步骤·取计划三个闭包）；
[createSessionManager](../../src/agent/agent.ts) 的 90 行同理。

**做法**：给 `assembler.ts` 工厂增加 `AgentHooks` 参数（emit / assertNotBusy / 会话管理 / 策略 / 后处理的稳定引用），
把接线闭包下沉；Agent 的 `assembleComponents` 退化为一行委托。最贴合「逻辑下沉到单一真理源」。

**边界**：`AgentHooks` 传的是 Agent 的稳定能力（非私有状态），避免反向依赖泄漏；接线回调语义不变。

### 切面 2：输入增强管线 → ContextPreparer（Step 2）

**现状**：[recallAndInject](../../src/agent/contextPreparer.ts)（语义召回 + limited 配额 + 固定轮次注入；
v0.13 起角色自动匹配已移除，管线仅剩记忆/技能增强）。

**本质**：一条完整的「外部输入 → 记忆增强」管线，正是「触发源决定召回」哲学的实体。

**接口**：`prepare(input) → { memories }`；内部依赖（emit 回调、getActiveStrategy、requirePctx）以 options 注入，Agent 只留调用点。
记忆召回 / 摘要配额 / 保底阈值等策略解析随管线一起走。

**边界**：召回后的事件发射（memoryRecalled / boost 持久化）由 Agent 通过 options 回调承接，语义不变。

### 切面 3：检查点恢复协议 → CheckpointRestoreCoordinator（Step 3 · 最独立）

**现状**：[warmRecallForCheckpoint](../../src/agent/agent.ts) + reinjectContracts + restoreFromCheckpoint +
[shouldGenerateTaskTable](../../src/agent/agent.ts)，约 300 行，只在 resume 时激活。

**本质**：一套完整领域协议——恢复时「召回什么 / 注入什么 / 预判什么」。

**接口**：`restore(event, checkpoint)` / `shouldGenerateTaskTable(event, checkpoint)`；
仅依赖 sessionManager / history / loop 的稳定接口。

**边界**：`autoResumeIfPaused`（13 行，并发锁 + 状态机翻转）**留在 Agent**——它是编排动作，不是协议实现。

## 五、明确不拆（为什么）

| 保留项                                          | 理由                               |
| -------------------------------------------- | -------------------------------- |
| chat / processEvent / consumeExecutionStream | 编排主链路，门面本身                       |
| autoResumeIfPaused                           | 并发锁 + 状态机翻转的编排动作                 |
| postProcess / doPostProcess                  | 已委托 RoundSummaryGenerator，仅 20 行 |
| 守卫 / require\* getter / 字段区                  | 基础设施，移动收益低、伤可读性                  |
| reloadConfig / switchProject / close         | 生命周期是 Agent 本来职责                 |

## 六、迁移步骤与验证

```
Step 1 装配回填 assembler     → 纯内部移动，行为等价
Step 2 输入增强 → ContextPreparer
Step 3 恢复协议 → CheckpointRestoreCoordinator
```

* 每步独立、可单独回退；每步结束跑 `tsc --noEmit` + 相关单测 + 三场景回归：
  普通对话 / 暂停→续跑 / 角色切换 + 技能匹配。

* 结构指标：agent.ts 超 60 行方法数（当前 8 个 → 目标 ≤2）、方法数、嵌套深度。

* 探索期落位：本文档标注「探索中」，三步骤全部稳定后按 S2 固化 ADR。

## 七、收益与边界（诚实）

* **收益**：agent.ts 2255 → \~1400 行；超 60 行方法 8 → ≤2；编排职责在门面内唯一可见。

* **边界**：不承诺降到 1000 以下（编排 + 生命周期 + 守卫客观 \~1400，是门面合理厚度）；
  loop.ts 本轮不动（先聚焦 agent）；现有 managers/ 结构一律不动，只做回填与新增。

***

> **关联文档**：
>
> * [module-inventory.md](./module-inventory.md) —— agent/ 模块清单与质量状态（实施后更新）
>
> * [agent-design-philosophy.md](./agent-design-philosophy.md) —— turn 设计推导
>
> * [.trae/rules/single-truth-source-mindset.md](../../.trae/rules/single-truth-source-mindset.md) —— 最小单元与逻辑下沉
>
> * [.trae/rules/exploration-decision-sedimentation-rules.md](../../.trae/rules/exploration-decision-sedimentation-rules.md) —— 探索期决策沉淀机制（S1/S2）

