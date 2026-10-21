# 方案：HOST-SPLIT-1 P2 chatView 活动抽屉域提取（含指标域随刀）

> 序列：HOST-SPLIT-1 P2 域外置第 5 刀（chatView 第 4 刀）。先例：planBarView（第 2 刀）、historyMenuView（第 3 刀）、contextOccupancyView（第 4 刀）。
> **归组兑现**：上刀方案 §四已定案「指标域归组『活动抽屉域』同刀外置」——指标域（`metricsSignalOf`/`renderMetrics` + 三个信号状态）与活动条/时间线/未读位是**双向耦合的一体域**（上刀已实测 4 面），本刀整体外置，不再拆两刀。

## 一、域梳理

### 1.1 活动抽屉域边界枚举（本刀提取对象）

| 类别 | 符号 | 现行号 | 域外引用 |
|---|---|---|---|
| 常量 | `MAX_ACTIVITY_HISTORY` | L4607 | 零（仅域内 shift 截断用） |
| 类型 | `ActivityRecord` | L4609-4615 | 零 |
| 状态 | `activityHistory` | L4616 | **1 处**：`resolveDock` timelineReady 判据（L2771） |
| 状态 | `activityUnread` | L4629 | **1 处**：`resolveDock` hasUnread（L2773）+ `dockChip` click 清零（L2801） |
| 状态 | `metricsUnread` | L4644 | 同上两处（L2773 / L2803） |
| 状态 | `metricsSignalLatest` | L4646 | **1 处**：`dockChip` click 消费（L2803） |
| 状态 | `metricsSignalSeen` | L4648 | **1 处**：`dockChip` click 消费（L2803） |
| 状态 | `activityTimer` | L4650 | 零（showActivity 瞬态撤出计时） |
| 函数 | `renderActivityDetail` | L4660-4676 | 零（域内 2 调用：showActivity / renderMetrics） |
| 函数 | `showActivity` | L4687-4748 | **11 处**：消息分发各分支（L5387/5560/5563/5658/5732/5817/5823/5875/5877/6111/6139） |
| 函数 | `metricsSignalOf` | L4946-4955 | 零（仅 renderMetrics 用） |
| 函数 | `renderMetrics` | L4965-5043 | **1 处**：`metrics` 分支（L5585） |
| DOM | `activityBar`（引用 L216） | — | showActivity 操作 + **裁决器注册**（L2688 `registerDockEntry('activity', …)`） |
| DOM | `activityList`（引用 L223） | — | 零（仅 renderActivityDetail 用） |
| DOM | `activityMetrics`（引用 L224） | — | **1 处**：`resolveDock` timelineReady（L2771） |

- **外部依赖**：`fmtTime`（`../helpers/fmtTime.js`，showActivity ts 字段；域外另有 4 处轮块渲染用，公共 helper 双方自带 import）；`fmtCompactTokens`（renderMetrics budget 行 4 处，**域外零使用**——grep 实证 L37 import 后仅 L4995-5001，随域走后 chatView import 收窄为 `fmtTokens`）；`ExtensionToWebviewMessage`（`metrics` 分支同源取型）。
- **耦合 4 面**（上刀实测，本刀处置）：① renderMetrics 尾调 `resolveDock()`（出）→ deps `notifyDockChanged`；② resolveDock 读 timelineReady/hasUnread 判据（入）→ 窄接口 `getDockState()`；③ dockChip click 清未读 + 消费信号（入）→ 窄接口 `markDrawerOpened()`；④ `_dockExpanded` 决定「当场消费 vs 标未读」（入）→ deps `isDockExpanded()`。
- 行数：区块 A（L4601-4748，状态区 + 时间线 + showActivity）约 148 行 + 区块 B（L4931-5043，metricsSignalOf + renderMetrics）约 113 行 + DOM 引用 2 行 ≈ **263 行**（≥40 ✅）。

### 1.2 收敛判据三件套核验

① 域边界可枚举（上表 8 状态 + 4 函数 + 3 DOM，耦合 4 面逐面有窄接口承接）✅；② 测试兜底（`chatView.test.ts` 活动域用例密集：dockChip 收起态形态 / 未读判据「推过≠新闻」回归锁 / 拉开态未读消费 / 「resolveDock 按未读位强制合抽屉」变异锁 / 「P4 补审 A」审计信号守卫——全走 `dispatch({type:…})` + DOM id 查询，**零私有符号穿透**，外置对测试透明）✅；③ 搬出降 ≥40 行（净降约 245）✅。

## 二、容器设计

### 2.1 模块形态

新建 `webview/scripts/activityDrawerView.ts`（域外置工厂范式第 4 次复制）：

```typescript
export interface ActivityDrawerViewDeps {
  document: Document;
  /** #activityBar 主状态条（瞬态单条；裁决器注册与容器操作共享同一节点） */
  activityBar: HTMLElement;
  /** #activityList 抽屉时间线历史列表 */
  activityList: HTMLElement;
  /** #activityMetrics 抽屉指标块 */
  activityMetrics: HTMLElement;
  /** StatusDock 上报（窄化：本域只触 'activity' 一个 id，禁触其他条） */
  setDockActive: (id: 'activity', active: boolean) => void;
  setDockFixed: (id: 'activity', fixed: boolean) => void;
  /** resolveDock 单点重排（showActivity 入口显式刷新 / renderMetrics 尾部刷新） */
  notifyDockChanged: () => void;
  /** 折叠轴只读（决定未读「当场消费 vs 标未读」；容器不得反向写） */
  isDockExpanded: () => boolean;
}

export interface ActivityDrawerView {
  showActivity(level, text, action?, kind?): void;
  renderMetrics(msg: MetricsMessage): void;
  /** resolveDock 消费的抽屉入口判据（timelineReady / hasUnread） */
  getDockState(): { timelineReady: boolean; hasUnread: boolean };
  /** 拉开＝已读：清两个未读位 + 消费指标信号（dockChip click 拉开时调用） */
  markDrawerOpened(): void;
}
```

- **类型同源**：`Extract<ExtensionToWebviewMessage, { type: 'metrics' }>` 直接取型，不复制字段形状（上刀已立范式）。
- **deps 函数签名窄化**：`setDockActive`/`setDockFixed` 形参收 `'activity'` 字面量——本域只触自己这条；chatView 侧 `(id: DockId, …)` 签名经参数逆变天然兼容。容器**不得**知道 DOCK_PRIORITY 全表（那是裁决器域的财产）。
- **TDZ 安全**：deps 的 `setDockActive`/`resolveDock` 是函数声明（提升）；`isDockExpanded: () => _dockExpanded` 是闭包捕获（延迟求值）——容器创建行可置于 StatusDock 区块头部，语义等价、时序零变化。
- 内部函数**零改名平移**（`renderActivityDetail` / `showActivity` / `metricsSignalOf` / `renderMetrics`），状态 8 个封装进工厂闭包；`fmtTime`/`fmtCompactTokens` 由容器自带 import。
- **无新增监听器**：showActivity 的 action.onClick 是调用方注入的回调（监听器注册在域内但回调闭包属调用方——原样平移）；`window.setTimeout`/`clearTimeout` 原样随迁。

### 2.2 监听器归属

本域原有监听器仅 showActivity 内部 action 按钮 click（动态创建时注册，随域平移）。`dockChip` click **不在域内**（它是折叠轴 = 裁决器财产，历史菜单刀「同元素双监听器时序敏感」判据同理：click 回调体内三行状态清零改调 `markDrawerOpened()`，监听器本体不动）。

## 三、接线点（chatView 侧）

1. import 增 `createActivityDrawerView`，删 `fmtCompactTokens`（`fmtTokens` 保留）；
2. 容器创建置于 StatusDock 区块头部（L2611 注释块后）：`const activityDrawerView = createActivityDrawerView({ document, activityBar, activityList, activityMetrics, setDockActive, setDockFixed, notifyDockChanged: resolveDock, isDockExpanded: () => _dockExpanded })`——**必须在 `registerDockEntry('activity', …)`（L2688）之前**，保持注册时序零变化；
3. 区块 A（L4601-4748）、区块 B（L4931-5043）整体切除，原域位置各留一行指针注释；
4. L223-224 `activityList`/`activityMetrics` 引用删除（随域）；L216 `activityBar` **保留**（裁决器注册 + deps 传入，双消费面共享节点）；
5. 11 处 `showActivity(` → `activityDrawerView.showActivity(`（调用点不搬，只换前缀）；
6. `metrics` 分支 L5585 `renderMetrics(msg)` → `activityDrawerView.renderMetrics(msg)`；
7. `resolveDock` L2771-2773 三行 → 两行：`const { timelineReady, hasUnread } = activityDrawerView.getDockState();` + `const chipVisible = rest.length > 0 || timelineReady;`（L2768-2770 判据论证注释随 `getDockState` 迁容器；「不替用户合抽屉」注释留在 resolveDock——那是 `_dockExpanded` 的裁决语义）；
8. `dockChip` click 回调 L2801-2803 三行 → 一行 `activityDrawerView.markDrawerOpened();`（监听器注册时机零变化）；
9. 消息分发各分支调用**时机与顺序零变化**。

## 四、不提取归档（防重复论证）

| 不提取项 | 理由 |
|---|---|
| **StatusDock 裁决器全套**（`DOCK_PRIORITY`/`CONFIRM_PRIORITY`/`DockId`/`DockEntry`/`dockEntries`/`registerDockEntry`/`setComposerReplaced`/`setDockActive`/`setDockFixed`/`pickDockHead`/`resolveDock`/`_dockExpanded`/`dockChip` click 主体，L2611-2806） | **共享基础设施非活动域私有**：pendingQueue / fileChanges / background / confirm 四条仍消费同一裁决器，活动域只是其 5 条 entry 之一。裁决器随刀 = 窄接口必须暴露通用条目注册面，域边界从「活动条+时间线+指标」漂移成「收纳器全域」——那是另一把刀（且需等其余条外置后裁决器才可能随域收口） |
| **待发送区**（`_pendingQueueBar`/`_pendingQueueItems`/`_pendingDiscardedBuffer`/`updatePendingQueueBar`，L2808-2917） | 独立域：turn_update.pendingQueue 驱动的队列可视化（badge/list 渲染 + diff 上屏 + 满员预检投影），与活动条/时间线/指标**零语义交集**——它只是恰好挂在同一收纳器上。「挂在 dock 上的条」≠ 活动域成员。未来独立成刀（与 fileChanges/background 两同范式条归组） |
| `activityBar` DOM 引用（L216） | 双消费面共享节点：裁决器注册（L2688）+ 容器 deps。引用本体留 chatView，两边都拿到同一节点（非双源——节点只有 DOM 一个真源，引用是同一对象的两个别名） |
| `firstLine`（L4758） | 记忆域 helper：`memory_added` 事件**调用点**拼参数用（L5389），showActivity 函数体内零使用。位置紧邻活动区属相邻区块巧合，随记忆域走 |
| `updateFileChangesBar` / `updateBackgroundTasksBar` / `renderWriteConfirmCard` | StatusDock 其他挂载条（fileChanges/background/confirm 三域），同待发送区理由 |
| `fmtTime` | 公共 helper：域内 1 处 + 域外 4 处（轮块渲染），双方自带 import，无归属问题 |

## 五、注释处置

- 域内全部注释**原样随迁**：`activityUnread`「🔴 旧判据…换壳不换病」治本论证、`metricsUnread`「🔴 病根（2026-10-05 审查实锤）」、`metricsSignalOf`「🔴 血训（audit 只准 denied）+ P4 补审 A 守卫用例指针」、showActivity「P0 保护 / 排雷雷-4 / 宪法④」「入口显式刷新必须在 P0 早退判据之前」时序注释、renderActivityDetail「C1 起不再裁决任何显隐」、L4652-4654 C1 拆除史、L4601-4605 区块头「三合一」定位（并入容器模块头，不复述）。
- `resolveDock` L2768-2770「抽屉入口可达判据 + C1 闭合缺口（台账 P15 病③）」论证随 `getDockState` 迁容器；L2774-2776「不替用户合抽屉」**留 resolveDock**（折叠轴裁决语义）。
- 切除处各留一行指针注释；容器模块头 JSDoc：域职责 + 耦合 4 面承接声明 + 未读判据「信号驱动非渲染结果」边界声明。
- 编号锚（P4/P10C/P15/C1/宪法④）在册即定案锚，原样保留不清算。

## 六、验证计划

### 6.3 变异五发（预期）

| 编号 | 变异 | 预期 |
|---|---|---|
| M1 | showActivity 删 P0 早退前的 `resolveDock()` 入口显式刷新 | 红（注释点名场景「收抽屉后第二条通知到达，徽章不亮」；setter 判重 no-op 用例） |
| M2 | `markDrawerOpened` 删 `metricsSignalSeen = metricsSignalLatest` 消费行 | 红（拉开后信号未消费，未读反复亮；未读判据回归锁用例） |
| M3 | `metricsSignalOf` audit 字段改用 `total` | 红（「P4 补审 A」审计守卫条——血训注释点名的既有守卫） |
| M4 | `getDockState().timelineReady` 去掉 `!activityMetrics.hidden` 支路 | 红（首推 metrics 即让入口可达用例；若 0 红则属既有覆盖缺口，如实登记） |
| M5 | showActivity 删 P0 保护（info 覆盖 error） | 红（错误优先保护用例；若 0 红同上） |

0 红 = 待验证假设（等价变异 / 既有覆盖缺口），如实登记不预补。变异自身语法错误不算红，即时修正再跑；逐发还原后 grep「M[1-5] 变异」确认残留清零。

### 6.4 契约不变式（拆完必须仍成立）

1. 🔴 **hidden 与归位只由 resolveDock 裁决**：容器禁直写任何条目的 hidden/insertBefore，只经 `setDockActive`/`setDockFixed` 上报（ADR-037 形态宪法）；
2. 🔴 **「不替用户合抽屉」**：空态强制收起是唯一合抽屉点且在 resolveDock 内；容器对 `_dockExpanded` 只读（`isDockExpanded`），无任何反向写入面；
3. **拉开＝已读单点**：未读消费只经 `markDrawerOpened`（唯一折叠轴 dockChip click）；showActivity/renderMetrics 的现场消费只读 `isDockExpanded` 决定「当场消费 vs 标未读」，不新增消费路径；
4. **未读判据只由诊断信号驱动**（`metricsSignalOf` 五元组：fp/fail/trunc/unparsed/audit-denied），禁用「推过」「全文 diff」「`activityMetrics.hidden` 渲染结果」当事实源（2026-10-05 两轮实锤病根）；
5. **时序不变**：showActivity「入口显式刷新在 P0 早退判据之前」、error 档 8s/info 档 2.5s 撤出、error 豁免 fixed 恒主位、消息分发分支顺序、`registerDockEntry('activity', …)` 注册时机——全部零变化；
6. **DOM id 契约零变化**：activityBar/activityList/activityMetrics/dockChip/dockPanel/dockControls 六个 id 与消息分发语义不动——测试全走 DOM 查询，外置对测试透明。

## 七、实施后回填

- **切除实绩**：区块 A（原 L4601-4748，148 行）+ 区块 B（原 L4931-5043，113 行）+ DOM 引用 2 行 = 263 行切除；新增容器创建 15 行 + 原域位置指针注释 4 行 + dispose 接线改造 1 行 ⇒ **净降 243（`chatView.ts` 7185 → 6942，闸门自报口径）**；`activityDrawerView.ts` 落地 **358 物理行**。
- **闸门**：chatView max 7185 → **6942**（自报两轮：prettier 折行前实测 6939 → 格式化折行 +3 被只降不升闸门**当场拦截** → 按提交产物同源重取 6942 定稿；**闸门拦截活体验证有效**）。
- **窄接口实况（§2.1 的 4 面 → 实施为 5 面）**：实施中发现 `activityTimer` 在 chatView `dispose()` 清理清单有第 3 处使用（§1.1 域枚举漏检该符号的散布点）——编译期即红（TS2304），处置 = 窄接口加 `dispose()` 面，清理顺序零变化。**教训已入台账：域边界枚举的符号 grep 必须覆盖 dispose/清理面等初始化尾部散布点。**
- **变异实录（五发全红，零缺口）**：M1 = 1 红（「新活动重新标未读」）/ M2 = 3 红（未读判据回归锁连坐）/ M3 = 1 红（「P4 补审 A」审计守卫条）/ M4 = 4 红（首推入口可达 + 解耦用例连坐）/ M5 = 1 红（错误优先保护）。本域测试密度高于预期（§6.3 两个「若 0 红则登记」的预判均未触发）。还原后 grep「M[1-5] 变异」清零，目标测试 457 全绿。
- **验证**：tsc 双配置 EXIT=0；eslint EXIT=0；目标 457 passed（chatView.test 单文件，测试零改动）；全量 **84 文件 / 1467 passed / 2 skipped（= 基线）**。
- **口径注记**：上刀收据「目标测试 459」= chatView.test 457 + occupancyContract 2 两文件合计，非笔误；本刀无 occupancyContract 侧改动，单文件口径 457。
