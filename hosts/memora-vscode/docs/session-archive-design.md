# 会话归档（会话记录物理分区）设计草稿 — 探索中

> 状态：**探索中**（可逆决策，先写 docs 草稿验证，不预写 ADR）。
> 目标：让「已关闭 / 不再经常用」的会话记录物理挪到独立存放区，**不污染用户的选择界面**，且清洗期后可随时回看 / 恢复。

## 一、结论先行

- **纯宿主侧改动，内核零改动。**
- 「分区」的载体 = **物理存放路径本身**，不是新增数据字段，故不动 `SessionMeta`、不改内核 `ISessionStore` 契约、不新增记忆轨。
- 「归档」= 把某会话的元数据 + 轮次文件，从活动路径 `move` 到归档路径。
- 探索期只收文档，不落地代码。

## 二、边界与内核零改动论证

| 数据 | 归属 | 载体 |
| --- | --- | --- |
| 原始对话（meta + rounds） | **宿主** | `WorkspaceSessionStore`（`sessions.json`）+ `WorkspaceRoundStore`（`rounds/*.json`） |
| 精华记忆（round-summary） | **内核** | 记忆库（每轮自动生成，单轨） |

内核只认 `ISessionStore` 抽象，**不感知物理落盘位置**（见 `src/memory/sessionStore.ts` 契约）。因此宿主把某个会话的记录放哪、放几个文件，内核无感知——`listSessionMetas` / `loadMessages` / `traceSummary` 都按 `sessionId` 走宿主实现，只要宿主实现兜住归档会话的回读即可。

> 注意：**本功能不产生新的记忆**。会话的「精华」已由内核 round-summary 每轮自动沉淀；归档只收容**原始素材**（可回看的对话记录）。不要新造「会话→记忆」转换轨（违记忆单轨原则）。

## 三、现状存储结构（改动基准）

```
.memora/
  sessions.json            # WorkspaceSessionStore：sessionId → SessionMeta + roundIds
  rounds/
    index.json             # WorkspaceRoundStore：roundId → status + refCount + file
    {roundId}.json         # 单个 Round 完整数据
```

- 会话记录 = `sessions.json` 里的一条（meta + roundId 引用）+ 引用的若干 `rounds/{roundId}.json`。
- 消息正文唯一真相源在 `rounds/`，`sessions.json` 只存 roundId 列表。

## 四、方案：位置即分区

**判别「会话属于哪个分区」= 它所在的物理路径 / 文件**，不引入字段。

### 落盘布局（改后）

```
.memora/
  sessions.json            # 活动会话（listSessionMetas 只扫这里）
  archived/                # ── 归档区（原样结构、同 schema）──
    sessions.json          #   归档会话：SessionMeta + roundIds
    rounds/
      index.json
      {roundId}.json
```

要点：
1. `archived/sessions.json`、`archived/rounds/` 与活动区**同一 schema**——**不改数据表结构**，只是另一份散落在不同路径。
2. 无迁移：归档不是改字段，是**搬文件**。
3. `sessionId`（YYYY-MM-DD-sessionName）全局唯一，活动区 / 归档区不允许同名并存。

### 判定与操作（宿主内部方法）

- `resolveSessionLocation(sessionId)` → `active | archived`：先查活动 `sessions.json`，查不到再查 `archived/sessions.json`。
- `archiveSession(sessionId)`：
  1. 从活动 `sessions.json` 读出该条 meta + roundId 列表；
  2. 把该会话引用的每个 `rounds/{roundId}.json` `move` 到 `archived/rounds/` 并更新两区 `index.json` 的 refCount（**先入后删，成对完整搬**）；
  3. 把 meta + roundIds 写入 `archived/sessions.json`，再从活动 `sessions.json` 移除；
  4. 全流程原子（失败可回滚：已搬的 round 移回）。
- `restoreSession(sessionId)`：反向执行（archived → active），同样成对搬。
- `deleteSession(sessionId)`：变为「先在 locating 结果所在分区内删除 meta + 其引用归零的 rounds」，语义不变。

### 界面

- 会话选择界面：`listSessionMetas` 只枚举活动 `sessions.json` → 归档会话自然不显示（**非 UI 过滤**，是物理不存在于活动区）。
- 新增「归档视图」：只读展示 `archived/sessions.json` 列表，提供「恢复」/「删除」操作；查看某归档会话详情 = 经 `resolveSessionLocation` 回读其 rounds。

### IPC / 消息类型

- 在 `src/shared/protocol.ts` 登记新增消息类型（archive/restore/归档列表枚举）。**该文件有去重消息数量阈值治理，新类型一次性收口**，勿引入重复别名。

## 五、落地改动清单（宿主侧，全部）

1. `extension/host/workspaceRoundStore.ts`：支持「两区」round 读写 + 跨区 move（或由上层 store 编排 move，roundStore 只提供 resolve）。
2. `extension/host/sessionStore.ts`：
   - 引入 active / archived 两个 session 文件；
   - `listSessionMetas()`/`loadMessages`/`listSessions` 指向 active（`loadMessages` 对归档会话经 locate 兜底回读）；
   - 新增 `archiveSession` / `restoreSession`。
3. 控制器 / extension 注册 IPC：archive / restore / 列出归档。
4. `webview` 归档视图（列表 + 恢复/删除）与入口（会话历史界面加「归档」按钮）。
5. `src/shared/protocol.ts`：登记新消息类型。
6. 测试：`workspaceSessionStore.test.ts` 补归档/恢复/分区互斥用例。

## 六、风险与注意

- **成对搬**：meta 与 rounds 必须同为一步搬完；漏搬 → 归档后无内容或 `traceSummary` 回溯断供。
- **同名撞库**：活动区与归档区不许同名会话；move 前校验 `sessionId` 已存在则拒绝 / 加后缀。
- **孤儿清扫联掉**：`WorkspaceRoundStore` 现有孤儿清扫按 refCount 走；跨区 move 时两区 `index.json` 的 refCount 需同步维护，避免误清。
- **崩溃一致性**：move 非单文件原子；采用「先写目标、校验成功后删源」防半搬状态。
- 探索期内不写 ADR；验证稳定、被真实场景复现消费后再固化为定案（含引用方盘点）。

## 七、关联

- [memory-role-pack-boundary-rules.md](../../../.trae/rules/memory-role-pack-boundary-rules.md)（会话记录归宿主会话存储、记忆单轨 round-summary）
- `src/memory/sessionStore.ts`（内核 `ISessionStore` 契约，本次不动）
- [directory-structure.md](./directory-structure.md)、[host-overview.md](./host-overview.md)