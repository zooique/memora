/**
 * chatView — 对话面板 webview 运行时脚本（阶段 B P2-1）
 *
 * 由 chatPanel.ts 的 buildHtml 内联 <script> 迁移而来：以工厂函数 createChatView
 * 接收依赖（acquireVsCodeApi / window）并初始化全部交互，替代原「字符串注入脚本」。
 * 消除全局污染（window.ToolCard / __xxx 全局回调 → 模块 import + 显式回调映射），
 * 同时具备可测性（依赖注入，可传入 mock window/jsdom）。
 *
 * 由 esbuild 以 browser/iife 打包为 dist/webview/scripts/chatView.js，经
 * webview.asWebviewUri 在 HTML 中 <script src> 引用（CSP script-src 'self'）。
 */
import type {
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from '../../shared/protocol.js';
import { fmtTime } from '../helpers/fmtTime.js';
import { ToolCard } from '../components/toolCard.js';
import { initDropdowns } from '../components/dropdown.js';

/** chatView 依赖（依赖注入：隔离 webview 环境，单测可注入 mock） */
export interface ChatViewDeps {
  /** 获取 webview 通信 API（仅 webview 上下文合法） */
  acquireVsCodeApi: () => { postMessage(msg: WebviewToExtensionMessage): void };
  /** webview window 对象（脚本在浏览器环境运行） */
  window: Window;
}

/**
 * 初始化对话面板 webview 交互（替代原内联 <script>）
 *
 * @param deps 运行时依赖（acquireVsCodeApi + window）
 */
export function createChatView({ acquireVsCodeApi, window }: ChatViewDeps): void {
  const document = window.document;
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages') as HTMLElement;
  const emptyState = document.getElementById('emptyState') as HTMLElement;
  const input = document.getElementById('input') as HTMLTextAreaElement;
  const send = document.getElementById('send') as HTMLButtonElement;
  const memoryBar = document.getElementById('memoryBar') as HTMLElement;
  const noticeBar = document.getElementById('noticeBar') as HTMLElement;
  const inputBar = document.getElementById('inputBar') as HTMLElement;
  const clarifyBar = document.getElementById('clarifyBar') as HTMLElement;
  const clarifyText = document.getElementById('clarifyText') as HTMLElement;
  const clarifyOptions = document.getElementById('clarifyOptions') as HTMLElement;
  const clarifyInput = document.getElementById('clarifyInput') as HTMLInputElement;
  const clarifySend = document.getElementById('clarifySend') as HTMLButtonElement;
  // 底部模型下拉框（独立于顶部⋯菜单，用 extraClass=model-picker 修饰）
  const modelPicker = document.querySelector('.model-picker');
  const modelPickerMenu = modelPicker ? modelPicker.querySelector('.treedd__menu') : null;
  const modelPickerTrigger = modelPicker ? modelPicker.querySelector('.treedd__trigger') : null;
  // 顶部历史会话下拉框（用 extraClass=history-picker 修饰，可手动切换查看某天记录）
  const historyPicker = document.querySelector('.history-picker');
  const historyPickerMenu = historyPicker ? historyPicker.querySelector('.treedd__menu') : null;
  const historyPickerTrigger = historyPicker ? historyPicker.querySelector('.treedd__trigger') : null;

  // 当前 Provider 列表（由 chat_providers 消息填充）
  let currentProviders: { name: string; displayName: string }[] = [];
  let currentActive: string | undefined;
  // 历史会话日期列表（由 chat_history_dates 消息填充，倒序最新在前）
  let historyDates: string[] = [];

  // 切换 LLM 运行状态：thinking → 发送按钮变 loading，禁用输入；done 恢复
  function setStatus(state: 'thinking' | 'done'): void {
    if (state === 'thinking') {
      send.classList.add('loading');
      send.setAttribute('title', '思考中…');
      input.disabled = true;
    } else {
      send.classList.remove('loading');
      send.setAttribute('title', '发送 (Enter)');
      input.disabled = false;
      // 仅当用户没有正在与其他交互元素交互（焦点已回落 body —— disabled 的输入框
      // 自然失焦后的默认状态）时才恢复输入焦点，避免 done 时强制 focus 打断用户
      // 正在进行的其他操作（如阅读/操作下拉菜单，对抗评估 P1-4）
      if (document.activeElement === document.body) input.focus();
    }
  }

  // 复制消息文本到剪贴板
  function copyText(text: string): void {
    window.navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
  }

  // 空状态开关：消息区无 .msg 时显示空状态提示，有消息则隐藏
  function updateEmptyState(): void {
    emptyState.hidden = messages.querySelector('.msg') !== null;
  }

  // 滚动到底部（rAF 节流）：流式渲染时每 chunk 都可能触发滚动，
  // 用 requestAnimationFrame 合并为每帧一次，避免读写交错强制 reflow。
  let scrollRafPending = false;
  function scrollToBottom(): void {
    if (scrollRafPending) return;
    scrollRafPending = true;
    window.requestAnimationFrame(() => {
      scrollRafPending = false;
      messages.scrollTop = messages.scrollHeight;
    });
  }

  // 渲染模型下拉框选项
  function renderModelPicker(): void {
    if (!modelPickerMenu) return;
    // P0-1 防注入：模型名来自用户配置（displayName），禁止 innerHTML 拼接，
    // 一律用 createElement + textContent 构建，杜绝 HTML 注入/破版。
    modelPickerMenu.textContent = '';
    if (currentProviders.length > 0) {
      currentProviders.forEach((p) => {
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
        ? currentProviders.find((p) => p.name === currentActive)?.displayName || currentActive
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

  // 渲染历史会话下拉框选项（toolbar，可手动切换查看某天对话记录）
  function renderHistoryPicker(): void {
    if (!historyPickerMenu) return;
    // 防注入：日期来自 sessionStore key（YYYY-MM-DD），textContent 构建
    historyPickerMenu.textContent = '';
    // 「全部历史」作为首项（跨天合并，默认视角）
    const all = document.createElement('button');
    all.className = 'treedd__item';
    all.setAttribute('role', 'menuitem');
    all.setAttribute('data-treedd-id', '');
    all.textContent = '全部历史';
    historyPickerMenu.appendChild(all);
    // 按日期倒序列出各天对话
    historyDates.forEach((date) => {
      const btn = document.createElement('button');
      btn.className = 'treedd__item';
      btn.setAttribute('role', 'menuitem');
      btn.setAttribute('data-treedd-id', date);
      btn.textContent = date;
      historyPickerMenu.appendChild(btn);
    });
    // 更新触发器显示当前查看范围（紧凑胶囊，与模型选择器同一视觉语言）
    if (historyPickerTrigger) {
      historyPickerTrigger.textContent = '';
      const span = document.createElement('span');
      span.className = 'dd-model-name';
      span.textContent = '历史';
      historyPickerTrigger.appendChild(span);
      historyPickerTrigger.setAttribute('aria-label', '切换历史对话日期');
    }
  }

  // 追加一条消息：role 决定样式，ts 显示时间戳；AI 消息底部加「复制」（主动可见）
  function append(role: 'user' | 'assistant' | 'error', text: string, ts?: string): void {
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
      copyBtn.addEventListener('click', () => copyText(text));
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
  }

  let memoryTimer: number | null = null;
  function showMemory(text: string): void {
    memoryBar.textContent = text;
    memoryBar.hidden = false;
    if (memoryTimer) window.clearTimeout(memoryTimer);
    memoryTimer = window.setTimeout(() => {
      memoryBar.hidden = true;
    }, 2500);
  }

  // 提示条（错误级 / 低扰 info）：textContent 赋值防注入；
  // 分级停留——error 醒目且停留更久，info 低扰短暂显示（对齐排雷雷-4 语义分离）
  let noticeTimer: number | null = null;
  function showNotice(level: 'info' | 'error', message: string): void {
    noticeBar.className = 'notice-bar ' + level;
    noticeBar.textContent = message;
    noticeBar.hidden = false;
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      noticeBar.hidden = true;
    }, level === 'error' ? 8000 : 2500);
  }

  // 处理 extension → webview 消息（流式渲染 / 状态机 / 工具卡片 / 下拉数据）
  window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
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
    } else if (msg.type === 'done') {
      // 本轮流式结束：兜底终结所有残留「执行中」工具卡片，避免 tool_start 后
      // 流异常/中断时卡片永远停在 spinner（对抗评估 P1-1）。error 后必跟 done，
      // 此处统一收敛；切换日期清空消息区后无 is-running 卡片，调用幂等无副作用。
      ToolCard.settleRunning(messages, '已中断');
    } else if (msg.type === 'need_clarify') {
      clarifyText.textContent =
        'Agent 需要你确认：' + msg.questions.map((q) => q.question).join('；');
      clarifyInput.value = '';
      clarifyOptions.textContent = '';
      msg.questions.forEach((q) => {
        (q.options || []).forEach((opt) => {
          const b = document.createElement('button');
          b.className = 'opt-btn';
          b.textContent = opt;
          b.addEventListener('click', () => {
            clarifyInput.value = opt;
            clarifyInput.focus();
          });
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
      ToolCard.show(messages, msg.toolCallId, msg.name, msg.args);
    } else if (msg.type === 'tool_result') {
      ToolCard.update(messages, msg.toolCallId, msg.name, msg.ok, msg.summary);
    } else if (msg.type === 'clear_ok') {
      // 清空消息区须同时清 type=msg 消息与 .tool-card 工具卡片（对抗评估 P1-1）：
      // 仅挑 .msg 会让切换历史/清空后旧工具卡片残留 DOM，污染重放视图。
      // 不替换 messages 全部子节点（保留 #emptyState 占位），故按两类消息类型选择。
      messages.querySelectorAll('.msg, .tool-card').forEach((el) => el.remove());
      updateEmptyState();
    } else if (msg.type === 'chat_providers') {
      currentProviders = msg.providers || [];
      currentActive = msg.activeName;
      renderModelPicker();
    } else if (msg.type === 'chat_skill') {
      // 当前技能徽章：textContent 赋值防注入，显示后主动可见
      const badge = document.getElementById('skillBadge');
      if (badge) {
        badge.textContent = msg.skill;
        badge.title = '当前技能：' + msg.skill;
        badge.hidden = false;
      }
    } else if (msg.type === 'chat_history_dates') {
      // 历史会话日期列表（toolbar 历史下拉框）：刷新选项
      historyDates = msg.dates || [];
      renderHistoryPicker();
    } else if (msg.type === 'notice') {
      showNotice(msg.level, msg.message);
    }
  });

  // textarea 自适应高度（Enter 发送 / Shift+Enter 换行）
  // SSOT：高度上限单一真理源 — 从 CSS 令牌(--input-max-h)的计算值读取，
  // JS 与 CSS 共用同一上限，杜绝双源漂移。
  const inputMaxHeight = parseInt(window.getComputedStyle(input).maxHeight, 10) || 140;
  function autoResize(): void {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, inputMaxHeight) + 'px';
  }
  function sendMessage(): void {
    const text = input.value.trim();
    if (!text || send.classList.contains('loading')) return;
    input.value = '';
    input.style.height = 'auto';
    vscode.postMessage({ type: 'send', text });
  }
  send.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input.addEventListener('input', autoResize);

  // 下拉菜单：显式回调映射替代原 window.__xxx 全局函数名（去全局污染）
  // 键名与 buildDropdownHtml 的 data-on-select 属性值一一对应
  initDropdowns(document, {
    __treeddOnSelect: (id) => {
      // 危险操作确认在 extension host 侧完成（VSCode webview 禁用原生 confirm()，
      // 由 host 弹原生 modal，避免确认框静默失效 → 按钮无反应，对抗评估 P0-2）
      if (id === 'clear') vscode.postMessage({ type: 'clear' });
    },
    __modelPickerOnSelect: (id) => vscode.postMessage({ type: 'chat_set_provider', name: id }),
    __historyPickerOnSelect: (id) =>
      vscode.postMessage({ type: 'chat_switch_date', date: id || '' }),
  });

  // 主动提问回答：提交并续跑
  function sendClarifyAnswer(): void {
    const text = clarifyInput.value.trim();
    if (!text) return;
    clarifyInput.value = '';
    clarifyBar.classList.remove('visible');
    inputBar.hidden = false;
    vscode.postMessage({ type: 'clarify_answer', text });
  }
  clarifySend.addEventListener('click', sendClarifyAnswer);
  clarifyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendClarifyAnswer();
  });

  // 首屏刷新
  updateEmptyState();
  renderModelPicker();
  renderHistoryPicker();

  // 通知 extension：脚本已就绪、监听器已注册，可安全回放会话
  // （消除折叠/展开重建 HTML 时，消息在监听器注册前到达而被丢弃的竞态）
  vscode.postMessage({ type: 'ready' });
}
