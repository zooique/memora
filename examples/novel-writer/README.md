# Memora · 小说创作 Demo

> **真实可跑的"宿主项目接入"示例**
> —— 任何想接入 Memora 的开发者，都可以 cat 一下这个项目，5 分钟看到完整路径。

## 这是什么？

一个**独立**的 demo 项目（不在 memora 主项目里），演示如何把
[Memora Agent](../../README.md) 接入到一个**真实可对话的应用**中。

双形态：

| 形态             | 命令          | 适用                    |
| ---------------- | ------------- | ----------------------- |
| **B1: 极简 CLI** | `npm run cli` | 开发者，5 分钟上手      |
| **B3: Web UI**   | `npm run web` | 最终用户/PM，可视化聊天 |

## 5 行核心接入代码

整个 demo 的核心就是 [src/agentBridge.ts](src/agentBridge.ts) 里的 5 行：

```typescript
import { Agent } from 'memora';

const agent = new Agent({
  config: { llm: { provider: 'openai-compatible', apiKey, baseUrl, model } },
  configDir: './agent-config', // 宿主的人格/规则/技能
  projectPath: './.novel-data', // .memora/ 所在
});
await agent.init();

for await (const chunk of agent.chat('你好')) {
  console.log(chunk);
}
```

## 快速开始

```bash
# 1. 安装依赖
cd examples/novel-writer
npm install

# 2. 启动 CLI（Mock 模式，无需 API Key）
npm run cli

# 3. 启动 Web（打开 http://localhost:3000）
npm run web
```

## LLM 配置（自适应）

demo **自适应运行**：

- **有 API Key** → 走真实 LLM（mimo 免登录 API）
- **无 API Key** → 走 Mock 输出（让 demo 也能跑通）

配置方式（3 选 1）：

```bash
# A) 环境变量（推荐）
export MIMI_API_KEY="mimo-xxxxx"
npm run cli
```

```bash
# B) 配置文件
cp config.local.example.json config.local.json
# 编辑 config.local.json 填入 API Key
npm run cli
```

```bash
# C) Web UI 界面
npm run web
# 打开浏览器 → 点"⚙ 配置 LLM" → 填 API Key → 保存
```

## 目录结构

```
novel-writer/
├── package.json              # 独立依赖
├── tsconfig.json
├── agent-config/             # 宿主项目的人格/规则/技能（5 文件）
│   ├── personality.md        # 墨羽人格
│   ├── rules/                # 2 条核心规则
│   │   ├── character-first.md
│   │   └── show-not-tell.md
│   └── skills/
│       └── character-arc.md
├── public/
│   └── index.html            # Web UI 单页（无需打包）
└── src/
    ├── agentBridge.ts        # ⭐ 5 行核心接入
    ├── config.ts             # 配置加载
    ├── cli.ts                # B1: 极简 CLI
    └── web.ts                # B3: Express + SSE
```

## 与 memora 主项目的关系

```
memora 主项目                examples/novel-writer
───────────                  ─────────────────────
src/                        src/
  ├─ agent/agent.ts ←───────agentBridge.ts 导入
  ├─ llm/factory.ts ←───────
  └─ ...                    ├──cli.ts（用户视角）
                            └──web.ts（用户视角）
```

**完全独立**——不修改 memora 主项目一行代码。通过 npm 本地链接（`"memora": "file:../"`）接入。

## 这不是"前端摆拍"

- ✅ 真实调 `agent.chat()` 流式输出
- ✅ 真实读 personality + rules + skills
- ✅ 真实写入 .memora/ 数据库
- ✅ 真实触发记忆挂载（可点 "📚 挂载的话题记忆" 查看）

## 移植到你的项目？

把 [src/agentBridge.ts](src/agentBridge.ts) 的 5 行代码拷贝到你的项目，替换：

- `configDir` → 你的人格/规则/技能目录
- `projectPath` → 你的项目根目录
- `llm 配置` → 你的 LLM API 信息

就完成了。
