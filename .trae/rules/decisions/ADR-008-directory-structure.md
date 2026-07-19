---
alwaysApply: false
description: 目录结构按"职责分层"而非"按类型分层"
version: v0.4
date: 2026-06-11
---

# ADR-008 · 目录结构按"职责分层"而非"按类型分层"

> **状态**：✅ 已接受 **日期**：2026-06-02 **播种批次**：Memora 模式 A v1
> **来源**：(历史设计文档已归档：项目决策表.md §八)

## 背景

代码组织有两种主流风格：

- **按类型分层**：`controllers/` / `services/` / `models/`（按代码角色）
- **按职责分层**：`agent/` / `memory/` / `llm/` / `skills/`（按业务模块）

## 决策

采用**按职责分层**（业务模块优先）。每个模块内部可再细分（types / store / index
/ test）。

## 理由

- **业务内聚**：agent 相关的所有代码在 `agent/` 下，无需跨目录跳转
- **新人友好**：看一个模块就知道"Agent 怎么工作"——所有相关代码在一起
- **可替换性**：未来 `memory/` 整个模块替换（如换 LanceDB）不影响其他模块
- **符合 Memora 的"领域可插拔"哲学**：领域切换通过角色自动匹配（PersonaManager）切换，核心代码不动

## 目录结构（当前）

```
src/
├── index.ts                # 库导出入口（类型 + 接口 + 函数 + 类导出）
├── agent/                  # Agent 门面 + AgentLoop + 工具执行 + managers/ 子目录（13 个专职 Manager/服务类）+ 对话快照 + 作品投影
├── memory/                 # 记忆引擎（IMemoryStorage 接口 + InMemoryStorage 实现 + 召回 + IMemoryRelationStore 侧车接口）
├── persona/                # 角色管理
├── skill/                  # 技能管理
├── llm/                    # LLM 适配层
├── security/               # 安全策略
├── config/                 # 配置加载
├── logging/                # 日志（ILogger + console fallback）
├── eval/                   # 评估框架（EvalScenario 类型 + 工具函数）
└── utils/                  # 工具函数（含 eventEmitter.ts 事件系统）
```

> **已移出至精灵宿主项目**（详见 [ADR-SP-007](./ADR-SP-007-directory-structure.md)）：
> - `cli/` → `hosts/memora-sprite/src/cli.ts`
> - `SqliteStorage`（原 `memory/index.ts`） → `hosts/memora-sprite/src/storage/sqliteStorage.ts`
> - `SqliteRelationStore`（ADR-014 侧车实现） → `hosts/memora-sprite/src/storage/sqliteRelationStore.ts`
> - `commander`、`picocolors` → 精灵宿主 dependencies

## 年轮修订

### v0.2（2026-06-02）· 阶段三目录结构更新

**变更**：新增 2 个文件（embedding.ts / vectorStore.ts）

**设计演进**：

- 领域切换从"只改 skills/ 和 personality/"演进为"角色自动匹配（PersonaManager）"
- 每个领域有独立的 SQLite + 向量索引 + 安全守卫
- embedding.ts 放在 llm/ 下（属于 LLM 适配层，调用 /embeddings API）
- vectorStore.ts 放在 memory/ 下（属于记忆引擎的向量索引层）

### v0.3（2026-06-02）· M-207 多项目并发

**变更**：新增 projectManager.ts；repl.ts 新增 /project 命令

**设计演进**：

- 多项目并发从"每个项目独立进程"演进为"ProjectManager 管理项目切换"
- 三层架构：Agent 级配置（configDir）→ 用户记忆（dataDir）→ 项目级配置（projectPath/.memora/）
- 锁文件机制（.memora/.lock）防止同项目并发写入
- 项目注册表（dataDir/projects.json）记录已注册项目

## 反例（按类型分层的问题）

```
src/
├── controllers/    # agent/llm/memory 各自的 controller 散落
├── services/       # agent/llm/memory 各自的 service 散落
└── models/         # agent/llm/memory 各自的 model 散落
```

→ 改一个 agent 功能要跳 3 个目录；新人看不懂"agent 整体怎么工作"

## 影响

- `src/` 下不允许有 `utils.ts` 这种根级文件（必须放 `utils/` 目录）
- 模块内部可再分文件：`agent/loop.ts` / `agent/toolExecutor.ts`
- 跨模块共享的类型放 `src/types/`（极少使用）
- 阶段一专注核心模块：`agent` / `memory` / `persona` / `skill` / `llm` / `security` / `config` / `logging` / `utils`

## 何时回顾

- 当 `agent/` 目录超过 20 个文件需要再细分
- 当出现跨多个模块的横切关注点（如 logging）

### v0.4（2026-06-11）· 零依赖内核目录更新

**变更**：移除 `cli/`、`memory/index.ts`（SqliteStorage），更新 `src/index.ts` 定位

**设计演进**：
- memora 内核定位为零 native 依赖纯逻辑库
- CLI 移出至精灵宿主项目（`hosts/memora-sprite/src/cli.ts`）
- SqliteStorage 移出至精灵宿主项目（`hosts/memora-sprite/src/storage/sqliteStorage.ts`）
- `src/index.ts` 从 CLI 入口转变为库导出入口
- 目录结构简化为 9 个纯逻辑模块

### v0.5（2026-06-20）· agent/managers/ 子目录

**变更**：新增 `agent/managers/` 子目录，归拢 7 个专职 Manager 文件

**设计演进**：
- agent/ 目录从 17 个文件增长，专职 Manager 散落导致查找困难
- 7 个 Manager 文件（ConfigManager / SessionManager / MemoryInspector / InsightExtractor / AutoConfigRefiner / WorkProjectionManager / UserFactExtractor）归入 `agent/managers/`
- 核心文件（agent.ts / loop.ts / assembler.ts / toolExecutor.ts 等）保留在 `agent/`
- 符合 ADR-008 原设计"当 agent/ 目录超过 20 个文件需要再细分"的回顾条件

### v0.6（2026-06-22）· 规则文档与实际产出对齐

**变更**：backend_layers_rules.md 文件清单与实际 src/ 目录对齐

**设计演进**：
- agent/ 清单补充 `constants.ts`（Agent/Loop 常量集合），反映 managers/ 子目录结构
- utils/ 清单补充 4 个遗漏文件：`toError.ts`（纯逻辑 toError）、`loggerHolder.ts`（Logger 持有者）、`path.ts`（路径工具）、`time.ts`（时间工具）
- 年轮审判发现规则文档滞后于产出，此次双向对齐

### v0.7（2026-07-16）· managers/ 子目录 Manager 数量同步

**变更**：managers/ 子目录专职 Manager/服务类数量从 v0.5 的 7 个增长到 13 个，本次年轮补记

**设计演进**：
- v0.5 原 7 个：ConfigManager / SessionManager / MemoryInspector / InsightExtractor / AutoConfigRefiner / WorkProjectionManager / UserFactExtractor（注：UserFactExtractor 实际位于 agent/ 根级，非 managers/，v0.5 年轮记录有误）
- v0.7 当前 13 个：ArchiveCoordinator / AutoConfigRefiner / ChatLock / Config / Insight / MemoryAdvisor / MemoryDecay / MemoryInspector / RelationBuilder / Session / SessionArchiver / TextPolish / WorkProjection
- 新增 6 个 Manager/服务类：ArchiveCoordinator（归档协调）、ChatLock（并发锁）、MemoryAdvisor（记忆建议）、MemoryDecay（记忆衰减）、RelationBuilder（关系构建）、TextPolish（文本润色，无状态服务类）
- UserFactExtractor 保留在 agent/ 根级（纯函数模块，非 Manager）
- TextPolishManager 命名沿用"Manager"后缀但实际是无状态服务类（详见 [ADR-SP-017](./ADR-SP-017-quick-input-architecture.md) §3 补录）
- 本次年轮同步触发自 2026-07-16 根须体系健康度诊断（发现 Manager 数量三处不同步）
