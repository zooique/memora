---
alwaysApply: false
description: "快速输入浮窗架构：窗口管理器内联 IPC + Controller/Completion 双类解耦 + LLM 回调注入"
---

# ADR-SP-017 · 快速输入浮窗架构决策

> **状态**：✅ 已接受
> **日期**：2026-07-15
> **来源**：年轮审判（2026-07-15 全自动质量闭环链路）—— quick-input 模块 7 次功能迭代后补录架构决策
> **依赖**：[ADR-SP-003](./ADR-SP-003-desktop-shell.md)（Electron 桌面壳）、[ADR-017](./ADR-017-natural-growth-redefinition.md)（架构先行原则）、[ADR-018](./ADR-018-css-scoping-convention.md)（CSS 作用域）

## 背景

快速输入浮窗（quick-input）是 memora-sprite 的轻量级用户输入入口，经 7 次功能迭代（流式锁、展开/收起、拖拽、LLM 润色、同源过滤、类重构、CSS 重构）形成稳定架构，但以下 3 项架构决策此前未以 ADR 形式记录：

1. **IPC 通道注册位置**：3 个通道（MOVE_QUICK_INPUT / QUICK_INPUT_POLISH / QUICK_INPUT_RESIZE）在 `quickInputWindow.ts`（窗口管理器）内注册，而非 `ipc/` 下的 handler 文件，违反 directory-structure.md §2.5 给人的"所有 IPC 都在 ipc/ 下"错觉
2. **类设计解耦**：`QuickInputController`（交互控制）+ `QuickInputCompletion`（补全逻辑）两类通过回调解耦，无直接依赖
3. **LLM 润色能力注入**：通过 `onPolish` 回调注入，main.ts 注入 `agent.polish?.polish()`，无独立 Manager 类

## 决策

### 1. 窗口管理器内联 IPC 模式

**quick-input 的 IPC 通道在窗口管理器（`quickInputWindow.ts`）内注册，而非 `ipc/` 下的 handler 文件。**

| 通道 | 注册位置 | 模式 | 理由 |
|------|---------|------|------|
| QUICK_INPUT_CONFIRM | quickInputWindow.ts | `ipcMain.handle` | 深度耦合窗口生命周期（流式模式抑制 blur、paste 后重新聚焦） |
| QUICK_INPUT_CLOSE | quickInputWindow.ts | `ipcMain.handle` | 直接操作 `this.hide()`，需访问窗口实例状态 |
| QUICK_INPUT_RESIZE | quickInputWindow.ts | `ipcMain.handle` | 操作 `this.win.setSize()` + `keepWindowInWorkArea()` |
| MOVE_QUICK_INPUT | quickInputWindow.ts | `ipcMain.on` | 操作 `this.win.setPosition()` + `clampPositionToWorkArea()` |
| QUICK_INPUT_POLISH | quickInputWindow.ts | `ipcMain.handle` | 调用 `this.callbacks.onPolish`（main.ts 注入） |

**判定标准**：当 IPC handler 需要深度访问窗口实例状态（焦点/位置/可见性/blur 定时器）时，在窗口管理器内注册；当 handler 是无状态的数据操作（CRUD/搜索）时，放在 `ipc/` 下的 handler 文件。

### 2. Controller + Completion 双类解耦

```
QuickInputController（quickInput.ts，交互控制层）
  ├── 键盘事件 / 流式模式 / 展开收起 / LLM 润色 / 拖动 / 确认流程 / 布局调整
  └── 持有 QuickInputCompletion 实例，通过 onSelect / onListChange 回调消费

QuickInputCompletion（quickInputCompletion.ts，补全逻辑层）
  ├── 防抖 / 并行搜索 / 合并去重 / 多样性过滤 / 采纳反馈 / ARIA
  └── 通过 onSelect(text) / onListChange(count) 回调通知 Controller
```

**解耦理由**：
- Controller 关注"用户交互 + 窗口状态"，Completion 关注"候选计算 + ARIA"
- Completion 可独立测试（50 个单测覆盖），不依赖 DOM 交互
- Controller 的布局调整（autoResize/resizeWindow）不污染补全逻辑

### 3. LLM 润色回调注入模式

**原决策（2026-07-09）：不引入独立 TextPolishManager 类，通过 `onPolish` 回调注入 LLM 能力。**

**实际实现（2026-07-16 补录）：演变为无状态服务类 TextPolishManager。**

```typescript
// quickInputWindow.ts 暴露回调接口
interface QuickInputWindowCallbacks {
  onPolish?: (text: string) => Promise<{ polished: string; changed: boolean }>;
}

// main.ts 注入实现（通过 TextPolishManager 服务类）
quickInputWindow.updateCallbacks({
  onPolish: async (text) => agent.polish?.polish(text) ?? { polished: text, changed: false },
});
```

**演进理由**：实际实现引入了 `src/agent/managers/textPolishManager.ts`（export class TextPolishManager），原因：
- 与 InsightExtractor/WorkProjection 同模式（构造函数注入 Provider + 流式累积），可测试性更好
- 仍是无状态服务类（仅 provider 字段，无 init/close/状态持久化/调度器），不符合"有生命周期 Manager"定义
- 命名"Manager"造成语义歧义，但实际是"服务类"——managers/ 目录下 13 个文件中仅 ChatLockManager 有 dispose() 生命周期方法

**与原决策的关系**：原决策"不引入独立 Manager 类"的语义是"不引入有生命周期的 Manager"，实际实现符合该语义（TextPolishManager 无生命周期），仅命名沿用"Manager"后缀。

## 理由

| 考虑 | 说明 |
|------|------|
| **窗口生命周期耦合** | quick-input 的 IPC 深度耦合窗口实例（blur 抑制、焦点恢复、位置 clamp），抽到 ipc/ 下需反向注入窗口引用，增加复杂度 |
| **双类解耦的测试收益** | Completion 50 单测可纯逻辑测试（无 DOM mock），Controller 的 DOM 交互测试缺口可接受（归档 COMP-0715-2） |
| **回调注入的最小成本** | 润色功能仅需 1 次 LLM 调用 + 结果回填，Manager 模式过度设计。main.ts 已是回调注入的汇聚点（onConfirm/onAfterConfirm/onClose） |
| **与 ADR-017 架构先行对齐** | 本 ADR 补录已实现的架构决策，非新设计。后续 quick-input 新增 IPC 通道时参照本 ADR 的判定标准 |

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 所有 IPC 放 ipc/ 下 + 注入窗口引用 | 反向依赖（ipc/ 依赖窗口管理器），违反分层方向；5 个通道中 5 个都需窗口实例，无收益 |
| Controller + Completion 合并为单类 | 单类超过 1500 行，补全逻辑与交互控制耦合，测试覆盖困难 |
| TextPolishManager 作为有生命周期 Manager 类 | 无状态单次调用不需生命周期管理（init/close/调度器），过度设计。实际实现为无状态服务类（见 §3 补录） |

## 影响

- **directory-structure.md §2.5**：补充"窗口管理器内联 IPC 例外"说明（RULE-0715-4）
- **sprite-project-rules.md**：新增 quick-input 模块章节（RULE-0715-3）
- **新增 IPC 通道时**：参照本 ADR §1 判定标准选择注册位置
- **preload 暴露面**：当前单 preload 暴露 100+ API，quick-input 仅需 9 个（SEC-0715-1 待方案设计）

## 何时回顾

- 当 quick-input 窗口数 > 1（如新增独立搜索窗口）时，评估是否提取共用 preload
- 当 LLM 润色需要状态管理（历史润色记录/批量润色）时，评估是否升级为 Manager
- 当 ipc/ 下的 handler 也需要访问窗口实例时，评估是否统一窗口管理器注册模式
