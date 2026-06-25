/**
 * 对话相关 IPC 处理器
 *
 * 职责：
 *   1. 用户输入处理（消费 agent.chat() AsyncGenerator，流式输出到渲染进程）
 *   2. 对话中断（AbortController + reason 携带中断原因）
 *
 * 流式输出架构（方案 §6.2 排雷修正）：
 *   主进程直接消费 agent.chat()，通过专用 IPC 通道发送 chunk，
 *   不走 IInteraction（IInteraction 仅负责非流式输出）。
 */

import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import { toError } from 'memora';
import { errorHandler, ErrorCode } from '../errorHandler.js';
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from './channels.js';
import type { IpcContext } from './types.js';
import { getLocalDate } from '../../sprite/constants.js';

/**
 * 注册对话相关 IPC 处理器
 *
 * @param ctx IPC 上下文
 */
export function registerChatHandlers(ctx: IpcContext): void {
  /**
   * 用户输入处理 — 消费 agent.chat() AsyncGenerator
   *
   * 流式输出架构：主进程直接消费 agent.chat()，通过专用 IPC 通道发送 chunk。
   */
  ipcMain.on(IPC_CHANNELS.USER_INPUT, (_event, text: string) => {
    void handleUserInput(text, ctx);
  });

  /** 中断当前对话 */
  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT, async () => {
    // P2-DESIGN-7 修复：使用 AbortController.reason 携带中断原因，替代共享布尔标志
    const ctrl = ctx.getAbortController();
    if (ctrl) {
      // 使用 DOMException 模拟标准 AbortController.abort(reason) 行为
      // reason='user' 标识用户主动中断，catch 块据此发送系统消息
      ctrl.abort(new DOMException('用户手动停止', 'AbortError'));
      ctx.setAbortController(null);
    }
    return { aborted: true };
  });
}

/**
 * 处理用户输入 — 消费 agent.chat() AsyncGenerator 并推送流式 chunk
 *
 * 实现方案 §6.2 流式输出架构：
 * - 主进程直接消费 agent.chat() 的 AsyncGenerator
 * - 通过 sprite-stream-start / sprite-stream-chunk / sprite-stream-end 通道推送
 * - 支持 AbortController 中断
 */
export async function handleUserInput(text: string, ctx: IpcContext): Promise<void> {
  const fullWindow = ctx.windowManager.getFullWindow();
  if (!fullWindow || fullWindow.isDestroyed()) return;

  // P1 修复：Agent 未就绪时拒绝（reinitAgent 失败后旧 Agent 已关闭，新对话会抛错）
  if (!ctx.isAgentReady()) {
    fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, {
      text: 'Agent 未就绪，请在设置面板中重新配置 LLM 后重试',
    });
    return;
  }

  // P1 修复：竞态保护——已有进行中的对话时拒绝，避免 Agent 并发锁抛"对话繁忙"错误。
  if (ctx.getAbortController()) {
    fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, {
      text: '上一条消息仍在处理中，请等待完成或点击停止后再发送',
    });
    return;
  }

  // UT-FQ-01 跨日/跨会话自动重置：确保新消息始终归当天主会话
  const history = ctx.agent.agentHistory;
  if (history) {
    const todayDate = getLocalDate();
    if (history.currentDateValue !== todayDate) {
      // 重置到当天 main 会话：更新 currentDate/currentSession + 加载当天已有消息
      const restoredCount = await ctx.agent.sessionManager.restoreSession(todayDate, 'main');
      // restoreSession 仅在有消息时写入工作记忆；无消息时旧上下文残留需手动清理
      if (restoredCount === 0 && ctx.agent.agentLoop) {
        ctx.agent.agentLoop.restoreHistory([]);
      }
    }
  }

  const messageId = randomUUID();
  fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START, { messageId });

  // 完整窗口不可见时增加未读计数（推送到浮动窗口徽章）
  if (!fullWindow.isVisible()) {
    ctx.incrementUnreadCount();
  }

  // 托盘切换为 active 状态（蓝色 + 脉冲），表示精灵正在思考
  ctx.trayManager?.setState('active');

  // 创建 AbortController 供中断使用
  const abortController = new AbortController();
  ctx.setAbortController(abortController);

  // OBS-02：记录对话开始前的截断次数，对话结束后对比检测截断事件
  const truncationBefore = ctx.agent.getMetrics().context.truncationCount;

  try {
    // 每次 chunk 发送累积完整文本（非 delta），保证渲染层拼接完整
    let accumulatedText = '';
    for await (const chunk of ctx.agent.chat(text, abortController.signal)) {
      // 检查窗口是否仍然可用
      if (fullWindow.isDestroyed()) break;

      if (chunk.type === 'text') {
        // 累积 delta 后发送完整文本，渲染层清空重渲染也不会丢失内容
        accumulatedText += chunk.content;
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK, {
          messageId,
          text: accumulatedText,
        });
      } else if (chunk.type === 'recall') {
        // MS-12 召回透明度：推送召回记忆摘要到渲染层，在消息底部展示
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_RECALL, {
          messageId,
          memories: chunk.memories,
        });
      } else if (chunk.type === 'tool_start') {
        // UX-P1-02 工具调用开始：推送工具名和参数，UI 渲染工具调用卡片
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_START, {
          messageId,
          toolCallId: chunk.toolCallId,
          name: chunk.name,
          args: chunk.args,
        });
      } else if (chunk.type === 'tool_result') {
        // UX-P1-02 工具调用结果：推送工具名、成功状态和摘要，UI 更新工具卡片状态
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_TOOL_RESULT, {
          messageId,
          toolCallId: chunk.toolCallId,
          name: chunk.name,
          ok: chunk.ok,
          summary: chunk.summary,
        });
      } else if (chunk.type === 'thinking') {
        // UX-P2-01 思考阶段指示：推送阶段名称，UI 显示"正在回忆.../处理.../归档..."
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_THINKING, {
          messageId,
          phase: chunk.phase,
        });
      } else if (chunk.type === 'done') {
        // OBS-02：对话正常结束时检测截断次数是否增加
        const truncationAfter = ctx.agent.getMetrics().context.truncationCount;
        if (truncationAfter > truncationBefore) {
          fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_CONTEXT_TRUNCATED, {
            messageId,
            count: truncationAfter - truncationBefore,
          });
        }
        // done 信号：不 break，让 for-await 自然结束。
        // agent.chat() 在 done 后仍需执行 appendAssistant（保存助手消息）
        // 和 postProcess（归档后处理），break 会导致 return() 被调用，
        // 跳过这些关键步骤。finally 块会在 generator 自然结束后发送 SPRITE_STREAM_END。
      } else if (chunk.type === 'aborted') {
        // UX-PP-04 中断系统消息（在 finally 发送 SPRITE_STREAM_END 之前）
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT, {
          text: `[已中断：${chunk.reason}]`,
          kind: 'system',
        });
        // aborted 信号：停止处理后续 chunk，由 finally 统一发送 SPRITE_STREAM_END
        break;
      }
    }
  } catch (error) {
    if (!fullWindow.isDestroyed()) {
      // P2-DESIGN-7 修复：通过 AbortController.reason 判断是否用户主动中断（替代共享布尔标志）
      const ctrl = ctx.getAbortController();
      const abortReason = ctrl?.signal.reason;
      const wasUserAborted = abortReason instanceof DOMException && abortReason.name === 'AbortError';
      // UX-PP-04 用户主动中断时，catch 块也需发送系统消息告知用户
      if (wasUserAborted) {
        fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT, {
          text: '[已中断：用户手动停止]',
          kind: 'system',
        });
      }
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, {
        text: `对话出错：${toError(error).message}`,
      });
    }
    // 错误路径：由 finally 统一发送 SPRITE_STREAM_END
    errorHandler.handle(error, { code: ErrorCode.API_ERROR, context: '对话流式输出失败' });
  } finally {
    // 无论生成器以何种方式退出（done/aborted/异常/窗口销毁），都确保发送 SPRITE_STREAM_END。
    // 修复根因：原架构中 done/aborted 时直接发送 SPRITE_STREAM_END 并 break，但异常路径依赖
    // catch 块正常执行。如果 catch 内部再次抛出、窗口在 catch 执行前销毁、或生成器以其他方式
    // 终止，SPRITE_STREAM_END 将不会发送，导致渲染进程 isStreaming 永远卡在 true。
    if (!fullWindow.isDestroyed()) {
      fullWindow.webContents.send(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, { messageId });
    }
    ctx.setAbortController(null);
    // 流式结束：托盘切回 idle 状态（绿色静态）
    ctx.trayManager?.setState('idle');
  }
}
