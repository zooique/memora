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
- **符合 Memora 的"领域可插拔"哲学**：领域切换只改 `skills/` 和
  `personality/`，核心代码不动

## 目录结构（阶段一）

```
src/
├── index.ts                # CLI 入口
├── cli/                    # CLI 解析与交互
│   ├── commands/           # 子命令
│   └── repl.ts             # REPL 主循环
├── agent/                  # Agent Loop
│   ├── loop.ts
│   ├── tool-executor.ts
│   └── message-history.ts
├── memory/                 # 记忆引擎
│   ├── types.ts
│   ├── store.ts            # 文件存储
│   ├── index.ts            # SQLite 索引
│   ├── recall.ts
│   └── assemble.ts
├── llm/                    # LLM 适配层
│   ├── provider.ts         # 抽象接口
│   ├── openai-compatible.ts
│   └── providers/          # 各家实现
├── security/               # 安全策略
│   ├── permissions.ts
│   ├── path-guard.ts
│   └── tool-guard.ts
├── config/                 # 配置加载
├── utils/                  # 工具函数
└── logging/                # 日志
```

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
