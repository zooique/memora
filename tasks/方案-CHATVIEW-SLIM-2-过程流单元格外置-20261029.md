# 方案 · CHATVIEW-SLIM-2 — 过程流单元格外置（零状态批）

> 日期：2026-10-29 · 范围：`hosts/memora-vscode/src/webview/scripts/chatView.ts`（6440 行 / 闸门 6694）
> 上游：CHATVIEW-SLIM-1（已完成 · 12 纯函数迁 `helpers/processEventText.ts`，6693 → 6440）
> 台账锚点：`tasks/待完成任务.md` · **CHATVIEW-SLIM-2**（宿主轴）
> 规则依据：`progressive-refactor-rules.md` §1 触发判定 / §2.3 模式选择 / §3 方案先行 / §5.1 单轮一域 / §9 禁止事项

---

## 一、现状分析

### 1.1 演进路径

chatView 减重是同一条线的第 N 刀，前序已完成：计划栏域、历史菜单域、占用域、活动抽屉域、状态条域外置（`scripts/*View.ts`），以及 SLIM-1 的过程事件纯函数外置（`helpers/processEventText.ts`）。**域外置工厂范式**（deps 窄接口 + 域内状态私有 + `dispose`）已在 `activityDrawerView.ts` 复制 4 次，是本仓既定形态。

### 1.2 是否真需拆分（对 ARCH-4 口径）

不是「行数超标强制拆」。触发信号仍是**修改成本**：SLIM-1 后闸门余量 254/6694，下一次中等改动即触顶（IMG-8 已实证须并句腾行）。本轮不新增判据、不改阈值，只把**已经成熟、零状态依赖**的一批函数按既定范式外置。

### 1.3 审计方法与口径（本方案的数从哪来）

用 TypeScript 编译器 API 对 `chatView.ts` 做**符号级**依赖解析（`checker.getSymbolAtLocation`，非文本 grep）：
- 作用域 = `createChatView` 函数体内的顶层绑定；
- 依赖 = 每个闭包函数体内引用到的顶层绑定（区分 read / write / 成员变异 / 方法调用）；
- 传递闭包 = 沿「调用其他闭包函数」边展开；
- 读数由脚本一次产出，脚本为一次性审计工具（未入库；口径即本节描述，可复现）。

> 纪律：本方案所有数字均为**上述口径的实测值**，不取估算；与台账估算不一致处以实测为准并当场订正（见 1.5）。

### 1.4 实测数据（2026-10-29）

| 指标 | 实测 |
|---|---|
| 闭包顶层绑定总数 | **270**（`let` 52 / `const` 79 / 函数 139） |
| 17 个 let 的写者 ≥ 2（跨域共享） | 是，见 1.5 |
| `handleMessage` 单函数触达状态 | **48 个**（625 行） |
| `resetChatView` 触达状态 | 24 个（55 行） |
| `renderReplayRound` 触达状态 | 13 个（110 行） |
| `resetForNewClosedLoop` 触达状态 | 13 个（25 行） |
| 闭包函数中「传递闭包后无真实状态依赖」 | **47 个 / 937 行** |
| 其中落在过程流渲染链上 | **28 个 / 638 行** |
| `if (letName)` 窄化守卫总数（全文件） | **20 处**（`streamRenderTimer` 6 / `streamingActive` 3 / `currentSkill` 3 / 其余 8） |

### 1.5 排雷：对既有估算的三处订正

**① 「~15 个函数」口径要拆开写。**
- 过程流渲染链的状态绑定核心只有 **8 个函数 / 660 行**：`prepareFlowShell`(24) · `ensureProcessFlow`(30) · `ensureRoundBlock`(22) · `renderRoundBlock`(364) · `renderProcessFlow`(160) · `renderInterruptedRound`(25) · `renderDateDivider`(17) · `flushSkeletonPendingItems`(18)。
- 但若从这 8 个做**传递闭包**，会扩到 **50 个函数**（因为渲染收尾会调工具行、证据块、思考聚合等单元构造函数）。
- ⇒ 台账「~15 个函数整体外置」若按传递闭包执行，会把 28 个零状态函数一并绑进一个必须持有状态的模块，等于人为制造一个巨型 deps 大杂烩——正是 `HOST-SPLIT-1` 已撤回的形态（`方案-HOST-SPLIT-1-活动文件域提取` 记录的「context 大杂烩 = 转移复杂度」）。

**② 「8+ 个闭包 let」准确。**
实测这 8 个函数共触达 **10 个 let**：`flowEl` · `flowShellEl` · `roundBlockEl` · `roundBlockHostEl` · `currentEvents` · `livePlanStates` · `streamingActive` · `activeAssistantEl` · `lastShownDate` · `archivingFallbackTimer`。其中 `activeAssistantEl` 有 **19 个用户 / 7 个写点**，横跨流式渲染、提问卡、复盘、记忆命中四个面——**它不属于过程流域**，不能被这一刀顺手带走。

**③ 「先状态收口、再整体搬迁」顺序错误（本方案订正）。**
写点分布决定风险：`flowEl` 6 写、`roundBlockEl` 5 写、`activeAssistantEl` 7 写，且写点全部落在 `handleMessage`(48 状态) / `resetChatView`(24) / `resetForNewClosedLoop`(13) / `renderReplayRound`(13) 这四个最高风险函数里。先做状态收口 = 先动这四个函数。
⇒ 正确顺序反过来：**先搬 638 行零状态函数（零状态语义变化），行数余量从 254 抬到 ~890，再谈状态收口。**

### 1.6 本轮提取范围（28 函数 / 638 行 · 落 3 个模块）

判定标准：**传递闭包后，除 `document` 外不触达任何顶层绑定**（常量白名单另行标注）。

**A. 纯模型函数（无 DOM）→ `webview/helpers/processFlowModel.ts`（16 个 / 286 行）**

| 函数 | 行数 | 说明 |
|---|---|---|
| `sectionOf` | 15 | 分区判定 |
| `planItemContainerFor` | 21 | 计划项容器定位 |
| `insertPlanItemGroupInOrder` | 28 | 有序插入（纯计算目标位置） |
| `planItemStatesFromEvents` | 20 | 事件 → 计划项状态 Map |
| `thoughtLabel` | 3 | 思考块标题 |
| `groupThoughtBuckets` | 35 | 思考分桶 |
| `visibleInputTs` | 12 | 可见输入时间戳 |
| `insertPlanItemInOrder` | 23 | 有序插入 |
| `stopReasonLabel` | 8 | 终止原因文案 |
| `findRunningTool` | 16 | 运行中工具定位 |
| `toolRowStatus` | 11 | 工具行状态推导 |
| `buildSearchEvidenceResolver` | 34 | 搜索证据解析器 |
| `buildMemoryHitsEvidenceResolver` | 17 | 记忆命证解析器 |
| `decideTerminus` | 24 | 终止判定 |
| `narrateChainText` | 6 | 链式叙述文本 |
| `insertBeforeBody` | 13 | **通用 DOM 工具，跨域使用（`renderMemoryHits` 也调）→ 独立落 `helpers/insertBeforeBody.ts`** |

**B. DOM 构造函数（注入 `document`）→ `webview/scripts/processFlowCells.ts`（12 个 / 352 行）**

`getOrCreateSection`(17) · `createNarrateRow`(14) · `createAggregatedThought`(40) · `upgradePendingToolRow`(22) · `getOrCreatePlanItemGroup`(27) · `applyPlanItemStates`(23) · `refreshToolBatchSummary`(49) · `createToolBatchBlock`(16) · `renderSearchEvidenceBlock`(13) · `renderToolRow`(77) · `updateToolRowState`(38) · `appendInterruptedRow`(16)

**C. 随迁类型**：以上函数签名用到的局部 `interface` / `type`（`ToolBatch` 等）逐一定夺——只被本批函数使用者随迁并从新模块 `export`；同时被残留函数使用者，从新模块导入（**类型归属唯一**，不留两份）。

### 1.7 行数账（取闸门口径）

| 项 | 值 |
|---|---|
| chatView 现基线 | 6440（闸门 6694，余量 254） |
| 本轮迁出 | −638 |
| 新增 import / 装配行 | ≈ +12 |
| chatView 落点 | ≈ **5814**（余量 ≈ 880） |
| 闸门调整 | **不改 max**（只降不升；瘦身后可另起一笔调低） |
| 新模块与 1000 行通用闸 | 286 / 352 / 13 行，均 < 1000，**无需登记 eslint 例外** |

---

## 二、目标设计

### 2.1 纯模型模块（helpers · 无 DOM 副作用）

```ts
// webview/helpers/processFlowModel.ts
export function groupThoughtBuckets(events: ProcessEvent[]): { ... };
export function planItemStatesFromEvents(events: ProcessEvent[]): Map<string, string>;
export function decideTerminus(events: ProcessEvent[]): { ... };
// …共 15 个；全部纯函数，输入即输出
```

### 2.2 单元格工厂（scripts · 照 activityDrawerView / planBarView 形态）

```ts
// webview/scripts/processFlowCells.ts
export interface ProcessFlowCellsDeps {
  /** webview 文档对象（单元格构造唯一 DOM 入口；禁在模块内读全局 document） */
  document: Document;
}
export interface ProcessFlowCells {
  getOrCreateSection(details: HTMLElement, title: string): HTMLElement;
  createNarrateRow(ev: Extract<ProcessEvent, { type: 'narrate' }>): HTMLElement;
  renderToolRow(ev: ..., batch: ToolBatch): HTMLElement;
  // …共 12 个
}
export function createProcessFlowCells(deps: ProcessFlowCellsDeps): ProcessFlowCells;
```

**边界纪律**：
- 域内不持有任何 chatView 状态（本批全部零状态）；
- 不 query 全局 DOM，不注册事件监听，不启动定时器 ⇒ **无需 `dispose`**（这也是本批可零风险先走的原因）；
- chatView 只留**一行装配**：`const cells = createProcessFlowCells({ document });`

### 2.3 与现有模式对比

| 维度 | activityDrawerView（域容器） | processEventText（SLIM-1） | **processFlowCells（本批）** |
|---|---|---|---|
| 持状态 | 是（时间线/未读） | 否 | **否** |
| DOM 依赖 | deps 注入 ×5 节点 | 无 | **deps 注入 `document`** |
| dispose | 需要 | 不需要 | **不需要** |
| 迁出方式 | 函数 + 状态整体搬 | 纯函数搬 | **纯函数 + DOM 构造函数搬** |

---

## 三、改动文件清单

| 文件 | 变更类型 | 改动点 |
|---|---|---|
| `src/webview/scripts/chatView.ts` | 修改 | 删 28 函数 + 随迁类型；新增 3 处 import + 1 行装配；调用点改 `cells.xxx` / `model.xxx` |
| `src/webview/helpers/processFlowModel.ts` | 新增 | 15 个纯函数 + 随迁类型 |
| `src/webview/helpers/insertBeforeBody.ts` | 新增 | 通用有序插入工具 |
| `src/webview/scripts/processFlowCells.ts` | 新增 | 12 个 DOM 构造函数 + 工厂 |
| `src/webview/helpers/__tests__/processFlowModel.test.ts` | 新增 | 纯函数单测（补 model 层覆盖） |
| `src/webview/scripts/__tests__/chatView.test.ts` | 不改 | 477 行为用例作为回归基线，必须全绿 |
| `tasks/待完成任务.md` | 修改 | SLIM-2 条目状态推进 + SLIM-1 后续句改指向 |

> **不动**：`eslint.config.mjs`（新文件均 < 1000 行）、协议文件、样式文件、任何 CSS/class 名。

---

## 四、不提取归档（本轮明确不做）

| 项 | 理由 |
|---|---|
| 8 个状态绑定函数（`prepareFlowShell` / `ensureProcessFlow` / `ensureRoundBlock` / `renderRoundBlock` / `renderProcessFlow` / `renderInterruptedRound` / `renderDateDivider` / `flushSkeletonPendingItems`，660 行） | 触达 10 个共享 let；写点分布在 4 个高状态函数里 ⇒ 属批 2 |
| `activeAssistantEl` 相关（19 用户 / 7 写） | 跨 4 个域（流式 / 提问卡 / 复盘 / 记忆命中），需独立立项 |
| `handleMessage`（625 行 / 48 状态） | 判别联合 if/else 链是正确用法；拆注册表会丢 TS 窄化（HOST-SPLIT-1 已撤回同类方案） |
| 47 个可平移函数中不属于过程流链的 19 个（`copyText` / `renderPicker` / `renderQaItem` / `enhanceCodeBlocks` / `buildAssistantShell` 等） | §5.1 单轮一域：本轮只做过程流单元格；其余按自然生长触发 |
| 顺手优化（命名、抽常量、合并分支） | §9 明令禁止「搬迁夹带优化」 |
| `BATCH_SPLITTER_TYPES` 等常量归位 | 常量非状态；下一刀随 `groupToolBatches` 一起处理 |

---

## 五、后续演进路径

> ⚠️ **本节已作废（2026-10-29 批 2 开工前排雷）**：下列步骤表与批 2/批 3 划分均被实测推翻，**禁止据本节施工**。实测数据与订正路线见 **§八**。原文保留仅供追溯。

```
批 1（本方案）  28 函数 / 638 行 Zero-State 外置     → chatView ≈5814
批 2            状态所有权收口（8 函数 / 10 let）
批 3            「过程流渲染域」整体外置（此时才是台账原意）
```

**批 2 的顺序由写点数决定（升序，每步一次提交、一次门禁）**：

| 序 | 状态 | 写点 | 处置 |
|---|---|---|---|
| 1 | `archivingFallbackTimer` | 2（域内闭环） | 随域搬走，chatView `dispose` 改调模块 dispose |
| 2 | `livePlanStates` | 1（`handleMessage`） | 唯一外部写点改走 API |
| 3 | `lastShownDate` | 2（`renderDateDivider` + `resetChatView`） | 同上 |
| 4 | `currentRoundMeta` | 2（`renderReplayRound` + `handleMessage`） | 同上 |
| 5 | `flowShellEl` | 4 | 同上（含 `renderReplayRound` 回放面） |
| 6 | `roundBlockEl` / `roundBlockHostEl` | 5 / 5 | 同上 |
| 7 | `flowEl` | 6 | 同上；此步完成后域边界才成立 |
| — | `streamingActive` / `activeAssistantEl` | 4 / 7 | **不进批 2**：属流式渲染域，另立一刀 |

---

## 六、验证计划

| 门 | 判据 |
|---|---|
| 类型 | 根 `tsc --noEmit`；宿主 `tsc --noEmit`（esbuild 不查类型，必跑） |
| 静态 | 宿主 `eslint . --max-warnings 0`（须 cd 进宿主目录跑，根跑=假红） |
| 行为 | `chatView.test` 477 例全绿 + 新增 model 单测 |
| 零状态断言 | 迁移后 `grep` 原文件确认 28 个函数名零残留定义；新模块内 `grep document` 仅出现在 deps 参数与局部解构 |
| 变异验证 | 打真实渲染链（`renderToolRow` 的 class 名或状态文案改写）⇒ 红必须红在新模块消费链上；还原复绿。**禁用全 ASCII 假数据**（真形态零覆盖） |
| 行数 | chatView ≤ 5814（只减不升）；新文件 < 1000 |
| 结构 | `git show HEAD:<file> \| grep -c '^  function '` 对比，函数数减少量 == 28 |
| 文档 | 本方案第七章补「实施完成」；台账销项 |

---

## 七、实施完成（2026-10-29 当日落地）

### 7.1 实际范围（与 §1.6 预估的偏差）

预估 28 函数 / 638 行；**实际 32 函数**——多出的 4 个是依赖强制：

| 函数 | 行数 | 为何必须随迁 |
|---|---|---|
| `buildMemoryHitsBlock` / `buildMemoryHitItems` | 13 / 36 | `renderToolRow` 内命中明细直接调 `buildMemoryHitsBlock`；不随迁则需把函数当 deps 注入（弱边界），故独立成 `scripts/memoryHitsBlock.ts`，**两处消费同一实现**（工具行 + 实时记忆命中块） |
| `setCursorStatus` / `setTerminus` | 8 / 10 | `appendInterruptedRow` 调 `setTerminus`；两者是纯属性写入（不碰状态、不碰 document），独立成 `helpers/statusAttrs.ts` |

落点随之从 3 个模块变 5 个：

| 模块 | 函数 | 行 |
|---|---|---|
| `helpers/processFlowModel.ts` | 10 纯模型函数 + 4 类型（`ToolBatch`/`ToolBatchEntry`/`WebSearchEvidence`/`MemoryHitEntry`） | 331 |
| `helpers/statusAttrs.ts` | 2（`setCursorStatus`/`setTerminus`）+ 2 类型（`CursorStatus`/`TerminusKind`） | 69 |
| `helpers/insertBeforeBody.ts` | 1 | 37 |
| `scripts/memoryHitsBlock.ts` | 2（工厂 `createMemoryHitsBlock({document, vscode})` → `buildItems`/`buildBlock`） | 114 |
| `scripts/processFlowCells.ts` | 12 工厂方法 + 5 模块级工具（工厂 `createProcessFlowCells({document, memoryHits})`） | 693 |

### 7.2 验证结果（实测数据）

| 门 | 结果 |
|---|---|
| 宿主 `tsc --noEmit` | 0 错误 |
| 根 `tsc --noEmit` | 0 错误 |
| 宿主 `eslint . --max-warnings 0` | 0 错 0 警 |
| 宿主全量 vitest | **123 文件 / 2203 passed / 4 skipped** 全绿 |
| `chatView.test` 行为用例 | **482 passed**（基线 477 → 482，非本刀新增） |
| 新增单测 | `helpers/__tests__/processFlowModel.test.ts` **16 例**（四档状态 / 终止三分支 / 分桶键 / 计划项状态 / 证据主配与回退游标） |
| 行数（闸门自报口径） | chatView **6440 → 5434**；`max-lines` 6694 → **5434**（只降不升，已同步 eslint.config） |
| 新文件行数 | 331 / 69 / 37 / 693 / 114，均 < 1000 通用闸 ⇒ 无需登记例外 |
| 结构核对 | chatView 闭包函数 **139 → 107**（−32，与迁移数相等）；32 个函数零残留定义 |
| **逐字比对** | 32 个函数按 AST 切片 + 去缩进归一后比对 HEAD 原文：**31/32 完全一致**；唯一差异 = `renderToolRow` 内 `buildMemoryHitsBlock(memHits)` → `memoryHits.buildBlock(memHits)`（有意改写，方案 §2.2 已声明） |
| 变异验证 | 目标：`renderToolRow` 状态标签 `(成功)` → `[成功]`。结果：**6 处断言当场红**，全部落在 `processFlowCells` 新消费链（`expected '读取文件 [成功]' to be '读取文件 (成功)'` 等），还原复绿 |
| 台账门禁 | `verify:ledger-hygiene` 十类绿 / `verify:ledger-fold` 净丢失 0 |

**变异口径留痕（踩坑记录）**：首次变异选 `round-block__tool` 类名改写，导致大量用例走等待超时（14 分钟未收敛）——红是红，但失去「红在判据上」的可观测性。**判据改进**：变异靶点须选**断言直接消费的文案值**，不选**选择器依赖的类名**（后者把断言失败变成超时，成本爆炸且定位困难）。

### 7.3 实际修改文件清单

| 文件 | 类型 |
|---|---|
| `src/webview/scripts/chatView.ts` | 修改（−1006 行 / +约 70 行：导入 + 装配 + `cells.` 调用点 30 处） |
| `src/webview/helpers/processFlowModel.ts` | 新增 |
| `src/webview/helpers/statusAttrs.ts` | 新增 |
| `src/webview/helpers/insertBeforeBody.ts` | 新增 |
| `src/webview/scripts/memoryHitsBlock.ts` | 新增 |
| `src/webview/scripts/processFlowCells.ts` | 新增 |
| `src/webview/helpers/__tests__/processFlowModel.test.ts` | 新增（16 例） |
| `eslint.config.mjs` | 修改（chatView max-lines 6694 → 5434，注释补「过程流单元格域已外置」） |

### 7.4 额外发现（登记不修，按 §9「禁夹带」）

`decideTerminus` 在**无 error / aborted 事件**的兜底分支返回 `reason: 'interrupted'`（裸英文）——`stopReasonLabel({reason:'interrupted'})` 无 `stopReason` 时直接回落 `reason` 原文，而 `appendInterruptedRow` 会把它渲染进中断行。属**既有行为**（非本刀引入），已在台账登记观察项，本刀只按现状锁定（单测如实断言 `'interrupted'`），不顺手改文案。

### 7.5 后续

批 2 = 状态所有权收口（8 函数 / 10 个 let，按写点升序），见 §五。**本轮未动任何状态**，故批 2 可独立开工、独立回滚。

---

## 八、批 2 排雷与路线订正（2026-10-29 开工前）

> 性质：**§五 的步骤表作废**，本节为实测替代。原文保留不删（可追溯），但不得再据 §五 施工。

### 8.1 排雷方法与一处工具 bug 订正

口径同 §1.3（TypeScript 编译器 API，`checker` 级符号解析）。**首轮脚本有判定 bug**：把 `currentRoundMeta?.role || x` 这类「可选链 + 逻辑或」误判为成员赋值，导致 `currentRoundMeta` / `livePlanStates` / `currentEvents` 的写点被虚增、读点被吞。修正判据 = 成员赋值必须校验 `operatorToken` 属赋值运算符族；修正后数据见 8.2。

> 教训（与 §7.2 变异口径同类）：**盘账工具本身也要验**。首轮「4 写 0 读」的僵尸状态假象，来源是脚本 bug 而非代码事实——若据此下结论即造伤。

### 8.2 实测：10 个目标状态的真实读写面

`in` = §1.5 的 8 个状态绑定函数；`out` = 其余全部闭包函数。计数单位 = 标识符出现次数。

| 状态 | 读in | 读out | 写in | 写out | 触达函数 | 判定 |
|---|---|---|---|---|---|---|
| `flowEl` | 6 | 6 | 2 | 7 | 8 | 双向耦合 |
| `flowShellEl` | 0 | 3 | 2 | 7 | 4 | 双向耦合 |
| `roundBlockEl` | 4 | 15 | 4 | 5 | 10 | 双向耦合 |
| `roundBlockHostEl` | 1 | **0** | 2 | 3 | 5 | **单向可转让** |
| `currentEvents` | 7 | 9 | 1 | 5 | 11 | 双向耦合 |
| `livePlanStates` | 2 | 1 | **0** | 4 | 2 | 双向（域内只读） |
| `streamingActive` | 1 | 5 | 0 | 9 | 6 | **非本域** |
| `activeAssistantEl` | 3 | 21 | 3 | 15 | 19 | 双向耦合 |
| `lastShownDate` | 1 | **0** | 1 | 1 | 2 | **单向可转让** |
| `archivingFallbackTimer` | **0** | 4 | **0** | 3 | 3 | **非本域（域内零触达）** |
| `skeletonPendingItems` | 2 | **0** | 1 | 3 | 4 | **单向可转让** |
| `currentRoundMeta` | 0 | 2 | 0 | 2 | 3 | 非本域 |
| `streamBodyRendered` | 0 | 1 | 1 | 5 | 6 | 双向耦合 |

合计：域内写 **18** 次，域外写 **50** 次。**状态的支配方在域外**。

### 8.3 四条推翻结论

**① §五 步骤表的数字全部与实测不符**（不是小偏差，是系统性估算混入）：

| 状态 | §五 记 | 实测 | 偏差 |
|---|---|---|---|
| `flowEl` | 6 写 | **9** 写（域外 7） | 少记 3 |
| `flowShellEl` | 4 写 | **9** 写（域外 7） | 少记 5 |
| `roundBlockEl` | 5 写 | **9** 写（域外 5） | 少记 4 |
| `roundBlockHostEl` | 5 写 | **5** 写（域外 3） | 数字巧合、分布错 |
| `livePlanStates` | 1 写（`handleMessage`） | **4** 写（域内 0） | 少记 3，且方向错 |
| `activeAssistantEl` | 7 写 | **18** 写（域外 15） | 少记 11 |
| `archivingFallbackTimer` | 2 写（「域内闭环」） | **3** 写，**域内 0 触达** | 判定错 |
| `lastShownDate` | 2 写 | 2 写 | ✅ 唯一吻合 |

§1.3 自订「所有数字均为实测值，不取估算」——§五 违反了自己的纪律。**这是本轮最重要的流程教训：方案的「后续章节」最容易退化成拍脑袋估算，因为写的时候注意力在已完成部分。**

**② 两个状态不属于本域，§五 判错。** `archivingFallbackTimer` 在 8 个函数内**零读零写**，全部生命周期在 `clearArchivingFallback` / `scheduleArchivingFallback` / `dispose`；`streamingActive` 域内仅 1 处只读、域外 9 写。二者是「被渲染函数顺手读了一眼的邻居状态」，不是过程流私有状态。

**③ 「收口」中间态不产生任何所有权变化。** 把 `let x` 改成 `state.x` 后，`state` 仍是同一个闭包里的变量，读写方一个没变——只是换了访问路径，且每处 `state.` 前缀净增字符、不减行。付出 7 笔提交 + 7 次全量门禁（每轮 2203 用例）换零结构收益。

**④ 真正的所有权转让必须「状态 + 读写它的函数」同批搬走，而这条路被现有判据挡住。** 搬走 8 函数需注入：`document` · `messages` · `cells` · `planBar` + 7 个回调（`buildAssistantShell` / `groupToolBatches` / `updateEmptyState` / `renderQaItem` / `syncRunningCursor` / `ensureRoundGroup` / `openForUserVisibility`）+ 4 个跨界状态通道（`activeAssistantEl` / `streamingActive` / `streamBodyRendered` / `livePlanStates`）= **15 项 deps**。本仓既定判据（`方案-HOST-SPLIT-1-fileChangeView渲染域提取` §不提取归档）：「至少 5 个回调注入 = 大杂烩（转移复杂度而非消解）」；`方案-HOST-SPLIT-1-活动文件域提取` 记录 `handleMessage` 拆注册表撤回的先例同理（178 成员 context）。**15 > 5，判死。**

### 8.4 路线订正

```
批 2  状态所有权收口（8 函数 / 10 let）        → ❌ 终止（中间态零收益 + 5/7 状态双向）
批 3  过程流渲染域整体外置（台账原意）        → ❌ 终止（deps 15 项 > 本仓大杂烩判据 5 项）
```

台账 CHATVIEW-SLIM-1 的原始表述「渲染+状态函数区整体外置」，**在盘账两轮后正式判死**——它不是被推迟，是被证伪。渲染区是 chatView 的核心而非外围，其状态所有权天然在 `handleMessage` / `resetChatView` / `renderReplayRound` 手里。

### 8.5 实测替代路径：零状态收尾批（SLIM-3 候选）

以「传递闭包后不触达任何 `let`」为判据重盘，剩余 **28 个函数 / 445 行**（SLIM-2 已消耗 32 个）。按功能域分组与 deps 面宽度：

| 组 | 函数 | 行 | deps 面 |
|---|---|---|---|
| 选择器 / 问答 | `renderPicker` 51 · `renderQaItem` 40 | 91 | 仅 `document` |
| 工具批 / 工具行 | `groupToolBatches` 46 · `attachMemoryHitsToToolRow` 20 · `roundChainText` 13 · `findToolRow` 6 · `dropStalePendingToolRows` 3 | 88 | 常量 + `messages` + `memoryHitsBlock` |
| 活动区 / 徽章 | `createTeamMeetingIcon` 29 · `updateCapabilityBadge` 22 · `applyButtonSemantics` 18 · `pickDockHead` 7 · `registerDockEntry` 3 | 79 | DOM 节点引用 + 常量 |
| 其他 | `ensureRoundGroupFooter` 34 · `renderInjectionReceipt` 17 · `hideInjectionReceipt` 5 · `openForUserVisibility` 5 | 61 | `document` / `vscode` / 节点 |
| 输入框 / 编辑器 | `clampUserBubble` 20 · `setComposerReplaced` 10 · `copyText` 10 · `ensureUserInputVisible` 7 · `autoResize` 7 | 54 | `document` / `messages` / 节点 |
| 代码块 / 文本 | `enhanceCodeBlocks` 27 · `firstLine` 5 · `refDisplayName` 4 · `formatTokensShort` 3 | 39 | `document` |
| 空态 | `updateEmptyStateOnboarding` 17 · `renderEmptySuggestions` 13 · `updateEmptyState` 3 | 33 | 空态节点 ×4 + `document` / `vscode` |

**推荐首刀 = 选择器 / 问答组（91 行，仅 `document` 依赖）**：与 SLIM-2 完全同型（零状态 + deps 单字段注入），零新增判据，可复用已验证的搬迁与验证流程。全量做完 chatView 5434 → ≈4989，闸门可再降。

### 8.6 本轮未做（登记不改）

- §五 原表**不删**（留作流程教训的可追溯证据），仅标作废。
- 三个「单向可转让」状态（`roundBlockHostEl` / `lastShownDate` / `skeletonPendingItems`）**未动**：它们单独转让必须连带搬走 `ensureRoundBlock` / `renderDateDivider` / `flushSkeletonPendingItems`，而 `ensureRoundBlock` 被 364 行的 `renderRoundBlock` 依赖、`renderInterruptedRound` 又依赖 `renderRoundBlock` ⇒ 首刀会把 660 行链条重新卷进来。此路属「正收益但成本高于收尾批」，待 SLIM-3 完成后行数余量充足再评估。

### 8.7 订正：§8.5 的分组不是「域」，是「行数分箱」（2026-10-29 第三刀开工前实测）

第三刀开工前按「单轮一域」（规则 §5.1）复核 §8.5 那张表的**分组依据**，结论是它按行数凑出一组、按名字凑了一组，与功能域无关。三处实证：

| §8.5 分组 | 成员实际归属 | 判据 |
|---|---|---|
| 活动区 / 徽章（79 行） | **三个域** | ① `createTeamMeetingIcon` + `updateCapabilityBadge` = 真徽章行域（同写 `#currentRoleBadge` 所在行）；② `applyButtonSemantics` 是「按钮语义 derive/apply 对」的 apply 半边（derive 在 `helpers/turnUiState.ts`），其域是 composer 状态呈现；③ `registerDockEntry` + `pickDockHead` 是 dock 裁决域，而裁决主体 `resolveDock` 留在 chatView ⇒ 单拆这两个 = **同一域摊到两个文件**，比不拆更差 |
| 代码块 / 文本（39 行） | **四个域** | `enhanceCodeBlocks`（代码块增强）与 `firstLine`（叙述行截断，消费者在 `narrate` 分支）、`refDisplayName`（引用芯片名）、`formatTokensShort`（占用徽章 token 数）不同域，只是都是「文本处理」 |
| 其他（61 行） | 混合 | `ensureRoundGroupFooter` 属轮容器、`renderInjectionReceipt`/`hideInjectionReceipt` 属注入回执、`openForUserVisibility` 属可达性 ⇒ 无共同域 |

**因此本轮只执行其中真正内聚的一域（徽章行 51 行），不按 79 行整组搬。** 反过来说，若照 §8.5 原表把五个函数装进 `activityAreaView.ts` 一个模块，就造出一个以「都在活动区附近」为理由的杂物抽屉——这正是 `方案-HOST-SPLIT-1` 撤回时判死的那种形态（转移复杂度，不减少耦合）。

**结论（对后续刀的影响）**：§8.5 那张表的剩余组**不可按组施工**，须先按域重分。真实剩余域见 §11.6。

---

## 九、SLIM-3 首刀实施收据（2026-10-29 同日）

> 设计依据 = §8.5（已先行给出判据、分组与推荐首刀）；本节只补实施数据。**时序如实记录**：条款随实施同日补写，非事后编造范围。

### 9.1 实施范围（与 §8.5 预估零偏差）

| 函数 | 行 | 落点 | deps |
|---|---|---|---|
| `renderPicker` | 51 | `scripts/pickerView.ts` · `createPickerView({ document })` | `document` |
| `renderQaItem` | 40 | `scripts/qaRowView.ts` · `createQaRowView({ document })` | `document` |
| 随迁类型 `PickerItem` | 5 | `pickerView.ts` 导出（chatView 零残留引用） | — |

两模块均无定时器、无监听 ⇒ **无 `dispose`**，与 `processFlowCells` 同一形态宪法。

### 9.2 验证结果（实测）

| 门 | 结果 |
|---|---|
| 宿主 `tsc --noEmit` | 0 错误 |
| 根 `tsc --noEmit` | 0 错误 |
| 宿主 `eslint . --max-warnings 0` | 0 错 0 警（真实退出码 0，未接管道） |
| 宿主全量 vitest | **123 文件 / 2203 passed / 4 skipped**（与 SLIM-2 基线一致） |
| `chatView.test` | **482 passed** |
| 行数（闸门自报口径） | chatView **5434 → 5333**；`max-lines` 同步 5434 → **5333**（只降不升） |
| 新文件行数 | 97 / 75，均 < 1000 通用闸 ⇒ 无例外登记 |
| 逐字比对 | `renderPicker` 51/51、`renderQaItem` 40/40 **完全一致**（AST 切片 + 去缩进归一 vs HEAD）；chatView 内零残留定义 |
| 变异验证 | 靶点 = `renderQaItem` 标签文案 `'你答'` → `'你答MUT'`；**6 处 `AssertionError` 当场红**，签名原文 `expected '你答MUT' to be '你答'` 与 `expected '耗时 3s · 你答MUT×1' to contain '你答×1'`，全部落在 `qaRowView` 新消费链；还原复绿（482 passed） |

### 9.3 实际修改文件清单

| 文件 | 类型 |
|---|---|
| `src/webview/scripts/chatView.ts` | 修改（−107 行 / +5 行：2 导入 + 1 注释 + 2 装配；3 处调用点改 `pickerView.` / `qaRowView.`） |
| `src/webview/scripts/pickerView.ts` | 新增（97 行） |
| `src/webview/scripts/qaRowView.ts` | 新增（75 行） |
| `eslint.config.mjs` | 修改（chatView max-lines 5434 → 5333，注释补两域） |

### 9.4 后续

零状态收尾批余下 6 组 / **354 行**（工具批 88 · 活动区 79 · 其他 61 · 输入框 54 · 代码块 39 · 空态 33），全量做完 chatView ≈ **4979**。按 §5.1 单轮一域，逐组独立开工。

---

## 十、SLIM-3 第二刀实施收据（2026-10-29 同日）

> 设计依据 = §8.5「工具批 / 工具行」组，但**范围经 TS 符号级重盘后修订**（§10.4 记偏差）。实施前先重盘，未沿用 §8.5 的旧数字——首刀已把 chatView 从 5434 降到 5333，行号与集合均已漂移。

### 10.1 实施范围（重盘后）

| 函数 | 代码行 | 落点 | deps |
|---|---|---|---|
| `groupToolBatches` | 46 | `helpers/processFlowModel.ts` | 无（纯函数；消费随迁常量） |
| 随迁常量 `BATCH_SPLITTER_TYPES` | 7 | 同上（导出，`processFlowModel` 内唯一声明） | — |
| `findToolRow` | 6 | `scripts/toolRowView.ts` · `createToolRowView(deps)` | `messages` |
| `attachMemoryHitsToToolRow` → 方法名 `attachMemoryHits` | 20 | 同上 | `document` · `memoryHits` · `memoryHitsByCall` |
| `dropStalePendingToolRows` | 3 | 同上 | `messages` |

`toolRowView` 无定时器、无监听 ⇒ **无 `dispose`**，与 `processFlowCells` / `pickerView` 同一形态宪法。

### 10.2 唯一的架构判断：`currentMemoryHitsByCall` 怎么给

重盘发现本组**并非全零状态**：`attachMemoryHitsToToolRow` 的传递闭包触达 `currentMemoryHitsByCall`（可变 Map）。裁决依据是**读写方向**而非「是否可变」：

| 面 | 实测 |
|---|---|
| 写点（`clear` / `set`） | **6 处，全在 chatView**（新轮复位 ×2、中断 ×1、记忆事件 ×3） |
| 读点（`get` / 迭代） | **2 处**，其中 1 处即本刀目标 |
| 方向 | 域外写、域内读 = **单向** ⇒ 注入引用即可，**不需要回调** |
| 回调计数 | **0 项**，远低于本仓判据「回调注入 ≥5 = 大杂烩（转移复杂度）」 |

为保函数体**逐字零改写**，模块内不重命名该变量，改用别名并注明所有权：

```
const currentMemoryHitsByCall = deps.memoryHitsByCall;  // 所有权仍在 chatView，本模块只读消费
const memoryHitsBlock = deps.memoryHits;
```

> 取舍说明：改名会带来 2 处函数体改写（`memoryHits.buildBlock` / `memoryHitsByCall.get`），换来的是「命名即真相」。本刀选**零改写**，把「所有权」交给注释与 deps 接口声明承载——因为搬迁批的第一承诺是行为等价，命名优化属后续可独立评估的项。

### 10.3 验证结果（实测）

| 门 | 结果 |
|---|---|
| 宿主 `tsc --noEmit` | 0 错误 |
| 根 `tsc --noEmit` | 0 错误（真实退出码 0） |
| 宿主 `eslint . --max-warnings 0` | 0 错 0 警（真实退出码 0，未接管道） |
| 宿主全量 vitest | **123 文件 / 2210 passed / 4 skipped**（基线 2203 + 本刀新增 7 例 model 单测） |
| `chatView.test` | **482 passed** |
| 行数（闸门自报口径） | chatView **5333 → 5207**；`max-lines` 同步 5333 → **5207**（只降不升） |
| 新文件行数 | `toolRowView.ts` 114 · `processFlowModel.ts` 331 → 418，均 < 1000 通用闸 ⇒ 无例外登记 |
| 逐字比对 | **5/5 完全一致**（`groupToolBatches` / `findToolRow` / `attachMemoryHitsToToolRow`→`attachMemoryHits` / `dropStalePendingToolRows` / `BATCH_SPLITTER_TYPES`；AST 切片 + 去缩进 + 去 `export` + 声明行改名归一 vs HEAD）；chatView 内零残留定义 |
| 变异 ①（实时挂载链） | 靶点 = `toolRowView` 徽章文案 `记忆 ${hits.size}` → `记忆 ${hits.size}条`；**2 处 `AssertionError`**，签名原文 `expected '记忆 2条' to be '记忆 2'`，落在实时命中消费链；还原复绿 |
| 变异 ②（判据白名单） | 靶点 = `BATCH_SPLITTER_TYPES` 移除 `'narrate'`；model 单测 **2 红**（`expected [ 2 ] to deeply equal [ 1, 1 ]`）+ 渲染链 **3 类红**（`expected [ '2', '5' ] to deeply equal [ '2', '3', '5', '6' ]` 等）；还原复绿 |

变异 ① 的**分层信息**值得记：`renderToolRow`（`processFlowCells`）另有一处同形徽章文案，故 2 例红而非全红——这不是覆盖不足，而是「实时挂载」与「finalize 重建」两条链各有断言，正好证明变异命中的是**新外置的实时链**而非旧的同形代码。

### 10.4 与 §8.5 的偏差（如实登记）

| 项 | §8.5 预估 | 实测 | 处置 |
|---|---|---|---|
| 组规模 | 工具批 88 行 | 本刀搬走 **75 行**，`roundChainText`（13 行）**未搬** | 见下 |
| `roundChainText` 落点 | 归工具批组 | 它是「轮容器整链文本」（读 `previousElementSibling` + `.msg.assistant`），与「工具行」域不同；与 `copyText`（同属复制按钮链路）同域 | **移入「轮容器 / 复制」组**，与 `copyText` 一并处置 |
| 成员状态性 | deps 面 = 常量 + `messages` + `memoryHitsBlock` | 另需 `currentMemoryHitsByCall`（§8.5 未列出，重盘发现） | 按 §10.2 单向注入，不构成判据突破 |

**为什么未搬 `roundChainText`**：本刀划界的判据是「一次搬迁只搬一个语义域」。把它塞进 `toolRowView` 会让该模块同时承担「工具行动作」与「轮容器读取」两职；它又无 `dispose`/无状态，单独为 13 行开文件不值。归入 `copyText` 那组是唯一的干净解。

### 10.5 新增单测（非夹带，落点完整性要求）

`groupToolBatches` 是本刀唯一进入 `helpers/` 的**判据真源**，而 `processFlowModel.test.ts` 对同模块其余 10 个导出函数**均有直接单测**，唯它此前只在 `chatView.test` 里被间接覆盖。搬迁后不补 = 该模块「每个导出函数都有直接守护」的惯例被打破。新增 **7 例**：批量合并与 `segId` / 打断物断段 / 步切换断段与同 step 不断 / `stepIndex` 缺省回落 / 边界桶断段 / 结果晚到仍按 `toolCallId` 归位 / 空流。

> 施工中一次**测试自身**的错误必须记录：首版「跨问答卡断段」用例把边界 ts 设成与第二条工具同值，而判据是 `b < ts`（严格小于）⇒ 该用例期望 2 批实得 1 批。**这是用例数据构造错，不是代码错**——已改测试不改判据。若当时反向「修代码」，就是把正确判据改坏。

### 10.6 实际修改文件清单

| 文件 | 类型 |
|---|---|
| `src/webview/scripts/chatView.ts` | 修改（−168 / +17：导入 2 + 装配 7 + 注释 2 + 调用点前缀 5 + 删未用类型 1） |
| `src/webview/scripts/toolRowView.ts` | **新增**（114 行） |
| `src/webview/helpers/processFlowModel.ts` | 修改（+87：常量 28 + 函数 59） |
| `src/webview/helpers/__tests__/processFlowModel.test.ts` | 修改（+54，7 例） |
| `src/webview/__tests__/chatView.test.ts` | 修改（1 行注释：`BATCH_SPLITTER_TYPES` 唯一声明位置指路） |
| `src/webview/scripts/memoryHitsBlock.ts` | 修改（1 行注释：消费者名 `attachMemoryHitsToToolRow` → `toolRowView.attachMemoryHits`） |
| `eslint.config.mjs` | 修改（chatView max-lines 5333 → 5207，注释补一域） |

### 10.7 余量

零状态收尾批余下 **279 行 / 5 组**：活动区 79 · 输入框 54 · 代码块 39 · 空态 33 · 其他 74（原 61 + 转入的 `roundChainText` 13）。全量做完 chatView ≈ **4928**。

## 十一、SLIM-3 第三刀实施收据（2026-10-29 同日）

> 设计依据 = §8.5（经 §8.7 订正后只取其内聚子域）。本节只补实施数据。

### 11.1 实施范围（51 行 · 1 个模块）

| 函数 | 行 | 落点 |
|---|---|---|
| `createTeamMeetingIcon` | 29 | `scripts/roleBadgeView.ts`（**新增** 108 行） |
| `updateCapabilityBadge` | 22 | 同上 |
| `RoleBadgeViewDeps` / `RoleBadgeView` | — | 同上（窄接口，2 字段 + 2 方法） |

deps = `{ document, roleBadge, capabilityBadge }`：**回调 0 项**，三个字段全是只读引用（两个 DOM 节点身份由 chatView 持有）。无定时器、无全局监听（唯一监听挂在 `createTeamMeetingIcon` 新建的按钮自身上，随元素回收）⇒ **无 `dispose`**。

**为什么只搬「造」不搬「管」**：单例管理器 `updateTeamMeetingIcon` 读 `let teamMeetingIcon` 与 `let currentActiveTeam`（域外写 50 次），是状态主人，留在 chatView；本模块只负责造元素与更新文案。这与 SLIM-2「状态留原处、构造外移」同一分工。

### 11.2 唯一的架构判断：同组另外 28 行为何不搬

见 §8.7。`applyButtonSemantics`（18）与 `registerDockEntry`(3)+`pickDockHead`(7) 各自属于别处的域；硬凑进 `roleBadgeView` 会造杂物抽屉，硬凑成 `activityAreaView` 同理。**宁可少搬 28 行，不造一个需要下次再拆的模块。**

### 11.3 验证结果（实测）

| 项 | 结果 |
|---|---|
| chatView 行数 | 5207 → **5143**（闸门自报口径，−64 = 51 代码 + 13 JSDoc − 3 接线增量 + 空行合并） |
| `max-lines` | 5207 → **5143**（只降不升） |
| 逐字保真 | `createTeamMeetingIcon` **29/29**、`updateCapabilityBadge` **22/22** 逐行一致（零改写） |
| 根 `tsc --noEmit` | 0 错（真实退出码 0） |
| 宿主 `tsc --noEmit` | 0 错 |
| 宿主 `eslint . --max-warnings 0` | 0 警（真实退出码 0，未接管道） |
| `chatView.test` | **482 passed** |
| 宿主全量 | **123 文件 / 2210 passed / 4 skipped** |
| 变异 | `PREFIX '小组会议：'` → `'小组会议MUT：'` ⇒ 红在新模块消费链，签名 `expected '小组会议MUT：讨论选题' to be '小组会议：讨论选题'`；还原复绿（482 passed） |

### 11.4 观察项（登记不修）

- **CAPB-1（新发现，非本轮引入）**：`updateCapabilityBadge` **零断言覆盖**。夹具 `chatViewTestEnv.ts` 与生产 `chatPanel.ts` 都有 `#currentCapabilityBadge` 节点（骨架三方一致性守卫覆盖了 id 存在性），但**没有任何用例 dispatch `capability_badge` 或断言其文案 / title / hidden**。这属 UI-CONFIRM-P6 注释里点名的那类静默失测（节点存在、链路可执行、断言缺失）。本轮搬迁为纯 DOM 赋值 + 空值守卫，行为等价不受影响；补测另立条目，不在搬迁夹带。
- `createTeamMeetingIcon` 的 `roleBadge!` 非空断言保留原样：调用链保证有队伍时才有徽章，改断言属行为变更，不动。

### 11.5 实际修改文件清单

| 文件 | 类型 |
|---|---|
| `src/webview/scripts/chatView.ts` | 修改（−64 / +3：导入 1 + 装配注释 1 + 装配 1） |
| `src/webview/scripts/roleBadgeView.ts` | **新增**（108 行） |
| `eslint.config.mjs` | 修改（chatView max-lines 5207 → 5143，注释补一域） |

### 11.6 余量（按「真实域」重分，不再按 §8.5 行数分箱）

零状态散点余下 **228 行**，但**能独立成域的只有三块**：

| 真实域 | 成员 | 行 | 可行性 |
|---|---|---|---|
| composer 状态呈现 | `applyButtonSemantics` 18 · `setComposerReplaced` 10 · `ensureUserInputVisible` 7 · `autoResize` 7 · `clampUserBubble` 20 | 62 | 需重盘：`setComposerReplaced` 写 `inputWrap`，且注释锁「只由 resolveDock 调用」⇒ 与 dock 域有单向耦合，须先验 |
| 代码块增强 | `enhanceCodeBlocks` 27（+ 可能的 `firstLine` 若仅它用——实测否，`firstLine` 服务于 narrate 行） | 27 | 单函数成域，收益低于开模块成本 |
| 空态呈现 | `updateEmptyStateOnboarding` 17 · `renderEmptySuggestions` 13 · `updateEmptyState` 3 | 33 | 需 4 个空态节点注入 |

**不可成域（禁拆）**：`registerDockEntry` / `pickDockHead`（dock 域主体留守）、`ensureRoundGroupFooter`（轮容器）、`renderInjectionReceipt` / `hideInjectionReceipt`（注入回执，与 `currentInjections` 状态绑定）、`firstLine` / `refDisplayName` / `formatTokensShort`（各只有一个消费者，纯文本工具，拆出即「为一个调用点开文件」）。

**判断**：chatView 减重已进入收益递减区。剩下的每一刀都在 30–60 行量级，而每刀固定成本（重盘 + 全量 2210 例 + 变异 + 收据）不变。建议：**除非触到具体改动需要腾行，不再为「减行数」单开刀**；按规则 §5.1「后续轮次按自然生长触发」，把余量留给真正要改那块代码时顺手带走。

---

## 附 · 台账登记说明

- 新条目 **CHATVIEW-SLIM-2** 登记于 `### 宿主轴`（本项属宿主）。
- **发现（不顺手修，登记待拍板）**：上游 **CHATVIEW-SLIM-1 现登记在 `### 内核轴`**（`tasks/待完成任务.md` 观察区第一子轴），与其宿主属性不符；同一减重线的两刀分居两轴会让后续查找断链。是否迁移由下一轮台账治理统一处理，本方案不擅自移动。
