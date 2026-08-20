# 暂停 · 主动提问 · 输入补充 —— 三机制缺陷修复设计（探索期）

> **文档定位**：代码质量评审（2026-08-21）产出。针对 `LLM 主动暂停提问（[ASK]）/ 用户暂停继续 / 输入补充（Composer P1-P4）` 三机制发现的缺陷，先吸收主流大厂交互经验（土壤），再在最小单元上自然生长出修复方案（种子）。
>
> **状态**：探索中（可逆决策，未固化 ADR）。本文只论证方案、不承诺接口，具体落地待评审通过后实施。
>
> **方法**：网络为土壤（§一吸收 → §二交叉评审 → §三生长方案），单一真理源（每个缺陷在最小单元层面解决，不引入新机制）。
>
> **哲学真理源**：
> - [agent-design-philosophy.md](./agent-design-philosophy.md)（§14.3 主动提问/输入中断、闭环软暂停）
> - [memory-as-summary.md](./memory-as-summary.md)（§2.5 摘要与外部输入恒 1:1、软暂停不摘要）
> - [loop-design.md](./loop-design.md)（Loop = 单一闭环的编排）
> - [task-driven-closed-loop.md](./task-driven-closed-loop.md)（主动提问/暂停续跑链路）

---

## 一、土壤吸收：主流 Agent 的暂停/提问/续跑交互经验

### 1.1 Trae Work（用户认可的最佳交互范式）

| 经验 | 来源 | 对本项目可吸收点 |
|------|------|------------------|
| **三栏布局 + 工具面板**：左任务、中对话、右结果（待办 Todos / 产物 / 参考信息），任务自动拆解并实时追踪子任务进度 | [TraeWork 快速开始](https://docs.trae.cn/work_trae-work-web-and-desktop-quickstart) | 暂停原因/澄清问题应作为**可展示的状态**（pauseMeta），而非只存在于内存 |
| **过程透明 + 关键节点用户决策**："执行时持续反馈 Agent 在处理什么；到关键节点提供多个选项确认后再继续；可随时中断或调整方向" | [选择 TRAE Work 的 20 个理由](https://xmsumi.com/detail/3946) | 支持"提问-选项-确认"的结构化澄清（对应 Composer P4 / [ASK]） |
| **AskUserQuestion 工具**：多选/单选/描述，一次交互收集多个答案；用于诊断、方案审核（批准后才进入下一步） | [TraeWork 学习闭环 Skill 案例](https://forum.trae.cn/t/topic/172245) | 澄清应"暂停-回答-续跑"三段式，且**提问要在上下文中可追溯**（本评审 A1 的根因） |
| **三端任务状态同步 + 移动端调度**：任务不中断、状态无缝同步 | [TraeWork 概述](https://docs.trae.cn/work_what-is-trae-work) | 暂停/续跑是**跨会话状态**，暂停原因须持久化（A3） |

### 1.2 Claude Code / Copilot / 通用 agent 范式

| 经验 | 来源 | 可吸收点 |
|------|------|----------|
| **Plan-Then-Execute 收敛**：先研究→把歧义列为"开放问题"→用户澄清→再执行；澄清集中在规划阶段而非执行中途 | [Forge proactive-clarification 设计](https://github.com/johnkord/agents/blob/main/research/phase-5b-proactive-clarification-design.md) | 印证 memora `chat 事件永不 P4` 的正确性（少问多做）；执行中提问是 memora 相对主流的前瞻点（[ASK]） |
| **AskUserQuestion 是"工具化澄清"**：Anthropic 特意做了结构化工具而非纯文本约定，因为结构化提问产出更稳 | [Claude Code Pitfalls #37](https://claudecodetips.com/en/guide/pitfalls/37) | memora 用 `[ASK]` 文本约定 + 内核确定性解析，是"零第三方依赖"下的等价物；但**工具调用式天然把问题留在上下文**，[ASK] 缺失这一点（A1） |
| **过度确认破坏 flow**（反面教材）：Copilot 频繁暂停要"continue"被大量吐槽，要求"上下文无歧义时自动继续" | [vscode#291565](https://github.com/microsoft/vscode/issues/291565) | 印证：**提问要克制**（askLimit/防滥用已有），且被提问打断的回合不应污染记忆（A2） |
| **interrupt 四组件**：gate（拦截）+ checkpoint（保状态）+ notification（通知到人）+ resume path（重建工作流），缺一即坏 | [Agent Interrupt and Approval Checkpoints](https://www.channel.tel/blog/agent-interrupt-checkpoint-approval-patterns) | memora 已具备四组件；**checkpoint 的 pauseMeta 是"通知到人"的持久化载体**（A3） |
| **反馈信号分级**（👍继续/👎改向/✋打断）：轻量元数据而非完整消息，"不打断世界"的连续反馈 | [claude-code#59265](https://github.com/anthropics/claude-code/issues/59265) | 对应 memora `interject`/`requestPause` 的软语义；佐证"暂停是软事件"应保留上下文（A1） |
| **AG-UI interrupt 标准**：interrupt 含 id/reason/message，resolve(payload) 恢复、cancel 取消，支持多 interrupt 独立回答 | [CopilotKit useInterrupt](https://docs.showcase.copilotkit.ai/human-in-the-loop/useInterrupt) | memora `[ASK]` 单问题暂停已对齐该语义；多问题（多条 `[ASK]`）对齐多 interrupt |

### 1.3 交叉评审：土壤 vs 种子

| 土壤结论 | 种子（memora 既有设计） | 评审结论 |
|---------|------------------------|----------|
| 澄清最好在规划阶段（Plan-Then-Execute） | chat 事件永不 P4（content 即意图，直接执行） | ✅ **一致**：memora 已天然少问多做，符合过度确认的反面教训。不调整 |
| 提问要结构化、可追溯、留在上下文 | `[ASK]` 解析为 question_pending，**但问题未入消息历史** | ⚠️ **缺陷 A1**：结构性（解析）已对齐，可追溯（入史）缺失 |
| 暂停轮是"回合未完成"，不应作为独立轮次沉淀 | 摘要恒 1:1，软暂停不摘要（§2.5 定案） | ⚠️ **缺陷 A2**：文档已定案，**实现未落地**（文档-实现脱节） |
| 暂停原因应持久化、可展示（通知到人） | pauseMeta 仅在边界暂停写入 | ⚠️ **缺陷 A3**：`[ASK]`/P4 直接暂停路径未写 pauseMeta |

**土壤吸收结论**：memora 三机制与主流范式高度同构，**方向正确，差距在"上下文完整性与状态持久化的实现完整性"**，而非设计范式本身。以下方案全部是"补齐既有闭环的固有属性"，不是新增机制。

---

## 二、缺陷定性与根因（评审证据）

| # | 缺陷 | 定性 | 根因 | 证据 |
|---|------|------|------|------|
| A1 | `[ASK]` 问题未入工作记忆 → 续跑上下文断裂 | 实现缺陷 | `handleTextResponse` 的 `[ASK]` 分支遗漏常规文本路径的 `appendAssistantText` | loop.ts L839-849 |
| A2 | 暂停轮产出空输出摘要 + 续跑再产一条 → 违反摘要 1:1 | **文档-实现脱节** | `StreamConsumeResult` 无 `paused` 字段；`runEvent/runResume` 只判 `failed/aborted` | orchestrator.ts L161/L187；memory-as-summary §2.5 已定案"软暂停不摘要" |
| A3 | `[ASK]`/P4 暂停未写 pauseMeta → 重启后暂停原因丢失 | 实现缺陷 | pauseMeta 只在 `onPaused`（边界暂停）写入，直接暂停路径绕过 | assembler.ts L338-345 vs agent.ts L584 |
| A4 | `[ASK]` 与工具调用混出时被静默忽略 | 约束缺文档 | `extractAskQuestions` 仅在纯文本路由调用 | loop.ts L655 |
| A5 | `[ASK]` 行周围正文整体丢弃 | 随 A1 修复缓解 | `[ASK]` 分支只推问题、不落史 | loop.ts L839-849 |
| B1 | 执行中 `requestPause` 边界挂起同样可能产空摘要 | 同 A2 根因 | 同 A2 | runEvent→settle |
| C1 | P4 needClarify 暂停未写 pauseMeta | 同 A3 根因 | 同 A3 | agent.ts L584 |
| A6 | 无 Agent 级 `[ASK]→回答→续跑` 端到端测试 | 测试缺口 | 只有 loop 层单测 | loop.test.ts L1836-1910 |

**共性根因（一句话）**：三机制共享同一个最小单元——「闭环暂停边界」，但暂停边界**没有把它"为什么暂停、问了什么、是否算回合完成"这三个固有属性完整记录下来**。修复应落在暂停边界的收口处统一补齐，而非在三个入口各打补丁。

---

## 三、自然生长方案

> 原则：每个缺陷在「闭环暂停边界」这一既有最小单元上补齐固有属性，不新建机制、不新增模块。改动面收敛到 `loop.ts`（入史）+ `agent.ts`（收口标记/写 pauseMeta）+ `orchestrator.ts`（摘要门控）。

### P0-1 修复 A1+A5：`[ASK]` 问题入工作记忆（复用既有文本落史路径）

**生长点**：`handleTextResponse` 的常规路径本就 `appendAssistantText` 落史；`[ASK]` 分支只是走了"只推送、不落史"的旁路。补齐旁路即可，不引入任何新抽象。

**方案**：

```
handleTextResponse 检测到 pendingQuestions：
  1. this.appendAssistantText(fullContent)   // 问题全文入史（含 [ASK] 行周围正文）
  2. yield question_pending（每条 [ASK]）
  3. yield paused
```

**收益**：
- 续跑时 LLM 上下文为 `assistant(问题) + user(回答)`，短回答（"红色"/"第二个"）不再断链；
- [ASK] 行周围正文不再丢弃（A5 缓解）；
- 续跑轮的 round-summary 能提炼到问题与决策（配合 P0-2）。

**设计注意**：UI 展示与历史落史分离——UI 只渲染 question_pending 的问题文本，历史保存全文（与"可观察契约"一致）。

### P0-2 修复 A2+B1：暂停轮不产摘要 ——「回合完成」信号下沉

**生长点**：orchestrator 对 `aborted` 已有"不摘要"门控（L161/L187），`paused` 是同一个"结束原因枚举"的另一取值。在 `StreamConsumeResult` 上补 `paused` 字段并接线，是**枚举的自然扩展**，非新机制。同时把 [memory-as-summary §2.5](file:///f:/zooique/memora/docs/architecture/memory-as-summary.md#L134) 已定案、未落地的"软暂停不摘要"真正实现，消除文档-实现脱节（SSOT 收口）。

**方案**：
1. `consumeExecutionStream` 遇 `chunk.type === 'paused'` 时置 `paused: true`；
2. `runEvent` / `runRun` / `runChat` 在 `acted.paused` 时跳过 `settle`/`backgroundReflect`（摘要推迟到续跑最终轮）；
3. 续跑轮正常产摘要（维持恒 1:1：暂停轮 0 条 + 续跑轮 1 条 = 一次外部输入 1 条）。

**边界一致性**：
- 执行中 `requestPause` 边界挂起（content 可能部分文本）→ 同样 `paused` 跳过（回合未完成）；
- `aborted`（硬中止）→ 维持现状不摘要 + `[已中断]` 标记写史；
- 暂停后不续跑 → 该轮无摘要（无收尾，符合"摘要来自最后一轮问答产出"）。

### P1-1 修复 A3+C1：pauseMeta 统一到暂停收口

**生长点**：三个暂停入口最终都汇入 `consumeExecutionStream` 的 `paused` 收口（agent.ts L710-713），但 pauseMeta 记录却散在 `onPaused`（仅边界路径）。把记录点**收敛到收口**，是"暂停边界的固有属性"的单一落点。

**方案**：
1. `Agent.pause()`（收口处，`consumePendingPause` 之后）统一写入 pauseMeta（reason/source 取自 pendingPause，与状态机一致）；
2. `onPaused` 回调完全移除——`{type:'paused'}` chunk 本身即事件通知（consumeExecutionStream 消费），原回调零注册纯死代码（落地比"降级"更彻底）；
3. `[ASK]`/P4 直接暂停路径自然获得 pauseMeta（它们也走同一收口）。

**收益**：所有暂停路径（用户/Agent[ASK]/系统/P4 clarify）的暂停原因在 checkpoint 中一致，重启后宿主可展示"为什么暂停 + 问了什么"。

### P1-2 修复 A6：补 Agent 级端到端集成测试

在 `uninterruptedWorkflow.test.ts` 新增用例，断言：
- (a) LLM 输出 `[ASK]` → 问题入史（`assistant` 消息含问题）；
- (b) 会话进 `paused`，**该轮不产 round-summary**；
- (c) `resumeExecution(回答)` 续跑 → LLM 下一轮上下文含问题 + 回答；
- (d) 续跑轮恰好产 1 条 round-summary（恒 1:1）。

### P2-1 修复 A4：`[ASK]` 与工具混出的约束文档化

保持 `[ASK]` 纯约定（零依赖 SSOT），文档化约定："`[ASK]` 必须独占回合输出，不与工具调用同轮"。混出时的降级行为：问题文本仍入史（P0-1 后），不暂停——LLM 下一轮自见问题可继续，属于"不暂停的软降级"，不静默丢信息。

### P2-2 记录 B3（低优先，暂不修）：续跑时插话时序

paused 后 interject 的队列在续跑时消费，且 resume 输入先于插话 append（continueAfterPause L359-363 vs handleIterationResult L530-536）。场景罕见、影响极小，本文只记录，不承诺修复。

---

## 四、实施顺序与验证

| 批次 | 项 | 改动文件 | 风险 |
|------|----|----------|------|
| 批次 1（P0） | A1+A5 入史；A2+B1 摘要门控 | `loop.ts`、`agent.ts`、`seed/orchestrator.ts` | 低：复用既有路径，纯补齐 |
| 批次 2（P1） | A3+C1 pauseMeta 收口；A6 集成测试 | `agent.ts`、`assembler.ts`、`__tests__/uninterruptedWorkflow.test.ts` | 低：收口单一化 |
| 批次 3（P2） | A4 文档化；B3 记录 | `docs/architecture/task-driven-closed-loop.md` | 无代码风险 |

**验证**：`npx vitest run src/agent`（含新增集成用例）；`npm run typecheck` 零错误。批次 1 落地后再回归评审，确认摘要恒 1:1 在普通对话/暂停续跑/外部任务循环三种路径下均成立。

---

## 五、来源记录（土壤可追溯）

- [TraeWork 快速开始（官方）](https://docs.trae.cn/work_trae-work-web-and-desktop-quickstart)
- [TraeWork 概述（官方）](https://docs.trae.cn/work_what-is-trae-work)
- [TraeWork 学习闭环 Skill 案例（官方社区）](https://forum.trae.cn/t/topic/172245)
- [Forge Proactive Clarification 设计（Phase 5B）](https://github.com/johnkord/agents/blob/main/research/phase-5b-proactive-clarification-design.md)
- [Claude Code Pitfalls #37: AskUserQuestion](https://claudecodetips.com/en/guide/pitfalls/37)
- [vscode#291565: 过度确认破坏 flow（反面教材）](https://github.com/microsoft/vscode/issues/291565)
- [Agent Interrupt and Approval Checkpoints（四组件）](https://www.channel.tel/blog/agent-interrupt-checkpoint-approval-patterns)
- [claude-code#59265: 实时反馈信号分级](https://github.com/anthropics/claude-code/issues/59265)
- [CopilotKit useInterrupt（AG-UI interrupt 标准）](https://docs.showcase.copilotkit.ai/human-in-the-loop/useInterrupt)
- [AI Agent Interface Design（progress visibility / intervention）](https://designpixil.com/blog/ai-agent-interface-design)
