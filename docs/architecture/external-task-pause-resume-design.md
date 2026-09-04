# 外部任务「气口暂停 → 续跑整链」设计定案（docs 架构层）

> **定位**：**设计定案（docs 架构层），由用户设计方案固化而来**。**当前非 ADR**（S1 探索期→此处将方案 A 定为实施蓝图）；待实施落地、被 `src` 引用 / 规则引用 / 真实场景复现消费后，按探索期决策沉淀纪律 S2 固化 ADR（三条件之一即补）。
> 本文是 D1（外部任务循环 paused 状态丢失）方案 A 的实施依据。

---

## 一、目标语义（三契约，来自设计意图）

用户的意图——loop 是对 turn（问答闭环）**内部 step 的编排**，`externalTaskLoop` 是对**多个 turn 的串联（多 turn 任务编排）**。step 之间、turn 之间均存在**气口**（step 级气口是正式定义）：

1. **气口暂停**：用户申请暂停 → **当前 turn 或 step 结束后**在气口暂停，不打断正在执行的步/段。
2. **无损续跑整链**：暂停后恢复 → **无损跑完整条剩余任务链**（剩余 pending 步 + 收尾汇报 turn），而非只续当前步。
3. **气口插话/补充**：气口可插入信息 / 输入补充说明，然后再续跑。

与哲学的关系：多 turn 任务编排 = 最小单元（turn）的重复；气口 = step 之间的天然暂停点（agent-design-philosophy §2.2）。本设计让多 turn 任务编排（externalTaskLoop）的暂停点对齐到"turn 边界（step 级气口）"，消除「栈上 while 被暂停打断、续跑不回 while」的结构性矛盾。

## 二、当前结构矛盾（根因）

```
externalTaskLoop 用栈上 while 串联 turn：规划 turn → for each pending step: 步 turn → 收尾汇报 turn
```

- 暂停由 loop.ts `_handleInterrupt` 在**step 边界**消费 `requestPause`（loop.ts），在**单 turn 内 step 之间**生效，不是 turn 之间的气口。
- 续跑 `continueAfterPause` 只恢复 **turn 内 step 迭代**（保留 `this.messages`），不知道自己在外部任务链里；它不回编排器 while，故只续当前 turn，不接续剩余 pending 步与汇报 turn。

## 三、设计定案：可重入多 turn 任务编排推进（方案 A）

### 3.1 单一真理源：把「推进外部任务链」提炼为可重入方法

不再用"栈上 while + 续跑裸 continue"两段割裂，而是**一个推进入口，runChat 复杂路径与 runResume 续跑路径共用**：

- orchestrator 私有 `completeExternalTask(signal, { fromResume })`：一次调用推进到"一个暂停点或收敛"。规划只在 `fromResume=false`（首次）执行；此后每步一 turn；无 pending → 收尾汇报 turn。
- `runChat` 复杂路径：规划 → `completeExternalTask`；出口 `handoff(externalTaskReported=true)`。
- `runResume`：续跑当前 turn 后，若 `loop.withinExternalTask && 未收敛` → 继续 `completeExternalTask({fromResume:true})`（接续剩余链）；否则维持裸 `continueAfterPause`（普通 turn 续跑，行为零变化）。

### 3.2 多 turn 任务编排上下文标志（SSOT 落点）

loop 新增 `withinExternalTask: boolean`：规划/步 turn 开启时置 true，收尾汇报 turn 后清 false。它唯一决定续跑入口"是否继续推链"，避免 runResume 用 `if isComplex` 猜测。

### 3.3 气口暂停

暂停请求统一在推进函数的气口（拉下一个 pending 步**之前**）检查：

```
while(有 pending 步):
    若 pausePending(loop.isPauseRequested)：return（本气口暂停，现场保留）
    yield { thinking, phase:'step', index, limit }
    执行步 turn
    若 步 turn paused：return（视为"本 turn 自然结束后暂停"，同样保留现场）
```

要点：`requestPause` 命中时绝不跳过步/绝不半途开新 turn；暂停后 plan 与 loop.messages 均保留，续跑重入推进。

### 3.4 插话 / 补充输入

- 插话（interject）沿用 loop 既有机制（step 边界消费为 user 消息），气口暂停点同样可插。
- 补充输入由 `runResume(input)` 的 `input` 承载（continueAfterPause 入史后继续）。

## 四、落地要点（改动面）

| 文件 | 改动 |
|------|------|
| `loop.ts` | 新增 `withinExternalTask` 字段 + `setWithinExternalTask()`（或 enter/exit）；暴露 `isPauseRequested`（已有）供气口检查 |
| `orchestrator.ts` | 提炼 `completeExternalTask`；`externalTaskLoop` 改为「规划 + 调 completeExternalTask」；`runResume` 加多 turn 任务编排分支 |
| `seed/types.ts` | （可选）SeedParts 无需新增；依赖 loop 公开接口 |

## 五、边界与取舍

- **暂停粒度**：本定案允许"暂停在 turn 内 step 边界"（loop step 边界）与"turn 间气口"并存，二者都保留现场、续跑都整链——生效点以 loop 的 `requestPause` 实际触发边界为准，不承诺"严格只在 turn 后"。若需严格"当前 turn 完整执行完才停"，需再调 loop 打断语义（风险更大，延后评估）。
- **续跑范围**：整链续跑在 `fromResume=true` 时从"下一个 pending 步"继续到收尾汇报 turn（一次续跑推进完毕）；多轮暂停-续跑可反复。
- **回归安全**：非多 turn 任务编排的单 turn 续跑走 `fromResume=false`/普通分支，行为零变化。

## 六、验证计划

1. 气口暂停：多 turn 任务编排 turn 间 requestPause → 不拉大下一步 turn、保留现场。
2. 续跑整链：runResume 续跑当前 turn 后 → 接续剩余 pending 步 + 收尾汇报 turn。
3. 补充输入：runResume(input) 入史后继续。
4. 摘要 1:1：整链续跑后仍仅收尾汇报 turn 产 1 条 round-summary（组合 head 回溯不变）。
5. tsc --noEmit 零错误 · seed 单测 · 全量回归。

## 七、决策状态

- **设计已定案（docs 架构层）**，作为 D1 方案 A 实施蓝图。
- 未固化为 ADR；实施被引用/消费后再按 S2 固化。

---

> **关联文档**：
> - [agent-design-philosophy.md](./agent-design-philosophy.md) —— 最小单元 = turn（问答闭环）；气口 = step 之间天然暂停点（§2.2）
> - [memory-as-summary.md](./memory-as-summary.md) —— 摘要↔外部输入恒 1:1；软暂停不摘要
> - [loop-design.md](./loop-design.md) —— 暂停/续跑机制（turn 内 step 边界）
> - [pause-ask-resume-design.md](./pause-ask-resume-design.md) —— 三机制修复（入史/摘要门控/pauseMeta）
> - [task-driven-closed-loop.md](./task-driven-closed-loop.md) —— 外部任务驱动的多 turn 任务编排
> - 主实现：[orchestrator.ts](../../src/agent/seed/orchestrator.ts)、[loop.ts](../../src/agent/loop.ts)