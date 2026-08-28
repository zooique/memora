# 记忆沉底观测 · listFading（已落地）

> **一句话**：记忆库提供一个**只读**查询「按上次访问时间找出即将自然沉底的记忆」，供宿主记忆面板展示"什么快被遗忘了"。不改治理机制、不加记忆类型、不触发任何写操作——纯健康观测。
>
> **状态**：`已落地（2026-08-28 复核，S1 探索 → 实现）`。原探索草稿以"衰减调度"为背景，随**衰减子系统移除、治理收敛为 supersede + boost** 后对齐更新。实现落点：`MemoryInspector.listFading` + `IMemoryStorage.listFading?`（可选，宿主 SQL 优化）+ `InMemoryStorage` 实现。
>
> **来源**：C1（内核发布评估收敛）

***

## 一、背景与目标

Memora 内核的治理模型（2026-08-27 收敛）：

* **supersede**：写时取代——新记忆写入时以 `supersededBy` 标记旧记忆，历史即失效；

* **boost**：召回命中 / 主动写入会 `boostScore`（升分 + 刷新 `accessedAt`）——「越常用越重要」；

* **自然沉底**：显式 score 衰减调度已移除（摘要是事实记录、无"过时"语义），低频记忆经相关性排序**自然沉底**，无需主动降分。

但**分数对用户/宿主不可见**：`MemoryInspector` 有 list/stats/search/snapshot，却没有「哪些记忆因为长期没被访问而分数很低、即将沉底」的按 `accessedAt` 查询出口。用户 profile 明确诉求「记忆健康可观测」→ 宿主记忆视图无法展示"即将遗忘的记忆"。

**目标**：一个只读查询方法，返回「当前最接近自然沉底的记忆」（久未访问 + 低分优先），供宿主记忆面板做"可能遗忘"区展示。最小单元 = **一次健康观测**，本轮不写治理、不删记忆、不降级。

## 二、现状核实（代码亲验）

* `IMemoryStorage`（[storageInterface.ts](../../src/memory/storageInterface.ts)）有**可选**方法 `listFading?(before: string, limit?: number)`——与 `close?` 同风格，宿主可不实现（不破坏契约），实现时可用一条 SQL 高效完成。

* `InMemoryStorage`（[inMemoryStorage.ts](../../src/memory/inMemoryStorage.ts)）遍历式实现 `listFading`（按 `accessedAt < before` 过滤 + `byFadingAsc` 排序）。

* `MemoryInspector.listFading`（[memoryInspector.ts](../../src/agent/managers/memoryInspector.ts)）优先走存储实现，未实现时回退 `search('')` + 本地过滤（两路径语义一致）。

* 常量集中在 [governance.ts](../../src/memory/governance.ts)（SSOT）：`INACTIVITY_SINK_DAYS=60`（沉底判定天数 cutoff）/ `SCORE_FLOOR=0.1` / `SCORE_CEILING=1.0` / `BOOST_INCREMENT=0.05`。

* **事实**：`GOVERNANCE_SOURCES=['content']`——治理源只含实际写入记忆库的会话级摘要。`listFading` 定位为**通用健康观测**（凡久未访问即可能"被遗忘"，与是否真的进了治理源无关）。

## 三、设计（已按此落地）

> **排雷决定性修正（R5）**：原案"给 `IMemoryStorage` 加必选接口方法"被**排雷否决**——当时无宿主真实消费点，预埋存储接口违反自然生长（ADR-017 Scenario B「无明确消费者暂缓」）。收敛为：**内核只落** **`MemoryInspector.listFading`** **一个只读出口 + InMemory 实现**，`IMemoryStorage` 以**可选方法**（`listFading?`）声明；宿主接入后可按需用 SQL 优化。

`MemoryInspector.listFading(opts?: { limit?: number }): FadingMemory[]`

* **定义**：遍历活跃记忆，取 `accessedAt` 距今超过 `INACTIVITY_SINK_DAYS`（60 天）者，按 `accessedAt` **升序**（最久未访问在前）、同天按 `score` **升序**（最接近沉底）排序，取前 `limit` 条（默认 50，须正整数）。

* **语义**：全部活跃记忆参与（不限定 source），无需治理源，规避 `GOVERNANCE_SOURCES=['content']` 覆盖不全的影响。

* **纯只读**：不改 score、不写 accessedAt、不删记忆。

* **空边界**：无候选 / 冷启动记忆库空 → `[]`。

* **参数校验**：`limit` 须正整数，非法抛 `configError`。

### 返回值（FadingMemory）

```ts
interface FadingMemory {
  id: string;
  name: string;
  source: string;
  score: number;            // 当前分数（越低越接近沉底）
  contentPreview: string;   // 截断到 SEARCH_PREVIEW_LEN
  createdAt?: string;
  accessedAt: string;
  daysSinceAccess: number;  // 距上次访问天数（对齐 INACTIVITY_SINK_DAYS 语义）
}
```

### 分层落点

| 层                 | 改动                                                                                     | 说明                                |
| ----------------- | -------------------------------------------------------------------------------------- | --------------------------------- |
| `IMemoryStorage`  | **可选**方法 `listFading?(before, limit?)`                                                 | 契约声明，宿主可不实现（不破坏现有实现）              |
| `InMemoryStorage` | 实现 `listFading`                                                                        | 遍历活跃记忆过滤 + `byFadingAsc` 排序（沉底顺序） |
| `utils/array.ts`  | `byFadingAsc` 排序比较器                                                                    | accessedAt 升序 → score 升序（已落地）     |
| `utils/time.ts`   | `ONE_DAY_MS` 共享                                                                        | 沉底天数换算（已落地）                       |
| `MemoryInspector` | `listFading(opts?)` 优先 `index.listFading?`，未实现回退 `search('')`                          | 两路径语义一致（沉底顺序 + `FadingMemory` 形态） |
| 宿主存储（后续/可选）       | SQL：`WHERE accessed_at < ? AND deleted_at IS NULL ORDER BY accessed_at, score LIMIT ?` | **不强改**，宿主按需接入即得 SQL 优化           |

## 四、边界与不做什么

* **不触发治理写操作**：只读查询，`boostScore`/`supersede` 不做任何调用。

* **不替代治理调度**：supersede + boost 是治理真源；`listFading` 是观测工具，不与治理竞争。

* **不加新记忆类型、不破坏单轨**：仍然 round-summary / content 既有类型，零新 source。

* **不预埋宿主 UI**：内核只出查询出口 + 数据形态，是否/如何展示由宿主（记忆面板"可能遗忘"区）自行决定。

* **可选方法契约**：宿主未实现 `listFading?` 时上层自动回退本地过滤——无静默降级为空的行为差异。

## 五、消费场景与固化状态

* 宿主记忆管理视图展示「可能遗忘 N 条」区（对应用户"主动可见"体验原则）。

* **固化状态**：内核实现 + 测试已在（`memoryInspector.test` / `governance.test` 覆盖）；宿主 src≥1 真实消费后如需 SQL 优化，再评估下沉为必选存储方法（当前可选方法 + 回退路径已保证语义一致）。

<br />
