# Changelog

本文件记录 @zooique/memora 的版本变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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

### Added（新增功能）

- **`MemoryMutator`**：记忆写入器，与 `MemoryInspector` 严格分工（读写分离）
- **`RelationBuilder`**：关系构建器，从 `InsightExtractor` 提取（P1-3），支持冲突检测回调
- **`ProjectRegistry`** + **`LockManager`**：从 `ProjectManager` 拆分（P1-4），宿主可直接使用
- **`IVectorStore`** 接口：向量存储抽象，宿主可注入自定义实现（ADR-016）
- **`EmbeddingOptions`**：embedding 调用选项（`signal?: AbortSignal` + `timeoutMs?: number`），`EmbeddingProvider.embed/batchEmbed` 和 `IVectorStore` 方法支持外部取消 + 超时中断（P1-8）
- **`ConflictInfo`** 类型：关系冲突信息，`RelationBuilder.bindOnConflict()` 回调参数
- **`guardrail.ts`** 独立模块：内容护栏纯函数 `runGuardrails()`，从 `AgentLoop` 提取（P1-1）
- **`sourceValidation.ts`**：source 校验工具从 `types.ts` 拆分（P1-2）
- **AgentChunk `guardrailBlocked`** 标志位：结构化护栏信号，替代中文字符串匹配（P0-7）
- **ADR-016**：向量存储接口化决策记录
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
