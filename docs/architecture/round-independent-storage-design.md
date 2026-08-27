# 问答闭环独立存储方案（正式设计文档）

> **文档状态**：✅ 正式设计方案（SSOT）
> **版本**：v1.0
> **创建日期**：2026-08-27
> **状态**：已确认，作为 Memora 会话管理的唯一真理源

---

## 设计方案地位声明

本文件是 Memora 会话管理和分叉功能的**唯一真理源（SSOT）**。所有关于会话存储、问答闭环、记忆摘要、分叉操作的实现必须遵循本文档的设计。

### 设计原则

1. **SSOT 原则**：问答闭环（Round）是全局唯一的物理存储单元
2. **自然生长**：基于现有系统平滑扩展，不破坏现有架构
3. **纯洁性**：不考虑旧版兼容，设计干净纯粹
4. **平等性**：所有问答闭环、所有会话在存储层完全平等

---

## 一、设计背景与业界分析

### 1.1 问题背景

Memora 需要实现会话分叉功能，但受到现有记忆摘要系统的约束：

- **核心矛盾**：对话记录既是会话内容，又是记忆锚点，复制会破坏摘要溯源
- **解决思路**：将问答闭环从会话中独立出来，作为全局唯一的实体

### 1.2 业界方案对比

| 产品/框架 | 核心抽象 | 分叉方式 | 记忆管理 | 优缺点 |
|-----------|----------|----------|----------|--------|
| **ChatGPT** | 消息树（Message Tree） | parent_id 创建新分支 | 递归查询重建路径 | ❌ 实现复杂，需要递归查询 |
| **Claude Code** | Session 对象 + 状态继承 | `forkSession` 创建新会话 ID | 状态从原会话继承 | ❌ 分叉点粒度较粗，会话级 |
| **OpenAI Agents SDK** | Session + Memory 分层 | Session 级分叉 | 滑动窗口 + 摘要 + RAG | ❌ 实现复杂，分层记忆开销大 |
| **Memora（本方案）** | **问答闭环（Round）** | **Round ID 列表复制** | **Round ID 反向索引** | ✅ 简洁、高效、溯源清晰 |

### 1.3 核心设计优势

#### 对比业界方案

| 维度 | 业界主流方案 | 我们的方案（问答闭环独立存储） | 评估 |
|------|-------------|------------------------------|------|
| **核心抽象** | 消息（Message） | 问答闭环（Round） | ✅ 更贴近业务语义 |
| **分叉粒度** | 消息级（细） | Round 级（中等） | ✅ 更合理，符合问答闭环的自然边界 |
| **记忆绑定** | 消息 ID + Session ID | Round ID | ✅ 更简洁，溯源唯一 |
| **实现复杂度** | 高（树结构+递归） | 中（ID列表+批量加载） | ✅ 更简单 |
| **溯源能力** | 消息溯源 | Round 溯源 | ✅ 更清晰 |

#### 为什么选问答闭环而非消息？

```
业界方案（以消息为核心）：
  Message (User) → parent_id → Message (AI)
  Message (AI) → parent_id → Message (User, next round)
  ❌ 需要维护父子关系，实现复杂

我们的方案（以问答闭环为核心）：
  Round { userMessage, assistantMessage }
  ✅ 天然包含 User + AI，符合业务语义
  ✅ 不需要维护父子关系
```

#### 为什么用 ID 列表而非树结构？

```
业界方案（树结构）：
  fork(messageId) → 创建新消息，设置 parent_id → 递归重建路径
  ❌ 需要递归查询，性能开销大

我们的方案（ID 列表）：
  fork(roundId) → 创建新会话，复制 roundId 列表 → 批量加载 Round
  ✅ 直接查询，性能更好
  ✅ 实现简单
```

---

## 二、核心设计思想

### 2.1 大白话介绍

#### 核心思想

把**每一个问答闭环（User + AI）当作独立的、全局唯一的实体**，会话只是这些实体的有序集合。

```
现状：
  会话 = 消息列表（消息依附于会话）
  分叉 = 复制消息（产生重复数据）

新方案：
  问答闭环 = 独立实体（全局唯一 ID）
  会话 = 问答闭环 ID 的有序列表
  分叉 = 复制 ID 列表（指针复制，不复制数据）
```

#### 一句话总结

**问答闭环平等，会话只是容器，分叉只是复制容器的指针。**

### 2.2 SSOT 设计原则

> **单一真理源（Single Source of Truth）**

| 数据 | 真理源 | 说明 |
|------|--------|------|
| 问答闭环 ID (Round ID) | `RoundStore` | 全局唯一，物理存储的唯一标识 |
| 会话 ID (Session ID) | `SessionStore` | 会话的唯一标识 |
| 轮次摘要 ID (Memory ID) | `MemoryStore` | `round-summary:{roundId}` 格式 |

**核心保证**：
- 一个 Round ID 在全局物理存储中只对应一个问答闭环
- 一个 Memory ID（`round-summary:{roundId}`）只对应一条摘要
- 溯源时通过 Round ID 精确定位，无需会话 ID 辅助

### 2.3 与现有记忆系统的兼容性

#### 问题：问答闭环如何定位会话归属？

**结论：不需要定位，通过反向索引解决**

```
问答闭环本身不存储 sessionId
    ↓
为什么？因为同一个问答闭环可能被多个会话引用（分叉场景）
    ↓
解决方案：通过 Session 的 roundIds 列表反向查询
    ↓
加载流程：
1. 当前会话 SessionA 的 roundIds = [round-001, round-002, round-003]
2. 从 RoundStore 批量加载这些问答闭环
3. 合并成完整的对话视图
```

#### 问题：记忆召回的同会话优先原则如何实现？

**结论：通过 Round ID 反向索引实现**

```
现状：记忆存储 sessionId，召回时按 sessionId 筛选
    ↓
新方案：记忆存储 roundId，召回时按当前会话的 roundIds 筛选
    ↓
召回流程：
1. 获取当前会话的 roundIds = [round-001, round-002, round-003]
2. 搜索记忆，条件：memory.roundId IN (roundIds)
3. 这些记忆的权重更高（同会话优先）
4. 再搜索全局记忆，权重较低
5. 合并两组结果
```

---

## 三、数据模型设计

### 3.1 问答闭环（Round）

```typescript
// src/memory/roundStore.ts

/**
 * 问答闭环（Round）
 * - 独立存储，全局唯一 ID
 * - 包含一轮完整的 User + AI 对话
 * - 物理存储的唯一真理源
 */
export interface Round {
  /** 全局唯一 ID（格式：round-{uuid}） */
  id: string;
  
  /** 用户消息 */
  userMessage: RoundMessage;
  
  /** AI 消息 */
  assistantMessage: RoundMessage;
  
  /** 状态 */
  status: RoundStatus;
  
  /** 创建时间 */
  createdAt: string;
  
  /** 完成时间 */
  completedAt?: string;
  
  /** 关联的记忆摘要 ID */
  summaryId?: string;
  
  /** 引用计数（被多少个会话引用） */
  refCount: number;
}

export interface RoundMessage {
  /** 消息 ID（全局唯一） */
  id: string;
  
  /** 消息角色 */
  role: 'user' | 'assistant';
  
  /** 消息内容 */
  content: string;
  
  /** 时间戳 */
  timestamp: string;
  
  /** Token 用量 */
  tokenUsage?: {
    input: number;
    output: number;
  };
}

export type RoundStatus = 'pending' | 'complete' | 'error';
```

### 3.2 会话（Session）

```typescript
// src/memory/sessionStore.ts

/**
 * 会话（Session）
 * - 只是问答闭环 ID 的有序列表
 * - 不再包含消息内容
 * - 逻辑存储层的容器
 */
export interface SessionMeta {
  /** 会话 ID（格式：${date}-${sessionName}） */
  sessionId: string;
  
  /** 会话标题 */
  title: string;
  
  /** 问答闭环 ID 的有序列表（核心） */
  roundIds: string[];
  
  /** 创建时间 */
  createdAt: string;
  
  /** 更新时间 */
  updatedAt: string;
  
  /** 元数据（可选） */
  metadata?: {
    /** 是否置顶 */
    pinned?: boolean;
    /** 标签 */
    tags?: string[];
  };
}
```

### 3.3 记忆（Memory）

```typescript
// src/memory/memoryStore.ts

/**
 * 记忆（Memory）
 * - 以 Round ID 为核心标识
 * - 不存储固定的 sessionId
 */
export interface Memory {
  /** 记忆 ID（格式：round-summary:{roundId}） */
  id: string;
  
  /** 记忆内容（摘要） */
  content: string;
  
  /** 来源（固定为 'round-summary'） */
  source: 'round-summary';
  
  /** 关联的 Round ID */
  roundId: string;
  
  /** 创建时间 */
  createdAt: string;
  
  /** 重要性评分（用于排序） */
  importance?: number;
}
```

### 3.4 对比：现状 vs 新方案

| 维度 | 现状 | 新方案 | 改进 |
|------|------|--------|------|
| **数据所有权** | 消息属于会话 | 问答闭环独立 | ✅ 更纯粹 |
| **存储位置** | `会话ID/messages.json` | `rounds/{roundId}.json` | ✅ 全局唯一 |
| **会话内容** | 存储消息列表 | 存储 ID 列表 | ✅ 更简洁 |
| **分叉操作** | 复制消息数据 | 复制 ID 列表 | ✅ 高效 |
| **ID 唯一性** | 会话内唯一 | 全局唯一 | ✅ 溯源清晰 |
| **记忆绑定** | 依赖 sessionId + roundId | 仅依赖 roundId | ✅ 更简单 |

---

## 四、关键机制实现

### 4.1 加载逻辑：会话 → 问答闭环

```typescript
// src/memory/sessionViewLoader.ts

class SessionViewLoader {
  /**
   * 加载会话的完整对话（逻辑视图）
   * - 从 Session 加载 roundIds
   * - 从 RoundStore 批量加载问答闭环
   * - 展开成完整的消息列表
   */
  getSessionView(sessionId: string): SessionView {
    // 1. 获取会话元数据
    const sessionMeta = this.sessionStore.getMeta(sessionId);
    if (!sessionMeta) throw new Error('Session not found');
    
    // 2. 获取问答闭环 ID 列表
    const { roundIds } = sessionMeta;
    
    // 3. 从 RoundStore 批量加载问答闭环
    const rounds = this.roundStore.getRounds(roundIds);
    
    // 4. 展开成完整的消息列表
    const messages = rounds.flatMap(round => [
      round.userMessage,
      round.assistantMessage,
    ]);
    
    return {
      sessionId,
      rounds,
      messages,
    };
  }
}
```

### 4.2 写入流程：创建问答闭环

```typescript
// src/agent/managers/roundManager.ts

class RoundManager {
  /**
   * 创建新的问答闭环
   * - 确保 Round 的原子性
   * - 支持状态机：pending → complete
   */
  async createRound(
    sessionId: string,
    userMessage: RoundMessage,
  ): Promise<Round> {
    // 1. 创建 pending 状态的 Round
    const round: Round = {
      id: generateRoundId(),  // 生成全局唯一 ID
      userMessage,
      assistantMessage: null as any,
      status: 'pending',
      createdAt: new Date().toISOString(),
      refCount: 1,
    };
    
    // 2. 存储 Round
    await this.roundStore.save(round);
    
    // 3. 将 Round ID 追加到会话
    await this.sessionStore.appendRoundId(sessionId, round.id);
    
    return round;
  }
  
  /**
   * 完成问答闭环
   */
  async completeRound(
    roundId: string,
    assistantMessage: RoundMessage,
    summaryId?: string,
  ): Promise<Round> {
    // 1. 获取 Round
    const round = await this.roundStore.get(roundId);
    if (!round) throw new Error('Round not found');
    
    // 2. 更新 Round 为 complete 状态
    round.assistantMessage = assistantMessage;
    round.status = 'complete';
    round.completedAt = new Date().toISOString();
    round.summaryId = summaryId;
    
    // 3. 存储更新后的 Round
    await this.roundStore.save(round);
    
    return round;
  }
}
```

### 4.3 分叉操作：复制 ID 列表

```typescript
// src/agent/messageHistory.ts

class MessageHistory {
  /**
   * 从指定 Round ID 分叉会话
   * - 核心操作：复制 Round ID 列表
   * - 不复制问答闭环的物理数据
   */
  forkSessionFromRound(roundId: string, targetSession?: string): ForkResult {
    // 1. 获取当前会话
    const currentSession = this.sessionStore.getMeta(this.currentSession);
    if (!currentSession) throw new Error('Session not found');
    
    // 2. 获取问答闭环 ID 列表
    const currentRoundIds = currentSession.roundIds;
    
    // 3. 找到分叉点的位置
    const forkIdx = currentRoundIds.indexOf(roundId);
    if (forkIdx === -1) throw new Error('Round not found');
    
    // 4. 截取到分叉点的 ID 列表
    const newRoundIds = currentRoundIds.slice(0, forkIdx + 1);
    
    // 5. 生成新会话 ID
    const newSession = targetSession || this.autoBranchName(this.currentSession);
    
    // 6. 创建新会话（只有 ID 列表）
    const newSessionMeta: SessionMeta = {
      sessionId: newSession,
      title: '',
      roundIds: newRoundIds,  // 复制 ID 列表
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    // 7. 存储新会话
    this.sessionStore.saveMeta(newSessionMeta);
    
    // 8. 增加引用计数
    for (const id of newRoundIds) {
      this.roundStore.incrementRef(id);
    }
    
    // 9. 切换到新会话
    this.switchSession(newSession);
    
    return {
      newSession,
      roundCount: newRoundIds.length,
      nextRoundId: this.calculateNextRoundId(newRoundIds),
    };
  }
}
```

### 4.4 召回逻辑：按 Round ID 筛选

```typescript
// src/memory/recall.ts

class RecallEngine {
  /**
   * 记忆召回
   * - 同会话优先：按当前会话的 roundIds 筛选
   * - 全局补充：召回其他重要记忆
   */
  async recall(sessionId: string, query: string): Promise<Memory[]> {
    // 1. 获取当前会话的 roundIds
    const sessionMeta = this.sessionStore.getMeta(sessionId);
    if (!sessionMeta) throw new Error('Session not found');
    const { roundIds } = sessionMeta;
    
    // 2. 召回同会话的记忆（权重高）
    const sessionMemories = await this.memoryStorage.search({
      roundIds,  // 按 roundId 筛选
      importanceThreshold: 0.5,
    });
    
    // 3. 召回全局记忆（权重低）
    const globalMemories = await this.memoryStorage.search({
      excludeRoundIds: roundIds,  // 排除当前会话的，避免重复
      importanceThreshold: 0.7,  // 更高的重要性阈值
    });
    
    // 4. 合并，同会话的记忆排序靠前
    return this.mergeWithPriority(sessionMemories, globalMemories);
  }
  
  /**
   * 合并记忆，带优先级
   */
  private mergeWithPriority(
    sessionMemories: Memory[],
    globalMemories: Memory[],
  ): Memory[] {
    // 同会话的记忆排在前面
    return [...sessionMemories, ...globalMemories]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, MAX_MEMORY_COUNT);
  }
}
```

---

## 五、引用计数与垃圾回收

### 5.1 引用计数机制

```typescript
// src/memory/roundStore.ts

class RoundStore {
  /** 增加引用（分叉时调用） */
  incrementRef(roundId: string): void {
    const round = this.rounds.get(roundId);
    if (round) {
      round.refCount++;
      this.rounds.set(roundId, round);
    }
  }
  
  /** 减少引用（会话删除时调用） */
  decrementRef(roundId: string): void {
    const round = this.rounds.get(roundId);
    if (round && round.refCount > 0) {
      round.refCount--;
      this.rounds.set(roundId, round);
    }
  }
}
```

### 5.2 垃圾回收（GC）

```typescript
// src/memory/gcService.ts

class GCService {
  /**
   * 垃圾回收
   * - 清理孤立的问答闭环（refCount === 0）
   * - 只清理 complete 状态的闭环
   */
  async gc(): Promise<void> {
    const orphanedRounds: string[] = [];
    
    for (const [roundId, round] of this.roundStore.all()) {
      // 孤立的、已完成的问答闭环可以被清理
      if (round.refCount === 0 && round.status === 'complete') {
        orphanedRounds.push(roundId);
      }
    }
    
    // 删除孤立的问答闭环
    for (const roundId of orphanedRounds) {
      await this.roundStore.deleteRound(roundId);
      // 同时删除关联的摘要
      await this.memoryStore.deleteByRoundId(roundId);
    }
    
    logger.info(`GC completed: deleted ${orphanedRounds.length} orphaned rounds`);
  }
}
```

**触发时机**：
- 会话删除时，减少引用计数
- 定时任务（如每天一次）执行 GC
- 系统空闲时执行 GC

---

## 六、边界情况处理

### 6.1 问答闭环的原子性

**问题**：如果 User 消息写入后，AI 消息还没生成，程序崩溃了怎么办？

**解决方案**：
1. Round 的状态机：`pending` → `complete`
2. 只在 `complete` 状态下，才将 Round ID 追加到会话列表
3. `pending` 状态的 Round 定期清理（GC 时处理）

### 6.2 并发控制

**问题**：多端同时修改同一个问答闭环

**解决方案**：
1. Round 设计为 Append-only（只读，不修改）
2. 如果需要"修改"，创建新的 Round（而非修改原 Round）
3. 原 Round 保持不变，确保溯源清晰

### 6.3 会话删除的级联问题

**问题**：删除会话时，引用的 Round 是否删除？

**解决方案**：
1. 只减少引用计数，不物理删除
2. 当引用计数为 0 时，GC 自动清理
3. 摘要随 Round 一起清理

---

## 七、实施计划

### Phase 1：接口定义（3 天）

**目标**：定义新的数据模型和接口，不修改现有实现

| 任务 | 交付物 |
|------|--------|
| 定义 `Round` 接口 | `src/memory/roundStore.ts` |
| 定义 `SessionView` 接口 | `src/memory/sessionViewLoader.ts` |
| 定义 `RoundStore` 接口 | `src/memory/roundStore.ts` |
| 定义 `SessionStore` 扩展接口 | `src/memory/sessionStore.ts` |
| 编写接口文档 | docs/ |

**验收标准**：
- [ ] 所有接口定义完成
- [ ] 接口文档评审通过

### Phase 2：存储层实现（5 天）

**目标**：实现 `RoundStore`，不修改现有业务逻辑

| 任务 | 交付物 |
|------|--------|
| 实现 `InMemoryRoundStore` | `src/memory/inMemoryRoundStore.ts` |
| 实现 `FileRoundStore` | `hosts/memora-vscode/src/extension/storage/fileRoundStore.ts` |
| 实现引用计数机制 | 同上 |
| 实现 GC 功能 | `src/memory/gcService.ts` |
| 编写存储层单元测试 | `__tests__/` |

**验收标准**：
- [ ] 存储层单元测试通过率 100%
- [ ] 引用计数正确
- [ ] GC 功能正常

### Phase 3：会话层重构（5 天）

**目标**：将 `SessionStore` 从消息列表改为 ID 列表

| 任务 | 交付物 |
|------|--------|
| 实现 `SessionViewLoader`（透明转换层） | `src/memory/sessionViewLoader.ts` |
| 重构 `SessionStore` 使用 ID 列表 | `src/memory/sessionStore.ts` |
| 实现旧会话迁移逻辑 | 同上 |
| 编写迁移测试 | `__tests__/` |

**验收标准**：
- [ ] 旧会话可正确迁移
- [ ] 透明转换层工作正常
- [ ] 迁移后数据一致

### Phase 4：业务层适配（4 天）

**目标**：适配 `AgentLoop`、`MessageHistory`、`Recall`

| 任务 | 交付物 |
|------|--------|
| 适配 `AgentLoop` 写入逻辑 | `src/agent/loop.ts` |
| 适配 `MessageHistory` 加载逻辑 | `src/agent/messageHistory.ts` |
| 适配 `Recall` 召回逻辑 | `src/memory/recall.ts` |
| 适配 `RoundSummaryGenerator` | `src/agent/managers/roundSummaryGenerator.ts` |

**验收标准**：
- [ ] AgentLoop 正确创建 Round
- [ ] 召回逻辑正确基于 Round ID
- [ ] 端到端对话流程正常

### Phase 5：UI 与宿主适配（3 天）

**目标**：确保宿主层 UI 正确渲染

| 任务 | 交付物 |
|------|--------|
| 验证 `chatView.ts` 渲染 | `hosts/memora-vscode/src/webview/scripts/chatView.ts` |
| 验证 `chatPanel.ts` 逻辑 | `hosts/memora-vscode/src/webview/panels/chatPanel.ts` |
| 验证会话列表显示 | 同上 |

**验收标准**：
- [ ] UI 渲染正确
- [ ] 会话列表显示正常
- [ ] 无明显性能问题

### Phase 6：测试与上线（3 天）

**目标**：全量测试，确保稳定

| 任务 | 交付物 |
|------|--------|
| 集成测试 | `__tests__/integration/` |
| 边界测试 | `__tests__/boundary/` |
| 性能测试 | `__tests__/performance/` |
| 回归测试 | `__tests__/regression/` |

**验收标准**：
- [ ] 所有测试通过率 100%
- [ ] 无回归问题
- [ ] 性能符合预期

---

## 八、风险与缓解

### 8.1 主要风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| **数据迁移失败** | 中 | 高 | 充分测试，保留回滚方案 |
| **性能下降** | 低 | 中 | 缓存优化，批量加载 |
| **内存占用增加** | 低 | 低 | 引用计数 + GC |
| **兼容性问题** | 中 | 高 | 充分的过渡期测试 |

### 8.2 回滚方案

如果新版本出现严重问题：
1. 停止新会话使用新格式
2. 旧会话保留新格式，不再写入新格式
3. 重新启动服务，回滚到旧逻辑
4. 提供数据恢复脚本

---

## 附录

### A. 术语表

| 术语 | 说明 |
|------|------|
| Round | 问答闭环，包含一轮完整的 User + AI 对话 |
| Round ID | 问答闭环的全局唯一标识 |
| Session | 会话，问答闭环 ID 的有序列表 |
| Session ID | 会话的唯一标识 |
| Memory | 记忆，以 Round ID 为核心标识的摘要 |
| Memory ID | 记忆的唯一标识，格式为 `round-summary:{roundId}` |
| SessionView | 会话的逻辑视图，展开后的完整对话 |
| 引用计数 | 记录问答闭环被多少个会话引用 |
| GC | 垃圾回收，清理孤立的问答闭环 |

### B. 核心原则

1. **SSOT 原则**：Round ID 是全局唯一的物理存储标识
2. **自然生长**：基于现有系统平滑扩展
3. **纯洁性**：不考虑旧版兼容
4. **平等性**：所有问答闭环、所有会话在存储层完全平等
5. **溯源清晰**：通过 Round ID 精确定位，无需会话 ID 辅助

### C. 参考

- [Agent 设计哲学](./agent-design-philosophy.md)
- [Loop 设计](./loop-design.md)
- [记忆即摘要](./memory-as-summary.md)
