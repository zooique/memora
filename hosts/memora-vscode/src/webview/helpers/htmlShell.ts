/**
 * Webview HTML 文档头骨架 — 面板级 <head> 的单一真理源
 *
 * 背景：chatPanel 与 settingsPanel 各自持有一份逐字节相同的 <head>（lang / charset /
 * viewport / CSP / <style> 容器），且 `<html lang>` 硬编码为 zh-CN——与本仓库 bilingual
 * 产品形态、以及用户实际的 VS Code 显示语言脱钩：屏幕阅读器会用中文语音朗读英文内容，
 * 字体回退与断词行为也跟着错位。
 *
 * 本文件抽走这段骨架，使 CSP 与安全策略只在一处定义；lang 改由调用方按运行时环境
 * 解析后传入（本文件不依赖 vscode，保持纯函数、可直接单测）。
 */
import { L10N_BUNDLE_ELEMENT_ID } from '../../shared/constants.js';

export interface HtmlHeadParams {
  /** `<html lang>`：调用方应取 vscode.env.language，不可得时经 resolveHtmlLang 回落 */
  lang: string;
  /** webview.cspSource：放行 asWebviewUri 产出的外部脚本 */
  cspSource: string;
  /** 已拼接好的完整样式文本（可含多个样式片段） */
  styles: string;
  /** 宿主侧 l10n bundle（`vscode.l10n.bundle`）：默认语言 / 无 bundle 时为 undefined ⇒ 不注入 */
  l10nBundle?: Record<string, string> | undefined;
}

/**
 * lang 回落值：`env.language` 不可得时（如测试环境的 vscode mock 未定义 env）按
 * ADR-042 决策 2「默认语言 = 英文」落英文兜底。
 * ⚠️ 曾写死 `zh-CN` —— manifest 侧已定英文兜底、HTML lang 却兜底中文，同一事实两处
 * 登记且无任何测试会红（SSOT 漂移）。此处与 `package.nls.json` 的默认语言对齐。
 */
export const DEFAULT_HTML_LANG = 'en';

/**
 * lang 取值稳健解析：undefined 与空串一律回落，避免产出 `<html lang="undefined">`
 * ——那会被浏览器当作未知语言区域处理，比不写 lang 更糟。
 */
export function resolveHtmlLang(envLanguage: string | undefined): string {
  return envLanguage || DEFAULT_HTML_LANG;
}

/**
 * 宿主 l10n bundle → webview 内联译文数据块（HOST-I18N-1 P1 基建的写端）
 *
 * - **内联而非 postMessage**：不新增协议消息、无首屏竞态（译文须先于首个 `l10n.t` 调用就位，
 *   数据块随 HTML 一次到位）。
 * - **`type="application/json"`**：数据块不执行 ⇒ 不受 CSP `script-src` 约束，
 *   不破 `buildHtmlHead` 现有安全策略；读端（helpers/webviewL10n）经 JSON.parse 消费。
 * - **转义 `<` → `\u003c`**：`JSON.stringify` 不转义 `<`，值里若出现 `</script>` 会被
 *   HTML 解析器提前截断数据块（闭合标签只认字面量，`JSON.parse` 时 `\u003c` 仍还原为 `<`）。
 * - **`undefined`（默认语言）返回空串** = 不注入——en 用户零增量，与 `vscode.l10n.t`
 *   「无 bundle 返回原文」同一语义。
 */
export function buildL10nBundleScript(bundle: Record<string, string> | undefined): string {
  if (!bundle) return '';
  const json = JSON.stringify(bundle).replace(/</g, '\\u003c');
  return `<script type="application/json" id="${L10N_BUNDLE_ELEMENT_ID}">${json}</script>`;
}

/**
 * 生成 `<!DOCTYPE>` 到 `</head>` 的完整文档头（不含 `<body>`，由调用方续接）。
 *
 * CSP `img-src data: ${cspSource}`（2026-10-28 IMG-2 K3 放宽，改安全面 · 显式理由如下）：
 * - `data:`（2026-10-13 补）：样式层 mask 图标（如 AI 回答完成的「已完成」淡勾，
 *   chatStyles `.round-group__footer::after` 底栏标签用 `data:image/svg+xml` 画，同日自
 *   `.msg-body[data-terminus='已完成']::after` 迁来）按 CSP 规范走 img-src；
 *   不显式声明则被 `default-src 'none'` 兜底拦截——实测被拦后 VS Code 报
 *   "Note that 'img-src' was not explicitly set... The action has been blocked"，图标静默消失。
 * - `${cspSource}`（本次新增）：图片**磁盘预览**——附件缩略图/悬停大图用 `asWebviewUri`
 *   指向数据目录 `attachments/`（走宿主 `localResourceRoots` 同源路径），webview 只留
 *   URI 不留字节（数据唯一一份在磁盘，重启/销毁重建不产生「chip 在、预览空白」半死态）。
 *   这是对 VS Code 官方默认（本就放行扩展目录与工作区）的**恢复性放宽**——本宿主曾把
 *   `localResourceRoots` 主动收窄到 `dist/webview`，图片预览是收窄后第一个合法消费者；
 *   论证见 `docs/边界-图片采集UI-VSCode能力边界-20261028.md` §2 B4/B8（P-b 方案）。
 * ⚠️ 曾经那句「全库零 `<img>`，不授任何外部源」在图片输入落地后即成谎话，故本批同文订正
 * （注释与现实背离 = K3 立刺的本体，勿回退成只改一半）。
 */
export function buildHtmlHead({ lang, cspSource, styles, l10nBundle }: HtmlHeadParams): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: ${cspSource}; style-src 'unsafe-inline'; script-src ${cspSource};" />
<style>
${styles}
</style>
${buildL10nBundleScript(l10nBundle)}
</head>
`;
}
