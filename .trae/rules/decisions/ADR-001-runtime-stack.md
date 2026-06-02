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

## 何时回顾

- 当 Deno / Bun 生态成熟度追平 npm 时
- 当需要 Python 生态（如 ML 模型本地推理）时
