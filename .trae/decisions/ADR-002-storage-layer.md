---
alwaysApply: false
description: 存储层抽象：IMemoryStorage 接口 + Node.js 专属 + 零第三方依赖内核
---

# ADR-002 · 存储层抽象：IMemoryStorage 接口 + Node.js 专属 + 零第三方依赖内核

> **状态**：✅ 已实施 **日期**：2026-06-11 **版本**：v0.9（2026-07-30 定位定论）
> **变更原因**：memora 定位为 Node.js 专属纯逻辑库——零第三方运行时依赖，依赖 Node.js 内置模块，SqliteStorage/CLI 移出至宿主项目

## 背景

Memora 需要彻底独立于具体数据库实现。宿主项目（如泊文 Electron）持有 better-sqlite3 实例并封装统一存储接口；Agent 内核为纯业务模块，不依赖、不初始化数据库，仅接收宿注注入的存储接口完成记忆读写。**SqliteStorage 自身也移出内核**，确保 `node_modules` 不含任何需编译的 native 模块，测试全量使用 InMemoryStorage。

## 决策

| 项               | 选择                                                         |
| ---------------- | ------------------------------------------------------------ |
| 存储接口         | **IMemoryStorage**（纯 TS 接口，零依赖）                     |
| SQLite 实现      | **SqliteStorage**（已移出至宿主项目，由宿主各自实现持久化，内核经 `IMemoryStorage` 接口注入） |
| 内存实现         | **InMemoryStorage implements IMemoryStorage**（测试用 + fallback） |
| 依赖管理         | better-sqlite3 完全从 memora 移除，由宿主项目管理            |
| 注入方式         | Agent 构造函数可选参数 `storage?: IMemoryStorage`            |
| 日志抽象         | `ILogger` 接口 + 全局单例 `setLogger()`                     |
| CLI 独立运行     | 移出至精灵宿主 `hosts/memora-sprite/`                        |

15 个方法（基础 CRUD + 软删除/回收站 + 统计维护 + 可选 close），全部同步语义。完整方法清单以源码为准：`src/memory/storageInterface.ts`，此处不内嵌。

## 三层架构

```
┌─────────────────────────────────────────────────┐
│  Electron 壳层（提供 Node 原生模块执行环境）       │
├─────────────────────────────────────────────────┤
│  精灵宿主（memora-sprite）                        │
│    ├─ SqliteStorage (持有 better-sqlite3)         │
│    ├─ memora-cli/ (CLI 入口)                      │
│    └─ 注入 IMemoryStorage → Memora Agent          │
├─────────────────────────────────────────────────┤
│  Memora 内核（纯逻辑库，零 native 依赖）            │
│    ├─ IMemoryStorage 接口 + InMemoryStorage       │
│    └─ agent / memory / skill / ...                │
└─────────────────────────────────────────────────┘
```

## 理由

- **内核零 native 依赖**：`node_modules` 不含 C++ 编译模块，`git push` 无需 rebuild
- **宿主全权持有数据库**：宿主主进程管理 better-sqlite3 生命周期，Memora 不感知
- **宿主可注入日志**：pino 走可选 peerDep（动态 import，零配置时 fallback console）；宿主可注入自定义 ILogger
- **测试零 IO + 零 native**：InMemoryStorage 让测试不需要文件系统、不需要编译
- **向后兼容**：`storage` 可选，不传则用 InMemoryStorage 兜底
- **CLI 由宿主提供**：memora 定位纯库

## 补充 · 同步优先决策（2026-07-12，排雷 AUDIT-4-1）

IMemoryStorage **保持同步语义**，不新增 IAsyncMemoryStorage 兄弟接口。理由：与 better-sqlite3 同步 API 对齐（事务原子性、无 async 边界开销）；`await` 同步值立即返回，调用方无需改；VectorStore.search 的异步是独立需求，不影响关键词搜索。仅当"真实浏览器直跑内核 + 非 SQLite 异步后端"同时出现且重复 2 次以上（见 [ADR-017](./ADR-017-natural-growth-redefinition.md) 枝叶 2 次提取）才启动预研。浏览器访问能力由宿主 Web 调试通道桥接，内核不感知。

## 补充 · Logger 懒初始化 + 定位定论（v0.9，2026-07-30）

**Logger 懒初始化**：`src/logging/logger.ts` 不得在模块顶层触发 fs 副作用（import 即 mkdir/createWriteStream 污染测试环境）。改为 Proxy getter 首次日志调用时异步触发 pino 升级，console fallback 同步可用，`setLogger(undefined)` 重置守卫。

**定位定论 — 约束语义精确化**：从"零依赖内核"修正为"**Node.js 专属 + 零第三方运行时依赖**"：

| 约束项 | 状态 | 说明 |
|--------|------|------|
| ✅ 依赖 `node:*` 内置模块 | 合法 | fs/path/os/crypto/http 是 Node.js 专属内核的正常依赖 |
| ✅ 可选 peerDep（pino） | 合法 | 动态 import，宿主不装则 fallback console |
| ❌ 第三方运行时依赖 | 禁止 | `dependencies` 为空 |
| ❌ native 编译模块 | 禁止 | better-sqlite3/electron 等不进入内核 |
| ❌ 宿主专属 API | 禁止 | Electron/browser API 不进入内核 |

原因：v0.7~v0.8"零 native 依赖"表述与实现脱节——12 个生产文件依赖 node:* 模块，催生了 logger 用动态 import 规避静态分析的补丁代码（坏味道）。修正后承认依赖 Node 运行时，保留真正有价值的"零第三方依赖"，消除"内核可脱离 node"的伪可移植性。内核是 **Node.js 专用纯逻辑库**，"浏览器可 import"仅在有价值模块层面实现（如 logger）。

## 何时回顾

- 阶段四启用 Web 形态时（可能需要 IAsyncMemoryStorage）
- Node.js 内置 sqlite 稳定时（可提供 NodeSqliteStorage 实现，仍由宿主管理）
- 宿主需要 IndexedDB / LevelDB 等非 SQLite 存储时
- memora 新增任何依赖时（须通过零依赖硬约束审查）