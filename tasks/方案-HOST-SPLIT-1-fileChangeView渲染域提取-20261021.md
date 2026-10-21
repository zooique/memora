# 方案-HOST-SPLIT-1-fileChangeView渲染域提取-20261021

> 归属：`tasks/待完成任务.md` HOST-SPLIT-1 主条目（L891）。这是 HOST-SPLIT-1 序列收口后的**首个新刀**（P2 大文件减肥，fileChangeView 为首选目标）。判据与红线均引自主条目 L949/L951，本文档不重定义。

## 一、现状分析

### 1.1 演进路径

`fileChangeView.ts`（**1322 物理行 / 807 有效行**，TARGET，时点 2026-10-21 闸门自报口径）自 2026-09-26 diff 可视化方案落地后持续生长：内联装饰、块级 CodeLens、虚拟文档对比、文件级/块级回退、状态栏与通知收口全部聚在一个类 `FileChangeView`（L333-1322，约 990 行）中。宿主 eslint 闸门对其设 `max: 1322`（只降不升）。

### 1.2 调研结论：是否真需拆分

按 `progressive-refactor-rules.md §1` 硬阈值核（非行数机械切分）：该类字段 10 个、方法 40+ 个；单次改动（如「改 hover 上限」）会同时触碰渲染、快照、动作互不相干的段落；行数 1322 已进闸门 TARGET 档。**且域边界可枚举、测试兜底齐全、净降远超判据 ⇒ 拆。**

### 1.3 本轮提取范围表（域边界枚举 · 判据①）

**选中域 = 渲染呈现域（块快照缓存 + 内联装饰 + 悬停 + 渲染并发守卫）**

| 类别 | 成员 | 现位置 |
|---|---|---|
| 字段 ×3 | `hunkCache` / `decorations` / `renderSeq`（含字段级 JSDoc） | L340-357 |
| 方法 ×13 | `revealChange`(589) `isLatestRender`(615) `renderInline`(632) `buildDecorationItems`(678) `anchorRange`(703) `reapplyDecorations`(716) `decorationFor`(733) `oldContentHover`(742) `snapshotFor`(758) `snapshotOfPath`(772) `resolveHunk`(784) `reconcile`(801) `clearDecoration`(811) | L573-818 |
| 模块级随迁 | `HOVER_MAX_LINES` / `highlightOptions`+`removedHighlightOptions`（惰性缓存双函数，**勿改回模块顶层常量**）/ `DecorationPair` / `safeLineRange` / `HunkSnapshot` | L71 / L137-172 / L175 / L225 / L247 |
| 外部调用点 ×15 | 见 §2.3 | — |

**外部依赖（全部可注入、零回调大杂烩）**：`FileChangeTracker` 实例（构造后不变，直接传引用）+ `log` 窄函数（结构化兼容 `FileChangeViewDeps`，不 import 该类型 ⇒ 无环）+ `vscode` + `fileChangeDiff` 工具。域内**不触碰**动作区/对比区/收口区任何私有成员。

**为何渲染域胜出（对比其余候选，实测非推测）**：
- 动作回退区（discard/confirm/revert/restore/writeBack ≈ 232 行）：外部调用横跨 `clearDecoration`+`releaseVirtual`+`refreshStatusBar`+`lensProvider.refresh`+`notifyChanged` 五处 ⇒ 至少 5 个回调注入 = 大杂烩（转移复杂度而非消解，见台账 L917 同款撤回理由）。
- 块级动作区（accept/reject/stale/afterBlockAction ≈ 116 行）：依赖渲染域 `resolveHunk`/`snapshotFor` 与动作区 `writeBack`/`confirmOverwriteDirty`，单抽横跨两域，**抽不出自足边界**。
- 对比虚拟文档区（openCompare 等 + `virtualContents` ≈ 70 行）：域体量 <100 行 ⇒ 判据③已知失效面（台账 L932 实锤），净降大概率 <40，不值得单刀。
- CodeLens 类（L266-331）：留原文件——经 `snapshotOfPath` 回调注入与现状完全同形，零改动；`registerCodeLensProvider` 注册点不动（REGISTER_SOURCES 只管 `registerCommand`，渲染域零命令注册）。

### 1.4 为何选此域做 P2 首刀

① 依赖最少（2 个注入 vs 动作区 5+），先例中依赖数递增（1/2/5），本刀回落到 2 = 风险可控；② 测试穿透实证为**零**（见 §6.1）——`fileChangeView.test.ts` 全走真实命令/事件路径，私有符号 grep 零命中；③ `hunkCache` 注释自书「渲染与 CodeLens 同源消费」= 域内聚有既有契约背书，搬走后同源关系整体平移，不拆散。

## 二、目标类设计

### 2.1 新模块 `extension/host/fileChangeRenderer.ts`

```text
export interface HunkSnapshot { hunks: DiffHunk[]; afterText: string }   // 随迁（属主 = hunkCache）
export function safeLineRange(document, line): vscode.Range              // 随迁导出（view 的 CodeLens 仍消费）
class FileChangeRenderer {
  constructor(tracker: FileChangeTracker, log: (msg: string) => void)
  // —— 原 13 个私有方法**零改名**原样搬迁 ——
  revealChange / renderInline / buildDecorationItems / anchorRange / reapplyDecorations
  decorationFor / oldContentHover / snapshotFor / snapshotOfPath / resolveHunk / reconcile
  clearDecoration / isLatestRender
  // —— 跨文件访问的最小新增接口（提取的接口代价，非优化）——
  invalidateSnapshot(path): void   // = hunkCache.delete（noteToolResult / noteExternalMutations / acceptHunk 用）
  release(path): void              // = clearDecoration + hunkCache.delete + renderSeq.delete（discardRecord 用，三行合一、语义等价）
  dispose(): void                  // = decorations/hunkCache/renderSeq 三个 Map 清理（view.dispose 委托）
}
```

- `invalidateSnapshot` 与 `release` **必须分开**：`noteToolResult` 只失效快照、**不动** `renderSeq`（在途渲染序号另有语义），合并即行为变更 = 违红线④。
- JSDoc 随代码走（方法注释原样搬迁），新文件头补 `@module` 级说明（域职责 + 同源契约指针）。

### 2.2 设计原则：方法名零改名（承第 1 刀）

`this.reconcile()` → `this._render.reconcile()`，纯路径变化；仅字段访问跨文件处换成 §2.1 两个新方法（字段搬走后的必然封装，非顺便优化）。

### 2.3 与 fileChangeView 的接口（单一挂载点）

| 现调用点 | 改后 |
|---|---|
| 构造 374：`new FileChangeCodeLensProvider((p) => this.snapshotOfPath(p))` | 回调改 `this._render.snapshotOfPath(p)`（`_render` 须先于 `lensProvider` 初始化） |
| 426 `reapplyDecorations`（register 监听） | `this._render.reapplyDecorations()` |
| 543/562 `hunkCache.delete(...)` | `this._render.invalidateSnapshot(...)` |
| 545/563 `reconcile` | `this._render.reconcile()` |
| 551/568/1229 `revealChange` | `this._render.revealChange(...)` |
| 896-900 discardRecord 内三行渲染清理 | `this._render.release(rec.path)` |
| 1130/1152 `resolveHunk` | `this._render.resolveHunk(...)` |
| 1140 `hunkCache.delete` | `this._render.invalidateSnapshot(...)` |
| 1222 `snapshotFor` | `this._render.snapshotFor(...)` |
| 1232 `reapplyDecorations` | `this._render.reapplyDecorations()` |
| 1311-1318 dispose 内三个 Map 清理 | `this._render.dispose()`（`virtualContents`/`lensProvider`/`changeEmitter` 留原地） |

view 侧新增：`import { FileChangeRenderer, safeLineRange, type HunkSnapshot } from './fileChangeRenderer.js'` + 字段 `_render` + 构造初始化，合计 ≈ 6-8 行。

## 三、改动文件清单

| 文件 | 动作 |
|---|---|
| `src/extension/host/fileChangeRenderer.ts` | **新建**（迁移域 + 最小新接口） |
| `src/extension/host/fileChangeView.ts` | 删迁出成员；加 `_render`；§2.3 调用点改造；`safeLineRange`/`HunkSnapshot` 改 import |
| `hosts/memora-vscode/eslint.config.mjs` | fileChangeView `max` **调低**至实测新值（取数 = 闸门自报；只降不升） |
| 测试文件 | **预期零改动**（穿透实证为零；若实施中出现随迁需求，逐处登记断言语义零变化） |

## 四、不提取的归档（含理由 · 防重复论证）

1. **动作回退区**（discardRecord/confirmChange/confirmAll/revertAll/confirmOverwriteDirty/restoreChange/dirtyDocumentOf/writeBack/applyRestore ≈ 232 行）：跨域调用 5 处 ⇒ 注入大杂烩；且与 `register()` 命令注册区、`withRecord/withHunk` 参数守卫纠缠。**前置条件** = 先把「收口区」（notifyChanged/refreshStatusBar/lensProvider.refresh）切出公共接口，再单独立项。
2. **块级动作区**（acceptHunk/rejectHunk/staleHunk/afterBlockAction ≈ 116 行）：横跨渲染域与动作域两界，待①落地后再评估。
3. **对比虚拟文档区**（≈ 70 行）：<100 行假门槛失效面（台账 L932），净降不足不值得单刀。
4. **CodeLens 类**：留 view，零改动（§1.3 论证）。
5. **收口区 / 状态栏 / 通知**（≈ 110 行）：`refreshStatusBar`/`notifyChanged` 被动作区与 Sink 广泛消费，是动作域拆分的**前置接口**而非独立域——先抽它等于为拆而拆。

## 五、后续演进路径

渲染域落地后 fileChangeView 预计 ≈ 1000 行出头（实测为准）。剩余块按判据独立立项：动作回退域（需 §四-1 前置）→ 收口区。**不预设轮次**，每刀过三件套才动。

## 六、验证计划

### 6.1 前置基线（改码前必跑，先锁数）

- `git status` 干净，HEAD = `8471af37`。
- `npx vitest run fileChangeView.test.ts fileChangeCommands.test.ts` → **50 passed**（35+15），此为回归基线。
- **测试穿透核验（第 1 刀血训动作，提前做）**：grep `hunkCache|renderSeq|decorations|snapshotOfPath|reconcile|revealChange|renderInline|clearDecoration|discardRecord|withRecord|\.tracker|\.deps` 于 `fileChangeView.test.ts` → **仅 1 处注释提及 `virtualContents`（不迁），私有面穿透零命中** ⇒ 测试零改动的依据。

### 6.2 新增测试

不新增单测：既有 35 用例（装饰存活守卫 / 渲染并发 / 高亮语义分流）经真实命令与事件路径完整覆盖本域；容器与 view 是同一测试面（命令路径不分层）。若变异验证暴露盲区，按需补（补则登记进第七章）。

### 6.3 变异验证（施加即红 / 还原即绿，每发记录三件）

预期红是**待验证假设**（第 2 刀教训：0 红可能是等价变异，如实登记勿改实现）：

| # | 变异 | 预期 |
|---|---|---|
| M1 | `revealChange` 删 `isLatestRender` 守卫 | 并发渲染用例红（只允许最新渲染落地） |
| M2 | `renderInline` 删「只对非空侧 setDecorations」守卫 | 装饰批次数断言红 |
| M3 | `reconcile` 删 `decorations` 对齐循环 | 装饰泄漏/残留用例红 |
| M4 | `release` 删 `clearDecoration` 步骤 | 确认后高亮残留用例红 |
| M5 | `snapshotFor` 删缓存命中判断 | 可能等价变异（语义等价仅性能差），如实登记 |

### 6.4 契约不变式（拆完必须仍成立）

1. `fileChangeView.ts` export 面**零删改**（8 命令 id 常量 + `PENDING_CONTEXT_KEY` + `FileChangeView` + `FileChangeViewDeps` + `FileChangeCodeLensProvider`）。
2. **命令 id 常量全部留在 fileChangeView.ts**——`fileChangeCommands.test.ts` 从该文件源码正则提取 `const X_COMMAND = '…'`，搬走即测试断言失据。
3. `REGISTER_SOURCES` 不新增（渲染域无 `registerCommand`）。
4. 闸门 `max` 只降不升，取数 = 闸门自报口径。
5. 测试零改动（出现穿透则随迁并登记）。

## 七、实施完成

### 7.1 验证结果（实际数据，2026-10-21）

- **`fileChangeView.ts` 1322 → 974 行（净降 348，判据③ ≥40 达标）**；行数取闸门自报口径（max 临时置 1 抓「File has N lines」）。新建 `fileChangeRenderer.ts` **435 行**（迁出 300+ 行 + 容器 JSDoc/新接口）。
- 门禁：`tsc --noEmit` 双配置 **EXIT=0**；`npx eslint .` **EXIT=0**；目标两测试 **50 passed（35+15，与基线一致）**；宿主全量 **84 文件 passed / EXIT=0**（零回归）。
- **测试零改动**（§6.2 承诺兑现）：私有面穿透 grep 核验零命中，全部断言经真实命令/事件路径不受迁域影响。
- view 侧残留核验：`this.(hunkCache|renderSeq|decorations|旧渲染方法名)` 全库 grep，`fileChangeView.ts` **零残留**（命中全部在容器内部 = 合法访问）。

### 7.2 变异验证（五发：1 红 / 4 不红，逐发如实登记）

| # | 变异 | 实测 | 失败签名 / 登记 |
|---|---|---|---|
| M1 | `revealChange` 删两处 `isLatestRender` 守卫 | **0 红** | **既有覆盖缺口**：测试无并发渲染用例（迁移前同样无覆盖），非本刀引入 |
| M2 | `renderInline` 删「只对非空侧 setDecorations」守卫 | **4 红** | `expected 2 to be 1`（重设装饰/分屏/hoverMessage/红侧空四用例）——装饰语义断言确实守住 |
| M3 | `reconcile` 删 `decorations` 对齐循环 | **0 红** | **既有覆盖缺口**：该分支仅 tracker 淘汰（100 条）后生效，测试无淘汰场景 |
| M4 | `release` 删 `clearDecoration` 步骤 | **0 红** | **既有观测面缺口**：mock 的 `createTextEditorDecorationType` 无 dispose 留痕，装饰残留不可观测（迁移前 `discardRecord` 同样无此断言） |
| M5 | `snapshotFor` 删缓存命中判断 | **0 红** | **等价变异**（方案 §6.3 预期）：diff 计算确定性，重算结果相同、仅性能差 |

**处置**：三处既有缺口（M1/M3/M4）**如实登记、不预补**——非本刀引入；补则要造并发/淘汰场景与改 mock 观测面，属扩测试改动面，触发驱动（同台账 L940「已知不可覆盖面」处置形态）。不为凑红加无用测试（第 2 刀纪律）。

### 7.3 实际修改文件清单

| 文件 | 变化 |
|---|---|
| `src/extension/host/fileChangeRenderer.ts` | 新建 435 行（3 字段 + 13 方法零改名 + `safeLineRange`/`HunkSnapshot` 导出 + `invalidateSnapshot`/`release`/`dispose` 三新接口） |
| `src/extension/host/fileChangeView.ts` | 1322 → 974（−382/+34）；import 收敛（`fileChangeDiff` 仅剩 `applyHunkReverts`/`hunkKey`/`DiffHunk`） |
| `hosts/memora-vscode/eslint.config.mjs` | fileChangeView `max: 1322 → 974`（只降不升，闸门自报取数） |
| `tasks/方案-HOST-SPLIT-1-fileChangeView渲染域提取-20261021.md` | 本方案 |

### 7.4 契约不变式核验（§6.4 五条全过）

① export 面零删改（8 命令 id + `PENDING_CONTEXT_KEY` + `FileChangeView`/`FileChangeViewDeps`/`FileChangeCodeLensProvider` 原样）；② 命令 id 常量全部留在 fileChangeView.ts（`fileChangeCommands.test.ts` 正则提取断言全绿 = 实证）；③ `REGISTER_SOURCES` 零新增（容器无 `registerCommand`，该测试 15 用例全绿 = 实证）；④ 闸门只降不升（1322 → 974）；⑤ 测试零改动。

### 7.5 实施中发现（非方案预设）

- 构造顺序约束：`_render` 必须先于 `lensProvider` 初始化（CodeLens 回调经 `this._render.snapshotOfPath` 取数），已注释钉在构造函数内。
- `discardRecord` 原三行渲染清理（`clearDecoration`+`hunkCache.delete`+`renderSeq.delete`）压缩为容器 `release()` 一调，原「作废在途渲染」语义注释随迁容器 `release` JSDoc，view 侧留一行指针注释。
