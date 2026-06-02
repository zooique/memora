---
alwaysApply: false
description: 选用 sqlite3 (mapbox) 作为存储层（统一索引表）
---

# ADR-002 · 选用 sqlite3 (mapbox) 作为存储层（统一索引表）

> **状态**：🔄 替代 [原 ADR-002](./ADR-002-storage-layer-original.md)
> — 阶段一方案 **日期**：2026-06-02 **变更原因**：原 better-sqlite3 在 Windows +
> Node 24 下需要 Visual Studio 编译；用户验证 `sqlite3` (mapbox) 可行
> **播种批次**：Memora 模式 A v1
> **来源**：[项目决策表.md §二](../../docs/项目决策表.md) +
> [agent设计.md §4.3](../../docs/基础设计文档/agent设计.md)

## 背景

5 种记忆类型（永驻 / 领域 / 话题 / 能力 / 归档）需要统一的检索能力。设计哲学"万物皆记忆"要求它们共享同一套索引机制。

**阶段一原方案**（[ADR-002 原版](./ADR-002-storage-layer-original.md)）：better-sqlite3 +
sqlite-vec。

**变更原因**：

- 用户环境：Windows 10 + Node.js v24.12.0（Current，非 LTS）
- better-sqlite3 11.3.0 没有 Node 24 的 prebuilt 二进制
- node-gyp 找不到 Visual Studio Build Tools
- 用户验证：`npm install sqlite3`（mapbox 包）可行

## 决策

| 项               | 选择                                                         |
| ---------------- | ------------------------------------------------------------ |
| 数据库           | **sqlite3**（mapbox/node-sqlite3，async 回调 API）           |
| 索引表设计       | 单一 `memories` 表 + `memory_type` 字段区分                  |
| 文件与数据库分工 | 文件承载本体，数据库承载索引（冷热分离）                     |
| 阶段三向量检索   | 待定（可能改用纯 JS 实现或转回 better-sqlite3 + sqlite-vec） |

## 理由

- **sqlite3 (mapbox)**：用户验证可装；异步 API 适合 Node 24；生态成熟
- **单一索引表**：符合"万物皆记忆"哲学；5 类记忆共享检索逻辑；扩展性好
- **冷热分离**：文件可读可编辑（备份/迁移零成本）；数据库只存索引和结构化数据

## 与原 ADR-002 的差异

| 维度         | 原版（better-sqlite3） | 新版（sqlite3）      |
| ------------ | ---------------------- | -------------------- |
| API 风格     | 同步                   | 异步（回调/Promise） |
| 安装难度     | Windows 需 VS          | 用户验证可行         |
| 性能         | 极高（同步）           | 高（异步，略慢）     |
| 阶段三向量   | sqlite-vec（同库）     | 待定（可能换实现）   |
| 阶段一适用性 | 阻塞                   | ✅ 可用              |

## 阶段三向量检索的备选方案

阶段三启用语义检索时，需重新评估：

| 方案                             | 评估                                         |
| -------------------------------- | -------------------------------------------- |
| 改回 better-sqlite3 + sqlite-vec | 届时建议在 Linux/macOS 上运行；或用 WSL 编译 |
| 纯 JS 向量库（如 `vectorious`）  | 性能可能不足                                 |
| LanceDB（独立进程）              | 违反"本地化"哲学                             |
| 文件级向量缓存                   | 自建索引；性能可控但开发成本高               |

**结论**：阶段三再做决策，本 ADR 不预先确定。

## 替代方案（已排除）

| 方案                           | 放弃原因                                    |
| ------------------------------ | ------------------------------------------- |
| node:sqlite（Node 22.5+ 内置） | 实验性 API；sqlite-vec 不兼容；稳定性待验证 |
| sql.js（WASM）                 | 性能 10-100x 差；不适合阶段三语义检索       |
| DuckDB                         | 重；单机场景过度设计                        |
| 按类型分表                     | 破坏"万物皆记忆"统一性                      |

## 影响

- `src/memory/index.ts` 重写：better-sqlite3 同步 API → sqlite3 异步 API
- 单元测试 `tests/unit/memory/index.test.ts` 改为 async/await
- `package.json` 依赖替换：`better-sqlite3@^11.3.0` → `sqlite3@^5.1.7`
- `@types/better-sqlite3` 移除
- 阶段一交付时间：不变（API 差异在用户代码层面透明）

## 代码 API 变化

### 旧版（better-sqlite3）

```typescript
const stmt = db.prepare('SELECT * FROM memories WHERE id = ?');
const row = stmt.get(id);
```

### 新版（sqlite3）

```typescript
const row = await db.get('SELECT * FROM memories WHERE id = ?', [id]);
```

## 何时回顾

- 阶段三启用语义检索时
- 当 sqlite3 (mapbox) 包不再维护
- 当 Node.js 内置 sqlite 稳定时
- 当 Windows 安装 VS Build Tools 后可换回 better-sqlite3 + sqlite-vec

## 相关历史

- [原 ADR-002 · better-sqlite3 + sqlite-vec](./ADR-002-storage-layer-original.md)
  — 已废弃阶段一方案
- 变更原因：用户环境约束 + 实用主义优先
