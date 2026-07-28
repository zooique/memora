# HEAL-12 PanelRouter 职责拆分方案

> 来源：HEAL-12 P1 架构级待办（待完成任务.md）。PanelRouter 实际承担 6 职责过载，违反单一职责原则。本轮按 progressive-refactor-rules.md §2.2 模式 B（职责拆分）拆为 4 个独立 Controller。
> 日期：2026-07-28
> 模式：B（职责拆分）—— 与 HEAL-10/11 的模式 A（容器提取）不同，本轮将单个大类拆为多个独立 Controller，Controller 之间通过 Host 接口解耦

## 一、现状分析

### 1.1 演进路径

```
PanelRouter 当前状态（panelRouter.ts，551 行）
  - 6 职责过载：面板切换 + 导航 + 全局快捷键 + 快捷触发 + 窗口控制 + AUX 侧栏
  - 2 个内部状态字段：auxSidebarOpen + activeAuxTab（与面板切换职责无关）
  - 1 个 EventTracker 持有所有事件监听器（混装 4 个域的监听器）
  - PanelRouterHost 接口 16 个方法（横跨 4 个域的宿主能力需求）
  ↓
本轮：按职责正交性拆为 4 个独立 Controller
  ↓
PanelRouter（面板切换 + 导航，~100 行）
  + WindowControlsController（窗口控制，~80 行）
  + AuxSidebarManager（AUX 侧栏，~120 行）
  + GlobalShortcutDispatcher（全局快捷键 + 快捷触发，~120 行）
  ↓
panelRouter.ts 从 551 行降至 ~100 行（-82%）
每个 Controller 职责单一，Host 接口最小化，EventTracker 各自独立
```

### 1.2 调研结论

PanelRouter 是典型的"职责过载"上帝类（progressive-refactor-rules.md §1 职责数 ≥ 5 阈值触发）：

- **职责正交**：4 个域之间不共享状态（auxSidebarOpen 仅 AUX 侧栏用，auxTab 仅 AUX 用，面板切换状态在 UIManager.state）
- **外部依赖正交**：窗口控制依赖 electronAPI，AUX 侧栏依赖 DOM，快捷键依赖 host.getState/isStreaming，面板切换依赖 dirty 检查
- **测试 mock 过载**：PanelRouterHost 16 个方法中，switchPanel 只用 8 个，windowControls 只用 5 个，auxSidebar 只用 1 个，globalShortcut 只用 6 个——单一职责测试需 mock 大量不相关依赖

**与 HEAL-10/11 的区别**：HEAL-10/11 是字段内聚度高 → 模式 A（容器提取，字段不迁移业务逻辑）；HEAL-12 是职责正交 → 模式 B（职责拆分，业务逻辑随之迁移到新 Controller）。

### 1.3 本轮拆分范围

| 拆出的新 Controller | 来源方法 | 来源状态 | 来源事件绑定 |
|---------------------|---------|---------|-------------|
| **WindowControlsController** | `handleMinimize` / `handleMaximize` / `handleClose` / `updateMaximizeButton` | 无（纯行为） | btn-minimize / btn-maximize / btn-close click + `onWindowStateChanged` |
| **AuxSidebarManager** | `handleToggleAuxClick` / `handleAuxTabClick` / `toggleAuxSidebar` / `switchAuxTab` / `isAuxTabVisible` / `openAuxSidebar` / `applyAuxSidebarState` / `applyAuxTabState` | `auxSidebarOpen` + `activeAuxTab` | btn-toggle-aux click + .aux-tab click |
| **GlobalShortcutDispatcher** | `handleGlobalKeydown` / `handleEscapeKey` / `handlePanelShortcut` / `handleActionShortcut` / `handleQuickRecordTrigger` / `handleRecallMemoryTrigger` + `PANEL_SHORTCUT_MAP` 常量 | 无（纯行为） | document keydown |

**保留在 PanelRouter 的方法**：`switchPanel` + `handleNavClick` + `init()` 中的 `.nav-btn` 绑定部分。

### 1.4 不提取的归档

| 项 | 归档理由 |
|----|---------|
| `events: EventTracker` 不共享 | 4 个 Controller 各自持有独立 EventTracker，遵循"自包含事件清理"契约（与 DateNavManager / SearchMessagesManager 同模式） |
| 不引入 PanelRouter → siblings 反向引用 | 反向引用会让 PanelRouter 退化为 composite facade，违反职责拆分初衷。跨 Controller 依赖通过 Host 接口（UIManager）中转 |
| 不提取为 panels 子目录 | 4 个文件并列在 panels/，与 inputAreaManager / searchMessagesManager / dateNavManager 同层（这些也不是严格"面板管理器"而是 UI 基础设施） |

## 二、4 个 Controller 类设计

### 2.1 PanelRouter（瘦身后的核心职责）

```typescript
/**
 * 面板路由器（瘦身后）—— 仅负责主面板切换 + 导航按钮点击
 *
 * HEAL-12 拆分后保留的核心职责：
 * - switchPanel：主面板切换（chat/memories/settings/clipboard/sprite-settings）含未保存修改检查
 * - handleNavClick：侧边栏导航按钮点击分发
 *
 * 已拆出的职责：
 * - 窗口控制 → WindowControlsController
 * - AUX 侧栏 → AuxSidebarManager
 * - 全局快捷键 + 快捷触发 → GlobalShortcutDispatcher
 */
export interface PanelRouterHost {
  /** 获取当前 UI 状态（只读副本） */
  getState(): UIState;
  /** 设置当前面板名 */
  setCurrentPanel(panel: string): void;
  /** 获取对话输入框元素（切到 chat 时聚焦） */
  getInputEl(): HTMLTextAreaElement;
  /** 检查设置面板是否有未保存修改 */
  isSettingsDirty(): boolean;
  /** 重置设置面板 dirty 标志 */
  resetSettingsFormDirty(): void;
  /** 显示确认对话框（离开设置面板时） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
  /** 关闭记忆面板的分析面板（离开 memories 时） */
  dismissMemoryAnalysisPanels(): void;
  /** 进入记忆面板时确保当前激活区块视图可见 */
  activateMemoryPanelView(): void;
  /** 获取面板切换回调（通知外部控制器刷新数据） */
  getPanelSwitchCallback(): ((panel: string) => void) | null;
}

export class PanelRouter {
  private events = new EventTracker();
  constructor(private host: PanelRouterHost) {}

  init(): void {
    // 仅绑定 .nav-btn[data-panel] 导航按钮
    document.querySelectorAll<HTMLElement>('.nav-btn').forEach((btn) => {
      this.events.addEventListener(btn, 'click', this.handleNavClick.bind(this));
    });
  }

  cleanup(): void { this.events.cleanup(); }

  async switchPanel(panel: string): Promise<void> { /* 逻辑保留 */ }
  handleNavClick(e: Event): void { /* 逻辑保留 */ }
}
```

**Host 接口收缩**：从 16 方法降至 9 方法（移除 isStreaming / getBtnStop / getBtnMaximize / emitStopMessage / showModal / hideModal / openCommandPalette）。

### 2.2 WindowControlsController（新）

```typescript
/**
 * 窗口控制 Controller —— 管理最小化/最大化/关闭按钮 + 最大化图标切换
 *
 * 职责：
 * - 绑定 btn-minimize / btn-maximize / btn-close 点击事件
 * - 监听 onWindowStateChanged 同步最大化图标
 * - handleClose 包含设置面板未保存修改检查（与 switchPanel 行为一致）
 */
export interface WindowControlsHost {
  /** 获取当前 UI 状态（用于 handleClose 检查 settings 面板） */
  getState(): UIState;
  /** 获取最大化按钮元素（可能为 null，部分布局无标题栏） */
  getBtnMaximize(): HTMLButtonElement | null;
  /** 检查设置面板是否有未保存修改 */
  isSettingsDirty(): boolean;
  /** 重置设置面板 dirty 标志 */
  resetSettingsFormDirty(): void;
  /** 显示确认对话框（关闭窗口时） */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;
}

export class WindowControlsController {
  private events = new EventTracker();
  constructor(private host: WindowControlsHost) {}

  init(): void {
    // btn-minimize / btn-maximize / btn-close 绑定
    // + window.electronAPI.onWindowStateChanged 监听
  }
  cleanup(): void { this.events.cleanup(); }
  updateMaximizeButton(isMaximized: boolean): void { /* 图标切换 */ }
  private handleMinimize(): void { /* windowMinimize */ }
  private handleMaximize(): void { /* windowMaximize */ }
  private async handleClose(): Promise<void> { /* 含 dirty 检查 */ }
}
```

### 2.3 AuxSidebarManager（新）

```typescript
/**
 * 信息侧栏 Manager —— 管理 AUX 侧栏展开/收起 + tab 切换
 *
 * 职责：
 * - 持有 auxSidebarOpen + activeAuxTab 状态
 * - 绑定 btn-toggle-aux + .aux-tab 点击事件
 * - applyAuxSidebarState / applyAuxTabState 同步 DOM
 * - openAuxSidebar / isAuxTabVisible 对外 API（命令面板/主动触发/精灵状态条点击）
 *
 * 命名调整（更简洁，对齐"独立 Controller"语义）：
 * - openAuxSidebar(tab?) → open(tab?)
 * - isAuxTabVisible(tab) → isVisible(tab)
 */
export interface AuxSidebarHost {
  /** 获取面板切换回调（tab 切换时触发数据刷新：perception→loadPerception，dashboard→loadDashboard） */
  getPanelSwitchCallback(): ((panel: string) => void) | null;
}

export class AuxSidebarManager {
  private events = new EventTracker();
  /** 信息侧栏是否展开（默认 true） */
  private auxSidebarOpen = true;
  /** 当前激活的侧栏 tab（默认 perception） */
  private activeAuxTab: 'perception' | 'dashboard' = 'perception';

  constructor(private host: AuxSidebarHost) {}

  init(): void {
    // btn-toggle-aux + .aux-tab 绑定
    // + applyAuxSidebarState() + applyAuxTabState() 初始同步
  }
  cleanup(): void { this.events.cleanup(); }

  /** 打开信息侧栏（可选指定 tab），用于自动打开路径 */
  open(tab?: 'perception' | 'dashboard'): void { /* 原 openAuxSidebar 逻辑 */ }
  /** 判断指定侧栏 tab 是否当前可见（侧栏展开 + 该 tab 激活） */
  isVisible(tab: 'perception' | 'dashboard'): boolean { /* 原 isAuxTabVisible 逻辑 */ }

  private handleToggleAuxClick(): void { /* toggle */ }
  private handleAuxTabClick(e: Event): void { /* switchAuxTab */ }
  private toggleAuxSidebar(): void { /* */ }
  private switchAuxTab(tab): void { /* */ }
  private applyAuxSidebarState(): void { /* DOM 同步 */ }
  private applyAuxTabState(): void { /* DOM 同步 */ }
}
```

### 2.4 GlobalShortcutDispatcher（新）

```typescript
/**
 * 全局快捷键 Dispatcher —— 管理键盘快捷键 + 快捷触发入口
 *
 * 职责：
 * - document keydown 全局监听
 * - Esc：关闭下拉/弹窗打开时跳过/非对话面板切回对话
 * - Ctrl/Cmd + 1-5：切换主面板
 * - Ctrl/Cmd + . ：停止生成（仅流式输出期间）
 * - Ctrl/Cmd + / ：快捷键帮助弹窗
 * - handleQuickRecordTrigger / handleRecallMemoryTrigger：Ctrl+Shift+M / Ctrl+Shift+R 入口
 *
 * 跨 Controller 依赖：通过 host.switchPanel 委托到 PanelRouter（不直接持有 PanelRouter 引用）
 */
export interface GlobalShortcutHost {
  /** 获取当前 UI 状态（用于 Escape 判断当前面板） */
  getState(): UIState;
  /** 是否正在流式输出（Ctrl+. 触发条件） */
  isStreaming(): boolean;
  /** 发送停止消息信号（Ctrl+. 触发） */
  emitStopMessage(): void;
  /** 显示弹窗（Ctrl+/ 切换 shortcuts-modal） */
  showModal(modalId: string): void;
  /** 隐藏弹窗 */
  hideModal(modalId: string): void;
  /** 切换面板（Ctrl+1-5 / Esc 切回 chat 时调用，委托到 PanelRouter.switchPanel） */
  switchPanel(panel: string): Promise<void>;
}

export class GlobalShortcutDispatcher {
  private events = new EventTracker();
  constructor(private host: GlobalShortcutHost) {}

  init(): void {
    this.events.addEventListener(document, 'keydown', this.handleGlobalKeydown.bind(this));
  }
  cleanup(): void { this.events.cleanup(); }

  /** Ctrl+Shift+M 入口：切换到对话面板 */
  async handleQuickRecordTrigger(): Promise<void> { /* await host.switchPanel('chat') */ }
  /** Ctrl+Shift+R 入口：切换到记忆面板并选中搜索框 */
  async handleRecallMemoryTrigger(): Promise<void> { /* await host.switchPanel('memories') + select */ }

  private handleGlobalKeydown(e: Event): void { /* */ }
  private handleEscapeKey(e: KeyboardEvent): void { /* */ }
  private handlePanelShortcut(e: KeyboardEvent): void { /* */ }
  private handleActionShortcut(e: KeyboardEvent): void { /* */ }

  /** 面板快捷键映射表（Ctrl/Cmd + 1-5 → chat/memories/sprite-settings/clipboard/settings） */
  private static readonly PANEL_SHORTCUT_MAP: Record<string, string> = {
    '1': 'chat', '2': 'memories', '3': 'sprite-settings', '4': 'clipboard', '5': 'settings',
  };
}
```

### 2.5 与现有模式的对比

| 维度 | HEAL-10/11（模式 A 容器提取） | HEAL-12（模式 B 职责拆分） |
|------|------------------------------|---------------------------|
| 拆分对象 | 字段（容器化，不迁移逻辑） | 职责（逻辑随之迁移） |
| 拆分粒度 | 按功能域分组字段 | 按职责正交性分组方法 |
| 原 Host 角色 | 保留业务逻辑，仅替换字段访问路径 | 不再持有这些职责，业务逻辑下沉到新 Controller |
| 调用方影响 | 路径替换（`field` → `container.field`） | 路径替换 + sugar API 调整（详见 §3.2） |
| Host 接口变化 | 字段路径替换 | 接口拆分（1 个 PanelRouterHost → 4 个 *Host） |

## 三、改动文件清单

### 3.1 文件变更总览

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `src/electron/renderer/panels/panelRouter.ts` | 修改（瘦身） | 移除窗口控制/AUX/快捷键相关方法 + 移除 auxSidebarOpen/activeAuxTab 字段 + PanelRouterHost 接口收缩 + init 仅绑定 .nav-btn |
| `src/electron/renderer/panels/windowControlsController.ts` | 新建 | WindowControlsController 类 + WindowControlsHost 接口 |
| `src/electron/renderer/panels/auxSidebarManager.ts` | 新建 | AuxSidebarManager 类 + AuxSidebarHost 接口 |
| `src/electron/renderer/panels/globalShortcutDispatcher.ts` | 新建 | GlobalShortcutDispatcher 类 + GlobalShortcutHost 接口 |
| `src/electron/renderer/ui.ts` | 修改 | 实例化 3 个新 Controller + init/cleanup 编排 + UIManager 实现 3 个新 Host 接口 + 添加 sugar API（openAuxSidebar/isAuxTabVisible）+ 移除 PanelRouterHost 中已迁移的方法实现 |
| `src/electron/renderer/helpers/ui-delegations/miscDelegations.ts` | 修改 | 3 个委托方法路径改指向兄弟 Controller（updateMaximizeButton → windowControlsController；handleQuickRecordTrigger/handleRecallMemoryTrigger → globalShortcutDispatcher） |
| `src/electron/renderer/renderer.ts` | 修改 | 5 处路径替换（panelRouter.openAuxSidebar → uiManager.openAuxSidebar；panelRouter.isAuxTabVisible → uiManager.isAuxTabVisible） |
| `src/electron/renderer/panels/commandPaletteManager.ts` | 修改 | 2 处路径替换（uiManager.panelRouter.openAuxSidebar → uiManager.openAuxSidebar） |
| `src/__tests__/electron/renderer/uiDelegations.test.ts` | 修改 | 3 个 miscDelegations 测试用例的 mock 路径更新（panelRouter.xxx → windowControlsController/globalShortcutDispatcher.xxx） |
| `.trae/rules/directory-structure.md` | 修改 | panels/ 节补登 3 个新文件描述 |

### 3.2 sugar API 调整说明

**调用方零改动的部分**（miscDelegations 内部委托路径调整，外部调用 `uiManager.updateMaximizeButton` 等不变）：
- `miscDelegations.updateMaximizeButton`：`this.panelRouter.updateMaximizeButton` → `this.windowControlsController.updateMaximizeButton`
- `miscDelegations.handleQuickRecordTrigger`：`this.panelRouter.handleQuickRecordTrigger` → `this.globalShortcutDispatcher.handleQuickRecordTrigger`
- `miscDelegations.handleRecallMemoryTrigger`：`this.panelRouter.handleRecallMemoryTrigger` → `this.globalShortcutDispatcher.handleRecallMemoryTrigger`

**调用方路径替换的部分**（原直接访问 `panelRouter.xxx` 改为 UIManager sugar API，避免外部调用方依赖兄弟 Controller 内部路径）：
- UIManager 新增 sugar API：`openAuxSidebar(tab)` 委托到 `auxSidebarManager.open(tab)`，`isAuxTabVisible(tab)` 委托到 `auxSidebarManager.isVisible(tab)`
- 7 处调用方路径替换（详见 §3.1 表格 renderer.ts + commandPaletteManager.ts + ui.ts initSpriteStatusBarClick）

**路径替换而非保留 panelRouter sugar API 的理由**：若保留 `panelRouter.openAuxSidebar` 作为委托到 `auxSidebarManager.open` 的 sugar API，PanelRouter 需持有 auxSidebarManager 引用，退化为 composite facade（违反职责拆分初衷）。UIManager 作为 composition root 持有所有 Controller，由它暴露跨域 sugar API 更符合分层方向。

## 四、不提取的归档

| 项 | 归档理由 |
|----|---------|
| 不合并 4 个 Controller 的 EventTracker | 各 Controller 职责正交、生命周期一致，独立 EventTracker 遵循"自包含事件清理"契约（与 DateNavManager / SearchMessagesManager / SkillDropManager 同模式）。合并 EventTracker 反而引入耦合 |
| 不引入 PanelRouterHost 基接口 | 4 个 Host 接口（PanelRouterHost / WindowControlsHost / AuxSidebarHost / GlobalShortcutHost）方法集不重叠（除 getState 在 3 个接口出现），抽取基接口收益低 |
| 不提取 GlobalShortcutDispatcher.PANEL_SHORTCUT_MAP 为共享常量 | 仅 1 处使用，未达 3 次阈值（progressive-refactor-rules.md §5.2） |
| 不重构 switchPanel 内部 70 行逻辑 | switchPanel 是 PanelRouter 的核心职责，本轮只拆分不重构（progressive-refactor-rules.md §9 禁止"提取时顺便优化"） |

## 五、后续演进路径

```
本轮（HEAL-12）：PanelRouter 6 职责 → 4 Controller
  ↓
（自然生长触发）
  ↓
HEAL-13：mixin 模式遮蔽循环依赖（ui.ts applyMixins 改组合委托）
  ↓
HEAL-15：renderer/sprite 同名 MemoryController/PersonaController 异义改名
  ↓
（远期）UIManager 28 字段进一步按域聚合（SettingsCoordinator / MemoryCoordinator / ChatCoordinator / GlobalInfraCoordinator）
```

## 六、验证计划

- **类型检查**：`npx tsc --noEmit` 0 错误（双 tsconfig：electron + preload）
- **全量测试**：`npx vitest run` 不新增失败用例（当前基线 4631/4631 通过）
- **集成模式验证点**：
  - PanelRouter.init() 仅绑定 `.nav-btn`，不再绑定窗口控制/AUX/快捷键
  - 3 个新 Controller 各自 init() + cleanup() 独立可调用
  - UIManager.cleanup() 顺序调用 4 个 Controller.cleanup()
  - auxSidebarOpen/activeAuxTab 状态迁移到 AuxSidebarManager 后，命令面板/主动触发/精灵状态条点击路径仍正确触发侧栏展开 + 数据刷新
  - 最大化按钮图标在窗口最大化/还原时正确切换（WindowControlsController.onWindowStateChanged 监听保留）
  - Ctrl+1-5 / Ctrl+. / Ctrl+/ / Esc 快捷键行为不变
  - Ctrl+Shift+M / Ctrl+Shift+R 快捷触发行为不变

## 七、实施完成（2026-07-28）

### 验证结果

- `npm run typecheck:electron`：0 错误
- `npm run test`：138 文件 / 4631 测试全通过（含 uiDelegations 128 测试）

### 实际修改文件清单

| 文件 | 变更类型 | 改动点 |
|------|---------|--------|
| `hosts/memora-sprite/src/electron/renderer/panels/panelRouter.ts` | 修改 | 删除窗口控制/AUX 侧栏/快捷键 3 个职责（551→197 行，-64%）；PanelRouterHost 接口瘦身到 8 方法；保留 switchPanel + handleNavClick + `.nav-btn` 绑定 |
| `hosts/memora-sprite/src/electron/renderer/panels/windowControlsController.ts` | **新建** | WindowControlsController 类 + WindowControlsHost 接口（5 方法）；init 绑定 btn-minimize/maximize/close；handleClose 含 dirty 检查 + 确认弹窗 |
| `hosts/memora-sprite/src/electron/renderer/panels/auxSidebarManager.ts` | **新建** | AuxSidebarManager 类 + AuxSidebarHost 接口（1 方法）；持有 auxSidebarOpen + activeAuxTab 状态；open(tab?) / isVisible(tab) / applyState 系列 |
| `hosts/memora-sprite/src/electron/renderer/panels/globalShortcutDispatcher.ts` | **新建** | GlobalShortcutDispatcher 类 + GlobalShortcutHost 接口（6 方法）；PANEL_SHORTCUT_MAP 静态常量；handleQuickRecordTrigger / handleRecallMemoryTrigger |
| `hosts/memora-sprite/src/electron/renderer/ui.ts` | 修改 | 新增 3 个 Controller 字段声明 + 构造函数初始化 + init/cleanup 编排；新增 implements 4 个 Host 接口；新增 sugar API（openAuxSidebar / isAuxTabVisible） |
| `hosts/memora-sprite/src/electron/renderer/helpers/ui-delegations/miscDelegations.ts` | 修改 | 3 个委托方法路径调整：updateMaximizeButton → windowControlsController；handleQuickRecordTrigger / handleRecallMemoryTrigger → globalShortcutDispatcher |
| `hosts/memora-sprite/src/electron/renderer/renderer.ts` | 修改 | 5 处调用方路径调整：State.uiManager.panelRouter.openAuxSidebar / isAuxTabVisible → State.uiManager.openAuxSidebar / isAuxTabVisible（sugar API） |
| `hosts/memora-sprite/src/electron/renderer/panels/commandPaletteManager.ts` | 修改 | 2 处命令面板 action 路径调整：panelRouter.openAuxSidebar → uiManager.openAuxSidebar |
| `hosts/memora-sprite/src/__tests__/electron/renderer/uiDelegations.test.ts` | 修改 | 3 个测试用例 mock 路径调整（panelRouter → globalShortcutDispatcher / windowControlsController） |

### 实施回顾

**模式 B 与模式 A 的差异体现**：
- HEAL-10/11（模式 A）：字段内聚度高，提取容器后业务逻辑仍留在原处（main.ts / UIManager + mixin），容器仅做字段集中 + cleanup 调度
- HEAL-12（模式 B）：职责正交，业务逻辑随职责一起迁移到新 Controller，原类（PanelRouter）真正瘦身（551→197 行）

**Host 接口最小化的收益**：
- PanelRouterHost 从 16 方法瘦身到 8 方法（仅面板切换所需）
- 每个新 Controller 的 Host 接口仅声明自己所需的最小依赖（WindowControlsHost 5 方法 / AuxSidebarHost 1 方法 / GlobalShortcutHost 6 方法）
- 单元测试 mock 不再需要为单一职责 mock 大量不相关依赖

**Sugar API 的向后兼容设计**：
- UIManager 暴露 `openAuxSidebar(tab?)` / `isAuxTabVisible(tab)` 包装方法
- renderer.ts（5 处）+ commandPaletteManager.ts（2 处）调用方无需感知内部 Controller 拆分
- 未来若 AuxSidebarManager 进一步演进，调用方 API 不变

### 与 progressive-refactor-rules 模式 B 的对齐

- ✅ 单轮一个职责域：本轮完成 PanelRouter 的 6 职责拆分，不混入其他重构
- ✅ Host 接口最小化：每个 Controller 定义独立 Host 接口
- ✅ EventTracker 独立：每个 Controller 持有独立 EventTracker，cleanup 仅清理自己的事件
- ✅ 业务逻辑随职责迁移：与方法 A 的"纯字段提取"不同，方法 B 的业务逻辑随之迁移
- ✅ 炼化归元收尾：typecheck + 全量测试 + 文档更新 + 待办迁移
