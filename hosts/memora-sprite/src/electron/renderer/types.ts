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
  MemoryRelationItem,
  SpriteConfigForm,
} from '../preload.js';
// PersonaInfo 从 sprite 层导入（真理源），消除 renderer 层 PersonaItem 重复定义
import type { PersonaInfo } from '../../sprite/controllers/index.js';

// 重新导出 preload.ts 的类型，保持 ui.ts 公共 API 不变（其他模块从 ui.ts 导入这些类型）
export type { MemoryListItem, MemorySearchHit, MemoryDetail, MemoryRelationItem, SpriteConfigForm, ElectronAPI };

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
   * 数组结构，支持多条召回记忆展示，每条含 id/name/score/source
   * id 为 source:name 格式，用于点击跳转记忆详情
   */
  memoryRecall?: Array<{ id: string; name: string; score: number; source: string }>;
}

/** UI 状态快照（供外部查询当前面板、未读数、流式状态、Agent 就绪状态） */
export interface UIState {
  currentPanel: string;
  unreadCount: number;
  isStreaming: boolean;
  /** Agent 是否就绪（LLM 配置保存成功后置 true，未就绪时禁止发送消息） */
  isAgentReady: boolean;
}

// PersonaItem re-export PersonaInfo（sprite 层是真理源），保持向后兼容
export type { PersonaInfo as PersonaItem };

/**
 * LLM 配置表单数据（renderer 层 UI 表单形态）
 *
 * 与 storage 层 LlmConfigFormData 对齐，但存在以下分层差异（有意设计）：
 * - temperature 必填（UI 表单需默认值，storage 层允许省略）
 * - background.temperature 存在（UI 表单可配置后台 temperature，storage 层不持久化）
 */
export interface LlmConfigForm {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  /** 后台 Provider 配置（可选，用于 Insight 提取/配置分析等后台任务） */
  background?: {
    enabled: boolean;
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    temperature?: number;
  };
}

/**
 * Embedding 配置表单数据（renderer 层 UI 表单形态）
 *
 * 与 storage 层 EmbeddingConfigFormData 对齐，但存在以下分层差异（有意设计）：
 * - enabled 字段存在（UI 表单需开关控件，storage 层用"参数是否传入"判断启用）
 * - baseUrl/apiKey 必填（UI 表单需默认值，storage 层允许省略）
 */
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

/** Toast 重试选项（提供 onRetry 时显示重试按钮，且 toast 不自动消失） */
export interface ToastOptions {
  onRetry?: () => void;
  /**
   * 自定义操作按钮（Phase 3.1：剪贴板分析触发）
   * 提供 actionLabel + onAction 时显示操作按钮，且 toast 不自动消失
   */
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * 确认弹窗选项（提取统一类型，消除 4 处内联重复定义）
 *
 * 被 modal.ts / ui.ts / ChatPanelHost / SettingsPanelHost / MemoryPanelHost 共享。
 */
export interface ConfirmDialogOptions {
  title?: string;
  message: string;
  /** 确认消息 DOM 节点数组（优先于 message，用于富文本展示，调用方通过 createElement + textContent 构建天然防 XSS） */
  messageNodes?: Node[];
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

// 扩展全局 Window 类型，消除 TS 编译错误（electronAPI 由 preload.ts 通过 contextBridge 注入）
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
