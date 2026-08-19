# Memora 内核 Agent 独立评审（第三方视角）

> 视角：以另一个 agent harness 团队的外部视角，客观评审 memora 的内核 agent 设计思维与代码质量。
> 日期：2026-08-19
> 方法：全文阅读 [agent-design-philosophy.md](architecture/agent-design-philosophy.md)、[types.ts](../src/agent/types.ts)、[loop.ts](../src/agent/loop.ts)、[agent.ts](../src/agent/agent.ts)、[harness-borrowing-assessment.md](harness/harness-borrowing-assessment.md) 后独立给出的判断；所有结论附真实性核查证据。

---

## 第一部分：真实性核查

本评审的每个关键论断均已对照代码/文档核实，修正误差如下：

| 断言（原表述） | 核查证据 | 判定 |
|---------------|---------|------|
| loop.ts 为"1400+ 行" | 实际 **2293 行** | 修正 |
| "约十几个 setXxx" | **11 个 L2 策略 setter** + 6 个基础设施 = **17 个 set/refresh 方法** | 修正 |
| agent.ts 门面"25+ 组件" | **20 个组件/manager 字段**（含 14 个 manager） | 修正 |
| 闭环公理 / 三阶段 / 触发源决定召回 | 设计 [agent-design-philosophy.md §2.1](architecture/agent-design-philosophy.md)；实现 [loop.ts](file:///f:/zooique/memora/src/agent/loop.ts#L511-L515) | 属实 |
| 记忆一等公民 / L0-L4 治理 / 双通道召回 | [memoryGovernance.ts](../src/agent/managers/memoryGovernance.ts) / [recall.ts](../src/memory/recall.ts) | 属实 |
| InsightExtractor 已移除 / round-summary 单轨 | [types.ts](../src/agent/types.ts#L204-L208) 已注明 | 属实 |
| 可观测 span（systemPromptHash / attachedMemoryFingerprint） | [loop.ts](../src/agent/loop.ts#L1396-L1402, L2230-L2234) | 属实 |
| 魔数 tokenBudget=8000 / stepBudget=50 / retry=2 / thr=3 | [loop.ts](../src/agent/loop.ts#L321, L329, L402, L409) | 属实 |
| determineTaskType 硬编码启发式 | [loop.ts](../src/agent/loop.ts#L1308-L1322)（>500 字符→reasoning、检代码块→code） | 属实 |
| "单一检查点"名实出入 | [loop.ts](../src/agent/loop.ts#L1679-L1717)：toolReadonly → toolApproval → preExecutionCheck 顺序过滤 | 属实 |
| harness-borrowing-assessment 结论（净采纳 1 / 否决 5） | 已读原文 | 属实 |

---

## 第二部分：一句话总评

**memora 是"设计思维"远强于"工程形态"的项目——思想模型处于行业顶级，但实现已悄悄长到与"最小单元"哲学互相矛盾的规模。** 问题不在"代码写得差"，而在**思想极简与实现膨胀之间的张力**。

---

## 第三部分：内核设计思维——真正好的部分

### 1. "单轮闭环"公理是本质回答，不是噱头

多数 harness（含本文视角所在团队）把 Agent 定义成"工具调用循环 + 提示词拼接"。memora 把一切收敛到"一次触发、一次回答、三阶段闭环"这一个最小单元，并**真的用它推导出** Loop、目标模式、子 Agent、角色包——是一次完整的演绎，而非架构巧合。

尤其见 **"触发源决定召回"**：外部输入触发 recall、Loop 自循环不触发。多数框架会用 `isLoopMode` flag 打补丁；memora 回到"闭环知道自己被谁拉起"这个本质维度，干净地消灭了一个模式分支，是单一真理源思维最漂亮的落地。

### 2. 记忆是一等公民，而非日志投影

记忆治理（L0-L4）、双通道召回、去重、衰减、跨会话、round-summary 单轨。多数 harness 把记忆当"历史数组"倒进上下文；memora 把"记忆怎么沉淀、召回、衰减"当成内核核心矛盾设计。"记忆即摘要"的效率挪移（预提炼 → 按需聚合）是一次漂亮的取舍，且文档诚实标注了代价（跨会话完整画像退化）。

### 3. 可追溯性是真实落地的

`isTraceable`、`roundId` 贯穿、`trace_summary` 回溯链路、ITracer span 上的 `systemPromptHash` / `attachedMemoryFingerprint`，把"模型看到了什么"真正做成可观测性，而非停留在 append-only 理想。

---

## 第四部分：内核设计思维——必须警惕的张力

### 4.1 最大问题："复杂度向外生长"没有兑现

文档第 14 章号称"远期锚点/设计空间全景"，但实现早已把这张全景表**物化成了接口**：`toolStepLimit / toolApproval / toolReadonly / providerRouting / inputInterrupt / tokenBudget / stepBudget / multiStepReasoning / errorHandling` 等 **11 个 L2 策略 setter** + 对应实例字段；`agent.ts` 门面持有 **20 个组件/manager**。

"核心保持简单"在这里是声明，不是事实。"想全行为维度"的现实把"最小单元"压垮了——这是所有 agent 框架的通病，但值得点明：**memora 的最高风险不是某段代码，而是把设计空间全景提前物化成接口导致的膨胀。**

### 4.2 具体架构债：策略枚举被拆成离散 setter，而非单个策略对象

memora 主张"策略是枚举，角色只选择不定义"（SSOT），正确落点应是一个 `L2Strategy` 单一配置对象，loop 构造时注入；而非 11 个散落 setter + 对应 `private` 字段。每个 setter 都是新的"表面"，状态来源要读者跨两个文件拼。**这恰是它自己批判的"场景特化补丁"——只不过打桩了。** 建议收敛为配置对象 + 不变式。

### 4.3 "单一检查点"名实略有出入

文档强调只有一个统一检查点（§7.2.1），但实现是 `executeOneTool` 内顺序执行多道闸门（toolReadonly → toolApproval → preExecutionCheck）。守卫职责确收敛一处，但"单一检查点"的说法夸大了——直白讲是"单点聚合的多重顺序过滤"。

---

## 第五部分：代码质量

### 5.1 强项（loop.ts 为示范级）

- **注释写"为什么"而非"是什么"**：如 `reflectionCountThisTurn` 解释"为何不用 `messages.filter().length`（截断致计数失真）"。
- **状态可推断性自觉**：不用从 messages 反推状态，显式字段 + 不变量守卫。
- **中断/超时极其严谨**：`AbortSignal.any` 防监听器泄漏、`raceToolWithSignal` 解决"无法中断卡住工具"、`.finally` 清理 abort 监听器、循环后复检 `signal.aborted`。
- **并发保持顺序**：独立 tool_call 并发执行但 message/yield 按原序回填，保证 Reflection `slice(-N)` 语义正确。
- **错误分级**：`[ERR:TOOL:code]` 结构化回传 LLM + 可重试/不可重试码分类 + Reflection 自愈，符合"不掩盖、回传、让模型自愈"。

### 5.2 弱点

- **文件体积失控**：`agent.ts` 约 133KB、`loop.ts` 2293 行、单类 20+ 实例字段、17 个 set/refresh 方法，有"上帝门面/上帝循环"倾向。方法级注释溢出为"commit message + 设计记录"，维护成本高。
- **`determineTaskType` 硬编码启发式**：`>500 字符 → reasoning`、检代码块 → code，被用于 Provider 路由（影响成本），启发式过脆。
- **魔数分散**：`tokenBudget=8000`、`stepBudget=50`、`retry=2`、`duplicateThreshold=3` 分散各处，未统一进策略/常量对象。
- **文档与代码强耦合**：正文混入大量 `2026-08-xx` 落地状态与代码行链接，横切了"设计文档"与"变更记录"两种形态；新读者需考古"哪些定案 / 历史 / 草案"。属团队文化，仅作外部观察。

---

## 第六部分：互相借鉴

与 [harness-borrowing-assessment.md](harness/harness-borrowing-assessment.md) 的既有结论（净采纳 1 / 否决 5）一致，此处给出独立增量视角。

### 6.1 memora 可借鉴 harness 家族的

| 可借鉴点 | 具体做法 |
|---------|---------|
| 可追溯性不变量（已采纳） | "模型可见即已记录"继续由 ITracer span 承载，保持不写入 sessionStore。 |
| **单一策略对象**（最值得采纳） | 把 L2 行为维度收敛为一个 `Strategy` 配置块，对齐其自身 SSOT 主张，替换 11 个离散 setter。 |

### 6.2 harness 家族值得借鉴 memora 的

1. **记忆一等公民的完整治理栈**——召回去重、衰减、双通道、跨会话、round-summary 单轨；多数 harness 缺且最难补。
2. **角色包 / 行为策略枚举的"可安全传播"**——角色用枚举选行为而非写代码，下载即用不引入任意逻辑。
3. **插卡式（Role Pack）+ 触发词粘性匹配**——首配锁定 + 互斥自动切换，解决"角色频繁切换体验不稳"的实际痛点。

---

## 第七部分：结语

**论"Agent 内核设计思维"，memora 比多数 harness 家族更接近本质；论"工程收敛"，其思想优雅程度已超过实现形态的节制程度。** 最大挑战不是写好某个函数，而是敢于做减法——承认第 14 章的"全景枚举"是设计空间而非必装接口，砍掉零真实消费的策略维度，把"20 个组件的门面 + 11 个策略 setter"收敛到"一个策略对象 + 一组真正的核心接口"。若一个以"最小单元"为哲学的内核仍需维护 133KB 门面，那哲学就该反过来审视实现，而非让实现用注释去合理化膨胀。