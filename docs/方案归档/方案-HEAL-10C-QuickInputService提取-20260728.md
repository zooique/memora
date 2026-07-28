# HEAL-10C QuickInputService 提取方案

> 来源：HEAL-10 appState 领域拆分第三步。前两轮已提取 AgentRuntime（9 字段）和 WindowService（4 字段），本轮提取快速输入/剪贴板基础设施。
> 日期：2026-07-28

## 一、现状分析

### 1.1 演进路径

```
已完成：AgentRuntime 提取（9 字段，验证集成模式）
  ↓
已完成：WindowService 提取（4 字段，窗口/托盘基础设施）
  ↓
本轮：QuickInputService 提取（clipboardHandler + quickInputWindow，2 字段）
  ↓
appState 仅保留应用级状态 + 独立功能模块（shortcutManager/auditManager/usageStatsCollector/pendingWriteConfirmations）
```

### 1.2 待提取字段引用扫描（main.ts 单文件）

| 字段 | 声明 | 读取 | 方法调用 | 初始化 | 清理 | 总计 |
|------|------|------|---------|--------|------|------|
| `clipboardHandler` | 1 | 2 | 3 | 1 | 2 | 9 |
| `quickInputWindow` | 1 | 2 | 5 | 1 | 2 | 11 |
| **合计** | 2 | 4 | 8 | 2 | 4 | **20** |

### 1.3 初始化与清理时序

**初始化**（`setupAgentIndependentResources`，阶段 2，不依赖 Agent）：
```
clipboardHandler (L804) → quickInputWindow (L857) → setSuppressNextChange (L893) → preloadInputInjector (L897) → updateFloatCallbacks (L902)
```

**清理**（`nullifyAllComponents` + `before-quit` 回调）：
- `before-quit` 先执行各字段的资源释放：`shortcutManager.unregisterAll` → `clipboardHandler.stopPolling` → `quickInputWindow.destroy`
- `nullifyAllComponents` 切断 2 字段引用

### 1.4 跨字段耦合点

| 耦合场景 | 涉及字段 | 说明 |
|---------|---------|------|
| `createDefaultConfirmCallback` | quickInputWindow → clipboardHandler | onConfirm 回调捕获 clipboardHandler，写入剪贴板前调用 suppressNextChange |
| `setSuppressNextChange` | quickInputWindow → clipboardHandler | PasteCoordinator 注入 clipboardHandler 的抑制函数 |
| `onAfterConfirm` 回调 | quickInputWindow → agentRuntime.sprite | 确认成功后异步 upsertMemory |
| `onPolish` 回调 | quickInputWindow → agentRuntime.agent | 调用 Agent 的文本润色能力 |
| `updateFloatCallbacks` | quickInputWindow → windowService.windowManager | 浮球单击触发 quickInputWindow.showAtPosition |
| `emit` 回调 | clipboardHandler → windowService.windowManager | 剪贴板事件推送到完整窗口 |
| ShortcutManager QUICK_INPUT handler | shortcutManager → quickInputWindow | 快捷键触发 quickInputWindow.show（跨 Service 外部依赖） |

### 1.5 IpcContext / MinimalIpcState 关系

| 字段 | IpcContext | MinimalIpcState |
|------|-----------|-----------------|
| `clipboardHandler` | 否（独立 ipcMain.handle 注册） | 否 |
| `quickInputWindow` | 否（IPC handler 在 quickInputWindow.ts 内联注册） | 否 |
| `shortcutManager` | 是（直接赋值，configHandlers 消费） | 否 |

**结论**：本轮提取不影响 MinimalIpcState 契约；IpcContext 仅涉及 shortcutManager，保持现状。

## 二、ShortcutManager 归属决策

### 2.1 归入 QuickInputService 的证据

- QUICK_INPUT handler 依赖 quickInputWindow（1/4 handler）

### 2.2 不归入的反证

- **时序不同**：shortcutManager 阶段 1 初始化（L719），QuickInputService 阶段 2 初始化（L804/L857）
- **3/4 handler 依赖 windowManager**（外部依赖）：TOGGLE_WINDOW / QUICK_RECORD / RECALL_MEMORY 均通过 windowService.windowManager
- **IpcContext 契约**：shortcutManager 已在 IpcContext 中直接赋值（L434），归入新 Service 需调整 IpcContext 访问路径
- **职责正交**：shortcutManager 是全局快捷键分发器，与剪贴板/快速输入是不同关注点

### 2.3 决策

**shortcutManager 不归入 QuickInputService**，保持独立。理由：
1. 时序不同（阶段 1 vs 阶段 2），强行归入会引入初始化时序复杂性
2. 3/4 handler 依赖 windowManager，归入会引入外部依赖，破坏 QuickInputService 封闭性
3. IpcContext 契约稳定性（shortcutManager 直接赋值模式与 getter 模式不一致，但当前无 bug，不强制修改）
4. 后续如需可独立成 ShortcutService（当前 7 处引用，未达提取阈值）

## 三、本轮方案：提取 QuickInputService

### 3.1 提取范围

| 迁入 QuickInputService 的字段 | 理由 |
|------------------------------|------|
| clipboardHandler | 阶段 2 初始化，与 quickInputWindow 双向依赖 |
| quickInputWindow | 阶段 2 初始化，依赖 clipboardHandler + agentRuntime + windowManager |

**不迁入**：
- `shortcutManager`（时序不同 + 3/4 handler 依赖 windowManager + IpcContext 契约）

### 3.2 QuickInputService 类设计

```typescript
/**
 * 快速输入/剪贴板基础设施状态容器
 *
 * 封装阶段 2 初始化的 2 个字段：
 * - clipboardHandler（剪贴板三重保护轮询）
 * - quickInputWindow（快速输入浮窗 UI + 粘贴协调）
 *
 * 设计原则：
 * - 纯状态容器，不持有业务逻辑（业务逻辑仍在 main.ts）
 * - 字段公开暴露，IPC handler 和 main.ts 直接读写
 *
 * 集成点：
 * - main.ts 持有 quickInputService 实例并挂载到 appState.quickInputService
 * - clipboardHandler 的 CLIPBOARD_ANALYZE IPC 通过 appState.quickInputService.clipboardHandler 访问
 * - quickInputWindow 的 IPC handler 在 quickInputWindow.ts 内联注册（ADR-SP-017 例外）
 * - shortcutManager QUICK_INPUT handler 通过 appState.quickInputService.quickInputWindow 访问（跨 Service 外部依赖）
 */
export class QuickInputService {
  /** 剪贴板处理器（三重保护轮询 + CLIPBOARD_ANALYZE），阶段 2 初始化 */
  clipboardHandler!: ClipboardHandler;
  /** 快速输入浮窗（Phase 1 骨架：懒创建，快捷键 Ctrl+Shift+C 触发显示），阶段 2 初始化 */
  quickInputWindow!: QuickInputWindow;

  /**
   * 清空所有引用（退出时调用）
   *
   * 切断所有字段引用，防止退出后定时器残留触发已销毁对象的方法。
   * clipboardHandler.stopPolling / quickInputWindow.destroy 由 before-quit 回调前置执行。
   */
  nullify(): void {
    this.clipboardHandler = null!;
    this.quickInputWindow = null!;
  }
}
```

> **注**：字段使用 `!:` definite assignment 语法（与 WindowService 一致），运行时初始值为 `undefined`，通过可选链 `?.` 安全降级。

### 3.3 appState 调整后结构

```typescript
const appState = {
  // ─── 领域 Service ───
  agentRuntime: new AgentRuntime(),
  windowService: new WindowService(),
  quickInputService: new QuickInputService(),

  // ─── 功能模块（独立，未达提取阈值） ───
  pendingWriteConfirmations: new Map<string, (confirmed: boolean) => void>(),
  auditManager: null as AuditManager | null,
  usageStatsCollector: null as UsageStatsCollector | null,
  shortcutManager: null as ShortcutManager | null,  // 保持独立（时序不同 + 3/4 handler 依赖 windowManager）

  // ─── 应用级状态（跨领域共享，保留 appState） ───
  agentReady: false as boolean,
  initErrorDetail: null as string | null,
  ipcRegistered: false as boolean,
  currentDataDir: DEFAULT_DATA_DIR as string,
  unreadCount: 0 as number,
  isQuitting: false as boolean,
};
```

### 3.4 MinimalIpcState 接口兼容性

**无需修改**。clipboardHandler 和 quickInputWindow 不在 MinimalIpcState 中，minimalHandlers 不访问这两个字段。

### 3.5 IpcContext 兼容性

**无需修改**。shortcutManager 保持 `appState.shortcutManager` 直接赋值模式，clipboardHandler 和 quickInputWindow 不在 IpcContext 中。

### 3.6 ShortcutManager QUICK_INPUT handler 跨 Service 访问

```typescript
// 修改前
[SHORTCUT_ACTIONS.QUICK_INPUT]: () => {
  if (appState.quickInputWindow) {
    appState.quickInputWindow.show();
  }
},

// 修改后
[SHORTCUT_ACTIONS.QUICK_INPUT]: () => {
  if (appState.quickInputService.quickInputWindow) {
    appState.quickInputService.quickInputWindow.show();
  }
},
```

### 3.7 改动文件清单

| 文件 | 变更类型 | 改动量 |
|------|---------|--------|
| `electron/runtime/quickInputService.ts` | **新建** | QuickInputService 类（2 字段 + nullify） |
| `electron/main.ts` | 修改 | appState.quickInputService 替代 2 字段；20 处引用路径调整；nullifyAllComponents 集中清理 |

**不需要修改**：
- `electron/ipc/types.ts`（MinimalIpcState 不含这两字段）
- `electron/ipc/minimalHandlers.ts`（不访问这两字段）
- 测试文件（minimalHandlers.test.ts 不涉及这两字段）

## 四、不提取的归档

### 4.1 shortcutManager（保持独立）

**理由**：
- 阶段 1 初始化，时序与 QuickInputService（阶段 2）不同
- 3/4 handler 依赖 windowManager（WindowService 外部依赖）
- IpcContext 契约稳定性（直接赋值模式，当前无 bug）
- 7 处引用，未达提取阈值

### 4.2 auditManager / usageStatsCollector / pendingWriteConfirmations

**理由**：
- pendingWriteConfirmations 是纯数据 Map，无方法，不需要容器化
- auditManager / usageStatsCollector 各 ~5 处引用，未达提取阈值
- 遵循"自然生长"原则，待引用数增长时再考虑提取

## 五、验证计划

1. **类型检查**：`tsc --noEmit` 通过 ✅
2. **全量测试**：4631/4631 通过 ✅
3. **集成模式验证点**：
   - setupAgentIndependentResources 正确初始化 2 字段到 quickInputService ✅
   - before-quit 清理路径正确调用 clipboardHandler.stopPolling + quickInputWindow.destroy ✅
   - nullifyAllComponents 正确调用 quickInputService.nullify() ✅
   - ShortcutManager QUICK_INPUT handler 通过 quickInputService.quickInputWindow 访问 ✅
   - clipboardHandler.emit 回调通过 quickInputService.clipboardHandler 访问（闭包内）✅

## 六、后续演进路径

```
本轮：QuickInputService 提取（2 字段容器化）
  ↓
appState 仅保留应用级状态（6 字段）+ 独立功能模块（4 字段）
  ↓
（自然生长触发）ShortcutService 提取 / AuditService 提取
```

## 七、实施完成

> **状态**：已完成 ✅
> **日期**：2026-07-28
> **提交**：见 git log

### 实际改动文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `electron/runtime/quickInputService.ts` | 新建 | QuickInputService 类（2 字段 + nullify），使用 `!:` definite assignment 语法 |
| `electron/main.ts` | 修改 | appState.quickInputService 替代 2 字段；20 处引用路径调整；nullifyAllComponents 集中清理；before-quit 回调路径调整 |

### 与方案的差异

无差异。方案设计即最终实现。
