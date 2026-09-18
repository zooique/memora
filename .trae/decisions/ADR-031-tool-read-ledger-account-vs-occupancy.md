# ADR-031 · 工具读取台账：账本与占用解耦（CTX-1b 定案）

> **状态**：✅ 已接受
> **日期**：2026-09-14 **播种批次**：3.0.0（读取防重与压缩协同） **来源**：`docs/读取防重与压缩协同-方案.md`
>（收敛终稿）+ `tasks/排雷-读取防重与压缩协同-20260914.md`（已随 2026-09-18 tasks 清理删除，内容并入本文与 docs/读取防重与压缩协同-方案.md）

## 背景

CTX-1b 真实复发：单轮 `read_file` 148 次、同一 `(path, offset, limit)` 重复 13 次、幻觉文件被读 10 次，撞 `stepBudget` 产出 `[已达最大迭代次数]`（tokenIn 171 万 / tokenOut 49）。实锤根因：防重拦截前提 `isCachedResultStillInContext`（loop.ts）要求「结果**仍**在上下文 + 指纹一致」才拦，而压缩链 `ResultReplacementStrategy` 的**唯一职责**就是把结果移出上下文 → 前提恒假 → 防重结构性失效 → 重读把空间填满 → 再压缩 → **永动机**。

**本质是设计缺口**：把「读过什么」（账本）与「结果还在不在上下文」（占用）**耦合成了同一个判据**。压缩属占用管理，本不该动摇账本。

## 决策

**账本与占用解耦：判据只记「发生过」，不依赖「在不在」。** 具体落地（已实现并消费）：

1. **结构化台账 `FileExposureLedger`**（`src/agent/toolLedger.ts`）：按规范化路径记「读到第几行 + 轻量替身摘要」，**闭环内生命周期**（`resetTurnState` 清），与 `toolResultCache` 同轨。不做自由文本、不塞 `intelNote`（intelNote 参与截断淘汰 + 裁最旧，是"压力下先被淘汰的错配仓库"，排雷否定）。
2. **拦截三分支**（`loop.ts` executeToolCalls）：① 原文在上下文 → `[ALREADY_READ]` 拦；② 原文已被压缩但台账有摘要 → **回显摘要 + 覆盖度**（非空拦、非放行 = 断永动机、不死锁）；③ 无摘要 → 放行（保守：宁多读一次，不可死锁，CTX-1 根因②）。
3. **read_file 压缩 → 摘要替代**（`compaction.ts` `ResultReplacementStrategy` 注入回调）：压缩把 read_file 结果换成**它自己的台账摘要**（非空 `[Previous: used read_file]`），摘要**只产一次**——拦截分支②、压缩占位、覆盖度元信息三处同源。
4. **同主体失败硬闸 + 重复判定前移**（`loop.ts` P0-2）：同主体连续失败达阈值（取拦截器 `getThreshold`，SSOT）→ **执行前**硬拦 `[READ_FAILED_LIMIT]`（真 block，修 N1/N2/N3）；失败即给证据（`siblingDirHint`）助模型自查。

## 理由

- **业界收敛一致**：Promptise / AutoGPT 工具台账（"发生过"与转写解耦）、Claude Code read dedup stub（判据挂在 文件/区间/时间 而非占用）、预算协调层强制。
- **断永动机的最小自洽单元**：分支②必须带摘要才非死锁，而摘要来自结构化台账 → 台账 + 三分支 + 写侧脚注摘要是一体的，不能只做"在场重复"。
- **SSOT**：摘要只产一次；脚注格式单一真理源（`formatSegmentationFooter` 生成 / `FOOTNOTE_RE` 解析同模块）；失败 key 按**文件**粒度（与防重按区间**有意不同**，非重复实现）。

## 替代方案

| 方案 | 放弃原因 |
| ------- | -------- |
| 结论存 `intelNote`（情报区）可视化 | intelNote 是自由文本级联、参与 `truncateMessages` 尾部淘汰、超限裁最旧——上下文越紧（恰是本 bug 触发）替代物越先被淘汰，**错配仓库**（排雷确认） |
| `toolResultCache` 加 `summary` 字段 | 与结论层构成并列存储（SSOT 违例）；且生命周期不同（缓存闭环内 clear vs 结论跨 turn）——R2 排雷否定 |
| read_file 结果**整体豁免**压缩 | 多文件会话轰爆上下文（无上限）；「摘要替代」既腾空间又保模型知情 |
| 新建独立失败计数器 | 已有 `DuplicateCallInterceptor` 三态 + `getThreshold`，新建 = 重复造轮子（R4 排雷否定）→ 升级它 |

## 影响

- **新增**：`src/agent/toolLedger.ts`（`FileExposureLedger` / `formatSegmentationFooter` / `parseReadFileCoverage` / `formatLedgerStub`），`loop.ts`（三分支 + 失败硬闸 + 压缩摘要回调 + 判定前移），`compaction.ts`（read_file 摘要替代回调），`builtinToolHandlers.ts`（P2 失败证据 + 脚注生成归单源），`duplicateInterceptor.ts` / `types.ts`（`getThreshold`）。
- **文档**：`docs/读取防重与压缩协同-方案.md` 收敛终稿；`tasks/待完成任务.md` CTX-1b / DUP-1 定稿。
- **不新增预算维度**、不引入 AST/tree-sitter（ADR-002 零三方依赖）、**保守方向不变**（无替代物一律放行）。

## 何时回顾

- 出现「重开对话要复用上次文件结论」真实需求 → 台账升格跨会话（届时落 `.memora/`，宿主/memory 子系统承载，loop 不直接写盘）。
- 若某处重新把「读没读过」与「在不在上下文」耦合回同一判据 → 立即回到本 ADR。