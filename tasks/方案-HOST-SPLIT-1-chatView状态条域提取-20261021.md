# 方案：HOST-SPLIT-1 P2 chatView 状态条域提取（第 6 刀 · 域外置范式第 5 次复制）

> 配套台账：`tasks/待完成任务.md` HOST-SPLIT-1 条目。本刀后 chatView P2 域外置序列正式收口。

## 一、背景与目标

`chatView.ts` 经 P2 第 1-5 刀（计划栏 / 历史菜单 / 占用 / 活动抽屉）后剩 **6942** 行，仍挂 StatusDock
上三条常驻状态条。本刀将这三条**状态条渲染与生命周期**外置为 `webview/scripts/statusBarsView.ts`，
`chatView.ts` 收口至 **6716** 行，并**正式收口 chatView P2 域外置序列**（终局条件：无剩余可枚举域）。

- 物理净降：6942 → 6716（**−226**）；新建 `statusBarsView.ts` **342** 物理行（有效 ≈227）。
- 闸门：`max` 6942 → **6716**（只降不升；lint 临时置 6715 触发生效，精确报 6716）。

## 二、域边界枚举

| 类别 | 符号 |
|---|---|
| 渲染函数 | `updatePendingQueueBar` / `updateFileChangesBar` / `updateBackgroundTasksBar` |
| 状态（5） | `_pendingQueueBar` / `_fileChangesBar` / `_backgroundBar` / `_pendingQueueItems` / `_pendingDiscardedBuffer` |
| 调用点（3） | `turn_update.pendingQueue`（L5038） / `file_changes`（L5566） / `background_tasks`（L5569） |

> 注：`BackgroundTaskView` 类型随 `msg.items` 流入，容器直接 `import type`；`MAX_PENDING_INTERJECTIONS`
> 留在 chatView（满员预检文案与判据共用），容器不持有。

## 三、耦合 4 面核对（本刀关键差异：较第 4/5 刀多出 3 个跨触点）

① **入**：`turn_update.pendingQueue` → `updatePendingQueue`（替代原 `updatePendingQueueBar`）。
② **入**：`pending_discarded` 事件经 `pushDiscarded` 压入丢弃缓冲（原 chatView L5062 直写 `_pendingDiscardedBuffer`），
缓冲随下一帧队列快照 diff 消耗（消失条目命中缓冲 = 丢弃不上屏）。
③ **出**：`sendMessage` 插话满员预检读 `getPendingCount()`（原 chatView L5895 读 `_pendingQueueItems.length`，配 `MAX_PENDING_INTERJECTIONS`）。
④ **收**：清空/切换会话的视图复位经 `reset()` 清两投影缓冲（原 chatView L4873/4882 直清）。

`fileChanges` / `background` 为自闭环（仅 `items.length===0` → `setDockActive(false)`），
**只有 `pendingQueue` 有上述跨触点**——这正是它不能像前两者那样「纯自闭环」搬走的原因，
窄接口须额外暴露 ③②④ 三个对外面。

**裁决**：StatusDock 裁决器（`resolveDock` / `registerDockEntry` / `setDockActive` / `_dockExpanded`）留 chatView（共享基础设施，
四条条仍消费它）；容器经 `deps` 注入这三面 + `appendInteractiveInput` + `postMessage`。
`populateIcons` / `getIconSvg` 为模块级 helper，容器直接 `import`。

## 四、窄接口设计

```ts
export interface StatusBarsViewDeps {
  document: Document;
  inputBar: HTMLElement;
  setDockActive: (id: 'pendingQueue' | 'fileChanges' | 'background', active: boolean) => void;
  registerDockEntry: (id: 'pendingQueue' | 'fileChanges' | 'background', el: HTMLElement) => void;
  appendInteractiveInput: (text: string, ts: string | undefined,
    kind: 'question-answer' | 'supplement' | 'timeout', roundId?: string, question?: string, options?: string[]) => void;
  postMessage: (msg: unknown) => void;
}

export interface StatusBarsView {
  updatePendingQueue: (items: readonly string[]) => void;
  pushDiscarded: (items: readonly string[]) => void;
  getPendingCount: () => number;
  updateFileChanges: (files: readonly string[]) => void;
  updateBackgroundTasks: (items: readonly BackgroundTaskView[]) => void;
  reset: () => void;
  dispose: () => void;
}
```

> `pushDiscarded` / `getPendingCount` / `reset` 即 §三 ②④③ 的对外面——缺一不可，是「不带伤」抽离 pendingQueue 的硬约束。

## 五、实施步骤（已落地）

1. 新建 `statusBarsView.ts`：搬 3 函数 + 5 state（无新增常量），`deps` 注入裁决器与 `postMessage`，
   `setDockActive`/`registerDockEntry` 形参收窄为三 id 并集（函数参数逆变，chatView 的 `DockId` 超集可赋值）。
2. `chatView.ts`：加 import + 实例化（紧邻 `planBar`，deps 闭包捕获 `setDockActive` 等 hoisted 函数声明）；
   3 调用点改 `statusBars.` 前缀；`pending_discarded` 改 `statusBars.pushDiscarded(msg.items)`；
   满员预检改 `statusBars.getPendingCount()`；reset 函数两行直清改 `statusBars.reset()`；`dispose` 加 `statusBars.dispose()`。
3. 删 `chatView.ts` 原三函数块（L2820-3056，237 行）。

## 六、测试与变异策略

**目标测试** `chatView.test` **457 例，测试零改动复绿**（消息驱动 + DOM 断言：清空按钮 SVG、`bar.hidden` 空态撤出、
`postMessage` 类型、徽章计数——抽离不改契约，DOM 类名/结构不变即断言有效）。

**变异五发全红零缺口**（逐发如实登记）：

| 变异 | 点 | 预期红 | 结果 |
|---|---|---|---|
| M1 | `pendingQueue` 空态撤出裁决 `setDockActive(false)` 删除 | 非空→空 `bar.hidden` 仍为 false | ✅ 红 |
| M2 | `fileChanges` 空态撤出裁决删除 | `count:0` 后 `bar.hidden` 仍为 false | ✅ 红 |
| M3 | clear 按钮 `postMessage` type 改 `clear_pending_queue`→`MUTATED` | `toHaveBeenCalledWith` 失配 | ✅ 红 |
| M4 | `pendingQueue` 徽章 `String(items.length)`→`+1` | 徽章期望 `'2'` 失配 | ✅ 红 |
| M5 | confirm 按钮 `postMessage` type 改 `confirm_all_file_changes`→`MUTATED` | `toHaveBeenCalledWith` 失配 | ✅ 红 |

## 七、实施后回填

- `chatView.ts` **6942 → 6716**（净降 226），闸门 `max` **6942 → 6716**（只降不升；lint 临时置 6715 触发验证报 6716）。
- 新建 `statusBarsView.ts` **342** 物理行 / 有效 ≈**227**。
- 全量基线 **84 文件 / 1467 passed / 2 skipped / EXIT=0**（与基线一致，零回归）。
- `tsc --noEmit -p tsconfig.json` EXIT=0；`npx eslint .` EXIT=0 零 warning。
- **chatView P2 域外置序列正式收口**（终局条件：无剩余可枚举域）；chatPanel 序列另行立项（见台账）。
- commit + 双端（gitee + github）推送。
