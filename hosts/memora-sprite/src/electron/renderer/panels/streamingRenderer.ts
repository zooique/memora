/**
 * 流式渲染核心（从 chatPanelManager.ts 提取）
 *
 * 职责：
 *   - updateStreamingMessage：RAF 节流的流式文本更新（纯文本显示，避免 O(n²) Markdown 渲染）
 *   - finishStreamingMessage：流式结束处理（一次性 Markdown 渲染 + 复制按钮）
 *   - addCopyButtonToMessage：为已完成的消息添加复制按钮
 *   - cancelPendingRaf：取消挂起的 RAF 回调（供 stopAllStreaming/markStreamingAborted 等复用）
 *
 * 提取原因：
 *   chatPanelManager.ts 1446 行超标，流式 RAF 核心 ~220 行
 *   是相对独立的子功能，提取为 context 注入式纯函数降低 chatPanelManager 体量。
 *
 * 设计（context 注入）：
 *   - 状态通过 StreamingRendererContext 共享（pendingRaf/rafHandle/latestStreamText/...）
 *   - 保留 RAF 节流逻辑：pendingRaf + rafHandle 的取消/重用
 *   - 流式期间使用 textContent 纯文本显示（O(1)），结束时一次性渲染 Markdown
 *   - 保留元素（cursor/memory-recall/tool-call/truncation）在 RAF 回调中重新查询
 */

import { clearElement } from '../helpers/domHelpers.js';
import { setIcon } from '../helpers/icon.js';
import { renderMarkdown } from '../components/markdown.js';
import { reportError } from '../helpers/errorHelpers.js';

/** 流式渲染上下文（状态 + 回调注入） */
export interface StreamingRendererContext {
  /** 活跃的流式消息映射（messageId → DOM 元素，与 ChatPanelManager 共享引用） */
  readonly streamingMessages: Map<string, HTMLElement>;
  /** RAF 是否挂起（节流标志，避免重复 requestAnimationFrame） */
  pendingRaf: boolean;
  /** requestAnimationFrame 句柄（cleanup 时取消挂起回调） */
  rafHandle: number | null;
  /** 最新流式文本内容（RAF 回调中使用） */
  latestStreamText: string;
  /** 最新流式消息 ID（RAF 回调中使用） */
  latestStreamMessageId: string;
  /** 自动滚动到底部（用户在底部附近时） */
  scrollToBottom(): void;
  /** 重置安全兜底定时器（每次收到 chunk 时调用） */
  onSafetyTimerReset(): void;
  /** 清除安全兜底定时器（流式正常结束时调用） */
  onSafetyTimerClear(): void;
  /** 设置流式输出状态 */
  setStreaming(streaming: boolean): void;
  /** 更新发送/停止按钮状态 */
  updateSendButton(): void;
}

/**
 * 更新流式消息内容
 *
 * 性能优化策略（CHAT-A01）：
 * 流式期间使用 textContent 纯文本显示 + 光标，不调用 renderMarkdown。
 * 原因：每次 chunk 对累积完整文本做全量 Markdown 渲染是 O(n²) 复杂度，
 * 复杂问答（5000+字、N 个 chunk）会直接卡死 UI。
 * 流式结束后由 finishStreamingMessage 一次性渲染完整 Markdown。
 *
 * 保留 cursor 元素和 memory-recall 元素。
 *
 * @param ctx 渲染上下文（状态 + 回调）
 * @param messageId 流式消息 ID
 * @param text 最新累积文本
 */
export function updateStreamingMessage(ctx: StreamingRendererContext, messageId: string, text: string): void {
  const el = ctx.streamingMessages.get(messageId);
  if (!el) return;

  // 每次收到新 chunk 重置超时兜底定时器（30 秒无新 chunk 则判定为卡死）
  ctx.onSafetyTimerReset();

  // 定位到气泡元素（assistant 消息结构：message > message-bubble）
  // bubble 由 createStreamingMessage() 保证存在（非 system 消息始终有 .message-bubble 子元素）
  const bubble = el.querySelector('.message-bubble')!;

  // 移除思考阶段指示器（text chunk 到达意味着思考阶段结束）
  const thinkingIndicator = bubble.querySelector('.thinking-phase');
  if (thinkingIndicator) {
    thinkingIndicator.remove();
  }

  // 存储最新文本，rAF 回调中统一执行纯文本更新
  ctx.latestStreamText = text;
  ctx.latestStreamMessageId = messageId;
  if (!ctx.pendingRaf) {
    ctx.pendingRaf = true;
    // 保存句柄，cleanup 时可取消挂起的回调
    ctx.rafHandle = requestAnimationFrame(() => {
      ctx.pendingRaf = false;
      ctx.rafHandle = null;
      // 重新定位气泡（可能已被 finishStreamingMessage 处理）
      const latestEl = ctx.streamingMessages.get(ctx.latestStreamMessageId);
      const latestBubble = latestEl?.querySelector('.message-bubble');
      if (!latestBubble) return;

      // 重新查询保留元素（rAF 回调中 DOM 可能已变化）
      const latestCursor = latestBubble.querySelector('.cursor');
      const latestRecall = latestBubble.querySelector('.memory-recall-container');
      const latestToolCalls = latestBubble.querySelectorAll('.tool-call-card');
      // 截断提示需跨 chunk 保留（用户需持续可见截断状态）
      const latestTruncation = latestBubble.querySelector('.truncation-notice');

      // 流式期间使用纯文本显示（O(1) 操作），不调用 renderMarkdown
      // 创建一个临时容器存放纯文本，避免破坏保留元素
      const textContainer = document.createElement('div');
      textContainer.className = 'streaming-text';
      textContainer.textContent = ctx.latestStreamText;
      // 白空格保留：代码块等格式在流式期间需要正确的换行显示
      textContainer.style.whiteSpace = 'pre-wrap';

      clearElement(latestBubble);
      // 截断提示在 bubble 顶部（文本之前）
      if (latestTruncation) latestBubble.appendChild(latestTruncation);
      latestBubble.appendChild(textContainer);

      // 重新追加保留元素（recall 和 tool-call 在文本后，cursor 在最后）
      if (latestRecall) latestBubble.appendChild(latestRecall);
      for (const tc of Array.from(latestToolCalls)) {
        latestBubble.appendChild(tc);
      }
      // 光标始终在文本末尾
      if (latestCursor) {
        textContainer.appendChild(latestCursor);
      }

      // DOM 更新完成后再滚动，确保滚动位置准确
      ctx.scrollToBottom();
    });
  }
}

/**
 * 完成流式消息
 *
 * 性能优化策略（CHAT-A02）：
 * 流式期间使用纯文本显示，结束时一次性渲染完整 Markdown。
 * 如果 rAF 还在 pending，取消它（避免纯文本和 Markdown 两次渲染竞争），
 * 然后同步执行一次完整 Markdown 渲染。
 *
 * 移除 streaming 类和光标元素，添加复制按钮。
 *
 * @param ctx 渲染上下文（状态 + 回调）
 * @param messageId 流式消息 ID
 */
export function finishStreamingMessage(ctx: StreamingRendererContext, messageId: string): void {
  const el = ctx.streamingMessages.get(messageId);
  if (!el) return;

  // 取消挂起的 rAF（无论是否 pending），避免纯文本渲染与最终 Markdown 渲染竞争
  cancelPendingRaf(ctx);

  const bubble = el.querySelector('.message-bubble');
  if (bubble && ctx.latestStreamText) {
    try {
      // 保留 recall/tool-call/truncation 元素
      const flushRecall = bubble.querySelector('.memory-recall-container');
      const flushToolCalls = bubble.querySelectorAll('.tool-call-card');
      const flushTruncation = bubble.querySelector('.truncation-notice');

      // 一次性渲染完整 Markdown（从纯文本切换到格式化输出）
      clearElement(bubble);
      // 截断提示在 bubble 顶部（Markdown 之前）
      if (flushTruncation) bubble.appendChild(flushTruncation);
      bubble.appendChild(renderMarkdown(ctx.latestStreamText));

      // 重新追加保留元素
      if (flushRecall) bubble.appendChild(flushRecall);
      flushToolCalls.forEach((tc) => bubble.appendChild(tc));
    } catch (err) {
      // 渲染异常时不阻塞收尾流程，保留旧 DOM
      reportError('finishStreamingMessage', err);
    }
  }

  el.classList.remove('streaming');
  // 移除光标元素
  const cursor = el.querySelector('.cursor');
  if (cursor) cursor.remove();

  // 移除思考阶段指示器（如"正在归档"等），流式结束后不应继续显示
  const thinkingPhase = el.querySelector('.thinking-phase');
  if (thinkingPhase) thinkingPhase.remove();

  // 流式完成后添加复制按钮（复用缓存的文本，无需 cloneNode）
  addCopyButtonToMessage(ctx, el);

  ctx.streamingMessages.delete(messageId);

  // 所有流式消息都已完成时，重置 isStreaming 状态和按钮
  if (ctx.streamingMessages.size === 0) {
    ctx.setStreaming(false);
    // 清除超时兜底定时器（正常结束）
    ctx.onSafetyTimerClear();
    ctx.updateSendButton();

    // 流式完成时通知屏幕阅读器（不对逐字追加设 aria-live，避免频繁播报）
    const liveRegion = document.getElementById('stream-live-region');
    if (liveRegion) {
      liveRegion.textContent = '新消息已就绪';
    }
  }
}

/**
 * 为已完成的助手消息添加复制按钮
 *
 * 性能优化（CHAT-A04）：
 * 使用 cloneNode(true) 深克隆整个气泡 + textContent 全树遍历提取文本，
 * 长消息（DOM 节点上千）各为 O(n)。
 * 优先复用 latestStreamText（流式期间缓存的累积文本），避免 DOM 反向提取。
 *
 * @param ctx 渲染上下文（读取 latestStreamText/latestStreamMessageId 缓存）
 * @param el 消息 DOM 元素（.message 容器）
 */
export function addCopyButtonToMessage(ctx: StreamingRendererContext, el: HTMLElement): void {
  const bubble = el.querySelector('.message-bubble');
  const contentWrapper = el.querySelector('.message-content');
  if (!bubble || !contentWrapper) return;

  // 避免重复添加（幂等保护）
  if (contentWrapper.querySelector('.message-copy-btn')) return;

  // 优先复用流式期间缓存的文本（O(1)），避免 cloneNode + textContent 的 O(n) 操作
  // 仅在缓存不可用时回退到 DOM 提取（如非流式消息的历史加载场景）
  let finalText: string;
  if (ctx.latestStreamText && ctx.latestStreamMessageId) {
    finalText = ctx.latestStreamText;
  } else {
    // 回退路径：从 DOM 提取纯文本（排除 UI 元信息元素）
    const clone = bubble.cloneNode(true);
    if (!(clone instanceof HTMLElement)) return;
    const recallInClone = clone.querySelector('.memory-recall');
    if (recallInClone) recallInClone.remove();
    const abortedInClone = clone.querySelector('.stream-aborted');
    if (abortedInClone) abortedInClone.remove();
    const errorInClone = clone.querySelector('.stream-error');
    if (errorInClone) errorInClone.remove();
    const thinkingInClone = clone.querySelector('.thinking-phase');
    if (thinkingInClone) thinkingInClone.remove();
    clone.querySelectorAll('.md-code-header').forEach((h) => h.remove());
    finalText = clone.textContent ?? '';
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'message-copy-btn';
  copyBtn.title = '复制';
  // aria-label 为屏幕阅读器提供可访问名称（icon-only 按钮必需）
  copyBtn.setAttribute('aria-label', '复制');
  // 使用 SVG 图标替代 emoji
  setIcon(copyBtn, 'icon-copy');
  // 使用 data-action 属性替代直接 addEventListener，由构造函数中的事件委托统一处理
  copyBtn.dataset.action = 'copy';
  copyBtn.dataset.content = finalText;

  // 查找或创建 metaRow，将复制按钮插入到时间戳之前
  // 精灵消息含 persona 标签时，metaRow 内有 .message-actions 容器包裹操作按钮组，复制按钮应插入到该容器内
  let metaRow = contentWrapper.querySelector('.message-meta');
  const timeEl = contentWrapper.querySelector('.message-time');
  // 优先使用 .message-actions 容器（精灵消息含 persona 时存在），否则回退到 metaRow
  const actionsContainer = contentWrapper.querySelector('.message-actions');
  const insertTarget = actionsContainer ?? metaRow;
  if (insertTarget) {
    // 容器已存在，插入到时间戳之前
    if (timeEl) {
      insertTarget.insertBefore(copyBtn, timeEl);
    } else {
      insertTarget.appendChild(copyBtn);
    }
  } else if (timeEl && timeEl.parentNode) {
    // metaRow 不存在（旧结构），创建并包裹时间戳
    metaRow = document.createElement('div');
    metaRow.className = 'message-meta';
    metaRow.appendChild(copyBtn);
    timeEl.parentNode.insertBefore(metaRow, timeEl);
    metaRow.appendChild(timeEl);
  } else {
    contentWrapper.appendChild(copyBtn);
  }
}

/**
 * 取消挂起的 RAF 回调
 *
 * 供 cleanup/stopAllStreaming/markStreamingAborted/injectErrorToStreamingMessages 复用，
 * 统一 RAF 取消 + 状态重置逻辑（原散落在 4 处的重复代码）。
 *
 * @param ctx 渲染上下文（重置 pendingRaf + rafHandle）
 */
export function cancelPendingRaf(ctx: StreamingRendererContext): void {
  if (ctx.rafHandle !== null) {
    cancelAnimationFrame(ctx.rafHandle);
    ctx.rafHandle = null;
    ctx.pendingRaf = false;
  }
}
