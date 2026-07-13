# Memora Sprite · 最终目录形态

> **设计原则**：按职责分组，而非按类型分组；每个目录有明确边界；禁止单文件目录；禁止命名冲突。
> **当前状态**：D-01~D-14 全部完成 + S-02 shared 模块已落地（DWM-01 双模式 Web 调试，含 hostContext/inputValidation/shortcutDefaults 三个文件）+ F-LINE-2 memoryPanelManager 拆分（memoryGraphPanel/memoryDetailPanel 两个 helper 提取）+ 迭代 5-7 ui.ts mixin 拆分（applyMixins + uiDelegations/ 6 委托群，1751→904 行）+ 3 Panel 过厚拆分（settings/memory/chat helper 提取）+ relationGraph 拆分（types/layout/color/geometry 四 helper，1206→889 行）+ sourceColor 提取（消除 helpers→panels 循环依赖）。目录形态已对齐最终目标。
> **版本**：v1.8（2026-07-13）

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
│   ├── windows/                # 窗口管理（浮动窗口 + 完整窗口 + 快速输入浮窗 + 状态持久化）
│   │   ├── floatWindow.ts      # 浮动窗口（右键菜单/消息列表/输入框）
│   │   ├── windowManager.ts    # 窗口管理器（浮动↔完整切换/生命周期）
│   │   ├── windowState.ts      # 窗口状态持久化（位置/大小/显示器恢复）
│   │   ├── quickInputWindow.ts # 快速输入浮窗（单例/懒创建/失焦延迟关闭/剪贴板写入）
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
│       │   ├── errorState.ts   # 错误状态辅助（全局错误状态管理）
│       │   ├── eventTracker.ts # 事件追踪（埋点/用户行为记录）
│       │   ├── formValidation.ts # 表单校验辅助（输入校验规则）
│       │   ├── icon.ts         # 图标辅助（SVG 图标加载/渲染）
│       │   ├── initFailureCard.ts # 初始化失败卡片辅助（启动失败时渲染降级卡片）
│       │   ├── messageDecorations.ts # 消息装饰辅助函数（系统消息/错误消息样式）
│       │   ├── messageOperations.ts # 消息操作辅助（消息 CRUD 纯函数）
│       │   ├── narrativeGenerator.ts # 叙事生成器辅助（感知叙事文本生成）
│       │   ├── perceptionLabels.ts # 感知标签辅助（情感/默契/上下文标签文本）
│       │   ├── scrollController.ts # 滚动控制器辅助（消息列表自动滚动/锚定）
│       │   ├── toolCallCard.ts # 工具调用卡片辅助（工具执行状态展示）
│       │   ├── safeTimer.ts    # 安全定时器辅助（自动清理/防泄漏）
│       │   │
│       │   ├── chatPanelEvents.ts # 对话面板事件监听辅助（从 chatPanelManager 提取）
│       │   ├── streamSafetyTimer.ts # 流式安全兜底定时器（30s/90s 二级兜底，从 chatPanelManager 提取）
│       │   ├── streamingRenderer.ts # 流式 RAF 渲染核心（context 注入纯函数，从 chatPanelManager 提取）
│       │   │
│       │   ├── memoryDetailPanel.ts # 记忆详情子系统辅助（F-LINE-2 从 memoryPanelManager 提取：详情/脉络/邻居/按钮）
│       │   ├── memoryGraphPanel.ts  # 图谱视图子系统辅助（F-LINE-2 从 memoryPanelManager 提取：初始化/空状态/缓存/上下文菜单/关系弹窗）
│       │   ├── memoryPanelEvents.ts # 记忆面板事件监听辅助（AUTO-HEALTH-05 从 memoryPanelManager 提取）
│       │   ├── memoryTimelineView.ts # 时间线视图辅助（按天分组渲染 + 日期标签格式化，从 memoryPanelManager 提取）
│       │   ├── memoryViewSwitcher.ts # 视图切换辅助（视图显隐 + 互斥切换 + viewSwitchToken 竞态保护，从 memoryPanelManager 提取）
│       │   ├── sourceColor.ts  # 记忆来源颜色映射纯函数（getSourceColorClass，从 memoryPanelManager 提取，消除 helpers→panels 循环依赖）
│       │   │
│       │   ├── providerManagement.ts # Provider 管理辅助（10 纯函数 + ProviderManagementContext，从 settingsPanelManager 提取）
│       │   ├── shortcutCapture.ts # 快捷键捕获辅助（2 纯函数 + ShortcutCaptureContext，从 settingsPanelManager 提取）
│       │   │
│       │   ├── relationGraphTypes.ts   # 关系图谱类型与常量（7 类型 + 14 常量，类型真理源，消除循环依赖）
│       │   ├── relationGraphLayout.ts  # 关系图谱布局算法（力导向布局，LayoutContext 依赖注入）
│       │   ├── relationGraphColor.ts   # 关系图谱颜色映射（节点/边配色纯函数）
│       │   ├── relationGraphGeometry.ts # 关系图谱几何计算（nodeRadius/screenToWorld/findNodeAt/findEdgeAt/pointToSegmentDist 纯函数）
│       │   │
│       │   ├── applyMixins.ts  # Mixin 注入工具（applyMixins 函数，将 uiDelegations/ 委托群方法分发到 UIManager）
│       │   └── uiDelegations/  # UIManager 委托群（mixin 模式，按业务域聚合的方法集合）
│       │       ├── chatDelegations.ts        # 对话面板委托方法（消息发送/流式/中断）
│       │       ├── dashboardDelegations.ts   # 仪表盘委托方法（概览/运行指标/记忆源健康）
│       │       ├── memoryDelegations.ts      # 记忆面板委托方法（列表/详情/视图切换/关系图谱）
│       │       ├── miscDelegations.ts        # 杂项委托方法（窗口控制/面板路由/全局快捷键）
│       │       ├── personaThemeDelegations.ts # 角色主题委托方法（角色切换/主题应用）
│       │       └── settingsModalDelegations.ts # 设置模态框委托方法（Provider/快捷键/隐私设置）
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
│       │   ├── personaPanelManager.ts    # 角色面板
│       │   ├── workProjectionPanelManager.ts # 作品投影面板
│       │   ├── commandPaletteManager.ts  # 命令面板
│       │   ├── auditPanelManager.ts      # 审计面板
│       │   ├── dashboardPanelManager.ts  # 仪表盘面板（概览+运行指标+记忆源健康+增长趋势）
│       │   ├── perceptionPanelManager.ts # 感知面板（情感/默契/上下文/模式/在场/叙事，通过 Host 接口写精灵状态条）
│       │   ├── partnerInsightsRenderer.ts # 伙伴洞察子渲染器（ADR-SP-015 模式 D，由 memoryPanelManager 持有）
│       │   ├── insightsRenderer.ts       # 洞察统计子渲染器（ADR-SP-015 模式 C，由 memoryPanelManager 持有）
│       │   ├── healthDashboardRenderer.ts # 健康度仪表盘子渲染器（ADR-SP-015 模式 C，由 memoryPanelManager 持有）
│       │   ├── panelErrorBannerManager.ts # 面板错误横幅（C-5-1 拆分，自包含 EventTracker）
│       │   ├── clipboardManager.ts       # 剪贴板保护（C-5-2 拆分，依赖注入 ToastManager + ModalManager）
│       │   ├── dateNavManager.ts         # 日期导航（C-5-3 拆分，自包含 EventTracker）
│       │   ├── skillDropManager.ts       # 技能拖入安装（C-5-4 拆分，依赖注入 ToastManager）
│       │   ├── archiveButtonManager.ts   # 归档按钮管理（manual 模式消息归档按钮，从 chatPanelManager 拆分）
│       │   ├── badgeManager.ts           # 未读徽章管理器（未读计数 + 徽章 DOM 更新，ADR-SP-015 §2 cleanup 契约）
│       │   ├── inputAreaManager.ts       # 输入区域管理（键盘事件/自适应高度/发送按钮，从 UIManager 拆分）
│       │   ├── searchMessagesManager.ts  # 消息搜索管理器（对话内搜索 + 防抖 + 高亮）
│       │   ├── spriteStatusPopover.ts    # 精灵状态浮层（在线状态/记忆量/主动行为提示）
│       │   └── panelRouter.ts            # 面板路由器（面板切换/导航/全局快捷键/窗口控制）
│       │
│       ├── float/              # 浮动窗口
│       │   ├── float.ts        # 浮动窗口渲染进程逻辑
│       │   ├── float.html      # 浮动窗口 HTML 入口
│       │   └── float.css       # 浮动窗口组件样式（令牌从 styles/tokens.css 共享引入）
│       │
│       ├── quick-input/        # 快速输入补全浮窗（Phase 1-2）
│       │   ├── quickInput.ts            # 快速输入渲染逻辑（输入框 + 补全交互）
│       │   ├── quickInputCompletion.ts  # 补全候选管理器（记忆/历史搜索 + 去重排序）
│       │   ├── quick-input.html         # 快速输入 HTML 入口
│       │   └── quick-input.css          # 快速输入组件样式（令牌从 styles/tokens.css 共享引入）
│       │
│       └── styles/             # CSS 样式表（详见 §2.4 CSS 架构规则）
│           ├── README.md       # CSS 架构文档（令牌所有权 + 聚合器模式 + 贡献约定）
│           ├── tokens.css      # 设计令牌「单一真理源」（P0：双主题变量 + CJK 字体栈，三窗口共享）
│           ├── base.css        # 全局重置 / 滚动条 / 动画 / focus-visible / 通用组件骨架
│           ├── layout.css      # 顶栏 + 64px 侧栏 + 核心窗口 Grid 布局
│           ├── chat.css        # 聚合器（@import 4 个子模块，P2 拆分）
│           ├── chat-toolbar.css      # 对话工具栏 / 状态条 / 在场脉冲浮层
│           ├── chat-perception.css   # 对话内嵌感知紧凑布局（rapport-row/affect-grid 等紧凑组件）
│           ├── chat-datenav.css      # 回到今天 / 日期选择 / 下拉 / 空状态
│           ├── chat-messages.css     # 消息气泡 / 输入框 / 打字指示 / 工具调用卡片
│           ├── memory.css      # 聚合器（@import 4 个子模块，P2 拆分）
│           ├── memory-list.css       # 面板头 / 搜索 / 记忆列表卡片 / 来源标签
│           ├── memory-detail.css     # 记忆详情弹窗 / 技能列表 / 全局·项目色
│           ├── memory-views.css      # 视图过渡 / 时间线 / Profile 卡片 / 知识缺口 / 成长趋势
│           ├── memory-graph.css      # 更多菜单 / 关系图谱 Canvas / 图例 / tooltip
│           ├── markdown.css    # Markdown 渲染样式
│           ├── modal.css       # 模态弹窗样式
│           ├── settings.css    # 设置面板样式
│           ├── toast.css       # Toast 通知样式
│           ├── dashboard.css   # 仪表盘面板样式（概览+运行指标+记忆源健康+增长趋势，感知样式已迁至 perception.css）
│           └── perception.css   # 独立感知面板样式（从 dashboard.css 迁出，覆盖 chat-perception.css 基础样式）
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
    │   │   └── ...（55 个 renderer 测试，含 sourceColor.test.ts / memoryPanelManagerInstance.test.ts / memoryPanelManagerViews.test.ts）
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

### 2.4 CSS 架构规则（2026-07-09 P0-P2 重构）

1. **令牌单一真理源**：`tokens.css` 是唯一令牌定义处。`float.html` / `quick-input.html` 通过 `<link>` 共享引入，**禁止在任何窗口内联 `<style>` 块**。修改令牌只能改 `tokens.css`。
2. **CSP 收紧**：主窗/浮窗/快速输入窗 `style-src` 均为 `'self'`（无 `'unsafe-inline'`），杜绝内联样式注入。
3. **聚合器模式**：`chat.css` / `memory.css` 为纯 `@import` 聚合器，不包含任何直接样式规则。`@import` 顺序保持与原单体文件一致，层叠等价。
4. **拆分切点**：按功能域切分，切点必须落在规则边界（大括号配平处），禁止在 CSS 规则中间切分。
5. **间距/圆角令牌化**：组件 CSS 间距/圆角走 `--space-*` / `--radius-*` 令牌，禁止裸写 px（布局 width/height 等除外）。
6. **贡献约定**：新增子模块在聚合器 `@import` 列表按层叠顺序追加；新组件样式放进对应功能 CSS。

### 2.5 IPC 通道治理现状（2026-07-12，排雷 AUDIT-6-2）

> **来源**：排雷报告方向六 · IPC 通道治理

#### 通道规模

| 方向 | 通道数 | 定义文件 |
|------|--------|----------|
| 渲染→主进程（`IPC_CHANNELS`） | 78 | `src/electron/ipc/channels.ts` |
| 主→渲染进程（`MAIN_TO_RENDERER_CHANNELS`） | 27 | 同上 |
| **合计** | **105** | 单一真理源 |

#### 功能域分组（7 个领域 handler + 1 个降级 + 1 个流式核心）

| Handler 文件 | 功能域 | 通道数 |
|--------------|--------|--------|
| `chatHandlers.ts` | 对话域（USER_INPUT / CHAT_ABORT / 锁管理） | 3 |
| `sessionHandlers.ts` | 会话管理（SESSION_*） | 8 |
| `memoryHandlers.ts` | 记忆 CRUD（MEMORIES_* / ARCHIVE_*） | 22 |
| `configHandlers.ts` | 配置 + 角色（CONFIG_* / PERSONA_*） | 7 |
| `systemHandlers.ts` | 主动提示 + 项目 + 仪表盘 + 主题 | 12 |
| `suggestionHandlers.ts` | 配置建议 + 用户画像 | 5 |
| `workProjectionHandlers.ts` | 作品投影 | 2 |
| `minimalHandlers.ts` | Agent 未就绪降级 | — |
| `chatStreamHandler.ts` | 流式输出核心（被 chatHandlers 调用） | — |

聚合入口：`src/electron/ipc/index.ts`（`registerIpcHandlers` 调用 7 个领域 register 函数）。

#### 命名规范

| 项 | 规范 |
|----|------|
| 字符串值 | kebab-case（如 `'memories-list'`） |
| 常量键名 | 全大写下划线（如 `MEMORIES_LIST`） |
| 方向区分 | 两个独立 `as const` 对象（`IPC_CHANNELS` vs `MAIN_TO_RENDERER_CHANNELS`） |
| 主→渲染前缀 | 精灵相关通道统一加 `SPRITE_` 前缀（STREAM / EVENT / OUTPUT / ERROR） |
| 版本号 | 无（当前无通道需 v2 重构，不引入版本管理） |

#### STREAM_* 系列（8 个，均在 `MAIN_TO_RENDERER_CHANNELS`）

`SPRITE_STREAM_START` / `SPRITE_STREAM_CHUNK` / `SPRITE_STREAM_END` / `SPRITE_STREAM_RECALL` / `SPRITE_STREAM_TOOL_START` / `SPRITE_STREAM_TOOL_RESULT` / `SPRITE_STREAM_THINKING` / `SPRITE_STREAM_ABORTED`

#### 校验机制

`scripts/check-ipc-channels.ts` 在构建时校验 `channels.ts` 与 `preload.ts` 的通道常量双向一致性，lint 时运行。

#### 治理决策（排雷 AUDIT-6-1/6-5/6-6）

- **通道合并**：不合并 STREAM_* 为统一通道。成本（preload API 重写 + 渲染层监听重写 + 测试更新 + 高频通道处理开销）远超收益
- **版本管理**：不引入 v2 前缀。当前无通道需 v2 重构，三处同步（channels + preload + handler）增加复杂度
- **未来触发时机**：通道数超 150 或出现跨领域 handler 时启动合并评估

#### 通道归属检查流程（AUDIT-6-3）

新增 IPC 通道时，必须按以下流程检查归属：

1. **确定功能域**：新通道属于哪个功能域（对话/会话/记忆/配置/系统/建议/作品投影）？
2. **handler 文件归属**：新通道的 handler 必须放在对应功能域的 handler 文件中（见上方"功能域分组"表）
3. **通道清理注册**：`ipcMain.handle` 通道必须在 `ipc/index.ts` 的 `HANDLE_CHANNELS` 数组中添加；`ipcMain.on` 通道必须在 `ON_CHANNELS` 数组中添加（reinitAgent 重复注册时清理）
4. **preload 同步**：在 `preload.ts` 的内联通道常量中同步新增（sandbox 兼容性要求）
5. **API 暴露**：在 `preload.ts` 的 `electronAPI` 对象中新增对应的 API 方法
6. **通道校验**：运行 `npx tsx scripts/check-ipc-channels.ts` 验证 channels.ts 与 preload.ts 的双向一致性
7. **测试更新**：在 `src/__tests__/electron/ipc/handlers.test.ts` 的 mock IpcContext 中新增通道相关字段（如 IpcContext 接口有变化）

**PR review checklist**：

- [ ] 新通道已归入正确功能域的 handler 文件
- [ ] `HANDLE_CHANNELS` 或 `ON_CHANNELS` 已添加新通道
- [ ] `preload.ts` 内联通道常量已同步
- [ ] `electronAPI` 已暴露对应 API 方法
- [ ] `check-ipc-channels.ts` 校验通过
- [ ] mock IpcContext 已更新（如 IpcContext 接口有变化）

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
- [x] CSS-R1: P0 令牌统一——抽出 tokens.css 作为单一真理源，float.html/quick-input.html 移除内联 `<style>` 变量块，CSP 收紧为 `style-src 'self'`（2026-07-09）
- [x] CSS-R2: P2 大文件拆分——chat.css(2960行)→4 子模块，memory.css(2197行)→4 子模块，原文件降级为 @import 聚合器（2026-07-09）
- [x] F-LINE-2: memoryPanelManager 拆分——helpers/memoryGraphPanel.ts（图谱视图子系统，~318 行）+ helpers/memoryDetailPanel.ts（记忆详情子系统，~368 行）提取，主文件 1968→1334 行（2026-07-11）
- [x] ITER-2: relationGraph 拆分——helpers/relationGraphLayout.ts（力导向布局算法）+ helpers/relationGraphColor.ts（节点/边配色映射）提取，主文件 -231 行（2026-07-12 迭代 2）
- [x] ITER-5: ui.ts mixin 拆分——helpers/applyMixins.ts（mixin 注入工具）+ helpers/uiDelegations/ 6 委托群（chat/dashboard/memory/misc/personaTheme/settingsModal）提取，ui.ts 1751→904 行（2026-07-12 迭代 5）
- [x] ITER-6: 3 Panel 过厚拆分——settingsPanelManager 提取 helpers/providerManagement.ts + helpers/shortcutCapture.ts（-455 行）；memoryPanelManager 提取 helpers/memoryViewSwitcher.ts + helpers/memoryTimelineView.ts（-496 行）；chatPanelManager 提取 helpers/streamingRenderer.ts + helpers/streamSafetyTimer.ts（-404 行）（2026-07-12 迭代 6）
- [x] ITER-7: sprite/ 测试补全——新增 spriteLifecycleManager/spriteConfigManager/spriteTracer/constants/errors 5 个测试文件 +136 测试（2026-07-12 迭代 7，非目录结构变更）
- [x] HEALTH-0712-6: sourceColor 提取——helpers/sourceColor.ts（getSourceColorClass 纯函数 + KNOWN_SOURCES 常量）从 memoryPanelManager 提取，消除 helpers→panels 循环依赖，5 个调用点导入路径更新，测试迁移到 sourceColor.test.ts（2026-07-12 斩木除根）
- [x] ITER-8: relationGraph 二次拆分——helpers/relationGraphTypes.ts（7 类型 + 14 常量，架构层类型真理源）+ helpers/relationGraphGeometry.ts（5 纯函数：nodeRadius/screenToWorld/findNodeAt/findEdgeAt/pointToSegmentDist）提取，主文件 1206→889 行（-26%），消除 relationGraphLayout.ts 对 components 的 type-only 循环依赖（2026-07-13 神木回天）

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