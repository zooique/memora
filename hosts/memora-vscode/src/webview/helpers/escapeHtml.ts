/**
 * escapeHtml — HTML 文本转义纯函数（单一真理源，防注入）
 *
 * SSOT 收敛（2026-09-21 站 67）：此前 renderMarkdown.ts（纯正则实现）与
 * settingsView.ts（DOM 序列化实现）各持一份同名 escapeHtml，转义面一致、语义重复，
 * 有漂移风险（一处改而另一处漏）。此处收敛为**纯函数**实现（Node-safe 契约，webview
 * 与扩展宿主 import 链均不依赖 document），两消费方统一改引。
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