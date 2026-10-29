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

## 附 · 台账登记说明

- 新条目 **CHATVIEW-SLIM-2** 登记于 `### 宿主轴`（本项属宿主）。
- **发现（不顺手修，登记待拍板）**：上游 **CHATVIEW-SLIM-1 现登记在 `### 内核轴`**（`tasks/待完成任务.md` 观察区第一子轴），与其宿主属性不符；同一减重线的两刀分居两轴会让后续查找断链。是否迁移由下一轮台账治理统一处理，本方案不擅自移动。
