---
alwaysApply: false
description: "memora-sprite 宿主：存储层选型"
---

# ADR-SP-002 · 存储层

> **状态**：✅ 已接受（2026-06-16）
> **依赖**：[ADR-002](./ADR-002-storage-layer.md)（内核存储层抽象）

## 背景

memora 内核定义了 `IMemoryStorage` 和 `ISessionStore` 接口（ADR-002），精灵需要选择具体实现。

## 决策

**better-sqlite3 作为主存储，会话数据同库存储。**

- `SqliteStorage`：实现 `IMemoryStorage`，基于 better-sqlite3
- `SqliteSessionStore`：实现 `ISessionStore`，同一 SQLite 数据库
- 阶段二可选集成 sqlite-vec 实现语义搜索

## 理由

- **接口对齐**：memora 的 `IMemoryStorage` 方法签名是同步的，正是对齐 better-sqlite3 的同步 API 设计（ADR-002 原文："方法签名保持同步语义（与 better-sqlite3 一致）"）
- **单机最优**：SQLite 是单机桌面应用的最佳存储方案，零部署、零配置、零网络延迟
- **同库存储**：会话数据量小（每天几十 KB），无需独立存储，减少文件管理复杂度
- **原子操作**：SQLite 事务支持 `copySession` 的原子性要求

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| IndexedDB | 异步 API，与 IMemoryStorage 同步签名不匹配 |
| 文件系统存储 | 并发写入风险，无事务支持 |
| LevelDB | 无 SQL 查询能力，search() 实现复杂 |
| 独立 SQLite 文件存会话 | 增加文件管理复杂度，无跨库事务 |

## 影响

- 精灵的 `dependencies` 包含 `better-sqlite3`（native 模块，当前 `^12.10.0`）
- Electron 环境需 `@electron/rebuild`（已迁移至 scoped package，替代旧 `electron-rebuild`）
- SqliteStorage 的 `search()` 使用 FTS5 全文搜索（阶段一用 LIKE 关键词匹配）
- `decayScores()` 用一条 SQL UPDATE 批量完成，替代内核的 O(n) 遍历
