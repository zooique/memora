# 记忆衰减可观测 · 即将沉底记忆查询（探索期草稿 · S1）

> **一句话**：给记忆库补一个**只读**查询「按上次访问时间找出即将自然沉底的记忆」，让宿主记忆面板能展示"什么快被遗忘了"。不改衰减机制、不加记忆类型、不触发衰减——纯健康观测。
>
> **状态**：`探索中（S1）`。按探索期决策沉淀机制，本方案为可逆探索项，**不加 ADR、不占编号、不改 README 索引**。待被宿主真实消费（src≥1 引用 或 rules≥3 引用 或真实场景复现）后按 S2 固化。
>
> **来源**：C1（内核发布评估收敛） · 任务见 [待完成任务.md](../../tasks/待完成任务.md)

---

## 一、背景与目标

Memora 内核已有完整的记忆 score 治理机制：

- 召回命中会 `boostScore`（升分 + 刷新 `accessedAt`）——「越常用越重要」；
- `MemoryDecayScheduler` 定时对治理源执行 `decayScores`，超过 `DECAY_AGE_DAYS` 未访问则逐周期降低 score——「自然遗忘」；
- 低分记忆可经 L2 时效性评估降级（不物理删除，保留可恢复性）。

但**这些分数对用户/宿主不可见**：`MemoryInspector` 有 list/stats/search/snapshot/搜索，却没有「哪些记忆因为长期没被访问而分数很低、即将沉底」的按 `accessedAt` 查询出口。用户 profile 明确诉求「记忆衰减/健康不可观测」→ 宿主记忆视图无法展示"即将遗忘的记忆"。

**目标**：补一个只读查询方法，返回「当前最接近自然沉底的记忆」（久未访问 + 低分优先），供宿主记忆面板做"可能遗忘"区展示。最小单元 = **一次健康观测**，本轮不写衰减、不删记忆、不降级。

## 二、现状核实（代码亲验）

- `IMemoryStorage`（[storageInterface.ts](../../src/memory/storageInterface.ts)）已有按时间过滤的**查询**（`listDeleted` 按 `deletedAt`、`purgeExpired` 按 `deletedAt`）和**写**（`decayScores` 按 `accessedAt` 调 `applyDecayToMemory`）。同类方法族存在，新增 `listFading` 为**同构自然生长**。
- `InMemoryStorage`（[inMemoryStorage.ts](../../src/memory/inMemoryStorage.ts)）遍历式实现上述方法，`listFading` 可实现为遍历过滤。
- 谓词常量集中在 [governance.ts](../../src/memory/governance.ts)（SSOT）：`DECAY_AGE_DAYS=7` / `DECAY_FLOOR=0.1` / `DECAY_AMOUNT=0.02`。
- **事实**：`GOVERNANCE_SOURCES=[]`（作品投影移出记忆库后治理空转）。即**当前无记忆实际在衰减**。因此 `listFading` 定位为**通用健康观测**（凡久未访问即可能"被遗忘"，与是否真的进了治理源无关），而非修复衰减空转——那是另一个独立议题，不在 C1 范围。

## 三、设计（排雷修正版 2026-08-21）

> **本次排雷决定性修正（R5）**：原案"给 `IMemoryStorage` 加必选/可选接口方法"被 **排雷否决**——当前无宿主真实消费点，预埋存储接口违反自然生长（ADR-017 Scenario B「无明确消费者暂缓」）。收敛为：**内核只落 `MemoryInspector.listFading` 一个只读出口 + InMemory 实现**，**暂不动 `IMemoryStorage` 接口**；待宿主记忆面板真实接入（≥1 消费，S2 触发）后再下沉存储接口方法。这消除了 R3（可选方法静默降级）、R1（签名语义散落）两个架构雷。

### 3.1 最小核心（本轮落地）

`MemoryInspector.listFading` —— 一次只读健康查询，**不新增 IMemoryStorage 接口方法**：

```ts
// MemoryInspector 同步方法（复用现有 index.search/快照遍历能力）
listFading(opts?: { limit?: number }): FadingMemory[];
```

- **定义**：从 `index` 遍历活跃记忆，取 `accessedAt` 距今超过 `DECAY_AGE_DAYS`（7 天）者，按 `accessedAt` **升序**（最久未访问在前）、同天按 `score` **升序**（最接近沉底）排序，取前 `limit` 条（默认 50，`limit` 须正整数）。
- **语义**：全部活跃记忆参与（不限定 source），无需治理源，规避 `GOVERNANCE_SOURCES=[]` 空转影响。
- **纯只读**：不改 score、不写 accessedAt、不删记忆。
- **空边界**：无候选 / 冷启动记忆库空 → 返回 `[]`（对齐 `listDeleted`/`search`）。
- **参数校验**：`limit` 须正整数（对齐 `search` 现有守卫，非法抛 `configError`）。

### 3.2 谓词复用常量（SSOT，不新造魔法数）

- 阈值：距今超过 `DECAY_AGE_DAYS`（7 天）未访问 → 纳入候选，复用 `governance.DECAY_AGE_DAYS`；
- `daysSinceAccess` 计算复用 `ONE_DAY_MS`——**其上提至 `utils/time.ts`**（当前散落 `memory/recall.ts:26` + `memoryAdvisor.test.ts:20`，SSOT 收敛），Inspector 引用 `utils/time` 避免 agent→memory 内部常量反向语义。
- 排序的"低分"沿用 `DECAY_FLOOR` 概念（越低越接近沉底），不引入新阈值。

### 3.3 分层落点（排雷收敛 · 2026-08-21 更新：可选方法下沉）

> **下沉策略**：经评估，`IMemoryStorage` 是内核对外契约（2 个宿主实现 + 已发布副本）。为守内核契约纯洁性、不破坏旧宿主，采用**可选方法**（与 `close?` 同风格）。`listFading?` 宿主可不实现，未实现时上层 `MemoryInspector` 走 `search('')+本地过滤` 回退；宿主实现时可用一条 SQL 高效完成。探索期**不强改旧宿主**。

| 层 | 改动 | 说明 |
|----|------|------|
| `IMemoryStorage` | 新增**可选**方法 `listFading?(before, limit?)` | 契约声明，宿主可不实现（不破坏现有实现） |
| `InMemoryStorage` | 实现 `listFading` | 遍历活跃记忆过滤 + `byFadingAsc` 排序（沉底顺序） |
| `utils/array.ts` | `byFadingAsc` 排序比较器 | accessedAt 升序 → score 升序（已落地） |
| `utils/time.ts` | `ONE_DAY_MS`/`daysBetween` | SSOT 跨层共享（已落地） |
| `MemoryInspector` | `listFading(opts?)` 优先 `index.listFading?`，未实现回退 `search('')` | 两路径语义一致（沉底顺序 + `FadingMemory` 形态） |
| 宿主 `SqliteStorage`（后续/可选） | SQL：`WHERE accessed_at < ? AND deleted_at IS NULL ORDER BY accessed_at, score LIMIT ?` | **不强改**，宿主按需接入即得 SQL 优化 |

### 3.4 返回值（Inspector 层）

```ts
interface FadingMemory {
  id: string;
  name: string;
  source: string;
  score: number;            // 当前分数（越低越接近沉底）
  contentPreview: string;   // 截断到 SEARCH_PREVIEW_LEN（复用 agentSearchHit 风格）
  createdAt?: string;
  accessedAt: string;
  daysSinceAccess: number;  // 距上次访问天数（对齐 DECAY_AGE_DAYS 语义）
}
```

## 四、边界与不做什么

- **不触发衰减**：只读查询，`decayScores` / `applyDecayToMemory` 不做任何调用。
- **不改治理空转现状**：`GOVERNANCE_SOURCES=[]` 是独立议题（当前无记忆该被衰减），不在 C1 处理。`listFading` 是观测工具，不替代也不修复治理调度。
- **不加新记忆类型、不破坏单轨**：仍然 round-summary / content 既有类型，零新 source。
- **不预埋宿主 UI**：内核只出查询出口 + 数据形态，是否/如何展示由宿主（记忆面板"可能遗忘"区）自行决定。
- **暂不预埋存储接口方法**：仅 Inspector 层 + InMemory 实现，宿主接入（S2 触发）后再下沉 `IMemoryStorage`——避免"宿主忘了实现→静默降级为空"的可选方法隐患（R3）。
- **探索期不写 ADR**：可逆、未消费，按 S1 留在 docs。

## 五、消费场景与固化触发（S2）

- 宿主记忆管理视图展示「可能遗忘 N 条」区（对应用户"主动可见"体验原则）；
- **消费达到 S2 触发条件（宿主 src≥1 引用 `MemoryInspector.listFading` 真实调用）后**：① 固化为 ADR；② 届时再评估是否下沉 `IMemoryStorage` 接口方法（当前预埋收益 < 契约成本）。

## 六、待办（排雷修正 · 2026-08-21 已实施）

> **验证**：tsc --noEmit 零错误 · 全量 vitest 94 文件 / 2365 passed / 1 skipped。memoryInspector 新增 7 用例（48 passed）。

- [x] `utils/time.ts` 上提 `ONE_DAY_MS`（recall.ts 改写引用 + `memoryAdvisor.ts`/`inMemoryStorage.test.ts`/`recall.test.ts`/`memoryAdvisor.test.ts` 导入同步），SSOT 收敛；并新增 `daysBetween` 通用天数差函数
- [x] `utils/array.ts` 新增 `byFadingAsc`（accessedAt 升序 + score 升序）
- [x] `MemoryInspector.listFading(opts?)`：遍历候选 + `DECAY_AGE_DAYS` 阈值 + limit 校验 + 空 `[]` 兜底 + `daysSinceAccess` 计算 + `FadingMemory` 类型导出至 `src/index.ts`
- [x] 单测：排序顺序（久未在前/低分优先）/ 阈值过滤 / limit 校验 / 空库返回 `[]` / daysSinceAccess 计算 / contentPreview 截断
- [x] tsc --noEmit 零错误 + 全量测试通过

**注意**：本轮按排雷 R5 收敛，**未改动 `IMemoryStorage` 接口**（仅 Inspector 层 + 复用 `index.search('')` 遍历）。宿主接入后若量大，再评估下沉存储 SQL / 接口方法（见 §五 S2 触发）。