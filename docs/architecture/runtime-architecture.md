# Memora 运行时架构

> **闭环之外的世界**——并发、关闭、可观测、热更新、隔离、护栏、性能、测试、版本。
>
> 核心闭环（第 1-12 章）回答了"Agent 如何工作"，本章回答"Agent 如何可靠地运行"。
>
> 与核心闭环的关系：**运行时是闭环的容器**——闭环不感知运行时的存在，但运行时确保闭环能在真实环境中正确执行。
>
> **设计状态说明**：本文描述的是**目标设计接口**（如 RoundHooks、TriggerQueue、Guardrail 等），部分接口尚未进入代码。
> 已实现接口以 [docs/memora-api-reference.md](../memora-api-reference.md)（现状快照 v2.1.0）与 `src/` 源码为准；
> 本文接口是否落地按 [docs/refactoring-roadmap.md](../refactoring-roadmap.md) 各阶段里程碑跟踪。
> 修订沿革见 [CHANGELOG.md](../../CHANGELOG.md) 与各阶段实施记录。

---

## 十三、运行时架构总览

### 13.1 运行时与核心闭环的边界

```
┌─────────────────────────────────────────────────────┐
│                    运行时层                           │
│                                                      │
│  并发控制  │  优雅关闭  │  可观测性  │  热更新       │
│  会话隔离  │  安全护栏  │  性能预算  │  版本管理     │
│                                                      │
├─────────────────────────────────────────────────────┤
│             核心闭环（第 1-12 章）                     │
│        Prepare → Act → Reflect → Handoff             │
└─────────────────────────────────────────────────────┘
```

**边界纪律**：
1. **核心闭环只暴露 `RoundHooks`**——一组阶段边界回调，不引用任何运行时类型
2. **所有运行时组件通过订阅 `RoundHooks` 接入**——追踪、指标、事件、检查点都是订阅者
3. **运行时是宿主级概念**，但接口形状由内核定义——宿主实现，内核使用

### 13.2 运行时接口总图

```
                     ┌──────────────────────┐
                     │     核心闭环           │
                     │  Prepare → Act →     │
                     │  Reflect → Handoff   │
                     └────────┬─────────────┘
                              │ 只暴露 RoundHooks
                              ▼
                     ┌──────────────────────┐
                     │     RoundHooks        │
                     │  onPhaseStart/End     │
                     │  onHandoff/onError    │
                     │  onEvent              │
                     └──────┬───────┬───────┘
                            │       │
              ┌─────────────┘       └─────────────┐
              ▼                                   ▼
     ┌────────────────┐                  ┌────────────────┐
     │  可观测性订阅者   │                  │  运行时订阅者    │
     │  TraceManager   │                  │  TriggerQueue   │
     │  MetricCollector│                  │  Guardrail      │
     │  EventEmitter   │                  │  ShutdownHook   │
     └────────────────┘                  └────────────────┘
```

---

## 13.3 并发控制

### 13.3.1 问题定义

核心闭环是"严格串行"的——任何时刻只有一个闭环在执行。但"严格串行"不等于"没有并发问题"：

| 并发场景 | 风险 | 说明 |
|---------|------|------|
| 多个 Trigger 同时到达 | 竞争执行 | 两个外部输入同时到达，可能导致两个闭环同时运行 |
| 工具调用中外部输入到达 | 状态污染 | 工具执行是异步的，外部输入可能在此期间修改共享状态 |
| 记忆系统并发写入 | 数据竞争 | 多个闭环（跨会话）同时写入记忆系统可能导致数据丢失 |
| Handoff 决策前状态变更 | 决策错误 | Handoff 依赖的检查条件在并发下可能已过时 |

### 13.3.2 并发模型：单会话串行 + 跨会话并行

**核心原则**：同一会话内的闭环严格串行，不同会话的闭环可以并行。

```
同一会话：Trigger → [排队] → Round1 → [排队] → Round2 → ...
                                     ↑
                                     └── 串行执行，用锁保证

不同会话：Session-A Round1 ──┐
                             ├── 并行执行，互不阻塞
          Session-B Round1 ──┘
```

### 13.3.3 接口定义

```typescript
/**
 * 触发队列：同一会话内的 Trigger 排队机制
 *
 * 职责：确保同一会话内的闭环严格串行执行
 * 挂载点：Trigger 入口处
 *
 * SSOT 纪律：InterruptProtocol 的功能合并到此接口中，
 * 不再有独立的"中断协议"接口。
 * hasPendingInput / getPendingInputs 是队列状态的查询，
 * 不需要独立的数据结构。
 *
 * 宿主实现责任：
 * - 提供适合宿主环境的排队策略（内存队列 / 消息队列 / 工作线程池）
 * - 实现队列容量限制和背压（backpressure）
 */
interface TriggerQueue {
  /**
   * 提交一个触发到指定会话的队列尾部
   * 返回一个 Promise，当该 Trigger 被处理时 resolve
   *
   * @param sessionId - 目标会话 ID
   * @param trigger - 触发内容
   * @param options - 排队选项
   * @returns 排队结果，包含队列位置和预计等待时间
   */
  enqueue(
    sessionId: string,
    trigger: Trigger,
    options?: EnqueueOptions
  ): Promise<EnqueueResult>;

  /**
   * 获取指定会话的队列状态
   */
  getQueueStatus(sessionId: string): QueueStatus;

  /**
   * 清空指定会话的队列（用于关闭/恢复）
   */
  drain(sessionId: string): Promise<Trigger[]>;

  /**
   * 注册闭环完成回调
   * 每轮闭环完成后调用，触发队列中下一个 Trigger 出队
   */
  onRoundComplete(sessionId: string): void;

  /**
   * 检查当前会话是否有待处理的外部输入（原 InterruptProtocol.hasPendingInput）
   * 由 Prepare 阶段在开始时调用
   * 影响 Handoff 决策：如有待处理输入，Handoff 不应选 loop
   */
  hasPendingInput(sessionId: string): boolean;

  /**
   * 获取待处理输入列表（原 InterruptProtocol.getPendingInputs）
   * 由 Prepare 阶段用于决定是否跳过某些步骤
   */
  getPendingInputs(sessionId: string): PendingInput[];

  /**
   * 注册外部输入到达信号（原 InterruptProtocol.signalPendingInput）
   * 当 enqueue 时自动调用，无需宿主手动调用
   */
  signalPendingInput(sessionId: string, triggerId: string): void;

  /**
   * 清除待处理输入信号（原 InterruptProtocol.acknowledge）
   * 当外部输入被排队等待下一轮时调用
   */
  acknowledge(sessionId: string, triggerId: string): void;
}

interface EnqueueOptions {
  /** 队列超时（毫秒），超过则丢弃 */
  timeout?: number;
  /** 优先级，数值越大越优先（默认 0） */
  priority?: number;
  /** 是否允许覆盖队列中已有的相同内容（去重） */
  deduplicate?: boolean;
}

interface EnqueueResult {
  position: number;       // 队列中的位置（1 = 正在执行）
  estimatedWaitMs: number; // 预计等待时间
  accepted: boolean;      // 是否被接受（可能被队列满拒绝）
  rejectReason?: string;  // 拒绝原因
}

interface QueueStatus {
  /** 当前队列深度 */
  depth: number;
  /** 当前正在执行的闭环（如果有） */
  currentRoundId?: string;
  /** 队列中等待的触发列表 */
  pendingTriggers: { id: string; submittedAt: number }[];
}
```

```typescript
/**
 * 锁管理器：跨会话共享资源的并发控制
 *
 * 职责：保护共享资源（记忆系统、角色包缓存）的并发访问
 * 挂载点：所有共享资源访问入口
 *
 * 锁类型：
 * - 会话锁（SessionLock）：同一会话内串行，不同会话不互斥
 * - 资源锁（ResourceLock）：跨会话共享资源的互斥访问
 * - 全局锁（GlobalLock）：全体互斥，仅用于极端场景
 */
interface LockManager {
  /**
   * 获取会话锁
   * 同一会话内的闭环必须获取此锁才能执行
   * 不同会话的锁不互斥
   */
  acquireSessionLock(sessionId: string): Promise<LockHandle>;

  /**
   * 获取资源锁
   * 保护共享资源的读写
   * 读锁可共享，写锁互斥
   */
  acquireResourceLock(
    resourceId: string,
    mode: 'read' | 'write',
    timeout?: number
  ): Promise<LockHandle>;

  /**
   * 释放锁
   */
  release(handle: LockHandle): void;

  /**
   * 尝试获取锁，不阻塞
   */
  tryAcquire(
    resourceId: string,
    mode: 'read' | 'write'
  ): LockHandle | null;
}

interface LockHandle {
  id: string;
  resourceId: string;
  mode: 'read' | 'write';
  acquiredAt: number;
  /** 释放锁的便捷方法 */
  release(): void;
}
```

### 13.3.4 执行流程

```
外部输入到达
  │
  ▼
TriggerQueue.enqueue(sessionId, trigger)
  │
  ├── 队列为空 → 立即获取 SessionLock → 开始执行闭环
  │
  └── 队列非空 → 排队等待
                   │
                   ▼
              当前闭环完成 → Handoff
                   │
                   ├── hasPendingInput()=true → Handoff 选 end
                   │   → 队列中下一个 Trigger 出队 → 开始新闭环
                   │
                   └── hasPendingInput()=false → Handoff 按策略决策
```

### 13.3.5 设计纪律

1. **不中断正在执行的闭环**：任何并发控制都不能在闭环执行中插入操作
2. **会话锁是准入锁，不是执行锁**：获取锁后闭环正常运行，锁只在阶段边界检查
3. **资源锁最小化**：记忆系统读取使用读锁共享，写入时才获取写锁
4. **队列满不阻塞**：队列满时直接返回 `accepted: false`，由触发者决定如何处理
5. **中断信号是提示，不是指令**：`signalPendingInput` 只是告知闭环"外面有输入"，闭环自行决定如何处理
6. **队列与锁职责分界**：`TriggerQueue` 负责顺序调度（单会话串行出队），`SessionLock` 负责并发互斥（跨进程/多线程宿主下的准入）——单进程内存队列实现下 `SessionLock` 可省略，避免"双重保险"被误读为必需

### 13.3.6 会话暂停 / 恢复（Pause）

**现状**：暂停/恢复是内核既有能力（`SessionManager.pause()/resume()`，状态机
`RUNNING → PAUSED → ERROR → RUNNING`，见 [README.md §12.1](README.md) 与
src/agent/sessionStateMachine.ts）。本节补齐其运行时边界语义，不与中断信号混淆：

| 机制 | 触发方 | 语义 | 生效时机 |
|------|--------|------|---------|
| 输入中断（§13.3.3） | 外部 Trigger 到达 | 提示闭环"外面有输入"，闭环自行决策 | Prepare 阶段读取，不打断在飞阶段 |
| 会话暂停（Pause） | 宿主显式调用 | 挂起整个会话，等待恢复 | 阶段边界收口后进入 PAUSED，不掐断在飞 LLM 调用 |
| 会话恢复（Resume） | 宿主显式调用 | 从检查点续跑 | 走恢复流程（§13.4） |
| 硬停止（Abort） | 宿主显式调用 | 终止运行，不可续跑（唯一霸道中止） | 立即杀生成器（signal.abort） |

**纪律**：

1. **暂停与中断不混淆**：中断是"下一轮优先处理新输入"的提示；暂停是"整个会话挂起，等宿主恢复"。
2. **暂停遵守"阶段边界收口"**（与 §13.9.4 纪律 5 一致）——不在 LLM 调用中途插入。
3. **暂停状态持久化**：`SessionCheckpoint.status = 'paused'`（含 `pauseMeta`），恢复经 `normalizeCheckpoint` 迁移（project-rules §1.8）。
4. **abort 的会话落点**：abort 后会话落回"待触发"态（等价 end 后），**必须卸载执行态**——`clearPlan` 清空 plan/roundLog（上下文保留为会话历史）；后续 Trigger 正常开新闭环。abort 与 pause 是互斥出口：暂停保留 plan 可续跑，abort 清 plan 不可续跑（详见 [README §12.1](README.md#十二远期锚点与已知缺口)）。

---

## 13.4 优雅关闭与恢复

### 13.4.1 问题定义

Agent 系统可能在任何时刻被要求关闭（用户退出、系统重启、异常崩溃），需要保证：

| 场景 | 要求 | 风险 |
|------|------|------|
| 用户主动关闭 | 保存当前轮次的状态，不丢失数据 | 正在进行中的 LLM 调用被截断 |
| 系统重启/更新 | 恢复到关闭前的状态，无缝继续 | 中间状态丢失 |
| 异常崩溃 | 最小化数据丢失，启动后恢复 | 记忆系统损坏 |
| 会话超时回收 | 资源释放，状态持久化 | 长时间运行的会话占用资源 |

### 13.4.2 接口定义

```typescript
/**
 * 关闭钩子：定义关闭时的行为序列
 *
 * 职责：协调各个组件的关闭顺序，保证数据完整性
 * 挂载点：宿主进程退出前
 */
interface ShutdownHook {
  /**
   * 注册一个关闭阶段
   * 阶段按注册顺序执行，每个阶段完成后再执行下一个
   *
   * @param phase - 关闭阶段名称
   * @param handler - 关闭处理函数
   * @param options - 阶段配置
   */
  register(
    phase: string,
    handler: ShutdownHandler,
    options?: ShutdownPhaseOptions
  ): void;

  /**
   * 执行关闭序列
   * 按阶段顺序执行，每个阶段可设置超时
   */
  shutdown(reason: ShutdownReason): Promise<ShutdownReport>;
}

type ShutdownHandler = () => Promise<void>;

interface ShutdownPhaseOptions {
  /** 该阶段超时时间（毫秒），超时后强制跳过 */
  timeout: number;
  /** 是否必须成功（失败时阻止进程退出） */
  critical: boolean;
}

type ShutdownReason =
  | 'user_exit'
  | 'system_restart'
  | 'update_install'
  | 'session_timeout'
  | 'crash_recovery';

interface ShutdownReport {
  completed: string[];      // 成功完成的阶段
  failed: { phase: string; error: string }[];  // 失败的阶段
  skipped: string[];        // 超时跳过的阶段
  totalDurationMs: number;
}
```

```typescript
/**
 * 检查点投影：Handoff 时持久化的会话状态视图
 *
 * SSOT 纪律：HandoffCheckpoint 不是独立机制——它是 `SessionCheckpoint`
 * （见 src/agent/types.ts，执行状态的唯一真理源）在 Handoff 场景下的**只读投影**。
 * 字段全部派生自 SessionCheckpoint 或运行时元数据：不新增字段、不持有独立版本号、
 * 不建平行存储/迁移链。
 *
 * - 版本兼容：由 `SessionCheckpoint.schemaVersion` + `SessionManager.checkpointMigrations`
 *   承担（project-rules §1.8 硬约束）。新增检查点字段必须：① 递增
 *   CURRENT_SCHEMA_VERSION；② 注册迁移函数。不得在此平行定义版本。
 * - 消息恢复：完整对话由会话存储（ISessionStore）负责，不进入检查点。
 * - 角色锁定 / 预算状态：属会话执行状态，走 SessionCheckpoint 既有字段
 *   （role / resource）；如需新增字段，按 §1.8 流程扩展，不在此定义。
 *
 * 挂载点：Handoff 阶段结束前由 SessionManager 自动创建（touchCheckpoint 收口）
 */
interface HandoffCheckpoint {
  /** 运行时派生的索引元数据（不承载执行状态） */
  metadata: {
    checkpointId: string;
    sessionId: string;
    roundId: string;
    handoffDecision: 'wait' | 'loop' | 'end';
    timestamp: number;
  };

  /** 会话状态投影：SessionCheckpoint 既有字段的直接引用（不新增字段） */
  session: Pick<
    SessionCheckpoint,
    | 'sessionId'
    | 'status'
    | 'mainGoal'
    | 'currentGoal'
    | 'plan'
    | 'role'
    | 'standard'
    | 'resource'
    | 'hotMemory' // 会话热记忆投影（高频短期记忆；读写机制归属记忆子系统设计，本文仅投影字段）
    | 'pauseMeta'
    | 'lastHeartbeat'
    | 'schemaVersion'
  >;
}

/**
 * 检查点存储：持久化 `SessionCheckpoint`（HandoffCheckpoint 为其投影视图）的存储接口
 *
 * 宿主实现。持久化主体是 SessionCheckpoint 本体——投影不单独落盘、不建平行格式。
 * 写入收口在 SessionManager（touchCheckpoint/flushCheckpoint），本接口描述的是
 * 关闭/恢复场景下宿主侧的持久化职责面；存储策略（文件系统 / 数据库 / 内存）由宿主决定。
 */
interface CheckpointStore {
  /** 保存检查点（Handoff 时自动调用） */
  save(checkpoint: SessionCheckpoint): Promise<void>;

  /** 获取指定会话的最后一个检查点 */
  getLastCheckpoint(sessionId: string): Promise<SessionCheckpoint | null>;

  /** 列出指定会话的所有检查点 */
  listCheckpoints(sessionId: string): Promise<CheckpointMeta[]>;

  /** 清理过期检查点 */
  cleanExpired(retentionPeriodMs: number): Promise<void>;
}

interface CheckpointMeta {
  checkpointId: string;
  sessionId: string;
  roundId: string;
  handoffDecision: string;
  timestamp: number;
  sizeBytes: number;
}

/**
 * 会话存储：完整对话消息的持久化接口（§13.4.2 引用的 ISessionStore 定义）
 *
 * 职责：保存/读取会话的完整消息序列（SerializedMessage[]），与检查点分离——
 * 检查点只存执行状态投影（§13.4.2），消息归本接口；恢复时两者合并重建会话。
 *
 * 宿主实现（文件系统 / 数据库 / 内存）；追加收口，防并行写乱序。
 */
interface ISessionStore {
  /** 追加消息（收口：消息写入唯一入口） */
  appendMessage(sessionId: string, message: SerializedMessage): Promise<void>;
  /** 读取会话完整消息（按时间正序） */
  getMessages(sessionId: string): Promise<SerializedMessage[]>;
  /** 删除会话消息（归档/清理时） */
  deleteSession(sessionId: string): Promise<void>;
}
```
```typescript
/**
 * 序列化消息格式
 * 与 AgentLoop 的 Message 格式一致，只添加序列化元数据
 */
interface SerializedMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  /** 元数据附加字段 */
  meta: {
    roundId: string;
    timestamp: number;
    summary?: string;
    tokenCount: number;
  };
}
```

```typescript
/**
 * 恢复策略：定义从异常中恢复的行为
 *
 * 职责：决定系统启动后如何处理未完成的会话和闭环。
 * 恢复数据来源：CheckpointStore 中最近的 `SessionCheckpoint`；
 * 版本迁移由 `normalizeCheckpoint` 自动应用（project-rules §1.8）。
 */
interface RecoveryStrategy {
  /**
   * 系统启动时自动调用
   * 扫描所有未完成的会话，根据策略决定恢复行为
   */
  recover(): Promise<RecoveryReport>;

  /**
   * 注册自定义恢复策略
   * 宿主可覆盖默认策略（恢复行为可配置，检查点格式不随之分叉）
   */
  setStrategy(
    sessionId: string,
    strategy: 'abandon' | 'restart_round' | 'continue_round'
  ): void;
}

interface RecoveryReport {
  scannedSessions: number;
  recovered: {
    sessionId: string;
    action: 'abandon' | 'restart_round' | 'continue_round';
    roundId?: string;
    snapshotId?: string;
  }[];
  failed: { sessionId: string; error: string }[];
  unrecoverable: { sessionId: string; reason: string }[];

  /** 恢复时从 CheckpointStore 读取 */
  readonly checkpointStore: CheckpointStore;
}
```

### 13.4.3 关闭流程

```
用户触发关闭
  │
  ▼
ShutdownHook.shutdown(reason)
  │
  ├── Phase 1: 通知（通知所有正在执行的闭环"准备关闭"）
  │   └── 正在执行的闭环完成当前阶段后停止，不开启新阶段
  │
  ├── Phase 2: 检查点（对每个活跃会话执行 Handoff 持久化）
  │   └── CheckpointStore.save(sessionCheckpoint)
  │
  ├── Phase 3: 持久化（将快照写入持久化存储）
  │   └── 确保内存数据已写入磁盘
  │
  ├── Phase 4: 释放（释放所有资源锁、关闭连接）
  │   └── LockManager.release() / 关闭 LLM 连接 / 关闭记忆存储
  │
  └── Phase 5: 完成（报告关闭结果）
      └── 返回 ShutdownReport
```

### 13.4.4 设计纪律

1. **关闭是"软着陆"**：不强制终止正在执行的 LLM 调用，等待其完成当前阶段
2. **检查点是 Handoff 的自然延伸**：每轮闭环的 Handoff 阶段自动创建检查点，关闭时只确保最后一个检查点已持久化
3. **恢复策略可配置**：宿主可根据场景决定恢复行为（如 CLI 工具可能直接丢弃，GUI 应用可能自动恢复）
4. **关闭顺序固定**：通知 → 检查点 → 持久化 → 释放 → 完成，不可颠倒
5. **检查点版本化**：投影不含独立版本号；兼容性由 `SessionCheckpoint.schemaVersion`
   递增 + `checkpointMigrations` 迁移承担（project-rules §1.8），恢复时经
   `normalizeCheckpoint` 自动应用迁移
6. **检查点写入按需收口**：脏标记（dirty flag，`touchCheckpoint` 置位 / `flushCheckpoint`
   清位）驱动落盘，只在阶段边界与关键状态变更时写；长会话须避免每轮全量快照的
   O(n²) 总写入量——变更字段增量序列化，或热状态高频小写 + 冷状态低频全量分层

---

## 13.5 可观测性

### 13.5.1 问题定义

Agent 系统的运行过程是"黑盒"——LLM 调用不可预测，工具调用链可能很长，记忆系统状态复杂。可观测性需要回答：

| 问题 | 对应机制 | 用途 |
|------|---------|------|
| "这个闭环在做什么？" | RoundTrace 追踪 | 实时查看执行进度 |
| "为什么 LLM 这样回答？" | 上下文日志 | 事后分析 |
| "系统性能瓶颈在哪？" | MetricCollector 指标 | 性能优化 |
| "系统是否健康？" | 健康检查 | 运行监控 |
| "发生了什么错误？" | 结构化日志 | 问题定位 |

### 13.5.2 接口定义

#### RoundHooks：核心闭环的唯一运行时接口

**SSOT 纪律**：核心闭环只暴露 `RoundHooks`，不引用任何运行时类型。所有可观测性组件（追踪、指标、事件）通过订阅 `RoundHooks` 接入。

```typescript
/**
 * 闭环阶段钩子 —— 核心闭环暴露给运行时的唯一接口
 *
 * 这是核心闭环与运行时的唯一边界。
 * 核心闭环不引用任何运行时类型，运行时通过订阅此接口接入。
 *
 * 默认实现为空操作，零开销。
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
  /** 通用事件记录 */
  onEvent?(type: string, data?: unknown): void;
}

/**
 * 触发源：决定召回与角色包匹配行为（见 README §3.3「触发源决定召回行为」）
 * - user / system / agent：外部输入 → 触发 recall() 与角色包匹配
 * - loop：Loop 自循环（工具调用/自动续跑）→ 不触发 recall
 */
type TriggerSource = 'user' | 'system' | 'agent' | 'loop';

interface PhaseStartData {
  sessionId: string;
  roundId: string;
  triggerSource: TriggerSource;
}

interface PhaseEndData {
  sessionId: string;
  roundId: string;
  durationMs: number;
  result?: unknown;
}
```

#### TraceManager：基于 RoundHooks 的追踪实现

```typescript
/**
 * 追踪管理器：通过订阅 RoundHooks 实现闭环追踪
 *
 * 挂载点：订阅 RoundHooks.onPhaseStart/End，自动收集阶段边界时间戳
 * 不依赖核心闭环的任何类型，仅通过 RoundHooks 回调数据推导追踪信息
 */
interface TraceManager {
  /**
   * 订阅 RoundHooks，开始追踪
   */
  attach(hooks: RoundHooks): void;

  /**
   * 获取指定会话的追踪数据
   */
  getTrace(sessionId: string): TraceData | null;

  /**
   * 查询历史追踪
   */
  queryTraces(filter: TraceFilter): Promise<TraceData[]>;
}

interface TraceData {
  traceId: string;
  sessionId: string;
  roundId: string;
  parentRoundId?: string;
  timeline: {
    triggerAt: number;
    prepareStart: number;
    prepareEnd: number;
    actStart: number;
    actEnd: number;
    reflectStart: number;
    reflectEnd: number;
    handoffAt: number;
  };
  events: TraceEvent[];
  errors: { phase: string; message: string; timestamp: number }[];
}

interface TraceEvent {
  type: 'recall' | 'llm_call' | 'tool_call' | 'tool_result' | 'error' | 'interrupt';
  timestamp: number;
  label: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

interface TraceFilter {
  sessionId?: string;
  timeRange?: [number, number];
  traceId?: string;
  hadError?: boolean;
  limit?: number;
}
```

#### MetricCollector：基于 RoundHooks 的指标收集

```typescript
/**
 * 指标收集器：通过订阅 RoundHooks 收集性能指标
 *
 * 挂载点：订阅 RoundHooks.onPhaseEnd，从 phaseEndData.durationMs 推导指标
 * 不依赖核心闭环的任何类型，仅通过 RoundHooks 回调数据计算指标
 */
interface MetricCollector {
  /**
   * 订阅 RoundHooks，开始收集指标
   */
  attach(hooks: RoundHooks): void;

  /**
   * 获取指标快照
   */
  snapshot(): MetricSnapshot;
}

interface MetricSnapshot {
  latencies: Record<string, { p50: number; p95: number; p99: number; count: number }>;
  counters: Record<string, number>;
  gauges: Record<string, number>;
}

/** 预定义指标名称 */
const BUILTIN_METRICS = {
  ROUND_DURATION: 'round.duration',
  PREPARE_DURATION: 'round.prepare_duration',
  ACT_DURATION: 'round.act_duration',
  REFLECT_DURATION: 'round.reflect_duration',
  TOOL_CALLS_TOTAL: 'tool.calls_total',
  TOOL_ERRORS_TOTAL: 'tool.errors_total',
  ROUNDS_TOTAL: 'round.rounds_total',
  ACTIVE_SESSIONS: 'session.active',
  TOKEN_USAGE: 'context.token_usage',
  COST_ACCUMULATED: 'cost.accumulated',
} as const;
```

#### 事件系统：扩展已有 EventEmitter

**SSOT 纪律**：不引入 `EventBus` 接口。扩展现有 `EventEmitter`（`src/utils/eventEmitter.ts`），在 `AGENT_EVENTS` 常量表中注册所有运行时事件类型。

```typescript
/**
 * 在现有 AGENT_EVENTS 中扩展运行时事件类型
 *
 * 现有系统已有 EventEmitter 和 AGENT_EVENTS 常量表。
 * 新增的事件类型直接注册到 AGENT_EVENTS 中，不引入第二套事件系统。
 */
// 在 src/utils/eventEmitter.ts 的 AGENT_EVENTS 中新增：
const AGENT_EVENTS_RUNTIME = {
  // 闭环生命周期事件
  roundTriggered: 'roundTriggered',
  roundPrepareStart: 'roundPrepareStart',
  roundPrepareEnd: 'roundPrepareEnd',
  roundActStart: 'roundActStart',
  roundActEnd: 'roundActEnd',
  roundReflectStart: 'roundReflectStart',
  roundReflectEnd: 'roundReflectEnd',
  roundHandoff: 'roundHandoff',
  roundCompleted: 'roundCompleted',
  roundError: 'roundError',

  // 系统事件
  systemShutdown: 'systemShutdown',
  configReloaded: 'configReloaded',

  // 安全事件
  guardrailBlocked: 'guardrailBlocked',
  guardrailViolation: 'guardrailViolation',

  // 生命周期事件
  sessionCreated: 'sessionCreated',
  sessionArchived: 'sessionArchived',
  sessionRecovered: 'sessionRecovered',
} as const;

// 合并到 AGENT_EVENTS 中
export const AGENT_EVENTS = {
  ...AGENT_EVENTS_CORE,     // 现有事件
  ...AGENT_EVENTS_RUNTIME,  // 新增运行时事件
} as const;
```

```typescript
/**
 * 结构化日志记录器
 * 宿主可对接 winston、pino 等日志库
 */
interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, ctx?: LogContext): void;
}

interface LogContext {
  sessionId?: string;
  traceId?: string;
  roundId?: string;
  phase?: string;
  durationMs?: number;
  error?: Error;
  [key: string]: unknown;
}
```

### 13.5.3 预定义仪表盘

以下指标组合可构成标准监控仪表盘：

```typescript
/**
 * 标准仪表盘指标定义
 * 宿主实现时，按此定义收集和展示指标
 */
const DASHBOARD_DEFINITIONS = {
  /** 核心健康面板 */
  health: {
    roundLatencyP50: { metric: 'round.duration', stat: 'p50', unit: 'ms' },
    roundLatencyP99: { metric: 'round.duration', stat: 'p99', unit: 'ms' },
    errorRate: { metric: 'round.error_total', stat: 'rate', unit: 'rpm' },
    activeSessions: { metric: 'session.active', stat: 'gauge', unit: 'count' },
  },

  /** LLM 性能面板 */
  llmPerformance: {
    firstTokenLatency: { metric: 'llm.first_token_latency', stat: 'p95', unit: 'ms' },
    tokenUsage: { metric: 'context.token_usage', stat: 'gauge', unit: 'tokens' },
    costPerRound: { metric: 'cost.per_round', stat: 'avg', unit: 'currency' },
  },

  /** 工具使用面板 */
  toolUsage: {
    callRate: { metric: 'tool.calls_total', stat: 'rate', unit: 'rpm' },
    errorRate: { metric: 'tool.errors_total', stat: 'rate', unit: 'rpm' },
    topTools: { metric: 'tool.calls_total', stat: 'top_by_label', unit: 'count' },
  },

  /** 队列健康面板 */
  queueHealth: {
    currentDepth: { metric: 'trigger.queue_depth', stat: 'gauge', unit: 'count' },
    droppedRate: { metric: 'trigger.dropped_total', stat: 'rate', unit: 'rpm' },
    maxLatency: { metric: 'trigger.queue_wait_time', stat: 'max', unit: 'ms' },
  },
};
```

### 13.5.4 设计纪律

1. **核心闭环只暴露 RoundHooks**：不引用任何运行时类型，所有可观测性组件通过订阅接入
2. **追踪和指标从阶段边界数据自动推导**：无需手动埋点，`TraceManager` 和 `MetricCollector` 从 `RoundHooks` 回调数据自动计算
3. **事件系统统一使用 EventEmitter**：不引入 `EventBus`，所有事件类型在 `AGENT_EVENTS` 常量表中注册
4. **日志不包含敏感信息**：用户输入内容、LLM 原始输出等不应自动记录到日志中
5. **可观测性数据可配置**：宿主可配置哪些指标需要收集、哪些事件需要订阅

---

## 13.6 热更新

### 13.6.1 问题定义

Agent 系统在运行时，可能需要更新配置而不重启进程：

| 更新场景 | 影响范围 | 风险 |
|---------|---------|------|
| 角色包内容更新 | 新闭环使用新版本 | 新旧版本不一致 |
| L2 策略配置变更 | 全局行为改变 | 正在执行的闭环使用旧策略 |
| 工具注册表变更 | 工具可用性变化 | 工具调用时发现工具不存在 |
| 记忆系统配置变更 | 召回行为变化 | 召回结果不一致 |

### 13.6.2 接口定义

```typescript
/**
 * 版本化配置：所有可热更新的配置项的基类
 *
 * 核心原则：配置变更只影响"新闭环"，不影响"正在执行的闭环"
 */
interface VersionedConfig {
  /** 配置版本号（单调递增） */
  version: number;

  /** 配置生效时间 */
  effectiveAt: number;

  /** 配置变更描述 */
  changelog: string;

  /** 兼容性检查：判断此版本是否与指定版本兼容 */
  isCompatibleWith(otherVersion: number): boolean;
}

/**
 * 配置版本管理器
 */
interface ConfigVersionManager {
  /**
   * 获取当前活跃配置
   * 返回与指定会话版本匹配的配置
   */
  getActiveConfig<T extends VersionedConfig>(
    configType: string,
    sessionVersion?: number
  ): T;

  /**
   * 更新配置
   * 新版本配置发布后，已有会话继续使用旧版本，新会话使用新版本
   */
  updateConfig<T extends VersionedConfig>(
    configType: string,
    newConfig: T
  ): Promise<void>;

  /**
   * 列出所有配置版本
   */
  listVersions(configType: string): ConfigVersion[];

  /**
   * 回滚到指定版本
   */
  rollback(configType: string, targetVersion: number): Promise<void>;
}

interface ConfigVersion {
  configType: string;
  version: number;
  effectiveAt: number;
  changelog: string;
  /** 当前是否活跃（新会话使用此版本） */
  isActive: boolean;
}
```

```typescript
/**
 * 迁移钩子：配置变更时执行的迁移逻辑
 *
 * 职责：配置变更后，需要执行的兼容性迁移
 * 挂载点：ConfigVersionManager.updateConfig 之后
 */
interface MigrationHook {
  /**
   * 注册迁移步骤
   */
  register(
    configType: string,
    fromVersion: number,
    toVersion: number,
    handler: MigrationHandler
  ): void;

  /**
   * 执行从 fromVersion 到 toVersion 的迁移
   * 自动查找并执行所有中间版本迁移
   */
  migrate(
    configType: string,
    fromVersion: number,
    toVersion: number
  ): Promise<void>;
}

type MigrationHandler = (
  context: MigrationContext
) => Promise<void>;

interface MigrationContext {
  configType: string;
  fromVersion: number;
  toVersion: number;
  affectedSessions: string[];
  /** 迁移超时时间 */
  timeoutMs: number;
}
```

```typescript
/**
 * 运行时配置注册表
 * 所有可热更新的配置项在此注册
 */
interface RuntimeConfigRegistry {
  /**
   * 注册一个配置类型
   */
  register(configType: string, options: ConfigRegistration): void;

  /**
   * 获取配置变更事件
   * 宿主可订阅此事件以感知配置变更
   */
  onConfigChanged: EventEmitter['on'];
}
```

### 13.6.3 热更新策略

```
配置更新请求
  │
  ▼
ConfigVersionManager.updateConfig('rolePack', newVersion)
  │
  ├── 1. 版本检查：新版本号 > 当前活跃版本号
  │
  ├── 2. 兼容性检查：isCompatibleWith(currentVersion)
  │
  ├── 3. 发布新版本：标记为"当前活跃版本"
  │     └── 已有会话：继续使用旧版本（不受影响）
  │     └── 新会话：使用新版本
  │
  ├── 4. 迁移执行（如有）：MigrationHook.migrate()
  │     └── 迁移只影响"共享状态"（如记忆系统格式），不影响"会话级状态"
  │
  └── 5. 事件通知：emit(AGENT_EVENTS.configReloaded, { configType, version })
```

### 13.6.4 设计纪律

1. **配置变更不回溯**：已开始的闭环不受配置变更影响
2. **版本号单调递增**：版本号是正整数，严格递增，不可回退（回滚通过发布新版本实现）
3. **迁移是幂等的**：迁移操作可重复执行，多次执行结果相同
4. **配置变更通过事件通知**：宿主可订阅 `AGENT_EVENTS.configReloaded` 事件感知变更（事件名以 §13.5.2 常量表为唯一真理源，禁止自造字面量）
5. **热更新不覆盖文件**：运行时配置变更存储在内存中，宿主决定是否持久化到文件
6. **生效边界告知**：由于"已有会话继续使用旧版本"（§13.6.3），配置变更后宿主**必须**向用户反馈生效范围（"新会话生效 / 当前会话继续用旧配置"）——防止"我改了模型怎么没变"的体验断档。`configReloaded` 事件携带新旧版本号，反馈文案由宿主呈现。

---

## 13.7 多会话隔离

### 13.7.1 问题定义

一个 Agent 实例可能同时服务多个会话，每个会话需要：

| 隔离维度 | 共享 | 隔离 | 说明 |
|---------|------|------|------|
| 内存状态 | 角色包缓存（只读） | 会话上下文、消息记录 | 会话间不应该看到对方的消息 |
| 记忆系统 | 共享记忆存储 | 记忆访问权限 | 会话可以读取共享记忆，但不能写入其他会话的记忆 |
| 资源配额 | 全局资源池 | 会话级配额 | 一个会话不应消耗所有资源 |
| 配置 | 全局配置 | 会话级配置覆盖 | 会话可以有自己的配置覆盖 |

### 13.7.2 接口定义

```typescript
/**
 * 会话作用域：会话级资源隔离的边界
 *
 * 每个会话拥有独立的 SessionScope 实例
 * 会话的整个生命周期内，scope 保持不变
 */
interface SessionScope {
  sessionId: string;

  /** 会话级资源配额 */
  quotas: {
    /** 最大 token 消耗（会话生命周期内） */
    maxTokenConsumption: number;
    /** 最大工具调用次数 */
    maxToolCalls: number;
    /** 最大内存召回条目数 */
    maxRecallItems: number;
    /** 最大闭环运行时间（毫秒） */
    maxRuntimeMs: number;
  };

  /** 当前资源使用量 */
  usage: {
    tokenConsumed: number;
    toolCalls: number;
    runtimeMs: number;
  };

  /**
   * 检查指定资源是否在配额内
   * 返回 QuotaResult 而非抛出异常，与 Guardrail 的 Result 模式一致
   */
  checkQuota(resource: string, delta?: number): QuotaResult;

  /**
   * 记录资源使用
   */
  recordUsage(resource: string, amount: number): void;
}

interface QuotaResult {
  allowed: boolean;
  reason?: string;
  /** 当前使用量 */
  current: number;
  /** 配额上限 */
  limit: number;
}
```

```typescript
/**
 * 隔离上下文：会话间安全的上下文访问
 *
 * 核心原则：通过会话 ID 过滤数据，不在代码中显式检查权限
 */
interface IsolatedContext {
  /** 当前会话 ID */
  readonly sessionId: string;

  /** 只读：会话自己的消息记录 */
  readonly messages: ReadonlyArray<SerializedMessage>;

  /** 只读：会话自己的角色包状态 */
  readonly rolePack: {
    packId: string;
    /** 锁定时的角色包版本（对齐 §13.6 VersionedConfig.version）——热更新后本会话继续使用该版本，恢复/续跑按此取包 */
    version: number;
    lockedAt: number;
    /** 多角色合并列表（§README 9.4 非互斥合并时的共存包，含各自 priority）——空数组 = 未合并 */
    merged: { packId: string; priority: number }[];
  };

  /**
   * 获取当前角色状态（用户侧可见性，§README 4.2/9.3）
   * 返回当前锁定角色包 + 合并列表 + 锁定时间——供宿主展示"当前是什么角色"，
   * 用户无需猜测自己是"工程师+总监"合并态还是单一角色。
   */
  getRoleState(): RoleState;

  /**
   * 安全读取记忆系统
   * 自动按 sessionId 过滤，只会返回当前会话相关的记忆
   * 跨会话共享记忆需显式声明 shareScope
   */
  readMemory(query: MemoryQuery, shareScope?: ShareScope): Promise<MemoryItem[]>;

  /**
   * 安全写入记忆系统
   * 写入时自动标记 sessionId，并**强制校验归属**：item 归属必须等于当前
   * sessionId 或显式 ShareScope 声明的共享域，越权写返回错误而非静默放行
   * （写隔离是硬校验，不是软标记，§13.7.4 纪律 7）
   */
  writeMemory(item: MemoryItem): Promise<void>;
}

type ShareScope =
  | 'session_only'    // 仅当前会话可见（默认）
  | 'user_global'     // 同一用户的所有会话可见
  | 'system_global';  // 所有会话可见（仅限系统级记忆）

/** 角色状态快照（getRoleState 返回值，用户侧展示用） */
interface RoleState {
  /** 当前锁定角色包（无命中时为默认兜底 persona，§README 4.2） */
  primary: { packId: string; version: number; lockedAt: number };
  /** 合并角色包列表（空数组 = 未合并） */
  merged: { packId: string; priority: number }[];
  /** 粘性漂移状态：连续未命中触发词计数 / 漂移阈值 */
  drift: { missCount: number; threshold: number };
}
```

### 13.7.3 隔离模型

```
                    ┌─────────────────────┐
                    │     全局资源池        │
                    │  (LLM 连接数/内存)    │
                    └──────┬──────────────┘
                           │ 按 SessionScope 分配
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
   ┌────────────┐  ┌────────────┐  ┌────────────┐
   │ Session A  │  │ Session B  │  │ Session C  │
   │            │  │            │  │            │
   │ scope.quotas │  │ scope.quotas │  │ scope.quotas │
   │ messages[] │  │ messages[] │  │ messages[] │
   │ rolePack   │  │ rolePack   │  │ rolePack   │
   └────────────┘  └────────────┘  └────────────┘
          │                │                │
          └────────────────┼────────────────┘
                           ▼
                    ┌──────────────┐
                    │  记忆系统     │
                    │(按 sessionId │
                    │  过滤访问)    │
                    └──────────────┘
```

### 13.7.4 设计纪律

1. **会话隔离是默认行为**：所有数据访问默认只限当前会话，跨会话访问需显式声明
2. **资源配额是"软限制"**：超出配额时触发警告而非硬阻断，宿主可配置硬限制
3. **角色包缓存是只读共享**：角色包内容在会话间共享，每个会话的实例状态隔离
4. **会话级配置覆盖不扩散**：会话的配置覆盖只影响本会话，不影响全局配置
5. **隔离通过数据过滤实现**：不在代码中显式检查权限，而是通过 sessionId 自动过滤
6. **全局资源管理由宿主实现**：内核不提供 ResourcePool 抽象，宿主通过 `LockManager` 自行管理全局资源
7. **写隔离是硬校验**：`IsolatedContext.writeMemory` 必须校验写入目标归属（当前 sessionId 或显式共享域），越权写返回错误而非只打标记放行；跨会话共享写入按 §13.3 `LockManager` 资源锁（写锁）互斥执行，防双会话并发写同一记忆

---

## 13.8 输入/输出护栏

### 13.8.1 问题定义

Agent 与外部世界交互时，需要安全的边界控制：

| 防护方向 | 风险 | 示例 |
|---------|------|------|
| 输入防护 | 注入攻击、越狱提示、格式错误 | 用户输入包含系统指令注入 |
| 输出防护 | 敏感信息泄露、不当内容 | Agent 输出包含用户密码 |
| 工具防护 | 危险操作、权限滥用 | 工具调用尝试删除系统文件 |
| 数据防护 | PII 泄露、隐私数据 | 记忆系统返回敏感个人信息 |

### 13.8.2 接口定义

**SSOT 纪律**：不引入护栏插件系统。护栏功能整合到角色包 `rule` 段中，`SecurityGuard` 统一执行所有规则。`SecurityGuard` 已在现有代码中存在（`src/security/pathGuard.ts`），扩展其能力而非引入新系统。

```typescript
/**
 * 安全规则：角色包 rule 段中定义的护栏规则
 *
 * 规则定义在角色包 frontmatter 的 rule 段中，与角色包一起加载。
 * 支持四种规则类型，覆盖输入/输出/工具/数据四个防护方向。
 */
interface SecurityRule {
  /** 规则类型 */
  type: 'input_filter' | 'output_filter' | 'tool_restriction' | 'content_block';
  /** 规则匹配模式（正则表达式或关键词列表） */
  pattern: string | string[];
  /** 匹配时的动作 */
  action: 'BLOCK' | 'LOG' | 'MODIFY';
  /** MODIFY 时的替换内容 */
  replacement?: string;
  /** 规则描述 */
  description: string;
  /** 严重级别 */
  severity?: 'info' | 'warning' | 'error' | 'critical';
  /** 执行优先级（数值越大越先执行，默认 0）——§13.8.3/§13.8.4「按优先级执行」以此字段为唯一依据 */
  priority?: number;
}

/**
 * 安全护栏：统一执行所有安全规则
 *
 * 挂载点：Prepare 阶段开始前（输入检查）、Act 阶段工具调用时（工具检查）、Handoff 前（输出检查）
 * 规则来源：角色包 rule 段（通过 SecurityGuard 加载）
 *
 * SSOT 纪律：这不是插件系统，而是角色包 rule 段的自然扩展。
 * 所有规则在角色包 frontmatter 中声明，与角色包一起版本化。
 */
interface SecurityGuard {
  /**
   * 加载安全规则
   * 从角色包 rule 段中提取规则
   */
  loadRules(rules: SecurityRule[]): void;

  /**
   * 输入安全检查
   * 在 Prepare 阶段前执行
   */
  checkInput(input: GuardrailInput): GuardrailResult;

  /**
   * 输出安全检查
   * 在 Handoff 前执行
   */
  checkOutput(output: GuardrailOutput): GuardrailResult;

  /**
   * 工具调用安全检查
   * 在工具执行前执行
   */
  checkToolCall(toolCall: GuardrailToolCall): GuardrailResult;

  /**
   * 获取检查报告
   */
  getReport(): GuardrailReport;
}

interface GuardrailInput {
  content: string;
  sessionId: string;
  triggerSource: TriggerSource;
  rawContent: string;
}

interface GuardrailOutput {
  content: string;
  sessionId: string;
  tokenCount: number;
  containsToolCalls: boolean;
}

interface GuardrailToolCall {
  toolName: string;
  args: Record<string, unknown>;
  sessionId: string;
  isReadonly: boolean;
}

interface GuardrailResult {
  action: 'ALLOW' | 'BLOCK' | 'MODIFY';
  reason?: string;
  modifiedContent?: string;
  severity?: 'info' | 'warning' | 'error' | 'critical';
}

interface GuardrailReport {
  totalChecks: number;
  blocked: number;
  modified: number;
  allowed: number;
  recentViolations: {
    rule: string;
    type: 'input' | 'output' | 'tool_call';
    reason: string;
    timestamp: number;
  }[];
}
```

**角色包 rule 段中的护栏规则示例**：

```yaml
---
name: 通用助手
rules:
  # 输入过滤：阻止系统指令注入
  - type: input_filter
    pattern: "忽略所有之前的指令|忽略系统提示"
    action: BLOCK
    severity: error

  # 输出过滤：阻止敏感信息泄露
  - type: output_filter
    pattern: "sk-[A-Za-z0-9]{20,}"
    action: BLOCK
    severity: critical

  # 工具限制：只读模式下禁止写操作
  - type: tool_restriction
    pattern: "file_write|file_delete|exec_command"
    action: BLOCK
    severity: error
**执行顺序与规则来源**：

- **检查时机在入队之后、闭环开始之前**：外部输入先经 TriggerQueue 入队（§13.3.3），
  出队后、进入 Prepare 前执行 `checkInput`——BLOCK 的输入已消费队列位置，宿主将拦截信息
  返回触发方即可（不重投队列）。
- **P0 全局规则加载路径**：§9.4.2 的 P0 全局安全规则（宿主全局配置，不可被角色包覆盖）由
  宿主在会话初始化时加载，与角色包 rule 段规则**合并注入**：
  `loadRules([...P0 全局规则, ...角色包规则])`。合并顺序即执行顺序；P0 全局规则应设更高的
  `priority`（见 SecurityRule.priority），确保先于角色包规则执行、不可被覆盖。

---

### 13.8.3 执行流程

```
用户输入
  │
  ▼
SecurityGuard.checkInput()
  └── 按优先级逐条执行 role 段中的 input_filter 规则
      ├── ALLOW → 进入 Prepare 阶段
      │
      └── BLOCK → 返回拦截信息，不进入闭环
             │
             └── emit(AGENT_EVENTS.guardrailBlocked, { type: 'input', reason })

LLM 输出
  │
  ▼
SecurityGuard.checkOutput()
  └── 按优先级逐条执行 role 段中的 output_filter 规则
      ├── ALLOW → 返回给用户
      │
      └── BLOCK → 替换为"内容被拦截"消息
             │
             └── emit(AGENT_EVENTS.guardrailBlocked, { type: 'output', reason })
```

### 13.8.4 设计纪律

1. **护栏是"防御层"不是"业务逻辑"**：护栏不参与决策，只做安全过滤
2. **BLOCK 不抛异常**：返回 `GuardrailResult` 而非抛出异常，让调用方决定处理方式
3. **护栏规则链是顺序的**：按优先级执行，任一 BLOCK 则阻断
4. **MODIFY 是例外**：默认只支持 ALLOW 和 BLOCK，MODIFY 仅用于 `output_filter` 规则
5. **护栏事件必须记录**：每次 BLOCK 都必须通过 EventEmitter 发出事件，供审计

---

## 13.9 性能与延迟目标

### 13.9.1 问题定义

Agent 系统的性能需要显式定义，否则无法判断"是否够快"：

| 性能维度 | 目标 | 度量方式 |
|---------|------|---------|
| 闭环延迟 | 从 Trigger 到 Handoff 的总时间 | 分位数（P50/P95/P99） |
| 首 token 延迟 | 从 LLM 调用到第一个 token 输出 | P50/P95 |
| 召回延迟 | 记忆/摘要召回的总时间 | P50/P95 |
| 上下文装配延迟 | 从 Trigger 到 LLM 调用的准备时间 | P50/P95 |
| 吞吐量 | 单位时间处理的闭环数 | 每秒闭环数（RPS） |

### 13.9.2 接口定义

```typescript
/**
 * 性能预算：闭环各阶段的延迟目标
 *
 * 每个阶段定义 P50 和 P95 延迟目标
 * 超过目标时触发警告
 */
interface PerformanceBudget {
  /** 整体闭环延迟目标 */
  round: {
    p50: number;  // 毫秒
    p95: number;
  };

  /** 各阶段延迟目标 */
  phases: {
    prepare: { p50: number; p95: number };
    act: { p50: number; p95: number };
    reflect: { p50: number; p95: number };
  };

  /** 子操作延迟目标 */
  operations: {
    /** 角色包匹配延迟 */
    rolePackMatch: { p50: number; p95: number };
    /** 记忆召回延迟 */
    recall: { p50: number; p95: number };
    /** 上下文装配延迟 */
    contextAssembly: { p50: number; p95: number };
    /** 摘要生成延迟 */
    summaryGeneration: { p50: number; p95: number };
    /** 记忆提炼延迟 */
    insightExtraction: { p50: number; p95: number };
  };
}

/** 默认性能预算 */
const DEFAULT_PERFORMANCE_BUDGET: PerformanceBudget = {
  round: { p50: 5000, p95: 15000 },    // 闭环 5s/15s
  phases: {
    prepare: { p50: 500, p95: 2000 },   // 准备 0.5s/2s
    act: { p50: 3000, p95: 10000 },     // 执行 3s/10s（含 LLM 调用）
    reflect: { p50: 1000, p95: 3000 },  // 沉淀 1s/3s（含异步摘要）
  },
  operations: {
    rolePackMatch: { p50: 50, p95: 200 },
    recall: { p50: 200, p95: 1000 },
    contextAssembly: { p50: 100, p95: 500 },
    summaryGeneration: { p50: 500, p95: 2000 },
    insightExtraction: { p50: 500, p95: 2000 },
  },
};
```

```typescript
/**
 * 吞吐量配置
 */
/**
 * 吞吐量配置：TriggerQueue（§13.3.3）宿主实现的容量/背压契约
 *
 * 消费方：宿主在实现 TriggerQueue 时读取——
 * - maxQueueDepth / backpressureThreshold：队列容量上限与拒绝阈值（accepted:false，§13.3.5 纪律 4）
 * - maxConcurrentRounds：跨会话并行上限（宿主调度器参考值，决定同时出队数）
 * - targetRPS：性能目标（§13.9.1 度量口径），供宿主容量规划
 */
interface ThroughputProfile {
  /** 最大并发闭环数 */
  maxConcurrentRounds: number;
  /** 目标吞吐量（每秒闭环数） */
  targetRPS: number;
  /** 最大排队深度 */
  maxQueueDepth: number;
  /** 背压阈值：队列深度超过此值时开始拒绝新 Trigger */
  backpressureThreshold: number;
}
```

### 13.9.3 性能预算与角色包集成

在 L2 策略层中新增性能相关维度：

| 策略维度 | 类型 | 默认值 | 说明 |
|---------|------|--------|------|
| `performance.targetLatency` | 枚举 | normal / fast / background | 延迟目标等级 |
| `performance.maxRoundDuration` | 毫秒 | 30000 | 单轮闭环最大执行时间 |
| `performance.recallTimeout` | 毫秒 | 2000 | 召回超时时间 |

性能目标是宿主级配置，角色包只声明"期望等级"：

```typescript
type LatencyTier = 'normal' | 'fast' | 'background';

const LATENCY_TIER_MAP: Record<LatencyTier, Partial<PerformanceBudget>> = {
  normal: {
    round: { p50: 5000, p95: 15000 },
    phases: { prepare: { p50: 500, p95: 2000 }, act: { p50: 3000, p95: 10000 }, reflect: { p50: 1000, p95: 3000 } },
  },
  fast: {
    round: { p50: 2000, p95: 5000 },
    phases: { prepare: { p50: 200, p95: 1000 }, act: { p50: 1000, p95: 3000 }, reflect: { p50: 500, p95: 1500 } },
  },
  background: {
    round: { p50: 15000, p95: 60000 },
    phases: { prepare: { p50: 1000, p95: 5000 }, act: { p50: 10000, p95: 30000 }, reflect: { p50: 3000, p95: 10000 } },
  },
};
```

### 13.9.4 设计纪律

1. **性能目标不是 SLA**：目标是指导性指标，不是硬性承诺
2. **延迟目标分等级**：不同场景有不同的延迟要求（如对话模式需要 fast，后台摘要需要 background）
3. **性能预算可配置**：宿主可根据部署环境调整性能目标
4. **性能指标必须可观测**：所有性能指标通过 MetricCollector 收集
5. **超时是硬限制**：`maxRoundDuration` 超过时，闭环在**当前阶段边界收口**——不再开启新阶段、等待在飞 LLM 调用自然返回后停止，并记为超时失败；不强行掐断在飞调用。这与 §13.3.5 纪律 1「不中断正在执行的闭环」、§13.4.4 纪律 1「软着陆」一致：并发准入与超时兜底都在阶段边界生效，不在执行中途插入操作。
6. **暂停不计入运行时长**：`maxRoundDuration` 计时只计 RUNNING 态；会话进入 PAUSED（§13.3.6）期间计时冻结，恢复后续计——避免长暂停后 resume 立即超时。含暂停的总时长上限由宿主在会话级另行约束（`SessionScope.maxRuntimeMs` 亦不含暂停）。

---

## 13.10 测试策略

### 13.10.1 问题定义

Agent 系统的测试面临特殊挑战：

| 挑战 | 原因 | 对策 |
|------|------|------|
| LLM 输出不可预测 | 同一输入可能产生不同输出 | 使用确定性 mock |
| 工具调用链复杂 | 多步工具调用可能产生各种路径 | 场景化测试夹具 |
| 需要真实环境 | 记忆系统、角色包等依赖环境 | 分层测试（单元/集成/e2e） |
| 时序敏感 | 并发、超时等行为依赖时间 | 模拟时钟 |

### 13.10.2 接口定义

```typescript
/**
 * 闭环测试夹具：闭环的完整输入/输出定义
 *
 * 用途：定义一个闭环的测试场景，包含所有输入条件和期望输出
 */
interface RoundFixture {
  /** 测试场景名称 */
  name: string;
  /** 场景描述 */
  description: string;

  /** 前置条件 */
  setup: {
    /** 模拟的会话状态 */
    sessionState?: Partial<SessionState>;
    /** 模拟的角色包 */
    rolePacks?: TestRolePack[];
    /** 模拟的对话历史 */
    history?: SerializedMessage[];
    /** 模拟的记忆数据 */
    memories?: MemoryItem[];
    /** 模拟的摘要数据 */
    summaries?: SummaryItem[];
  };

  /** 输入 */
  input: {
    /** 用户输入 */
    content: string;
    /** 触发源 */
    triggerSource?: TriggerSource;
    /** 额外参数 */
    metadata?: Record<string, unknown>;
  };

  /** 期望输出 */
  expected: {
    /** 期望的最终输出（正则匹配） */
    outputPattern?: RegExp;
    /** 期望的工具调用 */
    toolCalls?: ExpectedToolCall[];
    /** 期望的 Handoff 策略 */
    handoffStrategy?: 'wait' | 'loop' | 'end';
    /** 期望的上下文预算使用 */
    budgetUsage?: { tokenUsed?: number; summaryCount?: number; memoryCount?: number };
    /** 期望的状态变更 */
    stateChanges?: Record<string, unknown>;
  };

  /** Mock 配置 */
  mocks: {
    /** LLM 返回 mock */
    llmResponses: MockLlmResponse[];
    /** 工具执行 mock */
    toolResults: MockToolResult[];
    /** 召回 mock */
    recallResults?: MockRecallResult[];
  };
}

interface SessionState {
  /** 会话 ID——RoundHooks.onHandoff 的 state 据此可被 TraceManager 按会话索引（getTrace(sessionId)） */
  sessionId: string;
  messages: SerializedMessage[];
  rolePackId: string;
  contextBudget: number;
  totalCost: number;
}

interface TestRolePack {
  id: string;
  persona: string;
  rules: string[];
  skills: string[];
  l2Config: Record<string, unknown>;
}

interface ExpectedToolCall {
  name: string;
  args?: Record<string, unknown>;
  /** 是否期望此工具调用 */
  expect: 'called' | 'not_called';
  /** 调用次数 */
  callCount?: number;
}

interface MockLlmResponse {
  /** 匹配输入的正则 */
  inputPattern: RegExp;
  /** Mock 输出 */
  output: string;
  /** 模拟的延迟（毫秒） */
  delayMs?: number;
  /** 模拟工具调用 */
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}

interface MockToolResult {
  name: string;
  argsPattern?: RegExp;
  /** 模拟返回结果 */
  result: unknown;
  /** 模拟错误 */
  error?: string;
  /** 模拟延迟 */
  delayMs?: number;
}

interface MockRecallResult {
  memories?: MemoryItem[];
  summaries?: SummaryItem[];
  delayMs?: number;
}
```

```typescript
/**
 * Mock LLM 提供者：用于测试的确定性 LLM 实现
 *
 * 职责：替代真实 LLM 调用，提供可控的测试输出
 */
interface MockLlmProvider {
  /**
   * 注册 mock 响应
   */
  registerResponse(response: MockLlmResponse): void;

  /**
   * 批量注册（从 RoundFixture 加载）
   */
  loadFixture(fixture: RoundFixture): void;

  /**
   * 获取调用历史（用于断言）
   */
  getCallHistory(): LlmCallRecord[];

  /**
   * 重置
   */
  reset(): void;
}

interface LlmCallRecord {
  input: string;
  output: string;
  timestamp: number;
  durationMs: number;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
}
```

```typescript
/**
 * 场景构建器：构建复杂测试场景
 *
 * 用途：将多个 RoundFixture 串联成完整的测试场景
 * 支持多轮对话测试、Loop 测试、异常恢复测试等
 */
interface ScenarioBuilder {
  /**
   * 添加一轮测试
   */
  addRound(fixture: RoundFixture): ScenarioBuilder;

  /**
   * 设置场景级配置
   */
  setConfig(config: ScenarioConfig): ScenarioBuilder;

  /**
   * 运行场景
   */
  run(): Promise<ScenarioResult>;

  /**
   * 断言场景结果
   */
  assert(result: ScenarioResult): void;
}

interface ScenarioConfig {
  /** 最大允许轮数 */
  maxRounds?: number;
  /** 是否严格匹配顺序 */
  strictRoundOrder?: boolean;
  /** 超时时间 */
  timeoutMs?: number;
  /** 模拟时钟 */
  useMockClock?: boolean;
}

interface ScenarioResult {
  rounds: {
    input: string;
    output: string;
    handoff: string;
    durationMs: number;
    passed: boolean;
    errors: string[];
  }[];
  totalDurationMs: number;
  passed: boolean;
  summary: string;
}
```

### 13.10.3 测试层次

```
测试层次（从底向上）：

Layer 1: 单元测试 ── 测试单个组件
  ├── 测试 ContextBudgetConfig 计算逻辑
  ├── 测试截断选择算法
  ├── 测试角色包匹配逻辑
  └── 测试 Handoff 决策逻辑

Layer 2: 闭环测试 ── 测试单轮闭环
  ├── 使用 RoundFixture 定义场景
  ├── 使用 MockLlmProvider 替代 LLM
  ├── 测试完整的三阶段流程
  └── 测试边界条件（空输入、超长输入、工具调用失败）

Layer 3: 场景测试 ── 测试多轮交互
  ├── 使用 ScenarioBuilder 构建多轮场景
  ├── 测试对话模式（wait → wait → end）
  ├── 测试 Loop 模式（loop → loop → end）
  └── 测试异常恢复（error → recover → continue）

Layer 4: 集成测试 ── 测试真实组件
  ├── 使用真实记忆系统（内存实现）
  ├── 使用真实角色包（测试文件）
  ├── 测试并发控制（多 Trigger 同时到达）
  └── 测试优雅关闭（中途关闭进程）

Layer 5: E2E 测试 ── 测试完整系统
  ├── 使用真实 LLM（可选，需 API Key）
  ├── 测试完整的使用流程
  └── 测试宿主集成
```

### 13.10.4 设计纪律

1. **Mock LLM 是确定性的**：相同的输入必须返回相同的输出
2. **测试夹具可序列化**：`RoundFixture` 可保存为 JSON 文件，用于回归测试
3. **闭环测试不依赖真实 LLM**：所有闭环逻辑测试使用 MockLlmProvider
4. **场景测试覆盖关键路径**：至少覆盖正常路径、异常路径、边界条件
5. **测试报告包含追踪信息**：失败的测试应包含完整的 RoundTrace 信息

---

## 13.11 版本兼容与迁移

### 13.11.1 问题定义

随着系统演進，需要保证不同版本之间的兼容性：

| 兼容场景 | 风险 | 对策 |
|---------|------|------|
| 角色包格式升级 | 旧角色包无法加载 | 版本化格式 + 迁移脚本 |
| 记忆系统数据结构变更 | 旧记忆数据无法读取 | 数据迁移 |
| L2 策略维度增减 | 旧策略配置缺失维度 | 默认值回退 |
| 接口签名变更 | 宿主代码编译失败 | 接口版本化 |

### 13.11.2 接口定义

```typescript
/**
 * 角色包版本
 */
interface RolePackVersion {
  /** 角色包格式版本（语义化版本） */
  formatVersion: string;   // e.g., "1.0.0"
  /** 最低兼容的内核版本 */
  minKernelVersion: string; // e.g., "2.0.0"
  /** 变更历史 */
  changelog: VersionEntry[];
}

interface VersionEntry {
  version: string;
  date: string;
  changes: string[];
  /** 是否向后兼容 */
  backwardCompatible: boolean;
}

/** 当前角色包格式版本 */
const CURRENT_ROLE_PACK_VERSION = '1.0.0';

/** 版本兼容性检查 */
function isRolePackCompatible(
  packFormatVersion: string,
  kernelVersion: string
): boolean {
  // 语义化版本比较逻辑
  // 主版本号相同 → 兼容
  // 主版本号不同 → 不兼容
  const [packMajor] = packFormatVersion.split('.');
  const [kernelMajor] = kernelVersion.split('.');
  return packMajor === kernelMajor;
}
```

```typescript
/**
 * 迁移计划：定义从旧版本到新版本的迁移步骤
 */
interface MigrationPlan {
  /** 迁移计划 ID */
  id: string;
  /** 迁移描述 */
  description: string;
  /** 源版本 */
  fromVersion: string;
  /** 目标版本 */
  toVersion: string;
  /** 迁移步骤（按顺序执行） */
  steps: MigrationStep[];

  /** 验证迁移是否成功 */
  verify(): Promise<boolean>;
  /** 执行迁移 */
  execute(): Promise<void>;
  /** 回滚迁移 */
  rollback(): Promise<void>;
}

interface MigrationStep {
  name: string;
  type: 'data' | 'config' | 'schema' | 'code';
  description: string;
  /** 迁移操作 */
  migrate: () => Promise<void>;
  /** 回滚操作 */
  rollback?: () => Promise<void>;
  /** 是否必须成功 */
  critical: boolean;
  /** 预计影响范围 */
  impact: 'none' | 'low' | 'medium' | 'high';
}
```

```typescript
/**
 * 版本注册表：管理所有版本化组件的版本信息
 */
interface VersionRegistry {
  /**
   * 注册组件版本
   */
  register(component: string, version: string): void;

  /**
   * 获取组件版本
   */
  getVersion(component: string): string;

  /**
   * 检查兼容性
   * @returns 兼容性检查结果
   */
  checkCompatibility(
    component: string,
    requiredVersion: string
  ): CompatibilityResult;

  /**
   * 获取所有组件的版本信息
   */
  getAllVersions(): Record<string, string>;
}

interface CompatibilityResult {
  compatible: boolean;
  currentVersion: string;
  requiredVersion: string;
  reason?: string;
  /** 建议的迁移路径 */
  suggestedMigration?: MigrationPlan;
}
```

### 13.11.3 版本化策略

```
版本化策略：

角色包格式：
  major.minor.patch
  - major：不兼容的格式变更（需要迁移）
  - minor：向后兼容的新增字段
  - patch：bug 修复，无字段变更

内核 API：
  major.minor.patch
  - major：不兼容的接口变更
  - minor：向后兼容的新增接口
  - patch：内部实现变更，接口不变

记忆系统数据：
  schema_version（单一整数，单调递增）
  - 每次数据格式变更时递增
  - 旧数据在读取时自动迁移到新格式

检查点与热更新配置：
  schemaVersion / version（单一整数，单调递增）
  - 检查点：SessionCheckpoint.schemaVersion，迁移经 checkpointMigrations（project-rules §1.8）
  - 热更新配置：VersionedConfig.version（§13.6）
```

**版本格式边界**：semver 仅用于**外部可交付物格式**（角色包格式、内核 API 契约），
主版本相同即兼容；单一整数仅用于**内核内部持久化状态**（检查点 schemaVersion、
热更新配置 version、记忆 schema_version），仅比较大小、迁移逐版执行。
`VersionRegistry` 按组件记录其版本格式，兼容性检查按格式分派——两种格式不混用比较。

### 13.11.4 设计纪律

1. **主版本号相同即兼容**：主版本号不同时，需要执行迁移
2. **迁移是可逆的**：每个迁移步骤必须提供回滚操作
3. **默认值回退**：新增的 L2 策略维度必须有默认值，旧配置缺失时使用默认值
4. **版本信息可观测**：所有组件的版本信息通过 `VersionRegistry` 可查询
5. **迁移是幂等的**：多次执行迁移操作结果相同

---

## 关联文档索引

| 文档 | 用途 | 路径 |
|------|------|------|
| 架构说明书（核心） | 核心闭环设计、角色包体系、上下文预算 | [docs/architecture/README.md](README.md) |
| 运行时架构（本文） | 并发、关闭、可观测、热更新、隔离、护栏、性能、测试、版本 | 本文 |
| 设计推导（叙事） | 从公理到完整的推导过程 | [docs/agent-design/README.md](../agent-design/README.md) |
| 思维模型（方法论） | 单一真理源思维模型的完整规则 | [.trae/rules/single-truth-source-mindset.md](../../.trae/rules/single-truth-source-mindset.md) |
| API 参考 | 接口和类型定义（现状快照） | [docs/memora-api-reference.md](../memora-api-reference.md) |
| 重构路线图（实施） | 6 阶段重构 + SSOT 违规记录（长期实施计划） | [docs/refactoring-roadmap.md](../refactoring-roadmap.md) |
| P1 修复实施计划 | 2026-08-11 审查的一次性补丁方案（独立于阶段序列） | [docs/P1-实施计划.md](../P1-实施计划.md) |
| 第三方独立审查 | 2026-08-12 架构文档体系审查（含修复状态追踪表） | [docs/third-party-architecture-review-2026-08-12.md](../third-party-architecture-review-2026-08-12.md) |
| ADR 决策库 | 架构决策记录（决策真理源，`decisions/`） | [.trae/decisions/README.md](../../.trae/decisions/README.md) |