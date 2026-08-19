---
alwaysApply: false
description: 记忆归档价值过滤（v2.0 已简化为一步 LLM 提取 + Jaccard 去重）
---

# ADR-013 · 记忆归档价值过滤

> **状态**：✅ 已采纳（v2.0 已简化）
> **日期**：2026-06-03（年轮审判补写，原始实现日期 2026-06-02）
> **来源**：M-209 任务（历史文档已归档）

## 背景

话题切换时，工作记忆中的对话需要归档。但并非所有对话都有长期价值——"帮我查个 API"和"我们确定了架构方案"的保存价值完全不同。需要一种机制过滤低价值对话，只保留值得长期保存的内容。

## 决策

### v2.0 当前实现（2026-06-18 年轮修订）

话题切换时工作记忆需归档，但非所有对话都有长期价值。v2.0 基元驱动重构后，原**三步价值过滤**（Judge 判断 → Distill 蒸馏 → Converge 收敛）**简化为一步 LLM 提取 + Jaccard 去重**，原因是：

- 三步过滤需要 3 次 LLM 调用，延迟和成本过高
- 实际使用中单次 LLM 调用已能完成"判断价值 + 蒸馏信息"的合并语义
- Jaccard 相似度去重可替代"收敛"的合并语义，且无 LLM 调用开销

当前 `InsightExtractor.extract()` 的实际流程：

1. 单次 LLM 调用判断"是否值得记忆"并返回 insight 文本（合并了 Judge + Distill）
2. Jaccard 相似度去重检查（替代 Converge）
3. 写入 SQLite（source='insight'）

原三步过滤设计保留为**未来演进方向**，当记忆量级增长到需分级处理时可重新引入。过滤后的记忆以 `source: insight` 存入统一索引，不再使用独立的 topic-*.md 文件。

> **注意**：v2.0 基元驱动重构后，TopicStore 已移除。详见 [ADR-004](./ADR-004-memory-unification.md) §删除的模块。

## 关键实现

| 组件             | 文件                             | 职责                                   |
| ---------------- | -------------------------------- | -------------------------------------- |
| InsightExtractor | `src/agent/managers/insightExtractor.ts` | 每轮对话后提取 insight（source='insight'） |
| WorkProjection   | `src/agent/managers/workProjection.ts`   | 作品投影管理器（source='work-projection'） |

## 后果

**正面**：

- 避免低价值对话污染长期记忆
- v2.0 单次 LLM 调用，延迟和成本显著降低
- Jaccard 去重无 LLM 调用开销

**负面**：

- 价值判断有主观性，可能误判
- 归档失败不阻塞对话（fire-and-forget），可能导致记忆丢失（已通过 archiveFailed 事件缓解，见"归档失败可观测性"）

## 归档失败可观测性（AUDIT-0713-6，2026-07-14 落地）

postProcessInner 中 archiveProfileFacts / archiveInsight 两处 fire-and-forget 归档失败时，发射 `archiveFailed` 事件（payload: `{ stage: 'profile'|'insight'; message: string }`），沿 AgentEventMap → SpriteEventMap → spriteEventBridge IPC → ipcListeners 链路到达宿主 UI，以 toast 非阻塞通知用户（按 stage 独立 5min 节流）。

- autoConfigRefiner 不发射（语义为"配置学习"非"归档"）
- close() 顺序调整：awaitPendingArchives 在 removeAllListeners 之前，确保 close 期间归档失败的 emit 不丢失
- 复用现有事件链路，不新增 IPC 通道

## 何时回顾

- 当记忆量级增长到单次 LLM 提取无法有效过滤时，重新引入三步分级处理
- 当归档失败率上升时，评估增加可观测事件
