# Memora Sprite · 最终目录形态

> **设计原则**：按职责分组，而非按类型分组；每个目录有明确边界；禁止单文件目录；禁止命名冲突。
> **当前状态**：D-01~D-14 全部完成 + S-02 shared 模块已落地（DWM-01 双模式 Web 调试，含 hostContext/inputValidation/shortcutDefaults 三个文件）。目录形态已对齐最终目标。
> **版本**：v1.4（2026-07-06）

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
│   ├── clipboardHandler.ts     # 剪贴板三重保护处理器（Phase 3.1）
│   ├── shortcuts.ts            # 全局快捷键管理器（Phase 3.3）
│   ├── types.ts                # Electron 主进程类型 barrel（S-03 阶段 2）
│   │
│   ├── ipc/                    # IPC 通信层（通道定义 + 处理器注册 + 各类 handler）
│   │   ├── index.ts            # 聚合导出
│   │   ├── channels.ts         # IPC 通道常量（从 ipcChannels.ts 移入）
│   │   ├── handlers.ts         # 完整 IPC 处理器注册（从 ipcHandlers.ts 移入）
│   │   ├── minimalHandlers.ts  # 最小化 IPC 处理器（Agent 未就绪时降级）
│   │   ├── types.ts            # IPC 类型定义
│   │   ├── inputValidation.ts  # 输入验证（用户消息长度/频率限制）
│   │   ├── chatHandlers.ts     # 对话 IPC 注册（薄层，QC-R2-04 重构）
│   │   ├── chatStreamHandler.ts # 对话流式输出处理器（handleUserInput，QC-R2-04 提取）
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
│   │   ├── windowState.ts      # 窗口状态持久化（位置/大小/显示器恢复）
│   │   └── themeInjector.ts    # 主题注入器（CSS 变量动态注入）
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
│       │   ├── memoryController.ts      # 记忆面板控制器（C-3 重命名，原 memoryPanelController.ts）
│       │   └── personaController.ts     # 角色面板控制器（C-3 重命名，原 personaPanelController.ts）
│       │
│       ├── helpers/            # 渲染进程工具函数
│       │   ├── domHelpers.ts   # DOM 操作辅助（安全查询/批量操作）
│       │   ├── errorHelpers.ts # 错误处理辅助（IPC 错误处理器工厂）
│       │   ├── eventTracker.ts # 事件追踪（埋点/用户行为记录）
│       │   ├── memoryPanelEvents.ts # 记忆面板事件监听辅助（AUTO-HEALTH-05 从 memoryPanelManager 提取）
│       │   ├── messageDecorations.ts # 消息装饰辅助函数（系统消息/错误消息样式）
│       │   ├── toolCallCard.ts # 工具调用卡片辅助（工具执行状态展示）
│       │   └── safeTimer.ts    # 安全定时器辅助（自动清理/防泄漏）
│       │
│       ├── components/         # 可复用 UI 组件
│       │   ├── themeManager.ts      # 主题管理器（auto/light/dark 切换）
│       │   ├── modal.ts             # 模态弹窗
│       │   ├── toast.ts             # Toast 通知
│       │   ├── onboarding.ts        # 新手引导
│       │   ├── proactiveBanner.ts   # 精灵主动提示横幅
│       │   ├── suggestionCard.ts    # 建议卡片
│       │   ├── relationGraph.ts     # 关系图 Canvas 组件（记忆拓扑可视化）
│       │   └── markdown.ts          # Markdown 渲染
│       │
│       ├── panels/             # 面板管理器（各面板的 DOM 绑定 + 渲染逻辑）
│       │   ├── chatPanelManager.ts       # 对话面板
│       │   ├── memoryPanelManager.ts     # 记忆面板
│       │   ├── settingsPanelManager.ts   # 设置面板
│       │   ├── profilePanelManager.ts    # 用户画像面板
│       │   ├── sessionPanelManager.ts    # 会话面板
│       │   ├── personaPanelManager.ts    # 角色面板
│       │   ├── workProjectionPanelManager.ts # 作品投影面板
│       │   ├── commandPaletteManager.ts  # 命令面板
│       │   ├── auditPanelManager.ts      # 审计面板
│       │   ├── dashboardPanelManager.ts  # 仪表盘面板（Facade，持有 4 个子渲染器）
│       │   ├── partnerInsightsRenderer.ts # 伙伴洞察子渲染器（ADR-SP-015 模式 D）
│       │   ├── perceptionRenderer.ts     # 感知系统子渲染器（情感/默契/上下文/模式/在场状态/叙事）
│       │   ├── insightsRenderer.ts       # 洞察统计子渲染器（ADR-SP-015 模式 C）
│       │   ├── healthDashboardRenderer.ts # 健康度仪表盘子渲染器（ADR-SP-015 模式 C）
│       │   ├── panelErrorBannerManager.ts # 面板错误横幅（C-5-1 拆分，自包含 EventTracker）
│       │   ├── clipboardManager.ts       # 剪贴板保护（C-5-2 拆分，依赖注入 ToastManager + ModalManager）
│       │   ├── dateNavManager.ts         # 日期导航（C-5-3 拆分，自包含 EventTracker）
│       │   ├── skillDropManager.ts       # 技能拖入安装（C-5-4 拆分，依赖注入 ToastManager）
│       │   ├── archiveButtonManager.ts   # 归档按钮管理（manual 模式消息归档按钮，从 chatPanelManager 拆分）
│       │   ├── inputAreaManager.ts       # 输入区域管理（键盘事件/自适应高度/发送按钮，从 UIManager 拆分）
│       │   └── panelRouter.ts            # 面板路由器（面板切换/导航/全局快捷键/窗口控制）
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
│           ├── toast.css       # Toast 通知样式
│           └── dashboard.css   # 仪表盘面板样式
│
├── sprite/                     # 精灵核心层（纯逻辑，零 Electron 依赖）
│   ├── sprite.ts               # 精灵核心类（启动/关闭/事件/主动行为）
│   ├── spriteConfig.ts         # 精灵配置管理（加载/保存/默认值）
│   ├── spriteLifecycleManager.ts # 精灵生命周期管理器（从 sprite.ts 拆分：init/shutdown/定时任务）
│   ├── spriteTracer.ts         # 精灵追踪（Span 埋点）
│   ├── triggers.ts             # 触发条件定义（时间/事件/记忆量）
│   ├── tools.ts                # 工具定义（注册给 Agent 的自定义工具）
│   ├── constants.ts            # 精灵常量
│   ├── fileWatcherTrigger.ts   # 文件监听触发器
│   ├── interaction.ts          # IInteraction 接口定义
│   ├── skillInstaller.ts       # 技能安装器（拖入安装，Phase 4.3）
│   ├── errors.ts               # 宿主层共享错误类型（ErrorCode 枚举 + MemoraError 类，零 Electron 依赖）
│   ├── spriteConfigManager.ts  # 精灵配置管理器（配置 CRUD + 每日消息计数，从 sprite.ts 拆分）
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
│       ├── proactiveEngine.ts  # 精灵主动行为引擎（事件累积/提示生成）
│       ├── presenceController.ts # 在场状态控制器（锁屏/挂起/焦点，Phase 3）
│       ├── rapportController.ts  # 默契度控制器（Phase 2 伙伴关系）
│       ├── contextAwareness.ts   # 上下文感知控制器（场景识别/语境理解）
│       ├── patternDetector.ts    # 模式检测器（用户行为模式识别）
│       ├── affectController.ts   # 情感控制器（情绪感知/响应调节）
│       ├── perceptionCoordinator.ts # 感知协调器（融合多控制器输出，统一感知叙事）
│       ├── reviewManager.ts      # 回顾管理器（记忆定期回顾/总结）
│       └── memoryHealth.ts       # 记忆健康度管理（质量评估/优化建议）
│
├── storage/                    # 持久化层
│   ├── sessionStore.ts         # 会话持久化（SQLite 会话表）
│   ├── spriteConfigStore.ts    # 精灵配置持久化（~/.memora-sprite/config.json）
│   ├── sqliteDatabaseTypes.ts  # SQLite 数据库类型定义
│   ├── sqliteStorage.ts        # SQLite 存储实现（IMemoryStorage 接口）
│   ├── sqliteRelationStore.ts  # 记忆关系侧车存储实现（IMemoryRelationStore）
│   └── nodeSqliteDatabase.ts   # node:sqlite 适配器（零 native 依赖，Web/CLI 模式 SQLite 实现）
│
├── shared/                     # 宿主上下文共享层（纯类型+纯数据，无 Node 依赖，主进程/渲染进程/Web 安全共用）
│   ├── hostContext.ts          # HostContext 接口（Electron + Web 共用核心依赖容器）
│   ├── inputValidation.ts      # 跨进程输入验证（IPC + Web 路由白名单真理源，防路径遍历/注入）
│   └── shortcutDefaults.ts     # 快捷键默认配置（ShortcutConfig 类型 + DEFAULT_SHORTCUTS 常量，主进程+渲染进程共用）
│
├── web/                        # Web 模式（HTTP 调试通道，与 Electron 模式并行）
│   ├── server.ts               # HTTP 服务器入口（Express + 静态资源 + 路由挂载）
│   ├── static.ts               # 静态资源服务（渲染进程 HTML/CSS/JS）
│   ├── webContext.ts           # Web 模式上下文构造（注入 HostContext 核心字段）
│   ├── preloadWeb.ts           # Web 预加载脚本（替代 Electron preload，注入 window.api）
│   └── routes/                 # HTTP 路由（与 IPC handler 平行，消费同一 HostContext）
│       ├── index.ts            # 路由聚合导出
│       ├── types.ts            # 路由类型定义
│       ├── chatStreamRoutes.ts # 对话流式路由（SSE）
│       ├── configRoutes.ts     # 配置管理路由
│       ├── memoryRoutes.ts     # 记忆管理路由
│       ├── sessionRoutes.ts    # 会话管理路由
│       └── systemRoutes.ts     # 系统信息路由
│
└── __tests__/                  # 测试文件（镜像源码目录结构）
    ├── electron/               # Electron 层测试
    │   ├── ipc/                # IPC 处理器测试（镜像 src/electron/ipc/）
    │   │   ├── channels.test.ts
    │   │   ├── handlers.test.ts  # 完整 IPC 处理器注册测试（原 ipcHandlers.test.ts，D-07 重命名同步）
    │   │   └── ...（10 个 handler 测试）
    │   ├── windows/            # 窗口管理测试（镜像 src/electron/windows/）
    │   │   ├── themeInjector.test.ts
    │   │   └── windowState.test.ts
    │   ├── renderer/           # 渲染进程测试（镜像 src/electron/renderer/，D-12 镜像修复）
    │   │   ├── ui.test.ts      # 主 UI 管理器测试
    │   │   ├── chatPanelManager.test.ts
    │   │   └── ...（26 个 renderer 测试）
    │   ├── agentListeners.test.ts
    │   └── ...（5 个 electron 根级测试）
    ├── sprite/                 # 精灵层测试（镜像 src/sprite/）
    │   ├── audit/              # 审计模块测试（镜像 src/sprite/audit/）
    │   │   ├── auditManager.test.ts
    │   │   └── jsonlAppender.test.ts
    │   ├── controllers/        # 控制器测试（镜像 src/sprite/controllers/）
    │   │   ├── affectController.test.ts
    │   │   └── ...（7 个 controller 测试）
    │   ├── sprite.test.ts      # 精灵根级测试
    │   └── ...（6 个 sprite 根级测试）
    ├── storage/                # 存储层测试
    │   ├── nodeSqliteDatabase.ts  # 测试用 SQLite 数据库工厂（node:sqlite 适配器）
    │   ├── sessionStore.test.ts
    │   └── sqliteStorage.test.ts
    └── web/                    # Web 模式测试（镜像 src/web/）
        ├── webContext.test.ts     # Web 上下文构造测试
        ├── preloadWeb.test.ts     # Web 预加载脚本测试
        └── routes/               # 路由测试（镜像 src/web/routes/）
            ├── chatStreamRoutes.test.ts
            ├── memoryRoutes.test.ts
            └── types.test.ts
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
| `shared/` | 宿主上下文共享层（接口/类型 + 纯数据常量 + 纯函数，无 Node 依赖，主进程/渲染进程/Web 共用） | Node 运行时依赖（node:fs 等）；有副作用的业务逻辑 |
| `web/` | Web 模式 HTTP 调试通道（与 Electron 模式并行） | 直接操作 Electron API；包含业务逻辑（应委托 sprite/storage） |

### 2.2 命名冲突解决

| 冲突 | 解决方案 |
|------|----------|
| `renderer/ui.ts` vs `renderer/ui/` | `ui/` → 重命名为 `panels/`（面板管理器） |
| `renderer/controllers/` vs `sprite/controllers/` | 同名不同层，职责清晰：渲染进程控制器 vs 精灵核心控制器 |
| `ipcChannels.ts` / `ipcHandlers.ts` 在 electron/ 根 | 移入 `ipc/` 子目录，与其他 IPC 文件同组 |

### 2.3 测试文件组织

- **镜像原则**：`__tests__/` 目录结构严格镜像 `src/` 目录结构（`src/electron/ipc/` → `__tests__/electron/ipc/`）
- 测试文件按模块分组，子目录与源码子目录一一对应
- 测试辅助工具与测试文件同目录（如 `storage/nodeSqliteDatabase.ts` 与 `storage/*.test.ts` 同级），仅服务于该模块测试
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
- [x] D-11: `__tests__/` 按模块重组（electron/ sprite/ storage/ renderer/ 四个子目录）
- [x] D-12: `__tests__/` 镜像源码子目录——ipc/ 迁入 electron/ipc/、windows/ 迁入 electron/windows/、sprite/ 拆分 audit/ + controllers/
- [x] D-13: `__tests__/` 镜像修复收尾——renderer/ 27 文件迁入 electron/renderer/、ui.test.ts 迁入 electron/renderer/、ipcHandlers.test.ts 重命名为 ipc/handlers.test.ts（2026-06-30，第八轮骨架修复）
- [x] D-14: controllers/ 文件名对齐——memoryPanelController.ts → memoryController.ts、personaPanelController.ts → personaController.ts（C-3 重命名）；panels/ 补齐 4 个新 Manager——panelErrorBannerManager.ts/clipboardManager.ts/dateNavManager.ts/skillDropManager.ts（C-5-1~4 拆分，2026-07-01 阶段 C 架构演进）

### 延后（非目录结构）

- [x] S-02: shared 模块已落地（DWM-01 双模式 Web 调试，2026-07-03 v1.2 纳入文档；2026-07-04 v1.3 补充 inputValidation/shortcutDefaults 描述）
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