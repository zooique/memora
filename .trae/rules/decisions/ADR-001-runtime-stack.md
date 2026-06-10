---
alwaysApply: false
description: 选用 Node.js 20 LTS + TypeScript 5 + ESM 作为运行时栈
---

# ADR-001 · 选用 Node.js 20 LTS + TypeScript 5 + ESM 作为运行时栈

> **状态**：✅ 已接受 **日期**：2026-06-02 **播种批次**：Memora 模式 A v1
> **来源**：[项目决策表.md §一](../../docs/项目决策表.md)

## 背景

Memora 是本地 CLI 工具，需要：LLM
API 流式调用、SQLite 高效同步访问、跨平台支持、单进程轻量部署。

## 决策

| 项       | 选择                            |
| -------- | ------------------------------- |
| 运行时   | Node.js ≥ 20 LTS                |
| 类型系统 | TypeScript ≥ 5.x（strict 模式） |
| 模块系统 | ESM（`"type": "module"`）       |
| 包管理器 | npm                             |

## 理由

- **Node.js 20 LTS**：原生 fetch / SSE 流式响应 / Test Runner；npm 生态最成熟
- **TypeScript 5 strict**：记忆体系分层需要强类型保护；IDE 智能提示
- **ESM**：顶层 await 可用；与 TS 5 配置一致；Node 20 原生支持
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
- CI 需要 Node.js 20 环境
- `package.json` 的 `engines` 字段锁定为 `>=20.0.0 <23.0.0`（仅支持 20/22 LTS）

## 补充说明：Node 版本与 better-sqlite3 prebuild 兼容性（2026-06-10）

`better-sqlite3@12.10.0` 的 prebuilt 二进制基于 `node-gyp` 针对特定
`NODE_MODULE_VERSION` 编译。prebuild 发布时覆盖的范围：

| Node 版本           | NODE_MODULE_VERSION | better-sqlite3 12.10.0 prebuild | 备注                                |
| ------------------- | ------------------- | -------------------------------- | ----------------------------------- |
| 20.x LTS            | 115                 | ✅ 提供                          | 官方支持                            |
| 22.x LTS            | 127                 | ✅ 提供                          | 官方支持                            |
| 23.x                | 131                 | ❌ 无 prebuild，需源码编译       | 不在锁定范围                        |
| 24.x（24.12.0 实测）| 137                 | ❌ 无 prebuild，需源码编译       | 需 `npm rebuild better-sqlite3` 修复 |

**实测案例**（2026-06-10）：开发机误装 Node 24.12.0，git push 触发 lefthook
pre-push 钩子跑 vitest，67 个测试用例全红。根因是 `new Database()` 抛
`NODE_MODULE_VERSION 145 vs 137` 错误，级联导致 `MemoryIndex` 构造失败、
`index.close()` 报 `undefined`。

**为什么锁定 20/22 而非「>=20」**：

- 跟随 Node 官方 LTS 节奏（20 → 22 → 24），不在非 LTS 版本上花测试资源
- 避免 clone 后第一件事就撞 prebuild 兼容性陷阱
- 24.x 成为 LTS 后（2025-10 起 24 已成 LTS），需先升级 `better-sqlite3` 到
  提供 137+ prebuild 的版本，再放开 engines 范围

**降级/修复方案**：

- 推荐：用 nvm 切到 Node 22 LTS（`nvm install 22 && nvm use 22`）
- 应急：保留 Node 24，执行 `npm rebuild better-sqlite3` 重新编译 native 模块

## 何时回顾

- 当 Deno / Bun 生态成熟度追平 npm 时
- 当需要 Python 生态（如 ML 模型本地推理）时
