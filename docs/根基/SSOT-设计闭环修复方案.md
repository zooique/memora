# SSOT 与设计闭环修复方案

> 基于 Memora 项目 SSOT 和设计闭环审查报告，生成的具体修复方案。
> 涵盖 6 个待修复问题，每个问题包含：问题定位、修复方案、测试设计、代码变更清单。

---

## 目录

- [P0-1: MemoryRelation 孤儿边清理](#p0-1-memoryrelation-孤儿边清理)
- [P0-2: 运行时暂停超时检测](#p0-2-运行时暂停超时检测)
- [P1-1: refreshBootstrapMemories 改为必选](#p1-1-refreshbootstrapmemories-改为必选)
- [P1-2: goalVersion 漂移强制暂停](#p1-2-goalversion-漂移强制暂停)
- [P2-1: consecutivePauseCount 时间衰减](#p2-1-consecutivepausecount-时间衰减)
- [P2-2: ChatMessage 增加 name 字段](#p2-2-chatmessage-增加-name-字段)
- [任务推进排序](#任务推进排序)

---

## P0-1: MemoryRelation 孤儿边清理

### 问题定位

**文件：** [memoryInspector.ts](file:///f:/zooique/memora/src/agent/managers/memoryInspector.ts)

当前 `IMemoryStorage.delete()` 和 `IMemoryStorage.purge()` 只操作记忆本身，不清理关联的关系边。关系清理只在 `writePurgeExpired()` 中处理（第 695-730 行），但 **软删除路径（delete）和物理删除路径（purge）都没有自动清理关系边**。

具体受影响的调用链：
- `ConfigManager.deleteRule()` → `index.delete(id)` → 关系边残留
- `ConfigManager.deleteSkill()` → `index.delete(id)` → 关系边残留
- `memoryInspector.writeDeleteMemory()` → `index.delete()` → 关系边残留
- `memoryInspector.writePurgeMemory()` → `index.purge()` → 关系边残留

### 修复方案

**方案：在 memoryInspector 中增强代理方法，delete/purge 时自动清理关系边。**

`memoryInspector` 已经持有 `relationStore` 引用，且已经有 `writeRemoveRelationsByMemoryId` 代理方法。只需在 `writeDeleteMemory` 和 `writePurgeMemory` 方法中，在调用 `index.delete()` / `index.purge()` 之前先清理关系边。

#### 变更清单

**文件 1：`src/agent/managers/memoryInspector.ts`**

```typescript
// 现有 writeDeleteMemory 方法增强（约第 680 行附近）
/**
 * 删除记忆（软删除），自动清理关系边
 *
 * 覆盖 IMemoryStorage.delete() 的纯存储操作，在软删除记忆前
 * 先清理关联的所有关系边，防止 memory_relations 表残留孤儿边。
 *
 * @param id - 记忆 ID
 */
writeDeleteMemory(id: string): void {
  // 先清理关系边（relationStore 未注入时降级）
  this.writeRemoveRelationsByMemoryId(id);
  // 再软删除记忆
  this.index.delete(id);
}

// 新增 writePurgeMemory 增强方法
/**
 * 物理删除记忆，自动清理关系边
 *
 * 覆盖 IMemoryStorage.purge() 的纯存储操作，在物理删除记忆前
 * 先清理关联的所有关系边，防止 memory_relations 表残留孤儿边。
 * purgeExpired 的路径已由 writePurgeExpired 处理，此方法处理单条 purge。
 *
 * @param id - 记忆 ID
 */
writePurgeMemory(id: string): void {
  // 先清理关系边（relationStore 未注入时降级）
  this.writeRemoveRelationsByMemoryId(id);
  // 再物理删除记忆
  this.index.purge(id);
}
```

**文件 2：`src/agent/managers/sessionArchiver.ts`（或其他调用 index.delete 的地方）**

搜索所有直接调用 `index.delete()` 或 `index.purge()` 的地方，替换为 `memoryInspector.writeDeleteMemory()` 或 `memoryInspector.writePurgeMemory()`。

### 测试设计

| # | 测试用例 | 验证点 |
|---|---------|--------|
| 1 | 软删除记忆时自动清理关系边 | `writeDeleteMemory('mem1')` 后，`relationStore.getRelations('mem1')` 返回空数组 |
| 2 | 物理删除记忆时自动清理关系边 | `writePurgeMemory('mem1')` 后，`relationStore.getRelations('mem1')` 返回空数组 |
| 3 | relationStore 未注入时降级 | `relationStore = null` 时，`writeDeleteMemory('mem1')` 不抛错，正常执行 delete |
| 4 | 无关系边的记忆删除时不触发清理 | 记忆无关联关系边时，`writeDeleteMemory` 正常执行，`removeRelationsByMemoryId` 返回 0 |
| 5 | 多条关系边的记忆全部清理 | 记忆有 3 条关联关系边，`writeDeleteMemory` 后 `getAllRelations` 中不再包含这 3 条 |
| 6 | 已有 writePurgeExpired 不受影响 | `writePurgeExpired` 的清理逻辑不重复执行关系清理 |
| 7 | 现有 ConfigManager CRUD 路径覆盖 | `deleteRule` 后 `relationStore.getRelations` 返回空（集成测试） |

**测试文件：** `src/agent/managers/__tests__/memoryInspector.test.ts`（新增或扩展现有文件）

---

## P0-2: 运行时暂停超时检测

### 问题定位

**文件：** [sessionManager.ts](file:///f:/zooique/memora/src/agent/managers/sessionManager.ts)

`isPauseTimedOut()`（第 1162-1165 行）只在两个时机被调用：
1. `loadPersistedCheckpoint()`（第 386 行）—— Agent 初始化时
2. `resume()`（第 560 行）—— 用户主动恢复时

**运行时缺陷：** 会话暂停后，如果用户长时间不操作（超 30 分钟），没有自动检测机制。暂停的会话会一直停留在 PAUSED 状态，直到用户主动恢复或重启 Agent。

### 修复方案

**方案：在 SessionManager 中添加暂停超时定时器（setInterval），只在 paused 状态时生效。**

添加一个 `_pauseTimeoutTimer` 字段，在 `pause()` 方法中启动定时器，在 `resume()` 或 `destroy()` 中清除。定时器定期检查 `isPauseTimedOut()`，超时后自动清理。

#### 变更清单

**文件：`src/agent/managers/sessionManager.ts`**

```typescript
// 新增字段（约第 95 行附近）
/** 暂停超时检测定时器（只在 paused 状态时运行） */
private _pauseTimeoutTimer: ReturnType<typeof setInterval> | null = null;

/** 暂停超时检测间隔（毫秒）。30 秒检测一次心跳。 */
private static readonly PAUSE_TIMEOUT_CHECK_INTERVAL = 30_000;

// pause() 方法增强（第 525 行附近）
pause(reason: string, source: PauseSource = 'user', lowRisk: boolean = false): boolean {
  const result = this.stateMachine.pause(reason, source);
  if (result.allowed) {
    this.createCheckpoint();
    if (!lowRisk) {
      this.consecutivePauseCount++;
    }
    // 启动暂停超时检测定时器
    this.startPauseTimeoutTimer();
    this.emitEvent('sessionPaused', { ... });
  }
  return result.allowed;
}

// resume() 方法增强（第 558 行附近）
resume(): boolean {
  // 暂停超时阻止恢复
  if (this.checkpoint && this.isPauseTimedOut(this.checkpoint)) {
    // ... 现有逻辑不变
    return false;
  }
  const result = this.stateMachine.resume();
  if (result.allowed) {
    // 清除暂停超时定时器
    this.stopPauseTimeoutTimer();
    // ... 现有逻辑不变
  }
  return result.allowed;
}

// 新增方法
/**
 * 启动暂停超时检测定时器
 *
 * 只在 paused 状态运行时生效，定期检查心跳是否超时。
 * 超时后自动清理检查点、重置状态机、发射事件。
 * 防止暂停会话长时间占用资源。
 */
private startPauseTimeoutTimer(): void {
  this.stopPauseTimeoutTimer(); // 确保不重复启动
  this._pauseTimeoutTimer = setInterval(() => {
    if (!this.checkpoint) return;
    if (!this.isPauseTimedOut(this.checkpoint)) return;
    
    // 暂停超时，自动清理
    const sessionId = this.checkpoint.sessionId;
    const pauseDuration = Date.now() - this.checkpoint.lastHeartbeat;
    
    logger.warn(
      { sessionId, pauseDuration },
      '运行时检测到暂停超时，自动清理检查点',
    );
    
    // 清理检查点
    if (this.sessionStore?.deleteCheckpoint) {
      this.sessionStore.deleteCheckpoint(sessionId);
    }
    
    // 重置运行时状态
    this.checkpoint = null;
    
    // 重置状态机到 running（不保留 paused 状态）
    // 由于状态机没有 directSet 方法，通过 resume 恢复
    // 但 resume 会检查 isPauseTimedOut，所以需要直接操作状态机
    // 这里使用一个内部重置方法
    this.forceResetStateMachine();
    
    // 发射事件
    this.emitEvent('sessionPauseTimedOut', { sessionId, pauseDuration });
    
    // 停止定时器
    this.stopPauseTimeoutTimer();
  }, SessionManager.PAUSE_TIMEOUT_CHECK_INTERVAL);
}

/**
 * 停止暂停超时检测定时器
 */
private stopPauseTimeoutTimer(): void {
  if (this._pauseTimeoutTimer) {
    clearInterval(this._pauseTimeoutTimer);
    this._pauseTimeoutTimer = null;
  }
}

/**
 * 强制重置状态机到 running 状态
 *
 * 用于暂停超时场景：不经过正常的 resume 流程（会检查 isPauseTimedOut），
 * 直接重置状态机，使会话可以重新开始。
 */
private forceResetStateMachine(): void {
  // 通过状态机恢复，但需要绕过 paused 检查
  // 方案：直接设置状态机内部状态
  // 由于状态机没有公开的 reset 方法，通过反射访问
  // 更好的方案：在 SessionStateMachine 中增加公开的 reset 方法
  // 这里先使用类型断言方案
  (this.stateMachine as unknown as { currentStatus: string }).currentStatus = 'running';
  (this.stateMachine as unknown as { pauseReason: null }).pauseReason = null;
  (this.stateMachine as unknown as { pauseSource: null }).pauseSource = null;
}

// destroy() 或 close() 方法中清理定时器
destroy(): void {
  this.stopPauseTimeoutTimer();
}
```

**注意：** 上述 `forceResetStateMachine` 使用了类型断言，不够优雅。更好的方案是在 `SessionStateMachine` 中增加一个公开的 `reset()` 方法：

```typescript
// 在 sessionStateMachine.ts 中新增
/**
 * 重置状态机到 running 状态（用于暂停超时等强制清理场景）
 *
 * 注意：此方法跳过所有状态转换校验，仅用于强制清理。
 * 正常场景应使用 pause()/resume()/triggerError()/recover()。
 */
resetToRunning(): void {
  this.currentStatus = 'running';
  this.pauseReason = null;
  this.pauseSource = null;
  this.errorCause = null;
}
```

### 测试设计

| # | 测试用例 | 验证点 |
|---|---------|--------|
| 1 | 暂停后超时，定时器检测到并自动清理 | `pause()` 后快进时间超过 `PAUSE_TIMEOUT_MS`，检查点被清理，状态机回到 running |
| 2 | 暂停后在超时前恢复，不触发超时 | `pause()` 后立即 `resume()`，定时器不触发清理 |
| 3 | 运行中状态不触发超时检测 | 状态为 running 时，即使长时间无心跳，定时器也不触发 |
| 4 | 超时后发射 pauseTimedOut 事件 | `emitEvent` 被调用，事件名为 `'sessionPauseTimedOut'` |
| 5 | 超时后检查点被清理 | `sessionStore.deleteCheckpoint` 被调用 |
| 6 | 定时器不重复启动 | 连续调用 `pause()` 两次，定时器只启动一个实例 |
| 7 | destroy 时清理定时器 | `destroy()` 后定时器被清除，不触发回调 |

**测试文件：** `src/agent/managers/__tests__/sessionManager.test.ts`（扩展现有文件）

---

## P1-1: refreshBootstrapMemories 改为必选

### 问题定位

**文件：** [configManager.ts](file:///f:/zooique/memora/src/agent/managers/configManager.ts)

`ConfigManager` 构造函数的第 5 个参数 `refreshBootstrapMemories` 当前为可选（第 95 行）：

```typescript
private readonly refreshBootstrapMemories?: () => void,
```

但该方法在 `deleteRule`（第 327 行）、`updateRule`（第 370 行）、`deleteSkill`（第 405 行）中都被调用：`this.refreshBootstrapMemories?.()`。

**SSOT 违反：** 如果未注入此回调，CRUD 操作后 system prompt 中的 bootstrap 段不会同步。虽然 `assembler.ts` 实际传入时非空（第 246 行），但类型签名允许不传，埋下隐患。

### 修复方案

**方案：将 refreshBootstrapMemories 改为必选参数。**

#### 变更清单

**文件 1：`src/agent/managers/configManager.ts`**

```typescript
// 构造函数（第 95 行）
// 修改前：
private readonly refreshBootstrapMemories?: () => void,
// 修改后：
private readonly refreshBootstrapMemories: () => void,

// 调用处（第 327/370/405 行）
// 修改前：
this.refreshBootstrapMemories?.();
// 修改后：
this.refreshBootstrapMemories();
```

**文件 2：`src/agent/managers/__tests__/configManager.test.ts`**

测试中创建 ConfigManager 的方式需要适配：

```typescript
// 修改前（第 30-34 行）：
manager = new ConfigManager(
  storage,
  skillManager,
  (msg) => { systemMessages.push(msg); },
);

// 修改后：
manager = new ConfigManager(
  storage,
  skillManager,
  (msg) => { systemMessages.push(msg); },
  undefined, // writeConfigFile
  vi.fn(),   // refreshBootstrapMemories（必选）
);
```

### 测试设计

| # | 测试用例 | 验证点 |
|---|---------|--------|
| 1 | 构造时必传 refreshBootstrapMemories | 不传时 TypeScript 编译错误 |
| 2 | deleteRule 后触发 refreshBootstrapMemories | `deleteRule` 调用后，`refreshBootstrapMemories` 被调用 |
| 3 | updateRule 后触发 refreshBootstrapMemories | `updateRule` 调用后，`refreshBootstrapMemories` 被调用 |
| 4 | deleteSkill 后触发 refreshBootstrapMemories | `deleteSkill` 调用后，`refreshBootstrapMemories` 被调用 |
| 5 | 现有测试适配新构造签名 | 所有现有测试通过编译 |

**测试文件：** `src/agent/managers/__tests__/configManager.test.ts`（扩展现有文件）

---

## P1-2: goalVersion 漂移强制暂停

### 问题定位

**文件：** [sessionManager.ts](file:///f:/zooique/memora/src/agent/managers/sessionManager.ts)

`updateGoal()` 方法（第 697-731 行）检测到漂移后只发射 `goalDriftDetected` 事件，**不自动暂停**。宿主需要自行监听事件并调用 `pause()`，但内核没有提供自动暂停机制，导致漂移检测的闭环不完整。

### 修复方案

**方案：在 updateGoal 中，当检测到 drift 级别时自动触发 pause()。**

保持 `confirm` 级别为通知性（仅发射事件），`drift` 级别自动暂停。

#### 变更清单

**文件：`src/agent/managers/sessionManager.ts`**

```typescript
// updateGoal 方法增强（第 697 行附近）
updateGoal(newGoal: string): GoalConsistencyResult | null {
  if (!this.checkpoint) {
    this.createCheckpoint(newGoal);
    return null;
  }

  const mainGoal = this.checkpoint.mainGoal;
  const consistencyResult = this.consistencyChecker.checkConsistency(mainGoal, newGoal);

  this.checkpoint.currentGoal = newGoal;
  this.checkpoint.goalVersion++;
  this.checkpoint.lastHeartbeat = Date.now();

  this.emitEvent('goalUpdated', { ... });

  // P3.1：若检测到漂移，发射事件并自动暂停
  if (consistencyResult.level !== 'same') {
    this.emitEvent('goalDriftDetected', { ... });

    // 新增：drift 级别自动暂停（强制用户确认）
    if (consistencyResult.level === 'drift') {
      const pauseReason = `目标漂移：新目标与原始目标不一致（相似度 ${consistencyResult.similarity.toFixed(2)}）`;
      // 使用低风险暂停（不计入连续暂停计数），因为漂移是系统触发而非用户主动
      this.pause(pauseReason, 'system', true);
    }
  }

  return consistencyResult;
}
```

**注意：** 使用 `lowRisk = true`（低风险暂停），因为漂移是系统检测到的，不应计入用户的连续暂停计数。

### 测试设计

| # | 测试用例 | 验证点 |
|---|---------|--------|
| 1 | drift 级别时自动暂停 | `updateGoal('完全不同的目标')` 后，`stateMachine.status` 为 `'paused'` |
| 2 | confirm 级别时不自动暂停 | `updateGoal('相似但略有不同的目标')` 后，`stateMachine.status` 为 `'running'` |
| 3 | same 级别时不触发任何操作 | `updateGoal('相同目标')` 后，不发射 `goalDriftDetected` 事件，不暂停 |
| 4 | 自动暂停时发射 goalDriftDetected 事件 | `emitEvent` 被调用，事件名为 `'goalDriftDetected'` |
| 5 | 自动暂停使用低风险 | `pause` 被调用时 `lowRisk = true`，`consecutivePauseCount` 不增加 |
| 6 | 无检查点时 updateGoal 不触发暂停 | 首次调用 `updateGoal`（`checkpoint` 为 null），不触发任何暂停 |

**测试文件：** `src/agent/managers/__tests__/sessionManager.test.ts`（扩展现有文件）

---

## P2-1: consecutivePauseCount 时间衰减

### 问题定位

**文件：** [sessionManager.ts](file:///f:/zooique/memora/src/agent/managers/sessionManager.ts)

`consecutivePauseCount`（第 86 行）只在 `resetConsecutivePauseCount()`（第 652 行）时重置为 0。**没有时间衰减机制**。

如果用户连续遇到 2 次高风险暂停后，防滥用机制触发，强制降级 P3。但即使过了很长时间（如 1 小时后），计数仍然为 2，不会自动恢复 P4 能力。

### 修复方案

**方案：在 pause() 中记录暂停时间戳，在 isPauseLimitReached() 中检查时间衰减。**

添加一个 `_pauseTimestamps` 数组，记录每次高风险暂停的时间戳。`isPauseLimitReached()` 检查时，先过滤掉超过衰减窗口的时间戳，再判断是否达到上限。

#### 变更清单

**文件：`src/agent/managers/sessionManager.ts`**

```typescript
// 新增常量（约第 15 行附近，可在 AGENT_CONSTANTS 中定义）
/** 连续暂停计数衰减窗口（毫秒）。1 小时无新暂停则自动衰减。 */
PAUSE_DECAY_WINDOW_MS: 60 * 60 * 1000,

// 新增字段（约第 86 行附近）
/** 连续暂停时间戳记录（用于时间衰减） */
private pauseTimestamps: number[] = [];

// pause() 方法增强（第 525 行附近）
pause(reason: string, source: PauseSource = 'user', lowRisk: boolean = false): boolean {
  const result = this.stateMachine.pause(reason, source);
  if (result.allowed) {
    this.createCheckpoint();
    if (!lowRisk) {
      this.consecutivePauseCount++;
      // 记录高风险暂停时间戳
      this.pauseTimestamps.push(Date.now());
    }
    this.startPauseTimeoutTimer();
    this.emitEvent('sessionPaused', { ... });
  }
  return result.allowed;
}

// isPauseLimitReached() 方法增强（第 632 行附近）
isPauseLimitReached(): boolean {
  // 先衰减：过滤掉超过衰减窗口的时间戳
  this.decayPauseTimestamps();
  // 重新计算有效计数（基于衰减后的时间戳数量）
  return this.pauseTimestamps.length >= 2;
}

// 新增方法
/**
 * 衰减连续暂停计数
 *
 * 移除超过衰减窗口的暂停时间戳。
 * 窗口内无新暂停时，旧暂停自动失效，防滥用机制自动恢复。
 */
private decayPauseTimestamps(): void {
  const cutoff = Date.now() - AGENT_CONSTANTS.PAUSE_DECAY_WINDOW_MS;
  const before = this.pauseTimestamps.length;
  this.pauseTimestamps = this.pauseTimestamps.filter((ts) => ts > cutoff);
  const decayed = before - this.pauseTimestamps.length;
  if (decayed > 0) {
    logger.debug(
      { decayed, remaining: this.pauseTimestamps.length },
      '连续暂停计数已衰减',
    );
  }
}

// resetConsecutivePauseCount() 方法增强（第 652 行附近）
resetConsecutivePauseCount(): void {
  this.consecutivePauseCount = 0;
  this.pauseTimestamps = []; // 同步清理时间戳
  logger.debug('连续暂停计数已重置');
}
```

**注意：** `consecutivePauseCount` 字段保留作为快速缓存，但 `isPauseLimitReached()` 的行为改为基于 `pauseTimestamps` 数组的长度。`consecutivePauseCount` 在每次 `pause()` 时仍然递增，但为了保持一致性，也可以在 `isPauseLimitReached()` 中同步更新它。

### 测试设计

| # | 测试用例 | 验证点 |
|---|---------|--------|
| 1 | 连续暂停两次后达到上限 | 两次高风险暂停后，`isPauseLimitReached()` 返回 `true` |
| 2 | 第一次暂停超过衰减窗口后，第二次暂停不计入上限 | 第一次暂停在衰减窗口前，第二次在窗口内，`isPauseLimitReached()` 返回 `false` |
| 3 | 衰减窗口内暂停累积，超过窗口后衰减 | 3 次暂停，前 2 次超过窗口，第 3 次在窗口内，衰减后仅 1 次有效 |
| 4 | 低风险暂停不计数（现有行为不变） | 低风险暂停后 `pauseTimestamps` 长度不变 |
| 5 | resetConsecutivePauseCount 同时清理时间戳 | `resetConsecutivePauseCount()` 后 `pauseTimestamps` 为空数组 |
| 6 | 衰减不抛错（空数组边缘情况） | 无暂停记录时，`isPauseLimitReached()` 返回 `false`，不抛错 |

**测试文件：** `src/agent/managers/__tests__/sessionManager.test.ts`（扩展现有文件）

---

## P2-2: ChatMessage 增加 name 字段

### 问题定位

**文件：** [types.ts](file:///f:/zooique/memora/src/agent/types.ts)

`ChatMessage` 接口（第 374 行）当前只有 `role`、`content`、`toolCalls`、`toolCallId` 字段，**缺少 `name` 字段**。

LLM 的 `Message` 接口（`src/llm/provider.ts` 第 8 行）也没有 `name` 字段，但一些 LLM 提供商（如 OpenAI）支持 `name` 字段来标识消息来源（如 function 调用的结果消息）。检查点序列化/反序列化时，`name` 信息会丢失。

### 修复方案

**方案：在 ChatMessage 接口中增加可选的 `name` 字段，并在 extractHotMemory 和 restoreFromCheckpoint 中透传。**

#### 变更清单

**文件 1：`src/agent/types.ts`**

```typescript
// ChatMessage 接口增强（第 374 行附近）
export interface ChatMessage {
  /** 消息角色 */
  role: MessageRole;
  /** 消息内容 */
  content: string;
  /** 消息来源名称（可选，用于标识 function 调用等场景） */
  name?: string;
  /** 工具调用（assistant 消息，可选） */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** 工具调用 ID（tool 消息，可选） */
  toolCallId?: string;
}
```

**文件 2：`src/agent/managers/sessionManager.ts`**

```typescript
// extractHotMemory() 方法增强（第 1198 行附近）
const result = hotMessages.map((m) => ({
  role: m.role as ChatMessage['role'],
  content: /* ... 截断逻辑不变 ... */,
  name: (m as { name?: string }).name, // 透传 name 字段
  toolCalls: m.toolCalls?.map(/* ... */),
  toolCallId: m.toolCallId,
}));

// restoreFromCheckpoint() 方法增强（第 454 行附近）
const messages: Message[] = checkpoint.hotMemory.map((cm) => ({
  role: cm.role,
  content: cm.content,
  name: cm.name, // 恢复 name 字段
  toolCalls: cm.toolCalls,
  toolCallId: cm.toolCallId,
}));
```

### 测试设计

| # | 测试用例 | 验证点 |
|---|---------|--------|
| 1 | ChatMessage 接口包含 name 字段 | TypeScript 编译通过，`name` 为可选字符串 |
| 2 | extractHotMemory 透传 name 字段 | `name` 为 `'function_name'` 时，检查点中 `hotMemory[0].name` 为 `'function_name'` |
| 3 | extractHotMemory 不丢失 name 字段 | `name` 为 `undefined` 时，检查点中 `hotMemory[0].name` 为 `undefined` |
| 4 | restoreFromCheckpoint 恢复 name 字段 | 恢复后的 `Message` 对象包含 `name` 字段 |
| 5 | name 字段为 undefined 时向后兼容 | 旧检查点（无 name 字段）恢复后，`name` 为 `undefined`，不报错 |
| 6 | 现有断言不因新增字段而失败 | 所有现有测试通过 |

**测试文件：** `src/agent/managers/__tests__/sessionManager.test.ts`（扩展现有文件）

---

## 任务推进排序

### 优先级总览

```
P0 ──────────────────────────────────────
  ├─ P0-1: MemoryRelation 孤儿边清理     ← 数据完整性风险，必需优先
  └─ P0-2: 运行时暂停超时检测             ← 资源泄漏风险，必需优先

P1 ──────────────────────────────────────
  ├─ P1-1: refreshBootstrapMemories 改为必选  ← SSOT 违反，低风险修复
  └─ P1-2: goalVersion 漂移强制暂停           ← 闭环不完整，需设计决策

P2 ──────────────────────────────────────
  ├─ P2-1: consecutivePauseCount 时间衰减     ← 防滥用机制优化
  └─ P2-2: ChatMessage 增加 name 字段         ← 兼容性增强
```

### 推荐执行顺序

| 排序 | 任务 | 预估工作量 | 依赖 | 原因 |
|------|------|-----------|------|------|
| 1 | **P0-1: 孤儿边清理** | 代码 ~30 行 + 测试 ~80 行 | 无 | 数据完整性风险，简单修复，ROI 高 |
| 2 | **P1-1: refreshBootstrapMemories 改为必选** | 代码 ~5 行 + 测试 ~20 行 | 无 | 低风险，影响范围小，SSOT 合规 |
| 3 | **P2-2: ChatMessage 增加 name 字段** | 代码 ~10 行 + 测试 ~30 行 | 无 | 低风险，向后兼容 |
| 4 | **P0-2: 运行时暂停超时检测** | 代码 ~60 行 + 测试 ~80 行 | 无 | 资源泄漏风险，但实现稍复杂 |
| 5 | **P2-1: consecutivePauseCount 时间衰减** | 代码 ~30 行 + 测试 ~60 行 | 无 | 防滥用机制优化，影响较小 |
| 6 | **P1-2: goalVersion 漂移强制暂停** | 代码 ~10 行 + 测试 ~60 行 | 需用户确认 | 需要用户确认是否接受自动暂停行为 |

### 执行建议

**先做 1-2-3（P0-1 → P1-1 → P2-2）：** 这三个任务风险低、影响范围小、代码量少，可以快速完成，建立修复节奏。

**再做 4-5（P0-2 → P2-1）：** 这两个任务涉及 SessionManager 的状态管理，需要更仔细的测试，但都是独立变更，不会相互阻塞。

**最后做 6（P1-2）：** 这个任务需要用户确认是否接受"漂移时自动暂停"的行为变更，留到最后讨论。

### 依赖关系图

```
P0-1 ────┐
P1-1 ────┤
P2-2 ────┤  (独立，可并行)
         │
P0-2 ────┤
P2-1 ────┤  (独立，可并行)
         │
P1-2 ────┘  (需确认，可并行或最后)
```

所有 6 个任务**互不依赖**，理论上可以并行开发。但为了测试质量和代码审查效率，建议按上述顺序逐一推进。