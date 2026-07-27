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
// SerializedAppError / WorkProjectionPayload 真理源在 ipc/types.ts
import type { SerializedAppError, WorkProjectionPayload } from './ipc/types.js';
// 重新导出 WorkProjectionPayload，使渲染层统一从 preload 导入
export type { WorkProjectionPayload };
// 从业务层导入 IPC 契约类型，消除 preload 与 memoryController 的重复定义（DRY）。
// 使用 import type：编译时擦除，不引入运行时耦合；electron 层依赖 sprite 层是合理依赖方向。
import type {
  MemoryListItem,
  MemoryDetail,
  MemoryRelationItem,
  MemorySearchResult as MemorySearchHit,
  // 回收站列表项契约类型，从业务层真理源导入
  DeletedMemoryListItem,
  // Phase 5.1/5.2：路径追溯 + 邻居查询结果类型（精灵层 re-export 内核纯数据形态）
  RelationPath,
  RelationNeighbor,
} from '../sprite/controllers/memoryController.js';
// P3：从 sprite 层导入 SpriteConfig（真理源），用于派生 SpriteConfigForm（消除手写平行结构）
import type { SpriteConfig } from '../sprite/spriteConfig.js';
// L1~L3 LLM 治理报告类型（从内核 re-export 导入，用于 ElectronAPI 接口声明）
import type { DedupReport, TimelinessReport, ConflictReport } from 'memora';
// P5：从 sprite 层导入感知状态类型（真理源），修复 getPerceptionSnapshot 返回类型过宽问题
import type { AffectState, RapportState, ContextState, DetectedPattern, ProactiveStats } from '../sprite/controllers/index.js';
// 精灵设定面板 Epic 3：从 sprite 层 configFileManager 导入契约类型（真理源，编译时擦除）
// 与 skillInstaller.installSkill 的 SkillInstallResult 一样，通过 preload 透出给渲染层
import type { ConfigFileEntry, ConfigFileOperationResult } from '../sprite/configFileManager.js';

// ─── 内联 IPC 通道常量（sandbox 兼容性：不能运行时导入 ipcChannels.ts） ─────
// ⚠️ 与 ipcChannels.ts 保持同步：修改 ipcChannels.ts 时需同步更新此处的内联副本。
// 主进程使用 ipcChannels.ts（真理源），preload 使用此内联副本（sandbox 限制）。
// export 这两个常量，供 channelParity.test.ts 断言键集与真理源一致，
// 防止 sandbox 限制下的手动复制静默失配（UI 按钮无响应等全链路失效）。
export const IPC_CHANNELS = {
  USER_INPUT: 'user-input',
  CHAT_ABORT: 'chat-abort',
  /** 强制释放对话锁（应急恢复，与 ipc/channels.ts 保持同步） */
  CHAT_FORCE_RELEASE_LOCK: 'chat-force-release-lock',
  SESSION_LOAD: 'session-load',
  SESSION_LIST: 'session-list',
  SESSION_SWITCH: 'session-switch',
  /** 删除会话（含确认对话框） */
  SESSION_DELETE: 'session-delete',
  /** 重命名会话 */
  SESSION_RENAME: 'session-rename',
  /** 搜索对话内容（跨所有会话，返回匹配的消息片段） */
  SESSION_SEARCH: 'session-search',
  /** 会话分叉（内核 forkSession 已实现，发射 sessionForked 事件） */
  SESSION_FORK: 'session-fork',
  MEMORIES_LIST: 'memories-list',
  /** 列出 distinct 记忆 source（与 ipc/channels.ts 保持同步，用于来源筛选 dropdown 动态生成） */
  MEMORIES_SOURCES: 'memories-sources',
  MEMORIES_SEARCH: 'memories-search',
  MEMORIES_SHOW: 'memories-show',
  MEMORIES_DELETE: 'memories-delete',
  /** 恢复软删除记忆 */
  MEMORIES_RESTORE: 'memories-restore',
  /** 物理删除记忆（回收站彻底删除） */
  MEMORIES_PURGE: 'memories-purge',
  /** 批量恢复回收站所有记忆 */
  MEMORIES_RESTORE_ALL: 'memories-restore-all',
  /** 批量清空回收站所有记忆 */
  MEMORIES_PURGE_ALL: 'memories-purge-all',
  /** 列出回收站记忆 */
  MEMORIES_LIST_DELETED: 'memories-list-deleted',
  /** 手动归档会话内容（一键归档） */
  ARCHIVE_SESSION: 'archive-session',
  MEMORIES_ADD: 'memories-add',
  /** 提升记忆 score（L2 采纳反哺内核） */
  MEMORIES_BOOST: 'memories-boost',
  /** L1 语义去重（LLM 治理） */
  MEMORIES_DEDUP: 'memories-dedup',
  /** L2 时效性评估（LLM 治理，手动触发） */
  MEMORIES_EVALUATE_TIMELINESS: 'memories-evaluate-timeliness',
  /** L3 冲突检测（LLM 治理） */
  MEMORIES_DETECT_CONFLICTS: 'memories-detect-conflicts',
  MEMORIES_RELATION_GRAPH: 'memories-relation-graph',
  /** 获取记忆关系路径（Phase 5.1：路径追溯） */
  MEMORIES_RELATION_PATH: 'memories-relation-path',
  /** 获取记忆关系邻居（Phase 5.2：邻居查询） */
  MEMORIES_RELATION_NEIGHBORS: 'memories-relation-neighbors',
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
  /** 手动归档 profile facts（manual 模式下供 UI 调用） */
  MEMORIES_ARCHIVE_PROFILE: 'memories-archive-profile',
  /** 手动归档 insight（manual 模式下供 UI 调用） */
  MEMORIES_ARCHIVE_INSIGHT: 'memories-archive-insight',
  CONFIG_GET: 'config-get',
  CONFIG_UPDATE: 'config-update',
  // 批量事务性更新配置（必须与 ipc/channels.ts 保持同步）
  CONFIG_UPDATE_BATCH: 'config-update-batch',
  PERSONA_LIST: 'persona-list',
  PERSONA_SWITCH: 'persona-switch',
  PERSONA_MODE: 'persona-mode',
  PERSONA_MODE_GET: 'persona-mode-get',
  // ─── 角色文件 CRUD（精灵设定面板 Epic 3 · I1，与 ipc/channels.ts 同步） ─
  /** 读取角色文件内容（携带 name，返回 ConfigFileEntry | null） */
  PERSONA_READ_FILE: 'persona-read-file',
  /** 保存角色文件（新增/更新合并，携带 name + content） */
  PERSONA_SAVE_FILE: 'persona-save-file',
  /** 删除角色文件（携带 name） */
  PERSONA_DELETE_FILE: 'persona-delete-file',
  /** 打开配置文件目录（personas/skills/rules 所在目录） */
  CONFIG_DIR_OPEN: 'config-dir-open',
  PROJECTS_LIST: 'projects-list',
  DASHBOARD_GET: 'dashboard-get',
  /** 手动触发一次记忆衰减（L0 纯 score 递减，无 LLM 调用，与 ipc/channels.ts 同步） */
  MEMORY_DECAY_RUN: 'memory-decay-run',
  PERCEPTION_GET: 'perception-get',
  STARTUP_SUMMARY_GET: 'startup-summary-get',
  LLM_CONFIG_GET: 'llm-config-get',
  LLM_CONFIG_SAVE: 'llm-config-save',
  LLM_CONFIG_TEST: 'llm-config-test',
  /** 获取 Provider 列表 */
  LLM_PROVIDER_LIST: 'llm-provider-list',
  /** 保存 Provider 配置（新增/更新） */
  LLM_PROVIDER_SAVE: 'llm-provider-save',
  /** 删除 Provider */
  LLM_PROVIDER_DELETE: 'llm-provider-delete',
  /** 切换激活 Provider */
  LLM_PROVIDER_SET_ACTIVE: 'llm-provider-set-active',
  /** 保存后台 Provider 选择（角色自动匹配 LLM 辅助 + Insight 提取等后台任务） */
  LLM_BACKGROUND_PROVIDER_SAVE: 'llm-background-provider-save',
  AGENT_STATUS: 'agent-status',
  PROACTIVE_PROMPT_SHOWN: 'proactive-prompt-shown',
  /** Phase 2.1：用户接受了主动提示（点击"查看"） */
  PROACTIVE_ACCEPT: 'proactive-accept',
  /** Phase 2.1：用户拒绝/忽略了主动提示（点击"稍后"/关闭） */
  PROACTIVE_REJECT: 'proactive-reject',
  // 配置建议（接受/拒绝）
  SUGGESTION_ACCEPT: 'suggestion-accept',
  SUGGESTION_REJECT: 'suggestion-reject',
  // 用户画像管理
  USER_PROFILE_LIST: 'user-profile-list',
  USER_PROFILE_CONFIRM: 'user-profile-confirm',
  USER_PROFILE_REJECT: 'user-profile-reject',
  WINDOW_MINIMIZE: 'window-minimize',
  WINDOW_MAXIMIZE: 'window-maximize',
  WINDOW_CLOSE: 'window-close',
  THEME_CHANGED: 'theme-changed',
  MOVE_FLOAT_WINDOW: 'move-float-window',
  SAVE_FLOAT_POSITION: 'save-float-position',
  EXPAND_TO_FULL: 'expand-to-full',
  FLOAT_CONTEXT_MENU: 'float-context-menu',
  SHOW_QUICK_INPUT_FROM_FLOAT: 'show-quick-input-from-float',
  // M1：写入确认响应（渲染进程 → 主进程）
  WRITE_CONFIRMATION_RESPONSE: 'write-confirmation-response',
  // 作品投影查看
  WORK_PROJECTION_LIST: 'work-projection-list',
  WORK_PROJECTION_SHOW: 'work-projection-show',
  // M2：审计日志查看/清除
  AUDIT_LOG_LIST: 'audit-log-list',
  AUDIT_LOG_CLEAR: 'audit-log-clear',
  // Phase 3.1：剪贴板三重保护
  CLIPBOARD_ANALYZE: 'clipboard-analyze',
  // Phase 4.3：技能安装（渲染进程 → 主进程）
  SKILL_INSTALL: 'skill-install',
  // ─── 设定文件 CRUD（精灵设定面板 Epic 3 · I2/I3，与 ipc/channels.ts 同步） ─
  // 规则与技能的统一文件管理入口（角色文件 CRUD 见上方 PERSONA_*_FILE）
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
  // 快速输入补全（Phase 1 骨架：确认 + 关闭 + Phase 2 调整高度）
  QUICK_INPUT_CONFIRM: 'quick-input-confirm',
  QUICK_INPUT_CLOSE: 'quick-input-close',
  QUICK_INPUT_RESIZE: 'quick-input-resize',
  // 拖动浮窗位置（focus-bar 顶部标题栏可拖，dx/dy 增量，与 ipc/channels.ts MOVE_QUICK_INPUT 同步）
  MOVE_QUICK_INPUT: 'move-quick-input',
  // LLM 润色文本（携带原文，返回润色后文本，与 ipc/channels.ts QUICK_INPUT_POLISH 同步）
  QUICK_INPUT_POLISH: 'quick-input-polish',
  // 常驻模式切换（与 ipc/channels.ts 同步）
  // pinnedMode/alwaysOnTop 强耦合：浮窗永远 alwaysOnTop=true + skipTaskbar=true，
  // 消除 Windows 任务栏默认图标 bug。
  QUICK_INPUT_SET_PINNED_MODE: 'quick-input-set-pinned-mode',
  // 手动重捕获前台窗口（聚焦栏点击触发，与 ipc/channels.ts 同步）
  RECAPTURE_TARGET: 'recapture-target',
  // 渲染进程日志上报（渲染进程 → 主进程）
  RENDERER_LOG: 'renderer-log',
  // 使用统计导出（渲染进程 → 主进程）
  USAGE_STATS_EXPORT: 'usage-stats-export',
  // 清除使用统计数据（渲染进程 → 主进程）
  USAGE_STATS_CLEAR: 'usage-stats-clear',
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
  FLOAT_UNREAD: 'float-unread',
  /** P4-1：浮动窗口最后一条助手消息预览 */
  FLOAT_LAST_MESSAGE: 'float-last-message',
  WINDOW_STATE_CHANGED: 'window-state-changed',
  THEME_BROADCAST: 'theme-broadcast',
  // 主进程推送配置建议到渲染进程
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
  /** 快速输入浮窗被 show() 调用（通知渲染进程清空输入框，替代 focus 事件） */
  QUICK_INPUT_SHOW: 'quick-input-show',
  /** 浮窗聚焦变化通知（blur/focus 事件，appName=null 表示失焦） */
  QUICK_INPUT_FOCUS_CHANGE: 'quick-input-focus-change',
  // ─── 设定文件变更广播（精灵设定面板 Epic 3 · I4，与 ipc/channels.ts 同步） ─
  /**
   * 主进程 → 渲染进程：设定文件变更通知
   *
   * 携带 { type, action, name } payload：
   *   - type: 'persona' | 'rule' | 'skill'
   *   - action: 'save' | 'delete'
   *   - name: 配置名
   *
   * 触发场景：设定面板 CRUD 完成后广播 + personaWatcher 监听到外部编辑器修改 personas/ 目录时广播。
   * 渲染层监听后按 type 分发刷新（U8）。
   */
  CONFIG_FILES_CHANGED: 'config-files-changed',
} as const;

// 重新导出契约类型，供 ui.ts / renderer.ts 通过 preload 统一引用
// DeletedMemoryListItem 用于 UI 渲染回收站列表
// ConfigFileEntry / ConfigFileOperationResult 用于精灵设定面板渲染层引用
export type { MemoryListItem, MemoryDetail, MemoryRelationItem, MemorySearchHit, DeletedMemoryListItem, RelationPath, RelationNeighbor, ConfigFileEntry, ConfigFileOperationResult };

/**
 * 设定文件变更事件载荷（精灵设定面板 Epic 3 · I4）
 *
 * 主进程通过 CONFIG_FILES_CHANGED 通道推送到渲染进程，
 * 渲染层按 type 分发刷新对应面板（persona/rule/skill）。
 */
export interface ConfigFilesChangedPayload {
  /** 配置类型 */
  type: 'persona' | 'rule' | 'skill';
  /** 操作类型 */
  action: 'save' | 'delete';
  /** 配置名 */
  name: string;
}

// ─── 配置建议/用户画像共享类型定义 ───────────────────────────────────

/**
 * 配置建议（与内核 ConfigSuggestion 对齐）
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
 * 用户画像条目（与内核 UserProfileEntry 对齐）
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
  /** 文件当前内容预览（截断到 10KB，null 表示新文件）—— 用于 diff 展示 */
  beforeContent?: string | null;
  /** 写入后内容预览（截断到 10KB）—— 用于 diff 展示 */
  afterContent?: string;
}

/**
 * 剪贴板变化事件载荷
 *
 * 主进程 ClipboardHandler 检测到哈希变化后，读取剪贴板构造此 payload，
 * 通过 CLIPBOARD_CHANGED 通道推送到渲染进程。渲染层 ClipboardManager
 * 据此调用 addPendingItem(preview, length) 加入待处理列表。
 *
 * 设计决策：
 * - 仅传 preview（前 100 字符）+ length，不传完整内容（减少 IPC 载荷）
 * - 完整内容在归档时通过 clipboardHandler.analyze() 主动读取
 * - 不传 hash（clipboardHandler.computeHash 是 private，不暴露）
 */
export interface ClipboardChangedPayload {
  /** 完整内容（用于复制按钮写回 OS 剪贴板，localStorage 持久化） */
  content: string;
  /** 内容预览（前 100 字符，用于列表展示和归档时软校验） */
  preview: string;
  /** 内容完整长度（用于列表展示"100字"等） */
  length: number;
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
  /** 消息原始时间戳（ISO 8601），用于历史消息显示正确时间 */
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
  // AUDIT-5-4 使用统计开关（隐私合规，默认关闭）
  | 'usageStatsEnabled'
>>;

export interface SpriteConfigForm extends SpriteConfigFormBase {
  /** 静默模式恢复时间（ISO 8601），null 表示无定时恢复 */
  silentModeExpiresAt?: string | null;
  /** 界面主题（窄化版：'auto' 不暴露到表单，由 onThemeChange 即时处理） */
  theme: 'light' | 'dark';
  /** 文件监听忽略模式（glob 列表，可选，与 SpriteConfig 一致） */
  fileWatcherIgnore?: string[];
}

export interface ElectronAPI {
  // 对话
  sendUserInput: (text: string) => void;
  abortChat: () => Promise<void>;
  /**
   * 强制释放对话锁（应急恢复）
   *
   * 当 LLM Provider 挂起但未触发 60s 超时时，用户可手动释放锁立即发起新对话。
   * 与 abortChat 的区别：abort 只中断流，forceRelease 直接清理内核锁。
   * @returns released 是否真的释放了锁（false 表示本来就没锁）
   */
  forceReleaseChatLock: () => Promise<{ released: boolean }>;
  loadSession: (query: { date?: string; session?: string; limit?: number; offset?: number }) => Promise<{ messages: ChatMessage[]; loadedSessionId: string; total: number; hasMore: boolean }>;
  /** 列出所有会话 */
  listSessions: () => Promise<{ sessions: Array<{ id: string; date: string; name: string; preview?: string; messageCount?: number }> }>;
  /** 切换到已有会话（更新 Agent 内部状态，避免消息持久化到错误会话） */
  switchSession: (query: { date: string; session: string }) => Promise<{ success: boolean; messages: ChatMessage[]; error?: string }>;
  /** 删除会话（不可恢复，调用方需自行确认） */
  deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  /** 重命名会话 */
  renameSession: (sessionId: string, newName: string) => Promise<{ success: boolean; error?: string }>;
  /**
   * 搜索对话内容（跨所有会话）
   * @param query.keyword 搜索关键词
   * @param query.limit 返回上限（默认 50，最大 100）
   * @returns results 匹配的消息列表
   */
  searchSessionMessages: (query: { keyword: string; limit?: number }) => Promise<{
    results: Array<{ date: string; session: string; role: string; content: string; timestamp: string }>;
  }>;
  /**
   * 会话分叉（从当前会话分叉出独立分支，保留全部历史消息）
   *
   * @param targetSession 可选，指定分叉目标会话名；不传时由内核自动生成
   * @returns 成功时返回新会话名和消息数；失败时返回 error
   */
  forkSession: (targetSession?: string) => Promise<{ success: boolean; newSession?: string; messageCount?: number; error?: string }>;

  // 流式监听（含移除方法，防止多次调用导致重复触发与内存泄漏）
  onStreamStart: (cb: (msg: { messageId: string; persona?: string }) => void) => void;
  onStreamChunk: (cb: (msg: { messageId: string; text: string }) => void) => void;
  onStreamEnd: (cb: (msg: { messageId: string }) => void) => void;
  /**
   * 召回透明度监听
   * 在 text chunk 之前触发，携带本次对话召回的记忆摘要列表
   */
  onStreamRecall: (cb: (msg: { messageId: string; memories: Array<{ id: string; name: string; score: number; source: string }> }) => void) => void;
  /** 工具调用开始监听（携带工具名和参数） */
  onStreamToolStart: (cb: (msg: { messageId: string; toolCallId: string; name: string; args?: string }) => void) => void;
  /** 工具调用结果监听（携带工具名、成功状态和摘要） */
  onStreamToolResult: (cb: (msg: { messageId: string; toolCallId: string; name: string; ok: boolean; summary?: string }) => void) => void;
  /** 思考阶段监听（recalling/processing/archiving） */
  onStreamThinking: (cb: (msg: { messageId: string; phase: string }) => void) => void;
  /** 上下文截断通知：对话中发生截断时触发，携带截断次数 */
  onContextTruncated: (cb: (msg: { messageId: string; count: number }) => void) => void;
  /**
   * 流式对话被中断监听
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
  // 注意：已移除 presets 字段——不内置 Provider 预设，用户在 onboarding/设置面板手填所有字段
  getLlmConfig: () => Promise<{
    configured: boolean;
    config: { provider: string; model: string; baseUrl: string; apiKey: string; temperature: number } | null;
    embedding: { model: string; baseUrl: string; apiKey: string } | null;
  }>;
  saveLlmConfig: (
    llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number },
    embeddingConfig?: { model: string; baseUrl?: string; apiKey?: string },
  ) => Promise<{ success: boolean; error: string | null }>;

  /** 测试 LLM 连接（保存前验证配置是否可用） */
  testLlmConfig: (llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string }) => Promise<{ success: boolean; error: string | null }>;

  // ─── 多 Provider 管理 ──────────────────────────────────
  /** 获取 Provider 列表 */
  listLlmProviders: () => Promise<{ active: string; providers: Array<{ key: string; name: string; provider: string; model: string; baseUrl: string; apiKey: string; temperature: number; contextWindow?: number }> }>;
  /** 保存 Provider（新增/更新；编辑模式 isEditing=true 时 apiKey 允许空，保留原值） */
  saveLlmProvider: (key: string, config: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number; contextWindow?: number }, isEditing?: boolean) => Promise<{ success: boolean; error: string | null }>;
  /** 删除 Provider */
  deleteLlmProvider: (key: string) => Promise<{ success: boolean; error: string | null }>;
  /** 切换激活 Provider */
  setActiveLlmProvider: (key: string) => Promise<{ success: boolean; error: string | null; warning?: string }>;
  /** 保存后台 Provider 选择（角色自动匹配 LLM 辅助 + Insight 提取等后台任务） */
  saveBackgroundProvider: (key: string) => Promise<{ success: boolean; error: string | null }>;

  // Agent 就绪通知（主进程 → 渲染进程）
  onAgentReady: (cb: () => void) => void;
  /** 移除 Agent 就绪监听器 */
  removeAgentReadyListener: () => void;

  // 记忆
  listMemories: (query?: { source?: string }) => Promise<{ memories: MemoryListItem[] }>;
  /**
   * 列出全部 distinct 记忆 source（用于来源筛选 dropdown 动态生成）
   * @returns sources 排序后的 source 字符串数组
   */
  listMemorySources: () => Promise<{ sources: string[] }>;
  searchMemories: (query: string) => Promise<{ hits: MemorySearchHit[] }>;
  showMemory: (id: string) => Promise<{ memory: MemoryDetail | null }>;
  deleteMemory: (id: string) => Promise<{ deleted: boolean }>;
  /**
   * 恢复软删除记忆（从回收站还原）
   * @param id 记忆 ID
   * @returns restored=true 表示恢复成功
   */
  restoreMemory: (id: string) => Promise<{ restored: boolean; id: string }>;
  /**
   * 物理删除记忆（回收站彻底删除，不可恢复）
   * @param id 记忆 ID
   * @returns purged=true 表示已彻底删除
   */
  purgeMemory: (id: string) => Promise<{ purged: boolean }>;
  /**
   * 批量恢复回收站所有记忆
   * @returns restored 恢复成功的数量
   */
  restoreAllMemories: () => Promise<{ restored: number; failed: number }>;
  /**
   * 批量清空回收站所有记忆
   * @returns purged 彻底删除的数量
   */
  purgeAllMemories: () => Promise<{ purged: number; failed: number }>;
  /**
   * 列出回收站记忆（按 deletedAt 降序，最近删除在前）
   * @returns 回收站记忆列表（仅暴露必要字段，content 已截断预览）
   */
  listDeletedMemories: () => Promise<{ memories: DeletedMemoryListItem[] }>;
  addMemory: (data: { source: string; name: string; content: string }) => Promise<{ id: string }>;
  /** 提升记忆 score（L2 采纳反哺内核，补全采纳时调用） */
  boostMemory: (id: string) => Promise<{ success: boolean }>;
  /** L1 语义去重（LLM 治理：扫描名称相似对 → 降级低分记忆） */
  deduplicateMemories: () => Promise<DedupReport>;
  /** L2 时效性评估（LLM 治理：扫描低分记忆 → 降级过时记忆） */
  evaluateTimeliness: () => Promise<TimelinessReport>;
  /** L3 冲突检测（LLM 治理：仅检测不修复） */
  detectConflicts: () => Promise<ConflictReport>;
  /** 获取记忆关系图谱（ADR-014：拓扑可视化） */
  getRelationGraph: () => Promise<{ nodes: MemoryListItem[]; edges: Array<{ sourceId: string; targetId: string; type: string; weight: number; createdAt: string }> }>;
  /** 添加记忆关系（手动创建，关系图交互） */
  addRelation: (data: { sourceId: string; targetId: string; type: string; weight: number }) => Promise<{ success: boolean }>;
  /** 删除记忆关系（关系图交互） */
  removeRelation: (data: { sourceId: string; targetId: string; type: string }) => Promise<{ success: boolean }>;
  /** 更新记忆关系（关系图交互） */
  updateRelation: (data: { sourceId: string; targetId: string; type: string; weight: number }) => Promise<{ success: boolean }>;
  /** 获取记忆关系路径（Phase 5.1：路径追溯，展示记忆演化脉络） */
  getRelationPath: (data: { memoryId: string; maxDepth?: number; direction?: 'incoming' | 'outgoing' | 'both' }) => Promise<RelationPath[]>;
  /** 获取记忆关系邻居（Phase 5.2：邻居查询，展示直接关联记忆） */
  getRelationNeighbors: (data: { memoryId: string; limit?: number }) => Promise<RelationNeighbor[]>;
  /** 手动归档 profile facts（manual 模式下供 UI 调用，返回归档条目数） */
  archiveProfileFacts: (input: string) => Promise<{ count: number }>;
  /** 手动归档 insight（manual 模式下供 UI 调用，返回归档记忆数） */
  archiveInsight: (input: string, assistantContent: string) => Promise<{ count: number }>;
  /** 批量归档当前会话（一键归档） */
  archiveSession: (date: string, session: string) => Promise<{ archivedCount: number }>;
  /** 获取记忆健康度仪表盘数据（Phase 1：健康度诊断） */
  getHealthDashboard: () => Promise<HealthDashboardPayload>;
  /** 获取对话回顾数据（Phase 2：对话回顾与摘要） */
  getReviewData: () => Promise<ReviewDataPayload>;
  /** 批量删除记忆（Phase 3：智能清理） */
  deleteMemoriesBatch: (ids: string[]) => Promise<{ deleted: number; total: number }>;

  // 配置
  getConfig: () => Promise<{ config: SpriteConfigForm }>;
  /** 返回类型新增 error 字段（更新失败时包含错误信息） */
  updateConfig: (key: string, value: unknown) => Promise<{ updated: boolean; error?: string }>;
  /**
   * 批量更新配置（事务性）
   *
   * 替代 onConfigSave 中 N 次串行 updateConfig 调用。主进程在单个事务内完成
   * 全部更新（原子性 + 单次持久化 + 副作用去重），避免半更新状态。
   * 返回类型与 updateConfig 一致，便于复用现有错误处理逻辑。
   */
  updateConfigBatch: (updates: Record<string, unknown>) => Promise<{ updated: boolean; error?: string }>;

  // 角色
  listPersonas: () => Promise<{ personas: Array<{ name: string; description: string; active: boolean }> }>;
  /**
   * 切换角色（P0-2 用户体验打磨：返回值扩展 reason + unlockAt，向后兼容）
   *
   * @returns reason 取值：
   *   - undefined：切换成功
   *   - 'invalid'：名称非法（含路径分隔符/空格）
   *   - 'not_found'：角色不存在
   *   - 'locked'：切换锁定中（60s 内 3 次后锁 5 分钟），unlockAt 为自动恢复时间戳（ms epoch）
   *   - 'busy'：对话进行中
   *   - 'unknown'：其他异常
   */
  switchPersona: (name: string) => Promise<{
    switched: boolean;
    name: string | null;
    reason?: 'invalid' | 'not_found' | 'locked' | 'busy' | 'unknown';
    unlockAt?: number | null;
    error?: string;
  }>;
  setPersonaMode: (mode: 'auto' | 'manual') => Promise<{ set: boolean }>;
  /** 查询当前角色匹配模式 */
  getPersonaMode: () => Promise<{ mode: string }>;

  // ─── 精灵设定面板 Epic 3：角色/规则/技能文件 CRUD ─────────────
  /**
   * 读取角色文件内容
   *
   * @param name 配置名（不含扩展名）
   * @returns ConfigFileEntry | null（文件不存在返回 null）
   */
  readPersonaFile: (name: string) => Promise<ConfigFileEntry | null>;
  /**
   * 保存角色文件（新增/更新合并，同名覆盖）
   *
   * @param name 配置名
   * @param content 文件完整内容（含 frontmatter）
   * @returns 操作结果（含校验错误信息）
   */
  savePersonaFile: (name: string, content: string) => Promise<ConfigFileOperationResult>;
  /**
   * 删除角色文件
   *
   * @param name 配置名
   * @returns 操作结果（文件不存在时 success=false）
   */
  deletePersonaFile: (name: string) => Promise<ConfigFileOperationResult>;
  /** 列出所有规则文件（按 mtime 降序） */
  listRules: () => Promise<ConfigFileEntry[]>;
  /** 读取规则文件内容 */
  readRule: (name: string) => Promise<ConfigFileEntry | null>;
  /** 保存规则文件（新增/更新合并） */
  saveRule: (name: string, content: string) => Promise<ConfigFileOperationResult>;
  /** 删除规则文件 */
  deleteRule: (name: string) => Promise<ConfigFileOperationResult>;
  /** 列出所有技能文件（按 mtime 降序） */
  listSkills: () => Promise<ConfigFileEntry[]>;
  /** 读取技能文件内容（携带 name，返回 ConfigFileEntry | null） */
  readSkill: (name: string) => Promise<ConfigFileEntry | null>;
  /**
   * 删除技能文件
   *
   * 注：技能新增/更新复用 installSkill 通道（已含热重载逻辑），不新增 saveSkill。
   */
  deleteSkill: (name: string) => Promise<ConfigFileOperationResult>;
  /**
   * 打开配置文件目录（personas/skills/rules 所在目录）
   *
   * 技能编辑时的辅助功能：复杂技能可跳转到文件目录手动编辑。
   */
  openConfigDir: () => Promise<{ success: boolean; error: string | null }>;
  /**
   * 监听设定文件变更广播
   *
   * 主进程在设定面板 CRUD 完成后 + personaWatcher 监听到外部编辑器修改时广播，
   * 渲染层按 type 分发刷新对应面板。
   */
  onConfigFilesChanged: (cb: (payload: ConfigFilesChangedPayload) => void) => void;
  /** 移除设定文件变更监听器 */
  removeConfigFilesChangedListener: () => void;

  // 项目（项目模式）
  /** 列出已注册项目（供专注模式选择器使用） */
  listProjects: () => Promise<{ projects: Array<{ name: string; path: string }> }>;

  // 仪表盘
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
    /** Agent 运行时指标（null 表示不可用） */
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
    /** 已加载技能列表（空数组表示无技能或不可用） */
    skills: Array<{
      name: string;
      keywords: string[];
      description: string;
      layer: string;
    }>;
  }>;
  /** 手动触发一次记忆衰减（L0 纯 score 递减，返回成功/失败） */
  triggerDecayRun: () => Promise<{ success: boolean; error?: string }>;

  // 感知数据快照（精灵感知面板打开时调用，实时推导返回）
  getPerceptionSnapshot: () => Promise<{
    affect?: AffectState;
    rapport?: RapportState;
    context?: ContextState;
    patterns?: DetectedPattern[];
    /** 主动提示统计（接受率 + 生效冷却） */
    proactiveStats?: ProactiveStats;
  } | null>;

  /** 获取启动摘要（Welcome Back Digest，迭代一） */
  getStartupSummary: () => Promise<{
    totalMemories: number;
    totalInsights: number;
    skillCount: number;
    decay: { runCount: number; totalDecayedCount: number } | null;
    perception: { warmth: number; rapportLevel: string; rapportDescription: string } | null;
    healthStatus: 'healthy' | 'warning' | 'critical' | null;
  } | null>;

  // 窗口控制
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;

  // 浮动窗口
  onFloatUnread: (cb: (count: number) => void) => void;
  /** 移除浮动窗口未读计数监听器 */
  removeFloatUnreadListener: () => void;
  /** P4-1：监听最后一条助手消息推送（浮动窗口 hover 预览） */
  onLastMessage: (cb: (text: string) => void) => void;
  /** 移除最后一条消息监听器 */
  removeLastMessageListener: () => void;
  moveFloatWindow: (dx: number, dy: number) => void;
  saveFloatPosition: () => void;
  expandToFull: () => void;
  /** 显示浮动窗口右键菜单（主进程原生 Menu） */
  showFloatContextMenu: () => void;
  /** 浮球单击 → 呼出补全弹窗（STEP-4 交互重构） */
  showQuickInputFromFloat: () => void;

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

  /** 通知主进程主题已变更（需同步到浮动窗口） */
  notifyThemeChanged: (theme: 'light' | 'dark') => void;
  /** 监听主进程广播的主题变更（浮动窗口使用） */
  onThemeBroadcast: (cb: (theme: 'light' | 'dark') => void) => void;
  /** 移除主题广播监听器 */
  removeThemeBroadcastListener: () => void;

  // ─── 配置建议（AutoConfigRefiner 闭环） ──────────
  /** 监听主进程推送的配置建议 */
  onSuggestionPush: (cb: (suggestion: ConfigSuggestionPayload) => void) => void;
  /** 移除配置建议推送监听器 */
  removeSuggestionPushListener: () => void;
  /** 接受配置建议（调用 confirmConfigSuggestion 持久化到配置文件） */
  acceptSuggestion: (suggestion: ConfigSuggestionPayload) => Promise<{ success: boolean; error?: string }>;
  /** 拒绝配置建议（仅记录日志，不持久化） */
  rejectSuggestion: (suggestion: ConfigSuggestionPayload) => Promise<{ success: boolean }>;

  // ─── 用户画像（UserProfile 闭环） ────────────────
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
  /**
   * 监听剪贴板变化通知（携带 preview + length payload）
   *
   * 主进程 ClipboardHandler 检测到哈希变化后，读取剪贴板构造 payload，
   * 渲染层 ClipboardManager 据此调用 addPendingItem 加入待处理列表。
   */
  onClipboardChanged: (cb: (payload: ClipboardChangedPayload) => void) => void;
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
  /**
   * 安装技能文件到 configDir/skills/（携带文件名和内容）
   *
   * 返回值字段说明：
   * - success：文件校验+写入是否成功（不含热重载）
   * - hotReloaded：热重载是否成功（success=true 时有效）
   *   - true：当前会话立即生效
   *   - false：热重载失败（如对话繁忙），需重启 Agent 生效，原因见 hotReloadError
   *   - undefined：无 Agent 实例，将在 Agent 就绪后自动加载
   */
  installSkill: (fileName: string, content: string) => Promise<{
    success: boolean;
    error?: string;
    skillName?: string;
    hotReloaded?: boolean;
    hotReloadError?: string;
  }>;

  // ─── 快速输入补全（Phase 1 骨架 + Phase 4 自动粘贴） ─────
  /**
   * 确认输入文本（主进程优先自动粘贴，降级写入剪贴板）
   *
   * Phase 1-3：主进程调用 clipboardHandler.suppressNextChange() 抑制三重保护，
   *   再写入剪贴板，避免触发 CLIPBOARD_CHANGED 干扰用户。
   * Phase 4：主进程优先尝试自动粘贴（恢复焦点 + 模拟 Ctrl+V），
   *   成功返回 mode='paste'；失败降级走 Phase 3 复制流程，返回 mode='copy'。
   *
   * @param text 用户确认的文本
   * @param pinnedMode 常驻模式标志：true 时主进程持久 suppressBlurClose，浮窗钉住不关闭；
   *                   false 时 default 模式，paste 期间临时抑制 blur，paste 返回后清除抑制
   * @returns success 是否成功 + mode 成功模式（paste/copy）+ appName 粘贴目标应用名
   */
  confirmQuickInput: (text: string, pinnedMode?: boolean) => Promise<{
    success: boolean;
    /** 成功模式：paste=自动粘贴成功，copy=降级到复制+Toast */
    mode: 'paste' | 'copy';
    /** 粘贴目标应用名（paste 模式下供 Toast 显示） */
    appName?: string;
  }>;
  /** 关闭快速输入浮窗（Esc / 取消按钮触发，不写入剪贴板） */
  closeQuickInput: () => Promise<void>;
  /**
   * 调整浮窗高度（候选列表显示/隐藏时触发）
   *
   * @param height 目标高度（px），主进程调用 win.setSize(width, height)
   */
  resizeQuickInput: (height: number) => Promise<void>;
  /**
   * 拖动浮窗位置（focus-bar 顶部标题栏可拖，dx/dy 增量移动）
   *
   * 使用 ipcRenderer.send 单向发送（无需返回值），主进程 setPosition 后调用 keepWindowInWorkArea。
   * 位置不持久化：每次唤起仍在光标跟随位置显示，拖动仅本次会话生效。
   *
   * @param dx X 方向增量（px，screen 坐标系）
   * @param dy Y 方向增量（px，screen 坐标系）
   */
  moveQuickInput: (dx: number, dy: number) => void;
  /**
   * LLM 润色文本（非流式，await 返回润色结果）
   *
   * 使用 ipcRenderer.invoke 请求/响应模式（与 confirmQuickInput 一致），
   * 主进程调用 agent.polish?.polish(text) 后返回 { polished, changed }。
   * 润色期间渲染进程显示 loading 状态，失败了不阻塞用户操作。
   *
   * @param text 待润色的原始文本
   * @returns 润色结果 { polished: string; changed: boolean }
   */
  polishQuickInput: (text: string) => Promise<{ polished: string; changed: boolean }>;
  /**
   * 切换常驻模式（pinned=true 持久钉住浮窗，pinned=false 恢复 default 模式）
   *
   * 主进程 setPinnedMode() 同步更新 pinnedMode 字段 + suppressBlurClose 标志。
   */
  setPinnedMode: (pinned: boolean) => Promise<{ success: boolean }>;
  /**
   * 监听浮窗 show 事件（主进程 show() 调用后触发，携带剪贴板预填文本 + 敏感标记）
   *
   * 替代 window focus 事件，避免 Alt+Tab 切回时误清空输入内容。
   * payload.clipboardText 为 null 时表示无预填（敏感内容或空剪贴板）。
   * payload.isSensitive 为 true 时表示剪贴板内容命中敏感模式，渲染进程自动进入常驻模式。
   */
  onQuickInputShow: (cb: (payload: { clipboardText: string | null; isSensitive: boolean }) => void) => void;
  /** 移除浮窗 show 事件监听器 */
  removeQuickInputShowListener: () => void;
  /**
   * 监听浮窗聚焦变化（主进程 blur/focus 事件触发）
   *
   * appName=null 表示浮窗失去焦点（用户切走），渲染进程显示"无聚焦" + 禁用 Tab
   * appName=string 表示浮窗获得焦点，渲染进程显示"聚焦：{应用名}" + 激活 Tab
   */
  onFocusChange: (cb: (appName: string | null) => void) => void;

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

  // 作品投影（WorkProjectionManager 查看）
  /** 列出所有作品投影 */
  listWorkProjections: () => Promise<WorkProjectionPayload[]>;
  /** 查看单个作品投影详情（API 已就绪，UI 暂用内联展开替代，供未来宿主集成使用） */
  showWorkProjection: (filePath: string) => Promise<WorkProjectionPayload | null>;

  // ─── 使用统计（AUDIT-5-3，默认关闭，需显式开启） ────────
  /** 导出使用统计 JSON 文件，返回文件路径。采集器未就绪时返回 null */
  usageStatsExport: () => Promise<string | null>;
  /** 清除使用统计数据（AUDIT-5-4） */
  usageStatsClear: () => Promise<void>;

  // ─── 渲染进程日志上报 ────────
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
  forceReleaseChatLock: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_FORCE_RELEASE_LOCK),
  loadSession: (query) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LOAD, query),

  // 流式监听
  // 注意：ipcRenderer.on 注册的监听器会累积，多次调用 on* 方法会导致同一事件触发多次。
  // 提供 remove* 方法供渲染进程在重新初始化或页面卸载时清理。
  onStreamStart: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START, (_: IpcRendererEvent, msg: { messageId: string; persona?: string }) => cb(msg)),
  onStreamChunk: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK, (_: IpcRendererEvent, msg: { messageId: string; text: string }) => cb(msg)),
  onStreamEnd: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, (_: IpcRendererEvent, msg: { messageId: string }) => cb(msg)),
  onStreamRecall: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_RECALL, (_: IpcRendererEvent, msg: { messageId: string; memories: Array<{ id: string; name: string; score: number; source: string }> }) => cb(msg)),
  onStreamToolStart: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_START, (_: IpcRendererEvent, msg: { messageId: string; toolCallId: string; name: string; args?: string }) => cb(msg)),
  onStreamToolResult: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_RESULT, (_: IpcRendererEvent, msg: { messageId: string; toolCallId: string; name: string; ok: boolean; summary?: string }) => cb(msg)),
  onStreamThinking: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING, (_: IpcRendererEvent, msg: { messageId: string; phase: string }) => cb(msg)),
  /** 上下文截断通知：对话中发生截断时触发，携带截断次数 */
  onContextTruncated: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_CONTEXT_TRUNCATED, (_: IpcRendererEvent, msg: { messageId: string; count: number }) => cb(msg)),
  /** 流式对话被中断监听 */
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

  // 多 Provider 管理
  listLlmProviders: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_LIST),
  saveLlmProvider: (key, config, isEditing) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_SAVE, key, config, isEditing),
  deleteLlmProvider: (key) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_DELETE, key),
  setActiveLlmProvider: (key) => ipcRenderer.invoke(IPC_CHANNELS.LLM_PROVIDER_SET_ACTIVE, key),
  saveBackgroundProvider: (key) => ipcRenderer.invoke(IPC_CHANNELS.LLM_BACKGROUND_PROVIDER_SAVE, key),

  // Agent 就绪通知
  onAgentReady: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.AGENT_READY, () => cb()),
  removeAgentReadyListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.AGENT_READY);
  },

  // 记忆
  listMemories: (query) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_LIST, query ?? {}),
  /** 列出 distinct 记忆 source（用于来源筛选 dropdown 动态生成） */
  listMemorySources: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_SOURCES),
  searchMemories: (q) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_SEARCH, q),
  showMemory: (id) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_SHOW, id),
  deleteMemory: (id) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_DELETE, id),
  // 回收站操作（restore/purge/listDeleted + 批量）
  restoreMemory: (id) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_RESTORE, id),
  purgeMemory: (id) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_PURGE, id),
  restoreAllMemories: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_RESTORE_ALL),
  purgeAllMemories: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_PURGE_ALL),
  listDeletedMemories: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_LIST_DELETED),
  addMemory: (data) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_ADD, data),
  /** 提升记忆 score（L2 采纳反哺内核，补全采纳时调用） */
  boostMemory: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_BOOST, id) as Promise<{ success: boolean }>,
  /** L1 语义去重（LLM 治理） */
  deduplicateMemories: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_DEDUP) as Promise<DedupReport>,
  /** L2 时效性评估（LLM 治理，手动触发） */
  evaluateTimeliness: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_EVALUATE_TIMELINESS) as Promise<TimelinessReport>,
  /** L3 冲突检测（LLM 治理） */
  detectConflicts: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_DETECT_CONFLICTS) as Promise<ConflictReport>,
  getRelationGraph: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_RELATION_GRAPH),
  /** 获取记忆关系路径（Phase 5.1：路径追溯，展示记忆演化脉络） */
  getRelationPath: (data: { memoryId: string; maxDepth?: number; direction?: 'incoming' | 'outgoing' | 'both' }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_RELATION_PATH, data),
  /** 获取记忆关系邻居（Phase 5.2：邻居查询，展示直接关联记忆） */
  getRelationNeighbors: (data: { memoryId: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_RELATION_NEIGHBORS, data),
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
  archiveSession: (date: string, session: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ARCHIVE_SESSION, { date, session }),
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
  /** 查询当前角色匹配模式 */
  getPersonaMode: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_MODE_GET),

  // 精灵设定面板 Epic 3：角色/规则/技能文件 CRUD（统一委托 sprite.configFileManager）
  readPersonaFile: (name) => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_READ_FILE, name),
  savePersonaFile: (name, content) => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_SAVE_FILE, name, content),
  deletePersonaFile: (name) => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_DELETE_FILE, name),
  listRules: () => ipcRenderer.invoke(IPC_CHANNELS.RULE_LIST),
  readRule: (name) => ipcRenderer.invoke(IPC_CHANNELS.RULE_READ, name),
  saveRule: (name, content) => ipcRenderer.invoke(IPC_CHANNELS.RULE_SAVE, name, content),
  deleteRule: (name) => ipcRenderer.invoke(IPC_CHANNELS.RULE_DELETE, name),
  listSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST),
  /** 读取技能文件内容（携带 name，返回 ConfigFileEntry | null） */
  readSkill: (name) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_READ, name),
  // 技能新增/更新复用 installSkill（已含热重载），此处仅暴露删除
  deleteSkill: (name) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_DELETE, name),
  /** 打开配置文件目录（personas/skills/rules 所在目录） */
  openConfigDir: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_DIR_OPEN),

  // 设定文件变更监听设定文件变更广播监听（与 onClipboardChanged 模式一致）
  onConfigFilesChanged: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.CONFIG_FILES_CHANGED, (_: IpcRendererEvent, payload: ConfigFilesChangedPayload) => cb(payload)),
  removeConfigFilesChangedListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.CONFIG_FILES_CHANGED);
  },

  // 项目
  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_LIST),

  // 列出所有会话
  listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
  // 切换到已有会话（更新 Agent 内部状态）
  switchSession: (query) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SWITCH, query),
  deleteSession: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, sessionId),
  renameSession: (sessionId, newName) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_RENAME, sessionId, newName),
  // 搜索对话内容（跨所有会话，返回匹配的消息列表）
  searchSessionMessages: (query) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SEARCH, query),
  // 会话分叉：调用内核 Agent.forkSession()，返回新会话名和消息数
  forkSession: (targetSession?: string) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_FORK, targetSession),

  // 仪表盘
  getDashboard: () => ipcRenderer.invoke(IPC_CHANNELS.DASHBOARD_GET),
  // 手动触发一次记忆衰减（L0 纯 score 递减）
  triggerDecayRun: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DECAY_RUN),
  // 感知数据快照（精灵感知面板打开时调用）
  getPerceptionSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.PERCEPTION_GET),
  // 启动摘要（Welcome Back Digest，迭代一）
  getStartupSummary: () => ipcRenderer.invoke(IPC_CHANNELS.STARTUP_SUMMARY_GET),

  // 窗口
  windowMinimize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE),
  windowMaximize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE),
  windowClose: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE),

  // 浮动窗口
  onFloatUnread: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD, (_: IpcRendererEvent, count: number) => cb(count)),
  removeFloatUnreadListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD);
  },
  // P4-1：最后一条助手消息推送（浮动窗口 hover 预览）
  onLastMessage: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.FLOAT_LAST_MESSAGE, (_: IpcRendererEvent, text: string) => cb(text)),
  removeLastMessageListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.FLOAT_LAST_MESSAGE);
  },
  moveFloatWindow: (dx, dy) => ipcRenderer.send(IPC_CHANNELS.MOVE_FLOAT_WINDOW, dx, dy),
  saveFloatPosition: () => ipcRenderer.send(IPC_CHANNELS.SAVE_FLOAT_POSITION),
  expandToFull: () => ipcRenderer.send(IPC_CHANNELS.EXPAND_TO_FULL),
  showFloatContextMenu: () => ipcRenderer.send(IPC_CHANNELS.FLOAT_CONTEXT_MENU),
  showQuickInputFromFloat: () => ipcRenderer.send(IPC_CHANNELS.SHOW_QUICK_INPUT_FROM_FLOAT),

  // 主动提示
  proactivePromptShown: () => ipcRenderer.send(IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN),
  proactiveAccept: () => ipcRenderer.send(IPC_CHANNELS.PROACTIVE_ACCEPT),
  proactiveReject: () => ipcRenderer.send(IPC_CHANNELS.PROACTIVE_REJECT),

  // 窗口状态变更（最大化按钮图标切换）
  onWindowStateChanged: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.WINDOW_STATE_CHANGED, (_: IpcRendererEvent, msg: { maximized: boolean }) => cb(msg)),
  removeWindowStateChangedListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.WINDOW_STATE_CHANGED);
  },

  // 主题变更同步（完整窗口 → 主进程 → 浮动窗口）
  notifyThemeChanged: (theme) => ipcRenderer.send(IPC_CHANNELS.THEME_CHANGED, theme),
  onThemeBroadcast: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.THEME_BROADCAST, (_: IpcRendererEvent, theme: 'light' | 'dark') => cb(theme)),
  removeThemeBroadcastListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.THEME_BROADCAST);
  },

  // 配置建议（AutoConfigRefiner 闭环）
  onSuggestionPush: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SUGGESTION_PUSH, (_: IpcRendererEvent, suggestion: ConfigSuggestionPayload) => cb(suggestion)),
  removeSuggestionPushListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SUGGESTION_PUSH);
  },
  acceptSuggestion: (suggestion) => ipcRenderer.invoke(IPC_CHANNELS.SUGGESTION_ACCEPT, suggestion),
  rejectSuggestion: (suggestion) => ipcRenderer.invoke(IPC_CHANNELS.SUGGESTION_REJECT, suggestion),

  // 用户画像（UserProfile 闭环）
  listUserProfile: () => ipcRenderer.invoke(IPC_CHANNELS.USER_PROFILE_LIST),
  confirmUserProfile: (id) => ipcRenderer.invoke(IPC_CHANNELS.USER_PROFILE_CONFIRM, id),
  rejectUserProfile: (id) => ipcRenderer.invoke(IPC_CHANNELS.USER_PROFILE_REJECT, id),

  // M1：写入确认（安全写入确认 UI）
  onWriteConfirmation: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.WRITE_CONFIRMATION, (_: IpcRendererEvent, info: WriteConfirmationPayload) => cb(info)),
  removeWriteConfirmationListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.WRITE_CONFIRMATION);
  },
  responseWriteConfirmation: (requestId, confirmed) => ipcRenderer.invoke(IPC_CHANNELS.WRITE_CONFIRMATION_RESPONSE, requestId, confirmed),

  // Phase 3.1：剪贴板三重保护（CLIPBOARD_CHANGED 携带 preview + length payload）
  onClipboardChanged: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.CLIPBOARD_CHANGED, (_: IpcRendererEvent, payload: ClipboardChangedPayload) => cb(payload)),
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
  // 快速输入补全：确认（写剪贴板+关闭）、关闭（仅关闭）、调整高度
  confirmQuickInput: (text, pinnedMode) => ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_CONFIRM, text, pinnedMode),
  closeQuickInput: () => ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_CLOSE),
  resizeQuickInput: (height) => ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_RESIZE, height),
  moveQuickInput: (dx, dy) => ipcRenderer.send(IPC_CHANNELS.MOVE_QUICK_INPUT, dx, dy),
  polishQuickInput: (text) => ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_POLISH, text),
  setPinnedMode: (pinned) => ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_SET_PINNED_MODE, pinned),
  onQuickInputShow: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_SHOW, (_: IpcRendererEvent, payload: { clipboardText: string | null; isSensitive: boolean }) => cb(payload)),
  removeQuickInputShowListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_SHOW);
  },
  onFocusChange: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.QUICK_INPUT_FOCUS_CHANGE, (_: IpcRendererEvent, appName: string | null) => cb(appName)),

  // M2：审计日志（路径白名单的审计事件持久化与查询）
  listAuditLog: (limit) => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_LOG_LIST, limit),
  clearAuditLog: () => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_LOG_CLEAR),

  // 作品投影（WorkProjectionManager 查看）
  listWorkProjections: () => ipcRenderer.invoke(IPC_CHANNELS.WORK_PROJECTION_LIST),
  showWorkProjection: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.WORK_PROJECTION_SHOW, filePath),

  // 渲染进程日志上报（fire-and-forget，日志无需等待）
  rendererLog: (level, context, message) => ipcRenderer.send(IPC_CHANNELS.RENDERER_LOG, { level, context, message }),

  // 使用统计导出（返回 JSON 文件路径，供用户手动导出）
  usageStatsExport: () => ipcRenderer.invoke(IPC_CHANNELS.USAGE_STATS_EXPORT),
  // 使用统计清除（清空所有计数器并重置 since 时间）
  usageStatsClear: () => ipcRenderer.invoke(IPC_CHANNELS.USAGE_STATS_CLEAR),
};

// 条件保护——测试环境（vitest）无 contextBridge，直接调用会抛错阻断测试
// sandbox 环境下 contextBridge 始终存在，此条件不影响生产运行
if (typeof contextBridge !== 'undefined' && contextBridge.exposeInMainWorld) {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
}
