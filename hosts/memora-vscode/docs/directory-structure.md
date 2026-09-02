# Memora VS Code 插件 · 目录结构

> **定位**：`hosts/memora-vscode/` 的目录结构说明。当前已落地的用 ✅ 标注，预留的未来扩展点说明其用途。
> **架构**：插件 = memora 内核通用落地宿主，定位由内置角色包承载（ADR-VC-001）。
> 按职责分组，extension host（Node）与 webview（浏览器）严格分离。

---

## 一、目标目录树

```
hosts/memora-vscode/
├── package.json               # VS Code 插件清单（ESM，file: 依赖 memora）
├── tsconfig.json
├── .gitignore                 # dist/node_modules/.memora
├── media/                     # 静态资源（图标、logo、模板）
│   └── icon.svg
├── docs/
│   ├── directory-structure.md # 本文件
│   └── plugin-alignment.md    # 插件与内核设计对齐方案（差距清单 + 分层实施 + 排雷结论）
├── src/
│   ├── extension/             # extension host（Node 环境，可 node:fs）
│   │   ├── extension.ts       # ✅ 入口：activate + 命令注册（薄）
│   │   ├── commands/          # 命令处理器（每命令一文件，逻辑不进 extension.ts）
│   │   │   └── openChat.ts        # ✅ 打开通用对话面板（唯一命令，角色包承载定位）
│   │   ├── host/              # ✅ 薄壳装配层（注入 memora 内核，不重复实现）
│   │   │   ├── assemble.ts         # new Agent + 注入（含 UI 中文化 / preExecutionCheck / tracer）
│   │   │   ├── llmConfig.ts        # LLM Provider 配置
│   │   │   ├── tracer.ts           # ✅ VscodeTracer：ITracer 采集（指纹/指标，有界内存）
│   │   │   ├── workspaceStorage.ts # IMemoryStorage（.memora/memories.json）
│   │   │   └── sessionStore.ts     # ISessionStore（.memora/sessions.json）
│   │   └── role-packs/        # 内置角色包（构建期从内核同步，宿主持源目录不自持副本）
│   │
│   ├── webview/               # Webview UI（浏览器环境，仅 postMessage，禁 node API）
│   │   ├── panels/            # 面板（每面板一个文件，UI 渲染）
│   │   │   ├── chatPanel.ts       # ✅ 通用对话面板（唯一面板，角色包定位展示）
│   │   │   └── providerConfigPanel.ts # ✅ 大模型配置面板
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
| `extension/commands/` | Node | 命令处理器（通用命令，无特定功能硬编码） | 直接操作 DOM/Webview 渲染 |
| `extension/host/` | Node | 装配 memora 内核 + 持久化注入 | 重复实现内核能力 |
| `extension/role-packs/` | Node | 内置角色包（构建期从内核 `role-packs/` 同步，产出在 `dist/extension/role-packs/`） | 插件内硬编码功能定位 / 自持可写角色包源 |
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
5. **定位由角色包承载（单一真理源）**：插件不自定性，不硬编码功能定位；角色包维护于内核 `role-packs/`，宿主构建期从内核同步至 `dist/extension/role-packs/`，由内核 RolePackManager 自动扫描激活。宿主不自持可写副本，避免与内核分叉漂移。

## 四、角色包架构

| 角色包 | 定位 | 状态 |
|--------|------|------|
| `文档设计师` | 从需求到结构化文档（API / 教程 / 架构说明） | ✅ 出厂自带（内核同步） |
| `方案设计师` | 基于 memora 设计哲学（单一真理源·最小单元·网络为土壤）设计自洽项目方案 | ✅ 出厂自带（内核同步） |
| `小说助手` | 小说创作：人物设定 / 情节结构 / 对白与文风打磨 | ✅ 出厂自带（内核同步） |
| （未来扩展） | 维护于内核 `role-packs/`，宿主构建期自动同步 | 预留 |

角色包结构：
```
role-packs/<name>/
├── manifest.json   # 元数据、策略、触发词、能力声明
├── persona.md      # 角色身份设定（可选）
└── rules.md        # 角色行为规则（可选）
```

## 五、宿主定位与独立分发

- VS Code 插件更薄：复用 VS Code 窗口/编辑器/UI，不自造 Electron 壳。
- 目录按职责分组、extension/webview 分层、shared/ 共享契约。
- git 层面：物理同仓（便于开发），后续需要独立分发/开源时，在 `hosts/memora-vscode/` 单独初始化 git 仓库即可（ADR-VC-001 决策 6）。