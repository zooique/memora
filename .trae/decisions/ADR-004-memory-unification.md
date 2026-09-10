---
alwaysApply: false
description: 记忆统一为"source 开放字符串"基元驱动模型
---

# ADR-004 · 记忆统一为"source 开放字符串"基元驱动模型

> **状态**：✅ 已接受 **日期**：2026-06-11（v2.0 重构）/ 2026-07-03（GAP-6 软删除）
> **前身**：v1.0 "类型 + 永久性标记"模型（2026-06-02）
>
> **2026-09-09 收敛补记（阶段3 score 物理退役）**：本 ADR 正文中的 `score` 字段（含「`weight`→`score`」演进、「按 score 降序取 top N」召回排序、「字段精简至 8」中的 score 一项）**已随阶段3 从 `Memory` 接口物理删除**——实证 score 单调不减、全部记忆趋同 1.0 而失去区分度，且「只 touch 不 +score」后无写位。现状：排序收敛为单语义分 `vectorScore` 降序，使用轨迹唯一事实源为 `accessedAt`；解析走 `parseMemory` 白名单构造（未知字段自动剥离，旧档 score 读一次即清洗）。下文 score 相关表述均为退役前设计语义，不代表当前 schema。

## 背景

v1.0 模型用 `memory_type`（6 枚举）× `permanence`（4 枚举）区分记忆。实践发现：

1. **封闭枚举扩展性差**——新增来源需改代码
2. **permanence 是查询时策略，不是记忆固有属性**——同条记忆在不同场景召回策略不同
3. **管理器过多**——TopicMount / ArchiveManager / TopicStore 各 200+ 行，维护成本高
4. **概念驱动 vs 基元驱动**——概念驱动导致每个概念都有独立管理器/枚举/类型

## 决策

从"概念驱动"重构为"基元驱动"：以 `source` 开放字符串替代封闭枚举，`permanence` 移除（召回策略查询时决定），`weight`→`score`、`updatedAt`→`accessedAt`，字段精简至 8（v2.1 GAP-6 增加可选 `deletedAt` 软删除）。

**Memory 接口**（完整定义以源码为准）：`id`（`source:name`）、`content`、`source`、`name`、`createdAt`、`accessedAt`、`score`、可选 `deletedAt`。

**source 标签约定（开放，非枚举）**：`persona`/`rule`/`skill`/`insight`/`profile`/`work-projection`/`guardrail`。**新增来源无需改代码**——存储时指定 source 字符串即可。

> **GAP-6 软删除扩展（2026-07-03）**：新增 `deletedAt` 实现"删除即软删除"——undefined 为活跃，ISO 时间戳为已软删除；召回/搜索自动过滤。`delete()` 改软删除，新增 `purge()` 物理删除。软删除不删向量索引（restore 免重嵌入）。回收站保留 30 天（`recycleBinRetentionDays` 可配，0 禁用），宿主定时 `purgeExpired` 清理。

> **GAP-7 content 多用途（2026-07-07）**：`content` 默认 Markdown，但对部分 source 允许 JSON 编码承载元数据（如 `profile` 为 `{category,value}`、`work-projection` 为投影字段），由对应 `parseContentField()` 解码并兼容旧格式降级。避免为每类设计侧车造成过度工程化。

## 理由

1. **开放 > 封闭**——source 是字符串，新增来源不改代码
2. **基元 > 概念**——精简 Memory + `search()`，无需管理器
3. **简单 > 复杂**——TopicMount 200+ 行 → recall() 10 行
4. **查询时策略 > 固化属性**——permanence 不是记忆固有属性

## System Prompt 构建（6 层）

```
Layer 1: 角色人格（persona）    — 每次注入，不可省略
Layer 2: 创作规则（rule）       — 每次注入，不可省略
Layer 3: 用户画像（profile）    — 每次注入，不可省略
Layer 4: 相关记忆（recall）     — 按相关性注入，可省略
Layer 5: 最近对话（recent）     — 最近 3 轮，固定注入（无信息量输入时仍有上下文）
Layer 6: 工具描述（tools）      — 每次注入（如果有工具）
```

## 召回 / 归档逻辑

- **召回**：提取关键词（Intl.Segmenter + 停用词过滤）→ SQLite LIKE 搜索（排除 persona/rule）→ 按 score 降序取 top N → 注入 system prompt
- **归档**：每轮问答结束后异步提取 insight，一轮一提，原子粒度

## 影响

- SQLite schema 简化：`type`→`source`，移除 `permanence`/`tags`/`updated_at`/`file_path`
- IMemoryStorage 接口简化：移除 `getByPermanence()`/`getByType()`/`applyDecay()`/`touch()`；新增 `getBySource()`

## 何时回顾

- source 标签增长到 20+ 时考虑分类层级
- LIKE 性能不足时引入 FTS5
- 回收站数据量影响性能时分表