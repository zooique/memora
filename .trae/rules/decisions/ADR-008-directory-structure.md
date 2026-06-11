---
alwaysApply: false
description: 目录结构按"职责分层"而非"按类型分层"
version: v0.4
date: 2026-06-11
---

# ADR-008 · 目录结构按"职责分层"而非"按类型分层"

> **状态**：✅ 已接受 **日期**：2026-06-02 **播种批次**：Memora 模式 A v1
> **来源**：[项目决策表.md §八](../../docs/项目决策表.md)

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
- **符合 Memora 的"领域可插拔"哲学**：领域切换通过 DomainManager 切换 .memora/ 目录，核心代码不动

## 目录结构（当前）

```
src/
├── index.ts                # 库导出入口（纯类型 + 接口导出）
├── agent/                  # Agent Loop + 工具执行 + 对话快照 + 作品投影
├── memory/                 # 记忆引擎（IMemoryStorage 接口 + InMemoryStorage 实现 + 管理器）
├── persona/                # 角色管理
├── skill/                  # 技能管理
├── llm/                    # LLM 适配层
├── security/               # 安全策略
├── config/                 # 配置加载
├── logging/                # 日志（ILogger + console fallback）
└── utils/                  # 工具函数
```

> **已移出至宿主项目**：
> - `cli/` → 泊文 `hosts/memora-cli/`
> - `SqliteStorage`（原 `memory/index.ts`） → 泊文 `hosts/memora-utils/sqlite-storage.ts`
> - `commander`、`picocolors` → 泊文 dependencies

## 年轮修订

### v0.2（2026-06-02）· 阶段三目录结构更新

**变更**：新增 3 个文件（embedding.ts / vector-store.ts / domain-manager.ts）

**设计演进**：

- 领域切换从"只改 skills/ 和 personality/"演进为"DomainManager 切换 .memora/ 目录"
- 每个领域有独立的 SQLite + 向量索引 + 安全守卫
- embedding.ts 放在 llm/ 下（属于 LLM 适配层，调用 /embeddings API）
- vector-store.ts 放在 memory/ 下（属于记忆引擎的向量索引层）

### v0.3（2026-06-02）· M-207 多项目并发

**变更**：新增 project-manager.ts；repl.ts 新增 /project 命令

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
- 模块内部可再分文件：`agent/loop.ts` / `agent/tool-executor.ts`
- 跨模块共享的类型放 `src/types/`（极少使用）
- 阶段一专注核心模块：`agent` / `memory` / `persona` / `skill` / `llm` / `security` / `config` / `logging` / `utils`

## 何时回顾

- 当 `agent/` 目录超过 20 个文件需要再细分
- 当出现跨多个模块的横切关注点（如 logging）

### v0.4（2026-06-11）· 零依赖内核目录更新

**变更**：移除 `cli/`、`memory/index.ts`（SqliteStorage），更新 `src/index.ts` 定位

**设计演进**：
- memora 内核定位为零 native 依赖纯逻辑库
- CLI 移出至宿主项目（泊文 `hosts/memora-cli/`）
- SqliteStorage 移出至宿主项目（泊文 `hosts/memora-utils/sqlite-storage.ts`）
- `src/index.ts` 从 CLI 入口转变为库导出入口
- 目录结构简化为 9 个纯逻辑模块
