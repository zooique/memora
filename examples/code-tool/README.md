# Memora · Code Tool Demo

> ⚙️ **工程场景示例** · CLI 单形态 · 5 行接入核心库
>
> 这是 Memora
> Agent 的"装车指南"之一——演示如何把核心库接入到一个代码开发助手。其他参考实现见
> [novel-writer](../novel-writer/)（双形态 WebUI 参考实现）。

## 这是什么？

一个**独立**的 demo 项目，演示如何把 [Memora Agent](../../README.md)
接入到**代码开发助手**场景中。

与 [novel-writer](../novel-writer/) 的对照：

| 维度       | novel-writer        | code-tool     |
| ---------- | ------------------- | ------------- |
| 领域       | 创意写作            | 软件工程      |
| 形态       | CLI + Web（双形态） | CLI（单形态） |
| LLM 温度   | 0.7（创造性）       | 0.2（确定性） |
| 上下文窗口 | 8K（对话简短）      | 16K（代码长） |

## 5 行核心接入代码

整个 demo 的核心就是 [src/agentBridge.ts](src/agentBridge.ts) 里的 5 行：

```typescript
import { Agent } from 'memora';

const agent = new Agent({
  config: { llm: { provider: 'openaiCompatible', apiKey, baseUrl, model } },
  configDir: './agent-config',
  projectPath: './.code-data',
});
await agent.init();
```

## 快速开始

```bash
cd examples/code-tool
npm install
npm run cli
```

Mock 模式无需 API Key，开箱即用。

## 移植到你的项目？

把 [src/agentBridge.ts](src/agentBridge.ts) 的 5 行代码拷贝到你的项目，替换：

- `configDir` → 你的人格/规则/技能目录
- `projectPath` → 你的项目根目录
- `llm 配置` → 你的 LLM API 信息

就完成了。

## 这不是"前端摆拍"

- ✅ 真实调 `agent.chat()` 流式输出
- ✅ 真实读 personality + rules + skills
- ✅ 真实写入 .memora/ 数据库
- ✅ 通过 `memora init --domain code` 生成领域配置
