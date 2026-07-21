/**
 * 对话流式输出处理器
 *
 * 职责：
 *   消费 agent.chat() AsyncGenerator，将流式 chunk 通过 IPC 推送到渲染进程。
 *   包含无进展超时兜底、中断处理、错误降级等完整流式输出逻辑。
 *
 * 与 chatHandlers.ts 的关系：chatHandlers.ts 仅注册 IPC 通道，
 * 流式输出业务逻辑集中在本模块，职责分离便于维护和测试。
 *
 * 流式输出架构：
 *   主进程直接消费 agent.chat()，通过专用 IPC 通道发送 chunk，
 *   不走 IInteraction（IInteraction 仅负责非流式输出）。
 */

import { randomUUID } from 'node:crypto';
import { toError, logger } from 'memora';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { MAIN_TO_RENDERER_CHANNELS } from './channels.js';
import type { IpcContext } from './types.js';
import { getLocalDate } from '../../sprite/constants.js';
import { classifyLlmError } from '../../shared/llmErrorClassifier.js';
import type { BrowserWindow } from 'electron';

// ─── 流式输出超时兜底常量 ─────────────────────────────────

/**
 * 流式输出"无进展"超时阈值（毫秒）
 *
 * 主进程兜底：每个 chunk 到达即重置定时器，超过此时长无任何 chunk
 * 则判定为 generator 挂起（LLM 卡死 / postProcess 阻塞 / abort 未响应等），
 * 强制清理宿主状态并通知渲染进程解锁，避免 AbortController 泄漏导致后续对话被竞态保护拒绝。
 *
 * 时长取舍：晚于渲染进程 30s 兜底（留出 abort 响应窗口），早于内核 3 分钟锁超时（CHAT_LOCK_TIMEOUT_MS = 180_000）。
 */
const STREAM_NO_PROGRESS_TIMEOUT_MS = 60_000;

// ─── 流式错误推送辅助函数 ─────────────────────────────────

/**
 * 向渲染进程推送对话错误提示，并同步记录主进程日志
 *
 * 与 errorHandler.handle 的区别：
 * - 本函数用于业务拒绝/超时等可预期场景（logger.warn 级别，不推送 APP_ERROR 弹窗）
 * - errorHandler.handle 用于未捕获错误（logger.error 级别，推送 APP_ERROR 弹窗）
 *
 * @param fullWindow 目标窗口（调用方已确保未销毁，函数内不再重复检查）
 * @param text 用户可见的错误提示文本（推送 SPRITE_ERROR）
 * @param context 错误上下文标识（用于日志检索，如 'Agent 未就绪'）
 */
function emitStreamError(fullWindow: BrowserWindow, text: string, context: string): void {
  // 记录主进程日志（业务拒绝/超时场景用 warn 级别）
  logger.warn({ context, text }, '对话流式错误提示');
  // 推送到渲染进程显示错误提示（调用方均已检查 isDestroyed，同步路径无需二次防御）
  fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, { text });
}

/**
 * 处理用户输入 — 消费 agent.chat() AsyncGenerator 并推送流式 chunk
 *
 * 实现方案 §6.2 流式输出架构：
 * - 主进程直接消费 agent.chat() 的 AsyncGenerator
 * - 通过 sprite-stream-start / sprite-stream-chunk / sprite-stream-end 通道推送
 * - 支持 AbortController 中断
 *
 * @param text 用户输入文本
 * @param ctx IPC 上下文（提供 agent / windowManager / trayManager 等依赖）
 */
export async function handleUserInput(text: string, ctx: IpcContext): Promise<void> {
  const fullWindow = ctx.windowManager.getFullWindow();
  if (!fullWindow || fullWindow.isDestroyed()) return;

  // Agent 未就绪时拒绝：可能是首次配置后正在初始化，或配置缺失
  if (!ctx.isAgentReady()) {
    emitStreamError(fullWindow, 'Agent 正在初始化中，请稍候后重试；若长时间无响应请在设置面板检查 LLM 配置', 'Agent 未就绪');
    return;
  }

  // 竞态保护——已有进行中的对话时拒绝，避免 Agent 并发锁抛"对话繁忙"错误。
  if (ctx.getAbortController()) {
    emitStreamError(fullWindow, '上一条消息仍在处理中，请等待完成或点击停止后再发送', '对话竞态保护');
    return;
  }

  // 跨日/跨会话自动重置：确保新消息始终归当天主会话
  const history = ctx.agent.agentHistory;
  if (history) {
    const todayDate = getLocalDate();
    if (history.currentDateValue !== todayDate) {
      // 类型守卫：sessionManager 类型为 SessionManager | null，
      // 初始化未完成或 close() 后为 null，跨日重置依赖 sessionManager 必须存在
      const sessionManager = ctx.agent.sessionManager;
      if (!sessionManager) {
        emitStreamError(fullWindow, '会话管理器未初始化，请稍后重试', 'SessionManager 未初始化');
        return;
      }
      // 重置到当天 main 会话（先 switchSession 再 restoreSession，与其他路径一致）
      sessionManager.switchSession('main');
      const restoredCount = await sessionManager.restoreSession(todayDate, 'main');
      // restoreSession 仅在有消息时写入工作记忆；无消息时旧上下文残留需手动清理
      if (restoredCount === 0 && ctx.agent.agentLoop) {
        ctx.agent.agentLoop.restoreHistory([]);
      }
    }
  }

  const messageId = randomUUID();
  fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START, { messageId });

  // 累加当日用户消息计数（供 ReviewData.today.messageCount 消费）
  // 放在竞态/就绪检查通过后、流式开始前，确保只对真正发送的消息计数
  ctx.sprite.incrementDailyMessageCount();

  // 对话前感知刷新——累积用户消息 + 注入情感/默契度/上下文/模式/里程碑/跨会话上下文
  // 确保 LLM 在流式对话中也能拿到最新的感知数据（与 CLI 路径的 wakeup() 共享同一份刷新逻辑）
  ctx.sprite.prepareForChat(text);

  // 托盘切换为 active 状态（蓝色 + 脉冲），表示精灵正在思考
  ctx.trayManager?.setState('active');

  // 创建 AbortController 供中断使用
  const abortController = new AbortController();
  ctx.setAbortController(abortController);

  // 主进程无进展超时兜底：每个 chunk 到达即重置定时器，超时则强制清理（详见 STREAM_NO_PROGRESS_TIMEOUT_MS 注释）
  let streamTimedOut = false;
  let streamTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  /** 重置无进展定时器（chunk 到达或对话开始时调用） */
  const resetStreamTimeout = (): void => {
    if (streamTimeoutTimer !== null) clearTimeout(streamTimeoutTimer);
    streamTimeoutTimer = setTimeout(() => {
      // 幂等保护：已超时或已清理则跳过
      if (streamTimedOut) return;
      streamTimedOut = true;
      streamTimeoutTimer = null;
      // 强制中断内核 generator（若 generator 响应 abort 会抛 AbortError 退出）
      abortController.abort(new DOMException('流式输出无进展超时', 'TimeoutError'));
      // 强制释放内核对话锁
      // 仅靠 abortController.abort() 无法中断不响应 signal 的 await 点（如第三方库），
      // generator 仍卡住时 _chatBusy 锁未释放，用户再发消息会被 agent.chat() 竞态保护拒绝。
      // forceReleaseChatLock 递增 token + 清理锁，让用户能立即发起新对话；
      // 原 generator 的 finally 块通过 token 校验跳过清理，不影响新调用。
      ctx.agent.forceReleaseChatLock();
      // 兜底清理宿主状态：即使 generator 不响应 abort，也确保渲染进程解锁 + AbortController 释放
      if (!fullWindow.isDestroyed()) {
        emitStreamError(fullWindow, '对话超时（长时间无响应），已自动停止。可点击重试或检查 LLM 配置', '流式输出无进展超时');
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, { messageId });
      }
      ctx.setAbortController(null);
      ctx.trayManager?.setState('idle');
    }, STREAM_NO_PROGRESS_TIMEOUT_MS);
  };
  // 启动首次计时
  resetStreamTimeout();

  // 记录对话开始前的截断次数，对话结束后对比检测截断事件
  const truncationBefore = ctx.agent.getMetrics().context.truncationCount;

  /**
   * 中断通道已发送标志
   *
   * 内核 agent.chat() 有两条路径会产生中断：
   * 1. for-await 循环中 yield { type: 'aborted' } chunk（内核主动 abort）
   * 2. AbortController.abort() 导致 generator throw AbortError（外部 abort）
   * 两条路径最终都会到达：路径1 break 后到 finally，路径2 进入 catch。
   * 此标志确保 SPRITE_STREAM_ABORTED 只发送一次（单点路由原则），
   * 避免渲染层重复嵌入中断标记。
   */
  let abortedNotified = false;

  // 每次 chunk 发送累积完整文本（非 delta），保证渲染层拼接完整
  // 提升到 try 外部，finally 块需要访问以推送到浮动窗口
  let accumulatedText = '';

  try {
    // 每次 chunk 发送累积完整文本（非 delta），保证渲染层拼接完整
    for await (const chunk of ctx.agent.chat(text, abortController.signal)) {
      // 超时已被强制清理，或窗口销毁，则退出循环（break 会触发 generator return()）
      if (streamTimedOut || fullWindow.isDestroyed()) break;
      // 每个 chunk 到达即重置无进展定时器（chunk 到达代表 generator 有进展）
      resetStreamTimeout();

      if (chunk.type === 'text') {
        // 累积 delta 后发送完整文本，渲染层清空重渲染也不会丢失内容
        accumulatedText += chunk.content;
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK, {
          messageId,
          text: accumulatedText,
        });
      } else if (chunk.type === 'recall') {
        // 召回透明度：推送召回记忆摘要到渲染层，在消息底部展示
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_RECALL, {
          messageId,
          memories: chunk.memories,
        });
      } else if (chunk.type === 'tool_start') {
        // 工具调用开始：推送工具名和参数，UI 渲染工具调用卡片
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_START, {
          messageId,
          toolCallId: chunk.toolCallId,
          name: chunk.name,
          args: chunk.args,
        });
      } else if (chunk.type === 'tool_result') {
        // 工具调用结果：推送工具名、成功状态和摘要，UI 更新工具卡片状态
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_RESULT, {
          messageId,
          toolCallId: chunk.toolCallId,
          name: chunk.name,
          ok: chunk.ok,
          summary: chunk.summary,
        });
      } else if (chunk.type === 'thinking') {
        // 思考阶段指示：推送阶段名称，UI 显示"正在回忆.../处理.../归档..."
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING, {
          messageId,
          phase: chunk.phase,
        });
      } else if (chunk.type === 'done') {
        // 对话正常结束时检测截断次数是否增加
        const truncationAfter = ctx.agent.getMetrics().context.truncationCount;
        if (truncationAfter > truncationBefore) {
          fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_CONTEXT_TRUNCATED, {
            messageId,
            count: truncationAfter - truncationBefore,
          });
        }
        // done 后 agent.chat() 仍要执行 appendAssistant + postProcess
        // postProcess 是 fire-and-forget（所有 LLM 调用注册到 pendingArchives 不 await），
        // 本身执行很快（毫秒级），但 done 到 finally 之间仍有微小窗口期
        // 发 thinking keepalive（phase=archiving）让渲染层重置 safety timer，覆盖此窗口
        // 对应 chatPanelManager.showThinkingPhase 的 _resetStreamSafetyTimer 调用
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING, {
          messageId,
          phase: 'archiving' as const,
        });
        // done 信号：不 break，让 for-await 自然结束。
        // agent.chat() 在 done 后仍需执行 appendAssistant（保存助手消息）
        // 和 postProcess（归档后处理），break 会导致 return() 被调用，
        // 跳过这些关键步骤。finally 块会在 generator 自然结束后发送 SPRITE_STREAM_END。
      } else if (chunk.type === 'error') {
        // 内核 yield error chunk（如 LLM 超时、连接断开）
        // 复用 SPRITE_STREAM_ABORTED 通道展示错误（气泡内嵌错误提示）
        // 标记 abortedNotified 让 finally 不重复发 ABORTED
        abortedNotified = true;
        // 原始技术错误保留到日志便于排查，UI 仅展示友好映射文本
        logger.error('chatStream chunk error:', chunk.message);
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED, {
          messageId,
          reason: classifyLlmError(chunk.message ?? ''),
        });
        break;
      } else if (chunk.type === 'aborted') {
        // 中断标记内嵌气泡：内核主动 yield aborted chunk 时通知渲染层
        // 标记已发送，catch 块不再重复发送
        abortedNotified = true;
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED, {
          messageId,
          reason: chunk.reason,
        });
        // aborted 信号：停止处理后续 chunk，由 finally 统一发送 SPRITE_STREAM_END
        break;
      }
    }
  } catch (error) {
    // 超时已在定时器内完成清理与通知，跳过 catch 后续逻辑（finally 仍会执行定时器清理）
    if (streamTimedOut) return;
    // 通过 AbortController.reason 判断是否用户主动中断
    const ctrl = ctx.getAbortController();
    const abortReason = ctrl?.signal.reason;
    const wasUserAborted = abortReason instanceof DOMException && abortReason.name === 'AbortError';

    // IPC 消息顺序保证：错误/中断通知必须在 SPRITE_STREAM_END 之前发送，
    // 因为 END 会触发 finishStreamingMessage 清理 streamingMessages，
    // 之后到达的 SPRITE_ERROR/ABORTED 找不到消息元素无法注入提示。
    // finally 块在 catch 之后执行，SPRITE_STREAM_END 自然在最后发送，保证顺序正确。
    if (!fullWindow.isDestroyed()) {
      if (wasUserAborted) {
        // 仅当 aborted chunk 路径未发送过时才发送（避免双重通知）
        if (!abortedNotified) {
          fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED, {
            messageId,
            reason: '用户手动停止',
          });
          abortedNotified = true;
        }
      } else {
        // 原始错误保留到日志，UI 走 classifyLlmError 友好映射（未匹配回退到原始消息）
        const rawMsg = toError(error).message;
        logger.error('chatStream catch error:', rawMsg);
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, {
          text: classifyLlmError(rawMsg),
        });
      }
    }
    // 用户主动中断不记录为错误；其他错误才上报 errorHandler
    if (!wasUserAborted) {
      errorHandler.handle(error, { code: ErrorCode.API_ERROR, context: '对话流式输出失败' });
    }
  } finally {
    // 清理无进展超时定时器（正常结束 / 异常 / 中断均需清理）
    if (streamTimeoutTimer !== null) {
      clearTimeout(streamTimeoutTimer);
      streamTimeoutTimer = null;
    }
    // 超时路径已在定时器内发送过 STREAM_END + 清理 AbortController，此处跳过避免重复。
    if (!streamTimedOut) {
      // 无论生成器以何种方式退出（done/aborted/异常/窗口销毁），都确保发送 SPRITE_STREAM_END。
      // SPRITE_STREAM_END 在 catch/正常路径之后发送（finally 在 catch 之后执行），
      // 保证错误/中断通知先于 END 到达渲染层。
      if (!fullWindow.isDestroyed()) {
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, { messageId });
      }
      // P4-1：推送最后一条助手消息到浮动窗口（非空且非错误时）
      if (accumulatedText && !abortedNotified) {
        const floatWin = ctx.windowManager.getFloatWindow();
        if (floatWin) {
          floatWin.send(MAIN_TO_RENDERER_CHANNELS.FLOAT_LAST_MESSAGE, accumulatedText);
        }
        // 完整窗口不可见时增加未读计数（推送到浮动窗口徽章）
        // 语义：未读 = "AI 回复后用户尚未查看"，仅当 AI 真正生成内容时计数；
        // - accumulatedText 非空：AI 有实际回复内容（防止空回复计数）
        // - !abortedNotified：用户主动中断或内核错误时不计数（中断后视为无新消息）
        // - !fullWindow.isVisible()：完整窗口不可见时才计数（用户可见时不需提醒）
        // 与 spriteEventBridge.ts proactivePrompt 的 incrementUnreadCount 配合，
        // 都由 main.ts 的 onExpandToFull → resetUnreadCount 统一清除。
        if (!fullWindow.isVisible()) {
          ctx.incrementUnreadCount();
        }
      }
      ctx.setAbortController(null);
      // 流式结束：托盘切回 idle 状态（绿色静态）
      ctx.trayManager?.setState('idle');
    }
  }
}
