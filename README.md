# Memora

> **带治理能力的 Agent 记忆内核** — 本地、私有、零依赖。不是框架，是内核。

[![npm](https://img.shields.io/npm/v/@zooique/memora)](https://www.npmjs.com/package/@zooique/memora)
[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![Coverage](https://img.shields.io/badge/coverage-87%25-brightgreen)](https://vitest.dev)
[![Tests](https://img.shields.io/badge/tests-2446%20passed-brightgreen)](https://vitest.dev)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-yellowgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

**English** → [README.en.md](./README.en.md)

---

## 你遇到了什么问题？

- **LLM 每次对话都从零开始** — 用户记得上次聊过什么，Agent 不记得
- **现有记忆方案要么太重（框架绑定）要么太浅（只有 CRUD）** — 缺少去重、衰减、冲突检测等治理能力
- **记忆和角色混在一起** — 换个角色人格，历史记忆也跟着丢了
- **数据不想上云** — 需要一个本地、私有、不依赖外部服务的记忆层

## Memora 怎么解决

Memora 是一个 **Agent 记忆内核**——不绑定任何框架，不依赖任何云服务，专注于一件事：**让 Agent 拥有跨会话、跨话题的长期记忆，并且记忆是干净的。**

"干净"意味着：自动去重、自然衰减、冲突检测、时效评估——不是简单地把历史堆进上下文窗口。

```typescript
import { Agent, createProviderFromConfig } from '@zooique/memora';

const agent = new Agent({
  projectPath: '/your/project',
  provider: createProviderFromConfig('primary', {
    provider: 'openaiCompatible',
    apiKey: process.env.LLM_API_KEY!,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  }),
});
await agent.init();

// 对话 — 记忆自动沉淀
for await (const chunk of agent.chat('我喜欢 TypeScript')) {
  process.stdout.write(chunk.content);
}

// 下次对话 — Agent 自动召回记忆
const reply = await agent.chatSync('我喜欢什么语言？');

// 记忆治理 — 去重 / 冲突 / 时效 / 衰减
await agent.governance.deduplicate();
await agent.governance.detectConflicts();
agent.governance.decay();

await agent.close();
```

> **边界声明**：memora 是**不可独立运行的纯逻辑内核**——持久化 / 沙箱 / 可观测 / CLI·UI 均由宿主注入。内核保证**接口契约 + 单测验证的逻辑正确性**，agent 级行为评估由宿主自行承担。

---

## 为什么选择 Memora？

| | Memora | 向量记忆库 (agent-memory, MemStack) | 框架内置记忆 (Mastra, LangGraph) |
|---|---|---|---|
| **记忆治理** | ✅ 去重+衰减+冲突+时效 四层 | ⚠️ 仅衰减或无治理 | ⚠️ 部分支持 |
| **框架绑定** | ✅ 零绑定，纯内核 | ✅ 独立 | ❌ 绑定特定框架 |
| **数据隐私** | ✅ 100% 本地 | ✅ 本地 | ⚠️ 部分云端 |
| **运行时依赖** | ✅ 零（仅 node:*） | ❌ SQLite / better-sqlite3 | ❌ 重依赖 |
| **角色/记忆分离** | ✅ 角色包边界纪律 | ❌ 无角色概念 | ⚠️ 简单 prompt |
| **Embeddable** | ✅ 任何 Node.js 宿主 | ✅ 独立库 | ❌ 框架内使用 |

**一句话定位**：如果你想要一个**不绑定框架、有治理能力、零依赖**的记忆层，Memora 是目前 npm 上唯一的选择。

---

## 设计哲学

> **万物皆是记忆。**
>
> 人格是"我记得我是谁"，规则是"我记得该怎么做事"，技能是"我记得怎么做某类事"，对话历史是"我记得之前聊过什么"。

Memora 是一个**无法独立运行**的智能大脑内核——它只有接口，没有"形态"。CLI、WebUI、桌面精灵、小说生成器都是它的"宿主"，宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。

> **版本定位（v3.0.0）**：**Node.js 专属 · 零第三方运行时依赖的 Agent 内核**。3.0.0 是架构收敛后的第一个稳定基线，API 与结构以 3.0.0 为准。

---

## 核心能力

| 能力 | 说明 |
|------|------|
| **长期记忆沉淀** | 跨会话、跨话题的记忆持久化与智能召回 |
| **双通道召回** | 语义向量搜索 + 关键词搜索，hybridMerge 融合排序 |
| **记忆治理** | L0 衰减 / L1 语义去重 / L2 时效评估 / L3 冲突检测，经 `agent.governance` 门面委托暴露（LLM 判断） |
| **Agent 与角色分离** | Agent 是纯记忆引擎，角色是人格载体。换角色不丢记忆 |
| **统一记忆模型** | 一切统一为「记忆」，通过 `source` 开放字符串区分，无封闭枚举 |
| **领域可插拔** | 同一套架构，加载不同记忆配置即可适配不同领域 |
| **零第三方依赖内核** | 依赖 Node.js 内置 `node:*` 模块，持久化由宿主通过接口注入 |
| **可观测性** | ITracer 接口 + 结构化 span，宿主可接入任意 APM |
| **外部世界工具** | 条件性暴露 `web_search` / `web_fetch` / `run_code`——宿主注入对应 provider 才启用 |

## 快速开始

### 安装

```bash
npm install @zooique/memora
```

### 创建 Agent

```typescript
import { Agent, createProviderFromConfig } from '@zooique/memora';

// 宿主职责：创建 LLM Provider（兼容所有 OpenAI Chat Completions 协议的服务）
// createProviderFromConfig 是"单个 provider"入口；多 provider + active 路由见 createLlmProvider(loadConfig())
const provider = createProviderFromConfig('primary', {
  provider: 'openaiCompatible',
  apiKey: process.env.LLM_API_KEY!,
  baseUrl: 'https://api.xiaomimimo.com/v1',
  model: 'deepseek-chat',
});

// 创建 Agent
const agent = new Agent({
  projectPath: '/path/to/project',
  provider,
  configDir: '/path/to/agent-config', // role-packs / skills
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
// 搜索记忆（limit 为数字）
const hits = await agent.memory.searchHybrid('TypeScript 偏好', 5);

// 记忆治理（经 agent.governance 门面委托暴露，LLM 判断）
const report = await agent.governance.deduplicate();
console.log(`去重 ${report.deduplicatedCount} 条`);

const timeliness = await agent.governance.evaluateTimeliness();
const conflicts = await agent.governance.detectConflicts();

// 手动触发一次记忆衰减（纯 score 递减，无 LLM 调用）
agent.governance.decay();
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

### 五大注入接口

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
| 源码 | 104 个生产文件（src/，零第三方运行时依赖） |
| 测试 | 96 个测试文件 |
| 测试通过 | 2,446 通过 / 1 skip |
| 语句覆盖 | 85.8% |
| 分支覆盖 | 79.6% |
| 函数覆盖 | 88.5% |
| 行覆盖 | 87.4% |
| 运行时依赖 | **0** |
| 架构决策记录 | 24 个 ADR |

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
- [角色包开放键指南](docs/role-pack-开放键指南.md) — manifest.json 开放键使用指南（三层消费方 + 速查）
- [配置示例](config.example.json) — LLM / Embedding / 安全配置模板

## 示例角色包（随包发布）

npm 包内置 `role-packs/` 示例角色库（`小说助手` / `文档设计师` / `方案设计师`），每个包为文件夹形态（`manifest.json` 核心控制 + `persona.md` / `rules.md` / `skills/` 内容层）。复制到 `configDir/role-packs/` 即可装载，未声明角色包时 Agent 仍可正常对话（走默认策略）。开放键使用详见 [角色包开放键指南](docs/role-pack-开放键指南.md)；中立规范见仓库内 [role-pack-spec](docs/architecture/role-pack-spec.md)。

## 宿主项目

[memora-vscode](https://gitee.com/zooique/memora/tree/main/hosts/memora-vscode) — VS Code 插件宿主（第一宿主），展示 Memora 内核的完整接入方式：SQLite 持久化、双通道召回、角色包管理与记忆视图。

> 桌面精灵宿主（memora-sprite）亦作为参考宿主位于本仓库 `hosts/memora-sprite`（Electron 桌面应用，展示 SQLite 持久化 / 向量索引 / 系统托盘 / 全局快捷键）。

## 贡献

本项目遵循"大树模型"工程哲学。技术决策记录（ADR）位于仓库 [.trae/decisions/](https://gitee.com/zooique/memora/tree/main/.trae/decisions)。

## 许可证

[MIT](LICENSE)
