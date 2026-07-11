/**
 * 表单校验工具模块
 *
 * 职责：
 * - 提供统一的字段级校验错误显示与清空函数
 * - 基于 aria-invalid + aria-describedby 无障碍语义
 * - 消除 Provider 表单 / memory-add 表单 / prompt 弹窗三处重复实现
 *
 * 设计原则：
 * - 纯 DOM 操作，不依赖任何状态管理
 * - 错误文本容器遵循 {inputId}-error 命名约定
 * - 返回输入元素供调用方聚焦，保持调用方对焦点的控制权
 *
 * 提取时机：3 处表单出现相同模式（showFieldError + clearFieldErrors），
 * 遵循"3 次以上才提取"的自然生长原则。
 */

/**
 * 显示字段级校验错误
 *
 * 设置 input 的 aria-invalid=true，填充 aria-describedby 关联的错误文本容器，
 * 返回该 input 元素供调用方聚焦。
 *
 * @param inputId 输入框元素 id
 * @param message 错误提示文本
 * @returns 输入框元素（缺失时降级为 body，保证调用方 focus() 不抛错）
 */
export function showFieldError(inputId: string, message: string): HTMLElement {
  const input = document.getElementById(inputId);
  const errorEl = document.getElementById(`${inputId}-error`);
  if (input) {
    input.setAttribute('aria-invalid', 'true');
  }
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }
  return input ?? document.body;
}

/**
 * 清空多个字段的校验错误状态
 *
 * 移除 aria-invalid，隐藏错误文本容器。在开始新一轮校验前或打开弹窗时调用。
 *
 * @param inputIds 需要清空的输入框 id 数组
 */
export function clearFieldErrors(inputIds: string[]): void {
  for (const id of inputIds) {
    const input = document.getElementById(id);
    const errorEl = document.getElementById(`${id}-error`);
    if (input) {
      input.removeAttribute('aria-invalid');
    }
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
    }
  }
}
