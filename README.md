# Memora 🌲

> 通用 Agent 架构 — 本地、私有、领域无关，万物皆记忆

[![Node.js](https://img.shields.io/badge/Node.js-≥20-green)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

## 设计哲学

> **万物皆是记忆。**
>
> 除了用户当前直接输入的提示词内容，Agent 的一切都是记忆——人格是"我记得我是谁"，规则是"我记得该怎么做事"，技能是"我记得怎么做某类事"，对话历史是"我记得之前聊过什么"。

Memora 是一个**自研可控、本地私有化、领域无关的通用 AI
Agent 系统**。区别于通用对话机器人，Memora 具备以下核心差异化能力：

- **长期记忆沉淀**——跨会话、跨话题的记忆持久化与智能召回
- **记忆永久性分级约束**——通过 `always` / `domain` / `topic` / `on-demand`
  标记控制召回确定性
- **自主记忆召回**——Agent 自主从记忆中召回所需内容
- **领域可插拔**——同一套架构，加载不同记忆配置即可适配不同领域

## 核心架构

```
用户需求 → 基础记忆召回（永驻 + 领域）→ [Agent Loop: 模型推理 → 工具调用/增量记忆召回 → 结果回填 → 循环] → 后置处理 → 记忆写入与沉淀
```

详细设计见 [`docs/基础设计文档/`](./docs/基础设计文档/)：

- [agent设计.md](./docs/基础设计文档/agent设计.md) v3.5 — 架构总纲
- [agent上下文组装协议.md](./docs/基础设计文档/agent上下文组装协议.md) v3.3
  — 上下文组装子系统
- [安全权限设计 v0.1.md](./docs/基础设计文档/安全权限设计%20v0.1.md) — 安全模型
- [测试策略.md](./docs/基础设计文档/测试策略.md) — 测试规范

## 快速开始

### 安装

```bash
npm install
```

### 初始化项目

```bash
npx tsx src/index.ts init
```

会在当前目录创建 `.memora/` 目录结构（personality / rules / skills / topics /
archive）。

### 启动对话（使用 Mock LLM）

```bash
npx tsx src/index.ts chat
```

### 启动对话（使用真实 LLM）

```bash
# 设置环境变量
export MEMORA_LLM_API_KEY=sk-xxx

# 编辑 .memora/config.json
{
  "llm": {
    "provider": "deepseek",      // 或 "doubao" / "openai"
    "model": "deepseek-chat",
    "apiKey": "${MEMORA_LLM_API_KEY}"
  }
}

# 启动
npx tsx src/index.ts chat
```

## 技术栈

| 类别   | 选型                                  | 决策                                                              |
| ------ | ------------------------------------- | ----------------------------------------------------------------- |
| 运行时 | Node.js ≥ 20 LTS + TypeScript 5 + ESM | [ADR-001](./.trae/rules/decisions/ADR-001-runtime-stack.md)       |
| 数据层 | better-sqlite3 + sqlite-vec           | [ADR-002](./.trae/rules/decisions/ADR-002-storage-layer.md)       |
| LLM    | OpenAI Chat Completions 兼容协议      | [ADR-003](./.trae/rules/decisions/ADR-003-llm-adapter.md)         |
| 形态   | CLI 优先                              | [ADR-005](./.trae/rules/decisions/ADR-005-cli-first.md)           |
| 安全   | 两级权限 + 路径白名单                 | [ADR-006](./.trae/rules/decisions/ADR-006-security-model.md)      |
| 测试   | Vitest + MSW                          | [ADR-007](./.trae/rules/decisions/ADR-007-testing-strategy.md)    |
| 目录   | 按职责分层                            | [ADR-008](./.trae/rules/decisions/ADR-008-directory-structure.md) |

## 项目结构

```
memora/
├── docs/                     # 设计文档
│   ├── 基础设计文档/         # 6 份核心文档
│   ├── 领域适配示例/         # 小说创作领域示例
│   ├── 创意设计单页纸.md     # 核心矛盾
│   ├── 土壤分析报告.md       # 项目环境
│   └── 项目决策表.md         # 技术栈选型
├── src/                      # 源代码
│   ├── cli/                  # CLI 解析与交互
│   ├── agent/                # Agent Loop
│   ├── memory/               # 记忆引擎
│   ├── llm/                  # LLM 适配层
│   ├── security/             # 安全策略
│   ├── config/               # 配置加载
│   └── logging/              # 日志
├── tests/                    # 测试
├── .trae/
│   ├── rules/                # 规则文件
│   │   ├── decisions/        # ADR 决策年轮
│   │   ├── project-rules.md  # 项目总则
│   │   └── ...               # 各类规则
└── tasks/                    # 任务管理
```

## 开发命令

```bash
npm run dev          # 启动开发模式（watch）
npm test             # 运行测试
npm run test:cov     # 运行测试 + 覆盖率
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化
```

## 阶段一交付（v0.1.0 · 极简版）

- ✅ 5 层记忆体系 schema 完整
- ✅ SQLite 索引 + 文件存储冷热分离
- ✅ Agent Loop 流式对话
- ✅ LLM 适配层（DeepSeek / 豆包 / OpenAI / Mock）
- ✅ 路径白名单 + 两级权限
- ✅ Vitest + MSW 测试基础设施
- ⏳ CLI REPL 基础交互
- ⏳ 1 个内置工具（`read_file`）

## 路线图

| 阶段              | 范围                                                  | 状态      |
| ----------------- | ----------------------------------------------------- | --------- |
| **阶段一·极简版** | Node.js 骨架 + 5 类记忆 + LLM 适配 + Agent Loop + CLI | 🚧 进行中 |
| **阶段二·增强版** | FTS5 + jieba + 冥想归档 + 工具白名单                  | ⏳ 待启动 |
| **阶段三·完备版** | sqlite-vec 语义检索 + 多项目并发 + 领域切换           | ⏳ 待启动 |

## 贡献

本项目遵循"大树模型"工程哲学。详细开发规范见 [`.trae/rules/`](./.trae/rules/)。

## 许可证

MIT
