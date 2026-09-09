/**
 * chatView 测试 — clear_ok 消息区清理 + 过程事件单形态（v1.5）
 *
 * clear_ok 必须同时清 type=msg 消息与 .round-block 过程块，否则切换历史/清空后
 * 旧过程块残留 DOM（P1-1 修复）。渲染层已收敛为单一形态：process_event（运行时增量）
 * 与 replay_events（重放整批）汇入同一 events[]，由 renderRoundBlock 统一渲染
 * （SSOT：不再有 tool-card / review-block / thought-block 独立卡片）。
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createChatView } from '../scripts/chatView.js';

/**
 * 收集一条 AI 消息块内全部正文的 textContent（单容器结构：正文 = 该轮唯一 .msg-body）。
 * Markdown 段落 <p> 产生的换行符对「正文语义拼接断言」无意义，统一移除后比对。
 *
 * @param el  assistant 消息根节点（.msg.assistant）
 * @returns  去除首尾空白与段落换行的完整正文文本
 */
function collectAllBodyText(el: Element): string {
  return Array.from(el.querySelectorAll('.msg-body'))
    .map((b) => (b as HTMLElement).textContent ?? '')
    .join('')
    .replace(/\r?\n/g, '')
    .trim();
}

/** 覆盖 createChatView 全部 getElementById 引用的最小 HTML 骨架 */
const HTML = `
  <div id="sessionTitleBar" class="session-title-bar">
    <span id="sessionTitleText"></span>
    <button id="renameSessionBtn"><span class="btn-icon" data-icon="edit"></span></button>
    <span class="session-title-bar__spacer"></span>
    <button id="newSessionBtn"><span class="btn-icon" data-icon="plus"></span></button>
  </div>
  <div id="historyDd" class="treedd session-history" data-treedd data-on-select="__historyOnSelect">
    <button id="historyBtn" class="treedd__trigger"><span class="btn-icon" data-icon="history"></span></button>
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
    <button id="scrollToBottomBtn" class="scroll-to-bottom" hidden><span class="btn-icon" data-icon="scroll-bottom"></span></button>
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
    <div id="skillChips" class="skill-chip-row" hidden></div>
    <div id="inputWrap">
      <textarea id="input"></textarea>
      <div id="inputFooter">
        <div class="composer-row composer-row--actions">
          <div class="composer-actions">
            <div class="model-picker treedd--capsule"><button class="treedd__trigger"></button><div class="treedd__menu"></div></div>
            <button id="pauseBtn" hidden title="暂停生成" aria-label="暂停生成"><span class="btn-icon" data-icon="pause"></span></button>
            <button id="send"></button>
          </div>
        </div>
        <div class="composer-row composer-row--status">
          <div class="composer-status">
            <span id="currentRoleBadge" class="role-badge"></span>
          </div>
          <!-- ④ 预算可视化：状态行右端上下文占用圆环（容量上限由 chat_providers 实时渲染，真实占用由 context_occupancy 覆盖） -->
          <div id="contextOccupancy" class="context-ring" hidden>
            <svg class="context-ring__svg" viewBox="0 0 40 40" aria-hidden="true">
              <circle class="context-ring__track" cx="20" cy="20" r="16" />
              <circle class="context-ring__fill" id="occFill" cx="20" cy="20" r="16" />
            </svg>
            <span class="context-ring__percent" id="occPercent">0%</span>
            <div class="context-ring__tip" id="occTip" role="tooltip"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
`;

/** 跨用例累积泄漏的 createChatView 销毁句柄（flake 根因：全局监听器未移除） */
let chatViewDispose: (() => void) | undefined;

/** 挂载 createChatView 并返回 postMessage mock（ready 消息在此被捕获） */
function mountChatView(): { postMessage: ReturnType<typeof vi.fn> } {
  document.body.innerHTML = HTML;
  const postMessage = vi.fn();
  const view = createChatView({
    acquireVsCodeApi: () => ({ postMessage }),
    window: window as unknown as Window,
  });
  chatViewDispose = view.dispose;
  return { postMessage };
}

// 每个用例结束后显式销毁，防止 window/document 全局监听器跨用例累积泄漏（flake 根因）
afterEach(() => {
  chatViewDispose?.();
  chatViewDispose = undefined;
});

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

  it('chat_role_pack 渲染当前角色到输入区左侧角色徽章（只读状态展示，2026-08-17）', () => {
    mountChatView();
    const badge = document.getElementById('currentRoleBadge') as HTMLElement;
    // 初始无角色名 → 徽章隐藏
    expect(badge.hidden).toBe(true);

    // 推送当前角色（personaSwitched / 会话回放路径）
    dispatch({ type: 'chat_role_pack', rolePack: '文档打磨' });

    // 徽章显示角色显示名（textContent 赋值防注入）
    expect(badge.hidden).toBe(false);
    expect(badge.textContent).toBe('文档打磨');

    // 切回空名 → 徽章重新隐藏
    dispatch({ type: 'chat_role_pack', rolePack: '' });
    expect(badge.hidden).toBe(true);
  });

  it('clear_ok 同时清空 .msg 与 .round-block 残留，并恢复空状态', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    const emptyState = document.getElementById('emptyState') as HTMLElement;

    // 预先塞入一条消息 + 过程折叠区（模拟历史回放后残留）
    const msg = document.createElement('div');
    msg.className = 'msg assistant';
    messages.appendChild(msg);
    const block = document.createElement('details');
    block.className = 'round-block';
    messages.appendChild(block);
    expect(messages.querySelectorAll('.msg, .round-block')).toHaveLength(2);

    dispatch({ type: 'clear_ok' });

    // 消息与过程折叠区都必须被清空，且空状态提示恢复显示
    expect(messages.querySelectorAll('.msg, .round-block')).toHaveLength(0);
    expect(emptyState.hidden).toBe(false);
  });

  it('clear_ok 保留 #emptyState 占位（不整段清空 messages）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    dispatch({ type: 'clear_ok' });
    // 占位节点不被删除，仅消息类节点被清理
    expect(messages.querySelector('#emptyState')).not.toBeNull();
  });

  it('self_review 过程事件进入 round-block § 自审查输出（v1.5 单形态）', () => {
    mountChatView();
    // meta 开新轮 → 正文块（挂载 round-block）→ 自审查过程事件 → 收尾渲染
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '回答' });
    dispatch({ type: 'process_event', event: { type: 'self_review', seq: 2, ts: '', payload: { round: 1 } } });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    expect(rb.textContent).toContain('自审查轮 1');
    // summary 也有审查计数
    expect(rb.textContent).toContain('审查 1 次');
  });

  it('流式 chunk 与 process_event 交错后仍追加到同一条 assistant 消息（P0-1 锚点）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // 模拟「文本 → 工具过程事件 → 文本」循环：过程事件到达不应拆散同一条回复
    dispatch({ type: 'chunk', content: '思考第一段' });
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 1, ts: '', payload: { toolCallId: 't1', name: 'read_file', args: '{}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 2, ts: '', payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: 'ok' } } });
    dispatch({ type: 'chunk', content: '思考第二段' });
    dispatch({ type: 'chunk', content: '思考第三段' });
    // 流式结束（触发最终收敛渲染，节流渲染未到时也由 done 兜底）
    dispatch({ type: 'done' });

    // 同一条回复应只有一条 assistant 消息，三段文本拼接在其内
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    // 多段模式：正文可能拆分到多个 .msg-content 段，取所有 body 文本拼接（SSOT 断言结构无关）
    expect(collectAllBodyText(assistants[0])).toBe('思考第一段思考第二段思考第三段');
  });

  it('暂停→继续全时序：resume 的 meta 不建新骨架，chunk 原位续写暂停块（2026-09-07 双块分裂排雷修复）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首轮生成：meta 建骨架 + 首段正文（roundId r1）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '暂停前正文', roundId: 'r1' });
    // ② 暂停：记录暂停块锚点（activeAssistantEl 存为 pausedAssistantEl）
    dispatch({ type: 'paused' });
    // ③ resume 后 host 重新 emit meta（真实链路 consumeFlow 每次 runFlow 重发 meta，
    //    2026-09-07 修复前此 meta 会无条件 prepareFlowShell 建骨架 B，劫持后续 chunk
    //    → 视觉两个独立 LLM 回答）——pausedResume 分支应不建骨架、保留锚点
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    // ④ resume 后首 text chunk（同 roundId）：应原位续写暂停块，不新建第 2 块
    dispatch({ type: 'chunk', content: '暂停后正文', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });

    // 同一问答闭环只有一个 assistant 块，两段正文拼接缝合
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(collectAllBodyText(assistants[0])).toBe('暂停前正文暂停后正文');
  });

  it('暂停后中断（interrupted）：清暂停锚点，下轮新闭环 meta 正常建骨架（2026-09-07 对称雷修复）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首轮：meta + 正文（roundId r1）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '暂停前半', roundId: 'r1' });
    // ② 暂停 → 中断（用户放弃暂停态，直接停止）
    dispatch({ type: 'paused' });
    dispatch({ type: 'interrupted', roundId: 'r1' });
    // ③ 新闭环：user（无 kind，新问题）+ meta + chunk —— 应新建骨架块（锚点已清，不残留续写）
    dispatch({ type: 'user', text: '新问题', ts: '2026-09-07T10:00:00.000Z' });
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 3, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '新回答', roundId: 'r2' });
    dispatch({ type: 'done', roundId: 'r2' });

    // 两块各自独立：暂停前的半截块（收尾）+ 新闭环新块（不误续写到旧暂停块）
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(2);
    // 第二个块 = 新回答（未拼接旧正文）
    expect(collectAllBodyText(assistants[1])).toBe('新回答');
  });

  it('暂停态补充输入：user(kind=supplement) → resume meta 分块续接（SSOT 收窄 2026-09-08：与重放穿插同构）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首轮生成：meta 建骨架 + 首段正文（roundId r1）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '暂停前正文', roundId: 'r1' });
    // ② 暂停
    dispatch({ type: 'paused' });
    // ③ 暂停态补充输入（宿主 handleSend paused 分支：post user(kind=supplement) + resumeExecution(input)）
    dispatch({ type: 'user', text: '补充：成本标准改 <¥0.5', ts: '2026-09-07T11:00:00.000Z', kind: 'supplement' });
    // ④ resume 重发 meta——交互行已插入（interactiveRowInserted）→ 阻断原位续写，走 resumePending
    //    分支建续接骨架（修复前 pausedResume 恒优先原位续写，补充行被顶到完整回答之后）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    // ⑤ resume 后正文 chunk（同 roundId）：复用续接骨架成第 2 块
    dispatch({ type: 'chunk', content: '已按补充调整成本标准', roundId: 'r1' });
    // 运行时态（done 前）：补充行恒在两段之间——[块A] → [补充行] → [块B 续接]（2026-09-07 修复语义）
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(2);
    expect(collectAllBodyText(assistants[0])).toBe('暂停前正文');
    expect(collectAllBodyText(assistants[1])).toBe('已按补充调整成本标准');
    const qaRow = messages.querySelector('.msg-qa') as HTMLElement;
    expect(qaRow).not.toBeNull();
    const order = Array.from(messages.querySelectorAll('.msg.assistant, .msg-qa'));
    expect(order.indexOf(assistants[0])).toBeLessThan(order.indexOf(qaRow));
    expect(order.indexOf(qaRow)).toBeLessThan(order.indexOf(assistants[1]));
    dispatch({ type: 'done', roundId: 'r1' });
  });

  it('error 终态不清交互行门控：补充行已插 → resume 前 error → 再 resume 仍分块续接（2026-09-08 二查回退 182e5b8c 补清理）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首轮正文（roundId r1）→ 块1（activeAssistantEl=块1）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '前序正文', roundId: 'r1' });
    // ② 暂停（置 pausedAssistantEl=块1）
    dispatch({ type: 'paused' });
    // ③ 暂停态补充输入（interactiveRowInserted=true + resumePending=true，无骨架——resume 尚未开始）
    dispatch({ type: 'user', text: '补充', ts: '2026-09-07T11:05:00.000Z', kind: 'supplement' });
    // ④ resume 流启动即失败（宿主 runFlow 同步抛错路径：error 在 meta 前到达）——
    //    不得清 interactiveRowInserted：error 属可恢复中断，交互行已插则后续正文恒分块
    //    （182e5b8c 曾补清标志，二查定论其与 28d50f19 收窄语义相反而回退）
    dispatch({ type: 'error', message: 'boom' });
    // ⑤ 用户再次继续 → resume meta：门控仍在（未清）→ 不进 pausedResume 原位续写 → resumePending 分支建骨架
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '错误后续写', roundId: 'r1' });
    // 运行时态（done 前）：块1 不被原位续写合并（回退前 error 清标志 → ⑤ pausedResume 原位续写 → 块1 被追加 '错误后续写'）
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    expect(collectAllBodyText(assistants[0])).toBe('前序正文');
    // 错误后正文在独立新块（分块续接语义：补充行恒位于两段之间，而非被顶到完整回答之后）
    const texts = Array.from(assistants).map((a) => collectAllBodyText(a));
    expect(texts[1]).toBe('错误后续写');
    const qaRow = messages.querySelector('.msg-qa') as HTMLElement;
    expect(qaRow).not.toBeNull();
    const order = Array.from(messages.querySelectorAll('.msg.assistant, .msg-qa'));
    expect(order.indexOf(qaRow)).toBeLessThan(order.indexOf(assistants[1]!));
    dispatch({ type: 'done', roundId: 'r1' });
  });

  it('暂停态补充输入后再次继续：resumePending 已消费，下轮不误建续接骨架（2026-09-07 P-1 排雷修复，2026-09-08 收窄更新）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首轮：meta + 正文（roundId r1）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '第一段', roundId: 'r1' });
    // ② 暂停 → 补充输入（置 resumePending=true + interactiveRowInserted=true）
    dispatch({ type: 'paused' });
    dispatch({ type: 'user', text: '补充', ts: '2026-09-07T11:01:00.000Z', kind: 'supplement' });
    // ③ resume meta：交互行已插 → resumePending 分支（消费 resumePending + 建续接骨架）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '续写', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });
    // ④ 新闭环（无 kind）：真新轮应清空锚点建新骨架（不受残留 resumePending/interactiveRowInserted 影响）
    dispatch({ type: 'user', text: '新问题', ts: '2026-09-07T11:02:00.000Z' });
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 3, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '新回答', roundId: 'r2' });
    dispatch({ type: 'done', roundId: 'r2' });

    // 三段各自独立：补充行所在轮分块（第一段/续写），新问题不误续写到暂停块
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(3);
    expect(collectAllBodyText(assistants[0])).toBe('第一段');
    expect(collectAllBodyText(assistants[1])).toBe('续写');
    expect(collectAllBodyText(assistants[2])).toBe('新回答');
  });

  it('ask_user 问答：paused → QA 行 → resume meta 分块续接（QA 恒在两段之间，运行时=重放形态）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 提问前正文：meta 建骨架 + 首段正文（roundId r1）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '提问前正文', roundId: 'r1' });
    // ② LLM 调用 ask_user 暂停 → 提问块（ask-inline）挂出（消息流渲染，此处省略交互 DOM）
    dispatch({ type: 'paused' });
    // ③ 用户回答：宿主 post user(kind=question-answer)（G26 运行时无 question 回顾行，仅回答行）
    dispatch({ type: 'user', text: '选方案 A', ts: '2026-09-07T12:00:00.000Z', kind: 'question-answer', roundId: 'r1' });
    // ④ resume 重发 meta——交互行已插入 → 阻断 pausedResume 原位续写，开续接骨架（修复前 QA 被顶到完整回答后）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    // ⑤ 续跑最终正文（同 roundId）：进续接块（is-continued）
    dispatch({ type: 'chunk', content: '已按方案 A 执行完毕', roundId: 'r1' });
    // 运行时态（done 前）：形态 = 重放 sendRoundView 段穿插： [块A 提问前正文] [你答行] [块B 最终正文（续接）]
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(2);
    expect(collectAllBodyText(assistants[0])).toBe('提问前正文');
    expect(collectAllBodyText(assistants[1])).toBe('已按方案 A 执行完毕');
    // 你答行位于两段之间（文档树序断言，round-group 容器化下同样成立）
    const qaRow = messages.querySelector('.msg-qa') as HTMLElement;
    expect(qaRow).not.toBeNull();
    expect(qaRow.querySelector('.msg-qa__tag')?.textContent).toBe('你答');
    const order = Array.from(messages.querySelectorAll('.msg.assistant, .msg-qa'));
    expect(order.indexOf(assistants[0])).toBeLessThan(order.indexOf(qaRow));
    expect(order.indexOf(qaRow)).toBeLessThan(order.indexOf(assistants[1]));
    // 最终正文块带同环续接标记（与重放 is-continued 一致）
    expect(assistants[1].classList.contains('is-continued')).toBe(true);
    dispatch({ type: 'done', roundId: 'r1' });
  });

  it('同轮连环 ask：resume 无正文再问 → 第二轮 QA 恒插第一轮后（运行时=重放 ts 序，2026-09-09 T2）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // ① 首段正文 + 首次 ask 挂起（块A 暂停锚，roundId r1）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '第一问前正文', roundId: 'r1' });
    dispatch({ type: 'paused' });
    // ② 第一答（带 question → 「问」行 + 「你答」折叠块）
    dispatch({
      type: 'user', text: '选方案 A', ts: '2026-09-08T10:00:00.000Z', kind: 'question-answer', roundId: 'r1',
      question: '选哪个方案？', options: ['方案 A', '方案 B'],
    });
    // ③ resume：meta → 续接骨架挂第一问答对之后；LLM 无正文、直接二次 ask_user 再挂起
    //    （骨架空正文，二次回答提交时被 user 分支移除 → activeAssistantEl 回退块A = 倒挂根源）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'paused' });
    // ④ 第二答（同样带 question）——修复前第二轮 QA 对被顶到第一轮之前
    dispatch({
      type: 'user', text: '选方案 B', ts: '2026-09-08T10:01:00.000Z', kind: 'question-answer', roundId: 'r1',
      question: '确认改为 B？', options: ['方案 B', '方案 A'],
    });
    // 运行时形态（done 前）：第二轮 QA 必须归属本轮 round-group 容器、紧跟第一轮之后——
    // 不得因 assistant 锚回退/失效散落消息流层（:last-of-type 匹配失败 → appendChild 消息流尾 = 缺陷）
    const rgRun = messages.querySelector<HTMLElement>('.round-group');
    expect(rgRun).not.toBeNull();
    const rgQaRun = rgRun
      ? Array.from(rgRun.querySelectorAll<HTMLElement>('.msg-qa--ask, details.msg-qa'))
      : [];
    expect(rgQaRun).toHaveLength(4);
    const strayRun = Array.from(messages.children).filter(
      (el) => el instanceof HTMLElement && el.classList.contains('msg-qa'),
    );
    expect(strayRun).toHaveLength(0);

    // ⑤ resume → 续跑正文 → done
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 3, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '已按方案 B 继续', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });

    // 期望 = 重放 ts 交织序：[块A] → 问1 → 答1 → 问2 → 答2 → [正文续接]（运行时=重放同构）
    const askRows = Array.from(messages.querySelectorAll<HTMLElement>('.msg-qa--ask'));
    const ansRows = Array.from(messages.querySelectorAll<HTMLElement>('details.msg-qa'));
    expect(askRows).toHaveLength(2);
    expect(ansRows).toHaveLength(2);
    expect(askRows[0]?.textContent).toContain('选哪个方案？');
    expect(askRows[1]?.textContent).toContain('确认改为 B？');
    expect(ansRows[0]?.querySelector('.msg-qa__tag')?.textContent).toBe('你答');
    // 时序断言（文档树序，折叠与否均成立）：问1 在问2 前、答1 在答2 前、问1 在答2 前
    const seq = Array.from(messages.querySelectorAll<HTMLElement>('.msg-qa--ask, details.msg-qa'));
    expect(seq.indexOf(askRows[0] as HTMLElement)).toBeLessThan(seq.indexOf(askRows[1] as HTMLElement));
    expect(seq.indexOf(ansRows[0] as HTMLElement)).toBeLessThan(seq.indexOf(ansRows[1] as HTMLElement));
    expect(seq.indexOf(askRows[0] as HTMLElement)).toBeLessThan(seq.indexOf(ansRows[1] as HTMLElement));
  });

  it('交互行渲染异常 → 兜底降级可见：用户输入不丢，resume 后仍分块（ensureUserInputVisible）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // ① 首轮：meta + 正文（roundId r1）—— 建立 activeAssistantEl 锚点（块A）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '前序正文', roundId: 'r1' });
    // ② ask_user 暂停（pausedAssistantEl = 块A）
    dispatch({ type: 'paused' });
    // ③ 注入 DOM 异常：qa 行经 Element.after 插入时抛错（仅拦截下一次调用）
    const spy = vi.spyOn(Element.prototype, 'after').mockImplementationOnce(() => {
      throw new Error('injected-dom-failure');
    });
    dispatch({ type: 'user', text: '我的回答', ts: '2026-09-08T15:00:00.000Z', kind: 'question-answer', roundId: 'r1' });
    spy.mockRestore();

    // ④ 兜底降级块可见（输入恒不丢）+ 取证 console.warn 已调用
    const fb = messages.querySelector('.msg-user-fallback') as HTMLElement;
    expect(fb).not.toBeNull();
    expect(fb.textContent).toBe('我的回答');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[memora] 用户输入渲染失败'), expect.anything());

    // ⑤ 交互行标志已置位 → resume 后仍分块（渲染异常不破坏分块结构判定）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '最终正文', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(2);
    expect(collectAllBodyText(assistants[1])).toBe('最终正文');

    warnSpy.mockRestore();
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
    expect(collectAllBodyText(assistants[0])).toBe('重放后');
  });

  it('对话后新建会话：clear_ok 清空全部消息与空骨架（无顶部空白残留）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    // 会话 A 对话：用户消息（包 .msg-wrapper）+ AI 回答 + 空骨架轮
    dispatch({ type: 'user', text: '问题A', ts: '2026-08-14T10:00:00.000Z' });
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '回答A' });
    dispatch({ type: 'done', roundId: 'r1' });
    dispatch({ type: 'user', text: '问题B', ts: '2026-08-14T10:01:00.000Z' });
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'done', roundId: 'r2' });
    // 断言：清空前用户消息外层 .msg-wrapper 存在
    expect(messages.querySelectorAll('.msg-wrapper').length).toBe(2);
    // 新建会话 B：clear_ok 应清空全部（.msg 与 .msg-wrapper 外层都不残留）
    dispatch({ type: 'clear_ok' });
    expect(messages.querySelectorAll('.msg, .msg-wrapper').length).toBe(0);
  });

  it('无缝插话：流式中收到 user 复位锚点，下条 chunk 开新助手块且排在用户消息之后（缺口 B 排序）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // 生成中用户 Enter 补充（宿主 handleSend → agent.interject → UI 上屏 user）
    dispatch({ type: 'chunk', content: '第一段' }); // 开始流式：assistant 锚点
    dispatch({ type: 'user', text: '补充要求', ts: '2026-08-14T10:00:00.000Z' }); // 插话复位锚点
    dispatch({ type: 'chunk', content: '第二段' }); // 下一条 chunk：开新助手块
    dispatch({ type: 'done' }); // 结束流式（幂等）

    // 应拆成「两块助手 + 一条用户插话」，顺序：assistant → user → assistant
    const order = Array.from(messages.querySelectorAll('.msg')).map((m) => m.className);
    expect(order).toEqual(['msg assistant', 'msg user', 'msg assistant']);
    // 插话后内容落在新的助手块（不与「第一段」拼接）
    const assistants = messages.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(2);
    expect(collectAllBodyText(assistants[0])).toBe('第一段');
    expect(collectAllBodyText(assistants[1])).toBe('第二段');
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

  it('thinking 过程事件：流式中进入 round-block 实时相位行（进行中展开），收尾后归档 § 过程轨迹', () => {
    mountChatView();
    // 生成中先有 meta → 正文块挂载 round-block；thinking 事件流式中实时投影相位行
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '回答' });
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'recalling' } } });
    // 流式中（v1.8 剪枝）：无 round-block 壳，过程平铺在 .process-flow——thinking 相位轻量行实时显示
    const rbRunning = document.querySelector('.process-flow') as HTMLElement;
    expect(rbRunning).not.toBeNull();
    expect(document.querySelector('.round-block')).toBeNull(); // 运行时绝无大折叠壳
    const phaseRow = rbRunning.querySelector('.process-flow__phase') as HTMLElement;
    expect(phaseRow).not.toBeNull();
    expect(phaseRow.textContent).toContain('召回记忆中');
    // 收尾后：折叠区收起（open=false）、相位行移除；§ 过程轨迹保留相位时间线
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 3, ts: '', payload: { phase: 'llm_calling' } } });
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 4, ts: '', payload: { phase: 'archiving' } } });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLDetailsElement;
    expect(rb.classList.contains('is-running')).toBe(false);
    expect(rb.open).toBe(false);
    expect(rb.querySelector('.round-block__phase')).toBeNull();
    expect(rb.querySelector('.round-block__details')?.textContent).toContain('召回记忆中');
    expect(rb.querySelector('.round-block__details')?.textContent).toContain('调用模型中');
    expect(rb.querySelector('.round-block__details')?.textContent).toContain('归档记忆中');
  });

  it('过程轨迹聚合：同一 thinking 相位 N 次压缩为「相位 ×N」一行，去视觉噪点（2026-09-09）', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '正文' });
    // 同一相位「调用模型中」连续 5 次（LLM 多轮调用）+ 单次「召回记忆中」——模拟真实冗长轨迹
    for (let i = 0; i < 5; i++) {
      dispatch({ type: 'process_event', event: { type: 'thinking', seq: 2 + i, ts: '', payload: { phase: 'llm_calling' } } });
    }
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 8, ts: '', payload: { phase: 'recalling' } } });
    dispatch({ type: 'done' });
    const details = document.querySelector('.round-block__details') as HTMLElement;
    const rows = Array.from(details.querySelectorAll('.round-block__row')).map((r) => r.textContent);
    // 聚合：同相位合并计次（×5；phaseLabel 输出含「…」省略号），单次相位直显不赘 ×1；
    // 行数 = 相位种类（2），不随事件数（6）膨胀
    expect(rows.some((r) => r.includes('×5'))).toBe(true);
    expect(rows.some((r) => r.includes('召回记忆'))).toBe(true);
    expect(details.querySelectorAll('.round-block__row')).toHaveLength(2);
  });

  it('metrics 渲染 token 用量与记忆治理字段（alignment-iteration.md D）', () => {
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
      },
    });
    expect(metrics.hidden).toBe(false);
    expect(metrics.textContent).toContain('入 1000');
    expect(metrics.textContent).toContain('出 500');
  });

  it('metrics 渲染预算分配构成（④ 策略可视化，可选字段缺省不显示）', () => {
    mountChatView();
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    dispatch({
      type: 'metrics',
      fingerprints: {},
      metrics: {
        llmCallCount: 1,
        recallHitRate: 0.5,
        toolFailureCount: 0,
        truncationCount: 0,
        llmTokenIn: 1000,
        llmTokenOut: 500,
        budget: {
          availableTokens: 97_000,
          anchorTokens: 200,
          remainingTokens: 96_800,
          dialogueBudgetTokens: 87_120,
          memoryLayerCapTokens: 38_720,
        },
      },
    });
    expect(metrics.hidden).toBe(false);
    // 预算行展示：可用/锚点/对话层/记忆 cap/剩余（k 缩写）
    expect(metrics.textContent).toContain('预算：可用 97k');
    expect(metrics.textContent).toContain('锚点 200');
    expect(metrics.textContent).toContain('对话层 87k');
    expect(metrics.textContent).toContain('记忆 cap 39k');
    expect(metrics.textContent).toContain('剩余 97k');
  });

  it('metrics 缺省 budget 时不显示预算行（可选字段非必填）', () => {
    mountChatView();
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    dispatch({
      type: 'metrics',
      fingerprints: {},
      metrics: { llmCallCount: 0, recallHitRate: 0, toolFailureCount: 0, truncationCount: 0 },
    });
    expect(metrics.textContent).not.toContain('预算：');
  });

  it('metrics 渲染最近操作流（B9 透明面板 trace 展示）', () => {
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
      },
      trace: [{ label: '响应生成' }, { label: '工具·read_file' }, { label: '记忆召回' }],
    });
    expect(metrics.hidden).toBe(false);
    expect(metrics.textContent).toContain('操作流');
    expect(metrics.textContent).toContain('› 响应生成');
    expect(metrics.textContent).toContain('› 工具·read_file');
    expect(metrics.textContent).toContain('› 记忆召回');
  });

  it('metrics 无操作流时渲染不受影响（trace 缺省）', () => {
    mountChatView();
    const metrics = document.getElementById('activityMetrics') as HTMLElement;
    dispatch({
      type: 'metrics',
      fingerprints: { systemPromptHash: 'abc123' },
      metrics: {
        llmCallCount: 1,
        recallHitRate: 0,
        toolFailureCount: 0,
        truncationCount: 0,
      },
    });
    expect(metrics.hidden).toBe(false);
    // 未携带 trace / trace 为空 → 不出现「操作流」段
    expect(metrics.textContent).not.toContain('操作流');
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

  it('运行时（thinking）禁用会话导航类控件：新建/历史/删除按钮全 disabled', () => {
    mountChatView();
    dispatch({ type: 'status', state: 'thinking' });
    expect((document.getElementById('newSessionBtn') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('historyBtn') as HTMLButtonElement).disabled).toBe(true);
    // 已渲染的 AI 消息删除按钮同样被锁
    dispatch({ type: 'assistant', text: '回答', ts: '2026-08-14T09:00:30.000Z' });
    const del = document.querySelector('.msg.assistant .msg-delete-icon') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });

  it('非运行时（done）恢复会话导航类控件：新建/历史/删除按钮全 enabled', () => {
    mountChatView();
    dispatch({ type: 'status', state: 'thinking' });
    dispatch({ type: 'assistant', text: '回答', ts: '2026-08-14T09:00:30.000Z' });
    dispatch({ type: 'status', state: 'done' });
    expect((document.getElementById('newSessionBtn') as HTMLButtonElement).disabled).toBe(false);
    expect((document.getElementById('historyBtn') as HTMLButtonElement).disabled).toBe(false);
    const del = document.querySelector('.msg.assistant .msg-delete-icon') as HTMLButtonElement;
    expect(del.disabled).toBe(false);
  });

  it('暂停态（paused）同样禁用会话导航类控件（运行时挂起从严）', () => {
    mountChatView();
    dispatch({ type: 'status', state: 'paused' });
    expect((document.getElementById('newSessionBtn') as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById('historyBtn') as HTMLButtonElement).disabled).toBe(true);
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

  it('生成中暴露暂停按钮，点击发 pause 消息（缺口 A · 用户主动暂停）', () => {
    const { postMessage } = mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    // 初始（空闲）暂停按钮收回
    expect(pauseBtn.hidden).toBe(true);
    dispatch({ type: 'status', state: 'thinking' });
    // 生成中：暂停按钮暴露（软暂停入口），发送按钮仍为「停止」
    expect(pauseBtn.hidden).toBe(false);
    expect(send.title).toBe('停止生成');
    pauseBtn.click();
    // 点击暂停 → 发 pause 消息，host 调 agent.requestPause() step 边界软暂停（可经「继续」恢复）
    expect(postMessage).toHaveBeenCalledWith({ type: 'pause' });
  });

  it('暂停申请在途态：按钮即时切「继续」形态可反悔（2026-09-07 缺口修复 1）', () => {
    const { postMessage } = mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const icon = pauseBtn.querySelector('.btn-icon') as HTMLElement;
    dispatch({ type: 'status', state: 'thinking' });
    // 初始：暂停（‖）形态
    expect(icon.dataset.icon).toBe('pause');
    // host 推 pause_pending:true（申请已入队，step 未到）→ 按钮即时切「继续 ▶」可反悔
    dispatch({ type: 'pause_pending', pending: true });
    expect(icon.dataset.icon).toBe('play');
    expect(pauseBtn.title).toContain('取消暂停申请');
    // 申请态再点 → 仍发 pause 消息（host 侧 isPausePending → cancelPauseRequest 反悔）
    postMessage.mockClear();
    pauseBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'pause' });
    // host 推 pause_pending:false（取消成功）→ 恢复「暂停」形态
    dispatch({ type: 'pause_pending', pending: false });
    expect(icon.dataset.icon).toBe('pause');
    expect(pauseBtn.title).toBe('暂停生成');
  });

  it('暂停态双按钮：暂停按钮换「继续」▶、发送按钮保持「停止」■', () => {
    const { postMessage } = mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    dispatch({ type: 'status', state: 'thinking' });
    // 生成中暂停 → host 回 status paused
    dispatch({ type: 'status', state: 'paused' });
    // 已暂停：pauseBtn 换 play ▶（继续），sendBtn 保持 stop ■（硬停止）——双按钮并存
    expect(pauseBtn.hidden).toBe(false);
    expect(pauseBtn.querySelector('.btn-icon')?.getAttribute('data-icon')).toBe('play');
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.title).toContain('停止生成');
    // pauseBtn 发 resume，sendBtn 发 stop
    postMessage.mockClear();
    pauseBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'resume' });
    postMessage.mockClear();
    send.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'stop' });
  });

  it('paused 态暂停按钮图标运行时注入 play SVG（2026-09-07：populateIcons 仅初始化跑一次）', () => {
    mountChatView();
    const icon = document.querySelector('#pauseBtn .btn-icon') as HTMLElement;
    // 初始化由 populateIcons 注入 pause 双竖线 SVG
    expect(icon.innerHTML).toContain('x="5" y="3.5" width="2"');
    dispatch({ type: 'status', state: 'thinking' });
    // thinking：applyIcon('pause') 显式注入（图标保持暂停语义）
    expect(icon.dataset.icon).toBe('pause');
    expect(icon.innerHTML).toContain('x="5" y="3.5" width="2"');
    // paused：applyIcon('play') 运行时切换 → innerHTML 实时更新为三角（原 bug：仅改 data-icon 不重注入 SVG）
    dispatch({ type: 'status', state: 'paused' });
    expect(icon.dataset.icon).toBe('play');
    expect(icon.innerHTML).toContain('M5 3.5l7 4.5-7 4.5z');
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
    input.dispatchEvent(new Event('input', { bubbles: true })); // 输入后按钮解除禁用
    expect(send.disabled).toBe(false);
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

  it('中文输入法组合确认按 Enter 不误触发送（isComposing 守卫）', () => {
    const { postMessage } = mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = '选字中';
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', isComposing: true, bubbles: true,
    }));
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'send', text: '选字中' });
  });

  it('中文输入法在澄清输入框按 Enter 不触发澄清答复', () => {
    const { postMessage } = mountChatView();
    // 触发澄清交互后澄清输入框存在
    dispatch({ type: 'clarify', question: '需要补充什么？' });
    const clarifyInput = document.getElementById('clarifyInput') as HTMLTextAreaElement;
    clarifyInput.value = '补一段';
    clarifyInput.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', isComposing: true, bubbles: true,
    }));
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'clarify_answer', text: '补一段' });
  });

  it('interrupted 渲染「已停止生成」提示条', () => {
    mountChatView();
    dispatch({ type: 'interrupted' });
    const activityBar = document.getElementById('activityBar') as HTMLElement;
    expect(activityBar.hidden).toBe(false);
    expect(activityBar.textContent).toContain('已停止生成');
  });

  it('输入为空时发送按钮禁用（空闲态），输入后解除禁用', () => {
    mountChatView();
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const send = document.getElementById('send') as HTMLButtonElement;
    // 初始输入为空 → 禁用
    expect(send.disabled).toBe(true);
    // 输入内容 → 解除禁用
    input.value = '打磨这段';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(send.disabled).toBe(false);
    // 清空 → 重新禁用
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(send.disabled).toBe(true);
  });

  it('生成中/暂停态发送按钮不因输入为空禁用（停止/继续语义始终可用）', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    // 生成中（loading）：即使输入为空，停止按钮仍可点击
    dispatch({ type: 'status', state: 'thinking' });
    expect(send.disabled).toBe(false);
    // 暂停态（paused）：继续按钮仍可点击（空输入继续恢复执行）
    dispatch({ type: 'status', state: 'paused' });
    expect(send.disabled).toBe(false);
    // 回到空闲：输入为空 → 恢复禁用
    dispatch({ type: 'status', state: 'done' });
    expect(send.disabled).toBe(true);
  });
});

describe('chatView Phase 4 按钮矩阵（会话态 × 输入内容）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── thinking × 输入内容 ───

  it('thinking + 空输入 → 停止方块（loading），禁用态为 false（可停止）', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'thinking' });
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.disabled).toBe(false);
  });

  it('thinking + 有输入 → 发送图标（无 loading/paused），可用态', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'thinking' });
    input.value = '我插一句话';
    input.dispatchEvent(new Event('input'));
    expect(send.classList.contains('loading')).toBe(false);
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.disabled).toBe(false);
  });

  // ─── paused × 输入内容 ───

  it('paused + 空输入 → send 保持 stop ■（loading 类），pauseBtn 换 play ▶', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'paused' });
    input.value = '';
    input.dispatchEvent(new Event('input'));
    // sendBtn 在 paused 态始终是硬停止
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.disabled).toBe(false);
    // pauseBtn 显示 play ▶（继续）
    expect(pauseBtn.hidden).toBe(false);
    expect(pauseBtn.querySelector('.btn-icon')?.getAttribute('data-icon')).toBe('play');
  });

  it('paused + 有输入 → send 保持 stop ■，pauseBtn 换 play ▶ + 补充提示', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'paused' });
    input.value = '补充一下';
    input.dispatchEvent(new Event('input'));
    // sendBtn 在 paused 态始终是硬停止
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.classList.contains('loading')).toBe(true);
    expect(send.disabled).toBe(false);
    // pauseBtn 显示 play ▶ + 补充提示
    expect(pauseBtn.hidden).toBe(false);
    expect(pauseBtn.querySelector('.btn-icon')?.getAttribute('data-icon')).toBe('play');
    expect(pauseBtn.title).toContain('补充');
  });

  // ─── done × 输入内容 ───

  it('done + 空输入 → 发送禁用', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'done' });
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(send.classList.contains('loading')).toBe(false);
    expect(send.classList.contains('paused')).toBe(false);
    expect(send.disabled).toBe(true);
  });

  it('done + 有输入 → 发送启用', () => {
    mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'done' });
    input.value = '开始吧';
    input.dispatchEvent(new Event('input'));
    expect(send.disabled).toBe(false);
  });

  // ─── pauseBtn 纯投影会话状态机（图标永远 pause，不做本地 toggle） ───

  it('thinking 态 pauseBtn 显示 pause ‖ 图标，点击 post pause 消息', () => {
    const { postMessage } = mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    const icon = pauseBtn.querySelector<HTMLElement>('.btn-icon');
    // done 初始：隐藏
    expect(pauseBtn.hidden).toBe(true);
    // thinking 态：显示 pause 图标（永远不变）
    dispatch({ type: 'status', state: 'thinking' });
    expect(pauseBtn.hidden).toBe(false);
    expect(icon?.dataset.icon).toBe('pause');
    expect(pauseBtn.title).toBe('暂停生成');
    // 点击 → 只 post pause 消息，不做任何视觉变化
    pauseBtn.click();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'pause' });
    expect(pauseBtn.hidden).toBe(false);
    expect(icon?.dataset.icon).toBe('pause'); // 图标不变
  });

  it('paused / done 态 pauseBtn 隐藏（状态机驱动）', () => {
    mountChatView();
    const pauseBtn = document.getElementById('pauseBtn') as HTMLButtonElement;
    dispatch({ type: 'status', state: 'thinking' });
    expect(pauseBtn.hidden).toBe(false);
    // paused 态：显示（换 play ▶ 继续图标，与 sendBtn stop ■ 并列）
    dispatch({ type: 'status', state: 'paused' });
    expect(pauseBtn.hidden).toBe(false);
    // done 态：隐藏
    dispatch({ type: 'status', state: 'done' });
    expect(pauseBtn.hidden).toBe(true);
  });

  // ─── pending_queue_update DOM 渲染 ───

  it('pending_queue_update → 懒创建 .pending-queue-bar 并渲染全部条目', () => {
    mountChatView();
    dispatch({ type: 'status', state: 'thinking' });
    dispatch({ type: 'pending_queue_update', items: ['我插一句话', '再来一句'] });
    const bar = document.querySelector('.pending-queue-bar') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.hidden).toBe(false);
    // Phase 4 收敛：列表模式渲染全部条目 + 序号 + 计数
    const items = bar.querySelectorAll('.pending-queue-bar__item');
    expect(items.length).toBe(2);
    expect(items[0]!.querySelector('.pending-queue-bar__num')!.textContent).toBe('1.');
    expect(items[0]!.querySelector('.pending-queue-bar__text')!.textContent).toBe('我插一句话');
    expect(items[1]!.querySelector('.pending-queue-bar__num')!.textContent).toBe('2.');
    expect(items[1]!.querySelector('.pending-queue-bar__text')!.textContent).toBe('再来一句');
    // 2026-09-07 UI 打磨：计数改圆形徽章（badge）
    expect(bar.querySelector('.pending-queue-bar__badge')!.textContent).toBe('2');
    expect(bar.querySelector('.pending-queue-bar__label')!.textContent).toBe('待发送');
    // 清空 → 隐藏
    dispatch({ type: 'pending_queue_update', items: [] });
    expect(bar.hidden).toBe(true);
  });

  it('pending-queue-bar 清空按钮 → post clear_pending_queue', () => {
    const { postMessage } = mountChatView();
    dispatch({ type: 'status', state: 'thinking' });
    dispatch({ type: 'pending_queue_update', items: ['插队内容'] });
    const clearBtn = document.querySelector('.pending-queue-bar__clear') as HTMLButtonElement;
    clearBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'clear_pending_queue' });
  });

  // ─── send click 路由统一（验证宿主路由契约） ───

  it('thinking + 空输入点击 send → post stop（停止）', () => {
    const { postMessage } = mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    dispatch({ type: 'status', state: 'thinking' });
    send.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'stop' });
  });

  it('paused + 空输入点击 send → post stop（丢弃检查点，硬停止）', () => {
    const { postMessage } = mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    dispatch({ type: 'status', state: 'paused' });
    send.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'stop' });
  });

  it('thinking + 有输入点击 send → post send（宿主路由 interject）', () => {
    const { postMessage } = mountChatView();
    const send = document.getElementById('send') as HTMLButtonElement;
    const input = document.getElementById('input') as HTMLTextAreaElement;
    dispatch({ type: 'status', state: 'thinking' });
    input.value = '插队';
    input.dispatchEvent(new Event('input'));
    send.click();
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'send', text: '插队' }));
  });
});

describe('chatView 事件流对齐（P1 事件流 / P2 活动指标）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // handoff chunk 机制已在 commit 180b5fdc 删除（handoff → 消息已并入 done chunk），
  // chatView.ts 无 type: 'handoff' handler，以下 2 个死测试删除（2026-09-05，Phase 4 测试债清理 T3a）

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
    expect(body?.textContent?.trim()).toBe('被阻断的回复');
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
    dispatch({ type: 'process_event', event: { type: 'recall', seq: 1, ts: '', payload: { memories: [{ id: 'a', name: 'm1', source: 'round-summary', score: 0.9 }, { id: 'b', name: 'm2', source: 'profile', score: 0.5 }] } } });
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
    dispatch({ type: 'process_event', event: { type: 'memory_added', seq: 1, ts: '', payload: { id: 'm1', source: 'round-summary', name: '决策：数据库用 PG' } } });
    dispatch({ type: 'paused' });
    // 历史累积三条，全部可见（不互相覆盖丢失）
    expect(list.textContent).toContain('重试 1/3');
    expect(list.textContent).toContain('决策：数据库用 PG');
    expect(list.textContent).toContain('已暂停');
    // 每条带时间戳（.activity-list__time 存在）
    expect(list.querySelectorAll('.activity-list__time').length).toBeGreaterThanOrEqual(3);
  });
});

describe('chatView 过程事件单形态（round-block，v1.5 SSOT 渲染收敛）', () => {
  /** 构造一个 meta（开新轮，随后 round-block 挂载） */
  function beginRound(): void {
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: '文档设计师', llm: 'deepseek-chat' } } });
    dispatch({ type: 'chunk', content: '正文' });
  }

  it('process_event 增量渲染 round-block：summary 计数 + details 各小节（召回/工具/已沉淀/执行指标）', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'recall', seq: 2, ts: '', payload: { memories: [{ id: 'r:1', name: '记忆A', source: 'round-summary', score: 0.9 }] } } });
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"a.md"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 4, ts: '', payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: '读取成功' } } });
    dispatch({ type: 'process_event', event: { type: 'memory_added', seq: 5, ts: '', payload: { id: 'm1', source: 'round-summary', name: '设计约束' } } });
    dispatch({ type: 'process_event', event: { type: 'metrics', seq: 6, ts: '', payload: { durationMs: 62000, tokenIn: 100, tokenOut: 200, toolFailureCount: 0, recallCount: 1, success: true } } });
    dispatch({ type: 'done' });

    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    // round-block 挂在本轮 assistant 块内（正文之后、操作行之前）
    const assistant = document.querySelector('.msg.assistant') as HTMLElement;
    expect(assistant.contains(rb)).toBe(true);
    // summary：耗时（metrics）+ 叙述句（执行 1 步工具（读取 1）· 召回 1 条记忆）
    const summary = rb.querySelector('.round-block__summary') as HTMLElement;
    expect(summary.textContent).toContain('耗时 1m 2s');
    expect(summary.textContent).toContain('执行 1 步工具（读取 1）');
    expect(summary.textContent).toContain('召回 1 条记忆');
    // 工具行移入 round-block（任务过程折叠区）工具调用小节，不重复出现在其他档案小节
    const tool = document.querySelector('.round-block__tool') as HTMLElement;
    expect(tool).not.toBeNull();
    expect(tool.textContent).toContain('读取文件：a.md (成功)');
    expect(tool.textContent).toContain('读取成功');
    // round-block details 各小节（档案：召回/已沉淀/执行指标）
    const details = rb.querySelector('.round-block__details') as HTMLElement;
    expect(details.textContent).toContain('记忆A');
    expect(details.textContent).toContain('round-summary · 90%');
    expect(details.textContent).toContain('设计约束');
    expect(details.textContent).toContain('Tokens：入 100 / 出 200');
    expect(details.textContent).toContain('完成：是');
  });

  it('工具调用二级嵌套折叠：成功/进行中默认折叠，失败默认展开，body 含 args+result', () => {
    mountChatView();
    beginRound();
    // 成功工具：默认折叠（summary 常显名称(状态)，args/result 折叠在 body）
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 2, ts: '', payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"a.md"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: '读取成功' } } });
    // 失败工具：默认展开（错误可见优先）
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 4, ts: '', payload: { toolCallId: 't2', name: 'write_file', args: '{"path":"b.md"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 5, ts: '', payload: { toolCallId: 't2', name: 'write_file', ok: false, summary: '权限不足' } } });
    // 进行中工具（无 result）：默认折叠
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 6, ts: '', payload: { toolCallId: 't3', name: 'search', args: '{}' } } });
    dispatch({ type: 'done' });

    const tools = document.querySelectorAll('.round-block__tool') as NodeListOf<HTMLDetailsElement>;
    expect(tools).toHaveLength(3);
    // 成功：折叠（open=false），summary 含名称(状态)，body 含 args 与 result
    expect(tools[0].open).toBe(false);
    expect(tools[0].querySelector('summary')?.textContent).toBe('读取文件：a.md (成功)');
    expect(tools[0].textContent).toContain('{"path":"a.md"}');
    expect(tools[0].textContent).toContain('读取成功');
    // 失败：默认展开（open=true），错误摘要可见
    expect(tools[1].open).toBe(true);
    expect(tools[1].querySelector('summary')?.textContent).toBe('写入文件：b.md (失败)');
    expect(tools[1].textContent).toContain('权限不足');
    // 进行中：TS-11b 默认展开（让正在执行的工具可见）+ 进行中态 class（is-tool-running）
    expect(tools[2].open).toBe(true);
    expect(tools[2].classList.contains('is-tool-running')).toBe(true);
    expect(tools[2].querySelector('summary')?.textContent).toBe('search (进行中)');
  });

  it('meta 驱动本轮身份：该轮 assistant 消息挂对应角色/模型标签（与会话级 chat_role_pack 分离）', () => {
    mountChatView();
    // 会话级角色（顶栏）先推一个"当前角色"
    dispatch({ type: 'chat_role_pack', rolePack: '代码审查员' });
    beginRound(); // meta.role = 文档设计师
    const label = document.querySelector('.msg.assistant .msg-ai-label') as HTMLElement;
    expect(label.textContent).toContain('文档设计师');
    expect(label.textContent).toContain('deepseek-chat');
    // 会话级顶栏不被 meta 覆盖（仍是 chat_role_pack 推的角色）
    const badge = document.getElementById('currentRoleBadge') as HTMLElement;
    expect(badge.textContent).toBe('代码审查员');
  });

  it('replay_events 整批渲染与 process_event 同路径（重放 = 运行时同一渲染函数）', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '历史回答' });
    dispatch({
      type: 'replay_events',
      roundId: 'r1',
      events: [
        { type: 'recall', seq: 2, ts: '', payload: { memories: [{ id: 'r:1', name: '旧记忆', source: 'round-summary', score: 0.6 }] } },
        { type: 'aborted', seq: 3, ts: '', payload: { reason: 'User cancelled the conversation' } },
      ],
    });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb?.textContent).toContain('旧记忆');
    expect(rb?.textContent).toContain('已停止');
    expect(rb?.textContent).toContain('召回 1 条记忆');
  });

  it('阶段二步级折叠：replay_events 含 step_boundary 时 narrate/tool 按步归组（有任务表边切组、无边界退回扁平）', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '任务开始' });
    dispatch({
      type: 'replay_events',
      roundId: 'r1',
      events: [
        { type: 'step_boundary', seq: 2, ts: '', payload: { stepId: 's1', title: '分析需求' } },
        { type: 'narrate', seq: 3, ts: '', payload: { content: '正在分析需求文档' } },
        { type: 'tool_start', seq: 4, ts: '', payload: { toolCallId: 't1', name: 'read_file' } },
        { type: 'tool_result', seq: 5, ts: '', payload: { toolCallId: 't1', name: 'read_file', ok: true } },
        { type: 'step_boundary', seq: 6, ts: '', payload: { stepId: 's2', title: '编写代码' } },
        { type: 'narrate', seq: 7, ts: '', payload: { content: '开始编写实现代码' } },
        { type: 'tool_start', seq: 8, ts: '', payload: { toolCallId: 't2', name: 'write_file' } },
        { type: 'tool_result', seq: 9, ts: '', payload: { toolCallId: 't2', name: 'write_file', ok: true } },
      ],
    });
    // 两个步级折叠块：summary 显示步骤名并可展开
    const steps = document.querySelectorAll('.round-block__step');
    expect(steps.length).toBe(2);
    expect(steps[0]!.querySelector('.round-block__step-summary')?.textContent).toContain('step-1');
    expect(steps[0]!.querySelector('.round-block__step-summary')?.textContent).toContain('分析需求');
    expect(steps[1]!.querySelector('.round-block__step-summary')?.textContent).toContain('编写代码');
    // 步1内：narrate 与 tool 归入第 1 个 step 容器（边界切组、步内平铺）
    const step1Host = steps[0]!.querySelector('.round-block__narrate') as HTMLElement;
    expect(step1Host?.textContent).toContain('正在分析需求文档');
    expect(steps[0]!.querySelector('.round-block__tool')?.textContent).toContain('read_file');
    // 步2内：narrate 与 tool 归入第 2 个 step 容器，不越界混入步1
    const step2Host = steps[1]!.querySelector('.round-block__narrate') as HTMLElement;
    expect(step2Host?.textContent).toContain('开始编写实现代码');
    expect(steps[1]!.querySelector('.round-block__tool')?.textContent).toContain('write_file');
    expect(steps[0]!.querySelector('.round-block__tool')?.textContent).not.toContain('write_file');
  });

  it('clear_ok 清空 round-block 状态（切换会话不残留）', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'recall', seq: 2, ts: '', payload: { memories: [{ id: 'r:1', name: '旧', source: 'a', score: 0.8 }] } } });
    expect(document.querySelector('.process-flow')).not.toBeNull(); // v1.8：运行时平铺容器
    expect(document.querySelector('.round-block')).toBeNull(); // 运行时无大折叠壳
    dispatch({ type: 'clear_ok' });
    // DOM 与引用状态同步清空（下一轮 meta 重新挂载）
    expect(document.querySelector('.process-flow')).toBeNull();
    expect(document.querySelector('.round-block')).toBeNull();
  });

  it('meta 到达即建流式骨架：角色·模型标签 + 运行时过程容器立即可见（TTFT 前即时反馈）', () => {
    mountChatView();
    // 仅 meta（LLM 首 token 未到时）：应已有「谁在回答 + 正在做什么」
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: '代码专家', llm: 'deepseek-chat' } } });
    const assistant = document.querySelector('.msg.assistant') as HTMLElement;
    expect(assistant).not.toBeNull();
    // 消息标签显示本轮身份
    const label = assistant.querySelector('.msg-ai-label') as HTMLElement;
    expect(label.textContent).toContain('代码专家');
    expect(label.textContent).toContain('deepseek-chat');
    // v1.8：运行时过程平铺容器已挂载（无 round-block 大折叠壳，无 summary 统计条）
    const flow = document.querySelector('.process-flow') as HTMLElement;
    expect(flow).not.toBeNull();
    expect(document.querySelector('.round-block')).toBeNull();
    // 容器挂在本轮 assistant 块内 label 之后
    expect(flow.closest('.msg.assistant')).toBe(assistant);
  });

  it('thinking 到达后运行时平铺相位行实时显示运行阶段（召回记忆中 → 调用模型中…）', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'recalling' } } });
    let row = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain('召回记忆中');
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 3, ts: '', payload: { phase: 'llm_calling' } } });
    row = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(row.textContent).toContain('调用模型中');
  });

  it('首个 chunk 复用餐架块：正文流入同一块，不新建第二条 assistant 消息', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    // 骨架已存在（meta 建立）
    expect(document.querySelectorAll('.msg.assistant')).toHaveLength(1);
    dispatch({ type: 'chunk', content: '正文内容' });
    dispatch({ type: 'chunk', content: '继续' });
    dispatch({ type: 'done' });
    // 仍是一条消息，正文完整流入骨架
    const assistants = document.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    expect(collectAllBodyText(assistants[0])).toBe('正文内容继续');
  });

  it('pause→resume 无输入续跑：原位续写暂停块，不新建第 2 个 assistant 块（2026-09-07 回归）', async () => {
    mountChatView();
    // meta 建骨架 → 首个 chunk 流入块 A（beginStreaming 记录同闭环 roundId）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '前半', roundId: 'r:1' });
    expect(document.querySelectorAll('.msg.assistant')).toHaveLength(1);
    // 暂停：记录暂停块（resume 原位续接锚）+ 清流式态
    dispatch({ type: 'paused' });
    // 无输入 continue：同 roundId 首 chunk → 应原位续写暂停块（复用 pausedAssistantEl），
    // 而非 beginStreaming 新建第 2 个独立回答块（视觉「两个 LLM 回答」bug 根因）
    dispatch({ type: 'chunk', content: '后半', roundId: 'r:1' });
    const blocks = document.querySelectorAll<HTMLElement>('.msg.assistant');
    expect(blocks).toHaveLength(1); // 关键断言：不出现第 2 个块
    // 后续 chunk 走 150ms 节流重渲染（首个 chunk 已立即渲染）——等待节流周期后断言拼接完整
    await new Promise((r) => setTimeout(r, 160));
    expect(collectAllBodyText(blocks[0])).toContain('前半');
    expect(collectAllBodyText(blocks[0])).toContain('后半');
    dispatch({ type: 'done' });
  });

  it('重放路径：replay_events（含 meta）+ assistant 只产生 1 个 assistant 块（重启不重复块）', () => {
    mountChatView();
    // 模拟重启后 sendRoundView 的新时序：先 user，再 replay_events（整批含 meta），再 assistant
    dispatch({ type: 'user', text: '介绍下自己', ts: '2026-08-28T20:15:00Z' });
    dispatch({
      type: 'replay_events',
      roundId: 'r:100',
      events: [
        { type: 'meta', seq: 1, ts: '', payload: { role: '方案设计师', llm: 'mimo-v2.5-pro' } },
        { type: 'recall', seq: 2, ts: '', payload: { memories: [{ id: 'm:1', name: '设计哲学', source: 'round-summary', score: 0.9 }] } },
        { type: 'metrics', seq: 3, ts: '', payload: { durationMs: 9600, inputTokens: 500, outputTokens: 120 } },
      ],
    });
    dispatch({ type: 'assistant', text: '我是Memora Agent，专注于将模糊想法设计为可落地的项目方案。', ts: '2026-08-28T20:16:00Z', roundId: 'r:100' });
    // 核心断言：只有一条 assistant 消息块（不能出现"运行状态一条 + 正文一条"的双线 bug）
    const assistants = document.querySelectorAll('.msg.assistant');
    expect(assistants).toHaveLength(1);
    // 该块同时承载：身份标签 + 正文 + round-block（三合一，不分裂）
    const el = assistants[0] as HTMLElement;
    expect(el.querySelector('.msg-ai-label')?.textContent).toContain('方案设计师');
    expect(el.querySelector('.msg-ai-label')?.textContent).toContain('mimo-v2.5-pro');
    // 重放路径：单容器一次性渲染正文，这里仍按所有 .msg-body 拼接断言（结构无关）
    expect(collectAllBodyText(el)).toContain('Memora Agent');
    const rb = el.querySelector('.round-block') as HTMLElement | null;
    expect(rb).not.toBeNull();
    expect(rb?.querySelector('.round-block__summary')?.textContent).toContain('耗时 9.6s');
    expect(rb?.querySelector('.round-block__summary')?.textContent).toContain('召回 1 条记忆');
  });

  it('重放路径不会创建流式骨架引用（flowShellEl 保持 null，无残留副作用）', () => {
    mountChatView();
    // 模拟重启：直接走 replay_events（含 meta），不经过 process_event(meta)
    dispatch({
      type: 'replay_events',
      roundId: 'r:200',
      events: [
        { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
      ],
    });
    dispatch({ type: 'assistant', text: '回答', ts: 't', roundId: 'r:200' });
    // 现在模拟用户发送下一轮新消息（先 user）——user 消息处理会尝试清 flowShellEl，
    // 如果重放时错误地留下了 flowShellEl 残留，这里会把正文块当作骨架删掉，
    // 从而产生 bug。验证：发送 user 后上一条 assistant 正文块仍健在。
    const before = document.querySelectorAll('.msg.assistant').length;
    dispatch({ type: 'user', text: '下一个问题', ts: 't2' });
    expect(document.querySelectorAll('.msg.assistant')).toHaveLength(before);
    // 重放路径：单容器一次性渲染，按所有 .msg-body 拼接断言（结构无关）
    expect(collectAllBodyText(document.querySelectorAll('.msg.assistant')[0])).toContain('回答');
  });

  it('两轮带过程事件的重放：折叠区各归其轮（第二轮折叠不串到第一轮顶部，2026-09-07 回归）', () => {
    mountChatView();
    // 场景：用户只测 2 个问答后重启，历史重放两轮都带过程事件
    // 第 1 轮：召回 1 条记忆
    dispatch({ type: 'user', text: '问题一', ts: 't1' });
    dispatch({
      type: 'replay_events',
      roundId: 'r:1',
      events: [
        { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
        { type: 'recall', seq: 2, ts: '', payload: { memories: [{ id: 'm:1', name: '设计哲学', source: 'round-summary', score: 0.9 }] } },
      ],
    });
    dispatch({ type: 'assistant', text: '回答一', ts: 't2', roundId: 'r:1' });
    // 第 2 轮：召回 2 条记忆
    dispatch({ type: 'user', text: '问题二', ts: 't3' });
    dispatch({
      type: 'replay_events',
      roundId: 'r:2',
      events: [
        { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } },
        { type: 'recall', seq: 2, ts: '', payload: { memories: [{ id: 'm:2', name: '角色包', source: 'round-summary', score: 0.8 }, { id: 'm:3', name: '任务表', source: 'round-summary', score: 0.7 }] } },
      ],
    });
    dispatch({ type: 'assistant', text: '回答二', ts: 't4', roundId: 'r:2' });
    // 两个 assistant 块，折叠区总数 = 2（不得在旧块上堆叠）
    const blocks = document.querySelectorAll<HTMLElement>('.msg.assistant');
    expect(blocks).toHaveLength(2);
    expect(document.querySelectorAll('.round-block')).toHaveLength(2);
    // 折叠区各挂各轮：第一轮块 1 个（召回 1 条）、第二轮块 1 个（召回 2 条）
    const rb1 = blocks[0].querySelectorAll('.round-block');
    const rb2 = blocks[1].querySelectorAll('.round-block');
    expect(rb1).toHaveLength(1);
    expect(rb2).toHaveLength(1);
    expect(rb1[0].querySelector('.round-block__summary')?.textContent).toContain('召回 1 条记忆');
    expect(rb2[0].querySelector('.round-block__summary')?.textContent).toContain('召回 2 条记忆');
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

  it('interrupted（aborted 事件）→ round-block § 已停止 标记渲染，半截正文保留', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '半截回答' });
    dispatch({ type: 'process_event', event: { type: 'aborted', seq: 2, ts: '', payload: { reason: 'User cancelled the conversation' } } });
    dispatch({ type: 'interrupted', roundId: 'r1' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    expect(rb.textContent).toContain('已停止');
    expect(rb.textContent).toContain('User cancelled the conversation');
    // 收尾即停止呼吸（is-running 收敛）
    expect(rb.classList.contains('is-running')).toBe(false);
    // 半截正文保留（取消 ≠ 丢弃）
    const body = document.querySelector('.msg.assistant .msg-body');
    expect(body?.textContent?.trim()).toBe('半截回答');
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

  it('流式期间 body 带 is-streaming + 增量渲染 Markdown，done 后收敛', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '**加粗** 与 `code`' });
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    // 流式进行中：is-streaming 类（CSS ::after 显示闪烁光标）+ 首个 chunk 立即渲染 markdown
    // （吸收养分：对齐 TraeWork 实时格式化，不再显示 ** ` 原始记号）
    expect(body.classList.contains('is-streaming')).toBe(true);
    expect(body.textContent?.trim()).toBe('加粗 与 code');
    expect(body.querySelector('strong')).not.toBeNull();

    // done → 移除光标类，Markdown 保持渲染（加粗/行内代码成元素）
    dispatch({ type: 'done' });
    expect(body.classList.contains('is-streaming')).toBe(false);
    expect(body.querySelector('strong')).not.toBeNull();
    expect(body.querySelector('code')).not.toBeNull();
  });

  it('代码块增强：语言标签 + 复制按钮（吸收养分：对齐 TraeWork 一键复制）', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '```ts\nconst x = 1;\n```' });
    dispatch({ type: 'done' });
    // 流式收敛后代码块被包装为 .code-block（语言标签 + 复制按钮）
    const block = document.querySelector('.msg.assistant .code-block') as HTMLElement;
    expect(block).not.toBeNull();
    const lang = block.querySelector('.code-block__lang') as HTMLElement;
    expect(lang.textContent).toBe('ts');
    const copyBtn = block.querySelector('.code-block__copy') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.textContent).toBe('复制');
    // 复制按钮承载的是代码文本（供点击复制）
    expect(block.querySelector('code')?.textContent).toContain('const x = 1');
  });

  it('一键到底按钮：上滚离开底部显示，点击回到底部后隐藏（吸底优化）', () => {
    mountChatView();
    const btn = document.getElementById('scrollToBottomBtn') as HTMLButtonElement;
    const messages = document.getElementById('messages') as HTMLElement;
    // 默认吸底：按钮隐藏
    expect(btn.hidden).toBe(true);
    // 模拟上滚（scrollHeight > clientHeight + scrollTop + 阈值）→ 离开底部 → 按钮浮现
    Object.defineProperty(messages, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(messages, 'clientHeight', { value: 100, configurable: true });
    messages.scrollTop = 100;
    messages.dispatchEvent(new Event('scroll'));
    expect(btn.hidden).toBe(false);
    // 点击一键到底 → 回到最新位置 + 按钮隐藏
    btn.click();
    expect(messages.scrollTop).toBe(1000);
    expect(btn.hidden).toBe(true);
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
    expect(assistant.querySelector('.msg-copy-icon')).not.toBeNull();
  });

  it('interrupted 同样 finalize：渲染 Markdown + 移除光标 + 代码块增强', () => {
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
    // 消毒后 onerror 脚本被剥离（marked 透传原始 HTML，DOMPurify 负责剥离恶意属性），
    // 仅保留无害文本/元素
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
    const copyBtn = document.querySelector('.msg-user-actions .msg-copy-icon') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.getAttribute('aria-label')).toBe('复制消息');
  });

  it('AI 消息底部有复制 + 删除按钮（删除问答闭环入口）', () => {
    mountChatView();
    dispatch({ type: 'assistant', text: '回答', ts: '2026-08-14T09:00:30.000Z' });
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    expect(msg.querySelector('.msg-copy-icon')).not.toBeNull();
    const del = msg.querySelector('.msg-delete-icon') as HTMLButtonElement;
    expect(del).not.toBeNull();
    // 有 timestamp 锚点时删除按钮可用
    expect(del.disabled).toBe(false);
  });

  it('流式回答 done 携带 roundId → 分叉按钮启用（任意 LLM 回答可分叉）', () => {
    const { postMessage } = mountChatView();
    // 流式期间：roundId 未知 → 分叉按钮初始禁用（灰色）
    dispatch({ type: 'chunk', content: '第一段' });
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    const forkBtn = msg.querySelector('.msg-fork-icon') as HTMLButtonElement;
    expect(forkBtn).not.toBeNull();
    expect(forkBtn.disabled).toBe(true);
    // 本轮闭环结束：host done 携带 roundId → 回填 dataset 并启用按钮
    dispatch({ type: 'done', roundId: 'round-42' });
    // T3b 排雷：done 消息后宿主紧跟 status:done 释放 sessionControlsLocked，
    // forkBtn.disabled 判定 = locked || !roundId，锁未释放时恒为 true
    dispatch({ type: 'status', state: 'done' });
    expect(msg.dataset.roundId).toBe('round-42');
    expect(forkBtn.disabled).toBe(false);
    // 点击 → 携带该 roundId 发 fork_session（从本轮位置分叉新会话）
    forkBtn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'fork_session', roundId: 'round-42' });
  });

  it('interrupted 携带 roundId → 打断产生的部分回答也可分叉', () => {
    mountChatView();
    dispatch({ type: 'chunk', content: '半截回答' });
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    const forkBtn = msg.querySelector('.msg-fork-icon') as HTMLButtonElement;
    expect(forkBtn.disabled).toBe(true);
    dispatch({ type: 'interrupted', roundId: 'round-7' });
    // T3b 排雷：interrupted 后宿主同样发 status:done 释放锁
    dispatch({ type: 'status', state: 'done' });
    expect(msg.dataset.roundId).toBe('round-7');
    expect(forkBtn.disabled).toBe(false);
  });

  it('AI 消息删除按钮：携带该消息 ts 发送 delete_turn（host 确认后截断）', () => {
    const { postMessage } = mountChatView();
    dispatch({ type: 'assistant', text: '回答', ts: '2026-08-14T09:00:30.000Z' });
    const del = document.querySelector('.msg.assistant .msg-delete-icon') as HTMLButtonElement;
    del.click();
    // 点删除 → 发 delete_turn（携带渲染时存的 dataset.ts 锚点）
    expect(postMessage).toHaveBeenCalledWith({ type: 'delete_turn', ts: '2026-08-14T09:00:30.000Z' });
  });

  it('AI 消息无 timestamp 时删除按钮禁用（避免锚点失效）', () => {
    mountChatView();
    // 流式未完成即被清空：assistant 无 ts
    dispatch({ type: 'chunk', content: '半截' });
    const del = document.querySelector('.msg.assistant .msg-delete-icon') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });

  it('流式回答期间底部操作行隐藏，done 后才展示（按钮 + 时间戳）', () => {
    mountChatView();
    // 首个 chunk：footer 处于 pending（隐藏）态
    dispatch({ type: 'chunk', content: '第一段' });
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    const footer = msg.querySelector('.msg-footer') as HTMLElement;
    expect(footer).not.toBeNull();
    expect(footer.classList.contains('is-pending')).toBe(true);
    // 流式持续：仍隐藏
    dispatch({ type: 'chunk', content: '第二段' });
    expect(footer.classList.contains('is-pending')).toBe(true);
    // 回答完毕：展示 footer
    dispatch({ type: 'done', roundId: 'r1' });
    expect(footer.classList.contains('is-pending')).toBe(false);
  });

  it('meta 骨架（prepareFlowShell）期间 footer 隐藏，interrupted 打断后展示', () => {
    mountChatView();
    // meta 到达 → 骨架建立（footer pending）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    const msg = document.querySelector('.msg.assistant') as HTMLElement;
    const footer = msg.querySelector('.msg-footer') as HTMLElement;
    expect(footer.classList.contains('is-pending')).toBe(true);
    // 正文流入骨架
    dispatch({ type: 'chunk', content: '回答' });
    expect(footer.classList.contains('is-pending')).toBe(true);
    // 打断（interrupted 同样 finalize）：展示 footer
    dispatch({ type: 'interrupted', roundId: 'r2' });
    expect(footer.classList.contains('is-pending')).toBe(false);
  });

  it('历史回放的一次性 assistant 消息 footer 直接展示（已完成消息）', () => {
    mountChatView();
    dispatch({ type: 'assistant', text: '回答', ts: '2026-08-14T09:00:30.000Z' });
    const footer = document.querySelector('.msg.assistant .msg-footer') as HTMLElement;
    expect(footer).not.toBeNull();
    expect(footer.classList.contains('is-pending')).toBe(false);
  });
});

describe('chatView Follow-up 建议（T2，2026-08-17 回复后关联推荐）', () => {
  it('suggestions 渲染「接下来可以探索」chips 块（textContent 防注入）', () => {
    mountChatView();
    dispatch({
      type: 'suggestions',
      items: [
        { prompt: '继续深入：甲', label: '甲' },
        { prompt: '继续深入：乙', label: '乙' },
      ],
    });
    const block = document.querySelector('.followup');
    expect(block).not.toBeNull();
    expect(block?.querySelector('.followup__caption')?.textContent).toBe('接下来可以探索');
    const chips = block?.querySelectorAll('.suggestion-chip');
    expect(chips).toHaveLength(2);
    // 标签与 prompt 均为 textContent 赋值，恶意 HTML 不被注入
    expect(chips?.[0]?.textContent).toBe('甲');
    expect((chips?.[0] as HTMLButtonElement).dataset.prompt).toBe('继续深入：甲');
  });

  it('点击 follow-up chip 填入输入框并聚焦（复用 .suggestion-chip 点击委托）', () => {
    mountChatView();
    dispatch({
      type: 'suggestions',
      items: [{ prompt: '继续深入：记忆甲', label: '记忆甲' }],
    });
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const chip = document.querySelector('.followup .suggestion-chip') as HTMLButtonElement;
    chip.click();
    expect(input.value).toBe('继续深入：记忆甲');
    expect(document.activeElement).toBe(input);
  });

  it('多轮建议幂等：新 suggestions 覆盖旧块（不堆叠残影）', () => {
    mountChatView();
    dispatch({ type: 'suggestions', items: [{ prompt: '继续深入：旧', label: '旧' }] });
    dispatch({ type: 'suggestions', items: [{ prompt: '继续深入：新', label: '新' }] });
    const blocks = document.querySelectorAll('.followup');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].textContent).toContain('新');
    expect(blocks[0].textContent).not.toContain('旧');
  });

  it('clear_ok 清除 follow-up 建议块（不残留污染重放视图）', () => {
    mountChatView();
    dispatch({ type: 'suggestions', items: [{ prompt: '继续深入：甲', label: '甲' }] });
    expect(document.querySelector('.followup')).not.toBeNull();
    dispatch({ type: 'clear_ok' });
    expect(document.querySelector('.followup')).toBeNull();
  });

  it('空 items 不渲染建议块（记忆库为空/未装配时零残留）', () => {
    mountChatView();
    dispatch({ type: 'suggestions', items: [] });
    expect(document.querySelector('.followup')).toBeNull();
  });

  it('prefill_input 写入输入框并聚焦（角色 handoff 上下文传递，不自动发送）', () => {
    mountChatView();
    dispatch({ type: 'prefill_input', text: '继续以「技术文档工程师」的视角处理以上任务' });
    const input = document.getElementById('input') as HTMLTextAreaElement;
    expect(input.value).toBe('继续以「技术文档工程师」的视角处理以上任务');
    expect(document.activeElement).toBe(input);
  });
});

describe('chatView 断点续跑提示条（G3，2026-08-23）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checkpoint_available → 渲染提示条 + 「从断点续跑」按钮', () => {
    mountChatView();
    dispatch({ type: 'checkpoint_available' });
    const banner = document.querySelector('.checkpoint-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('检测到上次暂停的会话');
    expect(banner.querySelector('.checkpoint-banner-btn')?.textContent).toBe('从断点续跑');
  });

  it('点击「从断点续跑」→ postMessage checkpoint_restore', () => {
    const { postMessage } = mountChatView();
    dispatch({ type: 'checkpoint_available' });
    const btn = document.querySelector('.checkpoint-banner-btn') as HTMLButtonElement;
    btn.click();
    expect(postMessage).toHaveBeenCalledWith({ type: 'checkpoint_restore' });
  });

  it('checkpoint_result ok → 移除提示条', () => {
    mountChatView();
    dispatch({ type: 'checkpoint_available' });
    expect(document.querySelector('.checkpoint-banner')).not.toBeNull();
    dispatch({ type: 'checkpoint_result', ok: true, message: '已恢复' });
    expect(document.querySelector('.checkpoint-banner')).toBeNull();
  });

  it('checkpoint_result 失败 → 展示错误文案 + 无续跑按钮（保留关闭）', () => {
    mountChatView();
    dispatch({ type: 'checkpoint_available' });
    dispatch({ type: 'checkpoint_result', ok: false, message: '没有可恢复的暂停会话' });
    const banner = document.querySelector('.checkpoint-banner') as HTMLElement;
    expect(banner.textContent).toContain('没有可恢复的暂停会话');
    expect(banner.querySelector('.checkpoint-banner-btn')).toBeNull();
    expect(banner.querySelector('.checkpoint-banner-close')).not.toBeNull();
  });

  it('点击关闭按钮 → 移除提示条', () => {
    mountChatView();
    dispatch({ type: 'checkpoint_available' });
    const close = document.querySelector('.checkpoint-banner-close') as HTMLButtonElement;
    close.click();
    expect(document.querySelector('.checkpoint-banner')).toBeNull();
  });

  it('clear_ok → 移除断点续跑提示条（切换会话不残留）', () => {
    mountChatView();
    dispatch({ type: 'checkpoint_available' });
    expect(document.querySelector('.checkpoint-banner')).not.toBeNull();
    dispatch({ type: 'clear_ok' });
    expect(document.querySelector('.checkpoint-banner')).toBeNull();
  });
});

describe('chatView 安全审计指标（G6，2026-08-23）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('metrics 带 securityAudit → 可观测区渲染安全审计行（basename 路径）', () => {
    mountChatView();
    dispatch({
      type: 'metrics',
      fingerprints: { attachedMemoryCount: 2 },
      metrics: { llmCallCount: 3, recallHitRate: 0.5, toolFailureCount: 1, truncationCount: 0 },
      securityAudit: {
        total: 4,
        denied: 1,
        recent: [
          { type: 'path-allow', path: 'foo.ts' },
          { type: 'path-deny', path: 'out.js', reason: '路径越界，不在白名单内' },
        ],
      },
    });
    const metricsEl = document.getElementById('activityMetrics') as HTMLElement;
    expect(metricsEl.textContent).toContain('安全审计 4 次 · 拒绝 1');
    expect(metricsEl.textContent).toContain('path-allow foo.ts');
    // G11：拒绝原因须透出（此前仅显示 type+path，丢弃 reason）
    expect(metricsEl.textContent).toContain('path-deny out.js (路径越界，不在白名单内)');
  });

  it('metrics 无 securityAudit → 不显示安全审计行', () => {
    mountChatView();
    dispatch({
      type: 'metrics',
      fingerprints: {},
      metrics: { llmCallCount: 1, recallHitRate: 0, toolFailureCount: 0, truncationCount: 0 },
    });
    const metricsEl = document.getElementById('activityMetrics') as HTMLElement;
    expect(metricsEl.textContent).not.toContain('安全审计');
  });
});

describe('chatView 任务看板（H4 任务驱动多步闭环，2026-08-23）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('plan_update → 渲染任务看板（标题 N/M + 任务节点折叠列表）', () => {
    mountChatView();
    dispatch({
      type: 'plan_update',
      steps: [
        { id: 's1', description: '收集需求', status: 'done', order: 0, stepLog: [] },
        { id: 's2', description: '设计方案', status: 'active', order: 1, stepLog: [] },
        { id: 's3', description: '编写文档', status: 'pending', order: 2, stepLog: [] },
      ],
    });
    const board = document.querySelector('.plan-board') as HTMLElement;
    expect(board).not.toBeNull();
    // 标题：完成的 N/total
    expect(board.querySelector('.plan-board-header')?.textContent).toBe('任务进度：1/3');
    // 步骤：按 order 序号 + 描述（任务节点折叠）；状态 class 按 status 映射
    const steps = board.querySelectorAll('.plan-step');
    expect(steps).toHaveLength(3);
    expect(steps[0].querySelector('.plan-step-title')?.textContent).toBe('1. 收集需求');
    expect(steps[0].classList.contains('plan-step-done')).toBe(true);
    expect(steps[0].querySelector('.plan-step-badge')?.textContent).toBe('已完成');
    expect(steps[1].querySelector('.plan-step-title')?.textContent).toBe('2. 设计方案');
    expect(steps[1].classList.contains('plan-step-active')).toBe(true);
    expect(steps[1].querySelector('.plan-step-badge')?.textContent).toBe('进行中');
    expect(steps[2].querySelector('.plan-step-title')?.textContent).toBe('3. 编写文档');
    expect(steps[2].classList.contains('plan-step-pending')).toBe(true);
    expect(steps[2].querySelector('.plan-step-badge')?.textContent).toBe('待执行');
  });

  it('plan_update 携带 stepLog → 任务节点展开显示该步骤的 step 推进记录', () => {
    mountChatView();
    dispatch({
      type: 'plan_update',
      steps: [
        { id: 's1', description: '收集需求', status: 'done', order: 0, stepLog: [{ planStepId: 's1', summary: '梳理用户痛点并产出需求清单' }] },
        { id: 's2', description: '设计方案', status: 'active', order: 1, stepLog: [] },
      ],
    });
    const board = document.querySelector('.plan-board') as HTMLElement;
    const steps = board.querySelectorAll('.plan-step');
    // 有关联推进记录的步骤：details 携带摘要 body（折叠态，仅标题常显）
    const withRounds = steps[0] as HTMLDetailsElement;
    expect(withRounds.open).toBe(false);
    expect(withRounds.querySelector('.plan-step-round')?.textContent).toBe('梳理用户痛点并产出需求清单');
    // 无关联推进记录的步骤：不渲染空摘要体
    const noRounds = steps[1] as HTMLDetailsElement;
    expect(noRounds.querySelector('.plan-step-round')).toBeNull();
  });

  it('plan_update 覆盖旧看板（幂等更新，不堆叠）', () => {
    mountChatView();
    dispatch({
      type: 'plan_update',
      steps: [{ id: 's1', description: '第一步', status: 'active', order: 0, stepLog: [] }],
    });
    dispatch({
      type: 'plan_update',
      steps: [
        { id: 's1', description: '第一步', status: 'done', order: 0, stepLog: [] },
        { id: 's2', description: '第二步', status: 'active', order: 1, stepLog: [] },
      ],
    });
    const board = document.querySelector('.plan-board') as HTMLElement;
    expect(board).not.toBeNull();
    // 仅一个看板容器
    expect(document.querySelectorAll('.plan-board')).toHaveLength(1);
    // 步骤被新快照覆盖（3 步全替换为 2 步），标题同步
    expect(board.querySelectorAll('.plan-step')).toHaveLength(2);
    expect(board.querySelector('.plan-board-header')?.textContent).toBe('任务进度：1/2');
  });

  it('plan_update 空 steps → 移除看板', () => {
    mountChatView();
    dispatch({
      type: 'plan_update',
      steps: [{ id: 's1', description: '第一步', status: 'pending', order: 0, stepLog: [] }],
    });
    expect(document.querySelector('.plan-board')).not.toBeNull();
    dispatch({ type: 'plan_update', steps: [] });
    expect(document.querySelector('.plan-board')).toBeNull();
  });

  it('clear_ok → 移除任务看板（切换会话不残留）', () => {
    mountChatView();
    dispatch({
      type: 'plan_update',
      steps: [{ id: 's1', description: '第一步', status: 'pending', order: 0, stepLog: [] }],
    });
    expect(document.querySelector('.plan-board')).not.toBeNull();
    dispatch({ type: 'clear_ok' });
    expect(document.querySelector('.plan-board')).toBeNull();
  });

  it('planBoard + restoreBanner 同时存在 → 检查点横幅恒在任务看板之上（P1-0 插入顺序协议）', () => {
    mountChatView();
    // 先创建任务看板
    dispatch({
      type: 'plan_update',
      steps: [{ id: 's1', description: '收集需求', status: 'active', order: 0, stepLog: [] }],
    });
    const board = document.querySelector('.plan-board') as HTMLElement;
    expect(board).not.toBeNull();
    // 再创建检查点横幅（需决策），应插入到 planBoard 之前
    dispatch({ type: 'checkpoint_available' });
    const banner = document.querySelector('.checkpoint-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    // 检查点横幅应在任务看板之前（DOM 中 banner 是 board 的 previousSibling 或更前）
    expect(banner.compareDocumentPosition(board) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 反向验证：先建 banner 再建 board，board 应在 banner 之后
    dispatch({ type: 'clear_ok' });
    dispatch({ type: 'checkpoint_available' });
    const banner2 = document.querySelector('.checkpoint-banner') as HTMLElement;
    dispatch({
      type: 'plan_update',
      steps: [{ id: 's1', description: '设计方案', status: 'pending', order: 0, stepLog: [] }],
    });
    const board2 = document.querySelector('.plan-board') as HTMLElement;
    expect(board2.compareDocumentPosition(banner2) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});

describe('chatView 回答等待指示器（③ 等待反馈，2026-08-29）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('meta 前 thinking 事件 → 显示相位 + 等待秒数；meta 到达骨架接管后移除', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;

    // prepare 阶段：recalling（meta 未到、无骨架）
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 1, ts: '', payload: { phase: 'recalling' } } });
    let wait = messages.querySelector('.pending-wait') as HTMLElement | null;
    expect(wait).not.toBeNull();
    expect(wait!.textContent).toContain('召回记忆中');
    expect(wait!.textContent).toMatch(/已等待 \d+s/);

    // 相位推进 → 文案随 thinking 更新
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'llm_calling' } } });
    expect(messages.querySelector('.pending-wait')!.textContent).toContain('调用模型中');

    // meta 到达（建流式骨架 + 平铺容器）→ 等待条移除，过程平铺容器接管
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 3, ts: '', payload: { role: 'AI', llm: 'm' } } });
    expect(messages.querySelector('.pending-wait')).toBeNull();
    expect(messages.querySelector('.process-flow')).not.toBeNull(); // v1.8：平铺容器接管，无大折叠壳
    expect(messages.querySelector('.round-block')).toBeNull();
  });

  it('正文开启（chunk 首段）后等待指示器退场', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 1, ts: '', payload: { phase: 'processing' } } });
    expect(messages.querySelector('.pending-wait')).not.toBeNull();
    // chunk 首段（无骨架路径 beginStreaming）→ 等待条移除
    dispatch({ type: 'chunk', content: '回答' });
    expect(messages.querySelector('.pending-wait')).toBeNull();
  });

  it('done / error 收尾后等待指示器移除（不留残留定时器渲染）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 1, ts: '', payload: { phase: 'recalling' } } });
    expect(messages.querySelector('.pending-wait')).not.toBeNull();
    dispatch({ type: 'done' });
    expect(messages.querySelector('.pending-wait')).toBeNull();

    // error 分支同样清理
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'processing' } } });
    expect(messages.querySelector('.pending-wait')).not.toBeNull();
    dispatch({ type: 'error', message: 'boom' });
    expect(messages.querySelector('.pending-wait')).toBeNull();
  });

  it('error 消息带 category（结构化分类）时按 message 渲染、不崩溃', () => {
    // TS-10b：内核 error chunk 携带 category（connection/timeout/unknown），
    // webview 只消费 message（已是宿主映射后的友好文案），category 是透传诊断字段不影响渲染
    mountChatView();
    dispatch({ type: 'error', message: '对话连接中断，已保留部分回答，请检查网络后重试', category: 'connection' });
    const body = document.querySelector('.msg.error .msg-body') as HTMLElement;
    expect(body).not.toBeNull();
    expect(body.textContent).toBe('对话连接中断，已保留部分回答，请检查网络后重试');
  });

  it('纯 user 消息（历史回放路径）不触发等待指示器，防止误报', () => {
    // 纯 user 消息（历史回放 path）不建等待条——等待条只由运行时 thinking 事件驱动
    mountChatView();
    dispatch({ type: 'user', text: '旧消息', ts: 't' });
    expect(document.querySelector('.pending-wait')).toBeNull();
  });

  it('interrupted 后等待指示器退场（③ 排雷补漏：done/error 均清，中断也不能漏）', () => {
    mountChatView();
    const messages = document.getElementById('messages') as HTMLElement;
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 1, ts: '', payload: { phase: 'llm_calling' } } });
    expect(messages.querySelector('.pending-wait')).not.toBeNull();
    // 用户点停止 → interrupted（无 meta/chunk/done/error 的收尾通道）→ 等待条必须移除
    dispatch({ type: 'interrupted' });
    expect(messages.querySelector('.pending-wait')).toBeNull();
  });
});

describe('chatView 上下文占用条：按选中 LLM 实时显示上限（④ 预算可视化，2026-08-31）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('chat_providers 到达（含选中模型）→ 圆环显示该模型容量且未隐藏（首轮对话前即有真实容量）', () => {
    mountChatView();
    const bar = document.getElementById('contextOccupancy') as HTMLElement;
    const tipEl = document.getElementById('occTip') as HTMLElement;
    // 无 Provider 前：默认隐藏，避免展示误导性的 0/0
    expect(bar.hidden).toBe(true);

    dispatch({
      type: 'chat_providers',
      providers: [
        { name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, limitTokens: 128000 },
        { name: 'local', displayName: '本地', contextWindow: 8192, limitTokens: 8192 },
      ],
      activeName: 'deepseek',
    });

    // 展示所选模型上限（fmtTokens 缩写 128K），已用 0
    expect(bar.hidden).toBe(false);
    expect(tipEl.textContent).toContain('总容量 128K');
    expect((document.getElementById('occPercent') as HTMLElement).textContent).toBe('0%');
    // 空环：dashoffset = 周长（无可见充能弧）
    const fill = document.getElementById('occFill') as unknown as SVGCircleElement;
    expect(Number(fill.style.strokeDashoffset)).toBeCloseTo(2 * Math.PI * 16, 1);
  });

  it('无选中 Provider 时圆环保持隐藏（无「当前模型」可依赖，不展示缺省值）', () => {
    mountChatView();
    dispatch({ type: 'chat_providers', providers: [{ name: 'a', displayName: 'A', limitTokens: 64000 }], activeName: undefined });
    const bar = document.getElementById('contextOccupancy') as HTMLElement;
    expect(bar.hidden).toBe(true);
  });

  it('同一上限的 chat_providers 重复推送不重置已用数字（保留 context_occupancy 真实占用）', () => {
    mountChatView();
    dispatch({
      type: 'chat_providers',
      providers: [{ name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, limitTokens: 128000 }],
      activeName: 'deepseek',
    });
    // 首轮流式结束 → 真实占用到达（占用 24,000）
    dispatch({
      type: 'context_occupancy',
      occupancy: {
        totalTokens: 128000,
        rolePackBaseTokens: 20000,
        memoryTokens: 2000,
        dialogueTokens: 2000,
        dialogueCount: 3,
        memoryCount: 2,
        inputAnchorTokens: 0,
        outputReserveTokens: 19200,
        freeTokens: 84800,
      },
    });
    expect((document.getElementById('occTip') as HTMLElement).textContent).toContain('完整对话：3 条');
    // 「记忆摘要」段已隐藏（§2.4 定案：自动注入退役后 memoryTokens/memoryCount 恒 0，无信息量）；DTO 字段保留
    expect((document.getElementById('occTip') as HTMLElement).textContent).not.toContain('记忆摘要');
    // 同款 chat_providers 再推送（如面板刷新）→ 上限未变 → 不把已用清回 0
    dispatch({
      type: 'chat_providers',
      providers: [{ name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, limitTokens: 128000 }],
      activeName: 'deepseek',
    });
    expect((document.getElementById('occTip') as HTMLElement).textContent).toContain('完整对话：3 条');
  });

  it('切换到其他模型（上限不同）→ 容量与已用同步更新为新模型（实时跟随选中 LLM）', () => {
    mountChatView();
    dispatch({
      type: 'chat_providers',
      providers: [
        { name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, limitTokens: 128000 },
        { name: 'local', displayName: '本地', contextWindow: 8192, limitTokens: 8192 },
      ],
      activeName: 'deepseek',
    });
    expect((document.getElementById('occTip') as HTMLElement).textContent).toContain('总容量 128K');

    // 用户切换模型（底部模型下拉）→ host 重推 chat_providers（activeName 变化）
    dispatch({
      type: 'chat_providers',
      providers: [
        { name: 'deepseek', displayName: 'DeepSeek', contextWindow: 128000, limitTokens: 128000 },
        { name: 'local', displayName: '本地', contextWindow: 8192, limitTokens: 8192 },
      ],
      activeName: 'local',
    });
    // 容量切换为本地模型 8K，占用清零（旧模型占用数据对新模型无意义）
    expect((document.getElementById('occTip') as HTMLElement).textContent).toContain('总容量 8,192');
    expect((document.getElementById('occPercent') as HTMLElement).textContent).toBe('0%');
  });

  it('context_occupancy 真实占用覆盖首屏容量（内核为总容量唯一真理源）', () => {
    mountChatView();
    dispatch({
      type: 'chat_providers',
      providers: [{ name: 'deepseek', displayName: 'DeepSeek', contextWindow: 64000, limitTokens: 64000 }],
      activeName: 'deepseek',
    });
    expect((document.getElementById('occTip') as HTMLElement).textContent).toContain('总容量 64K');

    // 内核 prepare 后回推真实占用
    dispatch({
      type: 'context_occupancy',
      occupancy: {
        totalTokens: 64000,
        rolePackBaseTokens: 15000,
        memoryTokens: 1000,
        dialogueTokens: 1000,
        dialogueCount: 2,
        memoryCount: 1,
        inputAnchorTokens: 50,
        outputReserveTokens: 9600,
        freeTokens: 37350,
      },
    });
    // 更新：百分比取整显示 42%（41.64% → toFixed(0)）
    expect((document.getElementById('occPercent') as HTMLElement).textContent).toBe('42%');
    // 圆环充能：dashoffset 用精确比例 (64000−37350)/64000 = 0.4164（弧线精确、显示取整）
    const fill = document.getElementById('occFill') as unknown as SVGCircleElement;
    const expectedOffset = 2 * Math.PI * 16 * (37350 / 64000);
    expect(Number(fill.style.strokeDashoffset)).toBeCloseTo(expectedOffset, 1);
    // 明细弹窗：含角色包比例 + 条数 + token（fmtTokens 整千缩写 15K/1K）
    const tip = (document.getElementById('occTip') as HTMLElement).textContent ?? '';
    expect(tip).toContain('总容量 64K');
    expect(tip).toContain('完整对话：2 条 · 1K');
    // 「记忆摘要」段已隐藏（§2.4 定案）；DTO 字段保留作诊断
    expect(tip).not.toContain('记忆摘要');
    expect(tip).toContain('角色包/系统设定：15K（占窗口 23.4%）');
  });
});

describe('chatView 澄清候选选项（ask_user options，2026-09-02）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('need_clarify 携带 options → 消息流内联选择题渲染可点选项按钮（提问下方，非底部弹层）', () => {
    const { postMessage } = mountChatView();
    // 先建提问骨架作为内联锚点（提问块；纯视觉锚点，不含完整内核流）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({
      type: 'need_clarify',
      questions: [
        { slot: 'task', question: '请描述当前任务目标', options: ['延续当前会话目标', '开启新任务'] },
      ],
    });
    // 内联选择题在消息流内（提问块下方），不再是底部 clarifyBar 替换输入栏
    const box = document.querySelector('.ask-inline') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.querySelector('.ask-inline__q')?.textContent).toBe('请描述当前任务目标');
    const btns = box.querySelectorAll('.ask-inline__opt');
    expect(btns).toHaveLength(2);
    expect(btns[0].textContent).toBe('延续当前会话目标');
    expect(btns[1].textContent).toBe('开启新任务');
    // 补充输入通道随内联块出现（选择题 + 自由补充双通道）
    expect(box.querySelector('.ask-inline__input')).not.toBeNull();
    expect(box.querySelector('.ask-inline__send')).not.toBeNull();
    // 底部 clarifyBar 不激活（主路径已内联）
    expect((document.getElementById('clarifyBar') as HTMLElement).classList.contains('visible')).toBe(false);
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'clarify_answer' });
  });

  it('点击内联选项 → 点击即答：提交 clarify_answer 并移除内联块', () => {
    const { postMessage } = mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({
      type: 'need_clarify',
      questions: [
        { slot: 'task', question: '请描述当前任务目标', options: ['延续当前会话目标', '开启新任务'] },
      ],
    });
    const btns = document.querySelectorAll('.ask-inline__opt');
    (btns[1] as HTMLButtonElement).click();
    // 点击即答：无需二次回车，直接 postMessage clarify_answer
    expect(postMessage).toHaveBeenCalledWith({ type: 'clarify_answer', text: '开启新任务' });
    // 内联块已移除（答案就位，不再等待）
    expect(document.querySelector('.ask-inline')).toBeNull();
  });

  it('无 options 的 need_clarify 不渲染选项按钮（仅补充输入通道）', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({
      type: 'need_clarify',
      questions: [{ slot: 'task', question: '请描述当前任务目标' }],
    });
    const box = document.querySelector('.ask-inline') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.querySelectorAll('.ask-inline__opt')).toHaveLength(0);
    // 无选项时引导补充输入（纯文本输入退化仍可用）
    expect(box.querySelector('.ask-inline__input')).not.toBeNull();
  });

  it('内联补充输入：键入后回车 → 提交 clarify_answer 并移除内联块', () => {
    const { postMessage } = mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({
      type: 'need_clarify',
      questions: [{ slot: 'task', question: '请描述当前任务目标', options: ['方案A', '方案B'] }],
    });
    const input = document.querySelector('.ask-inline__input') as HTMLInputElement;
    input.value = '我补充一点要求';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(postMessage).toHaveBeenCalledWith({ type: 'clarify_answer', text: '我补充一点要求' });
    expect(document.querySelector('.ask-inline')).toBeNull();
  });

  it('无 assistant 锚点时 need_clarify 降级底部 clarifyBar（异常兜底）', () => {
    mountChatView();
    dispatch({
      type: 'need_clarify',
      questions: [{ slot: 'task', question: '请描述当前任务目标', options: ['A', 'B'] }],
    });
    // 无可用提问块 → 无内联块，底部 clarifyBar 兜底显示（含选项按钮）
    expect(document.querySelector('.ask-inline')).toBeNull();
    const bar = document.getElementById('clarifyBar') as HTMLElement;
    expect(bar.classList.contains('visible')).toBe(true);
    expect(document.querySelectorAll('#clarifyOptions .opt-btn')).toHaveLength(2);
  });

  it('allowCustom=false 且带 options → 强制单选：隐藏自由输入行（仅点选）', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({
      type: 'need_clarify',
      questions: [
        { slot: 'task', question: '采用哪种方案？', options: ['方案A', '方案B'], allowCustom: false },
      ],
    });
    const box = document.querySelector('.ask-inline') as HTMLElement;
    expect(box).not.toBeNull();
    // 选项仍在
    expect(box.querySelectorAll('.ask-inline__opt')).toHaveLength(2);
    // 自由输入行被隐藏（强制只点选）
    const inputRow = box.querySelector('.ask-inline__input-row') as HTMLElement;
    expect(inputRow).not.toBeNull();
    expect(inputRow.hidden).toBe(true);
  });

  it('allowCustom 缺省/true 且带 options → 保持双通道（自由输入行可见）', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    // allowCustom=true 显式允许自由输入
    dispatch({
      type: 'need_clarify',
      questions: [
        { slot: 'task', question: '采用哪种方案？', options: ['方案A', '方案B'], allowCustom: true },
      ],
    });
    const row = document.querySelector('.ask-inline__input-row') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.hidden).toBe(false);
  });
});

describe('chatView 任务过程文字化（TS-8，2026-09-02 以 Trae 执行过程为参照）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 开一轮（meta + 首 chunk），等价于 beginRound（本 describe 外的局部 helper 不共享） */
  function beginRound(): void {
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: '文档设计师', llm: 'deepseek-chat' } } });
    dispatch({ type: 'chunk', content: '正文' });
  }

  it('read_file 工具行显示行动叙述「读取文件：path (状态)」，原始 args 保留在折叠 body', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 2, ts: '', payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"docs/a.md"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: '内容概要' } } });
    dispatch({ type: 'done' });
    const tool = document.querySelector('.round-block__tool') as HTMLElement;
    expect(tool.querySelector('summary')?.textContent).toBe('读取文件：docs/a.md (成功)');
    // 原始 args JSON 仍在折叠 body（细节不丢）
    expect(tool.textContent).toContain('{"path":"docs/a.md"}');
  });

  it('未收录工具（自定义/未知）回退原生工具名，不编造叙述', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 2, ts: '', payload: { toolCallId: 't99', name: 'my_custom_tool', args: '{"foo":"bar"}' } } });
    dispatch({ type: 'done' });
    const tool = document.querySelector('.round-block__tool') as HTMLElement;
    // 无 result → 进行中；未收录映射 → 原生名
    expect(tool.querySelector('summary')?.textContent).toBe('my_custom_tool (进行中)');
  });

  it('args 非合法 JSON 时回退原生工具名（解析兜底，不抛错）', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 2, ts: '', payload: { toolCallId: 't1', name: 'read_file', args: 'not-json{{{[' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'read_file', ok: true } } });
    dispatch({ type: 'done' });
    const tool = document.querySelector('.round-block__tool') as HTMLElement;
    expect(tool.querySelector('summary')?.textContent).toBe('read_file (成功)');
  });

  it('多分型工具 → 收尾叙述句「执行 N 步工具（读取 x · 搜索 y · 写入 z）」，描述收口清晰', () => {
    mountChatView();
    beginRound();
    // 2 读取 + 1 搜索 + 1 写入（分型计数进入叙述句）
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 2, ts: '', payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"a.md"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'read_file', ok: true } } });
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 4, ts: '', payload: { toolCallId: 't2', name: 'read_skill', args: '{"name":"doc-writer"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 5, ts: '', payload: { toolCallId: 't2', name: 'read_skill', ok: true } } });
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 6, ts: '', payload: { toolCallId: 't3', name: 'search_project', args: '{"query":"createSession"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 7, ts: '', payload: { toolCallId: 't3', name: 'search_project', ok: true } } });
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 8, ts: '', payload: { toolCallId: 't4', name: 'write_file', args: '{"path":"out.md"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 9, ts: '', payload: { toolCallId: 't4', name: 'write_file', ok: true } } });
    dispatch({ type: 'done' });
    const summary = document.querySelector('.round-block__summary') as HTMLElement;
    expect(summary.textContent).toContain('执行 4 步工具（读取 2 · 搜索 1 · 写入 1）');
  });

  it('插话打断旧流时移除旧块流式光标（is-streaming ▋ 不残留闪烁）', () => {
    mountChatView();
    // 流式正文进行中（is-streaming 光标亮）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '正在回答第一段' });
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(body.classList.contains('is-streaming')).toBe(true);
    // 插话（supplement）到达 → 旧流被打断：新块由后续 chunk 开启，旧块必须是静态正文（无光标）
    dispatch({ type: 'user', text: '补充：换个方向', ts: '2026-09-02T04:15:05Z', kind: 'supplement' });
    const oldBody = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(oldBody.classList.contains('is-streaming')).toBe(false);
  });

  it('中断补充渲染为内联子行「你补充」，插在被打破块之后；后续 chunk 为「续接」块（2026-09-07 显示逻辑统一）', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    // D3 单轨：运行时 chunk 携带 turn roundId（宿主透传），续接判定与重放共用「roundId 相等」
    dispatch({ type: 'chunk', content: '正在回答第一段', roundId: 'round-1' });
    // 被打断补充（streaming 中 supplement）→ 内联子行「你补充」：与 question-answer 共用 msg-qa 形态
    dispatch({ type: 'user', text: '补充：不要联网搜索', ts: '2026-09-03T04:15:05Z', kind: 'supplement' });
    const supRow = document.querySelector('.msg-qa') as HTMLElement;
    expect(supRow).not.toBeNull();
    expect(supRow.querySelector('.msg-qa__tag')?.textContent).toBe('你补充');
    expect(supRow.textContent).toContain('不要联网搜索');
    // 子行插在被打断的 assistant 块之后（打断点归位），与消息流平级
    const interrupted = document.querySelectorAll('.msg.assistant')[0] as HTMLElement;
    expect(interrupted.nextElementSibling).toBe(supRow);
    // 后续 chunk（同 roundId）→ 新「续接」块（is-continued + ↻ 续接 chip），位于子行之后
    dispatch({ type: 'chunk', content: '好的，按你的要求继续', roundId: 'round-1' });
    const blocks = document.querySelectorAll('.msg.assistant');
    expect(blocks).toHaveLength(2);
    const continued = blocks[1] as HTMLElement;
    expect(continued.classList.contains('is-continued')).toBe(true);
    expect(continued.querySelector('.msg-ai-label__cont')?.textContent).toContain('续接');
    expect(supRow.nextElementSibling).toBe(continued);
    expect(collectAllBodyText(continued)).toContain('按你的要求继续');
  });

  it('连续补充各自独立成块：每颗钉子独立折叠块、无「补充 N 条」合并（2026-09-09 剪枝定案）', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '正在回答', roundId: 'round-1' });
    // 同轮连续两条补充（运行时：roundId 均未回填，历史上会误合并成「你补充 N 条」）
    dispatch({ type: 'user', text: '补充：先看配置', ts: 't1', kind: 'supplement', roundId: '' });
    dispatch({ type: 'user', text: '补充：再看日志', ts: 't2', kind: 'supplement', roundId: '' });
    const supRows = Array.from(document.querySelectorAll<HTMLElement>('.msg-qa')).filter(
      (el) => el.querySelector('.msg-qa__tag')?.textContent?.startsWith('你补充'),
    );
    // 两颗钉子独立成块：不合并、无「你补充了 N 条」标签、各自含完整内容
    expect(supRows).toHaveLength(2);
    expect(supRows[0]!.textContent).toContain('先看配置');
    expect(supRows[1]!.textContent).toContain('再看日志');
    expect(supRows[0]!.querySelector('.msg-qa__tag')?.textContent).toBe('你补充');
    expect(supRows[1]!.querySelector('.msg-qa__tag')?.textContent).toBe('你补充');
  });

  it('D3 单轨：运行时 qa 回答后 resume，骨架初始即标识续接（2026-09-08 同构收窄：交互已插=必然续接，不闪「新开回答」）', () => {
    mountChatView();
    // 第一段回答（提问，roundId=round-1）：骨架复用分支记 lastAssistantRoundId
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '需要先确认哪个方案？', roundId: 'round-1' });
    // 用户回答（question-answer，带提问原文——运行时同构：host 透出 question，渲染「问」回顾行）
    dispatch({ type: 'user', text: '选A', ts: 't2', kind: 'question-answer', roundId: 'round-1', question: '需要先确认哪个方案？' });
    const qaRows = document.querySelectorAll('.msg-qa');
    expect(qaRows.length).toBeGreaterThanOrEqual(1);
    // 提问明文在对话流（msg-qa--ask 回顾行 + 你答行）：trae work 形态，问答对可回看
    const askRow = document.querySelector('.msg-qa--ask') as HTMLElement;
    expect(askRow).not.toBeNull();
    expect(askRow.textContent).toContain('需要先确认哪个方案？');
    expect(askRow.textContent).toContain('问');
    // resumeExecution → 新 runFlow 的 meta → resumePending 分支建续接骨架：
    // 交互行已插 = 必然续接 → 骨架初始即 is-continued + 「↻ 续接」chip（不再零状态闪成新开回答）
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    const blocks = document.querySelectorAll('.msg.assistant');
    expect(blocks).toHaveLength(2);
    const skeleton = blocks[1] as HTMLElement;
    expect(skeleton.classList.contains('is-continued')).toBe(true);
    expect(skeleton.querySelector('.msg-ai-label__cont')?.textContent).toContain('续接');
    // 骨架挂在交互行之后（[块A] → [问/答行] → [块B 续接] 顺序同构）
    expect(qaRows[qaRows.length - 1]!.nextElementSibling).toBe(skeleton);
    // 首个 chunk（同 roundId）→ flowShellEl 复用骨架，正文流入续接块（chip 幂等不重复）
    dispatch({ type: 'chunk', content: '好，开始执行方案A', roundId: 'round-1' });
    const continued = document.querySelectorAll('.msg.assistant')[1] as HTMLElement;
    expect(continued).toBe(skeleton);
    expect(continued.classList.contains('is-continued')).toBe(true);
    expect(collectAllBodyText(continued)).toContain('开始执行方案A');
  });

  it('运行时暂停（paused）清流式光标：提问后暂停块不再闪烁「调用大模型」', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '需要先确认哪个方案？', roundId: 'round-1' });
    const body = document.querySelector('.msg.assistant .msg-body') as HTMLElement;
    expect(body.classList.contains('is-streaming')).toBe(true); // 暂停前光标亮
    dispatch({ type: 'paused' });
    expect(body.classList.contains('is-streaming')).toBe(false); // 暂停即灭光标（静态半截）
  });

  it('运行时 resume meta：续跑保留平铺容器锚点，不复制第二个运行时容器', () => {
    mountChatView();
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '需要先确认哪个方案？', roundId: 'round-1' });
    const flow0 = document.querySelector('.process-flow') as HTMLElement;
    expect(flow0).not.toBeNull();
    expect(flow0.closest('.msg.assistant')).toBe(document.querySelectorAll('.msg.assistant')[0]);
    // 用户回答 → resumePending 置位
    dispatch({ type: 'user', text: '选A', ts: 't2', kind: 'question-answer', roundId: 'round-1' });
    // resume 新 runFlow 的 meta（同闭环续跑）→ 不重置锚点：平铺容器仍只有一个、留在首块
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    const flow1s = document.querySelectorAll('.process-flow');
    expect(flow1s).toHaveLength(1);
    expect(flow1s[0].closest('.msg.assistant')).toBe(document.querySelectorAll('.msg.assistant')[0]);
    // 续接骨架不挂第二个容器
    const blocks = document.querySelectorAll('.msg.assistant');
    expect(blocks).toHaveLength(2);
    expect(blocks[1].querySelector('.process-flow')).toBeNull();
  });

  it('UX-9 B：重放同 roundId 多段 AI（assistantLog + final）呈连续链，第 2 段起标记续接', () => {
    mountChatView();
    // 普通新闭环用户输入（重置上轮同环判定）
    dispatch({ type: 'user', text: '任务A', ts: 't1', roundId: 'round-1' });
    // 前序 assistant 段（提问）
    dispatch({ type: 'assistant', text: '需要先确认哪个方案？', ts: 't2', roundId: 'round-1' });
    // 用户回答（question-answer）
    dispatch({ type: 'user', text: '选方案A', ts: 't3', roundId: 'round-1', kind: 'question-answer' });
    // 最终回答（同 roundId）→ 同环续接
    dispatch({ type: 'assistant', text: '好，开始执行方案A', ts: 't4', roundId: 'round-1' });
    const blocks = document.querySelectorAll('.msg.assistant');
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as HTMLElement).classList.contains('is-continued')).toBe(false);
    expect((blocks[1] as HTMLElement).classList.contains('is-continued')).toBe(true);
    expect((blocks[1] as HTMLElement).querySelector('.msg-ai-label__cont')?.textContent).toContain('续接');
    // 下一轮（新 roundId）→ 不再误标续接
    dispatch({ type: 'user', text: '任务B', ts: 't5', roundId: 'round-2' });
    dispatch({ type: 'assistant', text: '回答B', ts: 't6', roundId: 'round-2' });
    const blocks2 = document.querySelectorAll('.msg.assistant');
    expect((blocks2[2] as HTMLElement).classList.contains('is-continued')).toBe(false);
  });

  it('UX-9 C：question-answer 渲染为消息流内联子行（提问块下方，非折叠收纳）', () => {
    mountChatView();
    beginRound(); // meta + chunk：骨架建块并挂载 round-block（有过程事件）
    // 用户对提问的回答 → 内联子行「你答：xxx」插在提问块（activeAssistantEl）之后
    dispatch({ type: 'user', text: '选方案A', ts: '2026-09-03T03:15:05Z', kind: 'question-answer', roundId: 'round-1' });
    const qa = document.querySelector('.msg-qa') as HTMLElement;
    expect(qa).not.toBeNull();
    expect(qa.querySelector('.msg-qa__tag')?.textContent).toBe('你答');
    expect(qa.querySelector('.msg-qa__text')?.textContent).toContain('选方案A');
    // 位置：提问块（assistant）之后，与消息流平级（不在 round-block 折叠内部）
    const ask = document.querySelectorAll('.msg.assistant')[0] as HTMLElement;
    expect(ask.nextElementSibling).toBe(qa);
    // v1.8：运行时无 round-block 折叠壳，QA 平铺在消息流（不在 process-flow 过程容器内）
    const flow = document.querySelector('.process-flow') as HTMLElement | null;
    expect(document.querySelector('.round-block')).toBeNull(); // 无大折叠壳
    expect(flow?.querySelector('.msg-qa')).toBeNull(); // 交互输入不混入过程平铺，保持两段独立
  });

  it('G26：重放 question-answer 携带 question/options → 先渲染只读「问」回顾行再「你答」', () => {
    mountChatView();
    dispatch({ type: 'user', text: '任务A', ts: 't1', roundId: 'round-1' });
    dispatch({ type: 'assistant', text: '需要先确认哪个文件？', ts: 't2', roundId: 'round-1' });
    dispatch({
      type: 'user',
      text: '读 probe.txt',
      ts: 't3',
      roundId: 'round-1',
      kind: 'question-answer',
      question: '你想读哪个文件？',
      options: ['probe.txt', 'config.json'],
    });
    const qRows = Array.from(document.querySelectorAll<HTMLElement>('.msg-qa'));
    expect(qRows).toHaveLength(2); // 提问回顾行 + 回答行
    const askRow = qRows[0]!;
    expect(askRow.classList.contains('msg-qa--ask')).toBe(true);
    expect(askRow.querySelector('.msg-qa__tag')?.textContent).toBe('问');
    expect(askRow.querySelector('.msg-qa__text')?.textContent).toContain('你想读哪个文件？');
    expect(askRow.querySelector('.msg-qa__opts')?.textContent).toContain('probe.txt');
    // 阅读序：回顾行在前、回答行紧随其后
    expect(askRow.nextElementSibling).toBe(qRows[1]);
    expect(qRows[1]!.querySelector('.msg-qa__tag')?.textContent).toBe('你答');
    expect(qRows[1]!.querySelector('.msg-qa__text')?.textContent).toContain('读 probe.txt');
  });

  it('G26：无 question 的 question-answer（运行时/旧数据）不渲染回顾行，退化为现状', () => {
    mountChatView();
    dispatch({ type: 'user', text: '问题', ts: 't1' });
    dispatch({ type: 'assistant', text: '回答', ts: 't2' });
    dispatch({ type: 'user', text: '选A', ts: 't3', kind: 'question-answer', roundId: 'round-1' });
    const qRows = document.querySelectorAll('.msg-qa');
    expect(qRows).toHaveLength(1); // 仅「你答」行
    expect(document.querySelector('.msg-qa--ask')).toBeNull();
    expect(document.querySelector('.msg-qa__opts')).toBeNull();
  });

  it('UX-9 C 兜底：无 assistant 锚点时 qa 内联子行落消息流，不丢失', () => {
    mountChatView();
    dispatch({ type: 'user', text: '问题', ts: 't1' });
    dispatch({ type: 'assistant', text: '回答', ts: 't2' }); // 无过程事件 → 无 round-block
    dispatch({ type: 'user', text: '补充说明', ts: 't3', kind: 'question-answer' });
    const qa = document.querySelector('.msg-qa') as HTMLElement;
    expect(qa).not.toBeNull();
    expect(qa.textContent).toContain('补充说明');
  });

  it('UX-9 重放路径：replay_events + 前序段 + qa 内联子行、final 为续接（A/B/C 同框回归）', () => {
    mountChatView();
    // 主输入 → 整批过程事件（含 meta）→ 提问前序段
    dispatch({ type: 'user', text: '帮我做方案', ts: 't1', roundId: 'round-1' });
    dispatch({ type: 'replay_events', roundId: 'round-1', events: [
      { type: 'meta', seq: 1, ts: 't1', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
      { type: 'metrics', seq: 2, ts: 't2', payload: { durationMs: 3000, tokenIn: 10, tokenOut: 20, toolFailureCount: 0, recallCount: 0, success: true } },
    ] as never });
    dispatch({ type: 'assistant', text: '你倾向哪个方案？', ts: 't2', roundId: 'round-1' });
    // 用户回答 → 内联子行（插在前序段之后、final 之前）
    dispatch({ type: 'user', text: '选方案A', ts: 't3', roundId: 'round-1', kind: 'question-answer' });
    // 最终回答 → 同环续接
    dispatch({ type: 'assistant', text: '好的，按方案A继续', ts: 't4', roundId: 'round-1' });
    const qa = document.querySelector('.msg-qa') as HTMLElement;
    expect(qa).not.toBeNull();
    expect(qa.textContent).toContain('选方案A');
    // A/B：前序段与 final 同 roundId → final 为续接链；无打断轮不出现「补充」子行
    const blocks = document.querySelectorAll('.msg.assistant');
    expect(blocks).toHaveLength(2);
    expect((blocks[1] as HTMLElement).classList.contains('is-continued')).toBe(true);
    // 仅「补充」tag 不存在（本轮是 qa 回答，不渲染 supplement 子行）；「你答」子行仍应在
    const supplementRows = Array.from(document.querySelectorAll<HTMLElement>('.msg-qa')).filter(
      (el) => el.querySelector('.msg-qa__tag')?.textContent === '你补充',
    );
    expect(supplementRows).toHaveLength(0);
    // G31 方案1（2026-09-08 收敛落地）：有 round-block 时 QA 最终折入任务折叠块
    // （不再平铺于折叠块与最终回答之间污染两段式）——qa 行收进 .round-block__details 内
    const roundBlock = document.querySelector('.round-block') as HTMLElement;
    expect(roundBlock).not.toBeNull();
    const qaInsideBlock = roundBlock.querySelector('.msg-qa');
    expect(qaInsideBlock).not.toBeNull();
    expect(qaInsideBlock!.textContent).toContain('选方案A');
    // 消息流层面干净：assistant 前序段与续接 final 直接相邻（两段式：折叠块 + 纯文字报告）
    expect((blocks[0] as HTMLElement).nextElementSibling).toBe(blocks[1]);
    // 折叠块收起态摘要含「你答×1」
    expect(document.querySelector('.round-block__stats')?.textContent).toContain('你答×1');
  });

  it('重放跨轮 supplement 不合并：各 roundId 补充独立成行（2026-09-07 跨轮合并 bug 修复）', () => {
    mountChatView();
    // 两轮问答，各带一条 supplement（重放时序：user → 中间段supp → 最终回答）
    // 第一轮
    dispatch({ type: 'user', text: '第一轮问题', ts: 't1', roundId: 'r1' });
    dispatch({ type: 'user', text: '第一轮补充', ts: 't2', roundId: 'r1', kind: 'supplement' });
    dispatch({ type: 'assistant', text: '第一轮回答', ts: 't3', roundId: 'r1' });
    // 第二轮（无 setStatus 变化，模拟重放路径——修复前 _lastInterruptDivider 残留 → 误并入第一轮行）
    dispatch({ type: 'user', text: '第二轮问题', ts: 't4', roundId: 'r2' });
    dispatch({ type: 'user', text: '第二轮补充', ts: 't5', roundId: 'r2', kind: 'supplement' });
    dispatch({ type: 'assistant', text: '第二轮回答', ts: 't6', roundId: 'r2' });

    // 两轮补充各自独立成行（tag=你补充），不跨轮合并成「你补充了 2 条」
    const supplementRows = Array.from(document.querySelectorAll<HTMLElement>('.msg-qa')).filter(
      (el) => el.querySelector('.msg-qa__tag')?.textContent?.startsWith('你补充'),
    );
    expect(supplementRows).toHaveLength(2);
    // 各含自己的补充内容（第二轮没并进第一轮）
    expect(supplementRows[0]!.textContent).toContain('第一轮补充');
    expect(supplementRows[1]!.textContent).toContain('第二轮补充');
    expect(supplementRows[1]!.querySelector('.msg-qa__tag')?.textContent).toBe('你补充'); // 非「你补充了 2 条」
  });

  it('A 容器化：同 roundId 的 assistant 段收进同一 .round-group（平铺归组 + 容器级 footer）', () => {
    mountChatView();
    dispatch({ type: 'user', text: '帮我做方案', ts: 't1', roundId: 'round-1' });
    dispatch({ type: 'assistant', text: '你倾向哪个方案？', ts: 't2', roundId: 'round-1' });
    dispatch({ type: 'assistant', text: '好的，按方案A继续', ts: 't4', roundId: 'round-1' });
    // 同 roundId → 单个 .round-group 容器，两段平铺归组 + 容器级 footer
    const groups = document.querySelectorAll('.round-group');
    expect(groups).toHaveLength(1);
    const g = groups[0] as HTMLElement;
    expect(g.querySelectorAll('.msg.assistant')).toHaveLength(2);
    expect(g.querySelector('.round-group__footer')).not.toBeNull();
    // 结构：段全部位于容器内，footer 恒居容器底部（段不会压到 footer 之后）
    const kids = Array.from(g.children);
    const footIdx = kids.findIndex((c) => c.classList.contains('round-group__footer'));
    expect(footIdx).toBe(kids.length - 1);
    const segIdx = kids.findIndex((c) => c.classList.contains('msg'));
    expect(segIdx).toBeGreaterThanOrEqual(0);
    expect(segIdx).toBeLessThan(footIdx);
    // 用户主提问在容器外（消息流气泡），与 AI 作答链上下衔接
    const userWrap = g.previousElementSibling as HTMLElement;
    expect(userWrap.classList.contains('msg-wrapper')).toBe(true);
  });

  it('A 容器化：容器级 footer 复制 = 用户提问 + 各段报告正文（rawText 原文直取）', () => {
    mountChatView();
    // jsdom 无 navigator.clipboard，注入 writeText mock 捕获复制内容
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    dispatch({ type: 'user', text: '帮我做方案', ts: 't1', roundId: 'round-1' });
    dispatch({ type: 'assistant', text: '你倾向哪个方案？', ts: 't2', roundId: 'round-1' });
    dispatch({ type: 'assistant', text: '好的，按方案A继续', ts: 't4', roundId: 'round-1' });
    const copyBtn = document.querySelector('.round-group__footer .msg-copy-icon') as HTMLButtonElement;
    copyBtn.click();
    const copied = writeText.mock.calls[0]?.[0] ?? '';
    // 整链 = 用户提问 + 各段原文（提问在先、段按序拼接，rawText 直取不剥离）
    expect(copied).toContain('帮我做方案');
    expect(copied).toContain('你倾向哪个方案？');
    expect(copied).toContain('好的，按方案A继续');
    // 拼接顺序：提问在前、回答段在后
    expect(copied.indexOf('帮我做方案')).toBeLessThan(copied.indexOf('好的，按方案A继续'));
  });

  it('A 容器化：整链复制直取各段 rawText 原文（不剥离、不改写，溯源完整）', () => {
    mountChatView();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    dispatch({ type: 'user', text: '帮我做方案', ts: 't1', roundId: 'round-1' });
    dispatch({ type: 'assistant', text: '先确认倾向。\n采用方案A', ts: 't2', roundId: 'round-1' });
    dispatch({ type: 'assistant', text: '好的，按方案A继续', ts: 't4', roundId: 'round-1' });
    const copyBtn = document.querySelector('.round-group__footer .msg-copy-icon') as HTMLButtonElement;
    copyBtn.click();
    const copied = writeText.mock.calls[0]?.[0] ?? '';
    expect(copied).toContain('先确认倾向。');
    expect(copied).toContain('采用方案A');
    expect(copied).toContain('好的，按方案A继续');
  });

  it('narrate 过程事件渲染为独立父块（建议 A），每段叙述一个可折叠父块', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'narrate', seq: 2, ts: '', payload: { content: '让我先查看项目结构和所有文档' } } });
    dispatch({ type: 'process_event', event: { type: 'narrate', seq: 3, ts: '', payload: { content: '现在逐一读取它们的内容' } } });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    // 每段叙述 = 一个独立 .round-block__narrate 父块（建议 A 后不再有「过程叙述」独立小节标题）
    const rows = rb.querySelectorAll('.round-block__narrate') as NodeListOf<HTMLDetailsElement>;
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('让我先查看项目结构和所有文档');
    expect(rows[1].textContent).toContain('现在逐一读取它们的内容');
  });

  it('扁平化：narrate 与 tool 按 seq 平铺 details 顶层，各自独立折叠（2026-09-04）', () => {
    mountChatView();
    beginRound();
    // 第一段叙述 → 一个搜索工具
    dispatch({ type: 'process_event', event: { type: 'narrate', seq: 2, ts: '', payload: { content: '我先搜索相关资料' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'web_search', args: '{"query":"A"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 4, ts: '', payload: { toolCallId: 't1', name: 'web_search', ok: true, summary: '结果A' } } });
    // 第二段叙述 → 一个读取工具
    dispatch({ type: 'process_event', event: { type: 'narrate', seq: 5, ts: '', payload: { content: '再读取文档' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 6, ts: '', payload: { toolCallId: 't2', name: 'read_file', args: '{"path":"x.md"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 7, ts: '', payload: { toolCallId: 't2', name: 'read_file', ok: true, summary: '内容' } } });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const narrates = rb.querySelectorAll('.round-block__narrate') as NodeListOf<HTMLDetailsElement>;
    const tools = rb.querySelectorAll('.round-block__tool') as NodeListOf<HTMLDetailsElement>;
    expect(narrates).toHaveLength(2);
    expect(tools).toHaveLength(2);
    // 扁平化：工具行不再嵌套进 narrate（narrate 内部无 .round-block__tool）
    const nested = rb.querySelectorAll('.round-block__narrate .round-block__tool');
    expect(nested).toHaveLength(0);
    // 严格时序：details 顶层子元素按 seq 交错平铺 narrate(2) → tool t1(3) → narrate(5) → tool t2(6)
    const childSeq = Array.from(rb.querySelector('.round-block__details')!.children)
      .filter((el) => el.classList.contains('round-block__narrate') || el.classList.contains('round-block__tool'))
      .map((el) => (el as HTMLElement).dataset.seq);
    expect(childSeq).toEqual(['2', '3', '5', '6']);
    // narrate 与 tool 各自保留原展现（叙述文本 / 工具名与状态）
    expect(narrates[0].textContent).toContain('我先搜索相关资料');
    expect(narrates[1].textContent).toContain('再读取文档');
    expect(tools[0].dataset.toolCallId).toBe('t1');
    expect(tools[1].dataset.toolCallId).toBe('t2');
    expect(tools[0].textContent).toContain('联网搜索：A (成功)');
    expect(tools[1].textContent).toContain('读取文件：x.md (成功)');
  });

  it('运行中 narrate 平铺冒号行、done 收尾重建后进折叠块收起（v1.8 剪枝拍板）', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'narrate', seq: 2, ts: '', payload: { content: '我先搜索相关资料' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'web_search', args: '{"query":"A"}' } } });
    // 运行中（v1.8 平铺）：narrate = 平铺文本行（非折叠），以「：」结尾，后接工具折叠行
    const flow = document.querySelector('.process-flow') as HTMLElement;
    expect(flow).not.toBeNull();
    expect(document.querySelector('.round-block')).toBeNull(); // 运行时无大折叠壳
    const narrate = flow.querySelector('.process-flow__narrate') as HTMLElement;
    expect(narrate).not.toBeNull();
    expect(narrate.textContent).toBe('我先搜索相关资料：'); // 叙述冒号形态
    const toolRow = flow.querySelector('.round-block__tool') as HTMLDetailsElement;
    expect(toolRow).not.toBeNull();
    expect(toolRow.dataset.toolCallId).toBe('t1');
    // 阅读序：narrate 平铺行在工具折叠行之前（叙述冒号 → 工具块的序；phase 若存在居首）
    const phaseFirst = flow.children[0]?.classList.contains('process-flow__phase') ?? false;
    if (phaseFirst) expect(flow.children[1]).toBe(narrate);
    else expect(flow.children[0]).toBe(narrate);
    expect(narrate.nextElementSibling).toBe(toolRow);
    dispatch({ type: 'tool_result', seq: 4, ts: '', payload: { toolCallId: 't1', name: 'web_search', ok: true, summary: '结果A' } });
    dispatch({ type: 'done' });
    // 收尾（finalize 全量重建 + flow 移除）：narrate 进 round-block 折叠块（收起态）
    const rb = document.querySelector('.round-block') as HTMLDetailsElement;
    expect(rb).not.toBeNull();
    expect(document.querySelector('.process-flow')).toBeNull(); // 平铺容器已移除
    const narrateFolded = rb.querySelector('.round-block__narrate') as HTMLDetailsElement;
    expect(narrateFolded).not.toBeNull();
    expect(narrateFolded.open).toBe(false);
  });

  it('策略拦截（blocked）工具行显示「已拦截」并默认展开，不冒充成功/失败（2026-09-02 第三态）', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 2, ts: '', payload: { toolCallId: 't1', name: 'web_search', args: '{"query":"A"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'web_search', ok: false, blocked: true, summary: '[SEARCH_LIMIT_REACHED] 已达上限' } } });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const row = rb.querySelector<HTMLDetailsElement>('.round-block__tool[data-tool-call-id="t1"]');
    expect(row).not.toBeNull();
    // 状态标签为「已拦截」而非「成功/失败」；拦截即展开（拒绝文案应直接可见，与失败同纪律）
    expect(row!.textContent).toContain('已拦截');
    expect(row!.open).toBe(true);
  });

  it('TS-11 已拦截工具行不带 is-tool-running（拦截即终态，非进行中）', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 2, ts: '', payload: { toolCallId: 't1', name: 'web_search', args: '{"query":"A"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'web_search', ok: false, blocked: true, summary: 'x' } } });
    dispatch({ type: 'done' });
    const row = document.querySelector('.round-block__tool') as HTMLDetailsElement;
    expect(row.classList.contains('is-tool-running')).toBe(false);
  });
});

describe('TS-11 工具执行实时态（2026-09-02 用户实测消缺落地）', () => {
  function beginRound(): void {
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: '文档设计师', llm: 'deepseek-chat' } } });
    dispatch({ type: 'chunk', content: '正文' });
  }

  it('TS-11a 相位行联动：tool_start → 「正在执行：写入文件」叙述，tool_result → 回落 thinking 相位', () => {
    mountChatView();
    beginRound();
    // 先有 thinking（LLM 调用相位）
    dispatch({ type: 'process_event', event: { type: 'thinking', seq: 2, ts: '', payload: { phase: 'llm_calling' } } });
    // 工具开始执行：相位行切「正在执行」行动叙述（toolActionLabel 复用），is-tool 态
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'write_file', args: '{"path":"b.md"}' } } });
    let phaseRow = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(phaseRow).not.toBeNull();
    expect(phaseRow.textContent).toBe('正在执行：写入文件：b.md');
    expect(phaseRow.classList.contains('is-tool')).toBe(true);
    // 工具完成：相位行回落最新 thinking（调用模型中…），移除 is-tool 态
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 4, ts: '', payload: { toolCallId: 't1', name: 'write_file', ok: true, summary: 'ok' } } });
    phaseRow = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(phaseRow.textContent).toContain('调用模型中');
    expect(phaseRow.classList.contains('is-tool')).toBe(false);
  });

  it('TS-11a 多工具并行：最新未完成工具为相位主体，逐完成回落（无 thinking 时安全移除）', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 2, ts: '', payload: { toolCallId: 't1', name: 'read_file', args: '{"path":"a.md"}' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 3, ts: '', payload: { toolCallId: 't2', name: 'write_file', args: '{"path":"b.md"}' } } });
    // 最新未完成者（t2）为相位主体
    let phaseRow = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(phaseRow.textContent).toBe('正在执行：写入文件：b.md');
    // t2 完成 → t1 成为剩余未完成者 → 相位切回 t1
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 4, ts: '', payload: { toolCallId: 't2', name: 'write_file', ok: true, summary: 'ok' } } });
    phaseRow = document.querySelector('.process-flow__phase') as HTMLElement;
    expect(phaseRow.textContent).toBe('正在执行：读取文件：a.md');
    // t1 完成 → 无进行中工具且无 thinking → 相位行移除（不残留过期「正在执行」）
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 5, ts: '', payload: { toolCallId: 't1', name: 'read_file', ok: true, summary: 'ok' } } });
    expect(document.querySelector('.process-flow__phase')).toBeNull();
  });

  it('TS-11b 进行中工具行实时可见：默认展开 + is-tool-running，result 到达移除', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 2, ts: '', payload: { toolCallId: 't1', name: 'write_file', args: '{"path":"b.md"}' } } });
    const row = document.querySelector('.round-block__tool') as HTMLDetailsElement;
    expect(row).not.toBeNull();
    expect(row.open).toBe(true);
    expect(row.classList.contains('is-tool-running')).toBe(true);
    // result 到达 → 成功折叠 + 移除进行中态
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'write_file', ok: true, summary: '已写入' } } });
    expect(row.classList.contains('is-tool-running')).toBe(false);
    expect(row.open).toBe(false);
    expect(row.textContent).toContain('(成功)');
  });

  describe('TS-11c 工具等待时长（瞬态，不落库）', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('tool_start → 秒数实时刷新；结果完成 + 流结束 → elapsed 移除', () => {
      mountChatView();
      beginRound();
      dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 2, ts: '', payload: { toolCallId: 't1', name: 'write_file', args: '{"path":"b.md"}' } } });
      // tick 前无 elapsed span；advance 2s 后出现「Ns」标签（Date 被 fake timers 一并 mock）
      expect(document.querySelector('.round-block__elapsed')).toBeNull();
      vi.advanceTimersByTime(2000);
      const row = document.querySelector('.round-block__tool') as HTMLElement;
      expect(row.textContent).toContain('2s');
      // 结果完成 + 流结束 → elapsed 清空（瞬态退场）
      dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'write_file', ok: true, summary: 'ok' } } });
      dispatch({ type: 'done' });
      expect(document.querySelector('.round-block__elapsed')).toBeNull();
    });
  });
});

describe('TS-12b aborted 语义渲染（2026-09-02 结束语义收敛）', () => {
  function beginRound(): void {
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '正文' });
  }

  it('stopReason=user → § 已停止 显示「用户停止了对话」（不写死「用户取消了对话」）', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'aborted', seq: 2, ts: '', payload: { reason: 'User cancelled the conversation', stopReason: 'user' } } });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const detail = rb.querySelector('.round-block__details') as HTMLElement;
    expect(detail.textContent).toContain('已停止');
    expect(detail.textContent).toContain('用户停止了对话');
    expect(detail.textContent).not.toContain('用户取消了对话');
  });

  it('无 stopReason（旧数据）→ 回退 reason 原文（兼容不丢细节）', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'aborted', seq: 2, ts: '', payload: { reason: 'legacy 原因' } } });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb.textContent).toContain('legacy 原因');
  });

  it('stopReason=timeout（chat 锁超时/LLM 无响应）→ 显示「对话处理超时」，不显示「用户停止」', () => {
    mountChatView();
    beginRound();
    dispatch({ type: 'process_event', event: { type: 'aborted', seq: 2, ts: '', payload: { reason: 'LLM request timed out (no response)', stopReason: 'timeout' } } });
    dispatch({ type: 'done' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb.textContent).toContain('对话处理超时，请稍后重试');
    expect(rb.textContent).not.toContain('用户停止');
  });

  it('运行时流式轮 done 后回填 ts 锚：容器级删除按钮可用（修复「回答结束删除恒禁用」）', () => {
    mountChatView();
    // 用户输入（带 ts）→ 流式正文（建 round-group 容器 + footer）→ done（回填 roundId + ts 锚）
    dispatch({ type: 'user', text: '请总结', ts: '2026-09-08T10:00:00.000Z' });
    dispatch({ type: 'chunk', content: '第一段', roundId: 'r1' });
    dispatch({ type: 'chunk', content: '第二段' });
    // done 前：容器 footer 的删除按钮 anchor ts 未回填 → 禁用
    const delBefore = document.querySelector('.round-group__footer .msg-delete-icon') as HTMLButtonElement | null;
    expect(delBefore?.disabled).toBe(true);
    dispatch({ type: 'done', roundId: 'r1' });
    // done 后：commitTurnTs 用本轮用户输入 ts 回填 → 删除按钮可用（锁定已解除）
    const delAfter = document.querySelector('.round-group__footer .msg-delete-icon') as HTMLButtonElement;
    expect(delAfter.disabled).toBe(false);
    // 分叉按钮：roundId 回填 → 同样可用
    const forkAfter = document.querySelector('.round-group__footer .msg-fork-icon') as HTMLButtonElement;
    expect(forkAfter.disabled).toBe(false);
  });

  it('运行时交互行 roundId 随 done 回填：qa/supp 行与重放自带 roundId 对齐（2026-09-08 同构收口）', () => {
    mountChatView();
    // 流式首段（提问）→ 用户回答（qa 行，运行时无 roundId）→ resume 续接 → done 携带 roundId
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '需要确认？', roundId: 'r1' });
    dispatch({ type: 'user', text: '选A', ts: 't', kind: 'question-answer', question: '需要确认？' });
    const qaRow = document.querySelector('.msg-qa') as HTMLElement;
    expect(qaRow).not.toBeNull();
    // done 前：运行时 qa 行 roundId 未知（空）——与重放带 roundId 的差异点
    expect(qaRow.dataset.roundId ?? '').toBe('');
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 2, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '好，继续', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });
    // done 后：commitRoundId 回填交互行（防历史展开/未来宿主按 roundId 归属时落空）
    expect(qaRow.dataset.roundId).toBe('r1');
  });

  it('G31 方案1：运行时 done 收敛 QA 进折叠块——消息流干净、摘要含你答×N（2026-09-08 落地）', () => {
    mountChatView();
    // 有过程事件（narrate/tool）→ round-block 存在；过程中用户问答平铺消息流
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'process_event', event: { type: 'narrate', seq: 2, ts: '', payload: { content: '开始分析' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_start', seq: 3, ts: '', payload: { toolCallId: 't1', name: 'read_file' } } });
    dispatch({ type: 'process_event', event: { type: 'tool_result', seq: 4, ts: '', payload: { toolCallId: 't1', name: 'read_file', ok: true } } });
    dispatch({ type: 'chunk', content: '正在执行，需要确认方案', roundId: 'r1' });
    // 用户回答（运行时 qa，roundId 未知）
    dispatch({ type: 'user', text: '选方案A', ts: 't', kind: 'question-answer' });
    const qaRow = document.querySelector('.msg-qa') as HTMLElement;
    expect(qaRow).not.toBeNull();
    // 运行中（v1.8）：无 round-block 壳，过程平铺 .process-flow；QA 平铺消息流（折入未触发）
    expect(document.querySelector('.round-block')).toBeNull(); // 运行时绝无大折叠壳
    expect(document.querySelector('.process-flow')).not.toBeNull(); // 过程平铺容器在
    expect(qaRow.parentElement?.classList.contains('round-block__details')).toBe(false);
    // 续跑 + done → 收敛：QA 折入折叠块、平铺内容收进折叠、摘要更新、消息流干净
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 5, ts: '', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '好，按方案A继续', roundId: 'r1' });
    dispatch({ type: 'done', roundId: 'r1' });
    // QA 已折入 .round-block__details
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    // 运行时平铺容器已移除（过程收进折叠块，无残留平铺）
    expect(document.querySelector('.process-flow')).toBeNull();
    const rbQa = rb?.querySelector('.round-block__details .msg-qa');
    expect(rbQa).not.toBeNull();
    expect(rbQa!.textContent).toContain('选方案A');
    // narrate/tool 已由 finalize 全量承载进折叠块（收尾后过程在折叠内）
    expect(rb.querySelector('.round-block__details')?.textContent).toContain('开始分析');
    // 消息流层面：assistant 正文（含折叠块）→ 续接块，无孤立 QA 行（两段式干净）
    const assistants = document.querySelectorAll('.msg.assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    expect(rb.querySelector('.round-block__stats')?.textContent).toContain('你答×1');
    // done 后 round-block 收起（finalize）
    expect(rb?.hasAttribute('open')).toBe(false);
  });

  it('G31 方案1 修复（2026-09-08）：重放带 question 的 qa 成对完整折入——折叠内含「问回顾行 + 你答块」、assistant 相邻、摘要你答×1', () => {
    mountChatView();
    dispatch({ type: 'user', text: '帮我做方案', ts: 't1', roundId: 'round-1' });
    dispatch({ type: 'replay_events', roundId: 'round-1', events: [
      { type: 'meta', seq: 1, ts: 't1', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
      { type: 'metrics', seq: 2, ts: 't2', payload: { durationMs: 3000, tokenIn: 10, tokenOut: 20, toolFailureCount: 0, recallCount: 0, success: true } },
    ] as never });
    dispatch({ type: 'assistant', text: '你想读哪个文件？', ts: 't2', roundId: 'round-1' });
    // 带 question 的 qa（G26 形态：提问回顾行 + 回答折叠块）——修复前只折入问行、答块残留消息流
    dispatch({
      type: 'user',
      text: '读 probe.txt',
      ts: 't3',
      roundId: 'round-1',
      kind: 'question-answer',
      question: '你想读哪个文件？',
      options: ['probe.txt', 'config.json'],
    });
    dispatch({ type: 'assistant', text: '好的', ts: 't4', roundId: 'round-1' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    expect(rb).not.toBeNull();
    // 折叠块内成对完整：问回顾行 + 你答块
    const inBlock = rb.querySelectorAll<HTMLElement>('.round-block__details .msg-qa');
    expect(inBlock.length).toBe(2);
    expect(inBlock[0]!.classList.contains('msg-qa--ask')).toBe(true);
    expect(inBlock[1]!.querySelector('.msg-qa__tag')?.textContent).toBe('你答');
    // 消息流层面干净：assistant 前序段与 final 直接相邻（无残留 QA 块污染两段式）
    const blocks = document.querySelectorAll<HTMLElement>('.msg.assistant');
    expect(blocks[0]!.nextElementSibling).toBe(blocks[1]);
    // 折叠摘要含你答×1
    expect(rb.querySelector('.round-block__stats')?.textContent).toContain('你答×1');
  });

  it('ask 超时未答（2026-09-08 保底）：运行时提问框销毁、渲染「问 + 未回答」行、done 后折入折叠块 + 摘要未回答×1', () => {
    mountChatView();
    // 运行时轮：assistant 块（ask 暂停点）→ need_clarify 渲染提问框
    dispatch({ type: 'user', text: '帮我做方案', ts: 't1', roundId: 'round-1' });
    dispatch({ type: 'process_event', event: { type: 'meta', seq: 1, ts: 't1', payload: { role: 'AI', llm: 'm' } } });
    dispatch({ type: 'chunk', content: '在读取前需要确认：', roundId: 'round-1' });
    dispatch({ type: 'need_clarify', questions: [{ question: '你想读哪个文件？', options: ['probe.txt', 'config.json'] }] });
    const askInline = document.querySelector('.ask-inline') as HTMLElement;
    expect(askInline).not.toBeNull();
    // 宿主超时自动续跑：先投递「未回答」交互行（timeout 消息到达即销毁提问框）
    dispatch({ type: 'user', text: '用户未在时限内回答，已自动继续', ts: 't2', roundId: 'round-1', kind: 'timeout', question: '你想读哪个文件？', options: ['probe.txt', 'config.json'] });
    expect(document.querySelector('.ask-inline')).toBeNull(); // 提问框已销毁（不再等用户）
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.msg-qa'));
    // 问回顾行 + 未回答折叠块（阅读序）
    expect(rows.length).toBe(2);
    expect(rows[0]!.classList.contains('msg-qa--ask')).toBe(true);
    expect(rows[0]!.textContent).toContain('你想读哪个文件？');
    expect(rows[1]!.querySelector('.msg-qa__tag')?.textContent).toBe('未回答');
    expect(rows[1]!.textContent).toContain('已自动继续');
    // done → 收敛折入折叠块 + 摘要未回答×1
    dispatch({ type: 'chunk', content: '好的，按默认继续。', roundId: 'round-1' });
    dispatch({ type: 'done', roundId: 'round-1' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const rbQa = rb.querySelectorAll<HTMLElement>('.round-block__details .msg-qa');
    expect(rbQa.length).toBe(2); // 问回顾行 + 未回答块成对折入
    expect(rb.querySelector('.round-block__stats')?.textContent).toContain('未回答×1');
  });

  it('ask 超时重放：timeout 交互记录经 middle 透传渲染「问 + 未回答」并折入收起态折叠块（运行时 = 重放同构）', () => {
    mountChatView();
    dispatch({ type: 'user', text: '帮我做方案', ts: 't1', roundId: 'round-1' });
    dispatch({ type: 'replay_events', roundId: 'round-1', events: [
      { type: 'meta', seq: 1, ts: 't1', payload: { role: '文档设计师', llm: 'deepseek-chat' } },
      { type: 'metrics', seq: 2, ts: 't2', payload: { durationMs: 3000, tokenIn: 10, tokenOut: 20, toolFailureCount: 0, recallCount: 0, success: true } },
    ] as never });
    dispatch({ type: 'assistant', text: '在读取前需要确认：', ts: 't2', roundId: 'round-1' });
    // 重放 middle 段 timeout 行（宿主 sendRoundView 按 kind 透传；带 question/options）
    dispatch({ type: 'user', text: '用户未在时限内回答，已自动继续', ts: 't3', roundId: 'round-1', kind: 'timeout', question: '你想读哪个文件？', options: ['probe.txt', 'config.json'] });
    dispatch({ type: 'assistant', text: '好的，按默认继续。', ts: 't4', roundId: 'round-1' });
    const rb = document.querySelector('.round-block') as HTMLElement;
    const rbQa = rb.querySelectorAll<HTMLElement>('.round-block__details .msg-qa');
    expect(rbQa.length).toBe(2);
    expect(rbQa[0]!.classList.contains('msg-qa--ask')).toBe(true);
    expect(rbQa[1]!.querySelector('.msg-qa__tag')?.textContent).toBe('未回答');
    expect(rbQa[1]!.textContent).toContain('已自动继续');
    // 消息流干净 + 摘要
    const blocks = document.querySelectorAll<HTMLElement>('.msg.assistant');
    expect(blocks[0]!.nextElementSibling).toBe(blocks[1]);
    expect(rb.querySelector('.round-block__stats')?.textContent).toContain('未回答×1');
  });
});