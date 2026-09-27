/**
 * escapeHtml — HTML 文本转义纯函数（单一真理源，防注入）
 *
 * 单一真理源：renderMarkdown.ts 与 settingsView.ts 两个消费方统一引此，避免同名
 * escapeHtml 各持一份、一处改而另一处漏的漂移风险（坑）。实现为**纯函数**（Node-safe
 * 契约，webview 与扩展宿主 import 链均不依赖 document）。
 *
 * 转义面：`& < > " '` 五字符（HTML 文本/纯双引号属性上下文的安全最小集），
 * 与 DOM `textContent → innerHTML` 序列化的转义结果等效。
 */

/** 转义查表：HTML 保留字符 → 命名/数字实体（五字符最小安全集） */
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * HTML 转义（防注入）——纯函数实现，无 DOM 依赖。
 *
 * 用于把不受信任文本（LLM 生成内容 / 用户配置项）安全写入 innerHTML 或双引号属性值。
 *
 * @param text 待转义的原始文本
 * @returns 转义后的安全 HTML 文本
 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}
