# Agent Harness 增强方案 · 排雷分析与实施路线图

> **日期**：2026-06-15
> **来源**：问诊 → 业界对标分析 → 排雷 → 本方案
> **对标版本**：Memora v4.0（零依赖内核 + Manager 委托模式）
> **参考**：OpenAI Agents SDK 四原语 / Anthropic Claude Code Harness / 2026 Harness Engineering 范式

---

## 一、背景

通过对标 OpenAI Agents SDK、Anthropic Claude Code、Google DeepMind 和 2026 年 Harness Engineering 主流实践，识别出 Memora agent 在 **6 个维度** 存在功能短板：

| # | 短板 | 业界成熟度 | 对 Memora 的影响 |
|---|------|-----------|-----------------|
| 1 | Structured Output | 标配 | 工具调用参数不可靠，靠事后类型修正止血 |
| 2 | Guardrails（内容护栏） | 标配 | 仅有路径白名单，无输入/输出内容安全检查 |
| 3 | Tracing（可观测性） | 标配 | 仅文本日志，AgentLoop 行为不可观测 |
| 4 | Reflection（反思/自修正） | 主流 | 工具错误仅以字符串回传，无结构化错误分类 |
| 5 | Evaluation（评估体系） | 主流 | 无 Agent 行为回归测试，改 prompt 不知道是否退化 |
| 6 | Plan-then-Execute / Sub-agent | 前沿 | 纯 ReAct 循环，无显式规划阶段 |

本方案对每条建议做 **逐项排雷**——分析其与 memora 核心设计哲学的冲突风险、可行性、实施路径，并产生分阶段路线图。

---

## 二、排雷原则

每条建议按以下 5 个维度评估：

| 维度 | 说明 |
|------|------|
| **零依赖** | 是否引入新的 npm 依赖（违反 [project-rules.md §1.6](./.trae/rules/project-rules.md) "零依赖内核"） |
| **领域无关** | 是否在核心代码中硬编码领域逻辑（违反 [architecture_philosophy_rules.md §5](./.trae/rules/architecture_philosophy_rules.md)） |
| **记忆统一** | 是否创建独立的子系统而非融入 source 标签体系（违反 [ADR-004](./.trae/rules/decisions/ADR-004-memory-unification.md)） |
| **单 Agent** | 是否引入多 Agent 或破坏 Agent 级共享 DB（违反 [ADR-011](./.trae/rules/decisions/ADR-011-multi-project.md)） |
| **降级优先** | 是否在非关键路径上引入阻塞点（违反 [architecture_philosophy_rules.md §7](./.trae/rules/architecture_philosophy_rules.md)） |

---

## 三、逐项排雷

### 3.1 Structured Output（结构化输出） — ✅ 推荐采纳

**业界参考**：OpenAI `response_format: { type: "json_schema" }`，Anthropic structured output API。

**改动点**：`AgentLoop.buildChatOptions()`（[loop.ts#L376-L389](file:///f:/zooique/bowen-reader/hosts/memora/src/agent/loop.ts#L376-L389)）增加 `response_format` 字段，利用 OpenAI 兼容协议的 JSON Schema 约束 LLM 输出。

**排雷结果**：

| 维度 | 评估 | 说明 |
|------|------|------|
| 零依赖 | ✅ 通过 | 纯协议层增强，`ChatOptions` 已有 `tools` 字段，增加 `response_format` 不引入新依赖 |
| 领域无关 | ✅ 通过 | JSON Schema 由 ToolDefinition.parameters 自动生成，不硬编码领域逻辑 |
| 记忆统一 | ✅ 通过 | 不涉及记忆模型 |
| 单 Agent | ✅ 通过 | 不涉及 Agent 数量 |
| 降级优先 | ✅ 通过 | 需增加降级：`response_format` 失败时 fallback 到当前行为（纯文本 tool_call） |

**风险点**：
- 部分本地小模型不完全支持 `json_schema` 模式 → **需要降级策略**
- `validateAndCoerceArgs()` 目前作为安全网仍应保留（双重保障）

**实施路径**：
1. 在 `ToolDefinition` 增加 `strict` 标记（声明该工具必须结构化输出）
2. 在 `buildChatOptions()` 中，当所有 toolDefinitions 都标记 strict 时，生成 `response_format`
3. LLM Provider 接口增加 `supportsStructuredOutput` 能力声明
4. 不支持的 Provider 自动跳过 structured output，fallback 到当前行为

**依赖**：无新增 npm 依赖。

---

### 3.2 Tracing（可观测性） — ✅ 推荐采纳（需接口注入）

**业界参考**：OpenAI Agents SDK 内置 spans + traces，OpenTelemetry 生态。

**改动点**：在 AgentLoop 关键节点（recall → LLM call → tool call → response）埋入结构化 span event。

**排雷结果**：

| 维度 | 评估 | 说明 |
|------|------|------|
| 零依赖 | ⚠️ 需约束 | **禁止**直接 import OpenTelemetry SDK。必须定义为 `ITracer` 接口，宿主注入实现 |
| 领域无关 | ✅ 通过 | Span 定义（operation、duration、metadata）是通用概念 |
| 记忆统一 | ✅ 通过 | 不涉及记忆模型。Tracing 是横切关注点，不属于"记忆"范畴 |
| 单 Agent | ✅ 通过 | Tracing 是观测层，不影响 Agent 数量 |
| 降级优先 | ✅ 通过 | Tracer 未注入时静默跳过，不阻塞任何路径 |

**风险点**：
- 如果直接引入 `@opentelemetry/api` 或 `@opentelemetry/sdk-node`，会违反零依赖原则
- Span 数据量大时可能影响性能 → span 收集应为 fire-and-forget，不阻塞 AgentLoop

**实施路径**：
1. 定义 `ITracer` 接口（`src/agent/tracer.ts`）：`startSpan(name, attrs)` → `ISpan`
2. 定义 `ISpan` 接口：`setAttribute()` / `end()` / `recordException()`
3. 在 `AgentOptions` 增加 `tracer?: ITracer`
4. 在 `AgentLoop.processUserInput()` 的 4 个关键阶段埋入 span
5. 提供 `NoopTracer` 默认实现（静默丢弃所有 span）
6. 宿主项目（如 泊文）按需注入 OpenTelemetry 实现

**依赖**：无新增 npm 依赖（memora 侧仅定义接口）。

---

### 3.3 Guardrails（内容护栏） — ✅ 推荐采纳（需融入记忆统一模型）

**业界参考**：OpenAI Agents SDK 的输入/输出 Guardrails，Anthropic 的分级权限。

**改动点**：在 AgentLoop 对话前后插入可插拔的护栏检查点。

**排雷结果**：

| 维度 | 评估 | 说明 |
|------|------|------|
| 零依赖 | ✅ 通过 | 规则引擎（正则 + 字符串匹配）无需依赖；LLM judge 复用已有 provider |
| 领域无关 | ✅ 通过 | 护栏规则应从 `configDir/rules/` 加载，不硬编码领域逻辑 |
| 记忆统一 | ⚠️ 需约束 | **禁止**创建独立的 `GuardrailsService`。护栏规则应以 `source: "guardrail"` 记忆形式存储，遵循"万物皆记忆"原则 |
| 单 Agent | ✅ 通过 | 不涉及 Agent 数量 |
| 降级优先 | ✅ 通过 | 护栏检查失败 = 阻断（P0 安全），但不能因护栏自身异常导致对话中断 → 护栏异常时降级为"放行 + 记日志" |

**风险点**：
- 如果设计成独立子系统（GuardrailsService / GuardrailManager），直接违反"记忆统一模型"
- 护栏过于激进会误杀正常请求 → 需可配置开关（per guardrail）
- LLM-based judge 增加延迟 → 应作为可选项，默认用规则引擎

**实施路径**：
1. 定义 `GuardrailRule` 类型：`{ id, source: 'guardrail', stage: 'input'|'output', pattern: string, action: 'block'|'warn', message: string }`
2. 护栏规则以 `source: "guardrail"` 记忆形式存储，由 MemoryLoader 启动时加载
3. 在 `AgentLoop` 中增加两个钩子：
   - `runInputGuardrails(input: string)` → AgentLoop 迭代前
   - `runOutputGuardrails(content: string)` → 工具执行后 / 文本响应后
4. 护栏检查异常时降级为"放行 + logger.warn"，不阻塞对话
5. 可选的 LLM judge（复用 `backgroundProvider`，异步执行，不阻塞主流程）

**依赖**：无新增 npm 依赖。

---

### 3.4 Reflection（反思/自修正） — ✅ 推荐采纳

**业界参考**：OpenAI/Anthropic 的 self-correction 模式，执行 → 观察 → 自我评估 → 修正。

**改动点**：在 AgentLoop 工具调用结果回传时，附加结构化错误信息（errorCode + retryable）。

**排雷结果**：

| 维度 | 评估 | 说明 |
|------|------|------|
| 零依赖 | ✅ 通过 | 纯 AgentLoop 逻辑增强 |
| 领域无关 | ✅ 通过 | 错误码定义通用（PATH_NOT_ALLOWED / FILE_NOT_FOUND / TOOL_TIMEOUT 等） |
| 记忆统一 | ✅ 通过 | 不涉及记忆模型 |
| 单 Agent | ✅ 通过 | 不涉及 Agent 数量 |
| 降级优先 | ✅ 通过 | Reflection 失败不应阻止原始响应，只在可重试场景下尝试修正 |

**风险点**：
- 自修正循环可能导致 maxIterations 被快速消耗 → 需增加 `maxReflectionRetries`（建议 2 次）
- 需要区分可重试错误（FILE_NOT_FOUND → 可能是路径错了）和不可重试错误（PERMISSION_DENIED → 不应重试）

**实施路径**：
1. 定义 `ToolErrorCode` 枚举：`RETRYABLE`（网络超时/文件被锁）/ `NON_RETRYABLE`（权限拒绝/路径越界）/ `ARGUMENT_ERROR`（参数错误可修正）
2. 在 `ToolExecutor.execute()` 的 catch 分支（[toolExecutor.ts#L174-L182](file:///f:/zooique/bowen-reader/hosts/memora/src/agent/toolExecutor.ts#L174-L182)）中附加 errorCode
3. tool result 格式从纯文本扩展为：`{ result: string, errorCode?: string, retryable: boolean }`
4. AgentLoop 中增加轻量反思逻辑：如果 `retryable === true` 且未超过 `maxReflectionRetries`（默认 2），自动重新进入 LLM 迭代（带上错误上下文）

**依赖**：无新增 npm 依赖。

---

### 3.5 Evaluation（评估体系） — ⚠️ 建议分阶段（先 Mock Eval，后真实 LLM Eval）

**业界参考**：OpenAI Eval harness、LangSmith、Anthropic eval framework。

**改动点**：建立 Agent 行为回归测试，验证 prompt 修改、recall 管线调整后行为不退化。

**排雷结果**：

| 维度 | 评估 | 说明 |
|------|------|------|
| 零依赖 | ⚠️ 需约束 | Eval 工具作为 devDependency 可接受（不影响 memora 生产依赖），但应尽量轻量 |
| 领域无关 | ✅ 通过 | Eval 场景定义通用（输入 + 期望行为特征） |
| 记忆统一 | ✅ 通过 | 不涉及记忆模型 |
| 单 Agent | ✅ 通过 | 不涉及 Agent 数量 |
| 降级优先 | ✅ 通过 | Eval 只在开发/CI 阶段运行，不在运行时 |

**风险点**：
- ❌ 使用真实 LLM 做评估违反 [ADR-007](./.trae/rules/decisions/ADR-007-testing-strategy.md)（"不允许真实调用"）
- ❌ 评估体系如果设计成独立子系统，可能膨胀为负担

**实施路径（两阶段）**：

**阶段一：Mock Eval（推荐立即启动）**
1. 定义 `EvalScenario` 类型：输入、期望的工具调用名（或正则匹配）、期望的召回 source 分布
2. 使用 MSW Mock LLM（模拟 tool_call 响应），验证 AgentLoop 行为
3. 在 Vitest 中运行，作为 CI 的一部分
4. 覆盖场景：工具调用正确性 / 召回排除 source / 角色切换匹配

**阶段二：真实 LLM Eval（暂缓）**
- 需要真实 LLM 调用 → 必须独立于 CI，手动触发
- 评估 prompt 变更对回复质量的影响
- 不建议在 memora 核心库中实现，应由宿主项目自行构建

**依赖**：阶段一无新增依赖（复用 Vitest + MSW）。阶段二暂不实施。

---

### 3.6 Plan-then-Execute / Sub-agent — ❌ 不推荐采纳

**业界参考**：OpenAI Agents SDK Handoffs、LangGraph 多 Agent 编排。

**改动点**：引入显式规划阶段或多 Agent 委托。

**排雷结果**：

| 维度 | 评估 | 说明 |
|------|------|------|
| 零依赖 | ✅ 通过 | 纯架构变更 |
| 领域无关 | ⚠️ 有风险 | Sub-agent 的领域边界难以抽象 |
| 记忆统一 | ❌ **严重冲突** | Sub-agent 的记忆归属问题——是共享 Agent 级 DB 还是独立存储？共享违反隔离原则，独立违反"万物皆记忆" |
| 单 Agent | ❌ **直接违反** | [ADR-011](./.trae/rules/decisions/ADR-011-multi-project.md) 明确："Memora 被宿主接入后，就是该程序的唯一 Agent" |
| 降级优先 | ⚠️ 有风险 | 多 Agent 编排引入新的故障模式 |

**结论**：

- **Sub-agent 委托**：❌ 直接违反单 Agent 模型（ADR-011）和记忆统一模型（ADR-004）。不做。
- **Plan-then-Execute（轻量）**：⚠️ 可作为 AgentLoop 内的有限增强——在首轮迭代前让 LLM 输出多步骤计划（非多 Agent），但不涉及 sub-agent。即使这个方向也需要权衡：它违背了"应无所住而生其心"的专注哲学（[ADR-009](./.trae/rules/decisions/ADR-009-focus-mode.md)）——Agent 应该按需行动，而非预设全局计划。

**替代方案**：如果宿主项目（如 泊文）需要多步骤编排，应在 **宿主层面** 实现（多次调用 `agent.chat()`），而非在 memora 核心中支持。

---

## 四、排雷结论总表

| # | 建议 | 排雷结果 | 与核心哲学冲突 | 实施优先级 |
|---|------|---------|--------------|-----------|
| 1 | Structured Output | ✅ 安全 | 无 | **P0 · 立即** |
| 2 | Tracing | ✅ 安全（需接口注入） | 无（必须接口化） | **P0 · 立即** |
| 3 | Guardrails | ✅ 安全（需融入 source:guardrail） | 无（必须融入记忆模型） | **P1 · 下一迭代** |
| 4 | Reflection | ✅ 安全 | 无 | **P1 · 下一迭代** |
| 5 | Evaluation（Mock） | ✅ 安全（阶段一） | 无（不涉及真实 LLM） | **P1 · 下一迭代** |
| 6 | Plan-then-Execute / Sub-agent | ❌ 否决 | ADR-004 + ADR-011 + ADR-009 | **不做** |

---

## 五、分阶段实施路线图

### 阶段 A：零依赖快速补强（P0，预计 2-3 轮迭代）

**目标**：不改架构、不加依赖、直接提升 agent 可靠性。

| 编号 | 任务 | 涉及文件 | 产出 |
|------|------|---------|------|
| A-1 | ChatOptions 增加 response_format 支持 | `loop.ts`、`provider.ts` | Structured Output 能力 |
| A-2 | ITracer 接口定义 + NoopTracer | 新建 `src/agent/tracer.ts` | Tracing 抽象层 |
| A-3 | AgentLoop 关键节点埋 span | `loop.ts` | 4 个 span：recall / llm_call / tool_exec / response |
| A-4 | AgentOptions 增加 tracer 注入入口 | `agent.ts` | 宿主可注入 tracer |
| A-5 | LlmProvider 增加能力声明字段 | `provider.ts` | supportsStructuredOutput |

**验证标准**：
- 无新增 npm 依赖
- 现有测试 360+ 全部通过
- `response_format` Provider 不支持时自动降级

### 阶段 B：工程化能力加固（P1，预计 2-3 轮迭代）

**目标**：补齐 Guardrails、Reflection 和 Mock Eval。

| 编号 | 任务 | 涉及文件 | 产出 |
|------|------|---------|------|
| B-1 | Guardrail 记忆类型定义 | `types.ts`（增加 SOURCE_LABELS.GUARDRAIL） | source: "guardrail" |
| B-2 | MemoryLoader 加载 guardrail 规则 | `memoryLoader.ts` | 启动时加载护栏 |
| B-3 | AgentLoop 输入/输出护栏钩子 | `loop.ts` | runInputGuardrails() / runOutputGuardrails() |
| B-4 | ToolErrorCode 枚举 + tool result 结构化错误 | `toolExecutor.ts` | retryable flag |
| B-5 | AgentLoop 轻量 Reflection 循环 | `loop.ts` | maxReflectionRetries: 2 |
| B-6 | EvalScenario 类型 + Mock Eval 框架 | `tests/eval/` | 3-5 个回归场景 |
| B-7 | 更新 ADR-006 补充 Guardrails 内容 | `ADR-006-security-model.md` | 年轮修订 |

**验证标准**：
- 护栏规则从 configDir 加载，可人工编辑
- Reflection 不过度消耗 maxIterations
- Mock Eval 在 CI 中通过

### 阶段 C：宿主协作增强（P2，按需）

**目标**：由宿主项目（泊文）实现的增强，不进入 memora 核心。

| 编号 | 任务 | 说明 |
|------|------|------|
| C-1 | 宿主注入 OpenTelemetry Tracer | 泊文实现 ITracer，接入 OTLP |
| C-2 | 宿主级 Eval（真实 LLM） | 泊文自建真实 LLM 评估场景 |
| C-3 | 宿主级多步骤编排 | 通过多次 `agent.chat()` 实现复杂工作流 |

---

## 六、ADR 更新计划

| ADR | 变更内容 | 时机 |
|-----|---------|------|
| ADR-006（安全模型） | 增加 Guardrails 章节：输入/输出护栏作为阶段三实现 | 阶段 B-7 |
| ADR-007（测试策略） | 增加 Mock Eval 章节：Agent 行为回归测试 | 阶段 B-6 |
| ADR-010（Agent 门面） | 增加 ITracer 注入入口说明 | 阶段 A-4 |
| 新增 ADR-014 | Agent Harness 增强决策：取舍理由（含为何否决 Sub-agent） | 阶段 A 完成后 |

---

## 七、风险与注意事项

1. **Structured Output 的 Provider 兼容性**：不是所有 OpenAI 兼容 API 都支持 `response_format: json_schema`。需在 `LlmProvider` 接口增加能力声明字段（`supportsStructuredOutput?: boolean`），不支持时静默降级。

2. **Tracing 的性能开销**：Span 创建和属性设置应尽量轻量。NoopTracer 的实现应直接返回 `{ end: () => {} }` 空对象，避免任何计算。真实 tracer 的 span export 应为异步 fire-and-forget。

3. **Guardrails 不阻塞对话**：护栏自身异常（如规则加载失败、LLM judge 超时）应降级为"放行 + 记日志"，永远不阻断用户对话。这是降级优先原则（[architecture_philosophy_rules.md §7](file:///f:/zooique/bowen-reader/hosts/memora/.trae/rules/architecture_philosophy_rules.md)）的直接要求。

4. **Reflection 循环上限**：增强后的 AgentLoop 可能有更多迭代场景（ReAct + Reflection），需确保 `maxIterations` 足够但不过量。建议总上限保持 20，其中 Reflection 重试不超过 2 次。

5. **禁止引入的依赖清单**：
   - ❌ `@opentelemetry/api` / `@opentelemetry/sdk-node`
   - ❌ `langsmith` / `langfuse`
   - ❌ 任何 Agent 编排框架（LangGraph / CrewAI / AutoGen）
   - ✅ 仅允许 Vitest 的 devDependencies 用于 Eval

---

## 八、哲学一致性检查

| memora 核心哲学 | 本方案是否违背 | 说明 |
|----------------|-------------|------|
| 万物皆记忆 | 否 | Guardrails 以 source:guardrail 融入记忆模型 |
| 零依赖内核 | 否 | 所有增强通过接口注入或协议层实现 |
| 领域无关 | 否 | 不硬编码任何领域逻辑 |
| 单 Agent 模型 | 否（明确排除了 Sub-agent） | Plan-then-Execute 也暂缓 |
| 配置文件是真理源 | 否 | Guardrail 规则从 configDir 加载 |
| 降级优先 | 否 | 每个增强都有降级路径 |
| 专注模式 | 否 | Reflection 和 Structured Output 不改变专注哲学 |

---

> **下一步**：确认本方案后，按阶段 A → B → C 顺序执行。每个阶段完成后触发年轮审判（ADRs 交叉验证）。建议在阶段 A 开始前，先用一次"提交前审查"确认当前代码状态无偏离。