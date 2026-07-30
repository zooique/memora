---
alwaysApply: false
description: 专注模式（应无所住而生其心）与记忆衰减机制
---

# ADR-009 · 专注模式与记忆衰减

> **状态**：✅ 已采纳
> **日期**：2026-06-03（年轮审判补写，原始实现日期 2026-06-02）
> **来源**：[architecture_philosophy_rules.md §9 专注模式](../rules/architecture_philosophy_rules.md)（历史文档已归档）

## 背景

Memora 的核心矛盾是"无状态推理 ←→ 连续演化任务"。LLM 本身无状态，但用户需要跨会话的连续体验。传统方案要么全量加载（token 浪费），要么手动管理（认知负担）。

设计哲学"应无所住，而生其心"要求：

- **应无所住**：启动时不预加载话题记忆，保持工作集精简
- **而生其心**：用户开口时自动召回相关话题记忆，按需注入上下文

## 决策

采用 **recall() + decayScores() + truncateMessages()** 三机制实现专注模式：

1. **recall()（按需召回）**：启动时只加载 `persona` + `rule` + `skill`
   记忆（bootstrap）；用户首条消息触发关键词提取，自动召回匹配的记忆
2. **记忆衰减（score 指数衰减）**：未被命中的记忆 score 按衰减因子递减；被命中时 score 增量提升 0.05（上限 1.0，非重置）；衰减不影响永久性标记，只影响召回优先级。具体参数：超过 7 天未访问，每 7 天降低 0.02
3. **上下文截断（truncateMessages）**：当工作记忆接近 token 预算时，优先驱逐低 score 记忆

## 关键实现

| 组件                   | 文件                                     | 职责                      |
| ---------------------- | ---------------------------------------- | ------------------------- |
| recall()               | `src/memory/recall.ts`                   | 关键词提取 + 双通道召回   |
| decayScores()（工具函数） | `src/memory/recall.ts`                | 操作内存数组的 score 衰减（测试/InMemoryStorage 用） |
| IMemoryStorage.decayScores()（接口方法） | `src/memory/storageInterface.ts` | 宿主实现批量 SQL UPDATE 衰减（如 SqliteStorage） |
| boostScore()           | `src/memory/recall.ts`                   | 命中时 score 增量提升 0.05（上限 1.0） |
| truncateMessages()     | `src/agent/loop.ts`                      | token 预算截断 + 低 score 优先驱逐 |

## 后果

**正面**：

- 启动速度快（只加载必要记忆）
- 长期使用不累积 token 浪费
- 自然实现"遗忘"——不用的记忆自动淡出

**负面**：

- 首条消息有额外延迟（关键词提取 + 召回）
- 衰减参数需要调优（衰减因子、衰减间隔）
