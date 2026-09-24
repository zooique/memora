# Memora

> **带治理能力的 Agent 记忆内核** — 本地、私有、零依赖。不是框架，是内核。

[![npm](https://img.shields.io/npm/v/@zooique/memora)](https://www.npmjs.com/package/@zooique/memora)
[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![Coverage](https://img.shields.io/badge/coverage-covered-brightgreen)](https://vitest.dev)
[![Tests](https://img.shields.io/badge/tests-2700%2B%20passed-brightgreen)](https://vitest.dev)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-yellowgreen)](package.json)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

**English** → [README.en.md](./README.en.md)

---

## 你遇到了什么问题？

- **LLM 每次对话都从零开始** — 用户记得上次聊过什么，Agent 不记得
- **现有记忆方案要么太重（框架绑定）要么太浅（只有 CRUD）** — 缺少去重、冲突检测、写时取代等治理能力
- **记忆和角色混在一起** — 换个角色人格，历史记忆也跟着丢了
- **数据不想上云** — 需要一个本地、私有、不依赖外部服务的记忆层

## Memora 怎么解决

Memora 是一个 **Agent 记忆内核**——不绑定任何框架，不依赖任何云服务，专注于一件事：**让 Agent 拥有跨会话、跨话题的长期记忆，并且记忆是干净的。**

"干净"意味着：语义去重、冲突检测、写时取代（supersede）、命中即刷新最近使用（`accessedAt`，参与排序）——**不对记忆做重要度加权**，也不是简单地把历史堆进上下文窗口。

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

// 下次对话 — LLM 可自行调用 search_memories 取回这条记忆
const reply = await agent.chatSync('我喜欢什么语言？');

// 记忆治理 — 语义去重 / 冲突检测 / 来源健康诊断
await agent.governance.deduplicate();
await agent.governance.detectConflicts();
const health = agent.governance.sourceHealth();

await agent.close();
```

> **边界声明**：memora 是**不可独立运行的纯逻辑内核**——持久化 / 沙箱 / 可观测 / CLI·UI 均由宿主注入。内核保证**接口契约 + 单测验证的逻辑正确性**，agent 级行为评估由宿主自行承担。

> **零依赖如何成立（2026-09-21 审计）**：「零依赖」特指**零第三方运行时依赖**。内核仅使用 Node 内置模块（`node:fs` / `node:path` / `node:crypto` / `node:os` / `node:child_process`），6 类共见于 18 个生产文件，全部必要、无冗余。文件落盘（记忆 / 角色包 / 原子写 / 技能脚本执行）走**接口 + 内存默认实现**（如 `ISessionStore` → `InMemorySessionStore`），持久化 sink 交由宿主注入 `WorkspaceSessionStore` 等实现替换——这既支撑「本地、私有、零依赖」卖点，也遵守「持久化由宿主注入」边界。

---

## 为什么选择 Memora？

| | Memora | 向量记忆库 (agent-memory, MemStack) | 框架内置记忆 (Mastra, LangGraph) |
|---|---|---|---|
| **记忆治理** | ✅ 去重+冲突+写时取代 | ⚠️ 仅衰减或无治理 | ⚠️ 部分支持 |
| **框架绑定** | ✅ 零绑定，纯内核 | ✅ 独立 | ❌ 绑定特定框架 |
| **数据隐私** | ✅ 100% 本地 | ✅ 本地 | ⚠️ 部分云端 |
| **运行时依赖** | ✅ 零（仅 node:*） | ❌ SQLite / better-sqlite3 | ❌ 重依赖 |
| **角色/记忆分离** | ✅ 角色包边界纪律 | ❌ 无角色概念 | ⚠️ 简单 prompt |
| **Embeddable** | ✅ 任何 Node.js 宿主 | ✅ 独立库 | ❌ 框架内使用 |

**一句话定位**：如果你想要一个**不绑定框架、有治理能力、零依赖**的 memory + agent 内核，Memora 有清晰的差异化——它不是一个记忆 server / CLI / MCP 工具，而是一个可嵌入宿主、含完整执行闭环（loop / 工具 / 上下文 / 角色包 / 记忆即摘要）的纯逻辑内核。

> **生态定位（2026-09-21 实证）**：npm 上 agent 类包已分两轴——**引擎轴**（loop/工具执行：`@ownware/loom`、`@hbbio/nanoagent`、`@imzx/imzx`、`thoth-agent` 等）与**记忆层轴**（`@agentmemory/agentmemory`、`mem0`、`flair`、`honcho`、`engram`、`agentic-memory` 等）。Memora 同时触及两轴，但**具体组合无人占据**：① 引擎轴同等竞品均有运行时依赖或绑定特定 runtime（loom=7 deps、imzx=11 deps、nanoagent 绑定 bun），而 Memora 是**纯 Node 零第三方运行时依赖**；② 记忆层包（engram / agentic-memory 等）只做记忆，**不提供执行内核**；③ 引擎轴包（loom 等）只做**会话内**上下文 / checkpoint，**没有跨会话被治理的长期记忆**（内存治理：去重 / 冲突检测 / supersede 写时取代 / 角色包隔离）。**护城河 = 治理型长期记忆 + 角色包隔离，以纯 Node 零依赖、宿主内嵌形态交付**。引擎轴上有 [loom](https://www.npmjs.com/package/@ownware/loom) 这样的强对手，不应与其在「引擎」轴上对拼；竞争力聚焦在「被治理的记忆 + 角色包」这一 layer。

> **可被复用去开发 Agent（是）**：Memora 生来就是**宿主注入型的内核库**——`Agent` 门面 + `loop` 执行闭环 + 工具注入接口（web_search / web_fetch / run_code / search_project）+ `createProviderFromConfig`（可接任意 OpenAI 兼容 LLM），任何 Node.js 宿主都能用它搭出**带记忆和角色的自有 Agent**（聊天框、桌面精灵、文档助理、运算 worker……）。这正是设计意图：它只有接口、没有形态，形态由宿主定义。唯一前提是宿主需提供持久化 / 沙箱 / UI 等外围（内核不内置 sink）。

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
| **长期记忆沉淀** | 跨会话、跨话题的记忆持久化 + 工具化召回（`search_memories`；**不自动注入**） |
| **记忆检索工具** | 纯关键词检索（`search_memories`），命中刷新 `accessedAt`（语义向量通道已随 B0 收编，2026-09-18） |
| **记忆治理** | supersede 写时取代 + 命中刷新（`accessedAt` 参与排序，**不做重要度加权**）+ 语义去重 + 冲突检测，经 `agent.governance` 门面暴露（去重 / 冲突由 LLM 判断） |
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

// 下一次对话，LLM 可自行调用 search_memories 取回"喜欢 TypeScript"这条记忆
const reply = await agent.chatSync('我喜欢什么语言？');
// → LLM 检索后基于召回结果回答
```

### 记忆管理

```typescript
// 搜索记忆（limit 为数字）
const hits = await agent.memory.searchByKeyword('TypeScript 偏好', 5);

// 记忆治理（经 agent.governance 门面委托暴露，LLM 判断）
const report = await agent.governance.deduplicate();
console.log(`去重 ${report.deduplicatedCount} 条`);

const conflicts = await agent.governance.detectConflicts();

// 来源健康诊断（纯计算，不调 LLM）：逐 source 统计数量 / 距最近访问天数（score 退役后仅存事实观测）
const health = agent.governance.sourceHealth();
console.log(health?.sources);
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
│  │  - 纯关键词记忆检索（search_memories）    │               │
│  │  - 记忆治理机制（去重/冲突/写时取代）   │               │
│  │  - 角色 / 技能匹配（渐进披露）          │               │
│  │  - 工具注册 / 工具执行 / 反思重试        │               │
│  │  - 会话归档 / 轮次持久化                │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

### 五大注入接口

内核通过接口与外部世界交互，宿主按需注入：

| 接口 | 职责 | 内置实现 | 宿主注意 |
|------|------|----------|----------|
| `IMemoryStorage` | 记忆 CRUD + 搜索 + 按 source 查询 | `InMemoryStorage`（**仅内存占位，不持久化**） | 生产须宿主实现持久化（如 SQLite）；重启后数据依赖宿主实现 |
| `ISessionStore` | 会话历史 + 标题元数据持久化 | 无（宿主实现） | **不含检查点持久化**（2026-09-10 减法：跨重启恢复链整体退役）——中止/断电一律把未完成 turn 补全为完整 turn 身份、下次会话按历史加载；运行时暂停是同 turn 内续跑（内存态），无需跨进程载体 |
| `ILogger` | 日志输出 | console fallback | 无 |
| `ITracer` | 可观测性 span | `NOOP_TRACER` | 无 |

## 项目结构

```
src/
├── index.ts          # 库导出入口（类型 + 接口 + 函数 + 类导出，无 CLI）
├── agent/            # Agent 门面 + AgentLoop + seed/（turn）
│   ├── agent.ts      # 门面类（宿主唯一入口）
│   ├── loop.ts       # 核心循环（推理 → 工具调用 → 反思重试）
│   ├── assembler.ts  # 组件组装器（纯工厂）
│   ├── contextManager.ts / contextPreparer.ts / toolExecutor.ts / toolRunner.ts ···
│   ├── seed/         # turn（prepare → act/difficulty → reflect，含多 turn 任务编排）
│   └── managers/     # 16 个专职 Manager/服务类（memoryInspector / memoryGovernance / roundSummaryGenerator / sessionManager / sessionArchiver / archiveCoordinator / workProjection / textPolishManager / chatLockManager 等）
├── memory/           # 记忆引擎（IMemoryStorage + InMemoryStorage + 纯关键词召回 / 融合排序 / 治理常量）
├── role-pack/        # 角色包（manifest 解析 + validator + strategyResolver + 能力映射）
├── skill/            # 技能管理（全局池 + 角色包绑定，渐进披露 + skillScriptRunner）
├── llm/              # LLM 适配层（provider + openaiCompatible + factory）
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
| 冲突消解 | Memory 冲突改用 supersededBy 布尔标记 | ADR-021 |
| 形态 | 纯逻辑库（零 native 依赖，CLI/UI 由宿主提供） | ADR-002 |
| 安全 | 两级权限 + 路径白名单 + 审计日志 | ADR-006 |
| 测试 | Vitest + MSW Mock LLM + InMemoryStorage | ADR-007 |

## 工程质量

| 指标 | 数值 |
|------|------|
| 源码 | 117 个生产文件（src/，零第三方运行时依赖） |
| 测试 | 内核 + 宿主双套 vitest，根配置统一跑（100+ 文件） |
| 测试通过 | 2700+ 通过 / 1 skip |
| 语句覆盖 | 90.65% |
| 分支覆盖 | 84.83% |
| 函数覆盖 | 92.41% |
| 行覆盖 | 91.79% |
| 运行时依赖 | **0** |
| 架构决策记录 | 26 个 ADR |

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
- [配置示例](config.example.json) — LLM / 安全配置模板

## 示例角色包（随包发布）

npm 包内置 `role-packs/` 示例角色库（`共鸣小说家` / `白话方案设计师`），每个包为文件夹形态（`manifest.json` 核心控制 + `persona.md` / `rules.md` / `skills/` 内容层）。复制到 `configDir/role-packs/` 即可装载，未声明角色包时 Agent 仍可正常对话（走默认策略）。开放键使用详见 [角色包开放键指南](docs/role-pack-开放键指南.md)；中立规范见仓库内 [role-pack-spec](docs/architecture/role-pack-spec.md)。

## 宿主项目

[memora-vscode](https://gitee.com/zooique/memora/tree/main/hosts/memora-vscode) — VS Code 插件宿主（第一宿主），展示 Memora 内核的完整接入方式：JSON 文件持久化（`.memora/memories.json`）、纯关键词召回、角色包管理与记忆视图。

## 反馈

遇到问题或有改进建议？请在 [Gitee Issues](https://gitee.com/zooique/memora/issues)（主仓库）或 [GitHub Issues](https://github.com/zooique/memora/issues)（镜像）提交反馈。

## 贡献

本项目遵循"大树模型"工程哲学。技术决策记录（ADR）位于仓库 [.trae/decisions/](https://gitee.com/zooique/memora/tree/main/.trae/decisions)。

## 许可证

[MIT](LICENSE)
