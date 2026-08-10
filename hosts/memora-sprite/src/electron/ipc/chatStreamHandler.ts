/**
 * 对话流式输出处理器
 *
 * 职责：
 *   消费 agent.processEvent() / agent.resumeExecution() AsyncGenerator，将流式 chunk 通过 IPC 推送到渲染进程。
 *   包含无进展超时兜底、中断处理、错误降级、软暂停（paused chunk）与 finally 统一清理。
 *
 * 与 chatHandlers.ts 的关系：chatHandlers.ts 仅注册 IPC 通道，
 * 流式输出业务逻辑集中在本模块，职责分离便于维护和测试。
 *
 * 流式输出架构：
 *   主进程通过 agent.processEvent()/resumeExecution() 处理结构化 SessionEvent，通过专用 IPC 通道发送 chunk，
 *   不走 IInteraction（IInteraction 仅负责非流式输出）。
 */

import { randomUUID } from 'node:crypto';
import { toError, logger } from 'memora';
import type { SessionEvent, AgentChunk } from 'memora';
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
 * 流式 chunk 转发内核抽离到 forwardStream（handleUserInput 与 handleResume 共用），
 * 本函数仅负责"新对话"专属准备（会话重置 / 计数 / 感知准备）。
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

  // 在 await 之前同步占用 AbortController，避免 await 让渡点期间并发调用通过竞态检查
  // （JavaScript 单线程同步代码不会被打断，"检查-占用"原子化）
  const abortController = new AbortController();
  ctx.setAbortController(abortController);

  const agent = requireAgent(ctx);

  // 跨日/跨会话自动重置：确保新消息始终归当天主会话（跨宿主共享逻辑）
  const sessionReset = await resetSessionIfNeeded(agent);
  if (!sessionReset.ok) {
    emitStreamError(fullWindow, sessionReset.error, 'SessionManager 未初始化');
    ctx.setAbortController(null);
    return;
  }

  const messageId = randomUUID();

  // 累加当日用户消息计数（供 ReviewData.today.messageCount 消费）
  requireSprite(ctx).incrementDailyMessageCount();

  // 对话前感知刷新——累积用户消息 + 注入情感/默契度/上下文/模式/里程碑/跨会话上下文
  requireSprite(ctx).prepareForChat(text);

  // 托盘切换为 active 状态（蓝色 + 脉冲），表示精灵正在思考
  ctx.trayManager?.setState('active');

  // 构造 SessionEvent，意图分类为 chat（普通对话）
  const event: SessionEvent = { type: 'chat', content: text };
  const generator = agent.processEvent(event, abortController.signal);
  await forwardStream(generator, ctx, messageId, abortController);
}

/**
 * 软暂停后续跑 — 镜像 handleUserInput，消费 agent.resumeExecution() AsyncGenerator
 *
 * 与 handleUserInput 的区别：复用以暂停的既有上下文（不重置会话 / 不计数 / 不重新 prepareForChat），
 * 驱动内核 loop.continueAfterPause 续跑生成器。AbortController 仍由 ctx 管理（硬停止仍走 CHAT_ABORT）。
 *
 * @param input 可选补充输入（空=续跑原路径；有=注入修正后续轮）
 * @param ctx IPC 上下文
 */
export async function handleResume(input: string | undefined, ctx: IpcContext): Promise<void> {
  const fullWindow = ctx.windowManager.getFullWindow();
  if (!fullWindow || fullWindow.isDestroyed()) return;

  if (!ctx.isAgentReady()) {
    emitStreamError(fullWindow, 'Agent 正在初始化中，请稍候后重试；若长时间无响应请在设置面板检查 LLM 配置', 'Agent 未就绪');
    return;
  }

  // 竞态保护——续跑期间同样拒绝并发调用
  if (ctx.getAbortController()) {
    emitStreamError(fullWindow, '上一条消息仍在处理中，请等待完成或点击停止后再发送', '对话竞态保护');
    return;
  }

  const abortController = new AbortController();
  ctx.setAbortController(abortController);

  const messageId = randomUUID();
  // 托盘切换为 active 状态（蓝色 + 脉冲），表示精灵正在思考
  ctx.trayManager?.setState('active');

  const agent = requireAgent(ctx);
  const generator = agent.resumeExecution(input, abortController.signal);
  await forwardStream(generator, ctx, messageId, abortController);
}

/**
 * 广播会话状态变更（含 resumable 信号，供渲染层暂停按钮显隐）
 *
 * 状态层四态（用户设计定案 2026-08-10：资源层 vs 状态层模型）：
 * - running：运行中（挂载了任务状态）
 * - paused：已暂停（挂载物保留，可续跑）
 * - error：异常
 * - idle：空闲（资源层无挂载物，任务流结束/停止/异常后广播，
 *   渲染层据此复位 sessionStatus，卸载任务面板的暂停按钮等挂载物）
 *
 * @param ctx IPC 上下文
 * @param status 状态：running | paused | error | idle
 * @param reason 状态原因（可选）
 * @param resumable 当前会话是否可"无输入续跑"（内核 canContinueWithoutInput 信号）
 */
function broadcastStatus(ctx: IpcContext, status: 'running' | 'paused' | 'error' | 'idle', reason?: string, resumable?: boolean): void {
  const fullWindow = ctx.windowManager.getFullWindow();
  if (!fullWindow || fullWindow.isDestroyed()) return;
  fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SESSION_STATUS_CHANGED, { status, reason, resumable });
}

/**
 * 处理用户回答的澄清问题 — 与 handleUserInput 同构（SSOT 排雷第二轮 T1）
 *
 * 历史缺陷：chatHandlers 曾以 `void agent.processEvent(event)` 消费 async generator，
 * 而 async generator 不迭代则函数体一行不执行 → auto-resume / Composer 补槽 /
 * clarify→chat 转换 / resetConsecutivePauseCount 全链路失效，且 IPC 照常返回 success。
 * 此处复用 forwardStream 完整模式（AbortController 占用 → 迭代推流 → finally 释放），
 * 既让澄清回答真正驱动内核执行，又保持并发闸门（ctx.getAbortController()）有效。
 *
 * 与 handleUserInput 的区别：不重置会话 / 不计数 / 不 prepareForChat（同 handleResume，
 * 澄清回答是对既有会话的继续，不产生新消息计数）。
 *
 * @param answers 用户回答（slot → answer），序列化为 clarify 事件内容
 * @param ctx IPC 上下文
 */
export async function handleClarifyAnswer(
  answers: Array<{ slot: string; answer: string }>,
  ctx: IpcContext,
): Promise<void> {
  const fullWindow = ctx.windowManager.getFullWindow();
  if (!fullWindow || fullWindow.isDestroyed()) return;

  if (!ctx.isAgentReady()) {
    emitStreamError(fullWindow, 'Agent 正在初始化中，请稍候后重试', 'Agent 未就绪');
    return;
  }

  // 竞态保护——澄清回答驱动的执行流同样占用 AbortController，防止并发进入
  if (ctx.getAbortController()) {
    emitStreamError(fullWindow, '上一条消息仍在处理中，请等待完成或点击停止后再发送', '对话竞态保护');
    return;
  }

  const abortController = new AbortController();
  ctx.setAbortController(abortController);

  const messageId = randomUUID();
  ctx.trayManager?.setState('active');

  const agent = requireAgent(ctx);
  const event: SessionEvent = {
    type: 'clarify',
    content: JSON.stringify(answers),
    delta: {},
  };
  const generator = agent.processEvent(event, abortController.signal);
  await forwardStream(generator, ctx, messageId, abortController);
}

/**
 * 流式 chunk 转发内核（handleUserInput / handleResume 共用）
 *
 * 消费任意 AgentChunk 生成器，将 chunk 推送渲染进程，含无进展超时兜底、
 * 中断处理、错误降级、软暂停（paused chunk）与 finally 统一清理。
 * 抽离为单一真理源，避免 chat / resume 两条流式路径逻辑分叉。
 *
 * @param generator AgentChunk 生成器（chat 的 processEvent 或 resumeExecution）
 * @param ctx IPC 上下文
 * @param messageId 本次流式消息 ID（SPRITE_STREAM_START/CHUNK/END 共用）
 * @param abortController 本次流式占用的 AbortController（超时/硬停止共用）
 */
async function forwardStream(
  generator: AsyncGenerator<AgentChunk>,
  ctx: IpcContext,
  messageId: string,
  abortController: AbortController,
): Promise<void> {
  const fullWindow = ctx.windowManager.getFullWindow();
  if (!fullWindow || fullWindow.isDestroyed()) return;

  const sprite = requireSprite(ctx);
  const agent = requireAgent(ctx);

  // 每次 chunk 发送累积完整文本（非 delta），保证渲染层拼接完整
  // 声明在 try 之外：finally 块需访问以推送到浮动窗口
  let accumulatedText = '';
  // SPRITE_STREAM_START 是否已发送（延迟到首个 chunk 后，确保 persona 已匹配）
  let streamStarted = false;
  // 中断通道已发送标志（确保 SPRITE_STREAM_ABORTED 只发送一次）
  let abortedNotified = false;
  // 软暂停标志（paused chunk 已收到）：暂停由内核 sessionPaused 事件广播 paused 态，
  // finally 必须跳过 idle 广播，避免覆盖暂停态（SSOT 挂载物模型 2026-08-10）
  let pausedNotified = false;
  // 无进展超时状态机（跨宿主共享）
  const timeoutGuard = createStreamTimeoutGuard({
    onTimeout: () => {
      abortController?.abort(new DOMException('流式输出无进展超时', 'TimeoutError'));
      agent.forceReleaseChatLock();
    },
  });
  // 启动首次计时
  timeoutGuard.reset();

  // 记录对话开始前的截断次数，对话结束后对比检测截断事件
  const truncationBefore = agent.getMetrics().context.truncationCount;

  try {
    for await (const chunk of generator) {
      // 首个 chunk：此时 agent.processEvent() 内部的 tryAutoMatchPersona 已执行完毕，
      // activePersona 就是本轮 LLM 回答实际使用的角色（匹配成功已切换，匹配失败保持原角色）。
      // 同时首个 chunk 已越过内核 plan 创建点，此刻 canContinueWithoutInput 反映真实可续跑性，
      // 广播 resumable 让渲染层正确决定暂停按钮显隐（多轮任务显暂停 / 简单轮只显停止）。
      if (!streamStarted) {
        streamStarted = true;
        const personaName = sprite.activePersona ?? undefined;
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START, { messageId, persona: personaName });
        broadcastStatus(ctx, 'running', undefined, agent.canContinueWithoutInput());
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
        // 已进入自主工具步：内核 isInAutonomousStep 为 true，刷新 resumable 信号让暂停按钮显隐生效
        broadcastStatus(ctx, 'running', undefined, agent.canContinueWithoutInput());
      } else if (chunk.type === 'tool_result') {
        // 工具调用结果：推送工具名、成功状态和摘要，UI 更新工具卡片状态
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_RESULT, {
          messageId,
          toolCallId: chunk.toolCallId,
          name: chunk.name,
          ok: chunk.ok,
          summary: chunk.summary,
        });

        // 任务表生成即生效（用户定案 2026-08-10：无接受/丢弃确认，过渡设计已删）。
        // 通知渲染层刷新任务面板展示新任务表；plan 后续更新由 onStreamToolResult
        // 的 task_table_* 前缀刷新覆盖。
        if (chunk.name === 'task_table_write' && chunk.ok) {
          fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_TASK_TABLE_GENERATED, {
            messageId,
            plan: chunk.summary,
          });
        }
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
        // done 后 agent 仍要执行 appendAssistant + postProcess（fire-and-forget，毫秒级），
        // 但 done 到 finally 之间仍有微小窗口期；发 thinking keepalive（phase=archiving）
        // 让渲染层重置 safety timer，覆盖此窗口。不 break，让 for-await 自然结束。
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING, {
          messageId,
          phase: 'archiving' as const,
        });
      } else if (chunk.type === 'error') {
        // 内核 yield error chunk（如 LLM 超时、连接断开）
        // 复用 SPRITE_STREAM_ABORTED 通道展示错误（气泡内嵌错误提示）
        abortedNotified = true;
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
        abortedNotified = true;
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_ABORTED, {
          messageId,
          reason: chunk.reason,
        });
        // aborted 信号：停止处理后续 chunk，由 finally 统一发送 SPRITE_STREAM_END
        break;
      } else if (chunk.type === 'paused') {
        // 软暂停：内核在 loop 边界挂起生成器（非 abort），保留 messages 可经 resumeExecution 续跑。
        // 不发送 aborted/error（暂停非错误）；暂停前已生成的文本是真实内容，照常推送浮动窗口。
        // 标记暂停场景：状态广播由内核 sessionPaused 事件负责（paused 态），
        // finally 据此刻跳过 idle 广播，避免覆盖暂停态（SSOT 挂载物模型 2026-08-10）。
        pausedNotified = true;
        break;
      }
    }
  } catch (error) {
    // 超时路径：状态机已设标志 + abort，IPC 通知与状态清理统一在 finally 块执行，跳过 catch 重复处理
    if (timeoutGuard.isTimedOut()) return;
    // 通过 AbortController.reason 判断是否用户主动中断
    const ctrl = ctx.getAbortController();
    const abortReason = ctrl?.signal.reason;
    const wasUserAborted = abortReason instanceof DOMException && abortReason.name === 'AbortError';

    // IPC 消息顺序保证：错误/中断通知必须在 SPRITE_STREAM_END 之前发送
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
        // catch 块覆盖的是 generator 外层异常（IPC/存储/未知等），走通用分类
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
    // 清理无进展超时定时器（正常结束 / 异常 / 中断 / 暂停均需清理）
    timeoutGuard.cleanup();
    // 所有路径（含超时）统一在 finally 发送 IPC 与清理状态，避免定时器回调与主流程的并发访问竞争
    if (!fullWindow.isDestroyed()) {
      if (timeoutGuard.isTimedOut()) {
        // 超时路径：发送错误提示 + STREAM_END（仅在 streamStarted 后才发 END，避免无 START 的 END）
        if (messageId) {
          emitStreamError(fullWindow, '对话超时（长时间无响应），已自动停止。可点击重试或检查 LLM 配置', '流式输出无进展超时');
        }
        if (streamStarted && messageId) {
          fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, { messageId });
        }
      } else {
        // 正常 / 异常 / 中断 / 暂停路径：保证错误/中断通知先于 END 到达渲染层（catch 已发送过）
        if (streamStarted && messageId) {
          fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, { messageId });
        }
        // 推送最后一条助手消息到浮动窗口（非空且非错误/中断时）
        if (accumulatedText && !abortedNotified) {
          const floatWin = ctx.windowManager.getFloatWindow();
          if (floatWin) {
            floatWin.send(MAIN_TO_RENDERER_CHANNELS.FLOAT_LAST_MESSAGE, accumulatedText);
          }
          // 完整窗口不可见时增加未读计数（推送到浮动窗口徽章）
          if (!fullWindow.isVisible()) {
            ctx.incrementUnreadCount();
          }
        }
      }
    }
    ctx.setAbortController(null);
    // 流式结束：托盘切回 idle 状态（绿色静态）
    ctx.trayManager?.setState('idle');
    // SSOT 挂载物卸载（用户设计定案 2026-08-10：资源层 vs 状态层模型）：
    // 任务流结束/停止/异常后广播 idle，渲染层据此把 sessionStatus 复位为 idle，
    // 卸载任务面板的暂停按钮等运行态挂载物（回到"空闲 = 无挂载物"的资源层常态）。
    // 暂停场景跳过：paused 态由内核 sessionPaused 事件广播，idle 广播会覆盖它。
    if (!pausedNotified && !fullWindow.isDestroyed()) {
      // 卸载运行态任务状态：清空检查点 plan/roundLog（该场景与"存进度到记忆"天然互斥——
      // 归档按钮门控在 paused 态，而 paused 已跳过本分支，plan 保留供归档提取快照）
      agent.clearPlan();
      broadcastStatus(ctx, 'idle');
    }
  }
}
