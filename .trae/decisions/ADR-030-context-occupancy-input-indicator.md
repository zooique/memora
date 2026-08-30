---
alwaysApply: false
description: 输入区上下文占用指示器——单一真理源 = 内核 prepare 期记录的 ContextOccupancy（真实用量），宿主透传、webview 只渲染，输入区常驻比例条 + hover 明细。
---

# ADR-030 · 输入区上下文占用指示器（内核算、宿主传、webview 渲）

> **状态**：✅ 已接受
> **日期**：2026-08-30
> **依赖**：[ADR-029](./ADR-029-context-window-resolution-host-injection.md)（上下文窗口解析归宿主注入）、④ 预算可视化（`contextPreparer.recordBudget` / `loop.getMetrics().context.budget` 已规划）
> **来源**：用户对齐阿里 Qoder / 腾讯 WorkBuddy 输入区上下文占用比例条体验

## 背景

用户希望在输入区常驻展示上下文占用比例（总容量 = per-LLM 窗口上限），hover 出分层明细：角色包基础设定 / 记忆摘要 / 完整对话 各占多少。内核预算系统（`budget.ts`）已在 prepare 期算出各层**预算上限**（`ContextBudget`），且 `contextPreparer.ts` 已有 `recordBudget` 钩子（注释明写 ④ 预算可视化），`loop.getMetrics().context.budget` 已透出。但存在两处缺口：

1. 当前只带 **cap**，不带各层**真实用量**——用户要的是"占用多少"，而非"最多能用多少"。
2. 指示器挂在开发者开关 `memora.showMetrics` 后的折叠面板，而非输入区常驻。

## 决策

### 核心：单一真理源 = 内核 `ContextOccupancy`（真实用量），宿主只透传、webview 只渲染

1. **内核算**：`contextPreparer` 在 prepare 期算 `ContextOccupancy`（互斥分段拼满窗口总容量 `totalTokens`）：
   - `rolePackBaseTokens` = `fixedOverheadTokens`（system prompt：persona + rules + 技能 L1 + 工具 schema）
   - `dialogueTokens` = 实际进窗完整对话：hybrid 模式计量注入的最近轮次摘要块；fixed/query 模式不注入摘要（对话全量保留在 loop.messages），计量全部 user/assistant 对话
   - `memoryTokens` = `estimateTokens(注入的 recalled 记忆)`
   - `inputAnchorTokens` = `budget.anchorTokens`（触发输入 + 首个回答预留）
   - `outputReserveTokens` = 窗口 × 输出预留比例（留给模型回答的容量，非已用）
   - `freeTokens` = `max(0, total − 各段)`（非负收敛）
   经 `loop.recordOccupancy(occ)` 写入；`getMetrics().context.occupancy` 透出（与 budget caps 互补）。
2. **宿主传**：`chatPanel.postContextOccupancy()` 每轮流式结束**必推** `ExtensionToWebviewMessage.context_occupancy`（脱离 `showMetrics` 独立常驻），从 `agent.getMetrics().context.occupancy` 取数，**不重算**。
3. **webview 渲**：`chatView` 在输入区 `#contextOccupancy` 渲染分段比例条 + 百分比 + hover 原生 title 明细；UI 只消费数字。

### 配套（复杂度守恒）

- **不另立占用计算路径**：webview 不估算 token、不读 budget caps 重算；全部来自内核单一 occupancy 快照。
- **与 budget caps 互补不重复**：`ContextBudget` 是"各层最多能用的上限"，`ContextOccupancy` 是"本轮实际用了多少"——两个不同投影，同源 prepare，并列不腐化。
- **常驻 ≠ 噪音**：输入区细条默认可见（对齐 Qoder/WorkBuddy）；开发者折叠面板的预算构成（caps）仍保留在 `showMetrics` 后，二者并陈不冲突。

## 理由

1. **SSOT**：占用数字一个真相源（内核 prepare），宿主/webview 零重算——守内核/宿主边界铁律。
2. **真实用量 > caps**：用户要"占用多少"，各层 actual 比上限更有信息量（能看到记忆/对话实际吃了多少窗口）。
3. **复用既有脚手架**：④ 预算可视化已留 `recordBudget`/`getMetrics` 钩子，本 ADR 仅补 actual 维度 + 提拔到输入区，未另起炉灶。

## 影响（已实现 · 2026-08-30）

- **内核**：新增 `ContextOccupancy` 类型（`budget.ts`）+ `loop.recordOccupancy` + `getMetrics().context.occupancy`；`contextPreparer` 在 prepare 末尾算各层真实用量并记录（dialogue 按装配模式分支：hybrid 计量注入摘要、fixed/query 计量全量对话，经 `loop.getConversationMessages()` 取数）。单测（`metrics.test` / `contextPreparer.test`）覆盖透出、分段非负收敛与 fixed 全量计量。
- **宿主**：`protocol.ts` 加 `context_occupancy` 消息；`chatPanel.ts` 加 `postContextOccupancy()`（脱离 `showMetrics` 常驻）+ 输入区 `#contextOccupancy` DOM。
- **webview**：`chatView.ts` 加 `updateContextOccupancy` 处理器与渲染；`chatStyles.ts` 加分段配色。
- **质量门**：内核 test 24（metrics + contextPreparer）/ 宿主 `tsc --noEmit` 0 错、`eslint --max-warnings 0` 0 警告、全量测试 272 全绿。

## 何时回顾

- 若内核预算装配引入新分段（如工具 schema 单列、思考预算），须同步扩 `ContextOccupancy` 字段并补 webview 分段，保持分段互斥拼满总量。
- 若宿主要支持"切角色包/改窗口即刷新占用"（无需等到下一轮），在对应 host 事件处理里调一次 `postContextOccupancy()` 即可，不动内核。
