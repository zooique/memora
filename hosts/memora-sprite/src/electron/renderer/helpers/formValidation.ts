/**
 * 表单校验工具模块
 *
 * 职责：
 * - 提供统一的字段级校验错误显示与清空函数
 * - 基于 aria-invalid + aria-describedby 无障碍语义
 * - 消除 Provider 表单 / memory-add 表单 / prompt 弹窗三处重复实现
 * - attachRequiredBlurValidation 提供 blur 即时必填校验（ADR-017 枝叶层 2 次提取）
 *
 * 设计原则：
 * - 纯 DOM 操作，不依赖任何状态管理
 * - 错误文本容器遵循 {inputId}-error 命名约定
 * - 返回输入元素供调用方聚焦，保持调用方对焦点的控制权
 *
 * 提取时机：3 处表单出现相同模式（showFieldError + clearFieldErrors），
 * 遵循枝叶层 2 次提取原则（ADR-017）。
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

/**
 * 为多个必填字段附加 blur 即时校验
 *
 * blur 时若字段为空则显示"请填写{label}"错误，有值则清空错误状态。
 * 仅做必填校验，格式校验（正则/范围/唯一性）仍由提交时触发，避免过度设计。
 *
 * 遵循 ADR-017 枝叶层 2 次提取原则：Provider 表单和 memory-add 表单都需要必填 blur 校验。
 *
 * @param fields 字段 id 与中文标签的映射数组
 * @param events EventTracker 用于管理监听器生命周期，cleanup 时自动清理
 */
export function attachRequiredBlurValidation(
  fields: ReadonlyArray<{ id: string; label: string }>,
  events: { addEventListener: (el: EventTarget, event: string, handler: EventListener) => void },
): void {
  for (const { id, label } of fields) {
    const input = document.getElementById(id);
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) continue;
    events.addEventListener(input, 'blur', () => {
      if (!input.value.trim()) {
        showFieldError(id, `请填写${label}`);
      } else {
        clearFieldErrors([id]);
      }
    });
  }
}
