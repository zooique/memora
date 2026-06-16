---
alwaysApply: false
description: "memora-sprite 宿主：包管理与依赖引用方式"
---

# ADR-SP-005 · 包管理

> **状态**：✅ 已接受（2026-06-16）
> **依赖**：[ADR-002](./ADR-002-storage-layer.md)（零 native 依赖内核）

## 背景

精灵是 memora 仓库内的独立 package，需要决定如何引用 memora 内核以及包管理方式。

## 决策

**npm + `file:` 协议引用本地 memora。**

精灵的 `package.json` 中：
```json
{
  "dependencies": {
    "memora": "file:../..",
    "better-sqlite3": "^11.0.0"
  }
}
```

## 理由

- **最简方案**：不需要引入 pnpm workspace 或 turborepo 等新工具链
- **与根项目一致**：memora 根项目用 npm，精灵也用 npm
- **`file:` 协议**：npm install 时自动创建符号链接，修改内核代码后精灵立即可用，无需 publish
- **依赖隔离**：精灵的 `better-sqlite3` 不会污染内核的 `node_modules`（独立 package.json）

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| pnpm workspace | 引入新工具链，2 个包不值得 |
| npm publish + 版本引用 | 开发期频繁修改内核，每次 publish 不现实 |
| 相对路径 import（../../src） | 绕过 package.json，TypeScript 路径混乱 |
| monorepo（turborepo/nx） | 2 个包过度工程 |

## 影响

- 精灵开发前需在 `hosts/memora-sprite/` 下执行 `npm install`
- 内核代码修改后需 `npm run build` 重新生成 dist，精灵才能引用到最新类型
- `.gitignore` 需添加 `hosts/memora-sprite/node_modules/`
