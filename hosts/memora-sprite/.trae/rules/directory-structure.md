# Memora Sprite · 最终目录形态

> **设计原则**：按职责分组，而非按类型分组；每个目录有明确边界；禁止单文件目录；禁止命名冲突。
> **当前状态**：D-01~D-11 全部完成，目录形态已对齐最终目标。
> **版本**：v1.0（2026-06-24）

---

## 1. 完整目录树

```
src/
├── index.ts                    # 纯库导出入口（类型 + 接口 + startSprite）
├── cli.ts                      # CLI 入口（setupWizard + 命令路由 + REPL）
│
├── electron/                   # Electron 主进程 + 渲染进程
│   ├── main.ts                 # 主进程入口（窗口生命周期 + 应用启动）
│   ├── preload.ts              # 预加载脚本（contextBridge 暴露 API）
│   ├── esmShim.ts              # ESM 兼容 shim（__dirname 替代）
│   ├── errorHandler.ts         # 全局错误处理（分类 + 日志 + 降级）
│   ├── interaction.ts          # Electron 交互实现（IInteraction 接口）
│   ├── agentListeners.ts       # Agent 事件监听器（配置建议/写入确认/审计）
│   ├── spriteEventBridge.ts    # 精灵事件桥接（主进程 → 渲染进程通知）
│   ├── trayIcon.ts             # 系统托盘管理
│   │
│   ├── ipc/                    # IPC 通信层（通道定义 + 处理器注册 + 各类 handler）
│   │   ├── index.ts            # 聚合导出
│   │   ├── channels.ts         # IPC 通道常量（从 ipcChannels.ts 移入）
│   │   ├── handlers.ts         # 完整 IPC 处理器注册（从 ipcHandlers.ts 移入）
│   │   ├── minimalHandlers.ts  # 最小化 IPC 处理器（Agent 未就绪时降级）
│   │   ├── types.ts            # IPC 类型定义
│   │   ├── inputValidation.ts  # 输入验证（用户消息长度/频率限制）
│   │   ├── chatHandlers.ts     # 对话相关 IPC handler
│   │   ├── configHandlers.ts   # 配置相关 IPC handler
│   │   ├── memoryHandlers.ts   # 记忆相关 IPC handler
│   │   ├── sessionHandlers.ts  # 会话相关 IPC handler
│   │   ├── suggestionHandlers.ts    # 建议相关 IPC handler
│   │   ├── systemHandlers.ts        # 系统相关 IPC handler
│   │   └── workProjectionHandlers.ts # 作品投影 IPC handler
│   │
│   ├── windows/                # 窗口管理（浮动窗口 + 完整窗口 + 状态持久化）
│   │   ├── floatWindow.ts      # 浮动窗口（右键菜单/消息列表/输入框）
│   │   ├── windowManager.ts    # 窗口管理器（浮动↔完整切换/生命周期）
│   │   └── windowState.ts      # 窗口状态持久化（位置/大小/显示器恢复）
│   │
│   └── renderer/               # 渲染进程（UI 层，不直接导入 electron）
│       ├── index.html          # 完整窗口 HTML 入口
│       ├── renderer.ts         # 渲染进程入口（DOMContentLoaded → 初始化）
│       ├── ui.ts               # 主 UI 管理器（UIManager 类，~1000 行）
│       ├── types.ts            # 渲染进程类型定义
│       ├── ipcListeners.ts     # 主进程 → 渲染进程 IPC 监听器
│       ├── initHelpers.ts      # DOM 初始化辅助函数
│       │
│       ├── controllers/        # 面板控制器（业务逻辑，不含 DOM 操作）
│       │   ├── settingsController.ts    # 设置面板控制器
│       │   ├── sessionController.ts     # 会话面板控制器
│       │   ├── memoryPanelController.ts # 记忆面板控制器
│       │   └── personaPanelController.ts # 角色面板控制器
│       │
│       ├── helpers/            # 渲染进程工具函数
│       │   ├── domHelpers.ts   # DOM 操作辅助（安全查询/批量操作）
│       │   ├── errorHelpers.ts # 错误处理辅助（IPC 错误处理器工厂）
│       │   └── eventTracker.ts # 事件追踪（埋点/用户行为记录）
│       │
│       ├── components/         # 可复用 UI 组件
│       │   ├── themeManager.ts      # 主题管理器（auto/light/dark 切换）
│       │   ├── modal.ts             # 模态弹窗
│       │   ├── toast.ts             # Toast 通知
│       │   ├── onboarding.ts        # 新手引导
│       │   ├── proactiveBanner.ts   # 精灵主动提示横幅
│       │   ├── suggestionCard.ts    # 建议卡片
│       │   └── markdown.ts          # Markdown 渲染
│       │
│       ├── panels/             # 面板管理器（各面板的 DOM 绑定 + 渲染逻辑）
│       │   ├── chatPanelManager.ts       # 对话面板
│       │   ├── memoryPanelManager.ts     # 记忆面板
│       │   ├── settingsPanelManager.ts   # 设置面板
│       │   ├── profilePanelManager.ts    # 用户画像面板
│       │   ├── sessionPanelManager.ts    # 会话面板
│       │   └── personaPanelManager.ts    # 角色面板
│       │
│       ├── float/              # 浮动窗口
│       │   ├── float.ts        # 浮动窗口渲染进程逻辑
│       │   └── float.html      # 浮动窗口 HTML 入口
│       │
│       └── styles/             # CSS 样式表
│           ├── base.css        # 基础样式（变量/重置/排版）
│           ├── chat.css        # 对话面板样式
│           ├── layout.css      # 布局样式（侧边栏/主内容区）
│           ├── markdown.css    # Markdown 渲染样式
│           ├── memory.css      # 记忆面板样式
│           ├── modal.css       # 模态弹窗样式
│           ├── settings.css    # 设置面板样式
│           └── toast.css       # Toast 通知样式
│
├── sprite/                     # 精灵核心层（纯逻辑，零 Electron 依赖）
│   ├── sprite.ts               # 精灵核心类（启动/关闭/事件/主动行为）
│   ├── spriteConfig.ts         # 精灵配置管理（加载/保存/默认值）
│   ├── spriteTracer.ts         # 精灵追踪（Span 埋点）
│   ├── triggers.ts             # 触发条件定义（时间/事件/记忆量）
│   ├── tools.ts                # 工具定义（注册给 Agent 的自定义工具）
│   ├── constants.ts            # 精灵常量
│   ├── fileWatcherTrigger.ts   # 文件监听触发器
│   ├── interaction.ts          # IInteraction 接口定义
│   │
│   ├── cli/                    # CLI 专属模块
│   │   ├── formatter.ts        # CLI 输出格式化（颜色/表格/进度条）
│   │   └── interaction.ts      # CLI 交互实现（readline 问答）
│   │
│   ├── audit/                  # 审计日志
│   │   ├── auditManager.ts     # 审计管理器（写入/读取/清理）
│   │   └── jsonlAppender.ts    # JSONL 追加器（逐行写入审计日志）
│   │
│   └── controllers/            # 精灵控制器（Agent 能力扩展）
│       ├── index.ts            # 控制器聚合导出
│       ├── memoryController.ts # 记忆控制器（CRUD/搜索/统计）
│       ├── personaController.ts # 角色控制器（切换/列表/激活）
│       └── proactiveEngine.ts  # 精灵主动行为引擎（事件累积/提示生成）
│
├── storage/                    # 持久化层
│   ├── sessionStore.ts         # 会话持久化（SQLite 会话表）
│   ├── spriteConfigStore.ts    # 精灵配置持久化（~/.memora-sprite/config.json）
│   ├── sqliteDatabaseTypes.ts  # SQLite 数据库类型定义
│   └── sqliteStorage.ts        # SQLite 存储实现（IMemoryStorage 接口）
│
└── __tests__/                  # 测试文件
    ├── electron/               # Electron 层测试
    │   ├── ipcHandlers.test.ts
    │   └── ui.test.ts
    ├── sprite/                 # 精灵层测试
    │   ├── sprite.test.ts
    │   └── spriteIntegration.test.ts
    ├── storage/                # 存储层测试
    │   ├── helpers/            # 存储测试辅助（仅 storage 测试使用）
    │   │   └── nodeSqliteDatabase.ts  # 测试用 SQLite 数据库工厂
    │   ├── sessionStore.test.ts
    │   └── sqliteStorage.test.ts
    └── renderer/               # 渲染进程测试
        ├── float.test.ts
        └── sessionController.test.ts
```

---

## 2. 关键设计决策

### 2.1 职责分组原则

| 目录 | 职责边界 | 禁止内容 |
|------|----------|----------|
| `electron/` 根 | 主进程入口 + 全局单例模块 | 超过 3 个同类文件的平铺 |
| `electron/ipc/` | IPC 通道定义 + 处理器注册 + 各类 handler | 窗口/渲染相关代码 |
| `electron/windows/` | 窗口创建/管理/状态持久化 | IPC 业务逻辑 |
| `electron/renderer/` | 渲染进程 UI 层 | 直接导入 electron 模块 |
| `sprite/` 根 | 精灵核心类 + 配置 + 常量 | CLI 专属代码 |
| `sprite/cli/` | CLI 交互/格式化 | 精灵核心逻辑 |
| `sprite/audit/` | 审计日志写入/读取 | 精灵业务逻辑 |
| `sprite/controllers/` | Agent 能力扩展控制器 | 渲染进程 UI 代码 |
| `storage/` | 持久化实现 | 业务逻辑 |

### 2.2 命名冲突解决

| 冲突 | 解决方案 |
|------|----------|
| `renderer/ui.ts` vs `renderer/ui/` | `ui/` → 重命名为 `panels/`（面板管理器） |
| `renderer/controllers/` vs `sprite/controllers/` | 同名不同层，职责清晰：渲染进程控制器 vs 精灵核心控制器 |
| `ipcChannels.ts` / `ipcHandlers.ts` 在 electron/ 根 | 移入 `ipc/` 子目录，与其他 IPC 文件同组 |

### 2.3 测试文件组织

- 测试文件按模块分组，镜像 `src/` 结构
- 测试辅助工具放在对应模块的 `helpers/` 子目录（如 `storage/helpers/`），仅服务于该模块测试
- 不采用 co-location（测试与源文件同目录），保持 `__tests__/` 集中管理

---

## 3. 迁移步骤（从当前状态 → 最终形态）

### 已完成（第一轮 + 第二轮 + 第三轮）

- [x] D-01: `src/index.ts` 拆分为纯库导出 + `src/cli.ts`
- [x] D-02: `renderer/` 创建 `helpers/` `components/` `float/` 子目录
- [x] D-03: `esmShim.ts` 从 `utils/` 移至 `electron/` 根
- [x] D-04: `registerMinimalIpcHandlers` 提取到 `ipc/minimalHandlers.ts`
- [x] D-05: 渲染进程 controller 加 `Panel` 后缀
- [x] D-06: 创建 `electron/windows/`，移入 3 个窗口文件
- [x] D-07: `ipcChannels.ts` + `ipcHandlers.ts` 移入 `electron/ipc/`（channels.ts + handlers.ts）
- [x] D-08: `renderer/ui/` → `renderer/panels/`（消除 ui.ts vs ui/ 命名冲突）
- [x] D-09: `renderer/` 创建 `controllers/` 子目录（4 个 PanelController 移入）
- [x] D-10: `sprite/` 创建 `cli/` + `audit/` 子目录（formatter.ts + interaction.ts + auditManager.ts + jsonlAppender.ts）
- [x] D-11: `__tests__/` 按模块重组（electron/ sprite/ storage/ renderer/ 四个子目录 + storage/helpers/）

### 延后（非目录结构）

- [ ] S-02: 缺少 shared 模块（需评估方案）
- [ ] S-03: 类型定义分散（需统一方案）
- [ ] Q-01/Q-03: prettier/eslint 配置（低优先级）

---

## 4. 约束

1. **每次迁移独立可回滚**：一个 commit 只做一件事
2. **使用 git mv 保持历史**：文件移动使用 `git mv` 而非新建+删除
3. **翠幕天罗先行**：每次迁移后立即运行双 tsconfig + vitest + eslint
4. **规则先于代码**：本文件更新后，代码逐步对齐
5. **禁止单文件目录**：子目录至少包含 2 个文件
6. **禁止命名冲突**：同级不能有 `foo.ts` 和 `foo/` 同时存在