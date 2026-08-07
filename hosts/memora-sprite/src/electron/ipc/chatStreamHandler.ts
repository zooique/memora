/**
 * 对话流式输出处理器
 *
 * 职责：
 *   消费 agent.processEvent() AsyncGenerator，将流式 chunk 通过 IPC 推送到渲染进程。
 *   包含无进展超时兜底、中断处理、错误降级等完整流式输出逻辑。
 *
 * 与 chatHandlers.ts 的关系：chatHandlers.ts 仅注册 IPC 通道，
 * 流式输出业务逻辑集中在本模块，职责分离便于维护和测试。
 *
 * 流式输出架构：
 *   主进程通过 agent.processEvent() 处理结构化 SessionEvent，通过专用 IPC 通道发送 chunk，
 *   不走 IInteraction（IInteraction 仅负责非流式输出）。
 */

import { randomUUID } from 'node:crypto';
import { toError, logger } from 'memora';
import type { SessionEvent } from 'memora';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { MAIN_TO_RENDERER_CHANNELS } from './channels.js';
import { requireAgent, requireSprite } from './types.js';
import type { IpcContext } from './types.js';
import { classifyLlmError } from '../../shared/llmErrorClassifier.js';
import { formatErrorMessage } from '../../shared/errorMessages.js';
// 流式输出核心工具（跨宿主共享层）：超时常量 + 超时状态机 + 跨日重置
import {
  createStreamTimeoutGuard,
  resetSessionIfNeeded,
} from '../../shared/chatStreamCore.js';
import type { BrowserWindow } from 'electron';

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
 * 处理用户输入 — 消费 agent.processEvent() AsyncGenerator 并推送流式 chunk
 *
 * 实现方案 §6.2 流式输出架构：
 * - 主进程通过 agent.processEvent() 处理结构化 SessionEvent，消费 AsyncGenerator
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

  // 每次 chunk 发送累积完整文本（非 delta），保证渲染层拼接完整
  // 声明在 try 之外：finally 块需访问以推送到浮动窗口
  let accumulatedText = '';
  // SPRITE_STREAM_START 是否已发送（延迟到首个 chunk 后，确保 persona 已匹配）
  let streamStarted = false;
  // 中断通道已发送标志（确保 SPRITE_STREAM_ABORTED 只发送一次）
  let abortedNotified = false;
  // 无进展超时状态机（跨宿主共享）
  let timeoutGuard: ReturnType<typeof createStreamTimeoutGuard> | null = null;
  // AbortController 和 messageId 在 try 块内创建，但 finally 块需要访问
  let abortController: AbortController | null = null;
  let messageId: string | null = null;

  try {
    // 缓存 Agent / Sprite 实例：本函数内多次使用，统一取一次避免重复调用 getter；
    // 同时锁定本次对话使用的实例引用（reinitAgent 后旧实例仍能完成本次对话的清理）
    // 移入 try 块内：防止 isAgentReady() 通过后、reinitAgent 导致 requireAgent 抛异常时
    // 产生 unhandledRejection（chatHandlers.ts:39 使用 void handleUserInput()）
    const agent = requireAgent(ctx);
    const sprite = requireSprite(ctx);

    // 在 await 之前同步占用 AbortController，避免 await 让渡点期间并发调用通过竞态检查
    // （JavaScript 单线程同步代码不会被打断，"检查-占用"原子化）
    abortController = new AbortController();
    ctx.setAbortController(abortController);

    // 跨日/跨会话自动重置：确保新消息始终归当天主会话（跨宿主共享逻辑）
    const sessionReset = await resetSessionIfNeeded(agent);
    if (!sessionReset.ok) {
      emitStreamError(fullWindow, sessionReset.error, 'SessionManager 未初始化');
      return;
    }

    messageId = randomUUID();

    // 累加当日用户消息计数（供 ReviewData.today.messageCount 消费）
    sprite.incrementDailyMessageCount();

    // 对话前感知刷新——累积用户消息 + 注入情感/默契度/上下文/模式/里程碑/跨会话上下文
    sprite.prepareForChat(text);

    // 托盘切换为 active 状态（蓝色 + 脉冲），表示精灵正在思考
    ctx.trayManager?.setState('active');

    // 创建无进展超时状态机：超时时 abort + forceReleaseChatLock，IPC 推送统一到 finally 块发送
    // （避免与主流程 for-await 共享状态的并发访问竞争）
    timeoutGuard = createStreamTimeoutGuard({
      onTimeout: () => {
        abortController?.abort(new DOMException('流式输出无进展超时', 'TimeoutError'));
        agent.forceReleaseChatLock();
      },
    });
    // 启动首次计时
    timeoutGuard.reset();

    // 构造 SessionEvent，意图分类为 chat（普通对话）
    const event: SessionEvent = { type: 'chat', content: text };
    // 记录对话开始前的截断次数，对话结束后对比检测截断事件
    const truncationBefore = agent.getMetrics().context.truncationCount;
    // 每次 chunk 发送累积完整文本（非 delta），保证渲染层拼接完整
    for await (const chunk of agent.processEvent(event, abortController.signal)) {
      // 首个 chunk：此时 agent.processEvent() 内部的 tryAutoMatchPersona 已执行完毕，
      // activePersona 就是本轮 LLM 回答实际使用的角色（匹配成功已切换，匹配失败保持原角色）。
      // 在此发送 SPRITE_STREAM_START，确保消息底部角色标签与回答实际角色一致
      if (!streamStarted) {
        streamStarted = true;
        const personaName = sprite.activePersona ?? undefined;
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START, { messageId, persona: personaName });
      }

      // 超时已被强制清理，或窗口销毁，则退出循环（break 会触发 generator return()）
      if (timeoutGuard.isTimedOut() || fullWindow.isDestroyed()) break;
      // 每个 chunk 到达即重置无进展定时器（chunk 到达代表 generator 有进展）
      timeoutGuard.reset();

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
        const truncationAfter = agent.getMetrics().context.truncationCount;
        if (truncationAfter > truncationBefore) {
          fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_CONTEXT_TRUNCATED, {
            messageId,
            count: truncationAfter - truncationBefore,
          });
        }
        // done 后 agent.processEvent() 仍要执行 appendAssistant + postProcess
        // postProcess 是 fire-and-forget（所有 LLM 调用注册到 pendingArchives 不 await），
        // 本身执行很快（毫秒级），但 done 到 finally 之间仍有微小窗口期
        // 发 thinking keepalive（phase=archiving）让渲染层重置 safety timer，覆盖此窗口
        // 对应 chatPanelManager.showThinkingPhase 的 _resetStreamSafetyTimer 调用
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING, {
          messageId,
          phase: 'archiving' as const,
        });
        // done 信号：不 break，让 for-await 自然结束。
        // agent.processEvent() 在 done 后仍需执行 appendAssistant（保存助手消息）
        // 和 postProcess（归档后处理），break 会导致 return() 被调用，
        // 跳过这些关键步骤。finally 块会在 generator 自然结束后发送 SPRITE_STREAM_END。
      } else if (chunk.type === 'error') {
        // 内核 yield error chunk（如 LLM 超时、连接断开）
        // 复用 SPRITE_STREAM_ABORTED 通道展示错误（气泡内嵌错误提示）
        // 标记 abortedNotified 让 finally 不重复发 ABORTED
        abortedNotified = true;
        // 原始技术错误保留到日志便于排查，UI 仅展示友好映射文本
        // LLM 错误优先走 classifyLlmError（LLM 专用分类），非 LLM 错误走 formatErrorMessage（通用错误分类）
        const rawMsg = chunk.message ?? '';
        logger.error('chatStream chunk error:', rawMsg);
        const friendlyMessage = classifyLlmError(rawMsg);
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED, {
          messageId,
          reason: friendlyMessage,
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
    // 超时路径：状态机已设标志 + abort，IPC 通知与状态清理统一在 finally 块执行，跳过 catch 重复处理
    if (timeoutGuard?.isTimedOut()) return;
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
        // 错误分类：与 chatStreamRoutes（Web 路由）统一使用 formatErrorMessage。
        // chunk.type === 'error' 路径已由 classifyLlmError 处理 LLM 专用错误（401/403/429 等），
        // catch 块覆盖的是 generator 外层异常（IPC/存储/未知等），走通用分类更合适。
        const rawMsg = toError(error).message;
        logger.error('chatStream catch error:', rawMsg);
        const friendlyMessage = formatErrorMessage('对话', error);
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, {
          text: friendlyMessage,
        });
      }
    }
    // 用户主动中断不记录为错误；其他错误才上报 errorHandler
    if (!wasUserAborted) {
      errorHandler.handle(error, { code: ErrorCode.API_ERROR, context: '对话流式输出失败' });
    }
  } finally {
    // 清理无进展超时定时器（正常结束 / 异常 / 中断均需清理）
    timeoutGuard?.cleanup();
    // 所有路径（含超时）统一在 finally 发送 IPC 与清理状态，避免定时器回调与主流程的并发访问竞争
    if (!fullWindow.isDestroyed()) {
      if (timeoutGuard?.isTimedOut()) {
        // 超时路径：发送错误提示 + STREAM_END（仅在 streamStarted 后才发 END，避免无 START 的 END）
        if (messageId) {
          emitStreamError(fullWindow, '对话超时（长时间无响应），已自动停止。可点击重试或检查 LLM 配置', '流式输出无进展超时');
        }
        if (streamStarted && messageId) {
          fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, { messageId });
        }
      } else {
        // 正常 / 异常 / 中断路径：保证错误/中断通知先于 END 到达渲染层（catch 已发送过）
        // streamStarted 守卫：generator 退出前若未 yield 任何 chunk（如 chat() 入口抛异常），
        // 跳过 END，避免渲染层收到无对应 START 的 END 消息。
        if (streamStarted && messageId) {
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
      }
    }
    ctx.setAbortController(null);
    // 流式结束：托盘切回 idle 状态（绿色静态）
    ctx.trayManager?.setState('idle');
  }
}
