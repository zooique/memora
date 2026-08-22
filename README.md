# Memora

> 通用 Agent 记忆内核 — 本地、私有、领域无关，万物皆记忆

[![npm](https://img.shields.io/npm/v/@zooique/memora)](https://www.npmjs.com/package/@zooique/memora)
[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![Coverage](https://img.shields.io/badge/coverage-86%25-brightgreen)](https://vitest.dev)
[![Tests](https://img.shields.io/badge/tests-2369%20passed-brightgreen)](https://vitest.dev)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-yellowgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

**English** → [README.en.md](./README.en.md)

> **版本定位（v3.0.0）**：**Node.js 专属 · 零第三方运行时依赖的 Agent 内核**（依赖 `node:*` 内置模块，不引第三方运行时依赖 / native / 宿主 API）。早期版本（2.1.0 及以下）为探索性迭代；**3.0.0 是架构收敛后的第一个稳定基线**，API 与结构以 3.0.0 为准。
>
> **边界声明**：memora 是**不可独立运行的纯逻辑内核**——持久化 / 沙箱 / 可观测 / CLI·UI 均由宿主注入；**agent 级行为评估（eval）与独立验证不在内核范畴**，将由宿主基于内核可观测性（ITracer / 事件 / 指纹）自行承担。内核保证的是**接口契约 + 单测验证的逻辑正确性**，而非"agent 整体行为已被证明稳定"。

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
| **记忆治理框架（预留）** | L1-L4 治理（去重/时效/冲突/衰减）为多源记忆时代预留；当前单轨（round-summary）下治理层不参与运行时，去重由写路径 superseded 检测承担 |
| **Agent 与角色分离** | Agent 是纯记忆引擎，角色是人格载体。换角色不丢记忆 |
| **统一记忆模型** | 一切统一为「记忆」，通过 `source` 开放字符串区分，无封闭枚举 |
| **领域可插拔** | 同一套架构，加载不同记忆配置即可适配不同领域 |
| **零第三方依赖内核** | 依赖 Node.js 内置 `node:*` 模块，无任何第三方运行时依赖 / native / 宿主 API，持久化由宿主通过接口注入 |
| **可观测性** | ITracer 接口 + 结构化 span，宿主可接入任意 APM |
| **外部世界工具** | 条件性暴露 `web_search`（注入 `IWebSearchProvider`，内核自带 `FetchWebSearchProvider`）/ `web_fetch`（注入 `IFetchProvider`，内核自带 `FetchWebFetchProvider`）/ `run_code`（注入 `ICodeExecutionProvider`）——宿主注入对应 provider 才启用，内核保持零运行时依赖 |

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
│  │  - 记忆治理机制（去重/时效/冲突/衰减）   │               │
│  │  - 角色 / 技能匹配（渐进披露）          │               │
│  │  - 工具注册 / 工具执行 / 反思重试        │               │
│  │  - 会话归档 / 外部任务循环              │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

### 六大注入接口

内核通过接口与外部世界交互，宿主按需注入：

| 接口 | 职责 | 内置实现 | 宿主注意 |
|------|------|----------|----------|
| `IMemoryStorage` | 记忆 CRUD + 搜索 + 衰减 | `InMemoryStorage`（**仅内存占位，不持久化**） | 生产须宿主实现持久化（如 SQLite）；重启后数据依赖宿主实现 |
| `IVectorStore` | 语义向量索引 | `JsonVectorStore` | 无 |
| `ISessionStore` | 会话历史 + 检查点持久化 | 无（宿主实现） | 实现 `saveCheckpoint/loadPersistedCheckpoint` 即获得跨进程会话恢复 |
| `ILogger` | 日志输出 | console fallback | 无 |
| `ITracer` | 可观测性 span | `NOOP_TRACER` | 无 |

## 项目结构

```
src/
├── index.ts          # 库导出入口（类型 + 接口 + 函数 + 类导出，无 CLI）
├── agent/            # Agent 门面 + AgentLoop + seed/（单轮执行闭环）
│   ├── agent.ts      # 门面类（宿主唯一入口）
│   ├── loop.ts       # 核心循环（推理 → 工具调用 → 反思重试）
│   ├── assembler.ts  # 组件组装器（纯工厂）
│   ├── contextManager.ts / contextPreparer.ts / toolExecutor.ts / toolRunner.ts / checkpointRestoreCoordinator.ts ···
│   ├── seed/         # 最小执行闭环（prepare → act/difficulty → reflect，含外部任务外循环）
│   └── managers/     # 16 个专职 Manager/服务类（memoryInspector / memoryGovernance / roundSummaryGenerator / sessionManager / sessionArchiver / archiveCoordinator / workProjection / textPolishManager / chatLockManager 等）
├── memory/           # 记忆引擎（IMemoryStorage + InMemoryStorage + 召回 / 混合排序 / 向量 / 治理常量）
├── role-pack/        # 角色包（manifest 解析 + validator + strategyResolver + 能力映射）
├── skill/            # 技能管理（全局池 + 角色包绑定，渐进披露 + skillScriptRunner）
├── llm/              # LLM 适配层（provider + openaiCompatible + factory + embedding）
├── security/         # 安全策略（路径守卫 / 写入确认）
├── config/           # 配置加载
├── code-exec/        # 通用代码执行抽象（条件暴露）
├── web-search/       # 网络搜索抽象（条件暴露）
├── web-fetch/        # 网页抓取抽象（条件暴露）
├── logging/          # 日志（ILogger 接口 + console fallback）
└── utils/            # 工具函数（scanner / segmenter / 事件系统 / 原子写）
```

## 技术栈

| 类别 | 选型 | 决策依据 |
|------|------|----------|
| 运行时 | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | ADR-001 |
| 数据层 | IMemoryStorage 接口（宿主注入持久化实现） | ADR-002 |
| LLM 协议 | OpenAI Chat Completions 兼容（流式 SSE + Tool Calling） | ADR-003 |
| 记忆模型 | source 开放字符串基元驱动（万物皆记忆 v2） | ADR-004 |
| 向量检索 | IVectorStore 接口 + 内置 JsonVectorStore（纯 JS 余弦相似度） | ADR-002 |
| 冲突消解 | Memory 冲突改用 supersededBy 布尔标记 | ADR-021 |
| 形态 | 纯逻辑库（零 native 依赖，CLI/UI 由宿主提供） | ADR-002 |
| 安全 | 两级权限 + 路径白名单 + 审计日志 | ADR-006 |
| 测试 | Vitest + MSW Mock LLM + InMemoryStorage | ADR-007 |

## 工程质量

| 指标 | 数值 |
|------|------|
| 源码 | 101 个生产文件（src/，零第三方运行时依赖） |
| 测试 | 94 个测试文件 |
| 测试通过 | 2,369 通过 / 1 skip |
| 语句覆盖 | 85.4% |
| 分支覆盖 | 79.2% |
| 函数覆盖 | 88.3% |
| 行覆盖 | 86.9% |
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

## 示例角色包（随包发布）

npm 包内置 `role-packs/` 示例角色库（`小说助手` / `文档设计师` / `方案设计师`），每个包为文件夹形态（`manifest.json` 核心控制 + `persona.md` / `rules.md` / `skills/` 内容层）。复制到 `configDir/role-packs/` 即可装载，未声明角色包时 Agent 仍可正常对话（走默认策略）。详见 [role-pack-spec](docs/architecture/role-pack-spec.md)。

## 宿主项目

[memora-vscode](hosts/memora-vscode/) — VS Code 插件宿主（第一宿主），展示 Memora 内核的完整接入方式：SQLite 持久化、双通道召回、角色包管理与记忆视图。

> 桌面精灵宿主（memora-sprite）已独立仓库独立开发。

## 贡献

本项目遵循"大树模型"工程哲学。技术决策记录（ADR）位于 `.trae/decisions/`。

## 许可证

[MIT](LICENSE)
