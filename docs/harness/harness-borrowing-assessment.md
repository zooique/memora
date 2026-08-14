# 从 DeepSeek Harness 汲取营养：排雷评估

> 状态：排雷完成，形成最终采纳结论
> 日期：2026-08-14
> 关联：本评估基于 [architecture_philosophy_rules.md](../../.trae/rules/architecture_philosophy_rules.md)（10 条架构哲学）与 [single-truth-source-mindset.md](../../.trae/rules/single-truth-source-mindset.md)（单一真理源思维）逐条推演，结论全部落到现有代码证据。

---

## 一、背景

DeepSeek Harness（2026-08-13 开源，MIT）提出三大可借鉴点：

1. **工具执行流水线**（tools/pre-execute → execute → post-execute 瀑布事件，任意环节可插拔）
2. **系统提示词 section 化**（system-prompt section 注册表，prompt-section 按需装配）
3. **"模型可见即已记录"**（append-only 会话日志，任何到达模型的内容可从日志重建）

另有三条中 ROI 建议：Turn/Step 双层循环、子 Agent 委派、通用 inject API。

**评估方法**：对照 memora 现有代码（loop.ts / toolExecutor.ts / contextManager.ts / sessionStore.ts / agent.ts / configManager.ts）逐条排雷，识别：重复定义、架构分层冲突、哲学冲突、过度设计四类雷区，再给出收敛后的最终采纳结论。

---

## 二、逐条排雷推演

### 建议 A：工具执行流水线钩子（pre/post/onError）

| 项目 | 内容 |
|------|------|
| **Harness 参照** | tools/* 瀑布事件，Hook → 审批 → 权限 → 沙箱 → 超时 → 后处理全可插拔 |
| **memora 现状** | 已有三个分散钩子：`onBeforeWrite`（[toolExecutor.ts](../../src/agent/toolExecutor.ts) 写入扩展）、`onToolExecuted`（[loop.ts](../../src/agent/loop.ts#L121) 执行后记录）、`preExecutionCheck`（[loop.ts](../../src/agent/loop.ts#L134) 幂等跳过），外加 `sanitizeExternalText`（web_search 净化） |
| **雷区** | ⚠️ **重复定义**：三钩子已承担"执行前检查 / 执行后记录"职责，再建统一 ToolHook 会造成两套并列钩子机制 |
| **排雷结论** | **不新建 ToolHook 抽象**。现有回调已覆盖"记录 + 幂等"两大需求，真正的缺口只是**执行前拦截/审批**——用 `preExecutionCheck` 返回值扩展为 `{ skip, overrideArgs?, denied? }` 即可，一个参数补齐，不引入新机制 |
| **判定** | ✅ **采纳（收敛版）**——复用现有 preExecutionCheck，扩充分支语义，不做新抽象 |

**为什么收敛而不是新建**：单一真理源 §3.2——"在复杂场景上叠加补丁"是错误方向，正确做法是"回到最小单元，看能否用参数化解决"。现有三钩子就是工具执行扩展的最小单元，加一个返回值分支即可。

### 建议 B：系统提示词 section 化

| 项目 | 内容 |
|------|------|
| **Harness 参照** | ctx.systemPrompt 是 section 注册表，prompt-section 可增删排序 |
| **memora 现状** | 已有多条确定性注入通道：`systemPromptPrefix`（persona）、`bootstrapMemories`（rule，[loop.ts](../../src/agent/loop.ts#L66)）、`injectSystemMessage`（通用运行时注入，[loop.ts](../../src/agent/loop.ts#L1425)）、`injectRecallAsSystem`（召回记忆，[loop.ts](../../src/agent/loop.ts#L1436)）、`cleanTemporarySystemMessages`（每轮清理临时 system，[loop.ts](../../src/agent/loop.ts#L1713)） |
| **雷区** | ⚠️ **架构分层冲突 + 重复定义**：memora 已经用"system 消息数组 + 每轮清理"实现了等价于 section 装配的机制；架构哲学 §1.4 明确禁止"系统提示词硬编码"。再建 section 注册表 = 给已有机制换壳 |
| **排雷结论** | **不采纳**。memora 的"永久 system[0] + 临时 system 注入 + 每轮清理"已是 section 化的轻量实现，且更符合"一切皆记忆"（每段上下文都是记忆注入，非独立 prompt 系统） |
| **判定** | ❌ **否决** |

### 建议 C："模型可见即已记录"上下文快照入账

| 项目 | 内容 |
|------|------|
| **Harness 参照** | 任何到达模型请求的内容必须能从日志重建，append-only 事件溯源 |
| **memora 现状** | round-summary（记忆）+ 原始对话（sessionStore）+ `trace_summary` 工具（[builtinToolHandlers.ts](../../src/agent/builtinToolHandlers.ts#L747) 经 `loadRawRoundMessages` 回溯）已构成完整证据链 |
| **雷区** | ⚠️ **哲学冲突**：架构哲学 §8"自然遗忘优于完美记忆"明确禁止"永不删除任何记忆——存储会爆炸"；Harness 全量入账（含系统提示、召回、每次注入）会引入 O(N×上下文) 存储膨胀，与 memora 轻量定位冲突 |
| **排雷结论** | **不采纳全量快照**。memora 已有关键链路（round-summary → 原始对话 → trace_summary 回溯）覆盖"模型说了什么 + 原始对话是什么"两大可追溯诉求；"模型看到了什么"（召回/系统提示）属于调试诉求，应由 **ITracer span** 承载（已有 [ITracer](../../src/agent/types.ts) 可观测性接口），而非写死进 sessionStore |
| **判定** | ❌ **否决**（全量快照）/ 上下文快照归属 ITracer，不新增存储层 |

### 建议 D：Turn/Step 双层循环

| 项目 | 内容 |
|------|------|
| **Harness 参照** | Turn（用户交互边界）与 Step（单次模型请求）双层 |
| **memora 现状** | 已有 `roundId`（一次 processUserInput = 一个 round，[agent.ts](../../src/agent/agent.ts#L549)）+ `maxIterations` / `maxReflectionRetries`（收敛参数，[loop.ts](../../src/agent/loop.ts#L181)） |
| **雷区** | ⚠️ **重复定义**：memora 的"round"已等价 Harness"Turn"，"iteration"已等价"Step"；术语重命名 + 收敛策略可插拔化，收益低 |
| **排雷结论** | **不采纳**。round 边界已存在（roundId 贯穿 trace_summary），收敛已由 maxIterations 参数化。引入 Turn/Step 是术语重复，破坏单一真理源 §2.1"Loop 是最小单元的重复" |
| **判定** | ❌ **否决** |

### 建议 E：子 Agent 委派工具

| 项目 | 内容 |
|------|------|
| **Harness 参照** | Spawn / Fork / workflow / Ralph 多 Agent 编排 |
| **memora 现状** | [agent.ts](../../src/agent/agent.ts#L83) 设计哲学明确"单 Agent，单配置，单记忆"；注释明示"内核不负责多 Agent 编排——那是宿主层的职责" |
| **雷区** | 🚫 **架构哲学硬冲突**：架构哲学 §10"单 Agent 模型"是核心约束；`forkSession()` 已提供会话分叉（共享记忆索引），子任务委派属于宿主层（如 sprite）职责 |
| **排雷结论** | **坚决否决**。delegate_task 工具会把宿主层职责拉入内核，破坏单 Agent 模型 + 零依赖边界 |
| **判定** | ❌ **否决（最高优先级否决）** |

### 建议 F：通用 inject API

| 项目 | 内容 |
|------|------|
| **Harness 参照** | `agent.inject(contextBlock, { ttl })` 运行时注入上下文 |
| **memora 现状** | `injectSystemMessage(content)` 已是公开的通用运行时注入 API（[loop.ts](../../src/agent/loop.ts#L1425)），被 configManager / sessionManager / agent 广泛调用；`affectPrefix` 只是它的一个带语义的特例 |
| **雷区** | ⚠️ **重复定义**：`agent.inject()` 泛化后与现有 `injectSystemMessage` + `cleanTemporarySystemMessages`（TTL 清理）完全重叠 |
| **排雷结论** | **不采纳新 API**。现有 `injectSystemMessage` 已是通用注入通道，affectPrefix 不必泛化 |
| **判定** | ❌ **否决** |

---

## 三、最终采纳结论

| 建议 | 原始方向 | 排雷判定 | 最终行动 |
|------|---------|---------|---------|
| A 工具流水线钩子 | 新建 ToolHook 抽象 | 重复定义 | ✅ **收敛**：扩展 `preExecutionCheck` 返回值为 `{ skip, overrideArgs?, denied? }`，补齐"执行前拦截/审批"缺口，不建新抽象 |
| B 系统提示词 section 化 | 建 section 注册表 | 分层冲突 + 重复 | ❌ **否决**（已有 system 注入机制等价实现） |
| C 上下文快照入账 | sessionStore 全量入账 | 哲学冲突 | ❌ **否决**（可追溯性已由 round-summary + trace_summary 覆盖；调试诉求走 ITracer） |
| D Turn/Step 双层 | 双层循环重构 | 重复定义 | ❌ **否决**（round/iteration 已是等价物） |
| E 子 Agent 委派 | 内核加 delegate 工具 | 哲学硬冲突 | ❌ **否决**（宿主层职责，单 Agent 模型） |
| F 通用 inject API | agent.inject() | 重复定义 | ❌ **否决**（injectSystemMessage 已是通用通道） |

**净采纳：1 条收敛项，5 条否决**。

---

## 四、排雷后的深层洞察

1. **memora 已用"参数化 + 接口注入"实现了 Harness"插件化"的绝大部分价值**。系统提示词注入、工具回调、会话分叉、ITracer 可观测性——每一条 Harness 需要独立插件机制的能力，memora 都有更轻的等价物。

2. **差异本质是设计哲学而非能力差距**：
   - Harness 是**平台**（插件系统承载一切可组合性）→ 适合独立运行、高度可配置的场景
   - memora 是**内核**（接口注入 + 单一真理源）→ 适合嵌入宿主、追求轻量与确定性的场景
   - 因此"从 Harness 汲取"的正确姿势是**抄思想（可插拔性、可追溯性），不抄机制（插件系统、事件溯源）**。

3. **唯一真实缺口**：工具执行前拦截/审批（audit / override args / deny）。这是建议 A 收敛后的落地点，其余 5 条均是重复造轮子。

---

## 五、后续落地（可选）

- [ ] 建议 A：`preExecutionCheck` 返回值扩展为 `{ skip, previousResult?, overrideArgs?, denied? }`，供宿主实现审批/审计/参数改写
- [ ] 若需"模型看到了什么"的可追溯，扩展 ITracer span 属性（attachedMemory / systemPromptHash），不入 sessionStore

> 落地前需遵循项目既有流程：方案更新 → 补测试 → 测试回归 → 提交前审查。
