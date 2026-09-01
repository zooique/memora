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

### 增补：历史会话占用（轻量版，2026-08-31 实现 / 2026-09-01 补录）

运行时占用只在 prepare 期产生，故**未发过消息的会话（冷启动回放、切换历史会话）没有 occupancy 快照**，圆环会停在空态 0%——这是「切历史会话显示假 0%」的真实痛点。完整版需在 memory 层预测「下一条消息会召回哪些记忆」，空 query 语义召回必然失真且代价高，**不做**（YAGNI）。轻量版口径：

| 分段 | 历史会话取值 | 性质 |
|---|---|---|
| `totalTokens` | `resolveContextWindow(当前 Provider.contextWindow)` | 真值，与 `pushProviders` 同源 |
| `dialogueTokens` / `dialogueCount` | 持久化消息经 `estimateTokensMessages` 求和 / `length` | 真值（与运行时同口径） |
| `rolePackBaseTokens` | 内核最近一次 prepare 的值；**无 prepare 记录时降级为 0** | 降级（已知低估，见下） |
| `memoryTokens` / `memoryCount` | `0` | 诚实置 0（不可预测，不虚报） |
| `inputAnchorTokens` | `0` | 真值（历史会话无当前输入） |
| `outputReserveTokens` / `freeTokens` | `estimateOccupancy` 派生 | 真值 |

**约束（本增补的核心，守 SSOT）**：

1. **不另写估算逻辑**：宿主重算只做「取数 + 求和」，token 估算调内核导出纯函数 `estimateTokensMessages`，占用组装调 `estimateOccupancy`——与运行时 prepare 共用同一份代码，free 收敛口径不漂移。
2. **降级项必须诚实**：`rolePackBaseTokens` 冷启动为 0 属**已知低估**（system prompt 是每次请求动态注入的固定开销，内核未对外暴露其 token，需新增内核 API 才能取真值——留作独立决策，不在此扩张）。首轮 prepare 后自动修正为真实值。
3. **推送落点唯一**：补推必须挂在「装配后统一刷新」的收口点（`chatPanel.refreshAfterAssemble`），不得在 `setAgent` / `ensureAgent` 各钉一份——两条装配入口（`memora.open` 命令 / 重启与侧栏图标的懒装配）都要覆盖。

### 配套（复杂度守恒）

- **不另立占用计算路径**：webview 不估算 token、不读 budget caps 重算；运行时占用全部来自内核单一 occupancy 快照。历史会话场景无快照可用时，宿主按上表做**降级重算**，且估算与组装一律复用内核纯函数（同一份计算逻辑，非第二份实现）。
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

### 增补实现（2026-08-31 落地 / 2026-09-01 收口）

- **内核**：`estimateTokensText` 之外新增 `estimateTokensMessages`（消息级估算纯函数），`ContextManager.estimateTokens` 与宿主历史会话重算同源于它——消除「逐条取整求和」与「先累计后取整」的口径漂移。
- **宿主**：`chatPanel.postHistoryOccupancy()`（轻量版重算）；补推落点收口进 `refreshAfterAssemble`（由原 `refreshRoleInfoAfterAssemble` 改名，因不再只管角色信息），覆盖 `setAgent` 与 `ensureAgent` 两条装配入口。
- 修复：重启 / 侧栏图标懒装配路径下圆环恒 0%（补推此前只钉在 `setAgent`，懒装配走 `ensureAgent` 漏推）。

## 何时回顾

- 若内核预算装配引入新分段（如工具 schema 单列、思考预算），须同步扩 `ContextOccupancy` 字段并补 webview 分段，保持分段互斥拼满总量。
- 若宿主要支持"切角色包/改窗口即刷新占用"（无需等到下一轮）：**已有 prepare 快照**时调 `postContextOccupancy()` 透传即可，不动内核；**无快照（切换/冷启动的历史会话）**时走 `postHistoryOccupancy()` 降级重算。
- 若内核暴露 system prompt token 的只读口，历史会话的 `rolePackBaseTokens` 应改用真值，撤销「冷启动降级为 0」的已知低估。
