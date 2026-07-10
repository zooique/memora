---
alwaysApply: false
description: "memora-sprite 宿主：包管理与依赖引用方式"
---

# ADR-SP-005 · 包管理

> **状态**：✅ 已接受（2026-06-16，2026-06-29 修订，2026-07-10 二次修订）
> **依赖**：[ADR-002](./ADR-002-storage-layer.md)（零 native 依赖内核）

## 背景

精灵是 memora 仓库内的独立 package，需要决定如何引用 memora 内核以及包管理方式。

## 决策

**npm + `file:../..` 协议本地链接内核。**

精灵的 `package.json` 中：
```json
{
  "dependencies": {
    "memora": "file:../..",
    "better-sqlite3": "^12.10.0",
    "electron": "^40.0.0"
  },
  "devDependencies": {
    "@electron/rebuild": "^3.6.0"
  }
}
```

源码中 import 保持 `from 'memora'`，`file:../..` 指向仓库根目录（memora 内核 package.json 所在）。npm install 时在 `node_modules/memora` 创建 Junction（Windows）或 symlink（Unix），指向仓库根。

> **版本演进**：
> - 初始决策 better-sqlite3 为 `^11.0.0`，2026-06 阶段二升级至 `^12.10.0` 以适配 Node.js 24 LTS 与 Electron 40。`electron-rebuild` 包名已迁移为 `@electron/rebuild`（scoped package）。
> - 2026-06-29：内核正式发布至 npm（`@zooique/memora@0.1.0`），引用方式从 `file:../..` 切换为 `npm:@zooique/memora@^0.1.0` alias。源码中 import 保持 `from 'memora'`，由 npm alias 在包管理层完成映射。
> - 2026-07-10：因暂不计划持续发布内核至 npm，引用方式从 `npm:@zooique/memora@^1.0.1` alias 切回 `file:../..`。新增 `sync-memora` 脚本（编译内核 + 同步 dist），打包流程自动调用。详见 [sprite-project-rules.md §2](../sprite-project-rules.md)。

## 理由

- **最简方案**：不需要引入 pnpm workspace 或 turborepo 等新工具链
- **与根项目一致**：memora 根项目用 npm，精灵也用 npm
- **本地链接零发布开销**：`file:../..` 直接引用仓库根，无需 `npm publish` 即可让精灵使用最新内核
- **Junction 模式零复制**：npm on Windows 默认创建 Junction（目录符号链接），编译内核后 dist 自动生效，无需额外复制
- **依赖隔离**：精灵的 `better-sqlite3` 不会污染内核的 `node_modules`（独立 package.json）
- **打包兼容**：electron-builder 打入 asar 时解引用 Junction，复制实际文件，`verify-package.mjs` 检查路径不变

## 替代方案

| 方案 | 状态 | 说明 |
|------|------|------|
| pnpm workspace | 放弃 | 引入新工具链，2 个包不值得 |
| npm alias（`npm:@zooique/memora@^1.0.1`） | 历史方案（2026-06-29 至 2026-07-09） | 需每次内核改动后 `npm publish` + `npm update`，发布开销大；暂不计划持续发布 npm，切回 file: 协议 |
| 相对路径 import（../../src） | 放弃 | 绕过 package.json，TypeScript 路径混乱 |
| monorepo（turborepo/nx） | 放弃 | 2 个包过度工程 |
| 直接 `@zooique/memora` import | 放弃 | 源码中所有 import 需写全名，冗长 |

## 影响

- 精灵开发前需在 `hosts/memora-sprite/` 下执行 `npm install`
- **修改内核源码后**：执行 `npm run sync-memora`（编译内核 + 同步 dist，几秒）
- **不修改内核时**：零开销，`node_modules/memora` 通过 Junction 直接指向仓库根
- **打包流程**：`npm run package:win` 自动执行 sync-memora → build:electron → electron-builder → verify
- `.gitignore` 需添加 `hosts/memora-sprite/node_modules/`
- > 详见 [sprite-project-rules.md §2](../sprite-project-rules.md)

## 何时回顾

- 当需要重新发布内核至 npm（供其他宿主或 CI 使用）时，恢复 npm alias 模式
- 当仓库拆分为独立 Git 仓库时，file: 协议失效，需改用 npm 引用
