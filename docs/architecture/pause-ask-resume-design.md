# 暂停 · 主动提问 · 输入补充 —— 气口机制设计（定案）

> **2026-09-06 定案**：三气口机制已收敛。中断队列 + 统一 step 边界消费。本文前半部分为定案设计（当前代码形态），后半部分保留探索期设计记录（决策依据）。
>
> **文档定位**：已实现的气口机制设计文档。不是 ADR（没有跨模块不可逆约束需要冻结），是"代码就是设计"的自然生长记录。
>
> **本文边界（只覆盖「自愿介入」）**：本文的暂停/插话/补充/ask 均由**用户或 LLM 主动申请**，在 **step 边界**生效，**同一 turn 内**继续，turn 连续性始终保持。**进程被杀/断电等外部强制中断不走本文**——内存态随进程丢失，申请-介入的前提不再成立，须走 [step-atomic-persistence.md](./step-atomic-persistence.md) 的「中断轮收场 → 重开」路径。
>
> **边界裁决（2026-09-10 定案）**：断电时正处于暂停态 → **以断电为准**，按中断路径处理（补全为正常 turn + 只能新开 turn），不恢复暂停态。即：**自愿介入要求内存态连续，一旦进程死亡即降级为非自愿中断**。

---

## 第一部分 · 定案设计（当前代码形态）

### 一、核心模型：InterruptRequest 队列（SSOT）

**2026-09-06 收敛**：旧设计分散为 `pauseRequested: boolean` flag + `pendingInterjections: string[]` 数组。统一为单一队列。

```typescript
// loop.ts
type InterruptRequest =
  | { readonly kind: 'pause' }                              // 用户暂停申请
  | { readonly kind: 'interject'; readonly content: string }; // 用户插话申请

// 唯一字段
private interruptQueue: InterruptRequest[] = [];
```

**ask_user（LLM 主动提问）不走此队列**——它是 LLM 工具触发的气口，在 `handleAskUser` 工具分支独立 yield paused。来源不同（用户申请 vs LLM 工具），分开合理。

### 二、写入入口（申请 → 队列）

所有申请都是**非阻塞入队**——不中断当前正在跑的 step，等 step 边界生效。

| 用户操作 | Agent API | Loop 委托 | 队列操作 |
|----------|-----------|-----------|----------|
| 点暂停按钮 | `agent.requestPause(reason, source)` | `loop.requestPause()` | `queue.push({kind:'pause'})`（幂等：已有 pause 条目则不重复） |
| 取消暂停（生效前反悔） | `agent.cancelPauseRequest()` | `loop.clearPauseRequest()` | `queue.filter(r => r.kind !== 'pause')` |
| 执行中插话 | `agent.interject(content)` | `loop.interject(content)` | `queue.push({kind:'interject', content})` + history 持久化（TS-9 问答归属） |
| 删一条插话（后悔） | `agent.removePendingInterject(index)` | `loop.removePendingInterject(index)` | 计算 interject 条目的全局索引映射，splice 删除 |
| 清空全部插话 | `agent.clearPendingInterjections()` | `loop.clearPendingInterjections()` | `queue.filter(r => r.kind !== 'interject')` |

### 三、消费出口（step 边界 → 统一 splice）

`_handleInterrupt` 是**唯一消费点**——每次迭代循环的头部被调用，原子取出全部申请。

```typescript
// loop.ts _handleInterrupt（简化）
private async *_handleInterrupt(signal) {
  const reqs = this.interruptQueue.splice(0); // 原子消费，消费后队列为空

  // ① 先注入型（interject）→ appendUserMessage
  for (const req of reqs) {
    if (req.kind === 'interject') this.appendUserMessage(req.content);
  }

  // ② 后挂起型（pause）→ yield paused + generator return
  if (reqs.some(r => r.kind === 'pause')) {
    yield { type: 'paused' };
    return 'paused';
  }

  // ③ 硬中止检查
  if (signal?.aborted) {
    yield { type: 'aborted', reason: ... };
    return 'aborted';
  }
  return signal; // 继续正常迭代
}
```

**消费顺序是刻意的**：注入型优先于挂起型。如果用户同时发了 interject + pause，补充输入先 `appendUserMessage` 入史，再 yield paused。这样续跑时 LLM 能看到补充，不会被 pause 吞掉。

### 四、续跑：generator return paused → 外部重入

暂停不是"让正在跑的 step 停下来"——正在跑的 LLM 调用/工具执行会**自然跑完**。`pauseRequested` 标志在**下一个 step 边界**被检查。

```
runIterationLoop {         // generator instance A
  while (...) {
    step 1
    _handleInterrupt() → queue 有 pause → yield {type:'paused'}
                                        return 'paused'  ← generator A 结束
    step 2...  （不会被执行）
  }
}

// consumeExecutionStream 收到 'paused' chunk
// → sessionManager.pause()   [状态机 running → paused]
// → 写 pauseMeta checkpoint

// 用户点继续 → agent.resumeExecution(input?)
// → loop.continueAfterPause(input, signal)
//   → (optional) input → cleanExecutionTemporary + appendUserMessage(input)
//     // 注：续跑时直接 append，不走 queue——此时 loop 还没开始跑，不存在"step 边界"消费时机
//   → resetTurnState()
//   → runIterationLoop()   // generator instance B，全新！
```

**同一 turn 节点延续**：续跑沿用 `processUserInput` 分配的 roundId（不分裂新轮），messages 保留（checkpoint 落盘），askBudget 不清（防续跑段重复允许提问）。

### 五、状态机翻态：事实驱动，不申请即翻

```
申请阶段（UI 点暂停）：
  agent.requestPause()
    → sessionManager.requestPause()  // 只置 pendingPause，状态机仍 running
    → loop.requestPause()            // queue.push({kind:'pause'})
  状态机仍 running！UI 暂停按钮图标不变（纯投影，无本地 toggle）

气口生效（loop 边界）：
  _handleInterrupt → yield {type:'paused'}
  consumeExecutionStream 消费：
    → sessionManager.consumePendingPause()  // 取走 pendingPause
    → sessionManager.pause()                // 状态机 running → paused
  UI 收到 status{paused} → pauseBtn 隐藏，send 按钮变 ▶
```

### 六、ask_user 主动提问（LLM 工具触发的气口）

不走 interruptQueue——它是 LLM 调 ask_user 工具时触发的，在 handleAskUser 分支独立处理：

```typescript
// loop.ts handleAskUser
private async *handleAskUser(llmResult, toolCalls) {
  this.appendAssistantToolCall(fullContent, toolCalls); // tool_calls 落史
  this.pendingAsk = {toolCallIds, questions};
  for (const q of questions) yield {type: 'question_pending', questions: [q]};
  yield {type: 'paused'};
  return 'paused';
}
```

**回答续跑**：`agent.answerQuestion(answers)` 回填 tool result（和 tool_calls 配对，结构合法）→ `agent.resumeExecution(answer, kind:'question-answer')` → `continueAfterPause`。

---

## 第二部分 · 用户体验

### 核心认知：暂停不打断正在跑的 step

**所有暂停/插话都不打断当前正在跑的 step**。LLM 打字打到一半不会停，工具执行到一半不会停。它们都是"当前 step 跑完后、下一步开始前"生效。这是整个设计最核心的纪律，也是用户体验最稳定的保障。

### 场景 1：正常暂停 → 继续

| 阶段 | 用户动作 | 感知 |
|------|----------|------|
| T0 | 正在生成中，pauseBtn 显示 ‖ | 进度条在动，LLM 在打字 |
| T1 | 点暂停按钮 | **当前正在打的字会打完**，等待时间 = 当前 step 剩余时间（一般 1-3 秒） |
| T2 | step 边界到 | 状态翻 PAUSED，pauseBtn 隐藏，send 变 ▶ |
| T3 | 点继续 ▶ | 从 checkpoint 恢复，进度条继续推进 |

### 场景 2：暂停 → 生效前反悔 → 取消暂停

| 阶段 | 用户动作 | 感知 |
|------|----------|------|
| T0 | 正在输出 | — |
| T1 | 点暂停 → 入队 pause 申请 | 但 step 还没到边界 |
| T2 | 再点暂停 | cancelPauseRequest → queue 里 pause 被移除 |
| T3 | step 边界到 | queue 空，**完全无感**——按钮图标没变，LLM 继续输出 |

### 场景 3：暂停 → 等生效 → 补充输入 → 继续

| 阶段 | 用户动作 | 感知 |
|------|----------|------|
| T0 | 暂停生效，PAUSED | 状态翻暂停 |
| T1 | 在输入框打字补充内容 | 输入框完全可用，没被锁 |
| T2 | 点 send | 补充内容作为新 user 消息入史，LLM 续跑时必看到 |

### 场景 4：执行中插话（不暂停 loop）

| 阶段 | 用户动作 | 感知 |
|------|----------|------|
| T0 | 正在生成中 | — |
| T1 | 快速打字 + send | interject → queue 入队 + history 持久化 |
| T2 | 当前 step 跑完，边界到 | 注入型优先 → 补充先入史，然后继续 loop |
| T3 | 下一轮 step | LLM 可能立刻调整行为，比如"收到补充，现在同时写 report.md" |

### 场景 5：执行中插话 + 同时点暂停

| 阶段 | 用户动作 | 感知 |
|------|----------|------|
| T0 | 快速打字 + 点暂停 | queue = [{interject}, {pause}] |
| T1 | step 边界到 | **注入型优先**：interject 先入史，再 pause 挂起。补充不被吞掉 |
| T2 | 点继续 | messages 里已经有补充了，LLM 续跑第一轮就看到 |

### 场景 6：暂停 → 不想继续了 → 彻底停止

| 阶段 | 用户动作 | 感知 |
|------|----------|------|
| T0 | PAUSED 状态 | — |
| T1 | 点硬停止 | discardCurrentCheckpoint → **同时清 checkpoint + 清 queue**（不留孤儿数据） |
| T2 | done 态 | 可以开始新对话，没有残留 |

### 场景 7：LLM 主动提问

| 阶段 | 用户动作 | 感知 |
|------|----------|------|
| T0 | LLM 执行中决定问用户 | 弹出结构化提问 UI，暂停 |
| T1 | 回答问题 | answerQuestion（回填 tool result） + resumeExecution |
| T2 | 续跑 | LLM 已看到回答，继续执行 |

### 用户体验总结

> 暂停按钮点了**不立即停**（等 step 边界），取消暂停**完全无感**，补充输入**不被吞**（注入型优先），暂停后输入框**正常可用**，stop 彻底清干净**不留残留**。用户看到的就是"一个 ‖ 按钮 + 一个 ▶ 按钮 + 永远能打字的输入框"，其他复杂的气口消费顺序、queue 原子消费、generator 重入——都在用户看不到的内核里自然生长。

---

## 第三部分 · 自然生长的设计哲学

### 公理检验

| 自问三题 | 答案 |
|----------|------|
| ① 这套逻辑是否只在某场景生效？ | 否。interruptQueue 覆盖 pause + interject；ask_user 是 LLM 工具触发，来源不同分开合理 |
| ② 去掉该场景特殊处理，核心是否仍完整？ | 是。pauseRequested getter/setter 是 queue 的语法糖，去掉也能跑，保留只是兼容 API |
| ③ 实现是否需在最小单元之外引入新机制？ | 否。统一 queue + 统一 splice(0) 消费，没有引入新引擎/新层 |

### "水龙头模型" vs 当前截断重接

用户曾提出"generator 不退出、活着挂起等外部信号"的水龙头模型。评估后结论：**当前截断重接不是"错的截断"，而是"在每轮 step 循环后 generator 自然退出，续跑就像再开一轮"**——逻辑上和水龙头等价，但工程上更干净。

```
水龙头模型（理论）：generator 挂起 + await Promise resolve
当前实现（定案）：generator return paused + 外部重调 runIterationLoop
```

### "永不停止运行"的承载方式

"类似机器人的开关，一启动就持续运作"**不需要改 turn 内任何东西**——它是**宿主层驱动**：turn done 后宿主自动调 runChat()。暂停 = 打断当前 turn 的 step 循环（requestPause → generator return）；继续 = continueAfterPause（同 turn 节点续跑）+ 等 done 后宿主再自动拉起下一个 turn。

### SSOT 残留检查

| 检查项 | 状态 |
|--------|------|
| pauseRequested flag 还作为独立变量？ | ✅ 已消除（getter/setter 委托 queue） |
| pendingInterjections 还作为独立数组？ | ✅ 已消除（合并进 queue） |
| _handleInterrupt 还分别检查两处？ | ✅ 已统一（queue.splice(0) 一次消费） |
| 状态机翻态是"申请即翻"？ | ✅ 事实驱动（chunk.type===paused 时才翻 PAUSED） |
| 有没有双写（history + queue 写同一内容）？ | ✅ 无（history 持久化 + queue 运行时消费，两个目的） |
| 取消暂停后 queue 残留 pause？ | ✅ 已防（setter filter + splice(0) 天然清空） |
| stop→discard 时 queue 残留？ | ✅ 已防（同时清 checkpoint + queue） |

---

## 第四部分 · 历史探索记录（2026-09-04 归档）

> 以下保留探索期缺陷分析与方案论证，作为收敛决策的历史依据。**不再作为实现参考**——当前代码以上文定案设计为准。

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
| **Plan-Then-Execute 收敛**：先研究→把歧义列为"开放问题"→用户澄清→再执行；澄清集中在规划阶段而非执行中途 | [Forge proactive-clarification 设计](https://github.com/johnkord/agents/blob/main/research/phase-5b-proactive-clarification-design.md) | 印证 memora `chat 事件永不 P4` 的正确性（少问多做）；执行中提问是 memora 相对主流的前瞻点（ask_user） |
| **AskUserQuestion 是"工具化澄清"**：Anthropic 特意做了结构化工具而非纯文本约定，因为结构化提问产出更稳 | [Claude Code Pitfalls #37](https://claudecodetips.com/en/guide/pitfalls/37) | memora 用 ask_user 工具调用（2026-09-04 收敛），天然保持问题在上下文可追溯 |
| **过度确认破坏 flow**（反面教材）：Copilot 频繁暂停要"continue"被大量吐槽，要求"上下文无歧义时自动继续" | [vscode#291565](https://github.com/microsoft/vscode/issues/291565) | 印证：**提问要克制**（askLimit/防滥用已有），且被提问打断的回合不应污染记忆（A2 已修复） |
| **interrupt 四组件**：gate（拦截）+ checkpoint（保状态）+ notification（通知到人）+ resume path（重建工作流），缺一即坏 | [Agent Interrupt and Approval Checkpoints](https://www.channel.tel/blog/agent-interrupt-checkpoint-approval-patterns) | memora 已具备四组件；pauseMeta 是"通知到人"的持久化载体（A3 已修复） |

### 缺陷定性与根因（探索期）

| # | 缺陷 | 定性 | 根因 |
|---|------|------|------|
| A1 | 问题未入工作记忆 → 续跑上下文断裂 | 实现缺陷 | ask_user 分支遗漏常规文本路径的 appendAssistantText |
| A2 | 暂停轮产出空摘要 + 续跑再产一条 → 违反摘要 1:1 | 文档-实现脱节 | StreamConsumeResult 无 paused 字段 |
| A3 | 暂停路径未写 pauseMeta → 重启后暂停原因丢失 | 实现缺陷 | pauseMeta 只在 onPaused 写入 |
| B1 | 执行中 requestPause 同样可能产空摘要 | 同 A2 根因 | 同 A2 |

**共性根因**（修复前）：三机制共享同一个最小单元——「闭环暂停边界」，但暂停边界**没有把它"为什么暂停、问了什么、是否算回合完成"这三个固有属性完整记录下来**。

**修复后**：上述缺陷全部修复。ask_user 已收敛为内置工具（问题落史、答案 tool result 回填）；暂停轮不产摘要（StreamConsumeResult.paused 门控）；pauseMeta 统一收口写入（Agent.pause() 收口处）。

### 来源记录（土壤可追溯）

- [TraeWork 快速开始（官方）](https://docs.trae.cn/work_trae-work-web-and-desktop-quickstart)
- [TraeWork 概述（官方）](https://docs.trae.cn/work_what-is-trae-work)
- [Agent Interrupt and Approval Checkpoints（四组件）](https://www.channel.tel/blog/agent-interrupt-checkpoint-approval-patterns)
- [CopilotKit useInterrupt（AG-UI interrupt 标准）](https://docs.showcase.copilotkit.ai/human-in-the-loop/useInterrupt)
