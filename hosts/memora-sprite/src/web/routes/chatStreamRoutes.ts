/**
 * 对话流式 SSE 路由（DWM-01 Phase 2：Web 模式 SSE 流式对话）
 *
 * 与 electron/ipc/chatStreamHandler.ts 镜像，复用 agent.chat() AsyncGenerator。
 *
 * 路由表：
 *   POST /api/chat        → 启动流式对话（SSE 响应，text/event-stream）
 *   POST /api/chat/abort  → 中断进行中的对话
 *
 * SSE 事件协议（与 MAIN_TO_RENDERER_CHANNELS 平行）：
 *   event: start       data: {messageId}
 *   event: chunk       data: {messageId, text}              // 累积完整文本（非 delta）
 *   event: recall      data: {messageId, memories}
 *   event: tool_start  data: {messageId, toolCallId, name, args}
 *   event: tool_result data: {messageId, toolCallId, name, ok, summary}
 *   event: thinking    data: {messageId, phase}
 *   event: truncated   data: {messageId, count}
 *   event: aborted     data: {messageId, reason}
 *   event: error       data: {messageId, message}           // 业务错误（非中断）
 *   event: end         data: {messageId}                    // 流结束（必定发送）
 *
 * 关键设计（与 chatStreamHandler.ts 一致）：
 *   1. 无进展超时兜底（STREAM_NO_PROGRESS_TIMEOUT_MS = 60s）
 *   2. abortedNotified 单点路由（避免重复发送 aborted 事件）
 *   3. OBS-02 截断检测（done 时对比 truncationCount）
 *   4. 跨日/跨会话自动重置（确保新消息归当天 main 会话）
 *   5. AbortController.reason 区分用户中断 vs 异常
 *
 * 与 Electron 模式的差异：
 *   - Electron：ipcMain.on('user-input') + webContents.send（双向 IPC）
 *   - Web：POST /api/chat + SSE 响应（单向流式推送）
 *   - Web 模式无 windowManager / trayManager（ noop 降级）
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { toError, logger } from 'memora';
import { getLocalDate } from '../../sprite/constants.js';
import type { HostContext } from '../../shared/hostContext.js';
import { parseJsonBody, sendJson, sendError, safeRoute, SECURITY_HEADERS } from './types.js';

// ─── 常量 ──────────────────────────────────────────────────

/** 流式输出"无进展"超时阈值（毫秒），与 chatStreamHandler.ts 保持一致 */
const STREAM_NO_PROGRESS_TIMEOUT_MS = 60_000;

/** SSE 事件名常量（与 MAIN_TO_RENDERER_CHANNELS 平行） */
const SSE_EVENTS = {
  START: 'start',
  CHUNK: 'chunk',
  END: 'end',
  RECALL: 'recall',
  TOOL_START: 'tool_start',
  TOOL_RESULT: 'tool_result',
  THINKING: 'thinking',
  TRUNCATED: 'truncated',
  ABORTED: 'aborted',
  ERROR: 'error',
} as const;

// ─── SSE 写入辅助函数 ─────────────────────────────────────

/**
 * 写入 SSE 事件到响应流
 *
 * SSE 协议格式：
 *   event: <eventName>\n
 *   data: <json>\n\n
 *
 * @param res HTTP 响应对象
 * @param eventName SSE 事件名
 * @param data 事件数据对象（将被 JSON.stringify）
 */
function writeSSE(res: ServerResponse, eventName: string, data: unknown): void {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 判断错误是否为网络/连接类错误（SEC-WEB-02 辅助）
 *
 * 用于区分 LLM 调用中的网络故障（返回友好提示）与其他异常，避免把
 * 上游错误细节（如 fetch failed 原文、主机名、API 端点）回传客户端。
 *
 * 判断依据：
 *   1. Node/undici 网络错误码（ENOTFOUND/ECONNREFUSED/ECONNRESET 等）
 *   2. 错误消息中的网络相关关键词（兜底，覆盖未携带 code 的封装错误）
 *
 * @param error 待判断的错误对象
 * @returns true 表示网络类错误
 */
function isNetworkError(error: unknown): boolean {
  // 检查 Node/undici 错误码（原生网络错误会带 code 字段）
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      const NETWORK_CODES = [
        'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
        'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
        'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
      ];
      if (NETWORK_CODES.includes(code)) return true;
    }
  }
  // 检查错误消息关键词（兜底：覆盖被封装/重抛后丢失 code 的网络错误）
  const msg = toError(error).message.toLowerCase();
  return (
    msg.includes('fetch failed')
    || msg.includes('network')
    || msg.includes('econnrefused')
    || msg.includes('timed out')
    || msg.includes('getaddrinfo')
  );
}

// ─── 路由处理函数 ─────────────────────────────────────────

/**
 * 处理对话流式 SSE 路由
 *
 * @param req HTTP 请求对象
 * @param res HTTP 响应对象
 * @param ctx HostContext 实例
 */
export async function handleChatStreamRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HostContext,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = req.url ?? '';
  const path = url.split('?')[0] ?? url;

  logger.info({ method, path }, '[Web SSE] 收到对话请求');

  await safeRoute(res, '对话流式', async () => {
    // POST /api/chat/abort — 中断进行中的对话
    if (method === 'POST' && path === '/api/chat/abort') {
      const ctrl = ctx.getAbortController();
      if (ctrl) {
        // 使用 DOMException 模拟标准 AbortController.abort(reason) 行为
        // reason='AbortError' 标识用户主动中断，catch 块据此发送 aborted 事件
        ctrl.abort(new DOMException('用户手动停止', 'AbortError'));
        // 不在此处 setAbortController(null)：catch 块需通过 ctrl.signal.reason 判断中断类型
        // 清理统一由流式处理的 finally 块执行
      }
      sendJson(res, 200, { aborted: true });
      return;
    }

    // POST /api/chat — 启动流式对话（SSE 响应）
    if (method === 'POST' && path === '/api/chat') {
      await handleChatStart(req, res, ctx);
      return;
    }

    // SEC-WEB-05：不回显 path 防止用户输入注入到响应体或泄露路由细节，实际路径仅记录到服务端日志
    logger.info({ method, path }, '[Web SSE] 未匹配的对话路由');
    sendError(res, 404, '404 Not Found');
  });
}

/**
 * 启动流式对话（POST /api/chat）
 *
 * 消费 agent.chat() AsyncGenerator，将 chunk 通过 SSE 推送到客户端。
 * 包含无进展超时兜底、中断处理、错误降级等完整流式输出逻辑。
 *
 * @param req HTTP 请求对象
 * @param res HTTP 响应对象
 * @param ctx HostContext 实例
 */
async function handleChatStart(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HostContext,
): Promise<void> {
  // 解析请求体（用户输入文本）
  const body = await parseJsonBody<{ text: string }>(req);
  if (!body?.text || typeof body.text !== 'string' || body.text.length === 0) {
    sendError(res, 400, 'text 字段必填且必须是非空字符串');
    return;
  }
  // 输入长度校验（与 IPC isValidContent 对齐，防止超大文本耗尽内存/CPU）
  if (body.text.length > 100_000) {
    sendError(res, 400, '输入文本过长（超过 100KB 限制）');
    return;
  }

  // Agent 未就绪时拒绝（reinitAgent 失败后旧 Agent 已关闭）
  if (!ctx.isAgentReady()) {
    sendError(res, 503, 'Agent 未就绪，请先配置 LLM 提供商和 API Key');
    return;
  }

  // 竞态保护——已有进行中的对话时拒绝，避免 Agent 并发锁抛"对话繁忙"错误
  if (ctx.getAbortController()) {
    sendError(res, 409, '上一条消息仍在处理中，请等待完成或点击停止后再发送');
    return;
  }

  // 跨日/跨会话自动重置：确保新消息始终归当天主会话
  const history = ctx.agent.agentHistory;
  if (history) {
    const todayDate = getLocalDate();
    if (history.currentDateValue !== todayDate) {
      const sessionManager = ctx.agent.sessionManager;
      if (!sessionManager) {
        sendError(res, 503, '会话管理器未初始化，请稍后重试');
        return;
      }
      // 重置到当天 main 会话（先 switchSession 再 restoreSession，与其他路径一致）
      sessionManager.switchSession('main');
      const restoredCount = await sessionManager.restoreSession(todayDate, 'main');
      // restoreSession 仅在有消息时写入工作记忆；无消息时旧上下文残留需手动清理
      if (restoredCount === 0 && ctx.agent.agentLoop) {
        ctx.agent.agentLoop.restoreHistory([]);
      }
      logger.info({ todayDate, restoredCount }, '[Web SSE] 跨日自动重置到当天 main 会话');
    }
  }

  // 初始化 SSE 响应头（text/event-stream，禁用缓冲）
  // SEC-WEB-04：SSE 响应同样注入安全响应头（sendJson 路径已由 types.ts 统一注入）
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    // 禁用 Nagle 算法，降低小 chunk 延迟
    'X-Accel-Buffering': 'no',
  });

  // 生成消息 ID + 发送 start 事件
  const messageId = randomUUID();
  writeSSE(res, SSE_EVENTS.START, { messageId });

  // 创建 AbortController 供中断使用
  const abortController = new AbortController();
  ctx.setAbortController(abortController);

  // 客户端断开标志（监听 req 'close' 事件检测客户端 TCP 连接关闭）
  // 注意：res.writableEnded 仅在 res.end() 调用后为 true，不检测客户端断开；
  //       需要监听 req 'close' 事件才能正确感知客户端关闭连接/abort 取消
  let clientDisconnected = false;
  req.on('close', () => {
    clientDisconnected = true;
    // 客户端断开时立即中止 LLM 请求（释放锁和资源），
    // 防止服务端继续处理已无客户端接收的请求（导致锁泄漏、后续请求被 409 拒绝）
    if (!abortController.signal.aborted) {
      abortController.abort(new DOMException('客户端断开连接', 'AbortError'));
    }
  });

  // 无进展超时兜底定时器
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
      // 强制中断内核 generator
      abortController.abort(new DOMException('流式输出无进展超时', 'TimeoutError'));
      // 兜底清理：即使 generator 不响应 abort，也确保客户端收到 end 事件 + AbortController 释放
      writeSSE(res, SSE_EVENTS.ERROR, {
        messageId,
        message: '对话超时（长时间无响应），已自动停止。可点击重试或检查 LLM 配置',
      });
      writeSSE(res, SSE_EVENTS.END, { messageId });
      try {
        res.end();
      } catch {
        // res 已结束则忽略（幂等保护）
      }
      ctx.setAbortController(null);
      logger.warn({ context: '流式输出无进展超时' }, 'Web SSE 超时兜底触发');
    }, STREAM_NO_PROGRESS_TIMEOUT_MS);
  };
  // 启动首次计时
  resetStreamTimeout();

  // OBS-02：记录对话开始前的截断次数，对话结束后对比检测截断事件
  const truncationBefore = ctx.agent.getMetrics().context.truncationCount;

  // 中断事件已发送标志（单点路由，避免重复发送 aborted 事件）
  let abortedNotified = false;

  try {
    // 每次 chunk 发送累积完整文本（非 delta），保证客户端拼接完整
    let accumulatedText = '';
    for await (const chunk of ctx.agent.chat(body.text, abortController.signal)) {
      // 超时已被强制清理，则退出循环（break 会触发 generator return()）
      if (streamTimedOut) break;
      // 客户端断开连接或响应已结束/销毁时退出
      // clientDisconnected 由 req 'close' 事件设置；writableEnded 由 res.end() 设置；destroyed 由 socket 关闭设置
      if (clientDisconnected || res.writableEnded || res.destroyed) break;
      // 每个 chunk 到达即重置无进展定时器
      resetStreamTimeout();

      if (chunk.type === 'text') {
        // 累积 delta 后发送完整文本
        accumulatedText += chunk.content;
        writeSSE(res, SSE_EVENTS.CHUNK, { messageId, text: accumulatedText });
      } else if (chunk.type === 'recall') {
        // 召回透明度：推送召回记忆摘要到客户端
        writeSSE(res, SSE_EVENTS.RECALL, { messageId, memories: chunk.memories });
      } else if (chunk.type === 'tool_start') {
        // 工具调用开始
        writeSSE(res, SSE_EVENTS.TOOL_START, {
          messageId,
          toolCallId: chunk.toolCallId,
          name: chunk.name,
          args: chunk.args,
        });
      } else if (chunk.type === 'tool_result') {
        // 工具调用结果
        writeSSE(res, SSE_EVENTS.TOOL_RESULT, {
          messageId,
          toolCallId: chunk.toolCallId,
          name: chunk.name,
          ok: chunk.ok,
          summary: chunk.summary,
        });
      } else if (chunk.type === 'thinking') {
        // 思考阶段指示
        writeSSE(res, SSE_EVENTS.THINKING, { messageId, phase: chunk.phase });
      } else if (chunk.type === 'done') {
        // OBS-02：对话正常结束时检测截断次数是否增加
        const truncationAfter = ctx.agent.getMetrics().context.truncationCount;
        if (truncationAfter > truncationBefore) {
          writeSSE(res, SSE_EVENTS.TRUNCATED, {
            messageId,
            count: truncationAfter - truncationBefore,
          });
        }
        // done 后 agent.chat() 仍要执行 appendAssistant + postProcess
        // 发 thinking keepalive（phase=archiving）让客户端重置 safety timer，覆盖此窗口
        writeSSE(res, SSE_EVENTS.THINKING, { messageId, phase: 'archiving' });
        // done 信号：不 break，让 for-await 自然结束
      } else if (chunk.type === 'error') {
        // 内核 yield error chunk（如 LLM 超时、连接断开）
        // 标记 abortedNotified 让 finally 不重复发 ABORTED
        abortedNotified = true;
        writeSSE(res, SSE_EVENTS.ABORTED, { messageId, reason: chunk.message });
        break;
      } else if (chunk.type === 'aborted') {
        // 内核主动 yield aborted chunk 时通知客户端
        abortedNotified = true;
        writeSSE(res, SSE_EVENTS.ABORTED, { messageId, reason: chunk.reason });
        break;
      }
    }
  } catch (error) {
    // 超时已在定时器内完成清理，跳过 catch 后续逻辑（finally 仍会执行定时器清理）
    if (streamTimedOut) return;
    // 通过 AbortController.reason 判断是否用户主动中断
    const ctrl = ctx.getAbortController();
    const abortReason = ctrl?.signal.reason;
    const wasUserAborted = abortReason instanceof DOMException && abortReason.name === 'AbortError';

    // 单点路由：仅当 aborted chunk 路径未发送过时才发送
    if (!abortedNotified) {
      if (wasUserAborted) {
        writeSSE(res, SSE_EVENTS.ABORTED, { messageId, reason: '用户手动停止' });
        abortedNotified = true;
      } else {
        // SEC-WEB-02：对错误分类，不回传 LLM/网络错误的原始细节，避免信息泄露
        // - 网络类错误（DNS 失败/连接拒绝/超时等）→ 提示检查网络或 LLM 配置
        // - 其他错误（如内核异常）→ 通用"对话出错，请重试"
        const friendlyMessage = isNetworkError(error)
          ? '对话服务暂不可用，请检查网络或 LLM 配置'
          : '对话出错，请重试';
        writeSSE(res, SSE_EVENTS.ERROR, {
          messageId,
          message: friendlyMessage,
        });
      }
    }
    // 用户主动中断不记录为错误；其他错误才记录
    if (!wasUserAborted) {
      logger.error({ err: toError(error).message }, 'Web SSE 对话流式输出失败');
    }
  } finally {
    // 清理无进展超时定时器
    if (streamTimeoutTimer !== null) {
      clearTimeout(streamTimeoutTimer);
      streamTimeoutTimer = null;
    }
    // 超时路径已在定时器内发送过 END + 清理 AbortController，此处跳过避免重复
    if (!streamTimedOut) {
      // 客户端未断开且响应未结束时，发送 END 事件并关闭响应
      // clientDisconnected 表示 TCP 连接已关闭，此时写入会抛错，直接跳过
      if (!clientDisconnected && !res.writableEnded) {
        try {
          writeSSE(res, SSE_EVENTS.END, { messageId });
          res.end();
        } catch {
          // 写入失败（连接已关闭），忽略
        }
      }
      ctx.setAbortController(null);
    }
  }
}
