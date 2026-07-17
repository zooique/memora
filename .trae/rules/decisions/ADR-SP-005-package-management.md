---
alwaysApply: false
description: "memora-sprite 宿主：包管理与依赖引用方式"
---

# ADR-SP-005 · 包管理

> **状态**：✅ 已接受（2026-06-16，2026-06-29 修订，2026-07-10 二次修订，2026-07-17 三次修订）
> **依赖**：[ADR-002](./ADR-002-storage-layer.md)（零 native 依赖内核）

## 背景

精灵是 memora 仓库内的独立 package，需要决定如何引用 memora 内核以及包管理方式。

## 决策

**不通过 npm 依赖内核，由 `sync-memora.mjs` 负责内核分发。**

精灵的 `package.json` 中不声明 memora 依赖：
```json
{
  "dependencies": {
    "better-sqlite3": "^12.10.0",
    "electron": "^40.0.0"
  }
}
```

`sync-memora.mjs` 负责：编译内核 → 创建最小化 `node_modules/memora/`（仅 dist + zod + package.json + LICENSE）。
源码中 import 保持 `from 'memora'`，TypeScript 通过 `node_modules/memora/dist` 解析。

`build:electron` 自动调用 `sync-memora`，开发者无需手动操作。

> **版本演进**：
> - 初始决策 better-sqlite3 为 `^11.0.0`，2026-06 阶段二升级至 `^12.10.0` 以适配 Node.js 24 LTS 与 Electron 40。`electron-rebuild` 包名已迁移为 `@electron/rebuild`（scoped package）。
> - 2026-06-29：内核正式发布至 npm（`@zooique/memora@0.1.0`），引用方式从 `file:../..` 切换为 `npm:@zooique/memora@^0.1.0` alias。
> - 2026-07-10：因暂不计划持续发布内核至 npm，引用方式从 npm alias 切回 `file:../..`。新增 `sync-memora` 脚本。
> - 2026-07-17：移除 `file:../..` 依赖声明。原因：npm on Windows 对 `file:` 依赖创建 Junction（符号链接），electron-builder 跟随 Junction 将全量仓库（src/、tasks/、hosts/、.trae/）打入 asar。改由 `sync-memora.mjs` 统一负责内核分发（编译 → 最小化复制）。

## 理由

- **消除 Junction 风险**：`file:../..` 在 Windows 上创建 Junction，electron-builder 跟随 Junction 打包全量仓库文件到 asar，包含 src/、tasks/、hosts/ 等开发文件
- **统一开发/打包机制**：不再区分 Junction 模式（开发）和复制模式（打包），`sync-memora.mjs` 始终创建独立的最小化目录
- **最简方案**：不需要引入 pnpm workspace 或 turborepo 等新工具链
- **打包体积可控**：`node_modules/memora/` 仅含 dist（~1.3MB）+ zod（~0.7MB），不含源码和开发文件
- **依赖隔离**：精灵的 `better-sqlite3` 不会污染内核的 `node_modules`（独立 package.json）

## 替代方案

| 方案 | 状态 | 说明 |
|------|------|------|
| `file:../..`（Junction） | 废弃（2026-07-17） | electron-builder 跟随 Junction 打包全量仓库到 asar |
| npm alias（`npm:@zooique/memora@^1.0.1`） | 历史方案（2026-06-29 至 2026-07-09） | 需每次内核改动后 `npm publish` + `npm update`，发布开销大 |
| pnpm workspace | 放弃 | 引入新工具链，2 个包不值得 |
| 相对路径 import（../../src） | 放弃 | 绕过 package.json，TypeScript 路径混乱 |
| monorepo（turborepo/nx） | 放弃 | 2 个包过度工程 |

## 影响

- 精灵开发前需在 `hosts/memora-sprite/` 下执行 `npm install`
- `build:electron` / `start:electron` 自动调用 `sync-memora`，无需手动操作
- **打包流程**：`npm run package:win` 自动执行 build:electron（含 sync-memora） → electron-builder → verify
- `.gitignore` 需添加 `hosts/memora-sprite/node_modules/`
- > 详见 [sprite-project-rules.md §2](../sprite-project-rules.md)

## 何时回顾

- 当需要重新发布内核至 npm（供其他宿主或 CI 使用）时，恢复 npm alias 模式
- 当仓库拆分为独立 Git 仓库时，需改用 npm 引用或 git submodule
