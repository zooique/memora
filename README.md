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
- **记忆价值过滤**——三步判断（价值评估 → 核心精炼 → 答案收敛），只归档用户独特信息，不堆砌 LLM 通用知识。详见
  [记忆归档原则.md](./docs/基础设计文档/记忆归档原则.md)

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
- [记忆归档原则.md](./docs/基础设计文档/记忆归档原则.md) v0.2
  — 记忆价值过滤（三步判断）

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

### 启动对话

```bash
npx tsx src/index.ts chat                # 使用 Mock LLM（开箱即用）
npx tsx src/index.ts chat --project /path/to/project  # 指定项目目录
```

### 使用真实 LLM

```bash
# 设置环境变量
export MEMORA_LLM_API_KEY=sk-xxx

# 编辑 .memora/config.json
{
  "llm": {
    "provider": "deepseek",      // 或 "doubao" / "openai" / "mimo"
    "model": "deepseek-chat",
    "apiKey": "${MEMORA_LLM_API_KEY}"
  }
}

# 启动
npx tsx src/index.ts chat
```

### REPL 命令

| 命令               | 说明                              |
| ------------------ | --------------------------------- |
| `/help`            | 显示帮助                          |
| `/tools`           | 列出可用工具                      |
| `/memories`        | 列出已加载记忆                    |
| `/search <关键词>` | 搜索记忆（关键词匹配）            |
| `/project [name]`  | 切换/列出项目（M-207 多项目并发） |
| `/domain [name]`   | 切换/列出领域（M-208 领域切换）   |
| `/topic [name]`    | 切换/查看话题                     |
| `/topics`          | 列出所有话题文件                  |
| `/exit`, `/quit`   | 退出                              |

## 技术栈

| 类别     | 选型                                  | 决策                                                              |
| -------- | ------------------------------------- | ----------------------------------------------------------------- |
| 运行时   | Node.js ≥ 20 LTS + TypeScript 5 + ESM | [ADR-001](./.trae/rules/decisions/ADR-001-runtime-stack.md)       |
| 数据层   | better-sqlite3                        | [ADR-002](./.trae/rules/decisions/ADR-002-storage-layer.md)       |
| 向量检索 | 纯 JS 余弦相似度 + JSON 持久化        | [ADR-002](./.trae/rules/decisions/ADR-002-storage-layer.md) v0.2  |
| 嵌入     | OpenAI-compatible /embeddings API     | M-206 本地缓存                                                    |
| LLM      | OpenAI Chat Completions 兼容协议      | [ADR-003](./.trae/rules/decisions/ADR-003-llm-adapter.md)         |
| 形态     | CLI 优先                              | [ADR-005](./.trae/rules/decisions/ADR-005-cli-first.md)           |
| 安全     | 两级权限 + 路径白名单                 | [ADR-006](./.trae/rules/decisions/ADR-006-security-model.md)      |
| 测试     | Vitest + MSW                          | [ADR-007](./.trae/rules/decisions/ADR-007-testing-strategy.md)    |
| 目录     | 按职责分层                            | [ADR-008](./.trae/rules/decisions/ADR-008-directory-structure.md) |

## 项目结构

```
memora/
├── docs/                     # 设计文档
│   ├── 基础设计文档/         # 6 份核心文档（含记忆归档原则）
│   ├── 领域适配示例/         # 小说创作领域示例
│   ├── 创意设计单页纸.md     # 核心矛盾
│   ├── 土壤分析报告.md       # 项目环境
│   └── 项目决策表.md         # 技术栈选型
├── src/                      # 源代码
│   ├── index.ts              # CLI 入口
│   ├── cli/
│   │   ├── repl.ts           # REPL 主循环（含 /search /project /domain /topic 命令）
│   │   └── format.ts         # ANSI 格式化输出
│   ├── agent/
│   │   ├── loop.ts           # Agent Loop（流式 + 工具调用）
│   │   ├── tool-executor.ts  # 工具执行器（内置 4 工具）
│   │   └── message-history.ts # 消息历史（事件驱动归档 + 三步判断）
│   ├── memory/
│   │   ├── index.ts          # 关键词索引
│   │   ├── store.ts          # 文件存储
│   │   ├── topic-store.ts    # 话题文件管理
│   │   ├── vector-store.ts   # 纯 JS 向量索引（M-206）
│   │   ├── recall.ts         # 混合召回（关键词 + 向量）
│   │   ├── loader.ts         # 记忆加载器
│   │   ├── domain-manager.ts # 领域管理器（M-208）
│   │   └── project-manager.ts # 项目管理器（M-207）
│   ├── llm/
│   │   ├── factory.ts        # LLM Provider 工厂
│   │   ├── openai-compatible.ts # OpenAI 兼容协议适配
│   │   └── embedding.ts      # 嵌入向量 Provider（M-206）
│   ├── security/
│   │   └── path-guard.ts     # 路径白名单 + 黑名单 + 审计
│   ├── config/
│   │   └── loader.ts         # 配置加载
│   ├── logging/
│   │   └── logger.ts         # pino 日志
│   └── utils/
│       └── errors.ts         # MemoraError 错误体系
├── .trae/
│   ├── rules/
│   │   ├── decisions/        # ADR 决策年轮（8 份）
│   │   ├── project-rules.md  # 项目总则
│   │   └── ...               # 各类规则
│   └── skills/               # 大树模型技能
└── tasks/                    # 任务管理
```

## 开发命令

```bash
npm run dev          # 启动开发模式（watch）
npm test             # 运行测试（23 files / 217 tests）
npm run test:cov     # 运行测试 + 覆盖率
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 检查
npm run format       # Prettier 格式化
```

## 阶段交付物

### 阶段一（v0.1.0 · 极简版）✅ 已完成

- ✅ 5 层记忆体系 schema 完整
- ✅ SQLite 索引 + 文件存储冷热分离
- ✅ Agent Loop 流式对话
- ✅ LLM 适配层（DeepSeek / 豆包 / OpenAI / mimo / Mock）
- ✅ 路径白名单 + 两级权限
- ✅ Vitest + MSW 测试基础设施
- ✅ CLI REPL 基础交互（readline + 9 个命令）
- ✅ 4 个内置工具（read_file / write_file / list_dir / search_memories）
- ✅ 健康度 90/100 (A-)

### 阶段二（增强版）✅ 已完成

- ✅ FTS5 全文搜索
- ✅ jieba 中文分词
- ✅ 记忆加载器
- ✅ 话题持久化 + 事件驱动归档
- ✅ 工具白名单
- ✅ 测试覆盖率达标（lines ≥ 75%, branches ≥ 70%）

### 阶段三（完备版）✅ 已完成

- ✅ 语义检索（纯 JS 余弦相似度 + Embedding API + 本地缓存）— M-206
- ✅ 多项目并发（锁文件 + 项目注册表 + 全局规则）— M-207
- ✅ 领域切换（DomainManager + .memora-{name} 目录）— M-208
- ✅ 记忆价值过滤（三步判断归档原则）— M-209
- ✅ `/search` 记忆搜索命令

## 路线图

| 阶段               | 范围                                                  | 状态      |
| ------------------ | ----------------------------------------------------- | --------- |
| **阶段一·极简版**  | Node.js 骨架 + 5 类记忆 + LLM 适配 + Agent Loop + CLI | ✅ 已完成 |
| **阶段二·增强版**  | FTS5 + jieba + 话题归档 + 工具白名单 + 测试覆盖       | ✅ 已完成 |
| **阶段三·完备版**  | 语义检索 + 多项目并发 + 领域切换 + 记忆价值过滤       | ✅ 已完成 |
| **阶段四（待定）** | 本地模型 (Ollama) / Web 形态 / 结构化归档 / RAG 增强  | ⏳ 待决策 |

## 贡献

本项目遵循"大树模型"工程哲学。详细开发规范见 [`.trae/rules/`](./.trae/rules/)。

## 许可证

MIT
