# Memora

> 通用 Agent 记忆内核 — 本地、私有、领域无关，万物皆记忆

[![npm](https://img.shields.io/npm/v/@zooique/memora)](https://www.npmjs.com/package/@zooique/memora)
[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![Coverage](https://img.shields.io/badge/coverage-90%25-brightgreen)](https://vitest.dev)
[![Tests](https://img.shields.io/badge/tests-1983%20passed-brightgreen)](https://vitest.dev)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-yellowgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

**English** → [README.en.md](./README.en.md)

---

## 这是什么？

Memora 是一个 **Agent 记忆基础设施**——让你的 AI Agent 拥有跨会话、跨话题的长期记忆能力。

它解决一个核心问题：**LLM 是无状态的，但用户的任务是连续的。**

Memora 在无状态推理之上构建连续演化能力：记忆沉淀、智能召回、自然衰减、语义去重、冲突检测——完整的记忆生命周期管理，全部在本地完成，数据不出你的机器。

## 设计哲学

> **万物皆是记忆。**
>
> 人格是"我记得我是谁"，规则是"我记得该怎么做事"，技能是"我记得怎么做某类事"，对话历史是"我记得之前聊过什么"。

Memora 是一个**无法独立运行**的智能大脑内核——它只有接口，没有"形态"。CLI、WebUI、桌面精灵、小说生成器都是它的"宿主"，宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。

## 核心能力

| 能力 | 说明 |
|------|------|
| **长期记忆沉淀** | 跨会话、跨话题的记忆持久化与智能召回 |
| **双通道召回** | 语义向量搜索 + 关键词搜索，hybridMerge 融合排序 |
| **记忆治理 L1-L4** | L1 语义去重 → L2 时效评估 → L3 冲突检测 → L4 定时衰减 |
| **记忆关系图谱** | contradicts / supports / follows / refines / caused 五种关系类型 |
| **Agent 与角色分离** | Agent 是纯记忆引擎，角色是人格载体。换角色不丢记忆 |
| **统一记忆模型** | 一切统一为「记忆」，通过 `source` 开放字符串区分，无封闭枚举 |
| **领域可插拔** | 同一套架构，加载不同记忆配置即可适配不同领域 |
| **零依赖内核** | 核心层无任何第三方运行时依赖，持久化由宿主通过接口注入 |
| **内容护栏** | 正则规则 + block/warn 双动作，输入输出双向检查 |
| **可观测性** | ITracer 接口 + 结构化 span，宿主可接入任意 APM |

## 快速开始

### 安装

```bash
npm install @zooique/memora
```

### 创建 Agent

```typescript
import { Agent, createLlmProvider } from '@zooique/memora';

// 宿主职责：创建 LLM Provider（兼容所有 OpenAI Chat Completions 协议的服务）
const provider = createLlmProvider({
  provider: 'openaiCompatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
});

// 创建 Agent
const agent = new Agent({
  projectPath: '/path/to/project',
  provider,
  configDir: '/path/to/agent-config', // personas / rules / skills
  dataDir: '.memora',                 // 记忆数据存储目录
});

await agent.init();
```

### 对话（流式）

```typescript
for await (const chunk of agent.chat('你好，记住我喜欢 TypeScript')) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.content);
  }
}

// 下一次对话，Agent 会自动召回"喜欢 TypeScript"这条记忆
const reply = await agent.chatSync('我喜欢什么语言？');
// → 基于召回的记忆回答
```

### 记忆管理

```typescript
// 搜索记忆
const hits = await agent.memory.searchHybrid('TypeScript 偏好', { limit: 5 });

// 记忆治理：语义去重
const report = await agent.deduplicateMemories();
console.log(`去重 ${report.deduplicatedCount} 条`);

// 记忆治理：时效性评估
const timeliness = await agent.evaluateTimeliness();

// 记忆治理：冲突检测
const conflicts = await agent.detectConflicts();

// 手动触发衰减
await agent.runMemoryDecayOnce();
```

### 关闭

```typescript
await agent.close();
```

## 架构

```
┌────────────────────────────────────────────────────────────┐
│  宿主程序（CLI / 桌面精灵 / 小说生成器 / WebUI）            │
│  ┌─────────────────┐    ┌──────────────────┐               │
│  │ LLM Provider 实例 │◄───│ API Key / baseUrl │  ← 宿主职责  │
│  └────────┬────────┘    └──────────────────┘               │
│           │ 注入                                            │
│           ▼                                                 │
│  ┌──────────────────────────────────────────┐               │
│  │  Memora 内核（Agent）                    │               │
│  │  - chat(input) → 流式响应                │               │
│  │  - 双通道记忆召回（语义 + 关键词）       │               │
│  │  - 记忆治理 L1-L4（去重/时效/冲突/衰减） │               │
│  │  - 角色匹配 / 技能匹配 / 护栏检查        │               │
│  │  - 工具注册 / 工具执行 / 反思重试        │               │
│  │  - 会话归档 / 洞察提取 / 关系构建        │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

### 六大注入接口

内核通过接口与外部世界交互，宿主按需注入：

| 接口 | 职责 | 内置实现 |
|------|------|----------|
| `IMemoryStorage` | 记忆 CRUD + 搜索 + 衰减 | `InMemoryStorage` |
| `IVectorStore` | 语义向量索引 | `JsonVectorStore` |
| `IMemoryRelationStore` | 记忆关系图谱 | `InMemoryRelationStore` |
| `ISessionStore` | 会话历史持久化 | 无（宿主实现） |
| `ILogger` | 日志输出 | console fallback |
| `ITracer` | 可观测性 span | `NOOP_TRACER` |

## 项目结构

```
src/
├── index.ts          # 库导出入口（纯类型 + 接口导出，无 CLI）
├── agent/            # Agent 门面 + AgentLoop 执行引擎
│   ├── agent.ts      # 门面类（宿主唯一入口）
│   ├── loop.ts       # 核心循环（推理 → 工具调用 → 反思重试）
│   ├── assembler.ts  # 组件组装器（纯工厂，不持有状态）
│   ├── toolExecutor.ts    # 工具注册与执行
│   ├── contextManager.ts  # 上下文窗口管理（截断 + 摘要）
│   ├── guardrail.ts       # 内容护栏（正则 + block/warn）
│   └── managers/          # 14 个专职 Manager + 辅助模块
│       ├── archiveCoordinator.ts   # 归档协调（会话归档 + 洞察提取）
│       ├── memoryInspector.ts      # 记忆读写（CRUD + 搜索 + 统计）
│       ├── memoryGovernance.ts     # 治理统一门面（L1-L4）
│       ├── dedupManager.ts         # L1 语义去重
│       ├── memoryDecayScheduler.ts # L4 定时衰减 + L2 时效评估
│       ├── memoryAdvisor.ts        # L3 冲突检测 + 健康诊断
│       ├── insightExtractor.ts     # 对话洞察提取
│       ├── relationBuilder.ts      # 记忆关系构建（ADR-014）
│       ├── sessionManager.ts       # 会话管理（分叉/切换）
│       ├── sessionArchiver.ts      # 会话内容归档
│       ├── configManager.ts        # 配置管理（规则/技能热加载）
│       ├── autoConfigRefiner.ts    # 自进化配置建议
│       ├── workProjection.ts       # 作品投影管理
│       ├── textPolishManager.ts    # 文本润色
│       └── chatLockManager.ts      # 对话并发锁
├── memory/           # 记忆引擎
│   ├── types.ts          # Memory 基元（8 字段）+ 关系类型
│   ├── storageInterface.ts  # IMemoryStorage 接口（16 方法）
│   ├── recall.ts         # 双通道召回（语义 + 关键词）
│   ├── hybridMerge.ts    # 融合排序算法
│   ├── vectorStore.ts    # IVectorStore + JsonVectorStore
│   ├── relationStore.ts  # IMemoryRelationStore 接口
│   ├── governance.ts     # 治理共享常量（衰减/提升/上限）
│   ├── userProfile.ts    # 用户画像管理
│   └── projectManager.ts # 多项目注册 + 锁管理
├── llm/              # LLM 适配层
│   ├── provider.ts       # LlmProvider 抽象类
│   ├── openaiCompatible.ts  # OpenAI 兼容协议实现
│   ├── embedding.ts      # EmbeddingProvider（/embeddings 端点）
│   └── factory.ts        # createLlmProvider 工厂
├── persona/          # 角色管理（纯文件 + 内存缓存）
├── skill/            # 技能管理（关键词匹配 + 当轮注入）
├── security/         # 安全策略（两级权限 + 路径白名单 + 审计）
├── config/           # 配置加载（JSON + 环境变量插值）
├── logging/          # 日志（ILogger 接口 + 懒初始化）
├── eval/             # 评估框架（EvalScenario + EvalRunner，CI 用）
└── utils/            # 工具函数（事件系统/分词/分片/错误/定时器）
```

## 技术栈

| 类别 | 选型 | 决策依据 |
|------|------|----------|
| 运行时 | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | ADR-001 |
| 数据层 | IMemoryStorage 接口（宿主注入持久化实现） | ADR-002 |
| LLM 协议 | OpenAI Chat Completions 兼容（流式 SSE + Tool Calling） | ADR-003 |
| 记忆模型 | source 开放字符串基元驱动（万物皆记忆 v2） | ADR-004 |
| 向量检索 | IVectorStore 接口 + 内置 JsonVectorStore（纯 JS 余弦相似度） | ADR-002 |
| 关系图谱 | IMemoryRelationStore 侧车模型（不侵入 Memory 基元） | ADR-014 |
| 形态 | 纯逻辑库（零 native 依赖，CLI/UI 由宿主提供） | ADR-002 |
| 安全 | 两级权限 + 路径白名单 + 审计日志 | ADR-006 |
| 测试 | Vitest + MSW Mock LLM + InMemoryStorage | ADR-007 |

## 工程质量

| 指标 | 数值 |
|------|------|
| 源码 | 90 文件 / 24,059 行 |
| 测试 | 80 文件 / 28,013 行（测试代码量 > 生产代码量） |
| 测试通过 | 1,949+ |
| 语句覆盖 | 89.3% |
| 分支覆盖 | 81.7% |
| 函数覆盖 | 91.7% |
| 运行时依赖 | **0** |
| 架构决策记录 | 25 个 ADR |

## 开发命令

```bash
npm test             # 运行测试
npm run test:cov     # 运行测试 + 覆盖率
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 检查
npm run build        # 编译到 dist/
```

## 文档

- [接入指南](docs/memora-接入指南.md) — 宿主项目开发者完整接入手册
- [API 参考](docs/memora-api-reference.md) — 公共 API 速查
- [配置示例](config.example.json) — LLM / Embedding / 安全配置模板

## 宿主项目

[memora-sprite](hosts/memora-sprite/) — 基于 Electron 的桌面精灵宿主（v1.5.0），展示 Memora 内核的完整接入方式：SQLite 持久化、向量索引、系统托盘、全局快捷键、记忆图谱可视化。

## 贡献

本项目遵循"大树模型"工程哲学。技术决策记录（ADR）位于 `.trae/decisions/`。

## 许可证

[MIT](LICENSE)
