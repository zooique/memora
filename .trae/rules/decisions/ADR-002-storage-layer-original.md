---
alwaysApply: false
description: 选用 better-sqlite3 + sqlite-vec 作为存储层（统一索引表）
---

# ADR-002 · 选用 better-sqlite3 + sqlite-vec 作为存储层（统一索引表）

> **状态**：❌ 阶段一已废弃（被 [新 ADR-002](./ADR-002-storage-layer.md) 替代）
> **日期**：2026-06-02（废弃于同日） **废弃原因**：Windows + Node
> 24 环境无法安装（缺 VS Build Tools）
> **保留理由**：作为"理论最优方案"存档；阶段三在合适环境可恢复

## 原决策（已废弃）

| 项               | 选择                                        |
| ---------------- | ------------------------------------------- |
| 数据库           | better-sqlite3                              |
| 向量库（阶段三） | sqlite-vec                                  |
| 索引表设计       | 单一 `memories` 表 + `memory_type` 字段区分 |
| 文件与数据库分工 | 文件承载本体，数据库承载索引（冷热分离）    |

## 废弃时点

2026-06-02，npm install 失败时发现。

## 废弃原因

- better-sqlite3 11.3.0 没有 Node 24 的 prebuilt 二进制
- node-gyp 找不到 Visual Studio Build Tools
- Windows 上需要安装 1-3 GB 的 VS Build Tools 才能从源码编译
- 用户决策：改用 `sqlite3`（mapbox 包）作为阶段一方案（已验证可装）

## 阶段三恢复条件

满足任一条件时，可重新评估 better-sqlite3 + sqlite-vec：

- [ ] 用户切换到 Linux/macOS
- [ ] 用户安装 Visual Studio Build Tools
- [ ] 用户降级到 Node 22 LTS（better-sqlite3 11.x 有完整 prebuilt）
- [ ] Node.js 内置 sqlite 稳定且 sqlite-vec 兼容

## 关联

- 新版：[ADR-002 · 选用 sqlite3 (mapbox) 作为存储层](./ADR-002-storage-layer.md)
