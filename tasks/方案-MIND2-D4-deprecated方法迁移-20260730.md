# MIND2-D4 @deprecated 治理方法迁移方案

## 一、现状分析

### 1.1 演进路径

Agent 类有 6 个 @deprecated 方法，每个仅一行 `this._governance?.xxx()` 委托：
- `deduplicateMemories()` → `this._governance?.deduplicate(signal)`
- `evaluateTimeliness()` → `this._governance?.evaluateTimeliness(signal)`
- `runMemoryDecayOnce()` → `this._governance?.decay()`
- `sourceHealth()` → `this._governance?.sourceHealth()`
- `suggest()` → `this._governance?.suggest(query, options)`
- `detectConflicts()` → `this._governance?.detectConflicts(signal)`

新旧两套 API 并存，违反 §2.2「新逻辑要嫁接而非并列」。

### 1.2 调用方分析

**生产代码**（需迁移）：
| 文件 | 行号 | 调用 |
|------|------|------|
| sprite.ts | 964 | `this.agent.runMemoryDecayOnce()` |
| sprite.ts | 1045 | `this.agent.sourceHealth()` |
| sprite.ts | 1105 | `this.agent.sourceHealth()` |
| memoryController.ts | 558 | `this.agent.deduplicateMemories()` |
| memoryController.ts | 570 | `this.agent.evaluateTimeliness()` |
| memoryController.ts | 581 | `this.agent.detectConflicts()` |
| memoryController.ts | 623 | `this.agent.suggest(...)` |

**测试代码**（需迁移）：
| 文件 | 行号 | 调用 |
|------|------|------|
| agent.test.ts | 558,587,600,613 | `agent.suggest(...)` ×4 |
| agent.test.ts | 637 | `agent.deduplicateMemories()` |
| agent.test.ts | 652 | `agent.evaluateTimeliness()` |
| agent.test.ts | 666 | `agent.detectConflicts()` |
| sprite.test.ts | 1866,1874 | `sprite.sourceHealth()` ×2 |
| agentFixes.e2e.test.ts | 232 | `b.agent.deduplicateMemories()` |

### 1.3 null 安全处理

原 @deprecated 方法做了 null 安全（`_governance?.xxx() ?? defaultValue`）。
迁移到 `agent.governance?.xxx()` 时，调用方需处理 null：

**策略**：在调用方使用 nullish coalescing：
```typescript
// 迁移前
const report = await this.agent.deduplicateMemories();
// 迁移后
const governance = this.agent.governance;
if (!governance) return { skippedReason: 'Agent 未初始化', ... };
const report = await governance.deduplicate(signal);
```

**简化策略**：memoryController.ts 和 sprite.ts 的调用方已在 try/catch 中，且 governance
在 Agent 初始化后必定非 null（除非 reinitAgent 后未 init）。可在调用方加守卫：
```typescript
const governance = this.agent.governance;
if (!governance) throw new Error('治理模块未初始化');
```

## 二、改动清单

### 2.1 迁移调用方（7 处生产代码 + 8 处测试代码）

每个调用方改为 `agent.governance?.xxx()` + null 安全处理。

### 2.2 删除 6 个 @deprecated 方法

从 agent.ts:1704-1806 删除 6 个方法（约 100 行）。

### 2.3 不改动

- `MemoryGovernance` 类本身不变
- `agent.governance` getter 不变
- `MemoryController` 类的方法签名不变（它们是 sprite 层的 API，IPC handler 调用它们）

## 三、实施顺序

1. 迁移生产代码（sprite.ts + memoryController.ts）
2. 迁移测试代码（agent.test.ts + sprite.test.ts + agentFixes.e2e.test.ts）
3. 删除 6 个 @deprecated 方法
4. 验证：typecheck + test + lint

## 四、验证计划

- 类型检查 0 错误
- 全量测试通过
- lint 通过
- 重点验证：governance null 时的行为与原 @deprecated 方法一致

## 五、实施完成

**完成时间**：2026-07-30

**迁移范围**（超出原方案）：
- 生产代码：sprite.ts（3 处）+ memoryController.ts（4 处，含方案遗漏的 dashboard() suggest 调用）
- 测试代码：agent.test.ts（7 处）+ sprite.test.ts（9 处 mock + mockAgent governance 字段）+ agentFixes.e2e.test.ts（1 处）+ memoryController.test.ts（2 处，方案未列出）
- 内部引用：agent.ts:358 onDecayCompleted 回调中的 evaluateTimeliness 调用
- 删除：agent.ts 中 6 个 @deprecated 方法 + 6 个未使用的 type import

**验证结果**：
- 内核 typecheck：0 错误
- 宿主 typecheck：0 错误
- 内核测试：1637 passed, 1 skipped
- 宿主测试：全量通过
- 内核 lint + 宿主 lint：通过

**备注**：detectConflicts 方法内有一处编码损坏（行 1804 '未初始化' 字节异常），用 PowerShell 正则删除绕过。
