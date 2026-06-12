---
alwaysApply: false
description: 存储层抽象：IMemoryStorage 接口 + 零 native 依赖内核
---

# ADR-002 · 存储层抽象：IMemoryStorage 接口 + 零 native 依赖内核

> **状态**：✅ 已实施 **日期**：2026-06-11 **版本**：v0.7
> **变更原因**：memora 定位为纯逻辑库——零 native 依赖，SqliteStorage/CLI 移出至宿主项目
> **播种批次**：Memora 模式 A v1
> **来源**：项目决策表 §二（历史文档已归档）

## 背景

Memora 需要彻底独立于具体数据库实现。宿主项目（如泊文 Electron）持有
better-sqlite3 数据库实例，封装统一存储接口对外暴露；Memora Agent 内核
为纯业务逻辑模块，不依赖、不初始化数据库，仅接收宿主注入的存储接口完成记忆读写。

v0.7 进一步：**SqliteStorage 自身也从 memora 内核移出**，确保 memora 的 `node_modules`
不包含任何需要编译的 native 模块。测试全量使用 InMemoryStorage。

### 版本历史

| 版本 | 日期       | 选型                                     | 原因                                            |
| ---- | ---------- | ---------------------------------------- | ----------------------------------------------- |
| v0.1 | 初始设计   | better-sqlite3 + sqlite-vec              | 理想方案                                        |
| v0.2 | 2026-06-02 | sqlite3 (mapbox)                         | better-sqlite3 在 Win + Node 24 下编译失败      |
| v0.3 | 2026-06-05 | better-sqlite3                           | 用户验证编译通过（Node v24.12.0 + Python 3.14） |
| v0.4 | 2026-06-10 | **IMemoryStorage 接口 + 可插拔实现**     | Memora 彻底独立，内核零数据库依赖               |
| v0.5 | 2026-06-10 | **pino 改为可选 + cosmiconfig 移除**     | 内核零第三方依赖，pino 动态导入 + console 回退  |
| v0.6 | 2026-06-10 | **移除全局路径硬编码**                   | 内核零硬编码路径，全局配置由宿主通过 configDir 管理 |
| v0.7 | 2026-06-11 | **SqliteStorage 移出内核 + CLI 移出**    | 零 native 依赖，测试全量 InMemoryStorage         |

> 详见 [原 ADR-002 v0.1](./ADR-002-storage-layer-original.md) 和
> [ADR-002 v0.2 记录](./ADR-002-storage-layer.md)（已废弃）。

## 决策

| 项               | 选择                                                         |
| ---------------- | ------------------------------------------------------------ |
| 存储接口         | **IMemoryStorage**（纯 TS 接口，零依赖）                     |
| SQLite 实现      | **SqliteStorage**（已移出到宿主项目，如泊文 `hosts/memora-utils/`） |
| 内存实现         | **InMemoryStorage implements IMemoryStorage**（测试用 + fallback） |
| 依赖管理         | better-sqlite3 完全从 memora 移除，由宿主项目管理            |
| 注入方式         | Agent 构造函数可选参数 `storage?: IMemoryStorage`            |
| 日志抽象         | `ILogger` 接口 + 全局单例 `setLogger()`                     |
| CLI 独立运行     | 移出至宿主项目（泊文 `hosts/memora-cli/`）                   |

## 三层架构

```
┌─────────────────────────────────────────────────┐
│  Electron 壳层（提供 Node 原生模块执行环境）       │
├─────────────────────────────────────────────────┤
│  泊文宿主                                         │
│    ├─ SqliteStorage (持有 better-sqlite3)         │
│    ├─ memora-cli/ (CLI 入口)                      │
│    └─ 注入 IMemoryStorage → Memora Agent          │
├─────────────────────────────────────────────────┤
│  Memora 内核（纯逻辑库，零 native 依赖）            │
│    ├─ IMemoryStorage 接口                         │
│    ├─ InMemoryStorage（测试/fallback）             │
│    └─ agent / memory / persona / skill / ...      │
└─────────────────────────────────────────────────┘
```

## 理由

- **内核零 native 依赖**：memora 的 `node_modules` 不包含任何 C++ 编译模块，`git push` 不再需要 rebuild
- **宿主全权持有数据库**：泊文 Electron 主进程管理 better-sqlite3 生命周期，Memora 不感知
- **宿主可注入日志**：pino 为可选 peerDependency，宿主可注入自定义 ILogger 实现
- **零依赖降级**：pino 不可用时自动降级到 console fallback，内核正常运行
- **测试零 IO + 零 native**：InMemoryStorage 让测试不需要文件系统、不需要编译
- **向后兼容**：Agent 构造函数的 `storage` 参数可选，不传则使用 InMemoryStorage（非持久化兜底）
- **CLI 由宿主提供**：memora 定位纯库，CLI 交互由宿主项目实现

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
    // commander 移除（CLI 移出），better-sqlite3 + pino 完全移除
    "picocolors": "^1.1.0",
    "zod": "^3.25.76"
  },
  "peerDependencies": {
    // better-sqlite3 已移除（宿主项目管理）
    // pino 可选（宿主可注入自定义 ILogger）
    "pino": ">=9.0.0"
  },
  "peerDependenciesMeta": {
    "pino": { "optional": true }
  }
  // optionalDependencies 已清空（better-sqlite3 + pino 均移除）
  // engines_comment 移除（不再需要标注 ABI 版本说明）
  // bin 字段移除（CLI 由宿主提供）
}

## 影响

- `src/memory/storage-interface.ts`：IMemoryStorage 接口定义
- `src/logging/logger-interface.ts`：ILogger 接口
- `src/logging/logger.ts`：全局单例 + `setLogger()` 可替换
- `src/memory/in-memory-storage.ts`：InMemoryStorage（测试用 + fallback）
- `src/memory/project-manager.ts`：`storage` fallback 改为 InMemoryStorage
- `src/agent/agent.ts`：AgentOptions `storage` fallback 改为 InMemoryStorage
- `src/index.ts`：移除 SqliteStorage 导出 + CLI 入口
- **已删除**：`src/memory/index.ts`（SqliteStorage → 宿主项目）
- **已删除**：`src/cli/`（CLI → 宿主项目）
- **已删除**：better-sqlite3 依赖（peerDependencies + optionalDependencies）
- **已删除**：commander 依赖（CLI 移出后不再需要）
- **已移出**：`src/memory/__tests__/index.test.ts` → 宿主项目
- **已移出**：`src/llm/__tests__/smoke-mimo.test.ts` → 宿主项目
- 测试全量 InMemoryStorage，零 IO，零 native 编译

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
- 当 Node.js 内置 sqlite 稳定时（可提供 NodeSqliteStorage 实现，但仍由宿主管理）
- 当宿主项目需要 IndexedDB / LevelDB 等非 SQLite 存储时
- memora 新增任何依赖时（必须通过零依赖硬约束审查）

## 相关历史

- [ADR-002 v0.1 · better-sqlite3 + sqlite-vec](./ADR-002-storage-layer-original.md)
  — 初始方案
- [ADR-002 v0.2 · sqlite3 (mapbox)](./ADR-002-storage-layer.md)
  — 已废弃（2026-06-02 ~ 2026-06-05）
- ADR-002 v0.3 · better-sqlite3
  — 已废弃（2026-06-05 ~ 2026-06-10）
- ADR-002 v0.4 ~ v0.6 · IMemoryStorage 逐步独立
  — 逐步移出依赖，最终 v0.7 实现零 native 依赖内核
