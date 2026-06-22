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
import type { SerializedAppError } from '../ipcChannels.js';
import { reportError } from './errorHelpers.js';

/**
 * 渲染审计日志列表到 #audit-list
 *
 * 按事件类型显示不同符号，时间戳相对化（1 分钟前/今天/昨天）。
 */
async function loadAndRenderAuditLog(): Promise<void> {
  const listEl = document.getElementById('audit-list');
  const countEl = document.getElementById('audit-count');
  if (!listEl || !countEl) return;

  try {
    const entries = await window.electronAPI.listAuditLog(50);
    countEl.textContent = String(entries.length);
    if (entries.length === 0) {
      listEl.innerHTML = '<div class="profile-empty">暂无审计记录</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      const item = document.createElement('div');
      item.className = 'profile-item';
      const typeSymbol = entry.type === 'path-allow' ? '✓'
        : entry.type === 'path-deny' ? '✗'
        : entry.type === 'write-confirm' ? '⚑'
        : entry.type === 'write-auto' ? '◯'
        : entry.type === 'write-decline' ? '↩'
        : '?';
      const when = new Date(entry.timestamp);
      const timeStr = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      const meta = [
        entry.path ? `路径: ${entry.path}` : '',
        entry.tool ? `工具: ${entry.tool}` : '',
        entry.reason ? `原因: ${entry.reason}` : '',
      ].filter(Boolean).join(' · ');
      const nameEl = document.createElement('div');
      nameEl.className = 'profile-item-name';
      nameEl.textContent = `${typeSymbol} ${entry.type} · ${timeStr}`;
      const contentEl = document.createElement('div');
      contentEl.className = 'profile-item-content';
      contentEl.textContent = meta || '—';
      item.appendChild(nameEl);
      item.appendChild(contentEl);
      frag.appendChild(item);
    }
    listEl.innerHTML = '';
    listEl.appendChild(frag);
  } catch (err) {
    listEl.innerHTML = `<div class="profile-empty">加载失败: ${err instanceof Error ? err.message : String(err)}</div>`;
  }
}

/**
 * 主动提示 payload 结构
 *
 * 对齐 docs/memora-sprite-preview.html §6.6：
 * - prompt：提示文本
 * - triggers：触发原因列表
 * - silent：是否静默模式（静默时不弹窗，仅更新托盘数字）
 */
interface ProactivePromptPayload {
  prompt: string;
  triggers: string[];
  silent: boolean;
}

/**
 * P2-006 类型守卫：检查值是否为非 null 对象
 *
 * 替代 `as Record<string, unknown>` 类型断言，通过类型谓词正确收窄类型。
 * 可复用于所有需要将 unknown 安全转为对象访问的场景。
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 校验主动提示 payload 结构
 *
 * 类型守卫，确保 payload 字段类型正确，避免运行时错误。
 */
function isProactivePromptPayload(value: unknown): value is ProactivePromptPayload {
  if (!isObject(value)) return false;
  return (
    typeof value.prompt === 'string' &&
    Array.isArray(value.triggers) &&
    value.triggers.every((t) => typeof t === 'string') &&
    typeof value.silent === 'boolean'
  );
}

/**
 * 处理主动提示事件
 *
 * 对齐 docs/memora-sprite-preview.html §6.6：
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
    uiManager.switchPanel('chat');
  }
  uiManager.showProactiveBanner(msg.payload.prompt);

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
  const payload = msg.payload as { projectName: string };
  if (msg.silent) return; // 静默模式：不打扰
  uiManager.showToast(`已切换到项目：${payload.projectName}`, 'info', 3000);
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
  const payload = msg.payload as { skill: string; score: number };
  if (msg.silent) return;
  // 分数 < 0.5 的匹配不通知（避免低匹配度噪音）
  if (payload.score < 0.5) return;
  uiManager.showToast(`匹配到技能：${payload.skill}`, 'info', 2000);
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
  const payload = msg.payload as { count: number };
  if (msg.silent) return;
  if (payload.count <= 0) return; // 0 条不通知
  uiManager.showToast(`想起 ${payload.count} 条记忆`, 'info', 2000);
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
  const payload = msg.payload as { decayedCount: number };
  if (payload.decayedCount <= 0) return; // 0 条不通知

  const now = Date.now();
  if (now - lastDecayNoticeTime < DECAY_NOTICE_COOLDOWN_MS) return;
  lastDecayNoticeTime = now;

  // 衰减通知不受静默模式控制（教育用户记忆有生命周期）
  uiManager.showToast(
    `已衰减 ${payload.decayedCount} 条记忆（长期未访问自动降低权重）`,
    'info',
    4000,
  );
}
/** IPC 监听器初始化参数 */
export interface IpcListenerCallbacks {
  /** 记忆被注意时回调（刷新仪表盘 + 脉冲动画） */
  onMemoryNoticed: () => void;
  /** 洞察获得时回调（刷新仪表盘 + 脉冲动画） */
  onInsightGained: () => void;
  /** Agent 就绪时回调（加载初始数据 + 切换到对话面板） */
  onAgentReady: () => void;
  /** UX-PP-03 流式错误重试回调（重新发送上一条用户消息） */
  onSpriteErrorRetry?: () => void;
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

  // UX-P1-02 工具调用开始：在消息气泡内渲染工具调用卡片
  window.electronAPI.onStreamToolStart((msg) => {
    uiManager.showToolStart(msg.messageId, msg.name, msg.args);
  });

  // UX-P1-02 工具调用结果：更新工具调用卡片状态（成功/失败 + 摘要）
  window.electronAPI.onStreamToolResult((msg) => {
    uiManager.updateToolResult(msg.messageId, msg.name, msg.ok, msg.summary);
  });

  window.electronAPI.onStreamChunk((msg) => {
    uiManager.updateStreamingMessage(msg.messageId, msg.text);
  });

  window.electronAPI.onStreamEnd((msg) => {
    uiManager.finishStreamingMessage(msg.messageId);
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

  // ─── 精灵事件（统一监听，按 type 分发） ──────────────────
  /**
   * 精灵事件监听
   *
   * 对齐 docs/memora-sprite-preview.html：
   * - §6.3 memoryNoticed/insightGained → 仪表盘计数 +1 动画
   * - §6.6 proactivePrompt → 顶部滑入蓝粉渐变 banner（非静默模式）
   *
   * 注意：onSpriteEvent 在同一 IPC 通道上注册多次会导致同一事件触发多次。
   * 此处统一注册一个监听器，内部按 type 分发，避免重复触发。
   */
  window.electronAPI.onSpriteEvent((msg) => {
    if (msg.type === 'memoryNoticed') {
      callbacks.onMemoryNoticed();
    } else if (msg.type === 'insightGained') {
      callbacks.onInsightGained();
    } else if (msg.type === 'proactivePrompt') {
      handleProactivePrompt(uiManager, msg);
    } else if (msg.type === 'projectSwitched') {
      // L5：项目切换通知
      handleProjectSwitched(uiManager, msg);
    } else if (msg.type === 'skillMatched') {
      // L5：技能匹配通知
      handleSkillMatched(uiManager, msg);
    } else if (msg.type === 'memoryRecalled') {
      // L5：记忆召回通知
      handleMemoryRecalled(uiManager, msg);
    } else if (msg.type === 'decayCompleted') {
      // L5：衰减完成通知（24h 节流）
      handleDecayCompleted(uiManager, msg);
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
   * IX-06 统一走 toast 通知，保持错误反馈渠道一致。
   */
  window.electronAPI.onSpriteError((msg: { text: string }) => {
    // UX-PP-01 将错误注入到流式消息气泡中，让用户直接在对话中看到出错原因
    uiManager.injectErrorToStreamingMessages(msg.text);
    // UX-PP-03 提供重试按钮，让用户一键重试失败的消息
    uiManager.showToast(msg.text, 'error', undefined, {
      onRetry: callbacks.onSpriteErrorRetry,
    });
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

  // ─── M2 审计日志（刷新/清空按钮） ────────────────────────
  const auditRefreshBtn = document.getElementById('btn-audit-refresh');
  if (auditRefreshBtn) {
    auditRefreshBtn.addEventListener('click', () => {
      loadAndRenderAuditLog();
    });
  }

  const auditClearBtn = document.getElementById('btn-audit-clear');
  if (auditClearBtn) {
    auditClearBtn.addEventListener('click', async () => {
      await window.electronAPI.clearAuditLog();
      loadAndRenderAuditLog();
    });
  }
}
