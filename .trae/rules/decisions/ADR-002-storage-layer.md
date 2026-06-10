---
alwaysApply: false
description: 存储层抽象：IMemoryStorage 接口 + better-sqlite3 可插拔实现
---

# ADR-002 · 存储层抽象：IMemoryStorage 接口 + 可插拔实现

> **状态**：✅ 已实施 **日期**：2026-06-10 **版本**：v0.6
> **变更原因**：Memora 彻底独立——内核零第三方依赖 + 零硬编码路径，
> 宿主项目注入存储 + 日志实现，全局配置由宿主管理
> **播种批次**：Memora 模式 A v1
> **来源**：[项目决策表.md §二](../../docs/项目决策表.md) +
> [01-主架构-v4.0.md §4.3](../../docs/基础设计文档/01-主架构-v4.0.md)

## 背景

Memora 需要彻底独立于具体数据库实现。宿主项目（如泊文 Electron）持有
better-sqlite3 数据库实例，封装统一存储接口对外暴露；Memora Agent 内核
为纯业务逻辑模块，不依赖、不初始化数据库，仅接收宿主注入的存储接口完成记忆读写。

### 版本历史

| 版本 | 日期       | 选型                                     | 原因                                            |
| ---- | ---------- | ---------------------------------------- | ----------------------------------------------- |
| v0.1 | 初始设计   | better-sqlite3 + sqlite-vec              | 理想方案                                        |
| v0.2 | 2026-06-02 | sqlite3 (mapbox)                         | better-sqlite3 在 Win + Node 24 下编译失败      |
| v0.3 | 2026-06-05 | better-sqlite3                           | 用户验证编译通过（Node v24.12.0 + Python 3.14） |
| v0.4 | 2026-06-10 | **IMemoryStorage 接口 + 可插拔实现**     | Memora 彻底独立，内核零数据库依赖               |
| v0.5 | 2026-06-10 | **pino 改为可选 + cosmiconfig 移除**     | 内核零第三方依赖，pino 动态导入 + console 回退  |
| v0.6 | 2026-06-10 | **移除全局路径硬编码**                   | 内核零硬编码路径，全局配置由宿主通过 configDir 管理 |

> 详见 [原 ADR-002 v0.1](./ADR-002-storage-layer-original.md) 和
> [ADR-002 v0.2 记录](./ADR-002-storage-layer.md)（已废弃）。

## 决策

| 项               | 选择                                                         |
| ---------------- | ------------------------------------------------------------ |
| 存储接口         | **IMemoryStorage**（纯 TS 接口，零依赖）                     |
| SQLite 实现      | **SqliteStorage implements IMemoryStorage**（better-sqlite3） |
| 内存实现         | **InMemoryStorage implements IMemoryStorage**（测试用）      |
| 依赖管理         | better-sqlite3 移到 peerDependencies + optionalDependencies  |
| 注入方式         | Agent 构造函数可选参数 `storage?: IMemoryStorage`            |
| 日志抽象         | `ILogger` 接口 + 全局单例 `setLogger()`（2026-06-10 补充）  |
| CLI 独立运行     | 内部自建 SqliteStorage（仍需 better-sqlite3）                |

## 三层架构

```
┌─────────────────────────────────────────────────┐
│  Electron 壳层（提供 Node 原生模块执行环境）       │
├─────────────────────────────────────────────────┤
│  泊文宿主（持有 better-sqlite3，实现 IMemoryStorage）│
├─────────────────────────────────────────────────┤
│  Memora 内核（纯业务逻辑，仅依赖 IMemoryStorage）  │
└─────────────────────────────────────────────────┘
```

## 理由

- **内核零数据库依赖**：Memora 的 `agent/` + `memory/` + `persona/` + `skill/` 不 import better-sqlite3
- **宿主全权持有数据库**：泊文 Electron 主进程管理 better-sqlite3 生命周期，Memora 不感知
- **宿主可注入日志**：pino 为可选 peerDependency，宿主可注入自定义 ILogger 实现
- **零依赖降级**：pino 不可用时自动降级到 console fallback，内核正常运行
- **测试零 IO**：InMemoryStorage 让单元测试不需要文件系统、不需要 native 模块
- **向后兼容**：Agent 构造函数的 `storage` 参数可选，不传则内部创建 SqliteStorage
- **CLI 独立运行**：CLI 模式下 Memora 自行创建 SqliteStorage，不需要外部注入

## IMemoryStorage 接口方法

| 方法 | 说明 |
|------|------|
| `upsert(memory)` | 插入或更新记忆 |
| `delete(id)` | 删除记忆 |
| `getByPermanence(p)` | 按永久性等级获取 |
| `getById(id)` | 按 ID 获取单条 |
| `getByType(t)` | 按类型获取 |
| `touch(ids)` | 触摸记忆（weight 重置） |
| `applyDecay(halfLife)` | 应用权重衰减 |
| `search(query, limit, mode)` | 中文分词搜索 |
| `close?()` | 关闭连接（可选） |

## package.json 变更

```json
{
  "dependencies": {
    // better-sqlite3 + pino 已移除，cosmiconfig 已移除（死依赖）
    "commander": "^12.1.0",
    "picocolors": "^1.1.0",
    "zod": "^3.25.76"
  },
  "peerDependencies": {
    "better-sqlite3": ">=11.0.0",
    "pino": ">=9.0.0"
  },
  "peerDependenciesMeta": {
    "better-sqlite3": { "optional": true },
    "pino": { "optional": true }
  },
  "optionalDependencies": {
    "better-sqlite3": "^12.10.0",
    "pino": "^9.4.0"
  }
}
```

## 影响

- `src/memory/storage-interface.ts`：新增 IMemoryStorage 接口
- `src/logging/logger-interface.ts`：新增 ILogger 接口（2026-06-10 补充）
- `src/logging/logger.ts`：全局单例 + `setLogger()` 可替换（2026-06-10 补充）
- `src/memory/index.ts`：MemoryIndex → SqliteStorage implements IMemoryStorage
- `src/memory/in-memory-storage.ts`：新增 InMemoryStorage
- `src/memory/project-manager.ts`：构造函数新增 `storage?: IMemoryStorage` 参数
- `src/agent/agent.ts`：AgentOptions 新增 `storage?: IMemoryStorage` + `logger?: ILogger`
- `src/index.ts`：导出 IMemoryStorage + SqliteStorage + InMemoryStorage + ILogger + setLogger
- 所有消费者：`MemoryIndex` 类型 → `IMemoryStorage`，`new MemoryIndex` → `new SqliteStorage`
- 453 测试全量通过，0 编译错误
- cosmiconfig 从 dependencies 移除（死依赖，源码 0 处导入）
- `~/.memora/global/rules/` 硬编码路径从 ProjectManager 移除
- `~/.memora/global/skills/` 硬编码路径从 SkillManager 移除
- 全局规则/技能由宿主通过 configDir 统一管理

## 宿主接入示例

```typescript
import { Agent } from 'memora';
import type { IMemoryStorage, ILogger } from 'memora';

// 泊文宿主持有 better-sqlite3
const storage: IMemoryStorage = new BowenSqliteStorage(db);

// 可选：注入自定义 logger（不传则使用 pino 或 console fallback）
const myLogger: ILogger = {
  info: (obj, msg) => console.log('[info]', msg, obj),
  warn: (obj, msg) => console.warn('[warn]', msg, obj),
  error: (obj, msg) => console.error('[error]', msg, obj),
  debug: (obj, msg) => console.debug('[debug]', msg, obj),
};

const agent = new Agent({
  projectPath: '/path/to/novel',
  provider: myProvider,
  storage,      // 注入存储
  logger: myLogger,  // 注入日志（可选）
});

// 也可在构造前全局替换日志
import { setLogger } from 'memora';
setLogger(myLogger);
```

## 何时回顾

- 阶段四启用 Web 形态时（可能需要异步存储接口 IAsyncMemoryStorage）
- 当 Node.js 内置 sqlite 稳定时（可提供 NodeSqliteStorage 实现）
- 当宿主项目需要 IndexedDB / LevelDB 等非 SQLite 存储时

## 相关历史

- [ADR-002 v0.1 · better-sqlite3 + sqlite-vec](./ADR-002-storage-layer-original.md)
  — 初始方案
- [ADR-002 v0.2 · sqlite3 (mapbox)](./ADR-002-storage-layer.md)
  — 已废弃（2026-06-02 ~ 2026-06-05）
- ADR-002 v0.3 · better-sqlite3
  — 已废弃（2026-06-05 ~ 2026-06-10）
