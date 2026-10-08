# Memora VS Code 插件 · 目录结构

> **定位**：`hosts/memora-vscode/` 的目录结构说明。按职责分组，extension host（Node）与 webview（浏览器）严格分离。
> **架构**：插件 = memora 内核通用落地宿主，定位由内置角色包承载（ADR-VC-001）。
> **写法约定**：本树只点名稳定锚点文件，目录职责见 §二；逐文件清单会随迭代过期，以磁盘与 §二 职责为准。

---

## 一、目录树

```
hosts/memora-vscode/
├── package.json               # VS Code 插件清单（ESM，file: 依赖 memora；命令/配置/视图贡献点）
├── tsconfig.json
├── .vscodeignore              # vsce 打包排除清单（源码/docs/设计源稿不入安装包）
├── resources/                 # 静态资源（打包随 vsce 直收，见 .vscodeignore 排除项）
│   ├── icon.png               # ✅ 市场图标（拟物全彩版，256px；市场不收 SVG）
│   ├── icon-activitybar.svg   # ✅ 活动栏图标（单色线条版：线宽 1 + 珠线断点 + 圆头，mask 染色）
│   └── memora-host-icon-design.jpeg # 设计源稿存档（1536px 原图，不入安装包）
├── scripts/                   # 门禁验证脚本（.mts；不入安装包）
├── docs/                      # 设计与审查文档（本文件 / host-overview / session-archive-design / ui-growth-review）
├── src/
│   ├── extension/             # extension host（Node 环境，可 node:fs）
│   │   ├── extension.ts       # ✅ 入口：activate + 命令注册（轻量命令内联，重逻辑下放）
│   │   ├── commands/          # 独立成文件的命令处理器（openChat / demo）
│   │   ├── host/              # ✅ 薄壳装配层（new Agent + 注入；LLM 配置、会话/轮次存储、
│   │   │                      #    文件改动追踪确认回退、代码执行、技能聚合、全局搜索等内核适配）
│   │   └── providers/         # LLM Provider 凭据存取（providerStore，安全存储）
│   │
│   ├── webview/               # Webview UI（浏览器环境，仅 postMessage，禁 node API）
│   │   ├── panels/            # 面板壳（chatPanel / settingsPanel：生成 HTML + 挂载脚本）
│   │   ├── scripts/           # 各视图前端逻辑（chatView / settingsView / rolesView /
│   │   │                      #    configView / memoryView / pager / icons 等）
│   │   ├── components/        # 可复用 UI 组件（dropdown）
│   │   ├── helpers/           # 渲染层纯函数（markdown / 转义 / 格式化，可测试）
│   │   └── styles/            # CSS（tokens 归一 + 按视图分组）
│   │
│   └── shared/                # extension ↔ webview 共享（单一真理源）
│       ├── protocol.ts        # ✅ postMessage 消息协议类型
│       ├── constants.ts       # 共享常量
│       ├── turnProjection.ts  # 轮次投影（内核 Round → UI 视图模型）
│       └── errorText.ts       # 错误文案归一
│
└── .vscode/                   # 本地调试（launch / settings / tasks）
```

测试（`__tests__/`）就近散布于各目录，vitest 统一收敛（`vitest.config.ts`）；编译时会被一并编进 dist，分发由 .vscodeignore 排除。

> 角色包无宿主源目录：维护于内核 `role-packs/`，构建期由 esbuild 同步至 `dist/extension/role-packs/`（见 esbuild.config.mjs）。

---

## 二、各目录职责与边界

| 目录 | 环境 | 职责 | 禁止 |
|------|------|------|------|
| `extension/` 根 | Node | 入口 + 生命周期 + 命令注册 | 业务逻辑（重逻辑下放 commands/ 或 host/） |
| `extension/commands/` | Node | 独立成文件的命令处理器 | 直接操作 DOM/Webview 渲染 |
| `extension/host/` | Node | 薄壳装配 memora 内核 + 注入持久化/适配能力 | 重复实现内核能力 |
| `extension/providers/` | Node | LLM Provider 配置与凭据存取 | 把 API Key 写进明文配置 |
| `webview/panels/` | 浏览器 | 面板壳 UI 渲染 + postMessage 收发 | 直接 import node 模块 |
| `webview/scripts/` | 浏览器 | 各视图前端逻辑（事件/状态/渲染编排） | 直接 import node 模块 |
| `webview/components/` | 浏览器 | 可复用 UI 组件 | 面板独有逻辑 |
| `webview/helpers/` | 浏览器 | 纯函数（可测试） | 可变状态 |
| `webview/styles/` | 浏览器 | CSS（tokens 归一 + 按视图分组） | — |
| `shared/` | 双端 | 消息协议 + 共享类型/投影/文案 | Node/浏览器专有逻辑 |
| `scripts/` | Node | 门禁验证脚本（发布前手工/CI 调用） | 进运行时依赖 |

## 三、核心约定

1. **内核在 extension host，Webview 只做 UI**（ADR-VC-001 决策 5）：memora 内核 + `node:fs` 在 extension host；webview 仅通过 `shared/protocol.ts` 的 postMessage 通信。
2. **薄壳装配**（ADR-VC-001 决策 2）：host/ 只 `new Agent()` + 注入，不重复实现内核能力。
3. **单 Agent 串行**：内核保持单 Agent；多面板共享同一 Agent 实例（getOrCreateAgent 懒加载单例）。
4. **消息协议单一真理源**：`shared/protocol.ts` 定义所有 postMessage 载荷，两侧共用，防漂移。
5. **定位由角色包承载（单一真理源）**：插件不自定性，不硬编码功能定位；角色包维护于内核 `role-packs/`，宿主构建期从内核同步至 `dist/extension/role-packs/`，由内核 RolePackManager 自动扫描激活。宿主不自持可写副本，避免与内核分叉漂移。

## 四、角色包架构

| 角色包 | 定位 | 状态 |
|--------|------|------|
| `memora助手` | 内核通用助手（默认对话/记忆能力展示） | ✅ 出厂自带（内核同步） |
| `白话方案设计师` | 融合方案设计（单一真理源·最小单元·网络为土壤）与文档编排，先用白话把设计讲清楚、再落实为可开发的专业文档 | ✅ 出厂自带（内核同步） |
| `共鸣小说家` | 三层结构小说创作：需求洞察 / 内核提取 / 一致性检查 + 结构 / 人物 / 对白 / 伏笔 | ✅ 出厂自带（内核同步） |

新增角色包一律加在内核 `role-packs/`，宿主构建期自动同步，无需改宿主代码。

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
