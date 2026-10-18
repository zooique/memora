# @zooique/memora-mcp

把本机 **memora 记忆库**（`.memora/memories.db`，SQLite）通过 **MCP 协议**暴露给其他本地 AI agent。

> **当前形态：只读切片。** 只提供检索与读取，不提供写入。
> 设计见 [`docs/方案-服务端MCP宿主-memora-mcp-20261015.md`](../../docs/方案-服务端MCP宿主-memora-mcp-20261015.md)。

## 这是什么

Memora 的 VS Code 插件是「**人**通过界面用 memora 写码」。本包是另一种部署面：让**其他 AI agent**
（Claude Code / Cursor / Cline / Roo / VS Code Copilot）通过 MCP 协议来读你积累的记忆。

两者**共享同一个内核和同一份 `.memora/` 存储**——你的记忆只有一份，多个本地 agent 共用。

```
你的 .memora/ 记忆库  ←──  VS Code 插件（人用，读写）
        ↑
        └────  memora-mcp（其他 agent 用，只读）
```

## 暴露的工具

| 工具 | 作用 | 参数 |
| --- | --- | --- |
| `list_memory_sources` | 列出所有来源标签及条目数（推荐第一步） | — |
| `search_memories` | 关键词检索，返回摘要清单 | `query`（必填）、`limit` |
| `get_memory_by_id` | 按 id 取全文 | `id`（必填） |
| `get_memories_by_source` | 按来源标签批量取摘要 | `source`（必填）、`limit` |

推荐用法：`list_memory_sources` 摸清有什么 → `search_memories` 定位 → `get_memory_by_id` 取全文。
（先列表后取全文，避免一次灌爆上下文。）

## 接入方式

### Claude Code

```bash
claude mcp add memora -- npx -y @zooique/memora-mcp --db /path/to/your/workspace
```

### Claude Desktop / Cursor / VS Code（`mcpServers` 配置块）

```json
{
  "mcpServers": {
    "memora": {
      "command": "npx",
      "args": ["-y", "@zooique/memora-mcp", "--db", "/path/to/your/workspace"]
    }
  }
}
```

> `--db` 指向**工作区根目录**（其下含 `.memora/memories.db`），语义与 VS Code 插件一致。
> 不传则用当前工作目录。
>
> **前置条件**：Node ≥22.13（内置 `node:sqlite`）；该工作区须先用 Memora VS Code 插件
> （≥1.101）打开过一次——库由插件创建、旧 `memories.json` 也由插件迁移。
> MCP 只读，不建库、不迁移；库不存在会**报错退出**并说明成因，不会静默返回空结果。

### 本地构建后直接跑

```bash
cd hosts/memora-mcp
pnpm install
pnpm run build
node dist/index.js --db /path/to/your/workspace
```

验证端到端是否真的通（真实 MCP Client 走 stdio 往返，含**取代过滤正确性**断言）：

```bash
npm run smoke    # = build + 起进程 + initialize/tools/list/tools/call 全链路断言
```

## 架构边界（为什么这么写）

| 关注点                                                    | 归属                                                   | 说明                                                |
| ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------- |
| 检索 / 排序 / 软删除过滤                                         | **内核** `createNodeSqliteStorage`（`{ readOnly: true }` 只读视图） | 不自实现，避免与内核出现第二套算法                                 |
| 取代状态判定                                                 | **内核** `hasActiveSuperseder`                          | `supersededBy` 悬空指针的唯一判据，必须过滤被取代的旧摘要              |
| 定位库 + 只读打开 + 剔除被取代者                                     | **本宿主**（`readOnlyFileStore.ts`）                       | 本包唯一自写代码模块（三步之外全部委托内核）                            |
| 存储 / 传输 / SDK                                          | **本宿主**                                              | 这些依赖会破坏内核零依赖红线，故不入内核                              |

**只读保证由结构表达**：`ReadOnlyFileStore` 不暴露 `upsert / delete / restore / purge / touch`，
外部拿不到这些 API——不是「约定不乱调」。

## 已知限制

1. **只有本机 agent 能接入。** stdio 服务器是本机子进程，**没有公网 URL**——
   云端 / 远程 API 类 agent 触不到你的 `.memora/`。这是 local-first 的刻意取舍。
2. **只读连接每次查询读当前快照——新记忆实时可见。** 不缓存整库，插件刚写入的记忆下次查询即可召回，
   无需为「读到的还是旧内容」重启 MCP 服务器。
3. **不做 `touch`（不刷新 `accessedAt`）**：只读视图**结构性不含**写方法
   （`ReadOnlyMemoryStorage` 无 `upsert`/`delete`/`restore`/`purge`/`touch`），刷新使用轨迹需要写能力——
   本包刻意放弃，而非「约定不乱调」。
4. **写入能力已明确放弃，不是暂缓。** 本包只读，且**未来也不会加写**——
   理由不是「做不到」，而是「做了会更糟」：记忆的类型契约只能由一条链产出
   （插件侧的 LLM 提炼），MCP 侧写入会造出形似神不似的二等记忆，污染下游治理链。
   详见 `.trae/decisions/ADR-MCP-001-mcp-server-host.md` 决策 8。
   **`.memora/` 的权威记忆由 VS Code 插件宿主维护，本包只提供只读视图（每次查询读当前活库）。**

## 发布前必改（⚠ 勿忘）

当前 `package.json` 的内核依赖写的是 `file:../..`（**本地联调用**）：

```json
"dependencies": { "@zooique/memora": "file:../.." }
```

**`file:` 协议不能发布到 npm**。正式 publish 前须改为真实版本号：

```json
"dependencies": { "@zooique/memora": "^5.0.0" }
```

发布步骤：

```bash
npm publish                          # 1. 发 npm 包
mcp-publisher init                   # 2. 生成 server.json（已提交，可跳过）
mcp-publisher login github           # 3. 证明 io.github.zooique 命名空间
mcp-publisher publish                # 4. 登记官方 MCP Registry（下游市场自动同步）
```

> **本地联调事实（2026-10-18 实测）**：`hosts/memora-mcp/node_modules/@zooique/memora`
> 是指向仓库根的**符号链接**（`ls -la` 显示 `-> /f/zooique/memora`），不是硬链接副本。
> 内核 `npm run build` 后 mcp 立即读到新 `dist`，无需重装。若某次显示为副本而非链接，
> 才需要 `pnpm install --offline` 刷新。
