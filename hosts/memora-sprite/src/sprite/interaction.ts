/**
 * 交互层接口 — CLI readline → 可替换交互层，为 Electron 铺路
 *
 * 设计原则：
 *   - IInteraction 只关心"输入从哪来、输出到哪去"
 *   - 不关心命令路由（由宿主 main() 处理）
 *   - 不关心业务逻辑（由 Sprite / Agent 处理）
 *
 * 遵循自然生长原则：当前只有 CLI 一种实现，
 * 等 Electron 实现出现后再考虑是否提取更高层抽象。
 */

/** 用户输入事件 */
export interface InputEvent {
  /** 用户输入的原始文本 */
  text: string;
}

/** 输入处理器 */
export type InputHandler = (event: InputEvent) => void;

/** 关闭回调 */
export type CloseHandler = () => void;

/**
 * 交互层接口
 *
 * 宿主通过此接口与用户交互。
 * CLI 实现：readline（stdin/stdout）
 * Electron 实现：IPC 渲染进程（未来）
 */
export interface IInteraction {
  /** 启动交互层 */
  start(handler: InputHandler): void;
  /** 输出文本到用户 */
  output(text: string): void;
  /** 输出错误信息到用户 */
  error(text: string): void;
  /** 停止交互层 */
  stop(): void;
  /** 注册关闭回调（如 Ctrl+C、窗口关闭） */
  onClose(handler: CloseHandler): void;
}
