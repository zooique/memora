---
alwaysApply: false
description: "memora-sprite 宿主：运行时栈选型"
---

# ADR-SP-001 · 运行时栈

> **状态**：✅ 已接受（2026-06-16）
> **依赖**：[ADR-001](./ADR-001-runtime-stack.md)（内核运行时栈）

## 背景

memora-sprite 是 memora 内核的第一个真实宿主——桌面精灵。需要选择与内核兼容且适合桌面场景的运行时栈。

## 决策

**Node.js 22 LTS + TypeScript 5 strict + ESM**

与 memora 内核完全一致（ADR-001），确保类型共享和模块导入零摩擦。

## 理由

- **类型共享**：精灵直接 `import type { IMemoryStorage } from 'memora'`，无需维护类型桥接
- **ESM 一致**：memora 是 ESM-only，精灵也用 ESM 避免 CJS 互操作问题
- **native 模块**：better-sqlite3 是 Node native addon，Electron 主进程也是 Node.js 运行时
- **工具链复用**：tsc + tsc-alias + vitest 与内核一致，1 人团队不维护两套构建

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| Deno | better-sqlite3 不兼容 Deno FFI |
| CJS | memora 是 ESM-only，import 会报错 |
| Bun | better-sqlite3 需要验证兼容性，1 人团队不值得冒险 |

## 影响

- 精灵的 `tsconfig.json` 与内核保持相同的 `strict` + `module: NodeNext` 配置
- 精灵的 `package.json` 必须 `"type": "module"`
