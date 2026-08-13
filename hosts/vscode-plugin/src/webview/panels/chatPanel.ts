/**
 * 对话打磨面板 — 侧边栏 Webview 视图提供者（u1 UX 改进）
 *
 * 职责：
 *   - 渲染对话消息区（用户 / AI）+ 输入框 + 主动提问框；
 *   - 将用户输入 postMessage 到 extension host，调 Agent.chat() 流式返回并渲染；
 *   - 收到 extension host 的 questionPending 事件渲染提问框，回答后 resumeExecution 续跑；
 *   - 会话持久化：打开面板时从 sessionStore 恢复历史，发消息时写入。
 *
 * 设计（薄壳 + 复用内核，单一真理源）：
 *   - 文档属「当前任务上下文」注入 chat 输入，不进入记忆召回；
 *   - 渲染逻辑全部在 webview 内（postMessage 驱动），extension host 不做 DOM 操作；
 *   - 持久化复用内核 sessionStore 机制（date-session 组织消息）。
 */
import * as vscode from 'vscode';
import type { Agent, AgentChunk, ISessionStore } from '@zooique/memora';
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';

/** 侧边栏视图提供者 */
export class MemoraChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'memora.docReview.chat';

  /** 当前 webview（视图被关闭时 undefined） */
  private _view: vscode.WebviewView | undefined;
  /** 当前装配的 Agent（由 extension 装配后注入） */
  private _agent: Agent | undefined;
  /** 当前打磨文档上下文（打开时快照） */
  private _docContext: string | undefined;

  /**
   * @param sessionStore 会话存储（用于持久化/恢复对话历史）
   */
  constructor(private readonly sessionStore: ISessionStore) {}

  /** 由 extension 在装配 Agent 后注入 */
  public setAgent(agent: Agent): void {
    this._agent = agent;
  }

  /** 设置当前打磨文档上下文（打开面板时调用） */
  public setDocContext(docContext: string | undefined): void {
    this._docContext = docContext;
  }

  /** 视图被解析（侧边栏展开）时初始化 */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    // 渲染界面（含历史恢复）
    this.render();

    // 处理来自 webview 的用户输入
    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      if (msg.type === 'send' && msg.text.trim()) {
        void this.handleSend(msg.text.trim());
      } else if (msg.type === 'clarify_answer' && msg.text.trim()) {
        void this.handleResume(msg.text.trim());
      } else if (msg.type === 'clear') {
        this.handleClear();
      }
    });
  }

  /**
   * 清空当前会话：清空该会话持久化消息，并通知 webview 清空消息区
   *
   * 依赖 WorkspaceSessionStore.clearSession（宿主扩展方法，非内核 ISessionStore 标准接口）。
   */
  private handleClear(): void {
    try {
      const { date, session, store } = this.sessionInfo();
      const withClear = store as unknown as { clearSession?: (d: string, s: string) => void };
      withClear.clearSession?.(date, session);
    } catch {
      // 清空失败不阻塞，仅清 webview UI
    }
    this.post({ type: 'clear_ok' });
  }

  /** 渲染界面：HTML + 历史消息 */
  private render(): void {
    if (!this._view) return;
    this._view.webview.html = buildHtml();
    // 恢复历史消息（当前会话，含 user + assistant）
    const history = this.loadHistory();
    for (const m of history) {
      this.post({ type: m.role, text: m.content, ts: m.ts });
    }
  }

  /**
   * 从 sessionStore 恢复当前会话的完整历史（user + assistant）
   *
   * 恢复策略：
   *   - user 消息：直接回放原始内容
   *   - assistant 消息：回放上一次流式输出的完整内容（避免拼接不完整流）
   *   - 内核注入的 `<user_input>` 系统消息跳过（由 panel 持久化的 user 消息替代）
   *
   * @returns 带 role/timestamp 标记的会话消息列表
   */
  private loadHistory(): { role: 'user' | 'assistant'; content: string; ts?: string }[] {
    try {
      const { date, session, store } = this.sessionInfo();
      const msgs = store.loadMessages(date, session) as { role?: string; content?: string; timestamp?: string }[];
      return msgs
        .filter((m) => m.content && !m.content.startsWith('<user_input>'))
        .map((m) => ({
          role: (m.role === 'user' || m.role === 'assistant' ? m.role : 'user') as 'user' | 'assistant',
          content: m.content ?? '',
          ts: m.timestamp,
        }));
    } catch {
      return [];
    }
  }

  /** 当前会话的 date/session（默认当天 main，复用内核会话组织） */
  private sessionInfo(): { date: string; session: string; store: ISessionStore } {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return { date, session: 'main', store: this.sessionStore };
  }

  /** 持久化一条消息 */
  private persist(role: 'user' | 'assistant', content: string): void {
    const { date, session, store } = this.sessionInfo();
    store.appendMessage(date, session, { role, content, timestamp: new Date().toISOString() });
  }

  /** 向 webview 发送消息 */
  private post(msg: ExtensionToWebviewMessage): void {
    void this._view?.webview.postMessage(msg);
  }

  /** 处理用户输入：持久化 + 面板上屏 + Agent 流式对话 */
  private async handleSend(input: string): Promise<void> {
    if (!this._agent) return;
    const now = new Date().toISOString();
    this.persist('user', input);
    this.post({ type: 'user', text: input, ts: now });

    // 注入文档上下文（当前任务上下文，不进入记忆召回）
    const chatInput = this._docContext
      ? `[当前打磨文档内容]\n${this._docContext}\n[/当前打磨文档内容]\n\n用户请求：${input}`
      : input;

    await this.consumeFlow(this._agent.chat(chatInput));
  }

  /** 处理用户对主动提问的回答：persist + resumeExecution 续跑 */
  private async handleResume(input: string): Promise<void> {
    if (!this._agent) return;
    const now = new Date().toISOString();
    this.persist('user', input);
    this.post({ type: 'user', text: input, ts: now });
    await this.consumeFlow(this._agent.resumeExecution(input));
  }

  /** 消费 Agent 流：转发 text chunk，监听主动提问事件，透出运行状态 */
  private async consumeFlow(gen: AsyncGenerator<AgentChunk, void, unknown>): Promise<void> {
    if (!this._agent) return;
    // 监听主动提问事件 → 渲染提问框
    const onPendingQuestion = (questions: { slot: string; question: string }[]) => {
      this.post({ type: 'need_clarify', questions });
    };
    this._agent.on('questionPending', onPendingQuestion);

    let fullContent = '';
    // P0-2：进入生成状态（webview 展示加载动画 + 禁用输入）
    this.post({ type: 'status', state: 'thinking' });
    // P1：流式第一条 chunk 的时间戳（作为本轮 assistant 回复的时间）
    let firstChunkTs = new Date().toISOString();
    try {
      for await (const chunk of gen) {
        if (chunk.type === 'text' && chunk.content) {
          fullContent += chunk.content;
          this.post({ type: 'chunk', content: chunk.content, ts: firstChunkTs });
        }
      }
      // 流结束时持久化完整的 assistant 回复
      if (fullContent.trim()) this.persist('assistant', fullContent);
    } catch (err) {
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this._agent.off('questionPending', onPendingQuestion);
    }
    // 结束状态（恢复输入框）；错误时也恢复，避免卡死
    this.post({ type: 'status', state: 'done' });
    this.post({ type: 'done' });
  }
}

/** 生成 Webview HTML（含消息区 / 输入框 / 主动提问框） */
function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; flex-direction: column; height: 100vh; font-size: 13px; }
  #messages { flex: 1; overflow-y: auto; padding: 12px; box-sizing: border-box; }
  .msg { margin: 6px 0; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; position: relative; }
  .msg.user { background: var(--vscode-button-background, #e8f0fe); color: var(--vscode-button-foreground, #1a73e8); align-self: flex-end; }
  .msg.assistant { background: var(--vscode-editor-inactiveSelectionBackground, #f1f3f4); }
  .msg.error { background: var(--vscode-inputValidation-errorBackground, #fdecea); color: var(--vscode-inputValidation-errorForeground, #b3261e); }
  /* P1-时间戳：右上角小字，hover 显示复制按钮 */
  .msg-time { font-size: 10px; color: var(--vscode-descriptionForeground, #9aa0a6); margin-top: 4px; text-align: right; }
  .msg-copy { position: absolute; top: 4px; right: 4px; display: none; padding: 2px 6px; font-size: 11px; border-radius: 4px; border: none; background: var(--vscode-button-secondaryBackground, #e0e0e0); color: var(--vscode-button-secondaryForeground, #333); cursor: pointer; }
  .msg:hover .msg-copy { display: block; }
  #inputBar { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border, #ddd); }
  #input { flex: 1; padding: 8px; border-radius: 6px; border: 1px solid var(--vscode-input-border, #ccc); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  button { padding: 8px 14px; border-radius: 6px; border: none; background: var(--vscode-button-background, #1a73e8); color: var(--vscode-button-foreground, #fff); cursor: pointer; }
  .memory-bar { padding: 4px 12px; font-size: 12px; color: var(--vscode-descriptionForeground, #5f6368); background: var(--vscode-inputValidation-infoBackground, #e6f4ea); border-bottom: 1px solid var(--vscode-panel-border, #ceead6); }
  /* P0-2：LLM 运行状态条（生成中动画） */
  #statusBar { display: none; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12px; color: var(--vscode-descriptionForeground, #5f6368); border-bottom: 1px solid var(--vscode-panel-border, #ddd); }
  #statusBar.visible { display: flex; }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--vscode-panel-border, #ccc); border-top-color: var(--vscode-button-background, #1a73e8); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #clarifyBar { display: none; flex-direction: column; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-charts-yellow, #daa520); background: var(--vscode-inputValidation-warningBackground, #fff8e1); }
  #clarifyBar.visible { display: flex; }
  #clarifyText { font-size: 12px; color: var(--vscode-descriptionForeground, #6d5f00); }
  #clarifyRow { display: flex; gap: 6px; }
  #clarifyInput { flex: 1; padding: 8px; border-radius: 6px; border: 1px solid var(--vscode-input-border, #ccc); background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
  /* P1-主动提问：快捷选项按钮 */
  #clarifyOptions { display: flex; flex-wrap: wrap; gap: 6px; }
  .opt-btn { padding: 4px 10px; font-size: 12px; border-radius: 999px; border: 1px solid var(--vscode-charts-yellow, #daa520); background: transparent; color: var(--vscode-descriptionForeground, #6d5f00); cursor: pointer; }
  .opt-btn:hover { background: var(--vscode-inputValidation-warningBackground, #fff8e1); }
  /* 顶部工具按钮 */
  #toolbar { display: flex; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border, #ddd); align-items: center; }
  #toolbar .spacer { flex: 1; }
  .tool-btn { padding: 4px 10px; font-size: 12px; border-radius: 6px; border: 1px solid var(--vscode-panel-border, #ccc); background: transparent; color: var(--vscode-descriptionForeground, #5f6368); cursor: pointer; }
  .tool-btn:hover { background: var(--vscode-editor-inactiveSelectionBackground, #f1f3f4); }
</style>
</head>
<body>
  <div id="toolbar">
    <span style="font-weight:600;">文档打磨</span>
    <span class="spacer"></span>
    <button id="btnClear" class="tool-btn" title="清空当前对话">清空对话</button>
  </div>
  <div id="memoryBar" class="memory-bar" hidden></div>
  <div id="statusBar"><span class="spinner"></span><span id="statusText">Agent 思考中…</span></div>
  <div id="messages"></div>
  <div id="clarifyBar">
    <div id="clarifyText"></div>
    <div id="clarifyOptions"></div>
    <div id="clarifyRow">
      <input id="clarifyInput" type="text" placeholder="回答 Agent 的问题，回车提交……" />
      <button id="clarifySend">提交回答</button>
    </div>
  </div>
  <div id="inputBar">
    <input id="input" type="text" placeholder="在文档上打磨你的想法……" />
    <button id="send">发送</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const memoryBar = document.getElementById('memoryBar');
    const statusBar = document.getElementById('statusBar');
    const inputBar = document.getElementById('inputBar');
    const clarifyBar = document.getElementById('clarifyBar');
    const clarifyText = document.getElementById('clarifyText');
    const clarifyOptions = document.getElementById('clarifyOptions');
    const clarifyInput = document.getElementById('clarifyInput');
    const clarifySend = document.getElementById('clarifySend');
    const btnClear = document.getElementById('btnClear');

    // P0-2：切换 LLM 运行状态（thinking 显示状态条 + 禁用输入；done 恢复）
    function setStatus(state) {
      if (state === 'thinking') {
        statusBar.classList.add('visible');
        input.disabled = true;
        send.disabled = true;
      } else {
        statusBar.classList.remove('visible');
        input.disabled = false;
        send.disabled = false;
        input.focus();
      }
    }

    // 格式化时间戳（ISO → HH:MM）
    function fmtTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    // 复制消息文本到剪贴板
    function copyText(text) {
      navigator.clipboard.writeText(text).catch(function () {
        // 剪贴板失败时降级用 textarea 复制
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      });
    }

    // 追加一条消息：role 决定样式，ts 显示时间戳，assistant 加复制按钮
    function append(role, text, ts) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      const body = document.createElement('div');
      body.textContent = text;
      div.appendChild(body);
      // 复制按钮（assistant/user 均可复制）
      const copyBtn = document.createElement('button');
      copyBtn.className = 'msg-copy';
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', function () { copyText(text); });
      div.appendChild(copyBtn);
      // 时间戳
      const t = fmtTime(ts);
      if (t) {
        const timeEl = document.createElement('div');
        timeEl.className = 'msg-time';
        timeEl.textContent = t;
        div.appendChild(timeEl);
      }
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    let memoryTimer = null;
    function showMemory(text) {
      memoryBar.textContent = text;
      memoryBar.hidden = false;
      clearTimeout(memoryTimer);
      memoryTimer = setTimeout(() => { memoryBar.hidden = true; }, 2500);
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'status') {
        setStatus(msg.state);
      } else if (msg.type === 'user') {
        append('user', msg.text, msg.ts);
      } else if (msg.type === 'assistant') {
        // 历史回放：完整 assistant 消息直接渲染（不进入流式拼接）
        append('assistant', msg.text, msg.ts);
      } else if (msg.type === 'chunk') {
        const last = messages.lastElementChild;
        if (last && last.classList.contains('assistant')) {
          // 流式拼接：更新内容 body，保留时间戳/复制按钮/时间
          const body = last.querySelector(':scope > div:first-child');
          if (body) body.textContent += msg.content;
        } else {
          append('assistant', msg.content, msg.ts);
        }
        messages.scrollTop = messages.scrollHeight;
      } else if (msg.type === 'error') {
        append('error', msg.message);
      } else if (msg.type === 'need_clarify') {
        clarifyText.textContent = 'Agent 需要你确认：' + msg.questions.map(function(q){return q.question;}).join('；');
        clarifyInput.value = '';
        // P1-主动提问：渲染快捷选项
        clarifyOptions.innerHTML = '';
        msg.questions.forEach(function (q) {
          (q.options || []).forEach(function (opt) {
            const b = document.createElement('button');
            b.className = 'opt-btn';
            b.textContent = opt;
            b.addEventListener('click', function () { clarifyInput.value = opt; clarifyInput.focus(); });
            clarifyOptions.appendChild(b);
          });
        });
        clarifyBar.classList.add('visible');
        inputBar.hidden = true;
        clarifyInput.focus();
      } else if (msg.type === 'memory') {
        if (msg.action === 'recalled') showMemory('🧠 已召回 ' + msg.count + ' 条记忆');
        else if (msg.action === 'added') showMemory('📝 已沉淀 1 条记忆');
      } else if (msg.type === 'clear_ok') {
        messages.innerHTML = '';
      }
    });

    function sendMessage() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      vscode.postMessage({ type: 'send', text });
    }
    send.addEventListener('click', sendMessage);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

    // P1-清空对话：确认后发 clear 给 extension host
    btnClear.addEventListener('click', function () {
      if (confirm('确定清空当前对话？此操作不可恢复。')) {
        vscode.postMessage({ type: 'clear' });
      }
    });

    function sendClarifyAnswer() {
      const text = clarifyInput.value.trim();
      if (!text) return;
      clarifyInput.value = '';
      clarifyBar.classList.remove('visible');
      inputBar.hidden = false;
      vscode.postMessage({ type: 'clarify_answer', text });
    }
    clarifySend.addEventListener('click', sendClarifyAnswer);
    clarifyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendClarifyAnswer(); });
  </script>
</body>
</html>`;
}