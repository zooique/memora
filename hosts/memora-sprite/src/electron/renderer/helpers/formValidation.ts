/**
 * 表单校验工具模块
 *
 * 职责：
 * - 提供统一的字段级校验错误/成功状态显示与清空函数
 * - 基于 aria-invalid + aria-describedby 无障碍语义
 * - 消除 Provider 表单 / memory-add 表单 / prompt 弹窗三处重复实现
 * - attachRequiredBlurValidation 提供 blur 即时必填校验（ADR-017 枝叶层 2 次提取）
 *
 * 设计原则：
 * - 纯 DOM 操作，不依赖任何状态管理
 * - 错误/成功文本容器遵循 {inputId}-error 命名约定，复用同一 DOM 容器通过 .success 修饰类切换视觉态
 * - 返回输入元素供调用方聚焦，保持调用方对焦点的控制权
 *
 * 提取时机：3 处表单出现相同模式（showFieldError + clearFieldErrors），
 * 遵循枝叶层 2 次提取原则（ADR-017）。showFieldSuccess 为 onboarding 测试连接成功消息复用同一容器。
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
    // 清除成功态，确保错误态视觉优先（同一容器复用，状态互斥）
    errorEl.classList.remove('success');
  }
  return input ?? document.body;
}

/**
 * 显示字段级成功提示
 *
 * 复用 {inputId}-error 同一 DOM 容器，通过 .success 修饰类切换为绿色视觉态。
 * 用于 onboarding 测试连接成功消息等场景，避免复用红色错误容器显示成功内容。
 *
 * @param inputId 输入框元素 id
 * @param message 成功提示文本
 * @returns 输入框元素（缺失时降级为 body）
 */
export function showFieldSuccess(inputId: string, message: string): HTMLElement {
  const input = document.getElementById(inputId);
  const statusEl = document.getElementById(`${inputId}-error`);
  if (input) {
    // 成功态清除 aria-invalid，避免无障碍工具误读为错误
    input.removeAttribute('aria-invalid');
  }
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.classList.remove('hidden');
    statusEl.classList.add('success');
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
      // 同步清除成功态（同一容器复用，清空时重置为初始态）
      errorEl.classList.remove('success');
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
