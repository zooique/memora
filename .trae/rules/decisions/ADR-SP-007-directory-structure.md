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
    │   ├── triggers.ts       ← SpriteTrigger 接口 + TimerTrigger + TriggerBus
    │   ├── fileWatcherTrigger.ts ← 文件变化触发器（ADR-SP-004 阶段二）
    │   ├── interaction.ts    ← IInteraction 交互层接口
    │   ├── cliInteraction.ts ← CLI 交互层实现（readline）
    │   └── controllers/      ← 专职控制器（精灵事件分发，阶段二新增）
    │       ├── index.ts
    │       ├── memoryController.ts    ← 记忆事件 → 仪表盘计数
    │       ├── personaController.ts   ← 角色事件 → 角色标签更新
    │       └── proactiveEngine.ts     ← 事件累积 → 主动提示生成
    ├── electron/             ← Electron 主进程 + 渲染进程（阶段二新增）
    │   ├── main.ts           ← 主进程入口：窗口生命周期 + Agent 管理 + IPC 路由
    │   ├── preload.ts        ← contextBridge 安全桥接
    │   ├── windowManager.ts  ← 窗口管理器（完整窗口创建 + IPC 控制）
    │   ├── windowState.ts    ← 三态窗口状态机（tray/float/full）
    │   ├── floatWindow.ts    ← 浮动窗口（80x80 悬浮球 + 拖动 + 单击展开）
    │   ├── trayIcon.ts       ← 系统托盘（三态图标 idle/active/sleeping）
    │   ├── ipcHandlers.ts    ← IPC 处理器注册（流式输出 + 记忆 CRUD + 配置）
    │   ├── interaction.ts    ← ElectronInteraction（IInteraction 实现，非流式输出）
    │   ├── errorHandler.ts   ← 统一错误处理（ErrorCode 分类 + 用户友好消息）
    │   └── renderer/         ← 渲染进程
    │       ├── index.html    ← 完整窗口 HTML
    │       ├── float.html    ← 浮动窗口 HTML
    │       ├── renderer.ts   ← 渲染进程入口（IPC 监听 + 事件分发）
    │       ├── ui.ts         ← UI 管理器（DOM 操作 + 状态管理）
    │       └── renderer.css  ← 样式（Catppuccin Mocha + 霞鹜文楷）
    └── __tests__/
        ├── sqliteStorage.test.ts
        ├── sessionStore.test.ts
        ├── sprite.test.ts
        └── sprite-integration.test.ts
```

## 理由

- **`hosts/` 先例**：ADR-005 已确立 `hosts/memora-cli/` 作为宿主项目位置，精灵遵循同一约定
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
