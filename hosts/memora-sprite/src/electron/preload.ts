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
import { IPC_CHANNELS, MAIN_TO_RENDERER_CHANNELS } from './ipcChannels.js';
// 从业务层导入 IPC 契约类型，消除 preload 与 memoryController 的重复定义（DRY）。
// 使用 import type：编译时擦除，不引入运行时耦合；electron 层依赖 sprite 层是合理依赖方向。
import type {
  MemoryListItem,
  MemoryDetail,
  MemorySearchResult as MemorySearchHit,
} from '../sprite/controllers/memoryController.js';

// 重新导出契约类型，供 ui.ts / renderer.ts 通过 preload 统一引用
export type { MemoryListItem, MemoryDetail, MemorySearchHit };

// ─── 类型定义（与主进程 IPC 通道对应） ─────────────────────

/** 会话消息（渲染进程展示用，与 SessionMessage 对齐但仅暴露必要字段） */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
  loadSession: (query: { date?: string; session?: string }) => Promise<{ messages: ChatMessage[] }>;

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
  /** IX-07 查询当前角色匹配模式 */
  getPersonaMode: () => Promise<{ mode: string }>;

  // 项目（FD-04 项目模式）
  /** 列出已注册项目（供专注模式选择器使用） */
  listProjects: () => Promise<{ projects: Array<{ name: string; path: string }> }>;

  // 会话（FD-05 新建会话）
  /** 新建会话（生成时间戳会话名，切换到新会话） */
  newSession: () => Promise<{ success: boolean; sessionName?: string; error?: string }>;

  // 仪表盘（FD-03）
  getDashboard: () => Promise<{
    total: number;
    bySource: Record<string, number>;
    suggestions: Array<{ name: string; source: string; reason: string; relevance: number; contentPreview: string }>;
    pendingNotices: number;
    proactiveThreshold: number;
    registeredTriggers: string[];
  }>;

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
  /** 显示浮动窗口右键菜单（主进程原生 Menu） */
  showFloatContextMenu: () => void;

  // 主动提示已显示通知
  proactivePromptShown: () => void;
}

const electronAPI: ElectronAPI = {
  // 对话
  sendUserInput: (text) => ipcRenderer.send(IPC_CHANNELS.USER_INPUT, text),
  abortChat: () => ipcRenderer.invoke(IPC_CHANNELS.CHAT_ABORT),
  loadSession: (query) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LOAD, query),

  // 流式监听
  // 注意：ipcRenderer.on 注册的监听器会累积，多次调用 on* 方法会导致同一事件触发多次。
  // 提供 remove* 方法供渲染进程在重新初始化或页面卸载时清理。
  onStreamStart: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START, (_: IpcRendererEvent, msg: { messageId: string }) => cb(msg)),
  onStreamChunk: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK, (_: IpcRendererEvent, msg: { messageId: string; text: string }) => cb(msg)),
  onStreamEnd: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END, (_: IpcRendererEvent, msg: { messageId: string }) => cb(msg)),
  removeStreamListeners: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_START);
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_CHUNK);
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_STREAM_END);
  },

  // 精灵输出
  onSpriteOutput: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT, (_: IpcRendererEvent, msg: { text: string; kind: 'proactive' | 'system' }) => cb(msg)),
  removeSpriteOutputListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_OUTPUT);
  },

  // 精灵事件
  onSpriteEvent: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT, (_: IpcRendererEvent, msg: { type: string; payload: unknown; silent: boolean }) => cb(msg)),
  removeSpriteEventListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_EVENT);
  },

  // 错误
  onSpriteError: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR, (_: IpcRendererEvent, msg: { text: string }) => cb(msg)),
  removeSpriteErrorListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.SPRITE_ERROR);
  },

  // 应用错误
  onAppError: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.APP_ERROR, (_: IpcRendererEvent, msg: { code: string; message: string; timestamp: string }) => cb(msg)),
  removeAppErrorListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.APP_ERROR);
  },

  // Agent 状态查询
  getAgentStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_STATUS),

  // LLM 配置读写
  getLlmConfig: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_CONFIG_GET),
  saveLlmConfig: (llmConfig, embeddingConfig) => ipcRenderer.invoke(IPC_CHANNELS.LLM_CONFIG_SAVE, llmConfig, embeddingConfig),
  testLlmConfig: (llmConfig) => ipcRenderer.invoke(IPC_CHANNELS.LLM_CONFIG_TEST, llmConfig),

  // Agent 就绪通知
  onAgentReady: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.AGENT_READY, () => cb()),
  removeAgentReadyListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.AGENT_READY);
  },

  // 记忆
  listMemories: (query) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_LIST, query ?? {}),
  searchMemories: (q) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_SEARCH, q),
  showMemory: (id) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_SHOW, id),
  deleteMemory: (id) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_DELETE, id),
  addMemory: (data) => ipcRenderer.invoke(IPC_CHANNELS.MEMORIES_ADD, data),

  // 配置
  getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET),
  updateConfig: (key, value) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_UPDATE, key, value),

  // 角色
  listPersonas: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_LIST),
  switchPersona: (name) => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_SWITCH, name),
  setPersonaMode: (mode) => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_MODE, mode),
  /** IX-07 查询当前角色匹配模式 */
  getPersonaMode: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_MODE_GET),

  // 项目（FD-04）
  listProjects: () => ipcRenderer.invoke(IPC_CHANNELS.PROJECTS_LIST),

  // 会话（FD-05）
  newSession: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_NEW),

  // 仪表盘（FD-03）
  getDashboard: () => ipcRenderer.invoke(IPC_CHANNELS.DASHBOARD_GET),

  // 窗口
  windowMinimize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE),
  windowMaximize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE),
  windowClose: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE),

  // 浮动窗口
  onFloatDragStart: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.FLOAT_DRAG_START, () => cb()),
  onFloatDragEnd: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.FLOAT_DRAG_END, () => cb()),
  onFloatUnread: (cb) => ipcRenderer.on(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD, (_: IpcRendererEvent, count: number) => cb(count)),
  removeFloatUnreadListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.FLOAT_UNREAD);
  },
  removeFloatDragStartListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.FLOAT_DRAG_START);
  },
  removeFloatDragEndListener: () => {
    ipcRenderer.removeAllListeners(MAIN_TO_RENDERER_CHANNELS.FLOAT_DRAG_END);
  },
  moveFloatWindow: (dx, dy) => ipcRenderer.send(IPC_CHANNELS.MOVE_FLOAT_WINDOW, dx, dy),
  saveFloatPosition: () => ipcRenderer.send(IPC_CHANNELS.SAVE_FLOAT_POSITION),
  expandToFull: () => ipcRenderer.send(IPC_CHANNELS.EXPAND_TO_FULL),
  showFloatContextMenu: () => ipcRenderer.send(IPC_CHANNELS.FLOAT_CONTEXT_MENU),

  // 主动提示
  proactivePromptShown: () => ipcRenderer.send(IPC_CHANNELS.PROACTIVE_PROMPT_SHOWN),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
