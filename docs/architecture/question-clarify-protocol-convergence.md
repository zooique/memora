# 双提问机制收敛评估：P4 needClarify × \[ASK] question\_pending（探索期）

> **文档定位**：TS-O3（待完成任务清单「观察项」）收敛评估产出。评估「P4 澄清」与「\[ASK] 主动提问」两套"提问后暂停"机制是否重复、如何收敛。
>
> **状态**：档 1 已实施（2026-09-02，内核 + vscode 宿主）；**档 2 已剪枝（2026-09-03，P4 整条移除，[ASK] 为唯一提问通道，见 §七）**。可逆决策，符合 S1 探索期落地——不写 ADR、不占编号、不改 README 索引。
>
> **方法**：实证先行（逐条读源码链路核对现状，非凭印象）；自然生长（收敛目标是「统一对外提问协议」，不消灭触发源差异与续跑语义差异）；关联既有真理源 [pause-ask-resume-design.md](./pause-ask-resume-design.md)（三机制共享的闭环暂停边界已收敛至单一收口）。

***

## 一、现状实证（2026-09-02 逐条核对）

### 1.1 两机制链路对比

| 维度           | P4 needClarify（composer 补全链）                                                                                             | \[ASK] question\_pending（loop 主动提问）                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **触发者**      | 内核 composer 确定性检测槽位缺失                                                                                                    | LLM 流输出结构化 `[ASK] 问题 {A\|B}` 行                                                                                                              |
| **触发时机**     | 输入进入闭环前（门面 handleInput 的 compose 阶段）                                                                                     | 执行闭环内（`handleTextResponse` 迭代期）                                                                                                             |
| **载荷类型**     | `ClarifyQuestion`（slot/question/options/**lowRisk**）[types.ts](../../src/agent/types.ts#L460-L469)                       | `AskQuestion`（slot='ask'/question/options）[types.ts](../../src/agent/types.ts#L477-L484)                                                    |
| **chunk 通道** | `text`（`[需澄清] ${q.question}` 拼接，**无结构化 chunk**）[agent.ts L622](../../src/agent/agent.ts#L622)                            | `question_pending` 结构化 chunk（每条一条）[loop.ts L1196](../../src/agent/loop.ts#L1196)                                                            |
| **事件通道**     | `AGENT_EVENTS.needClarify`（宿主全局注册，构造时稳定）[chatPanel L846](../../hosts/memora-vscode/src/webview/panels/chatPanel.ts#L846) | `AGENT_EVENTS.questionPending`（宿主**流内注册**，consumeFlow 开头）[chatPanel L1987](../../hosts/memora-vscode/src/webview/panels/chatPanel.ts#L1987) |
| **暂停收口**     | `pause('agent')` + `setPauseMeta` + `done`，**直接 return 不经闭环流**                                                           | `paused` chunk（经流收口，`consumePendingPause` 统一翻 PAUSED）                                                                                       |
| **防滥用**      | 高低风险分级 + 连续暂停计数降级 P3                                                                                                     | 无（LLM 对话流，受 askLimit/策略约束）                                                                                                                  |
| **用户回答续跑**   | clarify 事件 → `formatClarifyAnswers`（slot→中文标签映射）→ 转 chat 语义 → **重新 compose**（槽位填充）                                       | question-answer 交互输入 → `continueAfterPause` **直接续跑**（不重新 compose）                                                                           |
| **入史**       | `[需澄清]` 文本入史                                                                                                             | 问题全文入史（pause-ask-resume P0-1 已落地）                                                                                                           |

### 1.2 宿主消费现状（关键：webview 端已统一）

两个事件（`needClarify` / `questionPending`）在宿主 panel 层最终都 post **同一个** `need_clarify` 协议消息 → webview 渲染同一套澄清输入条 UI。**webview 端没有重复**，重复停留在「内核双通道 + 宿主双监听」。

### 1.3 TS-O5 现状（本评估顺带复核）

[chatPanel L2049](../../hosts/memora-vscode/src/webview/panels/chatPanel.ts#L2049) 显式忽略 `question_pending` chunk（"已由 questionPending 事件驱动"）。\[ASK] 的提问 UI **单点依赖流内注册的事件**——若事件监听未就绪（流入口切换/事件系统异常），问题展示丢失且无 chunk 兜底。

***

## 二、收敛判定：重复域 vs 合理差异

| 维度                                    | 是否为重复/技术债 | 判定依据                                                                                    |
| ------------------------------------- | --------- | --------------------------------------------------------------------------------------- |
| **触发源**（composer 确定性 vs LLM 自由）       | ❌ 合理差异    | 一种是"系统确定性需要信息"（槽位缺失），一种是"LLM 主动需要信息"（执行中确认）。触发者、时机、防滥用模型都不同，合并是过度设计                     |
| **续跑语义**（重新 compose vs 直接续跑）          | ❌ 真实功能差异  | P4 回答是"输入的补全前置条件"（填槽位再执行）；\[ASK] 回答是"对话的新一轮"（直接推进）。合并会破坏 P4 槽位填充或让 \[ASK] 重复 compose 重问 |
| **对外提问协议**（chunk 结构化度 + 事件双名）         | ✅ 重复/债    | 两者对用户的交互是**同一件事**（提问 → 暂停 → 回答 → 继续），却走两套协议。P4 缺结构化 chunk，ASK 的双通道单点依赖（TS-O5）           |
| **载荷类型**（ClarifyQuestion/AskQuestion） | ✅ 轻微重复    | 形状几乎相同，注释已承认"共享载荷形状，宿主可统一渲染"；差异仅 `lowRisk`（P4 防滥用用）                                     |

**结论**：TS-O3 值得收敛，但收敛目标**不是消灭双机制**，而是**统一对外提问协议 + 修 TS-O5**。内部差异（触发源/续跑/防滥用）保留——这符合 SSOT 最小改动原则与自然生长哲学（内部语义差异留到能证明重复再合并，外部用户可见协议先行统一）。

***

## 三、收敛方案（三档，推荐档 1）

### 档 1（推荐）· 协议统一：P4 补结构化 chunk + 宿主 chunk 兜底

**改内核（低风险、可回退）**：

- [agent.ts L620-L643](../../src/agent/agent.ts#L620-L643) P4 分支在 `text [需澄清]` 之后、`pause` 之前补发结构化 chunk：

  ```ts
  yield { type: 'question_pending', questions: composeResult.needClarify.map((q) => ({
    slot: q.slot, question: q.question, ...(q.options ? { options: q.options } : {}),
  })) };
  ```

- 保留 `needClarify` 事件（宿主全局注册稳定，不需动组装器）。

**改宿主（顺带消 TS-O5）**：

- [chatPanel L2049](../../hosts/memora-vscode/src/webview/panels/chatPanel.ts#L2049) `question_pending` chunk 不再无条件忽略——改为**事件优先 + chunk 幂等兜底**（同一轮次已渲染提问则跳过，避免事件+chunk 双弹）。

- 收益：`question_pending` 成为全量渲染源（\[ASK] 与 P4 同构），事件仅在流式消费顺畅时提前驱动；监听未就绪时 chunk 兜底不丢问题。

**边界**：P4 的 text `[需澄清]` 保留（消息流可追溯，与 webview 提问 UI 并存为现状），不动 compose 注入、不动触发源、不动续跑语义。

### 档 2（可选）· 类型收敛：`ClarifyQuestion`/`AskQuestion` 合一

- 合并为单一载荷接口（`slot/question/options` + 可选 `lowRisk`），composer 产物与 \[ASK] 复用同一类型；`source: 'composer' | 'ask'` 保留溯源。

- 事件名是否合并（`questionPending` 吸收 `needClarify`）需同步改 agent.ts / loop.ts / assembler.ts / 宿主双监听与存量测试——**中风险**，收益是消除类型双声明与事件双名。

- 建议**延后**：触及面含测试断言与宿主协议，与档 1（纯增量）解耦，优先稳档 1。

### 档 3（不做）· 语义合并：P4 移入闭环流 / 统一续跑

- 把 P4 从门面层移入闭环流（compose 进 loop）或统一续跑语义——破坏"回答应用检查点"与"对话轮"的真实差异，大改 compose 注入（原观察项标注"挑战大"），违背最小改动原则。**明确排除**。

***

## 四、实施边界与验证

| 项        | 风险                                        | 验证                                                                            |
| -------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| 档 1 内核增量 | 低：纯加可选 chunk，不动既有通道；宿主忽略 chunk 的旧逻辑改为幂等兜底 | agent 测试断言 P4 分支 emit `question_pending`；宿主 vitest 补「chunk 兜底渲染 + 事件已渲染不重复」用例 |
| 档 1 宿主   | 低：补 PowerPoint 幂等去重                       | 全量 vitest + 双端 tsc 0                                                          |
| TS-O5 收敛 | 低：chunk 兜底把"单点事件依赖"降为"双源互补"               | 同上                                                                            |

**关联**：TS-O5（question\_pending 双通道竞态）随档 1 一并收敛；既有 [pause-ask-resume-design.md](./pause-ask-resume-design.md) 的"闭环暂停边界单一收口"结论不改变，本方案在其外向"宿主可见协议"再收敛一层。

***

## 五、来源记录（土壤可追溯）

- 代码实证：agent.ts L602-L646、loop.ts L1180-L1248、types.ts L460-L491、chatPanel.ts L663-L676/L1982-L2058、assembler.ts L343-L351（本文档 §一链路表）

- 既有设计真理源：[pause-ask-resume-design.md](./pause-ask-resume-design.md)（三机制共享最小单元"闭环暂停边界"识别）、[agent-design-philosophy.md](./agent-design-philosophy.md)（§14.3 主动提问/输入中断）

***

## 六、实施记录与观察（2026-09-02 档 1 落地）

### 实施内容（档 1 · 协议统一 + TS-O5 收敛）

| 层         | 文件                                                                                             | 改动                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 内核        | [agent.ts](../../src/agent/agent.ts) L632-L642                                                 | P4 暂停补发结构化 `question_pending` chunk（slot/question/options，与 \[ASK] 同构）；`needClarify` 事件保留（全局注册稳定，兼容 sprite）     |
| 宿主 vscode | [chatPanel.ts consumeFlow](../../hosts/memora-vscode/src/webview/panels/chatPanel.ts)          | `question_pending` chunk 从"无条件忽略"改为**事件优先 + chunk 幂等兜底**：事件驱动时清 chunk 缓存；事件未驱动（监听未就绪/异常）时流尾统一兜底渲染提问 UI。TS-O5 消除 |
| 测试        | [uninterruptedWorkflow.test.ts](../../src/agent/__tests__/uninterruptedWorkflow.test.ts) L2379 | P4 链路补断言 `question_pending` chunk（correction 事件触发 task 槽 P4 澄清）                                                 |

**验证**：内核 2636 全绿 + 宿主 vscode 246 全绿 + 双端 tsc 0 错。

### 实证发现：P4 在 vscode 宿主为死路径

- vscode 宿主唯一入口 `agent.chat()`（chatPanel L1883）→ `runChat` 直连 loop，**从不调** **`processEvent`（P4 唯一消费入口）**；

- vscode 宿主**从不发送** `correction/command/clarify` 类型 SessionEvent（全仓搜索零命中）；

- 结论：P4 在 vscode **100% 不可触发**（用户实测从未目睹一致）；P4 为 **sprite 专用 + vscode 死路径**（sprite 走 chatStreamHandler `processEvent`）。

- 含义：档 1 的 P4 补 chunk 在 vscode 是纯防御/协议同构增量；TS-O5 chunk 兜底的真价值在 \[ASK]（正常触发）。

### 观察：停滞确认职责未来或可移交 \[ASK]（待 \[ASK] 可靠性实证）

- P4 剩余真实职责仅 `resolveStalledTaskSlot`（计划停滞 → 确定性问方向）+ role/standard SlotRef 边缘。

- 主流范式（AskUserQuestion 等）把"提问时机/内容"交给 LLM；若未来 \[ASK] 在"任务链收尾"场景被真实场景实证"问得准、记得问"，可评估 P4 停滞分支退役（由 \[ASK]/LLM 承担）——**当前不做**：vscode 上 P4 不触发、sprite 还依赖确定性停滞确认，退役是净功能损失换形态统一，违背"克制提问"哲学。

***

## 七、档 2 · P4 整条剪枝（2026-09-03 实施）

**决策**：P4（needClarify · composer 四元组补全链）整条移除，`[ASK]`（question\_pending）成为内核唯一「提问后暂停」通道。符合"先验证后固化"：P4 为 vscode **死路径**（§六实证），属初始设计未自然生长的残留，剪枝保持内核纯洁性。

**删净的 sprite 专属实体**（仅内核，宿主 sprite 侧未同步、按"抛弃 sprite"决策不再维护）：

| 实体 | 落点 |
| --- | --- |
| `composer.ts`（四元组三源补全）/ `composer.test.ts` | 删除 |
| `SessionEvent` / `DeltaPayload` / `SlotRef` / `FourTuple` / `CompletionLevel` | [types.ts](../../src/agent/types.ts) 删除 |
| `processEvent` / `applyResolvedDelta` / `handleNonChatEvent` / `formatClarifyAnswers` / `injectMetaNote` | [agent.ts](../../src/agent/agent.ts) / [loop.ts](../../src/agent/loop.ts) 删除 |
| `runEvent` / `settle` / `TASK_TABLE_HINT` | [orchestrator.ts](../../src/agent/seed/orchestrator.ts) 删除 |
| `shouldGenerateTaskTable`（任务表预判） | [checkpointRestoreCoordinator.ts](../../src/agent/checkpointRestoreCoordinator.ts) 删除 |
| `AGENT_EVENTS.needClarify` | [eventEmitter.ts](../../src/utils/eventEmitter.ts) 删除 |
| 相关测试（runEvent / processEvent 用例） | [orchestrator.test.ts](../../src/agent/seed/__tests__/orchestrator.test.ts) / [uninterruptedWorkflow.test.ts](../../src/agent/__tests__/uninterruptedWorkflow.test.ts) 删除 |

**保留的共享内核**（vscode 活性依赖，非 sprite 专属，剪枝不动）：

- `seed/` 的 `runChat` / `runResume`——`agent.chat()` 委托（vscode 唯一入口）、`resumeExecution()` 续跑（`[ASK]` 回答 / 继续按钮）。
- `checkpointRestoreCoordinator.ts`——`restoreFromCheckpoint` 初始化时活性调用。
- `chatSync`——`chat()` 的同步封装（内部复用 `runChat`），非独立执行通道。
- 记录剪枝决策的注释（`types.ts` / `index.ts` / `eventEmitter.ts` 的"已随 composer 剪枝"标注）。

**净效果**：16 文件 +58/−1689（净 −1631 行）。`tsc --noEmit` 0 错；内核 2602 用例全绿。

**遗留（按"抛弃 sprite"决策不处理，仅记录）**：sprite 宿主 `chatHandlers.ts` / `ipcListeners.ts` / `preload.ts` 仍监听已删除的 `needClarify` 事件——内核不再 emit，sprite 澄清功能静默失效。若未来重新启用 sprite，需先同步该监听面。

