---
alwaysApply: false
description: VS Code 插件作为 memora 内核宿主（第二个宿主、比 sprite 更薄）——架构定位 + 骨架结构 + 宿主边界
---

# ADR-VC-001 · VS Code 插件作为 memora 内核宿主

> **状态**：✅ 已接受
> **日期**：2026-08-13
> **依赖**：[ADR-002](./ADR-002-storage-layer.md)（三层架构）、[ADR-004](./ADR-004-memory-unification.md)、[agent-design-philosophy.md](../architecture/agent-design-philosophy.md)
> **关联**：memora-sprite 宿主（ADR-SP 系列）为第一宿主，本 ADR 定义第二宿主

## 背景

memora 是 **Node.js 纯逻辑库**（零依赖，靠宿主注入存储/LLM/UI）。首个 MVP（AI 辅助打磨项目设计文档）需要宿主。经形态评估（AI IDE 赛马时代，VS Code 是所有主流 AI IDE 的底座，且 Trae/CodeBuddy 等国产 AI IDE 兼容 VS Code 插件），选定 **VS Code 插件**作为宿主。

## 决策

### 决策 1：架构定位——VS Code 插件 = memora 内核宿主（第二个、更薄）

- 与 memora-sprite 同级（都是宿主），但**更薄**：sprite 自造 Electron 壳，插件寄生在 VS Code，复用其窗口/编辑器/UI；
- 一个 VS Code 插件同时覆盖 **VS Code + Trae + CodeBuddy**（均兼容 VS Code 插件），用户群最大。

### 决策 2：宿主边界（内核 vs 宿主）

| 内核（memora，插件直接 import） | 宿主（插件自己写） |
|---|---|
| Agent 闭环 / 记忆 / 召回 / 角色包 / 文档自洽检查 | extension host 生命周期、命令注册 |
| 工具执行 | **注入 IMemoryStorage**（workspace `.memora/` 文件存储） |
| 事件流（chunk/tool/recall） | **注入 ISessionStore**（workspace 会话持久化） |
| 状态机 / 错误处理 | **注入 LlmProvider**（插件配置） |
| — | 侧边栏 Webview UI + 事件流渲染 |

**宿主纪律**：插件是**薄壳 + 装配**，不重复实现内核能力。

### 决策 3：复用入口（index.ts）

`Agent` / `AgentOptions` / `createLlmProvider` / `OpenAICompatibleProvider` / `IMemoryStorage` / `ISessionStore` / `JsonVectorStore` / `recall` / `RolePackManager` / `validateRolePack` / `TRACE_SUMMARY_TOOL`。

### 决策 4：骨架结构

```
hosts/vscode-plugin/
├── src/extension/          # extension host (Node)
│   ├── extension.ts        # activate/deactivate + 命令注册
│   └── host/
│       ├── assemble.ts     # new Agent() + 注入存储/LLM（薄装配）
│       ├── workspaceStorage.ts  # IMemoryStorage（workspace .memora/）
│       ├── sessionStore.ts      # ISessionStore（workspace）
│       └── llmConfig.ts         # createLlmProvider
├── src/webview/            # 侧边栏 UI（浏览器）
│   ├── panel.ts            # Webview + postMessage 通信
│   └── view/               # 对话 / 自洽检查 / 骨架 UI
└── doc-review/             # Agent Skill（SKILL.md）能力层，形态无关
```

### 决策 5：架构关键点——内核在 extension host，Webview 只做 UI

- memora 内核 + `node:fs` 跑在 **extension host（Node）**；
- Webview 是**浏览器环境**（不能用 `node:fs`），只做 UI，通过 `postMessage` 与 extension host 通信；
- 这符合 memora"零依赖内核 + 宿主注入存储"模式，与 sprite 的 IPC 思路同构但更轻。

### 决策 6：工程组织（2026-08-13 定案）——物理同仓库 + file: 本地路径依赖 + git 可拆

- **物理布局**：放 memora 仓库 `hosts/vscode-plugin/`（与 memora-sprite 并列）——**方便开发期内核+宿主一起改**；
- **依赖方式**：开发期用 **`file:` 本地路径**指向 memora（`"@zooique/memora": "file:../../"` 指向仓库根），**不用 `npm link`**（符号链接会致重复依赖实例，破坏宿主注入接口的 `instanceof`/事件系统）；
- **git 拆分**：物理同仓库但插件目录保持**可独立拆分**——包名、构建、.gitignore 边界清晰，后续需要独立分发/开源时，在 `hosts/vscode-plugin/` 单独初始化 git 仓库即可，避免拆仓手术；
- **发布期**：依赖切换为 `"@zooique/memora": "^x.y.z"`，插件独立发布到 VS Code Marketplace。

## 考虑的替代方案

| 方案 | 放弃原因 |
|---|---|
| 再造 sprite 独立 Electron 应用 | solo 开发 80% 精力在 UI 壳，核心价值占比低；第一个 MVP 应薄 |
| CLI | 无法承载文档打磨的 UI（对话 + 自洽检查可视化），仅适合最小验证 |
| 纯 Agent Skill（无 UI） | 缺 IDE 内交互，用户感知弱；Skill 作为**能力层**附加，非主体 |
| 绑定 Trae 专有插件 | 字节封闭生态、用户群窄；VS Code 插件已能覆盖 Trae（兼容） |

## 后果

### 正面

- 覆盖最大用户群（VS Code + 国产 AI IDE），单点投入多点触达；
- 复用 memora 内核零改动，验证"内核库 + 宿主"架构价值（sprite + VS Code 双宿主）；
- 薄壳装配，落地最快。

### 负面

- 绑定 VS Code 生态/市场规则（远期 Cursor 类彻底 AI 原生 IDE 兼容性可能下降）；
- Webview 复杂 UI 受限（浏览器环境），复杂面板需 IPC。

### 后续行动

- [ ] 在 `hosts/vscode-plugin/` 建骨架，实现 `workspaceStorage`（IMemoryStorage）
- [ ] 装配 `new Agent()` 跑通切片 A（对话打磨）+ 切片 D（记忆）
- [ ] 将"文档自洽检查"沉淀为 `doc-review/SKILL.md`（Agent Skill 能力层）

## 何时回顾

- 当需要复杂 UI 面板时，评估 Webview 是否够用或需独立窗口；
- 当目标用户迁移到 Cursor 类彻底 AI 原生 IDE 时，强化 Agent Skill 能力层对冲。

## 引用

- 架构文档：[mvp-scope.md](../architecture/mvp-scope.md)、[agent-design-philosophy.md](../architecture/agent-design-philosophy.md)
- 关联宿主：memora-sprite（ADR-SP 系列）
- 内核导出：[index.ts](../../src/index.ts)
