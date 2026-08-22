# Memora 模块清单与生长路线图

> 本文档记录 memora 内核所有模块的当前状态、测试覆盖度、质量评级与打磨优先级。
>
> 与普通按目录罗列的模块清单不同：本文档以 **「单轮执行闭环 = 种子」** 为编排锚点，按**自然生长顺序**组织全部模块——从最小单元出发，沿着「支撑 → 回答前 → 回答中 → 回答后 → 外循环 → 地基」的生长链逐层向外，让开发者顺着「种子怎么长出枝干」的脉络理解项目为什么长成今天这样。
>
> **最近更新**：2026-08-20
> **设计哲学**：万物皆记忆 · 最小执行闭环 · 单一真理源
> **设计真理源**：[agent-design-philosophy.md](./agent-design-philosophy.md)（种子推导）· [memory-as-summary.md](./memory-as-summary.md)（记忆生长）· [loop-design.md](./loop-design.md)（Loop 生长）· [role-pack-spec.md](./role-pack-spec.md)（角色包生长）

---

## 状态图例

| 状态 | 说明 |
|------|------|
| 🟢 已打磨 | 核心逻辑有测试覆盖，代码结构稳定 |
| 🟡 部分打磨 | 有测试但覆盖不足，或有未验证的边界场景 |
| 🔴 待打磨 | 无测试覆盖，或涉及复杂逻辑需验证 |
| ⚪ 工具/接口 | 纯函数/接口定义，风险低 |

---

## 生长全景图

**核心公理**：单轮执行闭环（一次触发、一次回答、三阶段）是 Agent 的最小完整单元——自足、可重复、可观察。一切复杂功能都是它三阶段（回答前/中/后）的自然生长，**没有第二套引擎**。

```
                         ┌──────────────────────────────────────────┐
                         │   L0 种子 · 单轮执行闭环                   │
                         │   一次触发 → 回答前 → 回答中 → 回答后      │
                         │   （loop.ts 执行 + agent.ts 编排门面）     │
                         └────────────────────┬─────────────────────┘
                                              │ 闭环要稳定运行 → 长出支撑骨架
                                              ▼
                         ┌──────────────────────────────────────────┐
                         │   L1 支撑骨架 · 状态 / 上下文 / 消息 / 装配 │
                         │   状态机·上下文窗口·微压缩·装配·可观察      │
                         └────────────────────┬─────────────────────┘
                                              │ 闭环内部三阶段各自精雕生长
                 ┌────────────────────────────┼────────────────────────────┐
                 ▼                            ▼                            ▼
        ┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
        │  L2 认知·回答前   │        │  L3 行动·回答中   │        │  L4 沉淀·回答后   │
        │  理解→角色→技能   │        │  LLM 生成 + 工具  │        │  摘要→记忆系统诞生 │
        │  →召回→装配       │        │  执行             │        │  →会话级沉淀       │
        └────────┬─────────┘        └────────┬─────────┘        └────────┬─────────┘
                 │                            │                           │
                 └──────────────┬─────────────┴─────────────┬─────────────┘
                                │  回答后 Handoff 选择"继续" → 长出外循环
                                ▼
                        ┌──────────────────────────────────────────┐
                        │   L5 外循环 · Loop 与会话延续              │
                        │   闭环的重复 · 检查点恢复 · 会话生命周期    │
                        └────────────────────┬─────────────────────┘
                                             │ 所有生长层共享的地基
                                             ▼
                        ┌──────────────────────────────────────────┐
                        │   L6 通用地基 · 配置 / 工具库 / 安全 / 日志 │
                        └──────────────────────────────────────────┘
```

**生长链与依赖关系（一句话版）**：

| 层 | 名称 | 生长来源 | 被谁消费 |
|----|------|---------|---------|
| L0 | 种子 · 执行闭环 | 最小单元（公理） | 所有层 |
| L1 | 支撑骨架 | 让闭环稳定运行 | L0 运行期 |
| L2 | 认知 · 回答前 | 闭环 Prepare 阶段精雕 | 生成回答的认知基础 |
| L3 | 行动 · 回答中 | 闭环 Act 阶段精雕 | 执行多步行动 |
| L4 | 沉淀 · 回答后 | 闭环 Reflect 阶段精雕 | 记忆写入 → 下次 L2 召回 |
| L5 | 外循环 · 会话延续 | 闭环的重复（Handoff=continue） | 多轮任务/会话切换 |
| L6 | 通用地基 | 所有层复用的公共设施 | 全部上层 |

> **阅读顺序**：先读 L0（种子）理解最小单元，再沿「L1 → L2 → L3 → L4」看三阶段如何从种子长满，接着看 L5 如何让闭环重复生长，最后落到 L6 地基。记忆系统的位置是理解全貌的关键——它在 **L4 诞生**（回答后沉淀出摘要），在 **L2 被消费**（下一次回答前召回），这正是「闭环 → 沉淀 → 再召回」的生长闭环。

---

## 〇、种子：单轮执行闭环（L0 · 最小单元）

> **为什么这是种子**：单轮执行闭环满足自足（一次触发一次回答）、可重复（可反复调用且独立）、可观察（执行可见可测）三条件，是 Agent 的最小完整单元。Loop、记忆、召回、角色包、技能——全部是它三阶段（回答前/中/后）的自然生长，而非独立系统。**本层是唯一的"立论"，其余各层都是它的"生长"。**

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `agent/seed/`（聚合目录） | 🟢 已打磨 | `seed/__tests__/`（prepare/orchestrator/difficulty + harness，39 tests） | 种子三阶段（回答前/中/后）+ Handoff 由 `seed/orchestrator.ts` 唯一编排（prepare/act/reflect/handoff 三阶段执行器并入 orchestrator）；`seed/difficulty.ts` 回答前 LLM 难度分级（阶段 2） |
| `agent/loop.ts` | 🟢 已打磨 | `__tests__/loop.test.ts` (76 tests) | AgentLoop 核心：单轮闭环执行 + Loop 外循环编排，含拦截器集成 |
| `agent/agent.ts` | 🟢 已打磨 | `__tests__/agent.test.ts` | Agent 主入口/门面：生命周期 + 锁/状态守卫 + 委托 seed 运行闭环（宿主 getter 契约字段独立，纯内部组件聚合于 `internals`） |

> **生长说明**：`seed/` 是"种子"的**代码名分**（2026-08-20 收敛）——原三阶段串联逻辑沉落在 `agent.ts` 4 个私有方法（prepareChatContext/executeChatLoop/postProcess/doPostProcess），现收进 seed 并交 `orchestrator` 唯一编排；orchestrator 提供三个显式命名入口（`runChat`/`runEvent`/`runResume`，对应对话/事件/续跑三种 Trigger），门面只做一行委托 + 生命周期守卫。**阶段 2 生长**：`seed/difficulty.ts` 在回答前判简单/复杂，复杂且收敛的主任务闭环后再跑一次 `loop.runReport()` 汇报闭环，其产出作为 round-summary 单源（`reflect.runReported`）——「汇总即记忆」。**阶段 3 生长**：orchestrator 外循环驱动器（`externalTaskLoop`）——复杂任务拆成「规划闭环 → 每步独立闭环（独立 roundId 供消息溯源/互斥排除，不单产摘要）→ 收敛后汇报」，步数上限经角色包 `global.taskLoopLimit` 配置；摘要恒「外部输入 ↔ round-summary 1:1」，仅收尾汇报产出唯一摘要（见 memory-as-summary §2.5）。`loop.ts` 是「单轮闭环」与「循环编排」的**合体**——哲学要求 Loop 的每一轮都是一次完整闭环，Loop 只是在 Handoff 处选择"继续"（详见 [loop-design.md](./loop-design.md)）。`agent.ts` 是门面（编排 + 生命周期 + 守卫），输入增强/检查点恢复等横向切面已下沉到 L2/L5 专职模块（[agent-facade-convergence.md](./agent-facade-convergence.md)）。seed 依赖方向：`agent/seed/* → agent/loop`（消费引擎）、`agent.ts → agent/seed`（委托），不新建顶层模块（见 [backend_layers_rules.md](../../.trae/rules/backend_layers_rules.md)）。

---

## 一、支撑骨架：让闭环稳定运行（L1）

> **生长来源**：闭环要稳定运行，必须回答"现在处于什么状态、上下文还剩多少、异常如何恢复"。这一层是闭环运行的**骨架**——不产生新能力，但保证闭环在任何情况下都能自洽运转。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `agent/sessionStateMachine.ts` | 🟢 已打磨 | `__tests__/sessionStateMachine.test.ts` (42 tests) | 三态流转（RUNNING/PAUSED/ERROR）、非法转换防护、ERROR 恢复双重校验、pending 暂停请求管理 |
| `agent/contextManager.ts` | 🟢 已打磨 | `__tests__/contextManager.test.ts` | Token 估算、上下文窗口管理、截断（优先复用已存 round-summary） |
| `agent/compaction.ts` | 🟢 已打磨 | `__tests__/compaction.test.ts` (15 tests) | 微压缩层：ResultReplacement + OffloadCompaction（资源边界） |
| `agent/messageHistory.ts` | 🟢 已打磨 | `__tests__/messageHistory.test.ts` | 消息历史管理 |
| `agent/composer.ts` | 🟢 已打磨 | `__tests__/composer.test.ts` | 上下文组装 |
| `agent/assembler.ts` | 🟢 已打磨 | `__tests__/assembler.test.ts` | 组件装配（AgentHooks + 接线回调 + sessionManager + ContextPreparer + CheckpointRestoreCoordinator 分阶段组装） |
| `agent/tracer.ts` | 🟢 已打磨 | `__tests__/tracer.test.ts` + `__tests__/metrics.test.ts` | 可观测性追踪（闭环可观察属性的载体）+ AgentMetrics 运行时指标（AgentLoop/Agent.getMetrics：LLM 调用 / 记忆召回命中率 / 工具调用 / 上下文管理 / 衰减） |
| `agent/constants.ts` | 🟢 已打磨 | `__tests__/constants.test.ts` | 常量定义 |
| `agent/types.ts` | 🟢 已打磨 | 间接测试 | 36 个导出类型定义 |

> **生长说明**：状态机是"闭环运行的骨架"（哲学第九章），上下文/微压缩是"资源边界"（哲学第十一章），消息/装配/可观察是闭环自足的物理承载。这一层与 L0 共同构成「最小单元能跑起来」的地基。

---

## 二、认知生长 · 回答前（Prepare · L2）

> **生长来源**：闭环回答前（Prepare）承担"理解触发、装配上下文"的认知职责。它把一次原始触发转化为可执行上下文，分三步：**理解输入 → 召回相关 → 装配上下文**。本层即这三步在代码中的自然生长。

### 2.1 输入增强管线

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `agent/contextPreparer.ts` | 🟢 已打磨 | 间接测试（agent.test.ts） | 输入增强管线：角色自动匹配（粘性+LLM 兜底）/ 记忆召回+固定轮次注入 / 技能当轮注入（「触发源决定召回」哲学的实体） |

> **生长说明**：`contextPreparer` 是回答前的**统一入口管线**（[agent-facade-convergence.md](./agent-facade-convergence.md) Step 2），其内部依次消费下面的角色包（视角框架）、技能（能力清单）与记忆召回（知识内容）。

### 2.2 角色包（role-pack/ · 视角框架）

> **生长来源**：装配上下文时先确定"用什么角色看问题"——角色包匹配在回答前**先于**记忆/摘要召回执行。角色包 = 插卡式 Agent（L1 内容 + L2 策略 + 远期 L3 代码），是"换装 = 换 Agent"的生长点（[role-pack-spec.md](./role-pack-spec.md)）。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `role-pack/types.ts` | 🟢 已打磨 | `__tests__/types.test.ts` | 36 个导出类型，行为策略全量定义 |
| `role-pack/rolePackManager.ts` | 🟢 已打磨 | `__tests__/rolePackManager.test.ts` | 角色包文件夹形态加载与装配 |
| `role-pack/validator.ts` | 🟢 已打磨 | `__tests__/validator.test.ts` | manifest.json 核心控制校验 + companion 内容红线检测（`checkCompanionContentRedline`） |
| `role-pack/capabilityMap.ts` | 🟢 已打磨 | `__tests__/capabilityMap.test.ts` | 能力声明映射与检查 |
| `role-pack/strategyResolver.ts` | 🟢 已打磨 | `__tests__/strategyResolver.test.ts` (84 tests) | 默认值完整性、22 个 resolve 函数、mergeStrategy、assembleRolePack 装配逻辑 |
| `role-pack/strategyKeys.ts` | 🟢 已打磨 | `__tests__/strategyKeys.test.ts` (48 tests) | 6 个校验辅助函数 + 别名映射 + 4 阶段 25+ 策略键规则完整性验证 |

### 2.3 技能（skill/ · 能力清单）

> **生长来源**：技能是回答前按输入匹配激活的"能力单元"，两级同构（全局技能池 + 角色包技能），三级渐进披露（L1 元数据常驻 / L2 read_skill 按需读正文 / L3 资源脚本）（[role-pack-skills-progressive-disclosure.md](./role-pack-skills-progressive-disclosure.md)）。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `skill/skillManager.ts` | 🟢 已打磨 | `__tests__/skillManager.test.ts` | 技能加载、匹配、执行调度 |
| `skill/skillScriptRunner.ts` | 🟢 已打磨 | `__tests__/skillScriptRunner.test.ts` (19 tests) | formatScriptResult 三分支 + runSkillScript 跨平台子进程执行（Node/Shell）+ 超时/环境变量隔离/返回结构 |
| `skill/types.ts` | ⚪ 工具 | 无独立测试 | 技能类型定义 |

### 2.4 记忆召回（知识内容 · 消费 L4 记忆系统）

> **生长闭环**：回答前的记忆召回（`recall()` 语义 + 关键词双通道、同会话窗口优先、互斥排除正文已加载轮次、minFallback 保底）由 `contextPreparer` 在外部输入触发时调用。**其物理实现位于 L4 记忆系统**（recall.ts / hybridMerge.ts / vectorStore.ts / reranker.ts，见 §四 4.2）——这是「闭环 → 回答后沉淀记忆 → 下次回答前召回」的生长闭环：记忆在 L4 诞生，在 L2 被消费。
>
> 召回相关设计详见 [memory-as-summary.md](./memory-as-summary.md) 与 [recall-mutex-pre-filter.md](./recall-mutex-pre-filter.md)。

---

## 三、行动生长 · 回答中（Act · L3）

> **生长来源**：闭环回答中（Act）承担"生成与执行"。它由两个能力构成：**生成**（LLM 调用）与**工具**（扩展行动能力）。工具调用是回答中的**内循环**——生成 → 判断 → 调用 → 回填 → 再生成，让单轮闭环具备多步行动能力。

### 3.1 LLM 生成（llm/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `llm/provider.ts` | 🟢 已打磨 | `__tests__/provider.test.ts` | Provider 抽象基类 |
| `llm/openaiCompatible.ts` | 🟢 已打磨 | `__tests__/openaiCompatible.test.ts` | OpenAI 兼容实现 |
| `llm/factory.ts` | 🟢 已打磨 | `__tests__/factory.test.ts` | Provider 工厂 |
| `llm/embedding.ts` | 🟢 已打磨 | `__tests__/embedding.test.ts` | 嵌入服务 |
| `llm/abortSignal.ts` | 🟢 已打磨 | `__tests__/abortSignal.test.ts` | 中止信号 |
| `llm/types.ts` | ⚪ 工具 | 无独立测试 | LLM 类型定义 |
| `llm/__tests__/llmIntegration.test.ts` | 🟢 已打磨 | 集成测试 | LLM 集成测试 |

### 3.2 工具执行（agent/ 工具）

> **生长来源**：工具是回答中「从思考到行动」的载体。所有工具调用经统一执行入口（ToolExecutor），入口前有执行前检查（只读 → 审批 → preExecutionCheck 三重顺序闸门）。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `agent/toolExecutor.ts` | 🟢 已打磨 | `__tests__/toolExecutor.test.ts` | 工具执行器（统一入口 + 外部文本净化） |
| `agent/builtinTools.ts` | 🟢 已打磨 | `__tests__/builtinTools.test.ts` | 内置工具定义 |
| `agent/builtinToolHandlers.ts` | 🟢 已打磨 | `__tests__/builtinToolHandlers.test.ts` | 内置工具处理器（含 traceSummary 溯源） |
| `agent/duplicateInterceptor.ts` | 🟢 已打磨 | `__tests__/duplicateInterceptor.test.ts` (22 tests) | 重复 tool_call 检测拦截器 |

### 3.3 任务表渲染

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `agent/taskTableRenderer.ts` | 🟢 已打磨 | `__tests__/taskTableRenderer.test.ts` (22 tests) | 任务进度渲染/状态标签映射/回合日志追加/描述截断/防误执行标记 |

### 3.4 网络搜索（web-search/ · 具体工具）

> **生长来源**：网络搜索是回答中工具能力的一个**具体实现**——经 `IWebSearchProvider` 接口由宿主注入，条件性暴露给 LLM（[mvp-scope.md](./mvp-scope.md) §四）。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `web-search/fetchWebSearchProvider.ts` | 🟢 已打磨 | `__tests__/fetchWebSearchProvider.test.ts` | DuckDuckGo 搜索实现 |
| `web-search/webSearchProvider.ts` | 🟢 已打磨 | `__tests__/webSearchProvider.test.ts` | 搜索包装 |
| `web-search/types.ts` | ⚪ 接口 | 无独立测试 | 搜索类型定义 |

### 3.5 网页抓取 + 代码执行（web-fetch/ · code-exec/ · 外部世界工具族）

> **生长来源**：与 web-search 同属「连接外部世界」工具族（[tool-surface-roadmap.md](./tool-surface-roadmap.md)）——经 `IFetchProvider` / `ICodeExecutionProvider` 接口宿主注入、条件性暴露；web_fetch 与 web_search 成对构成「搜索→抓取」闭环，run_code 提供通用计算/验证底座。内核零运行时依赖（沙箱由宿主 provider 决定）。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `web-fetch/types.ts` | ⚪ 接口 | 无独立测试 | 抓取类型定义（FetchedPage/FetchOptions/IFetchProvider） |
| `web-fetch/fetchWebFetchProvider.ts` | 🟢 已打磨 | `__tests__/fetchWebFetchProvider.test.ts` | 内置 fetch + 正则清洗 HTML 的零依赖默认实现 |
| `web-fetch/webFetchProvider.ts` | 🟢 已打磨 | `__tests__/webFetchProvider.test.ts` | safeFetch 超时保护包装 |
| `code-exec/types.ts` | ⚪ 接口 | 无独立测试 | 执行类型定义（CodeExecutionResult/ICodeExecutionProvider） |
| `code-exec/codeExecutionProvider.ts` | 🟢 已打磨 | `__tests__/codeExecutionProvider.test.ts` | safeExecuteCode 超时保护包装 |

> 集成侧：两模块工具定义（`WEB_FETCH_TOOL` / `RUN_CODE_TOOL`）登记在 `agent/builtinTools.ts`，条件暴露/执行分支在 `agent/toolExecutor.ts`（含 7 组注入/执行/冲突测试），接口注入链经 `agent/types.ts` → `agent/assembler.ts` → `agent/agent.ts` → `index.ts` 导出打通。

---

## 四、沉淀生长 · 回答后（Reflect · L4）—— 记忆系统的诞生

> **生长来源**：闭环回答后（Reflect）承担"提炼沉淀与衔接决策"。**记忆系统正是在这里诞生**——每轮闭环完成后，后台异步生成轮次摘要（round-summary），它就是唯一记忆单元（摘要即记忆）。本层是「万物皆记忆」的生长点，也是 L2 回答前召回的知识来源。

### 4.1 摘要生成（唯一记忆单元）

> **核心公理**：摘要就是记忆本体（[memory-as-summary.md](./memory-as-summary.md)）。`round-summary` 是唯一记忆单元，带 `summaryType` 语义标签 + `roundId/sessionId` 溯源；`superseded` 写时取代做冲突消解。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `managers/roundSummaryGenerator.ts` | 🟢 已打磨 | `__tests__/roundSummaryGenerator.test.ts` | 轮次摘要生成（含 superseded 写时取代检测、summaryFocus 提炼视角注入） |
| `managers/streamAccumulator.ts` | 🟢 已打磨 | `__tests__/streamAccumulator.test.ts` (15 tests) | chunk.content 拼接/空内容跳过/异常传播/options 透传 |
| `managers/llmJudgeHelper.ts` | 🟢 已打磨 | `__tests__/llmJudgeHelper.test.ts` (18 tests) | 三件套模式：流式累积 → parseLlmJson → configError 抛错 |

### 4.2 记忆底座（memory/ · 存储与召回）

> **生长说明**：记忆存储由宿主实现 `IMemoryStorage` 注入，内核通过接口读写。`recall.ts`/`hybridMerge.ts`/`vectorStore.ts`/`reranker.ts` 在 L2 回答前被召回消费（见 §二 2.4）。`sessionStore.ts`（会话记录底座）另见 §五 L5。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `memory/recall.ts` | 🟢 已打磨 | `__tests__/recall.test.ts` | 召回核心逻辑（双通道 + 互斥前置过滤 + minFallback 保底） |
| `memory/hybridMerge.ts` | 🟢 已打磨 | `__tests__/hybridMerge.test.ts` | 混合检索（向量 0.6 + score 0.4） |
| `memory/vectorStore.ts` | 🟢 已打磨 | `__tests__/vectorStore.test.ts` | 向量存储 |
| `memory/reranker.ts` | ⚪ 接口 | `__tests__/reranker.test.ts` (3 tests) | 重排序接口（IReranker，仅类型；默认实现已剪枝移除） |
| `memory/types.ts` | 🟢 已打磨 | `__tests__/types.test.ts` | 记忆类型定义 |
| `memory/governance.ts` | 🟢 已打磨 | `__tests__/governance.test.ts` | 分数衰减、clamp 边界 |
| `memory/inMemoryStorage.ts` | 🟢 已打磨 | `__tests__/inMemoryStorage.test.ts` | 内存存储实现 |
| `memory/storageInterface.ts` | ⚪ 接口 | 无独立测试 | IMemoryStorage 接口定义 |
| `memory/lockManager.ts` | 🟢 已打磨 | `__tests__/lockManager.test.ts` | 锁文件管理 |
| `memory/sourceValidation.ts` | 🟢 已打磨 | `__tests__/sourceValidation.test.ts` | Source 校验 |
| `memory/sourcePaths.ts` | 🟢 已打磨 | `__tests__/sourcePaths.test.ts` | Source → 路径映射 SSOT |
| `memory/projectManager.ts` | 🟢 已打磨 | `__tests__/projectManager.test.ts` | 项目管理 |
| `memory/projectRegistry.ts` | 🟢 已打磨 | `__tests__/projectRegistry.test.ts` | 项目注册表 |

> **2026-08-19 深度剪枝**：`memory/store.ts`（FileStore）、`memory/loader.ts`（MemoryLoader）随「设定记忆归角色包（ADR-025）」整链移除——设定记忆不再由文件扫描进记忆索引，FileStore 无生产消费者；`memory/multiHop.ts`（多跳推理）为内核零消费的僵尸公共 API，随剪枝移除。

### 4.3 记忆治理（managers/ · 记忆维护）

> **生长来源**：记忆系统长期运行会产生"记忆腐烂"（重复/覆盖/过时）。治理层是回答后沉淀的**维护侧**——去重、衰减、冲突检测、快照诊断，保证记忆自然沉底、不污染召回面。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `managers/memoryGovernance.ts` | 🟢 已打磨 | `__tests__/memoryGovernance.test.ts` | 记忆治理统一门面 |
| `managers/dedupManager.ts` | 🟢 已打磨 | `__tests__/dedupManager.test.ts` | L1 语义去重 |
| `managers/memoryDecayScheduler.ts` | 🟢 已打磨 | `__tests__/memoryDecayScheduler.test.ts` | L2 时效性评估 |
| `managers/memoryAdvisor.ts` | 🟢 已打磨 | `__tests__/memoryAdvisor.test.ts` | L3 冲突检测 |
| `managers/memoryInspector.ts` | 🟢 已打磨 | `__tests__/memoryInspector.test.ts` | 记忆快照/诊断 |
| `managers/goalConsistencyChecker.ts` | 🟢 已打磨 | `__tests__/goalConsistencyChecker.test.ts` (51 tests) | 约束提取/文本相似度（bigram+Jaccard）/漂移三级判定/约束一致性检查 |
| `managers/chatLockManager.ts` | 🟢 已打磨 | `__tests__/chatLockManager.test.ts` | 聊天锁管理 |
| `managers/workProjection.ts` | 🟢 已打磨 | `__tests__/workProjection.test.ts` | 作品投影管理 |
| `managers/textPolishManager.ts` | 🟢 已打磨 | `__tests__/textPolishManager.test.ts` | 文本润色 |

### 4.4 会话级沉淀（managers/ · 会话归档与命名）

> **生长来源**：回答后的沉淀不止轮次摘要——它还长出**会话级**产物：会话归档（content 会话级摘要）、会话标题（首轮闭环自动命名）。粒度（会话级）与 round-summary（轮次级）不同，同属摘要模型（[memory-as-summary.md](./memory-as-summary.md) §2.2；[ADR-024](../../.trae/decisions/ADR-024-session-title-layer.md)）。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `managers/sessionArchiver.ts` | 🟢 已打磨 | `__tests__/sessionArchiver.test.ts` | 会话归档：生成/更新 SessionMeta（summary/keyTopics） |
| `managers/archiveCoordinator.ts` | 🟢 已打磨 | `__tests__/archiveCoordinator.test.ts` | 归档协调器：归档模式判断、事件发射 |
| `managers/sessionNamer.ts` | 🟢 已打磨 | `__tests__/sessionNamer.test.ts` | 会话自动命名：LLM 生成 autoName，支持 displayName 覆盖 |

---

## 五、外循环生长 · Loop 与会话延续（L5）

> **生长来源**：闭环回答后的 Handoff 选择"继续"，就长出 Loop——**Loop = 闭环的重复**（哲学第三章），循环编排本身在 L0 `loop.ts` 内。本层是让闭环能跨轮延续、跨会话切换的配套模块：检查点恢复（断点续跑）、会话生命周期管理、会话记录底座。

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `agent/checkpointRestoreCoordinator.ts` | 🟢 已打磨 | 间接测试（agent.test.ts） | 检查点恢复协议：温记忆召回 / 契约重注入 / restore 编排 / 任务表预判 |
| `managers/sessionManager.ts` | 🟢 已打磨 | `__tests__/sessionManager.test.ts` (98 tests) | 会话生命周期管理：切换、分叉、恢复、消息加载 + 检查点生命周期 |
| `memory/sessionStore.ts` | 🟢 已打磨 | `__tests__/sessionStore.test.ts` (22 tests) + `agent/__tests__/sessionStoreContract.test.ts` | ISessionStore 契约：必需方法 + 全部可选方法（copySession/checkpoint/meta）+ 双层命名（autoName/displayName）类型验证 |

> **生长说明**：
> - **Loop 外循环本体在 L0**：`loop.ts` 的 `processUserInput` 即单轮闭环最小复用单元，对话/Loop/续跑共用同一闭环（[loop-design.md](./loop-design.md)）。
> - **外循环语义化（生长方向）**：复杂问题由任务链驱动多轮闭环 + 收敛汇报的设计愿景见 [task-driven-closed-loop.md](./task-driven-closed-loop.md)。
> - **会话记录底座**：`sessionStore.ts` 物理位置在 `memory/`，由宿主实现 `ISessionStore`，承载对话记录——是记忆溯源（traceSummary）与会话延续的共用底座。
> - **不中断工作流**：`agent/__tests__/uninterruptedWorkflow.test.ts`（不中断工作流集成测试）与 `agent/__tests__/degradation.test.ts`（降级处理测试）验证本层在暂停/续跑/异常下的行为。

---

## 六、通用地基（L6 · 被所有层消费）

> **生长来源**：任何生长层都需要的基础设施——配置加载、通用工具库、路径安全、日志。本层不承载业务生长，是各层共享的"土壤"。

### 6.1 配置（config/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `config/loader.ts` | 🟢 已打磨 | `__tests__/loader.test.ts` | 配置加载主入口 |
| `config/expandEnvVars.ts` | 🟢 已打磨 | `__tests__/expandEnvVars.test.ts` (16 tests) | 4 通道环境变量展开（llm/providers/background/embedding）+ 边界场景 |

### 6.2 工具库（utils/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `utils/eventEmitter.ts` | 🟢 已打磨 | `__tests__/eventEmitter.test.ts` | 类型化事件发射器 |
| `utils/segmenter.ts` | 🟢 已打磨 | `__tests__/segmenter.test.ts` | 分词工具（含加权 Jaccard 取代检测算法） |
| `utils/strings.ts` | 🟢 已打磨 | `__tests__/strings.test.ts` | 字符串工具 |
| `utils/objects.ts` | 🟢 已打磨 | `__tests__/objects.test.ts` | 对象类型守卫 |
| `utils/frontmatter.ts` | 🟢 已打磨 | `__tests__/frontmatter.test.ts` | Frontmatter 解析 |
| `utils/safeTimer.ts` | 🟢 已打磨 | `__tests__/safeTimer.test.ts` | 安全定时器 |
| `utils/hash.ts` | 🟢 已打磨 | `__tests__/hash.test.ts` | 哈希工具（sha256Fingerprint） |
| `utils/json.ts` | 🟢 已打磨 | `__tests__/json.test.ts` | JSON 工具 |
| `utils/errors.ts` | 🟢 已打磨 | `__tests__/errors.test.ts` | 错误类型体系 |
| `utils/toError.ts` | 🟢 已打磨 | `__tests__/toError.test.ts` | 错误转换 |
| `utils/math.ts` | 🟢 已打磨 | `__tests__/math.test.ts` | 数学工具 |
| `utils/array.ts` | 🟢 已打磨 | `__tests__/array.test.ts` | 数组工具 |
| `utils/path.ts` | 🟢 已打磨 | `__tests__/path.test.ts` | 路径工具 |
| `utils/time.ts` | 🟢 已打磨 | `__tests__/time.test.ts` | 时间工具 |
| `utils/scanner.ts` | 🟢 已打磨 | `__tests__/scanner.test.ts` | 文件扫描器 |
| `utils/configResourceManager.ts` | 🟢 已打磨 | `__tests__/configResourceManager.test.ts` | 配置资源管理（角色包/技能复用的基类） |
| `utils/loggerHolder.ts` | 🟢 已打磨 | `__tests__/loggerHolder.test.ts` | Logger 持有者 |
| `utils/atomicWrite.ts` | 🟢 已打磨 | `__tests__/atomicWrite.test.ts` (12 tests) | 原子写：临时文件+rename/覆盖写入/大内容/特殊字符/目录不存在异常 |
| `utils/recallDefaults.ts` | ⚪ 工具 | 无需测试 | 单常量 `DEFAULT_MIN_FALLBACK = 2` |

### 6.3 安全（security/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `security/pathGuard.ts` | 🟢 已打磨 | `__tests__/pathGuard.test.ts` | 路径白名单/黑名单守卫 + SecurityGuard（写入二次确认 + 审计日志，未注入 confirmationHandler 时 fail-closed） |

> **SecurityGuard 定位**：`pathGuard.ts` 同时承载 **SecurityGuard**——文件写权限守卫（4 类允许根 + 28 类禁止规则 + 写入二次确认 + 审计日志）。它由 `projectManager` 经 `createSecurityGuard` 工厂注入、被 `toolExecutor`/`builtinToolHandlers` 消费，是"角色包 rule 软约束护栏 + 即时注入防御"的物理落地（[agent-design-philosophy.md](./agent-design-philosophy.md) §6.3 信任边界；[mvp-scope.md](./mvp-scope.md) §二）。

### 6.4 日志（logging/）

| 模块文件 | 状态 | 测试文件 | 质量说明 |
|----------|------|----------|----------|
| `logging/logger.ts` | 🟢 已打磨 | `__tests__/logger.test.ts` | Logger 实现 |
| `logging/loggerInterface.ts` | ⚪ 接口 | 无独立测试 | ILogger 接口定义 |

> **2026-08-19 深度剪枝**：评估框架（`eval/`，evalRunner/evalTypes/scenarios）为运行时零消费者（index.ts 未导出，仅测试自引用），随剪枝整体移除——Agent 行为评估的 CI 回归能力由各宿主按需自建。

---

## 七、打磨线路推荐

> 本文档只**推荐打磨方向**，不记录打磨过程（历史沉淀见各 ADR）。当前内核核心逻辑均已打磨（见 §八 覆盖率），剩余打磨面收敛为**低风险接口补全**——纯类型/接口文件（⚪）依赖消费方集成测试覆盖，属"锦上添花"级推荐，不阻塞功能。

| # | 模块 | 推荐打磨内容 | 优先级 |
|---|------|-------------|--------|
| 1 | `memory/storageInterface.ts`、`logging/loggerInterface.ts` | 为 IMemoryStorage / ILogger 补独立契约测试（当前主路径已由消费方集成测试覆盖） | 低 |
| 2 | `skill/types.ts`、`llm/types.ts`、`web-search/types.ts` | 纯类型定义，随消费方集成测试覆盖即可，无需独立测试 | 低 |
| 3 | `utils/recallDefaults.ts` | 单常量（`DEFAULT_MIN_FALLBACK = 2`），无需测试 | — |

---

## 八、测试覆盖统计（按生长层）

> 覆盖统计按**生长层**组织（与正文模块编排一致）；纯类型/接口文件（⚪）按"消费方集成测试覆盖"计为无独立测试（与目录视角统计口径一致）。

| 生长层 | 文件数 | 有测试 | 无测试 | 覆盖率 |
|--------|--------|--------|--------|--------|
| L0 种子 · 执行闭环 | 10 | 8 | 2 | 80% |
| L1 支撑骨架 | 9 | 9 | 0 | 100% |
| L2 认知 · 回答前 | 10 | 9 | 1 | 90% |
| L3 行动 · 回答中 | 14 | 12 | 2 | 86% |
| L4 沉淀 · 回答后 | 28 | 27 | 1 | 96% |
| L5 外循环 · 会话延续 | 3 | 3 | 0 | 100% |
| L6 通用地基 | 24 | 22 | 2 | 92% |
| **总计** | **98** | **90** | **8** | **92%** |

> **计数口径**：
> - 无测试的 8 个文件：`skill/types.ts`、`llm/types.ts`、`web-search/types.ts`、`memory/storageInterface.ts`（纯类型/接口，消费方集成测试覆盖）+ `utils/recallDefaults.ts`（单常量，无需测试）+ `logging/loggerInterface.ts`（纯接口）+ `seed/index.ts`（桶导出）+ `seed/types.ts`（纯类型/契约，经 seed 各单测消费）。
> - L0 含 `agent/seed/`（5 源文件：index/types/prepare/orchestrator/difficulty；3 个有独立单测，index/types 无独立测试——prepare/act/reflect/handoff 三阶段执行器并入 orchestrator，无独立文件）；`seed/__tests__/harness.ts` 为测试装备非测试文件，不单列。
> - L4 含 `memory/` 13 文件（`sessionStore.ts` 计入 L5）+ 摘要/治理/会话沉淀 15 个 managers 文件。
> - L6 含 `utils/` 20 文件（含 `recallDefaults.ts`、`backgroundTask.ts`）+ config/security/logging。
> - 2026-08-20 种子收敛（L0 `agent/seed/`）+ 阶段 2（seed/difficulty 难度分级 + loop.runReport 汇报闭环）；2026-08-19 深度剪枝后：memory/ 移除 store/loader/multiHop 3 个文件，eval/ 整体移除（3 文件），reranker 收敛为接口（测试 3 条）。
