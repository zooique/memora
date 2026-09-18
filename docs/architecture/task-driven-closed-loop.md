# 任务驱动的多 turn 任务编排收敛模型

> **⚠️ 2026-09-04 整体废弃**：本文论述的多 turn 任务编排架构（难度分级 `difficulty.ts` + `externalTaskLoop`/`runStepSequence` 跨 turn 串联 + `runReport` 汇报 turn）已全部删除（-1181 行）。**历史设计记录原样保留**——它记录了从"多 turn 串联"架构到"单 turn step 循环驱动"的完整探索过程。收敛后的现状：所有复杂度（任务表、会议多角色、动态进度追踪）在一个 turn 的 step 循环内自然生长，LLM 自主调 `task_table_write` 而非强制前置规划。任务表工具（`task_table_write/update/complete`）+ 会议机制（`tryBuildMeetingPlan` 预置 writePlan）全部保留。
>
> 现状真理源：[agent-design-philosophy.md](./agent-design-philosophy.md)（头部收敛补记已更新）· 代码：[orchestrator.ts](../../src/agent/seed/orchestrator.ts) · [loop.ts](../../src/agent/loop.ts)
>
> **原定位（历史）**：本模型是"turn（问答闭环）= 种子"哲学的**多 turn 任务编排语义化**——它回答一个问题：**复杂的笼统问题，如何从一棵干净的种子长成"有条理、有起点、有终点"的多 turn 执行？**
>
> **原状态（历史）**：已实现（2026-09-03 术语统一更新）→ **2026-09-04 整体废弃删除**（-1181 行），现为历史设计记录。
>
> **哲学真理源**：[agent-design-philosophy.md](./agent-design-philosophy.md)（turn·step·loop·多 turn 任务编排）· [loop-design.md](./loop-design.md)（loop = 对 step 的编排）· [module-inventory.md](./module-inventory.md)（模块现状）

## 历史说明
本文为 2026-09-04 前「多 turn 任务编排」的设计/实现记录，机制已随 2026-09-04 整体废弃删除，收敛为单 turn step 循环驱动（任务表 + 会议机制保留）。收敛后真理源：[agent-design-philosophy.md](./agent-design-philosophy.md) · [loop-design.md](./loop-design.md) · [orchestrator.ts](../../src/agent/seed/orchestrator.ts)。正文已随 2026-09-18 docs 清理瘦身为头部索引，完整历史见 git 历史。