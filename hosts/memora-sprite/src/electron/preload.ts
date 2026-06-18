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

export interface ElectronAPI {
  // 对话
  sendUserInput: (text: string) => void;
  abortChat: () => Promise<void>;
  loadSession: (query: { date?: string; session?: string }) => Promise<{ messages: unknown[] }>;

  // 流式监听
  onStreamStart: (cb: (msg: { messageId: string }) => void) => void;
  onStreamChunk: (cb: (msg: { messageId: string; text: string }) => void) => void;
  onStreamEnd: (cb: (msg: { messageId: string }) => void) => void;

  // 精灵输出（主动提示 / 系统消息）
  onSpriteOutput: (cb: (msg: { text: string; kind: 'proactive' | 'system' }) => void) => void;

  // 精灵事件
  onSpriteEvent: (cb: (msg: { type: string; payload: unknown; silent: boolean }) => void) => void;

  // 错误
  onSpriteError: (cb: (msg: { text: string }) => void) => void;

  // 应用错误
  onAppError: (cb: (msg: { code: string; message: string; timestamp: string }) => void) => void;

  // 中断确认
  onChatAbortAck: (cb: () => void) => void;

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

  // Agent 就绪通知（主进程 → 渲染进程）
  onAgentReady: (cb: () => void) => void;

  // 记忆
  listMemories: (query?: { source?: string }) => Promise<{ memories: unknown[] }>;
  searchMemories: (query: string) => Promise<{ hits: unknown[] }>;
  showMemory: (id: string) => Promise<{ memory: unknown }>;
  deleteMemory: (id: string) => Promise<{ deleted: boolean }>;
  addMemory: (data: { source: string; name: string; content: string }) => Promise<{ id: string }>;

  // 配置
  getConfig: () => Promise<{ config: unknown }>;
  updateConfig: (key: string, value: unknown) => Promise<{ updated: boolean }>;

  // 角色
  listPersonas: () => Promise<{ personas: Array<{ name: string; description: string; active: boolean }> }>;
  switchPersona: (name: string) => Promise<{ switched: boolean; name: string | null }>;
  setPersonaMode: (mode: 'auto' | 'manual') => Promise<{ set: boolean }>;

  // 窗口控制
  windowMinimize: () => void;
  windowMaximize: () => void;
  windowClose: () => void;
  windowFloat: () => void;

  // 浮动窗口
  onFloatDragStart: (cb: () => void) => void;
  onFloatDragEnd: (cb: () => void) => void;
  onFloatUnread: (cb: (count: number) => void) => void;
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

  // 流式
  onStreamStart: (cb) => ipcRenderer.on('sprite-stream-start', (_: IpcRendererEvent, msg: { messageId: string }) => cb(msg)),
  onStreamChunk: (cb) => ipcRenderer.on('sprite-stream-chunk', (_: IpcRendererEvent, msg: { messageId: string; text: string }) => cb(msg)),
  onStreamEnd: (cb) => ipcRenderer.on('sprite-stream-end', (_: IpcRendererEvent, msg: { messageId: string }) => cb(msg)),

  // 精灵输出
  onSpriteOutput: (cb) => ipcRenderer.on('sprite-output', (_: IpcRendererEvent, msg: { text: string; kind: 'proactive' | 'system' }) => cb(msg)),

  // 精灵事件
  onSpriteEvent: (cb) => ipcRenderer.on('sprite-event', (_: IpcRendererEvent, msg: { type: string; payload: unknown; silent: boolean }) => cb(msg)),

  // 错误
  onSpriteError: (cb) => ipcRenderer.on('sprite-error', (_: IpcRendererEvent, msg: { text: string }) => cb(msg)),

  // 应用错误
  onAppError: (cb) => ipcRenderer.on('app-error', (_: IpcRendererEvent, msg: { code: string; message: string; timestamp: string }) => cb(msg)),

  // 中断确认
  onChatAbortAck: (cb) => ipcRenderer.on('chat-abort-ack', () => cb()),

  // Agent 状态查询
  getAgentStatus: () => ipcRenderer.invoke('agent-status'),

  // LLM 配置读写
  getLlmConfig: () => ipcRenderer.invoke('llm-config-get'),
  saveLlmConfig: (llmConfig, embeddingConfig) => ipcRenderer.invoke('llm-config-save', llmConfig, embeddingConfig),

  // Agent 就绪通知
  onAgentReady: (cb) => ipcRenderer.on('agent-ready', () => cb()),

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

  // 窗口
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose: () => ipcRenderer.send('window-close'),
  windowFloat: () => ipcRenderer.send('window-float'),

  // 浮动窗口
  onFloatDragStart: (cb) => ipcRenderer.on('float-drag-start', () => cb()),
  onFloatDragEnd: (cb) => ipcRenderer.on('float-drag-end', () => cb()),
  onFloatUnread: (cb) => ipcRenderer.on('float-unread', (_: IpcRendererEvent, count: number) => cb(count)),
  moveFloatWindow: (dx, dy) => ipcRenderer.send('move-float-window', dx, dy),
  saveFloatPosition: () => ipcRenderer.send('save-float-position'),
  expandToFull: () => ipcRenderer.send('expand-to-full'),

  // 主动提示
  proactivePromptShown: () => ipcRenderer.send('proactive-prompt-shown'),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
