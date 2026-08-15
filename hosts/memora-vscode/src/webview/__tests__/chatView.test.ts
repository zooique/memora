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
  <div id="activityBar" class="activity-bar" hidden></div>
  <details id="activityDetail" class="activity-detail" hidden>
    <summary>活动详情</summary>
    <div id="activityList" class="activity-list"></div>
    <div id="activityMetrics" class="activity-metrics" hidden></div>
  </details>
  <div id="identityBar" class="identity-bar" hidden>
    <span class="identity-avatar" aria-hidden="true"></span>
    <span class="identity-role"></span>
    <span class="identity-model"></span>
    <span class="identity-status" data-state="idle">待命</span>
  </div>
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

  it('chat_role_pack 渲染当前角色到身份条并主动可见（角色包定位承载，ui-redesign.md §4.1 ①）', () => {
    mountChatView();
    const identityBar = document.getElementById('identityBar') as HTMLElement;
    const identityRole = identityBar.querySelector('.identity-role') as HTMLElement;
    const identityAvatar = identityBar.querySelector('.identity-avatar') as HTMLElement;
    // 未推送前隐藏
    expect(identityBar.hidden).toBe(true);

    dispatch({ type: 'chat_role_pack', rolePack: 'doc-review' });

    // textContent 赋值防注入 + 显示后主动可见（用户始终知道当前用哪个角色）
    expect(identityBar.hidden).toBe(false);
    expect(identityRole.textContent).toBe('doc-review');
    expect(identityAvatar.textContent).toBe('d');
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

  it('self_review 渲染过程性提示到思考折叠块（自审查轮可见性，ui-redesign.md §7.1）', () => {
    mountChatView();
    dispatch({ type: 'self_review', round: 1 });
    const tb = document.querySelector('.thought-block') as HTMLDetailsElement;
    expect(tb).not.toBeNull();
    expect(tb.textContent).toContain('自审查轮 1');
    expect(tb.open).toBe(true);
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

  it('历史切换重建：clear_ok 后重放 user/assistant 消息正常渲染（ui-redesign 历史加载链路）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    const emptyState = document.getElementById('emptyState') as HTMLElement;

    // 模拟 handleSwitchDate 的完整重放序列：先 clear_ok，再逐条 post user/assistant
    dispatch({ type: 'clear_ok' });
    dispatch({ type: 'user', text: '昨天的问题', ts: '2026-08-14T09:00:00.000Z' });
    dispatch({ type: 'assistant', text: '昨天的回答', ts: '2026-08-14T09:00:30.000Z' });

    // 重放的两条消息都应渲染，且空状态隐藏
    const msgs = messages.querySelectorAll('.msg');
    expect(msgs).toHaveLength(2);
    expect(messages.querySelector('.msg.user .msg-body')?.textContent).toBe('昨天的问题');
    expect(messages.querySelector('.msg.assistant .msg-body')?.textContent).toBe('昨天的回答');
    expect(emptyState.hidden).toBe(true);
  });
});

describe('chatView 打断能力（mvp-scope stop / 插话）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('生成中（status thinking）输入框保持可用（支持插话）', () => {
    mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'thinking' });
    // 插话能力前提：生成中不禁用输入框，用户可输入新消息 → Enter 打断当前生成并重发
    expect(input.disabled).toBe(false);
  });

  it('生成中发送按钮切换为停止态，点击发送 stop 消息', () => {
    const { postMessage } = mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    dispatch({ type: 'status', state: 'thinking' });
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.title).toBe('停止生成');
    send.click();
    // 生成中点击按钮 = 停止（不是发送），发 stop 消息由 host 中断当前流
    expect(postMessage).toHaveBeenCalledWith({ type: 'stop' });
  });

  it('done 恢复发送态（loading 移除 + 发送提示）', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    dispatch({ type: 'status', state: 'thinking' });
    dispatch({ type: 'status', state: 'done' });
    expect(send.classList.contains('loading')).toBe(false);
    expect(send.title).toBe('发送 (Enter)');
  });

  it('空闲点击发送按钮发送输入内容', () => {
    const { postMessage } = mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    input.value = '打磨这段';
    send.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'send', text: '打磨这段' });
  });

  it('生成中按 Enter 仍发送（插话语义：打断当前生成并重发）', () => {
    const { postMessage } = mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'thinking' });
    input.value = '补充要求';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'send', text: '补充要求' });
  });

  it('interrupted 渲染「已停止生成」提示条', () => {
    mountChatView();
    dispatch({ type: 'interrupted' });
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(false);
    expect(activityBar.textContent).toContain('已停止生成');
  });
});

describe('chatView 事件流对齐（P1 事件流 / P2 活动指标）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handoff(loop) 渲染「自动续跑」低扰提示条（活动透明，雷-4 低频）', () => {
    mountChatView();
    dispatch({ type: 'handoff', decision: 'loop', reason: '后续步骤' });
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(false);
    expect(activityBar.textContent).toContain('自动续跑');
  });

  it('retry 渲染「LLM 重试 n/m」低扰提示条', () => {
    mountChatView();
    dispatch({ type: 'retry', attempt: 1, maxRetries: 3, delayMs: 200, error: 'ECONNRESET' });
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(false);
    expect(activityBar.textContent).toContain('重试 1/3');
  });

  it('paused 渲染「Agent 已暂停」提示条', () => {
    mountChatView();
    dispatch({ type: 'paused' });
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(false);
    expect(activityBar.textContent).toContain('已暂停');
  });

  it('guardrailBlocked chunk 渲染「护栏阻断」提示条且文本正常追加（§7.2.1）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '被阻断的回复', guardrailBlocked: true });
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(false);
    expect(activityBar.textContent).toContain('护栏阻断');
    // 文本仍正常追加到 assistant 消息（阻断 ≠ 丢弃内容，仅附加提示）
    const body = document.querySelector('.msg.assistant .msg-body');
    expect(body?.textContent).toBe('被阻断的回复');
  });

  it('metrics 渲染活动详情折叠区（指纹只显示 hash 与计数，不显示内容）', () => {
    mountChatView();
    const detail = document.getElementById('activityDetail') as HTMLElement;
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    // 未推送前默认隐藏
    expect(detail.hidden).toBe(true);

    dispatch({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'a1b2c3d4e5f6', attachedMemoryCount: 3 },
      metrics: { llmCallCount: 5, recallHitRate: 0.8, toolFailureCount: 1, truncationCount: 0 },
    });

    // metrics 只进详情折叠区，不占用主状态条（P2 不占主条）
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(true);
    expect(detail.hidden).toBe(false);
    expect(metrics.hidden).toBe(false);
    expect(metrics.textContent).toContain('系统提示 a1b2c3d4e5f6');
    expect(metrics.textContent).toContain('附着记忆 3 条');
    expect(metrics.textContent).toContain('LLM 5 次');
    expect(metrics.textContent).toContain('召回命中 80%');
  });

  it('P0 错误显示期间 P1 低扰不打断（错误优先保护，P1 仅进详情历史）', () => {
    mountChatView();
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    const list = document.getElementById('activityList') as HTMLElement;
    // 先发错误（P0）
    dispatch({ type: 'notice', level: 'error', message: '会话异常：超时' });
    expect(activityBar.textContent).toContain('会话异常');
    expect(activityBar.className).toContain('error');
    // 错误显示期间来低扰 info → 不覆盖主条，仅进历史
    dispatch({ type: 'memory', action: 'recalled', count: 2 });
    expect(activityBar.textContent).toContain('会话异常'); // 主条仍保持错误
    expect(activityBar.className).toContain('error');
    // 低扰信息进入详情历史（不丢失）
    expect(list.textContent).toContain('已召回 2 条记忆');
    // 新错误覆盖旧错误（P0 覆盖 P0）
    dispatch({ type: 'notice', level: 'error', message: '护栏规则未生效' });
    expect(activityBar.textContent).toContain('护栏规则未生效');
  });

  it('活动历史有界回溯：被覆盖的提示全部记录进详情（含时间戳）', () => {
    mountChatView();
    const list = document.getElementById('activityList') as HTMLElement;
    dispatch({ type: 'retry', attempt: 1, maxRetries: 3, delayMs: 200, error: 'ECONNRESET' });
    dispatch({ type: 'memory', action: 'added', count: 1, detail: { id: 'm1', source: 'round-summary', name: '决策：数据库用 PG' } });
    dispatch({ type: 'paused' });
    // 历史累积三条，全部可见（不互相覆盖丢失）
    expect(list.textContent).toContain('重试 1/3');
    expect(list.textContent).toContain('决策：数据库用 PG');
    expect(list.textContent).toContain('已暂停');
    // 每条带时间戳（.activity-list__time 存在）
    expect(list.querySelectorAll('.activity-list__time').length).toBeGreaterThanOrEqual(3);
  });
});

describe('chatView toolbar 剪枝（视图标题栏承载历史/清空）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('toolbar 剪枝后 webview 无溢出菜单元素（历史/清空迁至视图标题栏命令）', () => {
    mountChatView();
    // toolbar 已剪：不再渲染 overflow-menu / role-pack-badge 等顶部栏元素
    expect(document.querySelector('.overflow-menu')).toBeNull();
    expect(document.querySelector('#toolbar')).toBeNull();
    // chat_history_dates / chat_history_view 消息不再触发任何渲染（被静默忽略）
    expect(() => {
      dispatch({ type: 'chat_history_dates', dates: ['2026-08-15'] });
      dispatch({ type: 'chat_history_view', date: '2026-08-15' });
    }).not.toThrow();
  });
});