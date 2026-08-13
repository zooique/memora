# Memora Doc Review · 目录结构规划（面向未来扩展）

> **定位**：`hosts/vscode-plugin/` 的未来目录结构规划。当前已落地的用 ✅ 标注，预留的未来扩展点说明其用途。
> **架构**：ADR-VC-001（VS Code 插件 = memora 内核宿主，薄壳装配）。按职责分组，extension host（Node）与 webview（浏览器）严格分离。

---

## 一、目标目录树

```
hosts/vscode-plugin/
├── package.json               # VS Code 插件清单（ESM，file: 依赖 memora）
├── tsconfig.json
├── .gitignore                 # dist/node_modules/.memora
├── media/                     # 静态资源（图标、logo、模板）
│   └── icon.svg
├── docs/
│   └── directory-structure.md # 本文件（目录结构规划）
├── src/
│   ├── extension/             # extension host（Node 环境，可 node:fs）
│   │   ├── extension.ts       # ✅ 入口：activate + 命令注册（薄）
│   │   ├── commands/          # 命令处理器（每命令一文件，逻辑不进 extension.ts）
│   │   │   ├── openDocReview.ts    # ✅ 打开打磨面板（切片 A）
│   │   │   ├── reviewDocument.ts   # 审阅当前文档（切片 B，阶段 2）
│   │   │   └── scaffoldProject.ts  # 文档→代码骨架（切片 C，阶段 3）
│   │   ├── host/              # ✅ 薄壳装配层（注入 memora 内核，不重复实现）
│   │   │   ├── assemble.ts         # new Agent + 注入
│   │   │   ├── llmConfig.ts        # LLM Provider 配置
│   │   │   ├── workspaceStorage.ts # IMemoryStorage（.memora/memories.json）
│   │   │   └── sessionStore.ts     # ISessionStore（.memora/sessions.json）
│   │   ├── skills/            # Agent Skill 能力层（形态无关，任何 agent 可加载）
│   │   │   └── doc-review/SKILL.md # 文档自洽审阅能力（切片 B 载体）
│   │   └── eventBridge.ts     # Agent 事件流 → 面板（可观察契约，philosophy §13.x）
│   │
│   ├── webview/               # Webview UI（浏览器环境，仅 postMessage，禁 node API）
│   │   ├── panels/            # 面板（每面板一个文件，UI 渲染）
│   │   │   ├── chatPanel.ts       # ✅ 对话打磨（切片 A）
│   │   │   ├── reviewPanel.ts     # 自洽检查结果（切片 B，阶段 2）
│   │   │   ├── scaffoldPanel.ts   # 骨架生成（切片 C，阶段 3）
│   │   │   └── memoryPanel.ts     # 记忆/跨会话（切片 D，阶段 1）
│   │   ├── components/        # 可复用 UI 组件（气泡/输入/卡片）
│   │   │   └── README.md
│   │   ├── helpers/           # 渲染层纯函数（markdown/格式化）
│   │   │   └── README.md
│   │   └── styles/            # CSS（按面板/组件分组）
│   │       └── README.md
│   │
│   └── shared/                # extension ↔ webview 共享（消息协议 + 类型，单一真理源）
│       ├── protocol.ts        # ✅ postMessage 消息协议类型
│       └── types.ts           # 未来：共享领域类型
│
└── .vscode/                   # 本地调试（主仓 .gitignore 忽略；独立仓库时提交）
    └── launch.json
```

---

## 二、各目录职责与边界

| 目录 | 环境 | 职责 | 禁止 |
|------|------|------|------|
| `extension/` 根 | Node | 入口 + 生命周期 | 业务逻辑（委托 commands/） |
| `extension/commands/` | Node | 命令处理器 | 直接操作 DOM/Webview 渲染 |
| `extension/host/` | Node | 装配 memora 内核 + 持久化注入 | 重复实现内核能力 |
| `extension/skills/` | Node | Agent Skill 能力层（SKILL.md） | 与内核耦合的 UI 逻辑 |
| `extension/eventBridge.ts` | Node | Agent 事件 → 面板推送 | UI 渲染 |
| `webview/panels/` | 浏览器 | 面板 UI 渲染 + postMessage 收发 | 直接 import node 模块 |
| `webview/components/` | 浏览器 | 可复用 UI 组件 | 面板独有逻辑 |
| `webview/helpers/` | 浏览器 | 纯函数（可测试） | 可变状态 |
| `webview/styles/` | 浏览器 | CSS | — |
| `shared/` | 双端 | 消息协议 + 共享类型 | Node/浏览器专有逻辑 |

## 三、核心约定

1. **内核在 extension host，Webview 只做 UI**（ADR-VC-001 决策 5）：memora 内核 + `node:fs` 在 extension host；webview 仅通过 `shared/protocol.ts` 的 postMessage 通信。
2. **薄壳装配**（ADR-VC-001 决策 2）：host/ 只 `new Agent()` + 注入，不重复实现内核能力。
3. **单 Agent 串行**：内核保持单 Agent；多面板共享同一 Agent 实例（getOrCreateAgent 懒加载单例）。
4. **消息协议单一真理源**：`shared/protocol.ts` 定义所有 postMessage 载荷，两侧共用，防漂移。

## 四、未来扩展点（切片 → 目录映射）

| 切片/能力 | 阶段 | 落点 |
|---|---|---|
| A 对话打磨 | 阶段 0（✅） | `commands/openDocReview.ts` + `webview/panels/chatPanel.ts` |
| D 跨会话记忆 | 阶段 1 | `host/workspaceStorage.ts`/`sessionStore.ts`（✅ 已建）+ `webview/panels/memoryPanel.ts` |
| B 文档自洽检查 | 阶段 2 | `commands/reviewDocument.ts` + `webview/panels/reviewPanel.ts` + `skills/doc-review/SKILL.md` |
| C 文档→骨架 | 阶段 3 | `commands/scaffoldProject.ts` + `webview/panels/scaffoldPanel.ts` |
| 设置（LLM 配置 UI） | 阶段 1+ | `commands/openSettings.ts` + `webview/panels/settingsPanel.ts` |
| 可观察事件流 | 长期 | `extension/eventBridge.ts`（agent 工具/步骤事件 → 面板） |

## 五、与 memora-sprite 的关系

- 同属宿主层，但 **VS Code 插件更薄**（复用 VS Code 窗口/编辑器/UI，不自造 Electron 壳）。
- 目录思路对齐 sprite 的 `directory-structure.md`：按职责分组、extension/webview 分层、shared/ 共享契约。
- git 层面：物理同仓（便于开发），后续需要独立分发/开源时，在 `hosts/vscode-plugin/` 单独初始化 git 仓库即可（ADR-VC-001 决策 6）。
