---
alwaysApply: false
description: 选用 better-sqlite3 作为存储层（统一索引表）
---

# ADR-002 · 选用 better-sqlite3 作为存储层（统一索引表）

> **状态**：✅ 已实施 **日期**：2026-06-05 **版本**：v0.3
> **变更原因**：用户验证 better-sqlite3 在 Windows + Node
> 24 下编译通过；better-sqlite3 是 Node.js 社区公认最快的 SQLite 驱动
> **播种批次**：Memora 模式 A v1
> **来源**：[项目决策表.md §二](../../docs/项目决策表.md) +
> [01-主架构-v4.0.md §4.3](../../docs/基础设计文档/01-主架构-v4.0.md)

## 背景

5 种记忆类型（永驻 / 领域 / 话题 / 能力 / 归档）需要统一的检索能力。设计哲学"万物皆记忆"要求它们共享同一套索引机制。

### 版本历史

| 版本 | 日期       | 选型                        | 原因                                            |
| ---- | ---------- | --------------------------- | ----------------------------------------------- |
| v0.1 | 初始设计   | better-sqlite3 + sqlite-vec | 理想方案                                        |
| v0.2 | 2026-06-02 | sqlite3 (mapbox)            | better-sqlite3 在 Win + Node 24 下编译失败      |
| v0.3 | 2026-06-05 | **better-sqlite3**          | 用户验证编译通过（Node v24.12.0 + Python 3.14） |

> 详见 [原 ADR-002 v0.1](./ADR-002-storage-layer-original.md) 和
> [ADR-002 v0.2 记录](./ADR-002-storage-layer.md)（已废弃）。

## 决策

| 项               | 选择                                                         |
| ---------------- | ------------------------------------------------------------ |
| 数据库           | **better-sqlite3**                                           |
| 索引表设计       | 单一 `memories` 表 + `memory_type` 字段区分                  |
| 文件与数据库分工 | 文件承载本体，数据库承载索引（冷热分离）                     |
| 阶段三向量检索   | ✅ 已决策：纯 JS 余弦相似度 + JSON 持久化（见年轮修订 v0.2） |

## 理由

- **better-sqlite3**：同步 API（代码更简洁，删除 ~40 行 Promise 包装）；预编译语句缓存（重复查询零开销）；Node.js 社区公认最快的 SQLite 驱动
- **单一索引表**：符合"万物皆记忆"哲学；5 类记忆共享检索逻辑；扩展性好
- **冷热分离**：文件可读可编辑（备份/迁移零成本）；数据库只存索引和结构化数据

## better-sqlite3 vs sqlite3 (mapbox) 对比

| 维度       | better-sqlite3            | sqlite3 (mapbox)      |
| ---------- | ------------------------- | --------------------- |
| API 风格   | **同步**（无回调）        | 异步（回调/Promise）  |
| 性能       | **极高**（预编译缓存）    | 高（异步开销）        |
| 代码简洁度 | `db.prepare().all()`      | `await runAsync(...)` |
| 安装难度   | 需 VS Build Tools         | prebuilt 二进制       |
| 自定义函数 | ✅ 支持（FTS5 tokenizer） | 部分支持              |
| 阶段三向量 | 纯 JS（同 v0.2）          | 纯 JS（同 v0.2）      |

## 影响

- `src/memory/index.ts` 重写：sqlite3 async API → better-sqlite3 sync API（删除
  `runAsync`/`allAsync`/`closeAsync` 包装函数）
- `src/memory/project-manager.ts`：`close()` → 移除
  `.catch()`（同步，try-catch 包裹）
- `package.json`：`sqlite3` + `@types/sqlite3` → `better-sqlite3` +
  `@types/better-sqlite3`
- `MemoryIndex.read()` 兼容保留（空方法），旧调用方无需修改
- 453 测试全量通过，0 编译错误

## 代码 API 变化

### 旧版（sqlite3 / mapbox）

```typescript
const row = await allAsync(db, 'SELECT * FROM memories WHERE id = ?', [id]);
```

### 新版（better-sqlite3）

```typescript
const row = db.prepare('SELECT * FROM memories WHERE id = ?').all(id);
```

## 何时回顾

- 阶段三启用语义检索时（向量检索方案不变）
- 当 Node.js 内置 sqlite 稳定时

## 相关历史

- [ADR-002 v0.1 · better-sqlite3 + sqlite-vec](./ADR-002-storage-layer-original.md)
  — 初始方案
- [ADR-002 v0.2 · sqlite3 (mapbox)](./ADR-002-storage-layer.md)
  — 已废弃（2026-06-02 ~ 2026-06-05）
