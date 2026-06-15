---
alwaysApply: false
description: 选用 Node.js 22 LTS + TypeScript 5 + ESM 作为运行时栈
---

# ADR-001 · 选用 Node.js 22 LTS + TypeScript 5 + ESM 作为运行时栈

> **状态**：✅ 已接受 **日期**：2026-06-02 **播种批次**：Memora 模式 A v1
> **来源**：[项目决策表.md §一](../../docs/项目决策表.md)

## 背景

Memora 是纯逻辑库，需要：LLM API 流式调用、跨平台支持。

## 决策

| 项       | 选择                            |
| -------- | ------------------------------- |
| 运行时   | Node.js ≥ 22 LTS                |
| 类型系统 | TypeScript ≥ 5.x（strict 模式） |
| 模块系统 | ESM（`"type": "module"`）       |
| 包管理器 | npm                             |

## 理由

- **Node.js 22 LTS**：原生 fetch / SSE 流式响应 / Test Runner；npm 生态最成熟；better-sqlite3 原生 prebuild 支持
- **TypeScript 5 strict**：记忆体系分层需要强类型保护；IDE 智能提示
- **ESM**：顶层 await 可用；与 TS 5 配置一致；Node 22 原生支持
- **npm**：跨平台一致；零额外安装；与 Node 同源

## 替代方案

| 方案   | 放弃原因                 |
| ------ | ------------------------ |
| Deno   | 生态不成熟；npm 兼容弱   |
| Bun    | 生产稳定度待验证         |
| Python | 生态割裂；TS 优势丧失    |
| pnpm   | 符号链接在某些场景有问题 |

## 影响

- 所有源码使用 `.ts` + ESM
- `package.json` 必须设 `"type": "module"`
- `tsconfig.json` 使用 `module: "NodeNext"` + `moduleResolution: "NodeNext"`
- CI 需要 Node.js 22+ 环境
- `package.json` 的 `engines` 字段设为 `>=22.0.0`（跟随 Node LTS，不卡上限）

## 补充说明：Node 版本与 native 依赖（2026-06-11 更新）

> **2026-06-11**：better-sqlite3 已完全从 memora 内核移出。
> ABI 对齐问题由宿主项目（泊文）管理，详见 [ADR-002 v0.7](./ADR-002-storage-layer.md)。
> memora 内核零 native 依赖，`npm test` 和 `git push` 不再涉及任何编译步骤。

### 版本矩阵（历史参考）

| 组件                  | 版本           | NODE_MODULE_VERSION | 说明                        |
| --------------------- | -------------- | ------------------- | --------------------------- |
| Memora 引擎约束       | `>=22.0.0`     | —                   | 纯 JS，无 native 依赖       |
| 系统 Node.js（开发）  | 24.x LTS       | 137                 | 仅用于运行 TypeScript 编译  |
| Electron（宿主泊文）  | 41.7.x         | 145                 | 宿主管理 better-sqlite3 ABI |
| better-sqlite3        | ^12.10.0       | —                   | 由宿主 project 管理         |

### 三方 ABI 统一原则

系统 Node.js、Electron 内置 Node、better-sqlite3 native 模块三者的
`NODE_MODULE_VERSION` 必须一致，否则 `new Database()` 抛 ABI 不匹配错误。

**Electron 宿主项目的正确流程**：

```
npm install          ← 安装依赖（better-sqlite3 按系统 Node ABI 编译）
npm run rebuild      ← electron-rebuild 重编译为 Electron ABI
```

`postinstall` 脚本会自动清理 memora 子目录的 ABI 冲突副本。

### 为什么从 `<23.0.0` 放宽到 `>=22.0.0`

1. **Node 20 已 EOL**（2026-04-30），better-sqlite3@12.10.0 移除了 Node 20 prebuild
2. **Node 24 已是 LTS**（2025-10 起），是 Electron 41 的内置版本
3. 宿主 Electron 决定系统 Node 版本（须同大版本），Memora 不应卡死上限

### 降级/修复方案（已移出至宿主）

> 以下内容仅适用于宿主项目（泊文）。memora 内核无需任何 rebuild。

- 推荐：用 nvm 保持系统 Node 与 Electron 内置 Node 同大版本
- 应急：`npm run rebuild`（Electron 场景，由宿主 `package.json` 管理）

## 何时回顾

- 当 Deno / Bun 生态成熟度追平 npm 时
- 当需要 Python 生态（如 ML 模型本地推理）时
