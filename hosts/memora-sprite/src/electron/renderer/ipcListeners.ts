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

import type { UIManager } from './ui.js';
import type { SerializedAppError } from '../ipc/channels.js';
import { reportError } from './helpers/errorHelpers.js';

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

/**
 * P2-006 类型守卫：检查值是否为非 null 对象
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
        typeof (p as Record<string, unknown>).type === 'string' &&
        typeof (p as Record<string, unknown>).summary === 'string' &&
        typeof (p as Record<string, unknown>).confidence === 'number',
    )
  );
}

/** H3：作品投影更新载荷 */
export interface WorkProjectionUpdatedPayload {
  sourcePath: string;
  summary: string;
}

/** H3：作品投影更新载荷类型守卫 */
export function isWorkProjectionUpdatedPayload(value: unknown): value is WorkProjectionUpdatedPayload {
  return isObject(value) && typeof value.sourcePath === 'string' && typeof value.summary === 'string';
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
  // 里程碑事件使用专属庆祝样式
  uiManager.showProactiveBanner(msg.payload.prompt, msg.payload.isMilestone ?? false);

  // 通知主进程：主动提示已显示（用于清除未读计数）
  window.electronAPI.proactivePromptShown();
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
const DECAY_NOTICE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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
  uiManager.showToast(`已切换到项目：${msg.payload.projectName}`, 'info', 3000);
}

/**
 * 处理技能匹配事件
 * 静默模式：不弹 toast；非静默模式：显示"匹配到技能 X"
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
  // 分数 < 0.5 的匹配不通知（避免低匹配度噪音）
  if (msg.payload.score < 0.5) return;
  uiManager.showToast(`匹配到技能：${msg.payload.skill}`, 'info', 2000);
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
  uiManager.showToast(`想起 ${msg.payload.count} 条记忆`, 'info', 2000);
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
    4000,
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
    proactivePrompt: (msg) => handleProactivePrompt(uiManager, msg),
    projectSwitched: (msg) => handleProjectSwitched(uiManager, msg),
    skillMatched: (msg) => handleSkillMatched(uiManager, msg),
    memoryRecalled: (msg) => handleMemoryRecalled(uiManager, msg),
    decayCompleted: (msg) => handleDecayCompleted(uiManager, msg),
    // 情感基调更新 → 仪表盘四维进度条
    affectUpdated: (msg) => {
      if (!isAffectPayload(msg.payload)) {
        reportError('handleAffectUpdated', msg.payload);
        return;
      }
      callbacks.onAffectUpdated?.(msg.payload);
    },
    // Phase 3.2：在场状态变化 → 状态指示器
    presenceChanged: (msg) => {
      if (!isPresencePayload(msg.payload)) {
        reportError('handlePresenceChanged', msg.payload);
        return;
      }
      callbacks.onPresenceChanged?.(msg.payload);
    },
    // Phase 3：默契度更新 → 仪表盘展示
    rapportUpdated: (msg) => {
      if (!isRapportPayload(msg.payload)) {
        reportError('handleRapportUpdated', msg.payload);
        return;
      }
      callbacks.onRapportUpdated?.(msg.payload);
    },
    // Phase 4：对话上下文更新 → 仪表盘展示
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
    // H3：作品投影更新 → 刷新作品投影面板
    workProjectionUpdated: (msg) => {
      if (!isWorkProjectionUpdatedPayload(msg.payload)) {
        reportError('handleWorkProjectionUpdated', msg.payload);
        return;
      }
      callbacks.onWorkProjectionUpdated?.(msg.payload);
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
  /** Phase 3.2：在场状态变化时回调（更新状态指示器） */
  onPresenceChanged?: (payload: PresencePayload) => void;
  /** Phase 3：默契度更新时回调（更新仪表盘默契度卡片） */
  onRapportUpdated?: (payload: RapportPayload) => void;
  /** Phase 4：对话上下文更新时回调（更新仪表盘上下文卡片） */
  onContextUpdated?: (payload: ContextPayload) => void;
  /** H3：作品投影更新时回调（刷新作品投影面板） */
  onWorkProjectionUpdated?: (payload: WorkProjectionUpdatedPayload) => void;
  /** 用户模式更新时回调（刷新洞察面板） */
  onPatternsUpdated?: (payload: PatternsPayload) => void;
}

/** 情感基调载荷 */
export interface AffectPayload {
  warmth: number;
  playfulness: number;
  directness: number;
  initiative: number;
}

/** Phase 3.2：在场状态变化载荷 */
export interface PresencePayload {
  state: 'present' | 'away';
  timestamp: string;
  awayDurationMs?: number;
  reason: string;
}

/** Phase 3：默契度更新载荷 */
export interface RapportPayload {
  trust: number;
  familiarity: number;
  level: 'stranger' | 'acquaintance' | 'familiar' | 'close';
  description: string;
}

/** Phase 4：对话上下文更新载荷 */
export interface ContextPayload {
  rhythm: 'rapid' | 'normal' | 'slow' | 'idle';
  coherence: 'focused' | 'moderate' | 'scattered' | 'none';
  depth: 'deep' | 'moderate' | 'shallow' | 'none';
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
  }>;
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
    uiManager.startStreaming(msg.messageId);
  });

  // MS-12 召回透明度：在 text chunk 之前到达，注入召回记忆摘要到消息气泡
  window.electronAPI.onStreamRecall((msg) => {
    uiManager.setMemoryRecall(msg.messageId, msg.memories);
  });

  // UX-P2-01 思考阶段指示：在 text chunk 之前到达，显示"正在回忆.../处理.../归档..."
  window.electronAPI.onStreamThinking((msg) => {
    uiManager.showThinkingPhase(msg.messageId, msg.phase);
  });

  // OBS-02 上下文截断通知：对话中发生截断时，在消息气泡顶部显示持久提示条
  window.electronAPI.onContextTruncated((msg) => {
    uiManager.showTruncationNotice(msg.messageId, msg.count);
  });

  // UX-P1-02 工具调用开始：在消息气泡内渲染工具调用卡片
  window.electronAPI.onStreamToolStart((msg) => {
    uiManager.showToolStart(msg.messageId, msg.toolCallId, msg.name, msg.args);
  });

  // UX-P1-02 工具调用结果：更新工具调用卡片状态（成功/失败 + 摘要）
  window.electronAPI.onStreamToolResult((msg) => {
    uiManager.updateToolResult(msg.messageId, msg.toolCallId, msg.name, msg.ok, msg.summary);
  });

  window.electronAPI.onStreamChunk((msg) => {
    uiManager.updateStreamingMessage(msg.messageId, msg.text);
  });

  window.electronAPI.onStreamEnd((msg) => {
    uiManager.finishStreamingMessage(msg.messageId);
    // 对话结束后刷新仪表盘，获取最新的 LLM 指标和记忆统计
    callbacks.onConversationEnd?.();
  });

  // UX-PP-10 流式对话被中断：在原助手气泡内嵌入中断标记，保留已生成的部分内容
  // 替代旧的居中系统消息方案（体验割裂，与原气泡内容脱节）
  window.electronAPI.onStreamAborted((msg) => {
    uiManager.markStreamingAborted(msg.messageId, msg.reason);
  });

  // ─── 精灵输出（主动提示 / 系统消息） ───────────────────
  window.electronAPI.onSpriteOutput((msg) => {
    uiManager.appendMessage({
      role: 'system',
      content: msg.text,
    });

    // 通知主进程：主动提示已显示（用于清除未读计数）
    if (msg.kind === 'proactive') {
      uiManager.clearUnreadCount();
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
    // IX-06 应用级错误走 toast，不污染对话历史
    uiManager.showToast(error.message, 'error');
    reportError(error.code, error);
  });

  // ─── 精灵错误监听 ─────────────────────────────────────
  /**
   * 监听主进程推送的精灵对话级错误（ipcHandlers.ts 在对话流式输出出错时发送）。
   * 与 app-error（应用级错误）区分：sprite-error 是对话级错误。
   *
   * UX-PP-13 错误反馈去重：气泡内错误指示器 + 重试按钮为主通道（主动可见），
   * Toast 仅作辅助提示（无重试按钮，避免与气泡内重试按钮重复）。
   * 控制台日志保留用于排查。原方案同时触发气泡 + Toast（含重试）+ 控制台，
   * 重试入口冗余，用户注意力被分散。
   */
  window.electronAPI.onSpriteError((msg: { text: string }) => {
    // 主通道：将错误注入到流式消息气泡中，含重试按钮（UX-PP-01 + UX-PP-05）
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
    // IX-06 Agent 就绪是操作反馈（LLM 配置保存后触发），走 toast
    uiManager.showToast('Agent 已就绪，可以开始对话了', 'success');
    callbacks.onAgentReady();
  });

  // ─── H1 配置建议推送（AutoConfigRefiner 闭环） ─────────
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

  // ─── Phase 3.1 剪贴板三重保护 ──────────────────────────
  /**
   * 监听剪贴板变化通知（被动检测，不携带内容）
   *
   * 触发时机：ClipboardHandler 轮询检测到剪贴板哈希变化时
   * 处理方式：显示带"分析"按钮的 Toast，用户点击后触发主动分析
   */
  window.electronAPI.onClipboardChanged(() => {
    uiManager.showClipboardChangedToast();
  });

  /**
   * 监听敏感内容忽略通知
   *
   * 触发时机：用户点击"分析"后，ClipboardHandler.analyze() 检测到敏感内容
   * 处理方式：显示 warning Toast 提示用户（不展示内容）
   */
  window.electronAPI.onClipboardSensitiveIgnored((payload) => {
    uiManager.showToast(`检测到敏感内容（${payload.type}），已静默忽略`, 'warning');
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

  // ─── Phase 3.3 第二批：全局快捷键触发 ──────────────────
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
}
