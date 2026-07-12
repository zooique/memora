---
alwaysApply: false
description: 存储层抽象：IMemoryStorage 接口 + 零 native 依赖内核
---

# ADR-002 · 存储层抽象：IMemoryStorage 接口 + 零 native 依赖内核

> **状态**：✅ 已实施 **日期**：2026-06-11 **版本**：v0.7（2026-07-08 补充 Logger 懒初始化）
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

> v0.1 版本（better-sqlite3 + sqlite-vec 统一索引表）已被本文替代，v0.2 记录已合并到本文版本历史。

## 决策

| 项               | 选择                                                         |
| ---------------- | ------------------------------------------------------------ |
| 存储接口         | **IMemoryStorage**（纯 TS 接口，零依赖）                     |
| SQLite 实现      | **SqliteStorage**（已移出到宿主项目，如泊文 `hosts/memora-utils/`） |
| 内存实现         | **InMemoryStorage implements IMemoryStorage**（测试用 + fallback） |
| 依赖管理         | better-sqlite3 完全从 memora 移除，由宿主项目管理            |
| 注入方式         | Agent 构造函数可选参数 `storage?: IMemoryStorage`            |
| 日志抽象         | `ILogger` 接口 + 全局单例 `setLogger()`                     |
| CLI 独立运行     | 移出至宿主项目（泊文 `hosts/memora-sprite/`）                   |

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

## 补充：同步优先决策（2026-07-12，排雷 AUDIT-4-1）

> **来源**：排雷报告方向四 · 存储层异步化预研

### 决策

IMemoryStorage 接口**保持同步语义**，不新增 IAsyncMemoryStorage 兄弟接口。memora 是 Node.js 专用内核，不支持浏览器环境直接运行（浏览器场景需通过宿主层 Web 调试通道访问）。

### 理由

1. **与 better-sqlite3 API 对齐**：同步性是 better-sqlite3 的核心优势——无 callback hell、事务原子性保证、无 async 边界开销
2. **调用方兼容**：`await` 同步值立即返回，调用方已有的 `await storage.xxx()` 调用无需修改
3. **混合接口设计已满足需求**：VectorStore.search 返回 `Promise<Memory[]>`（向量搜索涉及网络调用必须异步），IMemoryStorage 关键词搜索同步即可，两者并行无冲突
4. **影响面可控**：15 个方法签名保持同步，Agent 和所有 Manager 无需异步化改造

### 异步化触发条件

仅在以下条件**同时满足**时启动 IAsyncMemoryStorage 预研：

- 出现真实的浏览器直接运行 memora 内核需求（非通过宿主 Web 调试通道）
- 出现 IndexedDB / LevelDB 等非 SQLite 异步存储后端需求
- 上述需求达到 2 次以上重复（枝叶层 2 次提取原则，详见 [ADR-017](./ADR-017-natural-growth-redefinition.md)）

当前阶段（v1.0.2 收敛期）不满足任何条件，本决策锁定。

### 浏览器场景的现有方案

浏览器访问 memora 能力通过宿主层 Web 调试通道（`hosts/memora-sprite/src/web/`）：

- HTTP 路由消费同一 HostContext，与 IPC handler 平行
- 存储层仍走宿主的 SqliteStorage（同步），Web 层负责 HTTP↔同步桥接
- 内核不感知浏览器存在

## IMemoryStorage 接口方法

> 完整定义见 `src/memory/storageInterface.ts`。所有方法均为同步（与 better-sqlite3 API 对齐）。

### 基础 CRUD（6 方法）

| 方法 | 说明 |
|------|------|
| `upsert(memory)` | 插入或更新记忆 |
| `getById(id)` | 按 ID 获取单条活跃记忆（已软删除的返回 null） |
| `getBySource(source)` | 按来源标签获取活跃记忆（自动过滤已软删除的） |
| `search(query, limit?)` | 关键词搜索活跃记忆（自动过滤已软删除的） |
| `count()` | 统计活跃记忆总数（不含已软删除的） |
| `countBySource(source)` | 按来源标签统计活跃记忆数量 |

### 软删除 / 回收站（6 方法，ADR-004 GAP-6 扩展）

| 方法 | 说明 |
|------|------|
| `delete(id)` | 软删除（写入 deletedAt，不物理移除；对已软删除的 no-op） |
| `restore(id)` | 恢复软删除记忆（清除 deletedAt；对活跃记忆 no-op） |
| `purge(id)` | 物理删除（不可恢复，用于回收站"彻底删除"） |
| `listDeleted(limit?)` | 列出回收站中的软删除记忆（按 deletedAt 降序） |
| `getDeletedById(id)` | 按 ID 获取单条软删除记忆（restore/purge 前的存在性校验） |
| `purgeExpired(before)` | 清理过期的软删除记忆（物理删除 deletedAt 早于 before 的） |

### 统计与维护（2 方法）

| 方法 | 说明 |
|------|------|
| `decayScores(sources, now)` | 批量衰减指定 source 的活跃记忆 score（宿主实现批量 SQL UPDATE） |
| `getAllSources()` | 获取所有 source 标签及其活跃记忆数量（Map<string, number>） |

### 可选（1 方法）

| 方法 | 说明 |
|------|------|
| `close?()` | 关闭连接（可选，宿主注入的实现可能不需要） |

**合计 15 方法**（含可选 close）。所有查询方法自动过滤已软删除的记忆（deletedAt != undefined）。

## package.json 变更

```json
{
  "dependencies": {
    // commander 移除（CLI 移出），better-sqlite3 + pino + picocolors 完全移除
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
  // optionalDependencies 保留 pino（纯 JS 日志库，便于宿主零配置可用；非 native 依赖）
  // engines_comment 移除（不再需要标注 ABI 版本说明）
  // bin 字段移除（CLI 由宿主提供）
}

## 影响

- `src/memory/storageInterface.ts`：IMemoryStorage 接口定义
- `src/logging/loggerInterface.ts`：ILogger 接口
- `src/logging/logger.ts`：全局单例 + `setLogger()` 可替换
- `src/memory/inMemoryStorage.ts`：InMemoryStorage（测试用 + fallback）
- `src/memory/projectManager.ts`：`storage` fallback 改为 InMemoryStorage
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
import { Agent } from '@zooique/memora';
import type { IMemoryStorage, ILogger } from '@zooique/memora';

// 泊文宿主持有 better-sqlite3
const storage: IMemoryStorage = new BowenSqliteStorage(db);

// 可选：注入自定义 logger（不传则使用 pino 或 console fallback）
const myLogger: ILogger = {
  info: (obj, msg) => console.log('[info]', msg, obj),
  warn: (obj, msg) => console.warn('[warn]', msg, obj),
  error: (obj, msg) => console.error('[error]', msg, obj),
  debug: (obj, msg) => console.debug('[debug]', msg, obj),
};

// v1.0：logger 从 AgentOptions 移除，改用全局 setLogger() 注入（见 ADR-002 补充 · Logger 懒初始化）
const agent = new Agent({
  projectPath: '/path/to/novel',
  provider: myProvider,
  storage,      // 注入存储
});

// 在构造前全局替换日志（v1.0 唯一的 logger 注入方式）
import { setLogger } from '@zooique/memora';
setLogger(myLogger);
```

## 补充：Logger 懒初始化（2026-07-08，1.0 接口稳定化）

> **来源**：1.0 审查报告 P0-4 · Logger 模块加载时异步触发 fs 副作用

### 问题

v0.3 的 `src/logging/logger.ts` 在模块顶层执行 `void tryCreatePinoLogger().then(...)`，导致：

1. **import 即触发 fs 副作用**——`import { logger } from 'memora'` 会立即异步调用 `mkdir` + `createWriteStream`，违反"内核零副作用"原则
2. **测试环境污染**——单元测试 import 内核模块时会创建日志目录/文件，污染测试工作区
3. **浏览器环境报错**——浏览器无 `node:fs`，import 即抛异常

### 决策

改为**懒初始化模式**（lazy initialization）：

```typescript
// 新增：懒触发函数
let _pinoUpgradeStarted = false;  // 守卫，确保只触发一次

function maybeUpgradeToPino(): void {
  if (_pinoUpgradeStarted) return;
  _pinoUpgradeStarted = true;
  // 异步触发 pino 升级（不阻塞首次日志调用）
  void tryCreatePinoLogger().then(/* ... */);
}

// logger getter 在首次调用时触发懒初始化
export const logger: ILogger = new Proxy(/* ... */, {
  get(target, prop) {
    maybeUpgradeToPino();  // 首次日志调用时触发
    return target[prop];
  },
});

// setLogger(undefined) 重置守卫，允许下次懒触发
export function setLogger(custom: ILogger | undefined): void {
  if (custom === undefined) {
    _pinoUpgradeStarted = false;  // 重置，允许下次懒触发
  }
  // ...
}
```

### 设计原则

1. **import 零副作用**——`import { logger }` 不触发任何 fs 操作，仅声明变量
2. **首次日志调用触发**——`logger.info(...)` 首次调用时异步触发 pino 升级，console fallback 同步可用
3. **守卫确保只触发一次**——`_pinoUpgradeStarted` 标志位防止重复触发
4. **setLogger(undefined) 可重置**——允许测试环境重置状态，下次懒触发重新执行
5. **console fallback 同步可用**——pino 升级完成前，所有日志走 console，不丢失日志

### 影响

- `src/logging/logger.ts`：移除模块顶层 `void tryCreatePinoLogger().then(...)`；新增 `maybeUpgradeToPino()` + `_pinoUpgradeStarted` 守卫
- import 内核模块零 fs 副作用
- 测试环境不再因 import 产生日志文件
- 浏览器端 import 不再抛异常（pino 动态 import 失败时降级 console）

## 何时回顾

- 阶段四启用 Web 形态时（可能需要异步存储接口 IAsyncMemoryStorage）
- 当 Node.js 内置 sqlite 稳定时（可提供 NodeSqliteStorage 实现，但仍由宿主管理）
- 当宿主项目需要 IndexedDB / LevelDB 等非 SQLite 存储时
- memora 新增任何依赖时（必须通过零依赖硬约束审查）

## 相关历史

- ADR-002 v0.1 · better-sqlite3 + sqlite-vec — 初始方案（已废弃，被本文替代）
- ADR-002 v0.2 · sqlite3 (mapbox) — 已废弃（2026-06-02 ~ 2026-06-05）
- ADR-002 v0.3 · better-sqlite3
  — 已废弃（2026-06-05 ~ 2026-06-10）
- ADR-002 v0.4 ~ v0.6 · IMemoryStorage 逐步独立
  — 逐步移出依赖，最终 v0.7 实现零 native 依赖内核
