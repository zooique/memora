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
export type WebviewToExtensionMessage = {
  type: 'send';
  /** 用户输入文本 */
  text: string;
};

/** extension → Webview 消息 */
export type ExtensionToWebviewMessage =
  | { type: 'user'; text: string }
  | { type: 'chunk'; content: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
