# 输入补全模块重思方案

> **模块范围**：`quick-input/`（快速输入浮窗补全）+ `panels/inputAreaManager.ts`（主窗口输入框补全）+ `quickInputCompletion.ts`（共享补全管理器）
> **触发原因**：用户反馈"快捷键呼出的窗口无法正确显示数据，但直接按 Tab 能补全"
> **产出时间**：2026-07-11

---

## 1. 现状分析

### 1.1 功能架构

输入补全模块服务于两个场景：

| 场景 | 入口 | 候选列表容器 | 定位策略 | 窗口高度调整 |
|------|------|------------|---------|------------|
| 主窗口输入框 | 用户在 textarea 输入时自动触发 | `#chat-completion-list` | 绝对定位在输入框**上方**（`bottom: 100%`） | 不需要（主窗口固定大小） |
| 快速输入浮窗 | 全局快捷键呼出 → 用户在 input 输入 | `#completion-list` | 绝对定位在输入框**下方**（`top: 100%`） | 需要（浮窗高度动态调整） |

两个场景共用 `QuickInputCompletion` 类（泛化支持 `HTMLInputElement | HTMLTextAreaElement`），职责清晰。

### 1.2 数据流

```
用户输入 → 防抖 300ms → 并行 IPC（searchMemories + searchSessionMessages）
→ 合并去重 + 排序 → 取 Top-5 → 渲染候选列表 DOM
→ onListChange 回调 → 窗口高度调整（仅浮窗）
```

### 1.3 问题定位

**核心 bug**：快捷键呼出的快速输入浮窗中，候选列表不可见。

| 维度 | 分析 |
|------|------|
| **现象** | 用户输入文本后，候选列表不显示；但按 ↓ 选中（不可见）后按 Tab，文本能回填到输入框 |
| **根因** | `quick-input.css` 中 `.quick-input-container` 缺少 `position: relative`，导致 `.completion-list` 的 `position: absolute; top: 100%` 相对于初始包含块（viewport）而非容器定位。候选列表被定位到 viewport 底部以下，被 `html, body { overflow: hidden }` 裁剪 |
| **对比** | 主窗口 `#input-area` 明确设置了 `position: relative`（[chat-messages.css:830](../src/electron/renderer/styles/chat-messages.css)），所以主窗口补全正常 |
| **影响** | 快速输入浮窗的补全功能完全不可用（用户看不到候选列表） |

---

## 2. 系统性审查：功能闭环问题清单

### P1（必须修复 — 功能阻断）

| # | 问题 | 文件 | 修复方案 |
|---|------|------|---------|
| 1 | `.quick-input-container` 缺少 `position: relative`，候选列表绝对定位参照系错误 | `quick-input.css` | 添加 `position: relative` 到 `.quick-input-container` |

### P2（应修复 — 体验缺陷）

| # | 问题 | 文件 | 修复方案 |
|---|------|------|---------|
| 2 | 窗口高度调整时序：候选列表渲染后到 IPC 调整窗口高度完成之间有闪烁 | `quickInput.ts` | 渲染前先隐藏列表，窗口高度调整完成后再显示（或先调整高度再渲染） |
| 3 | `focus` 事件每次清空输入框：用户 Alt+Tab 切走再回来，输入内容丢失 | `quickInput.ts` | 仅在窗口首次显示（`show()` 调用）时清空，不在每次 focus 时清空 |

### P3（可改进 — 完善性）

| # | 问题 | 文件 | 修复方案 |
|---|------|------|---------|
| 4 | Tab 无选中项时不补全：用户期望"直接 Tab 补全第一项" | `quickInputCompletion.ts` | Tab 时若无选中项（`selectedIndex = -1`）且候选列表非空，自动选中第一项 |
| 5 | 浮窗关闭时 `QuickInputCompletion.cleanup()` 未调用 | `quickInput.ts` | 浮窗单例复用不需要 cleanup，但 `destroy()` 时应调用。当前 `destroy()` 在 `quickInputWindow.ts` 中只清理 IPC handler 和定时器，未清理渲染进程的补全管理器 |

---

## 3. 修复方案

### 3.1 P1-1：CSS 定位参照系修复

**文件**：`hosts/memora-sprite/src/electron/renderer/quick-input/quick-input.css`

**变更**：在 `.quick-input-container` 中添加 `position: relative`，使 `.completion-list` 的 `position: absolute; top: 100%` 相对于容器定位。

```css
.quick-input-container {
  position: relative;  /* 新增：补全候选列表绝对定位参照系 */
  width: 100%;
  height: 100%;
  /* ... 其余不变 */
}
```

### 3.2 P2-2：窗口高度调整时序优化

**文件**：`hosts/memora-sprite/src/electron/renderer/quick-input/quickInput.ts`

**变更**：调整 `onListChange` 回调，在显示候选列表前先调整窗口高度，避免闪烁。

当前流程：渲染 DOM → 显示列表 → 调整高度（IPC 异步，有闪烁）
优化流程：渲染 DOM → 调整高度 → 高度调整完成后显示列表

但考虑 IPC 异步延迟极小（同进程 IPC ~1ms），且闪烁窗口极短，此优化的 ROI 较低。建议**暂不实施**，仅在用户反馈闪烁时再处理。

### 3.3 P2-3：focus 事件清空输入框优化

**文件**：`hosts/memora-sprite/src/electron/renderer/quick-input/quickInput.ts`

**变更**：将"每次 focus 清空输入框"改为"窗口 show 时清空"。

当前逻辑：
```js
window.addEventListener('focus', () => {
  inputField.value = '';
  // ...
});
```

问题：focus 事件在每次窗口获得焦点时触发，包括 Alt+Tab 切走再回来。

修复方案：通过 IPC 通知渲染进程"窗口被 show() 调用"（而非 focus 事件）。但这需要新增 IPC 通道，改动较大。

**替代方案**（更简单）：用一个标志位区分"首次显示"和"重新获得焦点"：

```js
let isFirstShow = true;
window.addEventListener('focus', () => {
  if (isFirstShow) {
    inputField.value = '';
    isFirstShow = false;
  }
  inputField.focus();
});
```

但此方案有问题：浮窗单例复用，第二次 show() 时 `isFirstShow` 已是 false，输入框不会被清空。

**最终方案**：由主进程 `show()` 后通过 IPC 通知渲染进程清空。复用现有 `QUICK_INPUT_RESIZE` IPC 的模式，新增一个 `QUICK_INPUT_SHOW` 事件（主进程 → 渲染进程，`webContents.send`）。

但考虑改动范围和 ROI，建议**暂不实施**，归档待办。

### 3.4 P3-4：Tab 自动选中第一项

**文件**：`hosts/memora-sprite/src/electron/renderer/quick-input/quickInputCompletion.ts`

**变更**：Tab 时若无选中项且候选列表非空，自动选中第一项并回填。

```js
} else if (ke.key === 'Tab') {
  if (this.candidates.length === 0) return;
  ke.preventDefault();
  // 无选中项时默认选中第一项
  const idx = this.selectedIndex >= 0 ? this.selectedIndex : 0;
  const selected = this.candidates[idx]!;
  this.onSelectCallback?.(selected.text);
  this.clearCandidates();
}
```

但此变更可能影响主窗口的 Tab 行为（Tab 在主窗口 textarea 中有默认行为：缩进/聚焦下一元素）。需要确认是否在主窗口也启用"Tab 自动补全第一项"。

**建议**：仅在快速输入浮窗中启用此行为，主窗口保持原有逻辑（需要先 ↓ 选中再 Tab 确认）。这需要在 `QuickInputCompletion` 类中新增配置项。

考虑改动范围和 ROI，建议**暂不实施**，归档待办。

### 3.5 P3-5：destroy 时清理补全管理器

**文件**：`hosts/memora-sprite/src/electron/windows/quickInputWindow.ts`

**变更**：浮窗 `destroy()` 时通知渲染进程调用 `cleanup()`。

但渲染进程的 `QuickInputCompletion` 实例在浮窗的渲染进程中，主进程无法直接调用。需要通过 IPC 通知渲染进程。

当前浮窗 `destroy()` 直接 `win.destroy()`，渲染进程的资源会被浏览器自动回收。`cleanup()` 的主要作用是移除事件监听器，但窗口销毁后监听器自然失效。

**结论**：不需要修复，窗口销毁时浏览器自动清理资源。

---

## 4. 执行计划

| 优先级 | 问题 | 方案 | 是否本轮执行 |
|--------|------|------|------------|
| P1 | CSS 定位参照系 | 添加 `position: relative` | ✅ 本轮执行 |
| P2 | 窗口高度闪烁 | 调整渲染时序 | ❌ 归档待办（ROI 低） |
| P2 | focus 清空输入框 | 新增 IPC 通知 | ❌ 归档待办（改动大） |
| P3 | Tab 自动补全第一项 | 修改 handleKeyDown | ❌ 归档待办（需区分场景） |
| P3 | destroy 清理 | 无需修复 | ❌ 浏览器自动回收 |

**本轮仅执行 P1 修复**（1 行 CSS 变更），其余归档到待完成任务。

---

## 5. 验证清单

| 验证项 | 操作 | 预期 |
|--------|------|------|
| 浮窗补全显示 | 快捷键呼出浮窗 → 输入 ≥2 字符 | 候选列表在输入框下方可见 |
| 浮窗补全 Tab 回填 | ↓ 选中候选项 → Tab | 文本回填到输入框 |
| 浮窗补全点击 | 鼠标点击候选项 | 文本回填到输入框 |
| 浮窗高度调整 | 候选列表显示/隐藏 | 窗口高度动态调整 |
| 浮窗 Esc 关闭 | 按 Esc | 浮窗关闭 |
| 主窗口补全不受影响 | 主窗口输入框输入 ≥2 字符 | 候选列表在输入框上方可见 |
