/**
 * 消息操作逻辑 — 重新生成 / 忘记 / 跨组遍历 / 删除清理
 *
 * 职责：
 * - handleRegenerate：重新生成指定精灵消息的回复
 * - findPreviousUserMessage：跨 message-group 查找上一条用户消息
 * - findNextAssistantMessage：跨 message-group 查找下一条精灵消息
 * - removeMessageAndCleanupGroup：删除消息元素并清理空的 group 容器
 * - handleForget：忘记操作（删除消息对，UI 软删除）
 *
 * 设计原则：
 * - 纯函数 + Host 依赖注入，无实例状态
 * - 5 个方法相互调用形成内部小闭环，整体独立性高
 * - 从 chatPanelManager.ts 提取（零行为变更，纯结构重构）
 */

import type { ChatPanelHost } from '../panels/chatPanelManager.js';
import { TOAST_SHORT_MS } from '../../../sprite/constants.js';

/**
 * 消息操作上下文（依赖注入）
 *
 * ChatPanelManager 通过此接口向提取的函数提供 host 回调。
 */
export interface MessageOperationContext {
  /** ChatPanelManager 的 host 实例（提供流式状态查询 + toast + 重新生成 + 确认弹窗） */
  host: ChatPanelHost;
}

/**
 * 处理重新生成操作（右键菜单"重新生成"触发）
 *
 * 流程：
 * 1. 流式状态检查（避免并行对话）
 * 2. 跨 group 查找上一条用户消息
 * 3. 提取用户消息文本
 * 4. 删除当前精灵消息
 * 5. 调用 host.regenerateLastMessage 重新发送
 *
 * @param ctx 消息操作上下文
 * @param messageEl 被右键点击的精灵消息 DOM 元素
 */
export function handleRegenerate(ctx: MessageOperationContext, messageEl: HTMLElement): void {
  if (ctx.host.isStreaming()) {
    ctx.host.showToast('精灵正在回复中，请等待完成或点击停止', 'warning');
    return;
  }

  const userMessageEl = findPreviousUserMessage(messageEl);
  if (!userMessageEl) {
    ctx.host.showToast('找不到对应的用户消息', 'error');
    return;
  }

  const userBubble = userMessageEl.querySelector('.message-bubble');
  const userContent = userBubble?.textContent ?? '';
  if (!userContent.trim()) {
    ctx.host.showToast('用户消息内容为空', 'error');
    return;
  }

  messageEl.remove();
  ctx.host.regenerateLastMessage(userContent);
}

/**
 * 查找指定精灵消息的上一条用户消息（跨 message-group 遍历）
 *
 * Phase 1 消息分组后，user 和 assistant 分属不同 .message-group 容器，
 * previousElementSibling 仅在同一 group 内遍历无法跨 group。
 * 修复：先跳到父 group，再跨 group 向前遍历，在每个 group 内取最后一条 user。
 *
 * @param assistantMessageEl 精灵消息元素
 * @returns 上一条用户消息元素，找不到返回 null
 */
export function findPreviousUserMessage(assistantMessageEl: HTMLElement): HTMLElement | null {
  // 跳到所属 group（或自身就是顶层消息时直接遍历）
  // closest() 属动态 DOM 遍历，返回值用 instanceof HTMLElement 前置判断（元素确实可能不存在）
  let searchFrom: HTMLElement = assistantMessageEl;
  const ownGroup = assistantMessageEl.closest('.message-group');
  if (ownGroup instanceof HTMLElement) searchFrom = ownGroup;

  // previousElementSibling 返回 Element | null，遍历用 instanceof HTMLElement 收窄
  let prev: Element | null = searchFrom.previousElementSibling;
  while (prev) {
    // 在 prev 中查找 user 消息（group 内可能有多条，取最后一条）
    const userMsgs = prev.querySelectorAll('.message.user');
    if (userMsgs.length > 0) {
      // 数组元素为 Element，返回前用 instanceof HTMLElement 收窄
      const lastUserMsg = userMsgs[userMsgs.length - 1];
      if (lastUserMsg instanceof HTMLElement) return lastUserMsg;
    }
    // 兜底：prev 本身就是 .message.user（非 group 场景）
    if (prev instanceof HTMLElement && prev.classList.contains('message') && prev.classList.contains('user')) {
      return prev;
    }
    prev = prev.previousElementSibling;
  }
  return null;
}

/**
 * 查找指定用户消息的下一条精灵消息（跨 message-group 遍历）
 *
 * 与 findPreviousUserMessage 对称，用于"忘记"操作删除 user 时找对应 assistant。
 *
 * @param userMessageEl 用户消息元素
 * @returns 下一条精灵消息元素，找不到返回 null
 */
export function findNextAssistantMessage(userMessageEl: HTMLElement): HTMLElement | null {
  let searchFrom: HTMLElement = userMessageEl;
  // closest() 属动态 DOM 遍历，返回值用 instanceof HTMLElement 前置判断
  const ownGroup = userMessageEl.closest('.message-group');
  if (ownGroup instanceof HTMLElement) searchFrom = ownGroup;

  // nextElementSibling 返回 Element | null，遍历用 instanceof HTMLElement 收窄
  let next: Element | null = searchFrom.nextElementSibling;
  while (next) {
    const assistantMsgs = next.querySelectorAll('.message.assistant');
    if (assistantMsgs.length > 0) {
      // 数组元素为 Element，返回前用 instanceof HTMLElement 收窄
      const firstAssistantMsg = assistantMsgs[0];
      if (firstAssistantMsg instanceof HTMLElement) return firstAssistantMsg;
    }
    if (next instanceof HTMLElement && next.classList.contains('message') && next.classList.contains('assistant')) {
      return next;
    }
    next = next.nextElementSibling;
  }
  return null;
}

/**
 * 删除消息元素并清理空的 message-group 容器
 *
 * 消息删除后 group 可能变空，需移除空容器避免 DOM 残留影响后续遍历。
 *
 * @param messageEl 待删除的消息元素
 */
export function removeMessageAndCleanupGroup(messageEl: HTMLElement): void {
  const group = messageEl.closest('.message-group');
  messageEl.remove();
  if (group && group.children.length === 0) {
    group.remove();
  }
}

/**
 * 处理忘记操作（右键菜单"忘记"触发）
 *
 * 从 UI 中移除消息对（用户消息 + 对应的精灵回复）。
 * 注意：这是 UI 层的软删除，刷新或重启后消息会重新出现，
 * 符合"忘记"的语义——暂时从视野中移除，而非永久删除。
 *
 * 操作前弹二次确认弹窗，避免误触；toast 文案明确告知"刷新后可恢复"，
 * 消除用户对数据丢失的焦虑。
 *
 * 如果右键的是精灵消息：删除精灵消息 + 上一条用户消息
 * 如果右键的是用户消息：删除用户消息 + 下一条精灵消息
 *
 * @param ctx 消息操作上下文
 * @param _messageId 消息 ID（当前未使用，未来持久化时使用）
 * @param messageEl 被右键点击的消息 DOM 元素
 */
export async function handleForget(
  ctx: MessageOperationContext,
  _messageId: string,
  messageEl: HTMLElement,
): Promise<void> {
  // 二次确认：避免误触移除消息对（虽是软删除，但会同时移除用户输入+精灵回复）
  const confirmed = await ctx.host.showConfirmDialog({
    title: '忘记此条对话',
    message: '将这条对话（你的消息和精灵的回复）从当前视野中移除，刷新后可恢复。',
    confirmText: '忘记',
    cancelText: '取消',
    danger: true,
  });
  if (!confirmed) return;

  const isUser = messageEl.classList.contains('user');
  const isAssistant = messageEl.classList.contains('assistant');

  if (isUser) {
    // 用户消息：删除当前用户消息 + 下一条精灵消息（跨 group 查找）
    const nextAssistant = findNextAssistantMessage(messageEl);
    if (nextAssistant) {
      removeMessageAndCleanupGroup(nextAssistant);
    }
    removeMessageAndCleanupGroup(messageEl);
  } else if (isAssistant) {
    // 精灵消息：删除上一条用户消息 + 当前精灵消息（跨 group 查找）
    const prevUser = findPreviousUserMessage(messageEl);
    if (prevUser) {
      removeMessageAndCleanupGroup(prevUser);
    }
    removeMessageAndCleanupGroup(messageEl);
  }

  ctx.host.showToast('已从本次对话移除，刷新后可恢复', 'success', TOAST_SHORT_MS);
}
