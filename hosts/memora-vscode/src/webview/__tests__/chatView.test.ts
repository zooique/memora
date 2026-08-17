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
  <div id="sessionTitleBar" class="session-title-bar">
    <span id="sessionTitleText"></span>
    <button id="renameSessionBtn"></button>
    <span class="session-title-bar__spacer"></span>
    <button id="newSessionBtn"></button>
  </div>
  <div id="historyDd" class="treedd session-history" data-treedd data-on-select="__historyOnSelect">
    <button id="historyBtn" class="treedd__trigger"></button>
    <div id="historyMenu" class="treedd__menu"></div>
  </div>
  <div id="activityBar" class="activity-bar" hidden></div>
  <details id="activityDetail" class="activity-detail" hidden>
    <summary>活动详情</summary>
    <div id="activityList" class="activity-list"></div>
    <div id="activityMetrics" class="activity-metrics" hidden></div>
  </details>
  <div id="messages">
    <div id="emptyState" class="empty-state" hidden>
      <div id="emptyTitle" class="empty-title"></div>
      <div id="emptyHint" class="empty-hint"></div>
      <div id="emptySuggestions" class="empty-suggestions"></div>
    </div>
  </div>
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
        <div class="composer-actions">
          <div class="role-picker treedd--capsule" data-treedd data-on-select="__rolePickerOnSelect">
            <button class="treedd__trigger"></button>
            <div class="treedd__menu"></div>
          </div>
          <div class="model-picker treedd--capsule"><button class="treedd__trigger"></button><div class="treedd__menu"></div></div>
          <button id="send"></button>
        </div>
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

  it('chat_role_pack 渲染当前角色到输入区角色选择器触发器（SSOT 收敛身份条已删）', () => {
    mountChatView();
    const rolePicker = document.querySelector<HTMLElement>('.role-picker');
    const roleTrigger = rolePicker?.querySelector<HTMLElement>('.treedd__trigger');
    // 无角色包列表时隐藏（chatView 控制显隐）
    expect(rolePicker?.hidden).toBe(true);

    // 真实回放流：先推角色包列表（下拉数据源），再推当前角色（personaSwitched/回放）
    dispatch({
      type: 'chat_role_packs',
      packs: [{ name: 'doc-review', displayName: '文档打磨' }],
      activeName: 'doc-review',
    });
    dispatch({ type: 'chat_role_pack', rolePack: 'doc-review' });

    // 有角色包列表 → 触发器显示激活角色显示名（textContent 赋值防注入）
    expect(rolePicker?.hidden).toBe(false);
    expect(roleTrigger?.textContent).toBe('文档打磨');
  });

  it('chat_role_packs 渲染角色切换下拉选项并高亮激活项（alignment-iteration.md A3）', () => {
    mountChatView();
    const rolePicker = document.querySelector<HTMLElement>('.role-picker');
    const roleTrigger = rolePicker?.querySelector<HTMLElement>('.treedd__trigger');
    const roleMenu = rolePicker?.querySelector<HTMLElement>('.treedd__menu');

    // 无列表时隐藏角色选择器（输入区不占位）
    expect(rolePicker?.hidden).toBe(true);

    dispatch({
      type: 'chat_role_packs',
      packs: [
        { name: 'doc-review', displayName: '文档打磨' },
        { name: '写作助手', displayName: '写作助手' },
      ],
      activeName: '写作助手',
    });

    // 有列表时显示，触发器显示激活角色显示名
    expect(rolePicker?.hidden).toBe(false);
    expect(roleTrigger?.textContent).toBe('写作助手');
    // 菜单选项 + 激活项高亮
    const items = Array.from(roleMenu?.querySelectorAll('.treedd__item') ?? []);
    expect(items.map((i) => i.textContent)).toEqual(['文档打磨', '写作助手']);
    expect(items[1]?.classList.contains('is-active')).toBe(true);
  });

  it('chat_role_packs 携带 description 时渲染为下拉副标题（2026-08-15 UI 查看能力）', () => {
    mountChatView();
    const roleMenu = document.querySelector<HTMLElement>('.role-picker .treedd__menu');

    dispatch({
      type: 'chat_role_packs',
      packs: [
        { name: 'doc-review', displayName: '文档打磨', description: '技术文档写作与打磨助手' },
        { name: '写作助手', displayName: '写作助手' }, // 无 description：验证旧包容错
      ],
      activeName: 'doc-review',
    });

    // 名称主行 + 描述副行分离（textContent 含两者，结构为独立子元素）
    const items = Array.from(roleMenu?.querySelectorAll('.treedd__item') ?? []);
    expect(items).toHaveLength(2);
    const first = items[0] as HTMLElement;
    expect(first.querySelector('.dd-item-name')?.textContent).toBe('文档打磨');
    expect(first.querySelector('.dd-item-desc')?.textContent).toBe('技术文档写作与打磨助手');
    // 无 description 的项仅渲染名称，不产生副标题（容错旧包）
    const second = items[1] as HTMLElement;
    expect(second.querySelector('.dd-item-name')?.textContent).toBe('写作助手');
    expect(second.querySelector('.dd-item-desc')).toBeNull();
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
    // assistant 经 Markdown 渲染（marked 包 <p>）→ 修剪尾换行后比对原文
    expect(messages.querySelector('.msg.assistant .msg-body')?.textContent?.trim()).toBe(
      '昨天的回答',
    );
    expect(emptyState.hidden).toBe(true);
  });

  it('thinking 阶段更新思考折叠块文案 + 轨迹默认折叠（alignment-iteration.md B）', () => {
    mountChatView();
    // 生成中先有 thinking 折叠块（默认折叠，不撑开挤压内容——对齐 VS Code Chat 折叠惯例）
    dispatch({ type: 'thinking', phase: 'recalling' });
    const tb = document.querySelector('.thought-block') as HTMLDetailsElement;
    expect(tb).not.toBeNull();
    expect(tb.textContent).toContain('召回记忆中');
    expect(tb.open).toBe(false);
    // 处理阶段切换文案
    dispatch({ type: 'thinking', phase: 'processing' });
    expect(tb.textContent).toContain('处理中');
    expect(tb.open).toBe(false);
    dispatch({ type: 'thinking', phase: 'archiving' });
    expect(tb.textContent).toContain('归档记忆中');
    expect(tb.open).toBe(false);
    // 归档停滞兜底定时器由 done 清除（避免测试残留 15s 定时器）
    dispatch({ type: 'done' });
  });

  it('metrics 渲染 token 用量与记忆衰减字段（alignment-iteration.md D）', () => {
    mountChatView();
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    dispatch({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'abc123', attachedMemoryCount: 2 },
      metrics: {
        llmCallCount: 3,
        recallHitRate: 0.5,
        toolFailureCount: 1,
        truncationCount: 0,
        llmTokenIn: 1000,
        llmTokenOut: 500,
        decayRunCount: 4,
      },
    });
    expect(metrics.hidden).toBe(false);
    expect(metrics.textContent).toContain('入 1000');
    expect(metrics.textContent).toContain('出 500');
    expect(metrics.textContent).toContain('记忆衰减 4 次');
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

  it('guardrailBlocked chunk 不再弹提示条、文本正常追加（排雷 2026-08-17，阻断文案由内核 content 承载）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '被阻断的回复', guardrailBlocked: true });
    // 阻断提示不弹 banner（避免与消息体文案双份 + 输入/输出语义错位），提示条保持隐藏
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(true);
    // 文本正常追加到 assistant 消息（阻断 ≠ 丢弃内容）
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

describe('chatView toolbar 剪枝（会话管理收敛到标题条，2026-08-17 重构）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('toolbar 剪枝后 webview 无溢出菜单元素（历史/清空已由标题条按钮 + 历史浮层取代）', () => {
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

describe('chatView 会话管理（2026-08-17 重构 v2：标题条按钮 + treedd 历史下拉）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('标题条按钮：改名/新建 发送对应消息；历史按钮请求列表', () => {
    const { postMessage } = mountChatView();
    (document.getElementById('renameSessionBtn') as HTMLElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'rename_request' });
    (document.getElementById('newSessionBtn') as HTMLElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'new_session' });
    (document.getElementById('historyBtn') as HTMLElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'session_list' });
  });

  it('历史按钮：点击请求列表并展开菜单（treedd 开合）', () => {
    const { postMessage } = mountChatView();
    const dd = document.getElementById('historyDd') as HTMLElement;
    const btn = document.getElementById('historyBtn') as HTMLElement;
    expect(dd.classList.contains('is-open')).toBe(false);
    btn.click();
    // treedd 开合 + 本层请求列表（SSOT 单一职责协作）
    expect(postMessage).toHaveBeenCalledWith({ type: 'session_list' });
    expect(dd.classList.contains('is-open')).toBe(true);
  });

  it('session_list_data 渲染历史条目（treedd__item 富内容）；点击条目走委托发送 switch_session', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [{ sessionId: '2026-08-15-s1', title: '会话A', updatedAt: new Date().toISOString() }],
    });
    const items = document.querySelectorAll('#historyMenu .treedd__item');
    expect(items.length).toBe(1);
    expect(items[0]?.querySelector('.session-history__item-title')?.textContent).toBe('会话A');
    // 点击条目 → treedd 选择委托 → __historyOnSelect → switch_session
    (items[0] as HTMLElement).click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'switch_session', sessionId: '2026-08-15-s1' });
  });

  it('历史条目垃圾桶：点击发送 delete_session 且不触发条目加载', () => {
    const { postMessage } = mountChatView();
    dispatch({
      type: 'session_list_data',
      sessions: [{ sessionId: '2026-08-15-s1', title: '会话A', updatedAt: new Date().toISOString() }],
    });
    const delBtn = document.querySelector('.session-history__item-del') as HTMLElement;
    delBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'delete_session', sessionId: '2026-08-15-s1' });
    // stopPropagation：不触发条目加载（选择委托）
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'switch_session' }));
  });

  it('session_list_data 空数组 → 显示空态（非 item 文本）', () => {
    mountChatView();
    dispatch({ type: 'session_list_data', sessions: [] });
    expect(document.querySelector('.session-history__empty')?.textContent).toContain('暂无历史会话');
    expect(document.querySelectorAll('#historyMenu .treedd__item').length).toBe(0);
  });

  it('点击外部区域收起历史菜单（treedd 外部关闭机制）', () => {
    mountChatView();
    const dd = document.getElementById('historyDd') as HTMLElement;
    (document.getElementById('historyBtn') as HTMLElement).click();
    expect(dd.classList.contains('is-open')).toBe(true);
    // 点击外部（非下拉区域）→ treedd root 委托关闭
    document.body.click();
    expect(dd.classList.contains('is-open')).toBe(false);
  });
});

describe('chatView UI 自然生长三优化点（2026-08-15）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('P1：metrics 到达后 AI 回复底部补「基于 N 条记忆」弱标签（记忆附着可见）', () => {
    mountChatView();
    dispatch({ type: 'user', text: '你好', ts: new Date().toISOString() });
    dispatch({ type: 'assistant', text: '回答', ts: new Date().toISOString() });
    // 流式结束 → metrics 携带附着记忆数
    dispatch({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'abc123', attachedMemoryCount: 3 },
      metrics: { llmCallCount: 1, recallHitRate: 0.5, toolFailureCount: 0, truncationCount: 0 },
    });
    const tag = document.querySelector('.msg.assistant .memory-tag');
    expect(tag).not.toBeNull();
    expect(tag?.textContent).toBe('基于 3 条记忆');
    // 一轮只补一次：重复 metrics 不产生重复标签
    dispatch({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'abc123', attachedMemoryCount: 3 },
      metrics: { llmCallCount: 1, recallHitRate: 0.5, toolFailureCount: 0, truncationCount: 0 },
    });
    expect(document.querySelectorAll('.msg.assistant .memory-tag').length).toBe(1);
  });

  it('P2：thinking 阶段渲染三阶段执行轨迹，phase 推进状态正确（执行过程可见）', () => {
    mountChatView();
    // 阶段 1：召回进行中，打磨/归档待执行
    dispatch({ type: 'thinking', phase: 'recalling' });
    const tb = document.querySelector('.thought-block') as HTMLDetailsElement;
    expect(tb).not.toBeNull();
    const marks = () => [...tb.querySelectorAll('.trace-step')].map((el) => el.className);
    expect(marks()[0]).toContain('active');
    expect(marks()[1]).toContain('pending');
    expect(marks()[2]).toContain('pending');
    // 阶段 2：召回完成、打磨进行中
    dispatch({ type: 'thinking', phase: 'processing' });
    expect(marks()[0]).toContain('done');
    expect(marks()[1]).toContain('active');
    // 阶段 3：打磨完成、归档进行中
    dispatch({ type: 'thinking', phase: 'archiving' });
    expect(marks()[1]).toContain('done');
    expect(marks()[2]).toContain('active');
  });

  it('P3：空状态标题/提示随激活角色包动态生成（切换角色不错位）', () => {
    mountChatView();
    const title = document.getElementById('emptyTitle') as HTMLElement;
    const hint = document.getElementById('emptyHint') as HTMLElement;
    // 未加载角色包：回退「AI」+ 默认引导
    expect(title.textContent).toBe('开始与 AI 对话');
    // 角色包列表 + 激活角色 → 空状态随角色生长（标题用角色名、提示用定位描述）
    dispatch({
      type: 'chat_role_packs',
      packs: [
        { name: 'doc-review', displayName: '文档打磨', description: '打磨文档结构、表达与一致性' },
        { name: 'translator', displayName: '翻译助手', description: '中英互译与润色' },
      ],
      activeName: 'doc-review',
    });
    dispatch({ type: 'chat_role_pack', rolePack: '文档打磨' });
    expect(title.textContent).toBe('开始与 文档打磨 对话');
    expect(hint.textContent).toBe('打磨文档结构、表达与一致性');
    // 切换角色 → 文案同步更新
    dispatch({ type: 'chat_role_pack', rolePack: '翻译助手' });
    expect(title.textContent).toBe('开始与 翻译助手 对话');
    expect(hint.textContent).toBe('中英互译与润色');
  });

  it('MVP：空状态示例提问随 showcase 角色特化（方案设计师种子收敛引导，其余回退通用）', () => {
    mountChatView();
    const chipLabels = () =>
      Array.from(document.querySelectorAll('.suggestion-chip')).map((c) => c.textContent);
    // 未加载角色：回退通用打磨引导
    expect(chipLabels()).toEqual(['审阅架构', '精简表达', '对齐实现']);
    // 非 showcase 角色（文档打磨）：仍回退通用引导
    dispatch({ type: 'chat_role_pack', rolePack: '文档打磨' });
    expect(chipLabels()).toEqual(['审阅架构', '精简表达', '对齐实现']);
    // showcase 角色（方案设计师）：渲染专属"种子收敛"引导，一键体验 memora 设计魅力
    dispatch({ type: 'chat_role_pack', rolePack: '方案设计师' });
    expect(chipLabels()).toEqual(['设计知识库', '设计记忆系统', '找最小单元']);
  });
});

describe('chatView 流式光标 + Markdown 渲染（吸收养分，2026-08-16）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('流式期间 body 带 is-streaming（末尾光标 ▋），done 后移除并渲染 Markdown', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '**加粗** 与 `code`' });
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    // 流式进行中：纯文本 + is-streaming 类（CSS ::after 显示闪烁光标）
    expect(body.classList.contains('is-streaming')).toBe(true);
    expect(body.textContent).toBe('**加粗** 与 `code`');

    // done → 移除光标类，Markdown 渲染为 HTML（加粗/行内代码成元素）
    dispatch({ type: 'done' });
    expect(body.classList.contains('is-streaming')).toBe(false);
    expect(body.querySelector('strong')).not.toBeNull();
    expect(body.querySelector('code')).not.toBeNull();
  });

  it('流式结束后复制按钮使用完整原始文本（dataset.rawText 修复复制只复制首 chunk）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '第一段 ' });
    dispatch({ type: 'chunk', content: '第二段' });
    dispatch({ type: 'done' });
    const assistant = document.querySelector('.msg.assistant') as HTMLElement;
    // 完整原始文本存在消息 dataset（复制按钮据此复制完整 Markdown 源）
    expect(assistant.dataset.rawText).toBe('第一段 第二段');
    // 复制按钮存在（主动可见）
    expect(assistant.querySelector('.msg-copy')).not.toBeNull();
  });

  it('interrupted 同样 finalize：渲染 Markdown + 移除光标', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '- 列表项一' });
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(body.classList.contains('is-streaming')).toBe(true);
    // 打断 → 渲染已累积的半截内容为 Markdown（列表成 <li>）
    dispatch({ type: 'interrupted' });
    expect(body.classList.contains('is-streaming')).toBe(false);
    expect(body.querySelector('li')).not.toBeNull();
  });

  it('Markdown 渲染不注入 LLM 恶意脚本（DOMPurify 消毒）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '<img src=x onerror=alert(1)> 安全文本' });
    dispatch({ type: 'done' });
    // 消毒后 onerror 脚本被剥离，仅保留无害文本/元素
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(body.querySelector('img[onerror]')).toBeNull();
    expect(body.textContent).toContain('安全文本');
  });

  it('历史回放的一次性 assistant 消息直接渲染 Markdown（无 is-streaming）', () => {
    mountChatView();
    dispatch({ type: 'assistant', text: '## 标题\n\n正文', ts: '2026-08-14T09:00:30.000Z' });
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    // 历史重放非流式：直接渲染 Markdown（标题成 <h2>），且无光标类
    expect(body.classList.contains('is-streaming')).toBe(false);
    expect(body.querySelector('h2')).not.toBeNull();
  });
});

describe('chatView 对话闭环操作（复制/删除，2026-08-16）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('用户消息底部有复制按钮（复制用户原始输入）', () => {
    mountChatView();
    dispatch({ type: 'user', text: '你好，帮我打磨文档', ts: '2026-08-14T09:00:00.000Z' });
    const copyBtn = document.querySelector('.msg.user .msg-copy') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.textContent).toBe('复制');
  });

  it('AI 消息底部有复制 + 删除按钮（删除问答闭环入口）', () => {
    mountChatView();
    dispatch({ type: 'assistant', text: '回答', ts: '2026-08-14T09:00:30.000Z' });
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    expect(msg.querySelector('.msg-copy')).not.toBeNull();
    const del = msg.querySelector('.msg-delete') as HTMLButtonElement;
    expect(del).not.toBeNull();
    // 有 timestamp 锚点时删除按钮可用
    expect(del.disabled).toBe(false);
  });

  it('AI 消息删除按钮：携带该消息 ts 发送 delete_turn（host 确认后截断）', () => {
    const { postMessage } = mountChatView();
    dispatch({ type: 'assistant', text: '回答', ts: '2026-08-14T09:00:30.000Z' });
    const del = document.querySelector('.msg.assistant .msg-delete') as HTMLButtonElement;
    del.click();
    // 点删除 → 发 delete_turn（携带渲染时存的 dataset.ts 锚点）
    expect(postMessage).toHaveBeenCalledWith({ type: 'delete_turn', ts: '2026-08-14T09:00:30.000Z' });
  });

  it('AI 消息无 timestamp 时删除按钮禁用（避免锚点失效）', () => {
    mountChatView();
    // 流式未完成即被清空：assistant 无 ts
    dispatch({ type: 'chunk', content: '半截' });
    const del = document.querySelector('.msg.assistant .msg-delete') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });
});