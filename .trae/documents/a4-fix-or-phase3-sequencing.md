# 问诊：先修 A4，还是推进阶段 3？（决策计划）

> **坐标**：正文行号为**历史记录的时点快照**，代码演进后不再核对——定位请按符号名检索，勿依赖行号。

> **问诊结论：先推进阶段 3**，并在阶段 3 全量回归时**顺手复测 A4**。
> A4 与阶段 3 **相互独立**（实证见下），不构成前置依赖；且阶段 3 回归跑一遍 A/B 能**钉死 A4 归因**，是零额外成本的二分实验。

---

## 一、A4 到底是什么问题（实证归因）

**A4 失败记录**（memory-tool-recall-ab-benchmark.md §3.1）：
- 种子：`content:review-checklist`，正文 `ZizzleReview：评审走五维清单（异步错误/分层/冗余/对抗CSS/安全性能）。`
- 用户输入：`这轮更新帮我按老规矩过一遍`（隐含相关，无「上次/之前」字样）
- **queried ✓ / hit ✗**：LLM 主动检索了，但返回未含实体 `ZizzleReview`。
- 理想查询 `评审五维清单` 自检可命中 → 检索通道**可达**；实跑 query（偏「老规矩过一遍」）与正文语义距离过大 → 未被召回。

**关键实证：score 与 A4 无关**：
- benchmark-seeds.ts:67 所有种子统一 `score: 0.7` → 实跑库内排序对 A4 **无 score 区分度**。
- score 退役（排序纯化为 `vectorScore` 降序）**不会改变 A4 命运**。
- 归因锁定：**A4 = 检索召回质量问题**（query↔正文语义相撞 / minSimilarity 阈值 / topN 没进池），**不是**「模型不主动回忆」（queried 已 ✓），也**不是**排序权重问题。

**结论**：阶段1 出口条件的**行为面（想起）已达标**（A 主动检索 6/6、B 命中率 100% 过硬门槛）；A4 是**检索质量的已知开放项**（设计文档已标「待复查」），不是阻塞范式定案的门槛。

---

## 二、为什么选「推阶段 3」（而非先修 A4）

| 维度 | 推阶段 3 | 先修 A4 |
|---|---|---|
| 依赖关系 | 与 A4 **独立**（score 无区分度） | 与阶段 3 无耦合，先修不影响阶段 3 |
| 性质 | **确定性清理**（删死权重，SSOT） | **实验/调优**（三选项均非确定改法） |
| 风险 | 低：独立提交 + 全量回归即验证 | 中：选项②动内核检索核心；无本地对照数据前=盲调 |
| 收益 | 排序纯化、boost 收敛、常量清理，账面明确 | 命中质量提升，但 1/6 个案，非行为门槛 |
| 附加价值 | 回归复测 A/B **顺手钉死 A4 归因**（二分实验） | 无 |

**三个可选修复**（设计文档 A4 归因段）：
1. 提 query 精确性引导（改 tool 描述 = 宿主 prompt）
2. kernel 检索对近义词召回增强（**动检索核心**，需本地小模型对照数据支撑，避免过度工程）
3. 换更难命中的种子措辞（改验收资产）

**三者都应在「本地小模型同题对照」（基准文档待办项）产生数据后再裁决**，仓促先修 = 未按实证原则。

---

## 三、实施计划（阶段 3 + 顺手复测 A4）

> 前提拍板（用户已确认）：score **物理删除**（含 `Memory.score` 字段），非设计文档早期的「保留诊断展示」。

### 批次 3A · 排序纯化
- `src/memory/hybridMerge.ts`：移除 `memoryScoreWeight` / `DEFAULT_MEMORY_SCORE_WEIGHT` / `DEFAULT_VECTOR_SCORE_WEIGHT` 权重与 `HybridWeights` 参数 → `sort` 单 `vectorScore` 降序。
- 消费方 `recall()`（recall.ts）与 `searchHybrid()`（memoryInspector.ts）同函数一处改、处处生效；`RecallOptions.weights` 同步移除。
- keyword-only 回退（vectorScore=0）失去 score 平局 → stable-sort 插入序，可接受。

### 批次 3B · boost 收敛
- `src/memory/recall.ts`：删除 `boostScore`（副本提升段），确认 `touchScores`（`incrementScore(id,0)`）为唯一写位。

### 批次 3C · memoryAdvisor 判定回退
- `src/agent/managers/memoryAdvisor.ts`：`SOURCE_HEALTH_THRESHOLDS` / avgScore 健康判定按拍板处置（倾向弃用 status；score 字段删除后无 avgScore 数据源）。`src/memory/governance.ts` 常量随拆记录。

### 批次 3D · 常量清理
- `BOOST_INCREMENT` / `SCORE_CEILING`：3B 后 grep 消费方归零则删（`src/index.ts` 导出面同步）。

### 批次 3E · 字段物理删除（破坏面大，独立提交）
- 内核 `Memory.score` 类型字段 + `InMemoryStorage` 读写。
- 宿主 `workspaceStorage.ts`（incrementScore/topByScore）、`protocol.ts` DTO、webview `memoryView.ts`/`chatView.ts` 展示。
- `builtinToolHandlers.ts` 工具返回 `(score=...)` 展示段移除。
- 相关测试用例同步清理。

### 批次 3F · 资产 / 验收
- benchmark-seeds.ts：`score: 0.7` 种子字段随类型删除（或保留分派兼容）。
- 脚本（benchmark / real）：随字段删除对齐。

### 回归 + A4 复测（验证步骤）
1. 每批独立 `npx vitest run` + `tsc --noEmit`，各层(root/host)全绿。
2. 阶段 3 收尾后**重跑 `scripts/test-memory-tool-recall-real.ts`**：
   - **预期 A4 仍 miss** → 顺势钉死归因「A4 = 纯检索召回，与排序无关」，把设计文档 A4 段从「待复查」收口为定案。
   - 若意外命中 → 记录（score 曾参与边界案例，反证排序耦合，需回查）。
3. A4 的真正修复（三选项）移入「本地小模型对照」待办，取得对照数据后按实证裁决。
4. 更新设计文档 §阶段3 状态行 + A/B 基准文档状态。

---

## 四、假设与边界

- **阶段3 范围内不做 A4 检索增强**：检索核心改动 = 过度工程风险，且无本地对照数据支撑，留观测推进。
- **score 物理删除为已拍板方向**；若回归暴露宿主/协议破坏面超预期，降级回「字段物理保留 + 逻辑退役」需用户二次确认（记录为风险点）。
- 阶段 3 全量绿后**独立提交 + 推送**，不进未完成批次的 git hoarding。

## 五、验证清单

- [ ] 3A-3D 后 `hybridMerge` 无 score 权重引用、`boostScore` 消费方归零
- [ ] 3E 后全库 grep `memory.score` / `score`(字段语义) 归零
- [ ] `npx vitest run` 各层全绿 + `tsc --noEmit` 零错误
- [ ] A/B 复测：A4 归因收口为「纯检索召回」
- [ ] 提交推送 + 设计文档状态行更新