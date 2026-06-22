/**
 * UIManager 测试覆盖
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - 消息渲染（appendMessage / updateStreamingMessage / finishStreamingMessage）
 * - 面板切换（switchPanel）
 * - 表单收集（collectConfigFromForm / collectLlmConfigFromForm / getAddMemoryFormData）
 * - 事件回调注册（onSendMessage / onStopMessage / onMemorySearch 等）
 * - 流式消息管理（startStreaming / stopAllStreaming / clearMessages）
 * - Toast 通知（showToast）
 * - 未读计数（clearUnreadCount / setUnreadCount）
 * - 空状态（showEmptyState / hideEmptyState）
 * - 确认弹窗（showConfirmDialog）
 * - 输入处理（getUserInput / sanitizeInput）
 * - 角色面板（renderPersonaDropdown / updateActivePersona）
 * - 记忆面板（renderMemoryList / showMemoryDetail）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { UIManager } from '../electron/renderer/ui.js';
import type { MemoryListItem, MemoryDetail } from '../electron/renderer/ui.js';

// ─── 测试辅助 ─────────────────────────────────────────────

/** 完整的 index.html DOM 结构片段（仅包含 UIManager 构造函数需要的元素） */
const TEST_HTML = `<!DOCTYPE html>
<html><body>
  <header id="titlebar">
    <div id="titlebar-drag"><span id="app-title">🧚 Memora</span></div>
    <div id="titlebar-controls">
      <button id="btn-minimize" title="最小化">─</button>
      <button id="btn-maximize" title="最大化">□</button>
      <button id="btn-close" title="关闭">✕</button>
    </div>
  </header>
  <div id="app">
    <aside id="sidebar">
      <div class="sidebar-brand">
        <div class="sidebar-brand-icon">🧚</div>
        <span>Memora</span>
      </div>
      <div id="sidebar-header">
        <div id="persona-selector">
          <span id="persona-icon">🧚</span>
          <span id="persona-name">精灵</span>
          <span id="persona-mode-badge" class="mode-badge">自动</span>
          <span id="persona-arrow">▼</span>
        </div>
        <div id="persona-dropdown" class="dropdown hidden"></div>
      </div>
      <div id="sidebar-content">
        <div id="dashboard">
          <div class="dash-item"><span class="dash-label">🧠 记忆</span><span class="dash-value" id="memory-count">0</span></div>
          <div class="dash-item"><span class="dash-label">💡 洞察</span><span class="dash-value" id="insight-count">0</span></div>
          <div class="dash-item"><span class="dash-label">🎭 角色</span><span class="dash-value" id="persona-count">0</span></div>
          <div class="dash-item" id="dash-triggers"><span class="dash-label">🔔 触发器</span><span class="dash-value" id="trigger-count">0</span></div>
          <div class="dash-item" id="dash-pending" style="grid-column: span 2;"><span class="dash-label">📥 事件</span><span class="dash-value" id="pending-count">0/3</span></div>
        </div>
        <nav id="sidebar-nav">
          <button class="nav-btn active" data-panel="chat">💬 对话</button>
          <button class="nav-btn" data-panel="memories">🧠 记忆</button>
          <button class="nav-btn" data-panel="settings">⚙️ 设置</button>
        </nav>
        <div id="recommendations" class="dashboard-section hidden">
          <h3>推荐</h3>
          <ul id="recommendation-list" class="suggestion-list"></ul>
        </div>
      </div>
    </aside>
    <main id="main-content">
      <div id="panel-chat" class="panel active">
        <div id="chat-toolbar">
          <div class="chat-toolbar-info">
            <span class="chat-toolbar-title">对话</span>
            <span class="chat-toolbar-subtitle" id="chat-message-count">今日已交流 0 条消息</span>
          </div>
          <button id="btn-new-session" title="开始新会话">✨ 新会话</button>
        </div>
        <div id="proactive-banner" class="hidden">
          <span class="banner-icon">🧚</span>
          <span class="banner-text" id="proactive-banner-text"></span>
          <div class="banner-actions">
            <button class="banner-btn" data-action="view">查看</button>
            <button class="banner-btn" data-action="later">稍后</button>
            <button class="banner-btn" data-action="silent">静默 1 小时</button>
          </div>
          <button class="banner-close" data-action="close" title="关闭">✕</button>
        </div>
        <div id="messages">
          <div id="chat-empty-state" class="chat-empty-state">
            <button class="suggestion-btn" data-suggestion="测试问题">测试</button>
          </div>
        </div>
        <div id="input-area">
          <textarea id="input" placeholder="输入消息" rows="1"></textarea>
          <div class="input-toolbar">
            <div class="input-actions-left">
              <button class="input-action" id="btn-add-memory-quick" title="添加记忆（快速）">➕</button>
            </div>
            <div class="input-send-area">
              <button id="btn-send">发送</button>
            </div>
          </div>
        </div>
      </div>
      <div id="panel-memories" class="panel">
        <div class="panel-header">
          <input type="text" id="memory-search" placeholder="搜索记忆…" />
          <select id="memory-filter-source">
            <option value="">全部来源</option>
            <option value="profile">profile</option>
          </select>
          <button id="btn-add-memory">+ 添加</button>
        </div>
        <div id="memory-list"></div>
      </div>
      <div id="panel-settings" class="panel">
        <div class="settings-tabs">
          <button class="settings-tab active" data-settings-tab="llm">大模型</button>
          <button class="settings-tab" data-settings-tab="embedding">嵌入</button>
          <button class="settings-tab" data-settings-tab="sprite">精灵</button>
        </div>
        <div class="settings-tab-content active" data-settings-tab="llm">
          <div class="settings-group">
            <div class="settings-row">
              <label for="cfg-llm-preset">提供商预设</label>
              <select id="cfg-llm-preset"><option value="">自定义</option></select>
            </div>
            <div class="settings-row">
              <label for="cfg-llm-provider">提供商</label>
              <input type="text" id="cfg-llm-provider" />
            </div>
            <div class="settings-row">
              <label for="cfg-llm-model">模型</label>
              <input type="text" id="cfg-llm-model" />
            </div>
            <div class="settings-row">
              <label for="cfg-llm-base-url">API 地址</label>
              <input type="text" id="cfg-llm-base-url" />
            </div>
            <div class="settings-row">
              <label for="cfg-llm-api-key">API Key</label>
              <div class="input-with-action">
                <input type="password" id="cfg-llm-api-key" />
                <button type="button" id="btn-toggle-llm-key" class="toggle-visibility">👁</button>
              </div>
            </div>
            <div class="settings-row">
              <label for="cfg-llm-temperature">温度</label>
              <input type="number" id="cfg-llm-temperature" value="0.7" />
            </div>
            <div class="settings-row">
              <label></label>
              <div>
                <button id="btn-llm-test" class="btn-secondary" type="button">测试连接</button>
                <span id="llm-test-result" class="settings-hint"></span>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-tab-content" data-settings-tab="embedding">
          <div class="settings-group">
            <div class="settings-row">
              <label for="cfg-emb-enabled">启用语义搜索</label>
              <input type="checkbox" id="cfg-emb-enabled" />
            </div>
            <div class="settings-row">
              <label for="cfg-emb-model">模型</label>
              <input type="text" id="cfg-emb-model" />
            </div>
            <div class="settings-row">
              <label for="cfg-emb-base-url">API 地址</label>
              <input type="text" id="cfg-emb-base-url" />
            </div>
            <div class="settings-row">
              <label for="cfg-emb-api-key">API Key</label>
              <div class="input-with-action">
                <input type="password" id="cfg-emb-api-key" />
                <button type="button" id="btn-toggle-emb-key" class="toggle-visibility">👁</button>
              </div>
            </div>
          </div>
        </div>
        <div class="settings-tab-content" data-settings-tab="sprite">
          <div class="settings-group">
            <div class="settings-row">
              <label for="cfg-theme">界面主题</label>
              <div class="radio-group">
                <label><input type="radio" name="theme-mode" value="light" checked /> 浅色</label>
                <label><input type="radio" name="theme-mode" value="dark" /> 深色</label>
              </div>
            </div>
            <div class="settings-row">
              <label for="cfg-silent">静默模式</label>
              <input type="checkbox" id="cfg-silent" />
            </div>
            <div class="settings-row">
              <label for="cfg-threshold">主动提示阈值（事件数）</label>
              <input type="number" id="cfg-threshold" min="1" value="3" />
            </div>
            <div class="settings-row">
              <label for="cfg-cooldown">主动提示冷却（分钟）</label>
              <input type="number" id="cfg-cooldown" min="1" value="5" />
            </div>
            <div class="settings-row">
              <label for="cfg-interval">定时触发间隔（分钟）</label>
              <input type="number" id="cfg-interval" min="1" value="60" />
            </div>
          </div>
          <div class="settings-group">
            <div class="settings-row">
              <label for="cfg-watcher-enabled">启用文件监听</label>
              <input type="checkbox" id="cfg-watcher-enabled" />
            </div>
            <div class="settings-row">
              <label for="cfg-watcher-paths">监听路径</label>
              <input type="text" id="cfg-watcher-paths" value="." />
            </div>
            <div class="settings-row">
              <label for="cfg-watcher-debounce">防抖时间（毫秒）</label>
              <input type="number" id="cfg-watcher-debounce" min="100" value="1000" />
            </div>
          </div>
          <div class="settings-group">
            <div class="settings-row">
              <label for="cfg-persona-mode">匹配模式</label>
              <div class="radio-group">
                <label><input type="radio" name="persona-mode" value="auto" checked /> 自动</label>
                <label><input type="radio" name="persona-mode" value="manual" /> 手动</label>
              </div>
            </div>
            <div class="settings-row">
              <label for="cfg-default-persona">默认角色</label>
              <input type="text" id="cfg-default-persona" />
            </div>
          </div>
        </div>
        <div class="settings-tab-content" data-settings-tab="project">
          <div class="settings-group">
            <div class="settings-row">
              <label for="cfg-project-mode">模式</label>
              <div class="radio-group">
                <label><input type="radio" name="project-mode" value="smart" checked /> 智能</label>
                <label><input type="radio" name="project-mode" value="focus" /> 专注</label>
              </div>
            </div>
            <div class="settings-row">
              <label for="cfg-focus-project">专注项目</label>
              <select id="cfg-focus-project" disabled>
                <option value="">-- 选择项目 --</option>
              </select>
            </div>
          </div>
        </div>
        <div class="settings-actions">
          <button id="btn-settings-cancel">取消</button>
          <button id="btn-settings-save">保存</button>
        </div>
      </div>
    </main>
  </div>
  <div id="memory-detail-modal" class="modal hidden">
    <div class="modal-content">
      <div class="modal-header">
        <h3 id="memory-detail-name"></h3>
        <button class="modal-close" data-modal="memory-detail-modal">✕</button>
      </div>
      <div class="modal-body">
        <div class="memory-meta">
          <span>来源: <code id="memory-detail-source"></code></span>
          <span id="memory-detail-score"></span>
          <span id="memory-detail-created"></span>
          <span id="memory-detail-accessed"></span>
        </div>
        <pre id="memory-detail-content"></pre>
      </div>
      <div class="modal-footer">
        <button id="btn-memory-delete" class="btn-danger">删除</button>
        <button class="btn-secondary" data-modal="memory-detail-modal">关闭</button>
      </div>
    </div>
  </div>
  <div id="memory-add-modal" class="modal hidden">
    <div class="modal-content">
      <div class="modal-header">
        <h3>添加记忆</h3>
        <button class="modal-close" data-modal="memory-add-modal">✕</button>
      </div>
      <div class="modal-body">
        <input type="text" id="memory-add-source" />
        <input type="text" id="memory-add-name" />
        <textarea id="memory-add-content" rows="6"></textarea>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" data-modal="memory-add-modal">取消</button>
        <button id="btn-memory-add-confirm" class="btn-primary">添加</button>
      </div>
    </div>
  </div>
  <div id="confirm-modal" class="modal hidden">
    <div class="modal-content">
      <div class="modal-header">
        <h3 id="confirm-title">确认</h3>
        <button class="modal-close" data-modal="confirm-modal">✕</button>
      </div>
      <div class="modal-body"><p id="confirm-message"></p></div>
      <div class="modal-footer">
        <button id="btn-confirm-cancel" class="btn-secondary">取消</button>
        <button id="btn-confirm-ok" class="btn-primary">确定</button>
      </div>
    </div>
  </div>
  <div id="onboarding-modal" class="modal hidden">
    <div class="modal-content">
      <div class="modal-header">
        <h3>🧚 欢迎</h3>
        <button class="modal-close" data-modal="onboarding-modal">✕</button>
      </div>
      <div class="modal-footer">
        <button id="btn-onboarding-ok" class="btn-primary">开始使用</button>
      </div>
    </div>
  </div>
  <div id="toast-container" aria-live="polite"></div>
  <div id="badge"></div>
</body></html>`;

/** 创建 mock electronAPI 的辅助函数 */
function createMockElectronAPI() {
  return {
    sendUserInput: vi.fn(),
    abortChat: vi.fn().mockResolvedValue({ aborted: true }),
    loadSession: vi.fn().mockResolvedValue({ messages: [] }),
    onStreamStart: vi.fn(),
    onStreamChunk: vi.fn(),
    onStreamEnd: vi.fn(),
    removeStreamListeners: vi.fn(),
    onSpriteOutput: vi.fn(),
    removeSpriteOutputListener: vi.fn(),
    onSpriteEvent: vi.fn(),
    removeSpriteEventListener: vi.fn(),
    onSpriteError: vi.fn(),
    removeSpriteErrorListener: vi.fn(),
    onAppError: vi.fn(),
    removeAppErrorListener: vi.fn(),
    getAgentStatus: vi.fn().mockResolvedValue({ ready: true }),
    getLlmConfig: vi.fn().mockResolvedValue({ configured: false, config: null, embedding: null, presets: {} }),
    saveLlmConfig: vi.fn().mockResolvedValue({ success: true }),
    testLlmConfig: vi.fn().mockResolvedValue({ success: true, error: null }),
    onAgentReady: vi.fn(),
    removeAgentReadyListener: vi.fn(),
    listMemories: vi.fn().mockResolvedValue({ memories: [] }),
    searchMemories: vi.fn().mockResolvedValue({ hits: [] }),
    showMemory: vi.fn().mockResolvedValue({ memory: null }),
    deleteMemory: vi.fn().mockResolvedValue({ deleted: true }),
    addMemory: vi.fn().mockResolvedValue({}),
    getConfig: vi.fn().mockResolvedValue({ config: {} }),
    updateConfig: vi.fn().mockResolvedValue({}),
    listPersonas: vi.fn().mockResolvedValue({ personas: [] }),
    switchPersona: vi.fn().mockResolvedValue({ switched: true, name: 'test' }),
    setPersonaMode: vi.fn().mockResolvedValue({ set: true }),
    getPersonaMode: vi.fn().mockResolvedValue({ mode: 'auto' }),
    listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    newSession: vi.fn().mockResolvedValue({ success: true, sessionName: 'test' }),
    getDashboard: vi.fn().mockResolvedValue({
      pendingNotices: 0,
      proactiveThreshold: 3,
      registeredTriggers: [],
      suggestions: [],
    }),
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn(),
    onWindowStateChanged: vi.fn(),
    removeWindowStateChangedListener: vi.fn(),
    onFloatDragStart: vi.fn(),
    onFloatDragEnd: vi.fn(),
    onFloatUnread: vi.fn(),
    removeFloatUnreadListener: vi.fn(),
    removeFloatDragStartListener: vi.fn(),
    removeFloatDragEndListener: vi.fn(),
    moveFloatWindow: vi.fn(),
    saveFloatPosition: vi.fn(),
    expandToFull: vi.fn(),
    showFloatContextMenu: vi.fn(),
    proactivePromptShown: vi.fn(),
  };
}

// ─── 全局设置 ─────────────────────────────────────────────

let dom: JSDOM;
let uiManager: UIManager;

beforeEach(() => {
  dom = new JSDOM(TEST_HTML, { url: 'http://localhost' });
  // 注入必要的全局对象
  dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
  // 注入 mock electronAPI
  (dom.window as unknown as Record<string, unknown>).electronAPI = createMockElectronAPI();
  // 设置全局 document 和 window
  global.document = dom.window.document;
  global.window = dom.window as unknown as Window & typeof globalThis;
  global.HTMLElement = dom.window.HTMLElement;
  global.HTMLInputElement = dom.window.HTMLInputElement;
  global.HTMLButtonElement = dom.window.HTMLButtonElement;
  global.HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
  global.HTMLSelectElement = dom.window.HTMLSelectElement;
  global.HTMLSpanElement = dom.window.HTMLSpanElement;
  global.HTMLPreElement = dom.window.HTMLPreElement;
  global.HTMLDivElement = dom.window.HTMLDivElement;
  // 注入 navigator.clipboard
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: {
      writeText: vi.fn().mockResolvedValue(undefined),
    },
    writable: true,
    configurable: true,
  });

  uiManager = new UIManager();
});

afterEach(() => {
  uiManager.cleanup();
  dom.window.close();
});

// ─── 消息渲染 ─────────────────────────────────────────────

describe('消息渲染', () => {
  it('appendMessage: 用户消息包含头像和气泡', () => {
    const el = uiManager.appendMessage({
      role: 'user',
      content: '你好',
    });

    expect(el.className).toContain('user');
    const avatar = el.querySelector('.message-avatar');
    expect(avatar).not.toBeNull();
    expect(avatar?.textContent).toBe('🧑');
    const bubble = el.querySelector('.message-bubble');
    expect(bubble?.textContent).toBe('你好');
  });

  it('appendMessage: 精灵消息渲染 Markdown', () => {
    const el = uiManager.appendMessage({
      role: 'assistant',
      content: '**粗体** 和 _斜体_',
    });

    expect(el.className).toContain('assistant');
    const avatar = el.querySelector('.message-avatar');
    expect(avatar?.textContent).toBe('🧚');
    const bubble = el.querySelector('.message-bubble');
    // 精灵消息应渲染 Markdown（包含 strong 标签，可能带 class 属性）
    expect(bubble?.innerHTML).toContain('<strong');
  });

  it('appendMessage: 系统消息居中无头像', () => {
    const el = uiManager.appendMessage({
      role: 'system',
      content: '系统通知',
    });

    expect(el.className).toContain('system');
    expect(el.querySelector('.message-avatar')).toBeNull();
    expect(el.textContent).toBe('系统通知');
  });

  it('appendMessage: 流式消息带 streaming 类和光标', () => {
    const el = uiManager.appendMessage({
      role: 'assistant',
      content: '流式...',
      streaming: true,
      messageId: 'msg-1',
    });

    expect(el.className).toContain('streaming');
    expect(el.querySelector('.cursor')).not.toBeNull();
  });

  it('appendMessage: 第一次添加消息时隐藏空状态', () => {
    const emptyState = document.getElementById('chat-empty-state');
    expect(emptyState?.classList.contains('hidden')).toBe(false);

    uiManager.appendMessage({ role: 'user', content: 'hi' });

    expect(emptyState?.classList.contains('hidden')).toBe(true);
  });

  it('appendMessage: 精灵消息带召回记忆提示', () => {
    // MS-12：memoryRecall 改为数组，支持多条召回记忆展示
    const el = uiManager.appendMessage({
      role: 'assistant',
      content: '回答',
      memoryRecall: [{ name: '用户偏好', score: 0.85, source: 'profile' }],
    });

    // 多条召回记忆渲染在 container 内，每条独立可点击
    const container = el.querySelector('.memory-recall-container');
    expect(container).not.toBeNull();
    const recall = el.querySelector('.memory-recall');
    expect(recall).not.toBeNull();
    expect(recall?.textContent).toContain('用户偏好');
    expect(recall?.textContent).toContain('0.85');
  });

  it('appendMessage: 消息包含时间戳', () => {
    const el = uiManager.appendMessage({
      role: 'user',
      content: 'hello',
      timestamp: '2026-06-19T10:30:00.000Z',
    });

    const timeEl = el.querySelector('.message-time');
    expect(timeEl).not.toBeNull();
    // 时间戳格式化为 HH:MM
    expect(timeEl?.textContent).toMatch(/\d\d:\d\d/);
  });

  it('appendMessage: 精灵消息（非流式）有复制按钮', () => {
    const el = uiManager.appendMessage({
      role: 'assistant',
      content: '完整回复',
      streaming: false,
    });

    const copyBtn = el.querySelector('.message-copy-btn');
    expect(copyBtn).not.toBeNull();
    expect(copyBtn?.textContent).toBe('📋');
  });
});

// ─── 流式消息管理 ─────────────────────────────────────────

describe('流式消息管理', () => {
  it('startStreaming: 创建流式消息并设置状态', () => {
    uiManager.startStreaming('msg-stream-1');

    expect(uiManager.isStreaming()).toBe(true);
    const messagesEl = document.getElementById('messages')!;
    const streamingEl = messagesEl.querySelector('.message.assistant.streaming');
    expect(streamingEl).not.toBeNull();
  });

  it('updateStreamingMessage: 更新累积文本', async () => {
    uiManager.startStreaming('msg-stream-2');
    uiManager.updateStreamingMessage('msg-stream-2', 'Hello World');

    // UX-PP-02 rAF 节流：渲染在下一帧执行，需等待 rAF 回调
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const bubble = document.querySelector('.message.assistant.streaming .message-bubble');
    // 渲染后应包含 Markdown 解析后的内容
    expect(bubble?.textContent).toContain('Hello World');
  });

  it('finishStreamingMessage: 移除 streaming 类和光标', () => {
    uiManager.startStreaming('msg-stream-3');
    uiManager.finishStreamingMessage('msg-stream-3');

    const el = document.querySelector('.message.assistant');
    expect(el?.classList.contains('streaming')).toBe(false);
    expect(el?.querySelector('.cursor')).toBeNull();
  });

  it('stopAllStreaming: 清理所有流式消息', () => {
    uiManager.startStreaming('msg-a');
    uiManager.startStreaming('msg-b');
    uiManager.stopAllStreaming();

    expect(uiManager.isStreaming()).toBe(false);
    const cursors = document.querySelectorAll('.cursor');
    expect(cursors.length).toBe(0);
  });

  it('clearMessages: 清空所有消息并恢复空状态', () => {
    uiManager.appendMessage({ role: 'user', content: 'hi' });
    uiManager.clearMessages();

    const messagesEl = document.getElementById('messages')!;
    expect(messagesEl.children.length).toBe(1); // 仅剩空状态引导
    expect(document.getElementById('chat-empty-state')?.classList.contains('hidden')).toBe(false);
  });
});

// ─── UX-P1-02 工具调用卡片 ─────────────────────────────────

describe('工具调用卡片（UX-P1-02）', () => {
  it('showToolStart: 在流式消息气泡内渲染工具调用卡片', () => {
    uiManager.startStreaming('msg-tool-1');
    uiManager.showToolStart('msg-tool-1', 'read_file', '{"path":"test.txt"}');

    const toolCard = document.querySelector('.tool-call.tool-call-running');
    expect(toolCard).not.toBeNull();
    expect(toolCard?.getAttribute('data-tool-name')).toBe('read_file');

    // 验证卡片包含工具名和状态
    expect(toolCard?.querySelector('.tool-call-name')?.textContent).toBe('read_file');
    expect(toolCard?.querySelector('.tool-call-status')?.textContent).toContain('执行中');
    expect(toolCard?.querySelector('.tool-call-args')?.textContent).toContain('test.txt');
  });

  it('showToolStart: 无参数时不渲染 .tool-call-args', () => {
    uiManager.startStreaming('msg-tool-2');
    uiManager.showToolStart('msg-tool-2', 'list_dir');

    const toolCard = document.querySelector('.tool-call.tool-call-running');
    expect(toolCard).not.toBeNull();
    expect(toolCard?.querySelector('.tool-call-args')).toBeNull();
  });

  it('updateToolResult: 成功时更新卡片状态为 success', () => {
    uiManager.startStreaming('msg-tool-3');
    uiManager.showToolStart('msg-tool-3', 'search_memories', '{"query":"test"}');
    uiManager.updateToolResult('msg-tool-3', 'search_memories', true, '找到 3 条记忆');

    const toolCard = document.querySelector('.tool-call');
    expect(toolCard?.classList.contains('tool-call-running')).toBe(false);
    expect(toolCard?.classList.contains('tool-call-success')).toBe(true);
    expect(toolCard?.querySelector('.tool-call-status')?.textContent).toContain('成功');
    expect(toolCard?.querySelector('.tool-call-result')?.textContent).toContain('找到 3 条记忆');
  });

  it('updateToolResult: 失败时更新卡片状态为 failed', () => {
    uiManager.startStreaming('msg-tool-4');
    uiManager.showToolStart('msg-tool-4', 'write_file', '{"path":"test.txt"}');
    uiManager.updateToolResult('msg-tool-4', 'write_file', false, '权限不足');

    const toolCard = document.querySelector('.tool-call');
    expect(toolCard?.classList.contains('tool-call-failed')).toBe(true);
    expect(toolCard?.querySelector('.tool-call-status')?.textContent).toContain('失败');
  });

  it('updateToolResult: 无摘要时不渲染 .tool-call-result', () => {
    uiManager.startStreaming('msg-tool-5');
    uiManager.showToolStart('msg-tool-5', 'read_file');
    uiManager.updateToolResult('msg-tool-5', 'read_file', true);

    const toolCard = document.querySelector('.tool-call');
    expect(toolCard?.querySelector('.tool-call-result')).toBeNull();
  });

  it('updateStreamingMessage: 保留工具调用卡片不丢失', () => {
    uiManager.startStreaming('msg-tool-6');
    uiManager.showToolStart('msg-tool-6', 'read_file', '{"path":"a.txt"}');
    // 流式更新文本时，工具卡片应保留
    uiManager.updateStreamingMessage('msg-tool-6', '读取完成');

    const toolCard = document.querySelector('.tool-call');
    expect(toolCard).not.toBeNull();
    expect(toolCard?.getAttribute('data-tool-name')).toBe('read_file');
  });
});

// ─── UX-P2-01 思考阶段指示器 ───────────────────────────────

describe('思考阶段指示器（UX-P2-01）', () => {
  it('showThinkingPhase: 在气泡内渲染思考阶段指示器', () => {
    uiManager.startStreaming('msg-think-1');
    uiManager.showThinkingPhase('msg-think-1', 'recalling');

    const indicator = document.querySelector('.thinking-phase');
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain('正在回忆');
  });

  it('showThinkingPhase: 不同阶段显示不同文案', () => {
    uiManager.startStreaming('msg-think-2');

    uiManager.showThinkingPhase('msg-think-2', 'processing');
    expect(document.querySelector('.thinking-phase')?.textContent).toContain('正在处理');

    uiManager.showThinkingPhase('msg-think-2', 'archiving');
    expect(document.querySelector('.thinking-phase')?.textContent).toContain('正在归档');
  });

  it('showThinkingPhase: 未知阶段使用原始字符串', () => {
    uiManager.startStreaming('msg-think-3');
    uiManager.showThinkingPhase('msg-think-3', 'custom-phase');

    expect(document.querySelector('.thinking-phase')?.textContent).toContain('custom-phase');
  });

  it('updateStreamingMessage: text chunk 到达后移除思考阶段指示器', () => {
    uiManager.startStreaming('msg-think-4');
    uiManager.showThinkingPhase('msg-think-4', 'recalling');
    expect(document.querySelector('.thinking-phase')).not.toBeNull();

    // 首个 text chunk 到达，指示器应被移除
    uiManager.updateStreamingMessage('msg-think-4', '回复内容');
    expect(document.querySelector('.thinking-phase')).toBeNull();
  });
});

// ─── UX-P2-03 Agent 就绪状态 ───────────────────────────────

describe('Agent 就绪状态（UX-P2-03）', () => {
  it('初始状态 isAgentReady 为 false', () => {
    expect(uiManager.getState().isAgentReady).toBe(false);
  });

  it('setAgentReady(true): 解除发送限制', () => {
    uiManager.setAgentReady(true);
    const cb = vi.fn();
    uiManager.onSendMessage(cb);

    const btnSend = document.getElementById('btn-send')!;
    btnSend.click();

    expect(cb).toHaveBeenCalled();
  });

  it('未就绪时点击发送显示 warning toast', () => {
    uiManager.setAgentReady(false);
    const cb = vi.fn();
    uiManager.onSendMessage(cb);

    const btnSend = document.getElementById('btn-send')!;
    btnSend.click();

    expect(cb).not.toHaveBeenCalled();
    // toast 容器应有 warning 类
    const toast = document.querySelector('.toast');
    expect(toast).not.toBeNull();
  });
});

// ─── UX-P2-02 流式状态发送拦截 ─────────────────────────────

describe('流式状态发送拦截（UX-P2-02）', () => {
  it('流式输出中按 Enter 触发停止而非发送', () => {
    uiManager.setAgentReady(true);
    uiManager.startStreaming('msg-block-1');

    const sendCb = vi.fn();
    const stopCb = vi.fn();
    uiManager.onSendMessage(sendCb);
    uiManager.onStopMessage(stopCb);

    // 合并按钮逻辑：流式态时 Enter 触发停止，不触发发送
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(sendCb).not.toHaveBeenCalled();
    expect(stopCb).toHaveBeenCalled();
  });
});

// ─── 面板切换 ─────────────────────────────────────────────

describe('面板切换', () => {
  it('switchPanel: 切换到记忆面板', () => {
    uiManager.switchPanel('memories');

    expect(uiManager.getCurrentPanel()).toBe('memories');
    const panel = document.getElementById('panel-memories');
    expect(panel?.classList.contains('active')).toBe(true);
  });

  it('switchPanel: 导航按钮高亮同步', () => {
    uiManager.switchPanel('settings');

    const activeBtn = document.querySelector('.nav-btn.active');
    expect(activeBtn?.getAttribute('data-panel')).toBe('settings');
  });

  it('switchPanel: 切换后原面板失活', () => {
    uiManager.switchPanel('memories');
    uiManager.switchPanel('chat');

    const memoriesPanel = document.getElementById('panel-memories');
    expect(memoriesPanel?.classList.contains('active')).toBe(false);
    const chatPanel = document.getElementById('panel-chat');
    expect(chatPanel?.classList.contains('active')).toBe(true);
  });
});

// ─── 表单收集 ─────────────────────────────────────────────

describe('表单收集', () => {
  it('collectConfigFromForm: 收集精灵配置', () => {
    // 填充表单值
    const silentEl = document.getElementById('cfg-silent') as HTMLInputElement;
    const thresholdEl = document.getElementById('cfg-threshold') as HTMLInputElement;
    const cooldownEl = document.getElementById('cfg-cooldown') as HTMLInputElement;
    const intervalEl = document.getElementById('cfg-interval') as HTMLInputElement;

    silentEl.checked = true;
    thresholdEl.value = '5';
    cooldownEl.value = '10';
    intervalEl.value = '30';

    const config = uiManager.collectConfigFromForm();

    expect(config.silentMode).toBe(true);
    expect(config.proactiveThreshold).toBe(5);
    expect(config.proactiveCooldownMs).toBe(10 * 60_000);
    expect(config.triggerIntervalMs).toBe(30 * 60_000);
  });

  it('collectConfigFromForm: 收集项目模式', () => {
    const focusRadio = document.querySelector<HTMLInputElement>(
      'input[name="project-mode"][value="focus"]',
    );
    if (focusRadio) focusRadio.checked = true;

    const config = uiManager.collectConfigFromForm();

    expect(config.projectMode).toBe('focus');
  });

  it('collectLlmConfigFromForm: 收集 LLM 配置', () => {
    const providerEl = document.getElementById('cfg-llm-provider') as HTMLInputElement;
    const modelEl = document.getElementById('cfg-llm-model') as HTMLInputElement;
    const apiKeyEl = document.getElementById('cfg-llm-api-key') as HTMLInputElement;

    providerEl.value = 'openai';
    modelEl.value = 'gpt-4o';
    apiKeyEl.value = 'sk-test123';

    const payload = uiManager.collectLlmConfigFromForm();

    expect(payload.llm.provider).toBe('openai');
    expect(payload.llm.model).toBe('gpt-4o');
    expect(payload.llm.apiKey).toBe('sk-test123');
    expect(payload.embedding).toBeNull(); // 未启用 embedding
  });

  it('getAddMemoryFormData: 收集添加记忆表单', () => {
    const sourceEl = document.getElementById('memory-add-source') as HTMLInputElement;
    const nameEl = document.getElementById('memory-add-name') as HTMLInputElement;
    const contentEl = document.getElementById('memory-add-content') as HTMLTextAreaElement;

    sourceEl.value = 'profile';
    nameEl.value = '测试记忆';
    contentEl.value = '记忆内容';

    const data = uiManager.getAddMemoryFormData();

    expect(data).not.toBeNull();
    expect(data?.source).toBe('profile');
    expect(data?.name).toBe('测试记忆');
    expect(data?.content).toBe('记忆内容');
  });

  it('getAddMemoryFormData: 空字段返回 null', () => {
    const data = uiManager.getAddMemoryFormData();
    expect(data).toBeNull();
  });
});

// ─── 事件回调 ─────────────────────────────────────────────

describe('事件回调注册', () => {
  it('onSendMessage: 注册并触发', () => {
    const cb = vi.fn();
    uiManager.onSendMessage(cb);

    // UX-P2-03 设置 Agent 就绪状态，否则 emitSendMessage 会拦截发送
    uiManager.setAgentReady(true);

    // 模拟点击发送按钮
    const btnSend = document.getElementById('btn-send')!;
    btnSend.click();

    expect(cb).toHaveBeenCalled();
  });

  it('onStopMessage: 注册并通过合并按钮触发', () => {
    const cb = vi.fn();
    uiManager.onStopMessage(cb);

    // 合并按钮：先进入流式态，再点击发送按钮触发停止
    uiManager.setAgentReady(true);
    uiManager.startStreaming('msg-stop-test');
    const btnSend = document.getElementById('btn-send')!;
    btnSend.click();

    expect(cb).toHaveBeenCalled();
  });

  it('onMemorySearch: 注册并触发（带防抖）', async () => {
    const cb = vi.fn();
    uiManager.onMemorySearch(cb);

    const searchEl = document.getElementById('memory-search') as HTMLInputElement;
    searchEl.value = 'test';
    searchEl.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

    // 等待防抖 300ms
    await new Promise((r) => setTimeout(r, 350));
    expect(cb).toHaveBeenCalledWith('test');
  });

  it('onMemoryAdd: 注册并触发', () => {
    const cb = vi.fn();
    uiManager.onMemoryAdd(cb);

    // 填充表单
    const sourceEl = document.getElementById('memory-add-source') as HTMLInputElement;
    const nameEl = document.getElementById('memory-add-name') as HTMLInputElement;
    const contentEl = document.getElementById('memory-add-content') as HTMLTextAreaElement;
    sourceEl.value = 'insight';
    nameEl.value = 'test';
    contentEl.value = 'content';

    const btnConfirm = document.getElementById('btn-memory-add-confirm')!;
    btnConfirm.click();

    expect(cb).toHaveBeenCalledWith({ source: 'insight', name: 'test', content: 'content' });
  });

  it('onNewSession: 注册回调', () => {
    const cb = vi.fn();
    uiManager.onNewSession(cb);

    const btnNewSession = document.getElementById('btn-new-session')!;
    btnNewSession.click();

    expect(cb).toHaveBeenCalled();
  });
});

// ─── Toast 通知 ───────────────────────────────────────────

describe('Toast 通知', () => {
  it('showToast: 创建 toast 元素', () => {
    uiManager.showToast('操作成功', 'success');

    const container = document.getElementById('toast-container')!;
    expect(container.children.length).toBe(1);
    const toast = container.firstChild as HTMLElement;
    expect(toast.className).toContain('success');
    expect(toast.textContent).toContain('操作成功');
  });

  it('showToast: error 类型有关闭按钮', () => {
    uiManager.showToast('错误消息', 'error');

    const toast = document.querySelector('.toast.error');
    const closeBtn = toast?.querySelector('.toast-close');
    expect(closeBtn).not.toBeNull();
  });

  it('showToast: 超出 5 条时移除最早的', () => {
    for (let i = 0; i < 6; i++) {
      uiManager.showToast(`消息 ${i}`, 'info');
    }

    const container = document.getElementById('toast-container')!;
    expect(container.children.length).toBe(5);
    expect(container.firstChild?.textContent).toContain('消息 1'); // 最早的消息 0 被移除
  });
});

// ─── 未读计数 ─────────────────────────────────────────────

describe('未读计数', () => {
  it('setUnreadCount: 设置正数时显示徽章', () => {
    const badge = document.getElementById('badge')!;

    uiManager.setUnreadCount(5);

    expect(badge.textContent).toBe('5');
    expect(badge.classList.contains('visible')).toBe(true);
  });

  it('setUnreadCount: 超过 99 显示 99+', () => {
    uiManager.setUnreadCount(100);

    const badge = document.getElementById('badge')!;
    expect(badge.textContent).toBe('99+');
  });

  it('clearUnreadCount: 清零并隐藏徽章', () => {
    uiManager.setUnreadCount(5);
    uiManager.clearUnreadCount();

    const badge = document.getElementById('badge')!;
    expect(badge.classList.contains('visible')).toBe(false);
    expect(uiManager.getState().unreadCount).toBe(0);
  });
});

// ─── 空状态 ───────────────────────────────────────────────

describe('空状态管理', () => {
  it('showEmptyState: 显示空状态', () => {
    uiManager.showEmptyState();

    const emptyState = document.getElementById('chat-empty-state');
    expect(emptyState?.classList.contains('hidden')).toBe(false);
  });

  it('hideEmptyState: 隐藏空状态', () => {
    uiManager.hideEmptyState();

    const emptyState = document.getElementById('chat-empty-state');
    expect(emptyState?.classList.contains('hidden')).toBe(true);
  });
});

// ─── 确认弹窗 ─────────────────────────────────────────────

describe('确认弹窗', () => {
  it('showConfirmDialog: 点击确认返回 true', async () => {
    const promise = uiManager.showConfirmDialog({
      title: '测试',
      message: '确认删除？',
      confirmText: '删除',
      danger: true,
    });

    // 点击确认按钮
    const btnOk = document.getElementById('btn-confirm-ok')!;
    btnOk.click();

    const result = await promise;
    expect(result).toBe(true);
  });

  it('showConfirmDialog: 点击取消返回 false', async () => {
    const promise = uiManager.showConfirmDialog({
      message: '确认？',
    });

    const btnCancel = document.getElementById('btn-confirm-cancel')!;
    btnCancel.click();

    const result = await promise;
    expect(result).toBe(false);
  });
});

// ─── 输入处理 ─────────────────────────────────────────────

describe('输入处理', () => {
  it('getUserInput: 返回用户输入并清空输入框', () => {
    const inputEl = document.getElementById('input') as HTMLTextAreaElement;
    inputEl.value = '测试消息';

    const text = uiManager.getUserInput();

    expect(text).toBe('测试消息');
    expect(inputEl.value).toBe(''); // 输入框已清空
  });

  it('getUserInput: 空白输入返回 null', () => {
    const inputEl = document.getElementById('input') as HTMLTextAreaElement;
    inputEl.value = '   ';

    const text = uiManager.getUserInput();

    expect(text).toBeNull();
  });
});

// ─── 角色面板 ─────────────────────────────────────────────

describe('角色面板', () => {
  it('renderPersonaDropdown: 渲染角色列表', () => {
    uiManager.renderPersonaDropdown([
      { name: '代码助手', description: '编程助手', active: true },
      { name: '写作助理', description: '写作帮助', active: false },
    ]);

    const dropdown = document.getElementById('persona-dropdown')!;
    expect(dropdown.children.length).toBe(2);
    const activeItem = dropdown.querySelector('.dropdown-item.active');
    // UX-04：角色项现在包含名称 + 描述，textContent 包含两者
    expect(activeItem?.textContent).toContain('代码助手');
    expect(activeItem?.textContent).toContain('编程助手');
    // 验证名称和描述分别在各自的子元素中
    const nameEl = activeItem?.querySelector('.dropdown-item-name');
    const descEl = activeItem?.querySelector('.dropdown-item-desc');
    expect(nameEl?.textContent).toBe('代码助手');
    expect(descEl?.textContent).toBe('编程助手');
  });

  it('updateActivePersona: 更新当前角色名', () => {
    uiManager.updateActivePersona('代码助手');

    const nameEl = document.getElementById('persona-name')!;
    expect(nameEl.textContent).toBe('代码助手');
  });
});

// ─── 记忆面板 ─────────────────────────────────────────────

describe('记忆面板', () => {
  it('renderMemoryList: 渲染记忆列表', () => {
    const memories: MemoryListItem[] = [
      { id: '1', name: '记忆1', source: 'profile', score: 0.9, contentPreview: '预览1' },
      { id: '2', name: '记忆2', source: 'insight', score: 0.7, contentPreview: '预览2' },
    ];

    uiManager.renderMemoryList(memories);

    const list = document.getElementById('memory-list')!;
    expect(list.children.length).toBe(2);
    expect(list.querySelector('.source-tag')?.textContent).toBe('profile');
  });

  it('renderMemoryList: 空列表显示空状态', () => {
    uiManager.renderMemoryList([]);

    const list = document.getElementById('memory-list')!;
    const empty = list.querySelector('.empty-state');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('暂无记忆');
  });

  it('showMemoryDetail: 显示记忆详情弹窗', () => {
    const detail: MemoryDetail = {
      id: '1',
      name: '测试记忆',
      source: 'profile',
      score: 0.95,
      content: '详细内容',
      createdAt: '2026-01-01',
      accessedAt: '2026-06-19',
    };

    uiManager.showMemoryDetail(detail);

    const nameEl = document.getElementById('memory-detail-name')!;
    expect(nameEl.textContent).toBe('测试记忆');
    const contentEl = document.getElementById('memory-detail-content')!;
    expect(contentEl.textContent).toBe('详细内容');
    const modal = document.getElementById('memory-detail-modal')!;
    expect(modal.classList.contains('hidden')).toBe(false);
  });
});

describe('标题栏窗口控制按钮', () => {
  it('点击最小化调用 window.electronAPI.windowMinimize', () => {
    const btn = document.getElementById('btn-minimize')!;
    btn.click();
    expect(window.electronAPI.windowMinimize).toHaveBeenCalled();
  });

  it('点击最大化调用 window.electronAPI.windowMaximize', () => {
    const btn = document.getElementById('btn-maximize')!;
    btn.click();
    expect(window.electronAPI.windowMaximize).toHaveBeenCalled();
  });

  it('点击关闭调用 window.electronAPI.windowClose（隐藏到浮动窗口）', () => {
    const btn = document.getElementById('btn-close')!;
    btn.click();
    expect(window.electronAPI.windowClose).toHaveBeenCalled();
  });
});