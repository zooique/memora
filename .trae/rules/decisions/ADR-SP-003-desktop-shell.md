---
alwaysApply: false
description: "memora-sprite 宿主：桌面壳分阶段策略"
---

# ADR-SP-003 · 桌面壳

> **状态**：✅ 已接受（2026-06-16）
> **依赖**：ADR-005（CLI 优先策略，已迁移——CLI 移出至宿主项目 `hosts/memora-sprite/`）

## 背景

精灵需要桌面存在感（系统托盘、通知、窗口），但 GUI 开发成本高。需要决定桌面壳方案和引入时机。

## 决策

**阶段一 CLI 先行，阶段二引入 Electron。**

- 阶段一：纯 CLI 交互（readline），验证 Agent 实例化 + SqliteStorage + 主动唤醒
- 阶段二：Electron 主进程 + 渲染进程，系统托盘 + 最小化窗口 + 通知

## 理由

- **验证优先**：精灵的核心价值是"自我进化"（记忆管道持续运行），不是 GUI。先验证核心机制跑通
- **渐进复杂度**：Electron 引入 native 重建、IPC 通信、窗口生命周期等复杂度，1 人团队应延迟引入
- **better-sqlite3 兼容**：Electron 主进程是 Node.js 运行时，better-sqlite3 可直接使用，无需 Rust 重写

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| Tauri | better-sqlite3 是 Node native 模块，Tauri 需要 Rust 重写存储层 |
| 直接 Electron | 阶段一过早引入 GUI 复杂度，拖慢核心验证 |
| Web UI + 本地服务 | 端口冲突、需开浏览器、与"桌面精灵"定位不符 |
| Neutralinojs | 生态太小，better-sqlite3 兼容性未知 |

## 影响

- 阶段一的 `package.json` 不包含 `electron`，只有 `memora` + `better-sqlite3`
- 阶段二引入 Electron 时需配置 `electron-rebuild`
- CLI 交互层设计为可替换的 `IInteraction` 接口，阶段二替换为 Electron 渲染进程
