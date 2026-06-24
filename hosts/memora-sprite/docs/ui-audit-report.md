# Memora 精灵 UI 审核报告

> 审核范围：`src/electron/renderer/` 全部 HTML / CSS / TS 文件
> 审核标准：Vercel Web Interface Guidelines + 专业 UI/UX 审计
> 审核日期：2026-06-24

---

## 一、总体评价

这是一个完成度较高的 Electron 桌面应用 UI，整体架构清晰（CSS 变量系统 + 组合式 TS 管理器），设计系统完整（双主题、响应式、动画令牌化）。代码注释详尽，ADR 决策记录规范。以下按严重程度分级列出发现的问题。

**评分概览：**

| 维度 | 评分 | 说明 |
|------|------|------|
| 可访问性 (A11y) | B+ | 大部分按钮已有 aria-label，但存在遗漏和焦点管理缺陷 |
| 交互规范 | A- | 键盘快捷键、智能滚动、状态反馈做得好 |
| 视觉一致性 | A | CSS 变量系统完整，双主题对齐度高 |
| 表单规范 | B | 部分输入框缺少 label 关联、autocomplete 属性 |
| 动画/性能 | A- | 已尊重 prefers-reduced-motion，但存在少量 transition: all 残留风险 |
| 内容/排版 | B+ | 省略号规范、数字排版基本合规 |

---

## 二、问题清单（按严重程度排序）

### P0 — 必须修复（影响可用性/安全）

#### 2.1 深色主题下 `<select>` 原生控件可能不可见

**文件：** `base.css:117` / `settings.css:205`
**问题：** 深色主题下，Windows/macOS 原生 `<select>` 下拉框的背景色和文字色由系统控制，不一定跟随 CSS 变量。当前仅设置了 `color: var(--text)` 和 `background: var(--window-bg)`，但原生下拉弹出层（dropdown）的样式无法通过 CSS 控制。
**修复建议：** 添加 `color-scheme: dark` 到 `[data-theme="dark"]` 的 `:root` 或 `html` 元素，让浏览器原生控件自动适配深色模式。

```css
/* base.css 深色主题块顶部添加 */
[data-theme="dark"] {
  color-scheme: dark;
}
```

#### 2.2 `<meta name="theme-color">` 缺失

**文件：** `index.html:3` / `float.html:3`
**问题：** 缺少 `<meta name="theme-color">`，在某些环境下（如 PWA、任务栏预览）窗口标题栏颜色不会跟随主题变化。
**修复建议：** 在 `<head>` 中添加，并通过 JS 在主题切换时动态更新。

#### 2.3 设置面板"离开确认"但无 `beforeunload` 保护

**文件：** `ui.ts:432-444`
**问题：** `switchPanel` 中检查了设置面板的 dirty 状态并弹出确认框，但用户直接关闭窗口/刷新页面时不会触发此保护。未保存的 LLM 配置（含 API Key）会丢失。
**修复建议：** 在 `renderer.ts` 中注册 `window.onbeforeunload`，当 `settingsPanelManager.isDirty()` 为 true 时返回确认字符串。

---

### P1 — 应该修复（影响体验/规范合规）

#### 2.4 仪表盘数字缺少 `font-variant-numeric: tabular-nums`

**文件：** `layout.css:248-253` (`.dash-value`)
**问题：** 仪表盘中的数字（记忆数、洞察数等）在变化时会导致布局抖动，因为等宧行为未启用。数字"1"和"888"宽度不同，切换时侧边栏会微移。
**修复建议：**

```css
.dash-value {
  font-variant-numeric: tabular-nums;
}
```

#### 2.5 记忆搜索框和设置输入框缺少 `autocomplete="off"`

**文件：** `index.html:236` (`#memory-search`) / `index.html:306` (`#cfg-llm-provider`)
**问题：** 非认证字段的输入框未设置 `autocomplete="off"`，浏览器密码管理器可能在不恰当的位置弹出自动填充建议。
**修复建议：** 对所有非 email/password/auth 的输入框添加 `autocomplete="off"`。

#### 2.6 弹窗缺少 `overscroll-behavior: contain`

**文件：** `modal.css:9-21` (`.modal`)
**问题：** 弹窗内容滚动到边界时，滚动事件会穿透到背景页面，导致背景页面跟着滚动（overscroll chaining）。
**修复建议：**

```css
.modal {
  overscroll-behavior: contain;
}
```

#### 2.7 `#messages` 区域大列表无虚拟化

**文件：** `chat.css:541-550` / `ui.ts` (ChatPanelManager)
**问题：** 消息列表直接 DOM 渲染，无虚拟化。长对话（数百条消息）时可能导致 DOM 节点过多，影响滚动性能。当前有"加载更多"分页机制缓解，但已加载的消息仍全量在 DOM 中。
**修复建议：** 中期可考虑 `content-visibility: auto` 对不可见消息做渲染延迟；长期考虑虚拟滚动。

#### 2.8 主动提示 banner 关闭按钮位置与 actions 按钮重叠风险

**文件：** `chat.css:341-363` / `index.html:191-199`
**问题：** `.banner-close` 使用 `position: absolute; right: 8px`，而 `.banner-actions` 在右侧 flex 排列。当 banner 文字较短时，关闭按钮可能与 actions 按钮视觉重叠。
**修复建议：** 给 `.banner-text` 添加 `margin-right: 30px` 为关闭按钮留出空间，或调整布局确保关闭按钮不与 actions 重叠。

#### 2.9 会话下拉菜单的删除/重命名按钮始终可见（`opacity: 0.45`）

**文件：** `chat.css:169-203`
**问题：** 注释说"主动可见（非 hover-only）"，但 `opacity: 0.45` 在视觉上接近隐藏，既不够明显又占据了点击区域，可能造成误触。这违反了"要么可见要么隐藏"的交互原则。
**修复建议：** 改为真正的 hover-only 显示（`opacity: 0` → hover `opacity: 1`），或在每个会话项右侧添加明确的"..."更多操作按钮。

#### 2.10 `<html lang="zh">` 但缺少 `<meta name="theme-color">`

（同 2.2，此处强调：深色主题下 `theme-color` 尤为重要）

---

### P2 — 建议优化（提升品质）

#### 2.11 省略号规范：部分 placeholder 使用 `...` 而非 `…`

**文件：** `index.html:174` (`placeholder="搜索会话..."`)
**问题：** Web Interface Guidelines 要求使用真正的省略号字符 `…`（U+2026）而非三个点 `...`。
**修复建议：** 全局搜索 `...` 并替换为 `…`（注意区分真正的省略语义和代码中的 spread operator）。

#### 2.12 标题层级不完整

**文件：** `index.html`
**问题：** 页面缺少 `<h1>` 元素。当前最高层级是侧边栏的 `<span>Memora</span>`（非语义标签），然后跳到各处的 `<h3>`。语义层级不连贯。
**修复建议：** 给 `.sidebar-brand` 中的品牌名使用 `<h1>` 或添加 `role="banner"`；确保 heading 层级从 h1 开始递减。

#### 2.13 输入框 textarea 缺少 `name` 属性

**文件：** `index.html:218` (`#input`)
**问题：** `<textarea id="input">` 缺少 `name` 属性。虽然当前不涉及表单提交，但 `name` 属性对可访问性（屏幕阅读器识别表单字段用途）和未来可能的自动保存有帮助。
**修复建议：** 添加 `name="message"` 或 `name="chat-input"`。

#### 2.14 `touch-action: manipulation` 缺失

**文件：** `base.css:206-210` (全局重置)
**问题：** 按钮和可点击元素未设置 `touch-action: manipulation`，在触屏设备上会有 300ms 双击缩放延迟。
**修复建议：** 在全局重置中为 `button, a, [role="button"]` 添加 `touch-action: manipulation`。

#### 2.15 消息气泡 `max-width: 80%` 在窄窗口下可能过窄

**文件：** `chat.css:559`
**问题：** 消息容器设置了 `max-width: 80%`，在响应式窄屏（侧边栏收窄为 64px 时）可用宽度减少，80% 可能导致消息气泡过窄，长文本阅读体验差。
**修复建议：** 在中屏媒体查询中适当放宽，如 `max-width: 90%`。

#### 2.16 浮动窗口 CSS 变量与 base.css 存在重复定义风险

**文件：** `float.html:19-103` / `base.css:14-203`
**问题：** `float.html` 内联了完整的 CSS 变量系统（浅色 + 深色），注释说"与 base.css 保持 1:1 对齐"。两套变量手动同步，容易在修改 base.css 时遗漏 float.html。
**修复建议：** 中期考虑将共享变量提取为独立 CSS 文件，两个 HTML 共同引用；或建立构建时同步机制。

#### 2.17 按钮文案可以更具体

**文件：** `index.html:528-532`
**问题：** 设置面板底部有"恢复默认"、"稍后配置"、"取消"、"保存"四个按钮。"取消"和"稍后配置"语义重叠，可能让用户困惑。
**修复建议：** 考虑合并或重新定义："恢复默认"保留，"取消"改为"放弃更改"，"稍后配置"改为"跳过"（首次配置场景）。

---

### P3 — 锦上添花（细节打磨）

#### 2.18 `font-variant-numeric: tabular-nums` 也适用于 Agent 指标

**文件：** `layout.css:248-253`（同 2.4，但 Agent 指标区的 `.dash-value` 也需要）

#### 2.19 `text-wrap: balance` 可用于空状态标题

**文件：** `chat.css:959-965` (`.empty-title`)
**问题：** 欢迎标题"你好，我是 Memora 精灵"在窄屏下可能产生孤字换行。
**修复建议：** 添加 `text-wrap: balance`。

#### 2.20 深色主题下 `color-scheme` 应显式声明

**文件：** `base.css:118`
**问题：** 同 2.1，`color-scheme: dark` 不仅影响原生控件，还会影响滚动条颜色。当前自定义了 `::-webkit-scrollbar`，但 `color-scheme` 声明可以让未自定义的滚动条场景也正确适配。

#### 2.21 品牌名 "Memora" 应添加 `translate="no"`

**文件：** `index.html:34` 等多处
**问题：** 如果未来支持多语言或浏览器自动翻译，品牌名 "Memora" 可能被错误翻译。
**修复建议：** 在品牌名 `<span>` 上添加 `translate="no"`。

#### 2.22 图片预加载可优化

**文件：** `float.html:325` (`#sphere-image`)
**问题：** `<img>` 已设置 `width/height`（防止 CLS，做得好），但 `display: none` 的图片仍会被浏览器加载。如果未来启用图片形态，应添加 `loading="lazy"`。

---

## 三、做得好的地方（值得保留）

1. **CSS 变量系统设计优秀** — 双主题变量命名规范（`--accent-20`、`--tag-profile-bg`），语义色完整，注释清晰标注了每个 ADR 决策。

2. **可访问性基础扎实** — 关键交互元素（角色选择器、浮动球体、记忆搜索框）已添加 `role`、`tabindex`、`aria-label`；`aria-live="polite"` 用于 toast 容器。

3. **`prefers-reduced-motion` 全面覆盖** — base.css 全局禁用动画，float.html 和 layout.css 的局部动画也单独处理，尊重用户系统偏好。

4. **焦点管理规范** — 使用 `:focus-visible` 而非 `:focus`，鼠标点击不显示焦点环；弹窗打开/关闭有焦点保存和恢复（`ModalManager.previousFocusEl`）。

5. **组合式架构** — UIManager 通过组合持有独立子模块（Toast/Modal/Theme/各 PanelManager），职责清晰，cleanup 统一管理，避免内存泄漏。

6. **事件跟踪器模式** — `EventTracker` 统一管理事件监听器的注册与清理，避免忘记 `removeEventListener`。

7. **错误状态处理完整** — 面板加载失败有统一错误横幅 + 重试按钮（`FD-A2`），流式输出错误有注入提示（`stream-error`），工具调用有三态卡片。

8. **智能滚动** — `isNearBottom` 判断避免打断用户的历史消息查看，仅当用户在底部附近时自动滚到底部。

9. **CSS transition 属性列表化** — 大部分 transition 已从 `all` 改为具体属性列表（`background var(--transition-fast), color var(--transition-fast)`），注释标注了 `UI-AUDIT`。

10. **XSS 防护** — 使用 `textContent` 而非 `innerHTML` 设置消息内容，从架构层面防止 XSS。

---

## 四、修复优先级建议

| 优先级 | 问题编号 | 预估工作量 | 影响范围 |
|--------|---------|-----------|---------|
| 立即 | 2.1 (color-scheme) | 1 行 CSS | 深色主题原生控件 |
| 立即 | 2.3 (beforeunload) | ~10 行 TS | 设置面板数据丢失风险 |
| 本周 | 2.4 (tabular-nums) | 1 行 CSS | 仪表盘数字抖动 |
| 本周 | 2.6 (overscroll) | 1 行 CSS | 弹窗滚动穿透 |
| 本周 | 2.8 (banner 布局) | 3 行 CSS | banner 关闭按钮遮挡 |
| 本周 | 2.9 (会话操作按钮) | 5 行 CSS | 误触风险 |
| 下周 | 2.2 (theme-color) | 3 行 HTML+TS | 任务栏颜色 |
| 下周 | 2.5 (autocomplete) | 批量 HTML 属性 | 密码管理器干扰 |
| 下周 | 2.11 (省略号) | 批量替换 | 排版规范 |
| 下周 | 2.12 (heading 层级) | 5 行 HTML | 语义 HTML |
| 低优 | 2.7 (虚拟化) | 较大重构 | 长对话性能 |
| 低优 | 2.16 (变量同步) | 架构调整 | 维护成本 |

---

## 五、关于"能做到什么程度"的回答

**我能直接做的：**
- 修改项目源代码中的 CSS / HTML / TS 文件，直接修复上述 P0-P2 问题
- 出具具体的代码修改方案并直接 apply

**建议的执行方式：**
1. **直接修改项目代码**（推荐）— 我可以直接编辑 `base.css`、`layout.css`、`chat.css`、`index.html`、`ui.ts`、`renderer.ts` 等文件，逐项修复
2. **先出调整方案** — 如果你希望先审核方案再动手，我可以先列出每项修改的 diff 预览

**不适合我做的：**
- 运行时视觉测试（需要启动 Electron 应用）
- 原生控件在不同操作系统上的实际表现验证
- 性能基准测试（需要真实数据量）

---

*报告结束。如需我直接修改代码，请告知优先处理哪些问题。*
