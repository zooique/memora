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
import { ProviderStore } from '../../extension/providers/providerStore.js';
import { buildDropdownHtml, dropdownInitScript, dropdownStyles } from '../components/dropdown.js';
import { toolCardScript } from '../components/toolCard.js';
import { chatStyles } from '../styles/chatStyles.js';
import { toolCardStyles } from '../styles/toolCard.js';
import { fmtTimeScript } from '../helpers/fmtTime.js';
import { toolNameMapScript } from '../helpers/toolNameMap.js';

/** 侧边栏视图提供者 */
export class MemoraChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'memora.docReview.chat';

  /** 当前 webview（视图被关闭时 undefined） */
  private _view: vscode.WebviewView | undefined;
  /** 当前装配的 Agent（由 extension 装配后注入） */
  private _agent: Agent | undefined;
  /** 当前打磨文档上下文（打开时快照） */
  private _docContext: string | undefined;
  /** 大模型配置存储（用于底部模型下拉框 + 切换） */
  private readonly _providerStore: ProviderStore;
  /** Agent 懒装配工厂（由 extension 注入，打开面板即装配，不依赖先执行 open 命令） */
  private _getAgent: ((projectPath: string) => Promise<Agent>) | undefined;
  /** 是否已尝试装配（避免面板每次展开都重复装配） */
  private _agentResolving = false;

  /**
   * @param sessionStore 会话存储（用于持久化/恢复对话历史）
   * @param providerStore 大模型配置存储（用于底部模型下拉框）
   */
  constructor(private readonly sessionStore: ISessionStore, providerStore: ProviderStore) {
    this._providerStore = providerStore;
  }

  /** 注入 Agent 懒装配工厂（由 extension.ts 提供 getOrCreateAgent） */
  public setAgentFactory(getAgent: (projectPath: string) => Promise<Agent>): void {
    this._getAgent = getAgent;
  }

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
    // 折叠/展开会触发 resolve 重建 HTML。不设 retainContextWhenHidden（避免 window
    // 全局标志残留与 document 重建的冲突），统一走「ready 回放」这一确定性机制：
    // 每次重建后，webview 脚本就绪发 ready，extension 再回放会话，保证数据不丢。
    webviewView.webview.options = { enableScripts: true };

    // 仅设置 HTML（不在就绪前回放，避免消息在脚本监听器注册前丢失）
    this.render();

    // 打开面板即确保 Agent 装配（不依赖先执行 open 命令），避免发送无反应
    void this.ensureAgent();

    // 视图被销毁（折叠/关闭）时清理引用，避免向已销毁 webview postMessage
    webviewView.onDidDispose(() => {
      if (this._view === webviewView) this._view = undefined;
    });

    // 处理来自 webview 的用户输入
    webviewView.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => {
      if (msg.type === 'ready') {
        // webview 脚本就绪后才回放会话（历史 + Provider 列表），消除时序竞态
        this.replaySession();
      } else if (msg.type === 'send' && msg.text.trim()) {
        void this.handleSend(msg.text.trim());
      } else if (msg.type === 'clarify_answer' && msg.text.trim()) {
        void this.handleResume(msg.text.trim());
      } else if (msg.type === 'clear') {
        this.handleClear();
      } else if (msg.type === 'chat_set_provider') {
        void this.handleSetProvider(msg.name);
      }
    });
  }

  /**
   * 确保 Agent 已装配：若尚未装配则通过工厂懒装配一次
   *
   * 用户可能直接点活动栏面板图标打开（未执行 open 命令），此时 agent 从未装配，
   * 会导致发送无反应。此方法在打开面板时自动装配，失败时给出明确提示。
   */
  private async ensureAgent(): Promise<void> {
    if (this._agent || this._agentResolving || !this._getAgent) return;
    this._agentResolving = true;
    try {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!ws) {
        void vscode.window.showWarningMessage('Memora：请先打开一个工作区');
        return;
      }
      this._agent = await this._getAgent(ws);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Memora 装配失败：${msg}`);
    } finally {
      this._agentResolving = false;
    }
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

  /** 仅渲染 HTML 骨架（历史/Provider 在 webview 就绪后经 replaySession 回放） */
  private render(): void {
    if (!this._view) return;
    this._view.webview.html = buildHtml();
  }

  /**
   * 回放当前会话（历史消息 + Provider 列表）
   *
   * 仅在 webview 发来 ready（脚本监听器已注册）后调用，避免 postMessage
   * 在监听器就绪前到达而被丢弃（折叠/展开重建 HTML 时尤其明显）。
   */
  private replaySession(): void {
    if (!this._view) return;
    // 恢复历史消息（当前会话，含 user + assistant）
    const history = this.loadHistory();
    for (const m of history) {
      this.post({ type: m.role, text: m.content, ts: m.ts });
    }
    // 推送 Provider 列表到 webview（底部模型下拉框）
    void this.pushProviders();
  }

  /**
   * 推送 Provider 列表到 webview（异步读取配置）
   *
   * 在 render 时调用，也可在切换 Provider 后再次调用以刷新下拉框。
   */
  private async pushProviders(): Promise<void> {
    try {
      const providers = await this._providerStore.listMasked();
      const activeName = this._providerStore.getActiveName();
      const list = providers.map((p) => ({ name: p.name, displayName: p.displayName || p.name }));
      this.post({ type: 'chat_providers', providers: list, activeName });
    } catch {
      // 推送失败不阻塞主流程
    }
  }

  /**
   * 处理用户切换激活 Provider（底部模型下拉框）
   *
   * @param name 用户选中的 Provider 别名
   */
  private async handleSetProvider(name: string): Promise<void> {
    const r = await this._providerStore.setActive(name);
    if (r.ok) {
      // 切换成功，重新推送列表以刷新下拉框的选中态
      await this.pushProviders();
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
    if (!this._agent) {
      // Agent 未装配（可能仍在懒装配中）：提示用户稍候，而非静默无反应
      void vscode.window.showWarningMessage('Memora：Agent 尚未就绪，请稍候片刻再发送');
      return;
    }
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
    // 监听记忆事件 → 转发到 webview 展示记忆条（recalled：「想起」/ added：「已沉淀」）
    // 对齐 kernel 对称事件：memoryRecalled {count,query} / memoryAdded {id,source,name}
    const onMemoryRecalled = (info: { count: number }) => {
      this.post({ type: 'memory', action: 'recalled', count: info.count });
    };
    const onMemoryAdded = (info: { id: string; source: string; name: string }) => {
      this.post({ type: 'memory', action: 'added', count: 1, detail: info });
    };
    this._agent.on('memoryRecalled', onMemoryRecalled);
    this._agent.on('memoryAdded', onMemoryAdded);

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
        } else if (chunk.type === 'tool_start') {
          // 工具调用开始 → webview 渲染「执行中」卡片
          this.post({ type: 'tool_start', toolCallId: chunk.toolCallId, name: chunk.name, args: chunk.args });
        } else if (chunk.type === 'tool_result') {
          // 工具调用结束 → 更新卡片状态
          this.post({
            type: 'tool_result',
            toolCallId: chunk.toolCallId,
            name: chunk.name,
            ok: chunk.ok,
            summary: chunk.summary,
          });
        }
      }
      // 流结束时持久化完整的 assistant 回复
      if (fullContent.trim()) this.persist('assistant', fullContent);
    } catch (err) {
      this.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      this._agent.off('questionPending', onPendingQuestion);
      this._agent.off('memoryRecalled', onMemoryRecalled);
      this._agent.off('memoryAdded', onMemoryAdded);
    }
    // 结束状态（恢复输入框）；错误时也恢复，避免卡死
    this.post({ type: 'status', state: 'done' });
    this.post({ type: 'done' });
  }
}

/** 生成 Webview HTML（含消息区 / 输入框 + 模型下拉框 / 主动提问框） */
function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
  ${chatStyles}
  ${dropdownStyles}
  ${toolCardStyles}
</style>
</head>
<body>
  <div id="toolbar">
    <span class="title">文档打磨</span>
    ${buildDropdownHtml([{ id: 'clear', label: '清空对话', danger: true }])}
  </div>
  <div id="memoryBar" class="memory-bar" hidden></div>
  <div id="messages">
    <div id="emptyState" class="empty-state" hidden>开始打磨你的设计文档<br>在下方输入你的想法，或粘贴要打磨的文档内容</div>
  </div>
  <div id="clarifyBar">
    <div id="clarifyText"></div>
    <div id="clarifyOptions"></div>
    <div id="clarifyRow">
      <input id="clarifyInput" type="text" placeholder="回答 Agent 的问题，回车提交……" aria-label="回答 Agent 的问题" />
      <button id="clarifySend">提交回答</button>
    </div>
  </div>
  <div id="inputBar">
    <div id="inputWrap">
      <textarea id="input" rows="1" placeholder="在文档上打磨你的想法……（Enter 发送，Shift+Enter 换行）" aria-label="消息输入"></textarea>
      <div id="inputFooter">
        ${buildDropdownHtml([], { extraClass: 'model-picker', onSelect: '__modelPickerOnSelect' })}
        <button id="send" class="send-btn" title="发送 (Enter)" aria-label="发送">
          <svg class="send-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
          <span class="send-spinner"></span>
        </button>
      </div>
    </div>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const emptyState = document.getElementById('emptyState');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const sendSpinner = send.querySelector('.send-spinner');
    const memoryBar = document.getElementById('memoryBar');
    const inputBar = document.getElementById('inputBar');
    const clarifyBar = document.getElementById('clarifyBar');
    const clarifyText = document.getElementById('clarifyText');
    const clarifyOptions = document.getElementById('clarifyOptions');
    const clarifyInput = document.getElementById('clarifyInput');
    const clarifySend = document.getElementById('clarifySend');
    // 底部模型下拉框（独立于顶部⋯菜单，用 extraClass=model-picker 修饰）
    const modelPicker = document.querySelector('.model-picker');
    const modelPickerMenu = modelPicker ? modelPicker.querySelector('.treedd__menu') : null;
    const modelPickerTrigger = modelPicker ? modelPicker.querySelector('.treedd__trigger') : null;

    // 当前 Provider 列表（由 chat_providers 消息填充）
    let currentProviders = [];
    let currentActive = undefined;

    // 切换 LLM 运行状态：thinking → 发送按钮变 loading，禁用输入；done 恢复
    function setStatus(state) {
      if (state === 'thinking') {
        send.classList.add('loading');
        send.setAttribute('title', '思考中…');
        input.disabled = true;
      } else {
        send.classList.remove('loading');
        send.setAttribute('title', '发送 (Enter)');
        input.disabled = false;
        input.focus();
      }
    }

    // 时间格式化（自定义组件注入版本，见 helpers/fmtTime.ts）
    ${fmtTimeScript}

    // 复制消息文本到剪贴板
    function copyText(text) {
      navigator.clipboard.writeText(text).catch(function () {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      });
    }

    // 空状态开关：消息区无 .msg 时显示空状态提示，有消息则隐藏
    function updateEmptyState() {
      emptyState.hidden = messages.querySelector('.msg') !== null;
    }

    // 滚动到底部（rAF 节流）：流式渲染时每 chunk 都可能触发滚动，
    // 用 requestAnimationFrame 合并为每帧一次，避免读写交错强制 reflow。
    let scrollRafPending = false;
    function scrollToBottom() {
      if (scrollRafPending) return;
      scrollRafPending = true;
      requestAnimationFrame(function () {
        scrollRafPending = false;
        messages.scrollTop = messages.scrollHeight;
      });
    }

    // 渲染模型下拉框选项
    function renderModelPicker() {
      if (!modelPickerMenu) return;
      // P0-1 防注入：模型名来自用户配置（displayName），禁止 innerHTML 拼接，
      // 一律用 createElement + textContent 构建，杜绝 HTML 注入/破版。
      modelPickerMenu.textContent = '';
      const items = currentProviders;
      if (items && items.length > 0) {
        items.forEach(function (p) {
          const isActive = p.name === currentActive;
          const btn = document.createElement('button');
          btn.className = 'treedd__item' + (isActive ? ' is-active' : '');
          btn.setAttribute('role', 'menuitem');
          btn.setAttribute('data-treedd-id', p.name);
          btn.textContent = p.displayName || p.name;
          modelPickerMenu.appendChild(btn);
        });
      } else {
        const empty = document.createElement('div');
        empty.className = 'treedd__empty';
        empty.textContent = '未配置模型';
        modelPickerMenu.appendChild(empty);
      }
      // 更新触发器显示当前模型（同样用 textContent 防注入）
      // SSOT：用 <span class="dd-model-name"> 包裹名称，CSS 只对此 span 做 ellipsis 截断，
      // 而 ::after 下拉箭头 flex-shrink:0 永远外露，不会被挤掉或截断
      if (modelPickerTrigger) {
        const name = currentActive
          ? (currentProviders.find(function(p){return p.name===currentActive;}) || {}).displayName || currentActive
          : '选择模型';
        modelPickerTrigger.textContent = '';
        const span = document.createElement('span');
        span.className = 'dd-model-name';
        span.textContent = name;
        modelPickerTrigger.appendChild(span);
        // 触发器可访问性：为读屏提供名称（aria-haspopup 已在组件 HTML 中声明）
        modelPickerTrigger.setAttribute('aria-label', '选择模型：' + name);
      }
    }

    // 追加一条消息：role 决定样式，ts 显示时间戳；AI 消息底部加「复制」（主动可见）
    function append(role, text, ts) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      const body = document.createElement('div');
      body.className = 'msg-body';
      body.textContent = text;
      div.appendChild(body);
      const footer = document.createElement('div');
      footer.className = 'msg-footer';
      if (role === 'assistant') {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'msg-copy';
        copyBtn.textContent = '复制';
        copyBtn.title = '复制消息';
        copyBtn.addEventListener('click', function () { copyText(text); });
        footer.appendChild(copyBtn);
      }
      const t = fmtTime(ts);
      if (t) {
        const timeEl = document.createElement('span');
        timeEl.className = 'msg-time';
        timeEl.textContent = t;
        footer.appendChild(timeEl);
      }
      div.appendChild(footer);
      messages.appendChild(div);
      scrollToBottom();
      updateEmptyState();
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
        append('assistant', msg.text, msg.ts);
      } else if (msg.type === 'chunk') {
        const last = messages.lastElementChild;
        if (last && last.classList.contains('assistant')) {
          const body = last.querySelector(':scope > .msg-body');
          if (body) {
            // 流式追加：用文本节点替代整体 textContent 重建，长回复避免 O(n²)
            body.appendChild(document.createTextNode(msg.content));
          }
        } else {
          append('assistant', msg.content, msg.ts);
        }
        scrollToBottom();
      } else if (msg.type === 'error') {
        append('error', msg.message);
      } else if (msg.type === 'need_clarify') {
        clarifyText.textContent = 'Agent 需要你确认：' + msg.questions.map(function(q){return q.question;}).join('；');
        clarifyInput.value = '';
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
        if (msg.action === 'recalled') showMemory('已召回 ' + msg.count + ' 条记忆');
        else if (msg.action === 'added') showMemory('已沉淀 1 条记忆');
      } else if (msg.type === 'tool_start') {
        window.ToolCard.show(messages, msg.toolCallId, msg.name, msg.args);
      } else if (msg.type === 'tool_result') {
        window.ToolCard.update(messages, msg.toolCallId, msg.name, msg.ok, msg.summary);
      } else if (msg.type === 'clear_ok') {
        messages.querySelectorAll('.msg').forEach(function (el) { el.remove(); });
        updateEmptyState();
      } else if (msg.type === 'chat_providers') {
        currentProviders = msg.providers || [];
        currentActive = msg.activeName;
        renderModelPicker();
      }
    });

    // textarea 自适应高度（Enter 发送 / Shift+Enter 换行）
    // SSOT：高度上限单一真理源 — 从 CSS 令牌(--input-max-h)的计算值读取，
    // JS 与 CSS 共用同一上限，杜绝双源漂移。
    const inputMaxHeight = parseInt(getComputedStyle(input).maxHeight, 10) || 140;
    function autoResize() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, inputMaxHeight) + 'px';
    }
    function sendMessage() {
      const text = input.value.trim();
      if (!text || send.classList.contains('loading')) return;
      input.value = '';
      input.style.height = 'auto';
      vscode.postMessage({ type: 'send', text });
    }
    send.addEventListener('click', sendMessage);
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    input.addEventListener('input', autoResize);

    // 顶部⋯菜单：清空对话（危险项）
    window.__treeddOnSelect = function (id) {
      if (id === 'clear') {
        if (confirm('确定清空当前对话？此操作不可恢复。')) {
          vscode.postMessage({ type: 'clear' });
        }
      }
    };

    // 底部模型下拉框：选择模型 → 通知 extension host 切换
    window.__modelPickerOnSelect = function (id) {
      vscode.postMessage({ type: 'chat_set_provider', name: id });
    };

    function sendClarifyAnswer() {
      const text = clarifyInput.value.trim();
      if (!text) return;
      clarifyInput.value = '';
      clarifyBar.classList.remove('visible');
      inputBar.hidden = false;
      vscode.postMessage({ type: 'clarify_answer', text });
    }
    clarifySend.addEventListener('click', sendClarifyAnswer);
    clarifyInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') sendClarifyAnswer(); });

    ${toolNameMapScript}
    ${toolCardScript}
    ${dropdownInitScript}

    // 首屏刷新
    updateEmptyState();
    renderModelPicker();

    // 通知 extension：脚本已就绪、监听器已注册，可安全回放会话
    // （消除折叠/展开重建 HTML 时，消息在监听器注册前到达而被丢弃的竞态）
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}