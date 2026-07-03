/**
 * 预加载脚本 — 安全桥接主进程与渲染进程
 *
 * contextBridge 暴露有限的 API 给渲染进程：
 * - 所有 IPC 调用必须显式列出
 * - 敏感 API（如 Shell、FileSystem）不暴露
 * - 通信方式：ipcRenderer.invoke（请求/响应）+ ipcRenderer.on（事件推送）
 *
 * ⚠️ Sandbox 兼容性：
 * Electron sandbox: true 要求 preload 是单个 CommonJS 文件，不能有外部模块的运行时导入。
 * 原方案 `import { IPC_CHANNELS } from './ipcChannels.js'` 会导致 ESM 多模块加载失败，
 * contextBridge.exposeInMainWorld() 静默失败，window.electronAPI 为 undefined，
 * 表现为顶部栏按钮点击无反应、浮动图标无法拖动等全链路 UI 失效。
 *
 * 修复策略：
 * - IPC 通道常量内联到本文件（与 ipcChannels.ts 保持同步，见下方 INLINED_IPC_CHANNELS）
 * - 仅保留 `import type`（编译时擦除，不产生运行时模块加载）
 * - 通过 tsconfig.preload.json 编译为 CommonJS 格式的 preload.cjs
 * - ipcChannels.ts 仍是主进程的真理源；本文件的内联副本需手动保持同步
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { SerializedAppError } from './ipc/channels.js';
import type { WorkProjectionPayload } from './ipc/channels.js';
// 重新导出 WorkProjectionPayload，使渲染层统一从 preload 导入
export type { WorkProjectionPayload };
// 从业务层导入 IPC 契约类型，消除 preload 与 memoryController 的重复定义（DRY）。
// 使用 import type：编译时擦除，不引入运行时耦合；electron 层依赖 sprite 层是合理依赖方向。
import type {
  MemoryListItem,
  MemoryDetail,
  MemoryRelationItem,
  MemorySearchResult as MemorySearchHit,
} from '../sprite/controllers/memoryController.js';
// P3：从 sprite 层导入 SpriteConfig（真理源），用于派生 SpriteConfigForm（消除手写平行结构）
import type { SpriteConfig } from '../sprite/spriteConfig.js';
// P5：从 sprite 层导入感知状态类型（真理源），修复 getPerceptionSnapshot 返回类型过宽问题
import type { AffectState, RapportState, ContextState, DetectedPattern, ProactiveStats } from '../sprite/controllers/index.js';

// ─── 内联 IPC 通道常量（sandbox 兼容性：不能运行时导入 ipcChannels.ts） ─────
// ⚠️ 与 ipcChannels.ts 保持同步：修改 ipcChannels.ts 时需同步更新此处的内联副本。
// 主进程使用 ipcChannels.ts（真理源），preload 使用此内联副本（sandbox 限制）。
// C-1：export 这两个常量，供 channelParity.test.ts 断言键集与真理源一致，
// 防止 sandbox 限制下的手动复制静默失配（UI 按钮无响应等全链路失效）。
export const IPC_CHANNELS = {
  USER_INPUT: 'user-input',
  CHAT_ABORT: 'chat-abort',
  SESSION_LOAD: 'session-load',
  SESSION_LIST: 'session-list',
  SESSION_SWITCH: 'session-switch',
  /** FD-09 删除会话（含确认对话框） */
  SESSION_DELETE: 'session-delete',
  /** FD-09 重命名会话 */
  SESSION_RENAME: 'session-rename',
  MEMORIES_LIST: 'memories-list',
  MEMORIES_SEARCH: 'memories-search',
  MEMORIES_SHOW: 'memories-show',
  MEMORIES_DELETE: 'memories-delete',
  MEMORIES_ADD: 'memories-add',
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
  /** 手动归档 profile facts（缺口 J：manual 模式下供 UI 调用） */
  MEMORIES_ARCHIVE_PROFILE: 'memories-archive-profile',
  /** 手动归档 insight（缺口 J：manual 模式下供 UI 调用） */
  MEMORIES_ARCHIVE_INSIGHT: 'memories-archive-insight',
  CONFIG_GET: 'config-get',
  CONFIG_UPDATE: 'config-update',
  // QC-CONFIG-01：批量事务性更新配置（必须与 ipc/channels.ts 保持同步）
  CONFIG_UPDATE_BATCH: 'config-update-batch',
  PERSONA_LIST: 'persona-list',
  PERSONA_SWITCH: 'persona-switch',
  PERSONA_MODE: 'persona-mode',
  PERSONA_MODE_GET: 'persona-mode-get',
  PROJECTS_LIST: 'projects-list',
  DASHBOARD_GET: 'dashboard-get',
  PERCEPTION_GET: 'perception-get',
  LLM_CONFIG_GET: 'llm-config-get',
  LLM_CONFIG_SAVE: 'llm-config-save',
  LLM_CONFIG_TEST: 'llm-config-test',
  AGENT_STATUS: 'agent-status',
  PROACTIVE_PROMPT_SHOWN: 'proactive-prompt-shown',
  /** Phase 2.1：用户接受了主动提示（点击"查看"） */
  PROACTIVE_ACCEPT: 'proactive-accept',
  /** Phase 2.1：用户拒绝/忽略了主动提示（点击"稍后"/关闭） */
  PROACTIVE_REJECT: 'proactive-reject',
  // H1：配置建议（接受/拒绝）
  SUGGESTION_ACCEPT: 'suggestion-accept',
  SUGGESTION_REJECT: 'suggestion-reject',
  // H2：用户画像管理
  USER_PROFILE_LIST: 'user-profile-list',
  USER_PROFILE_CONFIRM: 'user-profile-confirm',
  USER_PROFILE_REJECT: 'user-profile-reject',
  WINDOW_MINIMIZE: 'window-minimize',
  WINDOW_MAXIMIZE: 'window-maximize',
  WINDOW_CLOSE: 'window-close',
  THEME_CHANGED: 'theme-changed',
  MOVE_FLOAT_WINDOW: 'move-float-window',
  SAVE_FLOAT_POSITION: 'save-float-position',
  FLOAT_DRAG_BEGIN: 'float-drag-begin',
  EXPAND_TO_FULL: 'expand-to-full',
  FLOAT_CONTEXT_MENU: 'float-context-menu',
  // M1：写入确认响应（渲染进程 → 主进程）
  WRITE_CONFIRMATION_RESPONSE: 'write-confirmation-response',
  // H3：作品投影查看
  WORK_PROJECTION_LIST: 'work-projection-list',
  WORK_PROJECTION_SHOW: 'work-projection-show',
  // M2：审计日志查看/清除
  AUDIT_LOG_LIST: 'audit-log-list',
  AUDIT_LOG_CLEAR: 'audit-log-clear',
  // Phase 3.1：剪贴板三重保护
  CLIPBOARD_ANALYZE: 'clipboard-analyze',
  // Phase 4.3：技能安装（渲染进程 → 主进程）
  SKILL_INSTALL: 'skill-install',
  // FOUNDATION-SEAL Phase 4：渲染进程日志上报（渲染进程 → 主进程）
  RENDERER_LOG: 'renderer-log',
} as const;

export const MAIN_TO_RENDERER_CHANNELS = {
  SPRITE_STREAM_START: 'sprite-stream-start',
  SPRITE_STREAM_CHUNK: 'sprite-stream-chunk',
  SPRITE_STREAM_END: 'sprite-stream-end',
  SPRITE_STREAM_RECALL: 'sprite-stream-recall',
  SPRITE_STREAM_TOOL_START: 'sprite-stream-tool-start',
  SPRITE_STREAM_TOOL_RESULT: 'sprite-stream-tool-result',
  SPRITE_STREAM_THINKING: 'sprite-stream-thinking',
  SPRITE_STREAM_ABORTED: 'sprite-stream-aborted',
  SPRITE_CONTEXT_TRUNCATED: 'sprite-context-truncated',
  SPRITE_OUTPUT: 'sprite-output',
  SPRITE_EVENT: 'sprite-event',
  SPRITE_ERROR: 'sprite-error',
  APP_ERROR: 'app-error',
  AGENT_READY: 'agent-ready',
  FLOAT_DRAG_START: 'float-drag-start',
  FLOAT_DRAG_END: 'float-drag-end',
  FLOAT_UNREAD: 'float-unread',
  WINDOW_STATE_CHANGED: 'window-state-changed',
  THEME_BROADCAST: 'theme-broadcast',
  // H1：主进程推送配置建议到渲染进程
  SUGGESTION_PUSH: 'suggestion-push',
  // M1：主进程推送写入确认请求到渲染进程
  WRITE_CONFIRMATION: 'write-confirmation',
  // Phase 3.1：剪贴板三重保护推送
  CLIPBOARD_CHANGED: 'clipboard-changed',
  CLIPBOARD_SENSITIVE_IGNORED: 'clipboard-sensitive-ignored',
  CLIPBOARD_ANALYSIS_READY: 'clipboard-analysis-ready',
  CLIPBOARD_ANALYSIS_REJECTED: 'clipboard-analysis-rejected',
  // Phase 3.3 第二批：全局快捷键触发
  QUICK_RECORD_TRIGGER: 'quick-record-trigger',
  RECALL_MEMORY_TRIGGER: 'recall-memory-trigger',
} as const;

// 重新导出契约类型，供 ui.ts / renderer.ts 通过 preload 统一引用
export type { MemoryListItem, MemoryDetail, MemoryRelationItem, MemorySearchHit };

// ─── H1/H2 共享类型定义 ───────────────────────────────────

/**
 * H1：配置建议（与内核 ConfigSuggestion 对齐）
 *
 * 来自 AutoConfigRefiner 分析对话后提取的建议，
 * 渲染层展示建议卡片供用户接受/拒绝。
 */
export interface ConfigSuggestionPayload {
  /** 建议类型 */
  type: 'rule' | 'persona' | 'skill';
  /** 建议名称 */
  name: string;
  /** 建议内容（Markdown 格式） */
  content: string;
  /** 置信度 0-1 */
  confidence: number;
  /** 来源（固定为 'auto-config-refiner'） */
  source?: string;
}

/**
 * H2：用户画像条目（与内核 UserProfileEntry 对齐）
 *
 * 已确认条目持久化在 SQLite（source='profile'），
 * 待确认条目仅存内存缓存，进程重启后丢失。
 */
export interface UserProfileEntryPayload {
  /** 条目 ID（格式：profile:user-profile-{category}-{slug}） */
  id: string;
  /** 子分类 */
  category: 'identity' | 'preference' | 'expertise' | 'habit' | 'history';
  /** 事实值（如 "姓名: 张三"） */
  value: string;
  /** 来源轮次 */
  source: string;
  /** 权重 0-1 */
  weight: number;
  /** 是否已确认 */
  confirmed: boolean;
  /** 最后更新时间（ISO 8601） */
  updatedAt: string;
}

/**
 * M1：写入确认请求载荷（与内核 WriteConfirmationInfo 对齐）
 *
 * 主进程 SecurityGuard 发现写入操作需要确认时，
 * 通过 WRITE_CONFIRMATION 通道推送此结构到渲染进程。
 */
export interface WriteConfirmationPayload {
  /** 本次请求的唯一 ID（用于响应时匹配） */
  requestId: string;
  /** 目标文件绝对路径 */
  targetPath: string;
  /** 工具名（如 write_file） */
  tool: string;
  /** 人类可读的描述（如 "写入 100 字符到 foo.md"） */
  description?: string;
  /** 权限模式（owner / guest） */
  permission: string;
  /** 是否需要确认（owner + confirmWrites=false 时为 false，宿主可跳过弹窗） */
  needsConfirm: boolean;
}

/** 记忆健康度仪表盘 IPC 传输形态（Phase 1：健康度诊断） */
export interface HealthDashboardPayload {
  scores: { overall: number; uniqueness: number; freshness: number; completeness: number };
  duplicates: Array<{ type: 'name' | 'content'; memories: Array<{ id: string; name: string; source: string; score: number; contentPreview: string }>; similarity?: number }>;
  staleMemories: Array<{ memory: { id: string; name: string; source: string; score: number; contentPreview: string }; reason: 'old_age' | 'low_score' | 'both'; daysSinceAccess: number }>;
  lowQualityCount: number;
  totalMemories: number;
  healthLabel: 'excellent' | 'good' | 'fair' | 'poor';
  healthDescription: string;
}

/** 对话回顾数据 IPC 传输形态（Phase 2：对话回顾与摘要） */
export interface ReviewDataPayload {
  today: { date: string; messageCount: number; newMemories: number; newInsights: number };
  trend: { last7Days: number; last30Days: number; daily: Array<{ date: string; messageCount: number; newMemories: number; newInsights: number }>; direction: 'growing' | 'stable' | 'declining'; description: string };
  insights: { total: number; recent: Array<{ name: string; contentPreview: string; createdAt: string }>; bySource: Record<string, number> };
  totalMemories: number;
  generatedAt: string;
}

// ─── 类型定义（与主进程 IPC 通道对应） ─────────────────────

/** 会话消息（渲染进程展示用，与 SessionMessage 对齐但仅暴露必要字段） */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** UX-P2-06 消息原始时间戳（ISO 8601），用于历史消息显示正确时间 */
  timestamp?: string;
}

/**
 * 精灵配置表单（渲染进程用）
 *
 * P3：从 SpriteConfig 派生，消除手写平行结构导致的同步漂移风险。
 * - 12 个必填字段通过 Required<Pick<SpriteConfig, ...>> 派生（可选→必填）
 * - silentModeExpiresAt 保持可选（与 SpriteConfig 一致，null 表示无定时恢复）
 * - theme 单独声明：SpriteConfig.theme 含 'auto'，但表单仅暴露 'light'|'dark'
 *   （'auto' 由系统跟随逻辑处理，不暴露到表单 UI）
 * - archiveMode 三态全部暴露到表单（与 theme 不同：theme 窄化，archiveMode 不窄化）
 * - shortcuts 在表单中暴露完整 ShortcutConfig（Phase 3.3 快捷键设置 UI）
 * - SpriteConfig 新增/修改字段时，Form 自动同步（除 theme 外）
 */
type SpriteConfigFormBase = Required<Pick<SpriteConfig,
  | 'silentMode' | 'proactiveThreshold'
  | 'proactiveCooldownMs' | 'triggerIntervalMs' | 'fileWatcherEnabled'
  | 'fileWatcherPaths' | 'fileWatcherDebounceMs' | 'defaultPersona'
  | 'projectMode' | 'focusProjectPath' | 'shortcuts'
  // ADR-015 归档模式三态全部暴露到表单（切换即时生效，不走保存按钮）
  | 'archiveMode'
>>;

export interface SpriteConfigForm extends SpriteConfigFormBase {
  /** FD-10 静默模式恢复时间（ISO 8601），null 表示无定时恢复 */
  silentModeExpiresAt?: string | null;
  /** UX-FD-12 界面主题（窄化版：'auto' 不暴露到表单，由 onThemeChange 即时处理） */
  theme: 'light' | 'dark';
  /** 缺口 II：文件监听忽略模式（glob 列表，可选，与 SpriteConfig 一致） */
  fileWatcherIgnore?: string[];
}

export interface ElectronAPI {
  // 对话
  sendUserInput: (text: string) => void;
  abortChat: () => Promise<void>;
  loadSession: (query: { date?: string; session?: string; limit?: number; offset?: number }) => Promise<{ messages: ChatMessage[]; loadedSessionId: string; total: number; hasMore: boolean }>;
  /** FD-A1 列出所有会话 */
  listSessions: () => Promise<{ sessions: Array<{ id: string; date: string; name: string; preview?: string; messageCount?: number }> }>;
  /** UX-P1-04 切换到已有会话（更新 Agent 内部状态，避免消息持久化到错误会话） */
  switchSession: (query: { date: string; session: string }) => Promise<{ success: boolean; messages: ChatMessage[]; error?: string }>;
  /** FD-09 删除会话（不可恢复，调用方需自行确认） */
  deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  /** FD-09 重命名会话 */
  renameSession: (sessionId: string, newName: string) => Promise<{ success: boolean; error?: string }>;

  // 流式监听（含移除方法，防止多次调用导致重复触发与内存泄漏）
  onStreamStart: (cb: (msg: { messageId: string }) => void) => void;
  onStreamChunk: (cb: (msg: { messageId: string; text: string }) => void) => void;
  onStreamEnd: (cb: (msg: { messageId: string }) => void) => void;
  /**
   * MS-12 召回透明度监听
   * 在 text chunk 之前触发，携带本次对话召回的记忆摘要列表
   */
  onStreamRecall: (cb: (msg: { messageId: string; memories: Array<{ id: string; name: string; score: number; source: string }> }) => void) => void;
  /** UX-P1-02 工具调用开始监听（携带工具名和参数） */
  onStreamToolStart: (cb: (msg: { messageId: string; toolCallId: string; name: string; args?: string }) => void) => void;
  /** UX-P1-02 工具调用结果监听（携带工具名、成功状态和摘要） */
  onStreamToolResult: (cb: (msg: { messageId: string; toolCallId: string; name: string; ok: boolean; summary?: string }) => void) => void;
  /** UX-P2-01 思考阶段监听（recalling/processing/archiving） */
  onStreamThinking: (cb: (msg: { messageId: string; phase: string }) => void) => void;
  /** OBS-02 上下文截断通知：对话中发生截断时触发，携带截断次数 */
  onContextTruncated: (cb: (msg: { messageId: string; count: number }) => void) => void;
  /**
   * UX-PP-10 流式对话被中断监听
   * 用户主动中断或内核 yield aborted chunk 时触发，携带 messageId 和中断原因。
   * 渲染层在原助手气泡内嵌入中断标记，保留已生成的部分内容。
   */
  onStreamAborted: (cb: (msg: { messageId: string; reason: string }) => void) => void;
  /** 移除所有流式监听器（页面卸载或重新初始化时调用） */
  removeStreamListeners: () => void;

  // 精灵输出（主动提示 / 系统消息）
  onSpriteOutput: (cb: (msg: { text: string; kind: 'proactive' | 'system' }) => void) => void;
  /** 移除精灵输出监听器 */
  removeSpriteOutputListener: () => void;

  // 精灵事件
  onSpriteEvent: (cb: (msg: { type: string; payload: unknown; silent: boolean }) => void) => void;
  /** 移除精灵事件监听器 */
  removeSpriteEventListener: () => void;

  // 错误
  onSpriteError: (cb: (msg: { text: string }) => void) => void;
  /** 移除精灵错误监听器 */
  removeSpriteErrorListener: () => void;

  // 应用错误
  onAppError: (cb: (msg: SerializedAppError) => void) => void;
  /** 移除应用错误监听器 */
  removeAppErrorListener: () => void;

  // Agent 状态查询
  getAgentStatus: () => Promise<{ ready: boolean; error: string | null }>;

  // LLM 配置读写（首次启动引导用）
  getLlmConfig: () => Promise<{
    configured: boolean;
    config: { provider: string; model: string; baseUrl: string; apiKey: string; temperature: number } | null;
    embedding: { model: string; baseUrl: string; apiKey: string } | null;
    presets: Record<string, { provider: string; model: string; baseUrl: string }>;
  }>;
  saveLlmConfig: (
    llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number },
    embeddingConfig?: { model: string; baseUrl?: string; apiKey?: string },
  ) => Promise<{ success: boolean; error: string | null }>;

  /** 测试 LLM 连接（保存前验证配置是否可用） */
  testLlmConfig: (llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string }) => Promise<{ success: boolean; error: string | null }>;

  // Agent 就绪通知（主进程 → 渲染进程）
  onAgentReady: (cb: () => void) => void;
  /** 移除 Agent 就绪监听器 */
  removeAgentReadyListener: () => void;

  // 记忆
  listMemories: (query?: { source?: string }) => Promise<{ memories: MemoryListItem[] }>;
  searchMemories: (query: string) => Promise<{ hits: MemorySearchHit[] }>;
  showMemory: (id: string) => Promise<{ memory: MemoryDetail | null }>;
  deleteMemory: (id: string) => Promise<{ deleted: boolean }>;
  addMemory: (data: { source: string; name: string; content: string }) => Promise<{ id: string }>;
  /** 获取记忆关系图谱（ADR-014：拓扑可视化） */
  getRelationGraph: () => Promise<{ nodes: MemoryListItem[]; edges: Array<{ sourceId: string; targetId: string; type: string; weight: number; createdAt: string }> }>;
  /** 添加记忆关系（手动创建，关系图交互） */
  addRelation: (data: { sourceId: string; targetId: string; type: string; weight: number }) => Promise<{ success: boolean }>;
  /** 删除记忆关系（关系图交互） */
  removeRelation: (data: { sourceId: string; targetId: string; type: string }) => Promise<{ success: boolean }>;
  /** 更新记忆关系（关系图交互） */
  updateRelation: (data: { sourceId: string; targetId: string; type: string; weight: number }) => Promise<{ success: boolean }>;
  /** 手动归档 profile facts（缺口 J：manual 模式下供 UI 调用，返回归档条目数） */
  archiveProfileFacts: (input: string) => Promise<{ count: number }>;
  /** 手动归档 insight（缺口 J：manual 模式下供 UI 调用，返回归档记忆数） */
  archiveInsight: (input: string, assistantContent: string) => Promise<{ count: number }>;
  /** 获取记忆健康度仪表盘数据（Phase 1：健康度诊断） */
  getHealthDashboard: () => Promise<HealthDashboardPayload>;
  /** 获取对话回顾数据（Phase 2：对话回顾与摘要） */
  getReviewData: () => Promise<ReviewDataPayload>;
  /** 批量删除记忆（Phase 3：智能清理） */
  deleteMemoriesBatch: (ids: string[]) => Promise<{ deleted: number; total: number }>;

  // 配置
  getConfig: () => Promise<{ config: SpriteConfigForm }>;
  /** QC-CFG-03：返回类型新增 error 字段（更新失败时包含错误信息） */
  updateConfig: (key: string, value: unknown) => Promise<{ updated: boolean; error?: string }>;
  /**
   * QC-CONFIG-01 批量更新配置（事务性）
   *
   * 替代 onConfigSave 中 N 次串行 updateConfig 调用。主进程在单个事务内完成
   * 全部更新（原子性 + 单次持久化 + 副作用去重），避免半更新状态。
   * 返回类型与 updateConfig 一致，便于复用现有错误处理逻辑。
   */
  updateConfigBatch: (updates: Record<string, unknown>) => Promise<{ updated: boolean; error?: string }>;

  // 角色
  listPersonas: () => Promise<{ personas: Array<{ name: string; description: string; active: boolean }> }>;
  switchPersona: (name: string) => Promise<{ switched: boolean; name: string | null }>;
  setPersonaMode: (mode: 'auto' | 'manual') => Promise<{ set: boolean }>;
  /** IX-07 查询当前角色匹配模式 */
  getPersonaMode: () => Promise<{ mode: string }>;

  // 项目（FD-04 项目模式）
  /** 列出已注册项目（供专注模式选择器使用） */
  listProjects: () => Promise<{ projects: Array<{ name: string; path: string }> }>;

  // 仪表盘（FD-03）
  getDashboard: () => Promise<{
    total: number;
    bySource: Record<string, number>;
    suggestions: Array<{ id: string; name: string; source: string; reason: string; relevance: number; contentPreview: string }>;
    pendingNotices: number;
    proactiveThreshold: number;
    registeredTriggers: string[];
    /** 记忆源健康诊断（null 表示不可用） */
    sourceHealth: {
      sources: Array<{
        source: string;
        count: number;
        avgScore: number;
        daysSinceLastAccess: number;
        status: 'healthy' | 'warning' | 'critical';
      }>;
      overallStatus: 'healthy' | 'warning' | 'critical';
      diagnosedAt: string;
    } | null;
    /** OBS-01 Agent 运行时指标（null 表示不可用） */
    metrics: {
      llm: {
        callCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
      };
      recall: {
        totalCount: number;
        hitCount: number;
        hitRate: number;
      };
      tools: {
        callCount: number;
        failureCount: number;
      };
      context: {
        truncationCount: number;
        messageCount: number;
        estimatedTokens: number;
      };
      decay: {
        runCount: number;
        totalDecayedCount: number;
        lastRunAt: string | null;
      } | null;
    } | null;
    /** GAP-1 已加载技能列表（空数组表示无技能或不可用） */
    skills: Array<{
      name: string;
      keywords: string[];
      description: string;
      layer: string;
    }>;
  }>;

  // 感知数据快照（精灵感知面板打开时调用，实时推导返回）
  getPerceptionSnapshot: () => Promise<{
    affect?: AffectState;
    rapport?: RapportState;
    context?: ContextState;
    patterns?: DetectedPattern[];
    /** 缺口 G+H：主动提示统计（接受率 + 生效冷却） */
    proactiveStats?: ProactiveStats;
  } | null>;

  // 窗口控制
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;

  // 浮动窗口
  onFloatDragStart: (cb: () => void) => void;
  onFloatDragEnd: (cb: () => void) => void;
  onFloatUnread: (cb: (count: number) => void) => void;
  /** 移除浮动窗口未读计数监听器 */
  removeFloatUnreadListener: () => void;
  /** 移除浮动窗口拖动开始监听器 */
  removeFloatDragStartListener: () => void;
  /** 移除浮动窗口拖动结束监听器 */
  removeFloatDragEndListener: () => void;
  /** 通知主进程开始拖动（设置 isDragging 标志） */
  startFloatDrag: () => void;
  moveFloatWindow: (dx: number, dy: number) => void;
  saveFloatPosition: () => void;
  expandToFull: () => void;
  /** 显示浮动窗口右键菜单（主进程原生 Menu） */
  showFloatContextMenu: () => void;

  // 主动提示已显示通知
  proactivePromptShown: () => void;
  /** Phase 2.1：用户接受了主动提示（点击"查看"） */
  proactiveAccept: () => void;
  /** Phase 2.1：用户拒绝/忽略了主动提示（点击"稍后"/关闭） */
  proactiveReject: () => void;

  // 窗口状态变更（最大化按钮图标切换）
  onWindowStateChanged: (cb: (msg: { maximized: boolean }) => void) => void;
  /** 移除窗口状态变更监听器 */
  removeWindowStateChangedListener: () => void;

  /** UX-P2-10 通知主进程主题已变更（需同步到浮动窗口） */
  notifyThemeChanged: (theme: 'light' | 'dark') => void;
  /** UX-P2-10 监听主进程广播的主题变更（浮动窗口使用） */
  onThemeBroadcast: (cb: (theme: 'light' | 'dark') => void) => void;
  /** UX-P2-10 移除主题广播监听器 */
  removeThemeBroadcastListener: () => void;

  // ─── H1：配置建议（AutoConfigRefiner 闭环） ──────────
  /** 监听主进程推送的配置建议 */
  onSuggestionPush: (cb: (suggestion: ConfigSuggestionPayload) => void) => void;
  /** 移除配置建议推送监听器 */
  removeSuggestionPushListener: () => void;
  /** 接受配置建议（调用 confirmConfigSuggestion 持久化到配置文件） */
  acceptSuggestion: (suggestion: ConfigSuggestionPayload) => Promise<{ success: boolean; error?: string }>;
  /** 拒绝配置建议（仅记录日志，不持久化） */
  rejectSuggestion: (suggestion: ConfigSuggestionPayload) => Promise<{ success: boolean }>;

  // ─── H2：用户画像（UserProfile 闭环） ────────────────
  /** 列出所有画像条目（含已确认 + 待确认） */
  listUserProfile: () => Promise<{ entries: UserProfileEntryPayload[] }>;
  /** 确认待确认画像条目（写入存储 + 标记 confirmed） */
  confirmUserProfile: (id: string) => Promise<{ success: boolean; error?: string }>;
  /** 拒绝画像条目（从缓存删除，已确认的也从存储删除） */
  rejectUserProfile: (id: string) => Promise<{ success: boolean; error?: string }>;

  // ─── M1：写入确认（安全写入确认 UI） ──────────────────
  /** 监听主进程推送的写入确认请求 */
  onWriteConfirmation: (cb: (info: WriteConfirmationPayload) => void) => void;
  /** 移除写入确认推送监听器 */
  removeWriteConfirmationListener: () => void;
  /** 响应写入确认请求（用户确认/拒绝后回调主进程） */
  responseWriteConfirmation: (requestId: string, confirmed: boolean) => Promise<void>;

  // ─── Phase 3.1：剪贴板三重保护 ────────────────────────
  /** 监听剪贴板变化通知（不携带内容，仅通知 UI 显示"分析"提示） */
  onClipboardChanged: (cb: () => void) => void;
  /** 移除剪贴板变化监听器 */
  removeClipboardChangedListener: () => void;
  /** 监听敏感内容忽略通知（携带 type，供 UI 记录日志） */
  onClipboardSensitiveIgnored: (cb: (payload: { type: string }) => void) => void;
  /** 移除敏感内容忽略监听器 */
  removeClipboardSensitiveIgnoredListener: () => void;
  /** 监听分析就绪通知（携带 content，UI 展示确认对话框） */
  onClipboardAnalysisReady: (cb: (payload: { content: string }) => void) => void;
  /** 移除分析就绪监听器 */
  removeClipboardAnalysisReadyListener: () => void;
  /** 监听分析被拦截通知（携带 reason，UI 提示拦截原因） */
  onClipboardAnalysisRejected: (cb: (payload: { reason: string }) => void) => void;
  /** 移除分析被拦截监听器 */
  removeClipboardAnalysisRejectedListener: () => void;
  /** 请求主进程分析剪贴板内容（用户点击"分析"按钮触发） */
  clipboardAnalyze: () => Promise<boolean>;

  // ─── Phase 3.3 第二批：全局快捷键触发 ──────────────────
  /** 监听 quick-record 触发（聚焦输入框进入快速记录模式） */
  onQuickRecordTrigger: (cb: () => void) => void;
  /** 移除 quick-record 触发监听器 */
  removeQuickRecordTriggerListener: () => void;
  /** 监听 recall-memory 触发（切换到记忆面板） */
  onRecallMemoryTrigger: (cb: () => void) => void;
  /** 移除 recall-memory 触发监听器 */
  removeRecallMemoryTriggerListener: () => void;

  // ─── Phase 4.3：技能文件安装 ──────────────────────────
  /** 安装技能文件到 configDir/skills/（携带文件名和内容） */
  installSkill: (fileName: string, content: string) => Promise<{ success: boolean; error?: string; skillName?: string }>;

  // ─── M2：审计日志 ─────────────────────────────────────
  /** 列出最近 N 条审计日志 */
  listAuditLog: (limit?: number) => Promise<Array<{
    type: string;
    path?: string;
    tool?: string;
    reason?: string;
    timestamp: string;
    sessionId: string;
  }>>;
  /** 清空审计日志 */
  clearAuditLog: () => Promise<void>;

  // H3：作品投影（WorkProjectionManager 查看）
  /** 列出所有作品投影 */
  listWorkProjections: () => Promise<WorkProjectionPayload[]>;
  /** 查看单个作品投影详情（API 已就绪，UI 暂用内联展开替代，供未来宿主集成使用） */
  showWorkProjection: (filePath: string) => Promise<WorkProjectionPayload | null>;

  // ─── FOUNDATION-SEAL Phase 4：渲染进程日志上报 ────────
  /**
   * 上报日志到主进程 logger（渲染进程无 pino，通过 IPC 转发）
   *
   * @param level 日志级别（'warn' | 'error'）
   * @param context 错误上下文标识（如 'loadPersonaList'）
   * @param message 错误消息文本
   */
  rendererLog: (level: 'warn' | 'error', context: string, message: string) => void;
}

const electronAPI: ElectronAPI = {
  // 对话
  sendUserInput: (text) => ipcRenderer.send(IPC_CHANNELS.USER_INPUT, text),
  abortChat: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_ABORT),
  loadSession: (query) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LOAD, query),

  // 流式监听
  // 注意：ipcRenderer.on 注册的监听器会累积，多次调用 on* 方法会导致同一事件触发多次。
  // 提供 remove* 方法供渲染进程在重新初始化或页面卸载时清理。
  onStreamStart: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START, (_: IpcRendererEvent, msg: { messageId: string }) => cb(msg)),
  onStreamChunk: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK, (_: IpcRendererEvent, msg: { messageId: string; text: string }) => cb(msg)),
  onStreamEnd: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, (_: IpcRendererEvent, msg: { messageId: string }) => cb(msg)),
  onStreamRecall: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_RECALL, (_: IpcRendererEvent, msg: { messageId: string; memories: Array<{ id: string; name: string; score: number; source: string }> }) => cb(msg)),
  onStreamToolStart: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_START, (_: IpcRendererEvent, msg: { messageId: string; toolCallId: string; name: string; args?: string }) => cb(msg)),
  onStreamToolResult: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_RESULT, (_: IpcRendererEvent, msg: { messageId: string; toolCallId: string; name: string; ok: boolean; summary?: string }) => cb(msg)),
  onStreamThinking: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING, (_: IpcRendererEvent, msg: { messageId: string; phase: string }) => cb(msg)),
  /** OBS-02 上下文截断通知：对话中发生截断时触发，携带截断次数 */
  onContextTruncated: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_CONTEXT_TRUNCATED, (_: IpcRendererEvent, msg: { messageId: string; count: number }) => cb(msg)),
  /** UX-PP-10 流式对话被中断监听 */
  onStreamAborted: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED, (_: IpcRendererEvent, msg: { messageId: string; reason: string }) => cb(msg)),
  removeStreamListeners: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START);
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK);
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END);
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_RECALL);
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_START);
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_RESULT);
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING);
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_CONTEXT_TRUNCATED);
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED);
  },

  // 精灵输出
  onSpriteOutput: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT, (_: IpcRendererEvent, msg: { text: string; kind: 'proactive' | 'system' }) => cb(msg)),
  removeSpriteOutputListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT);
  },

  // 精灵事件
  onSpriteEvent: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, (_: IpcRendererEvent, msg: { type: string; payload: unknown; silent: boolean }) => cb(msg)),
  removeSpriteEventListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT);
  },

  // 错误
  onSpriteError: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, (_: IpcRendererEvent, msg: { text: string }) => cb(msg)),
  removeSpriteErrorListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
  },

  // 应用错误
  onAppError: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.APP_ERROR, (_: IpcRendererEvent, msg: SerializedAppError) => cb(msg)),
  removeAppErrorListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.APP_ERROR);
  },

  // Agent 状态查询
  getAgentStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STATUS),

  // LLM 配置读写
  getLlmConfig: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_CONFIG_GET),
  saveLlmConfig: (llmConfig, embeddingConfig) => ipcRenderer.invoke(IPC_CHANNELS.LLM_CONFIG_SAVE, llmConfig, embeddingConfig),
  testLlmConfig: (llmConfig) => ipcRenderer.invoke(IPC_CHANNELS.LLM_CONFIG_TEST, llmConfig),

  // Agent 就绪通知
  onAgentReady: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.AGENT_READY, () => cb()),
  removeAgentReadyListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.AGENT_READY);
  },

  // 记忆
  listMemories: (query) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_LIST, query ?? {}),
  searchMemories: (q) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_SEARCH, q),
  showMemory: (id) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_SHOW, id),
  deleteMemory: (id) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_DELETE, id),
  addMemory: (data) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_ADD, data),
  getRelationGraph: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_RELATION_GRAPH),
  /** 添加记忆关系（手动创建，关系图交互） */
  addRelation: (data: { sourceId: string; targetId: string; type: string; weight: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_ADD_RELATION, data),
  /** 删除记忆关系（关系图交互） */
  removeRelation: (data: { sourceId: string; targetId: string; type: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_REMOVE_RELATION, data),
  /** 更新记忆关系（关系图交互） */
  updateRelation: (data: { sourceId: string; targetId: string; type: string; weight: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_UPDATE_RELATION, data),
  archiveProfileFacts: (input: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_ARCHIVE_PROFILE, { input }),
  archiveInsight: (input: string, assistantContent: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_ARCHIVE_INSIGHT, { input, assistantContent }),
  getHealthDashboard: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_HEALTH_DASHBOARD),
  getReviewData: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_REVIEW_DATA),
  deleteMemoriesBatch: (ids) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_DELETE_BATCH, ids),

  // 配置
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET),
  updateConfig: (key, value) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_UPDATE, key, value),
  updateConfigBatch: (updates) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_UPDATE_BATCH, updates),

  // 角色
  listPersonas: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_LIST),
  switchPersona: (name) => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_SWITCH, name),
  setPersonaMode: (mode) => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_MODE, mode),
  /** IX-07 查询当前角色匹配模式 */
  getPersonaMode: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_MODE_GET),

  // 项目（FD-04）
  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_LIST),

  // FD-A1 列出所有会话
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
  // UX-P1-04 切换到已有会话（更新 Agent 内部状态）
  switchSession: (query) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SWITCH, query),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionId),
  renameSession: (sessionId, newName) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_RENAME, sessionId, newName),

  // 仪表盘（FD-03）
  getDashboard: () => ipcRenderer.invoke(IPC_CHANNELS.DASHBOARD_GET),
  // 感知数据快照（精灵感知面板打开时调用）
  getPerceptionSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.PERCEPTION_GET),

  // 窗口
  windowMinimize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE),
  windowMaximize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE),
  windowClose: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE),

  // 浮动窗口
  onFloatDragStart: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.FLOAT_DRAG_START, () => cb()),
  onFloatDragEnd: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.FLOAT_DRAG_END, () => cb()),
  onFloatUnread: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD, (_: IpcRendererEvent, count: number) => cb(count)),
  removeFloatUnreadListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD);
  },
  removeFloatDragStartListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.FLOAT_DRAG_START);
  },
  removeFloatDragEndListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.FLOAT_DRAG_END);
  },
  startFloatDrag: () => ipcRenderer.send(IPC_CHANNELS.FLOAT_DRAG_BEGIN),
  moveFloatWindow: (dx, dy) => ipcRenderer.send(IPC_CHANNELS.MOVE_FLOAT_WINDOW, dx, dy),
  saveFloatPosition: () => ipcRenderer.send(IPC_CHANNELS.SAVE_FLOAT_POSITION),
  expandToFull: () => ipcRenderer.send(IPC_CHANNELS.EXPAND_TO_FULL),
  showFloatContextMenu: () => ipcRenderer.send(IPC_CHANNELS.FLOAT_CONTEXT_MENU),

  // 主动提示
  proactivePromptShown: () => ipcRenderer.send(IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN),
  proactiveAccept: () => ipcRenderer.send(IPC_CHANNELS.PROACTIVE_ACCEPT),
  proactiveReject: () => ipcRenderer.send(IPC_CHANNELS.PROACTIVE_REJECT),

  // 窗口状态变更（最大化按钮图标切换）
  onWindowStateChanged: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.WINDOW_STATE_CHANGED, (_: IpcRendererEvent, msg: { maximized: boolean }) => cb(msg)),
  removeWindowStateChangedListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.WINDOW_STATE_CHANGED);
  },

  // UX-P2-10 主题变更同步（完整窗口 → 主进程 → 浮动窗口）
  notifyThemeChanged: (theme) => ipcRenderer.send(IPC_CHANNELS.THEME_CHANGED, theme),
  onThemeBroadcast: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.THEME_BROADCAST, (_: IpcRendererEvent, theme: 'light' | 'dark') => cb(theme)),
  removeThemeBroadcastListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.THEME_BROADCAST);
  },

  // H1：配置建议（AutoConfigRefiner 闭环）
  onSuggestionPush: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SUGGESTION_PUSH, (_: IpcRendererEvent, suggestion: ConfigSuggestionPayload) => cb(suggestion)),
  removeSuggestionPushListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SUGGESTION_PUSH);
  },
  acceptSuggestion: (suggestion) => ipcRenderer.invoke(IPC_CHANNELS.SUGGESTION_ACCEPT, suggestion),
  rejectSuggestion: (suggestion) => ipcRenderer.invoke(IPC_CHANNELS.SUGGESTION_REJECT, suggestion),

  // H2：用户画像（UserProfile 闭环）
  listUserProfile: () => ipcRenderer.invoke(IPC_CHANNELS.USER_PROFILE_LIST),
  confirmUserProfile: (id) => ipcRenderer.invoke(IPC_CHANNELS.USER_PROFILE_CONFIRM, id),
  rejectUserProfile: (id) => ipcRenderer.invoke(IPC_CHANNELS.USER_PROFILE_REJECT, id),

  // M1：写入确认（安全写入确认 UI）
  onWriteConfirmation: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.WRITE_CONFIRMATION, (_: IpcRendererEvent, info: WriteConfirmationPayload) => cb(info)),
  removeWriteConfirmationListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.WRITE_CONFIRMATION);
  },
  responseWriteConfirmation: (requestId, confirmed) => ipcRenderer.invoke(IPC_CHANNELS.WRITE_CONFIRMATION_RESPONSE, requestId, confirmed),

  // Phase 3.1：剪贴板三重保护
  onClipboardChanged: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_CHANGED, (_: IpcRendererEvent) => cb()),
  removeClipboardChangedListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_CHANGED);
  },
  onClipboardSensitiveIgnored: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_SENSITIVE_IGNORED, (_: IpcRendererEvent, payload: { type: string }) => cb(payload)),
  removeClipboardSensitiveIgnoredListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_SENSITIVE_IGNORED);
  },
  onClipboardAnalysisReady: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_ANALYSIS_READY, (_: IpcRendererEvent, payload: { content: string }) => cb(payload)),
  removeClipboardAnalysisReadyListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_ANALYSIS_READY);
  },
  onClipboardAnalysisRejected: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_ANALYSIS_REJECTED, (_: IpcRendererEvent, payload: { reason: string }) => cb(payload)),
  removeClipboardAnalysisRejectedListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_ANALYSIS_REJECTED);
  },
  clipboardAnalyze: () => ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_ANALYZE),

  // Phase 3.3 第二批：全局快捷键触发
  onQuickRecordTrigger: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.QUICK_RECORD_TRIGGER, (_: IpcRendererEvent) => cb()),
  removeQuickRecordTriggerListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.QUICK_RECORD_TRIGGER);
  },
  onRecallMemoryTrigger: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.RECALL_MEMORY_TRIGGER, (_: IpcRendererEvent) => cb()),
  removeRecallMemoryTriggerListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.RECALL_MEMORY_TRIGGER);
  },

  // Phase 4.3：技能文件安装
  installSkill: (fileName, content) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_INSTALL, fileName, content),

  // M2：审计日志（路径白名单的审计事件持久化与查询）
  listAuditLog: (limit) => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_LOG_LIST, limit),
  clearAuditLog: () => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_LOG_CLEAR),

  // H3：作品投影（WorkProjectionManager 查看）
  listWorkProjections: () => ipcRenderer.invoke(IPC_CHANNELS.WORK_PROJECTION_LIST),
  showWorkProjection: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.WORK_PROJECTION_SHOW, filePath),

  // FOUNDATION-SEAL Phase 4：渲染进程日志上报（fire-and-forget，日志无需等待）
  rendererLog: (level, context, message) => ipcRenderer.send(IPC_CHANNELS.RENDERER_LOG, { level, context, message }),
};

// C-1：条件保护——测试环境（vitest）无 contextBridge，直接调用会抛错阻断测试
// sandbox 环境下 contextBridge 始终存在，此条件不影响生产运行
if (typeof contextBridge !== 'undefined' && contextBridge.exposeInMainWorld) {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
}
