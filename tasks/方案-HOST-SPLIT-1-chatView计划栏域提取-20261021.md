# 方案-HOST-SPLIT-1-chatView计划栏域提取-20261021

> 性质：HOST-SPLIT-1 的 chatView 首刀（域外置范式立范刀）。
> 判据：收敛三件套（域边界可枚举 / 有测试兜底 / 搬出降 ≥40 行）缺一即停。
> 红线：export 面零删改 · 不补掩护 · 不把红说成假红 · 不借拆分顺便优化 · 拆文件≠拆通道 · 常量 SSOT · 运行时常量不进协议大文件。

## 一、现状分析

### 1.1 演进路径

`HOST-SPLIT-1` 第 0 步补宿主 `max-lines` 闸门 → 第 1/2/4 刀（chatPanel：文档轨迹域 / 写确认域 / ask 域）→ 第 3 刀（安全审计域）经实测否决 → P2 第 1 刀（`fileChangeView` 渲染域，1322→974）→ **本刀：chatView 首次域外置**。

### 1.2 为何 chatPanel 不再是下一个候选

`tasks/待完成任务.md` L953 已明写「建议就此收口」，原文依据：

- 剩余大块 = `consumeFlow` 529 行 / `postTurnUpdate` / `handleWebviewMessage` 分发链；
- `consumeFlow` 阶段化属**方法内拆段**，判据③（搬出后行数下降 ≥40）**从定义上不成立**——方法内拆段总行数不降，补 JSDoc 反而升；
- 该议题已归档为独立议题，不并入本条。

结论：chatPanel 硬拆 = 为拆而拆，违反收敛判据本意。

### 1.3 为何 chatView 必须换拆法（单闭包 ≠ class）

| 维度 | chatPanel（已拆三刀） | chatView（本刀对象） |
|---|---|---|
| 结构 | class（38 字段 / 151 方法） | **单个 `createChatView` 闭包 + 178 个内层函数** |
| 拆法 | 搬字段 + 搬方法 + 注入依赖 | 不能照搬：函数之间靠闭包变量**直接互访** |
| 状态 | 类字段，天然可归属 | 约 45 个 DOM 引用 + 20 个 `let` 状态，横跨全部函数 |
| 可行形态 | 协作类（`ConfirmCoordinator` / `AskCoordinator`） | **域外置工厂**（`createXxx(deps)` 返回窄接口） |

域外置已有先例，不是新造机制：

- `helpers/roundNav.ts`：`createRoundNav(messages, roundNavEl)` → 返回 `{ refresh, ... }`，view 只接线；
- `helpers/turnUiState.ts`：纯函数层（派生逻辑外置，view 只做取数→施加）。

### 1.4 域边界枚举表（判据①）

| 类别 | 内容 | 位置 |
|---|---|---|
| 函数 | `getPlanBarEl` / `removeAllPlanBoards` / `setPlanBarVisible` / `setPlanBarExpanded` / `renderPlanBar` / `renderPlanBarPanel` / `buildPlanItemList` / `renderPlanBoard` | `chatView.ts` L369-565 |
| 状态 | `planBarEl`（惰性 DOM 单例）/ `planBarExpanded` / `currentPlanItems` | L360-367 |
| 模块常量 | `PLAN_ITEM_STATUS_LABEL` | L65-70 |
| 工具函数 | `formatRelativeTime`（仅计划项日志使用） | L693-704 |
| 反向依赖（域外读本域） | ① `renderRoundBlock` 读 `currentPlanItems` 渲染任务项标签（L2085-2086）② `document` 点击监听读写 `planBarExpanded` + `getPlanBarEl`（L6938-6942）③ `document` keydown 读 `planBarExpanded`（L6949） | 3 处 |
| 外部调用点（域外写本域） | ① `handleMessage` 的 `plan_update` 分支 → `renderPlanBoard`（L6101）② `resetChatView` → `removeAllPlanBoards`（L5488） | 2 处 |
| **不随迁** | `insertBeforeBody`（L383-411）——服务 `ensureProcessFlow` / `ensureRoundBlock`，属过程流挂载域，不属计划栏 | — |

### 1.5 为何选计划栏域做首刀（四候选对比）

| 候选域 | 行数 | 自有状态 | 反向依赖 | 测试兜底 | 首刀适配度 |
|---|---|---|---|---|---|
| **计划栏域** | ~210 | **3** | **3 处（纯读/开合）** | 5 个用例 | **最优：状态最少、边界最净** |
| 历史菜单域（L6703-6956） | ~250 | 2 + 6 DOM 引用 | 与全局点击处理跨域耦合 | 有 | 中 |
| 指标/占用域（L5148-5451） | ~300 | 多个 DOM 引用 + provider 状态 | 与 `metrics` 消息分支耦合 | 有 | 中 |
| 技能/引用域（L6956-7384） | ~430 | 5 个状态 | 与 `append` / `sendMessage` 强耦合 | 有 | 高 |

选计划栏域的决定因素：**它只需 3 个状态 + 1 个窄 getter 面就能完整外置**，适合先把「域外置范式」立稳，后续域按同一模板复制。首刀不选最大的过程流渲染域（L949-2740，约 1800 行）——它共用 `currentEvents` / `flowEl` / `roundBlockEl` / `livePlanStates` 等 7+ 状态，抽它须先建渲染状态容器 = 重设计，收益/风险比最差。

## 二、目标模块设计

### 2.1 新模块 `webview/scripts/planBarView.ts`

```typescript
export interface PlanBarViewDeps { document: Document }

export interface PlanBarView {
  renderBoard(items: PlanItemDto[]): void;      // 外部唯一写入口（原 renderPlanBoard）
  removeAll(): void;                            // 原 removeAllPlanBoards
  getItems(): readonly PlanItemDto[];           // 只读快照（原 currentPlanItems 的读面）
  isExpanded(): boolean;                        // 开合态读面
  toggleExpanded(): void;                       // 头部点击切换
  collapse(): void;                             // 外部点击 / Esc 收起
  containsTarget(target: Node): boolean;        // 「点在浮层内」判定
}

export function createPlanBarView({ document }: PlanBarViewDeps): PlanBarView
```

设计要点：

1. **状态封装不外泄**：`planBarEl` / `planBarExpanded` / `currentPlanItems` 全部进工厂闭包，view 侧不再持有；
2. **DOM 惰性查询沿用原范式**：`getPlanBarEl` 的单例语义原样保留（同一 DOM 节点，避免每次 `getElementById`）；
3. **方法名零改名**（承前两刀惯例）：内部 8 个函数名一字不改，只在外层加窄接口包装，便于逐行对拍；
4. **不注入 `log`**：原域无任何失败日志调用点，不凭空加依赖面；
5. **依赖只注入 `document`**：`applyIcon` 由容器直接 import（纯渲染工具，与 `fileChangeRenderer` 导 `safeLineRange` 同理），不引入第二真理源。

### 2.2 交互监听器留在 view（零行为变更）

`planBarHead` 点击 / `document` 点击收起 / `document` keydown 收起三段监听（L6934-6952）**不搬进容器**，只把内部调用改为窄接口方法。

理由（不带伤）：

- 原实现以**匿名函数**注册且从未移除（`dispose` 只移除具名 `onDocumentClick`）。搬进容器不会改善这一点，反而会改变注册**时机与顺序**（容器在 DOM 引用区创建，监听会提前到 L360 附近）；
- `document` 上有多个 `click` 监听器（浮层收起 / 示例 chips / 折叠意图闩）。顺序变动虽不影响当前各监听器的独立判定，但属**无法用测试完全覆盖的时序面**——拆分刀不碰；
- 红线④「不借拆分顺便优化」：注册时机/顺序零变化 = 行为零变化，可用既有测试与变异验证兜底。

### 2.3 注释处置（并入本刀，按三分法）

| 位置 | 处置 | 依据 |
|---|---|---|
| 任务看板设计注释 L342-359（18 行） | **压缩为 5 行**随迁容器模块头：保留「单轨呈现 / 常驻门槛 ≥3 属展示层决策 / 与内核 `needsPlanning` 无对应关系」三点，删铺陈 | 规则 §2-B（节级文件头只留设计意图）；§2-C 保留「别义」这一真·为什么 |
| `renderPlanBoard` 内 L554-560（重复论证） | **压缩为 2 行 + 指针**（指向模块头），删与 L342-359 重复的「勿称对齐内核 / 同为 3 属巧合」整段 | 规则 §2-A「重复论证收口」——同一结论 6 行 + 5 行两处重复 |
| `renderPlanBarPanel` 单行 JSDoc | **删除**（函数体即 `panel.innerHTML = '' + appendChild(buildPlanItemList)`，名字自明） | 规则 §2-A「重述代码 / 名字自明」 |
| `renderPlanBar` 的「头行各槽位」注释 | **保留**（声明 HTML 固定 id 契约，属跨层契约） | 规则 §2-B |
| `setPlanBarExpanded` 的残留 DOM 坑注释 | **保留**（真实坑：懒构建门被残留 DOM 挡住，删了会重造） | 规则 §2-C「bug 教训」 |
| `renderRoundBlock` L2112「无 active step」 | **订正为「无 active 任务项」** | 术语锚点 §2 判定口诀：任务表语义不得用 `step`；属零行为变更的措辞订正，登记于实施发现 |

**编号锚（HOST-CTX-4 / H4 / PLAN-UI-1 等）一律保留**：它们指向台账在册条目，是可检索的定案锚；本刀不做批量正则替换（见 `comment-doc-citation-rules.md`）。仅在本域内删掉已被上方模块头覆盖的重复编号。

## 三、改动文件清单

| 文件 | 动作 |
|---|---|
| `src/webview/scripts/planBarView.ts` | **新建**（约 200 行：1 常量 + 1 工具函数 + 8 内部函数 + 窄接口） |
| `src/webview/scripts/chatView.ts` | 迁出 L65-70 / L342-367 / L369-381 / L413-565 / L693-704；新增 import 与实例创建；改 6 处调用面 |
| `eslint.config.mjs`（宿主） | `chatView.ts` 闸门 `max: 7789` → **实测自报值**（只降不升） |
| `tasks/待完成任务.md` | 状态行 + 体量表 + 闸门清单 + 收据子项 |
| 本方案文档 | §七 实施完成回填 |

**零改动**：`shared/protocol.ts`（无协议变化）、全部测试文件（预期穿透零命中）、`package.json`。

## 四、不提取的归档（防重复论证）

1. **过程流渲染域（L949-2740，约 1800 行）**：共用 `currentEvents` / `flowEl` / `roundBlockEl` / `livePlanStates` / `currentMemoryHitsByCall` 等 7+ 状态；外置须先建渲染状态容器 = 重设计，不是减肥。
2. **`handleMessage` 636 行分发链**：与 chatPanel `consumeFlow` 同性质，拆分判据③不成立，归独立议题。
3. **`insertBeforeBody`**：属过程流挂载域（被 `ensureProcessFlow` / `ensureRoundBlock` 共用），随计划栏迁出即制造第二真理源。
4. **`formatRelativeTime` 的 `Date.now()` 默认参数**：保留（已有 `now` 形参可注入，改动 = 借拆分顺便优化）。

## 五、后续演进路径（只登记，不承诺）

| 序 | 域 | 行数 | 前置风险 |
|---|---|---|---|
| 第 2 刀候选 | 历史菜单域 | ~250 | 需先拆解全局点击处理的跨域判定 |
| 第 3 刀候选 | 指标 / 上下文占用域 | ~300 | 与 `metrics` 消息分支耦合 |
| 第 4 刀候选 | 技能 / 引用域 | ~430 | 与 `append` / `sendMessage` 强耦合 |

每刀仍按三件套判定，不因「已排期」而豁免。

## 六、验证计划

### 6.1 前置基线（改码前先锁数）

- 宿主全量测试基线：84 文件 passed / EXIT=0（前刀收据）；
- `chatView.test.ts` 任务看板相关用例 5 个（L5192 describe 4 例 + L3568 常驻条隐藏 1 例）；
- 闸门自报行数：临时把 `chatView.ts` 的 `max` 置 1 跑 `npm run lint`，取「File has N lines」为刀前基线；
- tsc 双配置 / lint 先跑绿，避免把既有红当自己造成。

### 6.2 新增测试

**预期为零**：本刀全部断言经真实消息路径（`plan_update` / `resetChatView` / 点击 / Esc），不经私有面。若迁移后测试出现红，先按「穿透失效」排查（改的是测试对私有符号的引用，不是实现），不得把红说成环境假红。

### 6.3 变异验证（每发记录：动作 / 结果 / 结论）

| 编号 | 变异 | 预期 |
|---|---|---|
| M1 | `renderBoard` 的 ≥3 门槛改为 `>= 2` | 红（用例 L5200 覆盖 ≥3 才常驻） |
| M2 | `getItems()` 返回空数组 | 红（round-block 任务项标签用例 L2085 面） |
| M3 | `containsTarget` 恒 `false` | 待验证（是否有点击外部收起的用例） |
| M4 | `collapse()` 改空实现 | 红（Esc 收起用例 L5236） |
| M5 | `removeAll()` 不清 `currentPlanItems` | 待验证（resetChatView 后缓存残留是否有用例） |

**纪律**：0 红 = 待验证假设（等价变异 / 既有覆盖缺口），如实登记，不为凑红加无用测试。

### 6.4 契约不变式（拆完必须仍成立）

1. **空 plan** → 常驻条收起，且 `currentPlanItems` **不被覆写**（保持「最近一次非空 plan」语义，供 round-block 标签）；
2. **≥3 任务项**才常驻；2 个任务项不常驻（展示层自身门槛，与内核判定无对应关系）；
3. **展开态重建**：`plan_update` 到达时若浮层已展开，面板跟随最新快照重建；
4. **收起即清面板**：残留 DOM 不得挡住下次展开的懒构建；
5. **开合态与 aria/chevron 同步**：`aria-expanded` 与图标必须同源更新；
6. **外部点击 / Esc 只在展开态生效**，且不干扰输入框。

## 七、实施完成

### 7.1 验证数据（2026-10-21 实测）

| 项 | 结果 |
|---|---|
| `chatView.ts` 行数 | **7789 → 7585**（净降 204；**闸门自报**：max 临时置 1 跑 lint 得「File has too many lines (7585)」，与判定同源） |
| `planBarView.ts` | 新建 **267 行**（常量 1 + 工具函数 1 + 内部函数 8 + 窄接口 7 面） |
| `npm run typecheck` | 双配置 EXIT=0 |
| `npm run lint`（`--max-warnings 0`） | EXIT=0（新闸门 `max: 7585`） |
| 目标测试 `chatView.test.ts` | **457 passed / 与基线一致**（测试零改动） |
| 宿主全量 `npm test` | **84 文件 / 1467 passed / 2 skipped / EXIT=0**（零回归） |

### 7.2 变异实测表（逐发登记，不为凑红加测试）

| 编号 | 变异动作 | 实测 | 结论 |
|---|---|---|---|
| M1 | 常驻门槛 `>= 3` → `>= 2`（两处） | **1 红**：`plan_update <3 个任务项 → 常驻条不出现` | 门槛语义被用例钉住 |
| M2 | `getItems()` 恒返回 `[]` | **0 红** | **既有覆盖缺口**：round-block 任务项标签无断言，迁移前同样无覆盖 |
| M3 | `containsTarget` 恒 `false` | **5 红**（展开态用例连坐：头部点击后 document 冒泡立即收起） | 命中判定被展开/点击链覆盖 |
| M4 | `collapse()` 空实现 | **1 红**：`浮层展开态按 Esc 收起…` | 收起面被键盘契约用例钉住 |
| M5 | `removeAll()` 不清 `currentPlanItems` | **0 红** | **既有覆盖缺口**：resetChatView 后缓存残留无断言，迁移前同样无覆盖 |

两处缺口按「触发驱动」如实登记，不预补。

### 7.3 文件清单

| 文件 | 动作 |
|---|---|
| `src/webview/scripts/planBarView.ts` | 新建 267 行 |
| `src/webview/scripts/chatView.ts` | 7789 → 7585（迁出 8 函数 / 3 状态 / 1 常量 / 1 工具函数；接线 6 处） |
| `eslint.config.mjs` | chatView 闸门 `7789 → 7585`（只降不升） |
| `tasks/待完成任务.md` | 状态行 / 体量表 / 闸门清单 / 收据子项 |
| 测试文件 | **零改动**（§6.2 兑现：断言全走真实消息/点击/Esc 路径，不经私有面） |
| `shared/protocol.ts` | 零改动 |

### 7.4 契约不变式核验

| # | 不变式 | 核验 |
|---|---|---|
| 1 | 空 plan → 收起且不覆写缓存 | ✅ `renderPlanBoard` 早返回；缓存只在非空分支赋值 |
| 2 | ≥3 任务项才常驻 | ✅ M1 变异红，语义仍钉住 |
| 3 | 展开态 `plan_update` 重建面板 | ✅ `renderPlanBar` 尾部 `if (planBarExpanded) renderPlanBarPanel(items)` 原样保留 |
| 4 | 收起即清面板（防残留挡懒构建） | ✅ `setPlanBarExpanded(false)` 内 `panel.innerHTML = ''` 原样保留（坑注释随迁） |
| 5 | aria / chevron 同源更新 | ✅ 同一函数内 `aria-expanded` + `applyIcon` 同步 |
| 6 | 外部点击 / Esc 仅展开态生效、不干扰输入框 | ✅ 监听器位置与顺序零变化，仅调用面改为 `isExpanded` / `containsTarget` / `collapse` |

### 7.5 实施中发现

1. **术语伤订正**：`renderRoundBlock` 原注释「无 active step」把任务表语义误用 `step`，按术语锚点 §2 判定口诀订正为「无 active 任务项」（零行为变更，属规则强制项）。
2. **跨文件符号指针清算**：迁出后原文件仍有 3 处注释引用 `getPlanBarEl` / `PLAN_ITEM_STATUS_LABEL`，已改为「计划栏的惰性单例范式（`planBarView` 模块）」与「计划栏状态标签（同包枚举）」的概念指针，不留悬空符号名（comment-doc-citation-rules §3）。
3. **交互监听留 view 是正确的**：把监听搬进容器会让注册时机从 L6733 提前到 DOM 引用区，虽当前无测试可感知，但属不可完全覆盖的时序面——按红线④不碰。
4. **注释剪枝实际收益**：本域 18 行设计注释 → 5 行模块头，5 行重复论证删除，1 行名字自明注释删除；**编号锚全部保留**（台账在册即定案锚）。这印证了「剪枝并入刀内、不设 KPI」的判断：真实可减量集中在重复论证，不集中在「占比」。

