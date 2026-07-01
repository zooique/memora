/**
 * Web 版 preload（DWM-01：双模式 Web 调试）
 *
 * 实现 ElectronAPI 接口，用 fetch 替代 ipcRenderer.invoke，
 * 用 EventSource 替代 ipcRenderer.on（SSE 流式，Phase 2 完善）。
 *
 * 注入到 window.electronAPI，渲染进程代码零改动即可在 Web 模式运行。
 *
 * 设计原则：
 *   - 接口签名与 Electron preload.ts 完全一致（结构性类型兼容）
 *   - 原生能力（窗口/托盘/快捷键/剪贴板）降级为 noop
 *   - Phase 1：基础 CRUD 用 fetch 实现
 *   - Phase 2：流式对话用 SSE（EventSource）实现
 *
 * 加载方式：在 renderer/index.html 中通过 <script> 标签引入（Web 模式专属）
 */

/**
 * Web 版 ElectronAPI
 *
 * 结构与 Electron preload.ts 的 ElectronAPI 接口一致，
 * TypeScript 结构性类型系统自动兼容。
 * 渲染进程调用 window.electronAPI.xxx() 时无需知道是 Electron 还是 Web 模式。
 */
export interface WebElectronAPI {
  // 对话
  sendUserInput: (text: string) => void;
  abortChat: () => Promise<void>;
  loadSession: (query: { date?: string; session?: string; limit?: number; offset?: number }) => Promise<{ messages: Array<{ role: string; content: string; timestamp?: string }>; loadedSessionId: string; total: number; hasMore: boolean }>;
  listSessions: () => Promise<{ sessions: Array<{ id: string; date: string; name: string; preview?: string; messageCount?: number }> }>;
  switchSession: (query: { date: string; session: string }) => Promise<{ success: boolean; messages: Array<{ role: string; content: string }>; error?: string }>;
  deleteSession: (sessionId: string) => Promise<{ success: boolean; error?: string }>;
  renameSession: (sessionId: string, newName: string) => Promise<{ success: boolean; error?: string }>;

  // 流式监听（Phase 2 用 SSE 实现，Phase 1 预留空实现）
  onStreamStart: (cb: (msg: { messageId: string }) => void) => void;
  onStreamChunk: (cb: (msg: { messageId: string; text: string }) => void) => void;
  onStreamEnd: (cb: (msg: { messageId: string }) => void) => void;
  onStreamRecall: (cb: (msg: { messageId: string; memories: Array<{ id: string; name: string; score: number; source: string }> }) => void) => void;
  onStreamToolStart: (cb: (msg: { messageId: string; toolCallId: string; name: string; args?: string }) => void) => void;
  onStreamToolResult: (cb: (msg: { messageId: string; toolCallId: string; name: string; ok: boolean; summary?: string }) => void) => void;
  onStreamThinking: (cb: (msg: { messageId: string; phase: string }) => void) => void;
  onContextTruncated: (cb: (msg: { messageId: string; count: number }) => void) => void;
  onStreamAborted: (cb: (msg: { messageId: string; reason: string }) => void) => void;
  removeStreamListeners: () => void;

  // 精灵输出（Phase 2 用 SSE 实现）
  onSpriteOutput: (cb: (msg: { text: string; kind: string }) => void) => void;
  removeSpriteOutputListener: () => void;
  onSpriteEvent: (cb: (msg: { type: string; payload: unknown; silent: boolean }) => void) => void;
  removeSpriteEventListener: () => void;
  onSpriteError: (cb: (msg: { text: string }) => void) => void;
  removeSpriteErrorListener: () => void;
  onAppError: (cb: (msg: { code: string; message: string; timestamp: string }) => void) => void;
  removeAppErrorListener: () => void;

  // Agent 状态
  getAgentStatus: () => Promise<{ ready: boolean; error: string | null }>;
  onAgentReady: (cb: () => void) => void;
  removeAgentReadyListener: () => void;

  // LLM 配置
  getLlmConfig: () => Promise<{
    configured: boolean;
    config: { provider: string; model: string; baseUrl: string; apiKey: string; temperature: number } | null;
    embedding: { model: string; baseUrl: string; apiKey: string } | null;
    presets: Record<string, { provider: string; model: string; baseUrl: string }>;
  }>;
  saveLlmConfig: (llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number }, embeddingConfig?: { model: string; baseUrl?: string; apiKey?: string }) => Promise<{ success: boolean; error: string | null }>;
  testLlmConfig: (llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string }) => Promise<{ success: boolean; error: string | null }>;

  // 记忆
  listMemories: (query?: { source?: string }) => Promise<{ memories: unknown[] }>;
  searchMemories: (query: string) => Promise<{ hits: unknown[] }>;
  showMemory: (id: string) => Promise<{ memory: unknown }>;
  deleteMemory: (id: string) => Promise<{ deleted: boolean }>;
  addMemory: (data: { source: string; name: string; content: string }) => Promise<{ id: string }>;
  getRelationGraph: () => Promise<{ nodes: unknown[]; edges: unknown[] }>;
  addRelation: (data: { sourceId: string; targetId: string; type: string; weight: number }) => Promise<{ success: boolean }>;
  removeRelation: (data: { sourceId: string; targetId: string; type: string }) => Promise<{ success: boolean }>;
  updateRelation: (data: { sourceId: string; targetId: string; type: string; weight: number }) => Promise<{ success: boolean }>;
  getHealthDashboard: () => Promise<unknown>;
  getReviewData: () => Promise<unknown>;
  deleteMemoriesBatch: (ids: string[]) => Promise<{ deleted: number; total: number }>;

  // 配置
  getConfig: () => Promise<{ config: unknown }>;
  updateConfig: (key: string, value: unknown) => Promise<{ updated: boolean; error?: string }>;
  updateConfigBatch: (updates: Record<string, unknown>) => Promise<{ updated: boolean; error?: string }>;

  // 角色
  listPersonas: () => Promise<{ personas: Array<{ name: string; description: string; active: boolean }> }>;
  switchPersona: (name: string) => Promise<{ switched: boolean; name: string | null }>;
  setPersonaMode: (mode: 'auto' | 'manual') => Promise<{ set: boolean }>;
  getPersonaMode: () => Promise<{ mode: string }>;

  // 项目
  listProjects: () => Promise<{ projects: Array<{ name: string; path: string }> }>;

  // 仪表盘
  getDashboard: () => Promise<unknown>;

  // 窗口控制（Web 模式降级为 noop）
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;

  // 浮动窗口（Web 模式降级为 noop）
  onFloatDragStart: (cb: () => void) => void;
  onFloatDragEnd: (cb: () => void) => void;
  onFloatUnread: (cb: (count: number) => void) => void;
  removeFloatUnreadListener: () => void;
  removeFloatDragStartListener: () => void;
  removeFloatDragEndListener: () => void;
  startFloatDrag: () => void;
  moveFloatWindow: (dx: number, dy: number) => void;
  saveFloatPosition: () => void;
  expandToFull: () => void;
  showFloatContextMenu: () => void;

  // 主动提示
  proactivePromptShown: () => void;
  proactiveAccept: () => void;
  proactiveReject: () => void;

  // 窗口状态变更（Web 模式降级为 noop）
  onWindowStateChanged: (cb: (msg: { maximized: boolean }) => void) => void;
  removeWindowStateChangedListener: () => void;

  // 主题
  notifyThemeChanged: (theme: 'light' | 'dark') => void;
  onThemeBroadcast: (cb: (theme: 'light' | 'dark') => void) => void;
  removeThemeBroadcastListener: () => void;

  // 配置建议（Phase 2 用 SSE 实现）
  onSuggestionPush: (cb: (suggestion: unknown) => void) => void;
  removeSuggestionPushListener: () => void;
  acceptSuggestion: (suggestion: unknown) => Promise<{ success: boolean; error?: string }>;
  rejectSuggestion: (suggestion: unknown) => Promise<{ success: boolean }>;

  // 用户画像
  listUserProfile: () => Promise<{ entries: unknown[] }>;
  confirmUserProfile: (id: string) => Promise<{ success: boolean; error?: string }>;
  rejectUserProfile: (id: string) => Promise<{ success: boolean; error?: string }>;

  // 写入确认（Phase 2 用 SSE 实现）
  onWriteConfirmation: (cb: (info: unknown) => void) => void;
  removeWriteConfirmationListener: () => void;
  responseWriteConfirmation: (requestId: string, confirmed: boolean) => Promise<void>;

  // 剪贴板（Web 模式降级为 noop）
  onClipboardChanged: (cb: () => void) => void;
  removeClipboardChangedListener: () => void;
  onClipboardSensitiveIgnored: (cb: (payload: { type: string }) => void) => void;
  removeClipboardSensitiveIgnoredListener: () => void;
  onClipboardAnalysisReady: (cb: (payload: { content: string }) => void) => void;
  removeClipboardAnalysisReadyListener: () => void;
  onClipboardAnalysisRejected: (cb: (payload: { reason: string }) => void) => void;
  removeClipboardAnalysisRejectedListener: () => void;
  clipboardAnalyze: () => Promise<boolean>;

  // 全局快捷键触发（Web 模式降级为 noop）
  onQuickRecordTrigger: (cb: () => void) => void;
  removeQuickRecordTriggerListener: () => void;
  onRecallMemoryTrigger: (cb: () => void) => void;
  removeRecallMemoryTriggerListener: () => void;

  // 技能安装
  installSkill: (fileName: string, content: string) => Promise<{ success: boolean; error?: string; skillName?: string }>;

  // 审计日志
  listAuditLog: (limit?: number) => Promise<unknown[]>;
  clearAuditLog: () => Promise<void>;

  // 作品投影
  listWorkProjections: () => Promise<unknown[]>;
  showWorkProjection: (filePath: string) => Promise<unknown>;

  // 渲染进程日志上报
  rendererLog: (level: 'warn' | 'error', context: string, message: string) => void;
}

// ─── fetch 工具函数 ────────────────────────────────────────

/**
 * SSE 事件回调表（事件名 → 回调函数）
 *
 * 流式对话期间，onStreamStart/onStreamChunk 等方法注册回调到此表，
 * startSseStream 解析 SSE 流后按 event 名称分发调用。
 */
interface SseListeners {
  start?: (msg: { messageId: string }) => void;
  chunk?: (msg: { messageId: string; text: string }) => void;
  end?: (msg: { messageId: string }) => void;
  recall?: (msg: { messageId: string; memories: Array<{ id: string; name: string; score: number; source: string }> }) => void;
  tool_start?: (msg: { messageId: string; toolCallId: string; name: string; args?: string }) => void;
  tool_result?: (msg: { messageId: string; toolCallId: string; name: string; ok: boolean; summary?: string }) => void;
  thinking?: (msg: { messageId: string; phase: string }) => void;
  truncated?: (msg: { messageId: string; count: number }) => void;
  aborted?: (msg: { messageId: string; reason: string }) => void;
  error?: (msg: { messageId: string; message: string }) => void;
}

/** 当前活跃的 SSE 流监听器（全局单例，新对话开始时覆盖旧的） */
let activeSseListeners: SseListeners | null = null;

/** 当前活跃的 SSE AbortController（用于客户端主动取消流式接收） */
let activeSseAbortController: AbortController | null = null;

/** onAgentReady 回调存储（Web 模式轮询实现使用） */
let agentReadyCallback: (() => void) | null = null;

/** onAgentReady 轮询定时器句柄（用于取消轮询） */
let agentReadyPollTimer: number | null = null;

/**
 * 流式监听器注册表
 *
 * onStream* 方法将回调注册到此对象，
 * sendUserInput 调用时将此对象传入 startSseStream。
 * removeStreamListeners 清空此对象。
 *
 * 使用 let 声明以便 removeStreamListeners 时整体替换为新对象。
 */
let streamListenersRegistry: SseListeners = {};

/**
 * 启动 SSE 流式对话
 *
 * 用 fetch + ReadableStream + TextDecoder 解析 SSE 流（EventSource 不支持 POST 请求体）。
 * 解析后按 event 名称分发到 activeSseListeners 中对应的回调。
 *
 * 流结束后自动清理 activeSseListeners 和 activeSseAbortController。
 *
 * @param text 用户输入文本
 * @param listeners SSE 事件回调表
 */
async function startSseStream(text: string, listeners: SseListeners): Promise<void> {
  // 覆盖旧的监听器（理论上每次新对话前应先 removeStreamListeners，此处防御性清理）
  activeSseListeners = listeners;
  activeSseAbortController = new AbortController();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: activeSseAbortController.signal,
    });

    // 非 2xx 响应：读取错误信息并通知 error 回调
    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => `HTTP ${response.status}`);
      listeners.error?.({ messageId: '', message: `对话请求失败：${errorText}` });
      return;
    }

    // 用 TextDecoder + ReadableStream reader 解析 SSE 流
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = ''; // SSE 解析缓冲区（可能跨 chunk）

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 累积新数据到缓冲区
      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以 \n\n 分隔，按分隔符切分
      const events = buffer.split('\n\n');
      // 最后一段可能不完整（未以 \n\n 结尾），保留到下一次循环
      buffer = events.pop() ?? '';

      for (const eventBlock of events) {
        const parsed = parseSseEvent(eventBlock);
        if (!parsed) continue;
        // 按 event 名称分发到对应回调
        const { event, data } = parsed;
        switch (event) {
          case 'start':
            listeners.start?.(data as { messageId: string });
            break;
          case 'chunk':
            listeners.chunk?.(data as { messageId: string; text: string });
            break;
          case 'end':
            listeners.end?.(data as { messageId: string });
            break;
          case 'recall':
            listeners.recall?.(data as { messageId: string; memories: Array<{ id: string; name: string; score: number; source: string }> });
            break;
          case 'tool_start':
            listeners.tool_start?.(data as { messageId: string; toolCallId: string; name: string; args?: string });
            break;
          case 'tool_result':
            listeners.tool_result?.(data as { messageId: string; toolCallId: string; name: string; ok: boolean; summary?: string });
            break;
          case 'thinking':
            listeners.thinking?.(data as { messageId: string; phase: string });
            break;
          case 'truncated':
            listeners.truncated?.(data as { messageId: string; count: number });
            break;
          case 'aborted':
            listeners.aborted?.(data as { messageId: string; reason: string });
            break;
          case 'error':
            listeners.error?.(data as { messageId: string; message: string });
            break;
          default:
            // 未知事件名，忽略（向前兼容）
            break;
        }
      }
    }
  } catch (error) {
    // 客户端主动取消（abortChat）时不通知 error，由 aborted 回调处理
    if (error instanceof DOMException && error.name === 'AbortError') {
      return;
    }
    // 其他错误通知 error 回调
    listeners.error?.({ messageId: '', message: `SSE 流式接收失败：${error instanceof Error ? error.message : String(error)}` });
  } finally {
    // 清理全局引用（流式接收结束）
    activeSseListeners = null;
    activeSseAbortController = null;
  }
}

/**
 * 解析单个 SSE 事件块
 *
 * SSE 事件块格式：
 *   event: <eventName>\n
 *   data: <json>\n
 *
 * @param eventBlock 单个 SSE 事件块（不含尾部 \n\n）
 * @returns 解析结果 {event, data}，解析失败返回 null
 */
function parseSseEvent(eventBlock: string): { event: string; data: unknown } | null {
  let eventName = 'message'; // SSE 默认事件名
  let dataStr = '';

  // 按行解析
  for (const line of eventBlock.split('\n')) {
    if (line.startsWith('event: ')) {
      eventName = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      dataStr = line.slice(6);
    }
  }

  // 解析 data JSON
  if (!dataStr) return null;
  try {
    return { event: eventName, data: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

/**
 * 发起 JSON POST 请求
 *
 * @param url 请求 URL
 * @param body 请求体对象
 * @returns 响应 JSON
 */
async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json() as Promise<T>;
}

/**
 * 发起 JSON PUT 请求
 *
 * @param url 请求 URL
 * @param body 请求体对象
 * @returns 响应 JSON
 */
async function putJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json() as Promise<T>;
}

/**
 * 发起 DELETE 请求
 *
 * @param url 请求 URL
 * @param body 请求体对象（可选，DELETE 请求通常无 body，但此处支持）
 * @returns 响应 JSON
 */
async function deleteJson<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'DELETE',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json() as Promise<T>;
}

/**
 * 发起 GET 请求
 *
 * @param url 请求 URL
 * @returns 响应 JSON
 */
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return response.json() as Promise<T>;
}

// ─── Web 版 electronAPI 实现 ──────────────────────────────

/**
 * Web 版 electronAPI 实现
 *
 * 用 fetch 替代 ipcRenderer.invoke，接口签名与 Electron preload.ts 完全一致。
 * 原生能力（窗口/托盘/快捷键/剪贴板）降级为 noop。
 *
 * Phase 1：基础 CRUD 用 fetch 实现
 * Phase 2：流式对话用 SSE（EventSource）实现（当前为空实现）
 */
export const webElectronAPI: WebElectronAPI = {
  // ─── 对话 ───────────────────────────────────────────────

  /**
   * 发送用户输入并启动 SSE 流式对话
   *
   * Phase 2 实现：用 fetch + ReadableStream 解析 SSE 流，
   * chunk 通过 onStreamChunk 等注册的回调推送。
   *
   * 注意：与 Electron 模式不同，Web 模式的 sendUserInput 是异步的（fetch 流式接收），
   * 但渲染进程调用方式一致（fire-and-forget），回调通过 onStream* 注册。
   */
  sendUserInput: (text: string) => {
    // 防御性清理：如果上一次对话的 SSE 流仍在接收，先中止它
    // 注意：只 abort 客户端读取，不通知服务端（服务端由下一次请求的竞态保护处理）
    if (activeSseAbortController) {
      activeSseAbortController.abort();
      activeSseAbortController = null;
    }
    activeSseListeners = null;

    // 收集当前注册的监听器（onStream* 方法注册到 streamListenersRegistry 的字段）
    // 由于 onStream* 方法在 sendUserInput 之前调用注册回调，
    // 这里需要用一个临时对象收集，再传入 startSseStream
    const listeners: SseListeners = { ...streamListenersRegistry };
    void startSseStream(text, listeners);
  },

  abortChat: async () => {
    // 客户端先取消流式接收（避免继续读取已关闭的流）
    if (activeSseAbortController) {
      activeSseAbortController.abort();
    }
    // 通知服务端中断 AgentLoop
    return postJson('/api/chat/abort');
  },

  loadSession: (query) => {
    const params = new URLSearchParams();
    if (query.date) params.set('date', query.date);
    if (query.session) params.set('session', query.session);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    return getJson(`/api/sessions/messages?${params.toString()}`);
  },

  listSessions: () => getJson('/api/sessions'),

  switchSession: (query) => postJson('/api/sessions/switch', query),

  deleteSession: (sessionId) => deleteJson(`/api/sessions/${encodeURIComponent(sessionId)}`),

  renameSession: (sessionId, newName) => putJson(`/api/sessions/${encodeURIComponent(sessionId)}/rename`, { newName }),

  // ─── 流式监听（Phase 2：注册回调到 streamListenersRegistry） ──────

  /**
   * 流式监听器注册表
   *
   * onStream* 方法将回调注册到此对象，
   * sendUserInput 调用时将此对象传入 startSseStream。
   * removeStreamListeners 清空此对象。
   */
  onStreamStart: (cb) => { streamListenersRegistry.start = cb; },
  onStreamChunk: (cb) => { streamListenersRegistry.chunk = cb; },
  onStreamEnd: (cb) => { streamListenersRegistry.end = cb; },
  onStreamRecall: (cb) => { streamListenersRegistry.recall = cb; },
  onStreamToolStart: (cb) => { streamListenersRegistry.tool_start = cb; },
  onStreamToolResult: (cb) => { streamListenersRegistry.tool_result = cb; },
  onStreamThinking: (cb) => { streamListenersRegistry.thinking = cb; },
  onContextTruncated: (cb) => { streamListenersRegistry.truncated = cb; },
  onStreamAborted: (cb) => { streamListenersRegistry.aborted = cb; },
  removeStreamListeners: () => {
    // 清空所有注册的回调
    streamListenersRegistry = {};
    // 中断活跃的 SSE 流（如果有）
    if (activeSseAbortController) {
      activeSseAbortController.abort();
      activeSseAbortController = null;
    }
    activeSseListeners = null;
  },

  // ─── 精灵输出（Phase 2 用 SSE 实现） ────────────────────

  onSpriteOutput: (_cb) => { /* Phase 2: SSE EventSource */ },
  removeSpriteOutputListener: () => { /* Phase 2 */ },
  onSpriteEvent: (_cb) => { /* Phase 2: SSE EventSource */ },
  removeSpriteEventListener: () => { /* Phase 2 */ },
  onSpriteError: (_cb) => { /* Phase 2: SSE EventSource */ },
  removeSpriteErrorListener: () => { /* Phase 2 */ },
  onAppError: (_cb) => { /* Phase 2: SSE EventSource */ },
  removeAppErrorListener: () => { /* Phase 2 */ },

  // ─── Agent 状态 ─────────────────────────────────────────

  getAgentStatus: () => getJson('/api/agent-status'),

  /**
   * Web 模式下的 onAgentReady 实现
   *
   * Electron 模式通过 IPC 推送 AGENT_READY 事件；
   * Web 模式无推送通道，采用"注册即检查+轮询兜底"策略：
   * 1. 回调注册后立即检查 getAgentStatus，若已就绪则同步（微任务）调用
   * 2. 未就绪时启动轮询（每 1.5s，最多 20 次 = 30s），就绪后调用回调并停止
   * 3. removeAgentReadyListener 可取消轮询
   */
  onAgentReady: (cb) => {
    // 先取消之前可能存在的轮询
    if (agentReadyPollTimer !== null) {
      window.clearTimeout(agentReadyPollTimer);
      agentReadyPollTimer = null;
    }
    agentReadyCallback = cb;

    // 立即检查（微任务，避免与 getAgentStatus 初始化竞态）
    const checkAndFire = async (): Promise<void> => {
      try {
        const status = await getJson<{ ready: boolean; error: string | null }>('/api/agent-status');
        if (status.ready) {
          agentReadyCallback?.();
          agentReadyPollTimer = null;
          agentReadyCallback = null;
          return;
        }
      } catch {
        // 首次请求可能因服务未完全启动而失败，降级为轮询
      }
      // 未就绪：启动轮询
      startReadyPolling(1);
    };

    const startReadyPolling = (attempt: number): void => {
      const MAX_ATTEMPTS = 20; // 最多 30 秒
      if (attempt > MAX_ATTEMPTS) {
        agentReadyPollTimer = null;
        return;
      }
      agentReadyPollTimer = window.setTimeout(() => {
        void (async () => {
          try {
            const status = await getJson<{ ready: boolean; error: string | null }>('/api/agent-status');
            if (status.ready && agentReadyCallback) {
              agentReadyCallback();
              agentReadyCallback = null;
              agentReadyPollTimer = null;
              return;
            }
          } catch {
            // 轮询请求失败，继续下一轮
          }
          if (agentReadyCallback) {
            startReadyPolling(attempt + 1);
          }
        })();
      }, 1500);
    };

    void checkAndFire();
  },
  removeAgentReadyListener: () => {
    if (agentReadyPollTimer !== null) {
      window.clearTimeout(agentReadyPollTimer);
      agentReadyPollTimer = null;
    }
    agentReadyCallback = null;
  },

  // ─── LLM 配置 ──────────────────────────────────────────

  getLlmConfig: () => getJson('/api/llm-config'),

  saveLlmConfig: (llmConfig, _embeddingConfig) => postJson('/api/llm-config', llmConfig),

  testLlmConfig: (llmConfig) => postJson('/api/llm-config/test', llmConfig),

  // ─── 记忆 ───────────────────────────────────────────────

  listMemories: (query) => {
    const params = query?.source ? `?source=${encodeURIComponent(query.source)}` : '';
    return getJson(`/api/memories${params}`);
  },

  searchMemories: (query) => getJson(`/api/memories/search?q=${encodeURIComponent(query)}`),

  showMemory: (id) => getJson(`/api/memories/${encodeURIComponent(id)}`),

  deleteMemory: (id) => deleteJson(`/api/memories/${encodeURIComponent(id)}`),

  addMemory: (data) => postJson('/api/memories', data),

  getRelationGraph: () => getJson('/api/memories/graph'),

  addRelation: (data) => postJson('/api/memories/relation', data),

  removeRelation: (data) => deleteJson('/api/memories/relation', data),

  updateRelation: (data) => putJson('/api/memories/relation', data),

  getHealthDashboard: () => getJson('/api/memories/health'),

  getReviewData: () => getJson('/api/memories/review'),

  deleteMemoriesBatch: (ids) => postJson('/api/memories/batch-delete', { ids }),

  // ─── 配置 ───────────────────────────────────────────────

  getConfig: () => getJson('/api/config'),

  updateConfig: (key, value) => putJson('/api/config', { key, value }),

  updateConfigBatch: (updates) => putJson('/api/config/batch', updates),

  // ─── 角色 ───────────────────────────────────────────────

  listPersonas: () => getJson('/api/personas'),

  switchPersona: (name) => postJson('/api/personas/switch', { name }),

  setPersonaMode: (mode) => postJson('/api/personas/mode', { mode }),

  getPersonaMode: () => getJson('/api/personas/mode'),

  // ─── 项目 ───────────────────────────────────────────────

  listProjects: () => getJson('/api/projects'),

  // ─── 仪表盘 ─────────────────────────────────────────────

  getDashboard: () => getJson('/api/dashboard'),

  // ─── 窗口控制（Web 模式降级为 noop） ────────────────────

  windowMinimize: () => { /* Web 模式无窗口控制 */ },
  windowMaximize: () => { /* Web 模式无窗口控制 */ },
  windowClose: () => { /* Web 模式无窗口控制 */ },

  // ─── 浮动窗口（Web 模式降级为 noop） ────────────────────

  onFloatDragStart: (_cb) => { /* Web 模式无浮动窗口 */ },
  onFloatDragEnd: (_cb) => { /* Web 模式无浮动窗口 */ },
  onFloatUnread: (_cb) => { /* Web 模式无浮动窗口 */ },
  removeFloatUnreadListener: () => { /* noop */ },
  removeFloatDragStartListener: () => { /* noop */ },
  removeFloatDragEndListener: () => { /* noop */ },
  startFloatDrag: () => { /* noop */ },
  moveFloatWindow: (_dx, _dy) => { /* noop */ },
  saveFloatPosition: () => { /* noop */ },
  expandToFull: () => { /* noop */ },
  showFloatContextMenu: () => { /* noop */ },

  // ─── 主动提示 ───────────────────────────────────────────

  proactivePromptShown: () => { /* Phase 2: 通知后端清除未读计数 */ },
  proactiveAccept: () => { /* Phase 2: 通知后端记录接受 */ },
  proactiveReject: () => { /* Phase 2: 通知后端记录拒绝 */ },

  // ─── 窗口状态变更（Web 模式降级为 noop） ────────────────

  onWindowStateChanged: (_cb) => { /* Web 模式无窗口状态 */ },
  removeWindowStateChangedListener: () => { /* noop */ },

  // ─── 主题 ───────────────────────────────────────────────

  notifyThemeChanged: (_theme) => {
    // Web 模式：保存到 localStorage，由 ThemeManager 读取
    localStorage.setItem('theme', _theme);
  },

  onThemeBroadcast: (_cb) => { /* Web 模式无多窗口同步 */ },
  removeThemeBroadcastListener: () => { /* noop */ },

  // ─── 配置建议（Phase 2 用 SSE 实现） ────────────────────

  onSuggestionPush: (_cb) => { /* Phase 2: SSE EventSource */ },
  removeSuggestionPushListener: () => { /* Phase 2 */ },
  acceptSuggestion: (_suggestion) => Promise.resolve({ success: true }),
  rejectSuggestion: (_suggestion) => Promise.resolve({ success: true }),

  // ─── 用户画像（Phase 2 扩展路由） ───────────────────────

  listUserProfile: () => Promise.resolve({ entries: [] }),
  confirmUserProfile: (_id) => Promise.resolve({ success: true }),
  rejectUserProfile: (_id) => Promise.resolve({ success: true }),

  // ─── 写入确认（Phase 2 用 SSE 实现） ────────────────────

  onWriteConfirmation: (_cb) => { /* Phase 2: SSE EventSource */ },
  removeWriteConfirmationListener: () => { /* Phase 2 */ },
  responseWriteConfirmation: (_requestId, _confirmed) => Promise.resolve(),

  // ─── 剪贴板（Web 模式降级为 noop） ──────────────────────

  onClipboardChanged: (_cb) => { /* Web 模式无剪贴板监听 */ },
  removeClipboardChangedListener: () => { /* noop */ },
  onClipboardSensitiveIgnored: (_cb) => { /* noop */ },
  removeClipboardSensitiveIgnoredListener: () => { /* noop */ },
  onClipboardAnalysisReady: (_cb) => { /* noop */ },
  removeClipboardAnalysisReadyListener: () => { /* noop */ },
  onClipboardAnalysisRejected: (_cb) => { /* noop */ },
  removeClipboardAnalysisRejectedListener: () => { /* noop */ },
  clipboardAnalyze: () => Promise.resolve(false),

  // ─── 全局快捷键触发（Web 模式降级为 noop） ──────────────

  onQuickRecordTrigger: (_cb) => { /* Web 模式无全局快捷键 */ },
  removeQuickRecordTriggerListener: () => { /* noop */ },
  onRecallMemoryTrigger: (_cb) => { /* Web 模式无全局快捷键 */ },
  removeRecallMemoryTriggerListener: () => { /* noop */ },

  // ─── 技能安装（Phase 2 扩展路由） ───────────────────────

  installSkill: (_fileName, _content) => Promise.resolve({ success: false, error: 'Web 模式暂不支持技能安装' }),

  // ─── 审计日志（Phase 2 扩展路由） ───────────────────────

  listAuditLog: (_limit) => Promise.resolve([]),
  clearAuditLog: () => Promise.resolve(),

  // ─── 作品投影（Phase 2 扩展路由） ───────────────────────

  listWorkProjections: () => Promise.resolve([]),
  showWorkProjection: (_filePath) => Promise.resolve(null),

  // ─── 渲染进程日志上报 ──────────────────────────────────

  rendererLog: (level, context, message) => {
    // Web 模式：直接 console 输出（无主进程 logger 可转发）
    const prefix = level === 'error' ? '[Renderer Error]' : '[Renderer Warn]';
    console.error(`${prefix} ${context}: ${message}`);
  },
};

// ─── 注入到 window ────────────────────────────────────────

/**
 * 注入 Web 版 electronAPI 到 window
 *
 * 在 Web 模式下，renderer/index.html 加载本文件后调用此函数。
 * 渲染进程代码通过 window.electronAPI.xxx() 调用，与 Electron 模式完全一致。
 *
 * 注意：本函数仅在浏览器环境执行，Node.js 环境下 window 不存在。
 */
/**
 * 初始化 Web 模式 UI 适配
 *
 * 采用直接 DOM 样式操作而非 CSS 注入，原因：
 * IDE 内置浏览器环境中动态创建的 <style> 元素 sheet 为 null（无法解析内联样式），
 * 直接操作元素 style 属性可确保在任何环境下都生效。
 * 使用 MutationObserver 监听异步插入的元素。
 */
function initWebModeUi(): void {
  // 添加 body.web-mode 标识 class（供 CSS 选择器使用，即使 style sheet 不可用也无副作用）
  document.body.classList.add('web-mode');

  /**
   * 应用 Web 模式样式到指定元素
   * 直接设置内联样式，优先级最高且不依赖外部样式表
   */
  function applyWebStyles(): void {
    // 隐藏 Electron 窗口控制按钮（最小化/最大化/关闭）
    const controls = document.getElementById('titlebar-controls');
    if (controls) {
      controls.style.setProperty('display', 'none', 'important');
    }
    // 禁用 Electron 拖拽区域
    const titlebarDrag = document.getElementById('titlebar-drag');
    if (titlebarDrag) {
      titlebarDrag.style.setProperty('-webkit-app-region', 'no-drag', 'important');
      titlebarDrag.style.cursor = 'default';
    }
    const header = document.querySelector('header');
    if (header) {
      (header as HTMLElement).style.setProperty('-webkit-app-region', 'no-drag', 'important');
    }
  }

  // 立即应用（元素可能已存在）
  applyWebStyles();

  // 使用 MutationObserver 监听后续 DOM 变化（元素可能在脚本执行后才插入）
  const observer = new MutationObserver(() => {
    applyWebStyles();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

export function injectWebElectronAPI(): void {
  if (typeof window !== 'undefined') {
    (window as unknown as { electronAPI: WebElectronAPI }).electronAPI = webElectronAPI;
    // 初始化 Web 模式 UI 适配（DOM 加载完成后执行）
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initWebModeUi);
    } else {
      initWebModeUi();
    }
    console.log('[Web] electronAPI 已注入（Web 模式）');
  }
}

// 自动注入（浏览器环境加载本文件时立即执行）
if (typeof window !== 'undefined') {
  injectWebElectronAPI();
}
