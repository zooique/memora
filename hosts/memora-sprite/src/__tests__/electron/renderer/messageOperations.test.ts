/**
 * 消息操作逻辑测试 — 重新生成 / 忘记 / 跨组遍历 / 删除清理
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - handleRegenerate：流式状态检查、找不到用户消息、空内容、成功路径
 * - findPreviousUserMessage：跨 group 遍历、同 group 兜底、找不到
 * - findNextAssistantMessage：跨 group 遍历、同 group 兜底、找不到
 * - removeMessageAndCleanupGroup：删除消息、清理空 group、保留非空 group
 * - handleForget：取消确认、user 分支、assistant 分支、toast 反馈
 *
 * Mock 策略：
 * - JSDOM 提供真实 DOM API（构建 message-group 结构）
 * - Mock MessageOperationContext 的 host 回调（showToast / isStreaming / regenerateLastMessage / showConfirmDialog）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  handleRegenerate,
  findPreviousUserMessage,
  findNextAssistantMessage,
  removeMessageAndCleanupGroup,
  handleForget,
  type MessageOperationContext,
} from '../../../electron/renderer/helpers/messageOperations.js';
import type { ChatPanelHost } from '../../../electron/renderer/panels/chatPanelManager.js';
import { TOAST_SHORT_MS } from '../../../sprite/constants.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 Mock ChatPanelHost（所有方法用 vi.fn 创建，可通过 overrides 替换） */
function createMockHost(overrides?: Partial<ChatPanelHost>): ChatPanelHost {
  let streamingState = false;
  return {
    showToast: vi.fn(),
    scrollToBottom: vi.fn(),
    forceScrollToBottom: vi.fn(),
    updateSendButton: vi.fn(),
    setStreaming: vi.fn((s: boolean) => { streamingState = s; }),
    isStreaming: vi.fn(() => streamingState),
    updateBadge: vi.fn(),
    showEmptyState: vi.fn(),
    hideEmptyState: vi.fn(),
    updateUnreadCount: vi.fn(),
    onStreamStuck: vi.fn(),
    getArchiveMode: vi.fn(() => 'full' as const),
    archiveConversation: vi.fn(),
    archiveSession: vi.fn(),
    getCurrentSessionId: vi.fn(() => '2026-07-12-test'),
    regenerateLastMessage: vi.fn(),
    showConfirmDialog: vi.fn(async () => true),
    ...overrides,
  };
}

/** 创建消息元素（带 message-bubble 子元素） */
function createMessageEl(role: 'user' | 'assistant', content: string, messageId?: string): HTMLElement {
  const msg = document.createElement('div');
  msg.className = `message ${role}`;
  if (messageId) msg.dataset.messageId = messageId;
  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = content;
  msg.appendChild(bubble);
  return msg;
}

/** 构建 message-group 结构（一组 user + assistant 消息） */
function createMessageGroup(messages: HTMLElement[]): HTMLElement {
  const group = document.createElement('div');
  group.className = 'message-group';
  for (const msg of messages) {
    group.appendChild(msg);
  }
  return group;
}

/** 构建多组对话 DOM（挂载到 document.body） */
function buildConversation(groups: HTMLElement[][], container?: HTMLElement): HTMLElement {
  const root = container ?? document.body;
  for (const groupMessages of groups) {
    if (groupMessages.length === 1) {
      // 单条消息直接挂载（非 group 场景）
      root.appendChild(groupMessages[0]);
    } else {
      root.appendChild(createMessageGroup(groupMessages));
    }
  }
  return root;
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── 1. handleRegenerate ────────────────────────────────

describe('handleRegenerate', () => {
  it('流式中应拒绝并提示等待完成', () => {
    const host = createMockHost({ isStreaming: vi.fn(() => true) });
    const ctx: MessageOperationContext = { host };
    const assistantMsg = createMessageEl('assistant', '旧回复');
    handleRegenerate(ctx, assistantMsg);
    expect(host.showToast).toHaveBeenCalledWith('精灵正在回复中，请等待完成或点击停止', 'warning');
    expect(host.regenerateLastMessage).not.toHaveBeenCalled();
  });

  it('找不到上一条用户消息应提示错误', () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    // 仅有一条 assistant 消息，无 user
    const assistantMsg = createMessageEl('assistant', '回复');
    document.body.appendChild(assistantMsg);
    handleRegenerate(ctx, assistantMsg);
    expect(host.showToast).toHaveBeenCalledWith('找不到对应的用户消息', 'warning');
    expect(host.regenerateLastMessage).not.toHaveBeenCalled();
  });

  it('用户消息内容为空应提示错误', () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    // user 和 assistant 分属不同 group（Phase 1 消息分组结构）
    const userMsg = createMessageEl('user', '');
    const assistantMsg = createMessageEl('assistant', '回复');
    buildConversation([[userMsg], [assistantMsg]]);
    handleRegenerate(ctx, assistantMsg);
    expect(host.showToast).toHaveBeenCalledWith('用户消息内容为空', 'warning');
    expect(host.regenerateLastMessage).not.toHaveBeenCalled();
  });

  it('用户消息仅空白字符应提示错误', () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    const userMsg = createMessageEl('user', '   \n\t  ');
    const assistantMsg = createMessageEl('assistant', '回复');
    buildConversation([[userMsg], [assistantMsg]]);
    handleRegenerate(ctx, assistantMsg);
    expect(host.showToast).toHaveBeenCalledWith('用户消息内容为空', 'warning');
  });

  it('成功路径应删除精灵消息并调用 regenerateLastMessage', () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    const userMsg = createMessageEl('user', '你好');
    const assistantMsg = createMessageEl('assistant', '旧回复');
    buildConversation([[userMsg], [assistantMsg]]);
    handleRegenerate(ctx, assistantMsg);
    // 精灵消息应被删除
    expect(assistantMsg.parentElement).toBeNull();
    // 应调用 regenerateLastMessage 并传入用户消息内容
    expect(host.regenerateLastMessage).toHaveBeenCalledWith('你好');
  });

  it('成功路径应跨 group 查找上一条用户消息', () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    // user 和 assistant 分属不同 group
    const userMsg = createMessageEl('user', '跨组问题');
    const assistantMsg = createMessageEl('assistant', '跨组回复');
    buildConversation([[userMsg], [assistantMsg]]);
    handleRegenerate(ctx, assistantMsg);
    expect(host.regenerateLastMessage).toHaveBeenCalledWith('跨组问题');
    expect(assistantMsg.parentElement).toBeNull();
  });
});

// ─── 2. findPreviousUserMessage ─────────────────────────

describe('findPreviousUserMessage', () => {
  it('跨 group 应找到上一条用户消息', () => {
    const userMsg = createMessageEl('user', '用户问题');
    const assistantMsg = createMessageEl('assistant', '回复');
    buildConversation([[userMsg], [assistantMsg]]);
    const result = findPreviousUserMessage(assistantMsg);
    expect(result).toBe(userMsg);
  });

  it('同一 group 内应跳过自身 group 返回 null', () => {
    // 函数设计：跳到父 group 后仅向前遍历，不搜索自身 group
    // Phase 1 消息分组后 user 和 assistant 分属不同 group，同 group 是非预期场景
    const userMsg = createMessageEl('user', '同组问题');
    const assistantMsg = createMessageEl('assistant', '同组回复');
    buildConversation([[userMsg, assistantMsg]]);
    const result = findPreviousUserMessage(assistantMsg);
    expect(result).toBeNull();
  });

  it('多个 group 应取上一个 group 的 user 消息', () => {
    // 结构：[user1], [assistant1], [user2], [assistant2]
    // 从 assistant2 向前找，应返回 user2（最近的上一个 group 中的 user）
    const user1 = createMessageEl('user', '问题1');
    const assistant1 = createMessageEl('assistant', '回复1');
    const user2 = createMessageEl('user', '问题2');
    const assistant2 = createMessageEl('assistant', '回复2');
    buildConversation([[user1], [assistant1], [user2], [assistant2]]);
    const result = findPreviousUserMessage(assistant2);
    expect(result).toBe(user2);
  });

  it('非 group 场景（顶层 user 消息）应兜底返回', () => {
    const userMsg = createMessageEl('user', '顶层问题');
    const assistantMsg = createMessageEl('assistant', '回复');
    // 不包装在 group 中，直接挂载
    buildConversation([[userMsg], [assistantMsg]]);
    const result = findPreviousUserMessage(assistantMsg);
    expect(result).toBe(userMsg);
  });

  it('找不到用户消息应返回 null', () => {
    const assistantMsg = createMessageEl('assistant', '无用户消息');
    document.body.appendChild(assistantMsg);
    const result = findPreviousUserMessage(assistantMsg);
    expect(result).toBeNull();
  });

  it('上一个 group 内有多条 user 消息应取最后一条', () => {
    const user1 = createMessageEl('user', '第一条');
    const user2 = createMessageEl('user', '第二条');
    const assistantMsg = createMessageEl('assistant', '回复');
    buildConversation([[user1, user2], [assistantMsg]]);
    const result = findPreviousUserMessage(assistantMsg);
    expect(result).toBe(user2);
  });
});

// ─── 3. findNextAssistantMessage ────────────────────────

describe('findNextAssistantMessage', () => {
  it('跨 group 应找到下一条精灵消息', () => {
    const userMsg = createMessageEl('user', '问题');
    const assistantMsg = createMessageEl('assistant', '跨组回复');
    buildConversation([[userMsg], [assistantMsg]]);
    const result = findNextAssistantMessage(userMsg);
    expect(result).toBe(assistantMsg);
  });

  it('同一 group 内应跳过自身 group 返回 null', () => {
    // 函数设计：跳到父 group 后仅向后遍历，不搜索自身 group
    const userMsg = createMessageEl('user', '同组问题');
    const assistantMsg = createMessageEl('assistant', '同组回复');
    buildConversation([[userMsg, assistantMsg]]);
    const result = findNextAssistantMessage(userMsg);
    expect(result).toBeNull();
  });

  it('找不到精灵消息应返回 null', () => {
    const userMsg = createMessageEl('user', '无回复');
    document.body.appendChild(userMsg);
    const result = findNextAssistantMessage(userMsg);
    expect(result).toBeNull();
  });

  it('下一个 group 内有多条 assistant 消息应取第一条', () => {
    const userMsg = createMessageEl('user', '问题');
    const assistant1 = createMessageEl('assistant', '回复1');
    const assistant2 = createMessageEl('assistant', '回复2');
    buildConversation([[userMsg], [assistant1, assistant2]]);
    const result = findNextAssistantMessage(userMsg);
    expect(result).toBe(assistant1);
  });

  it('非 group 场景（顶层 assistant 消息）应兜底返回', () => {
    const userMsg = createMessageEl('user', '顶层问题');
    const assistantMsg = createMessageEl('assistant', '顶层回复');
    buildConversation([[userMsg], [assistantMsg]]);
    const result = findNextAssistantMessage(userMsg);
    expect(result).toBe(assistantMsg);
  });
});

// ─── 4. removeMessageAndCleanupGroup ───────────────────

describe('removeMessageAndCleanupGroup', () => {
  it('应从 DOM 中移除消息元素', () => {
    const msg = createMessageEl('user', '待删除');
    document.body.appendChild(msg);
    removeMessageAndCleanupGroup(msg);
    expect(msg.parentElement).toBeNull();
  });

  it('删除后 group 变空应清理 group 容器', () => {
    const msg = createMessageEl('user', '唯一消息');
    const group = createMessageGroup([msg]);
    document.body.appendChild(group);
    removeMessageAndCleanupGroup(msg);
    // group 应被移除
    expect(group.parentElement).toBeNull();
  });

  it('删除后 group 非空应保留 group 容器', () => {
    const msg1 = createMessageEl('user', '消息1');
    const msg2 = createMessageEl('assistant', '消息2');
    const group = createMessageGroup([msg1, msg2]);
    document.body.appendChild(group);
    removeMessageAndCleanupGroup(msg1);
    // group 应保留
    expect(group.parentElement).toBe(document.body);
    // 仅 msg1 被移除，msg2 保留
    expect(group.children.length).toBe(1);
    expect(group.children[0]).toBe(msg2);
  });

  it('非 group 顶层消息删除应正常移除', () => {
    const msg = createMessageEl('user', '顶层消息');
    document.body.appendChild(msg);
    removeMessageAndCleanupGroup(msg);
    expect(msg.parentElement).toBeNull();
    expect(document.body.children.length).toBe(0);
  });

  it('group 内多条消息删除一条后应保留剩余消息', () => {
    const msg1 = createMessageEl('user', '1');
    const msg2 = createMessageEl('assistant', '2');
    const msg3 = createMessageEl('user', '3');
    const group = createMessageGroup([msg1, msg2, msg3]);
    document.body.appendChild(group);
    removeMessageAndCleanupGroup(msg2);
    expect(group.children.length).toBe(2);
    expect(group.children[0]).toBe(msg1);
    expect(group.children[1]).toBe(msg3);
  });
});

// ─── 5. handleForget ────────────────────────────────────

describe('handleForget', () => {
  it('用户取消确认应不删除任何消息', async () => {
    const host = createMockHost({ showConfirmDialog: vi.fn(async () => false) });
    const ctx: MessageOperationContext = { host };
    const userMsg = createMessageEl('user', '问题');
    const assistantMsg = createMessageEl('assistant', '回复');
    buildConversation([[userMsg, assistantMsg]]);
    await handleForget(ctx, 'msg-id', userMsg);
    // 消息应保留
    expect(userMsg.parentElement).not.toBeNull();
    expect(assistantMsg.parentElement).not.toBeNull();
    // 不应调用 showToast
    expect(host.showToast).not.toHaveBeenCalled();
  });

  it('确认弹窗应包含正确的标题和 danger 标记', async () => {
    const host = createMockHost({ showConfirmDialog: vi.fn(async () => true) });
    const ctx: MessageOperationContext = { host };
    const userMsg = createMessageEl('user', '问题');
    document.body.appendChild(userMsg);
    await handleForget(ctx, 'msg-id', userMsg);
    expect(host.showConfirmDialog).toHaveBeenCalledWith({
      title: '忘记此条对话',
      message: '将这条对话（你的消息和精灵的回复）从当前视野中移除，刷新后可恢复。',
      confirmText: '忘记',
      cancelText: '取消',
      danger: true,
    });
  });

  it('右键 user 消息应删除 user + 下一条 assistant', async () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    // user 和 assistant 分属不同 group（Phase 1 消息分组结构）
    const userMsg = createMessageEl('user', '问题');
    const assistantMsg = createMessageEl('assistant', '回复');
    buildConversation([[userMsg], [assistantMsg]]);
    await handleForget(ctx, 'msg-id', userMsg);
    expect(userMsg.parentElement).toBeNull();
    expect(assistantMsg.parentElement).toBeNull();
    expect(host.showToast).toHaveBeenCalledWith('已从本次对话移除，刷新后可恢复', 'success', TOAST_SHORT_MS);
  });

  it('右键 assistant 消息应删除 assistant + 上一条 user', async () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    const userMsg = createMessageEl('user', '问题');
    const assistantMsg = createMessageEl('assistant', '回复');
    buildConversation([[userMsg], [assistantMsg]]);
    await handleForget(ctx, 'msg-id', assistantMsg);
    expect(userMsg.parentElement).toBeNull();
    expect(assistantMsg.parentElement).toBeNull();
    expect(host.showToast).toHaveBeenCalledWith('已从本次对话移除，刷新后可恢复', 'success', TOAST_SHORT_MS);
  });

  it('右键 user 消息跨 group 应删除对应 assistant', async () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    const userMsg = createMessageEl('user', '跨组问题');
    const assistantMsg = createMessageEl('assistant', '跨组回复');
    buildConversation([[userMsg], [assistantMsg]]);
    await handleForget(ctx, 'msg-id', userMsg);
    expect(userMsg.parentElement).toBeNull();
    expect(assistantMsg.parentElement).toBeNull();
  });

  it('右键 assistant 跨 group 应删除对应 user', async () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    const userMsg = createMessageEl('user', '跨组问题');
    const assistantMsg = createMessageEl('assistant', '跨组回复');
    buildConversation([[userMsg], [assistantMsg]]);
    await handleForget(ctx, 'msg-id', assistantMsg);
    expect(userMsg.parentElement).toBeNull();
    expect(assistantMsg.parentElement).toBeNull();
  });

  it('右键 assistant 找不到 user 应仅删除 assistant', async () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    const assistantMsg = createMessageEl('assistant', '无对应用户');
    document.body.appendChild(assistantMsg);
    await handleForget(ctx, 'msg-id', assistantMsg);
    expect(assistantMsg.parentElement).toBeNull();
    expect(host.showToast).toHaveBeenCalledWith('已从本次对话移除，刷新后可恢复', 'success', TOAST_SHORT_MS);
  });

  it('右键 user 找不到 assistant 应仅删除 user', async () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    const userMsg = createMessageEl('user', '无对应回复');
    document.body.appendChild(userMsg);
    await handleForget(ctx, 'msg-id', userMsg);
    expect(userMsg.parentElement).toBeNull();
    expect(host.showToast).toHaveBeenCalledWith('已从本次对话移除，刷新后可恢复', 'success', TOAST_SHORT_MS);
  });

  it('删除后空 group 应被清理', async () => {
    const host = createMockHost();
    const ctx: MessageOperationContext = { host };
    // user 和 assistant 分属不同 group（各自单条消息的 group）
    const userMsg = createMessageEl('user', '问题');
    const assistantMsg = createMessageEl('assistant', '回复');
    const userGroup = createMessageGroup([userMsg]);
    const assistantGroup = createMessageGroup([assistantMsg]);
    document.body.appendChild(userGroup);
    document.body.appendChild(assistantGroup);
    await handleForget(ctx, 'msg-id', userMsg);
    // 两个 group 内消息全删完，均应被清理
    expect(userGroup.parentElement).toBeNull();
    expect(assistantGroup.parentElement).toBeNull();
  });
});
