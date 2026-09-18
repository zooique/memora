# 外部任务「气口暂停 → 续跑整链」设计定案（docs 架构层）

> **⚠️ 2026-09-04 整体废弃**：本文论述的 `externalTaskLoop`（多 turn 任务编排跨 turn 串联）已整体删除。暂停续跑的语义已收敛为**单 turn step 循环内的气口续跑**（`continueAfterPause` 复用同一 turn 的 `handleIteration` + `handleIterationResult`），不再需要"续跑整链"概念。**历史设计原样保留**——它记录了从"多 turn 串联"架构到"单 turn step 循环驱动"的探索过程。
>
> **追加注记（2026-09-11，3.0.0 发倔剪枝）**：原文中 §3.2 / §四 引用的 `isPauseRequested` 查询接口已随内核剪枝**删除**（全仓零消费）；当前内核对暂停的读写统一走 private `pauseRequested` + `interruptQueue`。本文为考古原文，不再更新细节。
>
> 现状真理源：[agent-design-philosophy.md](./agent-design-philosophy.md)（头部收敛补记已更新）· 代码：[loop.ts](../../src/agent/loop.ts)（`continueAfterPause`）
>
> **原定位（历史）**：设计定案（docs 架构层），由用户设计方案固化而来。

## 历史说明
本文为 2026-09-04 前「外部任务多 turn 暂停→续跑整链」的设计定案，机制已随 2026-09-04 整体废弃删除，收敛为单 turn step 循环内气口续跑（`continueAfterPause`）。现状真理源：[agent-design-philosophy.md](./agent-design-philosophy.md) · [pause-ask-resume-design.md](./pause-ask-resume-design.md) · [loop.ts](../../src/agent/loop.ts)。正文已随 2026-09-18 docs 清理瘦身为头部索引，完整历史见 git 历史。