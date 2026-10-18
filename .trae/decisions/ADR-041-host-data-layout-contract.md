---
alwaysApply: false
description: 宿主数据布局契约——写宿主定义 `<workspace>/.memora/memories.db`，只读宿主跟随且不建库不回退 JSON；一致性判据是跨宿主契约测试而非文档；库缺失以 FILE_NOT_FOUND 三态诊断；门禁宿主集合按目录发现
---

# ADR-041 · 宿主数据布局契约与只读宿主的跟随规则

> **状态**：✅ 已接受
> **日期**：2026-10-18（`HOST-ALIGN-1` P0-A/B 修复时定案并落地）
> **定案真源**：本 ADR + `hosts/memora-vscode/src/__tests__/crossHostLayout.test.ts`（判据）
> **关联**：ADR-002（存储层抽象 / 内核不感知数据目录）、ADR-MCP-001（MCP 只读宿主）

## 背景

内核按 ADR-002 **不感知数据目录布局**：`createNodeSqliteStorage` 只收全长 `dbPath`，不拼 `.memora/`、不定义文件名。这带来一个结构性后果——「库在哪」这个事实由**每个宿主各自定义**。

2026-10-18 的事故（台账 `HOST-ALIGN-1`）正是这个后果：

1. 写宿主把 `memories.json` 迁移到 `memories.db` 并改名旧档，只读宿主仍在读 `memories.json` ⇒ 已迁移工作区**恒返回空**，且告警把成因误报成「`--db` 写错了」；
2. 内核收回 `InMemoryStorage` 导出时，判据只覆盖 `hosts/memora-vscode`，`hosts/memora-mcp` 编译断裂 + 旧产物启动即抛，24 小时无闸门报警。

两条事故的共同点：**同一事实有多处定义，且没有任何能红的判据**。文档约定拦不住漂移。

## 决策

1. **写宿主定义布局，只读宿主跟随**。
   记忆库固定为 `<工作区>/.memora/memories.db`（SQLite，WAL）。写宿主负责建库、迁移旧 JSON（改名为
   `memories.json.migrated-<date>`，不删除）。只读宿主**不建库、不迁移、不回退读 JSON**——回退会造第二个
   读入口，读到的是陈旧快照，比读不到更危险。

2. **内核边界不变**：内核仍不拼路径、不定义 `.memora`。布局契约属于**宿主之间**，不下沉进内核
   （避免内核多知道一件它不该知道的事，也避免将来收面时再制造一次同型事故）。

3. **一致性判据 = 跨宿主契约测试，不是文档**。
   `crossHostLayout.test.ts` 两条断言缺一不可：
   - ① **两侧一致**：写宿主 `resolveHostMemoryDbPath(ws)` 与只读宿主 `new ReadOnlyFileStore(ws).path` 相等
     —— 抓单侧漂移；
   - ② **布局锚定**：路径必须以 `.memora/memories.db` 结尾 —— 抓「两侧一起改错」（一致但不兼容存量库，
     ① 会误绿）。
   测试加载只读宿主的**构建产物**（宿主 tsconfig 的 `rootDir` 不允许跨包 import 源码），并先断言产物
   不旧于源码，防「测的是历史行为」。

4. **库缺失用错误码表达，不用文案猜**。
   `createNodeSqliteStorage(path, { readOnly: true })` 在库不存在时抛
   `MemoraError{ errorCode: FILE_NOT_FOUND }`（不是驱动的 `ERR_SQLITE_ERROR`）。只读宿主据此把成因分三态：
   未初始化 / 插件仍是旧 JSON 版 / 布局已漂移（有迁移快照却无 db）。三种情况的用户动作不同，混成一句就是废话。

5. **门禁宿主集合按目录发现**（`hosts/*/package.json`），不写死清单。
   所有宿主都进 typecheck 面；缺 `typecheck` 脚本视为配置错误（`exit 2`），不是静默跳过。
   深度面（lint / test / build）仍按各宿主自身 scripts 声明，如实分层而非假装一致。

## 理由

- **为什么不在内核导出布局常量**：那会让内核知道 `.memora`，与 ADR-002 的边界相反；且常量共享只能保证
  「两边犯同一个错」，测试能抓任意一侧的漂移。判据要能红，不能只是「看起来同源」。
- **为什么不回退读 JSON**：迁移后 JSON 已改名，回退读不到；若 JSON 仍在，说明写宿主尚未迁移，此时读到的是
  旧快照——用户会以为 MCP 看到的是最新记忆。宁可不读，不可读错。
- **为什么错误码要落在工厂**：只读宿主若各自 `existsSync`，判据就散在每个宿主里；工厂是唯一知道
  「打开失败的原因」的地方。

## 后果

- 新增只读宿主（如未来的 dsh 插件）必须复用 `createNodeSqliteStorage(..., { readOnly: true })` 并跟随本布局，
  不得自写第二套 SQL 语义。
- 改目录名/文件名 = 改契约：必须同时改写宿主、只读宿主、迁移逻辑与契约测试的锚定断言，否则门禁红。
- 只读宿主的最低运行门槛随之上移到 Node ≥22.13（`node:sqlite`），已在 `hosts/memora-mcp/package.json#engines` 声明。
- 内核 `FILE_NOT_FOUND` 语义成为公共契约的一部分：修改只读分支的抛出行为属破坏性变更。
