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
export interface HtmlHeadParams {
  /** `<html lang>`：调用方应取 vscode.env.language，不可得时经 resolveHtmlLang 回落 */
  lang: string;
  /** webview.cspSource：放行 asWebviewUri 产出的外部脚本 */
  cspSource: string;
  /** 已拼接好的完整样式文本（可含多个样式片段） */
  styles: string;
}

/** lang 回落值：env.language 不可得时（如测试环境的 vscode mock 未定义 env）沿用中文 */
export const DEFAULT_HTML_LANG = 'zh-CN';

/**
 * lang 取值稳健解析：undefined 与空串一律回落，避免产出 `<html lang="undefined">`
 * ——那会被浏览器当作未知语言区域处理，比不写 lang 更糟。
 */
export function resolveHtmlLang(envLanguage: string | undefined): string {
  return envLanguage || DEFAULT_HTML_LANG;
}

/**
 * 生成 `<!DOCTYPE>` 到 `</head>` 的完整文档头（不含 `<body>`，由调用方续接）。
 *
 * CSP `img-src data:`（2026-10-13 补）：样式层 mask 图标（如 AI 回答完成的「已完成」淡勾，
 * chatStyles `.round-group__footer::before` 底栏标签用 `data:image/svg+xml` 画，同日自
 * `.msg-body[data-status='已完成']::after` 迁来）按 CSP 规范
 * 走 img-src；不显式声明则被 `default-src 'none'` 兜底拦截——实测被拦后 VS Code 报
 * "Note that 'img-src' was not explicitly set... The action has been blocked"，图标静默消失。
 * 只授 `data:`：webview 无真实 `<img>`（全库零 <img> 标签），不授任何外部源。
 */
export function buildHtmlHead({ lang, cspSource, styles }: HtmlHeadParams): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src ${cspSource};" />
<style>
${styles}
</style>
</head>
`;
}
