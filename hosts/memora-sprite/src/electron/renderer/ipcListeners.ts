/**
 * IPC 监听器模块 — 所有渲染进程 IPC 事件监听
 *
 * 职责：
 * - 流式输出监听（onStreamStart/Chunk/End）
 * - 精灵输出监听（主动提示/系统消息）
 * - 精灵事件监听（memoryNoticed/insightGained/proactivePrompt，按 type 分发）
 * - 应用错误监听（app-error）
 * - 精灵错误监听（sprite-error）
 * - 浮动窗口未读计数同步
 * - Agent 就绪监听
 *
 * 设计原则：
 * - 接收 UIManager 实例 + 业务回调，不持有模块级状态
 * - 主动提示 payload 通过类型守卫校验，避免运行时错误
 * - 精灵事件统一注册一个监听器，内部按 type 分发，避免重复触发
 */

// STEP9-IMPORTS-01 反向 type-only 引用：编译期擦除，禁止改为 value import（否则与 ui 形成运行时循环依赖）
import type { UIManager } from './ui.js';
// SerializedAppError 真理源在 ipc/types.ts
import type { SerializedAppError } from '../ipc/types.js';
// ConfigFilesChangedPayload 真理源在 preload（与 settingsManagerPanel 共用同一类型契约）
import type { ConfigFilesChangedPayload } from '../preload.js';
import { reportError } from './helpers/errorHelpers.js';
// 补全统计埋点（B2 纵向养成指标：召回可感知时刻计数）
import { getCompletionMetrics } from './helpers/completionMetrics.js';
import { MS_PER_DAY, TOAST_SHORT_MS, TOAST_NORMAL_MS, TOAST_LONG_MS } from '../../sprite/constants.js';
// 感知数据联合类型从 sprite 层（业务真理源）导入，消除字面量重复内联
import type { RapportLevel, PresenceState, RhythmType, CoherenceLevel, DepthLevel } from '../../sprite/controllers/index.js';
// 文本截断工具（跨层共享，统一 ellipsis 为 '…'，ADR-017 枝叶层 2 次提取）
import { truncate } from '../../shared/truncate.js';
// getArchiveFailedMessage 归档失败文案真理源（UX-13：替代直传 msg.payload.message 到 Toast）
// formatErrorMessage 错误文案真理源（UX-REVIEW-M5：应用级 error toast 分类映射，避免暴露技术细节）
import { getArchiveFailedMessage, formatErrorMessage } from '../../shared/errorMessages.js';

/**
 * 主动提示 payload 结构
 *
 * 对齐设计契约 §6.6：
 * - prompt：提示文本
 * - triggers：触发原因列表
 * - silent：是否静默模式（静默时不弹窗，仅更新托盘数字）
 */
interface ProactivePromptPayload {
  prompt: string;
  triggers: string[];
  silent: boolean;
  /** 是否为里程碑事件（专属金色庆祝样式） */
  isMilestone?: boolean;
}

// ─── 感知数据 Payload 类型声明（前置，便于类型守卫引用） ─────

/** 情感基调载荷 */
export interface AffectPayload {
  warmth: number;
  playfulness: number;
  directness: number;
  initiative: number;
}

/** 在场状态变化载荷 */
export interface PresencePayload {
  state: PresenceState;
  timestamp: string;
  awayDurationMs?: number;
  reason: string;
}

/** 默契度更新载荷 */
export interface RapportPayload {
  trust: number;
  familiarity: number;
  level: RapportLevel;
  description: string;
}

/** 对话上下文更新载荷 */
export interface ContextPayload {
  rhythm: RhythmType;
  coherence: CoherenceLevel;
  depth: DepthLevel;
  dominantSource: string | null;
  description: string;
}

/** 用户模式更新载荷 */
export interface PatternsPayload {
  patterns: Array<{
    type: string;
    summary: string;
    confidence: number;
    suggestion?: string;
    /**
     * 相关记忆 ID 列表
     *
     * PatternDetector 在 detectRecurringTopics/detectKnowledgeGaps/detectInterestDrift
     * 中已填充该字段，但原 PatternsPayload 类型遗漏导致 renderer 无法消费。
     * 可选字段保证旧数据兼容（类型守卫不强制校验）。
     */
    relatedMemoryIds?: string[];
  }>;
}

/**
 * 类型守卫：检查值是否为非 null 对象
 *
 * 替代 `as Record<string, unknown>` 类型断言，通过类型谓词正确收窄类型。
 * 可复用于所有需要将 unknown 安全转为对象访问的场景。
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 校验主动提示 payload 结构
 *
 * 类型守卫，确保 payload 字段类型正确，避免运行时错误。
 */
export function isProactivePromptPayload(value: unknown): value is ProactivePromptPayload {
  if (!isObject(value)) return false;
  return (
    typeof value.prompt === 'string' &&
    Array.isArray(value.triggers) &&
    value.triggers.every((t) => typeof t === 'string') &&
    typeof value.silent === 'boolean'
  );
}

/**
 * 校验冲突检测 payload 结构
 *
 * 确保冲突通知的字段类型正确，避免运行时错误。
 */
export function isConflictDetectedPayload(value: unknown): value is {
  newMemoryId: string;
  newInsight: string;
  targetId: string;
  targetContent: string;
} {
  if (!isObject(value)) return false;
  return (
    typeof value.newMemoryId === 'string' &&
    typeof value.newInsight === 'string' &&
    typeof value.targetId === 'string' &&
    typeof value.targetContent === 'string'
  );
}

/** 校验项目切换 payload 结构（替代 as 断言，确保字段类型安全） */
export function isProjectSwitchedPayload(value: unknown): value is { projectName: string } {
  return isObject(value) && typeof value.projectName === 'string';
}

/** 校验技能匹配 payload 结构（替代 as 断言，确保字段类型安全） */
export function isSkillMatchedPayload(value: unknown): value is { skill: string; score: number } {
  return (
    isObject(value) &&
    typeof value.skill === 'string' &&
    typeof value.score === 'number'
  );
}

/** 校验记忆召回 payload 结构（替代 as 断言，确保字段类型安全） */
export function isMemoryRecalledPayload(value: unknown): value is { count: number } {
  return isObject(value) && typeof value.count === 'number';
}

/** 校验记忆衰减完成 payload 结构（替代 as 断言，确保字段类型安全） */
export function isDecayCompletedPayload(value: unknown): value is { decayedCount: number } {
  return isObject(value) && typeof value.decayedCount === 'number';
}

/** 会话分叉事件 payload 结构（from = 源会话 ID，to = 新会话 ID，messageCount = 复制消息数） */
export interface SessionForkedPayload {
  from: string;
  to: string;
  messageCount: number;
}

/** 校验会话分叉 payload 结构（确保 from/to/messageCount 字段类型安全） */
export function isSessionForkedPayload(value: unknown): value is SessionForkedPayload {
  return (
    isObject(value) &&
    typeof value.from === 'string' &&
    typeof value.to === 'string' &&
    typeof value.messageCount === 'number'
  );
}

/** 校验情感基调更新 payload 结构（替代 as 断言，确保四维字段类型安全） */
export function isAffectPayload(value: unknown): value is AffectPayload {
  return (
    isObject(value) &&
    typeof value.warmth === 'number' &&
    typeof value.playfulness === 'number' &&
    typeof value.directness === 'number' &&
    typeof value.initiative === 'number'
  );
}

/** 校验在场状态变化 payload 结构（替代 as 断言，确保字段类型安全） */
export function isPresencePayload(value: unknown): value is PresencePayload {
  return (
    isObject(value) &&
    (value.state === 'present' || value.state === 'away') &&
    typeof value.timestamp === 'string' &&
    typeof value.reason === 'string'
  );
}

/** 校验默契度更新 payload 结构（替代 as 断言，确保四字段类型安全） */
export function isRapportPayload(value: unknown): value is RapportPayload {
  return (
    isObject(value) &&
    typeof value.trust === 'number' &&
    typeof value.familiarity === 'number' &&
    (value.level === 'stranger' || value.level === 'acquaintance' || value.level === 'familiar' || value.level === 'close') &&
    typeof value.description === 'string'
  );
}

/** 校验对话上下文更新 payload 结构（替代 as 断言，确保五字段类型安全） */
export function isContextPayload(value: unknown): value is ContextPayload {
  return (
    isObject(value) &&
    (value.rhythm === 'rapid' || value.rhythm === 'normal' || value.rhythm === 'slow' || value.rhythm === 'idle') &&
    (value.coherence === 'focused' || value.coherence === 'moderate' || value.coherence === 'scattered' || value.coherence === 'none') &&
    (value.depth === 'deep' || value.depth === 'moderate' || value.depth === 'shallow' || value.depth === 'none') &&
    (value.dominantSource === null || typeof value.dominantSource === 'string') &&
    typeof value.description === 'string'
  );
}

/** 校验用户模式更新 payload 结构 */
export function isPatternsPayload(value: unknown): value is PatternsPayload {
  return (
    isObject(value) &&
    Array.isArray(value.patterns) &&
    value.patterns.every(
      (p: unknown) =>
        isObject(p) &&
        typeof p.type === 'string' &&
        typeof p.summary === 'string' &&
        typeof p.confidence === 'number',
    )
  );
}

/** 作品投影更新载荷 */
export interface WorkProjectionUpdatedPayload {
  sourcePath: string;
  summary: string;
}

/** 作品投影更新载荷类型守卫 */
export function isWorkProjectionUpdatedPayload(value: unknown): value is WorkProjectionUpdatedPayload {
  return isObject(value) && typeof value.sourcePath === 'string' && typeof value.summary === 'string';
}

/**
 * 归档失败 stage 合法枚举值
 *
 * 与内核 AgentEventMap.archiveFailed.stage / SpriteEventMap.archiveFailed.stage 保持一致。
 * 提取为常量便于类型守卫做 includes 校验，防止非法 stage 值穿透到 UI。
 */
const ARCHIVE_FAILED_STAGES = ['profile', 'insight', 'content'] as const;
/** 归档失败 stage 类型（由 ARCHIVE_FAILED_STAGES 派生） */
type ArchiveFailedStage = (typeof ARCHIVE_FAILED_STAGES)[number];

/** 归档失败事件载荷 */
export interface ArchiveFailedPayload {
  /** 失败阶段：profile（用户画像）/ insight（洞察提取）/ content（会话内容归档） */
  stage: ArchiveFailedStage;
  /** 失败原因摘要（error.message，截断 200 字符） */
  message: string;
}

/**
 * 校验归档失败 payload 结构（含 stage 枚举校验）
 *
 * 不仅校验字段类型，还校验 stage 必须是合法枚举值，
 * 防止上游误传非法 stage 字符串穿透到 UI 展示。
 */
export function isArchiveFailedPayload(value: unknown): value is ArchiveFailedPayload {
  if (!isObject(value)) return false;
  return (
    typeof value.stage === 'string' &&
    (ARCHIVE_FAILED_STAGES as readonly string[]).includes(value.stage) &&
    typeof value.message === 'string'
  );
}

/**
 * 角色切换事件载荷
 *
 * 由 spriteEventBridge.forwardSimpleEvent('personaChanged', ...) 转发，
 * 携带切换前后的角色名，用于渲染层刷新顶栏、下拉菜单 active 标记、感知面板。
 *
 * from 字段可能为 null：首次启动且 defaultPersona 触发切换时，prevName 为 null
 * （与 SpriteEventMap.personaChanged 的 from: string | null 类型对齐）
 */
export interface PersonaChangedPayload {
  /** 切换前角色名（首次启动时为 null：prevName 为 null） */
  from: string | null;
  /** 切换后角色名 */
  to: string;
}

/** 角色切换事件载荷类型守卫（from 允许 string 或 null） */
export function isPersonaChangedPayload(value: unknown): value is PersonaChangedPayload {
  if (!isObject(value)) return false;
  const from = (value as { from?: unknown }).from;
  return (typeof from === 'string' || from === null) && typeof (value as { to?: unknown }).to === 'string';
}

/**
 * 处理主动提示事件
 *
 * 对齐设计契约 §6.6：
 * - 静默模式：仅更新托盘数字，不打扰用户
 * - 非静默模式：确保对话面板可见，然后显示蓝粉渐变 banner
 *
 * @param uiManager UI 管理器实例
 * @param msg 精灵事件消息（含 type、payload、silent）
 */
function handleProactivePrompt(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  if (!isProactivePromptPayload(msg.payload)) {
    reportError('handleProactivePrompt', msg.payload);
    return;
  }

  if (msg.payload.silent) {
    // 静默模式：仅更新数字，不弹窗（由托盘在 ipcHandlers 层处理）
    return;
  }

  // 非静默模式：确保对话面板可见，然后显示 banner
  if (uiManager.getCurrentPanel() !== 'chat') {
    void uiManager.switchPanel('chat');
  }
  // 里程碑事件使用对话区内联 banner（对齐 demo v3），非里程碑保持顶部 #proactive-banner
  if (msg.payload.isMilestone) {
    uiManager.appendMilestoneBanner(msg.payload.prompt);
  } else {
    uiManager.showProactiveBanner(msg.payload.prompt, false, msg.payload.triggers);
  }

  // 通知主进程：主动提示已显示（用于清除未读计数）
  window.electronAPI.proactivePromptShown();
}

/**
 * 处理冲突检测事件
 *
 * 当 InsightExtractor 检测到 contradicts 关系时，通过 ProactiveBanner 通知用户。
 * 冲突通知是事实性通知（非主动行为），不受静默模式控制。
 *
 * 展示策略：复用 ProactiveBanner 组件，通知文本包含新洞察和矛盾目标的摘要。
 * 用户点击"查看"可切换到记忆面板查看冲突记忆详情（通过 lastConflictTargetId 暂存跳转目标）。
 */
function handleConflictDetected(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  if (!isConflictDetectedPayload(msg.payload)) {
    reportError('handleConflictDetected', msg.payload);
    return;
  }

  // 暂存冲突 targetId，供 banner onView 回调读取并跳转
  lastConflictTargetId = msg.payload.targetId;

  // 截断过长内容，避免 banner 文本溢出
  const MAX_BANNER_TEXT = 60;

  // 构造通知文本：突出"矛盾"语义，引导用户查看关系图
  const text = `检测到记忆冲突：「${truncate(msg.payload.newInsight, MAX_BANNER_TEXT)}」与已有记忆矛盾`;
  // 传入 'conflict' trigger，使 banner onView 能识别冲突场景并跳转
  uiManager.showProactiveBanner(text, false, ['conflict']);
}

/** 获取并清除最近一次冲突的 targetId（供 banner onView 回调消费后清空） */
export function consumeConflictTargetId(): string | null {
  const id = lastConflictTargetId;
  lastConflictTargetId = null;
  return id;
}

/**
 * L5：精灵事件处理器 — 4 种新增事件的 UI 展示逻辑
 *
 * 噪音控制策略（与用户约定）：
 *   - projectSwitched / skillMatched / memoryRecalled：静默模式下不弹 toast
 *   - decayCompleted：24h 节流（同一进程生命周期内），无论静默模式
 *   - 所有事件始终记入控制台（开发可见），但 UI 提示受控
 */

/** decayCompleted 上次显示时间戳（24h 节流） */
let lastDecayNoticeTime = 0;
const DECAY_NOTICE_COOLDOWN_MS = MS_PER_DAY;

/** dedupCompleted 上次显示时间戳（24h 节流，与 decayCompleted 同策略） */
let lastDedupNoticeTime = 0;

/** boostPersistFailed 上次显示时间戳（24h 节流：boost 每次召回都会触发，持久化失败会高频，长节流防刷屏） */
let lastBoostPersistFailedNotice = 0;

/** configReloaded 上次显示时间戳（5min 节流：仅在对话结束后补执行暂存的 reload 时触发，低频但留适度节流防边缘） */
const CONFIG_RELOAD_COOLDOWN_MS = 5 * 60 * 1000;
let lastConfigReloadNoticeTime = 0;

/** guardrailError 上次显示时间戳（5min 节流：每次输入/输出都会跑护栏规则，正则破则高频，短节流防刷屏） */
const GUARDRAIL_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
let lastGuardrailErrorNoticeTime = 0;

/** 最近一次冲突检测的 targetId（供 banner onView 跳转使用，与 lastDecayNoticeTime 同模式） */
let lastConflictTargetId: string | null = null;

/**
 * 处理项目切换事件
 * 静默模式：不弹 toast；非静默模式：显示"已切换到 XXX 项目"通知
 */
function handleProjectSwitched(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  // payload: { from: string | null; to: string; projectName: string }
  if (!isProjectSwitchedPayload(msg.payload)) {
    reportError('handleProjectSwitched', msg.payload);
    return;
  }
  if (msg.silent) return; // 静默模式：不打扰
  uiManager.showToast(`已切换到项目：${msg.payload.projectName}`, 'info', TOAST_NORMAL_MS);
}

/**
 * 处理技能匹配事件
 * 静默模式：不弹 toast；非静默模式：显示"匹配到技能 X"
 *
 * 阈值真理源：不在此处二次过滤分数——内核 SkillManager.match() 已用
 * SKILL_MATCH_MIN_SCORE (0.3) 过滤低匹配度技能，凡到达此处的 skillMatched
 * 事件 score 均 ≥ 0.3（trigger 命中则 = 1.0）。二次过滤会造成"激活但不提示"
 * 的静默激活误导。
 */
function handleSkillMatched(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  // payload: { skill: string; score: number }
  if (!isSkillMatchedPayload(msg.payload)) {
    reportError('handleSkillMatched', msg.payload);
    return;
  }
  if (msg.silent) return;
  uiManager.showToast(`匹配到技能：${msg.payload.skill}`, 'info', TOAST_SHORT_MS);
}

/**
 * 处理记忆召回事件
 * 静默模式：不弹 toast；非静默模式：显示"想起 X 条记忆"
 * 注意：每次对话都会触发，单条消息中只显示一次（外部去重由 onStreamRecall 处理）
 */
function handleMemoryRecalled(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  // payload: { count: number; query: string }
  if (!isMemoryRecalledPayload(msg.payload)) {
    reportError('handleMemoryRecalled', msg.payload);
    return;
  }
  if (msg.silent) return;
  if (msg.payload.count <= 0) return; // 0 条不通知
  uiManager.showToast(`想起 ${msg.payload.count} 条记忆`, 'info', TOAST_SHORT_MS);
}

/**
 * 处理记忆衰减完成事件
 * 24h 节流：同一进程生命周期内只显示一次
 * 静默模式与非静默模式都遵守节流（衰减是后台事件，与用户操作解耦）
 */
function handleDecayCompleted(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  // payload: { decayedCount: number }
  if (!isDecayCompletedPayload(msg.payload)) {
    reportError('handleDecayCompleted', msg.payload);
    return;
  }
  if (msg.payload.decayedCount <= 0) return; // 0 条不通知

  const now = Date.now();
  if (now - lastDecayNoticeTime < DECAY_NOTICE_COOLDOWN_MS) return;
  lastDecayNoticeTime = now;

  // 衰减通知不受静默模式控制（教育用户记忆有生命周期）
  uiManager.showToast(
    `已衰减 ${msg.payload.decayedCount} 条记忆（长期未访问自动降低权重）`,
    'info',
    TOAST_LONG_MS,
  );
}

/**
 * 处理回收站自动清理完成事件
 * 静默模式下不显示通知（清理是后台行为，与用户操作解耦）
 */
function handleTrashPurged(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  if (!isTrashPurgedPayload(msg.payload)) {
    reportError('handleTrashPurged', msg.payload);
    return;
  }
  if (msg.silent) return;
  if (msg.payload.purgedCount <= 0) return;
  uiManager.showToast(
    `已自动清理 ${msg.payload.purgedCount} 条过期记忆`,
    'info',
    TOAST_SHORT_MS,
  );
}

/** 类型守卫：回收站清理完成事件载荷 */
function isTrashPurgedPayload(
  payload: unknown,
): payload is { purgedCount: number } {
  return isObject(payload) && typeof payload.purgedCount === 'number';
}

/**
 * 归档失败节流状态（按 stage 独立节流）
 *
 * profile / insight / content 三条归档通路独立计时，避免一条失败时另一条的提示被压制。
 * 节流窗口 5 分钟：归档失败是后台事件，短时间内可能连续触发（如 LLM 服务异常），
 * 过短窗口会刷屏，过长窗口会让用户错过重要记忆丢失信号。
 */
const ARCHIVE_FAILED_COOLDOWN_MS = 5 * 60 * 1000;
const lastArchiveFailedTime: Record<ArchiveFailedStage, number> = {
  profile: 0,
  insight: 0,
  content: 0,
};

/**
 * 处理归档失败事件
 *
 * fire-and-forget 归档在 catch 分支发射此事件，提示用户记忆可能丢失。
 * 不受 silent 控制：归档失败是用户应感知的重要信号（记忆未持久化），
 * 与 decayCompleted 同样属于"教育用户记忆有生命周期"的语义。
 *
 * 节流策略：按 stage 独立 5 分钟节流，避免 LLM 服务异常时连续刷屏。
 */
function handleArchiveFailed(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  if (!isArchiveFailedPayload(msg.payload)) {
    reportError('handleArchiveFailed', msg.payload);
    return;
  }
  const now = Date.now();
  if (now - lastArchiveFailedTime[msg.payload.stage] < ARCHIVE_FAILED_COOLDOWN_MS) return;
  lastArchiveFailedTime[msg.payload.stage] = now;

  // stage → 用户可理解文案由 shared/errorMessages.getArchiveFailedMessage 提供
  // UX-13：不再直传 msg.payload.message 到 Toast（避免内核错误细节泄露）
  const friendlyMessage = getArchiveFailedMessage(msg.payload.stage);
  uiManager.showToast(
    friendlyMessage,
    'warning',
    TOAST_LONG_MS,
  );
}

/**
 * 处理语义去重完成事件
 *
 * 内核 DedupManager 自动/手动去重后发射，提示用户相似记忆已被整理（降低重复记忆权重）。
 * 复用 decayCompleted 的 24h 节流策略（后台事件，与用户操作解耦），且 0 条不通知。
 * 不受 silent 控制：整理动作是用户应感知的"记忆被重新组织"信号。
 */
function handleDedupCompleted(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  // payload: { deduplicatedCount: number; demotedIds: string[] }
  if (!isDedupCompletedPayload(msg.payload)) {
    reportError('handleDedupCompleted', msg.payload);
    return;
  }
  if (msg.payload.deduplicatedCount <= 0) return; // 0 条不通知

  const now = Date.now();
  if (now - lastDedupNoticeTime < DECAY_NOTICE_COOLDOWN_MS) return;
  lastDedupNoticeTime = now;

  uiManager.showToast(
    `已自动整理 ${msg.payload.deduplicatedCount} 条相似记忆（降低重复记忆权重）`,
    'info',
    TOAST_LONG_MS,
  );
}

/**
 * 处理记忆权重持久化失败事件
 *
 * boost 在每次召回时 fire-and-forget 持久化记忆权重，失败时内核发射此事件。
 * 不受 silent 控制：权重丢失是应感知的重要信号（记忆优先级可能偏低）。
 * 但 boost 每次召回都触发，持久化失败时若直接弹窗会刷屏——用 24h 长节流，
 * 仅首次暴露问题。遵循 UX-13：不直传内核错误细节，仅给可理解的提示。
 */
function handleBoostPersistFailed(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  // payload: { memoryId: string; message: string }
  if (!isBoostPersistFailedPayload(msg.payload)) {
    reportError('handleBoostPersistFailed', msg.payload);
    return;
  }
  const now = Date.now();
  if (now - lastBoostPersistFailedNotice < DECAY_NOTICE_COOLDOWN_MS) return;
  lastBoostPersistFailedNotice = now;

  uiManager.showToast(
    '部分记忆的重要性权重未能保存，下次对话时这些记忆的优先级可能偏低',
    'warning',
    TOAST_LONG_MS,
  );
}

/** 配置热重载完成通知（5min 节流） */
function handleConfigReloaded(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  if (!isConfigReloadedPayload(msg.payload)) {
    reportError('handleConfigReloaded', msg.payload);
    return;
  }
  const now = Date.now();
  if (now - lastConfigReloadNoticeTime < CONFIG_RELOAD_COOLDOWN_MS) return;
  lastConfigReloadNoticeTime = now;

  uiManager.showToast(
    '配置已自动更新',
    'info',
    TOAST_SHORT_MS,
  );
}

/** 护栏规则正则编译失败通知（5min 节流） */
function handleGuardrailError(
  uiManager: UIManager,
  msg: { type: string; payload: unknown; silent: boolean },
): void {
  if (!isGuardrailErrorPayload(msg.payload)) {
    reportError('handleGuardrailError', msg.payload);
    return;
  }
  const p = msg.payload;
  const now = Date.now();
  if (now - lastGuardrailErrorNoticeTime < GUARDRAIL_ERROR_COOLDOWN_MS) return;
  lastGuardrailErrorNoticeTime = now;

  uiManager.showToast(
    `护栏规则「${p.rule}」的正则表达式无效，该规则暂时未生效`,
    'warning',
    TOAST_LONG_MS,
  );
}

/** 类型守卫：配置热重载完成事件载荷 */
function isConfigReloadedPayload(
  payload: unknown,
): payload is { source: string } {
  return (
    isObject(payload) &&
    typeof payload.source === 'string'
  );
}

/** 类型守卫：护栏规则正则编译失败事件载荷 */
function isGuardrailErrorPayload(
  payload: unknown,
): payload is { rule: string; message: string } {
  return (
    isObject(payload) &&
    typeof payload.rule === 'string' &&
    typeof payload.message === 'string'
  );
}

/** 类型守卫：语义去重完成事件载荷 */
function isDedupCompletedPayload(
  payload: unknown,
): payload is { deduplicatedCount: number; demotedIds: string[] } {
  return (
    isObject(payload) &&
    typeof payload.deduplicatedCount === 'number' &&
    Array.isArray(payload.demotedIds)
  );
}

/** 类型守卫：记忆权重持久化失败事件载荷 */
function isBoostPersistFailedPayload(
  payload: unknown,
): payload is { memoryId: string; message: string } {
  return (
    isObject(payload) &&
    typeof payload.memoryId === 'string' &&
    typeof payload.message === 'string'
  );
}
/**
 * U4 精灵事件处理器映射表
 *
 * 替代 if-else 链，新增事件类型只需在表中加一行映射。
 * key: msg.type，value: 处理函数
 */
function createSpriteEventHandlers(
  uiManager: UIManager,
  callbacks: IpcListenerCallbacks,
): Record<string, (msg: { type: string; payload: unknown; silent: boolean }) => void> {
  return {
    memoryNoticed: () => callbacks.onMemoryNoticed(),
    insightGained: () => callbacks.onInsightGained(),
    // 冲突检测 → ProactiveBanner 通知用户
    conflictDetected: (msg) => handleConflictDetected(uiManager, msg),
    proactivePrompt: (msg) => handleProactivePrompt(uiManager, msg),
    projectSwitched: (msg) => handleProjectSwitched(uiManager, msg),
    skillMatched: (msg) => handleSkillMatched(uiManager, msg),
    memoryRecalled: (msg) => handleMemoryRecalled(uiManager, msg),
    decayCompleted: (msg) => handleDecayCompleted(uiManager, msg),
    trashPurged: (msg) => handleTrashPurged(uiManager, msg),
    // 归档失败 → warning toast 通知用户记忆可能丢失（按 stage 节流）
    archiveFailed: (msg) => handleArchiveFailed(uiManager, msg),
    // 语义去重完成 → 提示用户记忆被整理（24h 节流）
    dedupCompleted: (msg) => handleDedupCompleted(uiManager, msg),
    // 记忆权重持久化失败 → warning toast（24h 节流，不泄露内核错误细节）
    boostPersistFailed: (msg) => handleBoostPersistFailed(uiManager, msg),
    configReloaded: (msg) => handleConfigReloaded(uiManager, msg),
    guardrailError: (msg) => handleGuardrailError(uiManager, msg),
    // 会话分叉完成 → 切换到新会话（由 renderer.ts 注册的 onSessionForked 回调处理）
    sessionForked: (msg) => {
      if (!isSessionForkedPayload(msg.payload)) {
        reportError('handleSessionForked', msg.payload);
        return;
      }
      callbacks.onSessionForked?.(msg.payload);
    },
    // 情感基调更新 → 仪表盘四维进度条
    affectUpdated: (msg) => {
      if (!isAffectPayload(msg.payload)) {
        reportError('handleAffectUpdated', msg.payload);
        return;
      }
      callbacks.onAffectUpdated?.(msg.payload);
    },
    // 在场状态变化 → 状态指示器
    presenceChanged: (msg) => {
      if (!isPresencePayload(msg.payload)) {
        reportError('handlePresenceChanged', msg.payload);
        return;
      }
      callbacks.onPresenceChanged?.(msg.payload);
    },
    // 默契度更新 → 仪表盘展示
    rapportUpdated: (msg) => {
      if (!isRapportPayload(msg.payload)) {
        reportError('handleRapportUpdated', msg.payload);
        return;
      }
      callbacks.onRapportUpdated?.(msg.payload);
    },
    // 对话上下文更新 → 仪表盘展示
    contextUpdated: (msg) => {
      if (!isContextPayload(msg.payload)) {
        reportError('handleContextUpdated', msg.payload);
        return;
      }
      callbacks.onContextUpdated?.(msg.payload);
    },
    // 用户模式更新 → 洞察面板展示
    patternsUpdated: (msg) => {
      if (!isPatternsPayload(msg.payload)) {
        reportError('handlePatternsUpdated', msg.payload);
        return;
      }
      callbacks.onPatternsUpdated?.(msg.payload);
    },
    // 作品投影更新 → 刷新作品投影面板
    workProjectionUpdated: (msg) => {
      if (!isWorkProjectionUpdatedPayload(msg.payload)) {
        reportError('handleWorkProjectionUpdated', msg.payload);
        return;
      }
      callbacks.onWorkProjectionUpdated?.(msg.payload);
    },
    // 角色切换 → 顶栏 + 下拉菜单 active + 感知面板刷新
    // auto 模式自动匹配与手动切换都走同一事件链路（统一由 Agent.switchPersona 发射）
    personaChanged: (msg) => {
      if (!isPersonaChangedPayload(msg.payload)) {
        reportError('handlePersonaChanged', msg.payload);
        return;
      }
      callbacks.onPersonaChanged?.(msg.payload);
    },
  };
}
export interface IpcListenerCallbacks {
  /** 记忆被注意时回调（刷新仪表盘 + 脉冲动画） */
  onMemoryNoticed: () => void;
  /** 洞察获得时回调（刷新仪表盘 + 脉冲动画） */
  onInsightGained: () => void;
  /** Agent 就绪时回调（加载初始数据 + 切换到对话面板） */
  onAgentReady: () => void;
  /** 对话结束时回调（刷新仪表盘，获取最新 LLM 指标和记忆数据） */
  onConversationEnd?: () => void;
  /** 情感基调更新时回调（更新仪表盘四维进度条） */
  onAffectUpdated?: (payload: AffectPayload) => void;
  /** 在场状态变化时回调（更新状态指示器） */
  onPresenceChanged?: (payload: PresencePayload) => void;
  /** 默契度更新时回调（更新仪表盘默契度卡片） */
  onRapportUpdated?: (payload: RapportPayload) => void;
  /** 对话上下文更新时回调（更新仪表盘上下文卡片） */
  onContextUpdated?: (payload: ContextPayload) => void;
  /** 作品投影更新时回调（刷新作品投影面板） */
  onWorkProjectionUpdated?: (payload: WorkProjectionUpdatedPayload) => void;
  /** 用户模式更新时回调（刷新洞察面板） */
  onPatternsUpdated?: (payload: PatternsPayload) => void;
  /** 会话分叉完成时回调（切换到新会话，payload.to 为完整的新会话 ID） */
  onSessionForked?: (payload: SessionForkedPayload) => void;
  /**
   * 角色切换完成时回调（auto 自动匹配 / 手动切换统一入口）
   *
   * 触发链路：
   * - 手动：UI 点击 → Agent.switchPersona → emit('personaSwitched')
   * - auto：postProcessInner → personaMatcher.autoMatch → PersonaManager.switchPersona
   *
   * 渲染层职责：刷新顶栏角色名 + 下拉菜单 active 标记 + 感知面板（如打开）
   */
  onPersonaChanged?: (payload: PersonaChangedPayload) => void;
  /**
   * 设定文件变更回调（精灵设定面板 Epic 3 · I4）
   *
   * 触发链路：
   * - 内部：精灵设定面板 CRUD（saveConfigFile/deleteSkill 等）→ 主进程写盘 → ConfigFileWatcher 检测
   * - 外部：用户在文件系统中手动编辑 configDir/{personas,rules,skills}/ 下文件
   *
   * 渲染层职责：按 payload.type 分发到 settingsManagerPanel.handleConfigFilesChanged 刷新对应列表
   */
  onConfigFilesChanged?: (payload: ConfigFilesChangedPayload) => void;
  /**
   * 会话状态变更回调（不中断工作模型）
   *
   * 暂停/恢复/异常时触发，渲染层更新 UI 状态（暂停按钮禁用态 + 消息区状态横幅）。
   *
   * @param status 会话状态：'running' | 'paused' | 'error'
   * @param reason 状态变更原因（可选）
   * @param source 暂停来源（仅 paused 态有效，'user' | 'agent' | 'system'）
   */
  onSessionStatusChanged?: (status: string, reason?: string, resumable?: boolean, source?: string) => void;
  /**
   * 澄清问题推送回调（P4 暂停询问）
   *
   * Agent 在 P1-P3 补全链无法填充槽位时，通过 SESSION_NEED_CLARIFY 通道
   * 推送澄清问题到渲染进程。渲染层展示澄清面板，用户回答后恢复会话。
   *
   * @param questions 澄清问题数组（携带 slot/question/options）
   */
  onNeedClarify?: (questions: Array<{ slot: string; question: string; options?: string[] }>) => void;
}

/**
 * 初始化所有 IPC 监听器
 *
 * 统一注册所有渲染进程 IPC 监听器，避免分散注册导致遗漏清理。
 * 页面卸载时通过 window.electronAPI.remove*Listeners() 统一清理。
 *
 * @param uiManager UI 管理器实例
 * @param callbacks 业务回调（精灵事件分发、Agent 就绪处理）
 */
export function initIpcListeners(uiManager: UIManager, callbacks: IpcListenerCallbacks): void {
  // ─── 流式输出 ──────────────────────────────────────────
  window.electronAPI.onStreamStart((msg) => {
    // 透传 persona 到 startStreaming：本轮 LLM 调用使用的角色名，用于消息底部显示
    uiManager.startStreaming(msg.messageId, msg.persona);
  });

  // 召回透明度：在 text chunk 之前到达，注入召回记忆摘要到消息气泡
  window.electronAPI.onStreamRecall((msg) => {
    uiManager.setMemoryRecall(msg.messageId, msg.memories);
    // B2 纵向度量埋点：记录召回可感知时刻（精灵向用户展示"想起 N 条记忆"的次数）
    // 仅在 memories 非空时计数（空召回不构成"可感知时刻"，memories 类型为非可选数组）
    if (msg.memories.length > 0) {
      getCompletionMetrics().recordRecallMoment(msg.memories.length);
    }
  });

  // 思考阶段指示：在 text chunk 之前到达，显示"正在回忆…/处理…/归档…"
  window.electronAPI.onStreamThinking((msg) => {
    uiManager.showThinkingPhase(msg.messageId, msg.phase);
  });

  // 上下文截断通知：对话中发生截断时，在消息气泡顶部显示持久提示条
  window.electronAPI.onContextTruncated((msg) => {
    uiManager.showTruncationNotice(msg.messageId, msg.count);
  });

  // 工具调用开始：在消息气泡内渲染工具调用卡片
  window.electronAPI.onStreamToolStart((msg) => {
    uiManager.showToolStart(msg.messageId, msg.toolCallId, msg.name, msg.args);
  });

  // 工具调用结果：更新工具调用卡片状态（成功/失败 + 摘要）
  window.electronAPI.onStreamToolResult((msg) => {
    uiManager.updateToolResult(msg.messageId, msg.toolCallId, msg.name, msg.ok, msg.summary);
    // 长任务闭环：task_table_write/update 工具执行后 plan 已变更，
    // 内核无独立的 plan 更新事件，在工具执行完成点按工具名前缀精准刷新任务清单面板。
    if (msg.name?.startsWith('task_table')) {
      uiManager.chatCoordinator.taskTablePanelManager?.loadData();
    }
  });

  window.electronAPI.onStreamChunk((msg) => {
    uiManager.updateStreamingMessage(msg.messageId, msg.text);
  });

  window.electronAPI.onStreamEnd((msg) => {
    uiManager.finishStreamingMessage(msg.messageId);
    // P1-5: 流式结束后自动消费草稿（RUNNING 态待定输入 → 新一轮用户输入）
    uiManager.consumePendingDrafts();
    // 对话结束后刷新仪表盘，获取最新的 LLM 指标和记忆统计
    callbacks.onConversationEnd?.();
  });

  // 任务表已生成（task_table_write 成功）→ 刷新任务表面板展示新任务表
  // （用户定案 2026-08-10：任务表生成即生效，无接受/丢弃确认）
  window.electronAPI.onTaskTableGenerated((_msg) => {
    uiManager.chatCoordinator.taskTablePanelManager?.loadData();
  });

  // 流式对话被中断：在原助手气泡内嵌入中断标记，保留已生成的部分内容
  window.electronAPI.onStreamAborted((msg) => {
    uiManager.markStreamingAborted(msg.messageId, msg.reason);
  });

  // ─── 精灵输出（主动提示 / 系统消息） ───────────────────
  window.electronAPI.onSpriteOutput((msg) => {
    uiManager.appendMessage({
      role: 'system',
      content: msg.text,
    });

    // 通知主进程：主动提示已显示（用于托盘 active → idle 状态复位）
    // 注意：此处不调用 clearUnreadCount()——未读计数清零统一由 onExpandToFull →
    // resetUnreadCount 处理（用户展开完整窗口时才认为"已读"）。
    // 若在此处清零会误清 spriteEventBridge 在完整窗口不可见时累积的未读计数
    // （proactivePrompt 触发时若完整窗口不可见，主进程会 incrementUnreadCount）。
    if (msg.kind === 'proactive') {
      window.electronAPI.proactivePromptShown();
    }
  });

  // ─── 精灵事件（统一监听，映射表分发） ──────────────────
  /**
   * 精灵事件监听
   *
   * 对齐 ：
   * - §6.3 memoryNoticed/insightGained → 仪表盘计数 +1 动画
   * - §6.6 proactivePrompt → 顶部滑入蓝粉渐变 banner（非静默模式）
   *
   * 注意：onSpriteEvent 在同一 IPC 通道上注册多次会导致同一事件触发多次。
   * 此处统一注册一个监听器，内部按映射表分发，避免重复触发。
   */
  const spriteHandlers = createSpriteEventHandlers(uiManager, callbacks);
  window.electronAPI.onSpriteEvent((msg) => {
    const handler = spriteHandlers[msg.type];
    if (handler) {
      handler(msg);
    }
  });

  // ─── 应用错误处理 ─────────────────────────────────────
  window.electronAPI.onAppError((error: SerializedAppError) => {
    // 应用级错误走 toast，不污染对话历史
    // UX-13：分类映射为用户友好中文文案，避免暴露 IPC 错误码/堆栈等技术细节
    uiManager.showToast(formatErrorMessage('应用操作', error), 'error');
    reportError(error.code, error);
  });

  // ─── 精灵错误监听 ─────────────────────────────────────
  /**
   * 监听主进程推送的精灵对话级错误（ipcHandlers.ts 在对话流式输出出错时发送）。
   * 与 app-error（应用级错误）区分：sprite-error 是对话级错误。
   *
   * 错误反馈去重：气泡内错误指示器 + 重试按钮为主通道（主动可见），
   * Toast 仅作辅助提示（无重试按钮，避免与气泡内重试按钮重复）。
   * 控制台日志保留用于排查。
   */
  window.electronAPI.onSpriteError((msg: { text: string }) => {
    // 主通道：将错误注入到流式消息气泡中，含重试按钮
    uiManager.injectErrorToStreamingMessages(msg.text);
    // 辅助通道：Toast 仅作短暂提示，不携带重试按钮（避免与气泡内重试按钮重复）
    uiManager.showToast(msg.text, 'error');
    reportError('sprite-error', msg.text);
  });

  // ─── 浮动窗口未读计数 ─────────────────────────────────
  /**
   * 主进程在浮动窗口收到新消息时推送 count 到完整窗口。
   * 完整窗口的徽章由 UIManager 内部维护（appendMessage 时累加），
   * 此处仅同步主进程的权威计数，避免双窗口计数不一致。
   */
  window.electronAPI.onFloatUnread((count: number) => {
    uiManager.setUnreadCount(count);
  });

  // ─── Agent 就绪监听 ───────────────────────────────────
  /** 监听主进程 Agent 就绪通知（LLM 配置保存成功后触发） */
  window.electronAPI.onAgentReady(() => {
    // Agent 就绪是操作反馈（LLM 配置保存后触发），走 toast
    uiManager.showToast('精灵已就绪，可以开始对话了', 'success');
    callbacks.onAgentReady();
  });

  // ─── 配置建议推送（AutoConfigRefiner 闭环） ─────────
  /**
   * 监听主进程推送的配置建议（来自 AutoConfigRefiner.onConfigSuggestion 回调）
   *
   * 触发时机：用户对话中产生可提取的配置建议时，主进程通过 SUGGESTION_PUSH 通道推送
   * 处理方式：调用 uiManager.showSuggestion 显示卡片，用户可接受/拒绝
   * 卡片位置：#proactive-banner 之后、#messages 之前（顶部提示区）
   */
  window.electronAPI.onSuggestionPush((suggestion) => {
    uiManager.showSuggestion(suggestion);
  });

  // ─── M1 写入确认（SecurityGuard 写入二次确认） ──────────
  /**
   * 监听主进程推送的写入确认请求（来自 SecurityGuard.onWriteConfirmation 回调）
   *
   * 触发时机：Agent 工具尝试写入文件且需要用户确认时
   * 处理方式：调用 uiManager.showWriteConfirmation 显示确认弹窗，
   *           用户确认/拒绝后自动通过 responseWriteConfirmation 传回主进程
   */
  window.electronAPI.onWriteConfirmation((info) => {
    uiManager.showWriteConfirmation(info);
  });

  // ─── 剪贴板三重保护（被动等待 + 保护性主动） ───
  /**
   * 监听剪贴板变化通知（携带 preview + length payload）
   *
   * 触发时机：ClipboardHandler 轮询检测到剪贴板哈希变化时
   * 处理方式：加入待处理列表 + 角标 +1（不打断用户，被动等待用户查看）
   */
  window.electronAPI.onClipboardChanged((payload) => {
    uiManager.clipboardManager.addPendingItem(payload.preview, payload.length, payload.content);
  });

  /**
   * 监听敏感内容忽略通知（保护性主动提醒）
   *
   * 触发时机：用户主动分析后，ClipboardHandler.analyze() 检测到敏感内容
   * 处理方式：显示 warning Toast 5s 自动消失（敏感内容保护性主动，不进入待处理列表）
   */
  window.electronAPI.onClipboardSensitiveIgnored((payload) => {
    uiManager.clipboardManager.showSensitiveWarning(payload.type);
  });

  /**
   * 监听分析就绪通知（内容已通过敏感检测和护栏）
   *
   * 触发时机：ClipboardHandler.analyze() 通过所有检测后
   * 处理方式：显示确认对话框，用户确认后写入记忆
   */
  window.electronAPI.onClipboardAnalysisReady((payload) => {
    uiManager.showClipboardConfirmDialog(payload.content);
  });

  /**
   * 监听分析被拦截通知（输入护栏拦截）
   *
   * 触发时机：ClipboardHandler.analyze() 中 inputGuard 拦截内容
   * 处理方式：显示 warning Toast 提示拦截原因
   */
  window.electronAPI.onClipboardAnalysisRejected((payload) => {
    uiManager.showToast(`剪贴板内容被拦截：${payload.reason}`, 'warning');
  });

  // ─── 全局快捷键触发 ──────────────────
  /**
   * 监听 quick-record 触发
   *
   * 触发时机：用户按下 Ctrl+Shift+M 全局快捷键
   * 处理方式：聚焦聊天输入框，进入快速记录模式
   */
  window.electronAPI.onQuickRecordTrigger(() => {
    uiManager.handleQuickRecordTrigger();
  });

  /**
   * 监听 recall-memory 触发
   *
   * 触发时机：用户按下 Ctrl+Shift+R 全局快捷键
   * 处理方式：切换到记忆面板并聚焦搜索框
   */
  window.electronAPI.onRecallMemoryTrigger(() => {
    uiManager.handleRecallMemoryTrigger();
  });

  // ─── 设定文件变更广播（精灵设定面板 Epic 3 · I4） ───────
  /**
   * 监听 configDir/{personas,rules,skills}/ 下文件变更（外部编辑器或本面板 CRUD 触发）
   *
   * 触发链路：
   * - 内部：本面板 saveConfigFile/deleteSkill → 主进程 ConfigFileManager 写盘 → ConfigFileWatcher
   * - 外部：用户在文件系统直接编辑设定文件
   *
   * 处理方式：按 payload.type 分发到 settingsManagerPanel.handleConfigFilesChanged，
   * 由其根据当前激活的 tab 决定是否刷新列表（避免在不可见面板上做无意义的 IPC 调用）
   */
  window.electronAPI.onConfigFilesChanged((payload) => {
    callbacks.onConfigFilesChanged?.(payload);
  });

  // ─── 会话状态变更（不中断工作模型） ──────────────────
  /**
   * 监听会话状态变更（暂停/恢复/异常时触发）
   *
   * 触发链路：主进程 Agent 状态机状态变化 → SESSION_STATUS_CHANGED IPC 推送
   * 处理方式：调用 callbacks.onSessionStatusChanged 更新 UI 状态
   * （暂停按钮禁用态 + 消息区状态横幅）
   */
  window.electronAPI.onSessionStatusChanged((payload) => {
    callbacks.onSessionStatusChanged?.(payload.status, payload.reason, payload.resumable, payload.source);
  });

  // ─── 澄清问题推送（P4 暂停询问） ──────────────────
  /**
   * 监听澄清问题推送（P4 暂停询问）
   *
   * 触发链路：Agent 检测到 P1-P3 补全链无法填充槽位 →
   * needClarify 事件 → SESSION_NEED_CLARIFY IPC 推送
   * 处理方式：调用 callbacks.onNeedClarify 展示澄清面板
   */
  window.electronAPI.onNeedClarify((questions) => {
    callbacks.onNeedClarify?.(questions);
  });

  // ─── 澄清暂停超时自动续跑提示（Finding A） ───────────────
  /**
   * 监听澄清超时自动续跑通知
   *
   * 触发链路：needClarify 计时器超时（用户长时间未响应）→
   * CLARIFY_AUTO_RESOLVED IPC 推送
   * 处理方式：在对话区插入一条系统消息，告知用户已自动继续（择优决策并收敛本轮），
   * 与澄清面板被 SESSION_STATUS_CHANGED(running) 自动收起形成闭环。
   */
  window.electronAPI.onClarifyAutoResolved(() => {
    uiManager.appendMessage({
      role: 'system',
      content: '⏱️ 暂停询问超时未响应，已自动继续：Agent 将基于现有信息择优决策，并收敛本轮回答。',
    });
  });
}
