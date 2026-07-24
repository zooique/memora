/**
 * IPC 通道名称常量定义
 *
 * 集中管理所有主进程 ↔ 渲染进程通信通道，消灭散落在各文件中的魔法字符串，
 * 避免拼写错误导致通信失败，并便于统一维护通道契约。
 *
 * 通道分类：
 * - RENDERER_TO_MAIN：渲染进程调用/通知主进程（invoke / send）
 * - MAIN_TO_RENDERER：主进程推送事件到渲染进程（webContents.send）
 */

/** 渲染进程 → 主进程的请求/通知通道 */
export const IPC_CHANNELS = {
  // ─── 对话相关 ─────────────────────────────────────────
  /** 用户输入（fire-and-forget，主进程开始流式对话） */
  USER_INPUT: 'user-input',
  /** 中断当前对话 */
  CHAT_ABORT: 'chat-abort',
  /**
   * 强制释放对话锁（应急恢复）
   *
   * 当 LLM Provider 网络挂起但未触发 60s 无进展超时时，用户可手动释放锁。
   * 内核 Agent.forceReleaseChatLock() 通过 token 机制保证并发安全，
   * 递增 _chatLockToken 让原 chat() 的 finally 块跳过清理，避免误清新调用者的资源。
   * 幂等：_chatBusy 已为 false 时 no-op。
   */
  CHAT_FORCE_RELEASE_LOCK: 'chat-force-release-lock',
  /** 加载历史会话消息 */
  SESSION_LOAD: 'session-load',
  /** 列出所有会话 */
  SESSION_LIST: 'session-list',
  /** 切换到已有会话（更新 Agent 内部状态，避免消息持久化到错误会话） */
  SESSION_SWITCH: 'session-switch',
  /** 删除会话（含确认对话框） */
  SESSION_DELETE: 'session-delete',
  /** 重命名会话 */
  SESSION_RENAME: 'session-rename',
  /** 搜索对话内容（跨所有会话，返回匹配的消息片段） */
  SESSION_SEARCH: 'session-search',
  /**
   * 会话分叉（从当前会话分叉出独立分支，保留全部历史消息）
   *
   * 内核 Agent.forkSession() 已完整实现，发射 sessionForked 事件。
   * 此通道用于 UI 触发分叉操作，返回新会话名和消息数。
   */
  SESSION_FORK: 'session-fork',

  // ─── 记忆相关 ─────────────────────────────────────────
  /** 列出记忆 */
  MEMORIES_LIST: 'memories-list',
  /**
   * 列出全部 distinct 记忆 source（用于来源筛选 dropdown 动态生成）
   *
   * 返回当前活跃记忆库中所有出现过的 source 字符串数组。
   * 比起拉全量 listMemories 再去重，单次 IPC 仅返回 source 数组（轻量），
   * 避免大记忆库场景下传输整张表。
   */
  MEMORIES_SOURCES: 'memories-sources',
  /** 搜索记忆 */
  MEMORIES_SEARCH: 'memories-search',
  /** 查看单条记忆详情 */
  MEMORIES_SHOW: 'memories-show',
  /** 删除记忆（软删除，移入回收站） */
  MEMORIES_DELETE: 'memories-delete',
  /** 恢复软删除记忆（从回收站恢复） */
  MEMORIES_RESTORE: 'memories-restore',
  /** 批量归档当前会话（一键归档） */
  ARCHIVE_SESSION: 'archive-session',
  /** 物理删除记忆（回收站彻底删除） */
  MEMORIES_PURGE: 'memories-purge',
  /** 批量恢复回收站所有记忆 */
  MEMORIES_RESTORE_ALL: 'memories-restore-all',
  /** 批量清空回收站所有记忆 */
  MEMORIES_PURGE_ALL: 'memories-purge-all',
  /** 列出回收站记忆 */
  MEMORIES_LIST_DELETED: 'memories-list-deleted',
  /** 添加/更新记忆 */
  MEMORIES_ADD: 'memories-add',
  /** 获取记忆关系图谱（ADR-014：拓扑可视化） */
  MEMORIES_RELATION_GRAPH: 'memories-relation-graph',
  /** 获取记忆健康度仪表盘数据（Phase 1：健康度诊断） */
  MEMORIES_HEALTH_DASHBOARD: 'memories-health-dashboard',
  /** 获取对话回顾数据（Phase 2：对话回顾与摘要） */
  MEMORIES_REVIEW_DATA: 'memories-review-data',
  /** 批量删除记忆（Phase 3：智能清理） */
  MEMORIES_DELETE_BATCH: 'memories-delete-batch',
  /** 添加记忆关系（手动创建，关系图交互） */
  MEMORIES_ADD_RELATION: 'memories-add-relation',
  /** 删除记忆关系（关系图交互） */
  MEMORIES_REMOVE_RELATION: 'memories-remove-relation',
  /** 更新记忆关系（关系图交互） */
  MEMORIES_UPDATE_RELATION: 'memories-update-relation',
  /** 获取记忆关系路径（Phase 5.1：路径追溯） */
  MEMORIES_RELATION_PATH: 'memories-relation-path',
  /** 获取记忆关系邻居（Phase 5.2：邻居查询） */
  MEMORIES_RELATION_NEIGHBORS: 'memories-relation-neighbors',
  /** 手动归档 profile facts（archiveMode='manual' 模式下供 UI 调用） */
  MEMORIES_ARCHIVE_PROFILE: 'memories-archive-profile',
  /** 手动归档 insight（archiveMode='manual' 模式下供 UI 调用） */
  MEMORIES_ARCHIVE_INSIGHT: 'memories-archive-insight',
  /** 提升记忆 score（L2 采纳反哺内核，补全采纳时调用） */
  MEMORIES_BOOST: 'memories-boost',
  /** L1 语义去重（LLM 治理：扫描名称相似对 → 降级低分记忆） */
  MEMORIES_DEDUP: 'memories-dedup',
  /** L2 时效性评估（LLM 治理：扫描低分记忆 → 降级过时记忆，手动触发） */
  MEMORIES_EVALUATE_TIMELINESS: 'memories-evaluate-timeliness',
  /** L3 冲突检测（LLM 治理：同 source 配对 → 检测冲突，仅检测不修复） */
  MEMORIES_DETECT_CONFLICTS: 'memories-detect-conflicts',

  // ─── 配置相关 ─────────────────────────────────────────
  /** 获取精灵配置 */
  CONFIG_GET: 'config-get',
  /** 更新精灵配置项 */
  CONFIG_UPDATE: 'config-update',
  /**
   * 批量更新精灵配置（事务性）
   *
   * 主进程在单个事务内完成全部更新（原子性 + 单次持久化 + 副作用去重），
   * 避免多次串行 CONFIG_UPDATE 调用产生的半更新状态。
   */
  CONFIG_UPDATE_BATCH: 'config-update-batch',

  // ─── 角色相关 ─────────────────────────────────────────
  /** 列出所有角色 */
  PERSONA_LIST: 'persona-list',
  /** 切换角色 */
  PERSONA_SWITCH: 'persona-switch',
  /** 设置角色匹配模式 */
  PERSONA_MODE: 'persona-mode',
  /** 查询当前角色匹配模式 */
  PERSONA_MODE_GET: 'persona-mode-get',

  // ─── 角色文件 CRUD（精灵设定面板 Epic 3 · I1） ─────────
  /** 读取角色文件内容（携带 name，返回 ConfigFileEntry | null） */
  PERSONA_READ_FILE: 'persona-read-file',
  /** 保存角色文件（新增/更新合并，携带 name + content） */
  PERSONA_SAVE_FILE: 'persona-save-file',
  /** 删除角色文件（携带 name） */
  PERSONA_DELETE_FILE: 'persona-delete-file',

  // ─── 项目 / 仪表盘 ────────────────────────────────────
  /** 列出已注册项目 */
  PROJECTS_LIST: 'projects-list',
  /** 获取仪表盘数据 */
  DASHBOARD_GET: 'dashboard-get',
  /** 手动触发一次记忆衰减（L0 纯 score 递减，无 LLM 调用） */
  MEMORY_DECAY_RUN: 'memory-decay-run',
  /** 获取感知数据快照（情感基调/默契度/对话上下文/模式洞察） */
  PERCEPTION_GET: 'perception-get',
  /** 获取启动摘要（Welcome Back Digest，迭代一） */
  STARTUP_SUMMARY_GET: 'startup-summary-get',

  // ─── LLM 配置相关 ─────────────────────────────────────
  /** 获取 LLM 配置 */
  LLM_CONFIG_GET: 'llm-config-get',
  /** 保存 LLM 配置并重新初始化 Agent */
  LLM_CONFIG_SAVE: 'llm-config-save',
  /** 测试 LLM 连接 */
  LLM_CONFIG_TEST: 'llm-config-test',
  /** 获取 Provider 列表 */
  LLM_PROVIDER_LIST: 'llm-provider-list',
  /** 保存 Provider 配置（新增/更新） */
  LLM_PROVIDER_SAVE: 'llm-provider-save',
  /** 删除 Provider */
  LLM_PROVIDER_DELETE: 'llm-provider-delete',
  /** 切换激活 Provider */
  LLM_PROVIDER_SET_ACTIVE: 'llm-provider-set-active',

  // ─── Agent 状态 ───────────────────────────────────────
  /** 查询 Agent 是否就绪 */
  AGENT_STATUS: 'agent-status',

  // ─── 主动提示 ─────────────────────────────────────────
  /** 渲染进程通知主进程主动提示已显示 */
  PROACTIVE_PROMPT_SHOWN: 'proactive-prompt-shown',
  /** Phase 2.1：用户接受了主动提示（点击"查看"） */
  PROACTIVE_ACCEPT: 'proactive-accept',
  /** Phase 2.1：用户拒绝/忽略了主动提示（点击"稍后"/关闭） */
  PROACTIVE_REJECT: 'proactive-reject',

  // ─── 配置建议（AutoConfigRefiner 闭环） ──────────
  /** 接受配置建议（调用 confirmConfigSuggestion 持久化） */
  SUGGESTION_ACCEPT: 'suggestion-accept',
  /** 拒绝配置建议（仅记录日志，不持久化） */
  SUGGESTION_REJECT: 'suggestion-reject',

  // ─── 用户画像（UserProfile 闭环） ────────────────
  /** 列出画像条目（含已确认 + 待确认） */
  USER_PROFILE_LIST: 'user-profile-list',
  /** 确认待确认画像条目 */
  USER_PROFILE_CONFIRM: 'user-profile-confirm',
  /** 拒绝画像条目（从缓存删除，已确认的也从存储删除） */
  USER_PROFILE_REJECT: 'user-profile-reject',

  // ─── 窗口控制 ─────────────────────────────────────────
  /** 最小化完整窗口 */
  WINDOW_MINIMIZE: 'window-minimize',
  /** 最大化/还原完整窗口 */
  WINDOW_MAXIMIZE: 'window-maximize',
  /** 关闭完整窗口（实际切换到浮动态） */
  WINDOW_CLOSE: 'window-close',
  /** 通知主进程主题已变更（需同步到浮动窗口） */
  THEME_CHANGED: 'theme-changed',

  // ─── 写入确认（M1：安全写入确认 UI） ──────────────────
  /** 渲染进程 → 主进程：返回写入确认结果（requestId + confirmed） */
  WRITE_CONFIRMATION_RESPONSE: 'write-confirmation-response',

  // ─── 安全与审计 ─────────────────────────────────────
  /** M2：列出最近 N 条审计日志（SecurityGuard.onAudit 记录） */
  AUDIT_LOG_LIST: 'audit-log-list',
  /** M2：清空审计日志 */
  AUDIT_LOG_CLEAR: 'audit-log-clear',

  // ─── 作品投影（WorkProjectionManager 查看） ──────
  /** 列出所有作品投影（agent.works.loadAll()） */
  WORK_PROJECTION_LIST: 'work-projection-list',
  /** 查看单个作品投影详情（agent.works.getProjection()） */
  WORK_PROJECTION_SHOW: 'work-projection-show',

  // ─── 浮动窗口 ─────────────────────────────────────────
  /** 拖动时持续请求移动浮动窗口位置 */
  MOVE_FLOAT_WINDOW: 'move-float-window',
  /** 拖动结束，保存浮动窗口最终位置 */
  SAVE_FLOAT_POSITION: 'save-float-position',
  /** 请求展开为完整窗口 */
  EXPAND_TO_FULL: 'expand-to-full',
  /** 请求显示浮动窗口右键菜单 */
  FLOAT_CONTEXT_MENU: 'float-context-menu',
  /** 浮球单击 → 呼出补全弹窗（替代 EXPAND_TO_FULL，STEP-4 交互重构） */
  SHOW_QUICK_INPUT_FROM_FLOAT: 'show-quick-input-from-float',

  // ─── 剪贴板（Phase 3.1：三重保护） ────────────────────
  /** 渲染进程 → 主进程：请求分析剪贴板内容（用户点击"分析"按钮触发） */
  CLIPBOARD_ANALYZE: 'clipboard-analyze',

  // ─── 技能安装（Phase 4.3） ────────────────────────────
  /** 渲染进程 → 主进程：安装技能文件（携带文件名和内容） */
  SKILL_INSTALL: 'skill-install',

  // ─── 设定文件 CRUD（精灵设定面板 Epic 3 · I2/I3） ───────
  // 规则与技能的统一文件管理入口（角色文件 CRUD 见上方 PERSONA_READ_FILE 等）
  // PERSONA_LIST 复用为角色列表通道，不新增 RULE_LIST 对应的 persona 通道
  /** 列出所有规则文件（返回 ConfigFileEntry[]，按 mtime 降序） */
  RULE_LIST: 'rule-list',
  /** 读取规则文件内容（携带 name，返回 ConfigFileEntry | null） */
  RULE_READ: 'rule-read',
  /** 保存规则文件（新增/更新合并，携带 name + content） */
  RULE_SAVE: 'rule-save',
  /** 删除规则文件（携带 name） */
  RULE_DELETE: 'rule-delete',
  /** 列出所有技能文件（返回 ConfigFileEntry[]，按 mtime 降序） */
  SKILL_LIST: 'skill-list',
  /** 读取技能文件内容（携带 name，返回 ConfigFileEntry | null） */
  SKILL_READ: 'skill-read',
  /** 删除技能文件（携带 name；新增/更新复用 SKILL_INSTALL 通道） */
  SKILL_DELETE: 'skill-delete',

  // ─── 快速输入补全（Phase 1 骨架） ─────────────────────
  /** 渲染进程 → 主进程：确认输入（携带文本，主进程写入剪贴板 + 关闭浮窗） */
  QUICK_INPUT_CONFIRM: 'quick-input-confirm',
  /** 渲染进程 → 主进程：关闭浮窗（Esc / 取消按钮触发，不写入剪贴板） */
  QUICK_INPUT_CLOSE: 'quick-input-close',
  /** 渲染进程 → 主进程：调整浮窗高度（候选列表显示/隐藏时触发） */
  QUICK_INPUT_RESIZE: 'quick-input-resize',
  /** 渲染进程 → 主进程：拖动浮窗位置（focus-bar 顶部标题栏可拖，dx/dy 增量） */
  MOVE_QUICK_INPUT: 'move-quick-input',
  /** 渲染进程 → 主进程：LLM 润色文本（携带原文，返回润色后文本） */
  QUICK_INPUT_POLISH: 'quick-input-polish',
  /** 渲染进程 → 主进程：切换常驻模式（pinned=true 持久钉住浮窗，pinned=false 恢复 default 模式） */
  QUICK_INPUT_SET_PINNED_MODE: 'quick-input-set-pinned-mode',
  /** 渲染进程 → 主进程：手动重捕获前台窗口（聚焦栏点击触发，返回新应用名） */
  RECAPTURE_TARGET: 'recapture-target',

  // ─── 可观测性 ───────────────
  /** 渲染进程 → 主进程：上报日志（错误/警告等，转发到主进程 logger） */
  RENDERER_LOG: 'renderer-log',

  // ─── 使用统计（AUDIT-5-3） ───────────────
  /** 渲染进程 → 主进程：导出使用统计 JSON 文件，返回文件路径 */
  USAGE_STATS_EXPORT: 'usage-stats-export',
  /** 清除使用统计数据（AUDIT-5-4） */
  USAGE_STATS_CLEAR: 'usage-stats-clear',

  // ─── 配置目录（精灵设定面板辅助功能） ───────────────
  /** 渲染进程 → 主进程：打开配置文件目录（personas/skills/rules 所在目录） */
  CONFIG_DIR_OPEN: 'config-dir-open',
} as const;

/** 主进程 → 渲染进程的推送通道 */
export const MAIN_TO_RENDERER_CHANNELS = {
  // ─── 流式对话 ─────────────────────────────────────────
  /** 流式消息开始 */
  SPRITE_STREAM_START: 'sprite-stream-start',
  /** 流式消息片段 */
  SPRITE_STREAM_CHUNK: 'sprite-stream-chunk',
  /** 流式消息结束 */
  SPRITE_STREAM_END: 'sprite-stream-end',
  /**
   * 流式消息召回透明度
   * 在 text chunk 之前推送，携带本次对话召回的记忆摘要列表，
   * 供渲染层在消息底部展示"💡 召回记忆：xxx（score: 0.xx）"
   */
  SPRITE_STREAM_RECALL: 'sprite-stream-recall',
  /** 工具调用开始（携带工具名和参数） */
  SPRITE_STREAM_TOOL_START: 'sprite-stream-tool-start',
  /** 工具调用结果（携带工具名、成功状态和摘要） */
  SPRITE_STREAM_TOOL_RESULT: 'sprite-stream-tool-result',
  /** 思考阶段指示（recalling/processing/archiving） */
  SPRITE_STREAM_THINKING: 'sprite-stream-thinking',

  /**
   * 上下文截断通知
   * 对话中检测到 metrics.context.truncationCount 增加时推送，
   * 携带被裁剪的消息数，渲染层在消息气泡顶部显示持久提示条。
   */
  SPRITE_CONTEXT_TRUNCATED: 'sprite-context-truncated',

  /**
   * 流式对话被中断通知
   *
   * 用户主动中断（点击停止按钮）或内核 yield aborted chunk 时推送，
   * 携带 messageId 和中断原因。渲染层在原助手气泡内嵌入中断标记，
   * 保留已生成的部分内容（对齐 Claude Code 的 partial response 保留理念），
   * 提供更连贯的中断体验（相比居中系统消息方案）。
   */
  SPRITE_STREAM_ABORTED: 'sprite-stream-aborted',

  // ─── 精灵输出 / 错误 ──────────────────────────────────
  /** 精灵主动提示或系统消息 */
  SPRITE_OUTPUT: 'sprite-output',
  /** 精灵统一事件（memoryNoticed / insightGained / proactivePrompt / personaChanged） */
  SPRITE_EVENT: 'sprite-event',
  /** 精灵对话级错误 */
  SPRITE_ERROR: 'sprite-error',

  // ─── 应用级事件 ───────────────────────────────────────
  /** 应用级错误 */
  APP_ERROR: 'app-error',
  /** Agent 已就绪通知 */
  AGENT_READY: 'agent-ready',

  // ─── 浮动窗口事件 ─────────────────────────────────────
  /** 浮动窗口未读计数 */
  FLOAT_UNREAD: 'float-unread',
  /** P4-1：推送最后一条助手消息到浮动窗口（hover 预览） */
  FLOAT_LAST_MESSAGE: 'float-last-message',

  // ─── 窗口状态 ─────────────────────────────────────────
  /** 窗口最大化/还原状态变更 */
  WINDOW_STATE_CHANGED: 'window-state-changed',
  /** 主题变更通知（主进程广播到浮动窗口） */
  THEME_BROADCAST: 'theme-broadcast',

  // ─── 配置建议推送（AutoConfigRefiner 闭环） ──────
  /**
   * 主进程推送配置建议到渲染进程（来自 AutoConfigRefiner 分析）
   * 携带 ConfigSuggestion payload，渲染层显示建议卡片供用户确认/拒绝
   */
  SUGGESTION_PUSH: 'suggestion-push',

  // ─── 写入确认（M1：安全写入确认 UI） ──────────────────
  /**
   * 主进程推送写入确认请求到渲染进程
   * 携带路径、工具名等信息，渲染层显示确认对话框
   */
  WRITE_CONFIRMATION: 'write-confirmation',

  // ─── 剪贴板（Phase 3.1：三重保护推送） ────────────────
  /**
   * 剪贴板内容已变化（携带 preview + length，供渲染层加入待处理列表）
   *
   * 主进程读取剪贴板构造 {preview, length} payload，渲染层加入待处理列表 + 角标 +1
   * （被动等待 + 保护性主动：普通内容静默累积，敏感内容保护性主动提醒）
   */
  CLIPBOARD_CHANGED: 'clipboard-changed',
  /** 检测到敏感内容，已静默忽略（携带 type，供 UI 记录日志） */
  CLIPBOARD_SENSITIVE_IGNORED: 'clipboard-sensitive-ignored',
  /** 内容已通过检测，等待用户确认（携带 content，UI 展示确认对话框） */
  CLIPBOARD_ANALYSIS_READY: 'clipboard-analysis-ready',
  /** 内容被输入护栏拦截（携带 reason，UI 提示拦截原因） */
  CLIPBOARD_ANALYSIS_REJECTED: 'clipboard-analysis-rejected',

  // ─── 全局快捷键触发（Phase 3.3 第二批） ──────────────
  /** quick-record 触发：通知渲染进程聚焦输入框进入快速记录模式 */
  QUICK_RECORD_TRIGGER: 'quick-record-trigger',
  /** recall-memory 触发：通知渲染进程切换到记忆面板 */
  RECALL_MEMORY_TRIGGER: 'recall-memory-trigger',
  /** 快速输入浮窗被 show() 调用（通知渲染进程清空输入框） */
  QUICK_INPUT_SHOW: 'quick-input-show',
  /** 浮窗聚焦变化通知（blur→null，focus→应用名；渲染进程联动聚焦提示栏 + Tab 启用/禁用） */
  QUICK_INPUT_FOCUS_CHANGE: 'quick-input-focus-change',

  // ─── 设定文件变更广播（精灵设定面板 Epic 3 · I4） ───────
  /**
   * 主进程 → 渲染进程：设定文件变更通知
   *
   * 携带 { type, action, name } payload：
   *   - type: 'persona' | 'rule' | 'skill'
   *   - action: 'save' | 'delete'
   *   - name: 配置名
   *
   * 触发场景：
   *   1. 设定面板 CRUD 操作完成后广播（让其他面板如 personaPanelManager/commandPaletteManager 刷新）
   *   2. personaWatcher 监听到外部编辑器修改 personas/ 目录时广播
   *
   * 渲染层监听后按 type 分发刷新（U8）。
   */
  CONFIG_FILES_CHANGED: 'config-files-changed',
} as const;

// IPC 数据传输类型（SerializedAppError / WorkProjectionPayload）见 ./types.ts
