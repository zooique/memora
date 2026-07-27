/**
 * Agent 运行时状态容器
 *
 * 封装 Agent 实例生命周期相关的 9 个字段：
 * - Agent 实例四元组（agent/sprite/sessionStore/closeSprite）
 * - 流式控制（currentAbortController）
 * - LLM 配置缓存（lastProvider/lastModel/lastBaseUrl/lastApiKey）
 *
 * 设计原则：
 * - 纯状态容器，不持有业务逻辑（业务逻辑仍在 main.ts）
 * - 通过 setRuntime() 集中赋值四件套，避免 4 个独立赋值遗漏
 * - 字段公开暴露，IPC handler 和 main.ts 直接读写
 *
 * 集成点：
 * - main.ts 持有 agentRuntime 实例并挂载到 appState.agentRuntime
 * - minimalHandlers.ts 通过 MinimalIpcState.agentRuntime 访问
 * - IpcContext getter 通过 appState.agentRuntime.agent 实时查询
 */

import type { Agent } from 'memora';
import type { Sprite } from '../../sprite/sprite.js';
import type { SqliteSessionStore } from '../../storage/sessionStore.js';
// AppRuntime 类型真理源在 ipc/types.ts
import type { AppRuntime } from '../ipc/types.js';

/**
 * Agent 运行时状态容器类
 *
 * 集中管理 Agent 实例生命周期的 9 个字段，避免分散在 appState 中。
 * reinitAgent 时通过 setRuntime() 集中赋值，退出时通过 nullify() 清空引用。
 */
export class AgentRuntime {
  /** Agent 实例（对话 + 记忆），reinitAgent 后更新 */
  agent: Agent | null = null;
  /** Sprite 实例（精灵控制 + 配置 + 角色），reinitAgent 后更新 */
  sprite: Sprite | null = null;
  /** 会话存储（历史消息加载），reinitAgent 后更新 */
  sessionStore: SqliteSessionStore | null = null;
  /** 资源释放句柄（关闭精灵 + Agent + 存储连接） */
  closeSprite: (() => Promise<void>) | null = null;
  /** 当前对话的 AbortController（用于中断流式输出） */
  currentAbortController: AbortController | null = null;
  /** LLM 配置缓存：provider（用于判断是否需要重新初始化 Agent） */
  lastProvider: string | null = null;
  /** LLM 配置缓存：model */
  lastModel: string | null = null;
  /** LLM 配置缓存：baseUrl */
  lastBaseUrl: string | null = null;
  /** LLM 配置缓存：apiKey */
  lastApiKey: string | null = null;

  /**
   * 集中赋值运行时实例
   *
   * agent/sprite/sessionStore/closeSprite 在 3 处总是一起变化：
   * initializeApp 成功 / reinitAgent 成功 / reinitAgent 失败。
   * 提取为集中赋值方法，避免 4 个独立赋值遗漏。
   *
   * @param runtime 运行时实例，传 null 清空四件套引用（保留 LLM 缓存和 AbortController）
   */
  setRuntime(runtime: AppRuntime | null): void {
    if (runtime) {
      this.agent = runtime.agent;
      this.sprite = runtime.sprite;
      this.sessionStore = runtime.sessionStore;
      this.closeSprite = runtime.close;
    } else {
      this.agent = null;
      this.sprite = null;
      this.sessionStore = null;
      this.closeSprite = null;
    }
  }

  /**
   * 清空所有引用（退出时调用）
   *
   * 切断所有字段引用，防止内存 dump 泄漏（尤其 lastApiKey 等敏感字段）
   * 和退出后定时器残留触发已销毁对象的方法。
   */
  nullify(): void {
    this.agent = null;
    this.sprite = null;
    this.sessionStore = null;
    this.closeSprite = null;
    this.currentAbortController = null;
    this.lastProvider = null;
    this.lastModel = null;
    this.lastBaseUrl = null;
    this.lastApiKey = null;
  }
}
