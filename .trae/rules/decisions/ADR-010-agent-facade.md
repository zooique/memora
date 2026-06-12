---
alwaysApply: false
description: Agent 门面类（宿主项目接入入口）
---

# ADR-010 · Agent 门面类

> **状态**：✅ 已采纳
> **日期**：2026-06-03（年轮审判补写，原始实现日期 2026-06-02）
> **来源**：backend_layers_rules.md（历史文档已归档）

## 背景

Memora 需要支持宿主项目接入：

1. **库模式**：宿主项目通过 API 调用
2. ~~**CLI 模式**：用户通过终端交互~~（CLI 已移出至宿主项目）

宿主项目集成 Agent 后，通过门面类 API 驱动对话循环、记忆检索等所有功能。

## 决策

采用 **Agent 门面类** 模式：

1. `Agent` 类作为唯一对外入口，封装所有子系统初始化和生命周期管理
2. 对外暴露核心方法（v4.0 Manager 委托模式）：
   - **生命周期**：`init()` / `close()`
   - **对话**：`chat()` / `chatSync()` / `switchTopic()`
   - **项目**：`listProjects()` / `switchProject()` / `rebuildComponents()`
   - **话题恢复**：`restoreMostRecentTopic()` / `restoreTopic()` / `loadTopicMessages()`
   - **Provider**：`setProvider()` / `setBackgroundProvider()`
   - **调试**：`getBuildCtx()`
   - **只读访问器**：`initialized` / `context` / `provider` / `isBusy` / `lastInteractionAt` / `agentLoop` / `agentHistory`
   - **Manager 访问器**：`persona` / `tools` / `skills` / `config` / `insight` / `memory`
3. ~~CLI 的 `repl.ts` 通过 `Agent` 类调用~~（CLI 已移出至宿主项目）
4. 库模式用户直接实例化 `Agent`，无需了解内部实现

## 关键实现

| 组件              | 文件                              | 职责                           |
| ----------------- | --------------------------------- | ------------------------------ |
| Agent             | `src/agent/agent.ts`              | 门面类，编排层，统一入口       |
| AgentLoop         | `src/agent/loop.ts`               | 对话循环（被 Agent 调用）      |
| ToolExecutor      | `src/agent/toolExecutor.ts`       | 工具执行（通过 `agent.tools`） |
| InsightExtractor  | `src/agent/insightExtractor.ts`   | 输入分类 + 记忆提取            |
| ConfigManager     | `src/agent/configManager.ts`      | 规则/技能注入 + 配置建议       |
| MemoryInspector   | `src/agent/memoryInspector.ts`    | 记忆快照 + 搜索 + 统计         |

## 后果

**正面**：

- ~~CLI 和库模式共享同一入口，减少重复代码~~（CLI 已移出，仅库模式）
- 子系统变更只影响 Agent 内部，不影响调用方
- 便于未来添加 Web/API 入口

**负面**：

- Agent 类可能成为"上帝类"（需持续关注职责膨胀）
- ~~当前 `repl.ts` 仍直接 import
  memory/ 层（T-201 待办），门面类 API 尚未完全覆盖~~
  ✅ 已修复（翠幕天罗 v1.2：REPL 不再自行创建 providers Map / AgentLoop /
  MessageHistory）
  ✅ 已迁移（2026-06-11：CLI + repl.ts 移出至宿主项目，门面类仅服务库模式）
