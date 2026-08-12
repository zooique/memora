# Memora 重构实施路线图

> 基于 SSOT（单一真理源）哲学，从"闭环是种子"到"整个系统是一棵大树"。
>
> 本文档是实施计划，不是设计文档。设计文档见 [架构说明书](architecture/README.md) 和 [运行时架构](architecture/runtime-architecture.md)。

---

## 前奏：反思 — 运行时架构的 SSOT 违规

在制定路线图之前，先对刚生成的运行时架构做一次**哲学审查**。任何新设计必须通过 SSOT 的三问测试：

> 1. **这套逻辑是否只在某个场景下生效？**
> 2. **去掉这个场景的特殊处理，核心逻辑是否依然完整？**
> 3. **这个功能的实现，是否需要在最小单元之外引入新机制？**

### 违规 1：RoundTrace.record() 让核心闭环"知道"自己在被追踪

**问题**：运行时架构文档中，`RoundTrace` 接口包含 `record(event)` 和 `createChild()` 方法。如果核心闭环直接调用 `trace.record(...)`，意味着核心闭环 import 了可观测性类型——**这是核心对运行时的反向依赖**。

```
❌ 违规写法（核心闭环依赖可观测性）：
  class AgentLoop {
    constructor(private tracer: ITracer) {}
    async act() {
      const span = this.tracer.startSpan('act');
      // ...
      span.end();
    }
  }

✅ SSOT 正确写法（核心闭环暴露钩子，可观测性订阅）：
  class AgentLoop {
    constructor(private hooks: RoundHooks) {}
    async act() {
      this.hooks.onPhaseStart('act');
      // ...
      this.hooks.onPhaseEnd('act');
    }
  }

  // 可观测性层订阅钩子，内部创建 span
  class ObservabilityLayer {
    constructor(private tracer: ITracer) {
      hooks.onPhaseStart(p => this.tracer.startSpan(p));
    }
  }
```

**修正**：核心闭环只暴露 `RoundHooks` 接口，不引用任何可观测性类型。`ITracer` 保持宿主注入模式，但由运行时层在 `RoundHooks` 回调中调用。

**现行代码评估**：检查了现有 `AgentLoop` 代码，发现 `ITracer` 已经通过构造注入，核心闭环确实调用了 `this.tracer.startSpan()`。**这是历史遗留的 SSOT 违规**，需要修复。

### 违规 2：MetricCollector 被核心闭环直接调用

**问题**：同样的问题——如果核心闭环直接调用 `metricCollector.recordHistogram(...)`，就是运行时依赖。

**修正**：通过 `RoundHooks` 收集指标数据。`MetricCollector` 订阅 `onPhaseEnd` 事件，从事件参数中提取时长等数据，自行记录指标。

### 违规 3：StateSnapshot 是独立机制，而非 Handoff 的自然延伸

**问题**：SSOT 证明三（§2.3）明确指出：**"Handoff 边界是天然的暂停点/检查点"**。但运行时架构引入了独立的 `StateSnapshot`、`SnapshotManager`、`RecoveryStrategy` 三个接口——这是"引入新机制"的补丁思维。

```
❌ 违规：独立的快照系统
  闭环完成后 → SnapshotManager.createSnapshot() → 持久化

✅ SSOT 正确：Handoff 本身就是检查点
  闭环完成后 → Handoff 决策 → 持久化当前状态（作为 Handoff 的自然步骤）
```

**修正**：将检查点功能合并到 Handoff 阶段。Handoff 不只是"决定下一轮由谁触发"，还自然包含"持久化当前状态"。`StateSnapshot` 退化为 Handoff 的序列化格式，不单独存在。

**现行代码评估**：检查了现有 `SessionManager`，发现已有 `createCheckpoint` 和 `restoreFromCheckpoint` 方法。**这是历史遗留的 SSOT 违规**——检查点作为独立功能存在，而非 Handoff 的自然延伸。

### 违规 4：EventBus 与已有 EventEmitter 重复

**问题**：运行时架构引入了 `EventBus` 接口，但现有代码已有 `EventEmitter`（`src/utils/eventEmitter.ts`）和 `AGENT_EVENTS` 常量表。引入第二个事件系统是**重复造轮子**。

```
❌ 违规：两套事件系统
  现有：EventEmitter + AGENT_EVENTS（约 30 种事件）
  新引入：EventBus + 25 种事件类型

✅ SSOT 正确：扩展已有系统
  在 EventEmitter 基础上增加"事件类型"概念（目前只有"事件名"）
  新增的类型在 AGENT_EVENTS 中统一注册
```

**修正**：弃用 `EventBus` 接口，扩展 `EventEmitter` 使其支持事件类型分类。所有运行时事件注册到 `AGENT_EVENTS` 常量表中。

### 违规 5：GuardrailPlugin 插件链可能过度设计

**问题**：GuardrailPlugin 是插件链模式——多个插件按优先级顺序执行。但 SSOT 原则是"最小单元层面解决"。对于安全护栏来说，**更简单的方案是扩展角色包的 rule 段**，而非引入插件系统。

```
❌ 违规：插件链模式
  GuardrailPlugin { onInput, onOutput, onToolCall, onMemoryRecall }
  GuardrailManager { register, checkInput, checkOutput, ... }

✅ SSOT 正确：在角色包 rule 段中扩展安全规则类型
  rule 段新增：input_filter, output_filter 类型
  规则由 SecurityGuard 统一执行，无需插件系统
```

**修正**：将护栏功能整合到角色包 `rule` 段中，新增 `input_filter` 和 `output_filter` 规则类型。`SecurityGuard` 统一执行所有规则，不引入插件系统。

**例外**：如果未来需要宿主注入自定义护栏逻辑（如调用外部安全 API），可通过 `GuardrailPlugin` 的单接口实现，但**不作为核心接口暴露**——仅在宿主侧存在。

---

## 第二轮反思：运行时架构的深层问题

在对运行时架构做第二轮审查时，发现了更多问题——有些是文档不一致（已修复），有些是设计层面的问题。

### 违规 6-8：文档不一致（已修复）

这些不是设计违规，而是文档在 SSOT 修正后未同步更新导致的残留：

| # | 问题 | 位置 | 修复方式 |
|---|------|------|---------|
| 6 | GuardrailReport 重复定义，残留 `plugin` 字段 | runtime-architecture.md §13.8.2 | 删除旧定义，统一使用 SecurityGuard 下的 GuardrailReport |
| 7 | RuntimeConfigRegistry 引用 `EventBus['on']` | runtime-architecture.md §13.6.2 | 改为 `EventEmitter['on']` |
| 8 | 架构分层图仍列出 Guardrail 为独立组件 | architecture/README.md §2.1 | 合并到 SecurityGuard |

**教训**：文档修改必须全局同步，尤其是接口命名和组件结构的变更。

### 违规 9：InterruptProtocol 与 TriggerQueue 功能重叠

**问题**：`InterruptProtocol` 的 `signalPendingInput`、`hasPendingInput`、`getPendingInputs`、`acknowledge` 四个方法，本质上都是对 TriggerQueue 的查询操作。TriggerQueue 已经知道"队列中有什么"，不需要独立的协议。

```
❌ 当前设计：
  TriggerQueue（处理排队） + InterruptProtocol（处理中断信号）
  两个独立接口，但操作的其实是同一个数据（队列状态）

✅ SSOT 正确设计：
  TriggerQueue 自身提供查询接口，InterruptProtocol 退化为
  TriggerQueue.getQueueStatus() 的便捷方法
```

**严重程度**：🟡 中。

**影响范围**：运行时并发控制层。

**修复方式**：将 `InterruptProtocol` 合并到 `TriggerQueue` 中——`TriggerQueue` 新增 `hasPendingInput(sessionId)` 和 `getPendingInputs(sessionId)` 方法，移除 `InterruptProtocol` 接口。

### 违规 10：SessionScope.checkQuota 抛出异常

**问题**：`SessionScope.checkQuota` 抛出 `SessionQuotaExceededError`——这是异常流控制。但运行时架构中，Guardrail 使用 `GuardrailResult`（Result 模式），检查类操作应该使用同一模式。

```
❌ 不一致：
  SecurityGuard.checkInput() → GuardrailResult（Result 模式）
  SessionScope.checkQuota()  → 抛出异常（异常模式）

✅ 统一：
  SessionScope.checkQuota()  → QuotaResult（Result 模式）
  // 或：checkQuota 返回布尔值，由调用方决定如何处理
```

**严重程度**：🟢 低。

**影响范围**：会话隔离模块。

**修复方式**：将 `checkQuota` 的返回值从 `void`（抛出异常）改为 `QuotaResult` 或布尔值，由调用方决定是否终止。

### 违规 11：ResourcePool 可能过度设计

**问题**：`ResourcePool` 管理全局资源（LLM 并发数、内存字节、存储 IOPS），但大多数宿主并不需要这种精细度的资源管理。SessionScope 已经提供会话级配额，LockManager 提供跨会话资源锁——ResourcePool 在两者之间又加了一层。

**SSOT 三问测试**：
1. 这套逻辑是否只在某个场景下生效？——是，只在多会话高并发场景下需要。
2. 去掉这个场景的特殊处理，核心逻辑是否依然完整？——是，去掉 ResourcePool，SessionScope 和 LockManager 依然工作。
3. 这个功能的实现，是否需要在最小单元之外引入新机制？——是，它引入了全新的 ResourcePool 接口。

**结论**：三个问题都是"是"，**ResourcePool 是过度设计**。

**严重程度**：🟢 低。

**影响范围**：运行时多会话隔离层。

**修复方式**：从运行时架构中移除 `ResourcePool` 接口。全局资源管理由宿主自行决定，内核不提供抽象——宿主完全可以通过 `LockManager` 实现自己的资源管理。

---

## 违规总结

| # | 违规 | 严重程度 | 影响范围 | 修复方式 |
|---|------|---------|---------|---------|
| 1 | RoundTrace 导致核心依赖可观测性 | 🔴 高 | 核心闭环 | 改为 RoundHooks 钩子模式 |
| 2 | MetricCollector 被核心直接调用 | 🔴 高 | 核心闭环 | 同上，通过 RoundHooks 收集 |
| 3 | StateSnapshot 是独立机制 | 🔴 高 | 恢复机制 | 合并到 Handoff 阶段 |
| 4 | EventBus 与 EventEmitter 重复 | 🟡 中 | 事件系统 | 扩展 EventEmitter，弃用 EventBus |
| 5 | GuardrailPlugin 过度设计 | 🟡 中 | 安全护栏 | 合并到角色包 rule 段 |
| 6-8 | 文档不一致（已修复） | 🟢 低 | 文档 | 已修复 |
| 9 | InterruptProtocol 与 TriggerQueue 重叠 | 🟡 中 | 并发控制 | 合并到 TriggerQueue |
| 10 | SessionScope.checkQuota 异常流控制 | 🟢 低 | 会话隔离 | 改为 Result 模式 |
| 11 | ResourcePool 过度设计 | 🟢 低 | 会话隔离 | 移除接口，宿主自行实现 |

**核心结论**：运行时架构文档的**接口形状**基本正确，但**挂载方式**有 5 处 SSOT 违规，**文档一致性**有 3 处问题，**设计简洁性**有 3 处可优化。

修复方向不变：**核心闭环只暴露 `RoundHooks`——一组简单的阶段边界回调。所有运行时组件（追踪、指标、事件、检查点）都通过订阅 `RoundHooks` 接入，而非被核心直接调用。**

---

## 设计哲学反思

### 1. 运行时层本身是否违反 SSOT？

SSOT 的核心公理是"单轮问答闭环是最小单元，一切复杂行为都是这个单元的自然生长"。但运行时层（并发控制、优雅关闭、可观测性等）**不是最小单元的自然生长**——它是"闭环的容器"，不是"闭环的扩展"。

**这是否违反 SSOT？**

**答案：不违反。** SSOT 约束的是"闭环内部"的复杂度——上下文装配、角色包匹配、Handoff 决策等都是从最小单元中自然生长出来的。运行时层是"闭环运行的环境"，它有自己独立的需求维度（并发、进程管理、资源隔离等），这些需求不是从闭环中生长出来的，而是从"在真实环境中运行闭环"这个需求中生长出来的。

**类比**：发动机是最小单元，变速箱是它的自然扩展（改变转速→扭矩），但油箱不是发动机的自然扩展——它是发动机运行的环境。油箱的设计不需要遵守"从发动机自然生长"的原则，它只需要让发动机能正常工作。

**运行时层同理**：它不需要从闭环中自然生长，它只需要满足"让闭环能在真实环境中正确执行"这个需求。

### 2. 复杂度是否真的向外生长了？

当前架构的复杂度分布：

```
核心闭环（简单）：
  Prepare → Act → Reflect → Handoff
  └── 暴露 RoundHooks（唯一接口）

运行时层（复杂）：
  └── 9 个领域，每个领域 2-4 个接口
```

**问题**：运行时层的复杂度是否太大了？9 个领域、20+ 个接口，是否合理？

**评估**：9 个领域都是从生产环境需求中推导出来的，每个领域解决一个独立的运行时问题。但其中 3 个领域（并发控制、会话隔离、安全护栏）有接口重叠和过度设计的问题（见违规 9-11）。**复杂度不是太大，但确实有冗余**。

**结论**：复杂度分布是合理的——核心闭环保持简单，复杂度向外生长到运行时层。但运行时层需要进一步"修剪"——移除冗余接口，合并重叠功能。

### 3. 是否还有"补丁思维"的残留？

| 场景 | 当前设计 | 补丁思维？ | 评估 |
|------|---------|-----------|------|
| 多角色包冲突 | 优先级金字塔 + 冲突策略 | 否 | 在角色包自身属性层面解决，非新系统 |
| 成本追踪 | 在 Reflect 阶段累计，Handoff 前检查 | 否 | 在闭环阶段边界操作，非独立系统 |
| 摘要失败降级 | 会话级运行时标志 | 否 | 在闭环属性层面解决，非新系统 |
| 粘性漂移 | 在 system prompt 中注入提示 | 否 | 在闭环的上下文层面解决，非新系统 |
| **并发控制** | TriggerQueue + LockManager + InterruptProtocol | **是** | 三个接口操作同一数据，有冗余 |
| **会话隔离** | SessionScope + ResourcePool + IsolatedContext | **是** | ResourcePool 是过度设计 |

**结论**：运行时层残留了少量"补丁思维"——主要是接口层面的冗余，不是架构层面的问题。Phase 3（并发 + 护栏）和 Phase 6（性能预算）的实施中需要修剪这些冗余。

### 4. 深度反思：运行时架构的"隐形假设"

以下假设被隐含地接受，但未被明确验证：

| 假设 | 内容 | 风险 |
|------|------|------|
| 所有宿主都需要所有 9 个运行时领域 | 运行时架构为最复杂的宿主设计 | 轻量宿主（如 CLI）被过度设计拖累 |
| 内核和运行时通过 RoundHooks 解耦就够了 | 一个接口足够承载所有运行时需求 | 如果 RoundHooks 需要扩展，可能破坏已有订阅者 |
| 检查点版本化是必要的 | HandoffCheckpoint 包含 version 字段 | 版本兼容可能通过宿主层解决，不需要内核级别 |
| 可观测性是运行时层的职责 | 核心闭环不需要知道自己在被追踪 | 这是正确的，但依赖模式设计需谨慎 |

**结论**：这些假设需要在实际实施中验证。**如果某个宿主只需要 9 个领域中的 3 个，运行时架构应该允许"按需加载"**——而不是一次性加载所有运行时组件。这符合 SSOT 的"复杂度自然生长"原则：运行时复杂度应该"按需生长"，而非"预先设计"。

---

## 反思总结

| 维度 | 状态 | 未解决的问题 |
|------|------|-------------|
| 核心闭环 SSOT 合规 | ✅ 合规 | 无 |
| 运行时接口 SSOT 合规 | ✅ 基本合规 | 违规 9-11 需修复 |
| 文档一致性 | ✅ 已修复 | 违规 6-8 已修复 |
| 设计简洁性 | 🟡 需优化 | ResourcePool 过度设计，InterruptProtocol 冗余 |
| 隐形假设 | 🟡 需验证 | 运行时"按需加载"能力未定义 |

---

## 重构路线图

### 路线图总览

```
Phase 1: 打好地基 ── RoundHooks + 测试基础设施
    ↓
Phase 2: 装上眼睛 ── 可观测性（追踪 + 指标 + 事件）
    ↓
Phase 3: 建好护栏 ── 并发控制 + 安全护栏
    ↓
Phase 4: 学会走路 ── 优雅关闭 + 恢复（基于 Handoff）
    ↓
Phase 5: 学会进化 ── 热更新 + 版本兼容
    ↓
Phase 6: 学会跑 ── 性能预算 + 优化
```

---

### Phase 1：打好地基 — RoundHooks + 测试基础设施

**核心目标**：在核心闭环中植入 `RoundHooks`，消除所有运行时对核心的反向依赖。同时建立测试基础设施，为后续各阶段提供测试能力。

**修改的文件**：
- `src/agent/loop.ts` — 核心闭环
- `src/agent/tracer.ts` — 现有 ITracer（需要重构）
- 新建 `src/agent/roundHooks.ts` — 阶段钩子接口

**关键里程碑**：

| 里程碑 | 产出 | 验收标准 |
|--------|------|---------|
| M1.1 RoundHooks 接口定义 | `RoundHooks` 接口，包含 `onPhaseStart/End`、`onHandoff`、`onError` 四个回调 | 接口不引用任何运行时类型，仅传递阶段名和上下文数据 |
| M1.2 AgentLoop 接入 RoundHooks | AgentLoop 所有阶段边界调用 hooks 回调 | 所有现有测试通过，无行为变化 |
| M1.3 测试基础设施 | `MockLlmProvider`、`RoundFixture` 格式、`ScenarioBuilder` | 可独立测试单轮闭环，无需真实 LLM |
| M1.4 回归验证 | 用测试夹具覆盖核心闭环的全部路径 | 测试覆盖率 ≥ 90%（核心闭环路径） |

**RoundHooks 接口定义**：

```typescript
/**
 * 闭环阶段钩子 —— 核心闭环暴露给运行时的唯一接口
 *
 * SSOT 纪律：这是核心闭环与运行时的唯一边界。
 * 核心闭环不引用任何运行时类型，运行时通过订阅此接口接入。
 *
 * 默认实现为空操作（NoopRoundHooks），零开销。
 */
interface RoundHooks {
  /** 阶段开始 */
  onPhaseStart?(phase: 'prepare' | 'act' | 'reflect', data?: PhaseStartData): void;
  /** 阶段结束 */
  onPhaseEnd?(phase: 'prepare' | 'act' | 'reflect', data?: PhaseEndData): void;
  /** Handoff 决策 */
  onHandoff?(decision: HandoffDecision, state: SessionState): void;
  /** 错误发生 */
  onError?(error: Error, phase: string): void;
  /** 事件记录（通用事件） */
  onEvent?(type: string, data?: any): void;
}

interface PhaseStartData {
  sessionId: string;
  roundId: string;
  triggerSource: string;
}

interface PhaseEndData {
  sessionId: string;
  roundId: string;
  durationMs: number;
  result?: any;
}
```

**设计纪律**：
- `RoundHooks` 是 `interface` 而非类，所有回调可选，默认不执行任何操作
- 核心闭环不存储 hooks 的返回值，不依赖 hooks 的执行结果
- hooks 的执行是同步的，不阻塞核心闭环的主流程
- 运行时层通过 `RoundHooks` 适配器接入，而非直接修改核心闭环

---

### Phase 2：装上眼睛 — 可观测性

**核心目标**：基于 `RoundHooks` 实现完整的可观测性层。这是**第一阶段之后优先级最高的**——没有可观测性，后续所有阶段的调试都将是盲人摸象。

**关键决策**：弃用 `EventBus` 接口，扩展现有 `EventEmitter` 系统。

**修改的文件**：
- 新建 `src/observability/traceManager.ts` — 追踪管理器
- 新建 `src/observability/metricCollector.ts` — 指标收集器
- 修改 `src/utils/eventEmitter.ts` — 扩展事件类型
- 修改 `src/agent/tracer.ts` — 重构为基于 RoundHooks

**关键里程碑**：

| 里程碑 | 产出 | 验收标准 |
|--------|------|---------|
| M2.1 TraceManager | 基于 RoundHooks 的追踪实现，自动收集阶段边界时间戳 | 无需手动调用 `trace.record()`，自动生成完整 Timeline |
| M2.2 MetricCollector | 基于 RoundHooks 的指标收集，内置 20+ 预定义指标 | 指标自动从阶段边界数据推导，无需手动埋点 |
| M2.3 事件系统扩展 | 在现有 EventEmitter 上增加事件类型分类，注册所有运行时事件 | 统一使用 `AGENT_EVENTS` 常量表，无两套事件系统 |
| M2.4 宿主集成验证 | 验证宿主可订阅所有可观测性数据 | 宿主可获取完整追踪、指标、事件流 |

**SSOT 验证**：
- 核心闭环：不引用任何可观测性类型，只暴露 `RoundHooks`
- 可观测性层：订阅 `RoundHooks`，自行创建 trace/metric/event
- 宿主：通过 `ITracer` 接口接入自定义实现

---

### Phase 3：建好护栏 — 并发控制 + 安全护栏

**核心目标**：在多会话场景下保证安全和正确性。同时修复第二轮审查中发现的违规 9 和 10。

**关键决策**：
- 并发控制使用 `TriggerQueue`（排队），不引入复杂锁机制
- 安全护栏整合到角色包 `rule` 段，不引入插件系统
- `InterruptProtocol` 合并到 `TriggerQueue`，不独立存在（修复违规 9）
- `SessionScope.checkQuota` 使用 Result 模式而非异常（修复违规 10）

**修改的文件**：
- 新建 `src/runtime/triggerQueue.ts` — 触发队列（含中断查询接口）
- 新建 `src/runtime/lockManager.ts` — 锁管理器（简化版，仅读写锁）
- 新建 `src/runtime/sessionScope.ts` — 会话作用域（checkQuota 返回 Result）
- 修改 `src/security/guardrail.ts` — 扩展为基于 rule 段的统一护栏
- 修改 `src/agent/loop.ts` — 集成 TriggerQueue 和 Guardrail
- 移除 `InterruptProtocol` 接口（合并到 TriggerQueue）

**关键里程碑**：

| 里程碑 | 产出 | 验收标准 |
|--------|------|---------|
| M3.1 TriggerQueue | 每会话串行队列，支持优先级和超时，内置中断查询 | 10 个并发 Trigger 到达同一会话时依次执行，不丢不重；TriggerQueue.hasPendingInput() 正确反映队列状态 |
| M3.2 LockManager | 读锁共享写锁互斥的资源锁 | 双会话同时写入记忆系统时无数据竞争 |
| M3.3 SessionScope | 会话级资源配额和隔离，checkQuota 返回 Result 模式 | 单会话无法耗尽全局资源池；配额超限时返回 QuotaResult 而非异常 |
| M3.4 Guardrail 整合 | 护栏规则从角色包 rule 段读取，统一执行 | 输入过滤、输出过滤、工具调用检查全部通过 rule 段配置 |

**SSOT 验证**：
- 并发控制是运行时层，不修改核心闭环
- 安全护栏是角色包 rule 段的自然扩展，不是独立系统
- 核心闭环只通过 `RoundHooks` 暴露"输入到达"和"输出准备"事件
- 无 InterruptProtocol 独立接口（修复违规 9）
- 所有检查类操作统一使用 Result 模式（修复违规 10）

---

### Phase 4：学会走路 — 优雅关闭 + 恢复

**核心目标**：进程可以安全关闭和恢复，不丢失数据。

**关键决策**：**检查点合并到 Handoff**——这是本阶段最重要的 SSOT 修正。Handoff 不仅仅是"决策"，还包含"状态持久化"。恢复时从最后一个 Handoff 状态重建。

**修改的文件**：
- 修改 `src/agent/loop.ts` — Handoff 阶段包含状态持久化
- 修改 `src/agent/managers/sessionManager.ts` — 重构 createCheckpoint/restoreFromCheckpoint
- 新建 `src/runtime/shutdownHook.ts` — 关闭序列
- 新建 `src/runtime/recovery.ts` — 恢复策略

**关键里程碑**：

| 里程碑 | 产出 | 验收标准 |
|--------|------|---------|
| M4.1 Handoff 持久化 | Handoff 时自动持久化会话状态 | 每轮闭环完成后，状态自动写入持久化存储 |
| M4.2 ShutdownHook | 5 阶段关闭序列（通知→持久化→释放→完成） | 关闭时正在执行的闭环完成当前阶段后停止，不丢失数据 |
| M4.3 恢复策略 | 从 Handoff 状态重建会话 | 重启后自动扫描未完成会话，从最后一个 Handoff 恢复 |
| M4.4 异常容错 | 进程崩溃后的数据恢复 | 模拟 kill -9 后重启，会话数据完整，可从断点续跑 |

**SSOT 验证**：
- 检查点不是独立机制，是 Handoff 的自然延伸
- Handoff 的职责从"决策"扩展到"决策 + 持久化"
- 恢复时从最后一个 Handoff 状态重建，不需要额外的快照系统

---

### Phase 5：学会进化 — 热更新 + 版本兼容

**核心目标**：系统可以在运行时更新配置，不重启进程。

**修改的文件**：
- 新建 `src/runtime/configVersionManager.ts` — 版本化配置管理
- 新建 `src/runtime/versionRegistry.ts` — 版本注册表
- 修改 `src/role-pack/loader.ts` — 支持版本检查和兼容性验证
- 修改 `src/utils/eventEmitter.ts` — 注册 `configReloaded` 事件

**关键里程碑**：

| 里程碑 | 产出 | 验收标准 |
|--------|------|---------|
| M5.1 版本化配置 | 角色包和配置携带版本号，新老版本共存 | 新会话使用新版本，老会话继续使用旧版本 |
| M5.2 热更新事件 | 配置变更通过 EventEmitter 通知 | 宿主可订阅 `configReloaded` 事件感知变更 |
| M5.3 版本兼容检查 | 角色包加载时自动检查版本兼容性 | 不兼容版本报错，提示迁移路径 |
| M5.4 迁移机制 | 版本间数据迁移 | 角色包格式升级时，自动迁移旧数据到新格式 |

**SSOT 验证**：
- 版本号是角色包 frontmatter 的自然字段，不是新机制
- 热更新通过 EventEmitter 通知，不直接修改核心闭环
- 版本兼容检查是加载时的自然步骤，不是独立系统

---

### Phase 6：学会跑 — 性能预算 + 优化

**核心目标**：系统有明确的性能目标，可度量和优化。同时移除过度设计的 ResourcePool（修复违规 11）。

**修改的文件**：
- 新建 `src/runtime/performanceBudget.ts` — 性能预算配置
- 修改 `src/agent/loop.ts` — 集成性能预算检查
- 修改 `src/observability/metricCollector.ts` — 性能指标与预算对比
- 移除 `ResourcePool` 接口设计（过度设计，宿主自行实现全局资源管理）

**关键里程碑**：

| 里程碑 | 产出 | 验收标准 |
|--------|------|---------|
| M6.1 性能预算配置 | 角色包可声明 `performance.latencyTier` | 三级延迟等级（normal/fast/background） |
| M6.2 性能指标自动收集 | 基于 MetricCollector 的 P50/P95/P99 延迟 | 指标自动从阶段边界数据推导 |
| M6.3 超预算告警 | 超过性能目标时触发告警事件 | 宿主可订阅 `performanceWarning` 事件 |
| M6.4 移除 ResourcePool | 从运行时架构中移除 ResourcePool 接口 | SessionScope + LockManager 已覆盖资源管理需求 |

**SSOT 验证**：
- 性能预算是角色包 L2 策略的自然维度，不是新系统
- 超预算告警通过 EventEmitter 通知，不修改核心闭环
- 性能指标从已有数据（阶段边界时间戳）推导，不额外埋点
- ResourcePool 已移除，无过度设计残留（修复违规 11）

---

## 实施优先级矩阵

| 阶段 | 效益 | 成本 | 风险 | 涉及的违规修复 |
|------|------|------|------|--------------|
| P1 RoundHooks | 🔴 高（消除所有违规的根基） | 🟡 中（重构核心闭环） | 🟡 中（影响所有测试） | 违规 1,2 |
| P2 可观测性 | 🔴 高（后续所有阶段的调试依赖） | 🟢 低（基于 RoundHooks） | 🟢 低（不改变行为） | 违规 4 |
| P3 并发+护栏 | 🔴 高（多会话安全必备） | 🟡 中（新模块） | 🟢 低（新模块，不影响现有） | 违规 5,9,10 |
| P4 关闭+恢复 | 🟡 中（生产环境必备） | 🟡 中（重构检查点） | 🟡 中（修改 SessionManager） | 违规 3 |
| P5 热更新+版本 | 🟡 中（长期维护必备） | 🟢 低（扩展已有机制） | 🟢 低（不影响运行时） | 违规 7 |
| P6 性能预算 | 🟢 低（优化阶段） | 🟢 低（配置为主） | 🟢 低（纯新增） | 违规 11 |

---

## 实施纪律

### 1. 每个阶段完成后，运行所有测试

```
每个里程碑完成后：
  1. tsc --noEmit（类型检查通过）
  2. npm test（所有测试通过）
  3. npm run lint（代码规范通过）
```

### 2. 每个阶段完成后，更新文档

```
每个阶段完成后：
  1. 更新 architecture/README.md（如有接口变更）
  2. 更新 architecture/runtime-architecture.md（如有接口变更）
  3. 更新 CHANGELOG.md
```

### 3. SSOT 审查门禁

每个阶段完成后，必须通过 SSOT 三问测试：

1. **这套逻辑是否只在某个场景下生效？** —— 如果是，需要参数化
2. **去掉这个场景的特殊处理，核心逻辑是否依然完整？** —— 如果否，补丁与核心已耦合
3. **这个功能的实现，是否需要在最小单元之外引入新机制？** —— 如果是，审查是否过度设计

### 4. 运行时"按需加载"规则

运行时组件应支持按需加载，避免拖累轻量宿主：

```
如果宿主不需要某个运行时领域：
  → 不加载该领域的运行时组件
  → 不对核心闭环产生任何影响
  → 核心闭环的 RoundHooks 默认实现为空操作（NoopRoundHooks）
```

### 5. 新发现违规的即时修复纪律

在后续实施中，如果发现文档不一致或设计冗余：

- 文档不一致 → **立即修复**，不等待阶段边界
- 设计冗余 → **记录到路线图**，在对应的阶段修复
- 新的 SSOT 违规 → 评估严重程度，🔴 高优先立即修复，🟡 中/🟢 低在对应阶段修复

---

## 关联文档索引

| 文档 | 用途 | 路径 |
|------|------|------|
| 架构说明书（核心） | 核心闭环设计、角色包体系、上下文预算 | [docs/architecture/README.md](architecture/README.md) |
| 运行时架构（设计） | 9 个运行时领域的接口定义 | [docs/architecture/runtime-architecture.md](architecture/runtime-architecture.md) |
| 重构路线图（本文） | 实施阶段划分、里程碑、违规记录 | 本文 |
| 思维模型（方法论） | 单一真理源思维模型的完整规则 | [.trae/rules/single-truth-source-mindset.md](../.trae/rules/single-truth-source-mindset.md) |