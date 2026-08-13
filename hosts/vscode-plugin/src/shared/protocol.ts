/**
 * 消息协议 — extension host ↔ Webview 通信契约
 *
 * 单一真理源：所有 postMessage 载荷类型在此定义，extension 侧与 webview 侧共用，
 * 避免两侧手写消息类型漂移（对齐 memora-sprite 的 shared/ 跨进程契约思路）。
 *
 * 方向：
 *   - Webview → extension：用户动作（send 发送消息）
 *   - extension → Webview：Agent 流式输出（user/chunk/done/error）
 */

/** Webview → extension 消息 */
export type WebviewToExtensionMessage =
  | { type: 'send'; text: string }
  /** 用户对 Agent 主动提问（need_clarify）的回答，触发 resumeExecution 续跑 */
  | { type: 'clarify_answer'; text: string };

/** extension → Webview 消息 */
export type ExtensionToWebviewMessage =
  | { type: 'user'; text: string }
  | { type: 'chunk'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  /**
   * Agent 主动提问（mvp-scope §三：ambiguity/decision/missing_info）
   *
   * 由 extension host 监听内核 needClarify 事件后转发，触发 Agent 暂停（pause），
   * 等待用户在提问输入框回答；收到 clarify_answer 后调 resumeExecution 续跑。
   */
  | { type: 'need_clarify'; questions: { slot: string; question: string; options?: string[] }[] }
  /**
   * 记忆活动提示（任务 D 可观测出口）
   *
   * 由 extension host 监听 Agent 的 memoryRecalled / memoryAdded 事件后转发，
   * 让开发者「看见」跨会话记忆在工作（主动可见，非黑盒）。
   * action: 'recalled' 表示本轮召回 N 条记忆；'added' 表示本轮沉淀记忆。
   */
  | { type: 'memory'; action: 'recalled' | 'added'; count: number };
