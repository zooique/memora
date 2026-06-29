---
alwaysApply: false
description: "memora-sprite 宿主：包管理与依赖引用方式"
---

# ADR-SP-005 · 包管理

> **状态**：✅ 已接受（2026-06-16，2026-06-29 修订）
> **依赖**：[ADR-002](./ADR-002-storage-layer.md)（零 native 依赖内核）

## 背景

精灵是 memora 仓库内的独立 package，需要决定如何引用 memora 内核以及包管理方式。

## 决策

**npm + npm alias 引用已发布的 @zooique/memora。**

精灵的 `package.json` 中：
```json
{
  "dependencies": {
    "memora": "npm:@zooique/memora@^0.1.0",
    "better-sqlite3": "^12.10.0",
    "electron": "^40.0.0"
  },
  "devDependencies": {
    "@electron/rebuild": "^3.6.0"
  }
}
```

> **版本演进**：
> - 初始决策 better-sqlite3 为 `^11.0.0`，2026-06 阶段二升级至 `^12.10.0` 以适配 Node.js 24 LTS 与 Electron 40。`electron-rebuild` 包名已迁移为 `@electron/rebuild`（scoped package）。
> - 2026-06-29：内核正式发布至 npm（`@zooique/memora@0.1.0`），引用方式从 `file:../..` 切换为 `npm:@zooique/memora@^0.1.0` alias。源码中 import 保持 `from 'memora'`，由 npm alias 在包管理层完成映射。

## 理由

- **最简方案**：不需要引入 pnpm workspace 或 turborepo 等新工具链
- **与根项目一致**：memora 根项目用 npm，精灵也用 npm
- **npm alias**：`"memora": "npm:@zooique/memora@^0.1.0"` 使源码 import 保持简洁的 `from 'memora'`，同时在包管理层引用已发布的 scoped package
- **依赖隔离**：精灵的 `better-sqlite3` 不会污染内核的 `node_modules`（独立 package.json）

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| pnpm workspace | 引入新工具链，2 个包不值得 |
| `file:` 协议（`file:../..`） | 开发期方便但不符合发布后的正式引用方式；内核已发布至 npm，应使用正式版本引用 |
| 相对路径 import（../../src） | 绕过 package.json，TypeScript 路径混乱 |
| monorepo（turborepo/nx） | 2 个包过度工程 |
| 直接 `@zooique/memora` import | 源码中所有 import 需写全名，冗长；npm alias 在包管理处转化更简洁 |

## 影响

- 精灵开发前需在 `hosts/memora-sprite/` 下执行 `npm install`
- 内核代码修改后发布-更新流程：
  1. 内核目录：`npm test` → `npm run typecheck` → `npm run build` → `npm version patch|minor|major` → `npm publish --access public`
  2. 精灵目录：`npm update memora` → `npm run typecheck` → `npm run build`
  > 详见 [sprite-project-rules.md §2](../sprite-project-rules.md)
- `.gitignore` 需添加 `hosts/memora-sprite/node_modules/`
