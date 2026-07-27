# HEAL-10B WindowService 提取方案

> 来源：HEAL-10 appState 领域拆分第二步。上一轮 AgentRuntime 提取已验证集成模式，本轮提取窗口/托盘基础设施。
> 日期：2026-07-27

## 一、现状分析

### 1.1 上一轮遗留的演进路径

```
本轮（已完成）：AgentRuntime 提取（验证集成模式）
  ↓
本轮：WindowService 提取（4 字段容器化）
  ↓
下一轮：ClipboardQuickInputService 提取（含 ShortcutManager 归并评估）
  ↓
appState 仅保留应用级状态（~7 字段）
```

### 1.2 待提取字段引用扫描（main.ts 单文件）

| 字段 | 声明 | 读取 | 方法调用 | 初始化 | 清理 | 总计 |
|------|------|------|---------|--------|------|------|
| `windowManager` | 1 | 3 | 20 | 1 | 1 | 26 |
| `trayManager` | 1 | 2 | 9 | 1 + 1 回退 | 1 | 15 |
| `windowStateManager` | 1 | 2 | 7 | 1 | 1 | 12 |
| `interaction` | 1 | 0 | 1 | 1 | 1 | 4 |
| **合计** | 4 | 7 | 37 | 4 + 1 | 4 | **57** |

### 1.3 初始化与清理时序

**初始化**（`initializeApp` 阶段 1，串行创建）：
```
windowStateManager (611) → windowManager (626) → trayManager (679) → interaction (709)
```

**清理**（`nullifyAllComponents` 集中清理）：
- `before-quit` 回调先执行各 manager 的 destroy/closeAll
- `nullifyAllComponents` 切断 4 字段引用

### 1.4 跨字段耦合点

| 耦合场景 | 涉及字段 | 说明 |
|---------|---------|------|
| `createIpcContext` | windowManager + trayManager | 一次性打包传给 IpcContext |
| `setupAgentReady` | windowStateManager + windowManager + trayManager | 一次性打包传给 spriteEventDeps |
| TrayManager 构造回调 | trayManager + windowStateManager + windowManager | 回调反向引用窗口字段 |
| `onHideToTray` 回调 | windowStateManager + trayManager | 浮动窗口隐藏同步状态 + 重建菜单 |

## 二、ShortcutManager 归属决策

### 2.1 归入 WindowService 的证据

- 4 个 handler 中 3 个触及 `windowManager`（TOGGLE_WINDOW / QUICK_RECORD / RECALL_MEMORY）
- 阶段 1 一起初始化，`nullifyAllComponents` 一起清理

### 2.2 不归入的反证

- `QUICK_INPUT` handler 直接调用 `appState.quickInputWindow.show()` — 与 quickInputWindow 强耦合
- quickInputWindow 在阶段 2（`setupAgentIndependentResources`）初始化，时序不同
- ShortcutManager 与 quickInputWindow 有耦合点，应等 HEAL-10C 一起处理

### 2.3 决策

**ShortcutManager 不归入 WindowService**，保留在 appState。理由：
1. 归入会引入外部依赖（quickInputWindow），破坏 WindowService 封装
2. ShortcutManager 与 quickInputWindow 的耦合点应在 HEAL-10C 中统一处理
3. 遵循"单一职责"原则：WindowService 仅包含阶段 1 初始化的窗口/托盘基础设施

## 三、本轮方案：提取 WindowService

### 3.1 提取范围

| 迁入 WindowService 的字段 | 理由 |
|--------------------------|------|
| windowStateManager | 阶段 1 一起初始化，4 字段紧耦合 |
| windowManager | 同上 |
| interaction | 同上（本文件内仅 4 处引用，合并降低 appState 字段数） |
| trayManager | 同上（无托盘环境降级为 null） |

**不迁入**：
- `shortcutManager`（QUICK_INPUT handler 依赖 quickInputWindow，归入会引入外部依赖）
- `quickInputWindow`（阶段 2 初始化，时序不同）

### 3.2 WindowService 类设计

```typescript
/**
 * 窗口/托盘基础设施状态容器
 *
 * 封装阶段 1 初始化的 4 个字段：
 * - windowStateManager（窗口状态管理器）
 * - windowManager（窗口管理器）
 * - interaction（交互层）
 * - trayManager（系统托盘管理器）
 *
 * 设计原则：
 * - 纯状态容器，不持有业务逻辑（业务逻辑仍在 main.ts）
 * - 字段公开暴露，IPC handler 和 main.ts 直接读写
 *
 * 集成点：
 * - main.ts 持有 windowService 实例并挂载到 appState.windowService
 * - minimalHandlers.ts 通过 MinimalIpcState.windowService 访问 windowManager
 * - IpcContext getter 通过 appState.windowService.windowManager 实时查询
 */
export class WindowService {
  /** 窗口状态管理器（三态切换 + 持久化），阶段 1 初始化 */
  windowStateManager!: WindowStateManager;
  /** 窗口管理器（完整窗口 + 浮动窗口），阶段 1 初始化 */
  windowManager!: WindowManager;
  /** 交互层（ElectronInteraction，注入主窗口引用），阶段 1 初始化 */
  interaction!: ElectronInteraction;
  /** 系统托盘管理器（无托盘环境降级为 null），阶段 1 初始化 */
  trayManager: TrayManager | null = null;

  /**
   * 清空所有引用（退出时调用）
   *
   * 切断所有字段引用，防止退出后定时器残留触发已销毁对象的方法。
   * windowManager/trayManager 的 destroy/closeAll 由 before-quit 回调前置执行。
   */
  nullify(): void {
    this.windowStateManager = null!;
    this.windowManager = null!;
    this.interaction = null!;
    this.trayManager = null;
  }
}
```

> **注**：字段使用 `!:` definite assignment 语法（而非 `null! as Type`），因为后者不被 vite:oxc 转换器支持（PARSE_ERROR）。`!:` 在运行时初始值为 `undefined`，通过可选链 `?.` 安全降级。

### 3.3 appState 调整后结构

```typescript
const appState = {
  // ─── 领域 Service ───
  agentRuntime: new AgentRuntime(),
  windowService: new WindowService(),

  // ─── 功能模块（下一轮提取 ClipboardQuickInputService） ───
  pendingWriteConfirmations: new Map<string, (confirmed: boolean) => void>(),
  auditManager: null as AuditManager | null,
  usageStatsCollector: null as UsageStatsCollector | null,
  shortcutManager: null as ShortcutManager | null,  // 不归入 WindowService（QUICK_INPUT handler 依赖 quickInputWindow）
  clipboardHandler: null as ClipboardHandler | null,
  quickInputWindow: null as QuickInputWindow | null,

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

**问题**：`minimalHandlers.ts` 通过 `state.windowManager` 直接访问（THEME_CHANGED 通道）。

**方案**：MinimalIpcState 接口调整，`windowManager` 字段改为 `windowService`。

```typescript
// ipc/types.ts 修改前
interface MinimalIpcState {
  windowManager: WindowManagerLike | undefined;
  // ...
}

// ipc/types.ts 修改后
interface MinimalIpcState {
  windowService: WindowService;  // 替代 windowManager 字段
  // ...
}
```

`minimalHandlers.ts` 中 `state.windowManager?.updateBackgroundColor(color)` → `state.windowService.windowManager?.updateBackgroundColor(color)`。

### 3.5 IpcContext 兼容性

IpcContext 的 `windowManager` 和 `trayManager` 字段保持不变（IPC handler 通过 getter 访问）。`createIpcContext` 内部访问路径调整：

```typescript
// 修改前
const ctx: IpcContext = {
  windowManager: appState.windowManager,
  trayManager: appState.trayManager,
  // ...
};

// 修改后
const ctx: IpcContext = {
  windowManager: appState.windowService.windowManager,
  trayManager: appState.windowService.trayManager,
  // ...
};
```

### 3.6 改动文件清单

| 文件 | 变更类型 | 改动量 |
|------|---------|--------|
| `electron/runtime/windowService.ts` | **新建** | WindowService 类（4 字段 + nullify） |
| `electron/main.ts` | 修改 | appState.windowService 替代 4 字段；57 处引用路径调整 |
| `electron/ipc/types.ts` | 修改 | MinimalIpcState.windowManager → windowService |
| `electron/ipc/minimalHandlers.ts` | 修改 | state.windowManager → state.windowService.windowManager（THEME_CHANGED 通道） |
| `src/__tests__/electron/ipc/minimalHandlers.test.ts` | 修改 | createState 改用 new WindowService()；THEME_CHANGED 测试用例调整 |

## 四、不提取的归档

### 4.1 ShortcutManager（下一轮 HEAL-10C 评估）

**理由**：
- QUICK_INPUT handler 依赖 quickInputWindow，归入 WindowService 会引入外部依赖
- ShortcutManager 与 quickInputWindow 的耦合点应在 HEAL-10C 中统一处理
- 等 quickInputWindow 提取后，ShortcutManager 可与 quickInputWindow 一起归入新 Service，或独立成 ShortcutService

### 4.2 quickInputWindow（下一轮 HEAL-10C）

**理由**：
- 阶段 2 初始化（setupAgentIndependentResources），时序与 WindowService 的阶段 1 不同
- 回调闭包深度依赖 windowManager + agentRuntime + clipboardHandler
- 与 clipboardHandler 有双向依赖（setSuppressNextChange / createDefaultConfirmCallback）

## 五、验证计划

1. **类型检查**：`tsc --noEmit` 通过 ✅
2. **全量测试**：4631/4631 通过（含 minimalHandlers 55 测试 + THEME_CHANGED 3 测试）✅
3. **集成模式验证点**：
   - initializeApp 阶段 1 正确初始化 4 字段到 windowService ✅
   - before-quit 清理路径正确调用 windowService.nullify() ✅
   - minimalHandlers 通过 windowService.windowManager 访问 THEME_CHANGED ✅
   - IpcContext 通过 windowService.windowManager / windowService.trayManager 访问 ✅

## 六、后续演进路径

```
本轮：WindowService 提取（4 字段容器化）
  ↓
下一轮：ClipboardQuickInputService 提取（含 quickInputWindow + clipboardHandler）
  ↓
ShortcutManager 归并评估（独立成 ShortcutService 或归入 ClipboardQuickInputService）
  ↓
appState 仅保留应用级状态（~7 字段）
```

## 七、实施完成

> **状态**：已完成 ✅
> **日期**：2026-07-28
> **提交**：见 git log

### 实际改动文件

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `electron/runtime/windowService.ts` | 新建 | WindowService 类（4 字段 + nullify），使用 `!:` definite assignment 语法 |
| `electron/main.ts` | 修改 | appState.windowService 替代 4 字段；57 处引用路径调整；nullifyAllComponents 集中清理 |
| `electron/ipc/types.ts` | 修改 | MinimalIpcState.windowManager → windowService；新增 WindowService 导入 |
| `electron/ipc/minimalHandlers.ts` | 修改 | state.windowManager → state.windowService.windowManager（THEME_CHANGED 通道） |
| `src/__tests__/electron/ipc/minimalHandlers.test.ts` | 修改 | createState 改用 new WindowService()；THEME_CHANGED 3 测试用例调整 |

### 与方案的差异

字段语法从设计时的 `null! as Type` 改为实际实现的 `!:` definite assignment。原因：`null! as Type` 不被 vite:oxc 转换器支持（PARSE_ERROR: Expected `;` but found `as`）。`!:` 运行时初始值为 `undefined`，通过可选链 `?.` 安全降级。
