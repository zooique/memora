---
alwaysApply: false
description: 领域切换（DomainManager + /domain 命令）
---

# ADR-012 · 领域切换

> **状态**：✅ 已采纳
> **日期**：2026-06-03（年轮审判补写，原始实现日期 2026-06-02）
> **来源**：[agent设计.md §4.4](../../docs/基础设计文档/agent设计.md) +
> M-208 任务

## 背景

同一项目可能涉及不同领域（如前端 + 后端 +
DevOps），每个领域有不同的规则、技能和工具定义。需要支持：

1. 在不同领域间切换，加载对应的领域记忆
2. 切换时卸载旧领域记忆，加载新领域记忆
3. 领域模板（`init --domain`）预置常见领域配置

## 决策

采用 **DomainManager + 领域模板** 方案：

1. **DomainManager**：管理领域切换、记忆加载/卸载
2. **领域模板**：`src/cli/commands/templates/domain-templates.ts`
   预置常见领域（coding/writing/research）
3. **`/domain` 命令**：CLI 中切换领域
4. **领域记忆存放**：`.memora/domains/{domain-name}/` 目录

## 关键实现

| 组件          | 文件                           | 职责              |
| ------------- | ------------------------------ | ----------------- |
| DomainManager | `src/memory/domain-manager.ts` | 领域切换/记忆加载 |
| 领域模板      | `src/cli/commands/templates/`  | 领域初始化模板    |

## 后果

**正面**：

- 同一项目可适配不同工作场景
- 领域模板降低初始化成本
- 切换时自动管理记忆生命周期

**负面**：

- 领域切换有延迟（需重新加载领域记忆）
- 领域间记忆隔离可能导致上下文断裂
