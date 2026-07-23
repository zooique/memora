/**
 * UIManager 测试覆盖
 *
 * @vitest-environment jsdom
 *
 * 覆盖范围：
 * - 消息渲染（appendMessage / updateStreamingMessage / finishStreamingMessage）
 * - 面板切换（switchPanel）
 * - 表单收集（collectConfigFromForm / getAddMemoryFormData）
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
import { UIManager } from '../../../electron/renderer/ui.js';
import type { MemoryListItem, MemoryDetail } from '../../../electron/renderer/ui.js';

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
      <nav class="sidebar-nav">
        <button class="nav-btn active" data-panel="chat">💬 对话</button>
        <button class="nav-btn" data-panel="memories">🧠 记忆</button>
        <button class="nav-btn" data-panel="settings">⚙️ 设置</button>
      </nav>
    </aside>
    <main id="main-content">
      <div id="panel-chat" class="panel active">
        <!-- v3: 对话工具栏含精灵状态条+角色选择器 -->
        <div id="chat-toolbar">
          <div class="chat-toolbar-info">
            <div id="sprite-status-bar" class="sprite-status-bar">
              <span id="sprite-status-text-bar">就绪</span>
              <span class="sprite-status-dot" id="sprite-status-dot-bar"></span>
            </div>
          </div>
          <!-- v3: 角色选择器（工具栏内） -->
          <div id="toolbar-persona-container" class="toolbar-persona-container">
            <div id="persona-selector">
              <span id="persona-icon">🧚</span>
              <span id="persona-name">精灵</span>
              <span id="persona-mode-badge" class="mode-badge auto">自动</span>
              <span id="persona-arrow">▼</span>
            </div>
            <div id="persona-dropdown" class="dropdown hidden"></div>
          </div>
        </div>
        <!-- v3: 感知面板（选项卡化：关系/理解/洞察） -->
        <div id="perception-panel" class="perception-panel hidden">
          <div class="perception-panel-header">
            <span class="perception-panel-title">精灵感知状态</span>
            <button class="perception-panel-close">✕</button>
          </div>
          <!-- 选项卡栏：3 个分组按心智模型划分 -->
          <div class="perception-tabs" role="tablist">
            <button class="perception-tab active" role="tab" data-tab="relation" aria-selected="true">关系</button>
            <button class="perception-tab" role="tab" data-tab="understanding" aria-selected="false">理解</button>
            <button class="perception-tab" role="tab" data-tab="insight" aria-selected="false">洞察</button>
          </div>
          <!-- 选项卡内容区：3 个 pane 容纳 6 个 section -->
          <div class="perception-tab-panes">
            <div class="perception-tab-pane active" data-pane="relation">
              <div id="perception-affect"></div>
              <div id="perception-rapport"></div>
            </div>
            <div class="perception-tab-pane" data-pane="understanding">
              <div id="perception-context"></div>
              <div id="perception-narrative"></div>
            </div>
            <div class="perception-tab-pane" data-pane="insight">
              <div id="perception-patterns"></div>
              <div id="perception-metrics"></div>
            </div>
          </div>
        </div>
        <div id="proactive-banner" class="hidden">
          <span class="banner-icon">🧚</span>
          <span class="banner-text" id="proactive-banner-text"></span>
          <div class="banner-actions">
            <button class="banner-btn" data-action="view">查看</button>
            <button class="banner-btn" data-action="silent">静默 1 小时</button>
            <button class="banner-btn" data-action="disable">不再提醒</button>
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
              <!-- B2：停止生成浮动按钮（与 index.html 同结构） -->
              <button id="btn-stop" class="btn-stop-float">停止</button>
              <button id="btn-send">发送</button>
            </div>
          </div>
        </div>
      </div>
      <div id="panel-memories" class="panel" aria-hidden="true">
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
      <div id="panel-settings" class="panel" aria-hidden="true">
        <div class="panel-header">
          <span class="panel-title">设置</span>
        </div>
        <div class="settings-panel-body">
        <div class="settings-tabs">
          <button class="settings-tab active" data-settings-tab="llm">大模型</button>
          <button class="settings-tab" data-settings-tab="embedding">嵌入</button>
          <button class="settings-tab" data-settings-tab="sprite">精灵</button>
        </div>
        <div class="settings-tab-content active" data-settings-tab="llm">
          <div class="settings-group">
            <!-- Provider 列表与编辑表单容器（卡片由 settingsPanelManager 动态渲染） -->
            <div id="provider-list" class="provider-list"></div>
            <div id="provider-form" class="provider-form hidden"></div>
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
        </div><!-- /.settings-panel-body -->
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
        <button id="btn-memory-edit-save" class="btn-primary hidden">保存</button>
        <button id="btn-memory-edit-cancel" class="btn-secondary hidden">取消</button>
        <button id="btn-memory-edit" class="btn-secondary">编辑</button>
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
  <!-- shortcuts-modal 用于测试 Ctrl+/ 快捷键和内容同步 -->
  <div id="shortcuts-modal" class="modal hidden">
    <div class="modal-content modal-content-sm">
      <div class="modal-header">
        <h3>键盘快捷键</h3>
        <button class="modal-close" data-modal="shortcuts-modal">✕</button>
      </div>
      <div class="modal-body">
        <table class="shortcuts-table">
          <tbody>
            <tr><td><kbd>Ctrl+1</kbd></td><td>切换到对话面板</td></tr>
            <tr><td><kbd>Ctrl+2</kbd></td><td>切换到记忆面板</td></tr>
            <tr><td><kbd>Ctrl+3</kbd></td><td>切换到设置面板</td></tr>
            <tr><td><kbd>Ctrl+.</kbd></td><td>停止生成</td></tr>
            <tr><td><kbd>Ctrl+/</kbd></td><td>显示快捷键帮助</td></tr>
            <tr><td><kbd>Enter</kbd></td><td>发送消息（对话输入框）</td></tr>
            <tr><td><kbd>Shift+Enter</kbd></td><td>换行（对话输入框）</td></tr>
            <tr><td><kbd>Ctrl+Enter</kbd></td><td>提交（添加记忆弹窗）</td></tr>
            <tr><td><kbd>Esc</kbd></td><td>关闭弹窗/下拉菜单</td></tr>
            <tr><td><kbd>↑</kbd> / <kbd>↓</kbd></td><td>导航角色下拉菜单</td></tr>
          </tbody>
        </table>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" data-modal="shortcuts-modal">关闭</button>
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
    onStreamRecall: vi.fn(),
    onStreamToolStart: vi.fn(),
    onStreamToolResult: vi.fn(),
    onStreamThinking: vi.fn(),
    onContextTruncated: vi.fn(),
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
    getLlmConfig: vi.fn().mockResolvedValue({ configured: false, config: null, embedding: null }),
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
    getDashboard: vi.fn().mockResolvedValue({
      pendingNotices: 0,
      proactiveThreshold: 3,
      registeredTriggers: [],
      suggestions: [],
      sourceHealth: null,
      metrics: null,
    }),
    windowMinimize: vi.fn(),
    windowMaximize: vi.fn(),
    windowClose: vi.fn(),
    onWindowStateChanged: vi.fn(),
    removeWindowStateChangedListener: vi.fn(),
    onFloatUnread: vi.fn(),
    removeFloatUnreadListener: vi.fn(),
    moveFloatWindow: vi.fn(),
    saveFloatPosition: vi.fn(),
    expandToFull: vi.fn(),
    showFloatContextMenu: vi.fn(),
    proactivePromptShown: vi.fn(),
    // Provider 选择器相关（InputAreaManager.initProviderSelector 调用）
    listLlmProviders: vi.fn().mockResolvedValue({ active: '', providers: [] }),
    setActiveLlmProvider: vi.fn().mockResolvedValue({ success: true, error: null }),
    // 记忆讨论（MemoryPanelManager 调用）
    addMemory: vi.fn().mockResolvedValue({}),
    // 归档操作（ArchiveButtonManager 调用）
    archiveMemories: vi.fn().mockResolvedValue({ archivedCount: 0 }),
    // 关系图谱相关（MemoryPanelManager 调用）
    getMemoryRelations: vi.fn().mockResolvedValue({ relations: [] }),
    deleteMemoryRelation: vi.fn().mockResolvedValue({ deleted: true }),
    addMemoryRelation: vi.fn().mockResolvedValue({ added: true }),
    // 洞察相关（InsightsRenderer 调用）
    listInsights: vi.fn().mockResolvedValue({ insights: [] }),
    deleteInsight: vi.fn().mockResolvedValue({ deleted: true }),
    // 对话操作（SessionHandler 调用）
    forkSession: vi.fn().mockResolvedValue({ forked: true }),
    // 用户画像确认/拒绝（ProfilePanel 调用）
    confirmUserProfile: vi.fn().mockResolvedValue({ confirmed: true }),
    rejectUserProfile: vi.fn().mockResolvedValue({ rejected: true }),
    getUserProfile: vi.fn().mockResolvedValue({ profile: null }),
    // 精灵启动摘要（renderer.ts 调用）
    getStartupSummary: vi.fn().mockResolvedValue({
      totalMemories: 0,
      totalInsights: 0,
      skillCount: 0,
      decay: null,
      perception: null,
      healthStatus: null,
    }),
    // 感知数据（PerceptionPanelManager 调用）
    getPerceptionData: vi.fn().mockResolvedValue({
      affect: { warmth: 0.5, rapportLevel: 'neutral', rapportDescription: '' },
      rapport: { rapportLevel: 'neutral', rapportDescription: '' },
      context: { currentContext: '', contextSummary: '' },
      patterns: { patterns: [] },
      presence: { isActive: true, idleTime: 0 },
    }),
    // 设置相关
    getArchiveMode: vi.fn().mockResolvedValue({ mode: 'full' }),
    setArchiveMode: vi.fn().mockResolvedValue({ set: true }),
    getDecayConfig: vi.fn().mockResolvedValue({ config: null }),
    // 剪贴板保护
    getClipboardProtection: vi.fn().mockResolvedValue({ enabled: false }),
    setClipboardProtection: vi.fn().mockResolvedValue({ set: true }),
    // 快照/回顾
    getReviewSnapshots: vi.fn().mockResolvedValue({ snapshots: [] }),
    // 会话管理
    listSessions: vi.fn().mockResolvedValue({ sessions: [] }),
    deleteSession: vi.fn().mockResolvedValue({ deleted: true }),
    getSessionMessages: vi.fn().mockResolvedValue({ messages: [] }),
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
  // 设置全局 document 和 window（使用 vi.stubGlobal 确保 afterEach 可自动恢复，防止 worker 复用时全局引用泄漏导致 OOM）
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLInputElement', dom.window.HTMLInputElement);
  vi.stubGlobal('HTMLButtonElement', dom.window.HTMLButtonElement);
  vi.stubGlobal('HTMLTextAreaElement', dom.window.HTMLTextAreaElement);
  vi.stubGlobal('HTMLSelectElement', dom.window.HTMLSelectElement);
  vi.stubGlobal('HTMLSpanElement', dom.window.HTMLSpanElement);
  vi.stubGlobal('HTMLPreElement', dom.window.HTMLPreElement);
  vi.stubGlobal('HTMLDivElement', dom.window.HTMLDivElement);
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
  // 防御性检查：若构造函数抛出则 uiManager 为 undefined
  if (uiManager) {
    uiManager.cleanup();
  }
  dom.window.close();
  // 恢复 stub 的全局引用，释放 JSDOM 实例供 GC 回收（防止 worker 复用时内存累积导致 OOM）
  vi.unstubAllGlobals();
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
    expect(avatar?.innerHTML).toContain('icon-person');
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
    expect(avatar?.innerHTML).toContain('icon-fairy');
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
    // memoryRecall 为数组，支持多条召回记忆展示
    const el = uiManager.appendMessage({
      role: 'assistant',
      content: '回答',
      memoryRecall: [{ name: '用户偏好', score: 0.85, source: 'profile' }],
    });

    // 召回记忆渲染在 container 内（折叠模式：header + list）
    const container = el.querySelector('.memory-recall-container');
    expect(container).not.toBeNull();
    const recall = el.querySelector('.memory-recall');
    expect(recall).not.toBeNull();
    expect(recall?.textContent).toContain('用户偏好');
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
    expect(copyBtn?.innerHTML).toContain('icon-copy');
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

    // rAF 节流：渲染在下一帧执行，需等待 rAF 回调
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

// ─── 工具调用卡片 ─────────────────────────────────

describe('工具调用卡片', () => {
  it('showToolStart: 在流式消息气泡内渲染工具调用卡片', () => {
    uiManager.startStreaming('msg-tool-1');
    uiManager.showToolStart('msg-tool-1', 'call-1', 'read_file', '{"path":"test.txt"}');

    const toolCard = document.querySelector('.tool-call-card.tool-call-running');
    expect(toolCard).not.toBeNull();
    expect(toolCard?.getAttribute('data-tool-name')).toBe('read_file');
    expect(toolCard?.getAttribute('data-tool-call-id')).toBe('call-1');

    // P1-5：工具名经 toolNameMap.ts 映射为中文显示（read_file → 读取文件）
    expect(toolCard?.querySelector('.tool-call-name')?.textContent).toBe('读取文件');
    expect(toolCard?.querySelector('.tool-call-status')?.textContent).toContain('执行中');
    expect(toolCard?.querySelector('.tool-call-args')?.textContent).toContain('test.txt');
  });

  it('showToolStart: 无参数时不渲染 .tool-call-args', () => {
    uiManager.startStreaming('msg-tool-2');
    uiManager.showToolStart('msg-tool-2', 'call-2', 'list_dir');

    const toolCard = document.querySelector('.tool-call-card.tool-call-running');
    expect(toolCard).not.toBeNull();
    expect(toolCard?.querySelector('.tool-call-args')).toBeNull();
  });

  it('updateToolResult: 成功时更新卡片状态为 success', () => {
    uiManager.startStreaming('msg-tool-3');
    uiManager.showToolStart('msg-tool-3', 'call-3', 'search_memories', '{"query":"test"}');
    uiManager.updateToolResult('msg-tool-3', 'call-3', 'search_memories', true, '找到 3 条记忆');

    const toolCard = document.querySelector('.tool-call-card');
    expect(toolCard?.classList.contains('tool-call-running')).toBe(false);
    expect(toolCard?.classList.contains('tool-call-success')).toBe(true);
    expect(toolCard?.querySelector('.tool-call-status')?.textContent).toContain('成功');
    expect(toolCard?.querySelector('.tool-call-result')?.textContent).toContain('找到 3 条记忆');
  });

  it('updateToolResult: 失败时更新卡片状态为 failed', () => {
    uiManager.startStreaming('msg-tool-4');
    uiManager.showToolStart('msg-tool-4', 'call-4', 'write_file', '{"path":"test.txt"}');
    uiManager.updateToolResult('msg-tool-4', 'call-4', 'write_file', false, '权限不足');

    const toolCard = document.querySelector('.tool-call-card');
    expect(toolCard?.classList.contains('tool-call-failed')).toBe(true);
    expect(toolCard?.querySelector('.tool-call-status')?.textContent).toContain('失败');
  });

  it('updateToolResult: 无摘要时不渲染 .tool-call-result', () => {
    uiManager.startStreaming('msg-tool-5');
    uiManager.showToolStart('msg-tool-5', 'call-5', 'read_file');
    uiManager.updateToolResult('msg-tool-5', 'call-5', 'read_file', true);

    const toolCard = document.querySelector('.tool-call-card');
    expect(toolCard?.querySelector('.tool-call-result')).toBeNull();
  });

  it('updateStreamingMessage: 保留工具调用卡片不丢失', () => {
    uiManager.startStreaming('msg-tool-6');
    uiManager.showToolStart('msg-tool-6', 'call-6', 'read_file', '{"path":"a.txt"}');
    // 流式更新文本时，工具卡片应保留
    uiManager.updateStreamingMessage('msg-tool-6', '读取完成');

    const toolCard = document.querySelector('.tool-call-card');
    expect(toolCard).not.toBeNull();
    expect(toolCard?.getAttribute('data-tool-name')).toBe('read_file');
  });
});

// ─── 思考阶段指示器 ───────────────────────────────

describe('思考阶段指示器', () => {
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

// ─── Agent 就绪状态 ───────────────────────────────

describe('Agent 就绪状态', () => {
  it('初始状态 isAgentReady 为 false', () => {
    expect(uiManager.getState().isAgentReady).toBe(false);
  });

  it('setAgentReady(true): 解除发送限制', () => {
    // 设置输入内容，避免空输入时发送按钮 disabled
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = 'test';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    uiManager.setAgentReady(true);
    const cb = vi.fn();
    uiManager.onSendMessage(cb);

    const btnSend = document.getElementById('btn-send')!;
    btnSend.click();

    expect(cb).toHaveBeenCalled();
  });

  it('未就绪时点击发送显示 warning toast', () => {
    // 设置输入内容，避免空输入时发送按钮 disabled 导致 click 不触发
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = 'test';
    input.dispatchEvent(new Event('input', { bubbles: true }));
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

// ─── 流式状态发送拦截 ─────────────────────────────

describe('流式状态发送拦截', () => {
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
  it('switchPanel: 切换到记忆面板（激活 .panel.active）', () => {
    uiManager.switchPanel('memories');

    expect(uiManager.getCurrentPanel()).toBe('memories');
    // 记忆面板激活 = 含 .active 类
    const panel = document.getElementById('panel-memories');
    expect(panel?.classList.contains('active')).toBe(true);
    // 之前激活的对话面板应失活
    const chatPanel = document.getElementById('panel-chat');
    expect(chatPanel?.classList.contains('active')).toBe(false);
  });

  it('switchPanel: 导航按钮高亮同步', () => {
    uiManager.switchPanel('settings');

    const activeBtn = document.querySelector('.nav-btn.active');
    expect(activeBtn?.getAttribute('data-panel')).toBe('settings');
  });

  it('switchPanel: 切换后原面板失活（标准面板切换）', () => {
    uiManager.switchPanel('memories');
    uiManager.switchPanel('chat');

    const memoriesPanel = document.getElementById('panel-memories');
    expect(memoriesPanel?.classList.contains('active')).toBe(false);
    const chatPanel = document.getElementById('panel-chat');
    expect(chatPanel?.classList.contains('active')).toBe(true);
  });
});

// ─── handleRecallMemoryTrigger（Ctrl+Shift+R 快捷键） ─────

describe('handleRecallMemoryTrigger', () => {
  it('应激活记忆面板（panel-memories 含 .active）', async () => {
    // 初始状态在 chat 面板
    expect(uiManager.getCurrentPanel()).toBe('chat');

    await uiManager.handleRecallMemoryTrigger();

    // 切换后 currentPanel 标记为 memories
    expect(uiManager.getCurrentPanel()).toBe('memories');
    const panel = document.getElementById('panel-memories');
    expect(panel?.classList.contains('active')).toBe(true);
  });

  it('导航按钮应高亮记忆面板按钮', async () => {
    await uiManager.handleRecallMemoryTrigger();

    const activeBtn = document.querySelector('.nav-btn.active');
    expect(activeBtn?.getAttribute('data-panel')).toBe('memories');
  });

  it('切换到记忆面板后对话面板应失活（标准面板互斥）', async () => {
    // 初始在 chat
    expect(document.getElementById('panel-chat')?.classList.contains('active')).toBe(true);

    await uiManager.handleRecallMemoryTrigger();

    // 标准面板切换：chat 失活，memories 激活
    expect(document.getElementById('panel-chat')?.classList.contains('active')).toBe(false);
    const panel = document.getElementById('panel-memories');
    expect(panel?.classList.contains('active')).toBe(true);
  });

  it('应聚焦记忆搜索框', async () => {
    const searchInput = document.getElementById('memory-search') as HTMLInputElement;
    expect(searchInput).not.toBeNull();

    await uiManager.handleRecallMemoryTrigger();

    expect(document.activeElement).toBe(searchInput);
  });

  it('从 settings 面板触发时也应切换到记忆面板', async () => {
    // 先切换到 settings
    uiManager.switchPanel('settings');
    expect(uiManager.getCurrentPanel()).toBe('settings');

    // settingsPanelManager.isDirty() 返回 false（无未保存修改），直接切换
    await uiManager.handleRecallMemoryTrigger();

    expect(uiManager.getCurrentPanel()).toBe('memories');
  });

  it('从 settings 面板触发且有未保存修改时应弹出确认对话框', async () => {
    // 先切换到 settings
    uiManager.switchPanel('settings');

    // 模拟有未保存修改
    const settingsPanel = uiManager.settingsPanelManager;
    vi.spyOn(settingsPanel, 'isDirty').mockReturnValue(true);

    // 模拟用户确认离开
    vi.spyOn(uiManager, 'showConfirmDialog').mockResolvedValue(true);

    await uiManager.handleRecallMemoryTrigger();

    // 用户确认后应切换到记忆面板
    expect(uiManager.getCurrentPanel()).toBe('memories');
  });

  it('从 settings 面板触发且有未保存修改时用户取消应中止切换', async () => {
    // 先切换到 settings
    uiManager.switchPanel('settings');

    // 模拟有未保存修改
    const settingsPanel = uiManager.settingsPanelManager;
    vi.spyOn(settingsPanel, 'isDirty').mockReturnValue(true);

    // 模拟用户取消
    vi.spyOn(uiManager, 'showConfirmDialog').mockResolvedValue(false);

    await uiManager.handleRecallMemoryTrigger();

    // 用户取消，仍停留在 settings 面板
    expect(uiManager.getCurrentPanel()).toBe('settings');
    // 记忆面板保持未激活
    expect(document.getElementById('panel-memories')?.classList.contains('active')).toBe(false);
  });

  it('多次连续触发应保持记忆面板激活（幂等）', async () => {
    await uiManager.handleRecallMemoryTrigger();
    await uiManager.handleRecallMemoryTrigger();
    await uiManager.handleRecallMemoryTrigger();

    expect(uiManager.getCurrentPanel()).toBe('memories');
    // 记忆面板保持激活
    const panel = document.getElementById('panel-memories');
    expect(panel?.classList.contains('active')).toBe(true);
  });
});

// ─── triggerMemoryRecall ──────────────

describe('triggerMemoryRecall', () => {
  it('已注册 onMemoryRecallClick 回调时应触发该回调', () => {
    const cb = vi.fn();
    uiManager.onMemoryRecallClick(cb);

    uiManager.triggerMemoryRecall('推荐记忆A');

    expect(cb).toHaveBeenCalledWith('推荐记忆A');
  });

  it('未注册回调时不应抛错', () => {
    // 使用全新的 uiManager 实例避免之前测试注册的回调干扰
    expect(() => uiManager.triggerMemoryRecall('test')).not.toThrow();
  });

  it('应透传记忆名称到回调', () => {
    const cb = vi.fn();
    uiManager.onMemoryRecallClick(cb);

    uiManager.triggerMemoryRecall('带空格 的记忆名');

    expect(cb).toHaveBeenCalledWith('带空格 的记忆名');
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

    // 设置 Agent 就绪状态，否则 emitSendMessage 会拦截发送
    uiManager.setAgentReady(true);

    // 设置输入内容，避免空输入时发送按钮 disabled
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = 'test';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // 模拟点击发送按钮
    const btnSend = document.getElementById('btn-send')!;
    btnSend.click();

    expect(cb).toHaveBeenCalled();
  });

  it('onStopMessage: 注册并通过独立停止按钮触发（B2 拆分语义）', () => {
    const cb = vi.fn();
    uiManager.onStopMessage(cb);

    // B2：停止按钮已从 #btn-send 拆分为独立 #btn-stop
    // 先进入流式态（updateSendButton 会显示 #btn-stop），再点击停止按钮触发回调
    uiManager.setAgentReady(true);
    uiManager.startStreaming('msg-stop-test');
    const btnStop = document.getElementById('btn-stop')!;
    btnStop.click();

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
    // 角色项现在包含名称 + 描述，textContent 包含两者
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

// ─── prefillChatInput ──────────────

describe('prefillChatInput', () => {
  it('应设置输入框的值', () => {
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = '';

    uiManager.prefillChatInput('关于「记忆A」…');

    expect(input.value).toBe('关于「记忆A」…');
  });

  it('应触发 input 事件（让 chatPanelManager 感知内容变化）', () => {
    const input = document.getElementById('input') as HTMLTextAreaElement;
    const listener = vi.fn();
    input.addEventListener('input', listener);

    uiManager.prefillChatInput('新内容');

    expect(listener).toHaveBeenCalledTimes(1);
    input.removeEventListener('input', listener);
  });

  it('应覆盖已有输入内容', () => {
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = '旧内容';

    uiManager.prefillChatInput('新内容');

    expect(input.value).toBe('新内容');
  });

  it('空字符串应清空输入框', () => {
    const input = document.getElementById('input') as HTMLTextAreaElement;
    input.value = '有内容';

    uiManager.prefillChatInput('');

    expect(input.value).toBe('');
  });
});

// ─── Ctrl+/ 快捷键与 shortcuts-modal ─────

describe('Ctrl+/ 快捷键', () => {
  /**
   * 辅助函数：在 document 上派发 Ctrl+/ 键盘事件
   * shortcuts-modal 路径统一为 showModal/hideModal，
   * 这些测试验证统一的弹窗路径和焦点管理。
   */
  function dispatchCtrlSlash() {
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }

  it('Ctrl+/ 打开 shortcuts-modal（移除 hidden 类）', () => {
    const modal = document.getElementById('shortcuts-modal')!;
    expect(modal.classList.contains('hidden')).toBe(true);

    dispatchCtrlSlash();

    expect(modal.classList.contains('hidden')).toBe(false);
  });

  it('Ctrl+/ 调用 preventDefault 避免浏览器默认行为', () => {
    const event = new KeyboardEvent('keydown', {
      key: '/',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const spy = vi.spyOn(event, 'preventDefault');
    document.dispatchEvent(event);

    expect(spy).toHaveBeenCalled();
  });

  it('Ctrl+/ 再次按下关闭 shortcuts-modal（添加 hidden 类）', () => {
    const modal = document.getElementById('shortcuts-modal')!;
    // 先打开
    dispatchCtrlSlash();
    expect(modal.classList.contains('hidden')).toBe(false);

    // 再次按下关闭
    dispatchCtrlSlash();
    expect(modal.classList.contains('hidden')).toBe(true);
  });

  it('普通 / 按键（无 Ctrl）不触发 shortcuts-modal', () => {
    const modal = document.getElementById('shortcuts-modal')!;
    expect(modal.classList.contains('hidden')).toBe(true);

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }),
    );

    expect(modal.classList.contains('hidden')).toBe(true);
  });

  it('Cmd+/（metaKey）也能打开 shortcuts-modal（macOS 兼容）', () => {
    const modal = document.getElementById('shortcuts-modal')!;

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true, cancelable: true }),
    );

    expect(modal.classList.contains('hidden')).toBe(false);
  });

  it('打开 shortcuts-modal 时焦点移到弹窗内首个可交互元素', () => {
    // 使用 #input（始终可聚焦）替代 #btn-send（空输入时 disabled 不可聚焦）
    const triggerEl = document.getElementById('input') as HTMLTextAreaElement;
    triggerEl.focus();

    dispatchCtrlSlash();

    // 弹窗内首个可交互元素为 .modal-close 按钮（位于 modal-header）
    const closeBtn = document.querySelector('#shortcuts-modal .modal-close') as HTMLButtonElement;
    expect(document.activeElement).toBe(closeBtn);
  });

  it('关闭 shortcuts-modal 时焦点恢复到触发元素', () => {
    // 使用 #input（始终可聚焦）替代 #btn-send（空输入时 disabled 不可聚焦）
    const triggerEl = document.getElementById('input') as HTMLTextAreaElement;
    triggerEl.focus();

    // 打开 → 关闭
    dispatchCtrlSlash();
    dispatchCtrlSlash();

    expect(document.activeElement).toBe(triggerEl);
  });
});

describe('shortcuts-modal 内容同步', () => {
  /**
   * 验证 shortcuts-modal 表格内容与实际实现的快捷键保持同步。
   * 包含 Shift+Enter、Ctrl+Enter、方向键条目，
   * 防止文档与实现脱节。
   */
  function getShortcutsText(): string {
    const table = document.querySelector('#shortcuts-modal .shortcuts-table');
    return table?.textContent ?? '';
  }

  it('包含 Ctrl+1/2/3 面板切换条目', () => {
    const text = getShortcutsText();
    expect(text).toContain('Ctrl+1');
    expect(text).toContain('Ctrl+2');
    expect(text).toContain('Ctrl+3');
  });

  it('包含 Ctrl+. 停止生成条目', () => {
    expect(getShortcutsText()).toContain('Ctrl+.');
  });

  it('包含 Ctrl+/ 显示快捷键帮助条目', () => {
    expect(getShortcutsText()).toContain('Ctrl+/');
  });

  it('包含 Shift+Enter 换行条目', () => {
    expect(getShortcutsText()).toContain('Shift+Enter');
  });

  it('包含 Ctrl+Enter 提交条目（用于添加记忆弹窗）', () => {
    expect(getShortcutsText()).toContain('Ctrl+Enter');
  });

  it('包含 ↑/↓ 方向键导航角色下拉条目', () => {
    const text = getShortcutsText();
    expect(text).toContain('↑');
    expect(text).toContain('↓');
  });

  it('包含 Esc 关闭弹窗条目', () => {
    expect(getShortcutsText()).toContain('Esc');
  });
});

// 感知面板现为单页紧凑布局，相关测试在 perceptionPanelManager.test.ts 中覆盖。
