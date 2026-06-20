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

  // ─── 窗口控制 ─────────────────────────────────────────
  /** 最小化完整窗口 */
  WINDOW_MINIMIZE: 'window-minimize',
  /** 最大化/还原完整窗口 */
  WINDOW_MAXIMIZE: 'window-maximize',
  /** 关闭完整窗口（实际切换到浮动态） */
  WINDOW_CLOSE: 'window-close',

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
} as const;
