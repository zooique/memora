/**
 * 预加载脚本 — 安全桥接主进程与渲染进程
 *
 * contextBridge 暴露有限的 API 给渲染进程：
 * - 所有 IPC 调用必须显式列出
 * - 敏感 API（如 Shell、FileSystem）不暴露
 * - 通信方式：ipcRenderer.invoke（请求/响应）+ ipcRenderer.on（事件推送）
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

// ─── 类型定义（与主进程 IPC 通道对应） ─────────────────────

/** 记忆列表项（与 sprite.listMemories 返回值对齐） */
export interface MemoryListItem {
  id: string;
  name: string;
  source: string;
  score: number;
  contentPreview: string;
}

/** 记忆搜索结果（与 sprite.searchMemories 返回值对齐，含相似度） */
export interface MemorySearchHit {
  /** 记忆唯一标识（${source}:${name} 格式） */
  id: string;
  name: string;
  source: string;
  score: number;
  contentPreview: string;
  similarity?: number;
}

/** 记忆详情（与 sprite.showMemory 返回值对齐） */
export interface MemoryDetail {
  id: string;
  name: string;
  source: string;
  score: number;
  content: string;
  createdAt: string;
  accessedAt: string;
}

/** 精灵配置（与 SpriteConfig 对齐，渲染进程用） */
export interface SpriteConfigForm {
  silentMode: boolean;
  proactiveThreshold: number;
  proactiveCooldownMs: number;
  triggerIntervalMs: number;
  fileWatcherEnabled: boolean;
  fileWatcherPaths: string[];
  fileWatcherDebounceMs: number;
  defaultPersona: string;
  /** FD-04 项目模式：'smart'（智能）| 'focus'（专注） */
  projectMode: 'smart' | 'focus';
  /** FD-04 专注模式锁定的项目路径 */
  focusProjectPath: string;
}

export interface ElectronAPI {
  // 对话
  sendUserInput: (text: string) => void;
  abortChat: () => Promise<void>;
  loadSession: (query: { date?: string; session?: string }) => Promise<{ messages: unknown[] }>;

  // 流式监听（含移除方法，防止多次调用导致重复触发与内存泄漏）
  onStreamStart: (cb: (msg: { messageId: string }) => void) => void;
  onStreamChunk: (cb: (msg: { messageId: string; text: string }) => void) => void;
  onStreamEnd: (cb: (msg: { messageId: string }) => void) => void;
  /** 移除所有流式监听器（页面卸载或重新初始化时调用） */
  removeStreamListeners: () => void;

  // 精灵输出（主动提示 / 系统消息）
  onSpriteOutput: (cb: (msg: { text: string; kind: 'proactive' | 'system' }) => void) => void;
  /** 移除精灵输出监听器 */
  removeSpriteOutputListener: () => void;

  // 精灵事件
  onSpriteEvent: (cb: (msg: { type: string; payload: unknown; silent: boolean }) => void) => void;
  /** 移除精灵事件监听器 */
  removeSpriteEventListener: () => void;

  // 错误
  onSpriteError: (cb: (msg: { text: string }) => void) => void;
  /** 移除精灵错误监听器 */
  removeSpriteErrorListener: () => void;

  // 应用错误
  onAppError: (cb: (msg: { code: string; message: string; timestamp: string }) => void) => void;
  /** 移除应用错误监听器 */
  removeAppErrorListener: () => void;

  // Agent 状态查询
  getAgentStatus: () => Promise<{ ready: boolean; error: string | null }>;

  // LLM 配置读写（首次启动引导用）
  getLlmConfig: () => Promise<{
    configured: boolean;
    config: { provider: string; model: string; baseUrl: string; apiKey: string; temperature: number } | null;
    embedding: { model: string; baseUrl: string; apiKey: string } | null;
    presets: Record<string, { provider: string; model: string; baseUrl: string }>;
  }>;
  saveLlmConfig: (
    llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string; temperature?: number },
    embeddingConfig?: { model: string; baseUrl?: string; apiKey?: string },
  ) => Promise<{ success: boolean; error: string | null }>;

  /** 测试 LLM 连接（保存前验证配置是否可用） */
  testLlmConfig: (llmConfig: { provider: string; model: string; baseUrl: string; apiKey: string }) => Promise<{ success: boolean; error: string | null }>;

  // Agent 就绪通知（主进程 → 渲染进程）
  onAgentReady: (cb: () => void) => void;
  /** 移除 Agent 就绪监听器 */
  removeAgentReadyListener: () => void;

  // 记忆
  listMemories: (query?: { source?: string }) => Promise<{ memories: MemoryListItem[] }>;
  searchMemories: (query: string) => Promise<{ hits: MemorySearchHit[] }>;
  showMemory: (id: string) => Promise<{ memory: MemoryDetail | null }>;
  deleteMemory: (id: string) => Promise<{ deleted: boolean }>;
  addMemory: (data: { source: string; name: string; content: string }) => Promise<{ id: string }>;

  // 配置
  getConfig: () => Promise<{ config: SpriteConfigForm }>;
  updateConfig: (key: string, value: unknown) => Promise<{ updated: boolean }>;

  // 角色
  listPersonas: () => Promise<{ personas: Array<{ name: string; description: string; active: boolean }> }>;
  switchPersona: (name: string) => Promise<{ switched: boolean; name: string | null }>;
  setPersonaMode: (mode: 'auto' | 'manual') => Promise<{ set: boolean }>;

  // 项目（FD-04 项目模式）
  /** 列出已注册项目（供专注模式选择器使用） */
  listProjects: () => Promise<{ projects: Array<{ name: string; path: string }> }>;

  // 会话（FD-05 新建会话）
  /** 新建会话（生成时间戳会话名，切换到新会话） */
  newSession: () => Promise<{ success: boolean; sessionName?: string; error?: string }>;

  // 窗口控制
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;

  // 浮动窗口
  onFloatDragStart: (cb: () => void) => void;
  onFloatDragEnd: (cb: () => void) => void;
  onFloatUnread: (cb: (count: number) => void) => void;
  /** 移除浮动窗口未读计数监听器 */
  removeFloatUnreadListener: () => void;
  /** 移除浮动窗口拖动开始监听器 */
  removeFloatDragStartListener: () => void;
  /** 移除浮动窗口拖动结束监听器 */
  removeFloatDragEndListener: () => void;
  moveFloatWindow: (dx: number, dy: number) => void;
  saveFloatPosition: () => void;
  expandToFull: () => void;

  // 主动提示已显示通知
  proactivePromptShown: () => void;
}

const electronAPI: ElectronAPI = {
  // 对话
  sendUserInput: (text) => ipcRenderer.send('user-input', text),
  abortChat: () => ipcRenderer.invoke('chat-abort'),
  loadSession: (query) => ipcRenderer.invoke('session-load', query),

  // 流式监听
  // 注意：ipcRenderer.on 注册的监听器会累积，多次调用 on* 方法会导致同一事件触发多次。
  // 提供 remove* 方法供渲染进程在重新初始化或页面卸载时清理。
  onStreamStart: (cb) => ipcRenderer.on('sprite-stream-start', (_: IpcRendererEvent, msg: { messageId: string }) => cb(msg)),
  onStreamChunk: (cb) => ipcRenderer.on('sprite-stream-chunk', (_: IpcRendererEvent, msg: { messageId: string; text: string }) => cb(msg)),
  onStreamEnd: (cb) => ipcRenderer.on('sprite-stream-end', (_: IpcRendererEvent, msg: { messageId: string }) => cb(msg)),
  removeStreamListeners: () => {
    ipcRenderer.removeAllListeners('sprite-stream-start');
    ipcRenderer.removeAllListeners('sprite-stream-chunk');
    ipcRenderer.removeAllListeners('sprite-stream-end');
  },

  // 精灵输出
  onSpriteOutput: (cb) => ipcRenderer.on('sprite-output', (_: IpcRendererEvent, msg: { text: string; kind: 'proactive' | 'system' }) => cb(msg)),
  removeSpriteOutputListener: () => {
    ipcRenderer.removeAllListeners('sprite-output');
  },

  // 精灵事件
  onSpriteEvent: (cb) => ipcRenderer.on('sprite-event', (_: IpcRendererEvent, msg: { type: string; payload: unknown; silent: boolean }) => cb(msg)),
  removeSpriteEventListener: () => {
    ipcRenderer.removeAllListeners('sprite-event');
  },

  // 错误
  onSpriteError: (cb) => ipcRenderer.on('sprite-error', (_: IpcRendererEvent, msg: { text: string }) => cb(msg)),
  removeSpriteErrorListener: () => {
    ipcRenderer.removeAllListeners('sprite-error');
  },

  // 应用错误
  onAppError: (cb) => ipcRenderer.on('app-error', (_: IpcRendererEvent, msg: { code: string; message: string; timestamp: string }) => cb(msg)),
  removeAppErrorListener: () => {
    ipcRenderer.removeAllListeners('app-error');
  },

  // Agent 状态查询
  getAgentStatus: () => ipcRenderer.invoke('agent-status'),

  // LLM 配置读写
  getLlmConfig: () => ipcRenderer.invoke('llm-config-get'),
  saveLlmConfig: (llmConfig, embeddingConfig) => ipcRenderer.invoke('llm-config-save', llmConfig, embeddingConfig),
  testLlmConfig: (llmConfig) => ipcRenderer.invoke('llm-config-test', llmConfig),

  // Agent 就绪通知
  onAgentReady: (cb) => ipcRenderer.on('agent-ready', () => cb()),
  removeAgentReadyListener: () => {
    ipcRenderer.removeAllListeners('agent-ready');
  },

  // 记忆
  listMemories: (query) => ipcRenderer.invoke('memories-list', query ?? {}),
  searchMemories: (q) => ipcRenderer.invoke('memories-search', q),
  showMemory: (id) => ipcRenderer.invoke('memories-show', id),
  deleteMemory: (id) => ipcRenderer.invoke('memories-delete', id),
  addMemory: (data) => ipcRenderer.invoke('memories-add', data),

  // 配置
  getConfig: () => ipcRenderer.invoke('config-get'),
  updateConfig: (key, value) => ipcRenderer.invoke('config-update', key, value),

  // 角色
  listPersonas: () => ipcRenderer.invoke('persona-list'),
  switchPersona: (name) => ipcRenderer.invoke('persona-switch', name),
  setPersonaMode: (mode) => ipcRenderer.invoke('persona-mode', mode),
  /** IX-07 查询当前角色匹配模式 */
  getPersonaMode: () => ipcRenderer.invoke('persona-mode-get') as Promise<{ mode: string }>,

  // 项目（FD-04）
  listProjects: () => ipcRenderer.invoke('projects-list'),

  // 会话（FD-05）
  newSession: () => ipcRenderer.invoke('session-new'),

  // 仪表盘（FD-03）
  getDashboard: () => ipcRenderer.invoke('dashboard-get') as Promise<{
    total: number;
    bySource: Record<string, number>;
    suggestions: Array<{ name: string; source: string; reason: string; relevance: number }>;
    pendingNotices: number;
    proactiveThreshold: number;
    registeredTriggers: string[];
  }>,

  // 窗口
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),

  // 浮动窗口
  onFloatDragStart: (cb) => ipcRenderer.on('float-drag-start', () => cb()),
  onFloatDragEnd: (cb) => ipcRenderer.on('float-drag-end', () => cb()),
  onFloatUnread: (cb) => ipcRenderer.on('float-unread', (_: IpcRendererEvent, count: number) => cb(count)),
  removeFloatUnreadListener: () => {
    ipcRenderer.removeAllListeners('float-unread');
  },
  removeFloatDragStartListener: () => {
    ipcRenderer.removeAllListeners('float-drag-start');
  },
  removeFloatDragEndListener: () => {
    ipcRenderer.removeAllListeners('float-drag-end');
  },
  moveFloatWindow: (dx, dy) => ipcRenderer.send('move-float-window', dx, dy),
  saveFloatPosition: () => ipcRenderer.send('save-float-position'),
  expandToFull: () => ipcRenderer.send('expand-to-full'),

  // 主动提示
  proactivePromptShown: () => ipcRenderer.send('proactive-prompt-shown'),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
