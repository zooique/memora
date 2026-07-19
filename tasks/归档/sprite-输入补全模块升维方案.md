# 输入补全模块升维方案 — 默认连续输入与常驻聚焦

> **模块范围**：`quick-input/`（浮窗控制器 + HTML/CSS）+ `windows/quickInputWindow.ts`（主进程窗口管理）+ `windows/pasteCoordinator.ts`（粘贴协调器）+ `panels/inputAreaManager.ts`（主窗口输入框）+ `preload-quick-input.ts` + `ipc/channels.ts`
> **触发原因**：用户实测发现 Bug 1（主窗口回车后候选浮层不关闭）+ 提出升维设计（默认连续输入 + 加锁常驻 + 顶部聚焦提示栏）
> **产出时间**：2026-07-17
> **模式链路**：问诊（合理性评审）→ 方案更新（设计）→ 排雷（沙盘推演）→ 待执行

---

## 1. 现状分析

### 1.1 当前模式语义

浮窗 `QuickInputController.streamMode: boolean` 控制 Tab 提交后的窗口行为：

| streamMode | 提交后行为 | blur 行为 | 触发方式 |
|------------|-----------|-----------|---------|
| `false`（默认） | 800ms Toast 后 `closeQuickInput()` 关闭 | 200ms 延迟关闭 | localStorage 默认 '0' |
| `true`（流式） | 500ms Toast 后 `resetInputForNext()` 清空等待 | 200ms 延迟关闭（paste 期间 suppressBlurClose 抑制） | 手动 toggle / isSensitive 自动开启 |

图标语义：`#icon-lock`（流式开启）/ `#icon-unlock`（流式关闭），footer 按钮 `#stream-toggle`。

### 1.2 已有的关键基础设施

| 设施 | 位置 | 可复用性 |
|------|------|---------|
| `suppressBlurClose` 标志位 | [quickInputWindow.ts:136](../../src/electron/windows/quickInputWindow.ts) | ✅ 直接复用为 pinned 模式持久抑制 |
| `pasteCoordinator.previousWindow: ActiveWindow` | [pasteCoordinator.ts:39](../../src/electron/windows/pasteCoordinator.ts) | ⚠️ 仅暴露 `title: Promise<string>`，无 appName 字段 |
| `win.on('blur')` / `win.on('focus')` 监听 | [quickInputWindow.ts:187-193](../../src/electron/windows/quickInputWindow.ts) | ✅ 已存在，可挂钩聚焦变化 IPC |
| `MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_SHOW` 主→渲染通道 | [quickInputWindow.ts:254](../../src/electron/windows/quickInputWindow.ts) | ✅ 参照新增 `QUICK_INPUT_FOCUS_CHANGE` 通道 |

### 1.3 当前 IPC 通道数

- 当前总数：114
- 本轮新增：2（`QUICK_INPUT_FOCUS_CHANGE` + `QUICK_INPUT_SET_ALWAYS_ON_TOP`）
- 预期总数：116（仍低于 130 治理阈值）

---

## 2. Bug 1 根因定位

### 2.1 现象

主对话输入框输入文字 → 候选浮层 `#chat-completion-list` 弹出 → 直接 Enter 发送 → 浮层不关闭，持续遮挡输入区。

### 2.2 根因

[inputAreaManager.ts:211-221](../../src/electron/renderer/panels/inputAreaManager.ts) `handleKeydown` 在 Enter 发送消息时仅调用 `emitSendMessage()`，**未调用 `this.completion?.clear()`**。

对比三处分支验证：

| 分支 | 是否清候选 | 位置 |
|------|----------|------|
| Enter 发送 | ❌ 漏清 | inputAreaManager.ts:220 |
| ←→ 选中候选 | ✅ 已清 | inputAreaManager.ts:315/325/352 |
| 用户删空输入（query<2） | ✅ 自动清 | quickInputCompletion.ts:249-251 |

`handleClick`（点发送按钮，[line 250-252](../../src/electron/renderer/panels/inputAreaManager.ts)）存在相同问题。

### 2.3 修复

| 位置 | 改动 |
|------|------|
| `handleKeydown` Enter 分支（line 220 前） | 插入 `this.completion?.clear();` |
| `handleClick`（line 251 前） | 插入 `this.completion?.clear();` |

行数：+2。独立可回滚，与升维方案解耦。

---

## 3. 升维设计合理性评审

### 3.1 ✅ 合理的部分

| 维度 | 评估 |
|---|---|
| **默认模式 = 连续输入** | 当前 `streamMode=true` 已实现"提交后清空+聚焦+等待"，降为默认行为意味着 Tab 提交后窗口不自动关闭。符合"快速备忘录"心智，合理 |
| **加锁 = 常驻窗口** | 加锁时持久 `suppressBlurClose=true`，等价于"钉住浮窗"。复用已有机制，实现成本低，合理 |
| **顶部聚焦提示栏** | 当前 `pasteCoordinator.capturePreviousWindow()` 已捕获前台窗口但用户不可见。增加提示栏让"误粘贴到错误窗口"风险可见化，体验提升明显，合理 |
| **无聚焦禁用 Tab** | 防御性设计，避免无目标时盲粘，合理 |

### 3.2 ⚠️ 需要调整的部分

**用户提议的"聚焦窗口判断逻辑：记录上一个点击的输入窗口"在 Electron 中不可行。**

原因：
1. Electron 浮窗（`frame:false + alwaysOnTop:true`）无法监听用户在其他应用中的点击行为（OS 级点击事件不向其他进程派发）
2. `nut-js` 的 `getActiveWindow()` 是一次性查询，不能持续监听全局焦点变化
3. 持续轮询前台窗口会有性能损耗 + 隐私风险

**可行的替代方案**：基于已有数据源组合

| 数据源 | 时机 | 用途 |
|---|---|---|
| `pasteCoordinator.previousWindow` | show() 时捕获 | Tab 提交目标，提示栏显示其应用名 |
| 浮窗 `win.on('blur')` | 用户切走浮窗 | 提示栏切换为"无聚焦"，禁用 Tab |
| 浮窗 `win.on('focus')` | 用户切回浮窗 | 重新捕获前台窗口 + 更新提示栏 + 激活 Tab |

**语义重定义**：
- "聚焦窗口" = pasteCoordinator 上次捕获的前台窗口
- 浮窗 blur 后显示"无聚焦"（语义为"焦点已离开浮窗，无法确认目标"）
- 浮窗 focus 后显示"聚焦：{应用名}"（重新捕获前台窗口后更新）

### 3.3 用户已裁决的关键决策

| 决策点 | 用户选择 |
|---|---|
| 默认模式提交后关闭时机 | **失焦仍关闭**（保持现状 200ms blur 关闭） |
| 常驻模式 alwaysOnTop 行为 | **默认保持顶层，浮窗顶部增加图钉按钮可手动切换** |
| 顶部聚焦提示栏内容粒度 | **仅应用名**（如"聚焦：VSCode" / "无聚焦"） |

---

## 4. 具体更新方案

### 4.1 任务分解（按优先级 + 独立可回滚）

| Task | 优先级 | 范围 | 独立性 | 行数估算 |
|------|--------|------|--------|---------|
| A | P0 | Bug 1 修复 | ✅ 完全独立 | +2 |
| B | P1 | 字段语义重定义 `streamMode → pinnedMode` | ❌ 依赖测试更新 | ~80 |
| C | P1 | pinned 模式 blur 抑制 + alwaysOnTop 切换 | ❌ 依赖 B | ~60 |
| D | P1 | 顶部聚焦提示栏 + 图钉按钮 | ❌ 依赖 C | ~120 |
| E | P1 | pasteCoordinator 暴露应用名 getter | ❌ 依赖 D | ~30 |
| F | P2 | 测试覆盖更新 + 新增 | ❌ 依赖 A-E | ~200 |

### 4.2 Task A：Bug 1 修复（P0）

**文件**：`src/electron/renderer/panels/inputAreaManager.ts`

**变更点**：

```typescript
// handleKeydown 中 Enter 分支
if (this.host.isStreaming()) {
  this.host.emitStopMessage();
} else {
  this.completion?.clear();  // 新增：发送前清空候选列表，避免浮层遮挡
  this.host.emitSendMessage();
}

// handleClick
private handleClick(): void {
  this.completion?.clear();  // 新增：与 Enter 发送保持一致
  this.host.emitSendMessage();
}
```

**验证场景**：
1. 主窗口输入"测"→ 候选弹出 → Enter 发送 → 候选立即消失
2. 主窗口输入"测"→ 候选弹出 → 点击发送按钮 → 候选立即消失

---

### 4.3 Task B：字段语义重定义 `streamMode → pinnedMode`

**核心变更**：当前 `streamMode=true` 是"特例行为"（保持窗口），新方案下"保持窗口"成为默认（pinnedMode=false），pinnedMode=true 才是"特例"（常驻）。

#### 4.3.1 quickInput.ts 改动

| 位置 | 旧 | 新 |
|------|---|---|
| line 72 `STORAGE_KEY_STREAM` | `'memora-quick-input-stream'` | 删除，新增 `STORAGE_KEY_PINNED = 'memora-quick-input-pinned'` |
| line 143 `streamMode = false` | 默认 false 表示"提交后关闭" | 改为 `pinnedMode = false`，默认 false 表示"默认连续输入" |
| line 458 `bindStreamToggle` | 绑定 streamToggle | 绑定 pinnedToggle（DOM id 不变 `#stream-toggle`，仅语义变更） |
| line 478-481 `isSensitive` 自动开启 | `streamMode = true` | `pinnedMode = true`（敏感内容自动进入常驻模式更安全） |
| line 538-544 `restoreStreamState` | 从 localStorage 恢复 streamMode | 改为 `restorePinnedState`，恢复 pinnedMode |
| line 597-611 `updateStreamToggle` | 图标 #icon-lock/unlock 语义"流式开关" | 改名 `updatePinnedToggle`，图标不变（🔒仍是"锁住窗口"，🔓仍是"不锁"），title 改"常驻模式开启/关闭" |
| line 619-623 `toggleStreamMode` | 切换 streamMode | 改名 `togglePinnedMode`，切换 pinnedMode，IPC 通知主进程 |
| line 643-663 `scheduleSuccessToast` | streamMode 分支：500ms Toast + resetInputForNext / 800ms Toast + closeQuickInput | **移除分支**：所有提交均走 500ms Toast + resetInputForNext |
| line 671-702 `handleConfirm` | `confirmQuickInput(text, this.streamMode)` | `confirmQuickInput(text, this.pinnedMode)` |
| line 707-719 `resetInputForNext` | 仅 streamMode 调用 | 所有模式都调用（已存在，无需改） |

**移除的常量**：
- `STREAM_TOAST_MS = 500`（保留，作为统一 Toast 时长）
- `TOAST_DURATION_MS = 800`（删除，不再有延迟关闭分支）

#### 4.3.2 quickInputWindow.ts 改动

[line 309-372](../../src/electron/windows/quickInputWindow.ts) `QUICK_INPUT_CONFIRM` handler：

```typescript
// 旧
const safeStreamMode = typeof streamMode === 'boolean' ? streamMode : false;
const hideFloat = safeStreamMode ? () => {} : () => this.hide();
if (safeStreamMode) {
  this.suppressBlurClose = true;
}
// ...
if (safeStreamMode) {
  this.suppressBlurClose = false;
  this.cancelBlurClose();
  this.win?.focus();
}

// 新
const safePinnedMode = typeof pinnedMode === 'boolean' ? pinnedMode : false;
// pinned 模式下 paste 期间抑制 blur；default 模式下 paste 期间也需抑制（paste 恢复焦点会触发 blur）
this.suppressBlurClose = true;
const hideFloat = () => {};  // 不再在 paste 成功路径关闭，关闭由 scheduleSuccessToast 控制（default 模式由 blur 触发）
// ...
// paste 返回后：
if (!safePinnedMode) {
  // default 模式：清除抑制，允许 blur 关闭
  this.suppressBlurClose = false;
  this.cancelBlurClose();
  this.win?.focus();
} else {
  // pinned 模式：保持抑制（持久钉住）
  this.suppressBlurClose = false;  // 临时清除以取消任何待关闭定时器
  this.cancelBlurClose();
  this.win?.focus();
  this.suppressBlurClose = true;  // 重新置为持久抑制
}
```

**copy 降级路径**（line 357-359）：

```typescript
// 旧
if (pasteResult.mode === 'copy') this.hide();
// 新
if (pasteResult.mode === 'copy' && !safePinnedMode) this.hide();
```

#### 4.3.3 IPC 参数语义变更

| 通道 | 参数 | 旧语义 | 新语义 |
|------|------|--------|--------|
| `QUICK_INPUT_CONFIRM` | 第 2 参数 `streamMode?: boolean` | true=流式 | `pinnedMode?: boolean`，true=常驻 |

**preload-quick-input.ts** 改动：

```typescript
// 旧
confirmQuickInput: (text: string, streamMode?: boolean) =>
  ipcRenderer.invoke('quick-input-confirm', text, streamMode)
// 新
confirmQuickInput: (text: string, pinnedMode?: boolean) =>
  ipcRenderer.invoke('quick-input-confirm', text, pinnedMode)
```

#### 4.3.4 localStorage 兼容

- 旧 key `memora-quick-input-stream` 残留：忽略，不主动迁移
- 旧用户首次启动：默认 default 模式（连续输入）—— 这是升级后的新默认行为，符合预期

---

### 4.4 Task C：pinned 模式 blur 抑制 + alwaysOnTop 切换

#### 4.4.1 quickInputWindow.ts 改动

新增 `setPinnedMode(pinned: boolean)` 方法（由渲染进程 IPC 调用）：

```typescript
/**
 * 切换常驻模式
 *
 * pinned=true：持久 suppressBlurClose，blur 不关闭浮窗
 * pinned=false：恢复 default 模式行为，blur 触发 200ms 延迟关闭
 */
setPinnedMode(pinned: boolean): void {
  this.pinnedMode = pinned;
  this.suppressBlurClose = pinned;
  if (!pinned) {
    this.cancelBlurClose();
  }
}

private pinnedMode = false;  // 新增字段
```

修改 `win.on('blur')` 监听（line 187-190）：

```typescript
win.on('blur', () => {
  if (this.suppressBlurClose || this.pinnedMode) return;
  this.scheduleBlurClose();
});
```

新增 `setAlwaysOnTop(value: boolean)` 方法 + IPC handler：

```typescript
async setAlwaysOnTop(value: boolean): Promise<void> {
  if (this.win && !this.win.isDestroyed()) {
    this.win.setAlwaysOnTop(value);
  }
}

// IPC handler
ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_SET_ALWAYS_ON_TOP, (_event, value: boolean) => {
  this.setAlwaysOnTop(value);
  return { success: true };
});
```

**约束**：default 模式下 `alwaysOnTop` 恒为 true（浮窗本意）；pinned 模式下用户可切换。

---

### 4.5 Task D：顶部聚焦提示栏 + 图钉按钮

#### 4.5.1 quick-input.html 改动

在 `<body>` 顶部、`<div class="quick-input-container">` 之前新增：

```html
<div id="focus-bar" class="focus-bar">
  <span id="focus-app-name" class="focus-app-name">无聚焦</span>
  <button id="pin-toggle" class="pin-toggle" aria-pressed="false" title="切换置顶" hidden>
    <svg class="icon"><use href="#icon-pin"/></svg>
  </button>
</div>
```

`#pin-toggle` 默认 `hidden`，仅 pinned 模式下显示。

SVG sprite 中新增 `#icon-pin` 和 `#icon-pin-off`。

#### 4.5.2 quick-input.css 改动

```css
.focus-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
  padding: 0 12px;
  background: var(--color-bg-secondary, #f5f5f5);
  border-bottom: 1px solid var(--color-border, #e0e0e0);
  font-size: 12px;
  color: var(--color-text-secondary, #666);
  user-select: none;
}

.focus-app-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.focus-bar.no-focus .focus-app-name {
  color: var(--color-text-disabled, #999);
  font-style: italic;
}

.pin-toggle {
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--color-text-secondary, #666);
}

.pin-toggle.active {
  color: var(--color-accent, #4caf50);
}

.pin-toggle[hidden] {
  display: none;
}
```

#### 4.5.3 quickInput.ts 改动

新增字段与方法：

```typescript
/** 顶部聚焦提示栏应用名元素 */
private readonly focusAppNameEl: HTMLElement;
/** 图钉切换按钮 */
private readonly pinToggleEl: HTMLElement;
/** Tab 是否激活（无聚焦时禁用） */
private tabEnabled = true;

/**
 * 更新聚焦提示栏
 * @param appName 应用名（null 表示无聚焦）
 */
private updateFocusIndicator(appName: string | null): void {
  if (appName) {
    this.focusAppNameEl.textContent = `聚焦：${appName}`;
    this.focusAppNameEl.parentElement?.classList.remove('no-focus');
    this.setTabEnabled(true);
  } else {
    this.focusAppNameEl.textContent = '无聚焦';
    this.focusAppNameEl.parentElement?.classList.add('no-focus');
    this.setTabEnabled(false);
  }
}

/**
 * 启用/禁用 Tab 提交
 */
private setTabEnabled(enabled: boolean): void {
  this.tabEnabled = enabled;
  // 视觉反馈：禁用时输入框边框变灰
  this.inputField.classList.toggle('tab-disabled', !enabled);
}

/**
 * 绑定聚焦变化 IPC 事件
 */
private bindFocusChangeHandler(): void {
  this.api.onFocusChange((appName: string | null) => {
    this.updateFocusIndicator(appName);
  });
}

/**
 * 绑定图钉按钮点击
 */
private bindPinToggle(): void {
  this.pinToggleEl.addEventListener('click', () => {
    const isActive = this.pinToggleEl.classList.toggle('active');
    this.pinToggleEl.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    void this.api.setAlwaysOnTop(isActive);
  });
}

/**
 * 切换常驻模式（手动覆盖自动检测）
 */
private togglePinnedMode(): void {
  this.pinnedMode = !this.pinnedMode;
  safeSet(STORAGE_KEY_PINNED, this.pinnedMode ? '1' : '0');
  this.updatePinnedToggle();
  // 通知主进程切换 pinned 状态
  void this.api.setPinnedMode(this.pinnedMode);
  // pinned 模式下显示图钉按钮
  this.pinToggleEl.toggleAttribute('hidden', !this.pinnedMode);
}
```

修改 `handleTab`：

```typescript
private handleTab(): void {
  if (this.isSubmitting) return;
  if (!this.tabEnabled) return;  // 新增：无聚焦时禁用 Tab
  void this.handleConfirm();
}
```

#### 4.5.4 channels.ts 改动

新增两个通道常量：

```typescript
/** 浮窗聚焦变化通知（主→渲染，传递当前聚焦应用名） */
QUICK_INPUT_FOCUS_CHANGE: 'quick-input-focus-change',
/** 设置浮窗 alwaysOnTop（渲染→主） */
QUICK_INPUT_SET_ALWAYS_ON_TOP: 'quick-input-set-always-on-top',
/** 设置浮窗 pinned 模式（渲染→主） */
QUICK_INPUT_SET_PINNED_MODE: 'quick-input-set-pinned-mode',
```

实际新增 3 个通道（FOCUS_CHANGE + SET_ALWAYS_ON_TOP + SET_PINNED_MODE），IPC 总数 114 → 117，仍低于 130 阈值。

#### 4.5.5 preload-quick-input.ts 改动

新增 3 个 API：

```typescript
onFocusChange: (callback: (appName: string | null) => void) =>
  ipcRenderer.on('quick-input-focus-change', (_e, appName) => callback(appName)),
setAlwaysOnTop: (value: boolean) =>
  ipcRenderer.invoke('quick-input-set-always-on-top', value),
setPinnedMode: (pinned: boolean) =>
  ipcRenderer.invoke('quick-input-set-pinned-mode', pinned),
```

#### 4.5.6 quickInputWindow.ts 改动

新增 `QUICK_INPUT_SET_PINNED_MODE` IPC handler：

```typescript
ipcMain.handle(IPC_CHANNELS.QUICK_INPUT_SET_PINNED_MODE, (_event, pinned: boolean) => {
  this.setPinnedMode(pinned);
  return { success: true };
});
```

修改 `win.on('blur')` 和 `win.on('focus')`：

```typescript
win.on('blur', () => {
  if (this.suppressBlurClose || this.pinnedMode) return;
  this.scheduleBlurClose();
  // 通知渲染进程：焦点已离开浮窗
  this.notifyFocusChange(null);
});
win.on('focus', async () => {
  this.cancelBlurClose();
  // 重新捕获前台窗口（浮窗自身 focus 时，前台窗口是浮窗，需排除）
  // 实际上浮窗 focus 时 pasteCoordinator.previousWindow 仍是 show 时捕获的，无需重新捕获
  // 仅通知渲染进程：焦点已回到浮窗，恢复显示
  const appName = await this.getCapturedAppName();
  this.notifyFocusChange(appName);
});
```

新增辅助方法：

```typescript
/**
 * 通知渲染进程聚焦变化
 */
private notifyFocusChange(appName: string | null): void {
  if (this.win && !this.win.isDestroyed()) {
    this.win.webContents.send(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_FOCUS_CHANGE, appName);
  }
}

/**
 * 获取当前捕获窗口的应用名（委托 pasteCoordinator）
 */
private async getCapturedAppName(): Promise<string | null> {
  return this.pasteCoordinator.getCapturedAppName();
}
```

`show()` 末尾追加：

```typescript
// 通知渲染进程：当前捕获的前台窗口应用名
const appName = await this.pasteCoordinator.getCapturedAppName();
this.notifyFocusChange(appName);
```

---

### 4.6 Task E：pasteCoordinator 暴露应用名 getter

**文件**：`src/electron/windows/pasteCoordinator.ts`

新增方法：

```typescript
/**
 * 获取当前捕获窗口的应用名
 *
 * ActiveWindow 接口当前仅暴露 title（窗口标题），无 appName 字段。
 * v1 实现：返回窗口标题前缀（多数 OS 窗口标题格式为 "{文档名} - {应用名}"，
 * 取末段应用名；若格式不符则返回完整标题）。
 * v2 规划：inputInjector 升级时增加 getProcessName 能力，返回真实应用名。
 *
 * @returns 应用名（无捕获时返回 null）
 */
async getCapturedAppName(): Promise<string | null> {
  if (!this.previousWindow) return null;
  try {
    const title = await this.previousWindow.title;
    // 窗口标题格式约定："{文档} - {应用名}"，取末段
    const parts = title.split(' - ');
    return parts.length > 1 ? parts[parts.length - 1].trim() : title;
  } catch {
    return null;
  }
}
```

**v1 限制说明**：不同 OS / 应用窗口标题格式不一致（macOS 多为 "{应用名} — {文档}"，Windows 多为 "{文档} - {应用名}"），split 启发式可能误判。v1 接受此误差，v2 由 inputInjector 升级补 getProcessName。

---

### 4.7 Task F：测试覆盖

#### 4.7.1 inputAreaManager.test.ts（Bug 1 验证）

新增测试：

```typescript
describe('Bug 1 修复：Enter 发送时清候选', () => {
  it('Enter 发送消息时调用 completion.clear()', async () => {
    manager.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(completion.clear).toHaveBeenCalledTimes(1);
  });

  it('点击发送按钮时调用 completion.clear()', () => {
    manager.handleClick();
    expect(completion.clear).toHaveBeenCalledTimes(1);
  });
});
```

#### 4.7.2 quickInput.test.ts（模式字段重构）

- 所有 `streamMode` 引用替换为 `pinnedMode`
- `restoreStreamState` 测试改为 `restorePinnedState`
- `toggleStreamMode` 测试改为 `togglePinnedMode`
- `updateStreamToggle` 测试改为 `updatePinnedToggle`
- `scheduleSuccessToast` 测试：移除 streamMode 分支测试，仅保留 default 行为测试

新增测试：

```typescript
describe('pinned 模式行为', () => {
  it('togglePinnedMode 切换字段 + 持久化 + 通知主进程', () => {});
  it('pinned 模式下显示图钉按钮（hidden=false）', () => {});
  it('default 模式下隐藏图钉按钮（hidden=true）', () => {});
  it('图钉按钮点击切换 alwaysOnTop', () => {});
  it('updateFocusIndicator 有聚焦时显示应用名 + 激活 Tab', () => {});
  it('updateFocusIndicator 无聚焦时显示"无聚焦" + 禁用 Tab', () => {});
  it('handleTab 在 tabEnabled=false 时不触发 handleConfirm', () => {});
});
```

#### 4.7.3 quickInputWindow.test.ts

新增测试：

```typescript
describe('pinned 模式 IPC', () => {
  it('setPinnedMode(true) 持久 suppressBlurClose', () => {});
  it('setPinnedMode(false) 恢复 blur 关闭', () => {});
  it('pinned 模式下 win.on("blur") 不触发 scheduleBlurClose', () => {});
  it('QUICK_INPUT_SET_ALWAYS_ON_TOP 调用 win.setAlwaysOnTop', () => {});
  it('QUICK_INPUT_SET_PINNED_MODE 调用 setPinnedMode', () => {});
  it('blur 时通过 QUICK_INPUT_FOCUS_CHANGE 通知 null', () => {});
  it('focus 时通过 QUICK_INPUT_FOCUS_CHANGE 通知应用名', () => {});
  it('copy 降级 + pinned 模式不 hide', () => {});
});
```

#### 4.7.4 pasteCoordinator.test.ts

新增测试：

```typescript
describe('getCapturedAppName', () => {
  it('previousWindow 为 null 时返回 null', () => {});
  it('标题 "inputAreaManager.ts - VSCode" 返回 "VSCode"', () => {});
  it('标题 "VSCode" 无分隔符返回完整标题', () => {});
  it('title Promise reject 时返回 null', () => {});
});
```

---

## 5. 排雷（沙盘推演）

### 5.1 雷清单

| # | 雷点 | 严重度 | 影响范围 | 缓解措施 |
|---|------|--------|---------|---------|
| 1 | `ActiveWindow` 接口无 appName 字段，仅 `title: Promise<string>` | 🟡 中 | 提示栏显示精度 | v1 用窗口标题 split 启发式取应用名；v2 由 inputInjector 升级补 getProcessName |
| 2 | `streamMode → pinnedMode` 重命名影响范围大，易遗漏 | 🟡 中 | quickInput.ts / quickInputWindow.ts / preload-quick-input.ts / 所有相关测试 | TypeScript strict 模式捕获类型错误；逐文件 grep `streamMode` 确认零残留 |
| 3 | 默认模式失焦关闭 + "连续输入"心智冲突：用户切走查看结果即关闭 | 🟢 低 | 用户体验 | 用户已决策"失焦仍关闭"；footer hint 已有 `Esc 关闭` 提示足够 |
| 4 | pinned 模式下用户切走，`pasteCoordinator.previousWindow` 仍是旧捕获 → 粘贴到错误窗口 | 🔴 高 | 功能正确性 | 浮窗 focus 事件触发 `capturePreviousWindow` 重新捕获前台窗口（仅 pinned 模式生效） |
| 5 | 图钉按钮在 default 模式下应禁用 | 🟢 低 | UI 一致性 | `#pin-toggle` 默认 hidden，仅 pinned 模式下显示 |
| 6 | localStorage 旧 key `memora-quick-input-stream` 残留 | 🟢 低 | 兼容性 | 忽略旧 key，不主动迁移；旧用户首次启动默认 default 模式（升级后的新默认） |
| 7 | 测试基线 4382 通过，重构后 streamMode 测试需全部更新 | 🟡 中 | 测试覆盖 | 分步实施：先重构字段+更新现有测试，再新增 pinned/图钉/提示栏测试 |
| 8 | IPC 通道数 114 → 117，仍在 130 阈值内 | 🟢 低 | 治理 | 无需治理，记录到下次治理评估 |
| 9 | pinned 模式 copy 降级 hide 行为 | 🟡 中 | 功能正确性 | copy 路径下 `if (!safePinnedMode) this.hide()` |
| 10 | pinned 模式 + 浮窗 blur 后 Tab 禁用，但 pasteCoordinator 仍持有旧窗口 → Tab 禁用语义与 paste 目标不一致 | 🟡 中 | 交互一致性 | 浮窗 blur → 提示栏"无聚焦" + Tab 禁用；浮窗 focus → 重新捕获 + 提示栏更新 + Tab 激活。用户必须先点回浮窗再 Tab |
| 11 | 窗口标题 split 启发式在 macOS 不稳定（"应用名 — 文档" 格式） | 🟡 中 | 提示栏显示精度 | v1 仅在 Windows 验证；macOS 用户接受误差；v2 由 inputInjector 升级补 getProcessName |
| 12 | pinned 模式持久 `suppressBlurClose=true`，浮窗如何关闭？ | 🟡 中 | 可用性 | Esc 始终关闭（`handleClose` 走 `closeQuickInput` IPC）；用户切到 default 模式后 blur 关闭；可选：pinned 模式下顶部增加显式关闭按钮 |
| 13 | 浮窗 focus 事件触发 `capturePreviousWindow` 时，浮窗自身是前台窗口，会被排除捕获 | 🟢 低 | 捕获正确性 | `capturePreviousWindow(floatTitle)` 已支持排除浮窗自身（pasteCoordinator.ts:54-65） |

### 5.2 优化方案（基于排雷）

#### 5.2.1 雷 4 缓解实施

```typescript
// quickInputWindow.ts
win.on('focus', async () => {
  this.cancelBlurClose();
  if (this.pinnedMode) {
    // pinned 模式下：用户切走再切回，重新捕获前台窗口（排除浮窗自身）
    await this.pasteCoordinator.capturePreviousWindow(this.win?.getTitle());
  }
  const appName = await this.pasteCoordinator.getCapturedAppName();
  this.notifyFocusChange(appName);
});
```

#### 5.2.2 雷 12 缓解实施

pinned 模式下顶部 `#focus-bar` 右侧增加显式关闭按钮（与图钉并列）：

```html
<button id="close-btn" class="close-btn" title="关闭浮窗（Esc）">
  <svg class="icon"><use href="#icon-close"/></svg>
</button>
```

绑定：

```typescript
this.closeBtnEl.addEventListener('click', () => {
  void this.api.closeQuickInput();
});
```

`#close-btn` 始终显示（无论 default / pinned 模式），作为显式关闭入口。

#### 5.2.3 雷 10 语义澄清

| 场景 | 提示栏 | Tab | paste 目标 |
|------|--------|-----|-----------|
| 浮窗显示 + 用户未切走 | "聚焦：{应用名}" | ✅ 激活 | pasteCoordinator.previousWindow（show 时捕获） |
| 浮窗显示 + 用户切走（blur） | "无聚焦" | ❌ 禁用 | pasteCoordinator.previousWindow 不变（但 Tab 已禁用无法触发 paste） |
| 浮窗显示 + 用户切回（focus） | "聚焦：{应用名}"（pinned 模式下重新捕获） | ✅ 激活 | pinned 模式下 pasteCoordinator.previousWindow 已更新；default 模式下不变 |

语义自洽：Tab 禁用时无法 paste，所以 paste 目标"陈旧"问题不会发生。

---

## 6. 实施顺序建议

按依赖关系分批提交，每批独立可回滚：

1. **批次 1（P0 独立）**：Task A — Bug 1 修复（+2 行）
2. **批次 2（P1 字段重构）**：Task B — `streamMode → pinnedMode` + 测试更新
3. **批次 3（P1 pinned 行为）**：Task C — `setPinnedMode` + alwaysOnTop IPC + 测试
4. **批次 4（P1 UI 增强）**：Task D + E — 聚焦提示栏 + 图钉按钮 + 关闭按钮 + pasteCoordinator.getCapturedAppName + 测试
5. **批次 5（P2 测试补全）**：Task F — 剩余测试覆盖

每批次完成后跑 `npm test` 确认基线绿，再进入下一批次。

---

## 7. 验收场景

### 7.1 Bug 1 验收

- [ ] 主窗口输入"测"→ 候选弹出 → Enter 发送 → 候选立即消失
- [ ] 主窗口输入"测"→ 候选弹出 → 点击发送按钮 → 候选立即消失

### 7.2 默认模式验收

- [ ] 唤起浮窗 → 输入 → Tab 提交 → 浮窗不关闭，输入框清空，等待下次输入
- [ ] 默认模式下点击其他窗口 → 浮窗 200ms 后关闭
- [ ] 默认模式下 Esc → 浮窗关闭
- [ ] 默认模式下 footer 显示 🔓 图标，title="常驻模式关闭"

### 7.3 常驻模式验收

- [ ] 点击 🔓 图标切换为 🔒 → 进入 pinned 模式 → 图钉按钮显示
- [ ] pinned 模式下 Tab 提交 → 浮窗不关闭 + 输入框清空
- [ ] pinned 模式下点击其他窗口 → 浮窗不关闭
- [ ] pinned 模式下点击图钉按钮 → alwaysOnTop 切换为 false → 浮窗可被其他窗口遮挡
- [ ] pinned 模式下 Esc → 浮窗关闭
- [ ] pinned 模式下点击顶部关闭按钮 → 浮窗关闭

### 7.4 聚焦提示栏验收

- [ ] 唤起浮窗（前台为 VSCode）→ 顶部显示"聚焦：VSCode"
- [ ] 切走浮窗（blur）→ 顶部显示"无聚焦" + Tab 禁用
- [ ] 切回浮窗（focus）→ 顶部显示"聚焦：{应用名}" + Tab 激活
- [ ] pinned 模式下切走再切回 → 重新捕获前台窗口，提示栏更新

### 7.5 敏感内容验收

- [ ] 剪贴板含 token 时唤起浮窗 → 自动进入 pinned 模式 + 图钉按钮显示
- [ ] pinned 模式下手动切回 default 模式 → localStorage 持久化 default 偏好

### 7.6 兼容性验收

- [ ] 旧用户 localStorage 残留 `memora-quick-input-stream` 不影响新行为
- [ ] 新用户首次启动默认 default 模式（连续输入）

---

## 8. 影响文件清单

| # | 文件 | 改动类型 | 行数估算 |
|---|------|---------|---------|
| 1 | `src/electron/renderer/panels/inputAreaManager.ts` | 修改（Bug 1） | +2 |
| 2 | `src/electron/renderer/quick-input/quickInput.ts` | 修改（字段重构 + 提示栏 + 图钉 + Tab 禁用） | +120 / -40 |
| 3 | `src/electron/renderer/quick-input/quick-input.html` | 修改（顶部 focus-bar DOM + SVG） | +20 |
| 4 | `src/electron/renderer/quick-input/quick-input.css` | 修改（focus-bar + pin-toggle + close-btn 样式） | +50 |
| 5 | `src/electron/windows/quickInputWindow.ts` | 修改（pinned 持久抑制 + 3 个 IPC + focus/blur 通知） | +80 / -20 |
| 6 | `src/electron/windows/pasteCoordinator.ts` | 修改（getCapturedAppName 新增） | +25 |
| 7 | `src/electron/preload-quick-input.ts` | 修改（3 个新 API + 参数重命名） | +15 / -2 |
| 8 | `src/electron/ipc/channels.ts` | 修改（3 个新通道常量） | +6 |
| 9 | `src/electron/renderer/quick-input/__tests__/quickInput.test.ts` | 修改（字段重构测试 + 新增 pinned/提示栏测试） | +80 / -30 |
| 10 | `src/electron/renderer/panels/__tests__/inputAreaManager.test.ts` | 修改（Bug 1 测试） | +15 |
| 11 | `src/electron/windows/__tests__/quickInputWindow.test.ts` | 修改（pinned IPC + 聚焦通知测试） | +60 |
| 12 | `src/electron/windows/__tests__/pasteCoordinator.test.ts` | 修改（getCapturedAppName 测试） | +25 |

**总估算**：+498 / -94，净增 ~404 行。

---

## 9. 待确认事项

| # | 事项 | 默认决策 |
|---|------|---------|
| 1 | v1 用窗口标题 split 启发式取应用名是否可接受 | ✅ 接受，v2 由 inputInjector 升级补 getProcessName |
| 2 | pinned 模式下是否新增顶部显式关闭按钮 | ✅ 新增（雷 12 缓解） |
| 3 | default 模式下是否隐藏图钉按钮 | ✅ 隐藏（仅 pinned 模式显示） |
| 4 | 浮窗 focus 事件触发 `capturePreviousWindow` 是否仅 pinned 模式生效 | ✅ 仅 pinned（default 模式用户切走即关闭，无需重新捕获） |

---

> **后续衔接**：用户确认方案后可触发 `方案更新 输入补全模块升维方案` 进入执行，或继续 `排雷` 深挖特定雷点。
