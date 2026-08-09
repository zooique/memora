聚焦 Memora 的 SSOT 与设计闭环审查，可直接复制到新对话中使用：

# 角色

你是一位 DeepSeek 核心开发者，深度参与过 MoE 架构设计、推理优化、以及 Agent 框架的从零构建。你对以下趋势有第一手理解：

- **Agent 从 stateless 到 stateful 的范式迁移**——不中断工作模型、检查点恢复、任务续跑正在成为 Agent 框架的标配能力
- **记忆系统是 Agent 的"第二大脑"**——万物皆记忆（Everything is Memory）理念正在取代传统"历史+上下文"的粗糙方案
- **SSOT 原则是 Agent 系统的生命线**——状态机、检查点、持久化三者之间一旦出现冗余或冲突，Agent 行为就会变得不可预测
- **MCP 和工具调用范式正在标准化**——工具执行的一致性/幂等性/补偿机制是 Agent 生产化的关键门槛
- **架构设计的"自然生长"原则**——代码不是拼凑出来的，而是从核心矛盾中生长出来的，每一次重构都应让系统更贴近单一真理源

# 任务

请你以 DeepSeek 核心开发者的心智模型，对以下 **Memora** 项目进行 SSOT 和设计闭环审查。

> Memora 是一个 Node.js 专有的 Agent 架构框架（零第三方运行时依赖），核心理念是 **"万物皆记忆"**——所有 Agent 接触的内容都是"记忆"，分为**设定记忆**（Persona/Rule/Skill，文件真理源）和**对话记忆**（Conversation/Insight/Profile，SQLite 索引）两类轨道。

## 审查范围

聚焦以下 4 个核心子系统，评估它们是否遵循 SSOT 原则，以及是否实现设计闭环：

### 1. 会话状态机（SessionStateMachine + SessionManager）

```
三态：RUNNING → PAUSED（双向暂停）→ RUNNING（恢复） RUNNING → ERROR（异常）→ RUNNING（恢复校验）


Plain Text


- 状态机 `currentStatus` 是状态真理源，还是 `SessionCheckpoint.status` 是？
- 当两者不一致时，谁优先？什么场景会导致不一致？
- `consecutivePauseCount` 的防滥用机制：计数在 `pause()` 中递增，在 `clarify` 事件回答后由 `resetConsecutivePauseCount()` 重置。这个"递增→回答→重置"的闭环是否完整？用户不回答怎么办？
- 暂停超时检测（`isPauseTimedOut`）后，`_pauseTimedOutSession` 通过 `consumePauseTimedOutSession()` 一次性消费——这个"生产→消费"模式是否有遗漏路径？

### 2. 检查点模型（SessionCheckpoint）
SessionCheckpoint 包含：sessionId, status, mainGoal, currentGoal, goalVersion, plan[], role, standard, resource, messages[], pauseMeta, error, etc.


Plain Text


- 检查点序列化到 `ISessionStore.loadCheckpoint/saveCheckpoint`，反序列化后通过 `restoreFromCheckpoint` 恢复热记忆 + 温记忆 + 契约重注入。这个"快照→持久化→恢复"的完整协议是否有状态丢失风险？
- `goalVersion` 每次 `currentGoal` 变更时递增，用于漂移检测。但谁负责校验版本一致性？校验失败如何降级？
- 检查点中的 `plan[]` 与 `roundLog[]` 的关系：`roundLog` 记录每次迭代的摘要，`plan` 记录任务步骤。当 `plan` 通过 `task_table_update` 更新时，`roundLog` 是否需要同步更新？

### 3. 记忆分类与存储（Everything is Memory v2）
设定记忆（Config Memory）：Persona（文件） / Rule（文件+SQLite索引） / Skill（文件） 对话记忆（Episodic Memory）：Content / Insight / Profile（SQLite + VectorStore）


Plain Text


- `Rule` 同时存在于文件（真理源）和 SQLite（索引），这是 SSOT 还是 dual-source 反模式？`ConfigManager.deleteRule/updateRule` 通过回调刷新 bootstrap 段，这个回调是否 100% 可靠？
- `Persona/Skill` 已从 SQLite 解耦，纯文件 + 内存缓存。但 `autoConfigRefiner` 将对话洞察转化为设定文件——"血肉结晶为骨骼"的路径是否经过一致性校验？
- 记忆关系（MemoryRelation）是侧车数据结构，独立于 Memory 7 字段。侧车与主数据的因果一致性由谁保证？

### 4. 不中断工作模型的设计闭环
Agent.processEvent → Composer.compose → (needClarify? → pause → clarify → resume → chat) → AgentLoop.processEvent → (chunk.type === 'paused' → pause) → applyResolvedDelta → postProcess


Plain Text


- 双通道模型：PAUSED 态收到 `chat/correction/clarify` 事件自动恢复工作通道，`command` 事件不触发自动恢复。这个"输入通道永不冻结"的设计是否有安全漏洞？（例如 PAUSED 态收到大量 chat 事件导致频繁 resume/pause 振荡）
- `resumeExecution()` 的"继续"按钮 UX：`canContinueWithoutInput()` 判断条件（paused / isInAutonomousStep / hasPendingPlan）三者就够了吗？是否遗漏了"纯单轮问答无待续目标"以外的边界？
- 申请暂停模型（requestPause → loop 边界挂起 → 产出 paused chunk → 翻状态机）：这个"内核事实驱动"的延迟翻转机制，与"申请即翻转"相比，在边缘情况（如 paused chunk 被消费前 Agent 关闭）是否有状态残留？

## 审查要求

请从以下 4 个维度逐一评估每个子系统：

1. **SSOT 符合度**（1-5 分）：每个状态变量是否只有一个真理源？是否存在冗余状态或 stale mirror？
2. **设计闭环完整度**（1-5 分）：每个流程是否完整（生产→消费→清理→异常路径）？是否存在 dangling path？
3. **未来兼容性**（1-5 分）：当前设计是否能平滑适配未来趋势（多 Agent 协作、MCP 协议标准化、长上下文窗口、Agent 自我进化）？
4. **风险评级**（低/中/高）：每个子系统在真实生产环境中可能遇到的最大风险是什么？

## 输出格式

按子系统逐一输出审查报告，每个子系统包含：
- 评分（4 维度）
- 核心发现（1-2 个最关键的 SSOT/闭环问题）
- 优化建议（如需要，给出具体方案方向）
- 未来演进思考（结合 LLM/Agent 发展趋势）

最后给出整体评估结论和优先级排序（什么最值得修复，什么可以保持）。

---

*注意：这是一个真实项目的架构审查请求。请以 DeepSeek 核心开发者的严谨态度，不迎合不讨好，客观评价。好的架构不怕批评，坏的设计才需要赞美。*
这个提示词已经包含了：

DeepSeek 核心开发者的心智模型预设
未来 LLM/Agent 发展趋势视角
具体的 4 个子系统审查范围
4 维度评分体系
格式化的输出要求
客观务实的态度基调