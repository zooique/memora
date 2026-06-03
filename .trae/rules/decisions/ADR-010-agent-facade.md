---
alwaysApply: false
description: Agent 门面类（宿主项目接入入口）
---

# ADR-010 · Agent 门面类

> **状态**：✅ 已采纳
> **日期**：2026-06-03（年轮审判补写，原始实现日期 2026-06-02）
> **来源**：[01-主架构-v4.0.md §2](../../docs/基础设计文档/01-主架构-v4.0.md) +
> [backend_layers_rules.md](../../.trae/rules/backend_layers_rules.md)

## 背景

Memora 需要同时支持两种使用形态：

1. **CLI 模式**：用户通过终端交互
2. **库模式**：宿主项目通过 API 调用

两种模式共享相同的 Agent
Loop、记忆引擎、LLM 适配层，但入口不同。需要一个统一的门面类封装所有子系统，对外暴露简洁的 API。

## 决策

采用 **Agent 门面类** 模式：

1. `Agent` 类作为唯一对外入口，封装所有子系统初始化和生命周期管理
2. 对外暴露 5 个核心方法：`init()` / `chat()` / `switchTopic()` /
   `listAllTopics()` / `inspect()`
3. CLI 的 `repl.ts` 通过 `Agent` 类调用，不直接操作 memory/llm 子系统
4. 库模式用户直接实例化 `Agent`，无需了解内部实现

## 关键实现

| 组件         | 文件                         | 职责                      |
| ------------ | ---------------------------- | ------------------------- |
| Agent        | `src/agent/agent.ts`         | 门面类，统一入口          |
| AgentLoop    | `src/agent/loop.ts`          | 对话循环（被 Agent 调用） |
| ToolExecutor | `src/agent/tool-executor.ts` | 工具执行（被 Agent 注入） |

## 后果

**正面**：

- CLI 和库模式共享同一入口，减少重复代码
- 子系统变更只影响 Agent 内部，不影响调用方
- 便于未来添加 Web/API 入口

**负面**：

- Agent 类可能成为"上帝类"（需持续关注职责膨胀）
- 当前 `repl.ts` 仍直接 import memory/ 层（T-201 待办），门面类 API 尚未完全覆盖
