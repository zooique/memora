# 召回近因排序设计（纯近因路线）

> **状态**：~~提案待审~~ → **已被 [memory-tool-recall-design.md](memory-tool-recall-design.md) 取代**（2026-09-09 范式切换：自动注入 → 纯工具化 + 首步检索，排序问题域随注入语境消失）。本文档仅保留一条有效结论：accessedAt 作工具结果 P2 次序键 + 命中即 touch（见新文档 §3.4/§5.2）。保留原貌供决策链回溯。
> **日期**：2026-09-09
> **关联**：[memory-as-summary.md](memory-as-summary.md)（召回主设计）· [memory-role-pack-boundary.md](memory-role-pack-boundary.md) D7/D6 · [ADR-025](../../.trae/decisions/ADR-025-memory-role-pack-boundary.md) · [module-inventory.md](module-inventory.md)
> **决策链**：score 单调不减窘境（2026-09-09 实证）→ 时间/权重层叠质疑 → accessedAt 单标尺提案 → 纯近因定案（本项目暂不引深刻轨道）→ **范式切换：纯工具化（2026-09-09 拍板）**

---

## 0. 决策摘要（TL;DR）

1. **召回排序的时间标尺从 `createdAt`（部分）与 score（第二通道）改为 `accessedAt`（最后被想起时间）**——`accessedAt` 已在每次召回命中/创建时刷新（recall.ts:490 / roundSummaryGenerator.ts:161），是现成信号，零新机制。
2. **排序键 = 复合键 `(语义相关分 DESC, accessedAt DESC)`**：语义相关分决定"谁能被想起、贴题优先"，`accessedAt` 作为次级键决定"同贴题下最近者先浮现"。不引入新衰减曲线、不做加权求和。
3. **score 退出排序**（阶段 2）：退役 `hybridMerge` 的 score×0.4 项与 `SCORE_FLOOR`；boost 语义收敛为 **touch（刷新 accessedAt）**；健康阈值判定回退（其 score 基础消失）。
4. **明确不做深刻轨道**：本项目为项目级记忆（事件概括为主），无全局偏好冲突场景；全局成长型 agent 才需要频率/深刻通道——不预埋，留作演进点。

---

## 1. 背景与问题链

### 1.1 score 只增不减 → 区分度趋零（实证，2026-09-09）

score 生命周期实证：初值 0.5（`roundSummaryGenerator.ts:28`）→ 只增（召回命中 +0.05 / writeBoost +0.05，`SCORE_CEILING` 1.0 封顶）→ supersede 不改 score（`roundSummaryGenerator.ts:229`）→ 唯一降分路径 dedup `setScore(0.1)`（`dedupManager.ts:265`）因治理源为空**生产空转**。

**推论：score 生产上单调不减，全部记忆趋同 1.0，"深刻"失去对比度。**

### 1.2 时间在召回排序里站反/缺位

| 位置 | 现状 | 问题 |
|---|---|---|
| L1 会话内 | `createdAt` 升序 | 叙事线（对话进程），合理 |
| L2 preference | `createdAt` **升序** | **老的偏好排前面** = 给过时加权 |
| L2 其他 | 保持相关性序 | 语义序，合理 |
| 主排序第二通道 | score×0.4（hybridMerge） | 单调不减 → 无区分度 |

### 1.3 认知修正（本次讨论沉淀）

1. **round-summary 是"极简事件"记录**（用户需求 + LLM 回答的闭环概括），不是偏好断言库——preference 只是事件库子集，多数摘要是 general 事件总结。
2. **项目级记忆场景**：以项目为记忆边界，技术栈/事实通常单一（"用 Python" vs "也用 TS" 的全局偏好并存极少见），记忆以事件概括为主。
3. **记忆的"对不对"（有效性）与"多显眼"（浮现度）是两层**：有效性由 superseded 写时取代判定（D7），浮现度由近因（accessedAt）排序——互不冲突。

---

## 2. 设计：近因标尺

### 2.1 标尺选择

| 候选 | 语义 | 问题 |
|---|---|---|
| `createdAt` | 创建时间（事实锚） | 不可变，不能表达"最近被想起" |
| **`accessedAt`** | **最后被想起时间**（创建 = now；每次召回命中/采纳刷新） | **现成、已在转、天然含"褪色"（久不提自然沉）** |
| score（累积） | 使用频率 | 只增不减需褪色机制补偿 → 复杂 |

**定案：`accessedAt` 为时间标尺。** 它天然实现"用户最近提到什么，什么浮上来"；久不被想起的记忆自然沉底，但**不被判错、不消失**——语义相关时仍被召回（符合"深刻记忆被线索触发即浮现"的人类行为）。

### 2.2 排序合成：复合键，不加权求和

```
排序键 = (语义相关分 DESC, accessedAt DESC)
```

- **语义相关分**（主键）：退役 score 后的语义融合（向量 + 关键词），决定候选谁能进池与贴题优先。
- **accessedAt**（次级键）：同贴题档内，最近被想起的先浮现。

**为什么不用加权求和**（如 `相关×0.7 + recency×0.3`）：
- 加权需要 recency 归一化函数（accessedAt → 0~1 的窗口/曲线）= 重新发明衰减曲线，复杂度回潮。
- 复合键是"字段排序"，零曲线、零维护、行为可解释。
- 语义主键保证"贴题必现"——用户问"上周那个 Python 报错"，老记忆语义精准仍居前，不会被近因挤饿死。

### 2.3 与 D7 / superseded 的边界（不变量）

| 层 | 机制 | 不可变 |
|---|---|---|
| **有效性**（对不对） | superseded 写时取代（`supersededBy` 标记），非删除可回溯 | 时间不判有效性（D7 保持） |
| **浮现度**（多显眼） | accessedAt 近因排序 | 新机制（本设计） |

accessedAt 只排"先来后到"，不产生"过期/沉底归档"语义；supersededBy 过滤仍在 recall 注入前执行（recall.ts 现行行为）。

---

## 3. 排序管线具体改造

### 3.1 阶段 1：近因进排序（本次提案主体）

| 文件 | 改动 | 语义 |
|---|---|---|
| `recall.ts` `sortByLayer` | L2 preference 轨内排序 `createdAt 升序` → **复合键（语义分 DESC, accessedAt DESC）** | 修"老偏好优先"站反 |
| `recall.ts` `sortByLayer` | L2 其他轨内排序保持相关性序 → **复合键（同上）** | 同贴题下近因先 |
| `hybridMerge.ts` | （阶段 1 可不动）score 权重保留但确认不主导 | 见阶段 2 |
| L1 会话内 | **不动**（`createdAt` 升序 = 叙事线，注入顺序语义） | 避免破坏上下文连贯 |

> 注：L1 createdAt 升序是**注入叙事**（先第一轮后第二轮），与"浮现优先级"正交——不纳入本次改造，避免改变会话内上下文铺陈。

### 3.2 阶段 2：score 退出排序（独立批次，待阶段 1 验证后实施）

| 处置 | 语义 |
|---|---|
| `hybridMerge` score×0.4 项退役 | 纯语义融合排序 |
| `boost`（recall.ts:480 / writeBoost） | 收敛为 **touch**：仅刷新 accessedAt，不再 +score（排序唯一消费者的 score 副作用删除） |
| `SCORE_FLOOR` / `SOURCE_HEALTH_THRESHOLDS`（2026-09-09 上午新增） | **回退**——score 退役后其判定基础消失（诚实记录：随 score 退役一并拆除，勿留孤儿） |
| dedup 降级 `DEDUP_LOW_SCORE` | 语义改"合并内容到保留方 + 重复方打 supersededBy"（与 supersede 统一，非删除可回溯） |
| `memoryAdvisor.suggest` score 权重项 | 改 accessedAt 近因项 |
| score 字段 | 保留字段（存储兼容/诊断展示），不再消费 |

**阶段 2 若不做**：score 保留但退出排序主键（仅 hybridMerge 内低权重残余）——系统仍正确，只是遗留一个"无排序消费者但仍被 boost 维护"的字段。倾向彻底退役，避免半死状态。

---

## 4. 明确不做：深刻轨道（记录决策与理由）

人类记忆有两条通道：**近因**（最近的事记得清）与**深刻**（不断重复/重大事件，多年仍浮现）。本设计**只采纳近因**。

理由（2026-09-09 定案）：
1. **场景不匹配**：本项目为项目级记忆（以项目为边界，记忆以事件概括为主），不存在"全局多偏好长期并存"的典型深刻记忆需求；技术栈/事实通常单一演进。
2. **复杂度守恒**：深刻通道需要频率累积 + 对抗性褪色（否则重复过的全变深刻 → 又趋同）——正是 score 只增不减窘境的复刻。为猜的需求引入第二套标尺，违反"验证后固化"纪律。
3. **自强化副作用**：会话内多轮对话的最近摘要会被反复召回刷新——在深刻模型下等同于"反复练习"，会把会话内噪音刷成全局深刻记忆，污染跨会话召回。

**演进预留**（不做预埋）：若未来出现全局成长型 Agent（跨项目、长期、多主题偏好并存），再引入深刻轨道——标尺可扩展为 `(语义分 DESC, accessedAt DESC, 深刻度 DESC)` 或 score 复活为频率通道，届时单独设计。

---

## 5. 测试冲击面（已盘点）

| 测试文件 | 现状 | 影响 |
|---|---|---|
| `recall.test.ts`（47 用例） | 多处断言 createdAt 升序 / score 降序（:138 `按 score 降序`、:662/:684 createdAt 升序） | 阶段 1：preference 轨内排序断言改写；阶段 2：score 相关用例重定义 |
| `hybridMerge.test.ts` | 锁定 score×0.4 权重 | 阶段 2 重写 |
| `memoryAdvisor.test.ts` | 昨日改动的 avgScore status 判定 | score 退役 → status 判定回退（阶段 2） |
| `memoryInspector.test.ts` | searchHybrid 融合排序断言 | 阶段 2 对齐 |

**验证纪律**：每个阶段独立提交 + 突变验证（如"加回 createdAt 升序应使新用例转红"），与既有血训一致。

---

## 6. 待拍板开放点（本文档发布后需确认）

1. **阶段 1 与阶段 2 是否一起做**，还是阶段 1 先落地、score 退役观察后单独做（推荐后者）。
2. L1 会话内 `createdAt` 升序是否确认保持（不动）——影响会话内注入叙事。
3. preference 特权补入（**仅在有查询意图时**补入，无查询意图不补——防御偏好强塞噪声查询，`recall.ts` applyTrackPolicy）的保底次序：取"最近被想起"的 preference（accessedAt DESC）——是否认可。

> **排雷修正（2026-09-09）**：本文档初稿此处误述为"无查询意图也补池"，与代码相反（`applyTrackPolicy`：`if (!hasQueryIntent) return;`）。已更正。
4. dedup 与 supersede 统一（重复方打 supersededBy）是否作为阶段 2 一部分——涉及去重语义收敛。

---

## 7. 一句话总结

**把"最后被想起的时间"接进召回排序作为次级键——语义决定能不能被想起，近因决定想起时排多前；score 退出排序舞台；深刻轨道留给未来的全局 Agent。**
