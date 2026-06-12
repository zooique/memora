---
alwaysApply: false
description: 单 Agent 模型（Agent 级 DB + 三层架构 + 项目切换不重建）
---

# ADR-011 · 单 Agent 模型

> **状态**：✅ 已采纳（v2 修订） **日期**：2026-06-05（原 v1 日期 2026-06-03）
> **来源**：接入指南 v1.0 §一/§三/§四

## 背景

v1 设计为每个子项目创建独立的 memora.db，切换项目时关闭旧 DB、创建新 DB。这导致：

1. 切换子项目 = 丢失所有记忆（对话历史、用户画像、话题归档全部清空）
2. 与"单 Agent 模型"矛盾——Agent 应该有连续的记忆，不应因管理不同子项目而失忆
3. 项目级 `.memora/` 混淆了"配置"和"运行时数据"的职责

## 决策

采用 **单 Agent 模型 + 三层架构**：

1. **Agent 级配置（configDir）**：personas/rules/skills/tools，纯配置
2. **用户记忆（dataDir）**：memora.db + TopicStore + projects.json，纯数据，不随子项目切换重建
3. **项目级配置（projectPath/.memora/）**：项目专属 rules/skills，随项目版本控制
4. **项目切换**：只更新 SecurityGuard + 重新扫描项目 rules/skills，不重建数据库
5. **配置文件是真理源**：configDir 下的配置由 MemoryLoader 启动时扫描加载到 SQLite

## 关键实现

| 组件                 | 文件                            | 职责                                   |
| -------------------- | ------------------------------- | -------------------------------------- |
| ProjectManager       | `src/memory/projectManager.ts` | 三层架构管理 + 项目切换 |
| ensureAgentResources | 同上                            | 确保 memora.db 只创建一次              |
| shutdown             | 同上                            | 关闭 Agent 级 DB（仅在 Agent 关闭时）  |
| closeProject         | 同上                            | 释放项目锁，不关 DB                    |

## 后果

**正面**：

- 切换子项目不丢失记忆（对话历史、用户画像跨项目持久化）
- 配置文件可人工编辑、版本控制，SQLite 只是运行时索引
- 三层职责清晰：configDir（配置）→ dataDir（数据）→ projectPath/.memora/（项目配置）

**负面**：

- 所有子项目的记忆共享同一 DB，无法按项目隔离记忆（可通过 tag 过滤）
- 项目级 `.memora/` 不再有 memora.db，旧代码需迁移
