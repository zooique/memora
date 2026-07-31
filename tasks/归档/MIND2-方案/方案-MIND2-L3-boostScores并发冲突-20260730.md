# MIND2-L3 boostScores 并发冲突修复方案

## 一、问题

`recall.ts:178-191` 的 `boostScores` 是 read-modify-write 模式（getById → +0.05 → upsert），fire-and-forget 调用。与 `MemoryDecayScheduler.runOnce`（decayScores）、`DedupManager.demoteMemory`、`memoryInspector.writeBoost` 并发写同一批 score，boost 基于旧值覆盖式 upsert，可能把刚衰减/降级的 score 拉回。

违反 §1.2「核心逻辑不直接依赖不可靠机制」。

## 二、方案选择

**选定方案 C：增量更新（incrementScore + setScore）**

与现有 `decayScores`（storageInterface.ts:169）完全同模式——存储层一条 SQL UPDATE 表达式，接口在内核、实现在宿主。

**否决方案**：
- A（串行化锁）：违反内核自包含，引入全局可变状态（与 MIND2-A2 定论冲突）
- B（CAS）：复杂度最高，demote 语义模糊
- D（仅副本 boost 不持久化）：丢失 score 累积语义，且不覆盖 writeBoost/demoteMemory

## 三、改动清单

### 3.1 接口扩展（storageInterface.ts）

新增 2 个方法（与 decayScores 同模式）：
- `incrementScore(id, delta, now): boolean` — 原子加 delta，clamped 到 [DECAY_FLOOR, SCORE_CEILING]，更新 accessedAt
- `setScore(id, newScore, now): boolean` — 设绝对值，更新 accessedAt

返回 boolean：记忆不存在/软删除时返回 false（与 boostScores 现有"静默跳过"语义一致）。

### 3.2 存储 实现

- `sqliteStorage.ts`：`UPDATE memories SET score = MAX(0.1, MIN(1.0, score + ?)), accessedAt = ? WHERE id = ? AND deleted_at IS NULL`
- `inMemoryStorage.ts`：getById → 改 → set（JS 单线程天然原子）

### 3.3 调用方迁移（4 处 score 修改）

| 文件 | 原模式 | 迁移后 |
|------|--------|--------|
| recall.ts:178-191 boostScores | getById → boostScore → upsert | `storage.incrementScore(id, BOOST_INCREMENT, now)` |
| memoryInspector.ts:645-655 writeBoost | getById → boostScore → upsert | `storage.incrementScore(id, increment, now)` |
| dedupManager.ts:349-357 demoteMemory | spread 旧快照 + score=0.1 → upsert | `storage.setScore(id, DEDUP_LOW_SCORE, now)` |
| memoryDecayScheduler.ts:436-443 demoteOutdatedMemory | spread 旧快照 + score=0.05 → upsert | `storage.setScore(id, TIMELINESS_OUTDATED_SCORE, now)` |

### 3.4 不修复（同源隐性 bug，归档）

- `dedupManager.ts:368-376 keepMerged`：spread 旧快照覆盖 score/content。频率极低（仅 L1 去重合并），且 score 用保留方旧值语义可接受。归档待自然生长触发。

## 四、实施顺序

1. 接口扩展（storageInterface.ts 新增 2 方法）
2. SqliteStorage 实现
3. InMemoryStorage 实现
4. 迁移 boostScores（recall.ts）+ 测试
5. 迁移 writeBoost（memoryInspector.ts）+ 测试
6. 迁移 demoteMemory（dedupManager.ts）+ 测试
7. 迁移 demoteOutdatedMemory（memoryDecayScheduler.ts）+ 测试
8. 验证：typecheck + lint + 全量测试

## 五、设计原则

- **架构一致性**：与 decayScores 同模式（SQL UPDATE 表达式 + 宿主实现）
- **零依赖内核**：接口在内核，实现在宿主，符合 ADR-002 v0.9
- **真正原子**：彻底消除 read-modify-write，每次写都是原子操作
- **失败语义清晰**：返回 boolean，记忆不存在时 false（与现有静默跳过一致）
