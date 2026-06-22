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
  /** 加载历史会话消息 */
  SESSION_LOAD: 'session-load',
  /** 新建会话 */
  SESSION_NEW: 'session-new',
  /** FD-A1 列出所有会话 */
  SESSION_LIST: 'session-list',
  /** UX-P1-04 切换到已有会话（更新 Agent 内部状态，避免消息持久化到错误会话） */
  SESSION_SWITCH: 'session-switch',
  /** FD-09 删除会话（含确认对话框） */
  SESSION_DELETE: 'session-delete',
  /** FD-09 重命名会话 */
  SESSION_RENAME: 'session-rename',

  // ─── 记忆相关 ─────────────────────────────────────────
  /** 列出记忆 */
  MEMORIES_LIST: 'memories-list',
  /** 搜索记忆 */
  MEMORIES_SEARCH: 'memories-search',
  /** 查看单条记忆详情 */
  MEMORIES_SHOW: 'memories-show',
  /** 删除记忆 */
  MEMORIES_DELETE: 'memories-delete',
  /** 添加/更新记忆 */
  MEMORIES_ADD: 'memories-add',

  // ─── 配置相关 ─────────────────────────────────────────
  /** 获取精灵配置 */
  CONFIG_GET: 'config-get',
  /** 更新精灵配置项 */
  CONFIG_UPDATE: 'config-update',

  // ─── 角色相关 ─────────────────────────────────────────
  /** 列出所有角色 */
  PERSONA_LIST: 'persona-list',
  /** 切换角色 */
  PERSONA_SWITCH: 'persona-switch',
  /** 设置角色匹配模式 */
  PERSONA_MODE: 'persona-mode',
  /** 查询当前角色匹配模式 */
  PERSONA_MODE_GET: 'persona-mode-get',

  // ─── 项目 / 仪表盘 ────────────────────────────────────
  /** 列出已注册项目 */
  PROJECTS_LIST: 'projects-list',
  /** 获取仪表盘数据 */
  DASHBOARD_GET: 'dashboard-get',

  // ─── LLM 配置相关 ─────────────────────────────────────
  /** 获取 LLM 配置 */
  LLM_CONFIG_GET: 'llm-config-get',
  /** 保存 LLM 配置并重新初始化 Agent */
  LLM_CONFIG_SAVE: 'llm-config-save',
  /** 测试 LLM 连接 */
  LLM_CONFIG_TEST: 'llm-config-test',

  // ─── Agent 状态 ───────────────────────────────────────
  /** 查询 Agent 是否就绪 */
  AGENT_STATUS: 'agent-status',

  // ─── 主动提示 ─────────────────────────────────────────
  /** 渲染进程通知主进程主动提示已显示 */
  PROACTIVE_PROMPT_SHOWN: 'proactive-prompt-shown',

  // ─── 配置建议（H1：AutoConfigRefiner 闭环） ──────────
  /** 接受配置建议（调用 confirmConfigSuggestion 持久化） */
  SUGGESTION_ACCEPT: 'suggestion-accept',
  /** 拒绝配置建议（仅记录日志，不持久化） */
  SUGGESTION_REJECT: 'suggestion-reject',

  // ─── 用户画像（H2：UserProfile 闭环） ────────────────
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
  /** UX-P2-10 通知主进程主题已变更（需同步到浮动窗口） */
  THEME_CHANGED: 'theme-changed',

  // ─── 浮动窗口 ─────────────────────────────────────────
  /** 拖动时持续请求移动浮动窗口位置 */
  MOVE_FLOAT_WINDOW: 'move-float-window',
  /** 拖动结束，保存浮动窗口最终位置 */
  SAVE_FLOAT_POSITION: 'save-float-position',
  /** 通知主进程拖动开始 */
  FLOAT_DRAG_BEGIN: 'float-drag-begin',
  /** 请求展开为完整窗口 */
  EXPAND_TO_FULL: 'expand-to-full',
  /** 请求显示浮动窗口右键菜单 */
  FLOAT_CONTEXT_MENU: 'float-context-menu',
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
   * 流式消息召回透明度（MS-12）
   * 在 text chunk 之前推送，携带本次对话召回的记忆摘要列表，
   * 供渲染层在消息底部展示"💡 召回记忆：xxx（score: 0.xx）"
   */
  SPRITE_STREAM_RECALL: 'sprite-stream-recall',
  /** UX-P1-02 工具调用开始（携带工具名和参数） */
  SPRITE_STREAM_TOOL_START: 'sprite-stream-tool-start',
  /** UX-P1-02 工具调用结果（携带工具名、成功状态和摘要） */
  SPRITE_STREAM_TOOL_RESULT: 'sprite-stream-tool-result',
  /** UX-P2-01 思考阶段指示（recalling/processing/archiving） */
  SPRITE_STREAM_THINKING: 'sprite-stream-thinking',

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
  /** 浮动窗口拖动开始 */
  FLOAT_DRAG_START: 'float-drag-start',
  /** 浮动窗口拖动结束 */
  FLOAT_DRAG_END: 'float-drag-end',
  /** 浮动窗口未读计数 */
  FLOAT_UNREAD: 'float-unread',

  // ─── 窗口状态 ─────────────────────────────────────────
  /** 窗口最大化/还原状态变更 */
  WINDOW_STATE_CHANGED: 'window-state-changed',
  /** UX-P2-10 主题变更通知（主进程广播到浮动窗口） */
  THEME_BROADCAST: 'theme-broadcast',

  // ─── 配置建议推送（H1：AutoConfigRefiner 闭环） ──────
  /**
   * 主进程推送配置建议到渲染进程（来自 AutoConfigRefiner 分析）
   * 携带 ConfigSuggestion payload，渲染层显示建议卡片供用户确认/拒绝
   */
  SUGGESTION_PUSH: 'suggestion-push',
} as const;

// ─── IPC 数据传输类型 ────────────────────────────────────

/**
 * 主进程 AppError 序列化后的 IPC 传输形态
 *
 * 主进程的 AppError 包含 Date 对象和 Error 引用，无法直接通过 IPC 传输。
 * 经由 errorHandler.showErrorToUser 序列化后，渲染进程收到的是此结构的对象。
 * 主进程和渲染进程共享此类型，消除两处重复定义（errorHandler.ts 和 renderer.ts）。
 */
export interface SerializedAppError {
  /** 错误码（ErrorCode 枚举经 IPC 传输后转为 string） */
  code: string;
  /** 用户友好的错误消息（已由 errorHandler 转换） */
  message: string;
  /** ISO 8601 时间戳（AppError.timestamp 的 toISOString() 结果） */
  timestamp: string;
}
