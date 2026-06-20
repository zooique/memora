/**
 * DOM 工具函数模块
 *
 * 职责：
 * - 提供类型安全的 DOM 元素获取函数
 * - 核心元素缺失时抛出明确错误，可选元素缺失时降级
 *
 * 设计原则：
 * - 在初始化阶段即发现 HTML 与 TS 不同步问题，避免运行时静默失败
 * - 核心元素与可选元素分离，单个面板缺失不阻塞整个 UI
 */

/**
 * 获取必需的 DOM 元素，若缺失或标签名不匹配则抛出明确错误
 *
 * 在初始化阶段即发现 HTML 与 TS 不同步问题，避免运行时静默失败。
 *
 * **仅用于核心交互元素**（消息区、输入框、发送按钮、停止按钮）。
 * 非核心元素请使用 `getOptionalElement`，避免单个面板缺失导致整个 UI 崩溃。
 *
 * @param id 元素 id
 * @param tagName 期望的 HTML 标签名
 * @returns 类型安全的 DOM 元素
 */
export function getRequiredElement<T extends keyof HTMLElementTagNameMap>(
  id: string,
  tagName: T,
): HTMLElementTagNameMap[T] {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`[UIManager] 必需的 DOM 元素 #${id} 未找到，UI 无法初始化`);
  }
  // 运行时标签名校验：使用 tagName 字符串比较（兼容 JSDOM 等无 DOM 构造函数的环境）
  if (el.tagName.toLowerCase() !== tagName) {
    throw new Error(
      `[UIManager] DOM 元素 #${id} 类型不匹配，期望 <${tagName}>，实际 <${el.tagName.toLowerCase()}>`,
    );
  }
  return el as HTMLElementTagNameMap[T];
}

/**
 * 获取可选的 DOM 元素，缺失时 warn 并返回 null（不阻塞其他功能）
 *
 * 当 HTML 与 TS 不同步时，缺失的功能降级而非整个 UI 崩溃。
 *
 * @param id 元素 id
 * @param tagName 期望的 HTML 标签名
 * @returns 类型安全的 DOM 元素或 null
 */
export function getOptionalElement<T extends keyof HTMLElementTagNameMap>(
  id: string,
  tagName: T,
): HTMLElementTagNameMap[T] | null {
  const el = document.getElementById(id);
  if (!el) {
    console.warn(`[UIManager] 可选的 DOM 元素 #${id} 未找到，相关功能将降级`);
    return null;
  }
  // 运行时标签名校验
  if (el.tagName.toLowerCase() !== tagName) {
    console.warn(
      `[UIManager] DOM 元素 #${id} 类型不匹配，期望 <${tagName}>，实际 <${el.tagName.toLowerCase()}>，相关功能将降级`,
    );
    return null;
  }
  return el as HTMLElementTagNameMap[T];
}
