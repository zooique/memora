---
alwaysApply: false
description: 目录结构按"职责分层"而非"按类型分层"
version: v0.1
date: 2026-06-02
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

## 目录结构（阶段三）

```
src/
├── index.ts                # CLI 入口
├── cli/                    # CLI 解析与交互
│   ├── commands/           # 子命令
│   │   └── init.ts         # 初始化命令
│   └── repl.ts             # REPL 主循环（含 /project + /domain + /search 命令 + rebuildAgentComponents）
├── agent/                  # Agent Loop
│   ├── loop.ts
│   ├── tool-executor.ts
│   └── message-history.ts
├── memory/                 # 记忆引擎
│   ├── types.ts
│   ├── store.ts            # 文件存储
│   ├── index.ts            # SQLite 索引
│   ├── recall.ts           # 混合召回（关键词 + 向量）
│   ├── vector-store.ts     # 向量存储（M-206）
│   ├── domain-manager.ts   # 领域管理器（M-208）
│   ├── project-manager.ts  # 项目管理器（M-207）
│   ├── loader.ts           # 记忆加载器
│   └── topic-store.ts      # 话题存储
├── llm/                    # LLM 适配层
│   ├── provider.ts         # 抽象接口
│   ├── openai-compatible.ts
│   ├── embedding.ts        # Embedding Provider（M-206）
│   └── factory.ts          # 工厂函数
├── security/               # 安全策略
│   ├── permissions.ts
│   └── path-guard.ts
├── config/                 # 配置加载
├── utils/                  # 工具函数
└── logging/                # 日志
```

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
- 每个项目有独立的 .memora/ 目录（项目根目录下），与 config.dataDir（用户级默认）分离
- 锁文件机制（.memora/.lock）防止同项目并发写入
- 全局规则目录（~/.memora/global/rules/）跨项目共享只读规则
- 项目注册表（~/.memora/projects.json）记录已注册项目

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
- 阶段一专注核心 6 个模块：`cli` / `agent` / `memory` / `llm` / `security` /
  `config`

## 何时回顾

- 当 `agent/` 目录超过 20 个文件需要再细分
- 当出现跨多个模块的横切关注点（如 logging）
