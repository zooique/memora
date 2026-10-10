---
alwaysApply: false
description: 工具结果三值契约定案——status（ok/failed/blocked）为判据面唯一真源、文本判据桥物理删除（B5）、blocked 不计入 toolFailureCount 的计数口径（B4 Breaking）+ blockedReason 正交维度穷尽登记
---

# ADR-038 · 工具结果三值契约（ToolOutcome status 字段化）

> **状态**：✅ 已接受
> **日期**：2026-10-06 用户拍板（方案 §六决策一/二/三），同日 B4/B5 批次落地；2026-10-10 补录 ADR（Go/No-Go 审查 M8：决策依据原只在不随包发布的过程稿里）
> **过程稿**：`docs/方案-工具结果status字段化-20261006.md`（11 种主动挡下语义盘点 / 三结构性代价实测 / B1–B5 分批落地收据——「怎么变过来的」归该稿）；`tasks/archive/4.0.0-kernel.md` SCRIPT-2 条（批次收据与历史不可比登记）

## 背景

SCRIPT-1 实锤（2026-10-06）：失败判据是读文本前缀 `!result.startsWith('[ERR')`，而 `run_skill_script` / `run_code` / `run_command` 三工具共用的 `formatExecutionResult` 产出的是 `[SCRIPT_ERROR]` 等三态前缀——**一个都不以 `[ERR` 开头** ⇒ 工具全量失败却 `ok` 恒 `true`。SCRIPT-1 把判据收敛进 `isToolFailure`（两族正则）后仍**读文本**，三个结构性代价已实测：判据与渲染耦合（改文案即静默失效）、行首归属隐性契约（同一返回值两个事实抢行首）、拼接型产出对前缀守卫全失明（98 行含插值模板串）。根因修法 = 判据字段化。

## 决策

1. **三值契约（本体）**：执行器产出 `ToolOutcome = { status: 'ok' | 'failed' | 'blocked', text, blockedReason?, hasRealFailure?, errorCode? }`。`status` 是**判据面唯一真源**，`text` 是渲染面（原样回给 LLM 自愈），三值穷尽、**不加第四值**。
   - `ok` = 正常执行完成（含"成功但无输出"）；`failed` = 工具真的跑了但失败（计入 `toolFailureCount`）；`blocked` = **我们主动挡下的**（护栏拦截 / 只读拒绝 / 幂等跳过 / fail-closed 拒绝，改计 `toolBlockedCount`）。
2. **B5 文本判据桥物理删除**：`isToolFailure` / 前缀常量 / 前缀守卫整批删除，消费者判成败**一律读 `status` 字段、不得解析 `text`**；`runOne` 兜底 = `nativeOutcome ?? okOutcome`（裸文本 = 正常完成），abort 两出口显式 emit `failedOutcome`（中断 = 失败事实）。
3. **B4 计数口径（Breaking）**：执行层闸门（`permission_denied` / `readonly_denied` / `idempotent_skip`）不再计入 `toolFailureCount` → 归 `toolBlockedCount`；`hasRealFailure=true` 子集另计 `toolBlockedWithFailureCount`（`read_failed` 归 blocked 但背后藏真失败，不并入失败计数）。⚠️ `toolFailureCount` 数字**下降且与历史不可比**，CHANGELOG 已登记边界。
4. **blockedReason 正交维度**：11 种主动挡下不靠第四个 status 值区分，用 `blockedReason` 回答「为什么没成功」（与 status 正交），`Record<GuardRailId, BlockedReason>` 穷尽登记——**未登记即抛错并点名该 id**，禁止 `as` 强转 / `??` 兜底（兜底 = 新增护栏静默说不出原因，病症复发）。

## 理由

- **指标语义而非偏好**：`toolFailureCount` 的用途是判断「任务是否因工具能力不足而失败」；把「我们主动不跑」混进去，一个数字同时表达两件相反的事 ⇒ 指标失去判别力。
- **代码里已有正确先例**：`tool_result` chunk 的 `blocked` 字段 JSDoc 原文即「不计成功数亦不计失败数」——只是这个建模只覆盖 loop 护栏、没覆盖执行层（历史遗漏，非有意设计）。
- **文本判据的三个结构性代价是实测非推演**：改文案即静默失效没有测试会红；判据字段化后拼接盲区归零、行首归属契约消失。

## 替代方案

| 方案 | 放弃原因 |
| --- | --- |
| 加第四 status 值（如 `blocked_stuck`） | 每个 blocked 子类都得再判一次「算不算失败」，永远无法回答，且随护栏膨胀（11 条 → 11 个值） |
| `read_failed` 并入 `toolFailureCount` | blocked 同时表达「主动停手」与「真失败」= 回到一个数字两套语义的老问题 |
| 保留 `isToolFailure` 文本桥做兼容 | 双轨永久化，拼接盲区不消——B4 已将其降格为回落派生桥，B5 物理删除 |
| `blockedReason` 用 `as`/`??` 兜底 | 新增护栏静默落进兜底值 = 「新增护栏却说不出为什么被挡」（正是本契约要消灭的病症） |

## 引用方

- `src/agent/managers/toolCallHelpers.ts`：`ToolOutcome` / `ToolStatus` 定义，`failedOutcomeWithCode`（`errorCode` 与 text 前缀同源产出一次）
- `src/agent/types.ts` / `src/memory/roundStore.ts`：`blocked` 字段 JSDoc（B4 口径语义）
- `src/agent/managers/loopMetrics.ts`：三路互斥计数（ok 零计数 / blocked → `toolBlockedCount` / failed → `toolFailureCount`）
- `docs/memora-api-reference.md` §14.3：三值语义 + 计数口径 + 四条纪律（对消费者的 rationale 入口）
- `CHANGELOG.md` 4.0.0 Breaking 条：口径变更与历史不可比边界（随包发布，外部消费者可见）

## 何时回顾

- 任何「新增 status 第四值」提案：本 ADR 已否决 `blocked_stuck`，重提须带新证据。
- `toolFailureCount` 语义再变更：须同步 CHANGELOG 历史不可比登记（沿 SCRIPT-1/B4 范式）。
- 新增 `BlockedReason` 值：必须走穷尽登记，禁止硬塞既有值（原因字段退化成第二个 status 即违本 ADR 决策 4）。
- `docs/方案-工具结果status字段化-20261006.md` 降级或删除时：`src` 注释中指向该稿的临时指针（如 `toolExecutor.ts` 的「见方案 §六决策二」）迁指本 ADR（注释引用清算纪律 §3）。
