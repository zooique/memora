/**
 * renderMarkdown — AI 回复的 Markdown 渲染（吸收养分：大厂对话流 Markdown 展示）
 *
 * 养分来源（网络为土壤）：
 *   - 大厂对话流（ChatGPT / Claude / Trae）均以 Markdown 渲染 AI 回复，代码块/列表/表格可读；
 *   - 流式/截断时 Markdown 常「半截子」未闭合，需动态补全后再交给解析器，避免布局塌陷；
 *   - LLM 生成内容不可控，渲染前必须 DOMPurify 消毒，防 XSS 注入。
 *
 * 设计（单一真理源 + 简洁）：
 *   - 依赖 marked（Markdown → HTML），消毒（DOMPurify）由调用方在 webview 环境构造后注入，
 *     不在本模块顶层 import（Node 端 import 链安全，见 renderMarkdown 注释）；
 *   - 半截子补全仅「渲染时」拼凑，不污染存库的原始文本（调用方始终传原始串）；
 *   - 表格防爆由 chatStyles 的 `.msg-body table { display:block; overflow-x:auto }` 承担
 *     （纯 CSS 降维，不写复杂正则补全表格结构）。
 */
import { marked } from 'marked';
// import type：仅编译期引用契约，esbuild/tsc 剥离后不产生运行时依赖——Node 端 import
// 本模块永不加载 sanitizer.js（含 dompurify），保持渲染纯函数的跨环境安全
import type { SanitizeFn } from './sanitizer.js';

/**
 * 动态补全不完整的 Markdown（仅渲染用，不污染原始文本）
 *
 * 大模型流式输出时可能只吐出开头的 ``` 或 ** 而未闭合，若直接交给解析器会把
 * 后续所有文本当作代码/粗体处理导致布局塌陷。此处统计成对标记数量，奇数个
 * 说明「张着嘴」，临时补齐一个闭合符。低成本规避最常见的两种塌陷。
 *
 * @param raw 原始 Markdown 文本（不做任何污染）
 * @returns 补齐闭合符后的渲染文本
 */
function fixIncompleteMarkdown(raw: string): string {
  let fixed = raw;
  // 代码块未闭合：反引号```成奇数个说明有一个未闭合代码块
  const codeBlockCount = (raw.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) fixed += '\n```';
  // 粗体未闭合：** 成奇数个说明有一个未闭合粗体
  const boldCount = (raw.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) fixed += '**';
  return fixed;
}

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
 * 仅在「净化后为空 → 回退显示原文」这一纵深防线路径使用；Node 端渲染安全
 * （本模块保持 Node-safe 契约，不 import dompurify，这里也不碰 document）。
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

/**
 * 渲染 Markdown 为已消毒的 HTML 字符串
 *
 * 流程：半截子补全 → marked 解析 → sanitize 消毒（防 LLM 注入 <script> 等）。
 * 返回的 HTML 由调用方赋给 .msg-body 的 innerHTML（消毒后安全）。
 *
 * 重要设计：不在此文件 import dompurify。dompurify 需要浏览器 window 对象，
 * 若在 Node 环境（扩展宿主 import 链）顶层加载会抛 ReferenceError。
 * 调用方在 webview 浏览器环境经 createSanitizer 构造消毒器，以 SanitizeFn
 * 回调注入，实现「渲染逻辑」与「浏览器环境」的职责分离（契约见 sanitizer.ts）。
 *
 * 纵深防线（2026-09-14 静默失败修复）：若原文有可读字符、净化后却为空串——
 * 通常是「全文本工具标签」（如模型吐出 <tool_call> 骨架）被 DOMPurify 撕成空，
 * 显示空白且误导。判据为「净化前有非空白 & 净化结果为空」，回退转义显原文
 * （此时原文是提示性安全标签，非可执行脚本；转义后 innerHTML 安全）。
 *
 * @param text 原始 Markdown 文本
 * @param sanitize 消毒函数（SanitizeFn），由调用方在 webview 环境构造并注入
 * @returns 可安全 innerHTML 的 HTML 片段
 */
export function renderMarkdown(text: string, sanitize: SanitizeFn): string {
  // 半截子补全后交给解析器（async:false 同步返回 string，无异步扩展）
  const html = marked.parse(fixIncompleteMarkdown(text), { async: false }) as string;
  // 消毒：LLM 生成内容不可控，必须过滤 XSS（sanitize 由调用方在 webview 浏览器环境构造）
  const clean = sanitize(html);
  // 纵深防线：原文有可读内容、净化后为空 → 回退为转义原文（如全标签型输出），避免空白误导
  if (/\S/.test(text) && clean === '') {
    return `<p>${escapeHtml(text)}</p>`;
  }
  return clean;
}
