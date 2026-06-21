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

/** IPC 监听器初始化参数 */
export interface IpcListenerCallbacks {
  /** 记忆被注意时回调（刷新仪表盘 + 脉冲动画） */
  onMemoryNoticed: () => void;
  /** 洞察获得时回调（刷新仪表盘 + 脉冲动画） */
  onInsightGained: () => void;
  /** Agent 就绪时回调（加载初始数据 + 切换到对话面板） */
  onAgentReady: () => void;
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
}
