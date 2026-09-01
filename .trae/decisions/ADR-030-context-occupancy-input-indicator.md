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
   - `dialogueCount` = **问答闭环数（user 消息条数）**，非对话消息总数。计数标准以「用户输入」为准：一个 user 消息计 1 条，哪怕对应 assistant 回答残缺/被中止也如实记录（尊重用户保留意图）；assistant 消息不计入条数，但计入 `dialogueTokens` 容量。此口径 2026-09-01 定案，解「发一条消息后圆环不刷新」体感（详见「对话占用实时刷新」增补段）。
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
| `dialogueTokens` / `dialogueCount` | `dialogueTokens` = 持久化消息经 `estimateTokensMessages` 求和（全量 user+assistant）；`dialogueCount` = 其中 **user 消息数**（问答闭环，与运行时同口径） | 真值（与运行时同口径） |
| `rolePackBaseTokens` | 装配/切换角色包时由内核算定真值（`assembler` 拼完 systemPromptPrefix 即 `estimateTokensMessages`；切换走 `agent.setRolePackBaseTokens`），**冷启动即真值、不降级为 0**（2026-09-01 T5/T6 落地，见「装配期真值前移」增补段） | 真值 |
| `memoryTokens` / `memoryCount` | `0` | 诚实置 0（不可预测，不虚报） |
| `inputAnchorTokens` | `0` | 真值（历史会话无当前输入） |
| `outputReserveTokens` / `freeTokens` | `estimateOccupancy` 派生 | 真值 |

**约束（本增补的核心，守 SSOT）**：

1. **不另写估算逻辑**：宿主重算只做「取数 + 求和」，token 估算调内核导出纯函数 `estimateTokensMessages`，占用组装调 `estimateOccupancy`——与运行时 prepare 共用同一份代码，free 收敛口径不漂移。
2. **降级项已根除（2026-09-01 T5/T6）**：原「`rolePackBaseTokens` 冷启动降级为 0（system prompt 是动态注入固定开销、内核未暴露其 token）」的已知低估，已由「装配/切换角色包时内核算定真值」彻底消除——`assembler` 拼完 systemPromptPrefix 即 `estimateTokensMessages`，切换走 `agent.setRolePackBaseTokens`，均早于 prepare，冷启动首屏即真实值，无需等待首轮 prepare，也**无需新增内核 API**。本约束保留作历史注记。
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

### 增补：角色包底盘占用真值前移（装配/切换即确定，2026-09-01 T5/T6 落地）

原设计 `rolePackBaseTokens` 只在 prepare 期经 `ContextOccupancy` 透出，冷启动无快照时历史会话轻量版只能降级为 0（已知低估）。对抗式审查判定该低估**非必要**：system prompt 前缀（persona+rules+技能 L1+工具 schema）在装配/切换角色包时即已拼定，可立即 `estimateTokensMessages` 算得真值，早于任何一轮 prepare。故将真值真相源前移：

- **装配期**：`assembler.ts` 拼完 `systemPromptPrefix` 即 `estimateTokensMessages([{content}])` 得 `rolePackBaseTokens`，经 `AgentLoopOptions.rolePackBaseTokens` 注入 `loop`。
- **切换期**：`agent.ts` `refreshRolePackPrefixForRound` 内 `setRolePackBaseTokens` 重算（用户/宿主显式切换角色包时即刷新，不待下一轮）。
- **透出**：`loop.getMetrics().context.rolePackBaseTokens?` + `tracer.ts` `AgentMetrics.context.rolePackBaseTokens?`（doc 标注「装配/切换时确定，冷启动可用」）。
- **宿主**：`chatPanel.ts` `onRolePackSwitched` 末尾补推 `postContextOccupancy`（切角色包即刷新）；`postContextOccupancy` 若见 `ctx.rolePackBaseTokens` 与快照不符，用真值覆盖（解决冷启动快照 0% 残留）。

收益（SSOT + 自然生长）：复用既有 `estimateTokensMessages` + 既有 `postContextOccupancy` 收口点 + 既有 `rolePackSwitched` 事件链路，**无新增协议类型、无第二份计算**。冷启动首屏圆环即真实角色包底盘占比，不再显示假 0%。

> 注：此增补使上文第 43/51/83 行的「冷启动降级为 0 / 需新增内核 API」表述作废，已就地改为历史注记。

### 增补：对话占用实时刷新 + 条数语义定案（2026-09-01 修复）

**体感 bug**：用户发一条消息后，输入区圆环 hover「完整对话：N 条」不增长（仍是切换会话前的旧数）；记忆回忆正常。根因：占用快照 `ContextOccupancy` 仅在 **prepare 期**（每轮 LLM 调用前、assistant 生成前）由 `contextPreparer` `recordOccupancy` 写入；单轮对话（user→assistant 结束、不发动第 2 轮）结束后无新 prepare，快照永不刷新，且天然不含本轮 assistant。用户切会话触发 `postHistoryOccupancy`（读持久化全量）才看到正确值——故「切回来变正常」。

**条数语义定案（用户拍板）**：`dialogueCount` 以**用户输入**为计数标准——一个问答闭环（user 消息）计 1 条，哪怕 assistant 回答残缺/被中止也如实记录（尊重用户保留意图）；`dialogueTokens`（容量）仍诚实统计问答闭环 user+assistant 全文总和。废弃原「对话消息总数」口径（hybrid 计轮数 / fixed 计消息数之差异亦消除，统一为 user 数）。

**修复（内核侧，守 SSOT：宿主不重算）**：
- `contextPreparer.ts`：`dialogueCount` 改为 `loop.getConversationMessages().filter(m => m.role==='user').length`，去掉 hybrid/fixed 分支。
- `loop.ts`：新增 `refreshOccupancyDialogue()`——基于最新 `this.messages` 重算 `dialogueCount`（user 数）+ `dialogueTokens`（全量），合并 `lastOccupancy` 其余段后 `recordOccupancy`；在 `appendUserMessage`（user 输入即 +1，实时）与 `appendAssistantText`（assistant 落盘补容量，含残缺回复）末尾调用。幂等：无快照时 no-op。
- 宿主 `chatPanel.ts` `postHistoryOccupancy` 的 `dialogueCount: history.length` 同步改为 `history.filter(role==='user').length`，与内核口径一致。

收益：发消息即时 +1、assistant 落盘容量补上，无需切会话即可看到正确占用；条数语义直白（问答闭环数），残缺回复如实计入容量。

## 何时回顾

- 若内核预算装配引入新分段（如工具 schema 单列、思考预算），须同步扩 `ContextOccupancy` 字段并补 webview 分段，保持分段互斥拼满总量。
- 若宿主要支持"切角色包/改窗口即刷新占用"（无需等到下一轮）：**已有 prepare 快照**时调 `postContextOccupancy()` 透传即可，不动内核；**无快照（切换/冷启动的历史会话）**时走 `postHistoryOccupancy()` 降级重算。
- ~~若内核暴露 system prompt token 的只读口，历史会话的 `rolePackBaseTokens` 应改用真值，撤销「冷启动降级为 0」的已知低估。~~ **已落地（2026-09-01 T5/T6）**：`rolePackBaseTokens` 真值在装配/切换时即由 `estimateTokensMessages` 算定（取 system prompt 前缀 token），不依赖「内核暴露新只读口」，冷启动不再降级为 0；本回顾项作废。
