# 问答闭环独立存储方案（正式设计文档）

> **文档状态**：✅ 正式设计方案（SSOT）
> **版本**：v1.1
> **创建日期**：2026-08-27
> **更新日期**：2026-08-27
> **状态**：已确认，作为 Memora 会话管理的唯一真理源

### 变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-08-27 | 初始版本：Round 独立存储 + 分叉概念 |
| v1.1 | 2026-08-27 | **分叉模式定案**：统一为「从任意 Round 位置分叉」单一模式，删除 legacy copySession 路径，不考虑旧版兼容 |

---

## 设计方案地位声明

本文件是 Memora 会话管理和分叉功能的**唯一真理源（SSOT）**。所有关于会话存储、问答闭环、记忆摘要、分叉操作的实现必须遵循本文档的设计。

### 设计原则

1. **SSOT 原则**：问答闭环（Round）是全局唯一的物理存储单元
2. **自然生长**：基于现有模块平滑扩展（如引入 `RoundStore`），不破坏架构边界；扩展不等于保留旧数据格式并存
3. **纯洁性**：不考虑旧版兼容，设计干净纯粹
4. **分叉唯一性**：分叉只有一种方式——从任意 Round 位置分叉，不存在全量/增量的选择
5. **平等性**：所有问答闭环、所有会话在存储层完全平等

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

> **设计约束（SSOT）**：会话存储仅有 round-based 单一模式。`SessionMeta` 不含任何模式标识字段（如 `storageMode`）——**不存在 legacy 与 round-based 双模式并存**（产品未投入使用，无存量数据需迁移/兼容）。运行时所有会话一律以 `roundIds` 为唯一内容来源（消息内容只存于 `RoundStore`）。任何实现不得为"区分存储模式"引入 `storageMode` 之类字段或双写路径。
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

### 4.3 分叉操作：唯一模式——从 Round 位置分叉

> **v1.1 定案**：分叉方式只有一种——**传入一个 Round ID，新会话只包含该 Round 及之前的所有 Round ID**。
> 不存在"全量分叉"与"增量分叉"的选择。需要"全量"效果时，传入最后一个 Round ID 即可。
> legacy `copySession` 路径在本方案中**彻底移除**，不考虑旧版兼容。

#### 设计规则

```
分叉语义：
  会话 A: [Round₁, Round₂, Round₃, Round₄]
                           ↑
                       传入 round₂
                           ↓
  会话 B: [Round₁, Round₂]  ← 只复制到分叉点的 ID 列表
  Round₃, Round₄ 不受影响，仍归属会话 A
```

**核心保证**：
1. 传入的 `roundId` 必须存在于当前会话的 `roundIds` 中，否则抛错
2. 新会话的 `roundIds` = 源会话 `roundIds.slice(0, forkIdx + 1)`（包含分叉点）
3. 分叉后，源会话的 `roundIds` **不变**（分叉是创建新会话，不是修改源会话）
4. 引用计数：新会话引用的每个 Round `refCount` +1（已有引用的 Round 自然共享）
5. **会话 ID 统一**：所有会话只有一种 ID 格式 `{date}-{sessionName}`，不存在"分叉会话"特殊标记。新会话在存储层、UI 层、历史列表中与普通会话完全平等。

#### UI 交互设计

**分叉按钮位置**：内联在每一条 LLM 回答的底部，与"复制"、"删除"按钮同级。

```
┌─────────────────────────────────────────┐
│ 🤖 AI 回答内容...                        │
│                                         │
│ [复制] [删除] [⇢分叉]                   │  ← 每条 AI 回复底部
└─────────────────────────────────────────┘
```

**交互流程**：
1. 用户点击某条 AI 回复底部的"分叉"按钮
2. 宿主提取该 AI 回复所属的 `roundId`
3. 调用 `agent.forkSession(roundId)` 创建新会话
4. 内核截取 `roundIds.slice(0, forkIdx+1)` 创建平等的新会话
5. 宿主切换到新会话并加载视图

**设计理念**：分叉是对话中的自由选择，不是会话级别的操作。用户可以在任意历史点创建分支，每条 AI 回复都是潜在的分叉点。

#### 接口设计

```typescript
// src/agent/messageHistory.ts

/**
 * 分叉结果
 * - newSession: 新会话标识（不含日期前缀，平等普通会话）
 * - date: 会话日期
 * - roundIds: 新会话的 Round ID 列表（已复制的指针）
 */
export interface ForkResult {
  newSession: string;
  date: string;
  roundIds: string[];
}

class MessageHistory {
  /**
   * 从指定 Round 位置分叉会话（唯一分叉方式）
   *
   * 核心操作：复制 Round ID 列表（指针复制，不复制数据）
   * 新会话是完全平等的普通会话，无特殊标记。
   *
   * @param roundId - 分叉点的 Round ID（可选；不传默认使用最后一个 Round，等效全量分叉）
   * @param targetSession - 可选，自定义新会话名；不传则自动生成
   * @returns 分叉结果
   * @throws 会话不存在 / Round 不存在时抛错
   */
  forkSession(roundId?: string, targetSession?: string): ForkResult {
    // 1. 获取当前会话元数据
    const currentSession = this.getCurrentSessionMeta();
    if (!currentSession) throw new Error('会话不存在');

    // 2. 获取 Round ID 列表
    const currentRoundIds = currentSession.roundIds;
    if (!currentRoundIds?.length) throw new Error('当前会话无问答闭环');

    // 3. 定位分叉点
    const forkIdx = currentRoundIds.indexOf(roundId);
    if (forkIdx === -1) throw new Error(`Round 不存在于当前会话: ${roundId}`);

    // 4. 截取到分叉点的 ID 列表（包含分叉点）
    const newRoundIds = currentRoundIds.slice(0, forkIdx + 1);

    // 5. 生成新会话名（自动命名，平等普通会话）
    const newSession = targetSession || this.generateSessionName();

    // 6. 创建新会话（ID 列表 + 引用计数增加）
    this.sessionStore.createSession({
      sessionId: `${todayDate()}-${newSession}`,
      title: '',
      roundIds: newRoundIds,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 7. 增加引用计数（新会话引用这些 Round）
    for (const id of newRoundIds) {
      this.roundStore.incrementRef(id);
    }

    // 8. 切换到新会话
    this.switchSession(newSession);

    logger.info(
      { from: currentSession.sessionId, to: newSession, roundCount: newRoundIds.length },
      '会话分叉完成'
    );

    return {
      newSession,
      date: todayDate(),
      roundIds: newRoundIds,
    };
  }

  /**
   * 自动生成会话名（平等普通会话命名，无分叉标记）
   * 交给 SessionNamer 或宿主处理，此处留占位实现
   */
  private generateSessionName(): string {
    // 简化实现：用时间戳 + 随机后缀
    // 实际应委托给 SessionNamer
    return `session-${Date.now().toString(36)}`;
  }
}
```

#### 会话命名规则

新会话是完全平等的普通会话，不使用 `main-b1`、`main-b2` 等分叉命名：

| 场景 | 命名方式 | 示例 |
|------|---------|------|
| 用户指定名称 | 使用用户指定的名称 | `实验方案` |
| 自动生成（无 LLM） | 时间戳 + 随机后缀 | `session-k3x9m` |
| 自动生成（有 LLM） | SessionNamer 生成的标题 | `排序算法优化` |

**核心思想**：新会话不需要暴露"分叉"身份。用户在历史列表中看到的就是一个普通会话，只有会话内容（Round 列表）与源会话不同。

#### 对比：v1.0 vs v1.1

| 维度 | v1.0（原方案） | v1.1（定案） |
|------|--------------|-------------|
| 分叉入口 | `forkSessionFromRound(roundId)` | `forkSession(roundId)` — 重命名为唯一入口 |
| 分叉方式 | 仅 Round 位置分叉（设计中，未实现） | 同上，但**彻底删除 legacy 路径** |
| legacy `copySession` | 保留作为 fallback | **删除**，不再兼容 |
| 全量分叉 | 作为独立 API 存在 | 不传——传最后一个 Round ID 即可等效实现 |
| 会话加载 | `loadMessages()` 返回 `SessionMessage[]` | 返回 `Round[]` 展开视图 |

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

**目标**：将 `SessionStore` 落地为 round-based 单一模型（仅 `roundIds` 列表，无 legacy 消息列表）。产品尚未投入使用、无任何存量对话记录，故**无需任何迁移或兼容层**

| 任务 | 交付物 |
|------|--------|
| 实现 `SessionViewLoader`（round-based 会话视图加载：从 `roundIds` 批量读 `RoundStore` 展开消息） | `src/memory/sessionViewLoader.ts` |
| 重构 `SessionStore` 使用 ID 列表（`roundIds` 为唯一内容字段） | `src/memory/sessionStore.ts` |
| 编写存储层单元测试 | `__tests__/` |

**验收标准**：
- [ ] 运行时仅 round-based 单路径，无 legacy 读取路径、无模式标识字段
- [ ] 会话加载正确（消息条数 = `roundIds.length * 2`）

### Phase 4：分叉链路打通（核心任务） ✅ 已完成

**目标**：将分叉操作从 legacy `copySession` 路径完全切换到 round-based 路径，实现"从任意 Round 位置分叉"的唯一模式。

| 任务 | 交付物 | 状态 |
|------|--------|------|
| 改造 `MessageHistory.forkSession()` 签名为 `forkSession(roundId?, targetSession?)` | `src/agent/messageHistory.ts` | ✅ |
| 删除 `MessageHistory.forkSession()` 中 legacy `copySession` 分支 | 同上 | ✅ |
| `ISessionStore.copySession` 彻底删除（接口与实现），不保留 `@deprecated` 桩 | `src/memory/sessionStore.ts` | ✅ |
| VSCode 宿主 sessionStore `copySession` 删除 | `hosts/memora-vscode/` | ✅ |
| 删除 `DefaultSessionManager` 平行 `forkSession` 实现（SSOT：分叉唯一走 `MessageHistory.forkSession`） | `src/memory/sessionManager.ts` | ✅ |
| 更新 `AgentForkResult` 返回结构（含 `roundIds`） | `src/agent/managers/sessionManager.ts` | ✅ |
| 编写分叉单元测试（含边界：Round 不存在 / 空会话 / 自定义名） | `__tests__/` | ✅ |
| VSCode webview 分叉按钮内联到 AI 回复底部 | `hosts/memora-vscode/src/webview/scripts/chatView.ts` | ✅ |

**验收标准**：
- [x] 分叉唯一走 round-based 路径，无 legacy fallback
- [x] 传入 `roundId` → 新会话 `roundIds` 正确截取
- [x] 不传 `roundId` → 默认使用最后一个 Round（等效全量分叉）
- [x] 引用计数正确增加
- [x] 源会话 `roundIds` 不受影响
- [x] 全量测试通过（分叉相关测试全绿；`llmIntegration` 真实 LLM 用例需可用 API key，否则 skip）

### Phase 5：业务层适配

**目标**：适配 `AgentLoop`、`Recall` 等模块与 round-based 分叉对齐

| 任务 | 交付物 |
|------|--------|
| 适配 `AgentLoop` 写入逻辑（已完成，验证） | `src/agent/loop.ts` |
| 适配 `Recall` 召回逻辑（基于 Round ID 筛选） | `src/memory/recall.ts` |
| 适配 `RoundSummaryGenerator` | `src/agent/managers/roundSummaryGenerator.ts` |
| 适配宿主 IPC/WebSocket 分叉入口 | `hosts/memora-sprite/src/electron/ipc/sessionHandlers.ts` |

**验收标准**：
- [ ] AgentLoop 正确创建 Round
- [ ] 召回逻辑正确基于 Round ID
- [ ] 分叉后新会话的召回使用新会话的 roundIds

### Phase 6：UI 与宿主适配

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

### Phase 7：测试与上线（3 天）

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
| **分叉逻辑回归** | 低 | 高 | 完善的分叉单元测试覆盖 |
| **性能下降** | 低 | 中 | 缓存优化，批量加载 |
| **内存占用增加** | 低 | 低 | 引用计数 + GC |
| **宿主适配遗漏** | 低 | 中 | 双宿主（VSCode + Sprite）分叉路径全链路测试 |

> **v1.1 变化**：移除了"兼容性问题"风险项——产品尚未投入使用，无任何存量对话记录，无需任何迁移或 legacy 兼容层。运行时从首版起即为 round-based 单一模式；`SessionStore` 不存在 legacy/round-based 双模式并存，亦不含任何模式标识字段（如 `storageMode`）。

### 8.2 回滚方案

如果新版本出现严重问题：
1. 回退 `MessageHistory.forkSession()` 到上一个稳定版本
2. 存储保持 round-based 单路径不变（不回退为 legacy 双写）
3. 不涉及数据迁移，回滚粒度仅限分叉逻辑

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
