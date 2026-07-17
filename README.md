# Memora

> 通用 Agent 内核 — 本地、私有、领域无关，万物皆记忆

[![npm](https://img.shields.io/npm/v/@zooique/memora)](https://www.npmjs.com/package/@zooique/memora)
[![Node.js](https://img.shields.io/badge/Node.js-22%20LTS-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

## 设计哲学

> **万物皆是记忆。**
>
> 除了用户当前直接输入的提示词内容，Agent 的一切都是记忆——人格是"我记得我是谁"，规则是"我记得该怎么做事"，技能是"我记得怎么做某类事"，对话历史是"我记得之前聊过什么"。

Memora 是一个**无法独立运行**的智能大脑内核——它只有接口，没有"形态"。CLI、WebUI、桌面精灵、小说生成器都是它的"宿主"，宿主负责给它身体（UI）、血管（Provider）、神经网络（事件回路）。

## 核心能力

- **长期记忆沉淀**——跨会话、跨话题的记忆持久化与智能召回
- **Agent 与角色分离**——Agent 是纯记忆引擎，角色是人格载体。换角色不丢记忆
- **记忆统一模型**——角色、规则、技能、对话历史全部统一为「记忆」，通过 `source` 开放字符串区分
- **领域可插拔**——同一套架构，加载不同记忆配置即可适配不同领域
- **零依赖内核**——核心层仅依赖 `zod`，持久化由宿主通过接口注入

## 快速开始

### 安装

```bash
npm install @zooique/memora
```

### 创建 Agent

```typescript
import { Agent, createLlmProvider } from '@zooique/memora';

// 宿主职责：创建 LLM Provider
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
  // dataDir 默认为 '~/.memora'，此处显式指定项目级目录
  dataDir: '.memora',
});

await agent.init();
```

### 对话

```typescript
// 流式对话
for await (const chunk of agent.chat('你好')) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.content);
  }
}

// 同步对话（测试用）
const reply = await agent.chatSync('你好');
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
│  │  - 记忆搜索 / 归档 / 挂载                │               │
│  │  - 角色匹配 / 技能匹配                   │               │
│  │  - 工具注册 / 工具执行                   │               │
│  └──────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────┘
```

## 项目结构

```
src/
├── index.ts        # 库导出入口（纯类型 + 接口导出，无 CLI）
├── agent/          # Agent 门面 + AgentLoop + 工具执行 + managers/（13 个专职 Manager）
├── memory/         # 记忆引擎（IMemoryStorage + IMemoryRelationStore + 召回 + 向量存储）
├── persona/        # 角色管理
├── skill/          # 技能管理
├── llm/            # LLM 适配层
├── security/       # 安全策略
├── config/         # 配置加载
├── logging/        # 日志（ILogger 接口 + console fallback）
├── eval/           # 评估框架（EvalScenario + EvalRunner，CI 回归测试用）
└── utils/          # 工具函数（含 eventEmitter.ts 事件系统）
```

## 技术栈

| 类别 | 选型 | 决策 |
|------|------|------|
| 运行时 | Node.js ≥ 22 LTS + TypeScript 5 strict + ESM | ADR-001 |
| 数据层 | IMemoryStorage 接口（宿主注入持久化实现） | ADR-002 |
| LLM | OpenAI Chat Completions 兼容协议 | ADR-003 |
| 形态 | 纯逻辑库（CLI 由宿主提供） | ADR-002 |
| 安全 | 两级权限 + 路径白名单 | ADR-006 |
| 测试 | Vitest + MSW Mock LLM + InMemoryStorage | ADR-007 |

## 开发命令

```bash
npm test             # 运行测试
npm run test:cov     # 运行测试 + 覆盖率
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 检查
```

## 文档

详细接入指南与 API 参考文档随源码提供。本包核心使用方式见上文「快速开始」。

技术决策记录（ADR）目前为内部文档，不随 npm 包分发。

## 贡献

本项目遵循"大树模型"工程哲学。

## 许可证

MIT
