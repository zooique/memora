# 方案：HOST-SPLIT-1 P2 chatView 占用域提取（含指标域不提取归档）

> 序列：HOST-SPLIT-1 P2 域外置第 4 刀（chatView 第 3 刀）。先例：planBarView（第 2 刀）、historyMenuView（第 3 刀）。
> **刀切面修正（对上刀方案「指标/占用域」预估的订正）**：上刀方案 §五把「指标/占用域」当作一个约 300 行的候选域。本轮逐行核对后**拆开处理**——占用域边界干净可整域平移；指标域与活动抽屉（dock）**双向耦合**，单独劈出 = 为拆而拆，本刀不提取（理由见 §四）。上刀方案该句的「指标/占用」合并写法属**措辞折叠**（两个耦合形态不同的域被一个顿号折叠），在此订正。

## 一、域梳理

### 1.1 占用域边界枚举（本刀提取对象）

| 类别 | 符号 | 位置 | 域外引用 |
|---|---|---|---|
| 状态 | `contextLimitShown` | 原 L5045 | 零（仅域内 3 处读写） |
| 常量 | `RING_CIRCUMFERENCE` | 原 L5048 | 零（仅 `setRingFill` 用） |
| 常量 | `SEGMENT_LABELS` | 原 L5066 | 零（仅 `buildOccupancyTipText` / `renderOccupancySegments` 用） |
| 函数 | `setRingFill` | 原 L5056 | 零（域内 2 调用） |
| 函数 | `buildOccupancyTipText` | 原 L5082 | 零（域内 2 调用） |
| 函数 | `renderOccupancySegments` | 原 L5115 | 零（域内 2 调用） |
| 函数 | `renderOccupancyLimit` | 原 L5177 | **1 处**：`chat_providers` 分支尾部（原 L5957） |
| 函数 | `updateContextOccupancy` | 原 L5221 | **1 处**：`context_occupancy` 分支（原 L5781） |

- **外部依赖 3 类**：`fmtTokens`（`../helpers/fmtTokens.js`，模块级纯函数）；`ExtensionToWebviewMessage` 类型（`../../shared/protocol.js`，`Extract<…, { type: 'context_occupancy' }>['occupancy']` 同源取型）；DOM id ×5（`contextOccupancy` / `occFill` / `occPercent` / `occTipText` / `occSegments`，**全部即时查询非缓存**，平移零时序风险）。
- **零反向依赖**：域外无任何代码读 `contextLimitShown` 或调域内函数。
- **零监听器**：纯数据驱动渲染（消息到达 → 渲染），无事件注册面。
- 行数：原 L5043–5240 **约 198 行**（≥40 ✅）。

### 1.2 收敛判据三件套核验

① 域边界可枚举（上表 8 符号 + 2 外部调用点）✅；② 测试兜底（`chatView.test.ts` 占用域 5 类用例：chat_providers 空态 0% 空环 / 同上限重复推送不重置 / context_occupancy 真实占用覆盖 / 构成条六段比例与 title / 切换模型重置——全走 `dispatch({type:…})` + DOM 查询，零私有符号穿透风险）✅；③ 搬出降 ≥40 行（约 190 净降）✅。

## 二、容器设计

### 2.1 模块形态

新建 `webview/scripts/contextOccupancyView.ts`（域外置工厂范式第 3 次复制）：

```typescript
export interface ContextOccupancyViewDeps { document: Document }

export interface ContextOccupancyView {
  /** context_occupancy 到达：真实占用渲染（圆环充能 + 明细 + 构成条） */
  updateOccupancy(occ: ContextOccupancySnapshot): void;
  /** chat_providers 到达：按选中 LLM 上限渲染空态（上限未变跳过，防误清零） */
  renderLimit(providers: { name: string; limitTokens: number }[], activeName: string | undefined): void;
}

export function createContextOccupancyView(deps: ContextOccupancyViewDeps): ContextOccupancyView
```

- **类型同源**：容器 `import type { ExtensionToWebviewMessage } from '../../shared/protocol.js'`，`occupancy` 形状用 `Extract<…>['occupancy']` 取型——**不复制字段形状**（8 字段抄一遍 = 第二真源，protocol 改字段必漂移）。historyMenuView 当时自定义 DTO 属无奈（消息形状含行为字段）；此处协议类型直接可用，取之。
- **providers 窄投影**：`renderLimit` 形参收 `{ name: string; limitTokens: number }[]`——容器消费面只有这两个字段（`p.name === activeName` + `active.limitTokens`），TS 结构化类型与 chatView 的 `ChatProviderItem` 天然兼容。`ChatProviderItem` 本体留在 chatView（它是 chatPanel 消息 → chatView 状态的镜像类型，不是占用域的财产）。
- **窄接口 2 面**：内部函数**零改名平移**（`setRingFill` / `buildOccupancyTipText` / `renderOccupancySegments` / `renderOccupancyLimit` / `updateContextOccupancy`），窄接口方法名缩窄映射（`updateOccupancy: updateContextOccupancy` / `renderLimit: renderOccupancyLimit`）。
- 状态 1 个 + 常量 2 个封装进工厂闭包；`fmtTokens` 由容器自带 import（`fmtCompactTokens` **不随域**——占用域不用它，它是指标域 renderMetrics budget 行在用，见 §四）。

### 2.2 监听器归属

本域**无监听器**（纯数据驱动），上一刀「元素归谁所有，监听器归谁」判据在本域无适用面。DOM 全即时查询，无缓存引用可移交。

## 三、接线点（chatView 侧）

1. import 增 `createContextOccupancyView`；
2. 原域位置（L5043 起）切除 198 行，留容器创建 + 一行指针注释；
3. `context_occupancy` 分支：`updateContextOccupancy(msg.occupancy)` → `occupancyView.updateOccupancy(msg.occupancy)`；
4. `chat_providers` 分支尾部：`renderOccupancyLimit(currentProviders, currentActive)` → `occupancyView.renderLimit(currentProviders, currentActive)`；
5. `fmtTokens` / `fmtCompactTokens` import **原样保留**（注入域 L6956/6958 与指标域 renderMetrics 仍在用）；
6. 两分支调用**时机与顺序零变化**（分支本身不搬，只换函数体指向）。

## 四、不提取归档（防重复论证）

| 不提取项 | 理由 |
|---|---|
| **指标域**（`metricsSignalOf` / `renderMetrics` + `metricsUnread` / `metricsSignalLatest` / `metricsSignalSeen` + `activityMetrics`） | 与活动抽屉（dock）**双向耦合 4 面**：renderMetrics 尾调 `renderActivityDetail()` + `resolveDock()`（出）；`resolveDock` 读 `activityMetrics.hidden` + `metricsUnread`（入）；`dockChip` click 清未读 + 消费信号 `metricsSignalSeen = metricsSignalLatest`（入）；`_dockExpanded` 决定信号「当场消费 vs 标未读」（入）。且 `metricsUnread` 与 `activityUnread` 是**对称未读位对**（`hasUnread = activityUnread \|\| metricsUnread`）——本质是 dock 域的状态。单独外置需双向窄接口 ≈8 面（注入 renderActivityDetail/resolveDock/isDockExpanded + 暴露 getUnread/consumeSignal），通知式解耦还会改 resolveDock 的同步读时序。**归组：随未来「活动抽屉域」（dockChip/dockPanel/resolveDock/renderActivityDetail/activityHistory/metrics 信号）同刀整体外置**——那是指标域的天然宿主。 |
| `fmtCompactTokens` | 占用域零使用（grep 实证：仅 renderMetrics budget 行 4 处）。随域搬 = 引入死依赖。 |
| `INJECTION_SEGMENT_LABELS`（原 L6858） | 注入域（injectionReceipt）常量，与占用域 `SEGMENT_LABELS` **名近义异实**（注入来源标签 ≠ 占用分段标签）。两常量互不引用，禁合并禁混淆。 |
| `ChatProviderItem` interface | chatView 消息镜像类型（`chat_providers` 分支写 `currentProviders`），renderModelPicker / 模型名展示同用。占用域只消费 2 字段，容器用窄投影类型即可，本体不随域不导出。 |
| 轮块内 metrics 事件渲染（原 L1867 / L2109） | 消费的是 `ProcessEvent`（轮事件流）不是 `metrics` 消息，属轮块渲染域财产，与指标域同名异源。 |

## 五、注释处置

- 域内 8 个符号的注释**原样随迁**（含 `setRingFill` 几何注释 / `buildOccupancyTipText` 守边界注释 / `renderOccupancySegments` HOST-S3-2 编号锚与 2026-10-18 迁移史 / `renderOccupancyLimit` 空态动机 / `updateContextOccupancy` tip 子节点警示 / `contextLimitShown` 防误清零注释）——编号锚（HOST-S3-2）在册即定案锚，原样保留。
- 切除处留一行指针注释（容器创建处），不重述模块头内容。
- 容器模块头 JSDoc：域职责 + 「UI 只渲染宿主透传数字，不重算」边界声明 + 类型同源取型说明。

## 六、验证计划

### 6.3 变异五发（预期）

| 编号 | 变异 | 预期 |
|---|---|---|
| M1 | `updateContextOccupancy` 删 `contextLimitShown = occ.totalTokens` 记录 | 红（「同一上限的 chat_providers 重复推送不重置已用数字」用例） |
| M2 | `renderOccupancyLimit` 删「上限未变跳过」守卫 | 红（同款不重置用例） |
| M3 | `setRingFill` 去 0-100 clamp | 待验证（既有用例值均在正常区间，可能 0 红） |
| M4 | `renderOccupancySegments` 段序对调（rolepack ↔ dialogue） | 红（六段构成条用例有段序与 title 断言） |
| M5 | `updateContextOccupancy` 删尾行 `renderOccupancySegments(occ)` | 红（`occSegments` 构成条用例） |

0 红 = 待验证假设（等价变异 / 既有覆盖缺口），如实登记不预补。

### 6.4 契约不变式（拆完必须仍成立）

1. 空态（chat_providers）与真实态（context_occupancy）明细**共用 `buildOccupancyTipText` 单点**（空态 = 全 0 占用 + free=total 构造），禁手写第二份拼装；
2. 「上限未变则保留已展示的真实占用」判据由 `contextLimitShown` 承载，两入口（`updateOccupancy` 记录 / `renderLimit` 比对）协同，**防面板刷新把已用数字误清零**；
3. UI 只渲染宿主透传的数字与条数，**不重算**（守内核/宿主边界）；
4. 圆环充能几何 `RING_CIRCUMFERENCE` 单点（r=16 → 周长 ≈100.53），dasharray/dashoffset 单位统一；
5. `SEGMENT_LABELS` 是 hover 明细行与构成条段 title 的**单点文案源**（两处零漂移）；
6. 构成条段序 = 五段实际占用 + 剩余（rolepack/dynamic/dialogue/input/output/free），flex-grow = token 数、flex-basis 0（宽度精确按比例）；
7. 明细文字写 `#occTipText` 文本子节点，**勿写 occTip 本身**（构成条是 tip 子节点，textContent 会连它清掉）；
8. 两消息分支调用时机与顺序零变化；`chat_providers` 分支内 `renderModelPicker()` 在前、`renderLimit` 在后的既有顺序不动。

## 七、实施完成（2026-10-21 回填）

**域外置落地**：`webview/scripts/contextOccupancyView.ts` 新建（约 250 行），5 函数零改名平移 + 1 状态（`contextLimitShown`）+ 2 常量封装闭包；类型经 `Extract<ExtensionToWebviewMessage, …>['occupancy']` 同源取型（零字段复制）；窄接口 2 面（`updateOccupancy` / `renderLimit`，providers 形参走 `{ name; limitTokens }` 窄投影）。`chatView.ts` **7378 → 7185（净降 193，闸门自报口径）**；两消息分支改窄接口调用，时机顺序零变化；`fmtTokens`/`fmtCompactTokens` import 原样保留（指标域/注入域仍在用）。

**验证数据**：`tsc --noEmit` 双配置 EXIT=0；`npx eslint` EXIT=0；目标测试 **459 passed（chatView.test + occupancyContract，测试零改动）**；宿主全量 **84 文件 / 1467 passed / 2 skipped / EXIT=0**。闸门 `max-lines` 按「只降不升」定稿 **7185**（取数口径 = 闸门自报）。

**变异实测**（§6.3 预期 → 实测）：

| 编号 | 变异 | 预期 | 实测 |
|---|---|---|---|
| M1 | `updateContextOccupancy` 删 `contextLimitShown` 记录 | 红 | **0 红 = 变异可补位 + 既有缺口**（见下） |
| M2 | `renderOccupancyLimit` 删「上限未变跳过」守卫 | 红 | **1 红**（「同一上限重复推送不重置已用数字」用例） |
| M3 | `setRingFill` 去 clamp | 待验证（可能 0 红） | **0 红 = 既有覆盖缺口**（既有用例值均在 0-100 区间，clamp 为恒真路径；越界比例无用例，迁移前同样无覆盖） |
| M4 | 构成条段序对调（rolepack ↔ dialogue） | 红 | **2 红**（段序断言） |
| M5 | `updateContextOccupancy` 删尾行构成条同步 | 红 | **2 红**（`occSegments` 用例） |

**M1 逐发剖析（0 红原因，非简单缺口）**：`contextLimitShown` 有**双写入点**（空态 `renderLimit` 写上限 / 真实态 `updateOccupancy` 写 total）。既有用例序列 providers→occupancy→providers 中，第二步变异删除后第三步的「上限未变跳过」守卫仍由空态写入的同值补位命中 ⇒ 用例照绿。M1 真正破坏的序列是「occupancy **先**到（无 providers 前置）→ 后到同上限 providers 推送 ⇒ 真实占用被误清零」——该序列无用例 = **既有覆盖缺口**（迁移前同样无覆盖），如实登记不预补。同一条防误清零判据 M1/M2 各守一半，用例只从 M2 侧可达。

**实施中发现**：M3 首版变异删 clamp 后 L67 残留 `pct` 引用（编译必红），即时修正为直用 `usedPct` 再跑——变异自身语法错误不算红。

**§6.4 不变式八条核验**：全部成立（函数体零改名平移，逻辑逐行未动；八条均为域内单点结构，平移不触）。零新增违例。

**文件清单**：新建 `hosts/memora-vscode/src/webview/scripts/contextOccupancyView.ts`；修改 `hosts/memora-vscode/src/webview/scripts/chatView.ts`（净 −193）、`hosts/memora-vscode/eslint.config.mjs`（chatView 条目 7185 + 注释更新）、`tasks/待完成任务.md`（状态行 / 体量表 / 闸门清单 / 本收据）。
