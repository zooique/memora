/**
 * chatView 测试 — clear_ok 消息区清理（对抗评估 P1-1 锁定）
 *
 * clear_ok 必须同时清 type=msg 消息与 .tool-card 工具卡片，否则切换历史/清空后
 * 旧工具卡片残留 DOM（P1-1 修复）。本测试用 jsdom 环境 + 注入 mock acquireVsCodeApi，
 * 直接通过 createChatView 工厂驱动真实消息分发，锁定清理行为。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createChatView } from '../scripts/chatView.js';

/** 覆盖 createChatView 全部 getElementById 引用的最小 HTML 骨架 */
const HTML = `
  <div id="toolbar">
    <span id="skillBadge" class="skill-badge" hidden></span>
  </div>
  <div id="memoryBar" class="memory-bar" hidden></div>
  <div id="noticeBar" class="notice-bar" hidden></div>
  <div id="messages"><div id="emptyState" class="empty-state" hidden></div></div>
  <div id="clarifyBar">
    <div id="clarifyText"></div>
    <div id="clarifyOptions"></div>
    <div id="clarifyRow">
      <input id="clarifyInput" />
      <button id="clarifySend">提交</button>
    </div>
  </div>
  <div id="inputBar">
    <div id="inputWrap">
      <textarea id="input"></textarea>
      <div id="inputFooter">
        <div class="model-picker treedd--capsule"><button class="treedd__trigger"></button><div class="treedd__menu"></div></div>
        <button id="send"></button>
      </div>
    </div>
  </div>
`;

/** 挂载 createChatView 并返回 postMessage mock（ready 消息在此被捕获） */
function mountChatView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  createChatView({
    acquireVsCodeApi: () => ({ postMessage }),
    window: window as unknown as Window,
  });
  return { postMessage };
}

/** 向 webview 分发一条 extension → webview 消息 */
function dispatch(msg: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data: msg }));
}

describe('chatView clear_ok 消息区清理', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('发送 ready 通知 extension 会话可安全回放', () => {
    const { postMessage } = mountChatView();
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('clear_ok 同时清空 .msg 与 .tool-card 残留，并恢复空状态', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    const emptyState = document.getElementById('emptyState') as HTMLElement;

    // 预先塞入一条消息 + 一张工具卡片（模拟历史回放后的残留）
    const msg = document.createElement('div');
    msg.className = 'msg assistant';
    messages.appendChild(msg);
    const card = document.createElement('div');
    card.className = 'tool-card is-failed';
    messages.appendChild(card);
    expect(messages.querySelectorAll('.msg, .tool-card')).toHaveLength(2);

    dispatch({ type: 'clear_ok' });

    // P1-1 修复锁定：两类节点都必须被清空，且空状态提示恢复显示
    expect(messages.querySelectorAll('.msg, .tool-card')).toHaveLength(0);
    expect(emptyState.hidden).toBe(false);
  });

  it('clear_ok 保留 #emptyState 占位（不整段清空 messages）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    dispatch({ type: 'clear_ok' });
    // 占位节点不被删除，仅消息类节点被清理
    expect(messages.querySelector('#emptyState')).not.toBeNull();
  });

  it('self_review 渲染过程性提示（自审查轮可见性，交叉审核观察 A）', () => {
    mountChatView();
    dispatch({ type: 'self_review', round: 1 });
    const sr = document.querySelector('.self-review') as HTMLElement;
    expect(sr).not.toBeNull();
    expect(sr?.textContent).toContain('自审查轮 1');
  });

  it('流式 chunk 在工具卡片插入后仍追加到同一条 assistant 消息（P0-1 锚点）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // 模拟「文本 → 工具卡 → 文本」循环：工具卡片插入不应拆散同一条回复
    dispatch({ type: 'chunk', content: '思考第一段' });
    dispatch({ type: 'tool_start', toolCallId: 't1', name: 'read_file', args: '{}' });
    dispatch({ type: 'tool_result', toolCallId: 't1', name: 'read_file', ok: true, summary: 'ok' });
    dispatch({ type: 'chunk', content: '思考第二段' });
    dispatch({ type: 'chunk', content: '思考第三段' });

    // 同一条回复应只有一条 assistant 消息，三段文本拼接在其内
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].querySelector('.msg-body')?.textContent).toBe(
      '思考第一段思考第二段思考第三段',
    );
  });

  it('clear_ok 后流式锚点失效，后续 chunk 重建一条 assistant 消息（P0-1）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    dispatch({ type: 'chunk', content: '第一段' });
    dispatch({ type: 'clear_ok' });
    dispatch({ type: 'chunk', content: '重放后' });

    // 清空后仅剩重建的一条 assistant 消息（旧锚点已失效，不残留）
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].querySelector('.msg-body')?.textContent).toBe('重放后');
  });
});