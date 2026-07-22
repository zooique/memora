# Memora Sprite · 最终目录形态

> **设计原则**：按职责分组，而非按类型分组；每个目录有明确边界；禁止单文件目录；禁止命名冲突。
> **当前状态**：D-01~D-14 全部完成 + S-02 shared 模块已落地（DWM-01 双模式 Web 调试，含 hostContext/inputValidation/shortcutDefaults 三个文件）+ F-LINE-2 memoryPanelManager 拆分（memoryGraphPanel/memoryDetailPanel 两个 helper 提取）+ 迭代 5-7 ui.ts mixin 拆分（applyMixins + uiDelegations/ 6 委托群，1751→904 行）+ 3 Panel 过厚拆分（settings/memory/chat helper 提取）+ relationGraph 拆分（types/layout/color/geometry 四 helper，1206→889 行）+ sourceColor 提取（消除 helpers→panels 循环依赖）+ helpers 补登 4 文件（buttonHelpers/completionHelpers/completionMetrics/safeStorage，v2.2 规则对齐）+ helpers 类形式例外显式标注（EventTracker/SafeTimerTracker/ScrollController/StreamSafetyTimer/CompletionMetrics/NarrativeGenerator）+ CSS-R7 样式层规则对齐（memory/completion-stats.css + panels/clipboard.css 规则补登记 + index.html 重复 link 清理 + float.html 浮窗三层加载补齐 + clipboard.css 死代码剪枝 + completion-stats.css 11 处裸 px 令牌化）。目录形态已对齐最终目标。
> **版本**：v2.5（2026-07-19，STEP9 斩木除根同步：§1 preload-float→preloadFloat / preload-quick-input→preloadQuickInput（NAMING-2/3，camelCase 对齐 TS 规范）+ uiDelegations/→ui-delegations/（NAMING-1，文件夹 kebab-case 规范）+ shared/ 补登 5 文件（numberUtils/levelUtils/sensitivePatterns/llmErrorClassifier/spriteStats，STEP4-3 + STEP7 漏检补登）+ panels/ 补登 3 文件（clipboardPanelManager/completionStatsRenderer/llmGovernanceResultRenderer，STEP6-5）+ components/ 补登 startupSummaryBanner（STEP6-5）+ §3 迁移日志新增 STEP9-NAMING-1/2/3 + STEP9-DUP-1 + STEP9-DEP-1/2 + STEP4-3 + STEP6-5 + STEP7 漏检补登条目）

---

## 1. 完整目录树

```
src/
├── index.ts                    # 纯库导出入口（类型 + 接口 + startSprite）
├── cli.ts                      # CLI 入口（setupWizard + 命令路由 + REPL）
│
├── electron/                   # Electron 主进程 + 渲染进程
│   ├── main.ts                 # 主进程入口（窗口生命周期 + 应用启动）
│   ├── preload.ts              # 预加载脚本（contextBridge 暴露 API，主窗口完整 UI ~266 API）
│   ├── preloadFloat.ts         # 浮动窗口预加载脚本（12 API 最小化暴露面，ADR-SP-017 独立化；camelCase 命名规范，STEP9-NAMING-2）
│   ├── preloadQuickInput.ts    # 快速输入浮窗预加载脚本（10 API 最小化暴露面，ADR-SP-017 独立化；camelCase 命名规范，STEP9-NAMING-3）
│   ├── esmShim.ts              # ESM 兼容 shim（__dirname 替代）
│   ├── errorHandler.ts         # 全局错误处理（分类 + 日志 + 降级）
│   ├── interaction.ts          # Electron 交互实现（IInteraction 接口）
│   ├── agentListeners.ts       # Agent 事件监听器（配置建议/写入确认/审计）
│   ├── spriteEventBridge.ts    # 精灵事件桥接（主进程 → 渲染进程通知）
│   ├── trayIcon.ts             # 系统托盘管理
│   ├── clipboardHandler.ts     # 剪贴板三重保护处理器（Phase 3.1）
│   ├── inputInjector.ts        # 输入注入器（Phase 4 自动粘贴：nut-js 窗口管理 + 键盘模拟）
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
│   │   ├── quickInputWindow.ts # 快速输入浮窗（单例/懒创建/失焦延迟关闭/Phase 4 自动粘贴）
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
│       ├── helpers/            # 渲染进程工具函数（不持有可变状态、可独立测试；类形式例外：EventTracker/SafeTimerTracker/ScrollController/StreamSafetyTimer/CompletionMetrics/NarrativeGenerator/TimeRefresher，状态封闭在实例内、职责单一）
│       │   ├── domHelpers.ts   # DOM 操作辅助（安全查询/批量操作/统一时间格式化/createEmptyState/setButtonLoadingEl）
│       │   ├── errorHelpers.ts # 错误处理辅助（IPC 错误处理器工厂 + reportError 日志输出）
│       │   ├── errorState.ts   # 错误状态辅助（全局错误状态管理 + 重试按钮渲染）
│       │   ├── eventTracker.ts # 事件追踪类（埋点/用户行为记录 + 统一事件清理）
│       │   ├── formValidation.ts # 表单校验辅助（输入校验规则 + 必填字段 blur 即时校验）
│       │   ├── icon.ts         # 图标辅助（SVG 图标加载/渲染）
│       │   ├── initFailureCard.ts # 初始化失败卡片辅助（启动失败时渲染降级卡片）
│       │   ├── messageDecorations.ts # 消息装饰辅助函数（系统消息/错误消息样式/思考阶段中文映射）
│       │   ├── messageOperations.ts # 消息操作辅助（消息 CRUD 纯函数 + 跨 group 遍历）
│       │   ├── narrativeGenerator.ts # 叙事生成器类（感知叙事文本生成，累积器模式持有 lastNarrative* 状态）
│       │   ├── perceptionLabels.ts # 感知标签辅助（情感/默契/上下文标签文本）
│       │   ├── scrollController.ts # 滚动控制器类（消息列表自动滚动/锚定/rAF 节流）
│       │   ├── toolCallCard.ts # 工具调用卡片辅助（工具执行状态展示）
│       │   ├── safeTimer.ts    # 安全定时器类（SafeTimerTracker，自动清理/防泄漏）
│       │   ├── safeStorage.ts  # localStorage 安全读写纯函数（safeGetJSON/safeSetJSON/safeGet/safeSet，try-catch 静默降级，从 5+9 处提取）
│       │   ├── buttonHelpers.ts # 按钮事件绑定辅助（bindRefreshButton，按钮 click→loading→异步操作→恢复 标准模式）
│       │   ├── completionHelpers.ts # 补全模块共享工具（fetchMemoryContent，提取 quickInput/inputAreaManager 重复的 fillFromMemory 逻辑）
│       │   ├── completionMetrics.ts # 补全统计埋点单例类（CompletionMetrics + getCompletionMetrics，LRU 500 条 + 实时聚合，FNV-1a hash 去标识化）
│       │   ├── timeRefresher.ts # 全局相对时间刷新器单例类（TimeRefresher，window focus/visibilitychange/60s 定时器三重触发，刷新所有 data-timestamp 元素）
│       │   │
│       │   ├── chatPanelEvents.ts # 对话面板事件监听辅助（从 chatPanelManager 提取）
│       │   ├── streamSafetyTimer.ts # 流式安全兜底定时器类（StreamSafetyTimer，30s/90s 二级兜底，从 chatPanelManager 提取）
│       │   │
│       │   ├── memoryDetailPanel.ts # 记忆详情子系统辅助（F-LINE-2 从 memoryPanelManager 提取：详情/脉络/邻居/按钮）
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
│       │   ├── applyMixins.ts  # Mixin 注入工具（applyMixins 函数，将 ui-delegations/ 委托群方法分发到 UIManager）
│       │   └── ui-delegations/ # UIManager 委托群（mixin 模式，按业务域聚合的方法集合；kebab-case 命名规范，STEP9-NAMING-1）
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
│       │   ├── markdown.ts          # Markdown 渲染
│       │   └── startupSummaryBanner.ts # 启动摘要横幅组件（对话区顶部展示记忆/洞察/技能/衰减/感知/健康聚合数据，从 chatPanelManager 提取，STEP6-5）
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
│       │   ├── completionStatsRenderer.ts # 补全统计面板渲染器（第 3 个 analysis panel，ADR-SP-015 模式 C+D，由 memoryPanelManager 持有，STEP6-5）
│       │   ├── llmGovernanceResultRenderer.ts # LLM 治理结果子渲染器（健康度面板"LLM 治理结果"子区域，ADR-SP-015 模式 C+D，由 memoryController 持有，STEP6-5）
│       │   ├── panelErrorBannerManager.ts # 面板错误横幅（C-5-1 拆分，自包含 EventTracker）
│       │   ├── clipboardManager.ts       # 剪贴板保护（C-5-2 拆分，依赖注入 ToastManager + ModalManager）
│       │   ├── clipboardPanelManager.ts  # 剪贴板面板 UI 渲染层（待处理列表/角标/空状态/批量操作/引导气泡，从 clipboardManager 拆分 UI 部分，STEP6-5）
│       │   ├── dateNavManager.ts         # 日期导航（C-5-3 拆分，自包含 EventTracker）
│       │   ├── skillDropManager.ts       # 技能拖入安装（C-5-4 拆分，依赖注入 ToastManager）
│       │   ├── archiveButtonManager.ts   # 归档按钮管理（manual 模式消息归档按钮，从 chatPanelManager 拆分）
│       │   ├── badgeManager.ts           # 未读徽章管理器（未读计数 + 徽章 DOM 更新，ADR-SP-015 §2 cleanup 契约）
│       │   ├── inputAreaManager.ts       # 输入区域管理（键盘事件/自适应高度/发送按钮，从 UIManager 拆分）
│       │   ├── searchMessagesManager.ts  # 消息搜索管理器（对话内搜索 + 防抖 + 高亮）
│       │   ├── spriteStatusPopover.ts    # 精灵状态浮层（在线状态/记忆量/主动行为提示）
│       │   ├── streamingRenderer.ts      # 流式 RAF 渲染核心（context 注入纯函数，chatPanelManager 子模块，AUDIT-0716-3 从 helpers/ 迁入消除循环依赖）
│       │   ├── memoryGraphPanel.ts       # 图谱视图子系统（memoryPanelManager 子模块：初始化/空状态/缓存/上下文菜单/关系弹窗，AUDIT-0716-3 从 helpers/ 迁入消除循环依赖）
│       │   └── panelRouter.ts            # 面板路由器（双维度路由：switchPanel 主面板区 + switchAuxTab/openAuxSidebar/toggleAuxSidebar 信息侧栏；auxSidebarOpen/activeAuxTab 状态；isAuxTabVisible 替代 getCurrentPanel 用于侧栏面板可见性判断）
│       │
│       ├── float/              # 浮动窗口
│       │   ├── float.ts        # 浮动窗口渲染进程逻辑
│       │   └── float.html      # 浮动窗口 HTML 入口（CSS 已迁入 styles/windows/float.css）
│       │
│       ├── quick-input/        # 快速输入补全浮窗（Phase 1-2）
│       │   ├── quickInput.ts            # 快速输入控制器（QuickInputController：键盘事件/流式模式/展开收起/LLM润色/拖动/确认流程）
│       │   ├── quickInputCompletion.ts  # 补全候选管理器（记忆/历史搜索 + 去重排序）
│       │   └── quick-input.html         # 快速输入 HTML 入口（CSS 已迁入 styles/windows/quick-input.css）
│       │
│       └── styles/             # CSS 样式表（详见 §2.4 CSS 架构规则，按功能域分组）
│           ├── README.md       # CSS 架构文档（令牌所有权 + 聚合器模式 + 贡献约定 + 目录分组规则）
│           │
│           ├── foundation/    # 基础层（设计令牌 + 全局重置 + 工具类，三窗口共享）
│           │   ├── tokens.css      # 设计令牌「单一真理源」（P0：双主题变量 + CJK 字体栈）
│           │   ├── base.css        # 全局重置 / 滚动条 / 动画 / focus-visible / 图标系统 / 通用组件基类
│           │   └── utilities.css   # 通用工具类（flex-center / flex-col / surface-card / text-muted 等）
│           │
│           ├── layout/        # 布局层（窗口骨架）
│           │   └── layout.css      # 顶栏 + 64px 侧栏 + 核心窗口 Grid 布局 + 信息侧栏双栏布局（2.1：#main-content.aux-open grid-template-columns 1fr/1px/280px，含 .aux-sidebar-divider/.aux-sidebar-header/.aux-tab/.aux-sidebar-content/.sidebar-divider）
│           │
│           ├── chat/          # 对话功能域（聚合器 + 7 子模块）
│           │   ├── chat.css             # 聚合器（@import 7 子模块，P2 拆分 + 二级拆分）
│           │   ├── chat-toolbar.css     # 对话工具栏 / 状态条 / 在场脉冲浮层
│           │   ├── chat-perception.css  # 对话内嵌感知紧凑布局
│           │   ├── chat-datenav.css     # 回到今天 / 日期选择 / 下拉 / 空状态
│           │   ├── chat-messages-banner.css  # 主动提示横幅 / 里程碑 / 配置建议卡片（二级拆分）
│           │   ├── chat-messages-bubble.css  # 日期分隔符 / 消息分组 / 气泡 / 头像 / 召回（二级拆分）
│           │   ├── chat-messages-input.css   # 输入区 / 补全 / 停止按钮 / 空状态（二级拆分）
│           │   └── chat-messages-misc.css    # 思考指示器 / 工具卡片 / 动画 / 启动摘要 / 右键菜单（二级拆分）
│           │
│           ├── memory/        # 记忆功能域（聚合器 + 7 子模块 + 1 分析子面板）
│           │   ├── memory.css             # 聚合器（@import 7 子模块 + 1 分析子面板，P2 拆分 + 二级拆分）
│           │   ├── memory-list.css        # 面板头 / 搜索 / 记忆列表卡片 / 来源标签
│           │   ├── memory-detail.css      # 记忆详情弹窗 / 技能列表 / 全局·项目色
│           │   ├── memory-views.css       # 视图过渡 / 时间线 / Profile 卡片 / 知识缺口 / 成长趋势
│           │   ├── memory-graph-core.css  # 更多菜单 / 图例 / tooltip / 右键菜单 / 关系编辑（二级拆分）
│           │   ├── memory-graph-search.css # 高级搜索 / 搜索高亮 / 洞察栏（二级拆分）
│           │   ├── memory-graph-detail.css # 关联记忆 / 演化脉络 / 空状态 / 健康度仪表盘（二级拆分）
│           │   ├── memory-graph-misc.css  # 增强 1-5 / 时间线 / 回收站（二级拆分）
│           │   └── completion-stats.css  # 补全统计面板（记忆面板第 3 个 analysis panel，与 insights/health 互斥切换）
│           │
│           ├── panels/        # 独立面板样式（每个对应一个 .panel）
│           │   ├── dashboard.css   # 仪表盘面板（概览+运行指标+记忆源健康+增长趋势）
│           │   ├── perception.css  # 独立感知面板（覆盖 chat-perception.css 基础样式）
│           │   ├── clipboard.css   # 剪贴板保护面板（待处理列表 + 引导气泡 + 空状态，clipboardPanelManager 使用）
│           │   └── settings.css    # 设置面板
│           │
│           ├── overlays/      # 浮层组件（modal / toast / 命令面板 / 搜索弹窗）
│           │   ├── modal.css           # 模态弹窗
│           │   ├── toast.css           # Toast 通知
│           │   ├── command-palette.css # 快捷命令面板（Ctrl+K，类 VS Code 浮层）
│           │   └── search-messages.css # 对话内容搜索弹窗（Ctrl+Shift+F）
│           │
│           ├── content/       # 内容渲染样式
│           │   └── markdown.css    # Markdown 渲染
│           │
│           └── windows/       # 独立窗口专属样式（从 float/ 和 quick-input/ 迁入，统一管理）
│               ├── float.css       # 浮动窗口（令牌从 foundation/tokens.css 共享引入）
│               └── quick-input.css # 快速输入浮窗（引入 foundation 三层 + 本地组件样式）
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
│   ├── errors.ts               # 宿主层共享错误类型（ErrorCode 枚举 + SpriteError 类，零 Electron 依赖）
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
│   ├── shortcutDefaults.ts     # 快捷键默认配置（ShortcutConfig 类型 + DEFAULT_SHORTCUTS 常量，主进程+渲染进程共用）
│   ├── toError.ts              # 跨进程错误转换纯函数（与内核 utils/toError 行为对齐，渲染进程真理源）
│   ├── dateUtils.ts            # 日期工具纯函数（formatDateKey 本地时区 YYYY-MM-DD，与内核 utils/time 对齐）
│   ├── truncate.ts             # 文本截断纯函数（跨 renderer/sprite/storage 共用，统一 ellipsis U+2026）
│   ├── escapeRegExp.ts         # 正则转义纯函数（构造正则前转义用户输入特殊字符）
│   ├── safeWriteJson.ts        # 安全 JSON 写入纯函数（try-catch 防失败 + 原子写入语义）
│   ├── singleton.ts            # 同步单例工厂纯函数（createSingleton，ADR-017 枝叶层 2 次提取）
│   ├── numberUtils.ts          # 数值工具纯函数（roundTo2，从 affectController/rapportController/memoryController 7+ 处提取，STEP4-3）
│   ├── levelUtils.ts           # 等级标签纯函数（describeLevel 0-1→低/中/高，从 affectController/rapportController 2 处提取，STEP4-3）
│   ├── sensitivePatterns.ts    # 敏感内容检测模式与函数（SENSITIVE_PATTERNS 常量 + isSensitive 纯函数，从 clipboardHandler 下沉，STEP7 漏检补登）
│   ├── llmErrorClassifier.ts   # LLM 错误分类器纯函数（底层 API 错误→用户可理解中文提示映射，主进程+渲染进程共用，STEP7 漏检补登）
│   └── spriteStats.ts          # 精灵统计共享类型（ProactiveStats 类型定义，从 proactiveEngine 提取消除 renderer 反向依赖，STEP7 漏检补登）
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

### 2.4 CSS 架构规则（2026-07-15 重构：按功能域分组 + 浮窗统一管理）

#### 2.4.1 目录分组（8 个功能域子目录）

styles/ 按**功能域**分组，与渲染进程代码组织（panels/components/helpers）一致。禁止平铺 CSS 文件。

| 子目录 | 职责 | 加载顺序 | 文件数 |
|--------|------|----------|--------|
| `foundation/` | 设计令牌 + 全局重置 + 工具类（三窗口共享） | 1-3 | 3（tokens/base/utilities）|
| `layout/` | 窗口骨架（顶栏/侧栏/Grid） | 4 | 1 |
| `chat/` | 对话功能域（聚合器 + 7 子模块） | 5-12 | 8 |
| `memory/` | 记忆功能域（聚合器 + 7 子模块 + 1 分析子面板 completion-stats） | 13-21 | 9 |
| `panels/` | 独立面板样式（dashboard/perception/clipboard/settings） | 22-25 | 4 |
| `overlays/` | 浮层组件（modal/toast/命令面板/搜索弹窗） | 26-29 | 4 |
| `content/` | 内容渲染样式（markdown） | 30 | 1 |
| `windows/` | 独立窗口专属样式（float/quick-input，从原窗口目录迁入） | 浮窗独立引入 | 2 |

#### 2.4.2 令牌单一真理源

`foundation/tokens.css` 是唯一令牌定义处。三窗口（主窗/浮窗/快速输入窗）通过 `<link>` 共享引入 `../styles/foundation/tokens.css`。**禁止在任何窗口内联 `<style>` 块**。修改令牌只能改 `tokens.css`。

#### 2.4.3 CSP 收紧

主窗/浮窗/快速输入窗 `style-src` 均为 `'self'`（无 `'unsafe-inline'`），杜绝内联样式注入。

#### 2.4.4 聚合器模式

`chat/chat.css` / `memory/memory.css` 为纯 `@import` 聚合器，不包含任何直接样式规则。`@import` 路径使用相对路径（如 `@import "./chat-toolbar.css";`），顺序保持与原单体文件一致，层叠等价。

#### 2.4.5 拆分切点

按功能域切分，切点必须落在规则边界（大括号配平处），禁止在 CSS 规则中间切分。

#### 2.4.6 间距/圆角/动画时长令牌化

- 间距/圆角走 `--space-*` / `--radius-*` 令牌，禁止裸写 px（布局 width/height 等除外）。
- 动画播放时长走 `--duration-*` 令牌（`--duration-spin` / `--duration-breathing` / `--duration-float` / `--duration-pulse-slow`），与 `--transition-*` 过渡时长语义区分：前者是 `animation` 播放时长，后者是 `transition` 过渡时长。
- 激活态语义色走 `--active-bg` / `--active-bg-strong` / `--active-fg` / `--active-border` 四件套，统一 `.active` / `.selected` / `.current` 三套语义。

#### 2.4.7 浮窗 CSS 归属

`windows/float.css` 和 `windows/quick-input.css` 从原 `float/` 和 `quick-input/` 目录迁入 styles/，统一管理。HTML 中的 `<link>` 路径改为 `../styles/windows/xxx.css`。浮窗独立 BrowserWindow 不共享主窗口 SVG sprite，需在 HTML 中内联定义（详见各浮窗 HTML）。

#### 2.4.8 贡献约定

- 新增子模块在聚合器 `@import` 列表按层叠顺序追加
- 新组件样式放进对应功能域子目录（如对话相关 → `chat/`，记忆相关 → `memory/`）
- 新增独立面板 → `panels/`；新增浮层组件 → `overlays/`
- 新增独立窗口 → `windows/`（必须引入 foundation/ 三层 + 本地组件样式）

#### 2.4.9 加载顺序（index.html）

```
foundation/tokens.css → foundation/base.css → foundation/utilities.css
→ layout/layout.css
→ chat/chat.css（聚合器，内部 @import 7 子模块）
→ memory/memory.css（聚合器，内部 @import 7 子模块）
→ panels/dashboard.css → panels/perception.css → panels/settings.css
→ overlays/modal.css → overlays/toast.css → overlays/command-palette.css → overlays/search-messages.css
→ content/markdown.css
```

浮窗（float.html / quick-input.html）独立加载：`foundation/tokens.css` → `foundation/base.css` → `foundation/utilities.css` → `windows/xxx.css`。

### 2.5 IPC 通道治理现状（2026-07-12，排雷 AUDIT-6-2）

> **来源**：排雷报告方向六 · IPC 通道治理

#### 通道规模

| 方向 | 通道数 | 定义文件 |
|------|--------|----------|
| 渲染→主进程（`IPC_CHANNELS`） | 88 | `src/electron/ipc/channels.ts` |
| 主→渲染进程（`MAIN_TO_RENDERER_CHANNELS`） | 28 | 同上 |
| **合计** | **116** | 单一真理源 |

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

#### 窗口管理器内联 IPC 例外（ADR-SP-017）

> **例外**：窗口管理器内联 IPC 通道共 15 个，分布在 3 个窗口文件中，不在 `ipc/` 下的 handler 文件中。
> 决策原则（STEP3-18，最小修改原则）：扩展例外清单，不迁移到 `ipc/windowHandlers.ts`——窗口管理器内联 handler 深度耦合窗口实例状态，迁移需反向注入窗口引用，违反分层方向。

**quick-input 浮窗（8 个通道，`src/electron/windows/quickInputWindow.ts`）**

| 通道 | 模式 | 注册位置 | 内联理由 |
|------|------|---------|---------|
| QUICK_INPUT_CONFIRM | `ipcMain.handle` | quickInputWindow.ts | 深度耦合窗口生命周期（流式 blur 抑制、paste 后聚焦） |
| QUICK_INPUT_CLOSE | `ipcMain.handle` | quickInputWindow.ts | 操作 `this.hide()`，需窗口实例 |
| QUICK_INPUT_RESIZE | `ipcMain.handle` | quickInputWindow.ts | 操作 `this.win.setSize()` + `keepWindowInWorkArea()` |
| MOVE_QUICK_INPUT | `ipcMain.on` | quickInputWindow.ts | 操作 `this.win.setPosition()` + `clampPositionToWorkArea()` |
| QUICK_INPUT_POLISH | `ipcMain.handle` | quickInputWindow.ts | 调用 `this.callbacks.onPolish`（main.ts 注入） |
| QUICK_INPUT_SET_PINNED_MODE | `ipcMain.handle` | quickInputWindow.ts | 操作 `this.pinnedMode` 字段，控制 blur 抑制行为（常驻模式） |
| QUICK_INPUT_SHOW | 主→渲染 | quickInputWindow.ts | 浮窗唤起信号 |
| QUICK_INPUT_FOCUS_CHANGE | 主→渲染 | quickInputWindow.ts | 推送前台应用名到浮窗（focus-bar 显示来源） |

**浮动窗口（4 个通道，`src/electron/windows/floatWindow.ts`）**

| 通道 | 模式 | 注册位置 | 内联理由 |
|------|------|---------|---------|
| MOVE_FLOAT_WINDOW | `ipcMain.on` | floatWindow.ts | 操作 `this.win.setPosition()`（拖动增量） |
| SAVE_FLOAT_POSITION | `ipcMain.on` | floatWindow.ts | 操作 `this.windowStateManager.saveFloatPosition()` |
| EXPAND_TO_FULL | `ipcMain.on` | floatWindow.ts | 操作 `this.windowStateManager.transition('full')` |
| FLOAT_CONTEXT_MENU | `ipcMain.on` | floatWindow.ts | 操作 `this.showContextMenu()`（Menu.popup 需窗口实例） |

**完整窗口（3 个通道，`src/electron/windows/windowManager.ts`）**

| 通道 | 模式 | 注册位置 | 内联理由 |
|------|------|---------|---------|
| WINDOW_MINIMIZE | `ipcMain.on` | windowManager.ts | 操作 `this.fullWindow.minimize()` |
| WINDOW_MAXIMIZE | `ipcMain.on` | windowManager.ts | 操作 `this.fullWindow.maximize()`/`unmaximize()` |
| WINDOW_CLOSE | `ipcMain.on` | windowManager.ts | 操作 `this.fullWindow.close()` |

**判定标准**（详见 [ADR-SP-017 §1](../../../.trae/rules/decisions/ADR-SP-017-quick-input-architecture.md)）：当 IPC handler 需深度访问窗口实例状态（焦点/位置/可见性/blur 定时器/窗口状态机）时，在窗口管理器内注册；无状态数据操作放 `ipc/` 下。

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
- **未来触发时机**：通道数超 130 或出现跨领域 handler 时启动合并评估（阈值从 150 收紧至 130，对齐用户口径；当前 116，距阈值 14）

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
- [x] CSS-R3: 二级拆分——chat-messages.css(1941行)→4 子模块（banner/bubble/input/misc）+ memory-graph.css(1225行)→4 子模块（core/search/detail/misc），chat.css/memory.css 聚合器 @import 更新，层叠等价（2026-07-13 组合拳）
- [x] CSS-R4: P0 减法——base.css 拆分出 command-palette.css(166行) + search-messages.css(198行)，base.css 620→345 行(-44%)，回归"基础样式"定位（2026-07-13 问诊 CSS 减法）
- [x] CSS-R5: utilities.css 中间层——新增 5 个原子工具类（flex-center/flex-col/flex-row-center/surface-card/text-muted），从 3577 条属性声明提取 Top 重复模式（2026-07-13 P1 试点）
- [x] CSS-R6: styles/ 按功能域分组重构——8 个子目录（foundation/layout/chat/memory/panels/overlays/content/windows），浮窗 CSS（float.css + quick-input.css）从原窗口目录迁入 styles/windows/，index.html/float.html/quick-input.html 的 `<link>` 路径更新，chat.css/memory.css 聚合器内部 @import 改为同目录相对路径（2026-07-15 模块重思）
- [x] RULE-ALIGN-0719: helpers/ 补登 4 文件——buttonHelpers.ts（bindRefreshButton）/ completionHelpers.ts（fetchMemoryContent）/ completionMetrics.ts（CompletionMetrics 单例）/ safeStorage.ts（safeGetJSON/safeSetJSON/safeGet/safeSet），同步 §1 helpers 节增加"类形式例外"注释（EventTracker/SafeTimerTracker/ScrollController/StreamSafetyTimer/CompletionMetrics/NarrativeGenerator）（2026-07-19 炼化归元 Step 7 规则对齐）
- [x] CSS-R7: 样式层规则对齐 + 剪枝 + 提交前审查——(1) directory-structure.md §1/§2.4.1 + styles/README.md §1/§2/§4 补齐 memory/completion-stats.css（第 3 个 analysis panel）+ panels/clipboard.css（剪贴板保护面板）两个规则漏登记的文件；(2) index.html 删除 chat-toolbar/datenav/perception 3 处重复 link（聚合器 chat.css 已 @import，违反 §2.4.4 聚合器模式）；(3) float.html 补 base.css + utilities.css 两 link（违反 §2.4.9 浮窗加载顺序）；(4) panels/clipboard.css 删除死代码 .clipboard-list-hidden（与对称 .clipboard-actions-hidden 对比是遗漏实现的对称设计，clipboardPanelManager.ts 零引用）；(5) memory/completion-stats.css 11 处裸 px 令牌化（保留 1px/2px 次像素对齐 + max-height 容器高度）（2026-07-19 炼化归元 Step 8）
- [x] STEP4-3: shared/ 补登 2 文件——numberUtils.ts（roundTo2 纯函数，从 affectController/rapportController/memoryController 7+ 处 `Math.round(x*100)/100` 模式提取，ADR-017 枝叶层 2 次提取）+ levelUtils.ts（describeLevel 0-1→低/中/高，从 affectController/rapportController 2 处完全相同实现提取）（2026-07-19 炼化归元 Step 4 QC-1）
- [x] STEP6-5: panels/ + components/ 补登 4 文件——panels/clipboardPanelManager.ts（剪贴板面板 UI 渲染层，从 clipboardManager 拆分 UI 部分）+ panels/completionStatsRenderer.ts（补全统计面板渲染器，第 3 个 analysis panel，ADR-SP-015 模式 C+D）+ panels/llmGovernanceResultRenderer.ts（LLM 治理结果子渲染器，健康度面板"LLM 治理结果"子区域，ADR-SP-015 模式 C+D）+ components/startupSummaryBanner.ts（启动摘要横幅组件，从 chatPanelManager 提取）（2026-07-19 炼化归元 Step 6 QC-5）
- [x] STEP7-补登: shared/ 补登 3 文件——sensitivePatterns.ts（SENSITIVE_PATTERNS 常量 + isSensitive 纯函数，从 electron/clipboardHandler.ts 下沉到 shared/ 便于跨环境复用）+ llmErrorClassifier.ts（LLM 错误分类器纯函数，底层 API 错误→中文提示映射，主进程+渲染进程共用）+ spriteStats.ts（ProactiveStats 类型定义，从 sprite/controllers/proactiveEngine.ts 提取消除 renderer 反向引用 sprite/controllers 的跨子系统依赖）（2026-07-19 STEP9 文档同步漏检补登）
- [x] STEP9-NAMING-1: uiDelegations/ → ui-delegations/——helpers/uiDelegations/ 6 委托群文件夹重命名为 kebab-case（对齐 project-rules.md §4 文件夹命名规范），6 个委托文件（chatDelegations/dashboardDelegations/memoryDelegations/miscDelegations/personaThemeDelegations/settingsModalDelegations）路径同步，ui.ts 8 处导入 + applyMixins.ts 注释 + uiDelegations.test.ts 6 处导入路径更新（2026-07-19 斩木除根 NAMING-1）
- [x] STEP9-NAMING-2: preload-float.ts → preloadFloat.ts——浮动窗口预加载脚本重命名为 camelCase（对齐 project-rules.md §4 TS 文件命名规范），tsconfig.preload.json include + tsconfig.electron.json exclude + build-preload.mjs 4 处（注释块 + stale*Path 常量 + copyPreload 调用）+ floatWindow.ts 2 处（注释 + preload 路径 preloadFloat.cjs）+ 文件内 2 处注释更新（2026-07-19 斩木除根 NAMING-2）
- [x] STEP9-NAMING-3: preload-quick-input.ts → preloadQuickInput.ts——快速输入浮窗预加载脚本重命名为 camelCase（TS 文件命名规范；HTML 文件 quick-input.html 保持 kebab-case 不变），tsconfig.preload.json include + tsconfig.electron.json exclude + build-preload.mjs 4 处 + quickInputWindow.ts 2 处 + 文件内 1 处注释更新（2026-07-19 斩木除根 NAMING-3）
- [x] STEP9-DUP-1: 跨包契约测试——新增 src/__tests__/shared/toError.contract.test.ts（16 测试用例：Error 实例 identity + Error 子类 + 12 契约用例表驱动 + symbol + 循环引用），导入 sprite `../../shared/toError.js` + 内核 `memora` 公共 API（避免内部路径导入，符合架构分层），防止两套 toError 实现行为漂移（2026-07-19 斩木除根 DUP-1）
- [x] STEP9-DEP-1: memora 内核 12 devDeps 非 Major 升级——@commitlint/cli 21.1.0→21.2.1 + @commitlint/config-conventional 21.1.0→21.2.0 + @types/node 22.15.30→22.20.1 + @typescript-eslint/eslint-plugin 8.32.0→8.64.0 + @typescript-eslint/parser 8.32.0→8.64.0 + @vitest/coverage-v8 4.0.0→4.1.10 + eslint 9.27.0→9.39.5 + lefthook 1.6.10→1.7.0 + msw 2.8.0→2.15.0 + pino-pretty 11.2.0→11.2.0 + prettier 3.5.3→3.9.5 + tsc-alias 1.8.16→1.9.1 + tsx 4.19.2→4.23.1 + vitest 4.0.0→4.1.10（2026-07-19 斩木除根 DEP-1）
- [x] STEP9-DEP-2: sprite 宿主 8 devDeps 非 Major 升级——@types/node 24.0.0→24.13.3 + @typescript-eslint/eslint-plugin 8.32.0→8.64.0 + @typescript-eslint/parser 8.32.0→8.64.0 + electron 40.10.5→40.10.6（需 npm run rebuild 重建 native 模块）+ eslint 9.27.0→9.39.5 + prettier 3.5.3→3.9.5 + tsx 4.19.2→4.23.1 + vitest 4.0.0→4.1.10（2026-07-19 斩木除根 DEP-2）
- [x] INFO-ARCH-2.1: 信息架构重构双栏布局——(1) layout.css `#main-content` 改为 `display: grid`，`.aux-open` 状态下 `grid-template-columns: 1fr 1px var(--aux-sidebar-width)`（主面板区 + 1px 分隔线 + 280px 信息侧栏）；(2) index.html 新增 `#btn-toggle-aux` 单图标按钮（#icon-panel-right）+ `.main-panel-area` 包裹层 + `.aux-sidebar-divider` + `#aux-sidebar`（含 `.aux-sidebar-header` + 2 个 `.aux-tab` + `.aux-sidebar-content`）+ `.sidebar-divider` 视觉分隔线；(3) panelRouter.ts 扩展双维度路由：`switchPanel()` 主面板区（chat/memories/clipboard/settings，选择器限定 `.nav-btn[data-panel]` 排除 toggle 按钮）+ `switchAuxTab()`/`openAuxSidebar()`/`toggleAuxSidebar()` 信息侧栏（perception/dashboard，独立 `.aux-active` 类，与主面板 `.active` 互不干扰），新增 `auxSidebarOpen`/`activeAuxTab` 状态 + `isAuxTabVisible()` 替代 `getCurrentPanel()` 用于侧栏面板可见性判断；(4) #panel-perception/#panel-dashboard DOM 从 `.main-panel-area` 迁移到 `.aux-sidebar-content`；(5) tokens.css 新增 `--aux-sidebar-width: 280px`（浅色+深色双主题）；(6) 快捷键重编号 PANEL_SHORTCUT_MAP 从 6 项缩减为 4 项（Ctrl+1=chat/Ctrl+2=memories/Ctrl+3=clipboard/Ctrl+4=settings，移除 5/6），commandPaletteManager nav-perception/nav-dashboard 改为 `openAuxSidebar(tab)` 路径，shortcuts-modal + onboarding 文案同步更新；(7) 自动打开路径 3 条：精灵状态条点击 → `openAuxSidebar('perception')` + 命令面板 Ctrl+K → `openAuxSidebar(tab)` + 主动触发（洞察/里程碑/模式/建议）→ `openAuxSidebar('dashboard')`；(8) 渲染层 onPanelSwitch 回调扩展触发 switchAuxTab 数据刷新（perception→loadPerception，dashboard→loadDashboard），Canvas 重绘通过 getPanelSwitchCallback 触发（renderGrowthChart 在 `getBoundingClientRect().width === 0` 时跳过绘制）；(9) 智能决策：移除自动收起逻辑（min-width=640px 验证：280 侧栏 + 360 主面板 = 640，无需自动收起）；(10) 即时切换无动画（参考 VSCode 标准行为，`transition: width` 触发 reflow 性能差）（2026-07-22 2.1 阶段实施）

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