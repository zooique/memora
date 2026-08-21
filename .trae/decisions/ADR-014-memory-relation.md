---
alwaysApply: false
description: 记忆关系图谱——已废弃（2026-08-14 收敛移除），侧车模型被 supersededBy 写路径取代
---

# ADR-014 · 记忆关系图谱（侧车模型）

> **状态**：❌ 已废弃（2026-08-14 收敛移除）
> **日期**：2026-06-25
> **来源**：阶段二 Phase 1.1 排雷优化方案

> **废弃结论**：独立侧车模型（`IMemoryRelationStore` / `RelationBuilder` / `MemoryRelation`）经审查判定为**过度设计**，已整体移除。原因：
> - **矛盾检测简化**：不对称的复杂 `contradicts` 关系边 + 图遍历，被 `supersededBy` 布尔标记取代（[ADR-021](./ADR-021-memory-conflict-supersede-write-path.md) 写路径取代检测）——旧摘要被新摘要覆盖即标记、读时过滤，单字段即可表达；
> - **因果结构价值未兑现**：预想的"记忆有因果结构"差异化价值在真实使用中未形成刚需，复杂关系类型（`supports`/`follows`/`refines`/`caused`/`related`）维护成本超过收益；
> - **回归最小单元**：记忆本就以"摘要即记忆"（memory-as-summary.md）为最小单元，关系图谱是叠加其上的旁路侧车，应弃。
>
> 移除后：`types.ts`/`index.ts` 不再导出 `MemoryRelation` 及 `RelationBuilder`/`IMemoryRelationStore`/`InMemoryRelationStore`；`projectManager` 不再清理关系边。
> 原死亡设计正文（关系接口 / 类型 / 权重表 / 构建与冲突检测流程 / 2026-07-08 的"关系查询归属 + RelationBuilder 拆分"补充）已随本 ADR 压缩归档。历史实现细节见 [CHANGELOG](../../CHANGELOG.md) 对应 v2.0.x 条目。

## 背景（决策原由）

记忆模型原本扁平、彼此无关系，导致两个问题：

1. **矛盾无法自动发现**——用户今天说"喜欢咖啡"、下周说"不喝咖啡"，系统无法感知两条记忆的语义对立，会同时召回、上下文自相矛盾；
2. **记忆无因果结构**——差异化价值设想为"记忆有因果结构"，但大厂 Memory 是扁平向量召回，本方案想打出差异。

初稿试图在 Memory 类型新增 `relations` 字段（`contradicts`/`supports`/`follows`/`refines`），排雷发现两处致命违反 [ADR-004](./ADR-004-memory-unification.md)：`relations` 侵入不可扩展的 7 字段基元（R1 致命）；四种关系类型仍是封闭枚举，违背"source 开放字符串替代封闭枚举"核心决策（R2 致命）。故改为**独立侧车（sidecar）模型**——`MemoryRelation` 平行于 `Memory`，互不侵入。

## 决策（记录当时方案，现已废弃）

采用 `IMemoryRelationStore` 接口（宿主注入实现）+ 开放字符串关系类型 + 有向边（source→target）+ 权重（LLM 四档离散 0/0.3/0.7/1.0 + 0.5 兜底），冲突检测嵌入 `InsightExtractor.extract()` 流程（复用单次 LLM 调用，不新增调用）。

## 为何废弃而非保留

见顶部"废弃结论"三条。核心：**真实使用未兑现因果结构的差异化价值**，且其要解决的矛盾检测已被 [ADR-021](./ADR-021-memory-conflict-supersede-write-path.md) 的 `supersededBy` 单字段写时取代更简洁地覆盖——关系图谱是"叠加在最小单元之上的旁路机制"，回归最小单元后即无存在必要。