/**
 * 宿主上下文共享类型（DWM-01：双模式 Web 调试）
 *
 * 定义 Electron 模式与 Web 模式共用的核心依赖容器。
 * Electron 模式的 IpcContext 包含额外的窗口/托盘/快捷键等原生能力，
 * Web 模式仅注入此处的核心字段，两者复用同一套 sprite/storage/agent 核心层。
 *
 * 设计原则：
 *   - 核心字段 = 业务逻辑必需（对话/记忆/会话/配置/角色）
 *   - 原生字段 = Electron 专属（窗口/托盘/剪贴板/快捷键），Web 模式不注入
 *   - Web 模式的 HTTP 路由消费 HostContext，与 IPC handler 平行而非复用
 */

import type { Agent } from 'memora';
import type { Sprite } from '../sprite/sprite.js';
import type { SqliteSessionStore } from '../storage/sessionStore.js';

/**
 * 宿主上下文（核心依赖容器）
 *
 * Electron 模式和 Web 模式都构造此上下文，注入到各自的传输层
 * （IPC handler / HTTP 路由）。核心层（sprite/storage/agent）对宿主模式无感知。
 */
export interface HostContext {
  /** Agent 实例（对话 + 记忆引擎） */
  agent: Agent;
  /** Sprite 实例（精灵控制 + 配置 + 角色） */
  sprite: Sprite;
  /** 会话存储（历史消息加载） */
  sessionStore: SqliteSessionStore;
  /** 获取当前对话的 AbortController（用于中断流式输出） */
  getAbortController: () => AbortController | null;
  /** 设置当前对话的 AbortController */
  setAbortController: (ctrl: AbortController | null) => void;
  /**
   * Agent 是否就绪
   *
   * 配置缺失或 reinitAgent 失败后为 false，拒绝新对话请求。
   */
  isAgentReady: () => boolean;
}
