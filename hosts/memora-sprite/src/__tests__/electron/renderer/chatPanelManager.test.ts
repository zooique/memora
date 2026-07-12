/**
 * 聊天面板管理器测试
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - 构造与 cleanup：字段初始化、事件委托注册、cleanup 取消 rAF + 清除定时器 + events.cleanup、THINKING_PHASE_LABELS
 * - appendMessage：user/assistant/system/streaming 消息渲染、memoryRecall、document.hidden 未读、host 回调
 * - startStreaming：空流式消息创建、thinking-phase 占位、streamingMessages/host.setStreaming/updateSendButton、30s 安全定时器
 * - updateStreamingMessage：rAF 节流（首次触发/后续复用）、rAF 回调渲染 + 保留元素、重置定时器 + 移除 thinking-phase
 * - finishStreamingMessage：rAF flush、移除 streaming/cursor/thinking-phase、复制按钮、状态重置
 * - setMemoryRecall：静默返回、空数组、召回容器创建、已存在容器更新、插入到光标前
 * - showThinkingPhase：静默返回、创建指示器、更新文案、未知 phase 降级
 * - showTruncationNotice：count 文案、插入到 bubble 顶部、已存在更新
 * - showToolStart：卡片结构、args 附加、插入到光标前
 * - updateToolResult：精确匹配成功/失败、降级匹配、summary、collapsed
 * - stopAllStreaming：取消 rAF、移除 streaming/cursor、清空 Map + 状态
 * - clearMessages：移除 .message + load-more、清空状态、host 回调
 * - appendMessages：空数组、追加、prepend（load-more 之后）
 * - showLoadMore/hideLoadMore/showLoadEarlierDay：容器创建、回调保存、按钮文案
 * - markStreamingAborted：取消 rAF、嵌入中断标记、复制按钮、状态清理、幂等保护
 * - injectErrorToStreamingMessages：错误指示器、重试按钮、清空状态
 * - 空状态：initEmptyStateListeners、showEmptyState/hideEmptyState、元素缺失降级
 * - 事件委托 click 分发：copy/copy-code/recall/toggle-collapse/load-more/load-earlier-day/retry
 * - 回调注册：onSuggestionClick/setMemoryRecallClickCallback/onErrorRetry
 * - 超时兜底定时器：30s onStreamStuck、90s 二级兜底、safetyTimer.reset 不累积
 *
 * Mock 策略：
 * - Mock renderMarkdown 返回固定 DOM（.mock-markdown span，避免测试 Markdown 解析）
 * - 使用真实 EventTracker（验证事件注册与清理的完整生命周期）
 * - requestAnimationFrame 手动控制（捕获回调但不立即执行，测试节流逻辑）
 * - cancelAnimationFrame 跟踪取消调用并从队列移除
 * - vi.useFakeTimers 控制 setTimeout（30s/90s 安全定时器）
 * - mock navigator.clipboard.writeText
 * - JSDOM 提供真实 DOM API
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ChatPanelManager, type ChatPanelHost } from '../../../electron/renderer/panels/chatPanelManager.js';
import { EventTracker } from '../../../electron/renderer/helpers/eventTracker.js';
import type { Message } from '../../../electron/renderer/types.js';

// Mock renderMarkdown：返回固定 DOM 结构，避免测试 Markdown 解析逻辑
vi.mock('../../../electron/renderer/components/markdown.js', () => ({
  renderMarkdown: vi.fn((text: string): DocumentFragment => {
    const fragment = document.createDocumentFragment();
    const span = document.createElement('span');
    span.className = 'mock-markdown';
    span.textContent = text;
    fragment.appendChild(span);
    return fragment;
  }),
}));

// ─── 测试辅助 ─────────────────────────────────────────────

/** 创建 Mock ChatPanelHost（所有方法用 vi.fn 创建，可通过 overrides 替换） */
function createMockHost(overrides?: Partial<ChatPanelHost>): ChatPanelHost {
  // setStreaming/isStreaming 维护内部状态，
  // 使 ChatPanelManager 的 isStreaming() 读取能正确反映 setStreaming 调用
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
    // manual 模式归档按钮渲染依赖 host.getArchiveMode()（默认 full 不渲染）
    getArchiveMode: vi.fn(() => 'full' as const),
    // 忘记操作二次确认（默认直接确认）
    showConfirmDialog: vi.fn(async () => true),
    ...overrides,
  };
}

// rAF 回调队列与句柄计数（手动控制执行时机，测试节流逻辑）
let rafQueue: Array<{ cb: FrameRequestCallback; handle: number }> = [];
let rafHandleCounter = 0;
let canceledHandles: number[] = [];

/** 剪贴板 writeText mock 引用（beforeEach 中重新创建） */
let clipboardWriteText: ReturnType<typeof vi.fn>;

/** 创建 ChatPanelManager 实例（已注入 DOM 与共享状态） */
function createManager(opts?: {
  host?: ChatPanelHost;
  initEmptyState?: boolean;
}): {
  manager: ChatPanelManager;
  host: ChatPanelHost;
  events: EventTracker;
  streamingMessages: Map<string, HTMLElement>;
  messagesEl: HTMLElement;
} {
  // 构建 DOM：消息容器 + 空状态引导（含示例问题按钮）
  document.body.innerHTML = `
    <div id="chat-messages">
      <div id="chat-empty-state" class="hidden">
        <button class="suggestion-btn" data-suggestion="你好">你好</button>
        <button class="suggestion-btn" data-suggestion="帮助">帮助</button>
      </div>
    </div>
  `;
  const messagesEl = document.getElementById('chat-messages') as HTMLElement;
  const events = new EventTracker();
  const streamingMessages = new Map<string, HTMLElement>();
  const host = opts?.host ?? createMockHost();
  const manager = new ChatPanelManager(host, messagesEl, events, streamingMessages);
  if (opts?.initEmptyState) {
    manager.initEmptyStateListeners();
  }
  return { manager, host, events, streamingMessages, messagesEl };
}

/** 手动执行所有挂起的 rAF 回调（模拟帧刷新） */
function flushRaF(): void {
  const queue = rafQueue;
  rafQueue = [];
  for (const { cb } of queue) {
    cb(0);
  }
}

/** 构建用户消息 */
function userMsg(content: string, messageId?: string): Message {
  return { role: 'user', content, messageId };
}

/** 构建助手消息 */
function assistantMsg(content: string, messageId?: string): Message {
  return { role: 'assistant', content, messageId };
}

// ─── 全局设置 ─────────────────────────────────────────────

beforeEach(() => {
  // 使用 fake timers 控制 setTimeout（安全定时器 30s/90s）
  vi.useFakeTimers();
  // rAF 手动控制：捕获回调但不立即执行，测试节流逻辑
  rafQueue = [];
  rafHandleCounter = 0;
  canceledHandles = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
    const handle = ++rafHandleCounter;
    rafQueue.push({ cb, handle });
    return handle;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle: number) => {
    canceledHandles.push(handle);
    rafQueue = rafQueue.filter((e) => e.handle !== handle);
  });
  // 剪贴板 mock（JSDOM 中 navigator.clipboard 可能不存在，需显式定义）
  clipboardWriteText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: clipboardWriteText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// ─── 1. 构造与 cleanup ───────────────────────────────────

describe('构造与 cleanup', () => {
  it('构造函数应初始化字段并共享 streamingMessages 引用', () => {
    const { manager, host, streamingMessages } = createManager();
    // 通过 startStreaming 验证 host.setStreaming 调用 + streamingMessages 引用共享
    manager.startStreaming('m1');
    expect(host.setStreaming).toHaveBeenCalledWith(true);
    expect(streamingMessages.has('m1')).toBe(true);
  });

  it('构造函数应在 messagesEl 上注册 click 事件委托', () => {
    const { messagesEl } = createManager();
    // 创建带 data-action=copy 的按钮并触发 click
    const btn = document.createElement('button');
    btn.dataset.action = 'copy';
    btn.dataset.content = 'delegated-content';
    messagesEl.appendChild(btn);
    btn.click();
    expect(clipboardWriteText).toHaveBeenCalledWith('delegated-content');
  });

  it('cleanup 应取消挂起 rAF + 清除安全定时器', () => {
    const { manager, host } = createManager();
    manager.startStreaming('m1');
    manager.updateStreamingMessage('m1', 'text'); // 触发 rAF，streamRenderCtx.rafHandle 非空
    manager.cleanup();
    // rAF 应被取消
    expect(canceledHandles.length).toBeGreaterThan(0);
    // 安全定时器应被清除（30s 后不触发 onStreamStuck）
    vi.advanceTimersByTime(30_000);
    expect(host.onStreamStuck).not.toHaveBeenCalled();
  });

  it('cleanup 应调用 events.cleanup 移除事件监听', () => {
    const { manager, messagesEl } = createManager();
    manager.cleanup();
    // cleanup 后 click 不应触发事件委托
    const btn = document.createElement('button');
    btn.dataset.action = 'copy';
    btn.dataset.content = 'after-cleanup';
    messagesEl.appendChild(btn);
    btn.click();
    expect(clipboardWriteText).not.toHaveBeenCalledWith('after-cleanup');
  });

  // THINKING_PHASE_LABELS 已迁移到 messageDecorations.ts（私有常量非 export）
  // 改为黑盒行为测试：验证 showThinkingPhase 渲染的文案包含正确中文标签
  it('showThinkingPhase 应渲染 recalling/processing/archiving 中文标签', () => {
    const { manager, messagesEl } = createManager();
    manager.startStreaming('m1');
    manager.showThinkingPhase('m1', 'recalling');
    let indicator = messagesEl.querySelector('.thinking-phase');
    expect(indicator?.textContent).toContain('正在回忆相关记忆');
    manager.showThinkingPhase('m1', 'processing');
    indicator = messagesEl.querySelector('.thinking-phase');
    expect(indicator?.textContent).toContain('正在处理请求');
    manager.showThinkingPhase('m1', 'archiving');
    indicator = messagesEl.querySelector('.thinking-phase');
    expect(indicator?.textContent).toContain('正在归档对话');
  });
});

// ─── 2. appendMessage 消息渲染 ───────────────────────────

describe('appendMessage · 消息渲染', () => {
  it('user 消息应包含 🧑 头像 + textContent + 复制按钮 + 时间戳', () => {
    const { manager, host, messagesEl } = createManager();
    manager.appendMessage(userMsg('hello world', 'u1'));
    const msg = messagesEl.querySelector('.message.user') as HTMLElement;
    expect(msg).toBeTruthy();
    expect(msg.querySelector('.message-avatar')?.innerHTML).toContain('icon-person');
    // 用户消息使用 textContent（防 XSS）
    expect(msg.querySelector('.message-bubble')?.textContent).toBe('hello world');
    // 复制按钮（data-action=copy + data-content）
    const copyBtn = msg.querySelector('[data-action="copy"]') as HTMLElement;
    expect(copyBtn).toBeTruthy();
    expect(copyBtn.dataset.content).toBe('hello world');
    // 时间戳元素存在
    expect(msg.querySelector('.message-time')).toBeTruthy();
    // 触发 host 回调
    expect(host.hideEmptyState).toHaveBeenCalled();
    expect(host.scrollToBottom).toHaveBeenCalled();
  });

  it('assistant 消息应包含 🧚 头像 + renderMarkdown 渲染', () => {
    const { manager, messagesEl } = createManager();
    manager.appendMessage(assistantMsg('# 标题', 'a1'));
    const msg = messagesEl.querySelector('.message.assistant') as HTMLElement;
    expect(msg.querySelector('.message-avatar')?.innerHTML).toContain('icon-fairy');
    // renderMarkdown 应被调用，气泡内包含 mock markdown 输出
    expect(msg.querySelector('.mock-markdown')?.textContent).toBe('# 标题');
  });

  it('system 消息应为简单 textContent 无头像无气泡', () => {
    const { manager, messagesEl } = createManager();
    manager.appendMessage({ role: 'system', content: '系统提示' });
    const msg = messagesEl.querySelector('.message.system') as HTMLElement;
    expect(msg).toBeTruthy();
    expect(msg.textContent).toBe('系统提示');
    expect(msg.querySelector('.message-avatar')).toBeNull();
    expect(msg.querySelector('.message-bubble')).toBeNull();
  });

  it('streaming 消息应添加 streaming 类 + 光标元素 + 无复制按钮', () => {
    const { manager, messagesEl } = createManager();
    manager.appendMessage({ role: 'assistant', content: '', streaming: true, messageId: 's1' });
    const msg = messagesEl.querySelector('.message.streaming') as HTMLElement;
    expect(msg).toBeTruthy();
    expect(msg.querySelector('.cursor')).toBeTruthy();
    // 流式消息无复制按钮
    expect(msg.querySelector('[data-action="copy"]')).toBeNull();
  });

  it('assistant 消息带 memoryRecall 应附加召回容器', () => {
    const { manager, messagesEl } = createManager();
    manager.appendMessage({
      role: 'assistant',
      content: '回答',
      memoryRecall: [{ name: '记忆A', score: 0.95, source: 'conversation' }],
    });
    const msg = messagesEl.querySelector('.message.assistant') as HTMLElement;
    const container = msg.querySelector('.memory-recall-container');
    expect(container).toBeTruthy();
    // 极简模式：默认显示折叠头，记忆项隐藏
    const header = container?.querySelector('.memory-recall-header');
    expect(header).toBeTruthy();
    expect(header?.textContent).toContain('记忆');
    expect(header?.textContent).toContain('1');
    // 记忆项在列表中（默认隐藏）
    const recallItem = container?.querySelector('.memory-recall');
    expect(recallItem).toBeTruthy();
    expect(recallItem?.getAttribute('data-action')).toBe('recall');
    expect(recallItem?.getAttribute('data-name')).toBe('记忆A');
    expect(recallItem?.querySelector('.memory-recall-item-icon')?.innerHTML).toContain('icon-lightbulb');
    expect(recallItem?.textContent).toContain('记忆A');
    // score 不再显示（极简模式）
    expect(recallItem?.textContent).not.toContain('0.95');
  });

  it('document.hidden=true 时 assistant 消息应触发 updateUnreadCount', () => {
    // mock document.hidden 返回 true
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const { manager, host } = createManager();
    manager.appendMessage(assistantMsg('hi', 'a1'));
    expect(host.updateUnreadCount).toHaveBeenCalled();
  });
});

// ─── 3. startStreaming ───────────────────────────────────

describe('startStreaming', () => {
  it('应创建空 assistant 流式消息 + thinking-phase 占位', () => {
    const { manager, messagesEl } = createManager();
    manager.startStreaming('s1');
    const msg = messagesEl.querySelector('.message.streaming') as HTMLElement;
    expect(msg).toBeTruthy();
    expect(msg.classList.contains('assistant')).toBe(true);
    // thinking-phase 占位（SVG 齿轮图标 + 文字）
    const phase = msg.querySelector('.thinking-phase');
    expect(phase?.innerHTML).toContain('icon-gear');
    expect(phase?.textContent).toContain('正在思考...');
    // 光标元素存在
    expect(msg.querySelector('.cursor')).toBeTruthy();
  });

  it('应设置 streamingMessages + host.setStreaming(true) + 调用 updateSendButton', () => {
    const { manager, host, streamingMessages } = createManager();
    manager.startStreaming('s1');
    expect(streamingMessages.has('s1')).toBe(true);
    expect(host.setStreaming).toHaveBeenCalledWith(true);
    expect(host.updateSendButton).toHaveBeenCalled();
  });

  it('应启动 30s 安全定时器（到期触发 onStreamStuck）', () => {
    const { manager, host } = createManager();
    manager.startStreaming('s1');
    // 29s 不触发
    vi.advanceTimersByTime(29_000);
    expect(host.onStreamStuck).not.toHaveBeenCalled();
    // 30s 触发
    vi.advanceTimersByTime(1_000);
    expect(host.onStreamStuck).toHaveBeenCalledTimes(1);
  });
});

// ─── 4. updateStreamingMessage rAF 节流 ─────────────────

describe('updateStreamingMessage · rAF 节流', () => {
  it('messageId 不存在时应静默返回（不触发 rAF）', () => {
    const { manager } = createManager();
    manager.updateStreamingMessage('nonexistent', 'text');
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('首次调用应触发 rAF，后续调用复用 pending rAF', () => {
    const { manager } = createManager();
    manager.startStreaming('s1');
    manager.updateStreamingMessage('s1', 'chunk1');
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    // 第二次调用不应重复触发 rAF（streamRenderCtx.pendingRaf 仍为 true）
    manager.updateStreamingMessage('s1', 'chunk2');
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    // _latestStreamText 应更新为最新文本（已迁移到 streamRenderCtx.latestStreamText）
    expect(manager['streamRenderCtx'].latestStreamText).toBe('chunk2');
  });

  it('rAF 回调应清空 bubble + 纯文本显示 + 保留 cursor/recall/tool-call + scrollToBottom', () => {
    const { manager, host, streamingMessages } = createManager();
    manager.startStreaming('s1');
    // 添加召回容器和工具卡片（验证 rAF 回调保留这些元素）
    manager.setMemoryRecall('s1', [{ name: 'mem', score: 0.9, source: 'src' }]);
    manager.showToolStart('s1', 'tc1', 'toolName', '{}');
    host.scrollToBottom.mockClear();
    manager.updateStreamingMessage('s1', 'final text');
    flushRaF();
    // 流式期间使用纯文本显示（不调用 renderMarkdown）
    const el = streamingMessages.get('s1') as HTMLElement;
    const bubble = el.querySelector('.message-bubble') as HTMLElement;
    expect(bubble.querySelector('.streaming-text')?.textContent).toBe('final text');
    // scrollToBottom 应在 rAF 回调中调用
    expect(host.scrollToBottom).toHaveBeenCalled();
    // 验证保留元素顺序：streaming-text, recall, tool-call, cursor（cursor 在 streaming-text 内部）
    const children = Array.from(bubble.children);
    expect(children[0]?.className).toBe('streaming-text');
    expect(children[1]?.className).toContain('memory-recall-container');
    expect(children[2]?.className).toContain('tool-call');
    // cursor 应在 streaming-text 内部
    expect(children[0]?.querySelector('.cursor')).toBeTruthy();
  });

  it('应重置安全定时器 + 移除 thinking-phase 指示器', () => {
    const { manager, host, streamingMessages } = createManager();
    manager.startStreaming('s1');
    // startStreaming 后 thinking-phase 存在
    const el = streamingMessages.get('s1') as HTMLElement;
    expect(el.querySelector('.thinking-phase')).toBeTruthy();
    manager.updateStreamingMessage('s1', 'chunk');
    // thinking-phase 应被移除
    expect(el.querySelector('.thinking-phase')).toBeNull();
    // 安全定时器应被重置（从 updateStreamingMessage 时刻重新计时 30s）
    vi.advanceTimersByTime(29_999);
    expect(host.onStreamStuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.onStreamStuck).toHaveBeenCalledTimes(1);
  });
});

// ─── 5. finishStreamingMessage ───────────────────────────

describe('finishStreamingMessage', () => {
  it('messageId 不存在时应静默返回', () => {
    const { manager, host } = createManager();
    manager.finishStreamingMessage('nonexistent');
    expect(host.updateSendButton).not.toHaveBeenCalled();
  });

  it('rAF pending 时应同步 flush 渲染最新文本', () => {
    const { manager, messagesEl } = createManager();
    manager.startStreaming('s1');
    manager.updateStreamingMessage('s1', 'final content');
    // rAF 仍 pending（未 flush）
    expect(rafQueue.length).toBeGreaterThan(0);
    manager.finishStreamingMessage('s1');
    // 应同步 flush：bubble 包含 renderMarkdown('final content') 的输出
    const msg = messagesEl.querySelector('.message') as HTMLElement;
    const bubble = msg.querySelector('.message-bubble') as HTMLElement;
    expect(bubble.querySelector('.mock-markdown')?.textContent).toBe('final content');
  });

  it('应移除 streaming 类 + 光标 + thinking-phase + 添加复制按钮', () => {
    const { manager, messagesEl } = createManager();
    manager.startStreaming('s1');
    manager.showThinkingPhase('s1', 'archiving');
    manager.finishStreamingMessage('s1');
    const msg = messagesEl.querySelector('.message') as HTMLElement;
    expect(msg.classList.contains('streaming')).toBe(false);
    expect(msg.querySelector('.cursor')).toBeNull();
    expect(msg.querySelector('.thinking-phase')).toBeNull();
    // 复制按钮应被添加（addCopyButtonToMessage）
    expect(msg.querySelector('[data-action="copy"]')).toBeTruthy();
  });

  it('最后一条消息完成时应重置 isStreaming + 清除定时器 + updateSendButton', () => {
    const { manager, host } = createManager();
    manager.startStreaming('s1');
    expect(host.setStreaming).toHaveBeenCalledWith(true);
    host.updateSendButton.mockClear();
    host.setStreaming.mockClear();
    manager.finishStreamingMessage('s1');
    expect(host.setStreaming).toHaveBeenCalledWith(false);
    expect(host.updateSendButton).toHaveBeenCalled();
    // 安全定时器应被清除
    vi.advanceTimersByTime(30_000);
    expect(host.onStreamStuck).not.toHaveBeenCalled();
  });
});

// ─── 6. setMemoryRecall ──────────────────────────────────

describe('setMemoryRecall', () => {
  it('messageId 不存在时静默返回 + memories 为空时不创建容器', () => {
    const { manager, streamingMessages } = createManager();
    // messageId 不存在：不抛错
    expect(() => manager.setMemoryRecall('nonexistent', [])).not.toThrow();
    // memories 为空：不创建容器
    manager.startStreaming('s1');
    manager.setMemoryRecall('s1', []);
    const el = streamingMessages.get('s1') as HTMLElement;
    expect(el.querySelector('.memory-recall-container')).toBeNull();
  });

  it('应创建召回容器并插入到光标之前', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    manager.setMemoryRecall('s1', [
      { name: '记忆1', score: 0.88, source: 'conversation' },
      { name: '记忆2', score: 0.72, source: 'archive' },
    ]);
    const el = streamingMessages.get('s1') as HTMLElement;
    const bubble = el.querySelector('.message-bubble') as HTMLElement;
    const container = bubble.querySelector('.memory-recall-container');
    expect(container).toBeTruthy();
    expect(container?.querySelectorAll('.memory-recall').length).toBe(2);
    // 应插入到光标之前
    const children = Array.from(bubble.children);
    const recallIndex = children.indexOf(container as HTMLElement);
    const cursorIndex = children.indexOf(bubble.querySelector('.cursor') as HTMLElement);
    expect(recallIndex).toBeLessThan(cursorIndex);
  });

  it('已存在容器时应先移除再创建', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    manager.setMemoryRecall('s1', [{ name: '旧记忆', score: 0.5, source: 's' }]);
    manager.setMemoryRecall('s1', [{ name: '新记忆', score: 0.9, source: 's' }]);
    const el = streamingMessages.get('s1') as HTMLElement;
    const containers = el.querySelectorAll('.memory-recall-container');
    expect(containers.length).toBe(1);
    expect(containers[0]?.textContent).toContain('新记忆');
  });
});

// ─── 7. showThinkingPhase ───────────────────────────────

describe('showThinkingPhase', () => {
  it('messageId 不存在时应静默返回', () => {
    const { manager } = createManager();
    expect(() => manager.showThinkingPhase('nonexistent', 'recalling')).not.toThrow();
  });

  it('应创建新指示器并显示中文阶段文案', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    manager.showThinkingPhase('s1', 'recalling');
    const el = streamingMessages.get('s1') as HTMLElement;
    const indicator = el.querySelector('.thinking-phase');
    expect(indicator?.innerHTML).toContain('icon-gear');
    expect(indicator?.textContent).toContain('正在回忆相关记忆...');
  });

  it('应更新已存在指示器 + 未知 phase 降级显示原始字符串', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    // startStreaming 已创建 thinking-phase（"正在思考..."），showThinkingPhase 应复用
    manager.showThinkingPhase('s1', 'processing');
    let el = streamingMessages.get('s1') as HTMLElement;
    expect(el.querySelector('.thinking-phase')?.innerHTML).toContain('icon-gear');
    expect(el.querySelector('.thinking-phase')?.textContent).toContain('正在处理请求...');
    // 未知 phase 降级显示原始字符串
    manager.showThinkingPhase('s1', 'unknown-phase');
    el = streamingMessages.get('s1') as HTMLElement;
    expect(el.querySelector('.thinking-phase')?.innerHTML).toContain('icon-gear');
    expect(el.querySelector('.thinking-phase')?.textContent).toContain('unknown-phase');
    // 仍只有一个指示器
    expect(el.querySelectorAll('.thinking-phase').length).toBe(1);
  });
});

// ─── 8. showTruncationNotice ─────────────────────────────

describe('showTruncationNotice', () => {
  it('count=1 应显示截断提示并插入到 bubble 顶部', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    manager.showTruncationNotice('s1', 1);
    const el = streamingMessages.get('s1') as HTMLElement;
    const bubble = el.querySelector('.message-bubble') as HTMLElement;
    const notice = bubble.querySelector('.truncation-notice');
    // 图标 span 含 SVG use 引用
    expect(notice?.querySelector('.truncation-icon use')?.getAttribute('href')).toBe('#icon-warning');
    // 文本 span 承载文案（独立 span，无前导空格）
    expect(notice?.querySelector('.truncation-text')?.textContent).toBe('上下文已截断，部分历史已省略');
    // 关闭按钮存在
    expect(notice?.querySelector('.truncation-close')).not.toBeNull();
    // 应插入到 bubble 顶部（firstChild）
    expect(bubble.firstChild).toBe(notice);
  });

  it('count>1 应显示次数 + 已存在时更新文案不重复创建', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    manager.showTruncationNotice('s1', 1);
    manager.showTruncationNotice('s1', 3);
    const el = streamingMessages.get('s1') as HTMLElement;
    const bubble = el.querySelector('.message-bubble') as HTMLElement;
    const notices = bubble.querySelectorAll('.truncation-notice');
    expect(notices.length).toBe(1);
    expect(notices[0]?.querySelector('.truncation-icon use')?.getAttribute('href')).toBe('#icon-warning');
    expect(notices[0]?.querySelector('.truncation-text')?.textContent).toBe('上下文已截断 3 次，部分历史已省略');
  });
});

// ─── 9. showToolStart ────────────────────────────────────

describe('showToolStart', () => {
  it('messageId 不存在时应静默返回', () => {
    const { manager } = createManager();
    expect(() => manager.showToolStart('nonexistent', 'tc1', 'tool')).not.toThrow();
  });

  it('应创建工具卡片含 chevron + icon + name + spinner + 状态', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    manager.showToolStart('s1', 'tc1', 'readFile');
    const el = streamingMessages.get('s1') as HTMLElement;
    const card = el.querySelector('.tool-call-card');
    expect(card?.classList.contains('tool-call-running')).toBe(true);
    expect(card?.getAttribute('data-tool-call-id')).toBe('tc1');
    expect(card?.getAttribute('data-tool-name')).toBe('readFile');
    const header = card?.querySelector('.tool-call-header');
    expect(header?.querySelector('.tool-call-chevron')?.innerHTML).toContain('icon-chevron');
    expect(header?.querySelector('.tool-call-name')?.textContent).toBe('readFile');
    expect(header?.querySelector('.tool-call-spinner')).toBeTruthy();
    expect(header?.querySelector('.tool-call-status')?.textContent).toBe('执行中...');
    // header 应有 data-action="toggle-collapse"
    expect(header?.getAttribute('data-action')).toBe('toggle-collapse');
  });

  it('有 args 时应附加 tool-call-args + 插入到光标之前', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    manager.showToolStart('s1', 'tc1', 'search', '{"query":"test"}');
    const el = streamingMessages.get('s1') as HTMLElement;
    const bubble = el.querySelector('.message-bubble') as HTMLElement;
    const card = bubble.querySelector('.tool-call-card');
    expect(card?.querySelector('.tool-call-args')?.textContent).toBe('{"query":"test"}');
    // 应插入到光标之前
    const children = Array.from(bubble.children);
    const cardIndex = children.indexOf(card as HTMLElement);
    const cursorIndex = children.indexOf(bubble.querySelector('.cursor') as HTMLElement);
    expect(cardIndex).toBeLessThan(cursorIndex);
  });
});

// ─── 10. updateToolResult ────────────────────────────────

describe('updateToolResult', () => {
  it('messageId 不存在时应静默返回', () => {
    const { manager } = createManager();
    expect(() => manager.updateToolResult('nonexistent', 'tc1', 'tool', true)).not.toThrow();
  });

  it('精确匹配：ok=true → tool-call-success + ✓ 成功 + 移除 spinner + collapsed', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    manager.showToolStart('s1', 'tc1', 'readFile');
    manager.updateToolResult('s1', 'tc1', 'readFile', true);
    const el = streamingMessages.get('s1') as HTMLElement;
    const card = el.querySelector('.tool-call-card');
    expect(card?.classList.contains('tool-call-success')).toBe(true);
    expect(card?.classList.contains('tool-call-running')).toBe(false);
    expect(card?.querySelector('.tool-call-status')?.innerHTML).toContain('icon-check');
    // spinner 应被移除
    expect(card?.querySelector('.tool-call-spinner')).toBeNull();
    // 应自动折叠
    expect(card?.classList.contains('collapsed')).toBe(true);
  });

  it('精确匹配：ok=false → tool-call-failed + ✗ 失败 + summary', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    manager.showToolStart('s1', 'tc1', 'readFile');
    manager.updateToolResult('s1', 'tc1', 'readFile', false, '文件不存在');
    const el = streamingMessages.get('s1') as HTMLElement;
    const card = el.querySelector('.tool-call-card');
    expect(card?.classList.contains('tool-call-failed')).toBe(true);
    expect(card?.querySelector('.tool-call-status')?.innerHTML).toContain('icon-close');
    expect(card?.querySelector('.tool-call-result')?.textContent).toBe('文件不存在');
  });

  it('精确匹配失败时降级按 data-tool-name 匹配最后一个 running 卡片', () => {
    const { manager, streamingMessages } = createManager();
    manager.startStreaming('s1');
    // 用不同 toolCallId 创建卡片
    manager.showToolStart('s1', 'tc-other', 'search', '{}');
    // updateToolResult 用不匹配的 toolCallId 但匹配的 name
    manager.updateToolResult('s1', 'tc-mismatch', 'search', true, 'found 3 results');
    const el = streamingMessages.get('s1') as HTMLElement;
    const card = el.querySelector('.tool-call-card');
    expect(card?.classList.contains('tool-call-success')).toBe(true);
    expect(card?.querySelector('.tool-call-result')?.textContent).toBe('found 3 results');
  });
});

// ─── 11. stopAllStreaming ────────────────────────────────

describe('stopAllStreaming', () => {
  it('应取消挂起 rAF + 移除所有流式消息的 streaming 类和光标', () => {
    const { manager, messagesEl } = createManager();
    manager.startStreaming('s1');
    manager.updateStreamingMessage('s1', 'text'); // rAF pending
    manager.stopAllStreaming();
    expect(canceledHandles.length).toBeGreaterThan(0);
    const msg = messagesEl.querySelector('.message') as HTMLElement;
    expect(msg.classList.contains('streaming')).toBe(false);
    expect(msg.querySelector('.cursor')).toBeNull();
  });

  it('应清空 streamingMessages + 重置 isStreaming + 清除定时器 + updateSendButton', () => {
    const { manager, host, streamingMessages } = createManager();
    manager.startStreaming('s1');
    manager.stopAllStreaming();
    expect(streamingMessages.size).toBe(0);
    expect(host.setStreaming).toHaveBeenCalledWith(false);
    expect(host.updateSendButton).toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(host.onStreamStuck).not.toHaveBeenCalled();
  });
});

// ─── 12. clearMessages ───────────────────────────────────

describe('clearMessages', () => {
  it('应移除所有 .message 元素 + #load-more-container（保留 #chat-empty-state）', () => {
    const { manager, messagesEl } = createManager();
    manager.appendMessage(userMsg('a', 'u1'));
    manager.appendMessage(assistantMsg('b', 'a1'));
    manager.showLoadMore(5, () => {});
    expect(messagesEl.querySelectorAll('.message').length).toBe(2);
    expect(messagesEl.querySelector('#load-more-container')).toBeTruthy();
    manager.clearMessages();
    expect(messagesEl.querySelectorAll('.message').length).toBe(0);
    expect(messagesEl.querySelector('#load-more-container')).toBeNull();
    // #chat-empty-state 应保留
    expect(document.getElementById('chat-empty-state')).toBeTruthy();
  });

  it('应清空 streamingMessages + 重置状态 + 调用 host 回调', () => {
    const { manager, host, streamingMessages } = createManager();
    manager.startStreaming('s1');
    host.updateSendButton.mockClear();
    host.setStreaming.mockClear();
    manager.clearMessages();
    expect(streamingMessages.size).toBe(0);
    expect(host.setStreaming).toHaveBeenCalledWith(false);
    expect(host.updateSendButton).toHaveBeenCalled();
    expect(host.showEmptyState).toHaveBeenCalled();
    expect(host.forceScrollToBottom).toHaveBeenCalled();
  });
});

// ─── 13. appendMessages ──────────────────────────────────

describe('appendMessages', () => {
  it('空数组时应静默返回（不触发 host 回调）', () => {
    const { manager, host } = createManager();
    manager.appendMessages([]);
    expect(host.hideEmptyState).not.toHaveBeenCalled();
    expect(host.forceScrollToBottom).not.toHaveBeenCalled();
  });

  it('prepend=false 应追加到末尾 + 调用 host 回调', () => {
    const { manager, host, messagesEl } = createManager();
    manager.appendMessages([userMsg('a', 'u1'), assistantMsg('b', 'a1')]);
    expect(messagesEl.querySelectorAll('.message').length).toBe(2);
    expect(host.hideEmptyState).toHaveBeenCalled();
    expect(host.forceScrollToBottom).toHaveBeenCalled();
  });

  it('prepend=true 应插入到顶部（load-more-container 之后）', () => {
    const { manager, messagesEl } = createManager();
    manager.showLoadMore(5, () => {});
    manager.appendMessages([userMsg('new', 'u1')], true);
    const messages = messagesEl.querySelectorAll('.message');
    expect(messages.length).toBe(1);
    // load-more 应在 message 之前（loadMore.after(fragment)）
    const loadMore = messagesEl.querySelector('#load-more-container');
    expect(messagesEl.firstChild).toBe(loadMore);
  });
});

// ─── 14. showLoadMore / hideLoadMore / showLoadEarlierDay ─

describe('showLoadMore / hideLoadMore / showLoadEarlierDay', () => {
  it('showLoadMore 应创建容器 + 按钮 + 保存回调 + 点击禁用按钮', () => {
    const { manager, messagesEl } = createManager();
    const cb = vi.fn();
    manager.showLoadMore(10, cb);
    const container = messagesEl.querySelector('#load-more-container');
    expect(container).toBeTruthy();
    const btn = container?.querySelector('[data-action="load-more"]');
    expect(btn?.textContent).toContain('剩余 10 条');
    btn?.click();
    expect(cb).toHaveBeenCalled();
    expect(btn?.hasAttribute('disabled')).toBe(true);
    expect(btn?.textContent).toBe('加载中...');
  });

  it('hideLoadMore 移除容器 + showLoadMore 移除旧容器避免重复', () => {
    const { manager, messagesEl } = createManager();
    manager.showLoadMore(5, () => {});
    expect(messagesEl.querySelector('#load-more-container')).toBeTruthy();
    manager.hideLoadMore();
    expect(messagesEl.querySelector('#load-more-container')).toBeNull();
    // showLoadMore 再次调用应移除旧容器（不重复）
    manager.showLoadMore(3, () => {});
    manager.showLoadMore(1, () => {});
    expect(messagesEl.querySelectorAll('#load-more-container').length).toBe(1);
  });

  it('showLoadEarlierDay 应创建按钮 + "加载更早的对话"文案 + 点击禁用', () => {
    const { manager, messagesEl } = createManager();
    const cb = vi.fn();
    manager.showLoadEarlierDay(cb);
    const btn = messagesEl.querySelector('[data-action="load-earlier-day"]');
    expect(btn?.textContent).toBe('加载更早的对话');
    btn?.click();
    expect(cb).toHaveBeenCalled();
    expect(btn?.hasAttribute('disabled')).toBe(true);
  });
});

// ─── 15. markStreamingAborted ────────────────────────────

describe('markStreamingAborted', () => {
  it('messageId 不存在时应静默返回', () => {
    const { manager, host } = createManager();
    manager.markStreamingAborted('nonexistent', '用户停止');
    expect(host.updateSendButton).not.toHaveBeenCalled();
  });

  it('应取消 rAF + 移除光标/thinking-phase + 嵌入中断标记 + 添加复制按钮', () => {
    const { manager, messagesEl } = createManager();
    manager.startStreaming('s1');
    manager.updateStreamingMessage('s1', 'partial'); // rAF pending
    manager.markStreamingAborted('s1', '用户手动停止');
    expect(canceledHandles.length).toBeGreaterThan(0);
    const msg = messagesEl.querySelector('.message') as HTMLElement;
    expect(msg.querySelector('.cursor')).toBeNull();
    expect(msg.querySelector('.thinking-phase')).toBeNull();
    const aborted = msg.querySelector('.stream-aborted');
    // SVG 图标 + 文本分离：textContent 不含图标
    expect(aborted?.querySelector('use')?.getAttribute('href')).toBe('#icon-stop');
    expect(aborted?.textContent).toBe(' 已中断：用户手动停止（已保留上方生成内容）');
    // 复制按钮应被添加（addCopyButtonToMessage）
    expect(msg.querySelector('[data-action="copy"]')).toBeTruthy();
  });

  it('应完整清理流式状态（delete + isStreaming=false + 清除定时器 + updateSendButton）', () => {
    const { manager, host, streamingMessages } = createManager();
    manager.startStreaming('s1');
    host.updateSendButton.mockClear();
    host.setStreaming.mockClear();
    manager.markStreamingAborted('s1', '停止');
    expect(streamingMessages.has('s1')).toBe(false);
    expect(host.setStreaming).toHaveBeenCalledWith(false);
    expect(host.updateSendButton).toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(host.onStreamStuck).not.toHaveBeenCalled();
  });

  it('幂等保护：已存在 .stream-aborted 时不重复嵌入但仍清理状态', () => {
    const { manager, host, streamingMessages } = createManager();
    manager.startStreaming('s1');
    // 手动添加中断标记（模拟已嵌入场景）
    const el = streamingMessages.get('s1') as HTMLElement;
    const bubble = el.querySelector('.message-bubble') as HTMLElement;
    const prior = document.createElement('div');
    prior.className = 'stream-aborted';
    prior.textContent = '已中断：prior（已保留上方生成内容）';
    bubble.appendChild(prior);
    manager.markStreamingAborted('s1', '第二次停止');
    // 不应重复嵌入
    expect(bubble.querySelectorAll('.stream-aborted').length).toBe(1);
    // 仍应清理状态
    expect(streamingMessages.has('s1')).toBe(false);
    expect(host.setStreaming).toHaveBeenCalledWith(false);
  });
});

// ─── 16. injectErrorToStreamingMessages ──────────────────

describe('injectErrorToStreamingMessages', () => {
  it('无流式消息时应静默返回', () => {
    const { manager, host } = createManager();
    manager.injectErrorToStreamingMessages('错误');
    expect(host.updateSendButton).not.toHaveBeenCalled();
    expect(host.scrollToBottom).not.toHaveBeenCalled();
  });

  it('应嵌入错误指示器 + 重试按钮 + 移除光标/thinking-phase', () => {
    const { manager, messagesEl } = createManager();
    manager.startStreaming('s1');
    manager.injectErrorToStreamingMessages('网络中断');
    const msg = messagesEl.querySelector('.message') as HTMLElement;
    const error = msg.querySelector('.stream-error');
    // SVG 图标 + 文本分离：textContent 不含图标
    expect(error?.querySelector('use')?.getAttribute('href')).toBe('#icon-warning');
    expect(error?.textContent).toBe(' 网络中断');
    const retryBtn = msg.querySelector('.stream-error-retry');
    expect(retryBtn?.getAttribute('data-action')).toBe('retry');
    expect(retryBtn?.textContent).toBe('重试');
    expect(msg.querySelector('.cursor')).toBeNull();
    expect(msg.querySelector('.thinking-phase')).toBeNull();
    expect(msg.classList.contains('streaming')).toBe(false);
  });

  it('应清空 streamingMessages + 重置 isStreaming + 清除定时器 + scrollToBottom', () => {
    const { manager, host, streamingMessages } = createManager();
    manager.startStreaming('s1');
    host.updateSendButton.mockClear();
    host.setStreaming.mockClear();
    host.scrollToBottom.mockClear();
    manager.injectErrorToStreamingMessages('错误');
    expect(streamingMessages.size).toBe(0);
    expect(host.setStreaming).toHaveBeenCalledWith(false);
    expect(host.updateSendButton).toHaveBeenCalled();
    expect(host.scrollToBottom).toHaveBeenCalled();
    vi.advanceTimersByTime(30_000);
    expect(host.onStreamStuck).not.toHaveBeenCalled();
  });
});

// ─── 17. 空状态引导 ──────────────────────────────────────

describe('空状态引导', () => {
  it('initEmptyStateListeners 应绑定 suggestion-btn 点击', () => {
    const { manager } = createManager({ initEmptyState: true });
    const cb = vi.fn();
    manager.onSuggestionClick(cb);
    const btn = document.querySelector('.suggestion-btn') as HTMLElement;
    btn.click();
    expect(cb).toHaveBeenCalledWith('你好');
  });

  it('showEmptyState 移除 hidden 类 + hideEmptyState 添加 hidden 类', () => {
    const { manager } = createManager();
    const emptyState = document.getElementById('chat-empty-state') as HTMLElement;
    // 初始有 hidden 类
    expect(emptyState.classList.contains('hidden')).toBe(true);
    manager.showEmptyState();
    expect(emptyState.classList.contains('hidden')).toBe(false);
    manager.hideEmptyState();
    expect(emptyState.classList.contains('hidden')).toBe(true);
  });

  it('元素缺失时应降级不抛错', () => {
    // 构建不含 #chat-empty-state 的 DOM
    document.body.innerHTML = '<div id="chat-messages"></div>';
    const messagesEl = document.getElementById('chat-messages') as HTMLElement;
    const events = new EventTracker();
    const streamingMessages = new Map<string, HTMLElement>();
    const host = createMockHost();
    const manager = new ChatPanelManager(host, messagesEl, events, streamingMessages);
    expect(() => manager.showEmptyState()).not.toThrow();
    expect(() => manager.hideEmptyState()).not.toThrow();
    expect(() => manager.initEmptyStateListeners()).not.toThrow();
  });
});

// ─── 18. 事件委托 click 分发 ─────────────────────────────

describe('事件委托 · click 分发', () => {
  it('data-action=copy 应触发 clipboard.writeText + 成功 toast', async () => {
    const { host, messagesEl } = createManager();
    const btn = document.createElement('button');
    btn.dataset.action = 'copy';
    btn.dataset.content = 'copy me';
    messagesEl.appendChild(btn);
    btn.click();
    expect(clipboardWriteText).toHaveBeenCalledWith('copy me');
    // 等待 Promise 微任务（clipboard.writeText 返回 resolved Promise）
    await Promise.resolve();
    await Promise.resolve();
    expect(host.showToast).toHaveBeenCalledWith('已复制到剪贴板', 'success', 1500);
  });

  it('clipboard.writeText 失败时应显示 error toast', async () => {
    const { host, messagesEl } = createManager();
    clipboardWriteText.mockRejectedValueOnce(new Error('denied'));
    const btn = document.createElement('button');
    btn.dataset.action = 'copy';
    btn.dataset.content = 'fail me';
    messagesEl.appendChild(btn);
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.showToast).toHaveBeenCalledWith('复制失败，请手动选择文本复制', 'error');
  });

  it('data-action=copy-code 应触发 clipboard + 按钮文本切换"已复制" + 1.2s 恢复', async () => {
    const { host, messagesEl } = createManager();
    const btn = document.createElement('button');
    btn.dataset.action = 'copy-code';
    btn.dataset.content = 'code snippet';
    btn.textContent = '复制代码';
    messagesEl.appendChild(btn);
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(host.showToast).toHaveBeenCalledWith('已复制代码', 'success', 2000);
    // 按钮文本应切换为"已复制"
    expect(btn.textContent).toBe('已复制');
    expect(btn.classList.contains('copied')).toBe(true);
    // 1.2s 后恢复
    vi.advanceTimersByTime(1200);
    expect(btn.textContent).toBe('复制代码');
    expect(btn.classList.contains('copied')).toBe(false);
  });

  it('data-action=recall 应触发 memoryRecallClickCallback（传递 data-memory-id）', () => {
    const { manager, messagesEl } = createManager();
    const cb = vi.fn();
    manager.setMemoryRecallClickCallback(cb);
    const item = document.createElement('div');
    item.dataset.action = 'recall';
    item.dataset.memoryId = 'insight:记忆详情';
    item.dataset.name = '记忆详情';
    messagesEl.appendChild(item);
    item.click();
    expect(cb).toHaveBeenCalledWith('insight:记忆详情');
  });

  it('data-action=toggle-collapse 应切换 .tool-call-card 的 collapsed 类', () => {
    const { messagesEl } = createManager();
    const card = document.createElement('div');
    card.className = 'tool-call-card collapsed';
    const header = document.createElement('div');
    header.dataset.action = 'toggle-collapse';
    card.appendChild(header);
    messagesEl.appendChild(card);
    header.click();
    expect(card.classList.contains('collapsed')).toBe(false);
    header.click();
    expect(card.classList.contains('collapsed')).toBe(true);
  });

  it('data-action=dismiss-truncation 应移除 .truncation-notice 元素', () => {
    const { messagesEl } = createManager();
    // 模拟消息气泡内的截断提示条结构
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    const notice = document.createElement('div');
    notice.className = 'truncation-notice';
    const closeBtn = document.createElement('button');
    closeBtn.dataset.action = 'dismiss-truncation';
    notice.appendChild(closeBtn);
    bubble.appendChild(notice);
    messagesEl.appendChild(bubble);
    // 点击关闭按钮应移除整个 notice
    closeBtn.click();
    expect(messagesEl.querySelector('.truncation-notice')).toBeNull();
  });

  it('data-action=load-more 应禁用按钮 + 文本"加载中..." + 触发回调', () => {
    const { manager, messagesEl } = createManager();
    const cb = vi.fn();
    manager.showLoadMore(5, cb);
    const btn = messagesEl.querySelector('[data-action="load-more"]') as HTMLElement;
    btn.click();
    expect(cb).toHaveBeenCalled();
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.textContent).toBe('加载中...');
  });

  it('data-action=load-earlier-day + retry 应禁用按钮 + 触发各自回调', () => {
    const { manager, messagesEl } = createManager();
    // load-earlier-day
    const earlierCb = vi.fn();
    manager.showLoadEarlierDay(earlierCb);
    const earlierBtn = messagesEl.querySelector('[data-action="load-earlier-day"]') as HTMLElement;
    earlierBtn.click();
    expect(earlierCb).toHaveBeenCalled();
    expect(earlierBtn.hasAttribute('disabled')).toBe(true);
    expect(earlierBtn.textContent).toBe('加载中...');
    // retry：先注入错误创建 retry 按钮
    manager.startStreaming('s1');
    manager.injectErrorToStreamingMessages('出错');
    const retryCb = vi.fn();
    manager.onErrorRetry(retryCb);
    const retryBtn = messagesEl.querySelector('[data-action="retry"]') as HTMLElement;
    retryBtn.click();
    expect(retryCb).toHaveBeenCalled();
    expect(retryBtn.hasAttribute('disabled')).toBe(true);
    expect(retryBtn.textContent).toBe('重试中...');
  });
});

// ─── 19. 回调注册 ────────────────────────────────────────

describe('回调注册', () => {
  it('onSuggestionClick 应注册 suggestionClickCallback', () => {
    const { manager } = createManager({ initEmptyState: true });
    const cb = vi.fn();
    manager.onSuggestionClick(cb);
    document.querySelector('.suggestion-btn')?.click();
    expect(cb).toHaveBeenCalled();
  });

  it('setMemoryRecallClickCallback 应注册 memoryRecallClickCallback', () => {
    const { manager, messagesEl } = createManager();
    const cb = vi.fn();
    manager.setMemoryRecallClickCallback(cb);
    const item = document.createElement('div');
    item.dataset.action = 'recall';
    item.dataset.memoryId = 'profile:test-mem';
    item.dataset.name = 'test-mem';
    messagesEl.appendChild(item);
    item.click();
    expect(cb).toHaveBeenCalledWith('profile:test-mem');
  });

  it('onErrorRetry 应注册 errorRetryCallback', () => {
    const { manager, messagesEl } = createManager();
    const cb = vi.fn();
    manager.onErrorRetry(cb);
    const btn = document.createElement('button');
    btn.dataset.action = 'retry';
    messagesEl.appendChild(btn);
    btn.click();
    expect(cb).toHaveBeenCalled();
  });

  // 回调执行后按钮应恢复可点击状态
  it('retry 回调执行后应恢复按钮状态（disabled 移除 + 文案恢复）', async () => {
    const { manager, messagesEl } = createManager();
    const retryCb = vi.fn();
    manager.onErrorRetry(retryCb);

    // 创建 retry 按钮并点击
    const btn = document.createElement('button');
    btn.dataset.action = 'retry';
    btn.textContent = '重试';
    messagesEl.appendChild(btn);
    btn.click();

    // 点击后应禁用
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(btn.textContent).toBe('重试中...');

    // 等待 async IIFE 完成（retryCb 是同步函数，await void 后 finally 执行）
    await Promise.resolve();
    await Promise.resolve();

    // 按钮应恢复
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.textContent).toBe('重试');
    expect(retryCb).toHaveBeenCalled();
  });

  // async 回调 reject 时按钮也应恢复
  it('retry 回调抛错时按钮也应恢复（finally 兜底）', async () => {
    const { manager, messagesEl } = createManager();
    const retryCb = vi.fn().mockRejectedValue(new Error('重试失败'));
    manager.onErrorRetry(retryCb);

    const btn = document.createElement('button');
    btn.dataset.action = 'retry';
    btn.textContent = '重试';
    messagesEl.appendChild(btn);
    btn.click();

    // 等待 async IIFE 完成（含 rejected promise）
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // 按钮应恢复（finally 兜底）
    expect(btn.hasAttribute('disabled')).toBe(false);
    expect(btn.textContent).toBe('重试');
  });
});

// ─── 20. 超时兜底定时器 ──────────────────────────────────

describe('超时兜底定时器', () => {
  it('30s 无新 chunk 应触发 host.onStreamStuck', () => {
    const { manager, host } = createManager();
    manager.startStreaming('s1');
    vi.advanceTimersByTime(30_000);
    expect(host.onStreamStuck).toHaveBeenCalledTimes(1);
  });

  it('90s 二级兜底应本地清理（streamingMessages.clear + isStreaming=false）', () => {
    const { manager, host, streamingMessages } = createManager();
    manager.startStreaming('s1');
    // 30s 触发 onStreamStuck + 启动 60s fallback
    vi.advanceTimersByTime(30_000);
    expect(host.onStreamStuck).toHaveBeenCalled();
    host.updateSendButton.mockClear();
    host.setStreaming.mockClear();
    // 60s 后 fallback 触发本地清理
    vi.advanceTimersByTime(60_000);
    expect(streamingMessages.size).toBe(0);
    expect(host.setStreaming).toHaveBeenCalledWith(false);
    expect(host.updateSendButton).toHaveBeenCalled();
  });

  it('safetyTimer.reset 应清除旧定时器再设新（多次调用不累积）', () => {
    const { manager, host } = createManager();
    manager.startStreaming('s1');
    // 多次重置定时器（通过 updateStreamingMessage）
    manager.updateStreamingMessage('s1', 'chunk1');
    manager.updateStreamingMessage('s1', 'chunk2');
    manager.updateStreamingMessage('s1', 'chunk3');
    // 29s 不应触发（最后一次重置后仅过了 29s）
    vi.advanceTimersByTime(29_999);
    expect(host.onStreamStuck).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(host.onStreamStuck).toHaveBeenCalledTimes(1);
  });
});

// ─── 21. B1：对话区内联里程碑 banner ─────────────────────

describe('appendMilestoneBanner · 对话区内联里程碑 banner', () => {
  it('应在 messagesEl 末尾追加 .milestone-banner 元素（含奖杯图标 + 文本 + 关闭按钮）', () => {
    const { manager, messagesEl, host } = createManager();
    manager.appendMilestoneBanner('达成里程碑：首次完成 UI 布局重构方案');

    const banner = messagesEl.querySelector('.milestone-banner');
    expect(banner).toBeTruthy();
    // 奖杯图标存在（svg.milestone-icon）
    expect(banner!.querySelector('svg.milestone-icon')).toBeTruthy();
    // 文本正确注入
    expect(banner!.querySelector('.milestone-text')?.textContent).toBe('达成里程碑：首次完成 UI 布局重构方案');
    // 关闭按钮存在且 data-action="close-milestone"
    const closeBtn = banner!.querySelector('button.milestone-close');
    expect(closeBtn).toBeTruthy();
    expect(closeBtn!.dataset.action).toBe('close-milestone');
    // 通知主进程已显示（用于清除未读计数）由 ipcListeners 调用，此处不验证
    // host.hideEmptyState 应被调用（有内容时隐藏空状态）
    expect(host.hideEmptyState).toHaveBeenCalled();
    // host.scrollToBottom 应被调用（确保用户看到新里程碑）
    expect(host.scrollToBottom).toHaveBeenCalled();
  });

  it('不应参与消息分组（lastMessageRole 不变，前后同角色消息仍应分组）', () => {
    const { manager, messagesEl } = createManager();
    // 连续两条 assistant 消息（间隔 < 2 分钟，本应分组）
    manager.appendMessage(assistantMsg('hello', 'a1'));
    // 中间插入里程碑 banner，不应重置分组状态
    manager.appendMilestoneBanner('达成里程碑');
    // 第三条 assistant 消息：与第一条间隔很短，应分组到第一条（隐藏头像）
    manager.appendMessage(assistantMsg('world', 'a2'));
    // 验证：第二条 assistant 消息应被分组（含 .grouped class）
    const messages = messagesEl.querySelectorAll('.message.assistant');
    expect(messages.length).toBe(2);
    // 第二条消息应有 grouped class（里程碑不重置 lastMessageRole）
    expect(messages[1].classList.contains('grouped')).toBe(true);
    // 里程碑 banner 与消息共存于 messagesEl
    expect(messagesEl.querySelector('.milestone-banner')).toBeTruthy();
  });

  it('点击关闭按钮应移除整个 .milestone-banner 元素', () => {
    const { manager, messagesEl } = createManager();
    manager.appendMilestoneBanner('达成里程碑');
    expect(messagesEl.querySelectorAll('.milestone-banner').length).toBe(1);
    // 模拟点击关闭按钮
    const closeBtn = messagesEl.querySelector('.milestone-close') as HTMLElement;
    closeBtn.click();
    // banner 应被移除
    expect(messagesEl.querySelectorAll('.milestone-banner').length).toBe(0);
  });

  it('clearMessages 应同时清除 .milestone-banner 元素', () => {
    const { manager, messagesEl } = createManager();
    manager.appendMessage(userMsg('a', 'u1'));
    manager.appendMilestoneBanner('达成里程碑');
    expect(messagesEl.querySelectorAll('.milestone-banner').length).toBe(1);
    manager.clearMessages();
    // .message 与 .milestone-banner 都应被清除
    expect(messagesEl.querySelectorAll('.message').length).toBe(0);
    expect(messagesEl.querySelectorAll('.milestone-banner').length).toBe(0);
  });
});

