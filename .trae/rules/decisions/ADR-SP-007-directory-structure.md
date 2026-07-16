---
alwaysApply: false
description: "memora-sprite 宿主：目录结构"
---

# ADR-SP-007 · 目录结构

> **状态**：✅ 已接受（2026-06-16）
> **依赖**：[ADR-008](./ADR-008-directory-structure.md)（内核目录结构）

## 背景

精灵是 memora 仓库内的独立 package，需要确定其在仓库中的位置和内部目录结构。

## 决策

**`hosts/memora-sprite/` 作为独立 package，按职责分层。**

```
hosts/memora-sprite/
├── package.json              ← 独立依赖（memora + better-sqlite3 + electron）
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts              ← 入口：Agent 实例化 + 生命周期（startSprite / reinitAgent）
    ├── storage/
    │   ├── sqliteStorage.ts  ← IMemoryStorage 实现
    │   └── sessionStore.ts   ← ISessionStore 实现
    ├── sprite/
    │   ├── sprite.ts         ← 精灵主控：唤醒调度 + 对话管理 + 主动行为
    │   ├── spriteConfig.ts   ← 精灵配置持久化（sprite.json 读写）
    │   ├── spriteTracer.ts   ← 可观测性（ITracer/ISpan 实现，pino 日志）
    │   ├── constants.ts      ← 精灵常量集合
    │   ├── triggers.ts       ← SpriteTrigger 接口 + TimerTrigger + TriggerBus
    │   ├── fileWatcherTrigger.ts ← 文件变化触发器（ADR-SP-004 阶段二）
    │   ├── interaction.ts    ← IInteraction 交互层接口
    │   ├── cliInteraction.ts ← CLI 交互层实现（readline）
    │   ├── auditManager.ts   ← 审计日志管理器（安全审计事件记录）
    │   ├── tools.ts          ← 宿主自定义工具注册（webSearchTool + memorySearchTool）
    │   └── controllers/      ← 专职控制器（精灵事件分发，阶段二新增）
    │       ├── index.ts
    │       ├── memoryController.ts    ← 记忆事件 → 仪表盘计数 + 向量索引
    │       ├── personaController.ts   ← 角色事件 → 角色标签更新
    │       └── proactiveEngine.ts     ← 事件累积 → 主动提示生成
    ├── electron/             ← Electron 主进程 + 渲染进程（阶段二新增）
    │   ├── main.ts           ← 主进程入口：窗口生命周期 + Agent 管理 + IPC 路由
    │   ├── preload.ts        ← contextBridge 安全桥接
    │   ├── ipcChannels.ts    ← IPC 通道名称常量（主进程/渲染进程共享）
    │   ├── ipcHandlers.ts    ← IPC 处理器注册（流式输出 + 记忆 CRUD + 配置）
    │   ├── windowManager.ts  ← 窗口管理器（完整窗口创建 + IPC 控制）
    │   ├── windowState.ts    ← 三态窗口状态机（tray/float/full）
    │   ├── floatWindow.ts    ← 浮动窗口（80x80 悬浮球 + 拖动 + 单击展开）
    │   ├── trayIcon.ts       ← 系统托盘（三态图标 idle/active/sleeping）
    │   ├── interaction.ts    ← ElectronInteraction（IInteraction 实现，非流式输出）
    │   ├── errorHandler.ts   ← 统一错误处理（ErrorCode 分类 + 用户友好消息）
    │   ├── utils/
    │   │   └── esmShim.ts    ← ESM 兼容性垫片
    │   └── renderer/         ← 渲染进程
    │       ├── index.html    ← 完整窗口 HTML
    │       ├── float.html    ← 浮动窗口 HTML
    │       ├── float.ts      ← 浮动窗口逻辑
    │       ├── renderer.ts   ← 渲染进程入口（IPC 监听 + 事件分发 + 流式输出）
    │       ├── ui.ts         ← UI 管理器（DOM 操作 + 状态管理）
    │       ├── types.ts      ← 渲染进程类型定义
    │       ├── domHelpers.ts ← DOM 操作工具函数
    │       ├── errorHelpers.ts ← 错误处理工具函数
    │       ├── eventTracker.ts ← 事件监听器追踪与清理
    │       ├── ipcListeners.ts ← IPC 监听器注册
    │       ├── markdown.ts   ← Markdown 渲染
    │       ├── modal.ts      ← 模态框管理器
    │       ├── toast.ts      ← Toast 通知管理器
    │       ├── onboarding.ts ← 首次引导流程
    │       ├── themeManager.ts ← 主题管理（浅色/深色/系统跟随）
    │       ├── memoryController.ts ← 记忆面板控制器（C-3 重命名，原 memoryPanelController）
    │       ├── personaController.ts ← 角色面板控制器（C-3 重命名，原 personaPanelController）
    │       ├── sessionController.ts ← 会话面板控制器
    │       ├── settingsController.ts ← 设置面板控制器
    │       ├── panels/        ← 面板管理器（DOM 绑定 + 渲染逻辑，UIManager facade 委托）
    │       │   ├── chatPanelManager.ts ← 聊天面板（消息渲染 + 流式输出）
    │       │   ├── memoryPanelManager.ts ← 记忆面板（列表 + 搜索 + 详情）
    │       │   ├── dashboardPanelManager.ts ← 仪表盘面板（感知系统 + 仪表盘渲染，Phase 2 提取）
    │       │   ├── personaPanelManager.ts ← 角色选择器面板
    │       │   ├── settingsPanelManager.ts ← 设置面板 DOM 管理
    │       │   ├── profilePanelManager.ts ← 用户画像面板管理
    │       │   ├── workProjectionPanelManager.ts ← 作品投影面板
    │       │   ├── auditPanelManager.ts ← 审计日志面板
    │       │   ├── commandPaletteManager.ts ← 命令面板（Ctrl+K）
    │       │   ├── panelErrorBannerManager.ts ← 面板错误横幅（C-5-1 拆分）
    │       │   ├── clipboardManager.ts ← 剪贴板保护（C-5-2 拆分）
    │       │   ├── dateNavManager.ts ← 日期导航（C-5-3 拆分）
    │       │   └── skillDropManager.ts ← 技能拖入安装（C-5-4 拆分）
    │       ├── suggestionCard.ts ← 配置建议卡片
    │       ├── proactiveBanner.ts ← 主动提示横幅
    │       └── styles/       ← 样式文件（v8 语义化变量系统）
    │           ├── base.css      ← 基础变量 + 重置（Catppuccin Mocha + 霞鹜文楷）
    │           ├── layout.css    ← 布局（窗口框架 + 侧边栏）
    │           ├── chat.css      ← 对话区样式
    │           ├── memory.css    ← 记忆面板样式
    │           ├── modal.css     ← 模态框样式
    │           ├── settings.css  ← 设置面板样式
    │           ├── toast.css     ← Toast 通知样式
    │           └── markdown.css  ← Markdown 渲染样式
    └── __tests__/
        ├── sqliteStorage.test.ts
        ├── sessionStore.test.ts
        ├── sprite.test.ts
        ├── spriteIntegration.test.ts
        ├── ipcHandlers.test.ts
        ├── sessionController.test.ts
        ├── float.test.ts
        └── ui.test.ts
```

## 理由

- **`hosts/` 先例**：[ADR-002](./ADR-002-storage-layer.md) v0.7 已确立 `hosts/memora-sprite/` 作为宿主项目位置（CLI 移出至宿主），精灵遵循同一约定
- **独立 package.json**：精灵的 native 依赖（better-sqlite3）不污染内核
- **按职责分层**：与内核 ADR-008 一致，storage/ 和 sprite/ 各自独立
- **最小结构**：阶段一只需 3 个目录（storage/sprite/__tests__），不过度设计

## 替代方案

| 方案 | 放弃原因 |
|------|---------|
| `packages/memora-sprite/` | 需要引入 pnpm workspace，过度工程 |
| `src/hosts/sprite/` | 与内核 src/ 混在一起，依赖隔离困难 |
| 独立仓库 | 精灵与内核强耦合，独立仓库增加同步成本 |

## 影响

- `.gitignore` 需添加 `hosts/memora-sprite/node_modules/` 和 `hosts/memora-sprite/dist/`
- 精灵的 tsconfig.json 的 `paths` 不使用 `@/` 别名（精灵是小项目，相对路径足够）
- 阶段二引入 Electron 时，新增 `electron/` 目录放主进程和渲染进程代码

## 年轮修订

### v0.2（2026-06-22）· 规则文档与实际产出对齐

**变更**：目录结构树与实际 src/ 完全对齐

**设计演进**：
- sprite/ 新增 4 个文件：spriteTracer.ts（可观测性）、constants.ts（常量集合）、auditManager.ts（审计日志）、tools.ts（宿主自定义工具）
- electron/ 新增 2 项：ipcChannels.ts（IPC 通道常量）、utils/esmShim.ts（ESM 兼容垫片）
- electron/renderer/ 从 5 文件扩展到 24 文件 + styles/ 子目录，反映 v8 UI 重构后的完整前端架构
- styles/ 替代原 renderer.css，拆分为 8 个语义化 CSS 文件（base/layout/chat/memory/modal/settings/toast/markdown）
- __tests__/ 从 4 文件扩展到 8 文件，新增 ipcHandlers/sessionController/float/ui 测试
- 年轮审判发现规则文档严重滞后于产出（缺 20+ 文件），此次双向对齐

### v0.3（2026-06-29）· Phase 2 模块重思——DashboardPanelManager 提取

**变更**：electron/renderer/panels/ 目录树补完 7 个 PanelManager 完整列表

**设计演进**：
- v0.2 仅列出 settingsPanelManager/profilePanelManager 2 个 PanelManager，遗漏 chatPanelManager/memoryPanelManager/personaPanelManager/workProjectionPanelManager/auditPanelManager 5 个
- Phase 2 新增 dashboardPanelManager.ts（1425 行，从 memoryPanelController.ts 提取仪表盘渲染 + 感知系统），目录树补完时一并补齐
- UIManager facade 透传模式正式确立：PanelManager 依赖注入采用多种模式（详见 [ADR-SP-015](./ADR-SP-015-panel-manager-composition.md)），包括 Host 接口注入（推荐）、共享 leaf 组件注入（ToastManager/ModalManager）、共享 EventTracker 注入、自包含无注入，UIManager 仅做委托
- memoryPanelController.ts 从 1542 → 540 行（-1000 行），Controller 仅保留 IPC 编排，DOM 渲染归 PanelManager

### v0.4（2026-07-01）· 阶段 C 架构演进——controllers 重命名 + panels 拆分

**变更**：
- controllers/ 文件名对齐：memoryPanelController.ts → memoryController.ts、personaPanelController.ts → personaController.ts（C-3 重命名，文件名与导出函数名一致）
- panels/ 补齐 4 个新 Manager（C-5-1~4 拆分，从 UIManager 提取）：
  - panelErrorBannerManager.ts（91 行，自包含 EventTracker）
  - clipboardManager.ts（103 行，依赖注入 ToastManager + ModalManager）
  - dateNavManager.ts（185 行，自包含 EventTracker）
  - skillDropManager.ts（193 行，依赖注入 ToastManager）
- ui.ts 从 2131 → 1896 行（-235 行），新增 4 个独立 Manager 共 572 行

**设计演进**：
- C-5 拆分确立了 PanelManager 组合模式的完整约定，详见 [ADR-SP-015](./ADR-SP-015-panel-manager-composition.md)
- v0.3 表述"所有 PanelManager 通过 Host 接口注入"过绝对，修正为承认多种注入模式并存（Host 接口 / 共享 leaf 组件 / 共享 EventTracker / 自包含）
- C-8 确立"控制器不直接操作 DOM"分层约束，详见 [sprite-project-rules.md §4](../sprite-project-rules.md)
