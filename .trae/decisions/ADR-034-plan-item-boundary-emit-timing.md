---
alwaysApply: false
description: plan_item_boundary 产出时机前移定案——产于迭代开始、LLM 调用之前，边界语义「以下内容属于该任务项」决定其必须先于所罩内容
---

# ADR-034 · 任务项边界产出时机前移（plan_item_boundary）

> **状态**：✅ 已接受
> **日期**：2026-09-26 定案 · 2026-09-30 补录（S2 固化：src 生产引用 3 处）
> **过程稿**：`docs/方案-任务项边界产出时机前移-20260926.md`（「怎么变过来的」归该稿，本 ADR 只收定案）

## 决策

1. **检出时机 = 迭代开始、LLM 调用之前**：`handleIteration` 内 `_handleInterrupt` 之后、`_prepareContext` 之前调用 `_maybeEmitPlanItemBoundary`；比较 active 任务项是否推进，推进才产 `plan_item_boundary`（`lastBoundaryPlanItemId` 去噪，无任务表返回 null 静默）。
2. **顺序契约**：`plan_item_boundary` 产于**迭代头**（它所罩住的思考与工具之前），`step_boundary` 产于**迭代尾**——二者天然保持先后序，宿主本轮落盘快照已含该任务项折叠边界，崩溃重放不错位。若二者同产在迭代尾，每个任务项的首个迭代会掉出折叠块。
3. **时序分叉是设计语义**：`getActivePlanItemMeta`（迭代开始读，供边界产出）与 `onPlanItemBoundary`（LLM 调用后、工具前读，写 planItemLog）读同一 `checkpoint.plan` 真源但读取时刻不同——前者是「以下内容将归属的那个任务项」，后者是「本迭代实际服务的任务项」。

## 理由

- 边界的语义是「**以下内容**属于该任务项」⇒ 必须产在它所罩住的思考与工具**之前**；放在工具落定之后，宿主「向前找最近边界」的判据对该迭代必然落空 ⇒ 每个任务项的**首个迭代**（思考 + 首批工具）恒掉出折叠块，且流式插入后不搬家。
- 修的场景是「任务表在本轮开始前已存在」（续会 / 预置 / 上一 turn 遗留）。

## 语义后果（诚实声明，非缺陷）

任务表若由本轮某迭代的工具**新建**，该迭代仍留在组外——那个时刻任务表还不存在。

## 引用方

- `loop.ts` `_maybeEmitPlanItemBoundary`（主产出点）
- `types.ts` `step_boundary` JSDoc（顺序契约）
- `assembler.ts` `getActivePlanItemMeta` 装配回调（时序分叉）
- 宿主 webview `planItemContainerFor`（「向前找最近边界」消费判据）
