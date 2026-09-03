/**
 * renderMarkdown — AI 回复的 Markdown 渲染（吸收养分：大厂对话流 Markdown 展示）
 *
 * 养分来源（网络为土壤）：
 *   - 大厂对话流（ChatGPT / Claude / Trae）均以 Markdown 渲染 AI 回复，代码块/列表/表格可读；
 *   - 流式/截断时 Markdown 常「半截子」未闭合，需动态补全后再交给解析器，避免布局塌陷；
 *   - LLM 生成内容不可控，渲染前必须 DOMPurify 消毒，防 XSS 注入。
 *
 * 设计（单一真理源 + 简洁）：
 *   - 依赖 marked（Markdown → HTML）+ dompurify（消毒），均由 esbuild 打进 webview bundle；
 *   - 半截子补全仅「渲染时」拼凑，不污染存库的原始文本（调用方始终传原始串）；
 *   - 表格防爆由 chatStyles 的 `.msg-body table { display:block; overflow-x:auto }` 承担
 *     （纯 CSS 降维，不写复杂正则补全表格结构）。
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

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

/**
 * 渲染 Markdown 为已消毒的 HTML 字符串
 *
 * 流程：半截子补全 → marked 解析 → dompurify 消毒（防 LLM 注入 <script> 等）。
 * 返回的 HTML 由调用方赋给 .msg-body 的 innerHTML（消毒后安全）。
 *
 * @param text 原始 Markdown 文本
 * @param win 宿主 window（依赖注入：webview 传全局 window；测试传 jsdom window）。
 *   不裸用全局 window——webview 脚本若被 Node 环境误加载，裸 window 引用会抛
 *   ReferenceError（2026-09-03 打开聊天面板报错根因），显式注入让运行环境显式化。
 * @returns 可安全 innerHTML 的 HTML 片段
 */
export function renderMarkdown(text: string, win: Window): string {
  // 半截子补全后交给解析器（async:false 同步返回 string，无异步扩展）
  const html = marked.parse(fixIncompleteMarkdown(text), { async: false }) as string;
  // 消毒：LLM 生成内容不可控，必须过滤 XSS（DOMPurify 工厂的 WindowLike 与 lib.dom Window
  // 存在类型缺口，运行时等价——显式断言，不裸用全局 window）
  return DOMPurify(win as unknown as Parameters<typeof DOMPurify>[0]).sanitize(html);
}