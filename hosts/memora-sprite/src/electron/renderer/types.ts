/**
 * UI 模块公共类型定义
 *
 * 职责：
 * - 集中存放渲染进程 UI 层使用的类型
 * - 重新导出 preload.ts 的类型，保持 ui.ts 公共 API 不变
 *
 * 设计原则：
 * - 类型定义与 UI 实现分离，便于其他模块复用
 * - 不依赖任何运行时逻辑，纯类型模块
 */

import type {
  ElectronAPI,
  MemoryListItem,
  MemorySearchHit,
  MemoryDetail,
  SpriteConfigForm,
} from '../preload.js';

// 重新导出 preload.ts 的类型，保持 ui.ts 公共 API 不变（其他模块从 ui.ts 导入这些类型）
export type { MemoryListItem, MemorySearchHit, MemoryDetail, SpriteConfigForm, ElectronAPI };

/** UI 消息（对齐渲染进程消息渲染需求） */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming?: boolean;
  messageId?: string;
  /** 消息时间戳（ISO 字符串，可选）。未提供时使用当前时间。 */
  timestamp?: string;
  /**
   * 召回记忆提示（仅精灵消息可能携带，对齐 HTML 预览 §6.2 .memory-recall）
   * MS-12：改为数组支持多条召回记忆展示，每条含 name/score/source
   */
  memoryRecall?: Array<{ name: string; score: number; source: string }>;
}

/** UI 状态快照（供外部查询当前面板、未读数、流式状态） */
export interface UIState {
  currentPanel: string;
  unreadCount: number;
  isStreaming: boolean;
}

/** 角色列表项（与 sprite.listPersonas 返回值对齐） */
export interface PersonaItem {
  name: string;
  description: string;
  active: boolean;
}

/** LLM 配置表单数据 */
export interface LlmConfigForm {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
}

/** Embedding 配置表单数据 */
export interface EmbeddingConfigForm {
  enabled: boolean;
  model: string;
  baseUrl: string;
  apiKey: string;
}

/** LLM 配置保存回调参数（包含 LLM + Embedding） */
export interface LlmConfigSavePayload {
  llm: LlmConfigForm;
  embedding: EmbeddingConfigForm | null;
}

/** Toast 通知类型 */
export type ToastType = 'success' | 'error' | 'warning' | 'info';

// 扩展全局 Window 类型，消除 TS 编译错误（electronAPI 由 preload.ts 通过 contextBridge 注入）
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
