---
alwaysApply: false
description: Agent 门面类（宿主项目接入入口）
---

# ADR-010 · Agent 门面类

> **状态**：✅ 已接受
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
   - **对话**：`chat()` / `chatSync()` / `switchSession()` / `forkSession()`
   - **项目**：`listProjects()` / `switchProject()` / `rebuildComponents()`
   - **会话恢复**：`restoreMostRecentSession()` / `restoreSession()` / `loadSessionMessages()`
   - **Provider**：`setProvider()` / `setBackgroundProvider()`
   - **调试**：`getBuildCtx()`
   - **只读访问器**：`initialized` / `context` / `provider` / `isBusy` / `lastInteractionAt` / `agentLoop` / `agentHistory`
   - **Manager 访问器**：`persona` / `tools` / `skills` / `config` / `insight` / `memory` / `storage`
3. ~~CLI 的 `repl.ts` 通过 `Agent` 类调用~~（CLI 已移出至宿主项目）
4. 库模式用户直接实例化 `Agent`，无需了解内部实现

## 关键实现

| 组件 | 文件 | 职责 |
| ---- | ---- | ---- |
| Agent | `src/agent/agent.ts` | 门面类，编排层，统一入口 |
| AgentLoop | `src/agent/loop.ts` | 对话循环（被 Agent 调用） |
| ToolExecutor | `src/agent/toolExecutor.ts` | 工具执行（通过 `agent.tools`） |
| ArchiveCoordinator | `src/agent/managers/archiveCoordinator.ts` | 归档协调器（profile/insight/content 三阶段闭环，详见 ADR-015） |
| AutoConfigRefiner | `src/agent/managers/autoConfigRefiner.ts` | 智能配置提炼（模式 3：Agent 智能总结） |
| ChatLock | `src/agent/managers/chatLock.ts` | 对话并发锁（token 机制，防止重入） |
| ConfigManager | `src/agent/managers/configManager.ts` | 规则/技能注入 + 配置建议 |
| InsightExtractor | `src/agent/managers/insightExtractor.ts` | 输入分类 + 记忆提取 |
| MemoryAdvisor | `src/agent/managers/memoryAdvisor.ts` | 记忆策略建议（sourceHealth + suggest + L3 detectConflicts） |
| MemoryDecay | `src/agent/managers/memoryDecay.ts` | 记忆衰减管理 |
| MemoryInspector | `src/agent/managers/memoryInspector.ts` | 记忆快照 + 搜索 + 统计 + 关联推荐（sourceHealth / suggest 委托 advisor） |
| RelationBuilder | `src/agent/managers/relationBuilder.ts` | 记忆关系图谱构建（ADR-014） |
| SessionManager | `src/agent/managers/sessionManager.ts` | 会话管理 + getCurrentSessionInfo |
| SessionArchiver | `src/agent/managers/sessionArchiver.ts` | 会话内容摘要归档器（ADR-015 GAP-2） |
| TextPolish | `src/agent/managers/textPolish.ts` | 文本润色 |
| WorkProjection | `src/agent/managers/workProjection.ts` | 作品投影管理器 |
| DedupManager | `src/agent/managers/dedupManager.ts` | L1 语义去重管理器（SPLIT-3 闭环：从 MemoryInspector 拆分出异步 LLM 去重职责） |
| UserFactExtractor | `src/agent/userFactExtractor.ts` | 用户事实提取器（纯函数，非 Manager） |

> 共 14 个专职 Manager/服务类（不含 UserFactExtractor 纯函数）。完整列表与 [project-rules.md §3](../rules/project-rules.md) 一致。

### Manager 访问器（Host API）

Agent 通过只读 getter 暴露 Manager 实例供宿主调用：

| 访问器 | 返回类型 | 用途 |
| ------ | -------- | ---- |
| `agent.persona` | PersonaManager | 角色切换 |
| `agent.tools` | ToolExecutor | 工具执行 |
| `agent.skills` | SkillManager | 技能匹配 |
| `agent.config` | ConfigManager | 配置管理 |
| `agent.insight` | InsightExtractor | 洞察提取 |
| `agent.memory` | MemoryInspector | 记忆读写 + 查询入口 |
| `agent.storage` | IMemoryStorage | 存储层 |
| `agent.security` | SecurityGuard | 安全守卫（写入确认回调注册） |
| `agent.works` | WorkProjectionManager | 作品投影 |
| `agent.sessionManager` | SessionManager | 会话管理 |
| `agent.polish` | TextPolishManager | 文本润色 |

> **security 访问器**：2026-07-21 新增，宿主通过 `agent.security?.onWriteConfirmation(callback)` 注册写入确认回调，实现 M1 写入确认 UI 闭环。SecurityGuard 由 Agent 层创建并注入 ProjectContext，解除 memory→security 的反向依赖。

## 后果

**正面**：

- ~~CLI 和库模式共享同一入口，减少重复代码~~（CLI 已移出，仅库模式）
- 子系统变更只影响 Agent 内部，不影响调用方
- 便于未来添加 Web/API 入口

**负面**：

- Agent 类可能成为"上帝类"（需持续关注职责膨胀）
