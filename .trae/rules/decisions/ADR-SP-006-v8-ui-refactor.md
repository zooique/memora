---
alwaysApply: false
description: "memora-sprite 宿主：v8 UI 重构——双主题 CSS 变量系统 + 悬浮核心窗口"
---

# ADR-SP-006 · v8 UI 重构

> **状态**：✅ 已接受（2026-06-20）
> **依赖**：[ADR-SP-003](./ADR-SP-003-desktop-shell.md)（桌面壳分阶段策略）、[ADR-SP-004](./ADR-SP-004-perception.md)（精灵感知原则）

## 背景

精灵初始 UI 采用 Catppuccin Mocha 深色主题（`#1e1e2e` 底色），与 Trae Work 等现代桌面应用的浅色 + 悬浮核心窗口风格存在视觉代差。`docs/demo-new-ui-v8.html` 作为新 UI 风格的设计参考，确立了以下设计语言：

1. **大底板 + 悬浮核心窗口**：左侧栏与顶部栏连成同色大底板（`#f0f0f2`），核心窗口通过 `margin` + `border-radius` + `box-shadow` 形成白色悬浮效果
2. **浅色为默认基调**：从深色优先迁移到浅色优先，符合主流桌面应用习惯
3. **圆角与阴影系统**：`--radius-sm/md/lg/xl` 四级圆角 + `--shadow-float` 悬浮阴影
4. **语义化色彩**：`--accent`（蓝）、`--green`（成功）、`--yellow`（警告）作为功能色

需要决定如何将现有 Sprite 界面全量迁移至 v8 风格，同时保留深色主题作为备选。

## 决策

**采用双主题 CSS 变量系统 + grid 布局，分 5 个迭代（iter-0 ~ iter-4）逐步迁移。**

### 1. 双主题 CSS 变量系统

- **浅色默认**（`:root`）：`--bg: #f0f0f2`、`--window-bg: #ffffff`、`--text: #1e1e2e`
- **深色备选**（`[data-theme="dark"]`）：保留 Catppuccin Mocha 色板作为深色映射
- **向后兼容**：保留现有变量名（`--bg`/`--surface0`/`--text`），新增 v8 语义变量（`--shell-bg`/`--window-bg`/`--window-bg-2`/`--text-2`/`--text-3`/`--surface2`/`--radius-sm|md|lg|xl`/`--shadow-float`）
- **持久化**：通过 `localStorage.getItem('memora-theme')` 读取，`document.documentElement.setAttribute('data-theme', 'dark')` 切换
- **闪屏避免**：在 `index.html` 和 `float.html` 的 `<head>` 中内联同步脚本，CSS 加载前读取主题设置

### 2. Grid 布局（大底板 + 悬浮核心窗口）

```css
.app-shell {
  display: grid;
  grid-template-areas:
    "sidebar topbar"
    "sidebar main";
  grid-template-columns: 56px 1fr;
  grid-template-rows: 48px 1fr;
  height: 100vh;
  background: var(--shell-bg); /* 大底板同色 */
}
.app-main {
  margin: 0 12px 12px 0;        /* 与底板形成间隙 */
  background: var(--window-bg); /* 白色悬浮 */
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-float);
}
```

### 3. 迭代计划

| 迭代 | 交付内容 | 状态 |
|------|---------|------|
| iter-0 | 双主题 CSS 变量系统（base.css）+ grid 布局（layout.css）+ 主题切换入口（ui.ts/renderer.ts）+ windowManager 浅色背景 | ✅ |
| iter-1 | 对话面板 v8 风格（chat.css 重写 + index.html 输入区 DOM 调整为 textarea + .input-actions 分层） | ✅ |
| iter-2 | 侧栏 + 顶栏 v8 对齐（在 iter-0 中已完成） | ✅ |
| iter-3 | 记忆/设置/弹窗/toast v8 风格 + float.html 同步双主题 | ✅ |
| iter-4 | 收敛 + ADR-SP-006 + 文档更新 | ✅ |

### 4. 文档形式

**ADR + CSS 变量注释**（推荐）：
- 本 ADR 记录架构决策
- `base.css` 顶部以注释块说明每个变量的语义与取值
- 不单独维护 UI 规范文档，避免文档与代码漂移

## 理由

- **双主题而非单主题**：浅色符合主流习惯，深色满足夜间使用与原有用户偏好，通过 CSS 变量切换零成本
- **向后兼容变量名**：避免大规模重命名引发的回归风险，新增语义变量与旧变量并存
- **grid 布局而非 flex**：`grid-template-areas` 天然适合"侧栏 + 顶栏 + 主区"的二维结构，悬浮效果通过 margin + radius + shadow 自然实现
- **分迭代而非一次性重写**：每个迭代独立可验证（typecheck + lint + vitest），降低回归风险，符合"每次修复可独立回滚"原则
- **ADR + CSS 注释而非独立 UI 规范文档**：项目已建立 ADR 实践，CSS 变量注释与代码同源，避免文档漂移

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| 仅浅色单主题 | 丢失深色用户偏好，夜间使用体验下降 |
| CSS-in-JS（styled-components 等） | 引入运行时开销，与现有纯 CSS 架构不一致 |
| Tailwind CSS | 引入新工具链，2 个渲染进程过度工程 |
| 独立 UI 规范文档（如 `ui-guidelines.md`） | 易与代码漂移，ADR + CSS 注释已足够 |
| 一次性全量重写 | 回归风险高，无法分迭代验证 |

## 影响

### 新增文件
- 无（所有改造基于现有文件重写）

### 修改文件
- `src/electron/renderer/styles/base.css`：双主题 CSS 变量系统
- `src/electron/renderer/styles/layout.css`：grid 布局 + 侧栏/顶栏 v8
- `src/electron/renderer/styles/chat.css`：对话面板 v8（消息气泡、悬浮输入卡、圆形发送按钮）
- `src/electron/renderer/styles/memory.css`：记忆面板 v8（卡片式 memory-item、胶囊搜索框）
- `src/electron/renderer/styles/settings.css`：设置面板 v8（52px tabs、window-bg inputs）
- `src/electron/renderer/styles/modal.css`：弹窗 v8（radius-lg + 深阴影）
- `src/electron/renderer/styles/toast.css`：Toast v8（左侧色条 + radius-md）
- `src/electron/renderer/index.html`：输入区 DOM 调整为 textarea + .input-actions 分层
- `src/electron/renderer/float.html`：添加主题初始化脚本 + 内联 CSS 变量最小集
- `src/electron/renderer/ui.ts`：新增 `themeChangeCallback`/`onThemeChange`/`getTheme`/`setTheme`/`syncThemeRadios`
- `src/electron/renderer/renderer.ts`：DOMContentLoaded 中同步主题 + 注册回调
- `src/electron/windowManager.ts`：`backgroundColor` 改为浅色 `#f0f0f2`

### 验证
- `typecheck:electron`：0 错误
- `lint`：0 警告
- `vitest`：112/112 通过（6 个测试文件）

### 后续维护
- 新增 UI 组件必须使用 v8 语义变量，禁止硬编码颜色
- 深色主题调整只需修改 `base.css` 的 `[data-theme="dark"]` 块
- `float.html` 的内联 CSS 变量需与 `base.css` 保持同步（浮动窗口独立加载，无法引用外部 CSS）
