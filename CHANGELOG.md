# Changelog

本文件记录 @zooique/memora 的版本变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [2.0.0] - 2026-07-17

从 1.0.1 到 2.0.0 的架构收敛版本。核心目标：读写统一、记忆治理 L1~L4 全链路、god function 拆分、可观测性补全。

### Breaking Changes

> **升级指南**：以下变更需要消费者修改代码。

#### 1. MemoryMutator 移除，读写统一入口

`MemoryMutator` 类（1.0.0 引入的读写分离）已合并回 `MemoryInspector`。写方法以 `writeXxx` 前缀命名，与读方法统一在 `agent.memory` 上。

| 1.0.1 调用方式 | 2.0.0 迁移路径 |
|---|---|
| `agent.memoryMutator.upsert(memory)` | `agent.memory.writeUpsert(memory)` |
| `agent.memoryMutator.delete(id)` | `agent.memory.writeDelete(id)` |
| `agent.memoryMutator.restore(id)` | `agent.memory.writeRestore(id)` |
| `agent.memoryMutator.purge(id)` | `agent.memory.writePurge(id)` |
| `agent.memoryMutator.purgeExpired(before)` | `agent.memory.writePurgeExpired(before)` |
| `agent.memoryMutator.addRelation(rel)` | `agent.memory.writeAddRelation(rel)` |
| `agent.memoryMutator.removeRelation(...)` | `agent.memory.writeRemoveRelation(...)` |
| `import type { MemoryMutator }` | 移除，不再导出 |

**保留在 `agent.memory` 的只读方法**：`snapshot()` / `search()` / `searchHybrid()` / `stats()` / `getById()` / `list()` / `listDeleted()` / 关系查询方法等（不变）。

### Added（新增功能）

- **LLM 记忆治理 L1~L4**：
  - L1 语义去重：`agent.deduplicateMemories()` — 扫描名称相似记忆对，LLM 判断语义等价，降级重复记忆
  - L2 时效性评估：`agent.evaluateTimeliness()` — 扫描低分记忆，LLM 判断是否过时，降级过时记忆
  - L3 冲突检测：`agent.detectConflicts()` — 同 source 内配对，LLM 判断语义冲突，仅检测不修复
  - L0 手动衰减：`agent.runMemoryDecayOnce()` — 触发一次 score 衰减
  - 新增类型：`DedupPair` / `DedupVerdict` / `DedupReport`、`TimelinessVerdict` / `TimelinessReport`、`ConflictVerdict` / `ConflictReport`
- **TextPolishManager**：LLM 文本润色（语法修正 + 表达优化），独立于 Agent 生命周期，通过 `TextPolishManager` 类使用
- **EvalRunner 公开**：评估框架从 `@internal` 提升为公开 API，新增 `EVAL_SCENARIOS` / `EvalRunner` / `EvalRunnerOptions` / `EvalSummary` 导出
- **segmentLower**：分词工具扩展，返回小写分词结果（宿主 SqliteStorage 依赖）
- **isPlainObject**：纯对象类型守卫（宿主 spriteConfig 依赖，校验 JSON.parse 结果）
- **ChatLockManager**：对话锁管理器（从 AgentLoop 拆分），基于 token 的并发安全机制
- **ArchiveCoordinator**：归档协调器（从 postProcessInner 拆分），统一管理会话归档 + 洞察提取 + 角色匹配
- **MemoryDecayScheduler**：记忆衰减调度器（从 agent.ts 拆分），定时衰减 + L2 时效性评估 + 指标统计
- **MemoryAdvisor**：记忆顾问（从 MemoryInspector 拆分），sourceHealth 诊断 + suggest 关联推荐 + L3 冲突检测
- `TypedEventEmitter` 新增 `emitAsync` 方法（支持异步事件处理器的 await 等待）

### Changed（改进）

- **processUserInput 拆分**：从 550+ 行 god function 拆分为 4 个职责清晰的子方法（`handleRecallAndInputGuard` / `handleIteration` / `handleToolCalls` / `handleTextResponse`），每个方法独立可测
- **nullifyAllComponents 统一**：Agent.close() 中 13 个组件字段置空集中到 `nullifyAllComponents()` 私有方法，消除遗漏风险
- **requireNonNull 消除**：全量替换为局部变量提取 + non-null assertion `!`，减少代码噪音
- **personaManager LLM 调用迁移**：角色匹配的 LLM 调用从 persona 层迁移到 agent 层（架构分层合规）
- **toError 行为对齐**：跨模块统一错误处理，`toError(nonError)` 不再抛出 TypeError
- **formatDateKey 提取**：消除 3 处重复的日期格式化逻辑
- **抽象剪枝 3 轮**：DRY 收敛——消除重复的工具函数、常量定义、类型推导
- **types.ts 依赖图注释**：index.ts 新增完整的类型依赖图，降低新开发者学习成本
- 提示词优化 + 并发工具调用 + 可观测性补全（Tracer Span 覆盖衰减/归档/冲突检测）

### Fixed（修复）

- 神木回天 6 项修复：日志改进、硬约束测试补全、错误处理路径修复
- 感知层模式陈旧 bug：`welcomeBack` 文案 + 冷启动 blend 逻辑修复
- P3 静默 catch 修复：不再吞掉关键错误
- 归档失败事件 `archiveFailed` 可观测性补全（11 处测试覆盖）

### Internal（内部变更）

- `memoryMutator.ts` 文件删除，写方法合并到 `memoryInspector.ts`（`writeXxx` 前缀）
- `archiveCoordinator.ts` 独立模块（从 `agent.ts` 提取）
- `chatLockManager.ts` 独立模块（从 `loop.ts` 提取）
- `memoryDecayScheduler.ts` 独立模块（从 `agent.ts` 提取）
- `memoryAdvisor.ts` 独立模块（从 `memoryInspector.ts` 提取）
- `textPolishManager.ts` 新增模块（纯 LLM 调用，无存储依赖）
- 测试补强：L2 时效性评估测试、衰减边界测试、各 Manager 测试大幅扩展（+500+ 测试用例）

## [1.0.2] - 2026-07-11

### Changed

- `EmbeddingOptions` 接口归属位置从 `llm/embedding.ts` 调整到 `memory/vectorStore.ts`（符合依赖倒置原则：消费者定义接口，提供者通过 `import type` 引入）
- 顶层导出不变（`index.ts` 已同步更新导出路径），外部消费者无需修改导入语句

## [1.0.1] - 2026-07-08

### Fixed（P2 遗留项修复）

- coverage 阈值从 75/85/70/75 提升至 80/88/75/80
- pathGuard 黑名单新增 `.envrc` 拦截规则（direnv 配置文件）
- decisions/README.md ADR 索引补全 ADR-005 保留行
- kernel-ci.yml 测试数量注释更新

## [1.0.0] - 2026-07-08

从 0.3.0 到 1.0.0 的完整架构收敛版本。核心目标：接口稳定化、职责分离、韧性补齐、公共 API 收敛。

### Breaking Changes

> **升级指南**：以下变更需要消费者修改代码。所有 Breaking Changes 均有 1:1 迁移路径。

#### 1. 记忆读写分离：`agent.memory` → `agent.memoryMutator`

`MemoryInspector` 中的写操作方法已迁移到新类 `MemoryMutator`，实现读写职责严格分离（ADR-010 补充）。

| 0.3 写方法（`agent.memory.xxx`） | 1.0 迁移路径（`agent.memoryMutator.xxx`） |
|---|---|
| `agent.memory.upsert(memory)` | `agent.memoryMutator.upsert(memory)` |
| `agent.memory.delete(id)` | `agent.memoryMutator.delete(id)` |
| `agent.memory.restore(id)` | `agent.memoryMutator.restore(id)` |
| `agent.memory.purge(id)` | `agent.memoryMutator.purge(id)` |
| `agent.memory.purgeExpired(before)` | `agent.memoryMutator.purgeExpired(before)` |
| `agent.memory.addRelation(rel)` | `agent.memoryMutator.addRelation(rel)` |
| `agent.memory.removeRelation(...)` | `agent.memoryMutator.removeRelation(...)` |

**保留在 `agent.memory` 的只读方法**：`snapshot()` / `search()` / `searchHybrid()` / `stats()` / `getById()` / `list()` / `listDeleted()` / `getDeletedById()` / 关系查询方法等。

#### 2. `VectorStore` 重命名为 `JsonVectorStore`

向量存储从具体类重构为接口 + 实现（ADR-016）。

| 0.3 导出 | 1.0 迁移路径 |
|---|---|
| `import { VectorStore } from '@zooique/memora'` | `import { JsonVectorStore } from '@zooique/memora'` |
| `new VectorStore(path, embeddingProvider)` | `new JsonVectorStore(path, embeddingProvider)` |

新增 `IVectorStore` 接口，宿主可实现自定义向量存储（如 SqliteVectorStore / LanceDBVectorStore）。

#### 3. `ChatOptions.channel` 字段移除

`ChatOptions.channel?: 'chat' | 'background'` 字段从未被任何 LLM 调用路径读取，已移除。多 Provider 路由通过 `AgentOptions.backgroundProvider` 注入独立 LlmProvider 实例实现，不通过 `ChatOptions` 字段路由。

#### 4. `AgentChunk` 流式事件结构变化

多个 chunk 类型的字段结构发生变化，宿主需更新 chunk 处理逻辑：

| chunk 类型 | 0.3 结构 | 1.0 结构 |
|---|---|---|
| `recall` | `{ type: 'recall'; count: number }` | `{ type: 'recall'; memories: RecalledMemorySummary[] }`（携带记忆摘要列表，非计数） |
| `text` | `{ type: 'text'; content: string }` | `{ type: 'text'; content: string; guardrailBlocked?: boolean }`（新增护栏阻断标志） |
| `tool_start` | `{ type: 'tool_start'; name: string; args?: string }` | `{ type: 'tool_start'; toolCallId: string; name: string; args?: string }`（新增 toolCallId） |
| `tool_result` | `{ type: 'tool_result'; name: string; ok: boolean; summary?: string }` | `{ type: 'tool_result'; toolCallId: string; name: string; ok: boolean; summary?: string }`（新增 toolCallId） |
| `error` | 不存在 | `{ type: 'error'; message: string }`（新增，流式错误替代裸 throw） |
| `retry` | 不存在 | `{ type: 'retry'; attempt; maxRetries; delayMs; error }`（新增，指数退避重试信号） |

新增 `RecalledMemorySummary` 类型（`{ id, name, score, source }`），仅暴露 UI 展示所需字段，不含 `content`。

#### 5. `Memory` 类型新增 `deletedAt` 字段（7→8 字段）

`Memory` 接口新增可选字段 `deletedAt?: string`（ISO 8601），支持软删除/回收站机制（ADR-004 GAP-6 扩展）。所有查询方法自动过滤 `deletedAt != undefined` 的记忆。

#### 6. `IMemoryStorage` 接口扩展（7→15 方法）

新增 8 个方法，宿主实现的 `IMemoryStorage` 需补全：

| 新增方法 | 用途 |
|---|---|
| `restore(id)` | 恢复软删除记忆 |
| `purge(id)` | 物理删除（不可恢复） |
| `listDeleted(limit?)` | 列出回收站 |
| `getDeletedById(id)` | 按 ID 获取软删除记忆 |
| `purgeExpired(before)` | 清理过期回收站 |
| `decayScores(sources, now)` | 批量衰减 score |
| `getAllSources()` | 获取 source→count 映射 |

（`close?()` 已在 0.3 存在）

#### 7. `AgentOptions` 字段变化

| 变化 | 0.3 | 1.0 | 迁移路径 |
|---|---|---|---|
| `logger` 字段移除 | `AgentOptions.logger?: ILogger` | 移除 | 改用全局 `setLogger(customLogger)` 注入 |
| `archiveMode` 新增 | 不存在 | `archiveMode?: ArchiveMode`（默认 `'full'`） | 可选，不传则默认 `'full'` 全自动归档 |
| `enableContextSummary` 默认值 | `false` | `true` | 如需关闭显式传 `false` |

#### 8. 事件载荷变化

三个事件的载荷结构变化，宿主事件处理器需更新：

| 事件 | 0.3 载荷 | 1.0 载荷 |
|---|---|---|
| `conflictDetected` | `{ memoryId, conflictingId, relationType }` | `{ newMemoryId, newInsight, targetId, targetContent }` |
| `projectSwitched` | `{ from, to }` | `{ from: string \| null, to: string, projectName: string }` |
| `skillMatched` | `{ skillName, keywords }` | `{ skill: string, score: number }` |

#### 9. 会话/项目方法迁移到专职 Manager

以下方法从 Agent 面类迁移到专职 Manager（P1-4 拆分）：

| 0.3 调用方式 | 1.0 迁移路径 |
|---|---|
| `agent.switchSession(name)` | `agent.sessionManager.switchSession(name)` |
| `agent.loadSessionMessages(date, session)` | `agent.sessionManager.loadSessionMessages(date, session)` |
| `agent.restoreMostRecentSession(...)` | `agent.sessionManager.restoreMostRecentSession(...)` |
| `agent.restoreSession(date, session)` | `agent.sessionManager.restoreSession(date, session)` |
| `agent.listProjects()` | `agent.projects.listProjects()` |

**保留在 Agent 面类**：`switchProject()` / `rebuildComponents()` / `forkSession()`（常用入口）。

#### 10. `ToolExecutor` 移除 `getToolDefinitions()`

`agent.tools.getToolDefinitions()` 已移除，改用 `agent.tools.list`（getter）。

| 0.3 调用 | 1.0 迁移路径 |
|---|---|
| `agent.tools.getToolDefinitions()` | `agent.tools.list` |

#### 11. Agent 移除 `inspect()` / `getBuildCtx()`

`agent.inspect()` 和 `agent.getBuildCtx()` 已移除。宿主可通过事件系统、ITracer、`agent.memory.snapshot()` 观察内核状态。

### Added（新增功能）

- **`MemoryMutator`**：记忆写入器，与 `MemoryInspector` 严格分工（读写分离）
- **`RelationBuilder`**：关系构建器，从 `InsightExtractor` 提取（P1-3），支持冲突检测回调
- **`ProjectRegistry`** + **`LockManager`**：从 `ProjectManager` 拆分（P1-4），宿主可直接使用
- **`IVectorStore`** 接口：向量存储抽象，宿主可注入自定义实现（ADR-016）
- **`EmbeddingOptions`**：embedding 调用选项（`signal?: AbortSignal` + `timeoutMs?: number`），`EmbeddingProvider.embed/batchEmbed` 和 `IVectorStore` 方法支持外部取消 + 超时中断（P1-8）
- **`ConflictInfo`** 类型：关系冲突信息，`RelationBuilder.bindOnConflict()` 回调参数
- **`RecalledMemorySummary`** 类型：recall chunk 载荷，仅暴露 UI 展示所需字段（id/name/score/source），不含 content
- **`archiveMode`** 选项：ADR-015 三态归档控制（`full` / `insights-only` / `manual`），默认 `full`
- **AgentChunk 新增 `error` / `retry` 类型**：流式错误事件替代裸 throw，指数退避重试信号让宿主感知重试
- **`mergeSignals`** 工具：AbortSignal 合并工具，将多个 signal 合并为一个（用于工具执行超时 + 用户取消合并）
- **`guardrail.ts`** 独立模块：内容护栏纯函数 `runGuardrails()`，从 `AgentLoop` 提取（P1-1）
- **`sourceValidation.ts`**：source 校验工具从 `types.ts` 拆分（P1-2）
- **AgentChunk `guardrailBlocked`** 标志位：结构化护栏信号，替代中文字符串匹配（P0-7）
- **`SessionArchiver`**：会话内容归档器，支持 content 类记忆归档
- **`MemoryAdvisor`**：记忆建议器，提供 suggest / sourceHealth 查询
- **`MemoryDecayScheduler`**：记忆衰减调度器，init 首次 + 每小时定时衰减
- **ADR-016**：向量存储接口化决策记录
- **ADR-015**：archiveMode 三态归档控制决策记录
- **ADR-002/004/014 补充**：Logger 懒初始化、content 多用途、关系查询归属 + RelationBuilder 拆分

### Changed（改进）

- **zod schema 单一真理源**：`DEFAULT_CONFIG` 常量移除，配置默认值由 zod schema `.default()` 声明（P0-1）
- **Logger 懒初始化**：`maybeUpgradeToPino()` 延迟触发，import 零 fs 副作用（P0-6）
- **EmbeddingProvider 默认超时**：60 秒默认请求超时（可通过 `timeoutMs` 覆盖）
- **`ProjectManager` 瘦身**：从 640 行缩减到 410 行，注册表/锁文件操作委托给 `ProjectRegistry`/`LockManager`
- **`InsightExtractor` 瘦身**：关系构建逻辑委托给 `RelationBuilder`
- **测试目录镜像**：`managers/__tests__/` 严格镜像 `src/` 目录结构（ADR-007）

### Fixed（修复）

- **zod schema 与 DEFAULT_CONFIG 不一致**：配置默认值单一真理源
- **eval 护栏检测依赖中文魔法字符串**：改用 `guardrailBlocked` 结构化标志位
- **Logger import 触发 fs 副作用**：懒初始化，import 零 IO
- **Embedding 请求无超时/取消保护**：支持 AbortSignal + timeoutMs
- **`insightExtractor.ts` inline `import()` 类型**：改为顶层 type import

### Internal（内部变更，不影响公共 API）

- `types.ts` 拆分为 `types.ts` + `sourceValidation.ts` + `segmenter.ts`（STOPWORDS 迁移）
- `MemoryInspector` 移除写方法，保留只读编排职责
- `safeTimer` 的 `clearAllSafeTimers`/`getActiveTimerCount` 已不在公共导出（早期迭代已收敛）
- 11 个 manager 测试文件迁移到 `managers/__tests__/`

## [0.3.0] - 2026-06-27

Phase 5.1/5.2 初始 npm 发布版本。
